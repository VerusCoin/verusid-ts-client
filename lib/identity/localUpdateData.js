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
exports.MAX_LOCAL_IDENTITY_UPLOAD_ITEMS = exports.MAX_LOCAL_IDENTITY_UPLOAD_OUTPUT_BYTES = exports.MAX_LOCAL_IDENTITY_UPLOAD_BYTES = void 0;
exports.captureLocalIdentityUploadCrypto = captureLocalIdentityUploadCrypto;
exports.localIdentityUploadItems = localIdentityUploadItems;
exports.validateLocalIdentityUploadRequest = validateLocalIdentityUploadRequest;
exports.buildLocalIdentityUpdateData = buildLocalIdentityUpdateData;
const bn_js_1 = require("bn.js");
const verus_typescript_primitives_1 = require("verus-typescript-primitives");
const VDXF = __importStar(require("verus-typescript-primitives/dist/vdxf/vdxfdatakeys"));
const bufferutils_1 = __importDefault(require("verus-typescript-primitives/dist/utils/bufferutils"));
const varuint_1 = __importDefault(require("verus-typescript-primitives/dist/utils/varuint"));
const sapling_1 = require("verus-typescript-primitives/dist/utils/sapling");
const fundingPrimitives_1 = require("./fundingPrimitives");
const requestSnapshot_1 = require("./requestSnapshot");
/** Application limits leave room for identity, funding inputs, and signatures. */
exports.MAX_LOCAL_IDENTITY_UPLOAD_BYTES = 1000000;
exports.MAX_LOCAL_IDENTITY_UPLOAD_OUTPUT_BYTES = 1500000;
exports.MAX_LOCAL_IDENTITY_UPLOAD_ITEMS = 4096;
function captureLocalIdentityUploadCrypto(crypto) {
    if (crypto === undefined)
        return undefined;
    (0, fundingPrimitives_1.requireCondition)(crypto &&
        typeof crypto.randomBytes === "function" &&
        typeof crypto.encrypt === "function" &&
        typeof crypto.decryptData === "function" &&
        (crypto.createPublicRecipient === undefined ||
            typeof crypto.createPublicRecipient === "function"), "Local identity uploads require randomness, encryption, and authenticated decryption callbacks.");
    return Object.assign({ randomBytes: crypto.randomBytes.bind(crypto), encrypt: crypto.encrypt.bind(crypto), decryptData: crypto.decryptData.bind(crypto) }, (crypto.createPublicRecipient
        ? { createPublicRecipient: crypto.createPublicRecipient.bind(crypto) }
        : {}));
}
function supportedHash(value) {
    return bn_js_1.BN.isBN(value) && [1, 4, 5].some((type) => value.eqn(type));
}
/** Resolve compact request keys without passing binary-only values through JSON. */
function ordinaryVdxfValue(value) {
    if (!(value instanceof verus_typescript_primitives_1.FqnVdxfUniValue))
        return value;
    return new verus_typescript_primitives_1.VdxfUniValue({
        version: value.version,
        values: [
            ...Array.from(value.entries(), ([key, data]) => ({
                [key.toIAddress()]: data,
            })),
            ...value.values.filter((entry) => Object.prototype.hasOwnProperty.call(entry, "")),
        ],
    });
}
/** Convert request bytes using the daemon's ordinary (not compact) VDXF form. */
function localIdentityUploadItems(upload) {
    const mmr = upload.isMMRData() ? upload.data : undefined;
    const items = (mmr === null || mmr === void 0 ? void 0 : mmr.data) || [{ type: upload.dataType, data: upload.data }];
    (0, fundingPrimitives_1.requireCondition)(Array.isArray(items) &&
        items.length > 0 &&
        items.length <= exports.MAX_LOCAL_IDENTITY_UPLOAD_ITEMS, "Identity upload request has no data or too many items.");
    if (mmr) {
        (0, fundingPrimitives_1.requireCondition)(mmr instanceof verus_typescript_primitives_1.PartialMMRData &&
            Object.keys(mmr).every((key) => ["flags", "data", "mmrhashtype", "salt", "priormmr"].includes(key)) &&
            bn_js_1.BN.isBN(mmr.flags) &&
            mmr.flags.gten(0) &&
            mmr.flags.lten(3), "Unsupported identity upload MMR options.");
        (0, fundingPrimitives_1.requireCondition)(mmr.priormmr === undefined &&
            bn_js_1.BN.isBN(mmr.flags) &&
            mmr.flags.and(new bn_js_1.BN(2)).isZero(), "Prior MMR uploads are not supported.");
        (0, fundingPrimitives_1.requireCondition)(supportedHash(mmr.mmrhashtype), "Unsupported identity upload MMR hash type.");
        (0, fundingPrimitives_1.requireCondition)(mmr.salt === undefined ||
            (Array.isArray(mmr.salt) &&
                mmr.salt.length === items.length &&
                mmr.salt.every((salt) => Buffer.isBuffer(salt) && salt.length === 32)), "Identity upload salts must contain one exact 32-byte salt per item.");
        (0, fundingPrimitives_1.requireCondition)(mmr.flags.and(verus_typescript_primitives_1.PartialMMRData.CONTAINS_SALT).isZero() ||
            mmr.salt !== undefined, "Identity upload salt flag has no salts.");
    }
    return items.map((item, index) => {
        (0, fundingPrimitives_1.requireCondition)(item &&
            Object.keys(item).every((key) => key === "type" || key === "data"), "Unsupported identity upload item metadata.");
        (0, fundingPrimitives_1.requireCondition)(bn_js_1.BN.isBN(item.type) && !item.type.eq(verus_typescript_primitives_1.DATA_TYPE_FILENAME), "Identity uploads require inline data, not a remote filename.");
        (0, fundingPrimitives_1.requireCondition)([
            verus_typescript_primitives_1.DATA_TYPE_MESSAGE,
            verus_typescript_primitives_1.DATA_TYPE_HEX,
            verus_typescript_primitives_1.DATA_TYPE_BASE64,
            verus_typescript_primitives_1.DATA_TYPE_RAWSTRINGDATA,
            verus_typescript_primitives_1.DATA_TYPE_VDXFDATA,
            verus_typescript_primitives_1.DATA_TYPE_DATAHASH,
        ].some((type) => item.type.eq(type)), "Unsupported identity upload data type.");
        (0, fundingPrimitives_1.requireCondition)(!!mmr || !item.type.eq(verus_typescript_primitives_1.DATA_TYPE_RAWSTRINGDATA), "Raw-string identity upload data requires an MMR item.");
        const isVdxf = item.type.eq(verus_typescript_primitives_1.DATA_TYPE_VDXFDATA);
        (0, fundingPrimitives_1.requireCondition)(isVdxf ? item.data instanceof verus_typescript_primitives_1.VdxfUniValue : Buffer.isBuffer(item.data), "Invalid identity upload payload.");
        const vdxf = isVdxf
            ? ordinaryVdxfValue(item.data)
            : undefined;
        (0, fundingPrimitives_1.requireCondition)(!vdxf || !!mmr || vdxf.values.length === 1, "Single-item VDXF array uploads are not supported by the request CLI format.");
        // The local path already has decoded bytes. Keep typed BASE64/RAWSTRING
        // payloads and binary-only VDXF values intact; their daemon CLI conversion
        // is a separate, deliberately narrower contract enforced by primitives.
        const bytes = vdxf ? vdxf.toBuffer() : Buffer.from(item.data);
        const isHash = item.type.eq(verus_typescript_primitives_1.DATA_TYPE_DATAHASH);
        (0, fundingPrimitives_1.requireCondition)(isHash ? bytes.length === 32 && items.length > 1 : bytes.length > 0, isHash
            ? "A hash-only upload requires a 32-byte hash in a multi-item MMR."
            : "Identity upload payload must not be empty.");
        (0, fundingPrimitives_1.requireCondition)(!item.type.eq(verus_typescript_primitives_1.DATA_TYPE_MESSAGE) ||
            Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes), "Identity upload messages must contain valid UTF-8; use inline hex for arbitrary bytes.");
        return Object.assign({ bytes,
            isHash }, ((mmr === null || mmr === void 0 ? void 0 : mmr.salt) ? { salt: Buffer.from(mmr.salt[index]) } : {}));
    });
}
/**
 * Reject unsupported options before any wallet callback or chain-state read.
 * Verus asset chains (including VRSCTEST) use the same `zs` Sapling HRP.
 */
function validateLocalIdentityUploadRequest(request, _isTestnet) {
    var _a, _b, _c;
    const map = request.signDataMap;
    (0, fundingPrimitives_1.requireCondition)(request.containsSignData() ? !!map && map.size > 0 : !map || map.size === 0, "Identity upload request flags do not match its data.");
    if (!(map === null || map === void 0 ? void 0 : map.size))
        return;
    let totalBytes = 0;
    let totalItems = 0;
    const keys = new Set();
    for (const [key, upload] of map.entries()) {
        const decoded = (0, verus_typescript_primitives_1.fromBase58Check)(key.toIAddress());
        (0, fundingPrimitives_1.requireCondition)(decoded.version === verus_typescript_primitives_1.I_ADDR_VERSION &&
            decoded.hash.length === 20 &&
            !decoded.hash.equals(Buffer.alloc(20)) &&
            !keys.has(decoded.hash.toString("hex")), "Invalid or duplicate identity upload content key.");
        keys.add(decoded.hash.toString("hex"));
        (0, fundingPrimitives_1.requireCondition)(!((_c = (_b = (_a = request.identity) === null || _a === void 0 ? void 0 : _a.contentMultiMap) === null || _b === void 0 ? void 0 : _b.kvContent) === null || _c === void 0 ? void 0 : _c.hasAddress(key.toIAddress())), "An identity upload key cannot also contain ordinary content.");
        (0, fundingPrimitives_1.requireCondition)(upload instanceof verus_typescript_primitives_1.PartialSignData &&
            bn_js_1.BN.isBN(upload.flags) &&
            upload.flags.gten(0) &&
            upload.flags.lten(255), "Invalid identity upload options.");
        (0, fundingPrimitives_1.requireCondition)(upload.address === undefined &&
            upload.signature === undefined &&
            upload.flags.and(new bn_js_1.BN(10)).isZero(), "Identity upload data signatures are not supported.");
        (0, fundingPrimitives_1.requireCondition)(upload.prefixString === undefined &&
            upload.vdxfKeys === undefined &&
            upload.vdxfKeyNames === undefined &&
            upload.boundHashes === undefined &&
            upload.flags.and(new bn_js_1.BN(240)).isZero(), "Identity upload signature bindings are not supported.");
        (0, fundingPrimitives_1.requireCondition)(Object.keys(upload).every((key) => [
            "flags",
            "address",
            "prefixString",
            "vdxfKeys",
            "vdxfKeyNames",
            "boundHashes",
            "hashType",
            "encryptToAddress",
            "createMMR",
            "signature",
            "dataType",
            "data",
        ].includes(key)), "Unsupported identity upload metadata or options.");
        (0, fundingPrimitives_1.requireCondition)(upload.createMMR === undefined || upload.createMMR === true, "Identity uploads require createmmr=true.");
        (0, fundingPrimitives_1.requireCondition)(upload.flags.and(verus_typescript_primitives_1.PartialSignData.CONTAINS_ENCRYPTTOADDRESS).isZero() ||
            upload.encryptToAddress !== undefined, "Identity upload recipient flag has no recipient.");
        (0, fundingPrimitives_1.requireCondition)(supportedHash(upload.hashType), "Unsupported identity upload hash type.");
        if (upload.encryptToAddress !== undefined) {
            (0, fundingPrimitives_1.requireCondition)(upload.encryptToAddress instanceof verus_typescript_primitives_1.SaplingPaymentAddress &&
                Buffer.isBuffer(upload.encryptToAddress.d) &&
                upload.encryptToAddress.d.length === 11 &&
                Buffer.isBuffer(upload.encryptToAddress.pkD) &&
                upload.encryptToAddress.pkD.length === 32 &&
                !upload.encryptToAddress.pkD.equals(Buffer.alloc(32)), "Invalid identity upload Sapling recipient.");
        }
        for (const item of localIdentityUploadItems(upload)) {
            totalBytes += item.bytes.length;
            totalItems++;
        }
    }
    (0, fundingPrimitives_1.requireCondition)(totalBytes <= exports.MAX_LOCAL_IDENTITY_UPLOAD_BYTES &&
        totalItems <= exports.MAX_LOCAL_IDENTITY_UPLOAD_ITEMS, "Identity uploads exceed the local application size limit.");
    // Ciphertext lengths are exact (tagged plaintext + 16), so size and multipart
    // feasibility can be established before a wallet generates any key material.
    let multipartGroups = 0;
    let outputBytes = 0;
    for (const [key, upload] of map.entries()) {
        const items = localIdentityUploadItems(upload);
        const placeholder = (plain) => new verus_typescript_primitives_1.DataDescriptor({
            flags: verus_typescript_primitives_1.DataDescriptor.FLAG_ENCRYPTED_DATA.clone(),
            epk: Buffer.alloc(32),
            objectdata: Buffer.alloc(new verus_typescript_primitives_1.VDXFDataDescriptor(plain, VDXF.DataDescriptorKey.vdxfid).toBuffer().length + 16),
        });
        const leaves = items.map((item) => placeholder(item.isHash
            ? new verus_typescript_primitives_1.DataDescriptor()
            : new verus_typescript_primitives_1.DataDescriptor({
                objectdata: item.bytes,
                salt: Buffer.alloc(32),
            })));
        const descriptor = leaves.length === 1
            ? leaves[0]
            : new verus_typescript_primitives_1.MMRDescriptor({
                objectHashType: upload.hashType.toNumber(),
                mmrHashType: upload.data.mmrhashtype.toNumber(),
                mmrRoot: placeholder(new verus_typescript_primitives_1.DataDescriptor({ objectdata: Buffer.alloc(32) })),
                mmrHashes: placeholder(new verus_typescript_primitives_1.DataDescriptor({
                    objectdata: taggedHashVector(items.map(() => Buffer.alloc(32))),
                })),
                dataDescriptors: leaves,
            });
        const group = evidenceOutputs(key.toIAddress(), descriptor);
        if (group.length > 1)
            multipartGroups++;
        outputBytes += group.reduce((sum, output) => sum + output.script.length + 12, 0);
    }
    (0, fundingPrimitives_1.requireCondition)(multipartGroups <= 1, "Only one multipart identity upload group is supported per transaction.");
    (0, fundingPrimitives_1.requireCondition)(outputBytes <= exports.MAX_LOCAL_IDENTITY_UPLOAD_OUTPUT_BYTES, "Identity upload evidence exceeds the local application size limit.");
}
const tagged = (key, bytes) => new verus_typescript_primitives_1.BufferDataVdxfObject(bytes.toString("hex"), key).toBuffer();
function taggedHashVector(hashes) {
    const writer = new bufferutils_1.default.BufferWriter(Buffer.alloc(varuint_1.default.encodingLength(hashes.length) + hashes.length * 32));
    writer.writeCompactSize(hashes.length);
    hashes.forEach((hash) => writer.writeSlice(hash));
    return tagged(VDXF.VectorUint256Key.vdxfid, writer.buffer);
}
function evidenceOutputs(chainId, descriptor) {
    const object = new verus_typescript_primitives_1.EvidenceData({
        version: new bn_js_1.BN(1),
        type: new bn_js_1.BN(verus_typescript_primitives_1.ETypes.TYPE_DATA),
        md: undefined,
        vdxfd: VDXF.DataDescriptorKey.vdxfid,
        data_vec: tagged(descriptor instanceof verus_typescript_primitives_1.MMRDescriptor
            ? VDXF.MMRDescriptorKey.vdxfid
            : VDXF.DataDescriptorKey.vdxfid, descriptor.toBuffer()),
    });
    return (0, verus_typescript_primitives_1.createNotaryEvidenceOutputs)(new verus_typescript_primitives_1.NotaryEvidence({
        systemId: chainId,
        evidence: new verus_typescript_primitives_1.CrossChainProof({ chainObjects: [object] }),
    }));
}
/**
 * Build encrypted upload evidence and the identity content entries that point
 * to it. Public uploads publish a fresh viewing key on their encrypted link.
 * The caller must authenticate the completed uploads before funding them.
 */
function buildLocalIdentityUpdateData(_a) {
    return __awaiter(this, arguments, void 0, function* ({ request, chainId, crypto, firstOutputIndex = 0, isTestnet, }) {
        var _b, _c, _d;
        // Snapshot caller-owned request data before invoking asynchronous wallet code.
        request = (0, requestSnapshot_1.snapshotUpdateRequestValue)(request);
        validateLocalIdentityUploadRequest(request, isTestnet);
        const chain = (0, verus_typescript_primitives_1.fromBase58Check)(chainId);
        (0, fundingPrimitives_1.requireCondition)(chain.version === verus_typescript_primitives_1.I_ADDR_VERSION &&
            chain.hash.length === 20 &&
            !chain.hash.equals(Buffer.alloc(20)), "Identity upload requires a valid chain identity.");
        (0, fundingPrimitives_1.requireCondition)(Number.isSafeInteger(firstOutputIndex) &&
            firstOutputIndex >= 0 &&
            firstOutputIndex <= 0xffffffff - exports.MAX_LOCAL_IDENTITY_UPLOAD_ITEMS, "Invalid first identity upload output index.");
        const outputs = [];
        const contentMultiMap = new Map();
        if (!((_b = request.signDataMap) === null || _b === void 0 ? void 0 : _b.size))
            return { outputs, contentMultiMap };
        // Capture callbacks before the first await so wallet code cannot replace them.
        crypto = captureLocalIdentityUploadCrypto(crypto);
        const randomBytes = crypto.randomBytes.bind(crypto);
        const encrypt = crypto.encrypt.bind(crypto);
        const publicRecipient = (_c = crypto.createPublicRecipient) === null || _c === void 0 ? void 0 : _c.bind(crypto);
        // Match the daemon's ordering by the decoded content-key bytes.
        const entries = [...request.signDataMap.entries()].sort(([a], [b]) => (0, verus_typescript_primitives_1.fromBase58Check)(a.toIAddress()).hash.compare((0, verus_typescript_primitives_1.fromBase58Check)(b.toIAddress()).hash));
        (0, fundingPrimitives_1.requireCondition)(entries.every(([, upload]) => upload.encryptToAddress || publicRecipient), "Public identity uploads require a fresh public-recipient callback.");
        // Reject repeated EPKs and public recipients within this build.
        const epks = new Set();
        const publicAddresses = new Set();
        const publicIvks = new Set();
        let multipartGroups = 0;
        let outputBytes = 0;
        for (const [key, upload] of entries) {
            const items = localIdentityUploadItems(upload);
            const objectHashType = upload.hashType.toNumber();
            let address = (_d = upload.encryptToAddress) === null || _d === void 0 ? void 0 : _d.toAddressString();
            let ivk;
            // Public data is also encrypted; its fresh IVK will be published on the link.
            if (!address) {
                const recipient = yield publicRecipient();
                (0, fundingPrimitives_1.requireCondition)(recipient &&
                    typeof recipient.address === "string" &&
                    Buffer.isBuffer(recipient.ivk) &&
                    recipient.ivk.length === 32 &&
                    !recipient.ivk.equals(Buffer.alloc(32)), "Public identity upload recipient must include an address and 32-byte IVK.");
                // Verus mainnet and asset-chain testnets both use main-chain parameters.
                const decoded = (0, sapling_1.fromBech32)(recipient.address);
                (0, fundingPrimitives_1.requireCondition)(decoded.prefix === "zs" &&
                    decoded.data.length === 43 &&
                    verus_typescript_primitives_1.SaplingPaymentAddress.fromAddressString(recipient.address).toAddressString() === recipient.address &&
                    !decoded.data.subarray(11).equals(Buffer.alloc(32)) &&
                    !publicAddresses.has(recipient.address) &&
                    !publicIvks.has(recipient.ivk.toString("hex")), "Public identity upload recipient is invalid, wrong-network, or reused.");
                address = recipient.address;
                ivk = Buffer.from(recipient.ivk);
                publicAddresses.add(address);
                publicIvks.add(ivk.toString("hex"));
            }
            // Encrypt the entire tagged descriptor. These checks validate the callback's
            // result shape and duplicate EPKs; authenticated decryption happens later.
            const wrap = (plain) => __awaiter(this, void 0, void 0, function* () {
                const bytes = new verus_typescript_primitives_1.VDXFDataDescriptor(plain, VDXF.DataDescriptorKey.vdxfid).toBuffer();
                const result = yield encrypt(Buffer.from(bytes), address);
                (0, fundingPrimitives_1.requireCondition)(result &&
                    Buffer.isBuffer(result.epk) &&
                    result.epk.length === 32 &&
                    !result.epk.equals(Buffer.alloc(32)) &&
                    Buffer.isBuffer(result.ciphertext) &&
                    result.ciphertext.length === bytes.length + 16 &&
                    !epks.has(result.epk.toString("hex")), "Identity upload encryption returned invalid ciphertext or a reused ephemeral key.");
                epks.add(result.epk.toString("hex"));
                return new verus_typescript_primitives_1.DataDescriptor({
                    flags: verus_typescript_primitives_1.DataDescriptor.FLAG_ENCRYPTED_DATA.clone(),
                    epk: Buffer.from(result.epk),
                    objectdata: Buffer.from(result.ciphertext),
                });
            });
            const hashes = [];
            const leaves = [];
            for (const item of items) {
                if (item.isHash) {
                    // Hash-only leaves carry an empty descriptor and use daemon hash byte order.
                    hashes.push(objectHashType === verus_typescript_primitives_1.HASH_TYPE_SHA256.toNumber()
                        ? Buffer.from(item.bytes)
                        : Buffer.from(item.bytes).reverse());
                    leaves.push(yield wrap(new verus_typescript_primitives_1.DataDescriptor()));
                }
                else {
                    // Commit to both the payload and salt; preserve both inside the ciphertext.
                    const returnedSalt = item.salt || (yield randomBytes(32));
                    (0, fundingPrimitives_1.requireCondition)(Buffer.isBuffer(returnedSalt) && returnedSalt.length === 32, "Identity upload randomness must return exactly 32 bytes.");
                    const salt = Buffer.from(returnedSalt);
                    hashes.push((0, verus_typescript_primitives_1.hashData)(Buffer.concat([item.bytes, salt]), objectHashType));
                    leaves.push(yield wrap(new verus_typescript_primitives_1.DataDescriptor({ objectdata: item.bytes, salt })));
                }
            }
            // A single leaf is stored directly. Multiple leaves also encrypt the MMR
            // root and hash vector so the verifier can check their shared commitment.
            let descriptor = leaves[0];
            if (leaves.length > 1) {
                const mmrHashType = upload.data.mmrhashtype.toNumber();
                descriptor = new verus_typescript_primitives_1.MMRDescriptor({
                    objectHashType,
                    mmrHashType,
                    mmrRoot: yield wrap(new verus_typescript_primitives_1.DataDescriptor({ objectdata: (0, verus_typescript_primitives_1.getMMRRoot)(hashes, mmrHashType) })),
                    mmrHashes: yield wrap(new verus_typescript_primitives_1.DataDescriptor({ objectdata: taggedHashVector(hashes) })),
                    dataDescriptors: leaves,
                });
            }
            // Bound the combined evidence before adding its outputs to the transaction.
            const group = evidenceOutputs(chainId, descriptor);
            if (group.length > 1)
                multipartGroups++;
            // The daemon reader cannot safely traverse adjacent multipart groups.
            (0, fundingPrimitives_1.requireCondition)(multipartGroups <= 1, "Only one multipart identity upload group is supported per transaction.");
            outputBytes += group.reduce((sum, output) => sum + output.script.length + 12, 0);
            (0, fundingPrimitives_1.requireCondition)(outputBytes <= exports.MAX_LOCAL_IDENTITY_UPLOAD_OUTPUT_BYTES, "Identity upload evidence exceeds the local application size limit.");
            // A zero transaction hash refers to this transaction. Anchor the link to the
            // group's first absolute output index, including any preceding outputs.
            const reference = new verus_typescript_primitives_1.CrossChainDataRef(new verus_typescript_primitives_1.PBaaSEvidenceRef({
                flags: verus_typescript_primitives_1.PBaaSEvidenceRef.FLAG_ISEVIDENCE.clone(),
                output: new verus_typescript_primitives_1.UTXORef({
                    hash: Buffer.alloc(32),
                    n: new bn_js_1.BN(firstOutputIndex + outputs.length),
                }),
                objectNum: new bn_js_1.BN(0),
                subObject: new bn_js_1.BN(0),
            }));
            const link = yield wrap(new verus_typescript_primitives_1.DataDescriptor(Object.assign({ objectdata: tagged(VDXF.CrossChainDataRefKey.vdxfid, reference.toBuffer()) }, (items.length > 1 ? { mimeType: "application/json" } : {}))));
            if (ivk) {
                link.ivk = Buffer.from(ivk);
                link.setFlags();
            }
            contentMultiMap.set(key, [
                new verus_typescript_primitives_1.VDXFDataDescriptor(link, VDXF.DataDescriptorKey.vdxfid).toBuffer(),
            ]);
            outputs.push(...group);
        }
        return { outputs, contentMultiMap };
    });
}
