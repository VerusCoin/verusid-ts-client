import { AxiosRequestConfig } from "axios";
import {
  GetIdentityResponse,
  LoginConsentRequest,
  VerusIDSignature,
  IDENTITY_AUTH_SIG_VDXF_KEY,
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
  VerusPayInvoice,
  VerusPayInvoiceDetails,
  Identity,
  GetAddressUtxosResponse,
  FundRawTransactionResponse,
  decompile,
  OptCCParams,
  OPS,
  EVALS,
  IdentityUpdateRequestDetails,
  VerusCLIVerusIDJson,
  PartialIdentity,
  GenericRequest,
  GenericRequestInterface,
  GenericResponse,
  GenericResponseInterface,
  VERUSPAY_VERSION_3,
  OrdinalVDXFObject,
  AuthenticationRequestOrdinalVDXFObject,
  IdentityUpdateRequestOrdinalVDXFObject,
  VerusPayInvoiceDetailsOrdinalVDXFObject,
  ProvisionIdentityDetailsOrdinalVDXFObject,
  AppEncryptionRequestOrdinalVDXFObject,
  CreateWalletBackupDetailsOrdinalVDXFObject,
  TransferDestination
} from "verus-typescript-primitives";
import { VerusdRpcInterface } from "verusd-rpc-ts-client";
import {
  IdentitySignature,
  ECPair,
  networks,
  address,
  smarttxs,
  Transaction
} from "@bitgo/utxo-lib";
import { BlockInfo } from "verus-typescript-primitives/dist/block/BlockInfo";
import BigNumber from "bignumber.js"
import { BN } from "bn.js";
import { GenericEnvelope } from "verus-typescript-primitives/dist/vdxf/classes/envelope/GenericEnvelope";
import { APIAuthData, RPCRequestOverride } from "verusd-rpc-ts-client/lib/VerusdRpcInterface";

const { createUnfundedCurrencyTransfer, createUnfundedIdentityUpdate, validateFundedCurrencyTransfer, completeFundedIdentityUpdate } = smarttxs;

const VRSC_I_ADDRESS = "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV"
const ID_SIG_VERSION = 2
const ID_SIG_TYPE = 5
const LOGIN_CONSENT_SIG_TIME_DIFF_THRESHOLD = 3600

export type CurrencyTransferOutput = {
  currency: string;
  satoshis: string;
  convertto?: string;
  exportto?: string;
  feecurrency?: string;
  via?: string;
  feesatoshis?: string;
  address: TransferDestination;
  refundto?: TransferDestination;
  preconvert?: boolean;
  burn?: boolean;
  burnweight?: boolean;
  mintnew?: boolean;
  importtosource?: boolean;
  bridgeid?: string;
  vdxftag?: string;
}

export type IdentityUpdateCurrencySweepOptions = {
  chainIAddr?: string;
  maxFee?: number;
  fundRawTransactionResult?: FundRawTransactionResponse["result"];
  currentHeight?: number;
  updateIdentityTransactionHex?: string;
  parseVdxfObjects?: boolean;
  isTestnet?: boolean;
  expectedIdentityPrimaryAddress?: string;
  // Only use this for trusted callers or static fixtures that cannot provide previous raw transactions.
  allowUnverifiedPrevouts?: boolean;
}

export type IdentityUpdateTransactionResult = {
  hex: string;
  utxos: GetAddressUtxosResponse["result"];
  identity: Identity;
  deltas: Map<string, BigNumber>;
}

type PreparedIdentityUpdateTransaction = {
  height: number;
  identityTransaction: typeof Transaction;
  identityAddress: string;
  identityOnOutput: Identity;
  unfundedTxHex: string;
  vout: number;
}

type FundedCurrencyValidation = {
  valid: boolean;
  message?: string;
  fees?: { [currency: string]: string };
  sent?: { [currency: string]: string };
}

class VerusIdInterface {
  interface: VerusdRpcInterface;

  constructor(
    chain: string, 
    baseURL: string, 
    config?: AxiosRequestConfig, 
    rpcRequestOverride?: RPCRequestOverride, 
    APIAuth?: APIAuthData
  ) {
    this.interface = new VerusdRpcInterface(chain, baseURL, config, rpcRequestOverride, APIAuth);
  }

  async getCurrentHeight() {
    const _infores = await this.interface.getInfo();
    if (_infores.error) throw new Error(_infores.error.message);
    const info = _infores.result!;
    return info.longestchain;
  }

  async getChainId() {
    if (this.interface.chain === "VRSC" || this.interface.chain === VRSC_I_ADDRESS) {
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

  /**
   * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
   */
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
      IDENTITY_AUTH_SIG_VDXF_KEY
    );

    return request;
  }

  /**
   * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
   */
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

  /**
   * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
   */
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
      const _blockres = await this.interface.getBlock(sigInfo.height.toString());
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

  /**
   * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
   */
  private async signLoginResponse(
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

  /**
   * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
   */
  private async createLoginResponse(
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

  /**
   * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
   */
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

  /**
   * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
   */
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

  /**
   * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
   */
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

  /**
   * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
   */
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

  /**
   * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
   */
  async signLoginConsentResponse(
    response: LoginConsentResponse,
    primaryAddrWif: string,
    getIdentityResult?: GetIdentityResponse["result"],
    currentHeight?: number
  ): Promise<LoginConsentResponse> {
    return this.signLoginResponse(
      response,
      primaryAddrWif,
      getIdentityResult,
      currentHeight
    );
  }

  /**
   * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
   */
  async createLoginConsentResponse(
    signingId: string,
    decision: LoginConsentDecision,
    primaryAddrWif?: string,
    getIdentityResult?: GetIdentityResponse["result"],
    currentHeight?: number,
    chainIAddr?: string
  ): Promise<LoginConsentResponse> {
    return this.createLoginResponse(
      signingId,
      decision,
      primaryAddrWif,
      getIdentityResult,
      currentHeight,
      chainIAddr
    );
  }

  /**
   * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
   */
  async verifyLoginConsentResponse(
    response: LoginConsentResponse,
    getIdentityResult?: GetIdentityResponse["result"],
    chainIAddr?: string
  ): Promise<boolean> {
    return this.verifyResponse(response, getIdentityResult, chainIAddr);
  }

  /**
   * @deprecated Legacy VerusPay implementation, use GenericRequest class with invoice objects in details array
   */
  async createVerusPayInvoice(
    details: VerusPayInvoiceDetails,
    signingIdIAddr?: string,
    primaryAddrWif?: string,
    getIdentityResult?: GetIdentityResponse["result"],
    currentHeight?: number,
    chainIAddr?: string
  ): Promise<VerusPayInvoice> {
    let chainId: string;

    if (chainIAddr != null) chainId = chainIAddr;
    else chainId = await this.getChainId();

    const inv = new VerusPayInvoice({
      details: details,
      version: VERUSPAY_VERSION_3
    });

    if (signingIdIAddr && primaryAddrWif) {
      return this.signVerusPayInvoice(
        inv,
        signingIdIAddr!,
        chainId,
        primaryAddrWif,
        getIdentityResult,
        currentHeight
      );
    } else return inv;
  }

  /**
   * @deprecated Legacy VerusPay implementation, use GenericRequest class with invoice objects in details array
   */
  async signVerusPayInvoice(
    invoice: VerusPayInvoice,
    signingIdIAddr: string,
    systemIdIAddr: string,
    primaryAddrWif: string,
    getIdentityResult?: GetIdentityResponse["result"],
    currentHeight?: number
  ): Promise<VerusPayInvoice> {
    let height = currentHeight;

    if (height == null) {
      height = await this.getCurrentHeight();
    }

    invoice.setSigned();
    invoice.signing_id = signingIdIAddr;
    invoice.system_id = systemIdIAddr;

    const sig = await this.signHash(
      signingIdIAddr,
      invoice.getDetailsHash(height),
      primaryAddrWif,
      getIdentityResult,
      height,
      systemIdIAddr
    );

    invoice.signature = new VerusIDSignature(
      { signature: sig },
      IDENTITY_AUTH_SIG_VDXF_KEY,
      false
    );

    return invoice;
  }

  /**
   * @deprecated Legacy VerusPay implementation, use GenericRequest class with invoice objects in details array
   */
  async verifySignedVerusPayInvoice(
    invoice: VerusPayInvoice,
    getIdentityResult?: GetIdentityResponse["result"],
    chainIAddr?: string
  ): Promise<boolean> {
    const sigInfo = await this.getSignatureInfo(
      invoice.signing_id,
      invoice.signature!.signature,
      chainIAddr
    );

    return this.verifyHash(
      invoice.signing_id,
      invoice.signature!.signature,
      invoice.getDetailsHash(sigInfo.height, sigInfo.version),
      getIdentityResult,
      chainIAddr
    );
  }

  async signVerusIdProvisioningResponse(
    response: LoginConsentProvisioningResponse,
    primaryAddrWif: string,
    getIdentityResult?: GetIdentityResponse["result"],
    currentHeight?: number
  ): Promise<LoginConsentProvisioningResponse> {
    return this.signLoginResponse(
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
    return this.createLoginResponse(
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
      IDENTITY_AUTH_SIG_VDXF_KEY
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

  private static getIdentityFromIdTx(
    transaction: typeof Transaction,
    idAddr: string,
    parseVdxfObjects: boolean,
    strict: boolean = false
  ): { vout: number, identity: Identity } {
    let index = -1;
    let id: Identity | null = null;

    for (let i = 0; i < transaction.outs.length; i++) {
      const decomp = decompile(transaction.outs[i].script);

      if (decomp.length !== 4 || decomp[1] !== OPS.OP_CHECKCRYPTOCONDITION || decomp[3] !== OPS.OP_DROP) {
        if (strict) throw new Error("Unknown script format output found in transaction");
        continue;
      }

      const outMaster = OptCCParams.fromChunk(decomp[0] as Buffer);
      const outParams = OptCCParams.fromChunk(decomp[2] as Buffer);

      if (!outMaster.evalCode.eq(new BN(EVALS.EVAL_NONE))) {
        if (strict) throw new Error("Unsupported master eval code " + outMaster.evalCode.toNumber() + " found in transaction output");
        continue;
      }

      // Notary evidence eval codes are supported even in strict mode to allow for data included in the transaction as a result of
      // a signdata style updateidentity request. The data itself isn't verified and must be clearly displayed to the user, or the app
      // must verify that the key the data is under is indeed in the request signer's namespace
      if (!outParams.evalCode.eq(new BN(EVALS.EVAL_IDENTITY_PRIMARY))) {
        if (strict && !outParams.evalCode.eq(new BN(EVALS.EVAL_NOTARY_EVIDENCE))) {
          throw new Error("Unsupported params eval code " + outParams.evalCode.toNumber() + " found in transaction output");
        }

        continue;
      }

      if (strict && id != null) throw new Error("Multiple identity outputs found in transaction");

      id = new Identity();
      id.fromBuffer(outParams.getParamObject()!, 0, parseVdxfObjects);

      if (id.getIdentityAddress() === idAddr) {
        index = i;
        if (!strict) break;
      } else if (strict) {
        throw new Error("Identity output does not match identity address");
      }
    }

    if (index < 0) {
      throw new Error("Identity output not found");
    } else {
      return { vout: index, identity: id! }
    }
  }

  private static addNegativeDelta(deltas: Map<string, BigNumber>, key: string, value: BigNumber) {
    if (deltas.has(key)) deltas.set(key, deltas.get(key)!.minus(value))
    else deltas.set(key, value.multipliedBy(BigNumber(-1)))
  }

  private static addValidationFeesToDeltas(validation: FundedCurrencyValidation, deltas: Map<string, BigNumber>) {
    for (const key in validation.fees) {
      VerusIdInterface.addNegativeDelta(deltas, key, BigNumber(validation.fees[key]))
    }
  }

  private static addValidationSentToDeltas(validation: FundedCurrencyValidation, deltas: Map<string, BigNumber>) {
    for (const key in validation.sent) {
      VerusIdInterface.addNegativeDelta(deltas, key, BigNumber(validation.sent[key]))
    }
  }

  private static validateNoUnexpectedCurrencySent(validation: FundedCurrencyValidation) {
    for (const key in validation.sent) {
      if (BigNumber(validation.sent[key]).isGreaterThan(BigNumber(0))) {
        throw new Error("Cannot send currency and update ID.")
      }
    }
  }

  private static getExpectedSentFromSweepOutputs(sweepOutputs: CurrencyTransferOutput[]): Map<string, BigNumber> {
    const expectedSent = new Map<string, BigNumber>();

    for (const output of sweepOutputs) {
      const satoshis = BigNumber(output.satoshis);

      if (!satoshis.isFinite() || satoshis.isNegative()) {
        throw new Error("Sweep output satoshis must be a non-negative integer string.")
      }

      if (expectedSent.has(output.currency)) expectedSent.set(output.currency, expectedSent.get(output.currency)!.plus(satoshis))
      else expectedSent.set(output.currency, satoshis)
    }

    return expectedSent;
  }

  private static getDestinationFees(destination: TransferDestination): BigNumber {
    let fees = BigNumber(destination.fees != null ? destination.fees.toString() : 0);

    for (const auxDest of destination.auxDests || []) {
      fees = fees.plus(VerusIdInterface.getDestinationFees(auxDest))
    }

    return fees;
  }

  private static getExpectedFeesFromSweepOutputs(sweepOutputs: CurrencyTransferOutput[], chainId: string): Map<string, BigNumber> {
    const expectedFees = new Map<string, BigNumber>();

    for (const output of sweepOutputs) {
      const isReserveTransfer = output.feecurrency != null ||
                                output.feesatoshis != null ||
                                output.convertto != null ||
                                output.exportto != null ||
                                output.via != null;

      if (!isReserveTransfer) continue;

      const feeCurrency = output.feecurrency ? output.feecurrency : chainId;
      const outputFees = BigNumber(output.feesatoshis ? output.feesatoshis : "300000")
        .plus(VerusIdInterface.getDestinationFees(output.address));

      if (expectedFees.has(feeCurrency)) expectedFees.set(feeCurrency, expectedFees.get(feeCurrency)!.plus(outputFees))
      else expectedFees.set(feeCurrency, outputFees)
    }

    return expectedFees;
  }

  private static validateSweepSent(validation: FundedCurrencyValidation, expectedSent: Map<string, BigNumber>) {
    const keys = new Set<string>([
      ...Object.keys(validation.sent ? validation.sent : {}),
      ...Array.from(expectedSent.keys())
    ]);

    keys.forEach(key => {
      const actual = BigNumber(validation.sent && validation.sent[key] != null ? validation.sent[key] : 0);
      const expected = expectedSent.get(key) || BigNumber(0);

      if (!actual.isEqualTo(expected)) {
        throw new Error("Sent currency delta does not match explicit sweep output for " + key + ".")
      }
    })
  }

  private static validateFees(
    validation: FundedCurrencyValidation,
    expectedExplicitFees: Map<string, BigNumber>,
    chainId: string,
    maxFee: number
  ) {
    const maxNativeFeeSatoshis = BigNumber(maxFee).multipliedBy(BigNumber(10).pow(BigNumber(8)));

    if (!maxNativeFeeSatoshis.isFinite() || maxNativeFeeSatoshis.isNegative()) {
      throw new Error("Maximum fee must be a non-negative finite number.")
    }

    const keys = new Set<string>([
      chainId,
      ...Object.keys(validation.fees ? validation.fees : {}),
      ...Array.from(expectedExplicitFees.keys())
    ]);

    keys.forEach(key => {
      const actual = BigNumber(validation.fees && validation.fees[key] != null ? validation.fees[key] : 0);
      const expectedExplicitFee = expectedExplicitFees.get(key) || BigNumber(0);

      if (actual.isLessThan(expectedExplicitFee)) {
        throw new Error("Fee is lower than explicit fee output for " + key + ".")
      }

      if (key === chainId) {
        if (actual.isGreaterThan(maxNativeFeeSatoshis)) {
          throw new Error("Fee exceeds maximum permissable fee value.")
        }
      } else if (!actual.isEqualTo(expectedExplicitFee)) {
        throw new Error("Unexpected fee currency delta for " + key + ".")
      }
    })
  }

  private static getFundingUtxosFromTransaction(
    fundedTxHex: string,
    utxoList: GetAddressUtxosResponse["result"]
  ): GetAddressUtxosResponse["result"] {
    const fundedTx = Transaction.fromHex(fundedTxHex, networks.verus);
    const utxosUsed: GetAddressUtxosResponse["result"] = [];

    fundedTx.ins.forEach((input: {
      hash: Buffer,
      index: number,
      script: Buffer,
      sequence: BigNumber,
      witness: Array<any>
    }) => {
      const inputFromList = utxoList.find(utxo => {
        const inputHash = Buffer.from(input.hash).reverse().toString('hex');

        return utxo.txid === inputHash && utxo.outputIndex === input.index;
      });

      if (inputFromList) {
        utxosUsed.push(inputFromList);
      } else throw new Error("Input not found in UTXO list");
    })

    return utxosUsed;
  }

  private async getVerifiedFundingUtxosFromTransaction(
    fundedTxHex: string,
    utxoList: GetAddressUtxosResponse["result"],
    allowUnverifiedPrevouts: boolean = false
  ): Promise<GetAddressUtxosResponse["result"]> {
    if (allowUnverifiedPrevouts) return VerusIdInterface.getFundingUtxosFromTransaction(fundedTxHex, utxoList);

    const fundedTx = Transaction.fromHex(fundedTxHex, networks.verus);
    const txCache: Map<string, typeof Transaction> = new Map();
    const utxosUsed: GetAddressUtxosResponse["result"] = [];

    for (const input of fundedTx.ins as Array<{
      hash: Buffer,
      index: number,
      script: Buffer,
      sequence: BigNumber,
      witness: Array<any>
    }>) {
      const inputHash = Buffer.from(input.hash).reverse().toString('hex');
      const inputFromList = utxoList.find(utxo => utxo.txid === inputHash && utxo.outputIndex === input.index);

      if (!inputFromList) throw new Error("Input not found in UTXO list");

      let prevTx = txCache.get(inputHash);

      if (prevTx == null) {
        const rawTxRes = await this.interface.getRawTransaction(inputHash, 0);

        if (rawTxRes.error) throw new Error("Couldn't verify prevout " + inputHash + ": " + rawTxRes.error.message);

        const rawTx = rawTxRes.result;
        const rawTxHex = typeof rawTx === "string" ? rawTx : rawTx.hex;

        if (typeof rawTxHex !== "string") throw new Error("Couldn't verify prevout " + inputHash + ": missing raw transaction hex.");

        prevTx = Transaction.fromHex(rawTxHex, networks.verus);

        if (prevTx.getId() !== inputHash) {
          throw new Error("Prevout transaction hash mismatch for " + inputHash + ".");
        }

        txCache.set(inputHash, prevTx);
      }

      const prevOut = prevTx.outs[input.index];

      if (prevOut == null) throw new Error("Prevout " + inputHash + " index " + input.index + " not found.");

      utxosUsed.push({
        ...inputFromList,
        script: prevOut.script.toString('hex'),
        satoshis: prevOut.value
      });
    }

    return utxosUsed;
  }

  private static combineUnfundedTransactions(baseTxHex: string, outputsTxHex: string): string {
    const baseTx = Transaction.fromHex(baseTxHex, networks.verus);
    const outputsTx = Transaction.fromHex(outputsTxHex, networks.verus);

    if (baseTx.ins.length !== 0) throw new Error("Identity update transaction must be unfunded before combining sweep outputs.");
    if (outputsTx.ins.length !== 0) throw new Error("Currency sweep transaction must be unfunded before combining.");

    outputsTx.outs.forEach((output: { value: number, script: Buffer }) => {
      baseTx.outs.push(output)
    })

    return baseTx.toHex();
  }

  private static validateCompletedIdentityUpdateTransaction(
    fundedTxHex: string,
    completedTxHex: string,
    identityTransaction: typeof Transaction,
    identityVout: number
  ) {
    const fundedTx = Transaction.fromHex(fundedTxHex, networks.verus);
    const completedTx = Transaction.fromHex(completedTxHex, networks.verus);

    if (completedTx.outs.length !== fundedTx.outs.length) {
      throw new Error("Completed identity update output count does not match funded transaction.")
    }

    for (let i = 0; i < fundedTx.outs.length; i++) {
      if (completedTx.outs[i].value !== fundedTx.outs[i].value ||
          Buffer.from(completedTx.outs[i].script).toString('hex') !== Buffer.from(fundedTx.outs[i].script).toString('hex')) {
        throw new Error("Completed identity update outputs do not match funded transaction.")
      }
    }

    if (completedTx.ins.length !== fundedTx.ins.length + 1) {
      throw new Error("Completed identity update input count does not match funded transaction plus identity input.")
    }

    for (let i = 0; i < fundedTx.ins.length; i++) {
      if (Buffer.from(completedTx.ins[i].hash).toString('hex') !== Buffer.from(fundedTx.ins[i].hash).toString('hex') ||
          completedTx.ins[i].index !== fundedTx.ins[i].index ||
          completedTx.ins[i].sequence !== fundedTx.ins[i].sequence) {
        throw new Error("Completed identity update funding inputs do not match funded transaction.")
      }
    }

    const identityInput = completedTx.ins[fundedTx.ins.length];
    const expectedIdentityInputHash = Buffer.from(identityTransaction.getId(), 'hex').reverse();

    if (Buffer.from(identityInput.hash).toString('hex') !== expectedIdentityInputHash.toString('hex') || identityInput.index !== identityVout) {
      throw new Error("Completed identity update does not spend the expected identity output.")
    }
  }

  private static completeIdentityUpdateTransaction(
    fundedTxHex: string,
    utxoList: GetAddressUtxosResponse["result"],
    identityTransaction: typeof Transaction,
    identityVout: number
  ): string {
    const completeIdentityUpdate: string = completeFundedIdentityUpdate(
      fundedTxHex,
      networks.verus,
      utxoList.map(x => Buffer.from(x.script, 'hex')),
      {
        hash: Buffer.from(identityTransaction.getId(), 'hex').reverse(),
        index: identityVout,
        script: identityTransaction.outs[identityVout].script,
        sequence: 4294967295
      }
    )

    VerusIdInterface.validateCompletedIdentityUpdateTransaction(
      fundedTxHex,
      completeIdentityUpdate,
      identityTransaction,
      identityVout
    );

    return completeIdentityUpdate;
  }

  private static getIdentityDefinitionUtxo(
    identityAddress: string,
    identityTransaction: typeof Transaction,
    identityVout: number,
    identityTransactionHeight: number
  ): GetAddressUtxosResponse["result"][number] {
    return {
      address: identityAddress,
      txid: identityTransaction.getId(),
      outputIndex: identityVout,
      script: identityTransaction.outs[identityVout].script.toString('hex'),
      satoshis: 0,
      height: identityTransactionHeight,
      isspendable: 0,
      blocktime: 0 // Filled in to avoid getblock call because blocktime is not currently checked for the ID definition utxo
    }
  }

  private static validateIdentityPrimaryAddress(identity: Identity, expectedPrimaryAddress?: string) {
    if (expectedPrimaryAddress == null) return;

    const primaryAddresses = identity.toJson().primaryaddresses || [];

    if (primaryAddresses.length !== 1 || primaryAddresses[0] !== expectedPrimaryAddress) {
      throw new Error("Identity primary address must be exactly " + expectedPrimaryAddress + ".")
    }
  }

  private async prepareIdentityUpdateTransaction(
    identity: Identity | IdentityUpdateRequestDetails,
    rawIdentityTransaction: string,
    currentHeight?: number,
    updateIdentityTransactionHex?: string,
    parseVdxfObjects: boolean = true,
    isTestnet = false
  ): Promise<PreparedIdentityUpdateTransaction> {
    let height = currentHeight;

    if (height == null) {
      height = await this.getCurrentHeight();
    }

    const identityTransaction = Transaction.fromHex(rawIdentityTransaction, networks.verus);
    let unfundedTxHex: string;
    let identityAddress: string;
    let vout = -1
    let identityOnOutput: Identity;

    if (identity instanceof Identity) {
      // If identity is an identity object, assume that the object can be used at the output and that the user filled it in correctly
      identity.upgradeVersion();
      unfundedTxHex = createUnfundedIdentityUpdate(identity.toBuffer().toString('hex'), networks.verus, height + 20);

      identityAddress = identity.getIdentityAddress();
      const identityFromIdTx = VerusIdInterface.getIdentityFromIdTx(identityTransaction, identityAddress, parseVdxfObjects);

      vout = identityFromIdTx.vout;
      identityOnOutput = identity;
    } else if (identity instanceof IdentityUpdateRequestDetails) {
      // If identity is an identityupdaterequest, that only contains a partial identity with the changes the user wants to make, so we
      // need to fill in the rest of the ID in a way that doesn't trust the server without verification

      if (identity.containsTxid() && identity.getTxidString() !== identityTransaction.getId()) {
        throw new Error("Identity update request txid does not match the txid of the identity transaction")
      };

      if (updateIdentityTransactionHex) {
        unfundedTxHex = updateIdentityTransactionHex;
      } else {
        const idCliJson = identity.toCLIJson();
        const hexRes = (await this.interface.updateIdentity(idCliJson, true));

        if (hexRes.error) throw new Error(hexRes.error.message);
        else unfundedTxHex = hexRes.result;
      }

      const unfundedTx = Transaction.fromHex(unfundedTxHex, networks.verus);
      unfundedTx.ins = [];

      unfundedTxHex = unfundedTx.toHex();

      identityAddress = identity.getIdentityAddress(isTestnet);

      const detailsFromRawTransaction = VerusIdInterface.getIdentityFromIdTx(identityTransaction, identityAddress, parseVdxfObjects);
      vout = detailsFromRawTransaction.vout;

      const identityFromServer = VerusIdInterface.getIdentityFromIdTx(unfundedTx, identityAddress, parseVdxfObjects, true).identity;
      const identityFromRawTransaction = detailsFromRawTransaction.identity;
      const identityFromRawTransactionJson = identityFromRawTransaction.toJson();
      identityOnOutput = identityFromServer;

      const partialIdentity = identity.identity!.withResolvedContentMultiMap();
      const serverIdentityJson = identityFromServer.toJson();
      const partialIdentityJson = partialIdentity.toJson();

      const changedKeys = Object.keys(partialIdentityJson);

      // Compare keys that were both changed and unchanged to ensure that changes are the same in funded tx from server
      let serverChangedKeysComp: { [key: string]: any } = {};
      let serverUnchangedKeysComp: { [key: string]: any } = {};
      let fromTxUnchangedKeysComp:  { [key: string]: any } = {};

      // Separate out changed keys and unchanged keys, keeping name in all categories as it
      // should never be null or changed
      for (const key of Object.keys(identityFromRawTransactionJson) as Array<keyof VerusCLIVerusIDJson>) {
        if (key === 'name') {
          serverChangedKeysComp[key] = serverIdentityJson[key];
          serverUnchangedKeysComp[key] = serverIdentityJson[key];
          fromTxUnchangedKeysComp[key] = identityFromRawTransactionJson[key];
        } else if (changedKeys.includes(key)) {
          serverChangedKeysComp[key] = serverIdentityJson[key];
        } else {
          serverUnchangedKeysComp[key] = serverIdentityJson[key];
          fromTxUnchangedKeysComp[key] = identityFromRawTransactionJson[key];
        }
      }

      const serverKeysChangedCompJson = serverChangedKeysComp as VerusCLIVerusIDJson;
      const serverKeysUnchangedCompJson = serverUnchangedKeysComp as VerusCLIVerusIDJson;
      const fromTxKeysUnchangedCompJson = fromTxUnchangedKeysComp as VerusCLIVerusIDJson;

      // Ignore cmm fields that contained the "data" field because we can't establish if the cmm and/or encryption was
      // done correctly yet
      if (identity.containsSignData()) {
        if (serverKeysChangedCompJson.contentmultimap) {
          for (const [key, value] of identity.signDataMap!.entries()) {
            const iAddrKey = key.toAddress();

            delete serverKeysChangedCompJson.contentmultimap[iAddrKey];
          }
        } else throw new Error("Expected cmm in identity update request");
      } else if (unfundedTx.outs.length > 1) {
        // Outputs without signdata should only have an identity output and nothing else
        throw new Error("Expected only one output in identity update request");
      }

      // Create partialidentity from the server identity json, taking only keys that were submitted to be modified,
      // and then serialize it and compare it to the partial identity that was submitted, to ensure they are the same.
      const serverPartialIdChangedComp = PartialIdentity.fromJson(serverKeysChangedCompJson).withResolvedContentMultiMap();
      if (serverPartialIdChangedComp.toBuffer().toString('hex') !== partialIdentity.toBuffer().toString('hex')) {
        throw new Error(
          "Identity update request changes do not appear to match the changes in the identity transaction, got " +
          JSON.stringify(serverPartialIdChangedComp.toJson()) +
          " expected " +
          JSON.stringify(partialIdentity.toJson())
        );
      }

      const serverPartialIdUnchangedComp = PartialIdentity.fromJson(serverKeysUnchangedCompJson).withResolvedContentMultiMap();
      const fromTxPartialIdUnchangedComp = PartialIdentity.fromJson(fromTxKeysUnchangedCompJson).withResolvedContentMultiMap();
      if (serverPartialIdUnchangedComp.toBuffer().toString('hex') !== fromTxPartialIdUnchangedComp.toBuffer().toString('hex')) {
        throw new Error(
          "Unchanged identity properties returned from server do not appear to match the unchanged values from the identity transaction, got " +
          JSON.stringify(serverPartialIdUnchangedComp.toJson()) +
          " expected " +
          JSON.stringify(fromTxPartialIdUnchangedComp.toJson())
        );
      }
    } else throw new Error("Invalid identity type");

    return {
      height,
      identityTransaction,
      identityAddress,
      identityOnOutput,
      unfundedTxHex,
      vout
    }
  }

  // When using this function with a remote RPC server, PLEASE USE THE VERUSID DECODED FROM rawIdentityTransaction
  // AS YOUR BASE FOR PASSING IN THE IDENTITY PARAMETER (what you want to update). Otherwise if you're using an
  // untrusted server to get your identity base and then editing, you could be updating an ID with data you don't
  // want to update.
  async createUpdateIdentityTransaction(
    identity: Identity | IdentityUpdateRequestDetails,
    changeAddress: string,
    rawIdentityTransaction: string,
    identityTransactionHeight: number,
    utxoList?: GetAddressUtxosResponse["result"],
    chainIAddr?: string,
    maxFee: number = 5,
    fundRawTransactionResult?: FundRawTransactionResponse["result"],
    currentHeight?: number,
    updateIdentityTransactionHex?: string,
    parseVdxfObjects: boolean = true,
    isTestnet = false, // This parameter is only necessary if you pass in an IdentityUpdateRequestDetails
    allowUnverifiedPrevouts: boolean = false
  ): Promise<IdentityUpdateTransactionResult> {
    const preparedIdentityUpdate = await this.prepareIdentityUpdateTransaction(
      identity,
      rawIdentityTransaction,
      currentHeight,
      updateIdentityTransactionHex,
      parseVdxfObjects,
      isTestnet
    );

    let fundedTxHex;

    if (utxoList == null) {
      fundedTxHex = preparedIdentityUpdate.unfundedTxHex;
    } else if (fundRawTransactionResult == null) {
      const _fundRawTxRes = await this.interface.fundRawTransaction(
        preparedIdentityUpdate.unfundedTxHex,
        utxoList.map(utxo => {
          return {
            voutnum: utxo.outputIndex,
            txid: utxo.txid,
          };
        }),
        changeAddress
      );

      if (_fundRawTxRes.error) throw new Error("Couldn't fund raw transaction")
      else fundedTxHex = _fundRawTxRes.result.hex;
    } else fundedTxHex = fundRawTransactionResult.hex;

    const chainId = chainIAddr != null ? chainIAddr : await this.getChainId();
    const deltas: Map<string, BigNumber> = new Map();

    if (utxoList) {
      const verifiedFundingUtxos = await this.getVerifiedFundingUtxosFromTransaction(
        fundedTxHex,
        utxoList,
        allowUnverifiedPrevouts
      );
      const validation: FundedCurrencyValidation = validateFundedCurrencyTransfer(
        chainId,
        fundedTxHex,
        preparedIdentityUpdate.unfundedTxHex,
        changeAddress,
        networks.verus,
        verifiedFundingUtxos
      );

      if (!validation.valid) throw new Error(validation.message);

      VerusIdInterface.validateNoUnexpectedCurrencySent(validation);
      VerusIdInterface.validateFees(validation, new Map(), chainId, maxFee);
      VerusIdInterface.addValidationFeesToDeltas(validation, deltas);

      const completeIdentityUpdate = VerusIdInterface.completeIdentityUpdateTransaction(
        fundedTxHex,
        verifiedFundingUtxos,
        preparedIdentityUpdate.identityTransaction,
        preparedIdentityUpdate.vout
      );

      verifiedFundingUtxos.push(VerusIdInterface.getIdentityDefinitionUtxo(
        preparedIdentityUpdate.identityAddress,
        preparedIdentityUpdate.identityTransaction,
        preparedIdentityUpdate.vout,
        identityTransactionHeight
      ))

      return {
        hex: completeIdentityUpdate,
        utxos: verifiedFundingUtxos,
        identity: preparedIdentityUpdate.identityOnOutput,
        deltas
      };
    } else {
      return {
        hex: fundedTxHex,
        utxos: [],
        identity: preparedIdentityUpdate.identityOnOutput,
        deltas
      };
    }
  }

  async createUpdateIdentityWithCurrencySweepTransaction(
    identity: Identity | IdentityUpdateRequestDetails,
    changeAddress: string,
    rawIdentityTransaction: string,
    identityTransactionHeight: number,
    sweepOutputs: CurrencyTransferOutput[],
    utxoList: GetAddressUtxosResponse["result"],
    options: IdentityUpdateCurrencySweepOptions = {}
  ): Promise<IdentityUpdateTransactionResult> {
    if (!sweepOutputs.length) throw new Error("Must provide at least one explicit sweep output.");

    const preparedIdentityUpdate = await this.prepareIdentityUpdateTransaction(
      identity,
      rawIdentityTransaction,
      options.currentHeight,
      options.updateIdentityTransactionHex,
      options.parseVdxfObjects == null ? true : options.parseVdxfObjects,
      options.isTestnet == null ? false : options.isTestnet
    );

    VerusIdInterface.validateIdentityPrimaryAddress(
      preparedIdentityUpdate.identityOnOutput,
      options.expectedIdentityPrimaryAddress == null ? changeAddress : options.expectedIdentityPrimaryAddress
    );

    const chainId = options.chainIAddr != null ? options.chainIAddr : await this.getChainId();
    const sweepTxHex = createUnfundedCurrencyTransfer(
      chainId,
      sweepOutputs,
      networks.verus,
      preparedIdentityUpdate.height + 20
    );
    const combinedUnfundedTxHex = VerusIdInterface.combineUnfundedTransactions(
      preparedIdentityUpdate.unfundedTxHex,
      sweepTxHex
    );

    let fundedTxHex;

    if (options.fundRawTransactionResult == null) {
      const _fundRawTxRes = await this.interface.fundRawTransaction(
        combinedUnfundedTxHex,
        utxoList.map(utxo => {
          return {
            voutnum: utxo.outputIndex,
            txid: utxo.txid,
          };
        }),
        changeAddress
      );

      if (_fundRawTxRes.error) throw new Error("Couldn't fund raw transaction")
      else fundedTxHex = _fundRawTxRes.result.hex;
    } else fundedTxHex = options.fundRawTransactionResult.hex;

    const verifiedFundingUtxos = await this.getVerifiedFundingUtxosFromTransaction(
      fundedTxHex,
      utxoList,
      options.allowUnverifiedPrevouts == null ? false : options.allowUnverifiedPrevouts
    );
    const validation: FundedCurrencyValidation = validateFundedCurrencyTransfer(
      chainId,
      fundedTxHex,
      combinedUnfundedTxHex,
      changeAddress,
      networks.verus,
      verifiedFundingUtxos
    );

    if (!validation.valid) throw new Error(validation.message);

    const expectedSent = VerusIdInterface.getExpectedSentFromSweepOutputs(sweepOutputs);
    const expectedExplicitFees = VerusIdInterface.getExpectedFeesFromSweepOutputs(sweepOutputs, chainId);
    const deltas: Map<string, BigNumber> = new Map();

    VerusIdInterface.validateSweepSent(validation, expectedSent);
    VerusIdInterface.validateFees(validation, expectedExplicitFees, chainId, options.maxFee == null ? 5 : options.maxFee);
    VerusIdInterface.addValidationFeesToDeltas(validation, deltas);
    VerusIdInterface.addValidationSentToDeltas(validation, deltas);

    const completeIdentityUpdate = VerusIdInterface.completeIdentityUpdateTransaction(
      fundedTxHex,
      verifiedFundingUtxos,
      preparedIdentityUpdate.identityTransaction,
      preparedIdentityUpdate.vout
    );

    verifiedFundingUtxos.push(VerusIdInterface.getIdentityDefinitionUtxo(
      preparedIdentityUpdate.identityAddress,
      preparedIdentityUpdate.identityTransaction,
      preparedIdentityUpdate.vout,
      identityTransactionHeight
    ))

    return {
      hex: completeIdentityUpdate,
      utxos: verifiedFundingUtxos,
      identity: preparedIdentityUpdate.identityOnOutput,
      deltas
    };
  }

  async createRevokeIdentityTransaction(
    _identity: Identity,
    changeAddress: string,
    rawIdentityTransaction: string,
    identityTransactionHeight: number,
    utxoList?: GetAddressUtxosResponse["result"],
    chainIAddr?: string,
    fee: number = 0.0001,
    fundRawTransactionResult?: FundRawTransactionResponse["result"],
    currentHeight?: number,
    allowUnverifiedPrevouts: boolean = false
  ): Promise<{ hex: string;  utxos: GetAddressUtxosResponse["result"]; identity: Identity; deltas: Map<string, BigNumber>; }> {
    const identity = new Identity();
    identity.fromBuffer(_identity.toBuffer());

    identity.clearContentMultiMap();
    identity.revoke();

    return this.createUpdateIdentityTransaction(
      identity,
      changeAddress,
      rawIdentityTransaction,
      identityTransactionHeight,
      utxoList,
      chainIAddr,
      fee,
      fundRawTransactionResult,
      currentHeight,
      undefined,
      true,
      false,
      allowUnverifiedPrevouts
    );
  }

  async createRecoverIdentityTransaction(
    _identity: Identity,
    changeAddress: string,
    rawIdentityTransaction: string,
    identityTransactionHeight: number,
    utxoList?: GetAddressUtxosResponse["result"],
    chainIAddr?: string,
    fee: number = 0.0001,
    fundRawTransactionResult?: FundRawTransactionResponse["result"],
    currentHeight?: number,
    allowUnverifiedPrevouts: boolean = false
  ): Promise<{ hex: string; utxos: GetAddressUtxosResponse["result"]; identity: Identity; deltas: Map<string, BigNumber>; }> {
    const identity = new Identity();
    identity.fromBuffer(_identity.toBuffer());

    identity.clearContentMultiMap();
    identity.unrevoke();

    return this.createUpdateIdentityTransaction(
      identity,
      changeAddress,
      rawIdentityTransaction,
      identityTransactionHeight,
      utxoList,
      chainIAddr,
      fee,
      fundRawTransactionResult,
      currentHeight,
      undefined,
      true,
      false,
      allowUnverifiedPrevouts
    );
  }

  /**
   * 
   * @param unsignedTxHex The unsigned transaction hex
   * @param inputs A list of UTXOs that are being used as inputs for the transaction, in the order they appear in the unsigned tx
   * @param keys A list of WIF keys that correspond to the UTXOs in the inputs list, each utxo will be signed with each key in the list at the position of the utxo in the inputs list
   */
  signUpdateIdentityTransaction(
    unsignedTxHex: string,
    inputs: GetAddressUtxosResponse["result"],
    keys: string[][]
  ): string {    
    const txb = smarttxs.getFundedTxBuilder(unsignedTxHex, networks.verus, inputs.map(x => Buffer.from(x.script, 'hex')));

    for (let i = 0; i < keys.length; i++) {
      if (inputs[i] && keys[i] && Array.isArray(keys[i]) && keys[i].length > 0) {
        const keysForInput = keys[i];

        for (let j = 0; j < keysForInput.length; j++) {
          if (keysForInput[j]) {
            const keyPair = ECPair.fromWIF(keysForInput[j], networks.verus);

            txb.sign(i, keyPair, null, Transaction.SIGHASH_ALL, inputs[i].satoshis);
          }
        }
      }
    }

    return txb.build().toHex();
  }

  private async createGenericEnvelope<T extends GenericEnvelope, I>(
    EnvelopeClass: new (params: (I)) => T,
    params: I,
    primaryAddrWif?: string,
    getIdentityResult?: GetIdentityResponse["result"],
    currentHeight?: number,
    chainIAddr?: string
  ): Promise<T> {
    let chainId: string;

    if (chainIAddr != null) chainId = chainIAddr;
    else chainId = await this.getChainId();

    const req = new EnvelopeClass(params)

    if (primaryAddrWif) {
      return this.signGenericEnvelope<T>(
        req,
        primaryAddrWif,
        getIdentityResult,
        currentHeight
      );
    } else return req;
  }

  private async signGenericEnvelope<T extends GenericEnvelope>(
    request: T,
    primaryAddrWif: string,
    getIdentityResult?: GetIdentityResponse["result"],
    currentHeight?: number
  ): Promise<T> {
    request.setSigned();

    let height = currentHeight;

    if (height == null) {
      height = await this.getCurrentHeight();
    }

    if (request.signature == null) {
      throw new Error("Require VerifiableSignatureData to be filled in, without signatureAsVch to sign.");
    }

    if (request.signature?.hasBoundHashes() || request.signature?.hasStatements() || request.signature?.hasVdxfKeys() || request.signature?.hasVdxfKeyNames()) {
      throw new Error("Bound hashes, statements, and vdxfkeys in signature not yet supported.");
    }

    const sig = await this.signHash(
      request.signature?.identityID.toIAddress()!,
      request.getDetailsIdentitySignatureHash(height),
      primaryAddrWif,
      getIdentityResult,
      height,
      request.signature?.systemID.toIAddress()!,
    );

    request.signature.signatureAsVch = Buffer.from(sig, 'base64')

    return request;
  }

  private async verifyGenericEnvelope<T extends GenericEnvelope>(
    envelope: T,
    getIdentityResult?: GetIdentityResponse["result"],
    chainIAddr?: string,
    sigBlockTime?: number
  ): Promise<boolean> {
    if (!envelope.isSigned()) return false;

    const verifiableSig = envelope.signature!;

    const sigInfo = await this.getSignatureInfo(
      verifiableSig.identityID.toIAddress()!,
      verifiableSig.signatureAsVch!.toString('base64'),
      chainIAddr
    );

    if (envelope.hasCreatedAt()) {
      let blocktime;

      if (sigBlockTime) blocktime = sigBlockTime;
      else {
        const _blockres = await this.interface.getBlock(sigInfo.height.toString());
        if (_blockres.error) throw new Error(_blockres.error.message);

        blocktime = (_blockres.result as BlockInfo).time;
      }

      if (
        BigNumber(blocktime)
          .minus(envelope.createdAt?.toString()!)
          .abs()
          .isGreaterThan(LOGIN_CONSENT_SIG_TIME_DIFF_THRESHOLD)
      ) {
        return false
      }
    } else {
      return false
    }
    
    return this.verifyHash(
      verifiableSig.identityID.toIAddress(),
      verifiableSig.signatureAsVch.toString('base64'),
      envelope.getDetailsIdentitySignatureHash(sigInfo.height),
      getIdentityResult,
      chainIAddr
    );
  }

  createGenericRequest = (
    params: GenericRequestInterface,
    primaryAddrWif?: string,
    getIdentityResult?: GetIdentityResponse["result"],
    currentHeight?: number,
    chainIAddr?: string
  ) => this.createGenericEnvelope<GenericRequest, GenericRequestInterface>(GenericRequest, params, primaryAddrWif, getIdentityResult, currentHeight, chainIAddr);

  createGenericResponse = (
    params: GenericResponseInterface,
    primaryAddrWif?: string,
    getIdentityResult?: GetIdentityResponse["result"],
    currentHeight?: number,
    chainIAddr?: string
  ) => this.createGenericEnvelope<GenericResponse, GenericResponseInterface>(GenericResponse, params, primaryAddrWif, getIdentityResult, currentHeight, chainIAddr);

  signGenericRequest = this.signGenericEnvelope<GenericRequest>;
  signGenericResponse = this.signGenericEnvelope<GenericResponse>;

  static validateUnsignedGenericRequest(request: GenericRequest) {
    const details = request.details;

    if (!Array.isArray(details)) return false;

    let authIndex = -1;
    let specialIndex = -1;
    let provisioningIndex = -1;
    let appEncryptIndex = -1;
    let walletBackupIndex = -1;

    for (let i = 0; i < details.length; i++) {
      const detail = details[i];

      if (detail instanceof AuthenticationRequestOrdinalVDXFObject) {
        if (authIndex !== -1) return false;
        authIndex = i;
      }

      if (detail instanceof ProvisionIdentityDetailsOrdinalVDXFObject) {
        if (provisioningIndex !== -1) return false;
        provisioningIndex = i;
      }

      if (detail instanceof AppEncryptionRequestOrdinalVDXFObject) {
        if (appEncryptIndex !== -1) return false;
        appEncryptIndex = i;
      }

      if (detail instanceof CreateWalletBackupDetailsOrdinalVDXFObject) {
        if (walletBackupIndex !== -1) return false;
        walletBackupIndex = i;
      }

      if (detail instanceof VerusPayInvoiceDetailsOrdinalVDXFObject || detail instanceof IdentityUpdateRequestOrdinalVDXFObject) {
        if (specialIndex !== -1) return false;
        specialIndex = i;
      }
    }

    if (walletBackupIndex !== -1 && walletBackupIndex !== 0) return false;
    if (authIndex !== -1 && authIndex !== (walletBackupIndex === 0 ? 1 : 0)) return false;
    if (specialIndex !== -1 && specialIndex !== details.length - 1) return false;
    if (provisioningIndex !== -1 && (authIndex === -1 || provisioningIndex < authIndex)) return false;
    if (appEncryptIndex !== -1 && (authIndex === -1 || appEncryptIndex < authIndex)) return false;

    return true;
  }

  verifyGenericRequest = async (
    envelope: GenericRequest,
    getIdentityResult?: GetIdentityResponse["result"],
    chainIAddr?: string,
    sigBlockTime?: number,
    acceptUnsigned = false
  ): Promise<boolean> => {
    if (!VerusIdInterface.validateUnsignedGenericRequest(envelope)) return false;

    if (acceptUnsigned && !envelope.isSigned()) {
      return true;
    }

    return this.verifyGenericEnvelope<GenericRequest>(
      envelope,
      getIdentityResult,
      chainIAddr,
      sigBlockTime
    );
  };
  verifyGenericResponse = this.verifyGenericEnvelope<GenericResponse>;
}

export default VerusIdInterface
