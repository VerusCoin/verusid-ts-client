import { Identity } from "verus-typescript-primitives";
import { LocalIdentityUpdateContext, LocalIdentityUpdateResult } from "./localIdentityUpdate";
/**
 * Check source/target invariants that require no assumed chain height.
 * The funding verifier can repeat these checks against retained prevout bytes.
 * Currency launch and tokenization require dedicated, separately verified flows.
 */
export declare function validateIdentityUpdateTransitionInvariants(current: Identity, next: Identity): void;
/**
 * Validate an explicitly supplied final identity without rewriting its flags,
 * locks, private addresses, or contents. Partial updates normalize separately.
 */
export declare function validateFullIdentityUpdate(current: Identity, next: Identity, context: LocalIdentityUpdateContext): LocalIdentityUpdateResult["requiredAuthorities"];
