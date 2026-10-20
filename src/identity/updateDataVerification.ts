import {
  BufferDataVdxfObject,
  CrossChainDataRef,
  DataDescriptor,
  Identity,
  IdentityScript,
  IdentityUpdateRequestDetails,
  MMRDescriptor,
  PartialMMRData,
  PartialSignData,
  PBaaSEvidenceRef,
  SignatureData,
  SmartTransactionScript,
  VdxfUniValue,
  EVALS,
  DATA_TYPE_FILENAME,
  DATA_TYPE_DATAHASH,
  DATA_TYPE_VDXFDATA,
  HASH_TYPE_SHA256,
} from "verus-typescript-primitives";
import * as VDXF from "verus-typescript-primitives/dist/vdxf/vdxfdatakeys";
import bufferutils from "verus-typescript-primitives/dist/utils/bufferutils";
import {
  parseScript,
  requireCondition,
  transaction,
} from "./fundingPrimitives";
import { readIdentityUpdateEvidence } from "./updateDataEvidence";
import { snapshotUpdateRequestValue } from "./requestSnapshot";

export interface IdentityUpdateDataDecryptionContext {
  /** Requested contentmultimap key whose evidence is being decrypted. */
  contentKey: string;

  /** Requested private recipient; absent when the upload publishes its IVK. */
  encryptToAddress?: string;
}

/**
 * Authenticate and decrypt objectdata, returning the raw plaintext bytes.
 * The SDK parses the plaintext. The descriptor is a detached copy, including
 * the public link's IVK when its children need that key. Private keys stay in
 * the wallet; encryptToAddress identifies the requested recipient when needed.
 */
export type IdentityUpdateDataDecryptor = (
  descriptor: DataDescriptor,
  context: IdentityUpdateDataDecryptionContext
) => Buffer | Promise<Buffer>;

type Encoded = {
  fromBuffer(bytes: Buffer, offset?: number): number;
  toBuffer(): Buffer;
};

// Authenticated encryption adds a fixed tag, not arbitrary ciphertext padding.
const AUTHENTICATION_TAG_BYTES = 16;

// Allow the identity signature header and up to 25 compact signatures.
const MAX_IDENTITY_SIGNATURE_BYTES = 8 + 25 * 66;

/** Consume the entire object and reject alternate encodings or trailing bytes. */
function decode<T extends Encoded>(value: T, bytes: Buffer): T {
  requireCondition(
    value.fromBuffer(bytes, 0) === bytes.length &&
      value.toBuffer().equals(bytes),
    "Noncanonical identity upload data."
  );

  return value;
}

/** Remove a VDXF wrapper only after checking its version and expected type key. */
function tagged(bytes: Buffer, key: string): Buffer {
  const value = decode(new BufferDataVdxfObject(), bytes);

  requireCondition(
    value.version.eqn(1) && value.vdxfkey === key,
    "Unexpected identity upload data type."
  );

  return value.toDataBuffer();
}

/** Decrypted descriptors may contain only the metadata expected at this layer. */
function metadata(
  descriptor: DataDescriptor,
  label = "",
  mimeType = "",
  salted = false
) {
  requireCondition(
    descriptor.version.eqn(1) &&
      !descriptor.hasEncryptedData() &&
      !descriptor.hasVDXFKey() &&
      !descriptor.hasEPK() &&
      !descriptor.hasIVK() &&
      !descriptor.hasSSK() &&
      (descriptor.label || "") === label &&
      (descriptor.mimeType || "") === mimeType &&
      (salted ? descriptor.salt?.length === 32 : !descriptor.salt?.length),
    "Unexpected identity upload descriptor metadata."
  );
}

async function decryptDescriptor(
  descriptor: DataDescriptor,
  decrypt: IdentityUpdateDataDecryptor,
  context: IdentityUpdateDataDecryptionContext,
  ivk?: Buffer,
  publicLink = false
): Promise<DataDescriptor> {
  // Only public contentmultimap (CMM) links may publish an incoming viewing key
  // (IVK). Private uploads must use the wallet's key for the requested recipient.
  // Reject extra keys and metadata that could also inflate the funded size.
  requireCondition(
    descriptor.version.eqn(1) &&
      descriptor.hasEncryptedData() &&
      descriptor.epk?.length === 32 &&
      (publicLink ? descriptor.ivk?.length === 32 : !descriptor.ivk?.length) &&
      !descriptor.ssk?.length &&
      !descriptor.salt?.length &&
      !descriptor.label &&
      !descriptor.mimeType &&
      !descriptor.hasVDXFKey(),
    "Invalid encrypted identity upload descriptor."
  );

  // Pass detached objects to application code. Child descriptors inherit the
  // public link's IVK on this copy, without changing the transaction's bytes.
  const copy = decode(new DataDescriptor(), Buffer.from(descriptor.toBuffer()));

  if (!copy.ivk?.length && ivk?.length) {
    copy.ivk = Buffer.from(ivk);
    copy.setFlags();
  }

  const plaintext = await decrypt(copy, { ...context });

  // The callback authenticates the ciphertext. The SDK still checks its length
  // and parses the returned bytes itself before trusting any decrypted fields.
  requireCondition(
    Buffer.isBuffer(plaintext) &&
      descriptor.objectdata.length ===
        plaintext.length + AUTHENTICATION_TAG_BYTES,
    "Identity upload decryption returned an invalid plaintext length."
  );

  return decode(
    new DataDescriptor(),
    tagged(plaintext, VDXF.DataDescriptorKey.vdxfid)
  );
}

/** Treat single-item and MMR requests uniformly when comparing uploaded leaves. */
function uploadItems(request: PartialSignData) {
  const items = request.isMMRData()
    ? (request.data as PartialMMRData).data
    : [
        {
          type: request.dataType!,
          data: request.data as Buffer | VdxfUniValue,
        },
      ];

  requireCondition(items.length > 0, "Identity upload request has no data.");

  // A filename describes the daemon's filesystem, not bytes approved locally.
  for (const item of items) {
    requireCondition(
      item.type && !item.type.eq(DATA_TYPE_FILENAME),
      "Identity upload verification requires inline data, not a remote filename."
    );
  }

  return items;
}

/**
 * Verify the upload portion of an unfunded identity-update template. Every
 * evidence group must be referenced by a requested content key and every leaf
 * must match its requested bytes. This checks uploaded content and its bounded
 * encoding; it does not verify data signatures or recompute MMR commitments.
 */
export async function verifyIdentityUpdateData(
  request: IdentityUpdateRequestDetails,
  unfundedTxHex: string,
  decryptData: IdentityUpdateDataDecryptor
): Promise<true> {
  // Retain the exact request fields used by RPC before callbacks can mutate them.
  request = snapshotUpdateRequestValue(request);

  // Collect complete evidence groups and the identity that links to them.
  // Ordinary identity fields and transaction funding are checked by the caller.
  const tx = transaction(unfundedTxHex);
  const groups = readIdentityUpdateEvidence(tx.outs);
  const definitions = tx.outs.filter((output: any) =>
    parseScript(SmartTransactionScript, output.script).paramsOptCC.evalCode.eqn(
      EVALS.EVAL_IDENTITY_PRIMARY
    )
  );

  requireCondition(
    definitions.length === 1,
    "Expected one identity upload definition."
  );

  const identity: Identity = parseScript(
    IdentityScript,
    definitions[0].script
  ).getIdentity();

  requireCondition(
    request.containsSignData() &&
      request.signDataMap &&
      request.signDataMap.size > 0,
    "Expected an identity upload request."
  );

  requireCondition(
    typeof decryptData === "function",
    "Identity data uploads require a decryption callback."
  );

  // Each requested upload owns exactly one group, even if it spans many outputs.
  requireCondition(
    groups.size === request.signDataMap!.size,
    "Identity upload evidence does not match the requested uploads."
  );

  for (const [key, upload] of request.signDataMap!.entries()) {
    const contentKey = key.toAddress();
    const values = identity.contentMultiMap.kvContent.getByAddress(contentKey);

    requireCondition(
      values?.length === 1 && Buffer.isBuffer(values[0]),
      "Expected one identity upload link per requested key."
    );

    const links = values![0] as Buffer;
    const items = uploadItems(upload);
    const context = {
      contentKey,
      encryptToAddress: upload.encryptToAddress?.toAddressString(),
    };

    let cursor = 0;
    let groupIndex = -1;
    let sharedIVK: Buffer | undefined;
    const linkCount = upload.address ? 2 : 1;

    // A content entry contains one data link and, when requested, a signature
    // link. Both must reference the same local evidence group.
    for (let index = 0; index < linkCount; index++) {
      const encoded = new BufferDataVdxfObject();
      const end = encoded.fromBuffer(links, cursor);
      const outer = decode(
        new DataDescriptor(),
        tagged(links.subarray(cursor, end), VDXF.DataDescriptorKey.vdxfid)
      );

      if (index === 0) sharedIVK = outer.ivk;

      const link = await decryptDescriptor(
        outer,
        decryptData,
        context,
        sharedIVK,
        !upload.encryptToAddress
      );

      metadata(
        link,
        index ? "signature" : "",
        index || items.length > 1 ? "application/json" : ""
      );

      // A zero transaction hash means this transaction. Object 0 contains the
      // upload, with subobject 0 for data and subobject 1 for its signature.
      const reference = decode(
        new CrossChainDataRef(),
        tagged(link.objectdata, VDXF.CrossChainDataRefKey.vdxfid)
      ).ref;

      requireCondition(
        reference instanceof PBaaSEvidenceRef &&
          reference.version.eqn(1) &&
          reference.flags.eq(PBaaSEvidenceRef.FLAG_ISEVIDENCE) &&
          reference.output.hash.equals(Buffer.alloc(32)) &&
          reference.objectNum.isZero() &&
          reference.subObject.eqn(index),
        "Identity upload link does not reference local evidence."
      );

      const outputIndex = (reference as PBaaSEvidenceRef).output.n.toNumber();

      if (index === 0) groupIndex = outputIndex;

      requireCondition(
        outputIndex === groupIndex,
        "Identity upload links reference different evidence groups."
      );

      cursor = end;
    }

    requireCondition(
      cursor === links.length,
      "Unexpected additional identity upload links."
    );

    const group = groups.get(groupIndex);

    requireCondition(
      group && group.proof.chainObjects.length === linkCount,
      "Missing or unexpected identity upload evidence objects."
    );

    // Consume the group so another requested key cannot reuse the same evidence.
    groups.delete(groupIndex);

    // The daemon stores a single leaf directly, or an MMR for multiple leaves.
    const dataObject = group!.proof.chainObjects[0];

    requireCondition(
      dataObject.vdxfd === VDXF.DataDescriptorKey.vdxfid,
      "Unexpected identity upload evidence type."
    );

    let leaves: DataDescriptor[];
    let hashes: Buffer[] | undefined;
    let root: Buffer | undefined;

    if (items.length === 1) {
      leaves = [
        decode(
          new DataDescriptor(),
          tagged(dataObject.data_vec, VDXF.DataDescriptorKey.vdxfid)
        ),
      ];
    } else {
      // Multi-item uploads retain their MMR root and hash vector. Their sizes
      // are fixed by the requested leaf count, regardless of encrypted bytes.
      const mmr = decode(
        new MMRDescriptor(),
        tagged(dataObject.data_vec, VDXF.MMRDescriptorKey.vdxfid)
      );

      requireCondition(
        mmr.version.eqn(1) &&
          mmr.dataDescriptors.length === items.length &&
          mmr.objectHashType === upload.hashType!.toNumber() &&
          mmr.mmrHashType ===
            (upload.data as PartialMMRData).mmrhashtype!.toNumber(),
        "Identity upload MMR does not match the requested items."
      );

      const rootDescriptor = await decryptDescriptor(
        mmr.mmrRoot,
        decryptData,
        context,
        sharedIVK
      );

      metadata(rootDescriptor);
      root = rootDescriptor.objectdata;

      requireCondition(
        root.length === 32,
        "Invalid identity upload MMR root length."
      );

      const hashDescriptor = await decryptDescriptor(
        mmr.mmrHashes,
        decryptData,
        context,
        sharedIVK
      );

      metadata(hashDescriptor);

      // A CompactSize count precedes one 32-byte hash per requested leaf.
      // Neither extra hashes nor trailing bytes may enlarge the fee allowance.
      const reader = new bufferutils.BufferReader(
        tagged(hashDescriptor.objectdata, VDXF.VectorUint256Key.vdxfid)
      );

      requireCondition(
        reader.readCompactSize() === items.length &&
          reader.buffer.length - reader.offset === items.length * 32,
        "Identity upload MMR hash count does not match the requested items."
      );

      hashes = items.map(() => reader.readSlice(32));
      leaves = mmr.dataDescriptors;
    }

    // Compare authenticated leaves in request order, including any supplied salt.
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const leaf = await decryptDescriptor(
        leaves[index],
        decryptData,
        context,
        sharedIVK
      );

      const isHash = item.type.eq(DATA_TYPE_DATAHASH);
      metadata(leaf, "", "", !isHash);

      // Requests may use FqnVdxfUniValue's compact-key wire format. The daemon
      // receives its JSON and stores ordinary VDXF bytes instead.
      const expected = item.type.eq(DATA_TYPE_VDXFDATA)
        ? VdxfUniValue.fromJson((item.data as VdxfUniValue).toJson()).toBuffer()
        : (item.data as Buffer);

      if (isHash) {
        // Hash-only leaves have no payload or salt. Their binding comes from
        // the MMR hash vector, which the daemon omits for a single-item upload.
        requireCondition(
          hashes &&
            expected.length === 32 &&
            leaf.objectdata.length === 0 &&
            hashes[index].equals(
              upload.hashType!.eq(HASH_TYPE_SHA256)
                ? expected
                : Buffer.from(expected).reverse()
            ),
          "A hash-only upload requires a matching MMR hash entry; supply inline bytes for a single-item upload."
        );
      } else {
        requireCondition(
          leaf.objectdata.equals(expected),
          "Identity upload plaintext does not match the requested data."
        );

        const salt = upload.isMMRData()
          ? (upload.data as PartialMMRData).salt?.[index]
          : undefined;

        if (salt) {
          // Match the daemon's fixed 32-byte salt representation.
          const expectedSalt = Buffer.alloc(32);
          salt.copy(expectedSalt, 0, 0, 32);

          requireCondition(
            leaf.salt.equals(expectedSalt),
            "Identity upload salt does not match the request."
          );
        }
      }
    }

    if (upload.address) {
      // Optional signature evidence has bounded encoding and must describe the
      // requested signer and bindings. Signature authentication is separate.
      const evidence = group!.proof.chainObjects[1];

      requireCondition(
        evidence.vdxfd === VDXF.SignatureDataKey.vdxfid,
        "Unexpected identity upload signature evidence."
      );

      const encrypted = decode(
        new DataDescriptor(),
        tagged(evidence.data_vec, VDXF.SignatureDataKey.vdxfid)
      );
      const plain = await decryptDescriptor(
        encrypted,
        decryptData,
        context,
        sharedIVK
      );

      metadata(plain);

      const signature = decode(new SignatureData(), plain.objectdata);

      requireCondition(
        // Match the signer and the daemon's hash type. For a single leaf,
        // the MMR root uses the object hash type.
        signature.version.eqn(1) &&
          signature.sigType.eqn(1) &&
          signature.identityID === upload.address.toAddress() &&
          signature.hashType.eq(
            items.length > 1
              ? (upload.data as PartialMMRData).mmrhashtype!
              : upload.hashType!
          ) &&

          // Bound variable signature bytes and match the retained MMR root.
          signature.signatureHash.length === 32 &&
          (!root || root.equals(signature.signatureHash)) &&
          signature.signatureAsVch.length > 0 &&
          signature.signatureAsVch.length <= MAX_IDENTITY_SIGNATURE_BYTES &&

          // Keep binding order and match the daemon's ASCII-only case folding.
          // Hash byte order is SHA-256 directly, other hashes reversed.
          JSON.stringify(signature.vdxfKeys) ===
            JSON.stringify(
              (upload.vdxfKeys || []).map((value) => value.toAddress())
            ) &&
          JSON.stringify(signature.vdxfKeyNames) ===
            JSON.stringify(
              (upload.vdxfKeyNames || []).map((value) =>
                value
                  .toString("utf8")
                  .replace(/[A-Z]/g, char => char.toLowerCase())
              )
            ) &&
          JSON.stringify(
            signature.boundHashes.map((value) => value.toString("hex"))
          ) ===
            JSON.stringify(
              (upload.boundHashes || []).map((value) =>
                (upload.hashType!.eq(HASH_TYPE_SHA256)
                  ? value
                  : Buffer.from(value).reverse()
                ).toString("hex")
              )
            ),
        "Identity upload signature metadata does not match the request."
      );
    }
  }

  requireCondition(groups.size === 0, "Unreferenced identity upload evidence.");

  return true;
}
