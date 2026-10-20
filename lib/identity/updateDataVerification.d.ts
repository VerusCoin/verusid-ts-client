import { DataDescriptor, IdentityUpdateRequestDetails } from "verus-typescript-primitives";
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
export type IdentityUpdateDataDecryptor = (descriptor: DataDescriptor, context: IdentityUpdateDataDecryptionContext) => Buffer | Promise<Buffer>;
/**
 * Verify the upload portion of an unfunded identity-update template. Every
 * evidence group must be referenced by a requested content key and every leaf
 * must match its requested bytes. This checks uploaded content and its bounded
 * encoding; it does not verify data signatures or recompute MMR commitments.
 */
export declare function verifyIdentityUpdateData(request: IdentityUpdateRequestDetails, unfundedTxHex: string, decryptData: IdentityUpdateDataDecryptor): Promise<true>;
