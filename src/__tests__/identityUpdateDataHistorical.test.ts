import {
  BufferDataVdxfObject,
  DataDescriptor,
  IdentityUpdateRequestDetails,
} from "verus-typescript-primitives";
import { verifyIdentityUpdateData } from "../identity/updateDataVerification";
import { decryptHistoricalUpload } from "./fixtures/decryptIdentityUpdateData";
import { historicalUploadPayloadRequest } from "./fixtures/historicalUploadRequest";
import {
  TEST_ID_5_REQUEST_JSON,
  TEST_ID_5_SIGNDATA_UPDATE_UNFUNDED_TX,
} from "./fixtures/verusid";

test("rejects unsupported historical per-leaf metadata while parsing the request", () => {
  expect(() => IdentityUpdateRequestDetails.fromCLIJson(
    TEST_ID_5_REQUEST_JSON,
    {}
  )).toThrow("MMR data items must contain exactly one supported data key");
});

test("rejects authenticated historical upload metadata absent from a payload-only request", async () => {
  const request = IdentityUpdateRequestDetails.fromCLIJson(
    historicalUploadPayloadRequest(TEST_ID_5_REQUEST_JSON),
    {}
  );
  const decrypted: DataDescriptor[] = [];

  const decrypt = (descriptor: DataDescriptor) => {
    const plaintext = decryptHistoricalUpload(descriptor);

    // Retain each inner descriptor to identify which authenticated object
    // contains metadata that was omitted from the typed request.
    const wrapped = new BufferDataVdxfObject();
    wrapped.fromBuffer(plaintext);

    const inner = new DataDescriptor();
    inner.fromBuffer(wrapped.toDataBuffer());
    decrypted.push(inner);

    return plaintext;
  };

  // The historical daemon response includes per-item labels and MIME types
  // that this payload-only request does not authorize. Accepting these fields
  // would allow unrequested bytes to increase the calculated fee allowance.
  await expect(
    verifyIdentityUpdateData(
      request,
      TEST_ID_5_SIGNDATA_UPDATE_UNFUNDED_TX,
      decrypt
    )
  ).rejects.toThrow("Unexpected identity upload descriptor metadata");

  // Authentication succeeds for the link, root, hash vector, and first leaf.
  // Its payload is correct: rejection is specifically for discarded metadata.
  expect(decrypted).toHaveLength(4);

  const firstRequested =
    TEST_ID_5_REQUEST_JSON.contentmultimap.i5CXAPoCLothTntExgvc5kK38u2wyHtFCg
      .data.mmrdata[0];

  expect(decrypted[3].objectdata.toString("utf8")).toBe(firstRequested.message);
  expect(decrypted[3].label).toBe(firstRequested.label);
  expect(decrypted[3].mimeType).toBe(firstRequested.mimetype);
});
