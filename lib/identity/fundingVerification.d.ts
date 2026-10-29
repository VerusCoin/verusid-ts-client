import { Output } from "./fundingPrimitives";
export type FundingOutpoint = {
    txid: string;
    vout: number;
};
export type FundingPrevout = FundingOutpoint & {
    rawTransaction: string;
    address?: string;
};
/** Retain these unsigned transaction bytes and source evidence independently. */
export type PreparedFundingTransaction = {
    txHex: string;
    prevouts: FundingPrevout[];
};
/** Common payment intent; each operation supplies its own output and fee rules. */
export type FundingApproval = {
    systemID: string;
    changeAddress: string;
};
/** The raw-prevout bypass is available only to explicitly configured tests. */
export declare function assertUnverifiedPrevoutsAllowed(enabled: boolean): void;
/** Restrict accounting to transparent Sapling-v4 transactions. */
export declare function verifyTransparentTransaction(tx: any): void;
/**
 * Bind a candidate to the retained unsigned baseline. Signature verification
 * and operation-specific lock-time/expiry rules remain the caller's concern.
 */
export declare function verifyFundingTransaction(funded: PreparedFundingTransaction, candidateHex: string): any;
/**
 * Bind each input to its raw source output without using cached balances.
 * trustedPrevouts is a fixture fallback restricted to NODE_ENV=test, never
 * proof that an output exists or remains unspent on the current chain.
 */
export declare function readFundingPrevouts(candidate: any, prevouts: FundingPrevout[], options?: {
    allowCoinbase?: boolean;
    trustedPrevouts?: Array<FundingOutpoint & Output>;
}): Array<FundingPrevout & {
    output: Output;
}>;
