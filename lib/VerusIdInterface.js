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
const registration_1 = require("./identity/registration");
const registrationSigning_1 = require("./identity/registrationSigning");
const registrationFundingVerification_1 = require("./identity/registrationFundingVerification");
const registrationPolicy_1 = require("./identity/registrationPolicy");
const updateFundingVerification_1 = require("./identity/updateFundingVerification");
const fundingPrimitives_1 = require("./identity/fundingPrimitives");
const fundingVerification_1 = require("./identity/fundingVerification");
const updateDataVerification_1 = require("./identity/updateDataVerification");
const localUpdateData_1 = require("./identity/localUpdateData");
const localIdentityUpdate_1 = require("./identity/localIdentityUpdate");
const fullIdentityUpdateValidation_1 = require("./identity/fullIdentityUpdateValidation");
const updateLimits_1 = require("./identity/updateLimits");
const requestSnapshot_1 = require("./identity/requestSnapshot");
const identityValidation_1 = require("./identity/identityValidation");
const { createUnfundedIdentityUpdate, validateFundedCurrencyTransfer, completeFundedIdentityUpdate } = utxo_lib_1.smarttxs;
const VRSC_I_ADDRESS = "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV";
const ID_SIG_VERSION = 2;
const ID_SIG_TYPE = 5;
const LOGIN_CONSENT_SIG_TIME_DIFF_THRESHOLD = 3600;
const BN_TYPE_REF = new bn_js_1.BN(0, 10);
const RESERVE_TRANSFER_DEFAULT_PER_STEP_FEE = new bn_js_1.BN(10000, 10);
const RESERVE_TRANSFER_DESTINATION_BYTE_DIVISOR = 128;
function getUtxos(result) {
    return Array.isArray(result) ? result : result.utxos;
}
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
    /** Resolve and quote a modern commit/reveal registration without broadcasting. */
    resolveIdentityRegistration(request) {
        return (0, registration_1.resolveIdentityRegistration)(this.interface, request);
    }
    /** Builds the commitment transaction and returns private reservation recovery data. */
    createNameReservationTransaction(request) {
        return (0, registration_1.createNameReservationTransaction)(this.interface, request);
    }
    /** Spends an explicitly identified, confirmed commitment to create an identity. */
    createIdentityRegistrationTransaction(request) {
        return (0, registration_1.createIdentityRegistrationTransaction)(this.interface, request);
    }
    signIdentityRegistrationTransaction(request) {
        const prepared = request.transaction;
        (0, registration_1.validatePreparedIdentityRegistrationTransaction)(prepared, request.txHex);
        for (const partial of request.partialTransactions || [])
            (0, registration_1.validatePreparedIdentityRegistrationTransaction)(prepared, partial);
        return (0, registrationSigning_1.signIdentityRegistrationTransaction)({
            txHex: request.txHex == null ? prepared.txHex : request.txHex,
            prevouts: prepared.prevouts,
            identityAuthorities: prepared.identityAuthorities,
            keys: request.keys,
            partialTransactions: request.partialTransactions
        });
    }
    mergeIdentityRegistrationTransactions(request) {
        return this.signIdentityRegistrationTransaction(request);
    }
    inspectIdentityRegistrationSignatures(request) {
        return (0, registrationSigning_1.inspectIdentityRegistrationSignatures)(request);
    }
    /** Verify the approved economic intent and every supplied signature; inspect signingStatus before broadcast. */
    validateIdentityRegistrationTransaction(prepared, candidateHex = prepared.txHex, expectedChangeAddress = prepared.changeAddress) {
        (0, registration_1.validatePreparedIdentityRegistrationTransaction)(prepared, candidateHex, expectedChangeAddress);
        return Object.assign({ valid: true }, (0, registrationSigning_1.inspectIdentityRegistrationSignatures)({
            txHex: candidateHex,
            prevouts: prepared.prevouts,
            identityAuthorities: prepared.identityAuthorities
        }));
    }
    /** Independently account for raw input/output currencies against retained approval. No RPC or signature cache. */
    verifyIdentityRegistrationFunding(prepared, candidateHex = prepared.txHex, expectedChangeAddress = prepared.changeAddress) {
        return (0, registrationFundingVerification_1.verifyIdentityRegistrationFunding)(prepared, candidateHex, expectedChangeAddress);
    }
    /** Validate funding, approved intent, and complete signatures on every send, including retries. */
    sendIdentityRegistrationTransaction(prepared_1, signedHex_1) {
        return __awaiter(this, arguments, void 0, function* (prepared, signedHex, expectedChangeAddress = prepared.changeAddress) {
            (0, registration_1.validatePreparedIdentityRegistrationTransaction)(prepared, signedHex, expectedChangeAddress);
            const checked = (0, registrationSigning_1.inspectIdentityRegistrationSignatures)({
                txHex: signedHex,
                prevouts: prepared.prevouts,
                identityAuthorities: prepared.identityAuthorities
            });
            if (checked.signingStatus !== "complete") {
                throw new registrationPolicy_1.RegistrationError("INCOMPLETE_SIGNATURES", "Registration must be fully signed before broadcast.");
            }
            // Once submission starts, an RPC error or lost response cannot prove that
            // the transaction was not accepted. Retain the ID of the exact bytes sent.
            const txid = (0, fundingPrimitives_1.transaction)(signedHex).getId();
            let response;
            try {
                response = yield this.interface.sendRawTransaction(signedHex);
            }
            catch (cause) {
                throw new registrationPolicy_1.RegistrationError("BROADCAST_UNKNOWN", `Registration broadcast outcome is unknown; transaction ${txid} may have been submitted. Check its status before retrying.`, { txid, cause });
            }
            if (response == null || response.error != null || response.result !== txid) {
                throw new registrationPolicy_1.RegistrationError("BROADCAST_UNKNOWN", `Registration broadcast outcome is unknown; transaction ${txid} may have been submitted. Check its status before retrying.`, { txid, response });
            }
            return response;
        });
    }
    getChainId() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.interface.chain === "VRSC" || this.interface.chain === VRSC_I_ADDRESS) {
                return VRSC_I_ADDRESS;
            }
            else {
                // An explicitly configured i-address must not be replaced by an RPC response.
                try {
                    if (verus_typescript_primitives_1.IdentityID.fromAddress(this.interface.chain).toAddress() === this.interface.chain) {
                        return this.interface.chain;
                    }
                }
                catch (_) {
                    // Chain names still require RPC resolution.
                }
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
     * @deprecated SignedSessionObject construction is disabled in primitives.
     * No compatible replacement HTTP session API is available.
     */
    verifySignedSessionObject(object, getIdentityResult, chainIAddr) {
        return __awaiter(this, void 0, void 0, function* () {
            const sigInfo = yield this.getSignatureInfo(object.signing_id, object.signature.signature, chainIAddr);
            return this.verifyHash(object.signing_id, object.signature.signature, object.getDataHash(sigInfo.height), getIdentityResult, chainIAddr);
        });
    }
    /**
     * @deprecated SignedSessionObject construction is disabled in primitives.
     * No compatible replacement HTTP session API is available.
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
     * @deprecated Disabled because SignedSessionObject construction is unsupported in primitives.
     * Always rejects; no compatible replacement HTTP session API is available.
     */
    createSignedSessionObject(signingId, data, primaryAddrWif, getIdentityResult, currentHeight, chainIAddr) {
        return __awaiter(this, void 0, void 0, function* () {
            throw new Error("SignedSessionObject is deprecated and disabled; no compatible replacement HTTP session API is available.");
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
            // Data uploads also contain notary evidence outputs. This helper extracts
            // the identity; update builders verify the upload evidence separately.
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
                if (valueMap.size !== 1)
                    throw new Error("Reserve transfers require exactly one currency in their value map.");
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
        const maxNativeFeeSatoshis = (0, bignumber_js_1.default)((0, updateFundingVerification_1.identityUpdateFeeCap)(maxFee));
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
            (0, fundingVerification_1.assertUnverifiedPrevoutsAllowed)(allowUnverifiedPrevouts);
            if (allowUnverifiedPrevouts)
                return VerusIdInterface.getFundingUtxosFromTransaction(fundedTxHex, utxoList);
            const fundedTx = (0, fundingPrimitives_1.transaction)(fundedTxHex);
            const seen = new Set();
            const txCache = new Map();
            const utxosUsed = [];
            for (const input of fundedTx.ins) {
                const inputHash = Buffer.from(input.hash).reverse().toString('hex');
                const outpoint = `${inputHash}:${input.index}`;
                if (seen.has(outpoint))
                    throw new Error("Duplicate funding outpoint.");
                seen.add(outpoint);
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
                    prevTx = (0, fundingPrimitives_1.transaction)(rawTxHex);
                    if (prevTx.getId() !== inputHash) {
                        throw new Error("Prevout transaction hash mismatch for " + inputHash + ".");
                    }
                    txCache.set(inputHash, prevTx);
                }
                const prevOut = prevTx.outs[input.index];
                if (prevOut == null)
                    throw new Error("Prevout " + inputHash + " index " + input.index + " not found.");
                utxosUsed.push(Object.assign(Object.assign({}, inputFromList), { script: prevOut.script.toString('hex'), satoshis: prevOut.value, rawTransaction: prevTx.toHex() }));
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
            satoshis: identityTransaction.outs[identityVout].value,
            rawTransaction: identityTransaction.toHex(),
            height: identityTransactionHeight,
            isspendable: false,
            blocktime: 0 // Filled in to avoid getblock call because blocktime is not currently checked for the ID definition utxo
        };
    }
    static validateIdentityPrimaryAddress(identity, expectedPrimaryAddress) {
        if (expectedPrimaryAddress == null)
            return;
        // Binary content need not have a lossless daemon JSON representation.
        const primaryAddresses = (identity.primaryAddresses || []).map(address => address.toAddress());
        if (primaryAddresses.length !== 1 || primaryAddresses[0] !== expectedPrimaryAddress) {
            throw new Error("Identity primary address must be exactly " + expectedPrimaryAddress + ".");
        }
    }
    /** Validate definitions returned for required revocation/recovery authorities. */
    validateIdentityUpdateAuthorities(authorities) {
        return __awaiter(this, void 0, void 0, function* () {
            for (const authority of authorities) {
                const response = yield this.interface.getIdentity(authority.address);
                try {
                    if (response.error || !response.result) {
                        throw new Error("Missing authority");
                    }
                    // Check the RPC value before parsing can normalize a malformed version.
                    const rawVersion = response.result.identity.version;
                    if (!Number.isInteger(rawVersion) ||
                        rawVersion < 1 ||
                        rawVersion > 3) {
                        throw new Error("Invalid authority version");
                    }
                    const definition = verus_typescript_primitives_1.Identity.fromJson(response.result.identity);
                    (0, identityValidation_1.validateIdentityVersion)(definition.version);
                    // Validate the signing threshold and version-specific authority fields.
                    if (!bn_js_1.BN.isBN(definition.minSigs)) {
                        throw new Error("Missing authority threshold");
                    }
                    (0, identityValidation_1.validateIdentityPrimaryAddresses)(definition.primaryAddresses, definition.minSigs);
                    if (definition.version.gten(2)) {
                        (0, fundingPrimitives_1.validAddress)(definition.revocationAuthority.toAddress(), true);
                        (0, fundingPrimitives_1.validAddress)(definition.recoveryAuthority.toAddress(), true);
                    }
                    // Bind the returned definition to the requested authority address.
                    if (definition.getIdentityAddress() !== authority.address) {
                        throw new Error("Wrong authority");
                    }
                }
                catch (_) {
                    throw new Error(`Identity ${authority.role} authority does not exist on the configured chain.`);
                }
            }
        });
    }
    /**
     * Build or verify an unfunded update against the raw identity being spent.
     * Use one height/expiry context for identity edits, evidence, and verification.
     */
    prepareIdentityUpdateTransaction(identity_1, rawIdentityTransaction_1, currentHeight_1, updateIdentityTransactionHex_1) {
        return __awaiter(this, arguments, void 0, function* (identity, rawIdentityTransaction, currentHeight, updateIdentityTransactionHex, parseVdxfObjects = true, isTestnet = false, decryptData, localUploadCrypto, chainIAddr) {
            var _a;
            // Detach caller-owned state before invoking RPC or wallet callbacks.
            identity = (0, requestSnapshot_1.snapshotUpdateRequestValue)(identity);
            localUploadCrypto = (0, localUpdateData_1.captureLocalIdentityUploadCrypto)(localUploadCrypto);
            decryptData = decryptData || (localUploadCrypto === null || localUploadCrypto === void 0 ? void 0 : localUploadCrypto.decryptData);
            // Reject unsupported request fields and uploads before any external work.
            if (identity instanceof verus_typescript_primitives_1.IdentityUpdateRequestDetails) {
                if (!bn_js_1.BN.isBN(identity.flags) ||
                    identity.flags.isNeg() ||
                    identity.flags.gtn(31)) {
                    throw new Error("Unsupported identity update request flags.");
                }
                if (identity.expires() || identity.expiryHeight !== undefined) {
                    if (!bn_js_1.BN.isBN(identity.expiryHeight) ||
                        identity.expiryHeight.isNeg() ||
                        identity.expiryHeight.bitLength() > 32) {
                        throw new Error("Invalid identity update request expiry height.");
                    }
                }
                if (identity.containsSystem() || identity.systemID !== undefined) {
                    if (!(identity.systemID instanceof verus_typescript_primitives_1.IdentityID)) {
                        throw new Error("Invalid identity update request system.");
                    }
                    (0, fundingPrimitives_1.validAddress)(identity.systemID.toAddress(), true);
                }
                if ((identity.containsTxid() || identity.txid !== undefined) &&
                    (!Buffer.isBuffer(identity.txid) || identity.txid.length !== 32)) {
                    throw new Error("Invalid identity update request txid.");
                }
                const partial = identity.identity;
                if (!(partial instanceof verus_typescript_primitives_1.PartialIdentity)) {
                    throw new Error("Identity update request requires a partial identity.");
                }
                (0, identityValidation_1.dropEmptyIdentityContent)(partial);
                (0, identityValidation_1.validatePartialIdentityDefinition)(partial);
                (0, localUpdateData_1.validateLocalIdentityUploadRequest)(identity, isTestnet);
                // Uploads need decryption; local construction also needs encryption.
                if (identity.containsSignData() &&
                    !updateIdentityTransactionHex &&
                    !localUploadCrypto) {
                    throw new Error("Local identity data uploads require wallet crypto callbacks.");
                }
                if (identity.containsSignData() && typeof decryptData !== "function") {
                    throw new Error("Identity data uploads require a decryption callback.");
                }
            }
            // Select the chain context once so lock normalization and tx expiry agree.
            let height = currentHeight;
            if (height == null) {
                // Lock consensus uses the active chain's next block. A peer-reported
                // longest chain can be ahead while this endpoint is still synchronizing.
                const response = yield this.interface.getInfo();
                if (response.error) {
                    throw new Error(response.error.message);
                }
                height = (_a = response.result) === null || _a === void 0 ? void 0 : _a.blocks;
            }
            if (!Number.isSafeInteger(height) ||
                height < 0 ||
                height + 20 >= 500000000) {
                throw new Error("Invalid identity update preparation height.");
            }
            let expiryHeight = height + 20;
            if (identity instanceof verus_typescript_primitives_1.IdentityUpdateRequestDetails &&
                identity.expiryHeight !== undefined) {
                if (identity.expiryHeight.lte(new bn_js_1.BN(height))) {
                    throw new Error("Identity update request has expired.");
                }
                expiryHeight = Math.min(expiryHeight, identity.expiryHeight.toNumber());
            }
            // A supplied template fixes the expiry used for every subsequent lock check.
            if (identity instanceof verus_typescript_primitives_1.IdentityUpdateRequestDetails &&
                updateIdentityTransactionHex) {
                (0, updateLimits_1.validateIdentityUpdateTransactionSize)(updateIdentityTransactionHex);
                const supplied = (0, fundingPrimitives_1.transaction)(updateIdentityTransactionHex);
                (0, fundingVerification_1.verifyTransparentTransaction)(supplied);
                if (!Number.isInteger(supplied.expiryHeight) ||
                    supplied.expiryHeight < height + updateLimits_1.MIN_IDENTITY_UPDATE_EXPIRY_DELTA ||
                    supplied.expiryHeight >= 500000000 ||
                    supplied.expiryHeight > height + updateLimits_1.MAX_IDENTITY_UPDATE_EXPIRY_DELTA ||
                    (identity.expiryHeight !== undefined &&
                        identity.expiryHeight.lt(new bn_js_1.BN(supplied.expiryHeight)))) {
                    throw new Error("Supplied identity update expiry must be 4 to 40 blocks ahead and within the request expiry.");
                }
                expiryHeight = supplied.expiryHeight;
            }
            if (expiryHeight < height + updateLimits_1.MIN_IDENTITY_UPDATE_EXPIRY_DELTA) {
                throw new Error("Identity update expiry must be at least 4 blocks ahead to satisfy daemon relay policy.");
            }
            const chainId = chainIAddr || (yield this.getChainId());
            (0, fundingPrimitives_1.validAddress)(chainId, true);
            if (identity instanceof verus_typescript_primitives_1.IdentityUpdateRequestDetails &&
                identity.systemID !== undefined &&
                identity.systemID.toAddress() !== chainId) {
                throw new Error("Identity update request system does not match the configured chain.");
            }
            const identityTransaction = (0, fundingPrimitives_1.transaction)(rawIdentityTransaction);
            let unfundedTxHex;
            let identityAddress;
            let vout = -1;
            let identityOnOutput;
            if (identity instanceof verus_typescript_primitives_1.Identity) {
                // Full identities describe final state: validate the transition without
                // applying the partial-request normalization rules.
                (0, localIdentityUpdate_1.validateSupportedIdentityUpdateState)(identity);
                identityAddress = identity.getIdentityAddress();
                const identityFromIdTx = VerusIdInterface.getIdentityFromIdTx(identityTransaction, identityAddress, false);
                (0, localIdentityUpdate_1.validateSupportedIdentityUpdateState)(identityFromIdTx.identity);
                (0, identityValidation_1.dropEmptyIdentityContent)(identity);
                const requiredAuthorities = (0, fullIdentityUpdateValidation_1.validateFullIdentityUpdate)(identityFromIdTx.identity, identity, {
                    chainId,
                    nextBlockHeight: height + 1,
                    expiryHeight,
                });
                yield this.validateIdentityUpdateAuthorities(requiredAuthorities);
                unfundedTxHex = createUnfundedIdentityUpdate(identity.toBuffer().toString("hex"), utxo_lib_1.networks.verus, expiryHeight);
                vout = identityFromIdTx.vout;
                identityOnOutput = identity;
            }
            else if (identity instanceof verus_typescript_primitives_1.IdentityUpdateRequestDetails) {
                if ((identity.containsTxid() || identity.txid !== undefined) &&
                    identity.getTxidString() !== identityTransaction.getId()) {
                    throw new Error("Identity update request txid does not match the txid of the identity transaction");
                }
                identityAddress = identity.getIdentityAddress(isTestnet);
                // Raw source bytes, rather than aggregated RPC JSON, are the merge base.
                const source = VerusIdInterface.getIdentityFromIdTx(identityTransaction, identityAddress, false);
                vout = source.vout;
                (0, updateFundingVerification_1.verifyIdentityDefinitionOutput)(identityTransaction.outs[vout], identityAddress);
                const merged = (0, localIdentityUpdate_1.applyLocalIdentityUpdate)(source.identity, identity.identity, {
                    chainId,
                    nextBlockHeight: height + 1,
                    expiryHeight,
                    hasDataUploads: identity.containsSignData(),
                });
                yield this.validateIdentityUpdateAuthorities(merged.requiredAuthorities);
                const expectedIdentity = merged.identity;
                // Keep the expected ordinary edit separate from generated upload references.
                // Both supplied and local templates are checked against it below.
                if (updateIdentityTransactionHex) {
                    unfundedTxHex = updateIdentityTransactionHex;
                }
                else {
                    const constructedIdentity = (0, requestSnapshot_1.snapshotUpdateRequestValue)(expectedIdentity);
                    const evidence = identity.containsSignData()
                        ? yield (0, localUpdateData_1.buildLocalIdentityUpdateData)({
                            request: identity,
                            chainId,
                            crypto: localUploadCrypto,
                        })
                        : { outputs: [], contentMultiMap: new Map() };
                    for (const [key, values] of evidence.contentMultiMap) {
                        constructedIdentity.contentMultiMap.kvContent.set(key, values);
                    }
                    (0, identityValidation_1.validateIdentityDefinition)(constructedIdentity);
                    const local = (0, fundingPrimitives_1.transaction)(createUnfundedIdentityUpdate(constructedIdentity.toBuffer().toString("hex"), utxo_lib_1.networks.verus, expiryHeight));
                    // References were built for evidence starting at output zero.
                    local.outs = [...evidence.outputs, ...local.outs];
                    unfundedTxHex = local.toHex();
                }
                (0, updateLimits_1.validateIdentityUpdateTransactionSize)(unfundedTxHex);
                const template = (0, fundingPrimitives_1.transaction)(unfundedTxHex);
                (0, fundingVerification_1.verifyTransparentTransaction)(template);
                // Supplied daemon templates can include the old identity input. Funding
                // adds that verified input itself after validating the output plan.
                template.ins = [];
                unfundedTxHex = template.toHex();
                const output = VerusIdInterface.getIdentityFromIdTx(template, identityAddress, false, true);
                identityOnOutput = output.identity;
                // Remove upload entries from this comparison copy so ordinary fields can
                // be checked separately. Verify uploads against the original request below.
                const ordinary = (0, requestSnapshot_1.snapshotUpdateRequestValue)(identityOnOutput);
                if (identity.containsSignData()) {
                    for (const [key] of identity.signDataMap.entries()) {
                        ordinary.contentMultiMap.kvContent.deleteByAddress(key.toAddress());
                    }
                }
                const actualPrivate = ordinary.privateAddresses || [];
                const expectedPrivate = expectedIdentity.privateAddresses || [];
                if (actualPrivate.length !== expectedPrivate.length ||
                    actualPrivate.some((value, index) => !value.toBuffer().equals(expectedPrivate[index].toBuffer()))) {
                    throw new Error("Private addresses in identity transaction do not match the requested update.");
                }
                if (!ordinary.contentMultiMap
                    .toBuffer()
                    .equals(expectedIdentity.contentMultiMap.toBuffer())) {
                    throw new Error("Unexpected contentmultimap entries in identity transaction");
                }
                if (!ordinary.toBuffer().equals(expectedIdentity.toBuffer())) {
                    throw new Error("Identity update request changes or unchanged identity properties do not match the identity transaction.");
                }
                if (!identity.containsSignData() && template.outs.length !== 1) {
                    throw new Error("Expected only one output in identity update request");
                }
                // Authenticate and decrypt every requested upload before funding.
                if (identity.containsSignData()) {
                    yield (0, updateDataVerification_1.verifyIdentityUpdateData)(identity, unfundedTxHex, decryptData, chainId);
                }
            }
            else {
                throw new Error("Invalid identity type");
            }
            // Even unfunded results must contain a canonical, zero-value definition.
            // Return the decoded output so later policy checks use the actual bytes.
            (0, updateLimits_1.validateIdentityUpdateTransactionSize)(unfundedTxHex);
            const outputTransaction = (0, fundingPrimitives_1.transaction)(unfundedTxHex);
            (0, fundingVerification_1.verifyTransparentTransaction)(outputTransaction);
            const outputDefinition = VerusIdInterface.getIdentityFromIdTx(outputTransaction, identityAddress, parseVdxfObjects, true);
            (0, updateFundingVerification_1.verifyIdentityDefinitionOutput)(outputTransaction.outs[outputDefinition.vout], identityAddress, true);
            identityOnOutput = outputDefinition.identity;
            (0, updateFundingVerification_1.verifyIdentityDefinitionOutput)(identityTransaction.outs[vout], identityAddress);
            return {
                height,
                expiryHeight,
                chainId,
                identityTransaction,
                identityAddress,
                identityOnOutput,
                unfundedTxHex,
                vout,
            };
        });
    }
    // When using this function with a remote RPC server, PLEASE USE THE VERUSID DECODED FROM rawIdentityTransaction
    // AS YOUR BASE FOR PASSING IN THE IDENTITY PARAMETER (what you want to update). Otherwise if you're using an
    // untrusted server to get your identity base and then editing, you could be updating an ID with data you don't
    // want to update.
    createUpdateIdentityTransaction(identity_1, changeAddress_1, rawIdentityTransaction_1, identityTransactionHeight_1, utxoList_1, chainIAddr_1, maxFee_1, fundRawTransactionResult_1, currentHeight_1, updateIdentityTransactionHex_1) {
        return __awaiter(this, arguments, void 0, function* (identity, changeAddress, rawIdentityTransaction, identityTransactionHeight, utxoList, chainIAddr, maxFee, fundRawTransactionResult, currentHeight, updateIdentityTransactionHex, parseVdxfObjects = true, isTestnet = false, // This parameter is only necessary if you pass in an IdentityUpdateRequestDetails
        allowUnverifiedPrevouts = false, decryptData, localUploadCrypto) {
            var _a;
            (0, fundingVerification_1.assertUnverifiedPrevoutsAllowed)(allowUnverifiedPrevouts);
            if (maxFee !== undefined)
                (0, updateFundingVerification_1.identityUpdateFeeCap)(maxFee);
            const utxos = utxoList == null ? undefined : (0, requestSnapshot_1.snapshotUpdateRequestValue)(getUtxos(utxoList));
            fundRawTransactionResult = (0, requestSnapshot_1.snapshotUpdateRequestValue)(fundRawTransactionResult);
            const preparedIdentityUpdate = yield this.prepareIdentityUpdateTransaction(identity, rawIdentityTransaction, currentHeight, updateIdentityTransactionHex, parseVdxfObjects, isTestnet, decryptData, localUploadCrypto, chainIAddr);
            const feeLimit = maxFee === undefined ? (0, updateFundingVerification_1.defaultIdentityUpdateFeeCap)(preparedIdentityUpdate.unfundedTxHex) : maxFee;
            let fundedTxHex;
            if (utxos == null) {
                fundedTxHex = preparedIdentityUpdate.unfundedTxHex;
            }
            else if (fundRawTransactionResult == null) {
                const _fundRawTxRes = yield this.interface.fundRawTransaction(preparedIdentityUpdate.unfundedTxHex, utxos.map(utxo => {
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
            (0, updateLimits_1.validateIdentityUpdateTransactionSize)(fundedTxHex);
            const chainId = preparedIdentityUpdate.chainId;
            const deltas = new Map();
            if (utxos) {
                const verifiedFundingUtxos = yield this.getVerifiedFundingUtxosFromTransaction(fundedTxHex, utxos, allowUnverifiedPrevouts);
                const validation = validateFundedCurrencyTransfer(chainId, fundedTxHex, preparedIdentityUpdate.unfundedTxHex, changeAddress, utxo_lib_1.networks.verus, verifiedFundingUtxos);
                if (!validation.valid)
                    throw new Error(validation.message);
                VerusIdInterface.validateNoUnexpectedCurrencySent(validation);
                VerusIdInterface.validateFees(validation, new Map(), chainId, feeLimit);
                VerusIdInterface.addValidationFeesToDeltas(validation, deltas);
                const completeIdentityUpdate = VerusIdInterface.completeIdentityUpdateTransaction(fundedTxHex, verifiedFundingUtxos, preparedIdentityUpdate.identityTransaction, preparedIdentityUpdate.vout);
                verifiedFundingUtxos.push(VerusIdInterface.getIdentityDefinitionUtxo(preparedIdentityUpdate.identityAddress, preparedIdentityUpdate.identityTransaction, preparedIdentityUpdate.vout, identityTransactionHeight));
                const fundingApproval = (0, updateFundingVerification_1.createIdentityUpdateFundingApproval)({
                    txHex: completeIdentityUpdate, unfundedTxHex: preparedIdentityUpdate.unfundedTxHex,
                    systemId: chainId, changeAddress, nativeFee: ((_a = validation.fees) === null || _a === void 0 ? void 0 : _a[chainId]) || "0",
                    fees: Object.assign({}, validation.fees), explicitFees: {}, maxFee: (0, updateFundingVerification_1.identityUpdateFeeCap)(feeLimit),
                    identity: { txid: preparedIdentityUpdate.identityTransaction.getId(), outputIndex: preparedIdentityUpdate.vout,
                        identityAddress: preparedIdentityUpdate.identityAddress },
                }, verifiedFundingUtxos, allowUnverifiedPrevouts, {
                    chainId, nextBlockHeight: preparedIdentityUpdate.height + 1,
                });
                return {
                    hex: completeIdentityUpdate,
                    utxos: verifiedFundingUtxos,
                    identity: preparedIdentityUpdate.identityOnOutput,
                    deltas,
                    fundingApproval
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
            var _a, _b, _c;
            const localUploadCrypto = (0, localUpdateData_1.captureLocalIdentityUploadCrypto)(options.localUploadCrypto);
            options = Object.assign(Object.assign({}, (0, requestSnapshot_1.snapshotUpdateRequestValue)(Object.assign(Object.assign({}, options), { localUploadCrypto: undefined }))), { localUploadCrypto });
            currencyTransferOutputs = (0, requestSnapshot_1.snapshotUpdateRequestValue)(currencyTransferOutputs);
            (0, fundingVerification_1.assertUnverifiedPrevoutsAllowed)((_a = options.allowUnverifiedPrevouts) !== null && _a !== void 0 ? _a : false);
            if (options.maxFee !== undefined)
                (0, updateFundingVerification_1.identityUpdateFeeCap)(options.maxFee);
            const utxos = (0, requestSnapshot_1.snapshotUpdateRequestValue)(getUtxos(utxoList));
            if (!currencyTransferOutputs.length)
                throw new Error("Must provide at least one explicit currency transfer output.");
            // Retain the caller's approved ownership policy before any RPC await. A
            // copied address list prevents later form changes from relaxing this check.
            const expectedPrimaryAddress = options.expectedIdentityPrimaryAddress == null ? changeAddress : options.expectedIdentityPrimaryAddress;
            const suppliedPrimaryAddresses = options.expectedIdentityPrimaryAddresses;
            const expectedMinimumSignatures = options.expectedIdentityMinimumSignatures;
            const hasExpectedPolicy = suppliedPrimaryAddresses !== undefined || expectedMinimumSignatures !== undefined;
            let expectedPrimaryAddresses;
            if (hasExpectedPolicy) {
                if (options.expectedIdentityPrimaryAddress !== undefined) {
                    throw new Error("Choose either an expected primary address or a complete expected identity signing policy.");
                }
                if (!Array.isArray(suppliedPrimaryAddresses) || suppliedPrimaryAddresses.length === 0 || suppliedPrimaryAddresses.length > 25 ||
                    !Number.isInteger(expectedMinimumSignatures) || expectedMinimumSignatures < 1 ||
                    expectedMinimumSignatures > suppliedPrimaryAddresses.length || expectedMinimumSignatures > 13) {
                    throw new Error("Expected identity signing policy requires primary addresses and a valid minimum signature count.");
                }
                expectedPrimaryAddresses = [...suppliedPrimaryAddresses];
                try {
                    if (new Set(expectedPrimaryAddresses).size !== expectedPrimaryAddresses.length ||
                        expectedPrimaryAddresses.some(primary => typeof primary !== "string" || verus_typescript_primitives_1.KeyID.fromAddress(primary).toAddress() !== primary)) {
                        throw new Error("Invalid primary address.");
                    }
                }
                catch (_) {
                    throw new Error("Expected identity primary addresses must be distinct transparent R-addresses.");
                }
            }
            const preparedIdentityUpdate = yield this.prepareIdentityUpdateTransaction(identity, rawIdentityTransaction, options.currentHeight, options.updateIdentityTransactionHex, options.parseVdxfObjects == null ? true : options.parseVdxfObjects, options.isTestnet == null ? false : options.isTestnet, options.decryptData, options.localUploadCrypto, options.chainIAddr);
            if (expectedPrimaryAddresses) {
                const outputIdentity = preparedIdentityUpdate.identityOnOutput;
                const outputPrimaryAddresses = (outputIdentity.primaryAddresses || []).map(address => address.toAddress());
                if (outputPrimaryAddresses.length !== expectedPrimaryAddresses.length ||
                    outputPrimaryAddresses.some((primary, index) => primary !== expectedPrimaryAddresses[index]) ||
                    !((_b = outputIdentity.minSigs) === null || _b === void 0 ? void 0 : _b.eqn(expectedMinimumSignatures))) {
                    throw new Error("Identity signing policy does not match the expected primary addresses and minimum signatures.");
                }
            }
            else {
                VerusIdInterface.validateIdentityPrimaryAddress(preparedIdentityUpdate.identityOnOutput, expectedPrimaryAddress);
            }
            const chainId = preparedIdentityUpdate.chainId;
            const currencyTransferTxHex = VerusIdInterface.createUnfundedCurrencyTransferTransaction(chainId, currencyTransferOutputs, preparedIdentityUpdate.expiryHeight);
            const combinedUnfundedTxHex = VerusIdInterface.combineUnfundedTransactions(preparedIdentityUpdate.unfundedTxHex, currencyTransferTxHex);
            (0, updateLimits_1.validateIdentityUpdateTransactionSize)(combinedUnfundedTxHex);
            const expectedExplicitFees = VerusIdInterface.getExpectedFeesFromCurrencyTransferOutputs(currencyTransferOutputs, chainId);
            const feeLimit = options.maxFee === undefined ? (0, updateFundingVerification_1.defaultIdentityUpdateFeeCap)(combinedUnfundedTxHex, (expectedExplicitFees.get(chainId) || new bignumber_js_1.default(0)).toFixed(0)) : options.maxFee;
            let fundedTxHex;
            if (options.fundRawTransactionResult == null) {
                const _fundRawTxRes = yield this.interface.fundRawTransaction(combinedUnfundedTxHex, utxos.map(utxo => {
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
            (0, updateLimits_1.validateIdentityUpdateTransactionSize)(fundedTxHex);
            const verifiedFundingUtxos = yield this.getVerifiedFundingUtxosFromTransaction(fundedTxHex, utxos, options.allowUnverifiedPrevouts == null ? false : options.allowUnverifiedPrevouts);
            const validation = validateFundedCurrencyTransfer(chainId, fundedTxHex, combinedUnfundedTxHex, changeAddress, utxo_lib_1.networks.verus, verifiedFundingUtxos);
            if (!validation.valid)
                throw new Error(validation.message);
            const expectedSent = VerusIdInterface.getExpectedSentFromCurrencyTransferOutputs(currencyTransferOutputs);
            const deltas = new Map();
            VerusIdInterface.validateCurrencyTransferSent(validation, expectedSent);
            VerusIdInterface.validateFees(validation, expectedExplicitFees, chainId, feeLimit);
            VerusIdInterface.addValidationFeesToDeltas(validation, deltas);
            VerusIdInterface.addValidationSentToDeltas(validation, deltas);
            const completeIdentityUpdate = VerusIdInterface.completeIdentityUpdateTransaction(fundedTxHex, verifiedFundingUtxos, preparedIdentityUpdate.identityTransaction, preparedIdentityUpdate.vout);
            verifiedFundingUtxos.push(VerusIdInterface.getIdentityDefinitionUtxo(preparedIdentityUpdate.identityAddress, preparedIdentityUpdate.identityTransaction, preparedIdentityUpdate.vout, identityTransactionHeight));
            const fundingApproval = (0, updateFundingVerification_1.createIdentityUpdateFundingApproval)({
                txHex: completeIdentityUpdate, unfundedTxHex: combinedUnfundedTxHex,
                systemId: chainId, changeAddress, nativeFee: ((_c = validation.fees) === null || _c === void 0 ? void 0 : _c[chainId]) || "0",
                fees: Object.assign({}, validation.fees), explicitFees: Object.fromEntries([...expectedExplicitFees].map(([id, value]) => [id, value.toFixed(0)])),
                maxFee: (0, updateFundingVerification_1.identityUpdateFeeCap)(feeLimit),
                identity: { txid: preparedIdentityUpdate.identityTransaction.getId(), outputIndex: preparedIdentityUpdate.vout,
                    identityAddress: preparedIdentityUpdate.identityAddress },
            }, verifiedFundingUtxos, options.allowUnverifiedPrevouts === true, {
                chainId, nextBlockHeight: preparedIdentityUpdate.height + 1,
            });
            return {
                hex: completeIdentityUpdate,
                utxos: verifiedFundingUtxos,
                identity: preparedIdentityUpdate.identityOnOutput,
                deltas,
                fundingApproval
            };
        });
    }
    createRevokeIdentityTransaction(_identity_1, changeAddress_1, rawIdentityTransaction_1, identityTransactionHeight_1, utxoList_1, chainIAddr_1) {
        return __awaiter(this, arguments, void 0, function* (_identity, changeAddress, rawIdentityTransaction, identityTransactionHeight, utxoList, chainIAddr, fee = 0.0001, fundRawTransactionResult, currentHeight, allowUnverifiedPrevouts = false) {
            (0, fundingVerification_1.assertUnverifiedPrevoutsAllowed)(allowUnverifiedPrevouts);
            const identity = (0, requestSnapshot_1.snapshotUpdateRequestValue)(_identity);
            identity.clearContentMultiMap();
            identity.revoke();
            return this.createUpdateIdentityTransaction(identity, changeAddress, rawIdentityTransaction, identityTransactionHeight, utxoList, chainIAddr, fee, fundRawTransactionResult, currentHeight, undefined, true, false, allowUnverifiedPrevouts);
        });
    }
    createRecoverIdentityTransaction(_identity_1, changeAddress_1, rawIdentityTransaction_1, identityTransactionHeight_1, utxoList_1, chainIAddr_1) {
        return __awaiter(this, arguments, void 0, function* (_identity, changeAddress, rawIdentityTransaction, identityTransactionHeight, utxoList, chainIAddr, fee = 0.0001, fundRawTransactionResult, currentHeight, allowUnverifiedPrevouts = false) {
            (0, fundingVerification_1.assertUnverifiedPrevoutsAllowed)(allowUnverifiedPrevouts);
            const identity = (0, requestSnapshot_1.snapshotUpdateRequestValue)(_identity);
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
    signUpdateIdentityTransaction(unsignedTxHex, inputs, keys, fundingApproval, lockContext) {
        (0, updateLimits_1.validateIdentityUpdateTransactionSize)(unsignedTxHex);
        const utxos = getUtxos(inputs);
        if (fundingApproval)
            (0, updateFundingVerification_1.verifyIdentityUpdateFunding)(fundingApproval, unsignedTxHex, utxos, lockContext);
        const txb = utxo_lib_1.smarttxs.getFundedTxBuilder(unsignedTxHex, utxo_lib_1.networks.verus, utxos.map(x => Buffer.from(x.script, 'hex')));
        for (let i = 0; i < keys.length; i++) {
            if (utxos[i] && keys[i] && Array.isArray(keys[i]) && keys[i].length > 0) {
                const keysForInput = keys[i];
                for (let j = 0; j < keysForInput.length; j++) {
                    if (keysForInput[j]) {
                        const keyPair = utxo_lib_1.ECPair.fromWIF(keysForInput[j], utxo_lib_1.networks.verus);
                        txb.sign(i, keyPair, null, utxo_lib_1.Transaction.SIGHASH_ALL, utxos[i].satoshis);
                    }
                }
            }
        }
        const signedHex = txb.build().toHex();
        (0, updateLimits_1.validateIdentityUpdateTransactionSize)(signedHex);
        if (fundingApproval)
            (0, updateFundingVerification_1.verifyIdentityUpdateFunding)(fundingApproval, signedHex, utxos, lockContext);
        return signedHex;
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
