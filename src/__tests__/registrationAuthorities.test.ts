import BN from "bn.js";
import { networks, TransactionBuilder } from "@bitgo/utxo-lib";
import {
  CurrencyOptions,
  Identity,
  IdentityID,
  IdentityScript,
  KeyID,
  nameAndParentAddrToIAddr,
} from "verus-typescript-primitives";
import { VerusdRpcInterface } from "verusd-rpc-ts-client";
import { createNameReservationTransaction } from "../identity/registration";

const systemID = nameAndParentAddrToIAddr("VRSC");
const controllerID = nameAndParentAddrToIAddr("Controller", systemID);
const key = new KeyID(Buffer.alloc(20, 7));
const tipHash = "a1".repeat(32);
const ok = (result: unknown) => ({ result, error: null });

function source(script: Buffer, value: number) {
  const tx = new TransactionBuilder(networks.verus);
  tx.setVersion(4);
  tx.setVersionGroupId(0x892f2085);
  tx.setExpiryHeight(70);
  tx.addInput(Buffer.alloc(32, 15), 0);
  tx.addOutput(script, value);
  return tx.buildIncomplete();
}

function authorityFixture(flags = 0, unlockAfter = 0) {
  const identity = new Identity({
    version: new BN(3),
    flags: new BN(flags),
    minSigs: new BN(1),
    primaryAddresses: [key],
    name: "Controller",
    parent: IdentityID.fromAddress(systemID),
    systemId: IdentityID.fromAddress(systemID),
    revocationAuthority: IdentityID.fromAddress(controllerID),
    recoveryAuthority: IdentityID.fromAddress(controllerID),
    unlockAfter: new BN(unlockAfter),
  });
  const authority = source(IdentityScript.fromIdentity(identity).toBuffer(), 0);
  const { address } = require("@bitgo/utxo-lib");
  const funding = source(
    address.toOutputScript(key.toAddress(), networks.verus),
    20000000000
  );
  const declared: any = {
    identity: identity.toJson("VRSC"),
    txid: authority.getId(),
    vout: 0,
    blockheight: 50,
  };
  const unspent: any = {
    bestblock: tipHash,
    confirmations: 51,
    value: "0",
    scriptPubKey: { hex: authority.outs[0].script.toString("hex") },
    coinbase: false,
  };
  const rpc = {
    chain: systemID,
    getInfo: jest.fn(async () =>
      ok({ blocks: 100, longestchain: 100, chainid: systemID })
    ),
    getCurrency: jest.fn(async () =>
      ok({
        version: 1,
        currencyid: systemID,
        name: "VRSC",
        parent: new IdentityID(Buffer.alloc(20)).toAddress(),
        systemid: systemID,
        options: CurrencyOptions.PBAAS,
        proofprotocol: 1,
        startblock: 0,
        endblock: 0,
        idregistrationfees: 100,
        idreferrallevels: 0,
        idimportfees: 0.01,
        blocktime: 60,
      })
    ),
    getBlock: jest.fn(async () =>
      ok({ hash: tipHash, height: 100, confirmations: 1 })
    ),
    getIdentity: jest.fn(async (id: string) =>
      id === controllerID
        ? ok(declared)
        : {
            result: null,
            error: { code: -5, message: "Identity not found" },
          }
    ),
    getRawTransaction: jest.fn(async () => ok(authority.toHex())),
    getTxOut: jest.fn(async (txid: string) =>
      ok(
        txid === declared.txid
          ? unspent
          : {
              bestblock: tipHash,
              confirmations: 2,
              value: "200",
              coinbase: false,
              scriptPubKey: { hex: funding.outs[0].script.toString("hex") },
            }
      )
    ),
  };
  const request = {
    name: "NewUser",
    rootSystemName: "VRSC",
    systemID,
    controller: controllerID,
    salt: Buffer.alloc(32, 21),
    funding: [
      { txid: funding.getId(), vout: 0, rawTransaction: funding.toHex() },
    ],
    changeAddress: key.toAddress()!,
    approvedCosts: { [systemID]: "10000010000" },
  };
  const build = () =>
    createNameReservationTransaction(
      rpc as unknown as VerusdRpcInterface,
      request
    );
  return { build, declared, unspent, rpc, authority };
}

describe("registration authority evidence before commitment", () => {
  test.each([0, 99, 100])(
    "accepts an unlocked identity with elapsed timelock %s",
    async (unlockAfter) => {
      const fixture = authorityFixture(0, unlockAfter);
      const result = await fixture.build();
      expect(result.transaction.revealAuthorities).toEqual([
        {
          identityID: controllerID,
          primaryAddresses: [key.toAddress()],
          minimumSignatures: 1,
          revoked: false,
        },
      ]);
      expect(fixture.rpc.getTxOut).toHaveBeenCalledWith(
        fixture.authority.getId(),
        0,
        true
      );
    }
  );

  test.each([
    [2, 0],
    [0, 101],
    [0, 102],
  ])("rejects lock flags %s / unlock height %s", async (flags, unlockAfter) => {
    await expect(
      authorityFixture(flags, unlockAfter).build()
    ).rejects.toMatchObject({ code: "LOCKED_AUTHORITY" });
  });

  test.each([
    { minimumsignatures: 2 },
    { primaryaddresses: [new KeyID(Buffer.alloc(20, 9)).toAddress()] },
    { flags: 1 },
    { timelock: 100 },
  ])(
    "rejects authority JSON inconsistent with the raw identity %s",
    async (patch) => {
      const fixture = authorityFixture();
      Object.assign(fixture.declared.identity, patch);
      await expect(fixture.build()).rejects.toMatchObject({
        code: "AUTHORITY_MISMATCH",
      });
    }
  );

  test("rejects a mismatched authority transaction and a missing confirmed outpoint", async () => {
    const mismatched = authorityFixture();
    mismatched.declared.txid = "ff".repeat(32);
    await expect(mismatched.build()).rejects.toMatchObject({
      code: "AUTHORITY_MISMATCH",
    });
    const omitted = authorityFixture();
    delete omitted.declared.txid;
    await expect(omitted.build()).rejects.toMatchObject({
      code: "INVALID_AUTHORITY_EVIDENCE",
    });
  });

  test.each([
    [{ confirmations: 0 }, "AUTHORITY_MISMATCH"],
    [{ confirmations: 50 }, "AUTHORITY_MISMATCH"],
    [{ bestblock: "ff".repeat(32) }, "STALE_CHAIN_CONTEXT"],
    [{ value: "1" }, "AUTHORITY_MISMATCH"],
    [{ scriptPubKey: { hex: "51" } }, "AUTHORITY_MISMATCH"],
  ])("rejects changed unspent authority evidence %s", async (patch, code) => {
    const fixture = authorityFixture();
    Object.assign(fixture.unspent, patch);
    await expect(fixture.build()).rejects.toMatchObject({ code });
  });

  test("stops before commitment if the defining identity output has been spent", async () => {
    const fixture = authorityFixture();
    fixture.rpc.getTxOut.mockImplementation(async () => ok(null));
    await expect(fixture.build()).rejects.toMatchObject({
      code: "AUTHORITY_CHANGED",
    });
  });
});
