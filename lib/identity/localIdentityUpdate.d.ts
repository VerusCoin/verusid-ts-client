import BN from "bn.js";
import { Identity, PartialIdentity } from "verus-typescript-primitives";
import { IdentityLockContext } from "./identityLocks";
export interface LocalIdentityUpdateContext {
    chainId: string;
    /** The same next-block height and expiry used to construct the transaction. */
    nextBlockHeight: number;
    expiryHeight: number;
    rootSystemName?: string;
    /** Upload references count as a primary mutation of a revoked identity. */
    hasDataUploads?: boolean;
}
export interface LocalIdentityUpdateResult {
    identity: Identity;
    /** Resolve these identities on the configured chain before funding. */
    requiredAuthorities: Array<{
        address: string;
        role: "revocation" | "recovery";
    }>;
}
/**
 * Restrict update state to the daemon version exercised by the live audit.
 * A legacy source needs a separately verified migration path before enabling it.
 */
export declare function validateSupportedIdentityUpdateState(identity: Identity): void;
/** Authority existence checks shared by partial and full local update paths. */
export declare function getIdentityUpdateRequiredAuthorities(current: Identity, next: Identity, hasDataUploads?: boolean, rootSystemName?: string): LocalIdentityUpdateResult["requiredAuthorities"];
/** Reject invalid modern lock mutations using the actual inclusion context. */
export declare function validateLockMutation(current: Identity, next: Identity, height: BN, expiry: BN, context: IdentityLockContext): void;
/**
 * Apply an ordinary partial update using the current PBaaS daemon rules.
 * The base must be decoded from the spent identity output, with raw content.
 * This helper performs no RPC, encryption, signing, funding, or broadcasting.
 */
export declare function applyLocalIdentityUpdate(current: Identity, partial: PartialIdentity, context: LocalIdentityUpdateContext): LocalIdentityUpdateResult;
