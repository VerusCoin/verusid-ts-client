import {
  CrossChainProof,
  ETypes,
  EVALS,
  SmartTransactionScript,
  TxDestination,
  fromBase58Check,
  NOTARY_EVIDENCE_MAX_CONDITION_BYTES,
  NOTARY_EVIDENCE_MULTIPART_CHUNK_BYTES,
  NOTARY_EVIDENCE_PUBLIC_KEY_HEX,
} from "verus-typescript-primitives";
import { parseScript, requireCondition } from "./fundingPrimitives";

type Output = { script: Buffer; value: number };

export type IdentityUpdateEvidence = {
  proof: CrossChainProof;
  outputIndexes: number[];
};

const NOTARY_HEADER_BYTES = 59;
const IMPORT_PROOF = 3;
const MULTIPART_PROOF = 2;
const MAX_CONDITION_BYTES = NOTARY_EVIDENCE_MAX_CONDITION_BYTES;

// updateidentity uses an empty evidence script (148 bytes), plus 128 bytes of
// multipart overhead, when choosing the daemon's fixed-size data chunks.
const MULTIPART_CHUNK_BYTES = NOTARY_EVIDENCE_MULTIPART_CHUNK_BYTES;

// The daemon's fixed public key for the notary-evidence contract.
const NOTARY_EVIDENCE_PUBLIC_KEY = Buffer.from(
  NOTARY_EVIDENCE_PUBLIC_KEY_HEX,
  "hex"
);

function readProof(bytes: Buffer): CrossChainProof {
  // Notary header: version (1), type (1), system ID (20), outpoint (36),
  // and state (1). Uploads use a nonzero system, a null outpoint, and state 2
  // (supporting evidence).
  requireCondition(
    bytes.length > NOTARY_HEADER_BYTES &&
      bytes[0] === 1 &&
      (bytes[1] === IMPORT_PROOF || bytes[1] === MULTIPART_PROOF) &&
      !bytes.subarray(2, 22).equals(Buffer.alloc(20)) &&
      bytes.subarray(22, 58).equals(Buffer.alloc(36)) &&
      bytes[58] === 2,
    "Invalid identity upload evidence header."
  );

  const proof = new CrossChainProof();

  // Require the entire remaining payload and its canonical serialization.
  // This also rejects padding that could increase the calculated fee allowance.
  requireCondition(
    proof.fromBuffer(bytes, NOTARY_HEADER_BYTES) === bytes.length &&
      proof.version.eqn(1) &&
      proof.isValid() &&
      proof.toBuffer().equals(bytes.subarray(NOTARY_HEADER_BYTES)),
    "Noncanonical identity upload evidence."
  );

  return proof;
}

function fitsSingleOutput(
  smart: SmartTransactionScript,
  bytes: Buffer
): boolean {
  smart.paramsOptCC.vData = [bytes];

  // The daemon appends the master condition as another push in the parameters.
  return (
    smart.paramsOptCC.toChunk().length +
      1 +
      smart.masterOptCC.toChunk().length <
    MAX_CONDITION_BYTES
  );
}

/** Read the daemon's evidence groups, preserving their starting output indexes. */
export function readIdentityUpdateEvidence(
  outputs: Output[],
  expectedSystemId?: string
): Map<number, IdentityUpdateEvidence> {
  let systemID: Buffer | undefined;

  // Validate each physical output first. Preserve array positions because the
  // identity's data links refer to transaction output indexes.
  const evidence = outputs.map((output) => {
    const smart = parseScript(SmartTransactionScript, output.script);
    const master = smart.masterOptCC;
    const params = smart.paramsOptCC;

    if (params.evalCode.eqn(EVALS.EVAL_IDENTITY_PRIMARY)) return undefined;

    const destination = params.destinations[0];

    requireCondition(
      // Evidence carries no native value and uses the fixed 1-of-1 contract.
      output.value === 0 &&
        params.evalCode.eqn(EVALS.EVAL_NOTARY_EVIDENCE) &&
        params.version.eqn(3) &&
        params.m.eqn(1) &&
        params.n.eqn(1) &&
        params.destinations.length === 1 &&
        params.vData.length === 1 &&
        destination.type.eq(TxDestination.TYPE_PK) &&
        destination.data.toBuffer().equals(NOTARY_EVIDENCE_PUBLIC_KEY) &&
        // The outer master condition must use the same destination, with no
        // additional payload or alternative authorization.
        master.version.eqn(3) &&
        master.evalCode.eqn(EVALS.EVAL_NONE) &&
        master.m.eqn(1) &&
        master.n.eqn(1) &&
        master.destinations.length === 1 &&
        master.vData.length === 0 &&
        master.destinations[0].toBuffer().equals(destination.toBuffer()),
      "Unsupported identity upload evidence output."
    );

    const bytes = params.vData[0];
    const proof = readProof(bytes);

    requireCondition(
      fitsSingleOutput(smart, bytes),
      "Identity upload evidence output exceeds the daemon size limit."
    );

    const proofSystem = bytes.subarray(2, 22);

    requireCondition(
      (!systemID || systemID.equals(proofSystem)) &&
        (!expectedSystemId ||
          proofSystem.equals(fromBase58Check(expectedSystemId).hash)),
      "Identity upload evidence systems do not match."
    );

    systemID = proofSystem;

    return { smart, bytes, proof };
  });

  // Group complete uploads by the index of their first output.
  const groups = new Map<number, IdentityUpdateEvidence>();

  for (let index = 0; index < evidence.length; index++) {
    const first = evidence[index];

    if (!first) continue;

    // A normal import proof already contains the complete data objects.
    if (first.bytes[1] === IMPORT_PROOF) {
      requireCondition(
        first.proof.chainObjects.every((object) =>
          object.type.eqn(ETypes.TYPE_DATA)
        ),
        "Unexpected multipart object inside identity upload evidence."
      );

      groups.set(index, { proof: first.proof, outputIndexes: [index] });

      continue;
    }

    const startIndex = index;
    const chunks: Buffer[] = [];
    const outputIndexes: number[] = [];

    let totalLength = 0;
    let offset = 0;

    // Multipart outputs must be consecutive and agree on the header, total
    // length, chunk indexes, and byte offsets. Only the last chunk may be short.
    do {
      const part = evidence[index];

      requireCondition(
        part &&
          part.bytes[1] === MULTIPART_PROOF &&
          part.bytes
            .subarray(2, NOTARY_HEADER_BYTES)
            .equals(first.bytes.subarray(2, NOTARY_HEADER_BYTES)) &&
          part.proof.chainObjects.length === 1,
        "Missing or mismatched identity upload evidence part."
      );

      const chunk = part.proof.chainObjects[0];

      requireCondition(
        chunk.type.eqn(ETypes.TYPE_MULTIPART_DATA) &&
          chunk.md &&
          chunk.md.index.eqn(chunks.length) &&
          chunk.md.start.eqn(offset) &&
          chunk.md.total_length.gtn(0) &&
          chunk.md.total_length.bitLength() <= 53,
        "Invalid identity upload evidence part order or offset."
      );

      if (!chunks.length) totalLength = chunk.md.total_length.toNumber();

      requireCondition(
        chunk.md.total_length.eqn(totalLength) &&
          chunk.data_vec.length ===
            Math.min(MULTIPART_CHUNK_BYTES, totalLength - offset),
        "Invalid identity upload evidence chunk length."
      );

      chunks.push(chunk.data_vec);
      outputIndexes.push(index);
      offset += chunk.data_vec.length;

      // Leave index on the last part so the outer loop advances to a new group.
      if (offset < totalLength) index++;
    } while (offset < totalLength);

    // Reassemble the original import proof. Splitting a small proof would add
    // unnecessary outputs and inflate fees, so it must exceed the single-output
    // limit before multipart encoding is accepted.
    const bytes = Buffer.concat(chunks);
    const proof = readProof(bytes);

    requireCondition(
      bytes[1] === IMPORT_PROOF &&
        bytes
          .subarray(2, NOTARY_HEADER_BYTES)
          .equals(first.bytes.subarray(2, NOTARY_HEADER_BYTES)) &&
        proof.chainObjects.every((object) =>
          object.type.eqn(ETypes.TYPE_DATA)
        ) &&
        !fitsSingleOutput(first.smart, bytes),
      "Noncanonical multipart identity upload evidence."
    );

    groups.set(startIndex, { proof, outputIndexes });
    requireCondition(
      evidence[index + 1]?.bytes[1] !== MULTIPART_PROOF,
      "Adjacent multipart identity uploads cannot be retrieved by the daemon."
    );
  }

  return groups;
}
