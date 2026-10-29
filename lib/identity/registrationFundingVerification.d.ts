import type { PreparedIdentityRegistrationTransaction } from "./registration";
import type { FundedRegistration, RegistrationChainSnapshot, RegistrationFundingInput, RegistrationPlannedOutput } from "./registrationTransaction";
/**
 * Retain this approval independently from the transaction being checked.
 * Amounts are decimal strings in atomic units.
 */
export interface RegistrationFundingApproval {
    snapshot: RegistrationChainSnapshot;
    /** Exact miner fee, separate from any transfer fee embedded in a burn output. */
    nativeFee: string;
    changeAddress: string;
    /** Approved outputs before the selector appends change. */
    outputs: RegistrationPlannedOutput[];
    /** Only this exact name commitment may be spent as a special input. */
    commitment?: RegistrationFundingInput;
}
/**
 * Independently verify balances against explicit approved outputs and fees.
 * Also run automatically by fundRegistration before it returns a transaction.
 */
export declare function verifyRegistrationFunding(funded: FundedRegistration, approval: RegistrationFundingApproval, candidateHex?: string): true;
/**
 * Check all currencies, exact quoted fees/payments, and approved change directly
 * from transaction bytes and hash-verified source transactions. The prepared
 * approval must be retained independently from externally supplied candidates.
 * When supplied independently, expectedChangeAddress also binds the change
 * destination to the application's approval. This checks neither signatures
 * nor current chain/UTXO state and performs no RPC calls. Run it again before
 * each broadcast.
 */
export declare function verifyIdentityRegistrationFunding(prepared: PreparedIdentityRegistrationTransaction, candidateHex?: string, expectedChangeAddress?: string): true;
