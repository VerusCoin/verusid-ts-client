"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyIdentityUpdateData = verifyIdentityUpdateData;
const verus_typescript_primitives_1 = require("verus-typescript-primitives");
const VDXF = __importStar(require("verus-typescript-primitives/dist/vdxf/vdxfdatakeys"));
const bufferutils_1 = __importDefault(require("verus-typescript-primitives/dist/utils/bufferutils"));
const fundingPrimitives_1 = require("./fundingPrimitives");
const updateDataEvidence_1 = require("./updateDataEvidence");
const requestSnapshot_1 = require("./requestSnapshot");
// Authenticated encryption adds a fixed tag, not arbitrary ciphertext padding.
const AUTHENTICATION_TAG_BYTES = 16;
// Allow the identity signature header and up to 25 compact signatures.
const MAX_IDENTITY_SIGNATURE_BYTES = 8 + 25 * 66;
/** Consume the entire object and reject alternate encodings or trailing bytes. */
function decode(value, bytes) {
    (0, fundingPrimitives_1.requireCondition)(value.fromBuffer(bytes, 0) === bytes.length &&
        value.toBuffer().equals(bytes), "Noncanonical identity upload data.");
    return value;
}
/** Remove a VDXF wrapper only after checking its version and expected type key. */
function tagged(bytes, key) {
    const value = decode(new verus_typescript_primitives_1.BufferDataVdxfObject(), bytes);
    (0, fundingPrimitives_1.requireCondition)(value.version.eqn(1) && value.vdxfkey === key, "Unexpected identity upload data type.");
    return value.toDataBuffer();
}
/** Decrypted descriptors may contain only the metadata expected at this layer. */
function metadata(descriptor, label = "", mimeType = "", salted = false) {
    var _a, _b;
    (0, fundingPrimitives_1.requireCondition)(descriptor.version.eqn(1) &&
        !descriptor.hasEncryptedData() &&
        !descriptor.hasVDXFKey() &&
        !descriptor.hasEPK() &&
        !descriptor.hasIVK() &&
        !descriptor.hasSSK() &&
        (descriptor.label || "") === label &&
        (descriptor.mimeType || "") === mimeType &&
        (salted ? ((_a = descriptor.salt) === null || _a === void 0 ? void 0 : _a.length) === 32 : !((_b = descriptor.salt) === null || _b === void 0 ? void 0 : _b.length)), "Unexpected identity upload descriptor metadata.");
}
function decryptDescriptor(descriptor_1, decrypt_1, context_1, ivk_1) {
    return __awaiter(this, arguments, void 0, function* (descriptor, decrypt, context, ivk, publicLink = false) {
        var _a, _b, _c, _d, _e, _f;
        // Only public contentmultimap (CMM) links may publish an incoming viewing key
        // (IVK). Private uploads must use the wallet's key for the requested recipient.
        // Reject extra keys and metadata that could also inflate the funded size.
        (0, fundingPrimitives_1.requireCondition)(descriptor.version.eqn(1) &&
            descriptor.hasEncryptedData() &&
            ((_a = descriptor.epk) === null || _a === void 0 ? void 0 : _a.length) === 32 &&
            (publicLink ? ((_b = descriptor.ivk) === null || _b === void 0 ? void 0 : _b.length) === 32 : !((_c = descriptor.ivk) === null || _c === void 0 ? void 0 : _c.length)) &&
            !((_d = descriptor.ssk) === null || _d === void 0 ? void 0 : _d.length) &&
            !((_e = descriptor.salt) === null || _e === void 0 ? void 0 : _e.length) &&
            !descriptor.label &&
            !descriptor.mimeType &&
            !descriptor.hasVDXFKey(), "Invalid encrypted identity upload descriptor.");
        // Pass detached objects to application code. Child descriptors inherit the
        // public link's IVK on this copy, without changing the transaction's bytes.
        const copy = decode(new verus_typescript_primitives_1.DataDescriptor(), Buffer.from(descriptor.toBuffer()));
        if (!((_f = copy.ivk) === null || _f === void 0 ? void 0 : _f.length) && (ivk === null || ivk === void 0 ? void 0 : ivk.length)) {
            copy.ivk = Buffer.from(ivk);
            copy.setFlags();
        }
        const plaintext = yield decrypt(copy, Object.assign({}, context));
        // The callback authenticates the ciphertext. The SDK still checks its length
        // and parses the returned bytes itself before trusting any decrypted fields.
        (0, fundingPrimitives_1.requireCondition)(Buffer.isBuffer(plaintext) &&
            descriptor.objectdata.length ===
                plaintext.length + AUTHENTICATION_TAG_BYTES, "Identity upload decryption returned an invalid plaintext length.");
        return decode(new verus_typescript_primitives_1.DataDescriptor(), tagged(plaintext, VDXF.DataDescriptorKey.vdxfid));
    });
}
/** Treat single-item and MMR requests uniformly when comparing uploaded leaves. */
function uploadItems(request) {
    const items = request.isMMRData()
        ? request.data.data
        : [
            {
                type: request.dataType,
                data: request.data,
            },
        ];
    (0, fundingPrimitives_1.requireCondition)(items.length > 0, "Identity upload request has no data.");
    // A filename describes the daemon's filesystem, not bytes approved locally.
    for (const item of items) {
        (0, fundingPrimitives_1.requireCondition)(item.type && !item.type.eq(verus_typescript_primitives_1.DATA_TYPE_FILENAME), "Identity upload verification requires inline data, not a remote filename.");
    }
    return items;
}
/**
 * Verify the upload portion of an unfunded identity-update template. Every
 * evidence group must be referenced by a requested content key and every leaf
 * must match its requested bytes. This checks uploaded content and its bounded
 * encoding; it does not verify data signatures or recompute MMR commitments.
 */
function verifyIdentityUpdateData(request, unfundedTxHex, decryptData) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        // Retain the exact request fields used by RPC before callbacks can mutate them.
        request = (0, requestSnapshot_1.snapshotUpdateRequestValue)(request);
        // Collect complete evidence groups and the identity that links to them.
        // Ordinary identity fields and transaction funding are checked by the caller.
        const tx = (0, fundingPrimitives_1.transaction)(unfundedTxHex);
        const groups = (0, updateDataEvidence_1.readIdentityUpdateEvidence)(tx.outs);
        const definitions = tx.outs.filter((output) => (0, fundingPrimitives_1.parseScript)(verus_typescript_primitives_1.SmartTransactionScript, output.script).paramsOptCC.evalCode.eqn(verus_typescript_primitives_1.EVALS.EVAL_IDENTITY_PRIMARY));
        (0, fundingPrimitives_1.requireCondition)(definitions.length === 1, "Expected one identity upload definition.");
        const identity = (0, fundingPrimitives_1.parseScript)(verus_typescript_primitives_1.IdentityScript, definitions[0].script).getIdentity();
        (0, fundingPrimitives_1.requireCondition)(request.containsSignData() &&
            request.signDataMap &&
            request.signDataMap.size > 0, "Expected an identity upload request.");
        (0, fundingPrimitives_1.requireCondition)(typeof decryptData === "function", "Identity data uploads require a decryption callback.");
        // Each requested upload owns exactly one group, even if it spans many outputs.
        (0, fundingPrimitives_1.requireCondition)(groups.size === request.signDataMap.size, "Identity upload evidence does not match the requested uploads.");
        for (const [key, upload] of request.signDataMap.entries()) {
            const contentKey = key.toAddress();
            const values = identity.contentMultiMap.kvContent.getByAddress(contentKey);
            (0, fundingPrimitives_1.requireCondition)((values === null || values === void 0 ? void 0 : values.length) === 1 && Buffer.isBuffer(values[0]), "Expected one identity upload link per requested key.");
            const links = values[0];
            const items = uploadItems(upload);
            const context = {
                contentKey,
                encryptToAddress: (_a = upload.encryptToAddress) === null || _a === void 0 ? void 0 : _a.toAddressString(),
            };
            let cursor = 0;
            let groupIndex = -1;
            let sharedIVK;
            const linkCount = upload.address ? 2 : 1;
            // A content entry contains one data link and, when requested, a signature
            // link. Both must reference the same local evidence group.
            for (let index = 0; index < linkCount; index++) {
                const encoded = new verus_typescript_primitives_1.BufferDataVdxfObject();
                const end = encoded.fromBuffer(links, cursor);
                const outer = decode(new verus_typescript_primitives_1.DataDescriptor(), tagged(links.subarray(cursor, end), VDXF.DataDescriptorKey.vdxfid));
                if (index === 0)
                    sharedIVK = outer.ivk;
                const link = yield decryptDescriptor(outer, decryptData, context, sharedIVK, !upload.encryptToAddress);
                metadata(link, index ? "signature" : "", index || items.length > 1 ? "application/json" : "");
                // A zero transaction hash means this transaction. Object 0 contains the
                // upload, with subobject 0 for data and subobject 1 for its signature.
                const reference = decode(new verus_typescript_primitives_1.CrossChainDataRef(), tagged(link.objectdata, VDXF.CrossChainDataRefKey.vdxfid)).ref;
                (0, fundingPrimitives_1.requireCondition)(reference instanceof verus_typescript_primitives_1.PBaaSEvidenceRef &&
                    reference.version.eqn(1) &&
                    reference.flags.eq(verus_typescript_primitives_1.PBaaSEvidenceRef.FLAG_ISEVIDENCE) &&
                    reference.output.hash.equals(Buffer.alloc(32)) &&
                    reference.objectNum.isZero() &&
                    reference.subObject.eqn(index), "Identity upload link does not reference local evidence.");
                const outputIndex = reference.output.n.toNumber();
                if (index === 0)
                    groupIndex = outputIndex;
                (0, fundingPrimitives_1.requireCondition)(outputIndex === groupIndex, "Identity upload links reference different evidence groups.");
                cursor = end;
            }
            (0, fundingPrimitives_1.requireCondition)(cursor === links.length, "Unexpected additional identity upload links.");
            const group = groups.get(groupIndex);
            (0, fundingPrimitives_1.requireCondition)(group && group.proof.chainObjects.length === linkCount, "Missing or unexpected identity upload evidence objects.");
            // Consume the group so another requested key cannot reuse the same evidence.
            groups.delete(groupIndex);
            // The daemon stores a single leaf directly, or an MMR for multiple leaves.
            const dataObject = group.proof.chainObjects[0];
            (0, fundingPrimitives_1.requireCondition)(dataObject.vdxfd === VDXF.DataDescriptorKey.vdxfid, "Unexpected identity upload evidence type.");
            let leaves;
            let hashes;
            let root;
            if (items.length === 1) {
                leaves = [
                    decode(new verus_typescript_primitives_1.DataDescriptor(), tagged(dataObject.data_vec, VDXF.DataDescriptorKey.vdxfid)),
                ];
            }
            else {
                // Multi-item uploads retain their MMR root and hash vector. Their sizes
                // are fixed by the requested leaf count, regardless of encrypted bytes.
                const mmr = decode(new verus_typescript_primitives_1.MMRDescriptor(), tagged(dataObject.data_vec, VDXF.MMRDescriptorKey.vdxfid));
                (0, fundingPrimitives_1.requireCondition)(mmr.version.eqn(1) &&
                    mmr.dataDescriptors.length === items.length &&
                    mmr.objectHashType === upload.hashType.toNumber() &&
                    mmr.mmrHashType ===
                        upload.data.mmrhashtype.toNumber(), "Identity upload MMR does not match the requested items.");
                const rootDescriptor = yield decryptDescriptor(mmr.mmrRoot, decryptData, context, sharedIVK);
                metadata(rootDescriptor);
                root = rootDescriptor.objectdata;
                (0, fundingPrimitives_1.requireCondition)(root.length === 32, "Invalid identity upload MMR root length.");
                const hashDescriptor = yield decryptDescriptor(mmr.mmrHashes, decryptData, context, sharedIVK);
                metadata(hashDescriptor);
                // A CompactSize count precedes one 32-byte hash per requested leaf.
                // Neither extra hashes nor trailing bytes may enlarge the fee allowance.
                const reader = new bufferutils_1.default.BufferReader(tagged(hashDescriptor.objectdata, VDXF.VectorUint256Key.vdxfid));
                (0, fundingPrimitives_1.requireCondition)(reader.readCompactSize() === items.length &&
                    reader.buffer.length - reader.offset === items.length * 32, "Identity upload MMR hash count does not match the requested items.");
                hashes = items.map(() => reader.readSlice(32));
                leaves = mmr.dataDescriptors;
            }
            // Compare authenticated leaves in request order, including any supplied salt.
            for (let index = 0; index < items.length; index++) {
                const item = items[index];
                const leaf = yield decryptDescriptor(leaves[index], decryptData, context, sharedIVK);
                const isHash = item.type.eq(verus_typescript_primitives_1.DATA_TYPE_DATAHASH);
                metadata(leaf, "", "", !isHash);
                // Requests may use FqnVdxfUniValue's compact-key wire format. The daemon
                // receives its JSON and stores ordinary VDXF bytes instead.
                const expected = item.type.eq(verus_typescript_primitives_1.DATA_TYPE_VDXFDATA)
                    ? verus_typescript_primitives_1.VdxfUniValue.fromJson(item.data.toJson()).toBuffer()
                    : item.data;
                if (isHash) {
                    // Hash-only leaves have no payload or salt. Their binding comes from
                    // the MMR hash vector, which the daemon omits for a single-item upload.
                    (0, fundingPrimitives_1.requireCondition)(hashes &&
                        expected.length === 32 &&
                        leaf.objectdata.length === 0 &&
                        hashes[index].equals(upload.hashType.eq(verus_typescript_primitives_1.HASH_TYPE_SHA256)
                            ? expected
                            : Buffer.from(expected).reverse()), "A hash-only upload requires a matching MMR hash entry; supply inline bytes for a single-item upload.");
                }
                else {
                    (0, fundingPrimitives_1.requireCondition)(leaf.objectdata.equals(expected), "Identity upload plaintext does not match the requested data.");
                    const salt = upload.isMMRData()
                        ? (_b = upload.data.salt) === null || _b === void 0 ? void 0 : _b[index]
                        : undefined;
                    if (salt) {
                        // Match the daemon's fixed 32-byte salt representation.
                        const expectedSalt = Buffer.alloc(32);
                        salt.copy(expectedSalt, 0, 0, 32);
                        (0, fundingPrimitives_1.requireCondition)(leaf.salt.equals(expectedSalt), "Identity upload salt does not match the request.");
                    }
                }
            }
            if (upload.address) {
                // Optional signature evidence has bounded encoding and must describe the
                // requested signer and bindings. Signature authentication is separate.
                const evidence = group.proof.chainObjects[1];
                (0, fundingPrimitives_1.requireCondition)(evidence.vdxfd === VDXF.SignatureDataKey.vdxfid, "Unexpected identity upload signature evidence.");
                const encrypted = decode(new verus_typescript_primitives_1.DataDescriptor(), tagged(evidence.data_vec, VDXF.SignatureDataKey.vdxfid));
                const plain = yield decryptDescriptor(encrypted, decryptData, context, sharedIVK);
                metadata(plain);
                const signature = decode(new verus_typescript_primitives_1.SignatureData(), plain.objectdata);
                (0, fundingPrimitives_1.requireCondition)(
                // Match the signer and the daemon's hash type. For a single leaf,
                // the MMR root uses the object hash type.
                signature.version.eqn(1) &&
                    signature.sigType.eqn(1) &&
                    signature.identityID === upload.address.toAddress() &&
                    signature.hashType.eq(items.length > 1
                        ? upload.data.mmrhashtype
                        : upload.hashType) &&
                    // Bound variable signature bytes and match the retained MMR root.
                    signature.signatureHash.length === 32 &&
                    (!root || root.equals(signature.signatureHash)) &&
                    signature.signatureAsVch.length > 0 &&
                    signature.signatureAsVch.length <= MAX_IDENTITY_SIGNATURE_BYTES &&
                    // Keep binding order and match the daemon's ASCII-only case folding.
                    // Hash byte order is SHA-256 directly, other hashes reversed.
                    JSON.stringify(signature.vdxfKeys) ===
                        JSON.stringify((upload.vdxfKeys || []).map((value) => value.toAddress())) &&
                    JSON.stringify(signature.vdxfKeyNames) ===
                        JSON.stringify((upload.vdxfKeyNames || []).map((value) => value
                            .toString("utf8")
                            .replace(/[A-Z]/g, char => char.toLowerCase()))) &&
                    JSON.stringify(signature.boundHashes.map((value) => value.toString("hex"))) ===
                        JSON.stringify((upload.boundHashes || []).map((value) => (upload.hashType.eq(verus_typescript_primitives_1.HASH_TYPE_SHA256)
                            ? value
                            : Buffer.from(value).reverse()).toString("hex"))), "Identity upload signature metadata does not match the request.");
            }
        }
        (0, fundingPrimitives_1.requireCondition)(groups.size === 0, "Unreferenced identity upload evidence.");
        return true;
    });
}
