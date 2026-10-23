import {
  BufferDataVdxfObject,
  CrossChainDataRef,
  DataDescriptor,
  Identity,
  IdentityScript,
  IdentityUpdateRequestDetails,
  MMRDescriptor,
  getMMRRoot,
  hashData,
  PartialMMRData,
  PBaaSEvidenceRef,
  SmartTransactionScript,
  EVALS,
  HASH_TYPE_SHA256,
} from "verus-typescript-primitives";
import * as VDXF from "verus-typescript-primitives/dist/vdxf/vdxfdatakeys";
import {
  parseScript,
  requireCondition,
  transaction,
} from "./fundingPrimitives";
import { readIdentityUpdateEvidence } from "./updateDataEvidence";
import {
  validateLocalIdentityUploadRequest,
  localIdentityUploadItems,
} from "./localUpdateData";
import { validateIdentityUpdateTransactionSize } from "./updateLimits";
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
  usedEpks: Set<string>,
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
      !descriptor.epk.equals(Buffer.alloc(32)) &&
      !usedEpks.has(descriptor.epk.toString("hex")) &&
      (publicLink ? descriptor.ivk?.length === 32 : !descriptor.ivk?.length) &&
      !descriptor.ssk?.length &&
      !descriptor.salt?.length &&
      !descriptor.label &&
      !descriptor.mimeType &&
      !descriptor.hasVDXFKey(),
    "Invalid encrypted identity upload descriptor."
  );
  usedEpks.add(descriptor.epk.toString("hex"));

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

/**
 * Verify the upload portion of an unfunded identity-update template. Every
 * evidence group must be referenced by a requested content key and every leaf
 * must match its requested bytes. This checks uploaded content and its bounded
 * encoding, including every salted leaf hash and the MMR root. Data signatures
 * are unsupported and rejected before invoking wallet callbacks.
 */
export async function verifyIdentityUpdateData(
  request: IdentityUpdateRequestDetails,
  unfundedTxHex: string,
  decryptData: IdentityUpdateDataDecryptor,
  expectedSystemId?: string
): Promise<true> {
  // Retain exact request fields before callbacks can mutate them.
  request = snapshotUpdateRequestValue(request);
  validateLocalIdentityUploadRequest(request);
  validateIdentityUpdateTransactionSize(unfundedTxHex);

  // Collect complete evidence groups and the identity that links to them.
  // Ordinary identity fields and transaction funding are checked by the caller.
  const tx = transaction(unfundedTxHex);
  const groups = readIdentityUpdateEvidence(tx.outs, expectedSystemId);
  const usedEpks = new Set<string>();
  const publicIvks = new Set<string>();
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
    const items = localIdentityUploadItems(upload);
    const context = {
      contentKey,
      encryptToAddress: upload.encryptToAddress?.toAddressString(),
    };

    let cursor = 0;
    let groupIndex = -1;
    let sharedIVK: Buffer | undefined;
    const linkCount = 1;

    // Unsigned uploads contain exactly one local evidence link.
    for (let index = 0; index < linkCount; index++) {
      const encoded = new BufferDataVdxfObject();
      const end = encoded.fromBuffer(links, cursor);
      const outer = decode(
        new DataDescriptor(),
        tagged(links.subarray(cursor, end), VDXF.DataDescriptorKey.vdxfid)
      );

      if (index === 0) {
        sharedIVK = outer.ivk;
        if (!upload.encryptToAddress && sharedIVK) {
          requireCondition(
            !sharedIVK.equals(Buffer.alloc(32)) &&
              !publicIvks.has(sharedIVK.toString("hex")),
            "Public identity upload viewing keys must be fresh for each entry."
          );
          publicIvks.add(sharedIVK.toString("hex"));
        }
      }

      const link = await decryptDescriptor(
        outer,
        decryptData,
        context,
        usedEpks,
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
        usedEpks,
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
        usedEpks,
        sharedIVK
      );

      metadata(hashDescriptor);

      // Strict vector decoding rejects trailing/truncated data. Keep our tag
      // version and canonical encoding checks: the daemon-compatible decoder
      // accepts wrapper versions other than the one used by local uploads.
      tagged(hashDescriptor.objectdata, VDXF.VectorUint256Key.vdxfid);
      hashes = hashDescriptor.decodeHashVector(true);

      requireCondition(
        hashes.length === items.length,
        "Identity upload MMR hash count does not match the requested items."
      );

      leaves = mmr.dataDescriptors;
    }

    const computedHashes: Buffer[] = [];
    // Compare authenticated leaves in request order, including any supplied salt.
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const leaf = await decryptDescriptor(
        leaves[index],
        decryptData,
        context,
        usedEpks,
        sharedIVK
      );

      metadata(leaf, "", "", !item.isHash);
      if (item.isHash) {
        const digest = upload.hashType!.eq(HASH_TYPE_SHA256)
          ? item.bytes
          : Buffer.from(item.bytes).reverse();
        requireCondition(
          hashes &&
            leaf.objectdata.length === 0 &&
            hashes[index].equals(digest),
          "A hash-only upload requires a matching MMR hash entry; supply inline bytes for a single-item upload."
        );
        computedHashes.push(digest);
      } else {
        requireCondition(
          leaf.objectdata.equals(item.bytes),
          "Identity upload plaintext does not match the requested data."
        );
        if (item.salt) {
          requireCondition(
            leaf.salt.equals(item.salt),
            "Identity upload salt does not match the request."
          );
        }
        const digest = hashData(
          Buffer.concat([leaf.objectdata, leaf.salt]),
          upload.hashType!.toNumber()
        );
        requireCondition(
          !hashes || hashes[index].equals(digest),
          "Identity upload MMR leaf hash does not match its salted data."
        );
        computedHashes.push(digest);
      }
    }
    if (root) {
      requireCondition(
        getMMRRoot(
          computedHashes,
          (upload.data as PartialMMRData).mmrhashtype!.toNumber()
        ).equals(root),
        "Identity upload MMR root does not match its leaf hashes."
      );
    }
  }

  requireCondition(groups.size === 0, "Unreferenced identity upload evidence.");

  return true;
}
