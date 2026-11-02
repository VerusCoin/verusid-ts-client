import { VerusdRpcInterface } from "verusd-rpc-ts-client";
import { RpcRequestResult } from "verusd-rpc-ts-client/lib/types/RpcRequest";
import { ApiRequest, GetBlockRequest, GetCurrencyRequest, GetIdentityRequest, GetInfoRequest, GetRawTransactionRequest, GetTxOutRequest } from "verus-typescript-primitives";
/**
 * Optional batch transport supplied by the caller.
 *
 * Return one RPC envelope per request in request order. The transport must
 * correlate daemon response IDs, detect batch support and handle any fallback.
 * Chain-tip, identity and spendability reads must bypass transport TTL caches.
 */
export type RegistrationRequestMany = (requests: ApiRequest[]) => Promise<RpcRequestResult<any>[]>;
/** Existing RPC client with an optional caller-supplied batch transport. */
export type RegistrationRpc = VerusdRpcInterface & {
    requestMany?: RegistrationRequestMany;
};
declare const requestTypes: {
    getCurrency: typeof GetCurrencyRequest;
    getInfo: typeof GetInfoRequest;
    getBlock: typeof GetBlockRequest;
    getRawTransaction: typeof GetRawTransactionRequest;
    getTxOut: typeof GetTxOutRequest;
    getIdentity: typeof GetIdentityRequest;
};
type ReadMethod = keyof typeof requestTypes;
/** RPC method and arguments, using the same types as its single-request API. */
export type RegistrationRead = {
    [M in ReadMethod]: readonly [M, ...Parameters<VerusdRpcInterface[M]>];
}[ReadMethod];
type Response = RpcRequestResult<any>;
/**
 * Return responses in read order, including repeated or cached reads.
 *
 * A scoped client reuses currency lookups and raw transaction bytes within its
 * preparation. Other reads always reach the transport. Without a batch hook,
 * requests run sequentially unless the call site opts into parallelFallback.
 * Concurrent calls share cached promises but dispatch their own missing reads.
 */
export declare function registrationReadMany(rpc: RegistrationRpc, reads: readonly RegistrationRead[], parallelFallback?: boolean): Promise<Response[]>;
/**
 * Create a proxy with a fresh read cache for one registration preparation.
 *
 * Pass the proxy to nested helpers to share its cache. Calling this again with
 * that proxy returns it unchanged; calling with the original client starts a
 * separate scope. Other methods stay bound to the original client so transport
 * overrides and request ID counters retain their existing behavior.
 */
export declare function createRegistrationRpc<T extends RegistrationRpc>(rpc: T): T;
export {};
