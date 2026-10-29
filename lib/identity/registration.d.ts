import { Identity, IdentityRegistrationNameRequest, VerusCLIVerusIDJson } from "verus-typescript-primitives";
import { VerusdRpcInterface } from "verusd-rpc-ts-client";
import { IdentityRegistrationPolicy, IdentityRegistrationQuote } from "./registrationPolicy";
import { RegistrationIdentityAuthority, RegistrationInputSignatureStatus } from "./registrationSigning";
import { FundedRegistration, RegistrationAmounts, RegistrationChainSnapshot, RegistrationFundingInput } from "./registrationTransaction";
export interface ResolveIdentityRegistrationRequest extends IdentityRegistrationNameRequest {
    referralID?: string;
    /** Defaults to the chain's block-time-derived expiry delta (20 through 60). */
    expiryDelta?: number;
    /** Commitment fee in atomic units, encoded as an integer string. */
    commitmentFee?: string;
    offer?: string;
}
export interface ResolvedIdentityRegistration {
    policy: IdentityRegistrationPolicy;
    quote: IdentityRegistrationQuote;
    snapshot: RegistrationChainSnapshot;
}
/** Private recovery data. Persist encrypted before publishing a commitment. */
export interface IdentityReservationRecord {
    readonly schemaVersion: 1;
    readonly kind: "advanced";
    readonly reservationHex: string;
    readonly identityAddress: string;
    readonly parentID: string;
    readonly systemID: string;
    readonly rootSystemName: string;
    readonly fullName: string;
    /** SHA256d commitment hash in serialized byte order. */
    readonly commitmentHashHex: string;
    readonly controller: string;
    readonly authorizationID?: string;
}
export interface CreateNameReservationTransactionRequest extends ResolveIdentityRegistrationRequest {
    controller: string;
    /** Caller-generated, secure, nonzero 32-byte salt in serialized byte order. */
    salt: Buffer;
    funding: RegistrationFundingInput[];
    changeAddress: string;
    /** Maximum costs for the entire two-transaction operation, per currency. */
    approvedCosts: RegistrationAmounts;
}
export interface PreparedIdentityRegistrationTransaction extends FundedRegistration {
    /** Alias matching the existing client's transaction builder results. */
    hex: string;
    stage: "commitment" | "registration";
    nativeFee: string;
    /** Exact change recipient approved for this build. */
    changeAddress: string;
    /** Approved cost ceilings per currency, in atomic units. */
    approvedCosts: RegistrationAmounts;
    snapshot: RegistrationChainSnapshot;
    /** Exact independently approved commitment outpoint, required for reveals. */
    commitment?: RegistrationFundingInput;
    quote: IdentityRegistrationQuote;
    identityAuthorities: RegistrationIdentityAuthority[];
    requiredSignatures: RegistrationInputSignatureStatus[];
    /** Commitments need these authorities when revealed, not when published. */
    revealAuthorities: RegistrationIdentityAuthority[];
    signingStatus: "unsigned";
}
/** Sign only against an independently retained transaction approval. */
export interface SignIdentityRegistrationTransactionArgs {
    transaction: PreparedIdentityRegistrationTransaction;
    /** Optional partial transaction whose unsigned bytes match the approved plan. */
    txHex?: string;
    keys?: string[][];
    partialTransactions?: string[];
}
export interface MergeIdentityRegistrationTransactionsArgs {
    transaction: PreparedIdentityRegistrationTransaction;
    txHex?: string;
    partialTransactions: string[];
}
export interface NameReservationTransactionResult {
    reservation: IdentityReservationRecord;
    transaction: PreparedIdentityRegistrationTransaction;
    commitmentVout: number;
}
export interface CreateIdentityRegistrationTransactionRequest {
    reservation: IdentityReservationRecord;
    /** Confirmed commitment outpoint, using its signed transaction ID. */
    commitment: RegistrationFundingInput;
    identity: Identity | VerusCLIVerusIDJson;
    funding: RegistrationFundingInput[];
    changeAddress: string;
    /** Maximum reveal costs per currency; refreshed quotes must fit these caps. */
    approvedCosts: RegistrationAmounts;
    expiryDelta?: number;
    /** Previously paid commitment fee, for the combined operation quote. */
    commitmentFee?: string;
    offer?: string;
}
/**
 * Resolve the namespace policy and initial quote at a consistent chain tip.
 * Funding may raise relay fees; transaction builders enforce the caller's caps.
 */
export declare function resolveIdentityRegistration(rpc: VerusdRpcInterface, request: ResolveIdentityRegistrationRequest): Promise<ResolvedIdentityRegistration>;
/**
 * Check a candidate against the retained quote, outputs and spending approval.
 * Run before signing or merging partials. This does not refresh chain state.
 */
export declare function validatePreparedIdentityRegistrationTransaction(prepared: PreparedIdentityRegistrationTransaction, candidateHex?: string, expectedChangeAddress?: string): true;
/**
 * Build an unsigned commitment and its private reservation recovery record.
 * Persist the record securely before broadcasting; the reveal needs its salt.
 */
export declare function createNameReservationTransaction(rpc: VerusdRpcInterface, request: CreateNameReservationTransactionRequest): Promise<NameReservationTransactionResult>;
/**
 * Build an unsigned reveal spending the saved reservation's confirmed commitment.
 * Recheck the active-chain commitment, namespace policy and approved reveal costs.
 */
export declare function createIdentityRegistrationTransaction(rpc: VerusdRpcInterface, request: CreateIdentityRegistrationTransactionRequest): Promise<PreparedIdentityRegistrationTransaction>;
