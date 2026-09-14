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
const verus_typescript_primitives_1 = require("verus-typescript-primitives");
const verusd_rpc_ts_client_1 = require("verusd-rpc-ts-client");
const utxo_lib_1 = require("@bitgo/utxo-lib");
const bignumber_js_1 = __importDefault(require("bignumber.js"));
const bn_js_1 = require("bn.js");
const { createUnfundedIdentityUpdate, validateFundedCurrencyTransfer, completeFundedIdentityUpdate } = utxo_lib_1.smarttxs;
const VRSC_I_ADDRESS = "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV";
const ID_SIG_VERSION = 2;
const ID_SIG_TYPE = 5;
const LOGIN_CONSENT_SIG_TIME_DIFF_THRESHOLD = 3600;
const BN_TYPE_REF = new bn_js_1.BN(0, 10);
const RESERVE_TRANSFER_DEFAULT_PER_STEP_FEE = new bn_js_1.BN(10000, 10);
const RESERVE_TRANSFER_DESTINATION_BYTE_DIVISOR = 128;
class VerusIdInterface {
    constructor(chain, baseURL, config, rpcRequestOverride, APIAuth) {
        this.createGenericRequest = (params, primaryAddrWif, getIdentityResult, currentHeight, chainIAddr) => this.createGenericEnvelope(verus_typescript_primitives_1.GenericRequest, params, primaryAddrWif, getIdentityResult, currentHeight, chainIAddr);
        this.createGenericResponse = (params, primaryAddrWif, getIdentityResult, currentHeight, chainIAddr) => this.createGenericEnvelope(verus_typescript_primitives_1.GenericResponse, params, primaryAddrWif, getIdentityResult, currentHeight, chainIAddr);
        this.signGenericRequest = (this.signGenericEnvelope);
        this.signGenericResponse = (this.signGenericEnvelope);
        this.verifyGenericRequest = (envelope_1, getIdentityResult_1, chainIAddr_1, sigBlockTime_1, ...args_1) => __awaiter(this, [envelope_1, getIdentityResult_1, chainIAddr_1, sigBlockTime_1, ...args_1], void 0, function* (envelope, getIdentityResult, chainIAddr, sigBlockTime, acceptUnsigned = false) {
            if (!VerusIdInterface.validateUnsignedGenericRequest(envelope))
                return false;
            if (acceptUnsigned && !envelope.isSigned()) {
                return true;
            }
            return this.verifyGenericEnvelope(envelope, getIdentityResult, chainIAddr, sigBlockTime);
        });
        this.verifyGenericResponse = (this.verifyGenericEnvelope);
        this.interface = new verusd_rpc_ts_client_1.VerusdRpcInterface(chain, baseURL, config, rpcRequestOverride, APIAuth);
    }
    getCurrentHeight() {
        return __awaiter(this, void 0, void 0, function* () {
            const _infores = yield this.interface.getInfo();
            if (_infores.error)
                throw new Error(_infores.error.message);
            const info = _infores.result;
            return info.longestchain;
        });
    }
    getChainId() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.interface.chain === "VRSC" || this.interface.chain === VRSC_I_ADDRESS) {
                return VRSC_I_ADDRESS;
            }
            else {
                const _currres = yield this.interface.getCurrency(this.interface.chain);
                if (_currres.error)
                    throw new Error(_currres.error.message);
                return _currres.result.currencyid;
            }
        });
    }
    signMessage(iAddrOrIdentity, message, primaryAddrWif, getIdentityResult, currentHeight, chainIAddr) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.signHashOrMessage(iAddrOrIdentity, message, primaryAddrWif, getIdentityResult, currentHeight, chainIAddr);
        });
    }
    signHash(iAddrOrIdentity, hash, primaryAddrWif, getIdentityResult, currentHeight, chainIAddr) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.signHashOrMessage(iAddrOrIdentity, hash, primaryAddrWif, getIdentityResult, currentHeight, chainIAddr);
        });
    }
    signHashOrMessage(iAddrOrIdentity, hashOrMessage, primaryAddrWif, getIdentityResult, currentHeight, chainIAddr) {
        return __awaiter(this, void 0, void 0, function* () {
            let identity;
            let height;
            let chainId;
            if (getIdentityResult != null) {
                identity = getIdentityResult;
            }
            else {
                const _idres = yield this.interface.getIdentity(iAddrOrIdentity);
                if (_idres.error)
                    throw new Error(_idres.error.message);
                identity = _idres.result;
            }
            if (identity.status !== "active") {
                throw new Error("Cannot create a valid signature for a revoked identity");
            }
            if (currentHeight != null) {
                height = currentHeight;
            }
            else {
                height = yield this.getCurrentHeight();
            }
            if (chainIAddr != null) {
                chainId = chainIAddr;
            }
            else {
                chainId = yield this.getChainId();
            }
            const keyPair = utxo_lib_1.ECPair.fromWIF(primaryAddrWif, utxo_lib_1.networks.verus);
            const sig = new utxo_lib_1.IdentitySignature(utxo_lib_1.networks.verus, ID_SIG_VERSION, ID_SIG_TYPE, height, null, chainId, identity.identity.identityaddress);
            if (Buffer.isBuffer(hashOrMessage)) {
                sig.signHashOffline(hashOrMessage, keyPair);
            }
            else {
                sig.signMessageOffline(hashOrMessage, keyPair);
            }
            return sig.toBuffer().toString("base64");
        });
    }
    verifyMessage(iAddrOrIdentity, base64Sig, message, getIdentityResult, chainIAddr) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.verifyHashOrMessage(iAddrOrIdentity, base64Sig, message, getIdentityResult, chainIAddr);
        });
    }
    verifyHash(iAddrOrIdentity, base64Sig, hash, getIdentityResult, chainIAddr) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.verifyHashOrMessage(iAddrOrIdentity, base64Sig, hash, getIdentityResult, chainIAddr);
        });
    }
    verifyHashOrMessage(iAddrOrIdentity, base64Sig, hashOrMessage, getIdentityResult, chainIAddr) {
        return __awaiter(this, void 0, void 0, function* () {
            let iAddress;
            let identityAtHeight;
            let chainId;
            try {
                utxo_lib_1.address.fromBase58Check(iAddrOrIdentity);
                iAddress = iAddrOrIdentity;
            }
            catch (e) {
                const _idres = yield this.interface.getIdentity(iAddrOrIdentity);
                if (_idres.error)
                    throw new Error(_idres.error.message);
                const identity = _idres.result;
                iAddress = identity.identity.identityaddress;
            }
            const sig = new utxo_lib_1.IdentitySignature(utxo_lib_1.networks.verus);
            if (chainIAddr != null)
                chainId = chainIAddr;
            else
                chainId = yield this.getChainId();
            sig.fromBuffer(Buffer.from(base64Sig, "base64"), 0, chainId, iAddress);
            if (getIdentityResult != null) {
                identityAtHeight = getIdentityResult;
            }
            else {
                const _idresatheight = yield this.interface.getIdentity(iAddrOrIdentity, sig.blockHeight);
                if (_idresatheight.error)
                    throw new Error(_idresatheight.error.message);
                identityAtHeight = _idresatheight.result;
            }
            if (identityAtHeight.status !== "active") {
                return false;
            }
            const primaryAddresses = identityAtHeight.identity.primaryaddresses;
            const minsigs = identityAtHeight.identity.minimumsignatures;
            let sigs = 0;
            let signedBy = {};
            for (let j = 0; j < primaryAddresses.length; j++) {
                const signingAddress = primaryAddresses[j];
                if (signedBy[signingAddress])
                    continue;
                const sigRes = Buffer.isBuffer(hashOrMessage)
                    ? sig.verifyHashOffline(hashOrMessage, signingAddress)
                    : sig.verifyMessageOffline(hashOrMessage, signingAddress);
                if (sigRes.some((x) => x === true)) {
                    signedBy[signingAddress] = true;
                }
            }
            for (const key of Object.keys(signedBy)) {
                if (signedBy[key]) {
                    sigs += 1;
                }
                if (sigs == minsigs)
                    return true;
            }
            return false;
        });
    }
    getSignatureInfo(iAddrOrIdentity, base64Sig, chainIAddr) {
        return __awaiter(this, void 0, void 0, function* () {
            let iAddress;
            let chainId;
            try {
                utxo_lib_1.address.fromBase58Check(iAddrOrIdentity);
                iAddress = iAddrOrIdentity;
            }
            catch (e) {
                const _idres = yield this.interface.getIdentity(iAddrOrIdentity);
                if (_idres.error)
                    throw new Error(_idres.error.message);
                const identity = _idres.result;
                iAddress = identity.identity.identityaddress;
            }
            if (chainIAddr != null)
                chainId = chainIAddr;
            else
                chainId = yield this.getChainId();
            const sig = new utxo_lib_1.IdentitySignature(utxo_lib_1.networks.verus);
            sig.fromBuffer(Buffer.from(base64Sig, "base64"), 0, chainId, iAddress);
            return {
                version: sig.version,
                hashtype: sig.hashType,
                height: sig.blockHeight,
            };
        });
    }
    /**
     * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
     */
    signLoginConsentRequest(request, primaryAddrWif, getIdentityResult, currentHeight) {
        return __awaiter(this, void 0, void 0, function* () {
            let height = currentHeight;
            if (height == null) {
                height = yield this.getCurrentHeight();
            }
            const sig = yield this.signHash(request.signing_id, request.getChallengeHash(height), primaryAddrWif, getIdentityResult, height, request.system_id);
            request.signature = new verus_typescript_primitives_1.VerusIDSignature({ signature: sig }, verus_typescript_primitives_1.IDENTITY_AUTH_SIG_VDXF_KEY);
            return request;
        });
    }
    /**
     * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
     */
    createLoginConsentRequest(signingId, challenge, primaryAddrWif, getIdentityResult, currentHeight, chainIAddr) {
        return __awaiter(this, void 0, void 0, function* () {
            let chainId;
            if (chainIAddr != null)
                chainId = chainIAddr;
            else
                chainId = yield this.getChainId();
            const req = new verus_typescript_primitives_1.LoginConsentRequest({
                system_id: chainId,
                signing_id: signingId,
                challenge,
            });
            if (primaryAddrWif) {
                return this.signLoginConsentRequest(req, primaryAddrWif, getIdentityResult, currentHeight);
            }
            else
                return req;
        });
    }
    /**
     * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
     */
    verifyLoginConsentRequest(request, getIdentityResult, chainIAddr, sigBlockTime) {
        return __awaiter(this, void 0, void 0, function* () {
            const sigInfo = yield this.getSignatureInfo(request.signing_id, request.signature.signature, chainIAddr);
            let blocktime;
            if (sigBlockTime)
                blocktime = sigBlockTime;
            else {
                const _blockres = yield this.interface.getBlock(sigInfo.height.toString());
                if (_blockres.error)
                    throw new Error(_blockres.error.message);
                blocktime = _blockres.result.time;
            }
            if ((0, bignumber_js_1.default)(blocktime)
                .minus(request.challenge.created_at)
                .abs()
                .isGreaterThan(LOGIN_CONSENT_SIG_TIME_DIFF_THRESHOLD)) {
                return false;
            }
            return this.verifyHash(request.signing_id, request.signature.signature, request.getChallengeHash(sigInfo.height), getIdentityResult, chainIAddr);
        });
    }
    /**
     * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
     */
    signLoginResponse(response, primaryAddrWif, getIdentityResult, currentHeight) {
        return __awaiter(this, void 0, void 0, function* () {
            let height = currentHeight;
            if (height == null) {
                height = yield this.getCurrentHeight();
            }
            const sig = yield this.signHash(response.signing_id, response.getDecisionHash(height), primaryAddrWif, getIdentityResult, height, response.system_id);
            response.signature = new verus_typescript_primitives_1.VerusIDSignature({ signature: sig }, verus_typescript_primitives_1.LOGIN_CONSENT_RESPONSE_SIG_VDXF_KEY);
            return response;
        });
    }
    /**
     * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
     */
    createLoginResponse(signingId, decision, primaryAddrWif, getIdentityResult, currentHeight, chainIAddr) {
        return __awaiter(this, void 0, void 0, function* () {
            let chainId;
            if (chainIAddr != null)
                chainId = chainIAddr;
            else
                chainId = yield this.getChainId();
            const req = decision instanceof verus_typescript_primitives_1.LoginConsentProvisioningDecision
                ? new verus_typescript_primitives_1.LoginConsentProvisioningResponse({
                    system_id: chainId,
                    signing_id: signingId,
                    decision: decision,
                })
                : new verus_typescript_primitives_1.LoginConsentResponse({
                    system_id: chainId,
                    signing_id: signingId,
                    decision: decision,
                });
            if (primaryAddrWif) {
                return this.signLoginConsentResponse(req, primaryAddrWif, getIdentityResult, currentHeight);
            }
            else
                return req;
        });
    }
    /**
     * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
     */
    verifyResponse(response, getIdentityResult, chainIAddr) {
        return __awaiter(this, void 0, void 0, function* () {
            const sigInfo = yield this.getSignatureInfo(response.signing_id, response.signature.signature, chainIAddr);
            return this.verifyHash(response.signing_id, response.signature.signature, response.getDecisionHash(sigInfo.height), getIdentityResult, chainIAddr);
        });
    }
    /**
     * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
     */
    verifySignedSessionObject(object, getIdentityResult, chainIAddr) {
        return __awaiter(this, void 0, void 0, function* () {
            const sigInfo = yield this.getSignatureInfo(object.signing_id, object.signature.signature, chainIAddr);
            return this.verifyHash(object.signing_id, object.signature.signature, object.getDataHash(sigInfo.height), getIdentityResult, chainIAddr);
        });
    }
    /**
     * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
     */
    signSessionObject(object, primaryAddrWif, getIdentityResult, currentHeight) {
        return __awaiter(this, void 0, void 0, function* () {
            let height = currentHeight;
            if (height == null) {
                height = yield this.getCurrentHeight();
            }
            const sig = yield this.signHash(object.signing_id, object.getDataHash(height), primaryAddrWif, getIdentityResult, height, object.system_id);
            object.signature = new verus_typescript_primitives_1.VerusIDSignature({ signature: sig }, verus_typescript_primitives_1.LOGIN_CONSENT_RESPONSE_SIG_VDXF_KEY);
            return object;
        });
    }
    /**
     * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
     */
    createSignedSessionObject(signingId, data, primaryAddrWif, getIdentityResult, currentHeight, chainIAddr) {
        return __awaiter(this, void 0, void 0, function* () {
            let chainId;
            if (chainIAddr != null)
                chainId = chainIAddr;
            else
                chainId = yield this.getChainId();
            const object = new verus_typescript_primitives_1.SignedSessionObject({
                signing_id: signingId,
                data,
                system_id: chainId
            });
            if (primaryAddrWif) {
                return this.signSessionObject(object, primaryAddrWif, getIdentityResult, currentHeight);
            }
            else
                return object;
        });
    }
    /**
     * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
     */
    signLoginConsentResponse(response, primaryAddrWif, getIdentityResult, currentHeight) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.signLoginResponse(response, primaryAddrWif, getIdentityResult, currentHeight);
        });
    }
    /**
     * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
     */
    createLoginConsentResponse(signingId, decision, primaryAddrWif, getIdentityResult, currentHeight, chainIAddr) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.createLoginResponse(signingId, decision, primaryAddrWif, getIdentityResult, currentHeight, chainIAddr);
        });
    }
    /**
     * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
     */
    verifyLoginConsentResponse(response, getIdentityResult, chainIAddr) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.verifyResponse(response, getIdentityResult, chainIAddr);
        });
    }
    /**
     * @deprecated Legacy VerusPay implementation, use GenericRequest class with invoice objects in details array
     */
    createVerusPayInvoice(details, signingIdIAddr, primaryAddrWif, getIdentityResult, currentHeight, chainIAddr) {
        return __awaiter(this, void 0, void 0, function* () {
            let chainId;
            if (chainIAddr != null)
                chainId = chainIAddr;
            else
                chainId = yield this.getChainId();
            const inv = new verus_typescript_primitives_1.VerusPayInvoice({
                details: details,
                version: verus_typescript_primitives_1.VERUSPAY_VERSION_3
            });
            if (signingIdIAddr && primaryAddrWif) {
                return this.signVerusPayInvoice(inv, signingIdIAddr, chainId, primaryAddrWif, getIdentityResult, currentHeight);
            }
            else
                return inv;
        });
    }
    /**
     * @deprecated Legacy VerusPay implementation, use GenericRequest class with invoice objects in details array
     */
    signVerusPayInvoice(invoice, signingIdIAddr, systemIdIAddr, primaryAddrWif, getIdentityResult, currentHeight) {
        return __awaiter(this, void 0, void 0, function* () {
            let height = currentHeight;
            if (height == null) {
                height = yield this.getCurrentHeight();
            }
            invoice.setSigned();
            invoice.signing_id = signingIdIAddr;
            invoice.system_id = systemIdIAddr;
            const sig = yield this.signHash(signingIdIAddr, invoice.getDetailsHash(height), primaryAddrWif, getIdentityResult, height, systemIdIAddr);
            invoice.signature = new verus_typescript_primitives_1.VerusIDSignature({ signature: sig }, verus_typescript_primitives_1.IDENTITY_AUTH_SIG_VDXF_KEY, false);
            return invoice;
        });
    }
    /**
     * @deprecated Legacy VerusPay implementation, use GenericRequest class with invoice objects in details array
     */
    verifySignedVerusPayInvoice(invoice, getIdentityResult, chainIAddr) {
        return __awaiter(this, void 0, void 0, function* () {
            const sigInfo = yield this.getSignatureInfo(invoice.signing_id, invoice.signature.signature, chainIAddr);
            return this.verifyHash(invoice.signing_id, invoice.signature.signature, invoice.getDetailsHash(sigInfo.height, sigInfo.version), getIdentityResult, chainIAddr);
        });
    }
    signVerusIdProvisioningResponse(response, primaryAddrWif, getIdentityResult, currentHeight) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.signLoginResponse(response, primaryAddrWif, getIdentityResult, currentHeight);
        });
    }
    createVerusIdProvisioningResponse(signingId, decision, primaryAddrWif, getIdentityResult, currentHeight, chainIAddr) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.createLoginResponse(signingId, decision, primaryAddrWif, getIdentityResult, currentHeight, chainIAddr);
        });
    }
    verifyVerusIdProvisioningResponse(response, getIdentityResult, chainIAddr) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.verifyResponse(response, getIdentityResult, chainIAddr);
        });
    }
    static signHashWithAddress(hash, wif) {
        const keyPair = utxo_lib_1.ECPair.fromWIF(wif, utxo_lib_1.networks.verus);
        const sig = new utxo_lib_1.IdentitySignature(utxo_lib_1.networks.verus);
        return sig.signHashOffline(hash, keyPair).toString("base64");
    }
    static signVerusIdProvisioningRequest(request, addrWif) {
        return __awaiter(this, void 0, void 0, function* () {
            const sig = VerusIdInterface.signHashWithAddress(request.getChallengeHash(), addrWif);
            request.signature = new verus_typescript_primitives_1.VerusIDSignature({ signature: sig }, verus_typescript_primitives_1.IDENTITY_AUTH_SIG_VDXF_KEY);
            return request;
        });
    }
    static createVerusIdProvisioningRequest(signingAddress, challenge, addrWif) {
        return __awaiter(this, void 0, void 0, function* () {
            const req = new verus_typescript_primitives_1.LoginConsentProvisioningRequest({
                signing_address: signingAddress,
                challenge,
            });
            if (addrWif) {
                return VerusIdInterface.signVerusIdProvisioningRequest(req, addrWif);
            }
            else
                return req;
        });
    }
    static verifyVerusIdProvisioningRequest(request, address) {
        return __awaiter(this, void 0, void 0, function* () {
            const sig = new utxo_lib_1.IdentitySignature(utxo_lib_1.networks.verus, ID_SIG_VERSION, ID_SIG_TYPE, null, [Buffer.from(request.signature.signature, "base64")]);
            return sig.verifyHashOffline(request.getChallengeHash(), address)[0];
        });
    }
    static getIdentityFromIdTx(transaction, idAddr, parseVdxfObjects, strict = false) {
        let index = -1;
        let id = null;
        for (let i = 0; i < transaction.outs.length; i++) {
            const decomp = (0, verus_typescript_primitives_1.decompile)(transaction.outs[i].script);
            if (decomp.length !== 4 || decomp[1] !== verus_typescript_primitives_1.OPS.OP_CHECKCRYPTOCONDITION || decomp[3] !== verus_typescript_primitives_1.OPS.OP_DROP) {
                if (strict)
                    throw new Error("Unknown script format output found in transaction");
                continue;
            }
            const outMaster = verus_typescript_primitives_1.OptCCParams.fromChunk(decomp[0]);
            const outParams = verus_typescript_primitives_1.OptCCParams.fromChunk(decomp[2]);
            if (!outMaster.evalCode.eq(new bn_js_1.BN(verus_typescript_primitives_1.EVALS.EVAL_NONE))) {
                if (strict)
                    throw new Error("Unsupported master eval code " + outMaster.evalCode.toNumber() + " found in transaction output");
                continue;
            }
            // Notary evidence eval codes are supported even in strict mode to allow for data included in the transaction as a result of
            // a signdata style updateidentity request. The data itself isn't verified and must be clearly displayed to the user, or the app
            // must verify that the key the data is under is indeed in the request signer's namespace
            if (!outParams.evalCode.eq(new bn_js_1.BN(verus_typescript_primitives_1.EVALS.EVAL_IDENTITY_PRIMARY))) {
                if (strict && !outParams.evalCode.eq(new bn_js_1.BN(verus_typescript_primitives_1.EVALS.EVAL_NOTARY_EVIDENCE))) {
                    throw new Error("Unsupported params eval code " + outParams.evalCode.toNumber() + " found in transaction output");
                }
                continue;
            }
            if (strict && id != null)
                throw new Error("Multiple identity outputs found in transaction");
            id = new verus_typescript_primitives_1.Identity();
            id.fromBuffer(outParams.getParamObject(), 0, parseVdxfObjects);
            if (id.getIdentityAddress() === idAddr) {
                index = i;
                if (!strict)
                    break;
            }
            else if (strict) {
                throw new Error("Identity output does not match identity address");
            }
        }
        if (index < 0) {
            throw new Error("Identity output not found");
        }
        else {
            return { vout: index, identity: id };
        }
    }
    static addNegativeDelta(deltas, key, value) {
        if (deltas.has(key))
            deltas.set(key, deltas.get(key).minus(value));
        else
            deltas.set(key, value.multipliedBy((0, bignumber_js_1.default)(-1)));
    }
    static addValidationFeesToDeltas(validation, deltas) {
        for (const key in validation.fees) {
            VerusIdInterface.addNegativeDelta(deltas, key, (0, bignumber_js_1.default)(validation.fees[key]));
        }
    }
    static addValidationSentToDeltas(validation, deltas) {
        for (const key in validation.sent) {
            VerusIdInterface.addNegativeDelta(deltas, key, (0, bignumber_js_1.default)(validation.sent[key]));
        }
    }
    static validateNoUnexpectedCurrencySent(validation) {
        for (const key in validation.sent) {
            if ((0, bignumber_js_1.default)(validation.sent[key]).isGreaterThan((0, bignumber_js_1.default)(0))) {
                throw new Error("Cannot send currency and update ID.");
            }
        }
    }
    static getSatoshis(value, label) {
        const satoshis = (0, bignumber_js_1.default)(value);
        if (!satoshis.isFinite() || satoshis.isNegative() || !satoshis.isInteger()) {
            throw new Error(label + " must be a non-negative integer satoshi value.");
        }
        return new bn_js_1.BN(satoshis.toFixed(0), 10);
    }
    static getCurrencyValueMap(output) {
        const valueMap = new Map();
        for (const currency of Object.keys(output.currencies || {})) {
            valueMap.set(currency, VerusIdInterface.getSatoshis(output.currencies[currency], "Currency transfer output currency value for " + currency));
        }
        if (valueMap.size === 0)
            throw new Error("Currency transfer output must include at least one currency value.");
        return valueMap;
    }
    static isReserveTransferOutput(output) {
        return output.convertto != null ||
            output.exportto != null ||
            output.via != null ||
            output.preconvert === true ||
            output.burn === true ||
            output.burnweight === true ||
            output.mintnew === true ||
            output.importtosource === true;
    }
    static getTxDestination(destination) {
        const destinationType = destination.typeNoFlags();
        if (destinationType.eq(verus_typescript_primitives_1.DEST_PKH)) {
            return new verus_typescript_primitives_1.TxDestination(new verus_typescript_primitives_1.KeyID(destination.destinationBytes));
        }
        else if (destinationType.eq(verus_typescript_primitives_1.DEST_ID)) {
            return new verus_typescript_primitives_1.TxDestination(new verus_typescript_primitives_1.IdentityID(destination.destinationBytes));
        }
        else
            throw new Error("Unsupported transfer destination type.");
    }
    static getTokenOutputVersion(valueMap) {
        const version = new bn_js_1.BN(1, 10);
        return valueMap.size > 1 ? version.xor(verus_typescript_primitives_1.TOKEN_OUTPUT_VERSION_MULTIVALUE) : version;
    }
    static createSmartTransactionOutputScript(master, params) {
        return new verus_typescript_primitives_1.SmartTransactionScript(master, params).toBuffer();
    }
    static cloneTransferDestination(destination) {
        return new verus_typescript_primitives_1.TransferDestination({
            type: destination.type,
            destinationBytes: Buffer.from(destination.destinationBytes),
            gatewayID: destination.gatewayID,
            gatewayCode: destination.gatewayCode,
            fees: destination.fees,
            auxDests: (destination.auxDests || []).map(auxDest => VerusIdInterface.cloneTransferDestination(auxDest))
        });
    }
    static usesRefundDestination(output) {
        return output.exportto != null ||
            output.preconvert === true ||
            (output.convertto != null &&
                output.mintnew !== true &&
                output.burn !== true &&
                output.burnweight !== true);
    }
    static getReserveTransferDestination(output) {
        const destination = VerusIdInterface.cloneTransferDestination(output.address);
        if (output.refundto != null && VerusIdInterface.usesRefundDestination(output)) {
            destination.type = destination.type.or(verus_typescript_primitives_1.FLAG_DEST_AUX);
            destination.auxDests = [
                ...(destination.auxDests || []),
                VerusIdInterface.cloneTransferDestination(output.refundto)
            ];
        }
        return destination;
    }
    static validateCurrencyTransferOutput(output, chainId, isReserveTransfer) {
        if (!isReserveTransfer) {
            if (output.feecurrency != null)
                throw new Error("Fee currency is only valid for reserve transfer outputs.");
            if (output.feesatoshis != null)
                throw new Error("Reserve transfer fee is only valid for reserve transfer outputs.");
            if (output.refundto != null)
                throw new Error("Refund destination is only valid for reserve transfer outputs.");
            if (output.destsystem != null)
                throw new Error("Destination system is only valid for reserve transfer outputs.");
            return;
        }
        if (output.refundto != null && !VerusIdInterface.usesRefundDestination(output)) {
            throw new Error("Refund destination is only valid for export, preconvert, or conversion reserve transfer outputs.");
        }
        if (output.via != null && output.convertto == null) {
            throw new Error("Reserve-to-reserve currency transfers with via must also specify convertto.");
        }
        if (output.exportto != null && output.feesatoshis == null) {
            throw new Error("Cross-system currency transfers require explicit reserve transfer feesatoshis.");
        }
        if (output.feecurrency != null && output.feecurrency !== chainId && output.feesatoshis == null) {
            throw new Error("Non-native reserve transfer fee currency requires explicit feesatoshis.");
        }
        if ((output.preconvert || output.mintnew || output.burn || output.burnweight) &&
            output.feecurrency != null &&
            output.feecurrency !== chainId) {
            throw new Error("Preconvert, mint, and burn reserve transfer fees must use the native chain currency.");
        }
        if (output.preconvert && output.convertto == null) {
            throw new Error("Preconvert currency transfers require convertto.");
        }
        if (output.mintnew && output.convertto == null) {
            throw new Error("Mint currency transfers require convertto.");
        }
    }
    static getReserveTransferDestinationCurrency(output, currencies) {
        const primaryCurrency = currencies[0];
        const convertTo = output.convertto ? output.convertto : (output.exportto ? output.exportto : primaryCurrency);
        const destCurrencyID = output.via ? output.via : convertTo;
        const secondReserveID = output.via ? output.convertto : undefined;
        return {
            destCurrencyID,
            secondReserveID,
            destSystemID: output.destsystem ? output.destsystem : output.exportto
        };
    }
    static getReserveTransferFlags(output, currencies) {
        let flags = new bn_js_1.BN(1, 10);
        const isConversion = output.convertto != null && (currencies.length !== 1 || output.convertto !== currencies[0]);
        if (output.importtosource)
            flags = flags.or(verus_typescript_primitives_1.RESERVE_TRANSFER_IMPORT_TO_SOURCE);
        if (output.via != null && output.convertto != null)
            flags = flags.or(verus_typescript_primitives_1.RESERVE_TRANSFER_RESERVE_TO_RESERVE);
        if (output.exportto != null)
            flags = flags.or(verus_typescript_primitives_1.RESERVE_TRANSFER_CROSS_SYSTEM);
        if (isConversion)
            flags = flags.or(verus_typescript_primitives_1.RESERVE_TRANSFER_CONVERT);
        if (output.preconvert)
            flags = flags.or(verus_typescript_primitives_1.RESERVE_TRANSFER_PRECONVERT);
        if (output.mintnew)
            flags = flags.or(verus_typescript_primitives_1.RESERVE_TRANSFER_MINT_CURRENCY);
        if (output.burn)
            flags = flags.or(verus_typescript_primitives_1.RESERVE_TRANSFER_BURN_CHANGE_PRICE);
        if (output.burnweight)
            flags = flags.or(verus_typescript_primitives_1.RESERVE_TRANSFER_BURN_CHANGE_WEIGHT);
        return flags;
    }
    static calculateReserveTransferFee(destination, flags) {
        if (flags.and(verus_typescript_primitives_1.RESERVE_TRANSFER_FEE_OUTPUT).gt(new bn_js_1.BN(0, 10)))
            return new bn_js_1.BN(0, 10);
        const baseFee = RESERVE_TRANSFER_DEFAULT_PER_STEP_FEE.shln(1);
        const destinationSizeSteps = Math.floor(destination.destinationBytes.length / RESERVE_TRANSFER_DESTINATION_BYTE_DIVISOR);
        return baseFee.add(baseFee.mul(new bn_js_1.BN(destinationSizeSteps, 10)));
    }
    static getReserveTransferFeeSatoshis(output, flags) {
        return output.feesatoshis != null ?
            VerusIdInterface.getSatoshis(output.feesatoshis, "Reserve transfer fee") :
            VerusIdInterface.calculateReserveTransferFee(output.address, flags);
    }
    static getReserveTransferFeeCurrency(output, chainId) {
        if (output.preconvert || output.mintnew || output.burn || output.burnweight)
            return chainId;
        return output.feecurrency ? output.feecurrency : chainId;
    }
    static hasGatewayLeg(destination) {
        return destination.isGateway() && destination.gatewayID != null;
    }
    static getGatewayLegFees(destination) {
        return VerusIdInterface.hasGatewayLeg(destination) ?
            VerusIdInterface.getSatoshis(destination.fees ? destination.fees.toString() : 0, "Reserve transfer gateway fee") :
            new bn_js_1.BN(0, 10);
    }
    static createUnfundedCurrencyTransferTransaction(chainId, currencyTransferOutputs, expiryHeight) {
        const txb = new utxo_lib_1.TransactionBuilder(utxo_lib_1.networks.verus);
        txb.setVersion(4);
        txb.setExpiryHeight(expiryHeight);
        txb.setVersionGroupId(0x892f2085);
        for (const output of currencyTransferOutputs) {
            if (output.vdxftag != null)
                throw new Error("VDXF tags not fully implemented");
            if (output.address == null)
                throw new Error("Must specify address for all outputs");
            const valueMap = VerusIdInterface.getCurrencyValueMap(output);
            const valueCurrencies = Array.from(valueMap.keys());
            const isReserveTransfer = VerusIdInterface.isReserveTransferOutput(output);
            VerusIdInterface.validateCurrencyTransferOutput(output, chainId, isReserveTransfer);
            const nativeValue = valueMap.get(chainId) || new bn_js_1.BN(0, 10);
            const feeCurrency = isReserveTransfer ?
                VerusIdInterface.getReserveTransferFeeCurrency(output, chainId) :
                chainId;
            const flags = isReserveTransfer ?
                VerusIdInterface.getReserveTransferFlags(output, valueCurrencies) :
                new bn_js_1.BN(1, 10);
            const feeSatoshis = isReserveTransfer ?
                VerusIdInterface.getReserveTransferFeeSatoshis(output, flags) :
                new bn_js_1.BN(0, 10);
            const reserveTransferDestination = isReserveTransfer ?
                VerusIdInterface.getReserveTransferDestination(output) :
                output.address;
            const gatewayLegFees = isReserveTransfer ?
                VerusIdInterface.getGatewayLegFees(reserveTransferDestination) :
                new bn_js_1.BN(0, 10);
            const nativeFeeValue = isReserveTransfer && feeCurrency === chainId ? feeSatoshis.add(gatewayLegFees) : new bn_js_1.BN(0, 10);
            const outputNativeValue = nativeValue.add(nativeFeeValue);
            if (isReserveTransfer) {
                const reserveDestination = VerusIdInterface.getTxDestination(verus_typescript_primitives_1.RESERVE_TRANSFER_DESTINATION);
                const { destCurrencyID, secondReserveID, destSystemID } = VerusIdInterface.getReserveTransferDestinationCurrency(output, valueCurrencies);
                const values = new verus_typescript_primitives_1.CurrencyValueMap({
                    valueMap,
                    multivalue: valueMap.size > 1
                });
                const reserveTransfer = new verus_typescript_primitives_1.ReserveTransfer({
                    values,
                    version: VerusIdInterface.getTokenOutputVersion(valueMap),
                    flags,
                    feeCurrencyID: feeCurrency,
                    feeAmount: feeSatoshis,
                    transferDestination: reserveTransferDestination,
                    destCurrencyID,
                    secondReserveID,
                    destSystemID
                });
                const outMaster = new verus_typescript_primitives_1.OptCCParams({
                    version: new bn_js_1.BN(3, 10),
                    evalCode: new bn_js_1.BN(verus_typescript_primitives_1.EVALS.EVAL_NONE),
                    m: new bn_js_1.BN(1, 10),
                    n: new bn_js_1.BN(1, 10),
                    destinations: [reserveDestination]
                });
                const outParams = new verus_typescript_primitives_1.OptCCParams({
                    version: new bn_js_1.BN(3, 10),
                    evalCode: new bn_js_1.BN(verus_typescript_primitives_1.EVALS.EVAL_RESERVE_TRANSFER),
                    m: new bn_js_1.BN(1, 10),
                    n: new bn_js_1.BN(1, 10),
                    destinations: [reserveDestination],
                    vData: [reserveTransfer.toBuffer()]
                });
                txb.addOutput(VerusIdInterface.createSmartTransactionOutputScript(outMaster, outParams), outputNativeValue.toNumber());
            }
            else {
                const tokenValueMap = new Map(valueMap);
                tokenValueMap.delete(chainId);
                if (tokenValueMap.size === 0 && output.address.typeNoFlags().eq(verus_typescript_primitives_1.DEST_PKH)) {
                    txb.addOutput(output.address.getAddressString(), outputNativeValue.toNumber());
                }
                else {
                    const destination = VerusIdInterface.getTxDestination(output.address);
                    const outMaster = new verus_typescript_primitives_1.OptCCParams({
                        version: new bn_js_1.BN(3, 10),
                        evalCode: new bn_js_1.BN(verus_typescript_primitives_1.EVALS.EVAL_NONE),
                        m: tokenValueMap.size === 0 ? new bn_js_1.BN(0, 10) : new bn_js_1.BN(1, 10),
                        n: tokenValueMap.size === 0 ? new bn_js_1.BN(0, 10) : new bn_js_1.BN(1, 10),
                        destinations: tokenValueMap.size === 0 ? [] : [destination]
                    });
                    const outParams = tokenValueMap.size === 0 ?
                        new verus_typescript_primitives_1.OptCCParams({
                            version: new bn_js_1.BN(3, 10),
                            evalCode: new bn_js_1.BN(verus_typescript_primitives_1.EVALS.EVAL_NONE),
                            m: new bn_js_1.BN(1, 10),
                            n: new bn_js_1.BN(1, 10),
                            destinations: [destination]
                        }) :
                        new verus_typescript_primitives_1.OptCCParams({
                            version: new bn_js_1.BN(3, 10),
                            evalCode: new bn_js_1.BN(verus_typescript_primitives_1.EVALS.EVAL_RESERVE_OUTPUT),
                            m: new bn_js_1.BN(1, 10),
                            n: new bn_js_1.BN(1, 10),
                            destinations: [destination],
                            vData: [new verus_typescript_primitives_1.TokenOutput({
                                    values: new verus_typescript_primitives_1.CurrencyValueMap({
                                        valueMap: tokenValueMap,
                                        multivalue: tokenValueMap.size > 1
                                    }),
                                    version: VerusIdInterface.getTokenOutputVersion(tokenValueMap)
                                }).toBuffer()]
                        });
                    txb.addOutput(VerusIdInterface.createSmartTransactionOutputScript(outMaster, outParams), outputNativeValue.toNumber());
                }
            }
        }
        return txb.buildIncomplete().toHex();
    }
    static getExpectedSentFromCurrencyTransferOutputs(currencyTransferOutputs) {
        const expectedSent = new Map();
        for (const output of currencyTransferOutputs) {
            const valueMap = VerusIdInterface.getCurrencyValueMap(output);
            valueMap.forEach((value, currency) => {
                const satoshis = (0, bignumber_js_1.default)(value.toString());
                if (expectedSent.has(currency))
                    expectedSent.set(currency, expectedSent.get(currency).plus(satoshis));
                else
                    expectedSent.set(currency, satoshis);
            });
        }
        return expectedSent;
    }
    static getDestinationFees(destination) {
        return (0, bignumber_js_1.default)(VerusIdInterface.getGatewayLegFees(destination).toString());
    }
    static getExpectedFeesFromCurrencyTransferOutputs(currencyTransferOutputs, chainId) {
        const expectedFees = new Map();
        for (const output of currencyTransferOutputs) {
            const isReserveTransfer = VerusIdInterface.isReserveTransferOutput(output);
            if (!isReserveTransfer)
                continue;
            const valueCurrencies = Array.from(VerusIdInterface.getCurrencyValueMap(output).keys());
            VerusIdInterface.validateCurrencyTransferOutput(output, chainId, isReserveTransfer);
            const flags = VerusIdInterface.getReserveTransferFlags(output, valueCurrencies);
            const feeCurrency = VerusIdInterface.getReserveTransferFeeCurrency(output, chainId);
            const reserveTransferDestination = VerusIdInterface.getReserveTransferDestination(output);
            const outputFees = (0, bignumber_js_1.default)(VerusIdInterface.getReserveTransferFeeSatoshis(output, flags).toString())
                .plus(VerusIdInterface.getDestinationFees(reserveTransferDestination));
            if (expectedFees.has(feeCurrency))
                expectedFees.set(feeCurrency, expectedFees.get(feeCurrency).plus(outputFees));
            else
                expectedFees.set(feeCurrency, outputFees);
        }
        return expectedFees;
    }
    static validateCurrencyTransferSent(validation, expectedSent) {
        const keys = new Set([
            ...Object.keys(validation.sent ? validation.sent : {}),
            ...Array.from(expectedSent.keys())
        ]);
        keys.forEach(key => {
            const actual = (0, bignumber_js_1.default)(validation.sent && validation.sent[key] != null ? validation.sent[key] : 0);
            const expected = expectedSent.get(key) || (0, bignumber_js_1.default)(0);
            if (!actual.isEqualTo(expected)) {
                throw new Error("Sent currency delta does not match explicit currency transfer output for " + key + ".");
            }
        });
    }
    static validateFees(validation, expectedExplicitFees, chainId, maxFee) {
        const maxNativeFeeSatoshis = (0, bignumber_js_1.default)(maxFee).multipliedBy((0, bignumber_js_1.default)(10).pow((0, bignumber_js_1.default)(8)));
        if (!maxNativeFeeSatoshis.isFinite() || maxNativeFeeSatoshis.isNegative()) {
            throw new Error("Maximum fee must be a non-negative finite number.");
        }
        const keys = new Set([
            chainId,
            ...Object.keys(validation.fees ? validation.fees : {}),
            ...Array.from(expectedExplicitFees.keys())
        ]);
        keys.forEach(key => {
            const actual = (0, bignumber_js_1.default)(validation.fees && validation.fees[key] != null ? validation.fees[key] : 0);
            const expectedExplicitFee = expectedExplicitFees.get(key) || (0, bignumber_js_1.default)(0);
            if (actual.isLessThan(expectedExplicitFee)) {
                throw new Error("Fee is lower than explicit fee output for " + key + ".");
            }
            if (key === chainId) {
                if (actual.isGreaterThan(maxNativeFeeSatoshis)) {
                    throw new Error("Fee exceeds maximum permissable fee value.");
                }
            }
            else if (!actual.isEqualTo(expectedExplicitFee)) {
                throw new Error("Unexpected fee currency delta for " + key + ".");
            }
        });
    }
    static getFundingUtxosFromTransaction(fundedTxHex, utxoList) {
        const fundedTx = utxo_lib_1.Transaction.fromHex(fundedTxHex, utxo_lib_1.networks.verus);
        const utxosUsed = [];
        fundedTx.ins.forEach((input) => {
            const inputFromList = utxoList.find(utxo => {
                const inputHash = Buffer.from(input.hash).reverse().toString('hex');
                return utxo.txid === inputHash && utxo.outputIndex === input.index;
            });
            if (inputFromList) {
                utxosUsed.push(inputFromList);
            }
            else
                throw new Error("Input not found in UTXO list");
        });
        return utxosUsed;
    }
    getVerifiedFundingUtxosFromTransaction(fundedTxHex_1, utxoList_1) {
        return __awaiter(this, arguments, void 0, function* (fundedTxHex, utxoList, allowUnverifiedPrevouts = false) {
            if (allowUnverifiedPrevouts)
                return VerusIdInterface.getFundingUtxosFromTransaction(fundedTxHex, utxoList);
            const fundedTx = utxo_lib_1.Transaction.fromHex(fundedTxHex, utxo_lib_1.networks.verus);
            const txCache = new Map();
            const utxosUsed = [];
            for (const input of fundedTx.ins) {
                const inputHash = Buffer.from(input.hash).reverse().toString('hex');
                const inputFromList = utxoList.find(utxo => utxo.txid === inputHash && utxo.outputIndex === input.index);
                if (!inputFromList)
                    throw new Error("Input not found in UTXO list");
                let prevTx = txCache.get(inputHash);
                if (prevTx == null) {
                    const rawTxRes = yield this.interface.getRawTransaction(inputHash, 0);
                    if (rawTxRes.error)
                        throw new Error("Couldn't verify prevout " + inputHash + ": " + rawTxRes.error.message);
                    const rawTx = rawTxRes.result;
                    const rawTxHex = typeof rawTx === "string" ? rawTx : rawTx.hex;
                    if (typeof rawTxHex !== "string")
                        throw new Error("Couldn't verify prevout " + inputHash + ": missing raw transaction hex.");
                    prevTx = utxo_lib_1.Transaction.fromHex(rawTxHex, utxo_lib_1.networks.verus);
                    if (prevTx.getId() !== inputHash) {
                        throw new Error("Prevout transaction hash mismatch for " + inputHash + ".");
                    }
                    txCache.set(inputHash, prevTx);
                }
                const prevOut = prevTx.outs[input.index];
                if (prevOut == null)
                    throw new Error("Prevout " + inputHash + " index " + input.index + " not found.");
                utxosUsed.push(Object.assign(Object.assign({}, inputFromList), { script: prevOut.script.toString('hex'), satoshis: prevOut.value }));
            }
            return utxosUsed;
        });
    }
    static combineUnfundedTransactions(baseTxHex, outputsTxHex) {
        const baseTx = utxo_lib_1.Transaction.fromHex(baseTxHex, utxo_lib_1.networks.verus);
        const outputsTx = utxo_lib_1.Transaction.fromHex(outputsTxHex, utxo_lib_1.networks.verus);
        if (baseTx.ins.length !== 0)
            throw new Error("Identity update transaction must be unfunded before combining currency transfer outputs.");
        if (outputsTx.ins.length !== 0)
            throw new Error("Currency transfer transaction must be unfunded before combining.");
        outputsTx.outs.forEach((output) => {
            baseTx.outs.push(output);
        });
        return baseTx.toHex();
    }
    static validateCompletedIdentityUpdateTransaction(fundedTxHex, completedTxHex, identityTransaction, identityVout) {
        const fundedTx = utxo_lib_1.Transaction.fromHex(fundedTxHex, utxo_lib_1.networks.verus);
        const completedTx = utxo_lib_1.Transaction.fromHex(completedTxHex, utxo_lib_1.networks.verus);
        if (completedTx.outs.length !== fundedTx.outs.length) {
            throw new Error("Completed identity update output count does not match funded transaction.");
        }
        for (let i = 0; i < fundedTx.outs.length; i++) {
            if (completedTx.outs[i].value !== fundedTx.outs[i].value ||
                Buffer.from(completedTx.outs[i].script).toString('hex') !== Buffer.from(fundedTx.outs[i].script).toString('hex')) {
                throw new Error("Completed identity update outputs do not match funded transaction.");
            }
        }
        if (completedTx.ins.length !== fundedTx.ins.length + 1) {
            throw new Error("Completed identity update input count does not match funded transaction plus identity input.");
        }
        for (let i = 0; i < fundedTx.ins.length; i++) {
            if (Buffer.from(completedTx.ins[i].hash).toString('hex') !== Buffer.from(fundedTx.ins[i].hash).toString('hex') ||
                completedTx.ins[i].index !== fundedTx.ins[i].index ||
                completedTx.ins[i].sequence !== fundedTx.ins[i].sequence) {
                throw new Error("Completed identity update funding inputs do not match funded transaction.");
            }
        }
        const identityInput = completedTx.ins[fundedTx.ins.length];
        const expectedIdentityInputHash = Buffer.from(identityTransaction.getId(), 'hex').reverse();
        if (Buffer.from(identityInput.hash).toString('hex') !== expectedIdentityInputHash.toString('hex') || identityInput.index !== identityVout) {
            throw new Error("Completed identity update does not spend the expected identity output.");
        }
    }
    static completeIdentityUpdateTransaction(fundedTxHex, utxoList, identityTransaction, identityVout) {
        const completeIdentityUpdate = completeFundedIdentityUpdate(fundedTxHex, utxo_lib_1.networks.verus, utxoList.map(x => Buffer.from(x.script, 'hex')), {
            hash: Buffer.from(identityTransaction.getId(), 'hex').reverse(),
            index: identityVout,
            script: identityTransaction.outs[identityVout].script,
            sequence: 4294967295
        });
        VerusIdInterface.validateCompletedIdentityUpdateTransaction(fundedTxHex, completeIdentityUpdate, identityTransaction, identityVout);
        return completeIdentityUpdate;
    }
    static getIdentityDefinitionUtxo(identityAddress, identityTransaction, identityVout, identityTransactionHeight) {
        return {
            address: identityAddress,
            txid: identityTransaction.getId(),
            outputIndex: identityVout,
            script: identityTransaction.outs[identityVout].script.toString('hex'),
            satoshis: 0,
            height: identityTransactionHeight,
            isspendable: 0,
            blocktime: 0 // Filled in to avoid getblock call because blocktime is not currently checked for the ID definition utxo
        };
    }
    static validateIdentityPrimaryAddress(identity, expectedPrimaryAddress) {
        if (expectedPrimaryAddress == null)
            return;
        const primaryAddresses = identity.toJson().primaryaddresses || [];
        if (primaryAddresses.length !== 1 || primaryAddresses[0] !== expectedPrimaryAddress) {
            throw new Error("Identity primary address must be exactly " + expectedPrimaryAddress + ".");
        }
    }
    prepareIdentityUpdateTransaction(identity_1, rawIdentityTransaction_1, currentHeight_1, updateIdentityTransactionHex_1) {
        return __awaiter(this, arguments, void 0, function* (identity, rawIdentityTransaction, currentHeight, updateIdentityTransactionHex, parseVdxfObjects = true, isTestnet = false) {
            let height = currentHeight;
            if (height == null) {
                height = yield this.getCurrentHeight();
            }
            const identityTransaction = utxo_lib_1.Transaction.fromHex(rawIdentityTransaction, utxo_lib_1.networks.verus);
            let unfundedTxHex;
            let identityAddress;
            let vout = -1;
            let identityOnOutput;
            if (identity instanceof verus_typescript_primitives_1.Identity) {
                // If identity is an identity object, assume that the object can be used at the output and that the user filled it in correctly
                identity.upgradeVersion();
                unfundedTxHex = createUnfundedIdentityUpdate(identity.toBuffer().toString('hex'), utxo_lib_1.networks.verus, height + 20);
                identityAddress = identity.getIdentityAddress();
                const identityFromIdTx = VerusIdInterface.getIdentityFromIdTx(identityTransaction, identityAddress, parseVdxfObjects);
                vout = identityFromIdTx.vout;
                identityOnOutput = identity;
            }
            else if (identity instanceof verus_typescript_primitives_1.IdentityUpdateRequestDetails) {
                // If identity is an identityupdaterequest, that only contains a partial identity with the changes the user wants to make, so we
                // need to fill in the rest of the ID in a way that doesn't trust the server without verification
                if (identity.containsTxid() && identity.getTxidString() !== identityTransaction.getId()) {
                    throw new Error("Identity update request txid does not match the txid of the identity transaction");
                }
                ;
                if (updateIdentityTransactionHex) {
                    unfundedTxHex = updateIdentityTransactionHex;
                }
                else {
                    const idCliJson = identity.toCLIJson();
                    const hexRes = (yield this.interface.updateIdentity(idCliJson, true));
                    if (hexRes.error)
                        throw new Error(hexRes.error.message);
                    else
                        unfundedTxHex = hexRes.result;
                }
                const unfundedTx = utxo_lib_1.Transaction.fromHex(unfundedTxHex, utxo_lib_1.networks.verus);
                unfundedTx.ins = [];
                unfundedTxHex = unfundedTx.toHex();
                identityAddress = identity.getIdentityAddress(isTestnet);
                const detailsFromRawTransaction = VerusIdInterface.getIdentityFromIdTx(identityTransaction, identityAddress, parseVdxfObjects);
                vout = detailsFromRawTransaction.vout;
                const identityFromServer = VerusIdInterface.getIdentityFromIdTx(unfundedTx, identityAddress, parseVdxfObjects, true).identity;
                const identityFromRawTransaction = detailsFromRawTransaction.identity;
                const identityFromRawTransactionJson = identityFromRawTransaction.toJson();
                identityOnOutput = identityFromServer;
                const partialIdentity = identity.identity.withResolvedContentMultiMap();
                const serverIdentityJson = identityFromServer.toJson();
                const partialIdentityJson = partialIdentity.toJson();
                const changedKeys = Object.keys(partialIdentityJson);
                const contentMultiMapChanged = partialIdentity.containsContentMultiMap();
                // Identity contentmultimap values are per-transaction updates that the daemon
                // aggregates across identity history. When an update omits contentmultimap,
                // the next identity output must contain no new entries; the previous output's
                // entries must not be copied forward or compared as persistent state.
                if (!contentMultiMapChanged && identityFromServer.contentMultiMap.kvContent.size > 0) {
                    throw new Error("Unexpected contentmultimap entries in identity transaction");
                }
                // Compare keys that were both changed and unchanged to ensure that changes are the same in funded tx from server
                let serverChangedKeysComp = {};
                let serverUnchangedKeysComp = {};
                let fromTxUnchangedKeysComp = {};
                // Separate out changed keys and unchanged keys, keeping name in all categories as it
                // should never be null or changed
                for (const key of Object.keys(identityFromRawTransactionJson)) {
                    if (key === 'name') {
                        serverChangedKeysComp[key] = serverIdentityJson[key];
                        serverUnchangedKeysComp[key] = serverIdentityJson[key];
                        fromTxUnchangedKeysComp[key] = identityFromRawTransactionJson[key];
                    }
                    else if (changedKeys.includes(key)) {
                        serverChangedKeysComp[key] = serverIdentityJson[key];
                    }
                    else if (key === 'contentmultimap' && !contentMultiMapChanged) {
                        continue;
                    }
                    else {
                        serverUnchangedKeysComp[key] = serverIdentityJson[key];
                        fromTxUnchangedKeysComp[key] = identityFromRawTransactionJson[key];
                    }
                }
                const serverKeysChangedCompJson = serverChangedKeysComp;
                const serverKeysUnchangedCompJson = serverUnchangedKeysComp;
                const fromTxKeysUnchangedCompJson = fromTxUnchangedKeysComp;
                // Ignore cmm fields that contained the "data" field because we can't establish if the cmm and/or encryption was
                // done correctly yet
                if (identity.containsSignData()) {
                    if (serverKeysChangedCompJson.contentmultimap) {
                        for (const [key, value] of identity.signDataMap.entries()) {
                            const iAddrKey = key.toAddress();
                            delete serverKeysChangedCompJson.contentmultimap[iAddrKey];
                        }
                    }
                    else
                        throw new Error("Expected cmm in identity update request");
                }
                else if (unfundedTx.outs.length > 1) {
                    // Outputs without signdata should only have an identity output and nothing else
                    throw new Error("Expected only one output in identity update request");
                }
                // Create partialidentity from the server identity json, taking only keys that were submitted to be modified,
                // and then serialize it and compare it to the partial identity that was submitted, to ensure they are the same.
                const serverPartialIdChangedComp = verus_typescript_primitives_1.PartialIdentity.fromJson(serverKeysChangedCompJson).withResolvedContentMultiMap();
                if (serverPartialIdChangedComp.toBuffer().toString('hex') !== partialIdentity.toBuffer().toString('hex')) {
                    throw new Error("Identity update request changes do not appear to match the changes in the identity transaction, got " +
                        JSON.stringify(serverPartialIdChangedComp.toJson()) +
                        " expected " +
                        JSON.stringify(partialIdentity.toJson()));
                }
                const serverPartialIdUnchangedComp = verus_typescript_primitives_1.PartialIdentity.fromJson(serverKeysUnchangedCompJson).withResolvedContentMultiMap();
                const fromTxPartialIdUnchangedComp = verus_typescript_primitives_1.PartialIdentity.fromJson(fromTxKeysUnchangedCompJson).withResolvedContentMultiMap();
                if (serverPartialIdUnchangedComp.toBuffer().toString('hex') !== fromTxPartialIdUnchangedComp.toBuffer().toString('hex')) {
                    throw new Error("Unchanged identity properties returned from server do not appear to match the unchanged values from the identity transaction, got " +
                        JSON.stringify(serverPartialIdUnchangedComp.toJson()) +
                        " expected " +
                        JSON.stringify(fromTxPartialIdUnchangedComp.toJson()));
                }
            }
            else
                throw new Error("Invalid identity type");
            return {
                height,
                identityTransaction,
                identityAddress,
                identityOnOutput,
                unfundedTxHex,
                vout
            };
        });
    }
    // When using this function with a remote RPC server, PLEASE USE THE VERUSID DECODED FROM rawIdentityTransaction
    // AS YOUR BASE FOR PASSING IN THE IDENTITY PARAMETER (what you want to update). Otherwise if you're using an
    // untrusted server to get your identity base and then editing, you could be updating an ID with data you don't
    // want to update.
    createUpdateIdentityTransaction(identity_1, changeAddress_1, rawIdentityTransaction_1, identityTransactionHeight_1, utxoList_1, chainIAddr_1) {
        return __awaiter(this, arguments, void 0, function* (identity, changeAddress, rawIdentityTransaction, identityTransactionHeight, utxoList, chainIAddr, maxFee = 5, fundRawTransactionResult, currentHeight, updateIdentityTransactionHex, parseVdxfObjects = true, isTestnet = false, // This parameter is only necessary if you pass in an IdentityUpdateRequestDetails
        allowUnverifiedPrevouts = false) {
            const preparedIdentityUpdate = yield this.prepareIdentityUpdateTransaction(identity, rawIdentityTransaction, currentHeight, updateIdentityTransactionHex, parseVdxfObjects, isTestnet);
            let fundedTxHex;
            if (utxoList == null) {
                fundedTxHex = preparedIdentityUpdate.unfundedTxHex;
            }
            else if (fundRawTransactionResult == null) {
                const _fundRawTxRes = yield this.interface.fundRawTransaction(preparedIdentityUpdate.unfundedTxHex, utxoList.map(utxo => {
                    return {
                        voutnum: utxo.outputIndex,
                        txid: utxo.txid,
                    };
                }), changeAddress);
                if (_fundRawTxRes.error)
                    throw new Error("Couldn't fund raw transaction");
                else
                    fundedTxHex = _fundRawTxRes.result.hex;
            }
            else
                fundedTxHex = fundRawTransactionResult.hex;
            const chainId = chainIAddr != null ? chainIAddr : yield this.getChainId();
            const deltas = new Map();
            if (utxoList) {
                const verifiedFundingUtxos = yield this.getVerifiedFundingUtxosFromTransaction(fundedTxHex, utxoList, allowUnverifiedPrevouts);
                const validation = validateFundedCurrencyTransfer(chainId, fundedTxHex, preparedIdentityUpdate.unfundedTxHex, changeAddress, utxo_lib_1.networks.verus, verifiedFundingUtxos);
                if (!validation.valid)
                    throw new Error(validation.message);
                VerusIdInterface.validateNoUnexpectedCurrencySent(validation);
                VerusIdInterface.validateFees(validation, new Map(), chainId, maxFee);
                VerusIdInterface.addValidationFeesToDeltas(validation, deltas);
                const completeIdentityUpdate = VerusIdInterface.completeIdentityUpdateTransaction(fundedTxHex, verifiedFundingUtxos, preparedIdentityUpdate.identityTransaction, preparedIdentityUpdate.vout);
                verifiedFundingUtxos.push(VerusIdInterface.getIdentityDefinitionUtxo(preparedIdentityUpdate.identityAddress, preparedIdentityUpdate.identityTransaction, preparedIdentityUpdate.vout, identityTransactionHeight));
                return {
                    hex: completeIdentityUpdate,
                    utxos: verifiedFundingUtxos,
                    identity: preparedIdentityUpdate.identityOnOutput,
                    deltas
                };
            }
            else {
                return {
                    hex: fundedTxHex,
                    utxos: [],
                    identity: preparedIdentityUpdate.identityOnOutput,
                    deltas
                };
            }
        });
    }
    createUpdateIdentityWithCurrencyTransferTransaction(identity_1, changeAddress_1, rawIdentityTransaction_1, identityTransactionHeight_1, currencyTransferOutputs_1, utxoList_1) {
        return __awaiter(this, arguments, void 0, function* (identity, changeAddress, rawIdentityTransaction, identityTransactionHeight, currencyTransferOutputs, utxoList, options = {}) {
            if (!currencyTransferOutputs.length)
                throw new Error("Must provide at least one explicit currency transfer output.");
            const preparedIdentityUpdate = yield this.prepareIdentityUpdateTransaction(identity, rawIdentityTransaction, options.currentHeight, options.updateIdentityTransactionHex, options.parseVdxfObjects == null ? true : options.parseVdxfObjects, options.isTestnet == null ? false : options.isTestnet);
            VerusIdInterface.validateIdentityPrimaryAddress(preparedIdentityUpdate.identityOnOutput, options.expectedIdentityPrimaryAddress == null ? changeAddress : options.expectedIdentityPrimaryAddress);
            const chainId = options.chainIAddr != null ? options.chainIAddr : yield this.getChainId();
            const currencyTransferTxHex = VerusIdInterface.createUnfundedCurrencyTransferTransaction(chainId, currencyTransferOutputs, preparedIdentityUpdate.height + 20);
            const combinedUnfundedTxHex = VerusIdInterface.combineUnfundedTransactions(preparedIdentityUpdate.unfundedTxHex, currencyTransferTxHex);
            let fundedTxHex;
            if (options.fundRawTransactionResult == null) {
                const _fundRawTxRes = yield this.interface.fundRawTransaction(combinedUnfundedTxHex, utxoList.map(utxo => {
                    return {
                        voutnum: utxo.outputIndex,
                        txid: utxo.txid,
                    };
                }), changeAddress);
                if (_fundRawTxRes.error)
                    throw new Error("Couldn't fund raw transaction");
                else
                    fundedTxHex = _fundRawTxRes.result.hex;
            }
            else
                fundedTxHex = options.fundRawTransactionResult.hex;
            const verifiedFundingUtxos = yield this.getVerifiedFundingUtxosFromTransaction(fundedTxHex, utxoList, options.allowUnverifiedPrevouts == null ? false : options.allowUnverifiedPrevouts);
            const validation = validateFundedCurrencyTransfer(chainId, fundedTxHex, combinedUnfundedTxHex, changeAddress, utxo_lib_1.networks.verus, verifiedFundingUtxos);
            if (!validation.valid)
                throw new Error(validation.message);
            const expectedSent = VerusIdInterface.getExpectedSentFromCurrencyTransferOutputs(currencyTransferOutputs);
            const expectedExplicitFees = VerusIdInterface.getExpectedFeesFromCurrencyTransferOutputs(currencyTransferOutputs, chainId);
            const deltas = new Map();
            VerusIdInterface.validateCurrencyTransferSent(validation, expectedSent);
            VerusIdInterface.validateFees(validation, expectedExplicitFees, chainId, options.maxFee == null ? 5 : options.maxFee);
            VerusIdInterface.addValidationFeesToDeltas(validation, deltas);
            VerusIdInterface.addValidationSentToDeltas(validation, deltas);
            const completeIdentityUpdate = VerusIdInterface.completeIdentityUpdateTransaction(fundedTxHex, verifiedFundingUtxos, preparedIdentityUpdate.identityTransaction, preparedIdentityUpdate.vout);
            verifiedFundingUtxos.push(VerusIdInterface.getIdentityDefinitionUtxo(preparedIdentityUpdate.identityAddress, preparedIdentityUpdate.identityTransaction, preparedIdentityUpdate.vout, identityTransactionHeight));
            return {
                hex: completeIdentityUpdate,
                utxos: verifiedFundingUtxos,
                identity: preparedIdentityUpdate.identityOnOutput,
                deltas
            };
        });
    }
    createRevokeIdentityTransaction(_identity_1, changeAddress_1, rawIdentityTransaction_1, identityTransactionHeight_1, utxoList_1, chainIAddr_1) {
        return __awaiter(this, arguments, void 0, function* (_identity, changeAddress, rawIdentityTransaction, identityTransactionHeight, utxoList, chainIAddr, fee = 0.0001, fundRawTransactionResult, currentHeight, allowUnverifiedPrevouts = false) {
            const identity = new verus_typescript_primitives_1.Identity();
            identity.fromBuffer(_identity.toBuffer());
            identity.clearContentMultiMap();
            identity.revoke();
            return this.createUpdateIdentityTransaction(identity, changeAddress, rawIdentityTransaction, identityTransactionHeight, utxoList, chainIAddr, fee, fundRawTransactionResult, currentHeight, undefined, true, false, allowUnverifiedPrevouts);
        });
    }
    createRecoverIdentityTransaction(_identity_1, changeAddress_1, rawIdentityTransaction_1, identityTransactionHeight_1, utxoList_1, chainIAddr_1) {
        return __awaiter(this, arguments, void 0, function* (_identity, changeAddress, rawIdentityTransaction, identityTransactionHeight, utxoList, chainIAddr, fee = 0.0001, fundRawTransactionResult, currentHeight, allowUnverifiedPrevouts = false) {
            const identity = new verus_typescript_primitives_1.Identity();
            identity.fromBuffer(_identity.toBuffer());
            identity.clearContentMultiMap();
            identity.unrevoke();
            return this.createUpdateIdentityTransaction(identity, changeAddress, rawIdentityTransaction, identityTransactionHeight, utxoList, chainIAddr, fee, fundRawTransactionResult, currentHeight, undefined, true, false, allowUnverifiedPrevouts);
        });
    }
    /**
     *
     * @param unsignedTxHex The unsigned transaction hex
     * @param inputs A list of UTXOs that are being used as inputs for the transaction, in the order they appear in the unsigned tx
     * @param keys A list of WIF keys that correspond to the UTXOs in the inputs list, each utxo will be signed with each key in the list at the position of the utxo in the inputs list
     */
    signUpdateIdentityTransaction(unsignedTxHex, inputs, keys) {
        const txb = utxo_lib_1.smarttxs.getFundedTxBuilder(unsignedTxHex, utxo_lib_1.networks.verus, inputs.map(x => Buffer.from(x.script, 'hex')));
        for (let i = 0; i < keys.length; i++) {
            if (inputs[i] && keys[i] && Array.isArray(keys[i]) && keys[i].length > 0) {
                const keysForInput = keys[i];
                for (let j = 0; j < keysForInput.length; j++) {
                    if (keysForInput[j]) {
                        const keyPair = utxo_lib_1.ECPair.fromWIF(keysForInput[j], utxo_lib_1.networks.verus);
                        txb.sign(i, keyPair, null, utxo_lib_1.Transaction.SIGHASH_ALL, inputs[i].satoshis);
                    }
                }
            }
        }
        return txb.build().toHex();
    }
    createGenericEnvelope(EnvelopeClass, params, primaryAddrWif, getIdentityResult, currentHeight, chainIAddr) {
        return __awaiter(this, void 0, void 0, function* () {
            let chainId;
            if (chainIAddr != null)
                chainId = chainIAddr;
            else
                chainId = yield this.getChainId();
            const req = new EnvelopeClass(params);
            if (primaryAddrWif) {
                return this.signGenericEnvelope(req, primaryAddrWif, getIdentityResult, currentHeight);
            }
            else
                return req;
        });
    }
    signGenericEnvelope(request, primaryAddrWif, getIdentityResult, currentHeight) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d, _e, _f;
            request.setSigned();
            let height = currentHeight;
            if (height == null) {
                height = yield this.getCurrentHeight();
            }
            if (request.signature == null) {
                throw new Error("Require VerifiableSignatureData to be filled in, without signatureAsVch to sign.");
            }
            if (((_a = request.signature) === null || _a === void 0 ? void 0 : _a.hasBoundHashes()) || ((_b = request.signature) === null || _b === void 0 ? void 0 : _b.hasStatements()) || ((_c = request.signature) === null || _c === void 0 ? void 0 : _c.hasVdxfKeys()) || ((_d = request.signature) === null || _d === void 0 ? void 0 : _d.hasVdxfKeyNames())) {
                throw new Error("Bound hashes, statements, and vdxfkeys in signature not yet supported.");
            }
            const sig = yield this.signHash((_e = request.signature) === null || _e === void 0 ? void 0 : _e.identityID.toIAddress(), request.getDetailsIdentitySignatureHash(height), primaryAddrWif, getIdentityResult, height, (_f = request.signature) === null || _f === void 0 ? void 0 : _f.systemID.toIAddress());
            request.signature.signatureAsVch = Buffer.from(sig, 'base64');
            return request;
        });
    }
    verifyGenericEnvelope(envelope, getIdentityResult, chainIAddr, sigBlockTime) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            if (!envelope.isSigned())
                return false;
            const verifiableSig = envelope.signature;
            const sigInfo = yield this.getSignatureInfo(verifiableSig.identityID.toIAddress(), verifiableSig.signatureAsVch.toString('base64'), chainIAddr);
            if (envelope.hasCreatedAt()) {
                let blocktime;
                if (sigBlockTime)
                    blocktime = sigBlockTime;
                else {
                    const _blockres = yield this.interface.getBlock(sigInfo.height.toString());
                    if (_blockres.error)
                        throw new Error(_blockres.error.message);
                    blocktime = _blockres.result.time;
                }
                if ((0, bignumber_js_1.default)(blocktime)
                    .minus((_a = envelope.createdAt) === null || _a === void 0 ? void 0 : _a.toString())
                    .abs()
                    .isGreaterThan(LOGIN_CONSENT_SIG_TIME_DIFF_THRESHOLD)) {
                    return false;
                }
            }
            else {
                return false;
            }
            return this.verifyHash(verifiableSig.identityID.toIAddress(), verifiableSig.signatureAsVch.toString('base64'), envelope.getDetailsIdentitySignatureHash(sigInfo.height), getIdentityResult, chainIAddr);
        });
    }
    static validateUnsignedGenericRequest(request) {
        const details = request.details;
        if (!Array.isArray(details))
            return false;
        let authIndex = -1;
        let specialIndex = -1;
        let provisioningIndex = -1;
        let appEncryptIndex = -1;
        let walletBackupIndex = -1;
        for (let i = 0; i < details.length; i++) {
            const detail = details[i];
            if (detail instanceof verus_typescript_primitives_1.AuthenticationRequestOrdinalVDXFObject) {
                if (authIndex !== -1)
                    return false;
                authIndex = i;
            }
            if (detail instanceof verus_typescript_primitives_1.ProvisionIdentityDetailsOrdinalVDXFObject) {
                if (provisioningIndex !== -1)
                    return false;
                provisioningIndex = i;
            }
            if (detail instanceof verus_typescript_primitives_1.AppEncryptionRequestOrdinalVDXFObject) {
                if (appEncryptIndex !== -1)
                    return false;
                appEncryptIndex = i;
            }
            if (detail instanceof verus_typescript_primitives_1.CreateWalletBackupDetailsOrdinalVDXFObject) {
                if (walletBackupIndex !== -1)
                    return false;
                walletBackupIndex = i;
            }
            if (detail instanceof verus_typescript_primitives_1.VerusPayInvoiceDetailsOrdinalVDXFObject || detail instanceof verus_typescript_primitives_1.IdentityUpdateRequestOrdinalVDXFObject) {
                if (specialIndex !== -1)
                    return false;
                specialIndex = i;
            }
        }
        if (walletBackupIndex !== -1 && walletBackupIndex !== 0)
            return false;
        if (authIndex !== -1 && authIndex !== (walletBackupIndex === 0 ? 1 : 0))
            return false;
        if (specialIndex !== -1 && specialIndex !== details.length - 1)
            return false;
        if (provisioningIndex !== -1 && (authIndex === -1 || provisioningIndex < authIndex))
            return false;
        if (appEncryptIndex !== -1 && (authIndex === -1 || appEncryptIndex < authIndex))
            return false;
        return true;
    }
}
exports.default = VerusIdInterface;
