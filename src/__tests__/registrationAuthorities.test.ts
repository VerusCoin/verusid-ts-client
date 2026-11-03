import BN from "bn.js";
import { networks, TransactionBuilder } from "@bitgo/utxo-lib";
import {
  ApiRequest,
  CurrencyOptions,
  Identity,
  IdentityID,
  IdentityScript,
  KeyID,
  nameAndParentAddrToIAddr,
} from "verus-typescript-primitives";
import { VerusdRpcInterface } from "verusd-rpc-ts-client";
import { createNameReservationTransaction } from "../identity/registration";
import { paymentOutput } from "../identity/registrationTransaction";

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

function authorityFixture(
  flags = 0,
  unlockAfter = 0,
  identityFunding = false,
  batched = false
) {
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
    identityFunding
      ? Buffer.from(
          paymentOutput(controllerID, {}, systemID, "change").scriptHex,
          "hex"
        )
      : address.toOutputScript(key.toAddress(), networks.verus),
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
  const requestMany = jest.fn(async (reads: ApiRequest[]) =>
    Promise.all(
      reads.map((read) => {
        const method = Object.keys(rpc).find(
          (name) => name.toLowerCase() === read.cmd
        )!;
        return (rpc as any)[method](...read.getParams());
      })
    )
  );
  if (batched) Object.assign(rpc, { requestMany });

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
  return { build, declared, unspent, rpc, authority, request, requestMany };
}

describe("registration authority evidence before commitment", () => {
  test.each([false, true])(
    "shares decoding but refreshes authority spendability before returning a plan, batched=%s",
    async (batched) => {
      const fixture = authorityFixture(0, 0, true, batched);
      fixture.request.changeAddress = controllerID;
      const { transaction } = await fixture.build();

      const authorityLookups = () =>
        fixture.rpc.getIdentity.mock.calls.filter(
          ([id]) => id === controllerID
        );
      const authorityUnspents = () =>
        fixture.rpc.getTxOut.mock.calls.filter(
          ([txid]) => txid === fixture.authority.getId()
        );
      expect(authorityLookups()).toHaveLength(1);
      expect(authorityUnspents()).toHaveLength(2);
      expect(fixture.rpc.getRawTransaction).toHaveBeenCalledTimes(1);
      expect(transaction.identityAuthorities).toEqual(
        transaction.revealAuthorities
      );

      // One final check covers every use of this authority without another
      // identity/raw-transaction lookup or an extra batch round trip.
      if (batched) {
        const batches = fixture.requestMany.mock.calls;
        expect(
          batches[batches.length - 1][0].map((read) => read.prepare())
        ).toEqual([
          [systemID, "getinfo", []],
          [systemID, "getblock", ["100", 1]],
          [systemID, "gettxout", [fixture.authority.getId(), 0, true]],
        ]);
      } else {
        expect(fixture.requestMany).not.toHaveBeenCalled();
      }

      // Frozen plans expose independent copies, including their nested key arrays.
      expect(transaction.identityAuthorities[0]).not.toBe(
        transaction.revealAuthorities[0]
      );
      expect(transaction.identityAuthorities[0].primaryAddresses).not.toBe(
        transaction.revealAuthorities[0].primaryAddresses
      );
      expect(() => {
        transaction.identityAuthorities[0].primaryAddresses[0] = "changed";
      }).toThrow();
      expect(transaction.revealAuthorities[0].primaryAddresses).toEqual([
        key.toAddress(),
      ]);

      await fixture.build();
      expect(authorityLookups()).toHaveLength(2);
      expect(authorityUnspents()).toHaveLength(4);
      expect(fixture.rpc.getRawTransaction).toHaveBeenCalledTimes(2);

      // A subsequent preparation must still detect a newly spent authority.
      fixture.rpc.getTxOut.mockImplementation(async () => ok(null));
      await expect(fixture.build()).rejects.toMatchObject({
        code: "AUTHORITY_CHANGED",
      });
    }
  );

  test.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "rejects an authority spent during preparation with an unchanged tip, identity funding=%s, batched=%s",
    async (identityFunding, batched) => {
      const fixture = authorityFixture(0, 0, identityFunding, batched);
      fixture.request.changeAddress = controllerID;
      const original = fixture.rpc.getTxOut.getMockImplementation()!;
      let spent = false;

      fixture.rpc.getTxOut.mockImplementation(async (txid) => {
        if (txid === fixture.authority.getId() && spent) return ok(null);
        const response = await original(txid);

        // Identity funding loses its authority while funding is checked.
        // R-address funding still needs the change/controller authority to
        // remain spendable after its initial proof was cached.
        if (
          identityFunding
            ? txid !== fixture.authority.getId()
            : txid === fixture.authority.getId()
        ) {
          spent = true;
        }
        return response;
      });

      await expect(fixture.build()).rejects.toMatchObject({
        code: "AUTHORITY_CHANGED",
      });
      expect(spent).toBe(true);
      expect(fixture.rpc.getRawTransaction).toHaveBeenCalledTimes(1);
      expect(
        fixture.rpc.getIdentity.mock.calls.filter(([id]) => id === controllerID)
      ).toHaveLength(1);
    }
  );

  test.each([
    [{ confirmations: 0 }, "AUTHORITY_MISMATCH"],
    [{ confirmations: 50 }, "AUTHORITY_MISMATCH"],
    [{ bestblock: "ff".repeat(32) }, "STALE_CHAIN_CONTEXT"],
    [{ value: "1" }, "AUTHORITY_MISMATCH"],
    [{ scriptPubKey: { hex: "51" } }, "AUTHORITY_MISMATCH"],
  ])(
    "rejects changed authority evidence in the final batch %s",
    async (patch, code) => {
      const fixture = authorityFixture(0, 0, false, true);
      const original = fixture.rpc.getTxOut.getMockImplementation()!;
      let authorityReads = 0;

      fixture.rpc.getTxOut.mockImplementation(async (txid) => {
        if (txid === fixture.authority.getId() && ++authorityReads > 1) {
          return ok({ ...fixture.unspent, ...patch });
        }
        return original(txid);
      });

      await expect(fixture.build()).rejects.toMatchObject({ code });
      expect(authorityReads).toBe(2);
    }
  );

  test.each([false, true])(
    "does not return a plan when the final authority check fails, transport rejection=%s",
    async (rejected) => {
      const fixture = authorityFixture(0, 0, false, true);
      const original = fixture.rpc.getTxOut.getMockImplementation()!;
      let authorityReads = 0;

      fixture.rpc.getTxOut.mockImplementation(async (txid) => {
        if (txid === fixture.authority.getId() && ++authorityReads > 1) {
          if (rejected) throw new Error("Authority lookup unavailable");
          return {
            result: null,
            error: { code: -1, message: "Authority lookup unavailable" },
          } as any;
        }
        return original(txid);
      });

      await expect(fixture.build()).rejects.toThrow(
        "Authority lookup unavailable"
      );
      expect(authorityReads).toBe(2);
    }
  );

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
