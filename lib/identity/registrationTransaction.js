"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.atomic = atomic;
exports.safeNative = safeNative;
exports.destination = destination;
exports.addAmounts = addAmounts;
exports.requireAmounts = requireAmounts;
exports.parseTransaction = parseTransaction;
exports.readFundingOutput = readFundingOutput;
exports.paymentOutput = paymentOutput;
exports.readRegistrationPrevout = readRegistrationPrevout;
exports.assertRegistrationSnapshot = assertRegistrationSnapshot;
exports.fundRegistration = fundRegistration;
exports.validateRegistrationTransaction = validateRegistrationTransaction;
const bn_js_1 = __importDefault(require("bn.js"));
const utxo_lib_1 = require("@bitgo/utxo-lib");
const verus_typescript_primitives_1 = require("verus-typescript-primitives");
const registrationPolicy_1 = require("./registrationPolicy");
const verus_typescript_primitives_2 = require("verus-typescript-primitives");
const MAX_INT64 = new bn_js_1.default("9223372036854775807");
const MAX_SAFE = new bn_js_1.default(Number.MAX_SAFE_INTEGER);
// BitGo's output and signature-digest type guards impose this narrower bound.
const MAX_NATIVE = new bn_js_1.default("2100000000000000");
function atomic(value, label = "Amount") {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new registrationPolicy_1.RegistrationError("INVALID_AMOUNT", label + " must be a nonnegative atomic integer string.");
    }
    const result = new bn_js_1.default(value, 10);
    if (result.gt(MAX_INT64))
        throw new registrationPolicy_1.RegistrationError("INVALID_AMOUNT", label + " exceeds the signed 64-bit range.");
    return result;
}
function safeNative(value) {
    const amount = atomic(value);
    if (amount.gt(MAX_SAFE))
        throw new registrationPolicy_1.RegistrationError("UNSUPPORTED_AMOUNT", "Native values exceed the transaction library safe integer range.");
    if (amount.gt(MAX_NATIVE))
        throw new registrationPolicy_1.RegistrationError("UNSUPPORTED_AMOUNT", "Native values exceed the transaction library monetary limit.");
    return amount.toNumber();
}
function destination(addressString) {
    const decoded = (0, verus_typescript_primitives_1.fromBase58Check)(addressString);
    if (decoded.hash.length !== 20 || decoded.hash.equals(Buffer.alloc(20))) {
        throw new registrationPolicy_1.RegistrationError("INVALID_DESTINATION", "A nonzero key-hash or identity address is required.");
    }
    if (decoded.version === verus_typescript_primitives_1.I_ADDR_VERSION)
        return new verus_typescript_primitives_1.TxDestination(new verus_typescript_primitives_1.IdentityID(decoded.hash));
    if (decoded.version === verus_typescript_primitives_1.R_ADDR_VERSION)
        return new verus_typescript_primitives_1.TxDestination(new verus_typescript_primitives_1.KeyID(decoded.hash));
    throw new registrationPolicy_1.RegistrationError("UNSUPPORTED_DESTINATION", "Only key-hash and identity destinations are supported.");
}
function addAmounts(target, source) {
    Object.keys(source).forEach((id) => {
        target[id] = atomic(target[id] || "0")
            .add(atomic(source[id]))
            .toString(10);
    });
}
function requireAmounts(actual, limits) {
    Object.keys(actual).forEach((id) => {
        if (atomic(actual[id]).gt(atomic(limits[id] || "0"))) {
            throw new registrationPolicy_1.RegistrationError("COST_LIMIT_EXCEEDED", "Registration exceeds the approved atomic cost for " + id + ".");
        }
    });
}
function parseTransaction(hex) {
    if (typeof hex !== "string" || !/^(?:[0-9a-fA-F]{2})+$/.test(hex)) {
        throw new registrationPolicy_1.RegistrationError("INVALID_TRANSACTION", "Expected complete transaction hex.");
    }
    const tx = utxo_lib_1.Transaction.fromHex(hex, utxo_lib_1.networks.verus);
    if (tx.toHex() !== hex.toLowerCase())
        throw new registrationPolicy_1.RegistrationError("INVALID_TRANSACTION", "Noncanonical transaction encoding.");
    return tx;
}
function params(evalCode, destinations, data = []) {
    return new verus_typescript_primitives_1.OptCCParams({
        version: new bn_js_1.default(3),
        evalCode: new bn_js_1.default(evalCode),
        m: new bn_js_1.default(destinations.length ? 1 : 0),
        n: new bn_js_1.default(destinations.length),
        destinations,
        vData: data,
    });
}
/** Ordinary transfers only; special registration outputs are handled explicitly. */
function readFundingOutput(script, value, systemID) {
    if (!Number.isSafeInteger(value) || value < 0)
        throw new registrationPolicy_1.RegistrationError("UNSUPPORTED_AMOUNT", "Invalid native prevout value.");
    safeNative(String(value));
    const result = { [systemID]: String(value) };
    if (script.length === 25 &&
        script.subarray(0, 3).equals(Buffer.from("76a914", "hex")) &&
        script.subarray(23).equals(Buffer.from("88ac", "hex")))
        return result;
    const smart = new verus_typescript_primitives_1.SmartTransactionScript();
    smart.fromBuffer(script, 0, script.length);
    if (!smart.toBuffer().equals(script))
        throw new registrationPolicy_1.RegistrationError("INVALID_PREVOUT", "Noncanonical smart funding script.");
    const master = smart.masterOptCC;
    const condition = smart.paramsOptCC;
    if (!master.version.eqn(3) ||
        !master.evalCode.eqn(verus_typescript_primitives_1.EVALS.EVAL_NONE) ||
        master.vData.length ||
        !condition.version.eqn(3) ||
        condition.m.ltn(1) ||
        condition.m.gt(condition.n) ||
        !condition.n.eqn(condition.destinations.length) ||
        condition.destinations.length > 25 ||
        !((master.m.isZero() && master.n.isZero() && !master.destinations.length) ||
            (master.m.eq(condition.m) &&
                master.n.eq(condition.n) &&
                master.destinations.length === condition.destinations.length &&
                master.destinations.every((dest, i) => dest.toBuffer().equals(condition.destinations[i].toBuffer()))))) {
        throw new registrationPolicy_1.RegistrationError("UNSUPPORTED_FUNDING", "Unsupported funding authorization conditions.");
    }
    condition.destinations.forEach((dest) => destination(dest.toAddress()));
    if (condition.evalCode.eqn(verus_typescript_primitives_1.EVALS.EVAL_NONE) && condition.vData.length === 0)
        return result;
    if (!condition.evalCode.eqn(verus_typescript_primitives_1.EVALS.EVAL_RESERVE_OUTPUT) ||
        condition.vData.length !== 1) {
        throw new registrationPolicy_1.RegistrationError("UNSUPPORTED_FUNDING", "Funding must be a key-hash, transparent identity, or ordinary reserve output.");
    }
    const token = new verus_typescript_primitives_1.TokenOutput();
    const payload = condition.vData[0];
    if (token.fromBuffer(payload) !== payload.length ||
        !token.isValid() ||
        !token.toBuffer().equals(payload)) {
        throw new registrationPolicy_1.RegistrationError("INVALID_PREVOUT", "Invalid reserve output.");
    }
    token.reserveValues.valueMap.forEach((amount, currency) => {
        if (currency === systemID)
            throw new registrationPolicy_1.RegistrationError("INVALID_PREVOUT", "Reserve output duplicates native value.");
        const currencyDestination = destination(currency);
        if (!currencyDestination.type.eq(verus_typescript_primitives_1.TxDestination.TYPE_ID))
            throw new registrationPolicy_1.RegistrationError("INVALID_PREVOUT", "Invalid reserve currency.");
        result[currency] = atomic(amount.toString(10)).toString(10);
    });
    return result;
}
function paymentOutput(recipient, values, systemID, role) {
    const dest = destination(recipient);
    const value = values[systemID] || "0";
    safeNative(value);
    const reserves = new Map();
    // Issuer/referral payments retain their reserve denomination even at zero:
    // registration consensus identifies these outputs by EVAL_RESERVE_OUTPUT.
    const retainZeroReserves = role === "issuer-payment" || role === "referral";
    Object.keys(values)
        .filter((id) => id !== systemID && (retainZeroReserves || !atomic(values[id]).isZero()))
        .forEach((id) => {
        if (!destination(id).type.eq(verus_typescript_primitives_1.TxDestination.TYPE_ID))
            throw new registrationPolicy_1.RegistrationError("INVALID_CURRENCY", "Invalid reserve currency ID.");
        reserves.set(id, atomic(values[id]));
    });
    let script;
    if (!reserves.size && dest.type.eq(verus_typescript_primitives_1.TxDestination.TYPE_PKH)) {
        script = utxo_lib_1.address.toOutputScript(recipient, utxo_lib_1.networks.verus);
    }
    else {
        const token = new verus_typescript_primitives_1.TokenOutput({
            version: new bn_js_1.default(1),
            values: new verus_typescript_primitives_1.CurrencyValueMap({
                valueMap: reserves,
                multivalue: reserves.size !== 1,
            }),
        });
        script = new verus_typescript_primitives_1.SmartTransactionScript(params(verus_typescript_primitives_1.EVALS.EVAL_NONE, reserves.size ? [dest] : []), params(reserves.size ? verus_typescript_primitives_1.EVALS.EVAL_RESERVE_OUTPUT : verus_typescript_primitives_1.EVALS.EVAL_NONE, [dest], reserves.size ? [token.toBuffer()] : [])).toBuffer();
    }
    return {
        role,
        scriptHex: script.toString("hex"),
        value,
        values: Object.assign(Object.assign({}, values), { [systemID]: value }),
    };
}
function readRegistrationPrevout(rpc_1, input_1, snapshot_1) {
    return __awaiter(this, arguments, void 0, function* (rpc, input, snapshot, commitment = false) {
        var _a;
        if (!/^[0-9a-f]{64}$/.test(input.txid) ||
            !Number.isInteger(input.vout) ||
            input.vout < 0 ||
            input.vout > 0xffffffff) {
            throw new registrationPolicy_1.RegistrationError("INVALID_OUTPOINT", "Invalid registration outpoint.");
        }
        let raw = input.rawTransaction;
        if (raw == null) {
            const response = yield rpc.getRawTransaction(input.txid, 0);
            if (response.error)
                throw new registrationPolicy_1.RegistrationError("RPC_ERROR", "Cannot read previous transaction: " + response.error.message);
            raw =
                typeof response.result === "string"
                    ? response.result
                    : (_a = response.result) === null || _a === void 0 ? void 0 : _a.hex;
        }
        const tx = parseTransaction(raw);
        if (tx.getId() !== input.txid)
            throw new registrationPolicy_1.RegistrationError("PREVOUT_MISMATCH", "Previous transaction hash does not match the requested outpoint.");
        const output = tx.outs[input.vout];
        if (!output)
            throw new registrationPolicy_1.RegistrationError("INVALID_OUTPOINT", "Previous output index does not exist.");
        let values;
        if (commitment) {
            const script = new verus_typescript_primitives_1.IdentityCommitmentScript();
            script.fromBuffer(output.script, 0, output.script.length);
            if (script.getCommitment().isAdvanced())
                throw new registrationPolicy_1.RegistrationError("UNSUPPORTED_COMMITMENT", "Token-bearing commitments cannot register a name.");
            safeNative(String(output.value));
            values = { [snapshot.systemID]: String(output.value) };
        }
        else
            values = readFundingOutput(output.script, output.value, snapshot.systemID);
        const response = yield rpc.getTxOut(input.txid, input.vout, true);
        if (response.error)
            throw new registrationPolicy_1.RegistrationError("RPC_ERROR", "Cannot check previous output: " + response.error.message);
        const unspent = response.result;
        if (!unspent)
            throw new registrationPolicy_1.RegistrationError(commitment ? "COMMITMENT_SPENT" : "FUNDING_SPENT", "Previous output is unavailable or spent.");
        if (unspent.bestblock !== snapshot.tipHash)
            throw new registrationPolicy_1.RegistrationError("STALE_CHAIN_CONTEXT", "Chain tip changed while checking previous outputs.");
        if (unspent.scriptPubKey.hex !== output.script.toString("hex") ||
            !(0, verus_typescript_primitives_1.currencyAmountToAtomic)(unspent.value).eq(new bn_js_1.default(output.value))) {
            throw new registrationPolicy_1.RegistrationError("PREVOUT_MISMATCH", "Unspent output does not match its raw transaction.");
        }
        if (typeof unspent.coinbase !== "boolean" ||
            unspent.coinbase !== tx.isCoinbase()) {
            throw new registrationPolicy_1.RegistrationError("PREVOUT_MISMATCH", "Coinbase status does not match the previous transaction.");
        }
        if (!Number.isInteger(unspent.confirmations) ||
            unspent.confirmations < 0 ||
            unspent.confirmations > snapshot.candidateHeight) {
            throw new registrationPolicy_1.RegistrationError("INVALID_CONFIRMATION", "Invalid unspent output confirmation count.");
        }
        if (unspent.coinbase ||
            (unspent.interest != null && unspent.interest !== 0)) {
            throw new registrationPolicy_1.RegistrationError("UNSUPPORTED_FUNDING", "Coinbase and interest-bearing funding require a separate maturity/value policy.");
        }
        if (commitment && unspent.confirmations < 1)
            throw new registrationPolicy_1.RegistrationError("COMMITMENT_UNCONFIRMED", "Commitment must be confirmed in the active chain before registration.");
        return {
            txid: input.txid,
            vout: input.vout,
            rawTransaction: raw,
            scriptHex: output.script.toString("hex"),
            value: String(output.value),
            values,
            confirmations: unspent.confirmations,
            height: unspent.confirmations
                ? snapshot.candidateHeight - unspent.confirmations
                : 0,
        };
    });
}
function assertRegistrationSnapshot(rpc, snapshot) {
    return __awaiter(this, void 0, void 0, function* () {
        const info = yield rpc.getInfo();
        if (info.error)
            throw new registrationPolicy_1.RegistrationError("RPC_ERROR", info.error.message);
        const block = yield rpc.getBlock(String(snapshot.tipHeight), 1);
        if (block.error)
            throw new registrationPolicy_1.RegistrationError("RPC_ERROR", block.error.message);
        const result = block.result;
        if (info.result.blocks !== snapshot.tipHeight ||
            result.hash !== snapshot.tipHash ||
            result.height !== snapshot.tipHeight ||
            result.confirmations !== 1) {
            throw new registrationPolicy_1.RegistrationError("STALE_CHAIN_CONTEXT", "Chain context changed; resolve and review the registration again.");
        }
    });
}
/** Deterministic approved-input selection; the mandatory zero-value commitment is never coin-selected away. */
function fundRegistration(rpc, snapshot, outputs, nativeFee, funding, changeAddress, mandatory) {
    return __awaiter(this, void 0, void 0, function* () {
        destination(changeAddress);
        const needed = {
            [snapshot.systemID]: atomic(nativeFee).toString(10),
        };
        outputs.forEach((output) => addAmounts(needed, output.values));
        const total = {};
        const selected = [];
        const seen = new Set();
        if (mandatory) {
            selected.push(mandatory);
            addAmounts(total, mandatory.values);
            seen.add(mandatory.txid + ":" + mandatory.vout);
        }
        for (const item of funding) {
            const key = item.txid + ":" + item.vout;
            if (seen.has(key))
                throw new registrationPolicy_1.RegistrationError("DUPLICATE_INPUT", "Duplicate funding or commitment outpoint.");
            seen.add(key);
        }
        const sufficient = () => Object.keys(needed).every((id) => atomic(total[id] || "0").gte(atomic(needed[id])));
        for (const item of funding) {
            if (sufficient())
                break;
            const verified = yield readRegistrationPrevout(rpc, item, snapshot);
            selected.push(verified);
            addAmounts(total, verified.values);
        }
        if (!sufficient() || !selected.length)
            throw new registrationPolicy_1.RegistrationError("INSUFFICIENT_FUNDS", "Approved funding does not cover registration costs in every currency.");
        const change = {};
        Object.keys(total).forEach((id) => {
            const amount = atomic(total[id]).sub(atomic(needed[id] || "0"));
            if (!amount.isZero())
                change[id] = amount.toString(10);
        });
        const outputPlan = outputs.slice();
        if (Object.keys(change).length)
            outputPlan.push(paymentOutput(changeAddress, change, snapshot.systemID, "change"));
        const builder = new utxo_lib_1.TransactionBuilder(utxo_lib_1.networks.verus);
        builder.setVersion(4);
        builder.setVersionGroupId(0x892f2085);
        builder.setExpiryHeight(snapshot.expiryHeight);
        selected.forEach((input) => builder.addInput(Buffer.from(input.txid, "hex").reverse(), input.vout, 0xffffffff));
        outputPlan.forEach((output) => builder.addOutput(Buffer.from(output.scriptHex, "hex"), safeNative(output.value)));
        return {
            txHex: builder.buildIncomplete().toHex(),
            prevouts: selected,
            outputPlan,
        };
    });
}
/** Check all bytes other than signatures, plus raw prevout amounts and currency conservation. */
function validateRegistrationTransaction(prepared, candidateHex = prepared.txHex) {
    var _a, _b, _c;
    const approved = parseTransaction(prepared.txHex);
    const candidate = parseTransaction(candidateHex);
    if (approved.ins.some((input) => input.script.length))
        throw new registrationPolicy_1.RegistrationError("INVALID_PLAN", "The approved transaction must be unsigned.");
    const stripped = candidate.clone();
    stripped.ins.forEach((input) => {
        input.script = Buffer.alloc(0);
    });
    if (stripped.toHex() !== approved.toHex())
        throw new registrationPolicy_1.RegistrationError("TRANSACTION_CHANGED", "Transaction differs from the approved registration plan.");
    if (candidate.version !== 4 ||
        candidate.versionGroupId !== 0x892f2085 ||
        candidate.expiryHeight !== prepared.snapshot.expiryHeight ||
        candidate.locktime !== 0 ||
        ((_a = candidate.joinsplits) === null || _a === void 0 ? void 0 : _a.length) ||
        ((_b = candidate.vShieldedSpend) === null || _b === void 0 ? void 0 : _b.length) ||
        ((_c = candidate.vShieldedOutput) === null || _c === void 0 ? void 0 : _c.length)) {
        throw new registrationPolicy_1.RegistrationError("INVALID_TRANSACTION", "Unsupported registration transaction context.");
    }
    if (candidate.ins.length !== prepared.prevouts.length ||
        candidate.outs.length !== prepared.outputPlan.length)
        throw new registrationPolicy_1.RegistrationError("INVALID_PLAN", "Input or output plan length mismatch.");
    const incoming = {};
    const outgoing = {
        [prepared.snapshot.systemID]: atomic(prepared.nativeFee).toString(10),
    };
    const seen = new Set();
    prepared.prevouts.forEach((prevout, i) => {
        const input = candidate.ins[i];
        const key = prevout.txid + ":" + prevout.vout;
        if (seen.has(key) ||
            Buffer.from(input.hash).reverse().toString("hex") !== prevout.txid ||
            input.index !== prevout.vout ||
            input.sequence !== 0xffffffff)
            throw new registrationPolicy_1.RegistrationError("PREVOUT_MISMATCH", "Transaction inputs do not match the approved outpoints.");
        seen.add(key);
        const source = parseTransaction(prevout.rawTransaction);
        const output = source.outs[prevout.vout];
        if (source.getId() !== prevout.txid ||
            !output ||
            output.script.toString("hex") !== prevout.scriptHex ||
            String(output.value) !== prevout.value)
            throw new registrationPolicy_1.RegistrationError("PREVOUT_MISMATCH", "Signing prevout does not match its raw source transaction.");
        let values;
        try {
            values = readFundingOutput(output.script, output.value, prepared.snapshot.systemID);
        }
        catch (error) {
            const commitment = new verus_typescript_primitives_1.IdentityCommitmentScript();
            commitment.fromBuffer(output.script, 0, output.script.length);
            if (commitment.getCommitment().isAdvanced())
                throw error;
            values = { [prepared.snapshot.systemID]: String(output.value) };
        }
        const ids = new Set([
            ...Object.keys(values),
            ...Object.keys(prevout.values),
        ]);
        ids.forEach((id) => {
            if (!atomic(values[id] || "0").eq(atomic(prevout.values[id] || "0")))
                throw new registrationPolicy_1.RegistrationError("PREVOUT_MISMATCH", "Incorrect previous output currency amounts.");
        });
        addAmounts(incoming, values);
    });
    prepared.outputPlan.forEach((output, i) => {
        if (candidate.outs[i].script.toString("hex") !== output.scriptHex ||
            String(candidate.outs[i].value) !== output.value ||
            (output.values[prepared.snapshot.systemID] || "0") !== output.value)
            throw new registrationPolicy_1.RegistrationError("OUTPUT_MISMATCH", "Registration outputs differ from the approved plan.");
        const script = candidate.outs[i].script;
        let values = {
            [prepared.snapshot.systemID]: output.value,
        };
        if (output.role === "commitment") {
            const commitment = new verus_typescript_primitives_1.IdentityCommitmentScript();
            commitment.fromBuffer(script, 0, script.length);
            if (commitment.getCommitment().isAdvanced() ||
                !commitment.toBuffer().equals(script)) {
                throw new registrationPolicy_1.RegistrationError("OUTPUT_MISMATCH", "Invalid ordinary name commitment output.");
            }
        }
        else if (output.role === "identity") {
            const identity = new verus_typescript_primitives_2.IdentityScript();
            identity.fromBuffer(script, 0, script.length);
            if (!verus_typescript_primitives_2.IdentityScript.fromIdentity(identity.getIdentity())
                .toBuffer()
                .equals(script)) {
                throw new registrationPolicy_1.RegistrationError("OUTPUT_MISMATCH", "Identity output does not match its encoded identity authorities.");
            }
        }
        else if (output.role === "reservation") {
            const reservation = new verus_typescript_primitives_2.IdentityReservationScript();
            reservation.fromBuffer(script, 0, script.length);
            if (!reservation.toBuffer().equals(script))
                throw new registrationPolicy_1.RegistrationError("OUTPUT_MISMATCH", "Invalid reservation output.");
        }
        else if (output.role === "burn") {
            const smart = new verus_typescript_primitives_1.SmartTransactionScript();
            smart.fromBuffer(script, 0, script.length);
            if (!smart.toBuffer().equals(script) ||
                !smart.paramsOptCC.evalCode.eqn(verus_typescript_primitives_1.EVALS.EVAL_RESERVE_TRANSFER) ||
                smart.paramsOptCC.vData.length !== 1) {
                throw new registrationPolicy_1.RegistrationError("OUTPUT_MISMATCH", "Invalid registration burn output.");
            }
            const transfer = new verus_typescript_primitives_2.ReserveTransfer();
            const payload = smart.paramsOptCC.vData[0];
            if (transfer.fromBuffer(payload) !== payload.length ||
                !transfer.isValid() ||
                !transfer.toBuffer().equals(payload) ||
                !transfer.flags.eq(verus_typescript_primitives_2.RESERVE_TRANSFER_VALID.or(verus_typescript_primitives_2.RESERVE_TRANSFER_BURN_CHANGE_PRICE)) ||
                transfer.feeCurrencyID !== prepared.snapshot.systemID ||
                !transfer.feeAmount.eq(atomic(output.value)) ||
                transfer.reserveValues.valueMap.size !== 1 ||
                !transfer.transferDestination.type.eq(verus_typescript_primitives_2.DEST_ID)) {
                throw new registrationPolicy_1.RegistrationError("OUTPUT_MISMATCH", "Unsupported registration burn transfer.");
            }
            const burnDestination = new verus_typescript_primitives_1.TxDestination(new verus_typescript_primitives_1.KeyID(verus_typescript_primitives_2.RESERVE_TRANSFER_DESTINATION.destinationBytes));
            const canonicalBurn = new verus_typescript_primitives_1.SmartTransactionScript(params(verus_typescript_primitives_1.EVALS.EVAL_NONE, [burnDestination]), params(verus_typescript_primitives_1.EVALS.EVAL_RESERVE_TRANSFER, [burnDestination], [transfer.toBuffer()]));
            if (!canonicalBurn.toBuffer().equals(script)) {
                throw new registrationPolicy_1.RegistrationError("OUTPUT_MISMATCH", "Registration burn has unexpected authorization conditions.");
            }
            transfer.reserveValues.valueMap.forEach((amount, currency) => {
                if (currency === prepared.snapshot.systemID ||
                    !destination(currency).type.eq(verus_typescript_primitives_1.TxDestination.TYPE_ID) ||
                    transfer.destCurrencyID !== currency ||
                    transfer.transferDestination.getAddressString() !== currency) {
                    throw new registrationPolicy_1.RegistrationError("OUTPUT_MISMATCH", "Registration burn must pay its issuing currency.");
                }
                values[currency] = atomic(amount.toString(10)).toString(10);
            });
        }
        else if (output.role === "issuer-payment" ||
            output.role === "referral" ||
            output.role === "change") {
            values = readFundingOutput(script, candidate.outs[i].value, prepared.snapshot.systemID);
        }
        else {
            throw new registrationPolicy_1.RegistrationError("OUTPUT_MISMATCH", "Unknown registration output role.");
        }
        new Set([...Object.keys(values), ...Object.keys(output.values)]).forEach((id) => {
            if (!atomic(values[id] || "0").eq(atomic(output.values[id] || "0"))) {
                throw new registrationPolicy_1.RegistrationError("OUTPUT_MISMATCH", "Output currency metadata does not match its script bytes.");
            }
        });
        addAmounts(outgoing, values);
    });
    new Set([...Object.keys(incoming), ...Object.keys(outgoing)]).forEach((id) => {
        if (!atomic(incoming[id] || "0").eq(atomic(outgoing[id] || "0")))
            throw new registrationPolicy_1.RegistrationError("VALUE_MISMATCH", "Registration does not conserve the approved currency balances and fee.");
    });
    return true;
}
