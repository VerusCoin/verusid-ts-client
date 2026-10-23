import { BN } from "bn.js";
import {
  BufferDataVdxfObject,
  CompactIAddressObject,
  CrossChainDataRef,
  CrossChainProof,
  DataDescriptor,
  EHashTypes,
  ETypes,
  EvidenceData,
  FqnVdxfUniValue,
  IdentityUpdateRequestDetails,
  MMRDescriptor,
  NotaryEvidence,
  PartialMMRData,
  PartialSignData,
  PBaaSEvidenceRef,
  SaplingPaymentAddress,
  UTXORef,
  VDXFDataDescriptor,
  VdxfUniValue,
  createNotaryEvidenceOutputs,
  fromBase58Check,
  getMMRRoot,
  hashData,
  DATA_TYPE_BASE64,
  DATA_TYPE_DATAHASH,
  DATA_TYPE_FILENAME,
  DATA_TYPE_HEX,
  DATA_TYPE_MESSAGE,
  DATA_TYPE_RAWSTRINGDATA,
  DATA_TYPE_VDXFDATA,
  HASH_TYPE_SHA256,
  I_ADDR_VERSION,
} from "verus-typescript-primitives";
import * as VDXF from "verus-typescript-primitives/dist/vdxf/vdxfdatakeys";
import bufferutils from "verus-typescript-primitives/dist/utils/bufferutils";
import varuint from "verus-typescript-primitives/dist/utils/varuint";
import { fromBech32 } from "verus-typescript-primitives/dist/utils/sapling";
import { requireCondition } from "./fundingPrimitives";
import { snapshotUpdateRequestValue } from "./requestSnapshot";
import type { IdentityUpdateDataDecryptor } from "./updateDataVerification";

/** Application limits leave room for identity, funding inputs, and signatures. */
export const MAX_LOCAL_IDENTITY_UPLOAD_BYTES = 1_000_000;
export const MAX_LOCAL_IDENTITY_UPLOAD_OUTPUT_BYTES = 1_500_000;
export const MAX_LOCAL_IDENTITY_UPLOAD_ITEMS = 4096;

export interface LocalIdentityUploadCrypto {
  /** Cryptographically secure random bytes; every ordinary leaf needs a salt. */
  randomBytes(length: number): Buffer | Promise<Buffer>;
  /**
   * Encrypt the complete tagged descriptor using fresh Sapling ephemeral key
   * material, authenticated ChaCha20-Poly1305, and the daemon's Sapling KDF.
   * Never return or serialize a symmetric key here. A wallet may retain one
   * temporarily for authenticated verification of an external recipient.
   */
  encrypt(
    plaintext: Buffer,
    recipientAddress: string
  ):
    | { epk: Buffer; ciphertext: Buffer }
    | Promise<{ epk: Buffer; ciphertext: Buffer }>;
  /** Generate a fresh recipient. This IVK is deliberately published on chain. */
  createPublicRecipient?():
    | { address: string; ivk: Buffer }
    | Promise<{ address: string; ivk: Buffer }>;
  /** Must authenticate ciphertext, including locally encrypted descriptors. */
  decryptData: IdentityUpdateDataDecryptor;
}

export interface LocalIdentityUploadItem {
  bytes: Buffer;
  isHash: boolean;
  salt?: Buffer;
}

/** Capture methods without copying wallet-owned key storage or class internals. */
export function captureLocalIdentityUploadCrypto(
  crypto: LocalIdentityUploadCrypto
): LocalIdentityUploadCrypto;
export function captureLocalIdentityUploadCrypto(
  crypto: LocalIdentityUploadCrypto | undefined
): LocalIdentityUploadCrypto | undefined;
export function captureLocalIdentityUploadCrypto(
  crypto: LocalIdentityUploadCrypto | undefined
): LocalIdentityUploadCrypto | undefined {
  if (crypto === undefined) return undefined;
  requireCondition(
    crypto &&
      typeof crypto.randomBytes === "function" &&
      typeof crypto.encrypt === "function" &&
      typeof crypto.decryptData === "function" &&
      (crypto.createPublicRecipient === undefined ||
        typeof crypto.createPublicRecipient === "function"),
    "Local identity uploads require randomness, encryption, and authenticated decryption callbacks."
  );
  return {
    randomBytes: crypto.randomBytes.bind(crypto),
    encrypt: crypto.encrypt.bind(crypto),
    decryptData: crypto.decryptData.bind(crypto),
    ...(crypto.createPublicRecipient
      ? { createPublicRecipient: crypto.createPublicRecipient.bind(crypto) }
      : {}),
  };
}

function supportedHash(value: unknown): boolean {
  return BN.isBN(value) && [1, 4, 5].some((type) => value.eqn(type));
}

/** Resolve compact request keys without passing binary-only values through JSON. */
function ordinaryVdxfValue(value: VdxfUniValue): VdxfUniValue {
  if (!(value instanceof FqnVdxfUniValue)) return value;

  return new VdxfUniValue({
    version: value.version,
    values: [
      ...Array.from(value.entries(), ([key, data]) => ({
        [key.toIAddress()]: data,
      })),
      ...value.values.filter((entry) =>
        Object.prototype.hasOwnProperty.call(entry, "")
      ),
    ],
  });
}

/** Convert request bytes using the daemon's ordinary (not compact) VDXF form. */
export function localIdentityUploadItems(
  upload: PartialSignData
): LocalIdentityUploadItem[] {
  const mmr = upload.isMMRData() ? (upload.data as PartialMMRData) : undefined;
  const items = mmr?.data || [{ type: upload.dataType, data: upload.data }];

  requireCondition(
    Array.isArray(items) &&
      items.length > 0 &&
      items.length <= MAX_LOCAL_IDENTITY_UPLOAD_ITEMS,
    "Identity upload request has no data or too many items."
  );

  if (mmr) {
    requireCondition(
      mmr instanceof PartialMMRData &&
        Object.keys(mmr).every((key) =>
          ["flags", "data", "mmrhashtype", "salt", "priormmr"].includes(key)
        ) &&
        BN.isBN(mmr.flags) &&
        mmr.flags.gten(0) &&
        mmr.flags.lten(3),
      "Unsupported identity upload MMR options."
    );
    requireCondition(
      mmr.priormmr === undefined &&
        BN.isBN(mmr.flags) &&
        mmr.flags.and(new BN(2)).isZero(),
      "Prior MMR uploads are not supported."
    );
    requireCondition(
      supportedHash(mmr.mmrhashtype),
      "Unsupported identity upload MMR hash type."
    );
    requireCondition(
      mmr.salt === undefined ||
        (Array.isArray(mmr.salt) &&
          mmr.salt.length === items.length &&
          mmr.salt.every(
            (salt) => Buffer.isBuffer(salt) && salt.length === 32
          )),
      "Identity upload salts must contain one exact 32-byte salt per item."
    );
    requireCondition(
      mmr.flags.and(PartialMMRData.CONTAINS_SALT).isZero() ||
        mmr.salt !== undefined,
      "Identity upload salt flag has no salts."
    );
  }

  return items.map((item, index) => {
    requireCondition(
      item &&
        Object.keys(item).every((key) => key === "type" || key === "data"),
      "Unsupported identity upload item metadata."
    );
    requireCondition(
      BN.isBN(item.type) && !item.type!.eq(DATA_TYPE_FILENAME),
      "Identity uploads require inline data, not a remote filename."
    );
    requireCondition(
      [
        DATA_TYPE_MESSAGE,
        DATA_TYPE_HEX,
        DATA_TYPE_BASE64,
        DATA_TYPE_RAWSTRINGDATA,
        DATA_TYPE_VDXFDATA,
        DATA_TYPE_DATAHASH,
      ].some((type) => item.type!.eq(type)),
      "Unsupported identity upload data type."
    );
    requireCondition(
      !!mmr || !item.type!.eq(DATA_TYPE_RAWSTRINGDATA),
      "Raw-string identity upload data requires an MMR item."
    );

    const isVdxf = item.type!.eq(DATA_TYPE_VDXFDATA);
    requireCondition(
      isVdxf ? item.data instanceof VdxfUniValue : Buffer.isBuffer(item.data),
      "Invalid identity upload payload."
    );
    const vdxf = isVdxf
      ? ordinaryVdxfValue(item.data as VdxfUniValue)
      : undefined;
    requireCondition(
      !vdxf || !!mmr || vdxf.values.length === 1,
      "Single-item VDXF array uploads are not supported by the request CLI format."
    );
    // The local path already has decoded bytes. Keep typed BASE64/RAWSTRING
    // payloads and binary-only VDXF values intact; their daemon CLI conversion
    // is a separate, deliberately narrower contract enforced by primitives.
    const bytes = vdxf ? vdxf.toBuffer() : Buffer.from(item.data as Buffer);
    const isHash = item.type!.eq(DATA_TYPE_DATAHASH);

    requireCondition(
      isHash ? bytes.length === 32 && items.length > 1 : bytes.length > 0,
      isHash
        ? "A hash-only upload requires a 32-byte hash in a multi-item MMR."
        : "Identity upload payload must not be empty."
    );
    requireCondition(
      !item.type!.eq(DATA_TYPE_MESSAGE) ||
        Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes),
      "Identity upload messages must contain valid UTF-8; use inline hex for arbitrary bytes."
    );
    return {
      bytes,
      isHash,
      ...(mmr?.salt ? { salt: Buffer.from(mmr.salt[index]) } : {}),
    };
  });
}

/**
 * Reject unsupported options before any wallet callback or chain-state read.
 * Verus asset chains (including VRSCTEST) use the same `zs` Sapling HRP.
 */
export function validateLocalIdentityUploadRequest(
  request: IdentityUpdateRequestDetails,
  _isTestnet?: boolean
): void {
  const map = request.signDataMap;
  requireCondition(
    request.containsSignData() ? !!map && map.size > 0 : !map || map.size === 0,
    "Identity upload request flags do not match its data."
  );
  if (!map?.size) return;

  let totalBytes = 0;
  let totalItems = 0;
  const keys = new Set<string>();
  for (const [key, upload] of map.entries()) {
    const decoded = fromBase58Check(key.toIAddress());
    requireCondition(
      decoded.version === I_ADDR_VERSION &&
        decoded.hash.length === 20 &&
        !decoded.hash.equals(Buffer.alloc(20)) &&
        !keys.has(decoded.hash.toString("hex")),
      "Invalid or duplicate identity upload content key."
    );
    keys.add(decoded.hash.toString("hex"));
    requireCondition(
      !request.identity?.contentMultiMap?.kvContent?.hasAddress(
        key.toIAddress()
      ),
      "An identity upload key cannot also contain ordinary content."
    );
    requireCondition(
      upload instanceof PartialSignData &&
        BN.isBN(upload.flags) &&
        upload.flags.gten(0) &&
        upload.flags.lten(255),
      "Invalid identity upload options."
    );
    requireCondition(
      upload.address === undefined &&
        upload.signature === undefined &&
        upload.flags.and(new BN(10)).isZero(),
      "Identity upload data signatures are not supported."
    );
    requireCondition(
      upload.prefixString === undefined &&
        upload.vdxfKeys === undefined &&
        upload.vdxfKeyNames === undefined &&
        upload.boundHashes === undefined &&
        upload.flags.and(new BN(240)).isZero(),
      "Identity upload signature bindings are not supported."
    );
    requireCondition(
      Object.keys(upload).every((key) =>
        [
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
        ].includes(key)
      ),
      "Unsupported identity upload metadata or options."
    );
    requireCondition(
      upload.createMMR === undefined || upload.createMMR === true,
      "Identity uploads require createmmr=true."
    );
    requireCondition(
      upload.flags.and(PartialSignData.CONTAINS_ENCRYPTTOADDRESS).isZero() ||
        upload.encryptToAddress !== undefined,
      "Identity upload recipient flag has no recipient."
    );
    requireCondition(
      supportedHash(upload.hashType),
      "Unsupported identity upload hash type."
    );
    if (upload.encryptToAddress !== undefined) {
      requireCondition(
        upload.encryptToAddress instanceof SaplingPaymentAddress &&
          Buffer.isBuffer(upload.encryptToAddress.d) &&
          upload.encryptToAddress.d.length === 11 &&
          Buffer.isBuffer(upload.encryptToAddress.pkD) &&
          upload.encryptToAddress.pkD.length === 32 &&
          !upload.encryptToAddress.pkD.equals(Buffer.alloc(32)),
        "Invalid identity upload Sapling recipient."
      );
    }
    for (const item of localIdentityUploadItems(upload)) {
      totalBytes += item.bytes.length;
      totalItems++;
    }
  }
  requireCondition(
    totalBytes <= MAX_LOCAL_IDENTITY_UPLOAD_BYTES &&
      totalItems <= MAX_LOCAL_IDENTITY_UPLOAD_ITEMS,
    "Identity uploads exceed the local application size limit."
  );
  // Ciphertext lengths are exact (tagged plaintext + 16), so size and multipart
  // feasibility can be established before a wallet generates any key material.
  let multipartGroups = 0;
  let outputBytes = 0;
  for (const [key, upload] of map.entries()) {
    const items = localIdentityUploadItems(upload);
    const placeholder = (plain: DataDescriptor) =>
      new DataDescriptor({
        flags: DataDescriptor.FLAG_ENCRYPTED_DATA.clone(),
        epk: Buffer.alloc(32),
        objectdata: Buffer.alloc(
          new VDXFDataDescriptor(
            plain,
            VDXF.DataDescriptorKey.vdxfid
          ).toBuffer().length + 16
        ),
      });
    const leaves = items.map((item) =>
      placeholder(
        item.isHash
          ? new DataDescriptor()
          : new DataDescriptor({
              objectdata: item.bytes,
              salt: Buffer.alloc(32),
            })
      )
    );
    const descriptor =
      leaves.length === 1
        ? leaves[0]
        : new MMRDescriptor({
            objectHashType: upload.hashType!.toNumber(),
            mmrHashType: (
              upload.data as PartialMMRData
            ).mmrhashtype!.toNumber(),
            mmrRoot: placeholder(
              new DataDescriptor({ objectdata: Buffer.alloc(32) })
            ),
            mmrHashes: placeholder(
              new DataDescriptor({
                objectdata: taggedHashVector(items.map(() => Buffer.alloc(32))),
              })
            ),
            dataDescriptors: leaves,
          });
    const group = evidenceOutputs(key.toIAddress(), descriptor);
    if (group.length > 1) multipartGroups++;
    outputBytes += group.reduce(
      (sum, output) => sum + output.script.length + 12,
      0
    );
  }
  requireCondition(
    multipartGroups <= 1,
    "Only one multipart identity upload group is supported per transaction."
  );
  requireCondition(
    outputBytes <= MAX_LOCAL_IDENTITY_UPLOAD_OUTPUT_BYTES,
    "Identity upload evidence exceeds the local application size limit."
  );
}

const tagged = (key: string, bytes: Buffer): Buffer =>
  new BufferDataVdxfObject(bytes.toString("hex"), key).toBuffer();

function taggedHashVector(hashes: Buffer[]): Buffer {
  const writer = new bufferutils.BufferWriter(
    Buffer.alloc(varuint.encodingLength(hashes.length) + hashes.length * 32)
  );
  writer.writeCompactSize(hashes.length);
  hashes.forEach((hash) => writer.writeSlice(hash));
  return tagged(VDXF.VectorUint256Key.vdxfid, writer.buffer);
}

function evidenceOutputs(
  chainId: string,
  descriptor: DataDescriptor | MMRDescriptor
) {
  const object = new EvidenceData({
    version: new BN(1),
    type: new BN(ETypes.TYPE_DATA),
    md: undefined,
    vdxfd: VDXF.DataDescriptorKey.vdxfid,
    data_vec: tagged(
      descriptor instanceof MMRDescriptor
        ? VDXF.MMRDescriptorKey.vdxfid
        : VDXF.DataDescriptorKey.vdxfid,
      descriptor.toBuffer()
    ),
  });
  return createNotaryEvidenceOutputs(
    new NotaryEvidence({
      systemId: chainId,
      evidence: new CrossChainProof({ chainObjects: [object] }),
    })
  );
}

/**
 * Build encrypted upload evidence and the identity content entries that point
 * to it. Public uploads publish a fresh viewing key on their encrypted link.
 * The caller must authenticate the completed uploads before funding them.
 */
export async function buildLocalIdentityUpdateData({
  request,
  chainId,
  crypto,
  firstOutputIndex = 0,
  isTestnet,
}: {
  request: IdentityUpdateRequestDetails;
  chainId: string;
  crypto: LocalIdentityUploadCrypto;
  firstOutputIndex?: number;
  isTestnet?: boolean;
}): Promise<{
  outputs: Array<{ script: Buffer; value: number }>;
  contentMultiMap: Map<CompactIAddressObject, Buffer[]>;
}> {
  // Snapshot caller-owned request data before invoking asynchronous wallet code.
  request = snapshotUpdateRequestValue(request);
  validateLocalIdentityUploadRequest(request, isTestnet);

  const chain = fromBase58Check(chainId);
  requireCondition(
    chain.version === I_ADDR_VERSION &&
      chain.hash.length === 20 &&
      !chain.hash.equals(Buffer.alloc(20)),
    "Identity upload requires a valid chain identity."
  );
  requireCondition(
    Number.isSafeInteger(firstOutputIndex) &&
      firstOutputIndex >= 0 &&
      firstOutputIndex <= 0xffffffff - MAX_LOCAL_IDENTITY_UPLOAD_ITEMS,
    "Invalid first identity upload output index."
  );

  const outputs: Array<{ script: Buffer; value: number }> = [];
  const contentMultiMap = new Map<CompactIAddressObject, Buffer[]>();

  if (!request.signDataMap?.size) return { outputs, contentMultiMap };

  // Capture callbacks before the first await so wallet code cannot replace them.
  crypto = captureLocalIdentityUploadCrypto(crypto);
  const randomBytes = crypto.randomBytes.bind(crypto);
  const encrypt = crypto.encrypt.bind(crypto);
  const publicRecipient = crypto.createPublicRecipient?.bind(crypto);

  // Match the daemon's ordering by the decoded content-key bytes.
  const entries = [...request.signDataMap.entries()].sort(([a], [b]) =>
    fromBase58Check(a.toIAddress()).hash.compare(
      fromBase58Check(b.toIAddress()).hash
    )
  );
  requireCondition(
    entries.every(([, upload]) => upload.encryptToAddress || publicRecipient),
    "Public identity uploads require a fresh public-recipient callback."
  );

  // Reject repeated EPKs and public recipients within this build.
  const epks = new Set<string>();
  const publicAddresses = new Set<string>();
  const publicIvks = new Set<string>();
  let multipartGroups = 0;
  let outputBytes = 0;

  for (const [key, upload] of entries) {
    const items = localIdentityUploadItems(upload);
    const objectHashType = upload.hashType!.toNumber() as EHashTypes;
    let address = upload.encryptToAddress?.toAddressString();
    let ivk: Buffer | undefined;

    // Public data is also encrypted; its fresh IVK will be published on the link.
    if (!address) {
      const recipient = await publicRecipient!();
      requireCondition(
        recipient &&
          typeof recipient.address === "string" &&
          Buffer.isBuffer(recipient.ivk) &&
          recipient.ivk.length === 32 &&
          !recipient.ivk.equals(Buffer.alloc(32)),
        "Public identity upload recipient must include an address and 32-byte IVK."
      );

      // Verus mainnet and asset-chain testnets both use main-chain parameters.
      const decoded = fromBech32(recipient.address);
      requireCondition(
        decoded.prefix === "zs" &&
          decoded.data.length === 43 &&
          SaplingPaymentAddress.fromAddressString(
            recipient.address
          ).toAddressString() === recipient.address &&
          !decoded.data.subarray(11).equals(Buffer.alloc(32)) &&
          !publicAddresses.has(recipient.address) &&
          !publicIvks.has(recipient.ivk.toString("hex")),
        "Public identity upload recipient is invalid, wrong-network, or reused."
      );

      address = recipient.address;
      ivk = Buffer.from(recipient.ivk);
      publicAddresses.add(address);
      publicIvks.add(ivk.toString("hex"));
    }

    // Encrypt the entire tagged descriptor. These checks validate the callback's
    // result shape and duplicate EPKs; authenticated decryption happens later.
    const wrap = async (plain: DataDescriptor): Promise<DataDescriptor> => {
      const bytes = new VDXFDataDescriptor(
        plain,
        VDXF.DataDescriptorKey.vdxfid
      ).toBuffer();
      const result = await encrypt(Buffer.from(bytes), address!);
      requireCondition(
        result &&
          Buffer.isBuffer(result.epk) &&
          result.epk.length === 32 &&
          !result.epk.equals(Buffer.alloc(32)) &&
          Buffer.isBuffer(result.ciphertext) &&
          result.ciphertext.length === bytes.length + 16 &&
          !epks.has(result.epk.toString("hex")),
        "Identity upload encryption returned invalid ciphertext or a reused ephemeral key."
      );
      epks.add(result.epk.toString("hex"));

      return new DataDescriptor({
        flags: DataDescriptor.FLAG_ENCRYPTED_DATA.clone(),
        epk: Buffer.from(result.epk),
        objectdata: Buffer.from(result.ciphertext),
      });
    };

    const hashes: Buffer[] = [];
    const leaves: DataDescriptor[] = [];

    for (const item of items) {
      if (item.isHash) {
        // Hash-only leaves carry an empty descriptor and use daemon hash byte order.
        hashes.push(
          objectHashType === HASH_TYPE_SHA256.toNumber()
            ? Buffer.from(item.bytes)
            : Buffer.from(item.bytes).reverse()
        );
        leaves.push(await wrap(new DataDescriptor()));
      } else {
        // Commit to both the payload and salt; preserve both inside the ciphertext.
        const returnedSalt = item.salt || (await randomBytes(32));
        requireCondition(
          Buffer.isBuffer(returnedSalt) && returnedSalt.length === 32,
          "Identity upload randomness must return exactly 32 bytes."
        );

        const salt = Buffer.from(returnedSalt);
        hashes.push(
          hashData(Buffer.concat([item.bytes, salt]), objectHashType)
        );
        leaves.push(
          await wrap(new DataDescriptor({ objectdata: item.bytes, salt }))
        );
      }
    }

    // A single leaf is stored directly. Multiple leaves also encrypt the MMR
    // root and hash vector so the verifier can check their shared commitment.
    let descriptor: DataDescriptor | MMRDescriptor = leaves[0];

    if (leaves.length > 1) {
      const mmrHashType = (
        upload.data as PartialMMRData
      ).mmrhashtype!.toNumber() as EHashTypes;
      descriptor = new MMRDescriptor({
        objectHashType,
        mmrHashType,
        mmrRoot: await wrap(
          new DataDescriptor({ objectdata: getMMRRoot(hashes, mmrHashType) })
        ),
        mmrHashes: await wrap(
          new DataDescriptor({ objectdata: taggedHashVector(hashes) })
        ),
        dataDescriptors: leaves,
      });
    }

    // Bound the combined evidence before adding its outputs to the transaction.
    const group = evidenceOutputs(chainId, descriptor);

    if (group.length > 1) multipartGroups++;

    // The daemon reader cannot safely traverse adjacent multipart groups.
    requireCondition(
      multipartGroups <= 1,
      "Only one multipart identity upload group is supported per transaction."
    );
    outputBytes += group.reduce(
      (sum, output) => sum + output.script.length + 12,
      0
    );
    requireCondition(
      outputBytes <= MAX_LOCAL_IDENTITY_UPLOAD_OUTPUT_BYTES,
      "Identity upload evidence exceeds the local application size limit."
    );

    // A zero transaction hash refers to this transaction. Anchor the link to the
    // group's first absolute output index, including any preceding outputs.
    const reference = new CrossChainDataRef(
      new PBaaSEvidenceRef({
        flags: PBaaSEvidenceRef.FLAG_ISEVIDENCE.clone(),
        output: new UTXORef({
          hash: Buffer.alloc(32),
          n: new BN(firstOutputIndex + outputs.length),
        }),
        objectNum: new BN(0),
        subObject: new BN(0),
      })
    );
    const link = await wrap(
      new DataDescriptor({
        objectdata: tagged(
          VDXF.CrossChainDataRefKey.vdxfid,
          reference.toBuffer()
        ),
        ...(items.length > 1 ? { mimeType: "application/json" } : {}),
      })
    );

    if (ivk) {
      link.ivk = Buffer.from(ivk);
      link.setFlags();
    }

    contentMultiMap.set(key, [
      new VDXFDataDescriptor(link, VDXF.DataDescriptorKey.vdxfid).toBuffer(),
    ]);
    outputs.push(...group);
  }

  return { outputs, contentMultiMap };
}
