import { Amounts, Output } from "./fundingPrimitives";
export interface IdentityUpdateSigningInput {
    txid: string;
    outputIndex: number;
    script: string;
    satoshis: number;
    address?: string;
    rawTransaction?: string;
}
/** Construction request; the verified source transactions are supplied separately. */
export interface IdentityUpdateFundingRequest {
    txHex: string;
    unfundedTxHex: string;
    systemId: string;
    changeAddress: string;
    /** Total native fees, including fees embedded in explicit transfers. */
    nativeFee: string;
    fees: {
        [currency: string]: string;
    };
    explicitFees: {
        [currency: string]: string;
    };
    maxFee: string;
    identity: {
        txid: string;
        outputIndex: number;
        identityAddress: string;
    };
}
/**
 * Public receipt retained independently from externally supplied bytes.
 * Its existing field names are preserved for stored approvals and SDK callers.
 * All fee amounts are decimal strings in atomic units.
 */
export interface IdentityUpdateFundingApproval extends IdentityUpdateFundingRequest {
    prevouts: Array<{
        txid: string;
        outputIndex: number;
        rawTransaction: string;
        address?: string;
    }>;
}
/**
 * Convert a public coin-denominated cap to atomic units without accepting NaN,
 * infinity, fractions of a satoshi, or unsupported amounts.
 */
export declare function identityUpdateFeeCap(value: number): string;
/**
 * A bounded default allowance, not a fee quote. Explicit caller caps override it.
 *
 * Ten ordinary fees minimum; larger definitions scale by their daemon fee
 * factors, extra planned outputs and large scripts. Explicit native transfer
 * fees are additional approved costs. Change is still verified independently.
 */
export declare function defaultIdentityUpdateFeeCap(unfundedTxHex: string, explicitNativeFee?: string): number;
export declare function verifyIdentityDefinitionOutput(output: Output, expectedAddress: string, requireCanonicalAuthorization?: boolean): Amounts;
/**
 * Verify local economic intent and currency conservation against retained
 * approval. This does not check signatures or current chain/UTXO state.
 */
export declare function verifyIdentityUpdateFunding(approval: IdentityUpdateFundingApproval, candidateHex?: string, signingInputs?: IdentityUpdateSigningInput[]): true;
/**
 * Internal construction boundary: verify before freezing the approval.
 * The NODE_ENV=test fixture opt-out never produces a portable approval.
 */
export declare function createIdentityUpdateFundingApproval(request: IdentityUpdateFundingRequest, inputs: IdentityUpdateSigningInput[], allowUnverifiedPrevouts: boolean): IdentityUpdateFundingApproval | undefined;
