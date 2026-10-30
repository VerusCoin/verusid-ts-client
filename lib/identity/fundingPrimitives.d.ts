import BigNumber from "bignumber.js";
/** Currency IDs mapped to exact amounts in atomic units. */
type Amounts = Map<string, BigNumber>;
type Output = {
    script: Buffer;
    value: number;
};
declare function requireCondition(condition: unknown, message: string): asserts condition;
/** Parse a canonical nonnegative integer within the daemon's monetary range. */
declare function amount(value: string): BigNumber;
declare function nativeAmount(value: number): BigNumber;
declare function add(totals: Amounts, values: Amounts): void;
declare function sameAmounts(left: Amounts, right: Amounts, message: string): void;
/** Currency IDs require i-addresses; payment destinations may also use R-addresses. */
declare function validAddress(value: string, identityOnly?: boolean): void;
/** Decode an atomic amount record without trusting its currency keys or values. */
declare function amountMap(values: Record<string, string>, message?: string): Amounts;
declare function transaction(hex: string): any;
/** Require the decoded script to serialize back to exactly the supplied bytes. */
declare function parseScript<T extends {
    fromBuffer(bytes: Buffer, offset: number, length: number): unknown;
    toBuffer(): Buffer;
}>(Type: new () => T, bytes: Buffer): T;
/**
 * Decode an ordinary native/reserve output. Special protocol outputs are
 * handled by their callers. An expected recipient restricts payment/change
 * to that single destination, even though funding may use multiple signers.
 */
declare function ordinaryOutput(output: Output, systemID: string, expectedRecipient?: string, allowIndexMaster?: boolean): Amounts;
export { amount, nativeAmount, add, sameAmounts, validAddress, amountMap, transaction, parseScript, ordinaryOutput, requireCondition, };
export type { Amounts, Output };
