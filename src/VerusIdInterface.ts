import { AxiosRequestConfig } from "axios";
import {
  GetIdentityResponse
} from "verus-typescript-primitives";
import { VerusdRpcInterface } from "verusd-rpc-ts-client";
import { IdentitySignature, ECPair, networks, address } from "@bitgo/utxo-lib";

const VRSC_I_ADDRESS = "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV"
const ID_SIG_VERSION = 1
const ID_SIG_TYPE = 1

class VerusIdInterface {
  interface: VerusdRpcInterface;

  constructor(chain: string, baseURL: string, config?: AxiosRequestConfig) {
    this.interface = new VerusdRpcInterface(chain, baseURL, config);
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
  ) {
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
      const _infores = await this.interface.getInfo();
      if (_infores.error) throw new Error(_infores.error.message);
      const info = _infores.result!;
      height = info.longestchain;
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

    sig.signMessageOffline(message, keyPair);

    return sig.toBuffer().toString("base64");
  }

  async verifyMessage(
    iAddrOrIdentity: string,
    base64Sig: string,
    message: string,
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

    const sig = new IdentitySignature(networks[this.interface.chain]);

    if (chainIAddr != null) chainId = chainIAddr
    else chainId = await this.getChainId()

    sig.fromBuffer(Buffer.from(base64Sig, "base64"), 0, chainId, iAddress);

    if (getIdentityResult != null) {
      identityAtHeight = getIdentityResult;
    } else {
      const _idresatheight = await this.interface.getIdentity(iAddrOrIdentity, sig.blockHeight);
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

      if (sig.verifyMessageOffline(message, signingAddress)) {
        signedBy[signingAddress] = true;
        sigs += 1;

        if (sigs == minsigs) return true;
      }
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

    if (chainIAddr != null) chainId = chainIAddr
    else chainId = await this.getChainId()

    const sig = new IdentitySignature(networks[this.interface.chain]);

    sig.fromBuffer(
      Buffer.from(base64Sig, "base64"),
      0,
      chainId,
      iAddress
    );

    return {
      version: sig.version,
      hashtype: sig.hashType,
      height: sig.blockHeight,
    };
  }
}

export default VerusIdInterface