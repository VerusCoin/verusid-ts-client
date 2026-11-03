import BN from "bn.js";
import {
  address,
  networks,
  Transaction,
  TransactionBuilder,
} from "@bitgo/utxo-lib";
import {
  CurrencyValueMap,
  EVALS,
  fromBase58Check,
  IdentityCommitmentScript,
  IdentityID,
  KeyID,
  OptCCParams,
  SmartTransactionScript,
  TokenOutput,
  TxDestination,
  currencyAmountToAtomic,
  I_ADDR_VERSION,
  R_ADDR_VERSION,
} from "verus-typescript-primitives";
import { RpcRequestResult } from "verusd-rpc-ts-client";
import {
  RegistrationRpc,
  RegistrationRead,
  registrationReadMany,
} from "./registrationRpc";
import { RegistrationError, registrationRpcResult } from "./registrationPolicy";
import { verifyRegistrationFunding } from "./registrationFundingVerification";
import {
  IdentityReservationScript,
  IdentityScript,
  ReserveTransfer,
  DEST_ID,
  RESERVE_TRANSFER_VALID,
  RESERVE_TRANSFER_BURN_CHANGE_PRICE,
  RESERVE_TRANSFER_DESTINATION,
} from "verus-typescript-primitives";

export type RegistrationAmounts = { [currencyID: string]: string };
export type RegistrationFundingInput = {
  txid: string;
  vout: number;
  rawTransaction?: string;
};
export type RegistrationPrevout = RegistrationFundingInput & {
  rawTransaction: string;
  scriptHex: string;
  value: string;
  values: RegistrationAmounts;
  confirmations: number;
  height: number;
};
/** Canonical authority evidence retained only while preparing a transaction. */
export type RegistrationAuthorityOutpoint = Pick<
  RegistrationPrevout,
  "txid" | "vout" | "height" | "scriptHex" | "value"
>;
export type RegistrationChainSnapshot = {
  systemID: string;
  rootSystemName: string;
  tipHeight: number;
  tipHash: string;
  candidateHeight: number;
  expiryDelta: number;
  expiryHeight: number;
};
export type RegistrationPlannedOutput = {
  role:
    | "commitment"
    | "identity"
    | "issuer-payment"
    | "burn"
    | "referral"
    | "reservation"
    | "change";
  scriptHex: string;
  value: string;
  values: RegistrationAmounts;
};

// VerusCoin MoneyRange (amount.h / komodo_globals.h) is narrower than int64.
const MAX_MONEY_RANGE = new BN("5000000000000000000");
const MAX_SAFE = new BN(Number.MAX_SAFE_INTEGER);
// BitGo's output and signature-digest type guards impose this narrower bound.
const MAX_NATIVE = new BN("2100000000000000");

export function atomic(value: string, label = "Amount"): BN {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new RegistrationError(
      "INVALID_AMOUNT",
      label + " must be a nonnegative atomic integer string."
    );
  }
  const result = new BN(value, 10);
  if (result.gt(MAX_MONEY_RANGE))
    throw new RegistrationError(
      "INVALID_AMOUNT",
      label + " exceeds the daemon monetary range."
    );
  return result;
}

export function safeNative(value: string): number {
  const amount = atomic(value);
  if (amount.gt(MAX_SAFE))
    throw new RegistrationError(
      "UNSUPPORTED_AMOUNT",
      "Native values exceed the transaction library safe integer range."
    );
  if (amount.gt(MAX_NATIVE))
    throw new RegistrationError(
      "UNSUPPORTED_AMOUNT",
      "Native values exceed the transaction library monetary limit."
    );
  return amount.toNumber();
}

export function destination(addressString: string): TxDestination {
  const decoded = fromBase58Check(addressString);
  if (decoded.hash.length !== 20 || decoded.hash.equals(Buffer.alloc(20))) {
    throw new RegistrationError(
      "INVALID_DESTINATION",
      "A nonzero key-hash or identity address is required."
    );
  }
  if (decoded.version === I_ADDR_VERSION)
    return new TxDestination(new IdentityID(decoded.hash));
  if (decoded.version === R_ADDR_VERSION)
    return new TxDestination(new KeyID(decoded.hash));
  throw new RegistrationError(
    "UNSUPPORTED_DESTINATION",
    "Only key-hash and identity destinations are supported."
  );
}

export function addAmounts(
  target: RegistrationAmounts,
  source: RegistrationAmounts
): void {
  Object.keys(source).forEach((id) => {
    target[id] = atomic(
      atomic(target[id] || "0")
        .add(atomic(source[id]))
        .toString(10)
    ).toString(10);
  });
}

export function requireAmounts(
  actual: RegistrationAmounts,
  limits: RegistrationAmounts
): void {
  Object.keys(actual).forEach((id) => {
    if (atomic(actual[id]).gt(atomic(limits[id] || "0"))) {
      throw new RegistrationError(
        "COST_LIMIT_EXCEEDED",
        "Registration exceeds the approved atomic cost for " + id + "."
      );
    }
  });
}

export function parseTransaction(hex: string): any {
  if (typeof hex !== "string" || !/^(?:[0-9a-fA-F]{2})+$/.test(hex)) {
    throw new RegistrationError(
      "INVALID_TRANSACTION",
      "Expected complete transaction hex."
    );
  }
  const tx = Transaction.fromHex(hex, networks.verus);
  if (tx.toHex() !== hex.toLowerCase())
    throw new RegistrationError(
      "INVALID_TRANSACTION",
      "Noncanonical transaction encoding."
    );
  return tx;
}

function params(
  evalCode: number,
  destinations: TxDestination[],
  data: Buffer[] = []
): OptCCParams {
  return new OptCCParams({
    version: new BN(3),
    evalCode: new BN(evalCode),
    m: new BN(destinations.length ? 1 : 0),
    n: new BN(destinations.length),
    destinations,
    vData: data,
  });
}

function checkFundingScriptEnvelope(script: Buffer): void {
  // CScript::IsPayToCryptoCondition recognizes only a direct first push.
  // Scripts over MAX_SCRIPT_SIZE are unspendable, regardless of their payload.
  if (script.length > 10000 || script[0] < 1 || script[0] >= 76) {
    throw new RegistrationError(
      "UNSUPPORTED_FUNDING",
      "Funding script is not a spendable daemon smart transaction envelope."
    );
  }
}

function checkFundingScriptSize(smart: SmartTransactionScript): void {
  // The daemon appends the master to p.vData before checking p.AsVector().
  // The master is a direct push (<76 bytes), so its push prefix is one byte.
  // Checking only the serialized token payload misses this overhead.
  const paramsSize =
    smart.paramsOptCC.toChunk().length + 1 + smart.masterOptCC.toChunk().length;
  if (!smart.paramsOptCC.evalCode.eqn(EVALS.EVAL_NONE) && paramsSize >= 6000) {
    throw new RegistrationError(
      "UNSUPPORTED_SCRIPT_SIZE",
      "Funding or change exceeds the daemon smart transaction parameter limit; use a smaller funding set."
    );
  }
}

/** Ordinary transfers only; special registration outputs are handled explicitly. */
export function readFundingOutput(
  script: Buffer,
  value: number,
  systemID: string
): RegistrationAmounts {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RegistrationError(
      "UNSUPPORTED_AMOUNT",
      "Invalid native prevout value."
    );
  safeNative(String(value));
  const result: RegistrationAmounts = { [systemID]: String(value) };
  if (
    script.length === 25 &&
    script.subarray(0, 3).equals(Buffer.from("76a914", "hex")) &&
    script.subarray(23).equals(Buffer.from("88ac", "hex"))
  )
    return result;
  checkFundingScriptEnvelope(script);
  const smart = new SmartTransactionScript();
  smart.fromBuffer(script, 0, script.length);
  if (!smart.toBuffer().equals(script))
    throw new RegistrationError(
      "INVALID_PREVOUT",
      "Noncanonical smart funding script."
    );
  checkFundingScriptSize(smart);
  const master = smart.masterOptCC;
  const condition = smart.paramsOptCC;
  if (
    !master.version.eqn(3) ||
    !master.evalCode.eqn(EVALS.EVAL_NONE) ||
    master.vData.length ||
    !condition.version.eqn(3) ||
    condition.m.ltn(1) ||
    condition.m.gt(condition.n) ||
    !condition.n.eqn(condition.destinations.length) ||
    condition.destinations.length > 25 ||
    !(
      (master.m.isZero() && master.n.isZero() && !master.destinations.length) ||
      (master.m.eq(condition.m) &&
        master.n.eq(condition.n) &&
        master.destinations.length === condition.destinations.length &&
        master.destinations.every((dest, i) =>
          dest.toBuffer().equals(condition.destinations[i].toBuffer())
        ))
    )
  ) {
    throw new RegistrationError(
      "UNSUPPORTED_FUNDING",
      "Unsupported funding authorization conditions."
    );
  }
  condition.destinations.forEach((dest) => destination(dest.toAddress()));
  if (condition.evalCode.eqn(EVALS.EVAL_NONE) && condition.vData.length === 0)
    return result;
  if (
    !condition.evalCode.eqn(EVALS.EVAL_RESERVE_OUTPUT) ||
    condition.vData.length !== 1
  ) {
    throw new RegistrationError(
      "UNSUPPORTED_FUNDING",
      "Funding must be a key-hash, transparent identity, or ordinary reserve output."
    );
  }
  const token = new TokenOutput();
  const payload = condition.vData[0];
  if (
    token.fromBuffer(payload) !== payload.length ||
    !token.isValid() ||
    !token.toBuffer().equals(payload)
  ) {
    throw new RegistrationError("INVALID_PREVOUT", "Invalid reserve output.");
  }
  token.reserveValues.valueMap.forEach((amount, currency) => {
    if (currency === systemID)
      throw new RegistrationError(
        "INVALID_PREVOUT",
        "Reserve output duplicates native value."
      );
    const currencyDestination = destination(currency);
    if (!currencyDestination.type.eq(TxDestination.TYPE_ID))
      throw new RegistrationError(
        "INVALID_PREVOUT",
        "Invalid reserve currency."
      );
    result[currency] = atomic(amount.toString(10)).toString(10);
  });
  return result;
}

export function paymentOutput(
  recipient: string,
  values: RegistrationAmounts,
  systemID: string,
  role: RegistrationPlannedOutput["role"]
): RegistrationPlannedOutput {
  const dest = destination(recipient);
  const value = values[systemID] || "0";
  safeNative(value);
  const reserves = new Map<string, BN>();
  // Issuer/referral payments retain their reserve denomination even at zero:
  // registration consensus identifies these outputs by EVAL_RESERVE_OUTPUT.
  const retainZeroReserves = role === "issuer-payment" || role === "referral";
  Object.keys(values)
    .filter(
      (id) =>
        id !== systemID && (retainZeroReserves || !atomic(values[id]).isZero())
    )
    .forEach((id) => {
      if (!destination(id).type.eq(TxDestination.TYPE_ID))
        throw new RegistrationError(
          "INVALID_CURRENCY",
          "Invalid reserve currency ID."
        );
      reserves.set(id, atomic(values[id]));
    });
  let script: Buffer;
  if (!reserves.size && dest.type.eq(TxDestination.TYPE_PKH)) {
    script = address.toOutputScript(recipient, networks.verus);
  } else {
    const token = new TokenOutput({
      version: new BN(1),
      values: new CurrencyValueMap({
        valueMap: reserves,
        multivalue: reserves.size !== 1,
      }),
    });
    const smart = new SmartTransactionScript(
      params(EVALS.EVAL_NONE, reserves.size ? [dest] : []),
      params(
        reserves.size ? EVALS.EVAL_RESERVE_OUTPUT : EVALS.EVAL_NONE,
        [dest],
        reserves.size ? [token.toBuffer()] : []
      )
    );
    script = smart.toBuffer();
    checkFundingScriptEnvelope(script);
    checkFundingScriptSize(smart);
  }
  return {
    role,
    scriptHex: script.toString("hex"),
    value,
    values: { ...values, [systemID]: value },
  };
}

function assertRegistrationOutpoint(input: RegistrationFundingInput): void {
  if (
    !/^[0-9a-f]{64}$/.test(input.txid) ||
    !Number.isInteger(input.vout) ||
    input.vout < 0 ||
    input.vout > 0xffffffff
  ) {
    throw new RegistrationError(
      "INVALID_OUTPOINT",
      "Invalid registration outpoint."
    );
  }
}

/** Decode canonical source bytes before using their values for coin selection. */
function readRegistrationOutput(
  input: RegistrationFundingInput,
  raw: string,
  snapshot: RegistrationChainSnapshot,
  commitment: boolean
) {
  assertRegistrationOutpoint(input);
  const tx = parseTransaction(raw!);
  if (tx.getId() !== input.txid)
    throw new RegistrationError(
      "PREVOUT_MISMATCH",
      "Previous transaction hash does not match the requested outpoint."
    );
  const output = tx.outs[input.vout];
  if (!output)
    throw new RegistrationError(
      "INVALID_OUTPOINT",
      "Previous output index does not exist."
    );
  let values: RegistrationAmounts;
  if (commitment) {
    const script = new IdentityCommitmentScript();
    script.fromBuffer(output.script, 0, output.script.length);
    if (script.getCommitment().isAdvanced())
      throw new RegistrationError(
        "UNSUPPORTED_COMMITMENT",
        "Token-bearing commitments cannot register a name."
      );
    safeNative(String(output.value));
    values = { [snapshot.systemID]: String(output.value) };
  } else
    values = readFundingOutput(output.script, output.value, snapshot.systemID);
  return { tx, output, values };
}

function verifyRegistrationPrevout(
  input: RegistrationFundingInput,
  raw: string,
  response: RpcRequestResult<any>,
  snapshot: RegistrationChainSnapshot,
  commitment: boolean,
  decoded = readRegistrationOutput(input, raw, snapshot, commitment)
): RegistrationPrevout {
  const { tx, output, values } = decoded;
  if (response.error)
    throw new RegistrationError(
      "RPC_ERROR",
      "Cannot check previous output: " + response.error.message
    );
  const unspent = response.result;
  if (!unspent)
    throw new RegistrationError(
      commitment ? "COMMITMENT_SPENT" : "FUNDING_SPENT",
      "Previous output is unavailable or spent."
    );
  if (unspent.bestblock !== snapshot.tipHash)
    throw new RegistrationError(
      "STALE_CHAIN_CONTEXT",
      "Chain tip changed while checking previous outputs."
    );
  if (
    unspent.scriptPubKey.hex !== output.script.toString("hex") ||
    !currencyAmountToAtomic(unspent.value).eq(new BN(output.value))
  ) {
    throw new RegistrationError(
      "PREVOUT_MISMATCH",
      "Unspent output does not match its raw transaction."
    );
  }
  if (
    typeof unspent.coinbase !== "boolean" ||
    unspent.coinbase !== tx.isCoinbase()
  ) {
    throw new RegistrationError(
      "PREVOUT_MISMATCH",
      "Coinbase status does not match the previous transaction."
    );
  }
  if (
    !Number.isInteger(unspent.confirmations) ||
    unspent.confirmations < 0 ||
    unspent.confirmations > snapshot.candidateHeight
  ) {
    throw new RegistrationError(
      "INVALID_CONFIRMATION",
      "Invalid unspent output confirmation count."
    );
  }
  if (
    unspent.coinbase ||
    (unspent.interest != null && unspent.interest !== 0)
  ) {
    throw new RegistrationError(
      "UNSUPPORTED_FUNDING",
      "Coinbase and interest-bearing funding require a separate maturity/value policy."
    );
  }
  if (commitment && unspent.confirmations < 1)
    throw new RegistrationError(
      "COMMITMENT_UNCONFIRMED",
      "Commitment must be confirmed in the active chain before registration."
    );
  return {
    txid: input.txid,
    vout: input.vout,
    rawTransaction: raw!,
    scriptHex: output.script.toString("hex"),
    value: String(output.value),
    values,
    confirmations: unspent.confirmations,
    height: unspent.confirmations
      ? snapshot.candidateHeight - unspent.confirmations
      : 0,
  };
}

/**
 * Read an already-known group of inputs together. Supplied raw bytes avoid a
 * network read; every output still gets a fresh spendability check. The batch
 * helper bounds network groups, while verification keeps the caller's order.
 */
export async function readRegistrationPrevouts(
  rpc: RegistrationRpc,
  inputs: RegistrationFundingInput[],
  snapshot: RegistrationChainSnapshot,
  commitment = false
): Promise<RegistrationPrevout[]> {
  const reads: RegistrationRead[] = [];
  const rawIndexes = new Map<string, number>();
  const entries = inputs.map((input) => {
    assertRegistrationOutpoint(input);
    let rawIndex: number | undefined;
    let decoded: ReturnType<typeof readRegistrationOutput> | undefined;

    if (input.rawTransaction == null) {
      rawIndex = rawIndexes.get(input.txid);
      if (rawIndex == null) {
        rawIndex = reads.length;
        rawIndexes.set(input.txid, rawIndex);
        reads.push(["getRawTransaction", input.txid, 0]);
      }
    } else {
      // Reject malformed supplied bytes before asking the server for anything.
      decoded = readRegistrationOutput(
        input,
        input.rawTransaction,
        snapshot,
        commitment
      );
    }

    const unspentIndex = reads.length;
    reads.push(["getTxOut", input.txid, input.vout, true]);
    return { input, rawIndex, unspentIndex, decoded };
  });

  const responses = await registrationReadMany(rpc, reads);
  return entries.map(({ input, rawIndex, unspentIndex, decoded }) => {
    let raw = input.rawTransaction;
    if (rawIndex != null) {
      const response = responses[rawIndex];
      if (response.error)
        throw new RegistrationError(
          "RPC_ERROR",
          "Cannot read previous transaction: " + response.error.message
        );
      raw =
        typeof response.result === "string"
          ? response.result
          : response.result?.hex;
    }

    return verifyRegistrationPrevout(
      input,
      raw!,
      responses[unspentIndex],
      snapshot,
      commitment,
      decoded
    );
  });
}

export async function readRegistrationPrevout(
  rpc: RegistrationRpc,
  input: RegistrationFundingInput,
  snapshot: RegistrationChainSnapshot,
  commitment = false
): Promise<RegistrationPrevout> {
  return (
    await readRegistrationPrevouts(rpc, [input], snapshot, commitment)
  )[0];
}

export async function assertRegistrationSnapshot(
  rpc: RegistrationRpc,
  snapshot: RegistrationChainSnapshot,
  authorityOutpoints: readonly RegistrationAuthorityOutpoint[] = []
): Promise<void> {
  // An unchanged tip does not rule out a pending identity update. Recheck each
  // cached authority's defining output alongside the independent chain reads.
  const [info, block, ...unspentResponses] = await registrationReadMany(rpc, [
    ["getInfo"],
    ["getBlock", String(snapshot.tipHeight), 1],
    ...authorityOutpoints.map(
      (outpoint): RegistrationRead => [
        "getTxOut",
        outpoint.txid,
        outpoint.vout,
        true,
      ]
    ),
  ]);
  if (info.error) throw new RegistrationError("RPC_ERROR", info.error.message);
  if (block.error)
    throw new RegistrationError("RPC_ERROR", block.error.message);
  const result = block.result as any;
  if (
    info.result.blocks !== snapshot.tipHeight ||
    result.hash !== snapshot.tipHash ||
    result.height !== snapshot.tipHeight ||
    result.confirmations !== 1
  ) {
    throw new RegistrationError(
      "STALE_CHAIN_CONTEXT",
      "Chain context changed; resolve and review the registration again."
    );
  }

  authorityOutpoints.forEach((outpoint, index) => {
    const unspent = registrationRpcResult<any>(
      unspentResponses[index],
      "gettxout authorization"
    );
    if (!unspent)
      throw new RegistrationError(
        "AUTHORITY_CHANGED",
        "Signing authority was spent or changed; refresh registration."
      );

    if (unspent.bestblock !== snapshot.tipHash)
      throw new RegistrationError(
        "STALE_CHAIN_CONTEXT",
        "Chain tip changed while resolving signing authority."
      );

    if (
      !Number.isSafeInteger(unspent.confirmations) ||
      unspent.confirmations < 1 ||
      snapshot.candidateHeight - unspent.confirmations !== outpoint.height ||
      unspent.scriptPubKey?.hex !== outpoint.scriptHex ||
      !currencyAmountToAtomic(unspent.value).eq(atomic(outpoint.value))
    ) {
      throw new RegistrationError(
        "AUTHORITY_MISMATCH",
        "Signing authority unspent state differs from its confirmed defining output."
      );
    }
  });
}

export type FundedRegistration = {
  txHex: string;
  prevouts: RegistrationPrevout[];
  outputPlan: RegistrationPlannedOutput[];
};

/**
 * Verify the ordered funding prefix needed for every required currency.
 * Known amounts select a group locally; an unknown amount ends that group so
 * its raw transaction and spendability can be read together before proceeding.
 * Existing verified inputs let a caller extend coverage after a fee increase.
 */
export async function selectRegistrationFunding(
  rpc: RegistrationRpc,
  snapshot: RegistrationChainSnapshot,
  funding: RegistrationFundingInput[],
  needed: RegistrationAmounts,
  existing: RegistrationPrevout[] = []
): Promise<RegistrationPrevout[]> {
  const selected = existing.slice();
  const total: RegistrationAmounts = {};
  selected.forEach((input) => addAmounts(total, input.values));
  const knownTransactions = new Map(
    existing.map((input) => [input.txid, input.rawTransaction])
  );

  // Reject duplicates across the entire approval, including unused candidates.
  const seen = new Set<string>();
  for (const input of [...existing, ...funding]) {
    const key = input.txid + ":" + input.vout;
    if (seen.has(key))
      throw new RegistrationError(
        "DUPLICATE_INPUT",
        "Duplicate funding or commitment outpoint."
      );
    seen.add(key);
  }

  const sufficient = (amounts: RegistrationAmounts) =>
    Object.keys(needed).every((id) =>
      atomic(amounts[id] || "0").gte(atomic(needed[id]))
    );

  let index = 0;
  while (index < funding.length && !sufficient(total)) {
    const chosen: RegistrationFundingInput[] = [];
    const anticipated = { ...total };
    while (index < funding.length && !sufficient(anticipated)) {
      const candidate = funding[index++];
      const input = {
        ...candidate,
        rawTransaction:
          candidate.rawTransaction ?? knownTransactions.get(candidate.txid),
      };
      chosen.push(input);
      if (input.rawTransaction == null) break;

      const { values } = readRegistrationOutput(
        input,
        input.rawTransaction,
        snapshot,
        false
      );
      addAmounts(anticipated, values);
    }

    // Never fetch an unused tail merely to fill a batch. The read helper bounds
    // large known groups and verifies every selected amount against raw bytes.
    const verified = await readRegistrationPrevouts(rpc, chosen, snapshot);
    selected.push(...verified);
    verified.forEach((input) => {
      addAmounts(total, input.values);
      knownTransactions.set(input.txid, input.rawTransaction);
    });
  }

  if (!sufficient(total))
    throw new RegistrationError(
      "INSUFFICIENT_FUNDS",
      "Approved funding does not cover registration costs in every currency."
    );

  return selected;
}

/** Deterministic approved-input selection; the mandatory commitment is never coin-selected away. */
export async function fundRegistration(
  rpc: RegistrationRpc,
  snapshot: RegistrationChainSnapshot,
  outputs: RegistrationPlannedOutput[],
  nativeFee: string,
  funding: RegistrationFundingInput[],
  changeAddress: string,
  mandatory?: RegistrationPrevout
): Promise<FundedRegistration> {
  // The public selector can be used directly. Capture approvals before RPC
  // awaits so caller edits cannot replace outputs or the mandatory outpoint
  // while selection is in progress.
  snapshot = { ...snapshot };
  outputs = outputs.map((output) => ({
    ...output,
    values: { ...output.values },
  }));
  funding = funding.map((input) => ({ ...input }));
  if (mandatory) mandatory = { ...mandatory, values: { ...mandatory.values } };
  destination(changeAddress);
  const needed: RegistrationAmounts = {
    [snapshot.systemID]: atomic(nativeFee).toString(10),
  };
  outputs.forEach((output) => addAmounts(needed, output.values));
  const selected = await selectRegistrationFunding(
    rpc,
    snapshot,
    funding,
    needed,
    mandatory ? [mandatory] : []
  );
  if (!selected.length)
    throw new RegistrationError(
      "INSUFFICIENT_FUNDS",
      "Approved funding does not cover registration costs in every currency."
    );
  const total: RegistrationAmounts = {};
  selected.forEach((input) => addAmounts(total, input.values));
  const change: RegistrationAmounts = {};
  Object.keys(total).forEach((id) => {
    const amount = atomic(total[id]).sub(atomic(needed[id] || "0"));
    if (!amount.isZero()) change[id] = amount.toString(10);
  });
  const outputPlan = outputs.slice();
  if (Object.keys(change).length)
    outputPlan.push(
      paymentOutput(changeAddress, change, snapshot.systemID, "change")
    );
  const builder = new TransactionBuilder(networks.verus);
  builder.setVersion(4);
  builder.setVersionGroupId(0x892f2085);
  builder.setExpiryHeight(snapshot.expiryHeight);
  selected.forEach((input) =>
    builder.addInput(
      Buffer.from(input.txid, "hex").reverse(),
      input.vout,
      0xffffffff
    )
  );
  outputPlan.forEach((output) =>
    builder.addOutput(
      Buffer.from(output.scriptHex, "hex"),
      safeNative(output.value)
    )
  );
  const funded = {
    txHex: builder.buildIncomplete().toHex(),
    prevouts: selected,
    outputPlan,
  };
  // Selection uses cached balances for efficiency. A separate decoder must
  // prove conservation using the actual bytes before the result is released.
  verifyRegistrationFunding(funded, {
    snapshot,
    nativeFee,
    changeAddress,
    outputs,
    commitment: mandatory && { txid: mandatory.txid, vout: mandatory.vout },
  });
  return funded;
}

/** Check all bytes other than signatures, plus raw prevout amounts and currency conservation. */
export function validateRegistrationTransaction(
  prepared: FundedRegistration & {
    snapshot: RegistrationChainSnapshot;
    nativeFee: string;
  },
  candidateHex = prepared.txHex
): true {
  const approved = parseTransaction(prepared.txHex);
  const candidate = parseTransaction(candidateHex);
  if (approved.ins.some((input: any) => input.script.length))
    throw new RegistrationError(
      "INVALID_PLAN",
      "The approved transaction must be unsigned."
    );
  const stripped = candidate.clone();
  stripped.ins.forEach((input: any) => {
    input.script = Buffer.alloc(0);
  });
  if (stripped.toHex() !== approved.toHex())
    throw new RegistrationError(
      "TRANSACTION_CHANGED",
      "Transaction differs from the approved registration plan."
    );
  if (
    candidate.version !== 4 ||
    candidate.versionGroupId !== 0x892f2085 ||
    candidate.expiryHeight !== prepared.snapshot.expiryHeight ||
    candidate.locktime !== 0 ||
    candidate.joinsplits?.length ||
    candidate.vShieldedSpend?.length ||
    candidate.vShieldedOutput?.length
  ) {
    throw new RegistrationError(
      "INVALID_TRANSACTION",
      "Unsupported registration transaction context."
    );
  }
  if (
    candidate.ins.length !== prepared.prevouts.length ||
    candidate.outs.length !== prepared.outputPlan.length
  )
    throw new RegistrationError(
      "INVALID_PLAN",
      "Input or output plan length mismatch."
    );
  const incoming: RegistrationAmounts = {};
  const outgoing: RegistrationAmounts = {
    [prepared.snapshot.systemID]: atomic(prepared.nativeFee).toString(10),
  };
  const seen = new Set<string>();
  prepared.prevouts.forEach((prevout, i) => {
    const input = candidate.ins[i];
    const key = prevout.txid + ":" + prevout.vout;
    if (
      seen.has(key) ||
      Buffer.from(input.hash).reverse().toString("hex") !== prevout.txid ||
      input.index !== prevout.vout ||
      input.sequence !== 0xffffffff
    )
      throw new RegistrationError(
        "PREVOUT_MISMATCH",
        "Transaction inputs do not match the approved outpoints."
      );
    seen.add(key);
    const source = parseTransaction(prevout.rawTransaction);
    const output = source.outs[prevout.vout];
    if (
      source.getId() !== prevout.txid ||
      !output ||
      output.script.toString("hex") !== prevout.scriptHex ||
      String(output.value) !== prevout.value
    )
      throw new RegistrationError(
        "PREVOUT_MISMATCH",
        "Signing prevout does not match its raw source transaction."
      );
    let values: RegistrationAmounts;
    try {
      values = readFundingOutput(
        output.script,
        output.value,
        prepared.snapshot.systemID
      );
    } catch (error) {
      const commitment = new IdentityCommitmentScript();
      commitment.fromBuffer(output.script, 0, output.script.length);
      if (commitment.getCommitment().isAdvanced()) throw error;
      values = { [prepared.snapshot.systemID]: String(output.value) };
    }
    const ids = new Set([
      ...Object.keys(values),
      ...Object.keys(prevout.values),
    ]);
    ids.forEach((id) => {
      if (!atomic(values[id] || "0").eq(atomic(prevout.values[id] || "0")))
        throw new RegistrationError(
          "PREVOUT_MISMATCH",
          "Incorrect previous output currency amounts."
        );
    });
    addAmounts(incoming, values);
  });
  prepared.outputPlan.forEach((output, i) => {
    if (
      candidate.outs[i].script.toString("hex") !== output.scriptHex ||
      String(candidate.outs[i].value) !== output.value ||
      (output.values[prepared.snapshot.systemID] || "0") !== output.value
    )
      throw new RegistrationError(
        "OUTPUT_MISMATCH",
        "Registration outputs differ from the approved plan."
      );
    const script = candidate.outs[i].script as Buffer;
    let values: RegistrationAmounts = {
      [prepared.snapshot.systemID]: output.value,
    };
    if (output.role === "commitment") {
      const commitment = new IdentityCommitmentScript();
      commitment.fromBuffer(script, 0, script.length);
      if (
        commitment.getCommitment().isAdvanced() ||
        !commitment.toBuffer().equals(script)
      ) {
        throw new RegistrationError(
          "OUTPUT_MISMATCH",
          "Invalid ordinary name commitment output."
        );
      }
    } else if (output.role === "identity") {
      const identity = new IdentityScript();
      identity.fromBuffer(script, 0, script.length);
      if (
        !IdentityScript.fromIdentity(identity.getIdentity())
          .toBuffer()
          .equals(script)
      ) {
        throw new RegistrationError(
          "OUTPUT_MISMATCH",
          "Identity output does not match its encoded identity authorities."
        );
      }
    } else if (output.role === "reservation") {
      const reservation = new IdentityReservationScript();
      reservation.fromBuffer(script, 0, script.length);
      if (!reservation.toBuffer().equals(script))
        throw new RegistrationError(
          "OUTPUT_MISMATCH",
          "Invalid reservation output."
        );
    } else if (output.role === "burn") {
      const smart = new SmartTransactionScript();
      smart.fromBuffer(script, 0, script.length);
      if (
        !smart.toBuffer().equals(script) ||
        !smart.paramsOptCC.evalCode.eqn(EVALS.EVAL_RESERVE_TRANSFER) ||
        smart.paramsOptCC.vData.length !== 1
      ) {
        throw new RegistrationError(
          "OUTPUT_MISMATCH",
          "Invalid registration burn output."
        );
      }
      const transfer = new ReserveTransfer();
      const payload = smart.paramsOptCC.vData[0];
      if (
        transfer.fromBuffer(payload) !== payload.length ||
        !transfer.isValid() ||
        !transfer.toBuffer().equals(payload) ||
        !transfer.flags.eq(
          RESERVE_TRANSFER_VALID.or(RESERVE_TRANSFER_BURN_CHANGE_PRICE)
        ) ||
        transfer.feeCurrencyID !== prepared.snapshot.systemID ||
        !transfer.feeAmount.eq(atomic(output.value)) ||
        transfer.reserveValues.valueMap.size !== 1 ||
        !transfer.transferDestination.type.eq(DEST_ID)
      ) {
        throw new RegistrationError(
          "OUTPUT_MISMATCH",
          "Unsupported registration burn transfer."
        );
      }
      const burnDestination = new TxDestination(
        new KeyID(RESERVE_TRANSFER_DESTINATION.destinationBytes)
      );
      const canonicalBurn = new SmartTransactionScript(
        params(EVALS.EVAL_NONE, [burnDestination]),
        params(
          EVALS.EVAL_RESERVE_TRANSFER,
          [burnDestination],
          [transfer.toBuffer()]
        )
      );
      if (!canonicalBurn.toBuffer().equals(script)) {
        throw new RegistrationError(
          "OUTPUT_MISMATCH",
          "Registration burn has unexpected authorization conditions."
        );
      }
      transfer.reserveValues.valueMap.forEach((amount, currency) => {
        if (
          currency === prepared.snapshot.systemID ||
          !destination(currency).type.eq(TxDestination.TYPE_ID) ||
          transfer.destCurrencyID !== currency ||
          transfer.transferDestination.getAddressString() !== currency
        ) {
          throw new RegistrationError(
            "OUTPUT_MISMATCH",
            "Registration burn must pay its issuing currency."
          );
        }
        values[currency] = atomic(amount.toString(10)).toString(10);
      });
    } else if (
      output.role === "issuer-payment" ||
      output.role === "referral" ||
      output.role === "change"
    ) {
      values = readFundingOutput(
        script,
        candidate.outs[i].value,
        prepared.snapshot.systemID
      );
    } else {
      throw new RegistrationError(
        "OUTPUT_MISMATCH",
        "Unknown registration output role."
      );
    }
    new Set([...Object.keys(values), ...Object.keys(output.values)]).forEach(
      (id) => {
        if (!atomic(values[id] || "0").eq(atomic(output.values[id] || "0"))) {
          throw new RegistrationError(
            "OUTPUT_MISMATCH",
            "Output currency metadata does not match its script bytes."
          );
        }
      }
    );
    addAmounts(outgoing, values);
  });
  new Set([...Object.keys(incoming), ...Object.keys(outgoing)]).forEach(
    (id) => {
      if (!atomic(incoming[id] || "0").eq(atomic(outgoing[id] || "0")))
        throw new RegistrationError(
          "VALUE_MISMATCH",
          "Registration does not conserve the approved currency balances and fee."
        );
    }
  );
  return true;
}
