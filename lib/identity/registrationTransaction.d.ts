import BN from "bn.js";
import { TxDestination } from "verus-typescript-primitives";
import { RegistrationRpc } from "./registrationRpc";
export type RegistrationAmounts = {
    [currencyID: string]: string;
};
export type RegistrationFundingInput = {
    txid: string;
    vout: number;
    rawTransaction?: string;
};
export type RegistrationPrevout = RegistrationFundingInput & {
    rawTransaction: string;
    scriptHex: string;
    value: string;
    values: RegistrationAmounts;
    confirmations: number;
    height: number;
};
export type RegistrationChainSnapshot = {
    systemID: string;
    rootSystemName: string;
    tipHeight: number;
    tipHash: string;
    candidateHeight: number;
    expiryDelta: number;
    expiryHeight: number;
};
export type RegistrationPlannedOutput = {
    role: "commitment" | "identity" | "issuer-payment" | "burn" | "referral" | "reservation" | "change";
    scriptHex: string;
    value: string;
    values: RegistrationAmounts;
};
export declare function atomic(value: string, label?: string): BN;
export declare function safeNative(value: string): number;
export declare function destination(addressString: string): TxDestination;
export declare function addAmounts(target: RegistrationAmounts, source: RegistrationAmounts): void;
export declare function requireAmounts(actual: RegistrationAmounts, limits: RegistrationAmounts): void;
export declare function parseTransaction(hex: string): any;
/** Ordinary transfers only; special registration outputs are handled explicitly. */
export declare function readFundingOutput(script: Buffer, value: number, systemID: string): RegistrationAmounts;
export declare function paymentOutput(recipient: string, values: RegistrationAmounts, systemID: string, role: RegistrationPlannedOutput["role"]): RegistrationPlannedOutput;
/**
 * Read an already-known group of inputs together. Supplied raw bytes avoid a
 * network read; every output still gets a fresh spendability check. The batch
 * helper bounds network groups, while verification keeps the caller's order.
 */
export declare function readRegistrationPrevouts(rpc: RegistrationRpc, inputs: RegistrationFundingInput[], snapshot: RegistrationChainSnapshot, commitment?: boolean): Promise<RegistrationPrevout[]>;
export declare function readRegistrationPrevout(rpc: RegistrationRpc, input: RegistrationFundingInput, snapshot: RegistrationChainSnapshot, commitment?: boolean): Promise<RegistrationPrevout>;
export declare function assertRegistrationSnapshot(rpc: RegistrationRpc, snapshot: RegistrationChainSnapshot): Promise<void>;
export type FundedRegistration = {
    txHex: string;
    prevouts: RegistrationPrevout[];
    outputPlan: RegistrationPlannedOutput[];
};
/**
 * Verify the ordered funding prefix needed for every required currency.
 * Known amounts select a group locally; an unknown amount ends that group so
 * its raw transaction and spendability can be read together before proceeding.
 * Existing verified inputs let a caller extend coverage after a fee increase.
 */
export declare function selectRegistrationFunding(rpc: RegistrationRpc, snapshot: RegistrationChainSnapshot, funding: RegistrationFundingInput[], needed: RegistrationAmounts, existing?: RegistrationPrevout[]): Promise<RegistrationPrevout[]>;
/** Deterministic approved-input selection; the mandatory commitment is never coin-selected away. */
export declare function fundRegistration(rpc: RegistrationRpc, snapshot: RegistrationChainSnapshot, outputs: RegistrationPlannedOutput[], nativeFee: string, funding: RegistrationFundingInput[], changeAddress: string, mandatory?: RegistrationPrevout): Promise<FundedRegistration>;
/** Check all bytes other than signatures, plus raw prevout amounts and currency conservation. */
export declare function validateRegistrationTransaction(prepared: FundedRegistration & {
    snapshot: RegistrationChainSnapshot;
    nativeFee: string;
}, candidateHex?: string): true;
