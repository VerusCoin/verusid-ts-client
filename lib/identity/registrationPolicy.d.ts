import { CurrencyDefinition, IdentityDefinition, IdentityRegistrationNameRequest, ResolvedIdentityRegistrationName } from "verus-typescript-primitives";
export declare class RegistrationError extends Error {
    readonly code: string;
    readonly details?: unknown | undefined;
    constructor(code: string, message: string, details?: unknown | undefined);
}
/** The public RPC client satisfies this adapter; wallet signing RPCs are not used. */
export interface RegistrationPolicyRpc {
    getCurrency(id: string): Promise<unknown>;
    getIdentity(id: string, height?: number): Promise<unknown>;
    getIdentityHistory(id: string, start?: number, end?: number): Promise<unknown>;
    getRawTransaction(txid: string, verbose?: number): Promise<unknown>;
    getBlock(hashOrHeight: string, verbosity?: number): Promise<unknown>;
}
export interface RegistrationPolicyRequest extends IdentityRegistrationNameRequest {
    candidateHeight: number;
    /** On reveal this is the verified active-chain commitment height. */
    commitmentHeight?: number;
    referralID?: string;
}
export type RegistrationPaymentBranch = "native" | "token-payment" | "token-burn";
export interface RegistrationReferralEvidence {
    identityID: string;
    firstHeight: number;
    blockHash: string;
    txid: string;
    identityVout: number;
    reservationVout?: number;
}
export interface IdentityRegistrationPolicy {
    resolvedName: ResolvedIdentityRegistrationName;
    branch: RegistrationPaymentBranch;
    candidateHeight: number;
    commitmentHeight?: number;
    parentDefinition: CurrencyDefinition;
    nativeDefinition: CurrencyDefinition;
    issuerID: string;
    feePricingCurrencyID: string;
    referralID?: string;
    referralRecipients: string[];
    referralEvidence?: RegistrationReferralEvidence;
    requiredAuthorityID?: string;
    requiredAuthority?: IdentityDefinition;
}
export interface RegistrationPayment {
    currencyID: string;
    recipient: string;
    amount: string;
}
export interface IdentityRegistrationQuote {
    branch: RegistrationPaymentBranch;
    systemID: string;
    parentID: string;
    issuerID: string;
    feePricingCurrencyID: string;
    candidateHeight: number;
    commitmentFee: string;
    registrationOffer: string;
    /** Actual reveal transaction native fee, excluding transfer output value. */
    nativeFee: string;
    importFee: string;
    /** Native value in the burn transfer output; not a second transaction fee. */
    transferFee: string;
    issuerPayment?: RegistrationPayment & {
        kind: "payment" | "burn";
    };
    referralPayments: RegistrationPayment[];
    /** Reveal requirement before crediting existing commitment/funding input values. */
    totalRequired: Record<string, string>;
    /** Commitment fee plus reveal requirement, before input-value credits. */
    totalOperationRequired: Record<string, string>;
}
/** Current GetTransactionTransferFee() in crosschainrpc.h. */
export declare const REGISTRATION_TRANSFER_FEE = "20000";
export declare const DEFAULT_COMMITMENT_FEE = "10000";
/** Preserve daemon errors; an absent/malformed response is never availability. */
export declare function registrationRpcResult<T>(response: unknown, context: string): T;
export declare function requireRegistrationIdentity(rpc: Pick<RegistrationPolicyRpc, "getIdentity">, id: string, atHeight?: number): Promise<IdentityDefinition>;
export declare function assertIdentityRegistrationAvailable(rpc: Pick<RegistrationPolicyRpc, "getIdentity">, id: string): Promise<void>;
/** Resolve current PBaaS-era native and plain-token namespace policy. */
export declare function resolveIdentityRegistrationPolicy(rpc: RegistrationPolicyRpc, request: RegistrationPolicyRequest): Promise<IdentityRegistrationPolicy>;
/** Amounts remain integer strings across persistence/UI boundaries. */
export declare function quoteIdentityRegistration(policy: IdentityRegistrationPolicy, options?: {
    commitmentFee?: string;
    offer?: string;
}): IdentityRegistrationQuote;
