import type { PreparedIdentityRegistrationTransaction } from "./registration";
import type { FundedRegistration, RegistrationChainSnapshot, RegistrationFundingInput, RegistrationPlannedOutput } from "./registrationTransaction";
/** Retain this approval independently from the transaction being checked. */
export interface RegistrationFundingApproval {
    snapshot: RegistrationChainSnapshot;
    nativeFee: string;
    changeAddress: string;
    /** Approved outputs before the selector appends change. */
    outputs: RegistrationPlannedOutput[];
    /** Only this exact name commitment may be spent as a special input. */
    commitment?: RegistrationFundingInput;
}
/** Independent byte-level conservation check, also run automatically by fundRegistration. */
export declare function verifyRegistrationFunding(funded: FundedRegistration, approval: RegistrationFundingApproval, candidateHex?: string): true;
/**
 * Check all currencies, exact quoted fees/payments, and approved change directly
 * from transaction bytes and hash-verified source transactions. The prepared
 * approval must be retained independently from externally supplied candidates.
 * expectedChangeAddress can bind deserialized plans to an external approval.
 * This performs no RPC calls and must not be cached before broadcasting.
 */
export declare function verifyIdentityRegistrationFunding(prepared: PreparedIdentityRegistrationTransaction, candidateHex?: string, expectedChangeAddress?: string): true;
