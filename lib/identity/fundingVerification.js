"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertUnverifiedPrevoutsAllowed = assertUnverifiedPrevoutsAllowed;
exports.verifyTransparentTransaction = verifyTransparentTransaction;
exports.verifyFundingTransaction = verifyFundingTransaction;
exports.readFundingPrevouts = readFundingPrevouts;
const fundingPrimitives_1 = require("./fundingPrimitives");
/** The raw-prevout bypass is available only to explicitly configured tests. */
function assertUnverifiedPrevoutsAllowed(enabled) {
    var _a;
    if (!enabled)
        return;
    (0, fundingPrimitives_1.requireCondition)(typeof process !== "undefined" && ((_a = process.env) === null || _a === void 0 ? void 0 : _a.NODE_ENV) === "test", "Unverified prevouts are only allowed when NODE_ENV is test.");
}
/** Restrict accounting to transparent Sapling-v4 transactions. */
function verifyTransparentTransaction(tx) {
    var _a, _b, _c;
    (0, fundingPrimitives_1.requireCondition)(tx &&
        tx.version === 4 &&
        tx.overwintered === 1 &&
        tx.versionGroupId === 0x892f2085 &&
        !tx.isCoinbase() &&
        !((_a = tx.joinsplits) === null || _a === void 0 ? void 0 : _a.length) &&
        !((_b = tx.vShieldedSpend) === null || _b === void 0 ? void 0 : _b.length) &&
        !((_c = tx.vShieldedOutput) === null || _c === void 0 ? void 0 : _c.length) &&
        (!tx.valueBalance || tx.valueBalance.equals(Buffer.alloc(8))), "Unsupported funding transaction components.");
}
/**
 * Bind a candidate to the retained unsigned baseline. Signature verification
 * and operation-specific lock-time/expiry rules remain the caller's concern.
 */
function verifyFundingTransaction(funded, candidateHex) {
    const approved = (0, fundingPrimitives_1.transaction)(funded.txHex);
    const candidate = (0, fundingPrimitives_1.transaction)(candidateHex);
    verifyTransparentTransaction(approved);
    verifyTransparentTransaction(candidate);
    (0, fundingPrimitives_1.requireCondition)(approved.ins.every((input) => !input.script.length), "Funding approval transaction must be unsigned.");
    const stripped = candidate.clone();
    stripped.ins.forEach((input) => {
        input.script = Buffer.alloc(0);
    });
    (0, fundingPrimitives_1.requireCondition)(stripped.toHex() === approved.toHex(), "Funding transaction changed after approval.");
    return candidate;
}
/**
 * Bind each input to its raw source output without using cached balances.
 * trustedPrevouts is a fixture fallback restricted to NODE_ENV=test, never
 * proof that an output exists or remains unspent on the current chain.
 */
function readFundingPrevouts(candidate, prevouts, options = {}) {
    assertUnverifiedPrevoutsAllowed(options.trustedPrevouts !== undefined);
    (0, fundingPrimitives_1.requireCondition)(Array.isArray(candidate === null || candidate === void 0 ? void 0 : candidate.ins) &&
        candidate.ins.length > 0 &&
        Array.isArray(prevouts) &&
        candidate.ins.length === prevouts.length, "Missing or unexpected funding input.");
    const seen = new Set();
    const sources = new Map();
    return candidate.ins.map((input, index) => {
        var _a;
        const txid = Buffer.from(input.hash).reverse().toString("hex");
        const key = `${txid}:${input.index}`;
        const prevout = prevouts[index];
        (0, fundingPrimitives_1.requireCondition)(prevout &&
            !seen.has(key) &&
            input.sequence === 0xffffffff &&
            prevout.txid === txid &&
            prevout.vout === input.index, "Duplicate or unexpected funding outpoint.");
        seen.add(key);
        let output;
        if (prevout.rawTransaction) {
            let source = sources.get(txid);
            if (!source) {
                const tx = (0, fundingPrimitives_1.transaction)(prevout.rawTransaction);
                (0, fundingPrimitives_1.requireCondition)(tx.getId() === txid, "Funding source transaction hash or index does not match.");
                (0, fundingPrimitives_1.requireCondition)(options.allowCoinbase === true || !tx.isCoinbase(), "Coinbase funding source transaction is unsupported.");
                source = { tx, hex: prevout.rawTransaction };
                sources.set(txid, source);
            }
            else {
                (0, fundingPrimitives_1.requireCondition)(source.hex === prevout.rawTransaction, "Inconsistent funding source transaction.");
            }
            (0, fundingPrimitives_1.requireCondition)(source.tx.outs[input.index], "Funding source transaction hash or index does not match.");
            output = source.tx.outs[input.index];
        }
        else {
            const trusted = (_a = options.trustedPrevouts) === null || _a === void 0 ? void 0 : _a[index];
            (0, fundingPrimitives_1.requireCondition)(trusted && trusted.txid === txid && trusted.vout === input.index, "Missing raw funding source transaction.");
            output = { script: trusted.script, value: trusted.value };
        }
        return Object.assign(Object.assign({}, prevout), { output });
    });
}
