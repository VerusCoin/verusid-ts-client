"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyRegistrationFunding = verifyRegistrationFunding;
exports.verifyIdentityRegistrationFunding = verifyIdentityRegistrationFunding;
const bignumber_js_1 = __importDefault(require("bignumber.js"));
const verus_typescript_primitives_1 = require("verus-typescript-primitives");
const fundingPrimitives_1 = require("./fundingPrimitives");
const fundingVerification_1 = require("./fundingVerification");
const registrationPolicy_1 = require("./registrationPolicy");
function commitmentInput(output, systemID) {
    const commitment = (0, fundingPrimitives_1.parseScript)(verus_typescript_primitives_1.IdentityCommitmentScript, output.script);
    (0, fundingPrimitives_1.requireCondition)(!commitment.getCommitment().isAdvanced(), "Token-bearing name commitments are unsupported.");
    // Ordinary commitments may carry native value. Credit the real nValue and
    // return any surplus as change, just as for ordinary funding inputs.
    return new Map([[systemID, (0, fundingPrimitives_1.nativeAmount)(output.value)]]);
}
/** Registration metadata outputs carry no spendable native or reserve balance. */
function metadataOutput(output, role, systemID) {
    (0, fundingPrimitives_1.requireCondition)(output.value === 0, "Registration metadata must not absorb funds.");
    if (role === "commitment")
        return commitmentInput(output, systemID);
    if (role === "identity") {
        const identity = (0, fundingPrimitives_1.parseScript)(verus_typescript_primitives_1.IdentityScript, output.script).getIdentity();
        (0, fundingPrimitives_1.requireCondition)(verus_typescript_primitives_1.IdentityScript.fromIdentity(identity).toBuffer().equals(output.script), "Invalid identity authorization script.");
    }
    else {
        (0, fundingPrimitives_1.requireCondition)(role === "reservation", "Unknown registration output role.");
        (0, fundingPrimitives_1.parseScript)(verus_typescript_primitives_1.IdentityReservationScript, output.script);
    }
    return new Map([[systemID, new bignumber_js_1.default(0)]]);
}
/** Decode only the specific reserve-transfer burn used for registration payment. */
function burnOutput(output, systemID, quote, payment) {
    const smart = (0, fundingPrimitives_1.parseScript)(verus_typescript_primitives_1.SmartTransactionScript, output.script);
    const master = smart.masterOptCC;
    const condition = smart.paramsOptCC;
    const burnAddress = verus_typescript_primitives_1.RESERVE_TRANSFER_DESTINATION.getAddressString();
    // Both authorization layers must use the protocol's fixed burn destination.
    for (const params of [master, condition]) {
        (0, fundingPrimitives_1.requireCondition)(params.version.eqn(3) &&
            params.m.eqn(1) &&
            params.n.eqn(1) &&
            params.destinations.length === 1 &&
            params.destinations[0].toAddress() === burnAddress, "Unexpected registration burn authorization.");
    }
    (0, fundingPrimitives_1.requireCondition)(master.evalCode.eqn(verus_typescript_primitives_1.EVALS.EVAL_NONE) &&
        !master.vData.length &&
        condition.evalCode.eqn(verus_typescript_primitives_1.EVALS.EVAL_RESERVE_TRANSFER) &&
        condition.vData.length === 1, "Unsupported registration burn output.");
    const transfer = new verus_typescript_primitives_1.ReserveTransfer();
    const payload = condition.vData[0];
    // Disallow other transfer flags, auxiliary destinations, and gateway fees.
    (0, fundingPrimitives_1.requireCondition)(transfer.fromBuffer(payload) === payload.length &&
        transfer.isValid() &&
        transfer.toBuffer().equals(payload) &&
        transfer.flags.eq(verus_typescript_primitives_1.RESERVE_TRANSFER_VALID.or(verus_typescript_primitives_1.RESERVE_TRANSFER_BURN_CHANGE_PRICE)) &&
        transfer.feeCurrencyID === systemID &&
        transfer.transferDestination.type.eq(verus_typescript_primitives_1.DEST_ID) &&
        !transfer.transferDestination.auxDests.length &&
        transfer.transferDestination.fees.isZero() &&
        transfer.reserveValues.valueMap.size === 1, "Unsupported registration burn transfer.");
    const [currencyID, burned] = [...transfer.reserveValues.valueMap][0];
    (0, fundingPrimitives_1.validAddress)(currencyID, true);
    (0, fundingPrimitives_1.requireCondition)(currencyID !== systemID &&
        transfer.destCurrencyID === currencyID &&
        transfer.transferDestination.getAddressString() === currencyID &&
        (0, fundingPrimitives_1.nativeAmount)(output.value).eq((0, fundingPrimitives_1.amount)(transfer.feeAmount.toString(10))), "Incorrect burn currency or transfer fee.");
    if (quote && payment) {
        (0, fundingPrimitives_1.requireCondition)(payment.currencyID === currencyID &&
            payment.recipient === currencyID &&
            (0, fundingPrimitives_1.nativeAmount)(output.value).eq((0, fundingPrimitives_1.amount)(quote.transferFee)) &&
            (0, fundingPrimitives_1.amount)(burned.toString(10)).eq((0, fundingPrimitives_1.amount)(payment.amount)), "Burn differs from the approved registration payment.");
    }
    // The burned tokens and the embedded native transfer fee both consume input
    // funds. The miner fee is separate and is added by verify after output totals.
    return new Map([
        [systemID, (0, fundingPrimitives_1.nativeAmount)(output.value)],
        [currencyID, (0, fundingPrimitives_1.amount)(burned.toString(10))],
    ]);
}
function verify(funded, approval, candidateHex) {
    const { systemID, outputs, quote, expectedCosts } = approval;
    (0, fundingPrimitives_1.validAddress)(systemID, true);
    (0, fundingPrimitives_1.validAddress)(approval.changeAddress);
    const candidate = (0, fundingVerification_1.verifyFundingTransaction)(funded, candidateHex);
    // Registration additionally binds locktime and expiry to its chain snapshot.
    (0, fundingPrimitives_1.requireCondition)(candidate.locktime === 0 &&
        candidate.expiryHeight === approval.expiryHeight, "Unsupported registration transaction.");
    // Registration rejects coinbase sources. Amounts come from raw prevouts,
    // never the selector's cached balances or output-plan metadata.
    const prevouts = (0, fundingVerification_1.readFundingPrevouts)(candidate, funded.prevouts);
    const incoming = new Map();
    let commitmentCount = 0;
    for (const { txid, vout, output } of prevouts) {
        // Only the approved commitment gets special decoding. All other inputs
        // must satisfy the ordinary funding rules, even if they are commitments.
        if (approval.commitment &&
            txid === approval.commitment.txid &&
            vout === approval.commitment.vout) {
            commitmentCount++;
            (0, fundingPrimitives_1.add)(incoming, commitmentInput(output, systemID));
        }
        else {
            (0, fundingPrimitives_1.add)(incoming, (0, fundingPrimitives_1.ordinaryOutput)(output, systemID));
        }
    }
    (0, fundingPrimitives_1.requireCondition)(!approval.commitment || commitmentCount === 1, "Registration must spend its approved name commitment.");
    // Approved outputs retain their exact positions; only one trailing change
    // output may be appended, and its recipient is checked below.
    (0, fundingPrimitives_1.requireCondition)(candidate.outs.length === outputs.length ||
        candidate.outs.length === outputs.length + 1, "Unexpected registration outputs.");
    const expectedFee = (0, fundingPrimitives_1.amount)(approval.minerFee);
    const outgoing = new Map();
    // Spending excludes returned change but includes the approved miner fee.
    // Outgoing starts with all output balances, including change.
    const spending = new Map([[systemID, expectedFee]]);
    candidate.outs.forEach((output, index) => {
        const outputApproval = outputs[index];
        let values;
        if (!outputApproval) {
            values = (0, fundingPrimitives_1.ordinaryOutput)(output, systemID, approval.changeAddress);
        }
        else {
            if (outputApproval.approved) {
                (0, fundingPrimitives_1.requireCondition)(output.script.toString("hex") ===
                    outputApproval.approved.scriptHex.toLowerCase() &&
                    (0, fundingPrimitives_1.nativeAmount)(output.value).eq((0, fundingPrimitives_1.amount)(outputApproval.approved.value)), "Output differs from the approved payment.");
            }
            if (outputApproval.role === "issuer-payment" ||
                outputApproval.role === "referral") {
                const payment = outputApproval.payment;
                values = (0, fundingPrimitives_1.ordinaryOutput)(output, systemID, payment === null || payment === void 0 ? void 0 : payment.recipient);
                if (payment) {
                    (0, fundingPrimitives_1.sameAmounts)(values, (0, fundingPrimitives_1.amountMap)({ [payment.currencyID]: payment.amount }), "Payment differs from the approved amount or currency.");
                }
            }
            else if (outputApproval.role === "burn") {
                values = burnOutput(output, systemID, quote, outputApproval.payment);
            }
            else {
                values = metadataOutput(output, outputApproval.role, systemID);
            }
            (0, fundingPrimitives_1.add)(spending, values);
        }
        (0, fundingPrimitives_1.add)(outgoing, values);
    });
    if (expectedCosts) {
        (0, fundingPrimitives_1.sameAmounts)(spending, expectedCosts, "Actual spending differs from the approved registration costs.");
    }
    // Include the miner fee so equality means inputs = outputs + approved fee.
    // Embedded transfer fees were already counted as part of the burn output.
    (0, fundingPrimitives_1.add)(outgoing, new Map([[systemID, expectedFee]]));
    // Exact equality rejects excess native fees and implicit reserve burns,
    // including currencies unrelated to the registration quote.
    (0, fundingPrimitives_1.sameAmounts)(incoming, outgoing, "Input funds do not exactly cover the approved payments, change, and fee.");
    return true;
}
/** Expose a consistent registration error while retaining the failed check's message. */
function guard(verifyFunding) {
    try {
        return verifyFunding();
    }
    catch (error) {
        throw new registrationPolicy_1.RegistrationError("REGISTRATION_FUNDING_MISMATCH", "Registration funding verification failed. " +
            (error instanceof Error ? error.message : String(error)));
    }
}
/**
 * Independently verify balances against explicit approved outputs and fees.
 * Also run automatically by fundRegistration before it returns a transaction.
 */
function verifyRegistrationFunding(funded, approval, candidateHex = funded.txHex) {
    return guard(() => verify(funded, {
        systemID: approval.snapshot.systemID,
        expiryHeight: approval.snapshot.expiryHeight,
        minerFee: approval.nativeFee,
        changeAddress: approval.changeAddress,
        commitment: approval.commitment,
        outputs: approval.outputs.map((output) => ({
            role: output.role,
            approved: output,
        })),
    }, candidateHex));
}
/**
 * Check all currencies, exact quoted fees/payments, and approved change directly
 * from transaction bytes and hash-verified source transactions. The prepared
 * approval must be retained independently from externally supplied candidates.
 * When supplied independently, expectedChangeAddress also binds the change
 * destination to the application's approval. This checks neither signatures
 * nor current chain/UTXO state and performs no RPC calls. Run it again before
 * each broadcast.
 */
function verifyIdentityRegistrationFunding(prepared, candidateHex = prepared.txHex, expectedChangeAddress = prepared.changeAddress) {
    return guard(() => {
        const quote = prepared.quote;
        const systemID = prepared.snapshot.systemID;
        (0, fundingPrimitives_1.requireCondition)(quote &&
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
        ].forEach(fundingPrimitives_1.amount);
        // Full operation costs must equal reveal costs plus the commitment fee.
        const revealCosts = (0, fundingPrimitives_1.amountMap)(quote.totalRequired);
        const operationCosts = (0, fundingPrimitives_1.amountMap)(quote.totalOperationRequired);
        const combined = new Map(revealCosts);
        (0, fundingPrimitives_1.add)(combined, new Map([[systemID, (0, fundingPrimitives_1.amount)(quote.commitmentFee)]]));
        (0, fundingPrimitives_1.sameAmounts)(combined, operationCosts, "Inconsistent two-stage registration costs.");
        const commitment = prepared.stage === "commitment";
        (0, fundingPrimitives_1.requireCondition)(commitment ? !prepared.commitment : !!prepared.commitment, "Registration requires an independently approved commitment outpoint.");
        const expectedFee = commitment ? quote.commitmentFee : quote.nativeFee;
        (0, fundingPrimitives_1.requireCondition)((0, fundingPrimitives_1.amount)(prepared.nativeFee).eq((0, fundingPrimitives_1.amount)(expectedFee)), "Transaction fee differs from the approved quote.");
        // The commitment transaction spends only its own fee, but starting the
        // operation requires approval of both stages. Reveal approval covers only
        // the remaining registration costs.
        const expectedCosts = commitment
            ? (0, fundingPrimitives_1.amountMap)({ [systemID]: quote.commitmentFee })
            : revealCosts;
        const approvedCosts = (0, fundingPrimitives_1.amountMap)(prepared.approvedCosts);
        for (const [id, value] of commitment ? operationCosts : revealCosts) {
            (0, fundingPrimitives_1.requireCondition)(value.lte(approvedCosts.get(id) || 0), "Registration exceeds approved costs.");
        }
        // Derive output roles and payments from the quote, not outputPlan metadata.
        // The retained unsigned transaction still binds every candidate script.
        const outputs = commitment
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
            systemID,
            expiryHeight: prepared.snapshot.expiryHeight,
            minerFee: expectedFee,
            changeAddress: expectedChangeAddress,
            commitment: prepared.commitment,
            outputs,
            quote,
            expectedCosts,
        }, candidateHex);
    });
}
