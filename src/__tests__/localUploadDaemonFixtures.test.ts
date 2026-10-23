import {
  DataDescriptor,
  EHashTypes,
  MMRDescriptor,
  PartialSignData,
  VDXFDataDescriptor,
  DataDescriptorKey,
  getMMRRoot,
  hashData,
  NotaryEvidence,
  createNotaryEvidenceOutputs,
} from "verus-typescript-primitives";
import { Transaction, networks } from "@bitgo/utxo-lib";
import { localIdentityUploadItems } from "../identity/localUpdateData";
import { readIdentityUpdateEvidence } from "../identity/updateDataEvidence";
import { verifyIdentityUpdateFunding } from "../identity/updateFundingVerification";

const commitments = require("./fixtures/local-upload/commitments.json");
const interoperability = require("./fixtures/local-upload/native-interoperability.json");
const builder = require("./fixtures/local-upload/builder-interoperability.json");

describe("captured VRSCTEST daemon upload references", () => {
  test.each(commitments.map((fixture: any) => [fixture.name, fixture]) as Array<[string, any]>)(
    "matches exact daemon leaf bytes, salted hashes, and MMR root: %s",
    (_name: string, fixture: any) => {
      const request = PartialSignData.fromCLIJson(fixture.request);
      const items = localIdentityUploadItems(request);
      const descriptor = MMRDescriptor.fromJson(fixture.result.mmrdescriptor);
      const hashes = items.map((item, index) => {
        const actual = descriptor.dataDescriptors[index];
        if (item.isHash) {
          expect(actual.objectdata.length).toBe(0);
          expect(actual.salt).toBeUndefined();
          return request.hashType!.eqn(EHashTypes.HASH_SHA256)
            ? item.bytes : Buffer.from(item.bytes).reverse();
        }
        expect(actual.objectdata).toEqual(item.bytes);
        expect(actual.salt).toEqual(item.salt);
        return hashData(Buffer.concat([item.bytes, item.salt!]), descriptor.objectHashType);
      });
      expect(descriptor.mmrHashes.decodeHashVector()).toEqual(hashes);
      expect(descriptor.mmrRoot.objectdata).toEqual(getMMRRoot(hashes, descriptor.mmrHashType));
    }
  );

  test("native-decrypted daemon plaintext is the exact tagged descriptor", () => {
    const plain = interoperability.result.mmrdescriptor;
    const descriptors = [plain.mmrroot, plain.mmrhashes, ...plain.datadescriptors];
    interoperability.records.forEach((record: any, index: number) => {
      const expected = new VDXFDataDescriptor(
        DataDescriptor.fromJson(descriptors[index]), DataDescriptorKey.vdxfid
      ).toBuffer();
      expect(record.taggedPlaintextHex).toBe(expected.toString("hex"));
      expect(Buffer.from(record.encrypted.epk, "hex").length).toBe(32);
      expect(Buffer.from(record.encrypted.objectdata, "hex").length).toBe(expected.length + 16);
    });
    expect(interoperability.daemonDecrypted).toBe(plain.datadescriptors[0].objectdata);
  });

  test.each(builder.cases.map((fixture: any) => [fixture.name, fixture]) as Array<[string, any]>)(
    "preserves exact captured daemon evidence scripts and funded value: %s",
    (_name: string, fixture: any) => {
      const outputs = fixture.daemonOutputScripts.map((hex: string) => ({
        script: Buffer.from(hex, "hex"), value: 0,
      }));
      const groups = readIdentityUpdateEvidence(outputs, fixture.fundingApproval.systemId);
      for (const group of groups.values()) {
        const serialized = createNotaryEvidenceOutputs(new NotaryEvidence({
          systemId: fixture.fundingApproval.systemId, evidence: group.proof,
        }));
        expect(serialized.map((output) => output.script)).toEqual(
          group.outputIndexes.map((index) => outputs[index].script)
        );
      }
      expect(verifyIdentityUpdateFunding(fixture.fundingApproval, fixture.fundedUnsignedHex)).toBe(true);
      const moved = Transaction.fromHex(fixture.fundedUnsignedHex, networks.verus);
      const evidenceOutputCount = fixture.localGroupOutputCounts.reduce((a: number, b: number) => a + b, 0);
      const template = Transaction.fromHex(fixture.localTemplateHex, networks.verus);
      const changeIndex = moved.outs.findIndex((output: { script: Buffer }, index: number) => index >= evidenceOutputCount &&
        !template.outs.some((expected: { script: Buffer }) => expected.script.equals(output.script)));
      const [change] = moved.outs.splice(changeIndex, 1);
      moved.outs.unshift(change);
      expect(() => verifyIdentityUpdateFunding(fixture.fundingApproval, moved.toHex())).toThrow();
    }
  );

  test("construction and funding reference capture uses only allowed chain/funding reads", () => {
    expect(builder.broadcast).toBe(false);
    expect(builder.constructionRpcCalls.every((call: any) => [
      "getIdentity", "getRawTransaction", "fundRawTransaction", "getCurrency",
    ].includes(call.method))).toBe(true);
  });
});
