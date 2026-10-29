import BN from "bn.js";
import { Transaction, networks } from "@bitgo/utxo-lib";
import {
  Identity,
  IdentityScript,
  IdentityUpdateRequestDetails,
  PartialIdentity,
} from "verus-typescript-primitives";
import { applyLocalIdentityUpdate } from "../identity/localIdentityUpdate";
import { verifyIdentityUpdateFunding } from "../identity/updateFundingVerification";

const fixture = require("./fixtures/local-upload/live-identity-locks.json");
const accepted = fixture.cases.filter((entry: any) => entry.broadcastResult);

function definition(raw: string): Identity {
  const tx = Transaction.fromHex(raw, networks.verus);
  for (const output of tx.outs) {
    try {
      const script = new IdentityScript();
      script.fromBuffer(output.script);
      const identity = script.getIdentity(false);
      if (identity.getIdentityAddress() === fixture.identity) return identity;
    } catch (_) {}
  }
  throw new Error("Missing recorded identity output.");
}

describe("confirmed daemon identity lock and private-vector fixtures", () => {
  test.each(accepted as any[])(
    "reproduces the exact accepted mutation and verifies approval: $name",
    (record) => {
      const source = definition(record.sourceHex);
      const request = new IdentityUpdateRequestDetails();
      request.fromBuffer(Buffer.from(record.requestHex, "hex"), 0, false);
      const result = applyLocalIdentityUpdate(source, request.identity!, {
        chainId: fixture.chain,
        nextBlockHeight: record.height + 1,
        expiryHeight: record.expiryHeight,
      });
      expect(result.identity.toBuffer().toString("hex")).toBe(
        record.identityHex
      );
      expect(
        Transaction.fromHex(record.signedHex, networks.verus).getId()
      ).toBe(record.txid);
      expect(record.confirmations).toBeGreaterThanOrEqual(1);
      expect(record.blockhash).toMatch(/^[0-9a-f]{64}$/);
      expect(
        verifyIdentityUpdateFunding(record.fundingApproval, record.signedHex)
      ).toBe(true);
      expect(
        record.constructionRpcCalls.map((call: any) => call.method)
      ).not.toContain("updateidentity");
      expect(
        record.constructionRpcCalls.map((call: any) => call.method)
      ).not.toContain("signdata");
    }
  );

  test("the confirmed locked source contains both private addresses", () => {
    const lock = accepted.find(
      (entry: any) => entry.name === "lock-and-private-vector"
    );
    expect(lock.confirmations).toBeGreaterThanOrEqual(1);
    expect(lock.blockhash).toMatch(/^[0-9a-f]{64}$/);
    const identity = definition(lock.signedHex);
    expect(identity.isLocked()).toBe(true);
    expect(identity.unlockAfter.toNumber()).toBe(2);
    expect(identity.privateAddresses).toHaveLength(2);
    const preservation = fixture.liveMultiplePrivateVectorPreservation;
    const preserved = definition(preservation.templateHex);
    expect(
      preserved.privateAddresses.map((value) =>
        value.toBuffer().toString("hex")
      )
    ).toEqual(preservation.sourcePrivateAddresses);
  });

  test("matches daemon unlock output from the actual locked source exactly", () => {
    const reference = fixture.liveUnlockDaemonComparison;
    const source = definition(reference.sourceHex);
    expect(source.isLocked()).toBe(true);
    expect(source.privateAddresses).toHaveLength(2);
    const request = new PartialIdentity({
      name: source.name,
      parent: source.parent,
      flags: new BN(0),
    });
    request.privateAddresses = [];
    request.contains = request.contains.or(
      PartialIdentity.PARTIAL_ID_CONTAINS_PRIV_ADDRS
    );
    const result = applyLocalIdentityUpdate(source, request, {
      chainId: fixture.chain,
      nextBlockHeight: reference.height + 1,
      expiryHeight: reference.expiryHeight,
    });
    expect(result.identity.toBuffer().toString("hex")).toBe(
      reference.identityHex
    );
    expect(result.identity.unlockAfter.toNumber()).toBe(
      reference.expiryHeight + 2
    );
  });

  test("rejects a shortened lock on the confirmed source and restores the original private vector", () => {
    const unlock = accepted.find(
      (entry: any) => entry.name === "unlock-and-restore-private-vector"
    );
    const source = definition(unlock.sourceHex);
    const shortened = new PartialIdentity({
      name: source.name,
      parent: source.parent,
      unlockAfter: new BN(1),
    });
    expect(() =>
      applyLocalIdentityUpdate(source, shortened, {
        chainId: fixture.chain,
        nextBlockHeight: unlock.height + 1,
        expiryHeight: unlock.expiryHeight,
      })
    ).toThrow(/cannot be shortened/);
    const restored = definition(unlock.signedHex);
    expect(restored.isLocked()).toBe(false);
    expect(restored.unlockAfter.toNumber()).toBe(unlock.expiryHeight + 2);
    expect(restored.privateAddresses || []).toEqual([]);
  });
});
