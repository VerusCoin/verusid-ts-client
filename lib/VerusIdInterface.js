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
const VRSC_I_ADDRESS = "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV";
const ID_SIG_VERSION = 2;
const ID_SIG_TYPE = 5;
const LOGIN_CONSENT_SIG_TIME_DIFF_THRESHOLD = 3600;
class VerusIdInterface {
    constructor(chain, baseURL, config) {
        this.interface = new verusd_rpc_ts_client_1.VerusdRpcInterface(chain, baseURL, config);
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
            if (this.interface.chain === "VRSC") {
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
    signLoginConsentRequest(request, primaryAddrWif, getIdentityResult, currentHeight) {
        return __awaiter(this, void 0, void 0, function* () {
            let height = currentHeight;
            if (height == null) {
                height = yield this.getCurrentHeight();
            }
            const sig = yield this.signHash(request.signing_id, request.getChallengeHash(height), primaryAddrWif, getIdentityResult, height, request.system_id);
            request.signature = new verus_typescript_primitives_1.VerusIDSignature({ signature: sig }, verus_typescript_primitives_1.LOGIN_CONSENT_REQUEST_SIG_VDXF_KEY);
            return request;
        });
    }
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
    verifyLoginConsentRequest(request, getIdentityResult, chainIAddr, sigBlockTime) {
        return __awaiter(this, void 0, void 0, function* () {
            const sigInfo = yield this.getSignatureInfo(request.signing_id, request.signature.signature, chainIAddr);
            let blocktime;
            if (sigBlockTime)
                blocktime = sigBlockTime;
            else {
                const _blockres = yield this.interface.getBlock(sigInfo.height);
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
    signResponse(response, primaryAddrWif, getIdentityResult, currentHeight) {
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
    createResponse(signingId, decision, primaryAddrWif, getIdentityResult, currentHeight, chainIAddr) {
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
    verifyResponse(response, getIdentityResult, chainIAddr) {
        return __awaiter(this, void 0, void 0, function* () {
            const sigInfo = yield this.getSignatureInfo(response.signing_id, response.signature.signature, chainIAddr);
            return this.verifyHash(response.signing_id, response.signature.signature, response.getDecisionHash(sigInfo.height), getIdentityResult, chainIAddr);
        });
    }
    verifySignedSessionObject(object, getIdentityResult, chainIAddr) {
        return __awaiter(this, void 0, void 0, function* () {
            const sigInfo = yield this.getSignatureInfo(object.signing_id, object.signature.signature, chainIAddr);
            return this.verifyHash(object.signing_id, object.signature.signature, object.getDataHash(sigInfo.height), getIdentityResult, chainIAddr);
        });
    }
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
    signLoginConsentResponse(response, primaryAddrWif, getIdentityResult, currentHeight) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.signResponse(response, primaryAddrWif, getIdentityResult, currentHeight);
        });
    }
    createLoginConsentResponse(signingId, decision, primaryAddrWif, getIdentityResult, currentHeight, chainIAddr) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.createResponse(signingId, decision, primaryAddrWif, getIdentityResult, currentHeight, chainIAddr);
        });
    }
    verifyLoginConsentResponse(response, getIdentityResult, chainIAddr) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.verifyResponse(response, getIdentityResult, chainIAddr);
        });
    }
    signVerusIdProvisioningResponse(response, primaryAddrWif, getIdentityResult, currentHeight) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.signResponse(response, primaryAddrWif, getIdentityResult, currentHeight);
        });
    }
    createVerusIdProvisioningResponse(signingId, decision, primaryAddrWif, getIdentityResult, currentHeight, chainIAddr) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.createResponse(signingId, decision, primaryAddrWif, getIdentityResult, currentHeight, chainIAddr);
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
            request.signature = new verus_typescript_primitives_1.VerusIDSignature({ signature: sig }, verus_typescript_primitives_1.LOGIN_CONSENT_REQUEST_SIG_VDXF_KEY);
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
}
exports.default = VerusIdInterface;
