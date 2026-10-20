import BN from "bn.js";
import { verifyIdentityRegistrationFunding } from "./registrationFundingVerification";
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
  /** All costs are atomic integer strings. */
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
  /** Serialized SHA256d hash byte order, not daemon displayed uint256 hex. */
  readonly commitmentHashHex: string;
  readonly controller: string;
  readonly authorizationID?: string;
}

export interface CreateNameReservationTransactionRequest
  extends ResolveIdentityRegistrationRequest {
  controller: string;
  /** Securely generated nonzero 32-byte salt in serialized/internal order. Never generated implicitly. */
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
  /** The exact change recipient and cost ceilings approved for this build. */
  changeAddress: string;
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

/** Signing always uses an independently retained prepared transaction as approval. */
export interface SignIdentityRegistrationTransactionArgs {
  transaction: PreparedIdentityRegistrationTransaction;
  /** Optional partially signed candidate; its unsigned bytes must match transaction. */
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
  /** Exact outpoint of the signed/broadcast commitment; never an unsigned transaction ID. */
  commitment: RegistrationFundingInput;
  identity: Identity | VerusCLIVerusIDJson;
  funding: RegistrationFundingInput[];
  changeAddress: string;
  /** Maximum reveal costs in each currency. A refreshed quote cannot exceed this approval. */
  approvedCosts: RegistrationAmounts;
  expiryDelta?: number;
  offer?: string;
}

// Wallet form state can change while RPC requests are pending. Capture the
// approved request before the first await so outputs, costs and recovery data
// all describe the same invocation.
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

function snapshotIdentityRegistrationRequest(
  request: CreateIdentityRegistrationTransactionRequest
): CreateIdentityRegistrationTransactionRequest {
  const reservation = { ...request.reservation };
  let identity: Identity | VerusCLIVerusIDJson;
  if (request.identity instanceof Identity) {
    // Serialization discards address types: an IdentityID primary key would
    // decode as a KeyID with the same hash. Validate before that information is lost.
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
    // This public branch accepts the daemon's JSON representation, including
    // nested content data. Round-trip it now, before callers can mutate it.
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
      // FLAG_LOCKED is 0x2. After unlocking, the absolute unlockAfter height is
      // still locked through that height; an elapsed timelock is spendable.
      if (
        !identity.flags.and(new BN(0x2)).isZero() ||
        identity.unlockAfter.gten(snapshot.candidateHeight)
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
  // Identity payments bind to whoever controls the identity when they are spent.
  // A commitment must not send its change to an identity that is not registered
  // yet, including the identity this operation will create in its second stage.
  await authoritiesFor(rpc, [changeAddress], snapshot);
}

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

/** Returned plans contain only JSON values, so freeze the entire approval receipt. */
function freezePrepared<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezePrepared);
    Object.freeze(value);
  }
  return value;
}

/** Economic validation must run before releasing a signature, including on external partials. */
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
  verifyIdentityRegistrationFunding(
    prepared,
    candidateHex,
    expectedChangeAddress
  );
  return true;
}

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
  // Verify that the selected wallet can cover both stages before it pays for a commitment.
  const available: RegistrationAmounts = {};
  for (const item of request.funding)
    addAmounts(
      available,
      (await readRegistrationPrevout(rpc, item, snapshot)).values
    );
  if (
    Object.keys(quote.totalOperationRequired).some((id) =>
      atomic(available[id] || "0").lt(atomic(quote.totalOperationRequired[id]))
    )
  ) {
    throw new RegistrationError(
      "INSUFFICIENT_FUNDS",
      "Approved funding must cover both the commitment and registration."
    );
  }
  const funded = await fundRegistration(
    rpc,
    snapshot,
    [
      {
        role: "commitment",
        scriptHex: script.toBuffer().toString("hex"),
        value: "0",
        values: { [snapshot.systemID]: "0" },
      },
    ],
    quote.commitmentFee,
    request.funding,
    request.changeAddress
  );
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
  // Bind the confirmed outpoint to its active block, not merely a cached height.
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
  const quote = quoteIdentityRegistration(policy, { offer: request.offer });
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
  const identityJson = identity.toJson(record.rootSystemName);
  for (const id of new Set([
    identityJson.revocationauthority!,
    identityJson.recoveryauthority!,
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
  const funded = await fundRegistration(
    rpc,
    snapshot,
    outputs,
    quote.nativeFee,
    request.funding,
    request.changeAddress,
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
