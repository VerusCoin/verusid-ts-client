import { Identity, IdentityRegistrationNameRequest, VerusCLIVerusIDJson } from "verus-typescript-primitives";
import { VerusdRpcInterface } from "verusd-rpc-ts-client";
import { IdentityRegistrationPolicy, IdentityRegistrationQuote } from "./registrationPolicy";
import { RegistrationIdentityAuthority, RegistrationInputSignatureStatus } from "./registrationSigning";
import { FundedRegistration, RegistrationAmounts, RegistrationChainSnapshot, RegistrationFundingInput } from "./registrationTransaction";
export interface ResolveIdentityRegistrationRequest extends IdentityRegistrationNameRequest {
    referralID?: string;
    /** Defaults to the chain's block-time-derived expiry delta (20 through 60). */
    expiryDelta?: number;
    /** All costs are atomic integer strings. */
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
    /** Serialized SHA256d hash byte order, not daemon displayed uint256 hex. */
    readonly commitmentHashHex: string;
    readonly controller: string;
    readonly authorizationID?: string;
}
export interface CreateNameReservationTransactionRequest extends ResolveIdentityRegistrationRequest {
    controller: string;
    /** Securely generated nonzero 32-byte salt in serialized/internal order. Never generated implicitly. */
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
    /** The exact change recipient and cost ceilings approved for this build. */
    changeAddress: string;
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
/** Signing always uses an independently retained prepared transaction as approval. */
export interface SignIdentityRegistrationTransactionArgs {
    transaction: PreparedIdentityRegistrationTransaction;
    /** Optional partially signed candidate; its unsigned bytes must match transaction. */
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
    /** Exact outpoint of the signed/broadcast commitment; never an unsigned transaction ID. */
    commitment: RegistrationFundingInput;
    identity: Identity | VerusCLIVerusIDJson;
    funding: RegistrationFundingInput[];
    changeAddress: string;
    /** Maximum reveal costs in each currency. A refreshed quote cannot exceed this approval. */
    approvedCosts: RegistrationAmounts;
    expiryDelta?: number;
    offer?: string;
}
export declare function resolveIdentityRegistration(rpc: VerusdRpcInterface, request: ResolveIdentityRegistrationRequest): Promise<ResolvedIdentityRegistration>;
/** Economic validation must run before releasing a signature, including on external partials. */
export declare function validatePreparedIdentityRegistrationTransaction(prepared: PreparedIdentityRegistrationTransaction, candidateHex?: string, expectedChangeAddress?: string): true;
export declare function createNameReservationTransaction(rpc: VerusdRpcInterface, request: CreateNameReservationTransactionRequest): Promise<NameReservationTransactionResult>;
export declare function createIdentityRegistrationTransaction(rpc: VerusdRpcInterface, request: CreateIdentityRegistrationTransactionRequest): Promise<PreparedIdentityRegistrationTransaction>;
