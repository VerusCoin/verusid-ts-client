import BigNumber from "bignumber.js";
import { ECPair, networks } from "@bitgo/utxo-lib";
import { validateIdentityDefinition } from "./identityValidation";
import {
  EVALS,
  Identity,
  IdentityScript,
  SmartTransactionScript,
  ReserveTransfer,
} from "verus-typescript-primitives";
import {
  amount,
  amountMap,
  nativeAmount,
  add,
  sameAmounts,
  validAddress,
  transaction,
  parseScript,
  ordinaryOutput,
  requireCondition,
  Amounts,
  Output,
} from "./fundingPrimitives";
import {
  FundingApproval,
  FundingOutpoint,
  PreparedFundingTransaction,
  assertUnverifiedPrevoutsAllowed,
  readFundingPrevouts,
  verifyFundingTransaction,
  verifyTransparentTransaction,
} from "./fundingVerification";

export interface IdentityUpdateSigningInput {
  txid: string;
  outputIndex: number;
  script: string;
  satoshis: number;
  address?: string;
  rawTransaction?: string;
}

/** Construction request; the verified source transactions are supplied separately. */
export interface IdentityUpdateFundingRequest {
  txHex: string;
  unfundedTxHex: string;
  systemId: string;
  changeAddress: string;

  /** Total native fees, including fees embedded in explicit transfers. */
  nativeFee: string;
  fees: { [currency: string]: string };
  explicitFees: { [currency: string]: string };
  maxFee: string;

  identity: { txid: string; outputIndex: number; identityAddress: string };
}

/**
 * Public receipt retained independently from externally supplied bytes.
 * Its existing field names are preserved for stored approvals and SDK callers.
 * All fee amounts are decimal strings in atomic units.
 */
export interface IdentityUpdateFundingApproval
  extends IdentityUpdateFundingRequest {
  prevouts: Array<{
    txid: string;
    outputIndex: number;
    rawTransaction: string;
    address?: string;
  }>;
}

/** Complete update intent, separate from the retained transaction and prevouts. */
interface UpdateApproval extends FundingApproval {
  // The template already contains the exact approved outputs and header.
  // Keeping it avoids a second, potentially inconsistent output list.
  unfundedTxHex: string;
  totalNativeFee: string;
  fees: Record<string, string>;
  explicitFees: Record<string, string>;
  maxFee: string;
  identity: FundingOutpoint & { identityAddress: string };
}

/**
 * Convert a public coin-denominated cap to atomic units without accepting NaN,
 * infinity, fractions of a satoshi, or unsupported amounts.
 */
export function identityUpdateFeeCap(value: number): string {
  requireCondition(
    typeof value === "number" && Number.isFinite(value) && value >= 0,
    "Identity update fee cap must be finite and nonnegative."
  );

  const atomic = new BigNumber(value).times("100000000");
  requireCondition(
    atomic.isInteger() && atomic.lte("2100000000000000"),
    "Identity update fee cap must be an exact supported atomic amount."
  );

  return amount(atomic.toFixed(0)).toFixed(0);
}

/**
 * A bounded default allowance, not a fee quote. Explicit caller caps override it.
 *
 * Ten ordinary fees minimum; larger definitions scale by their daemon fee
 * factors, extra planned outputs and large scripts. Explicit native transfer
 * fees are additional approved costs. Change is still verified independently.
 */
export function defaultIdentityUpdateFeeCap(
  unfundedTxHex: string,
  explicitNativeFee = "0"
): number {
  const planned = transaction(unfundedTxHex);
  let identityUnits = 0;
  let largeScriptUnits = 0;

  for (const output of planned.outs as Output[]) {
    if (output.script.length > 1666) {
      largeScriptUnits += output.script.length > 3332 ? 2 : 1;
    }

    try {
      const id = parseScript(IdentityScript, output.script).getIdentity();

      // Measure serialized multimap content separately from the base identity.
      const withoutContent = new Identity();
      withoutContent.fromBuffer(id.toBuffer());
      withoutContent.clearContentMultiMap();
      const contentBytes = Math.max(
        0,
        id.toBuffer().length - withoutContent.toBuffer().length
      );
      identityUnits +=
        id.contentMap.size +
        Math.max(0, (id.primaryAddresses || []).length - 1) +
        Math.max(0, (id.privateAddresses || []).length - 1) +
        Math.ceil(contentBytes / 128);
    } catch (_) {
      // Explicit transfers and evidence are covered by output allowances.
    }
  }

  // fundrawtransaction may add one change output, so include that output in
  // the allowance even when the caller has supplied only a definition.
  const units = Math.max(
    10,
    Math.max(1, identityUnits) + planned.outs.length + largeScriptUnits
  );

  // Each unit is 10,000 atomic units; the ten-unit floor is 0.001 native coin.
  // Explicit native transfer fees are added before converting back to coins.
  const cap = amount(explicitNativeFee)
    .plus(new BigNumber(units).times(10000))
    .dividedBy("100000000")
    .toNumber();
  identityUpdateFeeCap(cap);
  return cap;
}

export function verifyIdentityDefinitionOutput(
  output: Output,
  expectedAddress: string,
  requireCanonicalAuthorization = false
): Amounts {
  // The identity authorizes the update but contributes no spendable balance.
  requireCondition(
    output && nativeAmount(output.value).isZero(),
    "Identity definition outputs carrying native value are unsupported."
  );

  const decoded = parseScript(IdentityScript, output.script).getIdentity();
  if (requireCanonicalAuthorization) validateIdentityDefinition(decoded);
  requireCondition(
    decoded.getIdentityAddress() === expectedAddress &&
      (!requireCanonicalAuthorization ||
        IdentityScript.fromIdentity(decoded).toBuffer().equals(output.script)),
    "Invalid identity definition authorization script."
  );

  return new Map();
}

function fundingOutput(
  output: Output,
  systemID: string,
  expectedAddress?: string
): Amounts {
  // Canonical P2PK outputs are common in mature mining rewards. Unlike ordinary
  // payments they are accepted only as inputs, with a valid public key.
  const bytes = output.script;
  if (
    ((bytes.length === 35 && bytes[0] === 33) ||
      (bytes.length === 67 && bytes[0] === 65)) &&
    bytes[bytes.length - 1] === 0xac
  ) {
    const key = ECPair.fromPublicKeyBuffer(
      bytes.subarray(1, bytes.length - 1),
      networks.verus
    );
    if (expectedAddress) {
      requireCondition(
        key.getAddress() === expectedAddress,
        "Funding output does not belong to its indexed address."
      );
    }

    return new Map([[systemID, nativeAmount(output.value)]]);
  }

  const values = ordinaryOutput(output, systemID);
  if (expectedAddress) {
    validAddress(expectedAddress);

    if (bytes.length === 25) {
      ordinaryOutput(output, systemID, expectedAddress);
    } else {
      const smart = parseScript(SmartTransactionScript, bytes);
      requireCondition(
        smart.paramsOptCC.destinations.some(
          (dest) => dest.toAddress() === expectedAddress
        ),
        "Funding output does not belong to its indexed address."
      );
    }
  }

  return values;
}

/** Decode a planned output's balances and any fees embedded in its transfer. */
function approvedOutput(
  output: Output,
  systemID: string,
  identityAddress: string
): { values: Amounts; fees: Amounts; identity: boolean; evidence?: boolean } {
  let smart: SmartTransactionScript | undefined;

  try {
    smart = parseScript(SmartTransactionScript, output.script);
  } catch (_) {
    // Ordinary P2PKH has no CC envelope.
  }

  const fees: Amounts = new Map();

  if (smart?.paramsOptCC.evalCode.eqn(EVALS.EVAL_IDENTITY_PRIMARY)) {
    return {
      values: verifyIdentityDefinitionOutput(output, identityAddress, true),
      fees,
      identity: true,
    };
  }

  if (smart?.paramsOptCC.evalCode.eqn(EVALS.EVAL_NOTARY_EVIDENCE)) {
    requireCondition(
      nativeAmount(output.value).isZero() &&
        smart.masterOptCC.version.eqn(3) &&
        smart.masterOptCC.evalCode.eqn(EVALS.EVAL_NONE) &&
        !smart.masterOptCC.vData.length &&
        smart.paramsOptCC.version.eqn(3),
      "Invalid or value-bearing identity evidence output."
    );
    return { values: new Map(), fees, identity: false, evidence: true };
  }

  if (smart?.paramsOptCC.evalCode.eqn(EVALS.EVAL_RESERVE_TRANSFER)) {
    const master = smart.masterOptCC;
    const condition = smart.paramsOptCC;
    requireCondition(
      master.version.eqn(3) &&
        master.evalCode.eqn(EVALS.EVAL_NONE) &&
        !master.vData.length &&
        condition.version.eqn(3) &&
        condition.vData.length === 1,
      "Unsupported explicit reserve-transfer envelope."
    );

    const transfer = new ReserveTransfer();
    const payload = condition.vData[0];
    requireCondition(
      transfer.fromBuffer(payload) === payload.length &&
        transfer.isValid() &&
        transfer.reserveValues.valueMap.size === 1 &&
        transfer.toBuffer().equals(payload),
      "Invalid explicit reserve-transfer encoding."
    );

    // Minted value is not paid by the inputs and cannot be accounted as a
    // normal identity transfer. Such a request needs a separate mint workflow.
    requireCondition(
      !transfer.isMint(),
      "Minting cannot be funded as an identity update."
    );

    const values: Amounts = new Map([[systemID, nativeAmount(output.value)]]);
    for (const [id, value] of transfer.reserveValues.valueMap) {
      validAddress(id, true);
      if (id !== systemID) values.set(id, amount(value.toString(10)));
    }

    const destination = transfer.transferDestination;
    requireCondition(
      destination.auxDests.every(
        (aux) => !aux.hasAuxDests() && (!aux.fees || aux.fees.isZero())
      ),
      "Reserve-transfer auxiliary fees cannot be funded as an identity update."
    );

    let transferFee = amount(transfer.feeAmount.toString(10));
    if (destination.isGateway() && destination.gatewayID != null) {
      validAddress(destination.gatewayID, true);
      transferFee = transferFee.plus(amount(destination.fees.toString(10)));
    }

    validAddress(transfer.feeCurrencyID, true);
    fees.set(transfer.feeCurrencyID, transferFee);

    // Native transfer fees are already in output.value. Reserve-denominated
    // fees must be added to the reserve amounts carried by the output.
    if (transfer.feeCurrencyID !== systemID) add(values, fees);

    return { values, fees, identity: false };
  }

  return { values: ordinaryOutput(output, systemID), fees, identity: false };
}

function verify(
  funded: PreparedFundingTransaction,
  approval: UpdateApproval,
  candidateHex: string,
  signingInputs?: IdentityUpdateSigningInput[],
  trustedInputs?: IdentityUpdateSigningInput[]
): true {
  validAddress(approval.systemID, true);
  validAddress(approval.changeAddress);
  validAddress(approval.identity.identityAddress, true);

  // The cap covers total native fees, including explicit transfer fees.
  const fees = amountMap(approval.fees, "Invalid fee amounts.");
  const explicitFees = amountMap(approval.explicitFees, "Invalid fee amounts.");
  const totalNativeFee = amount(approval.totalNativeFee);
  requireCondition(
    totalNativeFee.eq(fees.get(approval.systemID) || 0) &&
      totalNativeFee.lte(amount(approval.maxFee)),
    "Identity update fee exceeds its approval."
  );

  const candidate = verifyFundingTransaction(funded, candidateHex);
  const unfunded = transaction(approval.unfundedTxHex);
  verifyTransparentTransaction(unfunded);
  requireCondition(
    !unfunded.ins.length,
    "Identity funding approval must be unsigned."
  );
  requireCondition(
    candidate.ins.length > 1,
    "Missing or unexpected identity funding input."
  );

  if (signingInputs) {
    requireCondition(
      signingInputs.length === candidate.ins.length,
      "Signing inputs do not match the funding approval."
    );
  }

  // Updates support verified coinbase sources. The trusted metadata fallback
  // is supplied only by the internal fixture path, which returns no approval.
  const prevouts = readFundingPrevouts(candidate, funded.prevouts, {
    allowCoinbase: true,
    trustedPrevouts: trustedInputs?.map((input) => ({
      txid: input.txid,
      vout: input.outputIndex,
      value: input.satoshis,
      script: Buffer.from(input.script, "hex"),
    })),
  });
  const incoming: Amounts = new Map();
  let identityCount = 0;

  prevouts.forEach((prevout, index) => {
    const { txid, vout, output } = prevout;

    // The signer must use the same script and amount that were just verified.
    if (signingInputs) {
      const signing = signingInputs[index];
      requireCondition(
        signing.txid === txid &&
          signing.outputIndex === vout &&
          signing.satoshis === output.value &&
          signing.script === output.script.toString("hex"),
        "Signing input data differs from the verified prevout."
      );
    }

    if (txid === approval.identity.txid && vout === approval.identity.vout) {
      identityCount++;
      verifyIdentityDefinitionOutput(output, approval.identity.identityAddress);
    } else {
      add(incoming, fundingOutput(output, approval.systemID, prevout.address));
    }
  });

  requireCondition(
    identityCount === 1,
    "Identity update must spend exactly its approved identity definition."
  );

  // Preserve planned outputs in order, and evidence at its exact indexes so
  // local references and consecutive multipart chunks remain valid.
  const outgoing: Amounts = new Map();
  const actualExplicitFees: Amounts = new Map();
  let plannedIndex = 0;
  let identityOutputs = 0;
  const onlyApproved = candidate.clone();
  onlyApproved.ins = [];
  onlyApproved.outs = [];

  for (const [outputIndex, output] of (candidate.outs as Output[]).entries()) {
    const expected = unfunded.outs[plannedIndex];
    if (
      expected &&
      output.value === expected.value &&
      output.script.equals(expected.script)
    ) {
      const decoded = approvedOutput(
        output,
        approval.systemID,
        approval.identity.identityAddress
      );
      requireCondition(
        !decoded.evidence || outputIndex === plannedIndex,
        "Identity funding moved an evidence output."
      );

      plannedIndex++;
      onlyApproved.outs.push(output);
      if (decoded.identity) identityOutputs++;
      add(outgoing, decoded.values);
      add(actualExplicitFees, decoded.fees);
    } else {
      add(
        outgoing,
        ordinaryOutput(output, approval.systemID, approval.changeAddress)
      );
    }
  }

  // Removing funding inputs and change must recover the original template,
  // including its transaction header and exactly one identity output.
  requireCondition(
    identityOutputs === 1 &&
      plannedIndex === unfunded.outs.length &&
      onlyApproved.toHex() === unfunded.toHex(),
    "Identity funding changed its approved outputs or transaction header."
  );

  sameAmounts(
    actualExplicitFees,
    explicitFees,
    "Explicit transfer fees differ from the approval."
  );

  // Planned outputs already account for explicit transfer fees. Add only the
  // remaining miner fee; any residual fee in a reserve currency is rejected.
  for (const id of new Set([...fees.keys(), ...explicitFees.keys()])) {
    const residual = (fees.get(id) || new BigNumber(0)).minus(
      explicitFees.get(id) || 0
    );
    requireCondition(
      residual.gte(0) && (id === approval.systemID || residual.isZero()),
      "Unexpected identity funding fee currency."
    );
    add(outgoing, new Map([[id, residual]]));
  }

  // Every input currency must be preserved as payment, change, or approved fee.
  sameAmounts(
    incoming,
    outgoing,
    "Identity funding does not conserve the approved payments, change, and fees in every currency."
  );
  return true;
}

/** Normalize the existing public receipt once at the verification boundary. */
function verifyFundingApproval(
  receipt: IdentityUpdateFundingApproval,
  candidateHex: string,
  signingInputs?: IdentityUpdateSigningInput[],
  trustedInputs?: IdentityUpdateSigningInput[]
): true {
  requireCondition(
    receipt && typeof receipt === "object",
    "Missing identity update funding approval."
  );
  requireCondition(
    Array.isArray(receipt.prevouts),
    "Missing or unexpected identity funding input."
  );

  const funded: PreparedFundingTransaction = {
    txHex: receipt.txHex,
    prevouts: receipt.prevouts.map((prevout) => ({
      txid: prevout.txid,
      vout: prevout.outputIndex,
      rawTransaction: prevout.rawTransaction,
      address: prevout.address,
    })),
  };
  const approval: UpdateApproval = {
    systemID: receipt.systemId,
    changeAddress: receipt.changeAddress,
    unfundedTxHex: receipt.unfundedTxHex,
    totalNativeFee: receipt.nativeFee,
    fees: receipt.fees,
    explicitFees: receipt.explicitFees,
    maxFee: receipt.maxFee,
    identity: {
      txid: receipt.identity.txid,
      vout: receipt.identity.outputIndex,
      identityAddress: receipt.identity.identityAddress,
    },
  };

  return verify(funded, approval, candidateHex, signingInputs, trustedInputs);
}

/**
 * Verify local economic intent and currency conservation against retained
 * approval. This does not check signatures or current chain/UTXO state.
 */
export function verifyIdentityUpdateFunding(
  approval: IdentityUpdateFundingApproval,
  candidateHex = approval.txHex,
  signingInputs?: IdentityUpdateSigningInput[]
): true {
  return verifyFundingApproval(approval, candidateHex, signingInputs);
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/**
 * Internal construction boundary: verify before freezing the approval.
 * The NODE_ENV=test fixture opt-out never produces a portable approval.
 */
export function createIdentityUpdateFundingApproval(
  request: IdentityUpdateFundingRequest,
  inputs: IdentityUpdateSigningInput[],
  allowUnverifiedPrevouts: boolean
): IdentityUpdateFundingApproval | undefined {
  assertUnverifiedPrevoutsAllowed(allowUnverifiedPrevouts);

  const approval: IdentityUpdateFundingApproval = {
    ...request,
    prevouts: inputs.map((input) => ({
      txid: input.txid,
      outputIndex: input.outputIndex,
      rawTransaction: input.rawTransaction!,
      address: input.address,
    })),
  };

  verifyFundingApproval(
    approval,
    approval.txHex,
    inputs,
    allowUnverifiedPrevouts ? inputs : undefined
  );

  return allowUnverifiedPrevouts ? undefined : freeze(approval);
}
