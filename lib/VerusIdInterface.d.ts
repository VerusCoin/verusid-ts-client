import { AxiosRequestConfig } from "axios";
import { GetIdentityResponse, LoginConsentRequest, LoginConsentChallenge, LoginConsentProvisioningRequest, LoginConsentProvisioningChallenge, LoginConsentResponse, LoginConsentDecision, LoginConsentProvisioningDecision, LoginConsentProvisioningResponse, SignedSessionObject, SignedSessionObjectData, VerusPayInvoice, VerusPayInvoiceDetails, Identity, GetAddressUtxosResponse, FundRawTransactionResponse, IdentityUpdateRequestDetails, GenericRequest, GenericRequestInterface, GenericResponse, GenericResponseInterface, TransferDestination } from "verus-typescript-primitives";
import { VerusdRpcInterface } from "verusd-rpc-ts-client";
import BigNumber from "bignumber.js";
import { APIAuthData, RPCRequestOverride } from "verusd-rpc-ts-client/lib/VerusdRpcInterface";
export type CurrencyTransferOutput = {
    currencies: {
        [currency: string]: string | number;
    };
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
    destsystem?: string;
    vdxftag?: string;
};
export type IdentityUpdateCurrencyTransferOptions = {
    chainIAddr?: string;
    maxFee?: number;
    fundRawTransactionResult?: FundRawTransactionResponse["result"];
    currentHeight?: number;
    updateIdentityTransactionHex?: string;
    parseVdxfObjects?: boolean;
    isTestnet?: boolean;
    expectedIdentityPrimaryAddress?: string;
    allowUnverifiedPrevouts?: boolean;
};
export type AddressUtxos = Extract<GetAddressUtxosResponse["result"], unknown[]>;
export type AddressUtxo = AddressUtxos[number];
export type IdentityUpdateTransactionResult = {
    hex: string;
    utxos: AddressUtxos;
    identity: Identity;
    deltas: Map<string, BigNumber>;
};
declare class VerusIdInterface {
    interface: VerusdRpcInterface;
    constructor(chain: string, baseURL: string, config?: AxiosRequestConfig, rpcRequestOverride?: RPCRequestOverride, APIAuth?: APIAuthData);
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
    /**
     * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
     */
    signLoginConsentRequest(request: LoginConsentRequest, primaryAddrWif: string, getIdentityResult?: GetIdentityResponse["result"], currentHeight?: number): Promise<LoginConsentRequest>;
    /**
     * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
     */
    createLoginConsentRequest(signingId: string, challenge: LoginConsentChallenge, primaryAddrWif?: string, getIdentityResult?: GetIdentityResponse["result"], currentHeight?: number, chainIAddr?: string): Promise<LoginConsentRequest>;
    /**
     * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
     */
    verifyLoginConsentRequest(request: LoginConsentRequest, getIdentityResult?: GetIdentityResponse["result"], chainIAddr?: string, sigBlockTime?: number): Promise<boolean>;
    /**
     * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
     */
    private signLoginResponse;
    /**
     * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
     */
    private createLoginResponse;
    /**
     * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
     */
    private verifyResponse;
    /**
     * @deprecated SignedSessionObject construction is disabled in primitives.
     * No compatible replacement HTTP session API is available.
     */
    verifySignedSessionObject(object: SignedSessionObject, getIdentityResult?: GetIdentityResponse["result"], chainIAddr?: string): Promise<boolean>;
    /**
     * @deprecated SignedSessionObject construction is disabled in primitives.
     * No compatible replacement HTTP session API is available.
     */
    signSessionObject(object: SignedSessionObject, primaryAddrWif: string, getIdentityResult?: GetIdentityResponse["result"], currentHeight?: number): Promise<SignedSessionObject>;
    /**
     * @deprecated Disabled because SignedSessionObject construction is unsupported in primitives.
     * Always rejects; no compatible replacement HTTP session API is available.
     */
    createSignedSessionObject(signingId: string, data: SignedSessionObjectData, primaryAddrWif?: string, getIdentityResult?: GetIdentityResponse["result"], currentHeight?: number, chainIAddr?: string): Promise<SignedSessionObject>;
    /**
     * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
     */
    signLoginConsentResponse(response: LoginConsentResponse, primaryAddrWif: string, getIdentityResult?: GetIdentityResponse["result"], currentHeight?: number): Promise<LoginConsentResponse>;
    /**
     * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
     */
    createLoginConsentResponse(signingId: string, decision: LoginConsentDecision, primaryAddrWif?: string, getIdentityResult?: GetIdentityResponse["result"], currentHeight?: number, chainIAddr?: string): Promise<LoginConsentResponse>;
    /**
     * @deprecated Legacy VerusID login, use GenericRequest class with login objects in details array
     */
    verifyLoginConsentResponse(response: LoginConsentResponse, getIdentityResult?: GetIdentityResponse["result"], chainIAddr?: string): Promise<boolean>;
    /**
     * @deprecated Legacy VerusPay implementation, use GenericRequest class with invoice objects in details array
     */
    createVerusPayInvoice(details: VerusPayInvoiceDetails, signingIdIAddr?: string, primaryAddrWif?: string, getIdentityResult?: GetIdentityResponse["result"], currentHeight?: number, chainIAddr?: string): Promise<VerusPayInvoice>;
    /**
     * @deprecated Legacy VerusPay implementation, use GenericRequest class with invoice objects in details array
     */
    signVerusPayInvoice(invoice: VerusPayInvoice, signingIdIAddr: string, systemIdIAddr: string, primaryAddrWif: string, getIdentityResult?: GetIdentityResponse["result"], currentHeight?: number): Promise<VerusPayInvoice>;
    /**
     * @deprecated Legacy VerusPay implementation, use GenericRequest class with invoice objects in details array
     */
    verifySignedVerusPayInvoice(invoice: VerusPayInvoice, getIdentityResult?: GetIdentityResponse["result"], chainIAddr?: string): Promise<boolean>;
    signVerusIdProvisioningResponse(response: LoginConsentProvisioningResponse, primaryAddrWif: string, getIdentityResult?: GetIdentityResponse["result"], currentHeight?: number): Promise<LoginConsentProvisioningResponse>;
    createVerusIdProvisioningResponse(signingId: string, decision: LoginConsentProvisioningDecision, primaryAddrWif?: string, getIdentityResult?: GetIdentityResponse["result"], currentHeight?: number, chainIAddr?: string): Promise<LoginConsentProvisioningResponse>;
    verifyVerusIdProvisioningResponse(response: LoginConsentProvisioningResponse, getIdentityResult?: GetIdentityResponse["result"], chainIAddr?: string): Promise<boolean>;
    static signHashWithAddress(hash: Buffer, wif: string): string;
    static signVerusIdProvisioningRequest(request: LoginConsentProvisioningRequest, addrWif: string): Promise<LoginConsentProvisioningRequest>;
    static createVerusIdProvisioningRequest(signingAddress: string, challenge: LoginConsentProvisioningChallenge, addrWif?: string): Promise<LoginConsentProvisioningRequest>;
    static verifyVerusIdProvisioningRequest(request: LoginConsentProvisioningRequest, address: string): Promise<LoginConsentProvisioningRequest>;
    private static getIdentityFromIdTx;
    private static addNegativeDelta;
    private static addValidationFeesToDeltas;
    private static addValidationSentToDeltas;
    private static validateNoUnexpectedCurrencySent;
    private static getSatoshis;
    private static getCurrencyValueMap;
    private static isReserveTransferOutput;
    private static getTxDestination;
    private static getTokenOutputVersion;
    private static createSmartTransactionOutputScript;
    private static cloneTransferDestination;
    private static usesRefundDestination;
    private static getReserveTransferDestination;
    private static validateCurrencyTransferOutput;
    private static getReserveTransferDestinationCurrency;
    private static getReserveTransferFlags;
    private static calculateReserveTransferFee;
    private static getReserveTransferFeeSatoshis;
    private static getReserveTransferFeeCurrency;
    private static hasGatewayLeg;
    private static getGatewayLegFees;
    static createUnfundedCurrencyTransferTransaction(chainId: string, currencyTransferOutputs: CurrencyTransferOutput[], expiryHeight: number): string;
    private static getExpectedSentFromCurrencyTransferOutputs;
    private static getDestinationFees;
    private static getExpectedFeesFromCurrencyTransferOutputs;
    private static validateCurrencyTransferSent;
    private static validateFees;
    private static getFundingUtxosFromTransaction;
    private getVerifiedFundingUtxosFromTransaction;
    private static combineUnfundedTransactions;
    private static validateCompletedIdentityUpdateTransaction;
    private static completeIdentityUpdateTransaction;
    private static getIdentityDefinitionUtxo;
    private static validateIdentityPrimaryAddress;
    private prepareIdentityUpdateTransaction;
    createUpdateIdentityTransaction(identity: Identity | IdentityUpdateRequestDetails, changeAddress: string, rawIdentityTransaction: string, identityTransactionHeight: number, utxoList?: GetAddressUtxosResponse["result"], chainIAddr?: string, maxFee?: number, fundRawTransactionResult?: FundRawTransactionResponse["result"], currentHeight?: number, updateIdentityTransactionHex?: string, parseVdxfObjects?: boolean, isTestnet?: boolean, // This parameter is only necessary if you pass in an IdentityUpdateRequestDetails
    allowUnverifiedPrevouts?: boolean): Promise<IdentityUpdateTransactionResult>;
    createUpdateIdentityWithCurrencyTransferTransaction(identity: Identity | IdentityUpdateRequestDetails, changeAddress: string, rawIdentityTransaction: string, identityTransactionHeight: number, currencyTransferOutputs: CurrencyTransferOutput[], utxoList: GetAddressUtxosResponse["result"], options?: IdentityUpdateCurrencyTransferOptions): Promise<IdentityUpdateTransactionResult>;
    createRevokeIdentityTransaction(_identity: Identity, changeAddress: string, rawIdentityTransaction: string, identityTransactionHeight: number, utxoList?: GetAddressUtxosResponse["result"], chainIAddr?: string, fee?: number, fundRawTransactionResult?: FundRawTransactionResponse["result"], currentHeight?: number, allowUnverifiedPrevouts?: boolean): Promise<IdentityUpdateTransactionResult>;
    createRecoverIdentityTransaction(_identity: Identity, changeAddress: string, rawIdentityTransaction: string, identityTransactionHeight: number, utxoList?: GetAddressUtxosResponse["result"], chainIAddr?: string, fee?: number, fundRawTransactionResult?: FundRawTransactionResponse["result"], currentHeight?: number, allowUnverifiedPrevouts?: boolean): Promise<IdentityUpdateTransactionResult>;
    /**
     *
     * @param unsignedTxHex The unsigned transaction hex
     * @param inputs A list of UTXOs that are being used as inputs for the transaction, in the order they appear in the unsigned tx
     * @param keys A list of WIF keys that correspond to the UTXOs in the inputs list, each utxo will be signed with each key in the list at the position of the utxo in the inputs list
     */
    signUpdateIdentityTransaction(unsignedTxHex: string, inputs: GetAddressUtxosResponse["result"], keys: string[][]): string;
    private createGenericEnvelope;
    private signGenericEnvelope;
    private verifyGenericEnvelope;
    createGenericRequest: (params: GenericRequestInterface, primaryAddrWif?: string, getIdentityResult?: GetIdentityResponse["result"], currentHeight?: number, chainIAddr?: string) => Promise<GenericRequest>;
    createGenericResponse: (params: GenericResponseInterface, primaryAddrWif?: string, getIdentityResult?: GetIdentityResponse["result"], currentHeight?: number, chainIAddr?: string) => Promise<GenericResponse>;
    signGenericRequest: (request: GenericRequest, primaryAddrWif: string, getIdentityResult?: GetIdentityResponse["result"], currentHeight?: number) => Promise<GenericRequest>;
    signGenericResponse: (request: GenericResponse, primaryAddrWif: string, getIdentityResult?: GetIdentityResponse["result"], currentHeight?: number) => Promise<GenericResponse>;
    static validateUnsignedGenericRequest(request: GenericRequest): boolean;
    verifyGenericRequest: (envelope: GenericRequest, getIdentityResult?: GetIdentityResponse["result"], chainIAddr?: string, sigBlockTime?: number, acceptUnsigned?: boolean) => Promise<boolean>;
    verifyGenericResponse: (envelope: GenericResponse, getIdentityResult?: GetIdentityResponse["result"], chainIAddr?: string, sigBlockTime?: number) => Promise<boolean>;
}
export default VerusIdInterface;
