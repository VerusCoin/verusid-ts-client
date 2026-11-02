import { VerusdRpcInterface } from "verusd-rpc-ts-client";
import { RpcRequestResult } from "verusd-rpc-ts-client/lib/types/RpcRequest";
import {
  ApiRequest,
  GetBlockRequest,
  GetCurrencyRequest,
  GetIdentityRequest,
  GetInfoRequest,
  GetRawTransactionRequest,
  GetTxOutRequest,
} from "verus-typescript-primitives";
import { RegistrationError } from "./registrationPolicy";

/**
 * Optional batch transport supplied by the caller.
 *
 * Return one RPC envelope per request in request order. The transport must
 * correlate daemon response IDs, detect batch support and handle any fallback.
 * Chain-tip, identity and spendability reads must bypass transport TTL caches.
 */
export type RegistrationRequestMany = (
  requests: ApiRequest[]
) => Promise<RpcRequestResult<any>[]>;

/** Existing RPC client with an optional caller-supplied batch transport. */
export type RegistrationRpc = VerusdRpcInterface & {
  requestMany?: RegistrationRequestMany;
};

const requestTypes = {
  getCurrency: GetCurrencyRequest,
  getInfo: GetInfoRequest,
  getBlock: GetBlockRequest,
  getRawTransaction: GetRawTransactionRequest,
  getTxOut: GetTxOutRequest,
  getIdentity: GetIdentityRequest,
};

type ReadMethod = keyof typeof requestTypes;

/** RPC method and arguments, using the same types as its single-request API. */
export type RegistrationRead = {
  [M in ReadMethod]: readonly [M, ...Parameters<VerusdRpcInterface[M]>];
}[ReadMethod];

type Response = RpcRequestResult<any>;

type ReadScope = {
  source: RegistrationRpc;
  cache: Map<string, Promise<Response>>;
};

// Each proxy owns its preparation's cache without modifying the original client.
const scopes = new WeakMap<RegistrationRpc, ReadScope>();

// Per call, bound batch size and parallel fallback concurrency to one chunk.
const MAX_BATCH_READS = 20;

/** Select reads eligible for reuse within one registration preparation. */
function cacheKey(read: RegistrationRead): string | undefined {
  if (read[0] === "getCurrency") return JSON.stringify(read);

  // Raw bytes are stable. Verbose responses include changing confirmations,
  // so only verbosity zero is reusable; omitted verbosity has the same key.
  if (read[0] === "getRawTransaction" && (read[2] ?? 0) === 0)
    return JSON.stringify([read[0], read[1], 0]);

  // Always refresh chain-tip, block, identity and spendability reads.
  return undefined;
}

/** Check envelope count and shape; response ordering is the transport's duty. */
function validateBatch(responses: unknown, count: number): Response[] {
  if (
    !Array.isArray(responses) ||
    responses.length !== count ||
    responses.some(
      (response) =>
        !response ||
        typeof response !== "object" ||
        Array.isArray(response) ||
        !Object.prototype.hasOwnProperty.call(response, "result") ||
        (response.error != null &&
          (typeof response.error !== "object" ||
            typeof response.error.code !== "number" ||
            typeof response.error.message !== "string"))
    )
  ) {
    throw new RegistrationError(
      "INVALID_RPC_RESPONSE",
      "Registration batch must return one RPC envelope per request in request order."
    );
  }

  return responses;
}

/** Send bounded chunks in sequence, preserving the requested response order. */
async function dispatchReads(
  rpc: RegistrationRpc,
  reads: readonly RegistrationRead[],
  parallelFallback: boolean
): Promise<Response[]> {
  const responses: Response[] = [];

  for (let offset = 0; offset < reads.length; offset += MAX_BATCH_READS) {
    const chunk = reads.slice(offset, offset + MAX_BATCH_READS);

    if (rpc.requestMany) {
      // Build the same request objects used by the client's individual methods.
      const requests = chunk.map(([method, ...args]) => {
        const Request = requestTypes[method] as new (
          chain: string,
          ...parameters: any[]
        ) => ApiRequest;

        return new Request(rpc.chain, ...args);
      });

      responses.push(
        ...validateBatch(await rpc.requestMany(requests), chunk.length)
      );
    } else {
      // Call the original methods so custom single-request transports still run
      // with the original client as `this`.
      const read = ([method, ...args]: RegistrationRead) => {
        const call = rpc[method] as (...parameters: any[]) => Promise<Response>;

        return call.apply(rpc, args);
      };

      if (parallelFallback) {
        responses.push(...(await Promise.all(chunk.map(read))));
      } else {
        for (const item of chunk) responses.push(await read(item));
      }
    }
  }

  return responses;
}

/**
 * Return responses in read order, including repeated or cached reads.
 *
 * A scoped client reuses currency lookups and raw transaction bytes within its
 * preparation. Other reads always reach the transport. Without a batch hook,
 * requests run sequentially unless the call site opts into parallelFallback.
 * Concurrent calls share cached promises but dispatch their own missing reads.
 */
export async function registrationReadMany(
  rpc: RegistrationRpc,
  reads: readonly RegistrationRead[],
  parallelFallback = false
): Promise<Response[]> {
  const scope = scopes.get(rpc);
  if (!scope) return dispatchReads(rpc, reads, parallelFallback);

  const missing: RegistrationRead[] = [];

  // Publish each missing read's promise before dispatching. Eligible duplicates
  // in this group or another simultaneous call can share the pending result.
  let resolve!: (responses: Response[]) => void;
  let reject!: (error: unknown) => void;
  const batch = new Promise<Response[]>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });

  const pending = reads.map((read) => {
    const key = cacheKey(read);
    const cached = key == null ? undefined : scope.cache.get(key);
    if (cached) return cached;

    // Dispatch only misses. This index maps each pending result back to its
    // position in the compact list of requests sent to the transport.
    const index = missing.push(read) - 1;
    const response = batch.then((responses) => responses[index]);
    if (key == null) return response;

    // Evict RPC errors, null results and rejected requests so later reads retry.
    const reusable = response.then(
      (value) => {
        if (value.error != null || value.result == null)
          scope.cache.delete(key);

        return value;
      },
      (error) => {
        scope.cache.delete(key);
        throw error;
      }
    );

    scope.cache.set(key, reusable);

    return reusable;
  });

  // Combine cached and new results in the caller's order. Attach their handlers
  // before dispatching so a transport rejection propagates to the returned promise.
  const results = Promise.all(pending);

  // Use the original client so dispatch does not re-enter the proxy.
  dispatchReads(scope.source, missing, parallelFallback).then(resolve, reject);

  return results;
}

/**
 * Create a proxy with a fresh read cache for one registration preparation.
 *
 * Pass the proxy to nested helpers to share its cache. Calling this again with
 * that proxy returns it unchanged; calling with the original client starts a
 * separate scope. Other methods stay bound to the original client so transport
 * overrides and request ID counters retain their existing behavior.
 */
export function createRegistrationRpc<T extends RegistrationRpc>(rpc: T): T {
  if (scopes.has(rpc)) return rpc;

  const scoped = new Proxy(rpc, {
    get(target, property) {
      // Route reusable methods through the scope. cacheKey still excludes
      // verbose raw-transaction reads from reuse.
      if (property === "getCurrency")
        return (...args: Parameters<RegistrationRpc["getCurrency"]>) =>
          registrationReadMany(scoped, [["getCurrency", ...args]]).then(
            ([response]) => response
          );

      if (property === "getRawTransaction")
        return (...args: Parameters<RegistrationRpc["getRawTransaction"]>) =>
          registrationReadMany(scoped, [["getRawTransaction", ...args]]).then(
            ([response]) => response
          );

      // Forward everything else without moving client state onto the proxy.
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  scopes.set(scoped, { source: rpc, cache: new Map() });

  return scoped;
}
