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
exports.resolveIdentityRegistration = resolveIdentityRegistration;
exports.validatePreparedIdentityRegistrationTransaction = validatePreparedIdentityRegistrationTransaction;
exports.createNameReservationTransaction = createNameReservationTransaction;
exports.createIdentityRegistrationTransaction = createIdentityRegistrationTransaction;
const bn_js_1 = __importDefault(require("bn.js"));
const registrationFundingVerification_1 = require("./registrationFundingVerification");
const identityValidation_1 = require("./identityValidation");
const verus_typescript_primitives_1 = require("verus-typescript-primitives");
const registrationPolicy_1 = require("./registrationPolicy");
const registrationSigning_1 = require("./registrationSigning");
const registrationTransaction_1 = require("./registrationTransaction");
// Wallet form state can change while RPC requests are pending. Capture the
// approved request before the first await so outputs, costs and recovery data
// all describe the same invocation.
function snapshotNameReservationRequest(request) {
    return Object.assign(Object.assign({}, request), { salt: Buffer.isBuffer(request.salt)
            ? Buffer.from(request.salt)
            : request.salt, funding: request.funding.map((input) => (Object.assign({}, input))), approvedCosts: Object.assign({}, request.approvedCosts) });
}
function snapshotIdentityRegistrationRequest(request) {
    const reservation = Object.assign({}, request.reservation);
    let identity;
    if (request.identity instanceof verus_typescript_primitives_1.Identity) {
        // Serialization discards address types: an IdentityID primary key would
        // decode as a KeyID with the same hash. Validate before that information is lost.
        (0, verus_typescript_primitives_1.validateIdentityForRegistration)(request.identity, (0, verus_typescript_primitives_1.resolveIdentityRegistrationName)({
            name: reservation.fullName,
            parent: reservation.parentID,
            systemID: reservation.systemID,
            rootSystemName: reservation.rootSystemName,
        }));
        identity = new verus_typescript_primitives_1.Identity();
        identity.fromBuffer(request.identity.toBuffer(), 0, false, reservation.rootSystemName);
    }
    else {
        // This public branch accepts the daemon's JSON representation, including
        // nested content data. Round-trip it now, before callers can mutate it.
        identity = JSON.parse(JSON.stringify(request.identity));
    }
    return Object.assign(Object.assign({}, request), { reservation,
        identity, commitment: Object.assign({}, request.commitment), funding: request.funding.map((input) => (Object.assign({}, input))), approvedCosts: Object.assign({}, request.approvedCosts) });
}
function snapshotForRegistration(rpc, request) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!(0, registrationTransaction_1.destination)(request.systemID).type.eq(verus_typescript_primitives_1.TxDestination.TYPE_ID) ||
            !request.rootSystemName) {
            throw new registrationPolicy_1.RegistrationError("INVALID_CHAIN_CONTEXT", "An explicit registration system and global root name are required.");
        }
        const [infoResponse, nativeResponse, selectedResponse] = yield Promise.all([
            rpc.getInfo(),
            rpc.getCurrency(request.systemID),
            rpc.chain === request.systemID
                ? Promise.resolve(undefined)
                : rpc.getCurrency(rpc.chain),
        ]);
        const info = (0, registrationPolicy_1.registrationRpcResult)(infoResponse, "getinfo");
        const native = (0, registrationPolicy_1.registrationRpcResult)(nativeResponse, "getcurrency");
        const selected = selectedResponse == null
            ? native
            : (0, registrationPolicy_1.registrationRpcResult)(selectedResponse, "getcurrency selected chain");
        if (native.currencyid !== request.systemID ||
            native.systemid !== request.systemID ||
            selected.currencyid !== request.systemID ||
            (info.chainid != null && info.chainid !== request.systemID)) {
            throw new registrationPolicy_1.RegistrationError("WRONG_REGISTRATION_SYSTEM", "RPC endpoint does not match the selected registration system.");
        }
        if (!Number.isSafeInteger(info.blocks) ||
            info.blocks < 1 ||
            info.longestchain > info.blocks) {
            throw new registrationPolicy_1.RegistrationError("INVALID_CHAIN_CONTEXT", "RPC endpoint must have a synchronized active chain.");
        }
        const blockTime = native.blocktime == null ? 60 : native.blocktime;
        if (!Number.isSafeInteger(blockTime) || blockTime < 1)
            throw new registrationPolicy_1.RegistrationError("INVALID_CHAIN_CONTEXT", "Invalid native block time.");
        const delta = request.expiryDelta == null
            ? Math.max(20, Math.min(60, Math.floor(1200 / blockTime)))
            : request.expiryDelta;
        if (!Number.isSafeInteger(delta) || delta < 4 || delta > 60)
            throw new registrationPolicy_1.RegistrationError("INVALID_EXPIRY", "Expiry delta must be between 4 and 60 blocks.");
        const block = (0, registrationPolicy_1.registrationRpcResult)(yield rpc.getBlock(String(info.blocks), 1), "getblock tip");
        if (block.height !== info.blocks ||
            block.confirmations !== 1 ||
            !/^[0-9a-f]{64}$/.test(block.hash)) {
            throw new registrationPolicy_1.RegistrationError("INVALID_CHAIN_CONTEXT", "Tip block is not the active chain tip.");
        }
        const candidateHeight = info.blocks + 1;
        if (candidateHeight + delta >= 500000000)
            throw new registrationPolicy_1.RegistrationError("INVALID_EXPIRY", "Registration expiry exceeds the protocol limit.");
        return {
            systemID: request.systemID,
            rootSystemName: request.rootSystemName,
            tipHeight: info.blocks,
            tipHash: block.hash,
            candidateHeight,
            expiryDelta: delta,
            expiryHeight: candidateHeight + delta,
        };
    });
}
function resolveIdentityRegistration(rpc, request) {
    return __awaiter(this, void 0, void 0, function* () {
        request = Object.assign({}, request);
        const snapshot = yield snapshotForRegistration(rpc, request);
        const policy = yield (0, registrationPolicy_1.resolveIdentityRegistrationPolicy)(rpc, Object.assign(Object.assign({}, request), { candidateHeight: snapshot.candidateHeight }));
        constrainRegistrationExpiry(snapshot, policy);
        const quote = (0, registrationPolicy_1.quoteIdentityRegistration)(policy, request);
        yield (0, registrationTransaction_1.assertRegistrationSnapshot)(rpc, snapshot);
        return { policy, quote, snapshot };
    });
}
function constrainRegistrationExpiry(snapshot, policy) {
    const end = policy.parentDefinition.endblock;
    if (policy.branch === "token-payment" &&
        end &&
        snapshot.expiryHeight >= end) {
        // RPC and consensus disagree at the boundary itself. Keep the whole
        // transaction lifetime on the quoted side of the issuer-payment branch.
        snapshot.expiryHeight = end - 1;
        if (snapshot.expiryHeight - snapshot.candidateHeight < 4) {
            throw new registrationPolicy_1.RegistrationError("UNSUPPORTED_POLICY_BOUNDARY", "The namespace payment policy changes too soon to register with this quote.");
        }
    }
}
function authoritiesFor(rpc, addresses, snapshot) {
    return __awaiter(this, void 0, void 0, function* () {
        const ids = [...new Set(addresses)].filter((id) => (0, registrationTransaction_1.destination)(id).type.eq(verus_typescript_primitives_1.TxDestination.TYPE_ID));
        const authorities = yield Promise.all(ids.map((identityID) => __awaiter(this, void 0, void 0, function* () {
            var _a;
            const response = yield rpc.getIdentity(identityID);
            const result = (0, registrationPolicy_1.registrationRpcResult)(response, "getidentity authorization");
            const json = yield (0, registrationPolicy_1.requireRegistrationIdentity)({ getIdentity: () => __awaiter(this, void 0, void 0, function* () { return response; }) }, identityID);
            if (!result ||
                !/^[0-9a-f]{64}$/.test(result.txid) ||
                !Number.isInteger(result.vout) ||
                result.vout < 0 ||
                result.vout > 0xffffffff ||
                !Number.isSafeInteger(result.blockheight) ||
                result.blockheight < 1 ||
                result.blockheight > snapshot.tipHeight) {
                throw new registrationPolicy_1.RegistrationError("INVALID_AUTHORITY_EVIDENCE", "Signing authority requires a confirmed defining outpoint.");
            }
            const [rawResponse, unspentResponse] = yield Promise.all([
                rpc.getRawTransaction(result.txid, 0),
                rpc.getTxOut(result.txid, result.vout, true),
            ]);
            const raw = (0, registrationPolicy_1.registrationRpcResult)(rawResponse, "getrawtransaction authorization");
            const source = (0, registrationTransaction_1.parseTransaction)(typeof raw === "string" ? raw : raw === null || raw === void 0 ? void 0 : raw.hex);
            const output = source.outs[result.vout];
            if (source.getId() !== result.txid || !output) {
                throw new registrationPolicy_1.RegistrationError("AUTHORITY_MISMATCH", "Signing authority outpoint does not match its raw transaction.");
            }
            const script = new verus_typescript_primitives_1.IdentityScript();
            script.fromBuffer(output.script, 0, output.script.length);
            const identity = script.getIdentity();
            const primaryAddresses = identity.primaryAddresses.map((key) => key.toAddress());
            if (!identity.version.eqn(3) ||
                identity.getIdentityAddress(snapshot.rootSystemName) !== identityID ||
                !identity.toBuffer().equals(script.paramsOptCC.vData[0]) ||
                identity.name !== json.name ||
                identity.parent.toAddress() !== json.parent ||
                identity.systemId.toAddress() !== json.systemid ||
                identity.flags.toNumber() !== json.flags ||
                identity.version.toNumber() !== json.version ||
                identity.unlockAfter.toNumber() !== (json.timelock || 0) ||
                identity.minSigs.toNumber() !== json.minimumsignatures ||
                JSON.stringify(primaryAddresses) !==
                    JSON.stringify(json.primaryaddresses) ||
                !verus_typescript_primitives_1.IdentityScript.fromIdentity(identity).toBuffer().equals(output.script)) {
                throw new registrationPolicy_1.RegistrationError("AUTHORITY_MISMATCH", "Signing authority identity differs from its canonical defining output.");
            }
            const unspent = (0, registrationPolicy_1.registrationRpcResult)(unspentResponse, "gettxout authorization");
            if (!unspent)
                throw new registrationPolicy_1.RegistrationError("AUTHORITY_CHANGED", "Signing authority was spent or changed; refresh registration.");
            if (unspent.bestblock !== snapshot.tipHash) {
                throw new registrationPolicy_1.RegistrationError("STALE_CHAIN_CONTEXT", "Chain tip changed while resolving signing authority.");
            }
            if (!Number.isSafeInteger(unspent.confirmations) ||
                unspent.confirmations < 1 ||
                snapshot.candidateHeight - unspent.confirmations !==
                    result.blockheight ||
                ((_a = unspent.scriptPubKey) === null || _a === void 0 ? void 0 : _a.hex) !== output.script.toString("hex") ||
                !(0, verus_typescript_primitives_1.currencyAmountToAtomic)(unspent.value).eq(new bn_js_1.default(output.value))) {
                throw new registrationPolicy_1.RegistrationError("AUTHORITY_MISMATCH", "Signing authority unspent state differs from its confirmed defining output.");
            }
            // FLAG_LOCKED is 0x2. After unlocking, the absolute unlockAfter height is
            // still locked through that height; an elapsed timelock is spendable.
            if (!identity.flags.and(new bn_js_1.default(0x2)).isZero() ||
                identity.unlockAfter.gten(snapshot.candidateHeight)) {
                throw new registrationPolicy_1.RegistrationError("LOCKED_AUTHORITY", "Registration signing authority is locked.");
            }
            return {
                identityID,
                primaryAddresses,
                minimumSignatures: identity.minSigs.toNumber(),
                revoked: identity.isRevoked(),
            };
        })));
        (0, registrationSigning_1.validateRegistrationIdentityAuthorities)(authorities);
        return authorities;
    });
}
function validateRegistrationChangeAddress(rpc, changeAddress, snapshot, createdIdentityID) {
    return __awaiter(this, void 0, void 0, function* () {
        const change = (0, registrationTransaction_1.destination)(changeAddress);
        if (!change.type.eq(verus_typescript_primitives_1.TxDestination.TYPE_ID) ||
            changeAddress === createdIdentityID) {
            return;
        }
        // Identity payments bind to whoever controls the identity when they are spent.
        // A commitment must not send its change to an identity that is not registered
        // yet, including the identity this operation will create in its second stage.
        yield authoritiesFor(rpc, [changeAddress], snapshot);
    });
}
function preparedTransaction(rpc, funded, resolved, stage, nativeFee, revealAuthorities, changeAddress, approvedCosts, commitment) {
    return __awaiter(this, void 0, void 0, function* () {
        const signingIdentities = [];
        for (const prevout of funded.prevouts) {
            if (prevout.scriptHex.startsWith("76a914") &&
                prevout.scriptHex.length === 50)
                continue;
            const script = new verus_typescript_primitives_1.SmartTransactionScript();
            script.fromBuffer(Buffer.from(prevout.scriptHex, "hex"));
            script.paramsOptCC.destinations.forEach((dest) => {
                if (dest.type.eq(verus_typescript_primitives_1.TxDestination.TYPE_ID))
                    signingIdentities.push(dest.toAddress());
            });
        }
        const identityAuthorities = yield authoritiesFor(rpc, signingIdentities, resolved.snapshot);
        const signatureState = (0, registrationSigning_1.inspectIdentityRegistrationSignatures)(Object.assign(Object.assign({}, funded), { identityAuthorities }));
        const result = Object.assign(Object.assign(Object.assign(Object.assign({}, funded), { hex: funded.txHex, stage,
            nativeFee,
            changeAddress, approvedCosts: Object.assign({}, approvedCosts), snapshot: resolved.snapshot }), (commitment ? { commitment: Object.assign({}, commitment) } : {})), { quote: resolved.quote, identityAuthorities,
            revealAuthorities, requiredSignatures: signatureState.inputs, signingStatus: "unsigned" });
        validatePreparedIdentityRegistrationTransaction(result);
        yield (0, registrationTransaction_1.assertRegistrationSnapshot)(rpc, resolved.snapshot);
        return freezePrepared(result);
    });
}
/** Returned plans contain only JSON values, so freeze the entire approval receipt. */
function freezePrepared(value) {
    if (value && typeof value === "object") {
        Object.values(value).forEach(freezePrepared);
        Object.freeze(value);
    }
    return value;
}
/** Economic validation must run before releasing a signature, including on external partials. */
function validatePreparedIdentityRegistrationTransaction(prepared, candidateHex, expectedChangeAddress) {
    if (!prepared ||
        !prepared.approvedCosts ||
        typeof prepared.changeAddress !== "string") {
        throw new registrationPolicy_1.RegistrationError("APPROVED_TRANSACTION_REQUIRED", "Retain and supply the original prepared registration transaction with its cost and change approvals.");
    }
    (0, registrationTransaction_1.validateRegistrationTransaction)(prepared, candidateHex == null ? prepared.txHex : candidateHex);
    const systemID = prepared.snapshot.systemID;
    const quote = prepared.quote;
    if (!quote ||
        quote.systemID !== systemID ||
        (prepared.stage !== "commitment" && prepared.stage !== "registration")) {
        throw new registrationPolicy_1.RegistrationError("INVALID_PLAN", "Registration quote does not match its approved transaction context.");
    }
    const commitment = prepared.stage === "commitment";
    const expectedFee = commitment ? quote.commitmentFee : quote.nativeFee;
    if (prepared.nativeFee !== expectedFee)
        throw new registrationPolicy_1.RegistrationError("FEE_MISMATCH", "Transaction fee differs from the approved quote.");
    const expectedCosts = commitment
        ? { [systemID]: quote.commitmentFee }
        : quote.totalRequired;
    (0, registrationTransaction_1.requireAmounts)(commitment ? quote.totalOperationRequired : expectedCosts, prepared.approvedCosts);
    const expectedRoles = commitment
        ? ["commitment"]
        : [
            "identity",
            ...(quote.issuerPayment
                ? [
                    quote.issuerPayment.kind === "burn"
                        ? "burn"
                        : "issuer-payment",
                ]
                : []),
            ...quote.referralPayments.map(() => "referral"),
            "reservation",
        ];
    const outputs = prepared.outputPlan;
    const hasChange = outputs.length === expectedRoles.length + 1;
    if (hasChange)
        expectedRoles.push("change");
    if (outputs.length !== expectedRoles.length ||
        outputs.some((output, i) => output.role !== expectedRoles[i])) {
        throw new registrationPolicy_1.RegistrationError("OUTPUT_MISMATCH", "Registration output roles or ordering differ from the approved quote.");
    }
    const costs = { [systemID]: prepared.nativeFee };
    outputs.forEach((output) => {
        if (output.role === "change") {
            if (output.scriptHex !==
                (0, registrationTransaction_1.paymentOutput)(prepared.changeAddress, output.values, systemID, "change")
                    .scriptHex) {
                throw new registrationPolicy_1.RegistrationError("CHANGE_MISMATCH", "Change is not paid to the approved destination.");
            }
        }
        else {
            if ((output.role === "identity" ||
                output.role === "reservation" ||
                output.role === "commitment") &&
                output.value !== "0") {
                throw new registrationPolicy_1.RegistrationError("OUTPUT_MISMATCH", "Registration metadata outputs must not absorb funds.");
            }
            (0, registrationTransaction_1.addAmounts)(costs, output.values);
        }
    });
    new Set([...Object.keys(costs), ...Object.keys(expectedCosts)]).forEach((id) => {
        if (!(0, registrationTransaction_1.atomic)(costs[id] || "0").eq((0, registrationTransaction_1.atomic)(expectedCosts[id] || "0"))) {
            throw new registrationPolicy_1.RegistrationError("COST_MISMATCH", "Actual non-change spending differs from the approved quote for " +
                id +
                ".");
        }
    });
    if (!commitment) {
        let i = 1;
        const payments = [];
        if (quote.issuerPayment)
            payments.push(quote.issuerPayment.kind === "burn"
                ? burnOutput(quote)
                : (0, registrationTransaction_1.paymentOutput)(quote.issuerPayment.recipient, { [quote.issuerPayment.currencyID]: quote.issuerPayment.amount }, systemID, "issuer-payment"));
        quote.referralPayments.forEach((payment) => payments.push((0, registrationTransaction_1.paymentOutput)(payment.recipient, { [payment.currencyID]: payment.amount }, systemID, "referral")));
        payments.forEach((payment) => {
            if (outputs[i].scriptHex !== payment.scriptHex ||
                outputs[i].value !== payment.value) {
                throw new registrationPolicy_1.RegistrationError("PAYMENT_MISMATCH", "Issuer or referral payment differs from the approved quote.");
            }
            i++;
        });
    }
    (0, registrationFundingVerification_1.verifyIdentityRegistrationFunding)(prepared, candidateHex, expectedChangeAddress);
    return true;
}
function createNameReservationTransaction(rpc, request) {
    return __awaiter(this, void 0, void 0, function* () {
        request = snapshotNameReservationRequest(request);
        const controller = (0, registrationTransaction_1.destination)(request.controller);
        if (!Buffer.isBuffer(request.salt) ||
            request.salt.length !== 32 ||
            request.salt.equals(Buffer.alloc(32))) {
            throw new registrationPolicy_1.RegistrationError("INVALID_SALT", "Supply a securely generated nonzero 32-byte reservation salt.");
        }
        const salt = Buffer.from(request.salt);
        const resolved = yield resolveIdentityRegistration(rpc, request);
        const { policy, quote, snapshot } = resolved;
        (0, registrationTransaction_1.requireAmounts)(quote.totalOperationRequired, request.approvedCosts);
        yield validateRegistrationChangeAddress(rpc, request.changeAddress, snapshot);
        const revealAuthorities = yield authoritiesFor(rpc, [
            request.controller,
            ...(policy.requiredAuthorityID ? [policy.requiredAuthorityID] : []),
        ], snapshot);
        const reservation = new verus_typescript_primitives_1.AdvancedNameReservation({
            name: policy.resolvedName.name,
            parent: new verus_typescript_primitives_1.IdentityID((0, registrationTransaction_1.destination)(policy.resolvedName.parent).data.toBuffer()),
            referral: request.referralID
                ? new verus_typescript_primitives_1.IdentityID((0, registrationTransaction_1.destination)(request.referralID).data.toBuffer())
                : undefined,
            salt,
        });
        reservation.validateForCreation();
        const commitment = reservation.getCommitment();
        const script = verus_typescript_primitives_1.IdentityCommitmentScript.fromCommitment(commitment, controller, policy.requiredAuthorityID
            ? (0, registrationTransaction_1.destination)(policy.requiredAuthorityID)
            : undefined);
        const record = Object.freeze({
            schemaVersion: 1,
            kind: "advanced",
            reservationHex: reservation.toBuffer().toString("hex"),
            identityAddress: reservation.getIdentityAddress(),
            parentID: policy.resolvedName.parent,
            systemID: snapshot.systemID,
            rootSystemName: snapshot.rootSystemName,
            fullName: policy.resolvedName.fullName,
            commitmentHashHex: commitment.toBuffer().toString("hex"),
            controller: request.controller,
            authorizationID: policy.requiredAuthorityID,
        });
        // Verify that the selected wallet can cover both stages before it pays for a commitment.
        const available = {};
        for (const item of request.funding)
            (0, registrationTransaction_1.addAmounts)(available, (yield (0, registrationTransaction_1.readRegistrationPrevout)(rpc, item, snapshot)).values);
        if (Object.keys(quote.totalOperationRequired).some((id) => (0, registrationTransaction_1.atomic)(available[id] || "0").lt((0, registrationTransaction_1.atomic)(quote.totalOperationRequired[id])))) {
            throw new registrationPolicy_1.RegistrationError("INSUFFICIENT_FUNDS", "Approved funding must cover both the commitment and registration.");
        }
        const funded = yield (0, registrationTransaction_1.fundRegistration)(rpc, snapshot, [
            {
                role: "commitment",
                scriptHex: script.toBuffer().toString("hex"),
                value: "0",
                values: { [snapshot.systemID]: "0" },
            },
        ], quote.commitmentFee, request.funding, request.changeAddress);
        return {
            reservation: record,
            transaction: yield preparedTransaction(rpc, funded, resolved, "commitment", quote.commitmentFee, revealAuthorities, request.changeAddress, request.approvedCosts),
            commitmentVout: 0,
        };
    });
}
function restoreReservation(record) {
    if (!record || record.schemaVersion !== 1 || record.kind !== "advanced")
        throw new registrationPolicy_1.RegistrationError("INVALID_RESERVATION", "Unsupported saved reservation schema.");
    const reservation = verus_typescript_primitives_1.AdvancedNameReservation.fromHex(record.reservationHex);
    reservation.validateForCreation();
    if (reservation.toBuffer().toString("hex") !== record.reservationHex ||
        reservation.getIdentityAddress() !== record.identityAddress ||
        reservation.parent.toAddress() !== record.parentID ||
        reservation.getCommitment().toBuffer().toString("hex") !==
            record.commitmentHashHex) {
        throw new registrationPolicy_1.RegistrationError("RESERVATION_MISMATCH", "Saved reservation metadata differs from its canonical preimage.");
    }
    (0, registrationTransaction_1.destination)(record.controller);
    if (record.authorizationID &&
        !(0, registrationTransaction_1.destination)(record.authorizationID).type.eq(verus_typescript_primitives_1.TxDestination.TYPE_ID))
        throw new registrationPolicy_1.RegistrationError("INVALID_RESERVATION", "Authorization must be an identity.");
    return reservation;
}
function burnOutput(quote) {
    const payment = quote.issuerPayment;
    const transfer = new verus_typescript_primitives_1.ReserveTransfer({
        version: new bn_js_1.default(1),
        flags: new bn_js_1.default(1).or(verus_typescript_primitives_1.RESERVE_TRANSFER_BURN_CHANGE_PRICE),
        values: new verus_typescript_primitives_1.CurrencyValueMap({
            valueMap: new Map([[payment.currencyID, (0, registrationTransaction_1.atomic)(payment.amount)]]),
        }),
        feeCurrencyID: quote.systemID,
        feeAmount: (0, registrationTransaction_1.atomic)(quote.transferFee),
        destCurrencyID: payment.currencyID,
        transferDestination: new verus_typescript_primitives_1.TransferDestination({
            type: verus_typescript_primitives_1.DEST_ID,
            destinationBytes: (0, registrationTransaction_1.destination)(payment.recipient).data.toBuffer(),
        }),
    });
    const dest = new verus_typescript_primitives_1.TxDestination(new verus_typescript_primitives_1.KeyID(verus_typescript_primitives_1.RESERVE_TRANSFER_DESTINATION.destinationBytes));
    const master = new verus_typescript_primitives_1.OptCCParams({
        version: new bn_js_1.default(3),
        evalCode: new bn_js_1.default(verus_typescript_primitives_1.EVALS.EVAL_NONE),
        m: new bn_js_1.default(1),
        n: new bn_js_1.default(1),
        destinations: [dest],
    });
    const condition = new verus_typescript_primitives_1.OptCCParams({
        version: new bn_js_1.default(3),
        evalCode: new bn_js_1.default(verus_typescript_primitives_1.EVALS.EVAL_RESERVE_TRANSFER),
        m: new bn_js_1.default(1),
        n: new bn_js_1.default(1),
        destinations: [dest],
        vData: [transfer.toBuffer()],
    });
    return {
        role: "burn",
        scriptHex: new verus_typescript_primitives_1.SmartTransactionScript(master, condition)
            .toBuffer()
            .toString("hex"),
        value: quote.transferFee,
        values: {
            [quote.systemID]: quote.transferFee,
            [payment.currencyID]: payment.amount,
        },
    };
}
function createIdentityRegistrationTransaction(rpc, request) {
    return __awaiter(this, void 0, void 0, function* () {
        request = snapshotIdentityRegistrationRequest(request);
        const record = request.reservation;
        const reservation = restoreReservation(record);
        const snapshot = yield snapshotForRegistration(rpc, Object.assign(Object.assign({}, record), { expiryDelta: request.expiryDelta }));
        const commitment = yield (0, registrationTransaction_1.readRegistrationPrevout)(rpc, request.commitment, snapshot, true);
        const expectedScript = verus_typescript_primitives_1.IdentityCommitmentScript.fromCommitment(reservation.getCommitment(), (0, registrationTransaction_1.destination)(record.controller), record.authorizationID ? (0, registrationTransaction_1.destination)(record.authorizationID) : undefined)
            .toBuffer()
            .toString("hex");
        if (commitment.scriptHex !== expectedScript)
            throw new registrationPolicy_1.RegistrationError("COMMITMENT_MISMATCH", "Commitment does not match the saved reservation and authorization conditions.");
        // Bind the confirmed outpoint to its active block, not merely a cached height.
        const block = (0, registrationPolicy_1.registrationRpcResult)(yield rpc.getBlock(String(commitment.height), 1), "getblock commitment");
        if (block.height !== commitment.height ||
            block.confirmations !== commitment.confirmations ||
            !Array.isArray(block.tx) ||
            !block.tx.some((tx) => (typeof tx === "string" ? tx : tx.txid) === commitment.txid)) {
            throw new registrationPolicy_1.RegistrationError("COMMITMENT_REORGED", "Commitment is not in the expected active-chain block.");
        }
        const referralID = reservation.referral.toBuffer().equals(Buffer.alloc(20))
            ? undefined
            : reservation.referral.toAddress();
        const policy = yield (0, registrationPolicy_1.resolveIdentityRegistrationPolicy)(rpc, {
            name: record.fullName,
            parent: record.parentID,
            systemID: record.systemID,
            rootSystemName: record.rootSystemName,
            referralID,
            candidateHeight: snapshot.candidateHeight,
            commitmentHeight: commitment.height,
        });
        constrainRegistrationExpiry(snapshot, policy);
        if (policy.resolvedName.name !== reservation.name ||
            policy.resolvedName.identityID !== record.identityAddress ||
            policy.requiredAuthorityID !== record.authorizationID) {
            throw new registrationPolicy_1.RegistrationError("POLICY_CHANGED", "Resolved name or commitment authorization policy changed.");
        }
        const quote = (0, registrationPolicy_1.quoteIdentityRegistration)(policy, { offer: request.offer });
        (0, registrationTransaction_1.requireAmounts)(quote.totalRequired, request.approvedCosts);
        const identity = request.identity instanceof verus_typescript_primitives_1.Identity
            ? new verus_typescript_primitives_1.Identity()
            : (0, verus_typescript_primitives_1.identityFromJSONForRegistration)(request.identity, policy.resolvedName);
        if (request.identity instanceof verus_typescript_primitives_1.Identity)
            identity.fromBuffer(request.identity.toBuffer(), 0, false, record.rootSystemName);
        // Only prune the detached copy. A single zero-length byte value remains valid.
        (0, identityValidation_1.dropEmptyIdentityContent)(identity);
        (0, verus_typescript_primitives_1.validateIdentityForRegistration)(identity, policy.resolvedName);
        (0, identityValidation_1.validateIdentitySize)(identity);
        // This output may pay the identity created atomically by this same reveal.
        yield validateRegistrationChangeAddress(rpc, request.changeAddress, snapshot, record.identityAddress);
        const identityJson = identity.toJson(record.rootSystemName);
        for (const id of new Set([
            identityJson.revocationauthority,
            identityJson.recoveryauthority,
        ])) {
            if (id !== record.identityAddress)
                yield (0, registrationPolicy_1.requireRegistrationIdentity)(rpc, id);
        }
        const revealAuthorities = yield authoritiesFor(rpc, [
            record.controller,
            ...(record.authorizationID ? [record.authorizationID] : []),
        ], snapshot);
        const outputs = [
            {
                role: "identity",
                scriptHex: verus_typescript_primitives_1.IdentityScript.fromIdentity(identity)
                    .toBuffer()
                    .toString("hex"),
                value: "0",
                values: { [record.systemID]: "0" },
            },
        ];
        if (quote.issuerPayment) {
            outputs.push(quote.issuerPayment.kind === "burn"
                ? burnOutput(quote)
                : (0, registrationTransaction_1.paymentOutput)(quote.issuerPayment.recipient, { [quote.issuerPayment.currencyID]: quote.issuerPayment.amount }, record.systemID, "issuer-payment"));
        }
        quote.referralPayments.forEach((payment) => outputs.push((0, registrationTransaction_1.paymentOutput)(payment.recipient, { [payment.currencyID]: payment.amount }, record.systemID, "referral")));
        outputs.push({
            role: "reservation",
            scriptHex: verus_typescript_primitives_1.IdentityReservationScript.fromReservation(reservation)
                .toBuffer()
                .toString("hex"),
            value: "0",
            values: { [record.systemID]: "0" },
        });
        const funded = yield (0, registrationTransaction_1.fundRegistration)(rpc, snapshot, outputs, quote.nativeFee, request.funding, request.changeAddress, commitment);
        return preparedTransaction(rpc, funded, { policy, quote, snapshot }, "registration", quote.nativeFee, revealAuthorities, request.changeAddress, request.approvedCosts, request.commitment);
    });
}
