import BigNumber from "bignumber.js";
import {
  EVALS,
  SmartTransactionScript,
  ReserveTransfer,
  IdentityCommitmentScript,
  IdentityScript,
  IdentityReservationScript,
  DEST_ID,
  RESERVE_TRANSFER_VALID,
  RESERVE_TRANSFER_BURN_CHANGE_PRICE,
  RESERVE_TRANSFER_DESTINATION,
} from "verus-typescript-primitives";
import {
  amount,
  amountMap,
  nativeAmount,
  add,
  sameAmounts,
  validAddress,
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
  readFundingPrevouts,
  verifyFundingTransaction,
} from "./fundingVerification";
import { RegistrationError } from "./registrationPolicy";
import type {
  IdentityRegistrationQuote,
  RegistrationPayment,
} from "./registrationPolicy";
import type { PreparedIdentityRegistrationTransaction } from "./registration";
import type {
  FundedRegistration,
  RegistrationChainSnapshot,
  RegistrationFundingInput,
  RegistrationPlannedOutput,
} from "./registrationTransaction";

/**
 * Retain this approval independently from the transaction being checked.
 * Amounts are decimal strings in atomic units.
 */
export interface RegistrationFundingApproval {
  snapshot: RegistrationChainSnapshot;

  /** Exact miner fee, separate from any transfer fee embedded in a burn output. */
  nativeFee: string;
  changeAddress: string;

  /** Approved outputs before the selector appends change. */
  outputs: RegistrationPlannedOutput[];

  /** Only this exact name commitment may be spent as a special input. */
  commitment?: RegistrationFundingInput;
}

// Low-level callers supply exact approved output bytes. Registration callers
// instead derive payment descriptions from the retained quote and stage.
type RegistrationOutputApproval = {
  role: RegistrationPlannedOutput["role"];
  approved?: RegistrationPlannedOutput;
  payment?: RegistrationPayment;
};

/** Complete registration intent, separate from the retained transaction and prevouts. */
interface RegistrationApproval extends FundingApproval {
  expiryHeight: number;
  minerFee: string;
  outputs: RegistrationOutputApproval[];
  commitment?: FundingOutpoint;
  quote?: IdentityRegistrationQuote;
  expectedCosts?: Amounts;
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

/** Registration metadata outputs carry no spendable native or reserve balance. */
function metadataOutput(
  output: Output,
  role: RegistrationOutputApproval["role"],
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

/** Decode only the specific reserve-transfer burn used for registration payment. */
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

  // Both authorization layers must use the protocol's fixed burn destination.
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

  // Disallow other transfer flags, auxiliary destinations, and gateway fees.
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

  // The burned tokens and the embedded native transfer fee both consume input
  // funds. The miner fee is separate and is added by verify after output totals.
  return new Map([
    [systemID, nativeAmount(output.value)],
    [currencyID, amount(burned.toString(10))],
  ]);
}

function verify(
  funded: PreparedFundingTransaction,
  approval: RegistrationApproval,
  candidateHex: string
): true {
  const { systemID, outputs, quote, expectedCosts } = approval;
  validAddress(systemID, true);
  validAddress(approval.changeAddress);

  const candidate = verifyFundingTransaction(funded, candidateHex);
  // Registration additionally binds locktime and expiry to its chain snapshot.
  requireCondition(
    candidate.locktime === 0 &&
      candidate.expiryHeight === approval.expiryHeight,
    "Unsupported registration transaction."
  );

  // Registration rejects coinbase sources. Amounts come from raw prevouts,
  // never the selector's cached balances or output-plan metadata.
  const prevouts = readFundingPrevouts(candidate, funded.prevouts);
  const incoming: Amounts = new Map();
  let commitmentCount = 0;

  for (const { txid, vout, output } of prevouts) {
    // Only the approved commitment gets special decoding. All other inputs
    // must satisfy the ordinary funding rules, even if they are commitments.
    if (
      approval.commitment &&
      txid === approval.commitment.txid &&
      vout === approval.commitment.vout
    ) {
      commitmentCount++;
      add(incoming, commitmentInput(output, systemID));
    } else {
      add(incoming, ordinaryOutput(output, systemID));
    }
  }

  requireCondition(
    !approval.commitment || commitmentCount === 1,
    "Registration must spend its approved name commitment."
  );

  // Approved outputs retain their exact positions; only one trailing change
  // output may be appended, and its recipient is checked below.
  requireCondition(
    candidate.outs.length === outputs.length ||
      candidate.outs.length === outputs.length + 1,
    "Unexpected registration outputs."
  );

  const expectedFee = amount(approval.minerFee);
  const outgoing: Amounts = new Map();

  // Spending excludes returned change but includes the approved miner fee.
  // Outgoing starts with all output balances, including change.
  const spending: Amounts = new Map([[systemID, expectedFee]]);

  candidate.outs.forEach((output: Output, index: number) => {
    const outputApproval = outputs[index];
    let values: Amounts;
    if (!outputApproval) {
      values = ordinaryOutput(output, systemID, approval.changeAddress);
    } else {
      if (outputApproval.approved) {
        requireCondition(
          output.script.toString("hex") ===
            outputApproval.approved.scriptHex.toLowerCase() &&
            nativeAmount(output.value).eq(
              amount(outputApproval.approved.value)
            ),
          "Output differs from the approved payment."
        );
      }

      if (
        outputApproval.role === "issuer-payment" ||
        outputApproval.role === "referral"
      ) {
        const payment = outputApproval.payment;
        values = ordinaryOutput(output, systemID, payment?.recipient);
        if (payment) {
          sameAmounts(
            values,
            amountMap({ [payment.currencyID]: payment.amount }),
            "Payment differs from the approved amount or currency."
          );
        }
      } else if (outputApproval.role === "burn") {
        values = burnOutput(output, systemID, quote, outputApproval.payment);
      } else {
        values = metadataOutput(output, outputApproval.role, systemID);
      }

      add(spending, values);
    }

    add(outgoing, values);
  });

  if (expectedCosts) {
    sameAmounts(
      spending,
      expectedCosts,
      "Actual spending differs from the approved registration costs."
    );
  }

  // Include the miner fee so equality means inputs = outputs + approved fee.
  // Embedded transfer fees were already counted as part of the burn output.
  add(outgoing, new Map([[systemID, expectedFee]]));

  // Exact equality rejects excess native fees and implicit reserve burns,
  // including currencies unrelated to the registration quote.
  sameAmounts(
    incoming,
    outgoing,
    "Input funds do not exactly cover the approved payments, change, and fee."
  );
  return true;
}

/** Expose a consistent registration error while retaining the failed check's message. */
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

/**
 * Independently verify balances against explicit approved outputs and fees.
 * Also run automatically by fundRegistration before it returns a transaction.
 */
export function verifyRegistrationFunding(
  funded: FundedRegistration,
  approval: RegistrationFundingApproval,
  candidateHex = funded.txHex
): true {
  return guard(() =>
    verify(
      funded,
      {
        systemID: approval.snapshot.systemID,
        expiryHeight: approval.snapshot.expiryHeight,
        minerFee: approval.nativeFee,
        changeAddress: approval.changeAddress,
        commitment: approval.commitment,
        outputs: approval.outputs.map((output) => ({
          role: output.role,
          approved: output,
        })),
      },
      candidateHex
    )
  );
}

/**
 * Check all currencies, exact quoted fees/payments, and approved change directly
 * from transaction bytes and hash-verified source transactions. The prepared
 * approval must be retained independently from externally supplied candidates.
 * When supplied independently, expectedChangeAddress also binds the change
 * destination to the application's approval. This checks neither signatures
 * nor current chain/UTXO state and performs no RPC calls. Run it again before
 * each broadcast.
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

    // Full operation costs must equal reveal costs plus the commitment fee.
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

    // The commitment transaction spends only its own fee, but starting the
    // operation requires approval of both stages. Reveal approval covers only
    // the remaining registration costs.
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

    // Derive output roles and payments from the quote, not outputPlan metadata.
    // The retained unsigned transaction still binds every candidate script.
    const outputs: RegistrationOutputApproval[] = commitment
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
        systemID,
        expiryHeight: prepared.snapshot.expiryHeight,
        minerFee: expectedFee,
        changeAddress: expectedChangeAddress,
        commitment: prepared.commitment,
        outputs,
        quote,
        expectedCosts,
      },
      candidateHex
    );
  });
}
