import BN from "bn.js";
import { verifyIdentityRegistrationFunding } from "./registrationFundingVerification";
import { isIdentityLockedAtHeight } from "./identityLocks";
import {
  dropEmptyIdentityContent,
  validateIdentitySize,
} from "./identityValidation";
import {
  AdvancedNameReservation,
  CurrencyDefinition,
  CurrencyValueMap,
  DEST_ID,
  EVALS,
  Identity,
  IdentityCommitmentScript,
  IdentityID,
  IdentityRegistrationNameRequest,
  IdentityReservationScript,
  IdentityScript,
  KeyID,
  OptCCParams,
  RESERVE_TRANSFER_BURN_CHANGE_PRICE,
  RESERVE_TRANSFER_DESTINATION,
  RESERVE_TRANSFER_VALID,
  ReserveTransfer,
  SmartTransactionScript,
  TransferDestination,
  TxDestination,
  VerusCLIVerusIDJson,
  currencyAmountToAtomic,
  identityFromJSONForRegistration,
  resolveIdentityRegistrationName,
  validateIdentityForRegistration,
} from "verus-typescript-primitives";
import { VerusdRpcInterface } from "verusd-rpc-ts-client";
import {
  IdentityRegistrationPolicy,
  IdentityRegistrationQuote,
  RegistrationError,
  quoteIdentityRegistration,
  registrationRpcResult,
  requireRegistrationIdentity,
  resolveIdentityRegistrationPolicy,
} from "./registrationPolicy";
import {
  RegistrationIdentityAuthority,
  RegistrationInputSignatureStatus,
  inspectIdentityRegistrationSignatures,
  validateRegistrationIdentityAuthorities,
} from "./registrationSigning";
import {
  FundedRegistration,
  RegistrationAmounts,
  RegistrationChainSnapshot,
  RegistrationFundingInput,
  RegistrationPlannedOutput,
  RegistrationPrevout,
  addAmounts,
  assertRegistrationSnapshot,
  atomic,
  destination,
  fundRegistration,
  parseTransaction,
  paymentOutput,
  readRegistrationPrevout,
  requireAmounts,
  validateRegistrationTransaction,
} from "./registrationTransaction";

export interface ResolveIdentityRegistrationRequest
  extends IdentityRegistrationNameRequest {
  referralID?: string;

  /** Defaults to the chain's block-time-derived expiry delta (20 through 60). */
  expiryDelta?: number;

  /** Commitment fee in atomic units, encoded as an integer string. */
  commitmentFee?: string;
  offer?: string;
}

export interface ResolvedIdentityRegistration {
  policy: IdentityRegistrationPolicy;
  quote: IdentityRegistrationQuote;
  snapshot: RegistrationChainSnapshot;
}

/** Private recovery data. Persist encrypted before publishing a commitment. */
export interface IdentityReservationRecord {
  readonly schemaVersion: 1;
  readonly kind: "advanced";
  readonly reservationHex: string;
  readonly identityAddress: string;
  readonly parentID: string;
  readonly systemID: string;
  readonly rootSystemName: string;
  readonly fullName: string;

  /** SHA256d commitment hash in serialized byte order. */
  readonly commitmentHashHex: string;
  readonly controller: string;
  readonly authorizationID?: string;
}

export interface CreateNameReservationTransactionRequest
  extends ResolveIdentityRegistrationRequest {
  controller: string;

  /** Caller-generated, secure, nonzero 32-byte salt in serialized byte order. */
  salt: Buffer;
  funding: RegistrationFundingInput[];
  changeAddress: string;

  /** Maximum costs for the entire two-transaction operation, per currency. */
  approvedCosts: RegistrationAmounts;
}

export interface PreparedIdentityRegistrationTransaction
  extends FundedRegistration {
  /** Alias matching the existing client's transaction builder results. */
  hex: string;
  stage: "commitment" | "registration";
  nativeFee: string;

  /** Exact change recipient approved for this build. */
  changeAddress: string;

  /** Approved cost ceilings per currency, in atomic units. */
  approvedCosts: RegistrationAmounts;
  snapshot: RegistrationChainSnapshot;

  /** Exact independently approved commitment outpoint, required for reveals. */
  commitment?: RegistrationFundingInput;
  quote: IdentityRegistrationQuote;
  identityAuthorities: RegistrationIdentityAuthority[];
  requiredSignatures: RegistrationInputSignatureStatus[];

  /** Commitments need these authorities when revealed, not when published. */
  revealAuthorities: RegistrationIdentityAuthority[];
  signingStatus: "unsigned";
}

/** Sign only against an independently retained transaction approval. */
export interface SignIdentityRegistrationTransactionArgs {
  transaction: PreparedIdentityRegistrationTransaction;

  /** Optional partial transaction whose unsigned bytes match the approved plan. */
  txHex?: string;
  keys?: string[][];
  partialTransactions?: string[];
}

export interface MergeIdentityRegistrationTransactionsArgs {
  transaction: PreparedIdentityRegistrationTransaction;
  txHex?: string;
  partialTransactions: string[];
}

export interface NameReservationTransactionResult {
  reservation: IdentityReservationRecord;
  transaction: PreparedIdentityRegistrationTransaction;
  commitmentVout: number;
}

export interface CreateIdentityRegistrationTransactionRequest {
  reservation: IdentityReservationRecord;

  /** Confirmed commitment outpoint, using its signed transaction ID. */
  commitment: RegistrationFundingInput;
  identity: Identity | VerusCLIVerusIDJson;
  funding: RegistrationFundingInput[];
  changeAddress: string;

  /** Maximum reveal costs per currency; refreshed quotes must fit these caps. */
  approvedCosts: RegistrationAmounts;
  expiryDelta?: number;

  /** Previously paid commitment fee, for the combined operation quote. */
  commitmentFee?: string;
  offer?: string;
}

/** Copy wallet inputs before RPC awaits so form edits cannot alter approval. */
function snapshotNameReservationRequest(
  request: CreateNameReservationTransactionRequest
): CreateNameReservationTransactionRequest {
  return {
    ...request,
    salt: Buffer.isBuffer(request.salt)
      ? Buffer.from(request.salt)
      : request.salt,
    funding: request.funding.map((input) => ({ ...input })),
    approvedCosts: { ...request.approvedCosts },
  };
}

/** Detach the reveal request while preserving and validating typed identity data. */
function snapshotIdentityRegistrationRequest(
  request: CreateIdentityRegistrationTransactionRequest
): CreateIdentityRegistrationTransactionRequest {
  const reservation = { ...request.reservation };
  let identity: Identity | VerusCLIVerusIDJson;

  if (request.identity instanceof Identity) {
    // Binary decoding turns primary addresses into KeyIDs. Validate their
    // original types first so an IdentityID cannot pass as a primary key.
    validateIdentityForRegistration(
      request.identity,
      resolveIdentityRegistrationName({
        name: reservation.fullName,
        parent: reservation.parentID,
        systemID: reservation.systemID,
        rootSystemName: reservation.rootSystemName,
      })
    );
    identity = new Identity();
    identity.fromBuffer(
      request.identity.toBuffer(),
      0,
      false,
      reservation.rootSystemName
    );
  } else {
    // Copy nested content as well as top-level fields in daemon JSON input.
    identity = JSON.parse(JSON.stringify(request.identity));
  }

  return {
    ...request,
    reservation,
    identity,
    commitment: { ...request.commitment },
    funding: request.funding.map((input) => ({ ...input })),
    approvedCosts: { ...request.approvedCosts },
  };
}

/** Bind registration policy and expiry to the selected chain's active tip. */
async function snapshotForRegistration(
  rpc: VerusdRpcInterface,
  request: Pick<
    ResolveIdentityRegistrationRequest,
    "systemID" | "rootSystemName" | "expiryDelta"
  >
): Promise<RegistrationChainSnapshot> {
  if (
    !destination(request.systemID).type.eq(TxDestination.TYPE_ID) ||
    !request.rootSystemName
  ) {
    throw new RegistrationError(
      "INVALID_CHAIN_CONTEXT",
      "An explicit registration system and global root name are required."
    );
  }

  const [infoResponse, nativeResponse, selectedResponse] = await Promise.all([
    rpc.getInfo(),
    rpc.getCurrency(request.systemID),
    rpc.chain === request.systemID
      ? Promise.resolve(undefined)
      : rpc.getCurrency(rpc.chain),
  ]);
  const info = registrationRpcResult<any>(infoResponse, "getinfo");
  const native = registrationRpcResult<CurrencyDefinition>(
    nativeResponse,
    "getcurrency"
  );
  const selected =
    selectedResponse == null
      ? native
      : registrationRpcResult<CurrencyDefinition>(
          selectedResponse,
          "getcurrency selected chain"
        );

  if (
    native.currencyid !== request.systemID ||
    native.systemid !== request.systemID ||
    selected.currencyid !== request.systemID ||
    (info.chainid != null && info.chainid !== request.systemID)
  ) {
    throw new RegistrationError(
      "WRONG_REGISTRATION_SYSTEM",
      "RPC endpoint does not match the selected registration system."
    );
  }

  if (
    !Number.isSafeInteger(info.blocks) ||
    info.blocks < 1 ||
    info.longestchain > info.blocks
  ) {
    throw new RegistrationError(
      "INVALID_CHAIN_CONTEXT",
      "RPC endpoint must have a synchronized active chain."
    );
  }

  // Target roughly twenty minutes, bounded to the supported block-count range.
  const blockTime = native.blocktime == null ? 60 : native.blocktime;
  if (!Number.isSafeInteger(blockTime) || blockTime < 1)
    throw new RegistrationError(
      "INVALID_CHAIN_CONTEXT",
      "Invalid native block time."
    );

  const delta =
    request.expiryDelta == null
      ? Math.max(20, Math.min(60, Math.floor(1200 / blockTime)))
      : request.expiryDelta;
  if (!Number.isSafeInteger(delta) || delta < 4 || delta > 60)
    throw new RegistrationError(
      "INVALID_EXPIRY",
      "Expiry delta must be between 4 and 60 blocks."
    );

  const block = registrationRpcResult<any>(
    await rpc.getBlock(String(info.blocks), 1),
    "getblock tip"
  );
  if (
    block.height !== info.blocks ||
    block.confirmations !== 1 ||
    !/^[0-9a-f]{64}$/.test(block.hash)
  ) {
    throw new RegistrationError(
      "INVALID_CHAIN_CONTEXT",
      "Tip block is not the active chain tip."
    );
  }

  const candidateHeight = info.blocks + 1;
  if (candidateHeight + delta >= 500000000)
    throw new RegistrationError(
      "INVALID_EXPIRY",
      "Registration expiry exceeds the protocol limit."
    );

  return {
    systemID: request.systemID,
    rootSystemName: request.rootSystemName,
    tipHeight: info.blocks,
    tipHash: block.hash,
    candidateHeight,
    expiryDelta: delta,
    expiryHeight: candidateHeight + delta,
  };
}

/**
 * Resolve the namespace policy and initial quote at a consistent chain tip.
 * Funding may raise relay fees; transaction builders enforce the caller's caps.
 */
export async function resolveIdentityRegistration(
  rpc: VerusdRpcInterface,
  request: ResolveIdentityRegistrationRequest
): Promise<ResolvedIdentityRegistration> {
  request = { ...request };
  const snapshot = await snapshotForRegistration(rpc, request);

  const policy = await resolveIdentityRegistrationPolicy(rpc, {
    ...request,
    candidateHeight: snapshot.candidateHeight,
  });
  constrainRegistrationExpiry(snapshot, policy);

  const quote = quoteIdentityRegistration(policy, request);
  await assertRegistrationSnapshot(rpc, snapshot);

  return { policy, quote, snapshot };
}

/** Keep expiry within the quoted issuer-payment policy's lifetime. */
function constrainRegistrationExpiry(
  snapshot: RegistrationChainSnapshot,
  policy: IdentityRegistrationPolicy
): void {
  const end = policy.parentDefinition.endblock;
  if (
    policy.branch === "token-payment" &&
    end &&
    snapshot.expiryHeight >= end
  ) {
    // RPC and consensus disagree at the boundary itself. Keep the whole
    // transaction lifetime on the quoted side of the issuer-payment branch.
    snapshot.expiryHeight = end - 1;
    if (snapshot.expiryHeight - snapshot.candidateHeight < 4) {
      throw new RegistrationError(
        "UNSUPPORTED_POLICY_BOUNDARY",
        "The namespace payment policy changes too soon to register with this quote."
      );
    }
  }
}

/** Check signing policies against raw outputs and the tip's unspent view. */
async function authoritiesFor(
  rpc: VerusdRpcInterface,
  addresses: string[],
  snapshot: RegistrationChainSnapshot
): Promise<RegistrationIdentityAuthority[]> {
  const ids = [...new Set(addresses)].filter((id) =>
    destination(id).type.eq(TxDestination.TYPE_ID)
  );
  const authorities = await Promise.all(
    ids.map(async (identityID) => {
      const response = await rpc.getIdentity(identityID);
      const result = registrationRpcResult<any>(
        response,
        "getidentity authorization"
      );
      const json = await requireRegistrationIdentity(
        { getIdentity: async () => response },
        identityID
      );

      if (
        !result ||
        !/^[0-9a-f]{64}$/.test(result.txid) ||
        !Number.isInteger(result.vout) ||
        result.vout < 0 ||
        result.vout > 0xffffffff ||
        !Number.isSafeInteger(result.blockheight) ||
        result.blockheight < 1 ||
        result.blockheight > snapshot.tipHeight
      ) {
        throw new RegistrationError(
          "INVALID_AUTHORITY_EVIDENCE",
          "Signing authority requires a confirmed defining outpoint."
        );
      }

      const [rawResponse, unspentResponse] = await Promise.all([
        rpc.getRawTransaction(result.txid, 0),
        rpc.getTxOut(result.txid, result.vout, true),
      ]);
      const raw = registrationRpcResult<any>(
        rawResponse,
        "getrawtransaction authorization"
      );
      const source = parseTransaction(typeof raw === "string" ? raw : raw?.hex);
      const output = source.outs[result.vout];
      if (source.getId() !== result.txid || !output) {
        throw new RegistrationError(
          "AUTHORITY_MISMATCH",
          "Signing authority outpoint does not match its raw transaction."
        );
      }

      // Check the RPC identity against its canonical on-chain definition before
      // using its primary keys or signature threshold to authorize spending.
      const script = new IdentityScript();
      script.fromBuffer(output.script, 0, output.script.length);
      const identity = script.getIdentity();
      const primaryAddresses = identity.primaryAddresses!.map(
        (key) => key.toAddress()!
      );
      if (
        !identity.version.eqn(3) ||
        identity.getIdentityAddress(snapshot.rootSystemName) !== identityID ||
        !identity.toBuffer().equals(script.paramsOptCC.vData[0]) ||
        identity.name !== json.name ||
        identity.parent.toAddress() !== json.parent ||
        identity.systemId.toAddress() !== json.systemid ||
        identity.flags.toNumber() !== json.flags ||
        identity.version.toNumber() !== json.version ||
        identity.unlockAfter.toNumber() !== (json.timelock || 0) ||
        identity.minSigs!.toNumber() !== json.minimumsignatures ||
        JSON.stringify(primaryAddresses) !==
          JSON.stringify(json.primaryaddresses) ||
        !IdentityScript.fromIdentity(identity).toBuffer().equals(output.script)
      ) {
        throw new RegistrationError(
          "AUTHORITY_MISMATCH",
          "Signing authority identity differs from its canonical defining output."
        );
      }

      // Both the defining transaction and the unspent response must describe
      // the same confirmed output at the snapshot's tip.
      const unspent = registrationRpcResult<any>(
        unspentResponse,
        "gettxout authorization"
      );
      if (!unspent)
        throw new RegistrationError(
          "AUTHORITY_CHANGED",
          "Signing authority was spent or changed; refresh registration."
        );

      if (unspent.bestblock !== snapshot.tipHash) {
        throw new RegistrationError(
          "STALE_CHAIN_CONTEXT",
          "Chain tip changed while resolving signing authority."
        );
      }

      if (
        !Number.isSafeInteger(unspent.confirmations) ||
        unspent.confirmations < 1 ||
        snapshot.candidateHeight - unspent.confirmations !==
          result.blockheight ||
        unspent.scriptPubKey?.hex !== output.script.toString("hex") ||
        !currencyAmountToAtomic(unspent.value).eq(new BN(output.value))
      ) {
        throw new RegistrationError(
          "AUTHORITY_MISMATCH",
          "Signing authority unspent state differs from its confirmed defining output."
        );
      }

      if (
        isIdentityLockedAtHeight(identity, {
          chainId: snapshot.systemID,
          nextBlockHeight: snapshot.candidateHeight,
        })
      ) {
        throw new RegistrationError(
          "LOCKED_AUTHORITY",
          "Registration signing authority is locked."
        );
      }

      return {
        identityID,
        primaryAddresses,
        minimumSignatures: identity.minSigs!.toNumber(),
        revoked: identity.isRevoked(),
      };
    })
  );

  validateRegistrationIdentityAuthorities(authorities);
  return authorities;
}

async function validateRegistrationChangeAddress(
  rpc: VerusdRpcInterface,
  changeAddress: string,
  snapshot: RegistrationChainSnapshot,
  createdIdentityID?: string
): Promise<void> {
  const change = destination(changeAddress);
  if (
    !change.type.eq(TxDestination.TYPE_ID) ||
    changeAddress === createdIdentityID
  ) {
    return;
  }

  // Identity change requires an existing spendable authority. The reveal may
  // instead pay the identity it creates atomically (handled by the return above).
  await authoritiesFor(rpc, [changeAddress], snapshot);
}

/** Daemon PBaaS relay minimum in atomic units for supported outputs. */
function registrationRelayFee(outputs: RegistrationPlannedOutput[]): BN {
  const definition = outputs.find((output) => output.role === "identity");
  let identityUnits = 0;

  if (definition) {
    const bytes = Buffer.from(definition.scriptHex, "hex");
    const script = new IdentityScript();
    script.fromBuffer(bytes, 0, bytes.length);
    const identity = script.getIdentity();
    const fullSize = identity.toBuffer().length;
    identity.clearContentMultiMap();

    // Count transaction-specific content in 128-byte units, then persistent
    // content entries and addresses beyond the first of each kind.
    identityUnits =
      Math.ceil((fullSize - identity.toBuffer().length) / 128) +
      identity.contentMap.size +
      Math.max(0, (identity.primaryAddresses || []).length - 1) +
      Math.max(0, (identity.privateAddresses || []).length - 1);
  }

  // These layouts fit GetMinRelayFeeByOutputs' output-count allowance.
  // Identity units replace the base fee and large-script surcharges when nonzero.
  let units = Math.max(1, identityUnits);
  if (!identityUnits) {
    for (const output of outputs) {
      const size = Buffer.from(output.scriptHex, "hex").length;
      if (size > 2000) units += size > 4000 ? 2 : 1;
    }
  }

  return new BN(units).muln(10000);
}

/** Update the quote for actual relay fees and enforce approved cost caps. */
async function fundQuotedRegistration(
  rpc: VerusdRpcInterface,
  resolved: ResolvedIdentityRegistration,
  stage: PreparedIdentityRegistrationTransaction["stage"],
  outputs: RegistrationPlannedOutput[],
  funding: RegistrationFundingInput[],
  changeAddress: string,
  approvedCosts: RegistrationAmounts,
  mandatory?: RegistrationPrevout
): Promise<FundedRegistration> {
  const quote = resolved.quote;
  const commitment = stage === "commitment";
  const feeField = commitment ? "commitmentFee" : "nativeFee";
  let requiredFee = registrationRelayFee(outputs);

  // Raising the fee can select another input and enlarge reserve change.
  // Repeat funding until the quote covers the final output plan's relay minimum.
  for (;;) {
    const fee = atomic(quote[feeField]);
    if (requiredFee.gt(fee)) {
      const increase = requiredFee.sub(fee);

      // Both stage fees affect the operation total. A reveal fee increase also
      // changes the amount required for the reveal itself.
      quote[feeField] = requiredFee.toString(10);
      quote.totalOperationRequired[quote.systemID] = atomic(
        quote.totalOperationRequired[quote.systemID]
      )
        .add(increase)
        .toString(10);

      if (!commitment) {
        quote.totalRequired[quote.systemID] = atomic(
          quote.totalRequired[quote.systemID]
        )
          .add(increase)
          .toString(10);
      }
    }

    const funded = await fundRegistration(
      rpc,
      resolved.snapshot,
      outputs,
      quote[feeField],
      funding,
      changeAddress,
      mandatory
    );
    requiredFee = registrationRelayFee(funded.outputPlan);
    if (requiredFee.gt(atomic(quote[feeField]))) continue;

    // Commitment approval covers both stages; reveal approval covers only the
    // remaining registration costs. Include the revised quote in the cap error.
    const requiredCosts = commitment
      ? quote.totalOperationRequired
      : quote.totalRequired;
    try {
      requireAmounts(requiredCosts, approvedCosts);
    } catch (error) {
      if (
        error instanceof RegistrationError &&
        error.code === "COST_LIMIT_EXCEEDED"
      ) {
        throw new RegistrationError(error.code, error.message, {
          quote,
          requiredCosts,
        });
      }

      throw error;
    }

    return funded;
  }
}

/** Attach verified authorities and freeze the unsigned plan for later signing. */
async function preparedTransaction(
  rpc: VerusdRpcInterface,
  funded: FundedRegistration,
  resolved: ResolvedIdentityRegistration,
  stage: PreparedIdentityRegistrationTransaction["stage"],
  nativeFee: string,
  revealAuthorities: RegistrationIdentityAuthority[],
  changeAddress: string,
  approvedCosts: RegistrationAmounts,
  commitment?: RegistrationFundingInput
): Promise<PreparedIdentityRegistrationTransaction> {
  // Key-hash inputs need no identity lookup. Resolve identity destinations from
  // the actual funding scripts, including the commitment input on a reveal.
  const signingIdentities: string[] = [];
  for (const prevout of funded.prevouts) {
    if (
      prevout.scriptHex.startsWith("76a914") &&
      prevout.scriptHex.length === 50
    )
      continue;
    const script = new SmartTransactionScript();
    script.fromBuffer(Buffer.from(prevout.scriptHex, "hex"));
    script.paramsOptCC.destinations.forEach((dest) => {
      if (dest.type.eq(TxDestination.TYPE_ID))
        signingIdentities.push(dest.toAddress());
    });
  }

  const identityAuthorities = await authoritiesFor(
    rpc,
    signingIdentities,
    resolved.snapshot
  );
  const signatureState = inspectIdentityRegistrationSignatures({
    ...funded,
    identityAuthorities,
  });

  const result: PreparedIdentityRegistrationTransaction = {
    ...funded,
    hex: funded.txHex,
    stage,
    nativeFee,
    changeAddress,
    approvedCosts: { ...approvedCosts },
    snapshot: resolved.snapshot,
    ...(commitment ? { commitment: { ...commitment } } : {}),
    quote: resolved.quote,
    identityAuthorities,
    revealAuthorities,
    requiredSignatures: signatureState.inputs,
    signingStatus: "unsigned",
  };

  validatePreparedIdentityRegistrationTransaction(result);
  await assertRegistrationSnapshot(rpc, resolved.snapshot);

  return freezePrepared(result);
}

/** Recursively freeze the JSON-only approval receipt, including nested arrays. */
function freezePrepared<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezePrepared);
    Object.freeze(value);
  }

  return value;
}

/**
 * Check a candidate against the retained quote, outputs and spending approval.
 * Run before signing or merging partials. This does not refresh chain state.
 */
export function validatePreparedIdentityRegistrationTransaction(
  prepared: PreparedIdentityRegistrationTransaction,
  candidateHex?: string,
  expectedChangeAddress?: string
): true {
  if (
    !prepared ||
    !prepared.approvedCosts ||
    typeof prepared.changeAddress !== "string"
  ) {
    throw new RegistrationError(
      "APPROVED_TRANSACTION_REQUIRED",
      "Retain and supply the original prepared registration transaction with its cost and change approvals."
    );
  }

  validateRegistrationTransaction(
    prepared,
    candidateHex == null ? prepared.txHex : candidateHex
  );

  const systemID = prepared.snapshot.systemID;
  const quote = prepared.quote;
  if (
    !quote ||
    quote.systemID !== systemID ||
    (prepared.stage !== "commitment" && prepared.stage !== "registration")
  ) {
    throw new RegistrationError(
      "INVALID_PLAN",
      "Registration quote does not match its approved transaction context."
    );
  }

  const commitment = prepared.stage === "commitment";
  const expectedFee = commitment ? quote.commitmentFee : quote.nativeFee;
  if (prepared.nativeFee !== expectedFee)
    throw new RegistrationError(
      "FEE_MISMATCH",
      "Transaction fee differs from the approved quote."
    );

  const expectedCosts = commitment
    ? { [systemID]: quote.commitmentFee }
    : quote.totalRequired;
  requireAmounts(
    commitment ? quote.totalOperationRequired : expectedCosts,
    prepared.approvedCosts
  );

  // Require the protocol output order, followed by at most one change output.
  const expectedRoles: RegistrationPlannedOutput["role"][] = commitment
    ? ["commitment"]
    : [
        "identity",
        ...(quote.issuerPayment
          ? [
              quote.issuerPayment.kind === "burn"
                ? ("burn" as const)
                : ("issuer-payment" as const),
            ]
          : []),
        ...quote.referralPayments.map(() => "referral" as const),
        "reservation",
      ];
  const outputs = prepared.outputPlan;
  const hasChange = outputs.length === expectedRoles.length + 1;
  if (hasChange) expectedRoles.push("change");
  if (
    outputs.length !== expectedRoles.length ||
    outputs.some((output, i) => output.role !== expectedRoles[i])
  ) {
    throw new RegistrationError(
      "OUTPUT_MISMATCH",
      "Registration output roles or ordering differ from the approved quote."
    );
  }

  // Change returns funds to the approved recipient; all other outputs and the
  // native fee must account for exactly the quoted spending in every currency.
  const costs: RegistrationAmounts = { [systemID]: prepared.nativeFee };
  outputs.forEach((output) => {
    if (output.role === "change") {
      if (
        output.scriptHex !==
        paymentOutput(prepared.changeAddress, output.values, systemID, "change")
          .scriptHex
      ) {
        throw new RegistrationError(
          "CHANGE_MISMATCH",
          "Change is not paid to the approved destination."
        );
      }
    } else {
      if (
        (output.role === "identity" ||
          output.role === "reservation" ||
          output.role === "commitment") &&
        output.value !== "0"
      ) {
        throw new RegistrationError(
          "OUTPUT_MISMATCH",
          "Registration metadata outputs must not absorb funds."
        );
      }
      addAmounts(costs, output.values);
    }
  });

  new Set([...Object.keys(costs), ...Object.keys(expectedCosts)]).forEach(
    (id) => {
      if (!atomic(costs[id] || "0").eq(atomic(expectedCosts[id] || "0"))) {
        throw new RegistrationError(
          "COST_MISMATCH",
          "Actual non-change spending differs from the approved quote for " +
            id +
            "."
        );
      }
    }
  );

  // Matching totals alone is insufficient: issuer and referral outputs must
  // also use the exact scripts and values derived from the quote.
  if (!commitment) {
    let i = 1;
    const payments: RegistrationPlannedOutput[] = [];
    if (quote.issuerPayment)
      payments.push(
        quote.issuerPayment.kind === "burn"
          ? burnOutput(quote)
          : paymentOutput(
              quote.issuerPayment.recipient,
              { [quote.issuerPayment.currencyID]: quote.issuerPayment.amount },
              systemID,
              "issuer-payment"
            )
      );
    quote.referralPayments.forEach((payment) =>
      payments.push(
        paymentOutput(
          payment.recipient,
          { [payment.currencyID]: payment.amount },
          systemID,
          "referral"
        )
      )
    );
    payments.forEach((payment) => {
      if (
        outputs[i].scriptHex !== payment.scriptHex ||
        outputs[i].value !== payment.value
      ) {
        throw new RegistrationError(
          "PAYMENT_MISMATCH",
          "Issuer or referral payment differs from the approved quote."
        );
      }
      i++;
    });
  }

  if (
    atomic(prepared.nativeFee).lt(registrationRelayFee(prepared.outputPlan))
  ) {
    throw new RegistrationError(
      "INSUFFICIENT_RELAY_FEE",
      "Registration fee is below the daemon relay minimum. Rebuild and review the transaction."
    );
  }

  verifyIdentityRegistrationFunding(
    prepared,
    candidateHex,
    expectedChangeAddress
  );

  return true;
}

/**
 * Build an unsigned commitment and its private reservation recovery record.
 * Persist the record securely before broadcasting; the reveal needs its salt.
 */
export async function createNameReservationTransaction(
  rpc: VerusdRpcInterface,
  request: CreateNameReservationTransactionRequest
): Promise<NameReservationTransactionResult> {
  request = snapshotNameReservationRequest(request);
  const controller = destination(request.controller);

  if (
    !Buffer.isBuffer(request.salt) ||
    request.salt.length !== 32 ||
    request.salt.equals(Buffer.alloc(32))
  ) {
    throw new RegistrationError(
      "INVALID_SALT",
      "Supply a securely generated nonzero 32-byte reservation salt."
    );
  }

  const salt = Buffer.from(request.salt);
  const resolved = await resolveIdentityRegistration(rpc, request);
  const { policy, quote, snapshot } = resolved;
  requireAmounts(quote.totalOperationRequired, request.approvedCosts);
  await validateRegistrationChangeAddress(rpc, request.changeAddress, snapshot);

  const revealAuthorities = await authoritiesFor(
    rpc,
    [
      request.controller,
      ...(policy.requiredAuthorityID ? [policy.requiredAuthorityID] : []),
    ],
    snapshot
  );

  const reservation = new AdvancedNameReservation({
    name: policy.resolvedName.name,
    parent: new IdentityID(
      destination(policy.resolvedName.parent).data.toBuffer()
    ),
    referral: request.referralID
      ? new IdentityID(destination(request.referralID).data.toBuffer())
      : undefined,
    salt,
  });
  reservation.validateForCreation();

  const commitment = reservation.getCommitment();
  const script = IdentityCommitmentScript.fromCommitment(
    commitment,
    controller,
    policy.requiredAuthorityID
      ? destination(policy.requiredAuthorityID)
      : undefined
  );

  const record: IdentityReservationRecord = Object.freeze({
    schemaVersion: 1,
    kind: "advanced",
    reservationHex: reservation.toBuffer().toString("hex"),
    identityAddress: reservation.getIdentityAddress(),
    parentID: policy.resolvedName.parent,
    systemID: snapshot.systemID,
    rootSystemName: snapshot.rootSystemName,
    fullName: policy.resolvedName.fullName,
    commitmentHashHex: commitment.toBuffer().toString("hex"),
    controller: request.controller,
    authorizationID: policy.requiredAuthorityID,
  });

  // Check the supplied prevouts against the current quote for both stages.
  const available: RegistrationAmounts = {};
  for (const item of request.funding)
    addAmounts(
      available,
      (await readRegistrationPrevout(rpc, item, snapshot)).values
    );

  const requireOperationFunds = () => {
    if (
      Object.keys(quote.totalOperationRequired).some((id) =>
        atomic(available[id] || "0").lt(
          atomic(quote.totalOperationRequired[id])
        )
      )
    ) {
      throw new RegistrationError(
        "INSUFFICIENT_FUNDS",
        "Approved funding must cover both the commitment and registration."
      );
    }
  };

  requireOperationFunds();
  const funded = await fundQuotedRegistration(
    rpc,
    resolved,
    "commitment",
    [
      {
        role: "commitment",
        scriptHex: script.toBuffer().toString("hex"),
        value: "0",
        values: { [snapshot.systemID]: "0" },
      },
    ],
    request.funding,
    request.changeAddress,
    request.approvedCosts
  );

  // Funding can raise the commitment fee, increasing the combined requirement.
  requireOperationFunds();

  return {
    reservation: record,
    transaction: await preparedTransaction(
      rpc,
      funded,
      resolved,
      "commitment",
      quote.commitmentFee,
      revealAuthorities,
      request.changeAddress,
      request.approvedCosts
    ),
    commitmentVout: 0,
  };
}

/** Match saved metadata to the canonical reservation and commitment hash. */
function restoreReservation(
  record: IdentityReservationRecord
): AdvancedNameReservation {
  if (!record || record.schemaVersion !== 1 || record.kind !== "advanced")
    throw new RegistrationError(
      "INVALID_RESERVATION",
      "Unsupported saved reservation schema."
    );

  const reservation = AdvancedNameReservation.fromHex(record.reservationHex);
  reservation.validateForCreation();

  if (
    reservation.toBuffer().toString("hex") !== record.reservationHex ||
    reservation.getIdentityAddress() !== record.identityAddress ||
    reservation.parent.toAddress() !== record.parentID ||
    reservation.getCommitment().toBuffer().toString("hex") !==
      record.commitmentHashHex
  ) {
    throw new RegistrationError(
      "RESERVATION_MISMATCH",
      "Saved reservation metadata differs from its canonical preimage."
    );
  }

  destination(record.controller);
  if (
    record.authorizationID &&
    !destination(record.authorizationID).type.eq(TxDestination.TYPE_ID)
  )
    throw new RegistrationError(
      "INVALID_RESERVATION",
      "Authorization must be an identity."
    );

  return reservation;
}

/** Encode an issuer burn payment with its native transfer fee. */
function burnOutput(
  quote: IdentityRegistrationQuote
): RegistrationPlannedOutput {
  const payment = quote.issuerPayment!;
  const transfer = new ReserveTransfer({
    version: new BN(1),
    flags: new BN(1).or(RESERVE_TRANSFER_BURN_CHANGE_PRICE),
    values: new CurrencyValueMap({
      valueMap: new Map([[payment.currencyID, atomic(payment.amount)]]),
    }),
    feeCurrencyID: quote.systemID,
    feeAmount: atomic(quote.transferFee),
    destCurrencyID: payment.currencyID,
    transferDestination: new TransferDestination({
      type: DEST_ID,
      destinationBytes: destination(payment.recipient).data.toBuffer(),
    }),
  });

  const dest = new TxDestination(
    new KeyID(RESERVE_TRANSFER_DESTINATION.destinationBytes)
  );
  const master = new OptCCParams({
    version: new BN(3),
    evalCode: new BN(EVALS.EVAL_NONE),
    m: new BN(1),
    n: new BN(1),
    destinations: [dest],
  });
  const condition = new OptCCParams({
    version: new BN(3),
    evalCode: new BN(EVALS.EVAL_RESERVE_TRANSFER),
    m: new BN(1),
    n: new BN(1),
    destinations: [dest],
    vData: [transfer.toBuffer()],
  });

  return {
    role: "burn",
    scriptHex: new SmartTransactionScript(master, condition)
      .toBuffer()
      .toString("hex"),
    value: quote.transferFee,
    values: {
      [quote.systemID]: quote.transferFee,
      [payment.currencyID]: payment.amount,
    },
  };
}

/**
 * Build an unsigned reveal spending the saved reservation's confirmed commitment.
 * Recheck the active-chain commitment, namespace policy and approved reveal costs.
 */
export async function createIdentityRegistrationTransaction(
  rpc: VerusdRpcInterface,
  request: CreateIdentityRegistrationTransactionRequest
): Promise<PreparedIdentityRegistrationTransaction> {
  request = snapshotIdentityRegistrationRequest(request);
  const record = request.reservation;
  const reservation = restoreReservation(record);
  const snapshot = await snapshotForRegistration(rpc, {
    ...record,
    expiryDelta: request.expiryDelta,
  });

  const commitment = await readRegistrationPrevout(
    rpc,
    request.commitment,
    snapshot,
    true
  );

  const expectedScript = IdentityCommitmentScript.fromCommitment(
    reservation.getCommitment(),
    destination(record.controller),
    record.authorizationID ? destination(record.authorizationID) : undefined
  )
    .toBuffer()
    .toString("hex");
  if (commitment.scriptHex !== expectedScript)
    throw new RegistrationError(
      "COMMITMENT_MISMATCH",
      "Commitment does not match the saved reservation and authorization conditions."
    );

  // Confirm the commitment is still in the active block reported for its UTXO.
  const block = registrationRpcResult<any>(
    await rpc.getBlock(String(commitment.height), 1),
    "getblock commitment"
  );
  if (
    block.height !== commitment.height ||
    block.confirmations !== commitment.confirmations ||
    !Array.isArray(block.tx) ||
    !block.tx.some(
      (tx: any) => (typeof tx === "string" ? tx : tx.txid) === commitment.txid
    )
  ) {
    throw new RegistrationError(
      "COMMITMENT_REORGED",
      "Commitment is not in the expected active-chain block."
    );
  }

  const referralID = reservation.referral.toBuffer().equals(Buffer.alloc(20))
    ? undefined
    : reservation.referral.toAddress()!;

  // Refresh policy at the reveal height while retaining the committed name
  // and authorization requirements.
  const policy = await resolveIdentityRegistrationPolicy(rpc, {
    name: record.fullName,
    parent: record.parentID,
    systemID: record.systemID,
    rootSystemName: record.rootSystemName,
    referralID,
    candidateHeight: snapshot.candidateHeight,
    commitmentHeight: commitment.height,
  });
  constrainRegistrationExpiry(snapshot, policy);
  if (
    policy.resolvedName.name !== reservation.name ||
    policy.resolvedName.identityID !== record.identityAddress ||
    policy.requiredAuthorityID !== record.authorizationID
  ) {
    throw new RegistrationError(
      "POLICY_CHANGED",
      "Resolved name or commitment authorization policy changed."
    );
  }

  const quote = quoteIdentityRegistration(policy, {
    offer: request.offer,
    commitmentFee: request.commitmentFee,
  });
  requireAmounts(quote.totalRequired, request.approvedCosts);

  const identity =
    request.identity instanceof Identity
      ? new Identity()
      : identityFromJSONForRegistration(request.identity, policy.resolvedName);
  if (request.identity instanceof Identity)
    identity.fromBuffer(
      request.identity.toBuffer(),
      0,
      false,
      record.rootSystemName
    );

  // Only prune the detached copy. A single zero-length byte value remains valid.
  dropEmptyIdentityContent(identity);
  validateIdentityForRegistration(identity, policy.resolvedName);
  validateIdentitySize(identity);

  // This output may pay the identity created atomically by this same reveal.
  await validateRegistrationChangeAddress(
    rpc,
    request.changeAddress,
    snapshot,
    record.identityAddress
  );

  for (const id of new Set([
    identity.revocationAuthority.toAddress()!,
    identity.recoveryAuthority.toAddress()!,
  ])) {
    if (id !== record.identityAddress)
      await requireRegistrationIdentity(rpc, id);
  }

  const revealAuthorities = await authoritiesFor(
    rpc,
    [
      record.controller,
      ...(record.authorizationID ? [record.authorizationID] : []),
    ],
    snapshot
  );

  // The reveal layout is identity, optional issuer payment, referrals, then
  // reservation. Funding appends change while preserving this order.
  const outputs: RegistrationPlannedOutput[] = [
    {
      role: "identity",
      scriptHex: IdentityScript.fromIdentity(identity)
        .toBuffer()
        .toString("hex"),
      value: "0",
      values: { [record.systemID]: "0" },
    },
  ];

  if (quote.issuerPayment) {
    outputs.push(
      quote.issuerPayment.kind === "burn"
        ? burnOutput(quote)
        : paymentOutput(
            quote.issuerPayment.recipient,
            { [quote.issuerPayment.currencyID]: quote.issuerPayment.amount },
            record.systemID,
            "issuer-payment"
          )
    );
  }
  quote.referralPayments.forEach((payment) =>
    outputs.push(
      paymentOutput(
        payment.recipient,
        { [payment.currencyID]: payment.amount },
        record.systemID,
        "referral"
      )
    )
  );

  outputs.push({
    role: "reservation",
    scriptHex: IdentityReservationScript.fromReservation(reservation)
      .toBuffer()
      .toString("hex"),
    value: "0",
    values: { [record.systemID]: "0" },
  });

  const funded = await fundQuotedRegistration(
    rpc,
    { policy, quote, snapshot },
    "registration",
    outputs,
    request.funding,
    request.changeAddress,
    request.approvedCosts,
    commitment
  );

  return preparedTransaction(
    rpc,
    funded,
    { policy, quote, snapshot },
    "registration",
    quote.nativeFee,
    revealAuthorities,
    request.changeAddress,
    request.approvedCosts,
    request.commitment
  );
}
