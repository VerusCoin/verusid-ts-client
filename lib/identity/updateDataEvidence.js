"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readIdentityUpdateEvidence = readIdentityUpdateEvidence;
const verus_typescript_primitives_1 = require("verus-typescript-primitives");
const fundingPrimitives_1 = require("./fundingPrimitives");
const NOTARY_HEADER_BYTES = 59;
const IMPORT_PROOF = 3;
const MULTIPART_PROOF = 2;
const MAX_CONDITION_BYTES = 6000;
// updateidentity uses an empty evidence script (148 bytes), plus 128 bytes of
// multipart overhead, when choosing the daemon's fixed-size data chunks.
const MULTIPART_CHUNK_BYTES = MAX_CONDITION_BYTES - 148 - 128;
// The daemon's fixed public key for the notary-evidence contract.
const NOTARY_EVIDENCE_PUBLIC_KEY = Buffer.from("03e1894e9d487125be5a8c6657a8ce01bc81ba7816d698dbfcfb0483754eb5a2d9", "hex");
function readProof(bytes) {
    // Notary header: version (1), type (1), system ID (20), outpoint (36),
    // and state (1). Uploads use a nonzero system, a null outpoint, and state 2
    // (supporting evidence).
    (0, fundingPrimitives_1.requireCondition)(bytes.length > NOTARY_HEADER_BYTES &&
        bytes[0] === 1 &&
        (bytes[1] === IMPORT_PROOF || bytes[1] === MULTIPART_PROOF) &&
        !bytes.subarray(2, 22).equals(Buffer.alloc(20)) &&
        bytes.subarray(22, 58).equals(Buffer.alloc(36)) &&
        bytes[58] === 2, "Invalid identity upload evidence header.");
    const proof = new verus_typescript_primitives_1.CrossChainProof();
    // Require the entire remaining payload and its canonical serialization.
    // This also rejects padding that could increase the calculated fee allowance.
    (0, fundingPrimitives_1.requireCondition)(proof.fromBuffer(bytes, NOTARY_HEADER_BYTES) === bytes.length &&
        proof.version.eqn(1) &&
        proof.isValid() &&
        proof.toBuffer().equals(bytes.subarray(NOTARY_HEADER_BYTES)), "Noncanonical identity upload evidence.");
    return proof;
}
function fitsSingleOutput(smart, bytes) {
    smart.paramsOptCC.vData = [bytes];
    // The daemon appends the master condition as another push in the parameters.
    return (smart.paramsOptCC.toChunk().length +
        1 +
        smart.masterOptCC.toChunk().length <
        MAX_CONDITION_BYTES);
}
/** Read the daemon's evidence groups, preserving their starting output indexes. */
function readIdentityUpdateEvidence(outputs) {
    let systemID;
    // Validate each physical output first. Preserve array positions because the
    // identity's data links refer to transaction output indexes.
    const evidence = outputs.map((output) => {
        const smart = (0, fundingPrimitives_1.parseScript)(verus_typescript_primitives_1.SmartTransactionScript, output.script);
        const master = smart.masterOptCC;
        const params = smart.paramsOptCC;
        if (params.evalCode.eqn(verus_typescript_primitives_1.EVALS.EVAL_IDENTITY_PRIMARY))
            return undefined;
        const destination = params.destinations[0];
        (0, fundingPrimitives_1.requireCondition)(
        // Evidence carries no native value and uses the fixed 1-of-1 contract.
        output.value === 0 &&
            params.evalCode.eqn(verus_typescript_primitives_1.EVALS.EVAL_NOTARY_EVIDENCE) &&
            params.version.eqn(3) &&
            params.m.eqn(1) &&
            params.n.eqn(1) &&
            params.destinations.length === 1 &&
            params.vData.length === 1 &&
            destination.type.eq(verus_typescript_primitives_1.TxDestination.TYPE_PK) &&
            destination.data.toBuffer().equals(NOTARY_EVIDENCE_PUBLIC_KEY) &&
            // The outer master condition must use the same destination, with no
            // additional payload or alternative authorization.
            master.version.eqn(3) &&
            master.evalCode.eqn(verus_typescript_primitives_1.EVALS.EVAL_NONE) &&
            master.m.eqn(1) &&
            master.n.eqn(1) &&
            master.destinations.length === 1 &&
            master.vData.length === 0 &&
            master.destinations[0].toBuffer().equals(destination.toBuffer()), "Unsupported identity upload evidence output.");
        const bytes = params.vData[0];
        const proof = readProof(bytes);
        (0, fundingPrimitives_1.requireCondition)(fitsSingleOutput(smart, bytes), "Identity upload evidence output exceeds the daemon size limit.");
        const proofSystem = bytes.subarray(2, 22);
        (0, fundingPrimitives_1.requireCondition)(!systemID || systemID.equals(proofSystem), "Identity upload evidence systems do not match.");
        systemID = proofSystem;
        return { smart, bytes, proof };
    });
    // Group complete uploads by the index of their first output.
    const groups = new Map();
    for (let index = 0; index < evidence.length; index++) {
        const first = evidence[index];
        if (!first)
            continue;
        // A normal import proof already contains the complete data objects.
        if (first.bytes[1] === IMPORT_PROOF) {
            (0, fundingPrimitives_1.requireCondition)(first.proof.chainObjects.every((object) => object.type.eqn(verus_typescript_primitives_1.ETypes.TYPE_DATA)), "Unexpected multipart object inside identity upload evidence.");
            groups.set(index, { proof: first.proof, outputIndexes: [index] });
            continue;
        }
        const startIndex = index;
        const chunks = [];
        const outputIndexes = [];
        let totalLength = 0;
        let offset = 0;
        // Multipart outputs must be consecutive and agree on the header, total
        // length, chunk indexes, and byte offsets. Only the last chunk may be short.
        do {
            const part = evidence[index];
            (0, fundingPrimitives_1.requireCondition)(part &&
                part.bytes[1] === MULTIPART_PROOF &&
                part.bytes
                    .subarray(2, NOTARY_HEADER_BYTES)
                    .equals(first.bytes.subarray(2, NOTARY_HEADER_BYTES)) &&
                part.proof.chainObjects.length === 1, "Missing or mismatched identity upload evidence part.");
            const chunk = part.proof.chainObjects[0];
            (0, fundingPrimitives_1.requireCondition)(chunk.type.eqn(verus_typescript_primitives_1.ETypes.TYPE_MULTIPART_DATA) &&
                chunk.md &&
                chunk.md.index.eqn(chunks.length) &&
                chunk.md.start.eqn(offset) &&
                chunk.md.total_length.gtn(0) &&
                chunk.md.total_length.bitLength() <= 53, "Invalid identity upload evidence part order or offset.");
            if (!chunks.length)
                totalLength = chunk.md.total_length.toNumber();
            (0, fundingPrimitives_1.requireCondition)(chunk.md.total_length.eqn(totalLength) &&
                chunk.data_vec.length ===
                    Math.min(MULTIPART_CHUNK_BYTES, totalLength - offset), "Invalid identity upload evidence chunk length.");
            chunks.push(chunk.data_vec);
            outputIndexes.push(index);
            offset += chunk.data_vec.length;
            // Leave index on the last part so the outer loop advances to a new group.
            if (offset < totalLength)
                index++;
        } while (offset < totalLength);
        // Reassemble the original import proof. Splitting a small proof would add
        // unnecessary outputs and inflate fees, so it must exceed the single-output
        // limit before multipart encoding is accepted.
        const bytes = Buffer.concat(chunks);
        const proof = readProof(bytes);
        (0, fundingPrimitives_1.requireCondition)(bytes[1] === IMPORT_PROOF &&
            bytes
                .subarray(2, NOTARY_HEADER_BYTES)
                .equals(first.bytes.subarray(2, NOTARY_HEADER_BYTES)) &&
            proof.chainObjects.every((object) => object.type.eqn(verus_typescript_primitives_1.ETypes.TYPE_DATA)) &&
            !fitsSingleOutput(first.smart, bytes), "Noncanonical multipart identity upload evidence.");
        groups.set(startIndex, { proof, outputIndexes });
    }
    return groups;
}
