import { CompactIAddressObject, IdentityUpdateRequestDetails, PartialSignData } from "verus-typescript-primitives";
import type { IdentityUpdateDataDecryptor } from "./updateDataVerification";
/** Application limits leave room for identity, funding inputs, and signatures. */
export declare const MAX_LOCAL_IDENTITY_UPLOAD_BYTES = 1000000;
export declare const MAX_LOCAL_IDENTITY_UPLOAD_OUTPUT_BYTES = 1500000;
export declare const MAX_LOCAL_IDENTITY_UPLOAD_ITEMS = 4096;
export interface LocalIdentityUploadCrypto {
    /** Cryptographically secure random bytes; every ordinary leaf needs a salt. */
    randomBytes(length: number): Buffer | Promise<Buffer>;
    /**
     * Encrypt the complete tagged descriptor using fresh Sapling ephemeral key
     * material, authenticated ChaCha20-Poly1305, and the daemon's Sapling KDF.
     * Never return or serialize a symmetric key here. A wallet may retain one
     * temporarily for authenticated verification of an external recipient.
     */
    encrypt(plaintext: Buffer, recipientAddress: string): {
        epk: Buffer;
        ciphertext: Buffer;
    } | Promise<{
        epk: Buffer;
        ciphertext: Buffer;
    }>;
    /** Generate a fresh recipient. This IVK is deliberately published on chain. */
    createPublicRecipient?(): {
        address: string;
        ivk: Buffer;
    } | Promise<{
        address: string;
        ivk: Buffer;
    }>;
    /** Must authenticate ciphertext, including locally encrypted descriptors. */
    decryptData: IdentityUpdateDataDecryptor;
}
export interface LocalIdentityUploadItem {
    bytes: Buffer;
    isHash: boolean;
    salt?: Buffer;
}
/** Capture methods without copying wallet-owned key storage or class internals. */
export declare function captureLocalIdentityUploadCrypto(crypto: LocalIdentityUploadCrypto): LocalIdentityUploadCrypto;
export declare function captureLocalIdentityUploadCrypto(crypto: LocalIdentityUploadCrypto | undefined): LocalIdentityUploadCrypto | undefined;
/** Convert request bytes using the daemon's ordinary (not compact) VDXF form. */
export declare function localIdentityUploadItems(upload: PartialSignData): LocalIdentityUploadItem[];
/**
 * Reject unsupported options before any wallet callback or chain-state read.
 * Verus asset chains (including VRSCTEST) use the same `zs` Sapling HRP.
 */
export declare function validateLocalIdentityUploadRequest(request: IdentityUpdateRequestDetails, _isTestnet?: boolean): void;
/**
 * Build encrypted upload evidence and the identity content entries that point
 * to it. Public uploads publish a fresh viewing key on their encrypted link.
 * The caller must authenticate the completed uploads before funding them.
 */
export declare function buildLocalIdentityUpdateData({ request, chainId, crypto, firstOutputIndex, isTestnet, }: {
    request: IdentityUpdateRequestDetails;
    chainId: string;
    crypto: LocalIdentityUploadCrypto;
    firstOutputIndex?: number;
    isTestnet?: boolean;
}): Promise<{
    outputs: Array<{
        script: Buffer;
        value: number;
    }>;
    contentMultiMap: Map<CompactIAddressObject, Buffer[]>;
}>;
