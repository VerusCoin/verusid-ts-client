import { AxiosRequestConfig } from "axios";
import { VerusdRpcInterface } from "verusd-rpc-ts-client";
declare class VerusIdInterface {
    interface: VerusdRpcInterface;
    constructor(chain: string, baseURL: string, config?: AxiosRequestConfig);
    signMessage(iAddrOrIdentity: string, message: string, primaryAddrWif: string): Promise<void>;
}
export default VerusIdInterface;
