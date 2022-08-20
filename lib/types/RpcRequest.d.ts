import { ApiPrimitive, RequestParams } from "verus-typescript-primitives";
export interface RpcRequestBody<T = any> {
    jsonrpc: string;
    id: T;
    method: string;
    params?: RequestParams;
}
export interface RpcError<D = any> {
    code: number;
    message: string;
    data?: D;
}
export interface RpcRequestResultSuccess<T = any> {
    id: T;
    result: ApiPrimitive;
    error: null;
}
export interface RpcRequestResultError<T = any> {
    id: T;
    result: null;
    error: RpcError;
}
export declare type RpcRequestResult = RpcRequestResultSuccess | RpcRequestResultError;
