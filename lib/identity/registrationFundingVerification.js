"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyRegistrationFunding = verifyRegistrationFunding;
exports.verifyIdentityRegistrationFunding = verifyIdentityRegistrationFunding;
const bignumber_js_1 = __importDefault(require("bignumber.js"));
const utxo_lib_1 = require("@bitgo/utxo-lib");
const verus_typescript_primitives_1 = require("verus-typescript-primitives");
const registrationPolicy_1 = require("./registrationPolicy");
function requireCondition(condition, message) {
    if (!condition)
        throw new Error(message);
}
// Deliberately separate arithmetic and script decoding from the selector and
// its existing validator. Never use outputPlan.values or prevout.values to
// establish what an input/output actually carries.
function amount(value) {
    requireCondition(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value), "Amounts must be nonnegative atomic integer strings.");
    const result = new bignumber_js_1.default(value);
    requireCondition(result.lte("5000000000000000000"), "Amount exceeds the daemon monetary range.");
    return result;
}
function nativeAmount(value) {
    requireCondition(Number.isSafeInteger(value) && value >= 0 && value <= 2100000000000000, "Unsupported native amount.");
    return amount(String(value));
}
function add(totals, values) {
    for (const [id, value] of values) {
        totals.set(id, amount((totals.get(id) || new bignumber_js_1.default(0)).plus(value).toFixed(0)));
    }
}
function sameAmounts(left, right, message) {
    for (const id of new Set([...left.keys(), ...right.keys()])) {
        requireCondition((left.get(id) || new bignumber_js_1.default(0)).eq(right.get(id) || 0), message);
    }
}
function validAddress(value, identityOnly = false) {
    const decoded = (0, verus_typescript_primitives_1.fromBase58Check)(value);
    requireCondition(decoded.hash.length === 20 &&
        !decoded.hash.equals(Buffer.alloc(20)) &&
        (decoded.version === verus_typescript_primitives_1.I_ADDR_VERSION ||
            (!identityOnly && decoded.version === verus_typescript_primitives_1.R_ADDR_VERSION)), "Unsupported currency or payment address.");
}
function amountMap(values) {
    requireCondition(values && typeof values === "object" && !Array.isArray(values), "Invalid currency amounts.");
    return new Map(Object.entries(values).map(([id, value]) => {
        validAddress(id, true);
        return [id, amount(value)];
    }));
}
function transaction(hex) {
    requireCondition(typeof hex === "string" && /^(?:[0-9a-fA-F]{2})+$/.test(hex), "Invalid transaction bytes.");
    const tx = utxo_lib_1.Transaction.fromHex(hex, utxo_lib_1.networks.verus);
    requireCondition(tx.toHex() === hex.toLowerCase(), "Noncanonical transaction bytes.");
    return tx;
}
function parseScript(Type, bytes) {
    const parsed = new Type();
    parsed.fromBuffer(bytes, 0, bytes.length);
    requireCondition(parsed.toBuffer().equals(bytes), "Noncanonical output script.");
    return parsed;
}
function ordinaryOutput(output, systemID, expectedRecipient) {
    const values = new Map([[systemID, nativeAmount(output.value)]]);
    const bytes = output.script;
    if (bytes.length === 25 &&
        bytes.subarray(0, 3).equals(Buffer.from("76a914", "hex")) &&
        bytes.subarray(23).equals(Buffer.from("88ac", "hex"))) {
        const recipient = (0, verus_typescript_primitives_1.toBase58Check)(bytes.subarray(3, 23), verus_typescript_primitives_1.R_ADDR_VERSION);
        validAddress(recipient);
        if (expectedRecipient)
            requireCondition(recipient === expectedRecipient, "Unexpected payment or change destination.");
        return values;
    }
    requireCondition(bytes.length <= 10000 && bytes[0] > 0 && bytes[0] < 76, "Output is not a spendable daemon smart transaction envelope.");
    const smart = parseScript(verus_typescript_primitives_1.SmartTransactionScript, bytes);
    const master = smart.masterOptCC;
    const condition = smart.paramsOptCC;
    // CScript appends the first (master) push to the parameter object's vData.
    // Match the daemon's strict <6000 contextual limit on the resulting object.
    requireCondition(condition.evalCode.eqn(verus_typescript_primitives_1.EVALS.EVAL_NONE) ||
        condition.toChunk().length + 1 + master.toChunk().length < 6000, "Output exceeds the daemon smart transaction parameter limit.");
    requireCondition(master.version.eqn(3) &&
        master.evalCode.eqn(verus_typescript_primitives_1.EVALS.EVAL_NONE) &&
        !master.vData.length &&
        condition.version.eqn(3) &&
        condition.m.gten(1) &&
        condition.m.lte(condition.n) &&
        condition.n.eqn(condition.destinations.length) &&
        condition.destinations.length <= 25, "Unsupported funding or payment conditions.");
    const emptyMaster = master.m.isZero() && master.n.isZero() && !master.destinations.length;
    const sameMaster = master.m.eq(condition.m) &&
        master.n.eq(condition.n) &&
        master.destinations.length === condition.destinations.length &&
        master.destinations.every((dest, i) => dest.toBuffer().equals(condition.destinations[i].toBuffer()));
    requireCondition(emptyMaster || sameMaster, "Unexpected alternate output authorization.");
    condition.destinations.forEach((dest) => validAddress(dest.toAddress()));
    if (expectedRecipient)
        requireCondition(condition.m.eqn(1) &&
            condition.n.eqn(1) &&
            condition.destinations[0].toAddress() === expectedRecipient, "Unexpected payment or change destination.");
    if (condition.evalCode.eqn(verus_typescript_primitives_1.EVALS.EVAL_NONE)) {
        requireCondition(!condition.vData.length, "Unexpected data in native funding output.");
        return values;
    }
    requireCondition(condition.evalCode.eqn(verus_typescript_primitives_1.EVALS.EVAL_RESERVE_OUTPUT) &&
        condition.vData.length === 1, "Unsupported funding or payment output type.");
    const token = new verus_typescript_primitives_1.TokenOutput();
    const payload = condition.vData[0];
    requireCondition(token.fromBuffer(payload) === payload.length &&
        token.isValid() &&
        token.toBuffer().equals(payload), "Invalid reserve currency encoding.");
    for (const [id, value] of token.reserveValues.valueMap) {
        validAddress(id, true);
        requireCondition(id !== systemID, "Reserve output duplicates native currency.");
        values.set(id, amount(value.toString(10)));
    }
    return values;
}
function commitmentInput(output, systemID) {
    const commitment = parseScript(verus_typescript_primitives_1.IdentityCommitmentScript, output.script);
    requireCondition(!commitment.getCommitment().isAdvanced(), "Token-bearing name commitments are unsupported.");
    // Ordinary commitments may carry native value. Credit the real nValue and
    // return any surplus as change, just as for ordinary funding inputs.
    return new Map([[systemID, nativeAmount(output.value)]]);
}
function metadataOutput(output, role, systemID) {
    requireCondition(output.value === 0, "Registration metadata must not absorb funds.");
    if (role === "commitment")
        return commitmentInput(output, systemID);
    if (role === "identity") {
        const identity = parseScript(verus_typescript_primitives_1.IdentityScript, output.script).getIdentity();
        requireCondition(verus_typescript_primitives_1.IdentityScript.fromIdentity(identity).toBuffer().equals(output.script), "Invalid identity authorization script.");
    }
    else {
        requireCondition(role === "reservation", "Unknown registration output role.");
        parseScript(verus_typescript_primitives_1.IdentityReservationScript, output.script);
    }
    return new Map([[systemID, new bignumber_js_1.default(0)]]);
}
function burnOutput(output, systemID, quote, payment) {
    const smart = parseScript(verus_typescript_primitives_1.SmartTransactionScript, output.script);
    const master = smart.masterOptCC;
    const condition = smart.paramsOptCC;
    const burnAddress = verus_typescript_primitives_1.RESERVE_TRANSFER_DESTINATION.getAddressString();
    for (const params of [master, condition]) {
        requireCondition(params.version.eqn(3) &&
            params.m.eqn(1) &&
            params.n.eqn(1) &&
            params.destinations.length === 1 &&
            params.destinations[0].toAddress() === burnAddress, "Unexpected registration burn authorization.");
    }
    requireCondition(master.evalCode.eqn(verus_typescript_primitives_1.EVALS.EVAL_NONE) &&
        !master.vData.length &&
        condition.evalCode.eqn(verus_typescript_primitives_1.EVALS.EVAL_RESERVE_TRANSFER) &&
        condition.vData.length === 1, "Unsupported registration burn output.");
    const transfer = new verus_typescript_primitives_1.ReserveTransfer();
    const payload = condition.vData[0];
    requireCondition(transfer.fromBuffer(payload) === payload.length &&
        transfer.isValid() &&
        transfer.toBuffer().equals(payload) &&
        transfer.flags.eq(verus_typescript_primitives_1.RESERVE_TRANSFER_VALID.or(verus_typescript_primitives_1.RESERVE_TRANSFER_BURN_CHANGE_PRICE)) &&
        transfer.feeCurrencyID === systemID &&
        transfer.transferDestination.type.eq(verus_typescript_primitives_1.DEST_ID) &&
        !transfer.transferDestination.auxDests.length &&
        transfer.transferDestination.fees.isZero() &&
        transfer.reserveValues.valueMap.size === 1, "Unsupported registration burn transfer.");
    const [currencyID, burned] = [...transfer.reserveValues.valueMap][0];
    validAddress(currencyID, true);
    requireCondition(currencyID !== systemID &&
        transfer.destCurrencyID === currencyID &&
        transfer.transferDestination.getAddressString() === currencyID &&
        nativeAmount(output.value).eq(amount(transfer.feeAmount.toString(10))), "Incorrect burn currency or transfer fee.");
    if (quote && payment) {
        requireCondition(payment.currencyID === currencyID &&
            payment.recipient === currencyID &&
            nativeAmount(output.value).eq(amount(quote.transferFee)) &&
            amount(burned.toString(10)).eq(amount(payment.amount)), "Burn differs from the approved registration payment.");
    }
    return new Map([
        [systemID, nativeAmount(output.value)],
        [currencyID, amount(burned.toString(10))],
    ]);
}
function verify(funded, approval, descriptions, candidateHex, quote, expectedCosts) {
    var _a, _b, _c;
    const systemID = approval.snapshot.systemID;
    validAddress(systemID, true);
    validAddress(approval.changeAddress);
    const approved = transaction(funded.txHex);
    const candidate = transaction(candidateHex);
    requireCondition(candidate.version === 4 &&
        candidate.overwintered === 1 &&
        candidate.versionGroupId === 0x892f2085 &&
        candidate.locktime === 0 &&
        candidate.expiryHeight === approval.snapshot.expiryHeight &&
        !candidate.isCoinbase() &&
        !((_a = candidate.joinsplits) === null || _a === void 0 ? void 0 : _a.length) &&
        !((_b = candidate.vShieldedSpend) === null || _b === void 0 ? void 0 : _b.length) &&
        !((_c = candidate.vShieldedOutput) === null || _c === void 0 ? void 0 : _c.length) &&
        (!candidate.valueBalance ||
            candidate.valueBalance.equals(Buffer.alloc(8))), "Unsupported registration transaction.");
    requireCondition(approved.ins.every((input) => !input.script.length), "Approval transaction is already signed.");
    const stripped = candidate.clone();
    stripped.ins.forEach((input) => {
        input.script = Buffer.alloc(0);
    });
    requireCondition(stripped.toHex() === approved.toHex(), "Transaction changed after approval.");
    requireCondition(candidate.ins.length > 0 && candidate.ins.length === funded.prevouts.length, "Missing or unexpected funding input.");
    const incoming = new Map();
    const seen = new Set();
    const sources = new Map();
    let commitmentCount = 0;
    candidate.ins.forEach((input, index) => {
        const txid = Buffer.from(input.hash).reverse().toString("hex");
        const key = `${txid}:${input.index}`;
        const prevout = funded.prevouts[index];
        requireCondition(!seen.has(key) &&
            input.sequence === 0xffffffff &&
            prevout.txid === txid &&
            prevout.vout === input.index, "Duplicate or unexpected funding outpoint.");
        seen.add(key);
        let source = sources.get(txid);
        if (!source) {
            const tx = transaction(prevout.rawTransaction);
            requireCondition(tx.getId() === txid && !tx.isCoinbase(), "Invalid funding source transaction.");
            source = { tx, hex: prevout.rawTransaction };
            sources.set(txid, source);
        }
        else
            requireCondition(source.hex === prevout.rawTransaction, "Inconsistent funding source transaction.");
        const output = source.tx.outs[input.index];
        requireCondition(!!output, "Funding output does not exist.");
        if (approval.commitment &&
            txid === approval.commitment.txid &&
            input.index === approval.commitment.vout) {
            commitmentCount++;
            add(incoming, commitmentInput(output, systemID));
        }
        else
            add(incoming, ordinaryOutput(output, systemID));
    });
    requireCondition(!approval.commitment || commitmentCount === 1, "Registration must spend its approved name commitment.");
    requireCondition(candidate.outs.length === descriptions.length ||
        candidate.outs.length === descriptions.length + 1, "Unexpected registration outputs.");
    const expectedFee = amount(approval.nativeFee);
    const outgoing = new Map();
    const spending = new Map([[systemID, expectedFee]]);
    candidate.outs.forEach((output, index) => {
        const description = descriptions[index];
        let values;
        if (!description)
            values = ordinaryOutput(output, systemID, approval.changeAddress);
        else {
            if (description.approved) {
                requireCondition(output.script.toString("hex") ===
                    description.approved.scriptHex.toLowerCase() &&
                    nativeAmount(output.value).eq(amount(description.approved.value)), "Output differs from the approved payment.");
            }
            if (description.role === "issuer-payment" ||
                description.role === "referral") {
                const payment = description.payment;
                values = ordinaryOutput(output, systemID, payment === null || payment === void 0 ? void 0 : payment.recipient);
                if (payment)
                    sameAmounts(values, amountMap({ [payment.currencyID]: payment.amount }), "Payment differs from the approved amount or currency.");
            }
            else if (description.role === "burn") {
                values = burnOutput(output, systemID, quote, description.payment);
            }
            else
                values = metadataOutput(output, description.role, systemID);
            add(spending, values);
        }
        add(outgoing, values);
    });
    if (expectedCosts)
        sameAmounts(spending, expectedCosts, "Actual spending differs from the approved registration costs.");
    // Exact equality rejects excess native fees and implicit reserve burns,
    // including currencies unrelated to the registration quote.
    add(outgoing, new Map([[systemID, expectedFee]]));
    sameAmounts(incoming, outgoing, "Input funds do not exactly cover the approved payments, change, and fee.");
    return true;
}
function guard(verifyFunding) {
    try {
        return verifyFunding();
    }
    catch (error) {
        throw new registrationPolicy_1.RegistrationError("REGISTRATION_FUNDING_MISMATCH", "Registration funding verification failed. " +
            (error instanceof Error ? error.message : String(error)));
    }
}
/** Independent byte-level conservation check, also run automatically by fundRegistration. */
function verifyRegistrationFunding(funded, approval, candidateHex = funded.txHex) {
    return guard(() => verify(funded, approval, approval.outputs.map((output) => ({
        role: output.role,
        approved: output,
    })), candidateHex));
}
/**
 * Check all currencies, exact quoted fees/payments, and approved change directly
 * from transaction bytes and hash-verified source transactions. The prepared
 * approval must be retained independently from externally supplied candidates.
 * expectedChangeAddress can bind deserialized plans to an external approval.
 * This performs no RPC calls and must not be cached before broadcasting.
 */
function verifyIdentityRegistrationFunding(prepared, candidateHex = prepared.txHex, expectedChangeAddress = prepared.changeAddress) {
    return guard(() => {
        const quote = prepared.quote;
        const systemID = prepared.snapshot.systemID;
        requireCondition(quote &&
            quote.systemID === systemID &&
            quote.issuerID &&
            prepared.changeAddress === expectedChangeAddress &&
            (prepared.stage === "commitment" || prepared.stage === "registration"), "Registration funding context changed.");
        [
            quote.commitmentFee,
            quote.registrationOffer,
            quote.nativeFee,
            quote.importFee,
            quote.transferFee,
        ].forEach(amount);
        const revealCosts = amountMap(quote.totalRequired);
        const operationCosts = amountMap(quote.totalOperationRequired);
        const combined = new Map(revealCosts);
        add(combined, new Map([[systemID, amount(quote.commitmentFee)]]));
        sameAmounts(combined, operationCosts, "Inconsistent two-stage registration costs.");
        const commitment = prepared.stage === "commitment";
        requireCondition(commitment ? !prepared.commitment : !!prepared.commitment, "Registration requires an independently approved commitment outpoint.");
        const expectedFee = commitment ? quote.commitmentFee : quote.nativeFee;
        requireCondition(amount(prepared.nativeFee).eq(amount(expectedFee)), "Transaction fee differs from the approved quote.");
        const expectedCosts = commitment
            ? amountMap({ [systemID]: quote.commitmentFee })
            : revealCosts;
        const approvedCosts = amountMap(prepared.approvedCosts);
        for (const [id, value] of commitment ? operationCosts : revealCosts) {
            requireCondition(value.lte(approvedCosts.get(id) || 0), "Registration exceeds approved costs.");
        }
        const descriptions = commitment
            ? [{ role: "commitment" }]
            : [
                { role: "identity" },
                ...(quote.issuerPayment
                    ? [
                        {
                            role: quote.issuerPayment.kind === "burn"
                                ? "burn"
                                : "issuer-payment",
                            payment: quote.issuerPayment,
                        },
                    ]
                    : []),
                ...quote.referralPayments.map((payment) => ({
                    role: "referral",
                    payment,
                })),
                { role: "reservation" },
            ];
        return verify(prepared, {
            snapshot: prepared.snapshot,
            nativeFee: expectedFee,
            changeAddress: expectedChangeAddress,
            commitment: prepared.commitment,
        }, descriptions, candidateHex, quote, expectedCosts);
    });
}
