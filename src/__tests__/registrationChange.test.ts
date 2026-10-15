import BN from "bn.js";
import {
  ECPair,
  networks,
  Transaction,
  TransactionBuilder,
} from "@bitgo/utxo-lib";
import {
  CurrencyOptions,
  Identity,
  IdentityID,
  IdentityScript,
  KeyID,
  nameAndParentAddrToIAddr,
  SmartTransactionScript,
} from "verus-typescript-primitives";
import { VerusIdInterface } from "../index";
import { paymentOutput } from "../identity/registrationTransaction";

const SYSTEM = nameAndParentAddrToIAddr("VRSC");
const TOKEN = nameAndParentAddrToIAddr("community", SYSTEM);
const key = ECPair.fromPrivateKeyBuffer(Buffer.alloc(32, 23), networks.verus);
const address = key.getAddress();
const wif = key.toWIF();
const hashAt = (height: number) => height.toString(16).padStart(64, "0");

function harness(reserves: boolean) {
  let tip = 100;
  let nonce = 10;
  const sources = new Map<string, { tx: any; height: number }>();
  const identities = new Map<string, any>();
  const spent = new Set<string>();
  const native = {
    version: 1,
    name: "VRSC",
    parent: new IdentityID(Buffer.alloc(20)).toAddress(),
    currencyid: SYSTEM,
    systemid: SYSTEM,
    options: CurrencyOptions.PBAAS,
    proofprotocol: 1,
    startblock: 0,
    endblock: 0,
    blocktime: 60,
    idregistrationfees: 1,
    idreferrallevels: 0,
    idimportfees: 0.01,
  };
  const token = {
    ...native,
    name: "community",
    parent: SYSTEM,
    currencyid: TOKEN,
    options: CurrencyOptions.TOKEN,
  };
  const client = new VerusIdInterface(
    SYSTEM,
    "http://unused.invalid",
    undefined,
    async (request: any): Promise<any> => {
      const [first, second] = request.params || [];
      const ok = (result: unknown) => ({ id: request.id, error: null, result });
      if (request.method === "getinfo")
        return ok({ blocks: tip, longestchain: tip, chainid: SYSTEM });
      if (request.method === "getcurrency")
        return ok(first === TOKEN ? token : native);
      if (request.method === "getidentity") {
        if (identities.has(first)) return ok(identities.get(first));
        return {
          id: request.id,
          result: null,
          error: { code: -5, message: "Identity not found" },
        };
      }
      if (request.method === "getrawtransaction")
        return ok(sources.get(first)!.tx.toHex());
      if (request.method === "gettxout") {
        const source = sources.get(first);
        const output = source?.tx.outs[second];
        if (!source || !output || spent.has(`${first}:${second}`))
          return ok(null);
        const value = String(output.value).padStart(9, "0");
        return ok({
          bestblock: hashAt(tip),
          confirmations: tip - source.height + 1,
          value: `${value.slice(0, -8)}.${value.slice(-8)}`,
          coinbase: false,
          scriptPubKey: { hex: output.script.toString("hex") },
        });
      }
      if (request.method === "getblock") {
        const height = first.length > 10 ? parseInt(first, 16) : Number(first);
        return ok({
          hash: hashAt(height),
          height,
          confirmations: tip - height + 1,
          tx: [...sources.entries()]
            .filter(([, source]) => source.height === height)
            .map(([id]) => id),
        });
      }
      throw new Error(`Unexpected RPC ${request.method}`);
    }
  );
  const addSource = (outputScript: Buffer, value: number, height: number) => {
    const builder = new TransactionBuilder(networks.verus);
    builder.setVersion(4);
    builder.setVersionGroupId(0x892f2085);
    builder.setExpiryHeight(200);
    builder.addInput(Buffer.alloc(32, nonce++), 0);
    builder.addOutput(outputScript, value);
    const tx = builder.buildIncomplete();
    sources.set(tx.getId(), { tx, height });
    return tx;
  };
  const values = {
    [SYSTEM]: "200000000",
    ...(reserves ? { [TOKEN]: "200000000" } : {}),
  };
  const source = paymentOutput(address, values, SYSTEM, "change");
  const funding = addSource(
    Buffer.from(source.scriptHex, "hex"),
    Number(source.value),
    10
  );
  const parent = reserves ? TOKEN : SYSTEM;
  const newID = nameAndParentAddrToIAddr("Alice", parent);
  const identity = {
    version: 3,
    flags: 0,
    name: "Alice",
    parent,
    systemid: SYSTEM,
    minimumsignatures: 1,
    primaryaddresses: [address],
    timelock: 0,
    recoveryauthority: newID,
    revocationauthority: newID,
  };
  const request = {
    name: reserves ? "Alice.community@" : "Alice",
    rootSystemName: "VRSC",
    systemID: SYSTEM,
    controller: address,
    salt: Buffer.alloc(32, 41),
    funding: [{ txid: funding.getId(), vout: 0 }],
    changeAddress: address,
    approvedCosts: values,
  };
  const addChangeIdentity = (flags = 0, timelock = 0) => {
    const id = nameAndParentAddrToIAddr("change", SYSTEM);
    const identity = new Identity({
      version: new BN(3),
      flags: new BN(flags),
      name: "change",
      parent: IdentityID.fromAddress(SYSTEM),
      systemId: IdentityID.fromAddress(SYSTEM),
      minSigs: new BN(1),
      primaryAddresses: [KeyID.fromAddress(address)],
      revocationAuthority: IdentityID.fromAddress(id),
      recoveryAuthority: IdentityID.fromAddress(id),
      unlockAfter: new BN(timelock),
    });
    const tx = addSource(
      IdentityScript.fromIdentity(identity).toBuffer(),
      0,
      20
    );
    const response = {
      identity: identity.toJson("VRSC"),
      txid: tx.getId(),
      vout: 0,
      blockheight: 20,
    };
    identities.set(id, response);
    return { id, response };
  };
  const mine = (hex: string) => {
    const tx = Transaction.fromHex(hex, networks.verus);
    tip++;
    sources.set(tx.getId(), { tx, height: tip });
    tx.ins.forEach((input: any) =>
      spent.add(
        `${Buffer.from(input.hash).reverse().toString("hex")}:${input.index}`
      )
    );
    return tx;
  };
  return { client, request, identity, newID, addChangeIdentity, mine, spent };
}

describe.each([false, true])(
  "identity change safety (reserves=%s)",
  (reserves) => {
    test.each(["unknown", "future identity"])(
      "rejects commitment change to %s before signing",
      async (kind) => {
        const h = harness(reserves);
        const target =
          kind === "future identity"
            ? h.newID
            : nameAndParentAddrToIAddr("missing", SYSTEM);
        await expect(
          h.client.createNameReservationTransaction({
            ...h.request,
            changeAddress: target,
          })
        ).rejects.toThrow("Identity not found");
      }
    );

    test.each([
      ["revoked", 0x8000, 0, "REVOKED_IDENTITY"],
      ["locked", 0x2, 0, "LOCKED_AUTHORITY"],
      ["future timelock", 0, 101, "LOCKED_AUTHORITY"],
    ])(
      "rejects commitment change to a %s identity",
      async (_label, flags, timelock, code) => {
        const h = harness(reserves);
        const change = h.addChangeIdentity(flags as number, timelock as number);
        await expect(
          h.client.createNameReservationTransaction({
            ...h.request,
            changeAddress: change.id,
          })
        ).rejects.toMatchObject({ code });
      }
    );

    test("accepts existing usable identity change after checking its raw defining outpoint", async () => {
      const h = harness(reserves);
      const change = h.addChangeIdentity(0, 90);
      const result = await h.client.createNameReservationTransaction({
        ...h.request,
        changeAddress: change.id,
      });
      const output = result.transaction.outputPlan.find(
        (item) => item.role === "change"
      )!;
      const parsed = new SmartTransactionScript();
      parsed.fromBuffer(Buffer.from(output.scriptHex, "hex"));
      expect(parsed.paramsOptCC.destinations[0].toAddress()).toBe(change.id);
      expect(output.values[SYSTEM]).toBe("199990000");
      if (reserves) expect(output.values[TOKEN]).toBe("200000000");
      const signed = h.client.signIdentityRegistrationTransaction({
        transaction: result.transaction,
        keys: [[wif]],
      });
      expect(signed.signingStatus).toBe("complete");
      expect(
        h.client.validateIdentityRegistrationTransaction(
          result.transaction,
          signed.txHex
        ).valid
      ).toBe(true);
    });

    test("rejects a change identity whose JSON does not match its verified raw transaction", async () => {
      const h = harness(reserves);
      const change = h.addChangeIdentity();
      change.response.identity.primaryaddresses = [
        ECPair.fromPrivateKeyBuffer(
          Buffer.alloc(32, 42),
          networks.verus
        ).getAddress(),
      ];
      await expect(
        h.client.createNameReservationTransaction({
          ...h.request,
          changeAddress: change.id,
        })
      ).rejects.toMatchObject({ code: "AUTHORITY_MISMATCH" });
    });

    test("rejects change to an identity whose defining outpoint has been spent", async () => {
      const h = harness(reserves);
      const change = h.addChangeIdentity();
      h.spent.add(`${change.response.txid}:0`);
      await expect(
        h.client.createNameReservationTransaction({
          ...h.request,
          changeAddress: change.id,
        })
      ).rejects.toMatchObject({ code: "AUTHORITY_CHANGED" });
    });

    test("rejects unknown reveal change but permits change to the identity created by that reveal", async () => {
      const h = harness(reserves);
      const commitment = await h.client.createNameReservationTransaction(
        h.request
      );
      const signed = h.client.signIdentityRegistrationTransaction({
        transaction: commitment.transaction,
        keys: [[wif]],
      });
      const tx = h.mine(signed.txHex);
      const request = {
        reservation: commitment.reservation,
        commitment: { txid: tx.getId(), vout: commitment.commitmentVout },
        identity: h.identity,
        funding: [{ txid: tx.getId(), vout: 1 }],
        changeAddress: nameAndParentAddrToIAddr("missing", SYSTEM),
        approvedCosts: h.request.approvedCosts,
      };
      await expect(
        h.client.createIdentityRegistrationTransaction(request)
      ).rejects.toThrow("Identity not found");
      const registration = await h.client.createIdentityRegistrationTransaction(
        { ...request, changeAddress: h.newID }
      );
      const output = registration.outputPlan.find(
        (item) => item.role === "change"
      )!;
      const parsed = new SmartTransactionScript();
      parsed.fromBuffer(Buffer.from(output.scriptHex, "hex"));
      expect(parsed.paramsOptCC.destinations[0].toAddress()).toBe(h.newID);
      expect(registration.outputPlan[0].role).toBe("identity");
      const complete = h.client.signIdentityRegistrationTransaction({
        transaction: registration,
        keys: registration.prevouts.map(() => [wif]),
      });
      expect(complete.signingStatus).toBe("complete");
      expect(
        h.client.validateIdentityRegistrationTransaction(
          registration,
          complete.txHex
        ).valid
      ).toBe(true);
    });
  }
);
