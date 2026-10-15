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
exports.DEFAULT_COMMITMENT_FEE = exports.REGISTRATION_TRANSFER_FEE = exports.RegistrationError = void 0;
exports.registrationRpcResult = registrationRpcResult;
exports.requireRegistrationIdentity = requireRegistrationIdentity;
exports.assertIdentityRegistrationAvailable = assertIdentityRegistrationAvailable;
exports.resolveIdentityRegistrationPolicy = resolveIdentityRegistrationPolicy;
exports.quoteIdentityRegistration = quoteIdentityRegistration;
const bn_js_1 = __importDefault(require("bn.js"));
const utxo_lib_1 = require("@bitgo/utxo-lib");
const verus_typescript_primitives_1 = require("verus-typescript-primitives");
class RegistrationError extends Error {
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = "RegistrationError";
        Object.setPrototypeOf(this, RegistrationError.prototype);
    }
}
exports.RegistrationError = RegistrationError;
const MAX_AMOUNT = new bn_js_1.default("9223372036854775807");
/** Current GetTransactionTransferFee() in crosschainrpc.h. */
exports.REGISTRATION_TRANSFER_FEE = "20000";
exports.DEFAULT_COMMITMENT_FEE = "10000";
function fail(code, message, details) {
    throw new RegistrationError(code, message, details);
}
function record(value, context) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("INVALID_RPC_RESPONSE", `${context} returned an invalid object`);
    }
    return value;
}
/** Preserve daemon errors; an absent/malformed response is never availability. */
function registrationRpcResult(response, context) {
    const envelope = record(response, context);
    if (envelope.error != null) {
        const error = record(envelope.error, context);
        fail("RPC_ERROR", `${context}: ${String(error.message || "RPC request failed")}`, error);
    }
    if (!Object.prototype.hasOwnProperty.call(envelope, "result")) {
        fail("INVALID_RPC_RESPONSE", `${context} omitted its result`);
    }
    return envelope.result;
}
function identityAddress(address, label) {
    try {
        if ((0, verus_typescript_primitives_1.decodeDestination)(address, verus_typescript_primitives_1.I_ADDR_VERSION).equals(Buffer.alloc(20)))
            throw new Error("null");
    }
    catch (_) {
        fail("INVALID_IDENTITY_ADDRESS", `${label} must be a nonnull identity i-address`);
    }
}
function height(value, label) {
    if (!Number.isSafeInteger(value) || value < 1)
        fail("INVALID_HEIGHT", `${label} must be a positive integer`);
}
function hash(value, label) {
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
        fail("INVALID_RPC_RESPONSE", `${label} must be a 32-byte hexadecimal hash`);
    }
}
function derivedNameID(name, parent) {
    if (parent &&
        (0, verus_typescript_primitives_1.decodeDestination)(parent, verus_typescript_primitives_1.I_ADDR_VERSION).equals(Buffer.alloc(20)))
        parent = undefined;
    return (0, verus_typescript_primitives_1.nameAndParentAddrToIAddr)(name, parent || undefined);
}
function boundIdentity(value, id, label, unrevoked) {
    const identity = record(value, label);
    if (typeof identity.name !== "string" ||
        typeof identity.parent !== "string" ||
        derivedNameID(identity.name, identity.parent) !== id ||
        (identity.identityaddress != null && identity.identityaddress !== id)) {
        fail("LOOKUP_MISMATCH", `${label} identity does not match the requested address`);
    }
    if (!Number.isSafeInteger(identity.flags) || identity.flags < 0) {
        fail("INVALID_RPC_RESPONSE", `${label} omitted valid identity flags`);
    }
    if (unrevoked && (identity.flags & 0x8000) !== 0)
        fail("REVOKED_IDENTITY", `${label} is revoked`);
    return identity;
}
function requireRegistrationIdentity(rpc, id, atHeight) {
    return __awaiter(this, void 0, void 0, function* () {
        identityAddress(id, "Identity");
        const result = record(registrationRpcResult(yield rpc.getIdentity(id, atHeight), "getidentity"), "getidentity");
        return boundIdentity(result.identity, id, "getidentity", true);
    });
}
function assertIdentityRegistrationAvailable(rpc, id) {
    return __awaiter(this, void 0, void 0, function* () {
        identityAddress(id, "Identity");
        const response = record(yield rpc.getIdentity(id), "getidentity");
        // This exact daemon error is the only absence signal. Transport and index
        // errors, malformed success, and revoked identities must stop construction.
        if (response.error &&
            response.error.code === -5 &&
            response.error.message === "Identity not found")
            return;
        const result = record(registrationRpcResult(response, "getidentity"), "getidentity");
        boundIdentity(result.identity, id, "getidentity", false);
        fail("IDENTITY_EXISTS", "The requested identity is already registered");
    });
}
function boundCurrency(value, id) {
    const definition = record(value, "getcurrency");
    if (definition.currencyid !== id)
        fail("LOOKUP_MISMATCH", "Currency definition does not match the requested namespace");
    if (typeof definition.name !== "string" ||
        derivedNameID(definition.name, definition.parent) !== id) {
        fail("LOOKUP_MISMATCH", "Currency name and parent do not derive its requested address");
    }
    identityAddress(definition.systemid, "Currency system");
    if (!Number.isInteger(definition.version) ||
        definition.version < 1 ||
        !Number.isInteger(definition.proofprotocol) ||
        definition.proofprotocol < 1 ||
        !Number.isSafeInteger(definition.endblock) ||
        definition.endblock < 0 ||
        !Number.isSafeInteger(definition.startblock) ||
        definition.startblock < 0) {
        fail("INVALID_RPC_RESPONSE", "Currency definition omitted valid version, proof protocol or block boundaries");
    }
    try {
        verus_typescript_primitives_1.CurrencyIdentityRegistration.fromJSON(definition);
    }
    catch (error) {
        fail("INVALID_CURRENCY_POLICY", `Invalid currency identity policy: ${error.message}`);
    }
    return definition;
}
function readSmart(script) {
    try {
        const parsed = new verus_typescript_primitives_1.SmartTransactionScript();
        parsed.fromBuffer(script);
        return parsed.paramsOptCC.isValid() ? parsed : undefined;
    }
    catch (_) {
        return undefined;
    }
}
function referralHistory(rpc, policy, beforeHeight) {
    return __awaiter(this, void 0, void 0, function* () {
        const id = policy.referralID;
        const historyResponse = record(registrationRpcResult(yield rpc.getIdentityHistory(id, 0, beforeHeight - 1), "getidentityhistory"), "getidentityhistory");
        if (!Array.isArray(historyResponse.history) ||
            !historyResponse.history.length) {
            fail("REFERRAL_HISTORY_UNAVAILABLE", "Referrer original registration history is required");
        }
        const history = historyResponse.history
            .map((entry) => {
            const item = record(entry, "getidentityhistory entry");
            height(item.height, "Referral history height");
            if (item.height >= beforeHeight)
                fail("REFERRAL_TOO_NEW", "Referrer must first register before the commitment block");
            boundIdentity(item.identity, id, "Referral history", false);
            return item;
        })
            .sort((a, b) => { var _a, _b; return a.height - b.height || ((_a = a.output) === null || _a === void 0 ? void 0 : _a.voutnum) - ((_b = b.output) === null || _b === void 0 ? void 0 : _b.voutnum); });
        // The earliest entry must be a verifiable creation, not an update returned
        // by a pruned index. Import-only histories need separate protocol handling.
        const first = history[0];
        const output = record(first.output, "Referral history output");
        hash(output.txid, "Referral transaction ID");
        hash(first.blockhash, "Referral block hash");
        if (!Number.isSafeInteger(output.voutnum) || output.voutnum < 0)
            fail("INVALID_RPC_RESPONSE", "Invalid referral identity output index");
        const responses = yield Promise.all([
            rpc.getRawTransaction(output.txid, 0),
            rpc.getBlock(first.blockhash, 1),
        ]);
        const raw = registrationRpcResult(responses[0], "getrawtransaction");
        if (typeof raw !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(raw))
            fail("INVALID_RPC_RESPONSE", "Referral raw transaction must be hexadecimal bytes");
        let tx;
        try {
            tx = utxo_lib_1.Transaction.fromHex(raw, utxo_lib_1.networks.verus);
        }
        catch (_) {
            fail("INVALID_REFERRAL_HISTORY", "Cannot decode the original referral transaction");
        }
        if (tx.getId() !== output.txid || output.voutnum >= tx.outs.length) {
            fail("LOOKUP_MISMATCH", "Referrer raw transaction does not match its history outpoint");
        }
        const block = record(registrationRpcResult(responses[1], "getblock"), "getblock");
        if (block.hash !== first.blockhash ||
            block.height !== first.height ||
            !Number.isInteger(block.confirmations) ||
            block.confirmations < 1 ||
            !Array.isArray(block.tx) ||
            !block.tx.some((entry) => (typeof entry === "string" ? entry : entry === null || entry === void 0 ? void 0 : entry.txid) ===
                output.txid)) {
            fail("REFERRAL_NOT_CONFIRMED", "Referrer creation must belong to the reported active-chain block");
        }
        let original;
        try {
            const identityScript = new verus_typescript_primitives_1.IdentityScript();
            identityScript.fromBuffer(tx.outs[output.voutnum].script);
            original = identityScript.getIdentity();
        }
        catch (_) {
            fail("INVALID_REFERRAL_HISTORY", "Referrer history does not point to an identity output");
        }
        if (original.getIdentityAddress() !== id ||
            original.systemId.toAddress() !== policy.resolvedName.systemID ||
            (original.parent.toAddress() !== policy.resolvedName.parent &&
                id !== policy.resolvedName.parent)) {
            fail("LOOKUP_MISMATCH", "Original referrer identity has the wrong address, parent, or system");
        }
        const evidence = {
            identityID: id,
            firstHeight: first.height,
            blockHash: first.blockhash,
            txid: output.txid,
            identityVout: output.voutnum,
        };
        // LookupFirstIdentity's block-one exception is for PBaaS chains only. Avoid
        // interpreting imported/root definitions as ordinary paid registrations.
        if (first.height === 1 &&
            policy.nativeDefinition.parent &&
            !(0, verus_typescript_primitives_1.decodeDestination)(policy.nativeDefinition.parent, verus_typescript_primitives_1.I_ADDR_VERSION).equals(Buffer.alloc(20))) {
            return { recipients: [id], evidence };
        }
        const sourceReferrals = [];
        let afterPayment = policy.branch === "native";
        let foundReservation = false;
        for (let index = output.voutnum + 1; index < tx.outs.length; index++) {
            const parsed = readSmart(tx.outs[index].script);
            if (!parsed)
                fail("INVALID_REFERRAL_HISTORY", "Unexpected output inside original referral registration");
            const params = parsed.paramsOptCC;
            const evalCode = params.evalCode.toNumber();
            if (evalCode === verus_typescript_primitives_1.EVALS.EVAL_IDENTITY_RESERVATION ||
                evalCode === verus_typescript_primitives_1.EVALS.EVAL_IDENTITY_ADVANCEDRESERVATION) {
                try {
                    const reservation = new verus_typescript_primitives_1.IdentityReservationScript();
                    reservation.fromBuffer(tx.outs[index].script);
                    if (reservation.getIdentityAddress(original.parent.toAddress(), policy.resolvedName.rootSystemName) !== id)
                        throw new Error("wrong identity");
                    if (reservation.getReservation().name !== original.name)
                        throw new Error("wrong name");
                }
                catch (_) {
                    fail("INVALID_REFERRAL_HISTORY", "Original referral reservation does not match its identity");
                }
                evidence.reservationVout = index;
                foundReservation = true;
                break;
            }
            if (!afterPayment) {
                const expected = policy.branch === "token-payment"
                    ? verus_typescript_primitives_1.EVALS.EVAL_RESERVE_OUTPUT
                    : verus_typescript_primitives_1.EVALS.EVAL_RESERVE_TRANSFER;
                if (evalCode !== expected)
                    fail("UNSUPPORTED_REFERRAL_HISTORY", "Original referral payment branch differs from the current namespace");
                afterPayment = true;
                continue;
            }
            if (evalCode !==
                (policy.branch === "native"
                    ? verus_typescript_primitives_1.EVALS.EVAL_NONE
                    : verus_typescript_primitives_1.EVALS.EVAL_RESERVE_OUTPUT) ||
                params.destinations.length !== 1 ||
                !params.destinations[0].type.eqn(4) ||
                !params.m.eqn(1) ||
                !params.n.eqn(1)) {
                fail("INVALID_REFERRAL_HISTORY", "Original referral payments must be ordered identity outputs");
            }
            if (policy.branch !== "native") {
                try {
                    const token = new verus_typescript_primitives_1.TokenOutput();
                    const data = params.getParamObject();
                    if (token.fromBuffer(data) !== data.length ||
                        !token.isValid() ||
                        token.reserveValues.valueMap.size !== 1 ||
                        token.firstCurrency() !== policy.issuerID)
                        throw new Error("wrong currency");
                }
                catch (_) {
                    fail("INVALID_REFERRAL_HISTORY", "Original referral payment has the wrong reserve currency");
                }
            }
            sourceReferrals.push(params.destinations[0].toAddress());
        }
        if (!foundReservation)
            fail("REFERRAL_HISTORY_UNAVAILABLE", "Referrer history does not include its original reservation transaction");
        const levels = verus_typescript_primitives_1.CurrencyIdentityRegistration.fromJSON(policy.parentDefinition).getIDReferralLevels();
        // These edge branches differ between the RPC and activated consensus traversal.
        if ((levels === 1 || id === policy.resolvedName.parent) &&
            sourceReferrals.length) {
            fail("UNSUPPORTED_REFERRAL_HISTORY", "This referral ancestry requires an unsupported activation-dependent traversal");
        }
        return {
            recipients: [id, ...sourceReferrals.slice(0, levels - 1)],
            evidence,
        };
    });
}
/** Resolve current PBaaS-era native and plain-token namespace policy. */
function resolveIdentityRegistrationPolicy(rpc, request) {
    return __awaiter(this, void 0, void 0, function* () {
        height(request.candidateHeight, "Candidate height");
        if (request.commitmentHeight != null) {
            height(request.commitmentHeight, "Commitment height");
            if (request.commitmentHeight >= request.candidateHeight)
                fail("COMMITMENT_NOT_CONFIRMED", "Commitment must be in a prior block");
        }
        const resolvedName = (0, verus_typescript_primitives_1.resolveIdentityRegistrationName)(request);
        const [parentResponse, nativeResponse] = yield Promise.all([
            rpc.getCurrency(resolvedName.parent),
            rpc.getCurrency(request.systemID),
        ]);
        const parentDefinition = boundCurrency(registrationRpcResult(parentResponse, "getcurrency parent"), resolvedName.parent);
        const nativeDefinition = boundCurrency(registrationRpcResult(nativeResponse, "getcurrency native"), request.systemID);
        if (nativeDefinition.systemid !== request.systemID)
            fail("LOOKUP_MISMATCH", "Selected native currency belongs to another system");
        const parent = verus_typescript_primitives_1.CurrencyIdentityRegistration.fromJSON(parentDefinition);
        if (parent.noIDs())
            fail("NAMESPACE_DISALLOWS_IDENTITIES", "The selected currency does not permit identities");
        if (parent.isFractional() ||
            parent.isGateway() ||
            parent.isGatewayConverter() ||
            parentDefinition.gatewayconverterid) {
            fail("UNSUPPORTED_NAMESPACE", "Fractional and gateway identity pricing is not supported");
        }
        if (parentDefinition.systemid !== request.systemID)
            fail("WRONG_REGISTRATION_SYSTEM", "The selected namespace registers identities on another system");
        const native = resolvedName.parent === request.systemID;
        if (!native && !parent.isToken())
            fail("UNSUPPORTED_NAMESPACE", "Only native and plain token namespaces are supported");
        if (parentDefinition.proofprotocol !== 1 &&
            parentDefinition.proofprotocol !== 2) {
            fail("UNSUPPORTED_NAMESPACE", "This currency proof protocol does not support the implemented identity payment branches");
        }
        // RPC uses tip height and consensus uses candidate height around endBlock.
        if (parentDefinition.endblock &&
            request.candidateHeight === parentDefinition.endblock) {
            fail("UNSUPPORTED_POLICY_BOUNDARY", "Registration at the currency end-block boundary requires a refreshed quote");
        }
        const chainIDPayment = parentDefinition.proofprotocol === 2 &&
            (!parentDefinition.endblock ||
                request.candidateHeight < parentDefinition.endblock);
        if (native && chainIDPayment)
            fail("UNSUPPORTED_NAMESPACE", "Native PROOF_CHAINID registration accounting is not supported");
        const policy = {
            resolvedName,
            branch: native ? "native" : chainIDPayment ? "token-payment" : "token-burn",
            candidateHeight: request.candidateHeight,
            commitmentHeight: request.commitmentHeight,
            parentDefinition,
            nativeDefinition,
            issuerID: resolvedName.parent,
            feePricingCurrencyID: resolvedName.parent,
            referralID: request.referralID,
            referralRecipients: [],
        };
        if (parent.IDReferralRequired() &&
            !parent.IDRequiresPermission() &&
            !request.referralID) {
            fail("REFERRAL_REQUIRED", "This namespace requires a referring identity signature");
        }
        if (request.referralID) {
            identityAddress(request.referralID, "Referrer");
            const beforeHeight = request.commitmentHeight || request.candidateHeight;
            if (beforeHeight < 2)
                fail("REFERRAL_TOO_NEW", "A referrer must exist in a block before the commitment");
            const identity = yield requireRegistrationIdentity(rpc, request.referralID, request.commitmentHeight ? beforeHeight - 1 : undefined);
            if ((identity.parent !== resolvedName.parent &&
                request.referralID !== resolvedName.parent) ||
                identity.systemid !== request.systemID) {
                fail("INVALID_REFERRAL", "Referrer must belong to the registration system and namespace");
            }
            if (parent.getIDReferralLevels()) {
                if (!parent.IDReferrals())
                    fail("UNSUPPORTED_REFERRAL_POLICY", "Referral-required namespaces with nonzero levels but no economic referrals are unsupported");
                const evidence = yield referralHistory(rpc, policy, beforeHeight);
                policy.referralRecipients = evidence.recipients;
                policy.referralEvidence = evidence.evidence;
            }
        }
        policy.requiredAuthorityID = parent.IDRequiresPermission()
            ? resolvedName.parent
            : parent.IDReferralRequired()
                ? request.referralID
                : undefined;
        if (policy.requiredAuthorityID) {
            policy.requiredAuthority = yield requireRegistrationIdentity(rpc, policy.requiredAuthorityID);
            if (policy.requiredAuthority.systemid !== request.systemID)
                fail("WRONG_REGISTRATION_SYSTEM", "Required signing authority belongs to another system");
        }
        yield assertIdentityRegistrationAvailable(rpc, resolvedName.identityID);
        return policy;
    });
}
function atomic(value, label) {
    if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value))
        fail("INVALID_AMOUNT", `${label} must be a nonnegative atomic integer string`);
    const amount = new bn_js_1.default(value);
    if (amount.gt(MAX_AMOUNT))
        fail("INVALID_AMOUNT", `${label} exceeds signed 64-bit range`);
    return amount;
}
/** Amounts remain integer strings across persistence/UI boundaries. */
function quoteIdentityRegistration(policy, options = {}) {
    const parent = verus_typescript_primitives_1.CurrencyIdentityRegistration.fromJSON(policy.parentDefinition);
    const native = verus_typescript_primitives_1.CurrencyIdentityRegistration.fromJSON(policy.nativeDefinition);
    const commitmentFee = atomic(options.commitmentFee == null
        ? exports.DEFAULT_COMMITMENT_FEE
        : options.commitmentFee, "Commitment fee");
    const economicReferral = !!policy.referralID && parent.getIDReferralLevels() > 0;
    if (economicReferral && !policy.referralRecipients.length)
        fail("REFERRAL_HISTORY_UNAVAILABLE", "Cannot quote referral discounts without ordered history");
    const minimum = economicReferral
        ? parent.IDReferredRegistrationAmount()
        : parent.IDFullRegistrationAmount();
    const offer = options.offer == null
        ? minimum
        : atomic(options.offer, "Registration offer");
    if (offer.lt(minimum))
        fail("INSUFFICIENT_REGISTRATION_OFFER", "Registration offer is below the required namespace price");
    const referralAmount = economicReferral
        ? parent.IDReferralAmount()
        : new bn_js_1.default(0);
    const remainder = offer.sub(referralAmount.muln(policy.referralRecipients.length));
    if (remainder.isNeg())
        fail("INVALID_REFERRAL_POLICY", "Referral payments exceed the registration offer");
    const nativeFee = policy.branch === "native" ? remainder : native.IDImportFee();
    if (nativeFee.isNeg())
        fail("INVALID_CURRENCY_POLICY", "Native import fee cannot be negative");
    const transferFee = policy.branch === "token-burn"
        ? new bn_js_1.default(exports.REGISTRATION_TRANSFER_FEE)
        : new bn_js_1.default(0);
    const total = {};
    total[policy.resolvedName.systemID] =
        policy.branch === "native"
            ? offer.toString(10)
            : nativeFee.add(transferFee).toString(10);
    if (policy.branch !== "native")
        total[policy.issuerID] = offer.toString(10);
    const operationTotal = Object.assign({}, total);
    operationTotal[policy.resolvedName.systemID] = new bn_js_1.default(total[policy.resolvedName.systemID])
        .add(commitmentFee)
        .toString(10);
    Object.values(operationTotal).forEach((amount) => atomic(amount, "Total registration requirement"));
    return {
        branch: policy.branch,
        systemID: policy.resolvedName.systemID,
        parentID: policy.resolvedName.parent,
        issuerID: policy.issuerID,
        feePricingCurrencyID: policy.feePricingCurrencyID,
        candidateHeight: policy.candidateHeight,
        commitmentFee: commitmentFee.toString(10),
        registrationOffer: offer.toString(10),
        nativeFee: nativeFee.toString(10),
        importFee: policy.branch === "native" ? "0" : nativeFee.toString(10),
        transferFee: transferFee.toString(10),
        issuerPayment: policy.branch === "native"
            ? undefined
            : {
                currencyID: policy.issuerID,
                recipient: policy.issuerID,
                amount: remainder.toString(10),
                kind: policy.branch === "token-burn" ? "burn" : "payment",
            },
        referralPayments: policy.referralRecipients.map((recipient) => ({
            currencyID: policy.issuerID,
            recipient,
            amount: referralAmount.toString(10),
        })),
        totalRequired: total,
        totalOperationRequired: operationTotal,
    };
}
