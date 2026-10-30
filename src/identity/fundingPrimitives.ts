import BigNumber from "bignumber.js";
import { Transaction, networks, opcodes } from "@bitgo/utxo-lib";
import {
  EVALS,
  I_ADDR_VERSION,
  R_ADDR_VERSION,
  fromBase58Check,
  toBase58Check,
  SmartTransactionScript,
  TokenOutput,
  TxDestination,
} from "verus-typescript-primitives";

// These helpers keep verification arithmetic and decoding separate from the
// selector and its existing validator. Read balances from transaction/script
// bytes rather than trusting outputPlan.values or prevout.values.

/** Currency IDs mapped to exact amounts in atomic units. */
type Amounts = Map<string, BigNumber>;
type Output = { script: Buffer; value: number };

const PUBLIC_KEY_HASH_LENGTH = 20;
const P2PKH_PREFIX = Buffer.from([
  opcodes.OP_DUP,
  opcodes.OP_HASH160,
  PUBLIC_KEY_HASH_LENGTH, // Direct push of the following 20-byte hash.
]);
const P2PKH_SUFFIX = Buffer.from([opcodes.OP_EQUALVERIFY, opcodes.OP_CHECKSIG]);

function requireCondition(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new Error(message);
}

/** Parse a canonical nonnegative integer within the daemon's monetary range. */
function amount(value: string): BigNumber {
  requireCondition(
    typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value),
    "Amounts must be nonnegative atomic integer strings."
  );

  const result = new BigNumber(value);
  requireCondition(
    result.lte("5000000000000000000"),
    "Amount exceeds the daemon monetary range."
  );

  return result;
}

// Native values arrive as JavaScript numbers from the transaction library,
// whose supported monetary limit is narrower than the daemon's reserve limit.
function nativeAmount(value: number): BigNumber {
  requireCondition(
    Number.isSafeInteger(value) && value >= 0 && value <= 2100000000000000,
    "Unsupported native amount."
  );

  return amount(String(value));
}

function add(totals: Amounts, values: Amounts): void {
  for (const [id, value] of values) {
    // Apply the range check to each currency's aggregate, not just its inputs.
    totals.set(
      id,
      amount((totals.get(id) || new BigNumber(0)).plus(value).toFixed(0))
    );
  }
}

function sameAmounts(left: Amounts, right: Amounts, message: string): void {
  // Compare every currency on either side; an absent entry represents zero.
  for (const id of new Set([...left.keys(), ...right.keys()])) {
    requireCondition(
      (left.get(id) || new BigNumber(0)).eq(right.get(id) || 0),
      message
    );
  }
}

/** Currency IDs require i-addresses; payment destinations may also use R-addresses. */
function validAddress(value: string, identityOnly = false): void {
  const decoded = fromBase58Check(value);
  requireCondition(
    decoded.hash.length === 20 &&
      !decoded.hash.equals(Buffer.alloc(20)) &&
      (decoded.version === I_ADDR_VERSION ||
        (!identityOnly && decoded.version === R_ADDR_VERSION)),
    "Unsupported currency or payment address."
  );
}

/** Decode an atomic amount record without trusting its currency keys or values. */
function amountMap(
  values: Record<string, string>,
  message = "Invalid currency amounts."
): Amounts {
  requireCondition(
    values && typeof values === "object" && !Array.isArray(values),
    message
  );

  return new Map(
    Object.entries(values).map(([id, value]) => {
      validAddress(id, true);
      return [id, amount(value)];
    })
  );
}

function transaction(hex: string): any {
  requireCondition(
    typeof hex === "string" && /^(?:[0-9a-fA-F]{2})+$/.test(hex),
    "Invalid transaction bytes."
  );

  // A successful parse alone is insufficient: require an exact round trip so
  // ignored trailing bytes or normalized encodings cannot affect approval.
  const tx = Transaction.fromHex(hex, networks.verus);
  requireCondition(
    tx.toHex() === hex.toLowerCase(),
    "Noncanonical transaction bytes."
  );

  return tx;
}

/** Require the decoded script to serialize back to exactly the supplied bytes. */
function parseScript<
  T extends {
    fromBuffer(bytes: Buffer, offset: number, length: number): unknown;
    toBuffer(): Buffer;
  }
>(Type: new () => T, bytes: Buffer): T {
  const parsed = new Type();
  parsed.fromBuffer(bytes, 0, bytes.length);
  requireCondition(
    parsed.toBuffer().equals(bytes),
    "Noncanonical output script."
  );

  return parsed;
}

/**
 * Decode an ordinary native/reserve output. Special protocol outputs are
 * handled by their callers. An expected recipient restricts payment/change
 * to that single destination, even though funding may use multiple signers.
 */
function ordinaryOutput(
  output: Output,
  systemID: string,
  expectedRecipient?: string,
  allowIndexMaster = false
): Amounts {
  // The native balance comes only from nValue, never from the reserve payload.
  const values = new Map([[systemID, nativeAmount(output.value)]]);
  const bytes = output.script;
  const hashEnd = P2PKH_PREFIX.length + PUBLIC_KEY_HASH_LENGTH;

  // P2PKH: OP_DUP OP_HASH160 <20-byte hash> OP_EQUALVERIFY OP_CHECKSIG.
  // Recognize the exact script layout; this does not execute or verify it.
  if (
    bytes.length === hashEnd + P2PKH_SUFFIX.length &&
    bytes.subarray(0, P2PKH_PREFIX.length).equals(P2PKH_PREFIX) &&
    bytes.subarray(hashEnd).equals(P2PKH_SUFFIX)
  ) {
    const recipient = toBase58Check(
      bytes.subarray(P2PKH_PREFIX.length, hashEnd),
      R_ADDR_VERSION
    );
    validAddress(recipient);
    if (expectedRecipient) {
      requireCondition(
        recipient === expectedRecipient,
        "Unexpected payment or change destination."
      );
    }

    return values;
  }

  // The daemon recognizes smart outputs only with a direct first data push
  // (1–75 bytes) and a script no larger than 10,000 bytes.
  requireCondition(
    bytes.length <= 10000 && bytes[0] > 0 && bytes[0] < 76,
    "Output is not a spendable daemon smart transaction envelope."
  );

  const smart = parseScript(SmartTransactionScript, bytes);
  const master = smart.masterOptCC;
  const condition = smart.paramsOptCC;

  // CScript appends the first (master) push to the parameter object's vData.
  // Match the daemon's strict <6000 contextual limit on the resulting object.
  // The extra byte is the direct-push prefix for the master.
  requireCondition(
    condition.evalCode.eqn(EVALS.EVAL_NONE) ||
      condition.toChunk().length + 1 + master.toChunk().length < 6000,
    "Output exceeds the daemon smart transaction parameter limit."
  );

  requireCondition(
    master.version.eqn(3) &&
      master.evalCode.eqn(EVALS.EVAL_NONE) &&
      !master.vData.length &&
      condition.version.eqn(3) &&
      condition.m.gten(1) &&
      condition.m.lte(condition.n) &&
      condition.n.eqn(condition.destinations.length) &&
      condition.destinations.length <= 25,
    "Unsupported funding or payment conditions."
  );

  // Support an empty master or one that repeats the same authorization;
  // a different master could introduce an alternate spending condition.
  const emptyMaster =
    master.m.isZero() && master.n.isZero() && !master.destinations.length;
  const sameMaster =
    master.m.eq(condition.m) &&
    master.n.eq(condition.n) &&
    master.destinations.length === condition.destinations.length &&
    master.destinations.every((dest, i) =>
      dest.toBuffer().equals(condition.destinations[i].toBuffer())
    );
  // A tag is permitted only on an explicitly approved payment output.
  const indexMaster = allowIndexMaster &&
    master.m.eqn(1) && master.n.eqn(1) && master.destinations.length === 1 &&
    master.destinations[0].type.eq(TxDestination.TYPE_INDEX) &&
    master.destinations[0].data.toBuffer().length === PUBLIC_KEY_HASH_LENGTH;
  requireCondition(
    emptyMaster || sameMaster || indexMaster,
    "Unexpected alternate output authorization."
  );

  condition.destinations.forEach((dest) => validAddress(dest.toAddress()));
  if (expectedRecipient) {
    requireCondition(
      condition.m.eqn(1) &&
        condition.n.eqn(1) &&
        condition.destinations[0].toAddress() === expectedRecipient,
      "Unexpected payment or change destination."
    );
  }

  if (condition.evalCode.eqn(EVALS.EVAL_NONE)) {
    requireCondition(
      !condition.vData.length,
      "Unexpected data in native funding output."
    );
    return values;
  }

  // Only ordinary reserve outputs are accepted here. Transfers, deposits, and
  // other protocol outputs have separate accounting and spending rules.
  requireCondition(
    condition.evalCode.eqn(EVALS.EVAL_RESERVE_OUTPUT) &&
      condition.vData.length === 1,
    "Unsupported funding or payment output type."
  );

  const token = new TokenOutput();
  const payload = condition.vData[0];

  // Reject payloads the parser would normalize, including duplicate map keys.
  requireCondition(
    token.fromBuffer(payload) === payload.length &&
      token.isValid() &&
      token.toBuffer().equals(payload),
    "Invalid reserve currency encoding."
  );

  for (const [id, value] of token.reserveValues.valueMap) {
    validAddress(id, true);

    // Reject a second representation of native value, even when it is zero,
    // rather than allowing the reserve payload to overwrite the nValue balance.
    requireCondition(
      id !== systemID,
      "Reserve output duplicates native currency."
    );
    values.set(id, amount(value.toString(10)));
  }

  return values;
}

export {
  amount,
  nativeAmount,
  add,
  sameAmounts,
  validAddress,
  amountMap,
  transaction,
  parseScript,
  ordinaryOutput,
  requireCondition,
};
export type { Amounts, Output };
