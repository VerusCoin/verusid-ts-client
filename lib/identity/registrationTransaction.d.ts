import BN from "bn.js";
import { TxDestination } from "verus-typescript-primitives";
import { VerusdRpcInterface } from "verusd-rpc-ts-client";
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
export declare function readRegistrationPrevout(rpc: VerusdRpcInterface, input: RegistrationFundingInput, snapshot: RegistrationChainSnapshot, commitment?: boolean): Promise<RegistrationPrevout>;
export declare function assertRegistrationSnapshot(rpc: VerusdRpcInterface, snapshot: RegistrationChainSnapshot): Promise<void>;
export type FundedRegistration = {
    txHex: string;
    prevouts: RegistrationPrevout[];
    outputPlan: RegistrationPlannedOutput[];
};
/** Deterministic approved-input selection; the mandatory zero-value commitment is never coin-selected away. */
export declare function fundRegistration(rpc: VerusdRpcInterface, snapshot: RegistrationChainSnapshot, outputs: RegistrationPlannedOutput[], nativeFee: string, funding: RegistrationFundingInput[], changeAddress: string, mandatory?: RegistrationPrevout): Promise<FundedRegistration>;
/** Check all bytes other than signatures, plus raw prevout amounts and currency conservation. */
export declare function validateRegistrationTransaction(prepared: FundedRegistration & {
    snapshot: RegistrationChainSnapshot;
    nativeFee: string;
}, candidateHex?: string): true;
