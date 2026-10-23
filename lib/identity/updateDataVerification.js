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
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyIdentityUpdateData = verifyIdentityUpdateData;
const verus_typescript_primitives_1 = require("verus-typescript-primitives");
const VDXF = __importStar(require("verus-typescript-primitives/dist/vdxf/vdxfdatakeys"));
const fundingPrimitives_1 = require("./fundingPrimitives");
const updateDataEvidence_1 = require("./updateDataEvidence");
const localUpdateData_1 = require("./localUpdateData");
const updateLimits_1 = require("./updateLimits");
const requestSnapshot_1 = require("./requestSnapshot");
// Authenticated encryption adds a fixed tag, not arbitrary ciphertext padding.
const AUTHENTICATION_TAG_BYTES = 16;
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
function decryptDescriptor(descriptor_1, decrypt_1, context_1, usedEpks_1, ivk_1) {
    return __awaiter(this, arguments, void 0, function* (descriptor, decrypt, context, usedEpks, ivk, publicLink = false) {
        var _a, _b, _c, _d, _e, _f;
        // Only public contentmultimap (CMM) links may publish an incoming viewing key
        // (IVK). Private uploads must use the wallet's key for the requested recipient.
        // Reject extra keys and metadata that could also inflate the funded size.
        (0, fundingPrimitives_1.requireCondition)(descriptor.version.eqn(1) &&
            descriptor.hasEncryptedData() &&
            ((_a = descriptor.epk) === null || _a === void 0 ? void 0 : _a.length) === 32 &&
            !descriptor.epk.equals(Buffer.alloc(32)) &&
            !usedEpks.has(descriptor.epk.toString("hex")) &&
            (publicLink ? ((_b = descriptor.ivk) === null || _b === void 0 ? void 0 : _b.length) === 32 : !((_c = descriptor.ivk) === null || _c === void 0 ? void 0 : _c.length)) &&
            !((_d = descriptor.ssk) === null || _d === void 0 ? void 0 : _d.length) &&
            !((_e = descriptor.salt) === null || _e === void 0 ? void 0 : _e.length) &&
            !descriptor.label &&
            !descriptor.mimeType &&
            !descriptor.hasVDXFKey(), "Invalid encrypted identity upload descriptor.");
        usedEpks.add(descriptor.epk.toString("hex"));
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
/**
 * Verify the upload portion of an unfunded identity-update template. Every
 * evidence group must be referenced by a requested content key and every leaf
 * must match its requested bytes. This checks uploaded content and its bounded
 * encoding, including every salted leaf hash and the MMR root. Data signatures
 * are unsupported and rejected before invoking wallet callbacks.
 */
function verifyIdentityUpdateData(request, unfundedTxHex, decryptData, expectedSystemId) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        // Retain exact request fields before callbacks can mutate them.
        request = (0, requestSnapshot_1.snapshotUpdateRequestValue)(request);
        (0, localUpdateData_1.validateLocalIdentityUploadRequest)(request);
        (0, updateLimits_1.validateIdentityUpdateTransactionSize)(unfundedTxHex);
        // Collect complete evidence groups and the identity that links to them.
        // Ordinary identity fields and transaction funding are checked by the caller.
        const tx = (0, fundingPrimitives_1.transaction)(unfundedTxHex);
        const groups = (0, updateDataEvidence_1.readIdentityUpdateEvidence)(tx.outs, expectedSystemId);
        const usedEpks = new Set();
        const publicIvks = new Set();
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
            const items = (0, localUpdateData_1.localIdentityUploadItems)(upload);
            const context = {
                contentKey,
                encryptToAddress: (_a = upload.encryptToAddress) === null || _a === void 0 ? void 0 : _a.toAddressString(),
            };
            let cursor = 0;
            let groupIndex = -1;
            let sharedIVK;
            const linkCount = 1;
            // Unsigned uploads contain exactly one local evidence link.
            for (let index = 0; index < linkCount; index++) {
                const encoded = new verus_typescript_primitives_1.BufferDataVdxfObject();
                const end = encoded.fromBuffer(links, cursor);
                const outer = decode(new verus_typescript_primitives_1.DataDescriptor(), tagged(links.subarray(cursor, end), VDXF.DataDescriptorKey.vdxfid));
                if (index === 0) {
                    sharedIVK = outer.ivk;
                    if (!upload.encryptToAddress && sharedIVK) {
                        (0, fundingPrimitives_1.requireCondition)(!sharedIVK.equals(Buffer.alloc(32)) &&
                            !publicIvks.has(sharedIVK.toString("hex")), "Public identity upload viewing keys must be fresh for each entry.");
                        publicIvks.add(sharedIVK.toString("hex"));
                    }
                }
                const link = yield decryptDescriptor(outer, decryptData, context, usedEpks, sharedIVK, !upload.encryptToAddress);
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
                const rootDescriptor = yield decryptDescriptor(mmr.mmrRoot, decryptData, context, usedEpks, sharedIVK);
                metadata(rootDescriptor);
                root = rootDescriptor.objectdata;
                (0, fundingPrimitives_1.requireCondition)(root.length === 32, "Invalid identity upload MMR root length.");
                const hashDescriptor = yield decryptDescriptor(mmr.mmrHashes, decryptData, context, usedEpks, sharedIVK);
                metadata(hashDescriptor);
                // Strict vector decoding rejects trailing/truncated data. Keep our tag
                // version and canonical encoding checks: the daemon-compatible decoder
                // accepts wrapper versions other than the one used by local uploads.
                tagged(hashDescriptor.objectdata, VDXF.VectorUint256Key.vdxfid);
                hashes = hashDescriptor.decodeHashVector(true);
                (0, fundingPrimitives_1.requireCondition)(hashes.length === items.length, "Identity upload MMR hash count does not match the requested items.");
                leaves = mmr.dataDescriptors;
            }
            const computedHashes = [];
            // Compare authenticated leaves in request order, including any supplied salt.
            for (let index = 0; index < items.length; index++) {
                const item = items[index];
                const leaf = yield decryptDescriptor(leaves[index], decryptData, context, usedEpks, sharedIVK);
                metadata(leaf, "", "", !item.isHash);
                if (item.isHash) {
                    const digest = upload.hashType.eq(verus_typescript_primitives_1.HASH_TYPE_SHA256)
                        ? item.bytes
                        : Buffer.from(item.bytes).reverse();
                    (0, fundingPrimitives_1.requireCondition)(hashes &&
                        leaf.objectdata.length === 0 &&
                        hashes[index].equals(digest), "A hash-only upload requires a matching MMR hash entry; supply inline bytes for a single-item upload.");
                    computedHashes.push(digest);
                }
                else {
                    (0, fundingPrimitives_1.requireCondition)(leaf.objectdata.equals(item.bytes), "Identity upload plaintext does not match the requested data.");
                    if (item.salt) {
                        (0, fundingPrimitives_1.requireCondition)(leaf.salt.equals(item.salt), "Identity upload salt does not match the request.");
                    }
                    const digest = (0, verus_typescript_primitives_1.hashData)(Buffer.concat([leaf.objectdata, leaf.salt]), upload.hashType.toNumber());
                    (0, fundingPrimitives_1.requireCondition)(!hashes || hashes[index].equals(digest), "Identity upload MMR leaf hash does not match its salted data.");
                    computedHashes.push(digest);
                }
            }
            if (root) {
                (0, fundingPrimitives_1.requireCondition)((0, verus_typescript_primitives_1.getMMRRoot)(computedHashes, upload.data.mmrhashtype.toNumber()).equals(root), "Identity upload MMR root does not match its leaf hashes.");
            }
        }
        (0, fundingPrimitives_1.requireCondition)(groups.size === 0, "Unreferenced identity upload evidence.");
        return true;
    });
}
