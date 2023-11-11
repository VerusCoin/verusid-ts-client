/// <reference types="node" />
import { AxiosRequestConfig } from "axios";
import { GetIdentityResponse, LoginConsentRequest, LoginConsentChallenge, LoginConsentProvisioningRequest, LoginConsentProvisioningChallenge, LoginConsentResponse, LoginConsentDecision, LoginConsentProvisioningDecision, LoginConsentProvisioningResponse, SignedSessionObject, SignedSessionObjectData, VerusPayInvoice, VerusPayInvoiceDetails } from "verus-typescript-primitives";
import { VerusdRpcInterface } from "verusd-rpc-ts-client";
declare class VerusIdInterface {
    interface: VerusdRpcInterface;
    constructor(chain: string, baseURL: string, config?: AxiosRequestConfig);
    getCurrentHeight(): Promise<number>;
    getChainId(): Promise<string>;
    signMessage(iAddrOrIdentity: string, message: string, primaryAddrWif: string, getIdentityResult?: GetIdentityResponse["result"], currentHeight?: number, chainIAddr?: string): Promise<string>;
    signHash(iAddrOrIdentity: string, hash: Buffer, primaryAddrWif: string, getIdentityResult?: GetIdentityResponse["result"], currentHeight?: number, chainIAddr?: string): Promise<string>;
    private signHashOrMessage;
    verifyMessage(iAddrOrIdentity: string, base64Sig: string, message: string, getIdentityResult?: GetIdentityResponse["result"], chainIAddr?: string): Promise<boolean>;
    verifyHash(iAddrOrIdentity: string, base64Sig: string, hash: Buffer, getIdentityResult?: GetIdentityResponse["result"], chainIAddr?: string): Promise<boolean>;
    private verifyHashOrMessage;
    getSignatureInfo(iAddrOrIdentity: string, base64Sig: string, chainIAddr?: string): Promise<{
        version: number;
        hashtype: number;
        height: number;
    }>;
    signLoginConsentRequest(request: LoginConsentRequest, primaryAddrWif: string, getIdentityResult?: GetIdentityResponse["result"], currentHeight?: number): Promise<LoginConsentRequest>;
    createLoginConsentRequest(signingId: string, challenge: LoginConsentChallenge, primaryAddrWif?: string, getIdentityResult?: GetIdentityResponse["result"], currentHeight?: number, chainIAddr?: string): Promise<LoginConsentRequest>;
    verifyLoginConsentRequest(request: LoginConsentRequest, getIdentityResult?: GetIdentityResponse["result"], chainIAddr?: string, sigBlockTime?: number): Promise<boolean>;
    private signResponse;
    private createResponse;
    private verifyResponse;
    verifySignedSessionObject(object: SignedSessionObject, getIdentityResult?: GetIdentityResponse["result"], chainIAddr?: string): Promise<boolean>;
    signSessionObject(object: SignedSessionObject, primaryAddrWif: string, getIdentityResult?: GetIdentityResponse["result"], currentHeight?: number): Promise<SignedSessionObject>;
    createSignedSessionObject(signingId: string, data: SignedSessionObjectData, primaryAddrWif?: string, getIdentityResult?: GetIdentityResponse["result"], currentHeight?: number, chainIAddr?: string): Promise<SignedSessionObject>;
    signLoginConsentResponse(response: LoginConsentResponse, primaryAddrWif: string, getIdentityResult?: GetIdentityResponse["result"], currentHeight?: number): Promise<LoginConsentResponse>;
    createLoginConsentResponse(signingId: string, decision: LoginConsentDecision, primaryAddrWif?: string, getIdentityResult?: GetIdentityResponse["result"], currentHeight?: number, chainIAddr?: string): Promise<LoginConsentResponse>;
    verifyLoginConsentResponse(response: LoginConsentResponse, getIdentityResult?: GetIdentityResponse["result"], chainIAddr?: string): Promise<boolean>;
    createVerusPayInvoice(details: VerusPayInvoiceDetails, signingIdIAddr?: string, primaryAddrWif?: string, getIdentityResult?: GetIdentityResponse["result"], currentHeight?: number, chainIAddr?: string): Promise<VerusPayInvoice>;
    signVerusPayInvoice(invoice: VerusPayInvoice, signingIdIAddr: string, systemIdIAddr: string, primaryAddrWif: string, getIdentityResult?: GetIdentityResponse["result"], currentHeight?: number): Promise<VerusPayInvoice>;
    verifySignedVerusPayInvoice(invoice: VerusPayInvoice, getIdentityResult?: GetIdentityResponse["result"], chainIAddr?: string): Promise<boolean>;
    signVerusIdProvisioningResponse(response: LoginConsentProvisioningResponse, primaryAddrWif: string, getIdentityResult?: GetIdentityResponse["result"], currentHeight?: number): Promise<LoginConsentProvisioningResponse>;
    createVerusIdProvisioningResponse(signingId: string, decision: LoginConsentProvisioningDecision, primaryAddrWif?: string, getIdentityResult?: GetIdentityResponse["result"], currentHeight?: number, chainIAddr?: string): Promise<LoginConsentProvisioningResponse>;
    verifyVerusIdProvisioningResponse(response: LoginConsentProvisioningResponse, getIdentityResult?: GetIdentityResponse["result"], chainIAddr?: string): Promise<boolean>;
    static signHashWithAddress(hash: Buffer, wif: string): string;
    static signVerusIdProvisioningRequest(request: LoginConsentProvisioningRequest, addrWif: string): Promise<LoginConsentProvisioningRequest>;
    static createVerusIdProvisioningRequest(signingAddress: string, challenge: LoginConsentProvisioningChallenge, addrWif?: string): Promise<LoginConsentProvisioningRequest>;
    static verifyVerusIdProvisioningRequest(request: LoginConsentProvisioningRequest, address: string): Promise<LoginConsentProvisioningRequest>;
}
export default VerusIdInterface;
