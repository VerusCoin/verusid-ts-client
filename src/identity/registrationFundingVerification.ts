import BigNumber from "bignumber.js";
import { Transaction, networks } from "@bitgo/utxo-lib";
import {
  EVALS,
  I_ADDR_VERSION,
  R_ADDR_VERSION,
  fromBase58Check,
  toBase58Check,
  SmartTransactionScript,
  TokenOutput,
  ReserveTransfer,
  IdentityCommitmentScript,
  IdentityScript,
  IdentityReservationScript,
  DEST_ID,
  RESERVE_TRANSFER_VALID,
  RESERVE_TRANSFER_BURN_CHANGE_PRICE,
  RESERVE_TRANSFER_DESTINATION,
} from "verus-typescript-primitives";
import { RegistrationError } from "./registrationPolicy";
import type {
  IdentityRegistrationQuote,
  RegistrationPayment,
} from "./registrationPolicy";
import type { PreparedIdentityRegistrationTransaction } from "./registration";
import type {
  FundedRegistration,
  RegistrationAmounts,
  RegistrationChainSnapshot,
  RegistrationFundingInput,
  RegistrationPlannedOutput,
} from "./registrationTransaction";

/** Retain this approval independently from the transaction being checked. */
export interface RegistrationFundingApproval {
  snapshot: RegistrationChainSnapshot;
  nativeFee: string;
  changeAddress: string;
  /** Approved outputs before the selector appends change. */
  outputs: RegistrationPlannedOutput[];
  /** Only this exact name commitment may be spent as a special input. */
  commitment?: RegistrationFundingInput;
}

type Amounts = Map<string, BigNumber>;
type Output = { script: Buffer; value: number };
type Description = {
  role: RegistrationPlannedOutput["role"];
  approved?: RegistrationPlannedOutput;
  payment?: RegistrationPayment;
};

function requireCondition(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new Error(message);
}

// Deliberately separate arithmetic and script decoding from the selector and
// its existing validator. Never use outputPlan.values or prevout.values to
// establish what an input/output actually carries.
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

function nativeAmount(value: number): BigNumber {
  requireCondition(
    Number.isSafeInteger(value) && value >= 0 && value <= 2100000000000000,
    "Unsupported native amount."
  );
  return amount(String(value));
}

function add(totals: Amounts, values: Amounts): void {
  for (const [id, value] of values) {
    totals.set(
      id,
      amount((totals.get(id) || new BigNumber(0)).plus(value).toFixed(0))
    );
  }
}

function sameAmounts(left: Amounts, right: Amounts, message: string): void {
  for (const id of new Set([...left.keys(), ...right.keys()])) {
    requireCondition(
      (left.get(id) || new BigNumber(0)).eq(right.get(id) || 0),
      message
    );
  }
}

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

function amountMap(values: RegistrationAmounts): Amounts {
  requireCondition(
    values && typeof values === "object" && !Array.isArray(values),
    "Invalid currency amounts."
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
  const tx = Transaction.fromHex(hex, networks.verus);
  requireCondition(
    tx.toHex() === hex.toLowerCase(),
    "Noncanonical transaction bytes."
  );
  return tx;
}

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

function ordinaryOutput(
  output: Output,
  systemID: string,
  expectedRecipient?: string
): Amounts {
  const values = new Map([[systemID, nativeAmount(output.value)]]);
  const bytes = output.script;
  if (
    bytes.length === 25 &&
    bytes.subarray(0, 3).equals(Buffer.from("76a914", "hex")) &&
    bytes.subarray(23).equals(Buffer.from("88ac", "hex"))
  ) {
    const recipient = toBase58Check(bytes.subarray(3, 23), R_ADDR_VERSION);
    validAddress(recipient);
    if (expectedRecipient)
      requireCondition(
        recipient === expectedRecipient,
        "Unexpected payment or change destination."
      );
    return values;
  }
  requireCondition(
    bytes.length <= 10000 && bytes[0] > 0 && bytes[0] < 76,
    "Output is not a spendable daemon smart transaction envelope."
  );
  const smart = parseScript(SmartTransactionScript, bytes);
  const master = smart.masterOptCC;
  const condition = smart.paramsOptCC;
  // CScript appends the first (master) push to the parameter object's vData.
  // Match the daemon's strict <6000 contextual limit on the resulting object.
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
  const emptyMaster =
    master.m.isZero() && master.n.isZero() && !master.destinations.length;
  const sameMaster =
    master.m.eq(condition.m) &&
    master.n.eq(condition.n) &&
    master.destinations.length === condition.destinations.length &&
    master.destinations.every((dest, i) =>
      dest.toBuffer().equals(condition.destinations[i].toBuffer())
    );
  requireCondition(
    emptyMaster || sameMaster,
    "Unexpected alternate output authorization."
  );
  condition.destinations.forEach((dest) => validAddress(dest.toAddress()));
  if (expectedRecipient)
    requireCondition(
      condition.m.eqn(1) &&
        condition.n.eqn(1) &&
        condition.destinations[0].toAddress() === expectedRecipient,
      "Unexpected payment or change destination."
    );
  if (condition.evalCode.eqn(EVALS.EVAL_NONE)) {
    requireCondition(
      !condition.vData.length,
      "Unexpected data in native funding output."
    );
    return values;
  }
  requireCondition(
    condition.evalCode.eqn(EVALS.EVAL_RESERVE_OUTPUT) &&
      condition.vData.length === 1,
    "Unsupported funding or payment output type."
  );
  const token = new TokenOutput();
  const payload = condition.vData[0];
  requireCondition(
    token.fromBuffer(payload) === payload.length &&
      token.isValid() &&
      token.toBuffer().equals(payload),
    "Invalid reserve currency encoding."
  );
  for (const [id, value] of token.reserveValues.valueMap) {
    validAddress(id, true);
    requireCondition(
      id !== systemID,
      "Reserve output duplicates native currency."
    );
    values.set(id, amount(value.toString(10)));
  }
  return values;
}

function commitmentInput(output: Output, systemID: string): Amounts {
  const commitment = parseScript(IdentityCommitmentScript, output.script);
  requireCondition(
    !commitment.getCommitment().isAdvanced(),
    "Token-bearing name commitments are unsupported."
  );
  // Ordinary commitments may carry native value. Credit the real nValue and
  // return any surplus as change, just as for ordinary funding inputs.
  return new Map([[systemID, nativeAmount(output.value)]]);
}

function metadataOutput(
  output: Output,
  role: Description["role"],
  systemID: string
): Amounts {
  requireCondition(
    output.value === 0,
    "Registration metadata must not absorb funds."
  );
  if (role === "commitment") return commitmentInput(output, systemID);
  if (role === "identity") {
    const identity = parseScript(IdentityScript, output.script).getIdentity();
    requireCondition(
      IdentityScript.fromIdentity(identity).toBuffer().equals(output.script),
      "Invalid identity authorization script."
    );
  } else {
    requireCondition(
      role === "reservation",
      "Unknown registration output role."
    );
    parseScript(IdentityReservationScript, output.script);
  }
  return new Map([[systemID, new BigNumber(0)]]);
}

function burnOutput(
  output: Output,
  systemID: string,
  quote?: IdentityRegistrationQuote,
  payment?: RegistrationPayment
): Amounts {
  const smart = parseScript(SmartTransactionScript, output.script);
  const master = smart.masterOptCC;
  const condition = smart.paramsOptCC;
  const burnAddress = RESERVE_TRANSFER_DESTINATION.getAddressString();
  for (const params of [master, condition]) {
    requireCondition(
      params.version.eqn(3) &&
        params.m.eqn(1) &&
        params.n.eqn(1) &&
        params.destinations.length === 1 &&
        params.destinations[0].toAddress() === burnAddress,
      "Unexpected registration burn authorization."
    );
  }
  requireCondition(
    master.evalCode.eqn(EVALS.EVAL_NONE) &&
      !master.vData.length &&
      condition.evalCode.eqn(EVALS.EVAL_RESERVE_TRANSFER) &&
      condition.vData.length === 1,
    "Unsupported registration burn output."
  );
  const transfer = new ReserveTransfer();
  const payload = condition.vData[0];
  requireCondition(
    transfer.fromBuffer(payload) === payload.length &&
      transfer.isValid() &&
      transfer.toBuffer().equals(payload) &&
      transfer.flags.eq(
        RESERVE_TRANSFER_VALID.or(RESERVE_TRANSFER_BURN_CHANGE_PRICE)
      ) &&
      transfer.feeCurrencyID === systemID &&
      transfer.transferDestination.type.eq(DEST_ID) &&
      !transfer.transferDestination.auxDests.length &&
      transfer.transferDestination.fees.isZero() &&
      transfer.reserveValues.valueMap.size === 1,
    "Unsupported registration burn transfer."
  );
  const [currencyID, burned] = [...transfer.reserveValues.valueMap][0];
  validAddress(currencyID, true);
  requireCondition(
    currencyID !== systemID &&
      transfer.destCurrencyID === currencyID &&
      transfer.transferDestination.getAddressString() === currencyID &&
      nativeAmount(output.value).eq(amount(transfer.feeAmount.toString(10))),
    "Incorrect burn currency or transfer fee."
  );
  if (quote && payment) {
    requireCondition(
      payment.currencyID === currencyID &&
        payment.recipient === currencyID &&
        nativeAmount(output.value).eq(amount(quote.transferFee)) &&
        amount(burned.toString(10)).eq(amount(payment.amount)),
      "Burn differs from the approved registration payment."
    );
  }
  return new Map([
    [systemID, nativeAmount(output.value)],
    [currencyID, amount(burned.toString(10))],
  ]);
}

function verify(
  funded: FundedRegistration,
  approval: Omit<RegistrationFundingApproval, "outputs">,
  descriptions: Description[],
  candidateHex: string,
  quote?: IdentityRegistrationQuote,
  expectedCosts?: Amounts
): true {
  const systemID = approval.snapshot.systemID;
  validAddress(systemID, true);
  validAddress(approval.changeAddress);
  const approved = transaction(funded.txHex);
  const candidate = transaction(candidateHex);
  requireCondition(
    candidate.version === 4 &&
      candidate.overwintered === 1 &&
      candidate.versionGroupId === 0x892f2085 &&
      candidate.locktime === 0 &&
      candidate.expiryHeight === approval.snapshot.expiryHeight &&
      !candidate.isCoinbase() &&
      !candidate.joinsplits?.length &&
      !candidate.vShieldedSpend?.length &&
      !candidate.vShieldedOutput?.length &&
      (!candidate.valueBalance ||
        candidate.valueBalance.equals(Buffer.alloc(8))),
    "Unsupported registration transaction."
  );
  requireCondition(
    approved.ins.every((input: any) => !input.script.length),
    "Approval transaction is already signed."
  );
  const stripped = candidate.clone();
  stripped.ins.forEach((input: any) => {
    input.script = Buffer.alloc(0);
  });
  requireCondition(
    stripped.toHex() === approved.toHex(),
    "Transaction changed after approval."
  );
  requireCondition(
    candidate.ins.length > 0 && candidate.ins.length === funded.prevouts.length,
    "Missing or unexpected funding input."
  );
  const incoming: Amounts = new Map();
  const seen = new Set<string>();
  const sources = new Map<string, { tx: any; hex: string }>();
  let commitmentCount = 0;
  candidate.ins.forEach((input: any, index: number) => {
    const txid = Buffer.from(input.hash).reverse().toString("hex");
    const key = `${txid}:${input.index}`;
    const prevout = funded.prevouts[index];
    requireCondition(
      !seen.has(key) &&
        input.sequence === 0xffffffff &&
        prevout.txid === txid &&
        prevout.vout === input.index,
      "Duplicate or unexpected funding outpoint."
    );
    seen.add(key);
    let source = sources.get(txid);
    if (!source) {
      const tx = transaction(prevout.rawTransaction);
      requireCondition(
        tx.getId() === txid && !tx.isCoinbase(),
        "Invalid funding source transaction."
      );
      source = { tx, hex: prevout.rawTransaction };
      sources.set(txid, source);
    } else
      requireCondition(
        source.hex === prevout.rawTransaction,
        "Inconsistent funding source transaction."
      );
    const output = source.tx.outs[input.index];
    requireCondition(!!output, "Funding output does not exist.");
    if (
      approval.commitment &&
      txid === approval.commitment.txid &&
      input.index === approval.commitment.vout
    ) {
      commitmentCount++;
      add(incoming, commitmentInput(output, systemID));
    } else add(incoming, ordinaryOutput(output, systemID));
  });
  requireCondition(
    !approval.commitment || commitmentCount === 1,
    "Registration must spend its approved name commitment."
  );
  requireCondition(
    candidate.outs.length === descriptions.length ||
      candidate.outs.length === descriptions.length + 1,
    "Unexpected registration outputs."
  );
  const expectedFee = amount(approval.nativeFee);
  const outgoing: Amounts = new Map();
  const spending: Amounts = new Map([[systemID, expectedFee]]);
  candidate.outs.forEach((output: Output, index: number) => {
    const description = descriptions[index];
    let values: Amounts;
    if (!description)
      values = ordinaryOutput(output, systemID, approval.changeAddress);
    else {
      if (description.approved) {
        requireCondition(
          output.script.toString("hex") ===
            description.approved.scriptHex.toLowerCase() &&
            nativeAmount(output.value).eq(amount(description.approved.value)),
          "Output differs from the approved payment."
        );
      }
      if (
        description.role === "issuer-payment" ||
        description.role === "referral"
      ) {
        const payment = description.payment;
        values = ordinaryOutput(output, systemID, payment?.recipient);
        if (payment)
          sameAmounts(
            values,
            amountMap({ [payment.currencyID]: payment.amount }),
            "Payment differs from the approved amount or currency."
          );
      } else if (description.role === "burn") {
        values = burnOutput(output, systemID, quote, description.payment);
      } else values = metadataOutput(output, description.role, systemID);
      add(spending, values);
    }
    add(outgoing, values);
  });
  if (expectedCosts)
    sameAmounts(
      spending,
      expectedCosts,
      "Actual spending differs from the approved registration costs."
    );
  // Exact equality rejects excess native fees and implicit reserve burns,
  // including currencies unrelated to the registration quote.
  add(outgoing, new Map([[systemID, expectedFee]]));
  sameAmounts(
    incoming,
    outgoing,
    "Input funds do not exactly cover the approved payments, change, and fee."
  );
  return true;
}

function guard(verifyFunding: () => true): true {
  try {
    return verifyFunding();
  } catch (error) {
    throw new RegistrationError(
      "REGISTRATION_FUNDING_MISMATCH",
      "Registration funding verification failed. " +
        (error instanceof Error ? error.message : String(error))
    );
  }
}

/** Independent byte-level conservation check, also run automatically by fundRegistration. */
export function verifyRegistrationFunding(
  funded: FundedRegistration,
  approval: RegistrationFundingApproval,
  candidateHex = funded.txHex
): true {
  return guard(() =>
    verify(
      funded,
      approval,
      approval.outputs.map((output) => ({
        role: output.role,
        approved: output,
      })),
      candidateHex
    )
  );
}

/**
 * Check all currencies, exact quoted fees/payments, and approved change directly
 * from transaction bytes and hash-verified source transactions. The prepared
 * approval must be retained independently from externally supplied candidates.
 * expectedChangeAddress can bind deserialized plans to an external approval.
 * This performs no RPC calls and must not be cached before broadcasting.
 */
export function verifyIdentityRegistrationFunding(
  prepared: PreparedIdentityRegistrationTransaction,
  candidateHex = prepared.txHex,
  expectedChangeAddress = prepared.changeAddress
): true {
  return guard(() => {
    const quote = prepared.quote;
    const systemID = prepared.snapshot.systemID;
    requireCondition(
      quote &&
        quote.systemID === systemID &&
        quote.issuerID &&
        prepared.changeAddress === expectedChangeAddress &&
        (prepared.stage === "commitment" || prepared.stage === "registration"),
      "Registration funding context changed."
    );
    [
      quote.commitmentFee,
      quote.registrationOffer,
      quote.nativeFee,
      quote.importFee,
      quote.transferFee,
    ].forEach(amount);
    const revealCosts = amountMap(quote.totalRequired);
    const operationCosts = amountMap(quote.totalOperationRequired);
    const combined = new Map(revealCosts);
    add(combined, new Map([[systemID, amount(quote.commitmentFee)]]));
    sameAmounts(
      combined,
      operationCosts,
      "Inconsistent two-stage registration costs."
    );
    const commitment = prepared.stage === "commitment";
    requireCondition(
      commitment ? !prepared.commitment : !!prepared.commitment,
      "Registration requires an independently approved commitment outpoint."
    );
    const expectedFee = commitment ? quote.commitmentFee : quote.nativeFee;
    requireCondition(
      amount(prepared.nativeFee).eq(amount(expectedFee)),
      "Transaction fee differs from the approved quote."
    );
    const expectedCosts = commitment
      ? amountMap({ [systemID]: quote.commitmentFee })
      : revealCosts;
    const approvedCosts = amountMap(prepared.approvedCosts);
    for (const [id, value] of commitment ? operationCosts : revealCosts) {
      requireCondition(
        value.lte(approvedCosts.get(id) || 0),
        "Registration exceeds approved costs."
      );
    }
    const descriptions: Description[] = commitment
      ? [{ role: "commitment" }]
      : [
          { role: "identity" },
          ...(quote.issuerPayment
            ? [
                {
                  role:
                    quote.issuerPayment.kind === "burn"
                      ? ("burn" as const)
                      : ("issuer-payment" as const),
                  payment: quote.issuerPayment,
                },
              ]
            : []),
          ...quote.referralPayments.map((payment) => ({
            role: "referral" as const,
            payment,
          })),
          { role: "reservation" },
        ];
    return verify(
      prepared,
      {
        snapshot: prepared.snapshot,
        nativeFee: expectedFee,
        changeAddress: expectedChangeAddress,
        commitment: prepared.commitment,
      },
      descriptions,
      candidateHex,
      quote,
      expectedCosts
    );
  });
}
