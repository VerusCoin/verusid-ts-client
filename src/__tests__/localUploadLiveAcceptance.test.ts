import { Transaction, networks } from "@bitgo/utxo-lib";
import { IdentityScript, SmartTransactionScript, EVALS, VDXFDataDescriptor } from "verus-typescript-primitives";
import { parseScript } from "../identity/fundingPrimitives";
import { verifyIdentityUpdateFunding } from "../identity/updateFundingVerification";

const fixture = require("./fixtures/local-upload/live-acceptance.json");

describe("mined local upload regression", () => {
  test("retains the exact accepted signed transaction and verified funding", () => {
    expect(Transaction.fromHex(fixture.signedHex, networks.verus).getId()).toBe(fixture.txid);
    expect(verifyIdentityUpdateFunding(fixture.fundingApproval, fixture.signedHex)).toBe(true);
    expect(fixture.mempoolAccepted).toBe(true);
    expect(fixture.status).toBe("confirmed-and-retrieved");
    expect(fixture.confirmations).toBeGreaterThanOrEqual(1);
    expect(fixture.confirmedIdentity.txid).toBe(fixture.txid);
  });

  test("records retrieval and authentication of all six requested leaves", () => {
    expect(fixture.retrieval.transactionBytesExact).toBe(true);
    expect(fixture.retrieval.fundingReverified).toBe(true);
    expect(fixture.retrieval.everyRequestedLeafAuthenticated).toBe(true);
    // Four encrypted references, six leaves, and an MMR root/hash vector.
    expect(fixture.retrieval.authenticatedDescriptorCount).toBe(12);
    expect(fixture.retrieval.groupOutputCounts).toEqual([1, 1, 3, 1]);
    const results = fixture.retrieval.daemonRetrieveResults;
    expect(results.every((result: any) => !result.error)).toBe(true);
    expect(results[0].result[0].objectdata).toBe(Buffer.from(fixture.uploads[0].message).toString("hex"));
    expect(results[1].result[0].objectdata).toBe(Buffer.from(fixture.uploads[1].message).toString("hex"));
    expect(results[2].result[0].objectdata).toBe(Buffer.from(fixture.uploads[2].mmrdata[0].message).toString("hex"));
    expect(results[3].result[0].objectdata).toBe(Buffer.from(fixture.uploads[3].mmrdata[0].message).toString("hex"));
  });

  test("publishes only the fresh public recipient keys", () => {
    const tx = Transaction.fromHex(fixture.signedHex, networks.verus);
    const output = tx.outs.find((candidate: { script: Buffer }) => {
      try {
        return parseScript(SmartTransactionScript, candidate.script).paramsOptCC.evalCode.eqn(EVALS.EVAL_IDENTITY_PRIMARY);
      } catch (_) { return false; }
    });
    const identity = parseScript(IdentityScript, output.script).getIdentity();
    const publicKeys: string[] = [];
    for (const [index, entry] of fixture.retrieval.daemonRetrieveResults.entries()) {
      const descriptor = new VDXFDataDescriptor();
      descriptor.fromBuffer(identity.contentMultiMap.kvContent.getByAddress(entry.key)![0] as Buffer);
      expect(descriptor.dataDescriptor.ssk).toBeUndefined();
      if (fixture.uploads[index].encrypttoaddress) {
        expect(descriptor.dataDescriptor.ivk).toBeUndefined();
      } else {
        expect(descriptor.dataDescriptor.ivk!.length).toBe(32);
        publicKeys.push(descriptor.dataDescriptor.ivk!.toString("hex"));
      }
    }
    expect(new Set(publicKeys).size).toBe(2);
    expect(publicKeys.sort()).toEqual(fixture.publicRecipients.map((value: any) => value.ivk).sort());
    expect(fixture.sdkRpcMethods.every((method: string) =>
      ["fundRawTransaction", "getRawTransaction", "getIdentity", "getCurrency"].includes(method)
    )).toBe(true);
  });
});
