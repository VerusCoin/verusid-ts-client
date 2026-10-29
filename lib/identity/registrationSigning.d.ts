import { networks } from "@bitgo/utxo-lib";
/** Raw source bytes are required, including for zero-value commitment inputs. */
export interface RegistrationSigningPrevout {
    txid: string;
    vout: number;
    rawTransaction: string;
    scriptHex?: string;
    /** Native atomic units, never a floating-point coin amount. */
    value?: string;
}
/**
 * The caller must bind these authorities to current, verified chain evidence.
 * An i-address alone does not establish its current primary-key threshold.
 */
export interface RegistrationIdentityAuthority {
    identityID: string;
    primaryAddresses: string[];
    minimumSignatures: number;
    revoked?: boolean;
}
export interface InspectIdentityRegistrationSignaturesArgs {
    /** The approved transaction, possibly already partially signed. */
    txHex: string;
    prevouts: RegistrationSigningPrevout[];
    identityAuthorities?: RegistrationIdentityAuthority[];
    network?: typeof networks.verus;
}
export interface SignIdentityRegistrationTransactionArgs extends InspectIdentityRegistrationSignaturesArgs {
    /** WIF keys in exactly the transaction's input order. Empty entries are allowed. */
    keys?: string[][];
    partialTransactions?: string[];
}
export interface RegistrationDestinationSignatureStatus {
    destination: string;
    identityID?: string;
    threshold: number | null;
    eligibleKeyIDs: string[];
    signedKeyIDs: string[];
    missingSignatures: number | null;
    unresolvedIdentity: boolean;
}
export interface RegistrationInputSignatureStatus {
    inputIndex: number;
    txid: string;
    vout: number;
    /** Number of destination conditions that must be fulfilled on this input. */
    threshold: number;
    complete: boolean;
    requirements: RegistrationDestinationSignatureStatus[];
}
export interface IdentityRegistrationSigningResult {
    hex: string;
    txHex: string;
    /** Only the txid of these exact bytes; signing again can change it. */
    txid: string;
    signingStatus: "unsigned" | "partial" | "complete";
    inputs: RegistrationInputSignatureStatus[];
}
/** Validate identity key membership and thresholds before paying a commitment fee. */
export declare function validateRegistrationIdentityAuthorities(authorities: RegistrationIdentityAuthority[]): void;
/**
 * Verify/merge only signatures against an approved transaction and raw prevouts.
 * Economic and registration-policy validation belongs to the prepared builder;
 * this function never approves a change to that transaction's contents.
 */
export declare function signIdentityRegistrationTransaction(args: SignIdentityRegistrationTransactionArgs): IdentityRegistrationSigningResult;
/** Inspect signatures without changing the supplied transaction bytes or txid. */
export declare function inspectIdentityRegistrationSignatures(args: InspectIdentityRegistrationSignaturesArgs): IdentityRegistrationSigningResult;
export declare function mergeIdentityRegistrationTransactions(args: InspectIdentityRegistrationSignaturesArgs & {
    partialTransactions: string[];
}): IdentityRegistrationSigningResult;
