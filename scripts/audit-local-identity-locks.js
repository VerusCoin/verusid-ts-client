#!/usr/bin/env node
"use strict";

// Explicitly authorized VRSCTEST spending audit. Every signed transaction is
// retained before broadcast; retry commands reuse those exact signed bytes.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const BN = require("bn.js");
const { Transaction, networks } = require("@bitgo/utxo-lib");
const p = require("verus-typescript-primitives");
const { VerusIdInterface, verifyIdentityUpdateFunding } = require("../lib");
const {
  applyLocalIdentityUpdate,
} = require("../lib/identity/localIdentityUpdate");
const { rpc } = require("./local-upload-daemon-rpc");
const fixturePath = path.join(
  __dirname,
  "../src/__tests__/fixtures/local-upload/live-identity-locks.json"
);
const SUBJECT = "iLDXrgGXHxQRaQ9x7AAWKortf7T98YZ1Tn";
const CHAIN = "iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq";
const RESERVED = [
  {
    txid: "d7f7598090f4c07d71f9f53793129e3eb67e30802489aac6adf6f4001a94412e",
    vout: 1,
  },
  {
    txid: "3bad0a1214428ce6177519c6aa9a4b5e1713475535d45630a53e1a78a3407360",
    vout: 1,
  },
];
const read = () =>
  fs.existsSync(fixturePath)
    ? JSON.parse(fs.readFileSync(fixturePath, "utf8"))
    : { identity: SUBJECT, chain: CHAIN, cases: [] };
const save = (value) =>
  fs.writeFileSync(fixturePath, JSON.stringify(value, null, 2) + "\n");
function decodeIdentity(raw, address = SUBJECT) {
  const tx = Transaction.fromHex(raw, networks.verus);
  for (let index = 0; index < tx.outs.length; index++) {
    try {
      const script = new p.IdentityScript();
      script.fromBuffer(tx.outs[index].script);
      const identity = script.getIdentity(false);
      if (identity.getIdentityAddress() === address)
        return { identity, index, tx };
    } catch (_) {}
  }
  throw new Error("Expected identity definition missing");
}
async function chainInfo() {
  const info = await rpc("getinfo");
  assert.strictEqual(info.testnet, true);
  assert.strictEqual(info.chainid, CHAIN);
  return info;
}
function client(calls) {
  return new VerusIdInterface(
    CHAIN,
    "http://127.0.0.1:18843",
    undefined,
    async (request) => {
      assert(
        ["getidentity", "getrawtransaction", "fundrawtransaction"].includes(
          request.method
        ),
        "Unexpected SDK construction RPC: " + request.method
      );
      calls.push({ method: request.method, params: request.params });
      const result = await rpc(request.method, request.params);
      return { result, error: null, id: request.id };
    }
  );
}
async function fundingCoin(index, info) {
  const coins = await rpc("listunspent", [1, 9999999]);
  const expected = RESERVED[index];
  const coin = coins.find(
    (value) => value.txid === expected.txid && value.vout === expected.vout
  );
  assert(coin && coin.spendable, "Reserved audit funding input is unavailable");
  return {
    txid: coin.txid,
    outputIndex: coin.vout,
    address: coin.address,
    script: coin.scriptPubKey,
    satoshis: Math.round(coin.amount * 1e8),
    height: info.blocks - coin.confirmations + 1,
    isspendable: true,
    blocktime: 1,
  };
}
async function broadcastRetained(name) {
  const data = read();
  const record = data.cases.find((value) => value.name === name);
  assert(record?.signedHex && record.txid, "No retained signed transaction");
  assert.strictEqual(
    Transaction.fromHex(record.signedHex, networks.verus).getId(),
    record.txid
  );
  // A response failure never triggers reconstruction or re-signing.
  try {
    const result = await rpc("sendrawtransaction", [record.signedHex]);
    assert.strictEqual(result, record.txid);
    record.broadcastResult = result;
    record.broadcastAt = new Date().toISOString();
    delete record.broadcastError;
  } catch (error) {
    record.broadcastError = error.message;
    save(data);
    throw error;
  }
  save(data);
  console.log(
    JSON.stringify({
      name,
      txid: record.txid,
      expiryHeight: record.expiryHeight,
    })
  );
}
async function build(name) {
  const data = read();
  const existing = data.cases.find((value) => value.name === name);
  if (existing) {
    assert(
      existing.broadcastError?.includes("tx-expiring-soon"),
      "Use retry for the existing retained transaction"
    );
    assert(
      !(await rpc("getrawmempool")).includes(existing.txid),
      "Prior transaction is already in the mempool"
    );
    existing.name += "-rejected-expiry";
    existing.status =
      "Explicitly rejected before acceptance; replaced after checking mempool and unspent input.";
    save(data);
  }
  const info = await chainInfo();
  const currentResult = await rpc("getidentity", [SUBJECT]);
  const sourceHex = await rpc("getrawtransaction", [currentResult.txid]);
  const { identity: current } = decodeIdentity(sourceHex);
  assert(current.version.eqn(3));
  const partial = new p.PartialIdentity({
    name: current.name,
    parent: current.parent,
  });
  if (name === "lock-and-private-vector") {
    assert(!current.isLocked() && current.unlockAfter.ltn(info.blocks));
    data.originalIdentityHex = current.toBuffer().toString("hex");
    data.originalSourceHex = sourceHex;
    partial.lock(new BN(2));
    const first =
      require("../src/__tests__/fixtures/local-upload/public-recipient.json").address;
    const second = await rpc("z_getencryptionaddress", [
      { seed: "63".repeat(32) },
    ]);
    const secondAddress =
      second.address || second.paymentaddress || second.zaddress;
    assert(secondAddress && secondAddress !== first);
    partial.privateAddresses = [first, secondAddress].map((value) =>
      p.SaplingPaymentAddress.fromAddressString(value)
    );
    partial.contains = partial.contains.or(
      p.PartialIdentity.PARTIAL_ID_CONTAINS_PRIV_ADDRS
    );
  } else {
    assert.strictEqual(name, "unlock-and-restore-private-vector");
    assert(
      current.isLocked(),
      "The lock must be confirmed before the unlock audit"
    );
    const original = new p.Identity();
    original.fromBuffer(Buffer.from(data.originalIdentityHex, "hex"));
    partial.flags = current.flags.and(p.IDENTITY_FLAG_LOCKED.notn(32));
    partial.contains = partial.contains
      .or(p.PartialIdentity.PARTIAL_ID_CONTAINS_FLAGS)
      .or(p.PartialIdentity.PARTIAL_ID_CONTAINS_PRIV_ADDRS);
    partial.privateAddresses = original.privateAddresses || [];
    // Show the live locked source cannot be shortened.
    const shortened = new p.PartialIdentity({
      name: current.name,
      parent: current.parent,
      unlockAfter: new BN(1),
    });
    assert.throws(
      () =>
        applyLocalIdentityUpdate(current, shortened, {
          chainId: CHAIN,
          nextBlockHeight: info.blocks + 1,
          expiryHeight: info.blocks + 6,
        }),
      /cannot be shortened/
    );
    data.liveLockedSourceNegativeCheck = {
      sourceTxid: currentResult.txid,
      delay: current.unlockAfter.toNumber(),
      rejectedDelay: 1,
    };
  }
  const request = new p.IdentityUpdateRequestDetails({
    identity: partial,
    expiryHeight: new BN(info.blocks + 6),
  });
  const calls = [];
  const sdk = client(calls);
  if (name === "unlock-and-restore-private-vector") {
    const retained = await sdk.createUpdateIdentityTransaction(
      new p.IdentityUpdateRequestDetails({
        identity: new p.PartialIdentity({
          name: current.name,
          parent: current.parent,
        }),
      }),
      current.primaryAddresses[0].toAddress(),
      sourceHex,
      currentResult.blockheight,
      undefined,
      CHAIN,
      undefined,
      undefined,
      info.blocks,
      undefined,
      false,
      true
    );
    assert.strictEqual(
      decodeIdentity(retained.hex).identity.privateAddresses.length,
      2
    );
    data.liveMultiplePrivateVectorPreservation = {
      sourceTxid: currentResult.txid,
      templateHex: retained.hex,
      sourcePrivateAddresses: current.privateAddresses.map((value) =>
        value.toBuffer().toString("hex")
      ),
    };
    const daemonReference = await rpc("updateidentity", [
      {
        name: current.name,
        parent: current.parent.toAddress(),
        flags: partial.flags.toNumber(),
        privateaddress: "",
      },
      true,
    ]);
    const reference = decodeIdentity(daemonReference);
    const expectedReference = applyLocalIdentityUpdate(current, partial, {
      chainId: CHAIN,
      nextBlockHeight: info.blocks + 1,
      expiryHeight: reference.tx.expiryHeight,
    });
    assert(
      expectedReference.identity
        .toBuffer()
        .equals(reference.identity.toBuffer())
    );
    data.liveUnlockDaemonComparison = {
      rpc: {
        method: "updateidentity",
        params: [
          {
            name: current.name,
            parent: current.parent.toAddress(),
            flags: partial.flags.toNumber(),
            privateaddress: "",
          },
          true,
        ],
      },
      height: info.blocks,
      expiryHeight: reference.tx.expiryHeight,
      identityHex: reference.identity.toBuffer().toString("hex"),
      outputTransactionHex: daemonReference,
      sourceHex,
    };
  }
  const coin = await fundingCoin(
    name === "lock-and-private-vector" ? 0 : 1,
    info
  );
  const built = await sdk.createUpdateIdentityTransaction(
    request,
    coin.address,
    sourceHex,
    currentResult.blockheight,
    [coin],
    CHAIN,
    0.001,
    undefined,
    info.blocks,
    undefined,
    false,
    true
  );
  assert(built.fundingApproval);
  verifyIdentityUpdateFunding(built.fundingApproval, built.hex);
  const result = await rpc("signrawtransaction", [built.hex]);
  assert(
    result.complete === true,
    "Daemon did not fully sign: " + JSON.stringify(result.errors)
  );
  verifyIdentityUpdateFunding(built.fundingApproval, result.hex);
  const parsed = decodeIdentity(result.hex);
  if (name === "lock-and-private-vector") {
    assert(parsed.identity.isLocked());
    assert.strictEqual(parsed.identity.privateAddresses.length, 2);
  } else {
    assert(!parsed.identity.isLocked());
    assert.strictEqual(
      parsed.identity.unlockAfter.toNumber(),
      parsed.tx.expiryHeight + 2
    );
    assert.deepStrictEqual(parsed.identity.privateAddresses || [], []);
  }
  const record = {
    name,
    observedAt: new Date().toISOString(),
    daemonVersion: info.VRSCversion,
    height: info.blocks,
    sourceTxid: currentResult.txid,
    sourceHex,
    requestHex: request.toBuffer().toString("hex"),
    requestCLI: request.toCLIJson(),
    expiryHeight: parsed.tx.expiryHeight,
    identityHex: parsed.identity.toBuffer().toString("hex"),
    privateAddressCount: (parsed.identity.privateAddresses || []).length,
    unsignedHex: built.hex,
    signedHex: result.hex,
    txid: parsed.tx.getId(),
    fundingApproval: built.fundingApproval,
    constructionRpcCalls: calls,
  };
  data.cases.push(record);
  save(data);
  await broadcastRetained(name);
}
async function status() {
  const data = read();
  const info = await chainInfo();
  for (const record of data.cases) {
    try {
      const tx = await rpc("getrawtransaction", [record.txid, 1]);
      record.confirmations = tx.confirmations || 0;
      record.blockhash = tx.blockhash;
      assert.strictEqual(tx.hex, record.signedHex);
    } catch (error) {
      record.statusError = error.message;
    }
  }
  const current = await rpc("getidentity", [SUBJECT]);
  const raw = await rpc("getrawtransaction", [current.txid]);
  const { identity } = decodeIdentity(raw);
  data.lastStatus = {
    observedAt: new Date().toISOString(),
    height: info.blocks,
    txid: current.txid,
    flags: identity.flags.toNumber(),
    timelock: identity.unlockAfter.toNumber(),
    privateAddressCount: (identity.privateAddresses || []).length,
    daemonStatus: current.status,
    identityHex: identity.toBuffer().toString("hex"),
    rawTransactionHex: raw,
  };
  save(data);
  console.log(
    JSON.stringify({
      cases: data.cases.map(({ name, txid, confirmations }) => ({
        name,
        txid,
        confirmations,
      })),
      ...data.lastStatus,
      rawTransactionHex: undefined,
      identityHex: undefined,
    })
  );
}
const command = process.argv[2];
(command === "lock"
  ? build("lock-and-private-vector")
  : command === "unlock"
  ? build("unlock-and-restore-private-vector")
  : command === "retry"
  ? broadcastRetained(process.argv[3])
  : command === "status"
  ? status()
  : Promise.reject(
      new Error(
        "Usage: audit-local-identity-locks.js lock|unlock|status|retry <case-name>"
      )
    )
).catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
