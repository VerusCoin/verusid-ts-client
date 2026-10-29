import BN from "bn.js";
import { Identity } from "verus-typescript-primitives";
/** Trusted active-chain context, never the node's estimated longest chain. */
export interface IdentityLockContext {
    chainId: string;
    nextBlockHeight: number;
}
/** CIdentity::IsLocked(height), including the historical vARRR exception. */
export declare function isIdentityLockedAtHeight(identity: Identity, context: IdentityLockContext): boolean;
/**
 * updateidentity's lock-bit normalization over binary uint32 timelocks.
 * This deliberately does not emulate the RPC JSON parser's numeric coercions.
 */
export declare function normalizeIdentityLockUpdate(current: Identity, next: Identity, height: BN, expiry: BN): void;
/** The lock portion of post-PBaaS CIdentity::IsInvalidMutation. */
export declare function validateIdentityLockTransition(current: Identity, next: Identity, context: IdentityLockContext, expiryHeight: number): void;
/**
 * Verification without independently trusted height requires validity at every
 * nonexpired inclusion height. Lock state changes only at these boundaries.
 * A caller with trusted current context can instead verify at that actual height.
 */
export declare function validateIdentityLocksWithoutHeight(current: Identity, next: Identity, chainId: string, expiryHeight: number): void;
