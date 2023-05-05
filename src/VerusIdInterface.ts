import { AxiosRequestConfig } from "axios";
import {
  GetIdentityResponse,
  LoginConsentRequest,
  VerusIDSignature,
  LOGIN_CONSENT_REQUEST_SIG_VDXF_KEY,
  LoginConsentChallenge,
  LoginConsentProvisioningRequest,
  LoginConsentProvisioningChallenge,
  LoginConsentResponse,
  LoginConsentDecision,
  LoginConsentProvisioningDecision,
  LoginConsentProvisioningResponse,
  LOGIN_CONSENT_RESPONSE_SIG_VDXF_KEY,
  SignedSessionObject,
  SignedSessionObjectData,
} from "verus-typescript-primitives";
import { VerusdRpcInterface } from "verusd-rpc-ts-client";
import {
  IdentitySignature,
  ECPair,
  networks,
  address
} from "@bitgo/utxo-lib";
import { BlockInfo } from "verus-typescript-primitives/dist/block/BlockInfo";
import BigNumber from "bignumber.js"

const VRSC_I_ADDRESS = "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV"
const ID_SIG_VERSION = 2
const ID_SIG_TYPE = 5
const LOGIN_CONSENT_SIG_TIME_DIFF_THRESHOLD = 3600

class VerusIdInterface {
  interface: VerusdRpcInterface;

  constructor(chain: string, baseURL: string, config?: AxiosRequestConfig) {
    this.interface = new VerusdRpcInterface(chain, baseURL, config);
  }

  async getCurrentHeight() {
    const _infores = await this.interface.getInfo();
    if (_infores.error) throw new Error(_infores.error.message);
    const info = _infores.result!;
    return info.longestchain;
  }

  async getChainId() {
    if (this.interface.chain === "VRSC") {
      return VRSC_I_ADDRESS;
    } else {
      const _currres = await this.interface.getCurrency(this.interface.chain);
      if (_currres.error) throw new Error(_currres.error.message);

      return _currres.result!.currencyid;
    }
  }

  async signMessage(
    iAddrOrIdentity: string,
    message: string,
    primaryAddrWif: string,
    getIdentityResult?: GetIdentityResponse["result"],
    currentHeight?: number,
    chainIAddr?: string
  ): Promise<string> {
    return this.signHashOrMessage(
      iAddrOrIdentity,
      message,
      primaryAddrWif,
      getIdentityResult,
      currentHeight,
      chainIAddr
    );
  }

  async signHash(
    iAddrOrIdentity: string,
    hash: Buffer,
    primaryAddrWif: string,
    getIdentityResult?: GetIdentityResponse["result"],
    currentHeight?: number,
    chainIAddr?: string
  ): Promise<string> {
    return this.signHashOrMessage(
      iAddrOrIdentity,
      hash,
      primaryAddrWif,
      getIdentityResult,
      currentHeight,
      chainIAddr
    );
  }

  private async signHashOrMessage(
    iAddrOrIdentity: string,
    hashOrMessage: Buffer | string,
    primaryAddrWif: string,
    getIdentityResult?: GetIdentityResponse["result"],
    currentHeight?: number,
    chainIAddr?: string
  ): Promise<string> {
    let identity;
    let height;
    let chainId;

    if (getIdentityResult != null) {
      identity = getIdentityResult;
    } else {
      const _idres = await this.interface.getIdentity(iAddrOrIdentity);
      if (_idres.error) throw new Error(_idres.error.message);
      identity = _idres.result!;
    }

    if (identity.status !== "active") {
      throw new Error("Cannot create a valid signature for a revoked identity");
    }

    if (currentHeight != null) {
      height = currentHeight;
    } else {
      height = await this.getCurrentHeight();
    }

    if (chainIAddr != null) {
      chainId = chainIAddr;
    } else {
      chainId = await this.getChainId();
    }

    const keyPair = ECPair.fromWIF(primaryAddrWif, networks.verus);

    const sig = new IdentitySignature(
      networks.verus,
      ID_SIG_VERSION,
      ID_SIG_TYPE,
      height,
      null,
      chainId,
      identity.identity.identityaddress!
    );

    if (Buffer.isBuffer(hashOrMessage)) {
      sig.signHashOffline(hashOrMessage, keyPair);
    } else {
      sig.signMessageOffline(hashOrMessage, keyPair);
    }

    return sig.toBuffer().toString("base64");
  }

  async verifyMessage(
    iAddrOrIdentity: string,
    base64Sig: string,
    message: string,
    getIdentityResult?: GetIdentityResponse["result"],
    chainIAddr?: string
  ) {
    return this.verifyHashOrMessage(
      iAddrOrIdentity,
      base64Sig,
      message,
      getIdentityResult,
      chainIAddr
    );
  }

  async verifyHash(
    iAddrOrIdentity: string,
    base64Sig: string,
    hash: Buffer,
    getIdentityResult?: GetIdentityResponse["result"],
    chainIAddr?: string
  ) {
    return this.verifyHashOrMessage(
      iAddrOrIdentity,
      base64Sig,
      hash,
      getIdentityResult,
      chainIAddr
    );
  }

  private async verifyHashOrMessage(
    iAddrOrIdentity: string,
    base64Sig: string,
    hashOrMessage: Buffer | string,
    getIdentityResult?: GetIdentityResponse["result"],
    chainIAddr?: string
  ) {
    let iAddress;
    let identityAtHeight;
    let chainId;

    try {
      address.fromBase58Check(iAddrOrIdentity);
      iAddress = iAddrOrIdentity;
    } catch (e) {
      const _idres = await this.interface.getIdentity(iAddrOrIdentity);
      if (_idres.error) throw new Error(_idres.error.message);
      const identity = _idres.result!;
      iAddress = identity.identity.identityaddress!;
    }

    const sig = new IdentitySignature(networks.verus);

    if (chainIAddr != null) chainId = chainIAddr;
    else chainId = await this.getChainId();

    sig.fromBuffer(Buffer.from(base64Sig, "base64"), 0, chainId, iAddress);

    if (getIdentityResult != null) {
      identityAtHeight = getIdentityResult;
    } else {
      const _idresatheight = await this.interface.getIdentity(
        iAddrOrIdentity,
        sig.blockHeight
      );
      if (_idresatheight.error) throw new Error(_idresatheight.error.message);
      identityAtHeight = _idresatheight.result!;
    }

    if (identityAtHeight.status !== "active") {
      return false;
    }

    const primaryAddresses = identityAtHeight.identity.primaryaddresses;
    const minsigs = identityAtHeight.identity.minimumsignatures;
    let sigs = 0;
    let signedBy: { [key: string]: boolean } = {};

    for (let j = 0; j < primaryAddresses.length; j++) {
      const signingAddress = primaryAddresses[j];
      if (signedBy[signingAddress]) continue;

      const sigRes = Buffer.isBuffer(hashOrMessage)
        ? sig.verifyHashOffline(hashOrMessage, signingAddress)
        : sig.verifyMessageOffline(hashOrMessage, signingAddress);

      if (sigRes.some((x: boolean) => x === true)) {
        signedBy[signingAddress] = true;
      }
    }

    for (const key of Object.keys(signedBy)) {
      if (signedBy[key]) {
        sigs += 1;
      }

      if (sigs == minsigs) return true;
    }

    return false;
  }

  async getSignatureInfo(
    iAddrOrIdentity: string,
    base64Sig: string,
    chainIAddr?: string
  ): Promise<{
    version: number;
    hashtype: number;
    height: number;
  }> {
    let iAddress;
    let chainId;

    try {
      address.fromBase58Check(iAddrOrIdentity);
      iAddress = iAddrOrIdentity;
    } catch (e) {
      const _idres = await this.interface.getIdentity(iAddrOrIdentity);
      if (_idres.error) throw new Error(_idres.error.message);
      const identity = _idres.result!;
      iAddress = identity.identity.identityaddress!;
    }

    if (chainIAddr != null) chainId = chainIAddr;
    else chainId = await this.getChainId();

    const sig = new IdentitySignature(networks.verus);

    sig.fromBuffer(Buffer.from(base64Sig, "base64"), 0, chainId, iAddress);

    return {
      version: sig.version,
      hashtype: sig.hashType,
      height: sig.blockHeight,
    };
  }

  async signLoginConsentRequest(
    request: LoginConsentRequest,
    primaryAddrWif: string,
    getIdentityResult?: GetIdentityResponse["result"],
    currentHeight?: number
  ): Promise<LoginConsentRequest> {
    let height = currentHeight;

    if (height == null) {
      height = await this.getCurrentHeight();
    }

    const sig = await this.signHash(
      request.signing_id,
      request.getChallengeHash(height),
      primaryAddrWif,
      getIdentityResult,
      height,
      request.system_id
    );

    request.signature = new VerusIDSignature(
      { signature: sig },
      LOGIN_CONSENT_REQUEST_SIG_VDXF_KEY
    );

    return request;
  }

  async createLoginConsentRequest(
    signingId: string,
    challenge: LoginConsentChallenge,
    primaryAddrWif?: string,
    getIdentityResult?: GetIdentityResponse["result"],
    currentHeight?: number,
    chainIAddr?: string
  ): Promise<LoginConsentRequest> {
    let chainId: string;

    if (chainIAddr != null) chainId = chainIAddr;
    else chainId = await this.getChainId();

    const req = new LoginConsentRequest({
      system_id: chainId,
      signing_id: signingId,
      challenge,
    });

    if (primaryAddrWif) {
      return this.signLoginConsentRequest(
        req,
        primaryAddrWif,
        getIdentityResult,
        currentHeight
      );
    } else return req;
  }

  async verifyLoginConsentRequest(
    request: LoginConsentRequest,
    getIdentityResult?: GetIdentityResponse["result"],
    chainIAddr?: string,
    sigBlockTime?: number
  ): Promise<boolean> {
    const sigInfo = await this.getSignatureInfo(
      request.signing_id,
      request.signature!.signature,
      chainIAddr
    );

    let blocktime;

    if (sigBlockTime) blocktime = sigBlockTime;
    else {
      const _blockres = await this.interface.getBlock(sigInfo.height);
      if (_blockres.error) throw new Error(_blockres.error.message);

      blocktime = (_blockres.result as BlockInfo).time;
    }

    if (
      BigNumber(blocktime)
        .minus(request.challenge.created_at)
        .abs()
        .isGreaterThan(LOGIN_CONSENT_SIG_TIME_DIFF_THRESHOLD)
    ) {
      return false
    }

    return this.verifyHash(
      request.signing_id,
      request.signature!.signature,
      request.getChallengeHash(sigInfo.height),
      getIdentityResult,
      chainIAddr
    );
  }

  private async signResponse(
    response: LoginConsentResponse | LoginConsentProvisioningResponse,
    primaryAddrWif: string,
    getIdentityResult?: GetIdentityResponse["result"],
    currentHeight?: number
  ): Promise<LoginConsentResponse | LoginConsentProvisioningResponse> {
    let height = currentHeight;

    if (height == null) {
      height = await this.getCurrentHeight();
    }

    const sig = await this.signHash(
      response.signing_id,
      response.getDecisionHash(height),
      primaryAddrWif,
      getIdentityResult,
      height,
      response.system_id
    );

    response.signature = new VerusIDSignature(
      { signature: sig },
      LOGIN_CONSENT_RESPONSE_SIG_VDXF_KEY
    );

    return response;
  }

  private async createResponse(
    signingId: string,
    decision: LoginConsentDecision | LoginConsentProvisioningDecision,
    primaryAddrWif?: string,
    getIdentityResult?: GetIdentityResponse["result"],
    currentHeight?: number,
    chainIAddr?: string
  ): Promise<LoginConsentResponse | LoginConsentProvisioningResponse> {
    let chainId: string;

    if (chainIAddr != null) chainId = chainIAddr;
    else chainId = await this.getChainId();

    const req =
      decision instanceof LoginConsentProvisioningDecision
        ? new LoginConsentProvisioningResponse({
            system_id: chainId,
            signing_id: signingId,
            decision: decision as LoginConsentProvisioningDecision,
          })
        : new LoginConsentResponse({
            system_id: chainId,
            signing_id: signingId,
            decision: decision as LoginConsentDecision,
          });

    if (primaryAddrWif) {
      return this.signLoginConsentResponse(
        req,
        primaryAddrWif,
        getIdentityResult,
        currentHeight
      );
    } else return req;
  }

  private async verifyResponse(
    response: LoginConsentResponse | LoginConsentProvisioningResponse,
    getIdentityResult?: GetIdentityResponse["result"],
    chainIAddr?: string
  ): Promise<boolean> {
    const sigInfo = await this.getSignatureInfo(
      response.signing_id,
      response.signature!.signature,
      chainIAddr
    );

    return this.verifyHash(
      response.signing_id,
      response.signature!.signature,
      response.getDecisionHash(sigInfo.height),
      getIdentityResult,
      chainIAddr
    );
  }

  async verifySignedSessionObject(
    object: SignedSessionObject,
    getIdentityResult?: GetIdentityResponse["result"],
    chainIAddr?: string
  ): Promise<boolean> {
    const sigInfo = await this.getSignatureInfo(
      object.signing_id,
      object.signature!.signature,
      chainIAddr
    );

    return this.verifyHash(
      object.signing_id,
      object.signature!.signature,
      object.getDataHash(sigInfo.height),
      getIdentityResult,
      chainIAddr
    );
  }

  async signSessionObject(
    object: SignedSessionObject,
    primaryAddrWif: string,
    getIdentityResult?: GetIdentityResponse["result"],
    currentHeight?: number
  ): Promise<SignedSessionObject> {
    let height = currentHeight;

    if (height == null) {
      height = await this.getCurrentHeight();
    }

    const sig = await this.signHash(
      object.signing_id,
      object.getDataHash(height),
      primaryAddrWif,
      getIdentityResult,
      height,
      object.system_id
    );

    object.signature = new VerusIDSignature(
      { signature: sig },
      LOGIN_CONSENT_RESPONSE_SIG_VDXF_KEY
    );

    return object;
  }

  async createSignedSessionObject(
    signingId: string,
    data: SignedSessionObjectData,
    primaryAddrWif?: string,
    getIdentityResult?: GetIdentityResponse["result"],
    currentHeight?: number,
    chainIAddr?: string
  ): Promise<SignedSessionObject> {
    let chainId: string;

    if (chainIAddr != null) chainId = chainIAddr;
    else chainId = await this.getChainId();

    const object = new SignedSessionObject({
      signing_id: signingId,
      data,
      system_id: chainId
    })

    if (primaryAddrWif) {
      return this.signSessionObject(
        object,
        primaryAddrWif,
        getIdentityResult,
        currentHeight
      );
    } else return object;
  }

  async signLoginConsentResponse(
    response: LoginConsentResponse,
    primaryAddrWif: string,
    getIdentityResult?: GetIdentityResponse["result"],
    currentHeight?: number
  ): Promise<LoginConsentResponse> {
    return this.signResponse(
      response,
      primaryAddrWif,
      getIdentityResult,
      currentHeight
    );
  }

  async createLoginConsentResponse(
    signingId: string,
    decision: LoginConsentDecision,
    primaryAddrWif?: string,
    getIdentityResult?: GetIdentityResponse["result"],
    currentHeight?: number,
    chainIAddr?: string
  ): Promise<LoginConsentResponse> {
    return this.createResponse(
      signingId,
      decision,
      primaryAddrWif,
      getIdentityResult,
      currentHeight,
      chainIAddr
    );
  }

  async verifyLoginConsentResponse(
    response: LoginConsentResponse,
    getIdentityResult?: GetIdentityResponse["result"],
    chainIAddr?: string
  ): Promise<boolean> {
    return this.verifyResponse(response, getIdentityResult, chainIAddr);
  }

  async signVerusIdProvisioningResponse(
    response: LoginConsentProvisioningResponse,
    primaryAddrWif: string,
    getIdentityResult?: GetIdentityResponse["result"],
    currentHeight?: number
  ): Promise<LoginConsentProvisioningResponse> {
    return this.signResponse(
      response,
      primaryAddrWif,
      getIdentityResult,
      currentHeight
    );
  }

  async createVerusIdProvisioningResponse(
    signingId: string,
    decision: LoginConsentProvisioningDecision,
    primaryAddrWif?: string,
    getIdentityResult?: GetIdentityResponse["result"],
    currentHeight?: number,
    chainIAddr?: string
  ): Promise<LoginConsentProvisioningResponse> {
    return this.createResponse(
      signingId,
      decision,
      primaryAddrWif,
      getIdentityResult,
      currentHeight,
      chainIAddr
    );
  }

  async verifyVerusIdProvisioningResponse(
    response: LoginConsentProvisioningResponse,
    getIdentityResult?: GetIdentityResponse["result"],
    chainIAddr?: string
  ): Promise<boolean> {
    return this.verifyResponse(response, getIdentityResult, chainIAddr);
  }

  static signHashWithAddress(hash: Buffer, wif: string): string {
    const keyPair = ECPair.fromWIF(wif, networks.verus);

    const sig = new IdentitySignature(networks.verus);
    return sig.signHashOffline(hash, keyPair).toString("base64");
  }

  static async signVerusIdProvisioningRequest(
    request: LoginConsentProvisioningRequest,
    addrWif: string
  ): Promise<LoginConsentProvisioningRequest> {
    const sig = VerusIdInterface.signHashWithAddress(
      request.getChallengeHash(),
      addrWif
    );

    request.signature = new VerusIDSignature(
      { signature: sig },
      LOGIN_CONSENT_REQUEST_SIG_VDXF_KEY
    );

    return request;
  }

  static async createVerusIdProvisioningRequest(
    signingAddress: string,
    challenge: LoginConsentProvisioningChallenge,
    addrWif?: string
  ): Promise<LoginConsentProvisioningRequest> {
    const req = new LoginConsentProvisioningRequest({
      signing_address: signingAddress,
      challenge,
    });

    if (addrWif) {
      return VerusIdInterface.signVerusIdProvisioningRequest(req, addrWif);
    } else return req;
  }

  static async verifyVerusIdProvisioningRequest(
    request: LoginConsentProvisioningRequest,
    address: string
  ): Promise<LoginConsentProvisioningRequest> {
    const sig = new IdentitySignature(
      networks.verus,
      ID_SIG_VERSION,
      ID_SIG_TYPE,
      null,
      [Buffer.from(request.signature!.signature, "base64")]
    );

    return sig.verifyHashOffline(request.getChallengeHash(), address)[0];
  }
}

export default VerusIdInterface