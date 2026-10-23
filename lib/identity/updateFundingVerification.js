"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.identityUpdateFeeCap = identityUpdateFeeCap;
exports.defaultIdentityUpdateFeeCap = defaultIdentityUpdateFeeCap;
exports.verifyIdentityDefinitionOutput = verifyIdentityDefinitionOutput;
exports.verifyIdentityUpdateFunding = verifyIdentityUpdateFunding;
exports.createIdentityUpdateFundingApproval = createIdentityUpdateFundingApproval;
const bignumber_js_1 = __importDefault(require("bignumber.js"));
const utxo_lib_1 = require("@bitgo/utxo-lib");
const identityValidation_1 = require("./identityValidation");
const localIdentityUpdate_1 = require("./localIdentityUpdate");
const fullIdentityUpdateValidation_1 = require("./fullIdentityUpdateValidation");
const identityLocks_1 = require("./identityLocks");
const updateLimits_1 = require("./updateLimits");
const verus_typescript_primitives_1 = require("verus-typescript-primitives");
const fundingPrimitives_1 = require("./fundingPrimitives");
const fundingVerification_1 = require("./fundingVerification");
/**
 * Convert a public coin-denominated cap to atomic units without accepting NaN,
 * infinity, fractions of a satoshi, or unsupported amounts.
 */
function identityUpdateFeeCap(value) {
    (0, fundingPrimitives_1.requireCondition)(typeof value === "number" && Number.isFinite(value) && value >= 0, "Identity update fee cap must be finite and nonnegative.");
    const atomic = new bignumber_js_1.default(value).times("100000000");
    (0, fundingPrimitives_1.requireCondition)(atomic.isInteger() && atomic.lte("2100000000000000"), "Identity update fee cap must be an exact supported atomic amount.");
    return (0, fundingPrimitives_1.amount)(atomic.toFixed(0)).toFixed(0);
}
/**
 * A bounded default allowance, not a fee quote. Explicit caller caps override it.
 *
 * Ten ordinary fees minimum; larger definitions scale by their daemon fee
 * factors, extra planned outputs and large scripts. Explicit native transfer
 * fees are additional approved costs. Change is still verified independently.
 */
function defaultIdentityUpdateFeeCap(unfundedTxHex, explicitNativeFee = "0") {
    const planned = (0, fundingPrimitives_1.transaction)(unfundedTxHex);
    let identityUnits = 0;
    let largeScriptUnits = 0;
    let storageBytes = 0;
    for (const output of planned.outs) {
        if (output.script.length > 1666) {
            largeScriptUnits += output.script.length > 3332 ? 2 : 1;
        }
        try {
            const smart = (0, fundingPrimitives_1.parseScript)(verus_typescript_primitives_1.SmartTransactionScript, output.script);
            if (smart.paramsOptCC.evalCode.eqn(verus_typescript_primitives_1.EVALS.EVAL_NOTARY_EVIDENCE)) {
                storageBytes += output.script.length;
                continue;
            }
            const id = (0, fundingPrimitives_1.parseScript)(verus_typescript_primitives_1.IdentityScript, output.script).getIdentity();
            // Measure serialized multimap content separately from the base identity.
            const withoutContent = new verus_typescript_primitives_1.Identity();
            withoutContent.fromBuffer(id.toBuffer());
            withoutContent.clearContentMultiMap();
            const contentBytes = Math.max(0, id.toBuffer().length - withoutContent.toBuffer().length);
            identityUnits +=
                id.contentMap.size +
                    Math.max(0, (id.primaryAddresses || []).length - 1) +
                    Math.max(0, (id.privateAddresses || []).length - 1) +
                    Math.ceil(contentBytes / 128);
        }
        catch (_) {
            // Explicit transfers and evidence are covered by output allowances.
        }
    }
    // fundrawtransaction may add one change output, so include that output in
    // the allowance even when the caller has supplied only a definition.
    const units = Math.max(10, Math.max(1, identityUnits) + planned.outs.length + largeScriptUnits);
    // Each unit is 10,000 atomic units; the ten-unit floor is 0.001 native coin.
    // Explicit native transfer fees are added before converting back to coins.
    const cap = (0, fundingPrimitives_1.amount)(explicitNativeFee)
        .plus(new bignumber_js_1.default(units).times(10000))
        // GetMinRelayFeeForOutputs charges the complete evidence scripts:
        // bytes * (default storage factor 6 * export fee 1,000,000) / 6,000.
        // Use protocol defaults for a bounded allowance, never an RPC-proposed cap.
        // Custom chain/node fees can require an explicitly approved maxFee.
        .plus(new bignumber_js_1.default(storageBytes).times(1000))
        .dividedBy("100000000")
        .toNumber();
    identityUpdateFeeCap(cap);
    return cap;
}
function verifyIdentityDefinitionOutput(output, expectedAddress, requireCanonicalAuthorization = false) {
    // The identity authorizes the update but contributes no spendable balance.
    (0, fundingPrimitives_1.requireCondition)(output && (0, fundingPrimitives_1.nativeAmount)(output.value).isZero(), "Identity definition outputs carrying native value are unsupported.");
    const decoded = (0, fundingPrimitives_1.parseScript)(verus_typescript_primitives_1.IdentityScript, output.script).getIdentity();
    (0, localIdentityUpdate_1.validateSupportedIdentityUpdateState)(decoded);
    if (requireCanonicalAuthorization) {
        (0, identityValidation_1.validateIdentityDefinition)(decoded);
        const smart = (0, fundingPrimitives_1.parseScript)(verus_typescript_primitives_1.SmartTransactionScript, output.script);
        (0, fundingPrimitives_1.requireCondition)(smart.paramsOptCC.toChunk().length + 1 +
            smart.masterOptCC.toChunk().length < 6000, "Identity definition condition exceeds the daemon size limit.");
    }
    (0, fundingPrimitives_1.requireCondition)(decoded.getIdentityAddress() === expectedAddress &&
        (!requireCanonicalAuthorization ||
            verus_typescript_primitives_1.IdentityScript.fromIdentity(decoded).toBuffer().equals(output.script)), "Invalid identity definition authorization script.");
    return new Map();
}
function fundingOutput(output, systemID, expectedAddress) {
    // Canonical P2PK outputs are common in mature mining rewards. Unlike ordinary
    // payments they are accepted only as inputs, with a valid public key.
    const bytes = output.script;
    if (((bytes.length === 35 && bytes[0] === 33) ||
        (bytes.length === 67 && bytes[0] === 65)) &&
        bytes[bytes.length - 1] === 0xac) {
        const key = utxo_lib_1.ECPair.fromPublicKeyBuffer(bytes.subarray(1, bytes.length - 1), utxo_lib_1.networks.verus);
        if (expectedAddress) {
            (0, fundingPrimitives_1.requireCondition)(key.getAddress() === expectedAddress, "Funding output does not belong to its indexed address.");
        }
        return new Map([[systemID, (0, fundingPrimitives_1.nativeAmount)(output.value)]]);
    }
    const values = (0, fundingPrimitives_1.ordinaryOutput)(output, systemID);
    if (expectedAddress) {
        (0, fundingPrimitives_1.validAddress)(expectedAddress);
        if (bytes.length === 25) {
            (0, fundingPrimitives_1.ordinaryOutput)(output, systemID, expectedAddress);
        }
        else {
            const smart = (0, fundingPrimitives_1.parseScript)(verus_typescript_primitives_1.SmartTransactionScript, bytes);
            (0, fundingPrimitives_1.requireCondition)(smart.paramsOptCC.destinations.some((dest) => dest.toAddress() === expectedAddress), "Funding output does not belong to its indexed address.");
        }
    }
    return values;
}
/** Decode a planned output's balances and any fees embedded in its transfer. */
function approvedOutput(output, systemID, identityAddress) {
    let smart;
    try {
        smart = (0, fundingPrimitives_1.parseScript)(verus_typescript_primitives_1.SmartTransactionScript, output.script);
    }
    catch (_) {
        // Ordinary P2PKH has no CC envelope.
    }
    const fees = new Map();
    if (smart === null || smart === void 0 ? void 0 : smart.paramsOptCC.evalCode.eqn(verus_typescript_primitives_1.EVALS.EVAL_IDENTITY_PRIMARY)) {
        return {
            values: verifyIdentityDefinitionOutput(output, identityAddress, true),
            fees,
            identity: true,
        };
    }
    if (smart === null || smart === void 0 ? void 0 : smart.paramsOptCC.evalCode.eqn(verus_typescript_primitives_1.EVALS.EVAL_NOTARY_EVIDENCE)) {
        (0, fundingPrimitives_1.requireCondition)((0, fundingPrimitives_1.nativeAmount)(output.value).isZero() &&
            smart.masterOptCC.version.eqn(3) &&
            smart.masterOptCC.evalCode.eqn(verus_typescript_primitives_1.EVALS.EVAL_NONE) &&
            !smart.masterOptCC.vData.length &&
            smart.paramsOptCC.version.eqn(3), "Invalid or value-bearing identity evidence output.");
        return { values: new Map(), fees, identity: false, evidence: true };
    }
    if (smart === null || smart === void 0 ? void 0 : smart.paramsOptCC.evalCode.eqn(verus_typescript_primitives_1.EVALS.EVAL_RESERVE_TRANSFER)) {
        const master = smart.masterOptCC;
        const condition = smart.paramsOptCC;
        (0, fundingPrimitives_1.requireCondition)(master.version.eqn(3) &&
            master.evalCode.eqn(verus_typescript_primitives_1.EVALS.EVAL_NONE) &&
            !master.vData.length &&
            condition.version.eqn(3) &&
            condition.vData.length === 1, "Unsupported explicit reserve-transfer envelope.");
        const transfer = new verus_typescript_primitives_1.ReserveTransfer();
        const payload = condition.vData[0];
        (0, fundingPrimitives_1.requireCondition)(transfer.fromBuffer(payload) === payload.length &&
            transfer.isValid() &&
            transfer.reserveValues.valueMap.size === 1 &&
            transfer.toBuffer().equals(payload), "Invalid explicit reserve-transfer encoding.");
        // Minted value is not paid by the inputs and cannot be accounted as a
        // normal identity transfer. Such a request needs a separate mint workflow.
        (0, fundingPrimitives_1.requireCondition)(!transfer.isMint(), "Minting cannot be funded as an identity update.");
        const values = new Map([[systemID, (0, fundingPrimitives_1.nativeAmount)(output.value)]]);
        for (const [id, value] of transfer.reserveValues.valueMap) {
            (0, fundingPrimitives_1.validAddress)(id, true);
            if (id !== systemID)
                values.set(id, (0, fundingPrimitives_1.amount)(value.toString(10)));
        }
        const destination = transfer.transferDestination;
        (0, fundingPrimitives_1.requireCondition)(destination.auxDests.every((aux) => !aux.hasAuxDests() && (!aux.fees || aux.fees.isZero())), "Reserve-transfer auxiliary fees cannot be funded as an identity update.");
        let transferFee = (0, fundingPrimitives_1.amount)(transfer.feeAmount.toString(10));
        if (destination.isGateway() && destination.gatewayID != null) {
            (0, fundingPrimitives_1.validAddress)(destination.gatewayID, true);
            transferFee = transferFee.plus((0, fundingPrimitives_1.amount)(destination.fees.toString(10)));
        }
        (0, fundingPrimitives_1.validAddress)(transfer.feeCurrencyID, true);
        fees.set(transfer.feeCurrencyID, transferFee);
        // Native transfer fees are already in output.value. Reserve-denominated
        // fees must be added to the reserve amounts carried by the output.
        if (transfer.feeCurrencyID !== systemID)
            (0, fundingPrimitives_1.add)(values, fees);
        return { values, fees, identity: false };
    }
    return { values: (0, fundingPrimitives_1.ordinaryOutput)(output, systemID), fees, identity: false };
}
function verify(funded, approval, candidateHex, signingInputs, trustedInputs, lockContext) {
    (0, fundingPrimitives_1.validAddress)(approval.systemID, true);
    (0, fundingPrimitives_1.validAddress)(approval.changeAddress);
    (0, fundingPrimitives_1.validAddress)(approval.identity.identityAddress, true);
    // The cap covers total native fees, including explicit transfer fees.
    const fees = (0, fundingPrimitives_1.amountMap)(approval.fees, "Invalid fee amounts.");
    const explicitFees = (0, fundingPrimitives_1.amountMap)(approval.explicitFees, "Invalid fee amounts.");
    const totalNativeFee = (0, fundingPrimitives_1.amount)(approval.totalNativeFee);
    (0, fundingPrimitives_1.requireCondition)(totalNativeFee.eq(fees.get(approval.systemID) || 0) &&
        totalNativeFee.lte((0, fundingPrimitives_1.amount)(approval.maxFee)), "Identity update fee exceeds its approval.");
    (0, updateLimits_1.validateIdentityUpdateTransactionSize)(candidateHex);
    (0, updateLimits_1.validateIdentityUpdateTransactionSize)(approval.unfundedTxHex);
    const candidate = (0, fundingVerification_1.verifyFundingTransaction)(funded, candidateHex);
    const unfunded = (0, fundingPrimitives_1.transaction)(approval.unfundedTxHex);
    (0, fundingVerification_1.verifyTransparentTransaction)(unfunded);
    (0, fundingPrimitives_1.requireCondition)(!unfunded.ins.length, "Identity funding approval must be unsigned.");
    (0, fundingPrimitives_1.requireCondition)(candidate.ins.length > 1, "Missing or unexpected identity funding input.");
    if (signingInputs) {
        (0, fundingPrimitives_1.requireCondition)(signingInputs.length === candidate.ins.length, "Signing inputs do not match the funding approval.");
    }
    // Updates support verified coinbase sources. The trusted metadata fallback
    // is supplied only by the internal fixture path, which returns no approval.
    const prevouts = (0, fundingVerification_1.readFundingPrevouts)(candidate, funded.prevouts, {
        allowCoinbase: true,
        trustedPrevouts: trustedInputs === null || trustedInputs === void 0 ? void 0 : trustedInputs.map((input) => ({
            txid: input.txid,
            vout: input.outputIndex,
            value: input.satoshis,
            script: Buffer.from(input.script, "hex"),
        })),
    });
    const incoming = new Map();
    let identityCount = 0;
    let sourceIdentity;
    prevouts.forEach((prevout, index) => {
        const { txid, vout, output } = prevout;
        // The signer must use the same script and amount that were just verified.
        if (signingInputs) {
            const signing = signingInputs[index];
            (0, fundingPrimitives_1.requireCondition)(signing.txid === txid &&
                signing.outputIndex === vout &&
                signing.satoshis === output.value &&
                signing.script === output.script.toString("hex"), "Signing input data differs from the verified prevout.");
        }
        if (txid === approval.identity.txid && vout === approval.identity.vout) {
            identityCount++;
            verifyIdentityDefinitionOutput(output, approval.identity.identityAddress);
            sourceIdentity = (0, fundingPrimitives_1.parseScript)(verus_typescript_primitives_1.IdentityScript, output.script).getIdentity();
        }
        else {
            (0, fundingPrimitives_1.add)(incoming, fundingOutput(output, approval.systemID, prevout.address));
        }
    });
    (0, fundingPrimitives_1.requireCondition)(identityCount === 1, "Identity update must spend exactly its approved identity definition.");
    // Preserve planned outputs in order, and evidence at its exact indexes so
    // local references and consecutive multipart chunks remain valid.
    const outgoing = new Map();
    const actualExplicitFees = new Map();
    let plannedIndex = 0;
    let identityOutputs = 0;
    let resultingIdentity;
    const onlyApproved = candidate.clone();
    onlyApproved.ins = [];
    onlyApproved.outs = [];
    for (const [outputIndex, output] of candidate.outs.entries()) {
        const expected = unfunded.outs[plannedIndex];
        if (expected &&
            output.value === expected.value &&
            output.script.equals(expected.script)) {
            const decoded = approvedOutput(output, approval.systemID, approval.identity.identityAddress);
            (0, fundingPrimitives_1.requireCondition)(!decoded.evidence || outputIndex === plannedIndex, "Identity funding moved an evidence output.");
            plannedIndex++;
            onlyApproved.outs.push(output);
            if (decoded.identity) {
                identityOutputs++;
                resultingIdentity = (0, fundingPrimitives_1.parseScript)(verus_typescript_primitives_1.IdentityScript, output.script).getIdentity();
            }
            (0, fundingPrimitives_1.add)(outgoing, decoded.values);
            (0, fundingPrimitives_1.add)(actualExplicitFees, decoded.fees);
        }
        else {
            (0, fundingPrimitives_1.add)(outgoing, (0, fundingPrimitives_1.ordinaryOutput)(output, approval.systemID, approval.changeAddress));
        }
    }
    // Removing funding inputs and change must recover the original template,
    // including its transaction header and exactly one identity output.
    (0, fundingPrimitives_1.requireCondition)(identityOutputs === 1 &&
        plannedIndex === unfunded.outs.length &&
        onlyApproved.toHex() === unfunded.toHex(), "Identity funding changed its approved outputs or transaction header.");
    // A receipt is not evidence of current height. Use independently trusted
    // context, or prove the transition valid throughout its possible lifetime.
    (0, fullIdentityUpdateValidation_1.validateIdentityUpdateTransitionInvariants)(sourceIdentity, resultingIdentity);
    if (lockContext !== undefined) {
        (0, fundingPrimitives_1.requireCondition)(lockContext.chainId === approval.systemID, "Identity lock context does not match the approved chain.");
        (0, identityLocks_1.validateIdentityLockTransition)(sourceIdentity, resultingIdentity, lockContext, unfunded.expiryHeight);
    }
    else {
        (0, identityLocks_1.validateIdentityLocksWithoutHeight)(sourceIdentity, resultingIdentity, approval.systemID, unfunded.expiryHeight);
    }
    (0, fundingPrimitives_1.sameAmounts)(actualExplicitFees, explicitFees, "Explicit transfer fees differ from the approval.");
    // Planned outputs already account for explicit transfer fees. Add only the
    // remaining miner fee; any residual fee in a reserve currency is rejected.
    for (const id of new Set([...fees.keys(), ...explicitFees.keys()])) {
        const residual = (fees.get(id) || new bignumber_js_1.default(0)).minus(explicitFees.get(id) || 0);
        (0, fundingPrimitives_1.requireCondition)(residual.gte(0) && (id === approval.systemID || residual.isZero()), "Unexpected identity funding fee currency.");
        (0, fundingPrimitives_1.add)(outgoing, new Map([[id, residual]]));
    }
    // Every input currency must be preserved as payment, change, or approved fee.
    (0, fundingPrimitives_1.sameAmounts)(incoming, outgoing, "Identity funding does not conserve the approved payments, change, and fees in every currency.");
    return true;
}
/** Normalize the existing public receipt once at the verification boundary. */
function verifyFundingApproval(receipt, candidateHex, signingInputs, trustedInputs, lockContext) {
    (0, fundingPrimitives_1.requireCondition)(receipt && typeof receipt === "object", "Missing identity update funding approval.");
    (0, fundingPrimitives_1.requireCondition)(Array.isArray(receipt.prevouts), "Missing or unexpected identity funding input.");
    const funded = {
        txHex: receipt.txHex,
        prevouts: receipt.prevouts.map((prevout) => ({
            txid: prevout.txid,
            vout: prevout.outputIndex,
            rawTransaction: prevout.rawTransaction,
            address: prevout.address,
        })),
    };
    const approval = {
        systemID: receipt.systemId,
        changeAddress: receipt.changeAddress,
        unfundedTxHex: receipt.unfundedTxHex,
        totalNativeFee: receipt.nativeFee,
        fees: receipt.fees,
        explicitFees: receipt.explicitFees,
        maxFee: receipt.maxFee,
        identity: {
            txid: receipt.identity.txid,
            vout: receipt.identity.outputIndex,
            identityAddress: receipt.identity.identityAddress,
        },
    };
    return verify(funded, approval, candidateHex, signingInputs, trustedInputs, lockContext);
}
/**
 * Verify local economic intent and currency conservation against retained
 * approval. This does not fetch signatures or current chain/UTXO state.
 * Supply independently trusted active-chain context for height-dependent locks;
 * without it, the transition must be valid at every nonexpired inclusion height.
 * Never obtain this context from the untrusted receipt or transaction expiry.
 */
function verifyIdentityUpdateFunding(approval, candidateHex = approval.txHex, signingInputs, lockContext) {
    return verifyFundingApproval(approval, candidateHex, signingInputs, undefined, lockContext);
}
function freeze(value) {
    if (value && typeof value === "object") {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}
/**
 * Internal construction boundary: verify before freezing the approval.
 * The NODE_ENV=test fixture opt-out never produces a portable approval.
 */
function createIdentityUpdateFundingApproval(request, inputs, allowUnverifiedPrevouts, lockContext) {
    (0, fundingVerification_1.assertUnverifiedPrevoutsAllowed)(allowUnverifiedPrevouts);
    const approval = Object.assign(Object.assign({}, request), { prevouts: inputs.map((input) => ({
            txid: input.txid,
            outputIndex: input.outputIndex,
            rawTransaction: input.rawTransaction,
            address: input.address,
        })) });
    verifyFundingApproval(approval, approval.txHex, inputs, allowUnverifiedPrevouts ? inputs : undefined, lockContext);
    return allowUnverifiedPrevouts ? undefined : freeze(approval);
}
