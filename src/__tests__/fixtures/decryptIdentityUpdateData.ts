import { createDecipheriv } from "crypto";
import { jubjub } from "@noble/curves/misc";
import { blake2b } from "@noble/hashes/blake2";
import { DataDescriptor } from "verus-typescript-primitives";

/**
 * Authenticate historical daemon fixtures using their published viewing key.
 * This fixture helper is excluded from the build and published library.
 * Applications supply their own wallet decryptor.
 * See CVDXFEncryptor::Decrypt and KDF_Sapling in the daemon.
 */
export function decryptHistoricalUpload(descriptor: DataDescriptor): Buffer {
  if (descriptor.ivk?.length !== 32 || descriptor.epk?.length !== 32) {
    throw new Error("The test fixture must publish its Sapling viewing key.");
  }

  // Sapling stores the viewing scalar in little-endian order. Its key
  // agreement multiplies the shared Jubjub point by the cofactor, eight.
  const scalar = BigInt(
    `0x${Buffer.from(descriptor.ivk).reverse().toString("hex")}`
  );
  const shared = jubjub.Point.fromBytes(descriptor.epk)
    .multiply(scalar)
    .multiply(BigInt(8))
    .toBytes();

  // Match the daemon's personalized KDF, including the ephemeral public key.
  const key = blake2b(Buffer.concat([Buffer.from(shared), descriptor.epk]), {
    dkLen: 32,
    personalization: Buffer.from("Zcash_SaplingKDF"),
  });

  // Verus uses a zero nonce here and appends the 16-byte authentication tag
  // to the ciphertext. final() must succeed before plaintext is returned.
  const decipher = createDecipheriv(
    "chacha20-poly1305",
    Buffer.from(key),
    Buffer.alloc(12),
    {
      authTagLength: 16,
    }
  );
  decipher.setAuthTag(descriptor.objectdata.subarray(-16));

  return Buffer.concat([
    decipher.update(descriptor.objectdata.subarray(0, -16)),
    decipher.final(),
  ]);
}
