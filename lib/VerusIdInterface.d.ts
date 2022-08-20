import { AxiosRequestConfig } from "axios";
import { GetIdentityResponse } from "verus-typescript-primitives";
import { VerusdRpcInterface } from "verusd-rpc-ts-client";
declare class VerusIdInterface {
    interface: VerusdRpcInterface;
    constructor(chain: string, baseURL: string, config?: AxiosRequestConfig);
    getChainId(): Promise<string>;
    signMessage(iAddrOrIdentity: string, message: string, primaryAddrWif: string, getIdentityResult?: GetIdentityResponse["result"], currentHeight?: number, chainIAddr?: string): Promise<any>;
    verifyMessage(iAddrOrIdentity: string, base64Sig: string, message: string, getIdentityResult?: GetIdentityResponse["result"], chainIAddr?: string): Promise<boolean>;
    getSignatureInfo(iAddrOrIdentity: string, base64Sig: string, chainIAddr?: string): Promise<{
        version: number;
        hashtype: number;
        height: number;
    }>;
}
export default VerusIdInterface;
