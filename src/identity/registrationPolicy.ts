import BN from "bn.js";
import { Transaction, networks } from "@bitgo/utxo-lib";
import {
  CurrencyDefinition,
  CurrencyIdentityRegistration,
  IdentityDefinition,
  IdentityRegistrationNameRequest,
  ResolvedIdentityRegistrationName,
  IdentityScript,
  IdentityReservationScript,
  SmartTransactionScript,
  TokenOutput,
  EVALS,
  I_ADDR_VERSION,
  decodeDestination,
  nameAndParentAddrToIAddr,
  resolveIdentityRegistrationName,
} from "verus-typescript-primitives";

export class RegistrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "RegistrationError";
    Object.setPrototypeOf(this, RegistrationError.prototype);
  }
}

/** The public RPC client satisfies this adapter; wallet signing RPCs are not used. */
export interface RegistrationPolicyRpc {
  getCurrency(id: string): Promise<unknown>;
  getIdentity(id: string, height?: number): Promise<unknown>;
  getIdentityHistory(
    id: string,
    start?: number,
    end?: number
  ): Promise<unknown>;
  getRawTransaction(txid: string, verbose?: number): Promise<unknown>;
  getBlock(hashOrHeight: string, verbosity?: number): Promise<unknown>;
}

export interface RegistrationPolicyRequest
  extends IdentityRegistrationNameRequest {
  candidateHeight: number;
  /** On reveal this is the verified active-chain commitment height. */
  commitmentHeight?: number;
  referralID?: string;
}

export type RegistrationPaymentBranch =
  | "native"
  | "token-payment"
  | "token-burn";
export interface RegistrationReferralEvidence {
  identityID: string;
  firstHeight: number;
  blockHash: string;
  txid: string;
  identityVout: number;
  reservationVout?: number;
}

export interface IdentityRegistrationPolicy {
  resolvedName: ResolvedIdentityRegistrationName;
  branch: RegistrationPaymentBranch;
  candidateHeight: number;
  commitmentHeight?: number;
  parentDefinition: CurrencyDefinition;
  nativeDefinition: CurrencyDefinition;
  issuerID: string;
  feePricingCurrencyID: string;
  referralID?: string;
  referralRecipients: string[];
  referralEvidence?: RegistrationReferralEvidence;
  requiredAuthorityID?: string;
  requiredAuthority?: IdentityDefinition;
}

export interface RegistrationPayment {
  currencyID: string;
  recipient: string;
  amount: string;
}

export interface IdentityRegistrationQuote {
  branch: RegistrationPaymentBranch;
  systemID: string;
  parentID: string;
  issuerID: string;
  feePricingCurrencyID: string;
  candidateHeight: number;
  commitmentFee: string;
  registrationOffer: string;
  /** Actual reveal transaction native fee, excluding transfer output value. */
  nativeFee: string;
  importFee: string;
  /** Native value in the burn transfer output; not a second transaction fee. */
  transferFee: string;
  issuerPayment?: RegistrationPayment & { kind: "payment" | "burn" };
  referralPayments: RegistrationPayment[];
  /** Reveal requirement before crediting existing commitment/funding input values. */
  totalRequired: Record<string, string>;
  /** Commitment fee plus reveal requirement, before input-value credits. */
  totalOperationRequired: Record<string, string>;
}

const MAX_AMOUNT = new BN("9223372036854775807");
/** Current GetTransactionTransferFee() in crosschainrpc.h. */
export const REGISTRATION_TRANSFER_FEE = "20000";
export const DEFAULT_COMMITMENT_FEE = "10000";

function fail(code: string, message: string, details?: unknown): never {
  throw new RegistrationError(code, message, details);
}

function record(value: unknown, context: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_RPC_RESPONSE", `${context} returned an invalid object`);
  }
  return value as Record<string, any>;
}

/** Preserve daemon errors; an absent/malformed response is never availability. */
export function registrationRpcResult<T>(
  response: unknown,
  context: string
): T {
  const envelope = record(response, context);
  if (envelope.error != null) {
    const error = record(envelope.error, context);
    fail(
      "RPC_ERROR",
      `${context}: ${String(error.message || "RPC request failed")}`,
      error
    );
  }
  if (!Object.prototype.hasOwnProperty.call(envelope, "result")) {
    fail("INVALID_RPC_RESPONSE", `${context} omitted its result`);
  }
  return envelope.result as T;
}

function identityAddress(address: string, label: string): void {
  try {
    if (decodeDestination(address, I_ADDR_VERSION).equals(Buffer.alloc(20)))
      throw new Error("null");
  } catch (_) {
    fail(
      "INVALID_IDENTITY_ADDRESS",
      `${label} must be a nonnull identity i-address`
    );
  }
}

function height(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    fail("INVALID_HEIGHT", `${label} must be a positive integer`);
}

function hash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
    fail("INVALID_RPC_RESPONSE", `${label} must be a 32-byte hexadecimal hash`);
  }
}

function derivedNameID(name: string, parent?: string): string {
  if (
    parent &&
    decodeDestination(parent, I_ADDR_VERSION).equals(Buffer.alloc(20))
  )
    parent = undefined;
  return nameAndParentAddrToIAddr(name, parent || undefined);
}

function boundIdentity(
  value: unknown,
  id: string,
  label: string,
  unrevoked: boolean
): IdentityDefinition {
  const identity = record(value, label) as IdentityDefinition;
  if (
    typeof identity.name !== "string" ||
    typeof identity.parent !== "string" ||
    derivedNameID(identity.name, identity.parent) !== id ||
    (identity.identityaddress != null && identity.identityaddress !== id)
  ) {
    fail(
      "LOOKUP_MISMATCH",
      `${label} identity does not match the requested address`
    );
  }
  if (!Number.isSafeInteger(identity.flags) || identity.flags! < 0) {
    fail("INVALID_RPC_RESPONSE", `${label} omitted valid identity flags`);
  }
  if (unrevoked && (identity.flags! & 0x8000) !== 0)
    fail("REVOKED_IDENTITY", `${label} is revoked`);
  return identity;
}

export async function requireRegistrationIdentity(
  rpc: Pick<RegistrationPolicyRpc, "getIdentity">,
  id: string,
  atHeight?: number
): Promise<IdentityDefinition> {
  identityAddress(id, "Identity");
  const result = record(
    registrationRpcResult(await rpc.getIdentity(id, atHeight), "getidentity"),
    "getidentity"
  );
  return boundIdentity(result.identity, id, "getidentity", true);
}

export async function assertIdentityRegistrationAvailable(
  rpc: Pick<RegistrationPolicyRpc, "getIdentity">,
  id: string
): Promise<void> {
  identityAddress(id, "Identity");
  const response = record(await rpc.getIdentity(id), "getidentity");
  // This exact daemon error is the only absence signal. Transport and index
  // errors, malformed success, and revoked identities must stop construction.
  if (
    response.error &&
    response.error.code === -5 &&
    response.error.message === "Identity not found"
  )
    return;
  const result = record(
    registrationRpcResult(response, "getidentity"),
    "getidentity"
  );
  boundIdentity(result.identity, id, "getidentity", false);
  fail("IDENTITY_EXISTS", "The requested identity is already registered");
}

function boundCurrency(value: unknown, id: string): CurrencyDefinition {
  const definition = record(value, "getcurrency") as CurrencyDefinition;
  if (definition.currencyid !== id)
    fail(
      "LOOKUP_MISMATCH",
      "Currency definition does not match the requested namespace"
    );
  if (
    typeof definition.name !== "string" ||
    derivedNameID(definition.name, definition.parent) !== id
  ) {
    fail(
      "LOOKUP_MISMATCH",
      "Currency name and parent do not derive its requested address"
    );
  }
  identityAddress(definition.systemid, "Currency system");
  if (
    !Number.isInteger(definition.version) ||
    definition.version < 1 ||
    !Number.isInteger(definition.proofprotocol) ||
    definition.proofprotocol < 1 ||
    !Number.isSafeInteger(definition.endblock) ||
    definition.endblock < 0 ||
    !Number.isSafeInteger(definition.startblock) ||
    definition.startblock < 0
  ) {
    fail(
      "INVALID_RPC_RESPONSE",
      "Currency definition omitted valid version, proof protocol or block boundaries"
    );
  }
  try {
    CurrencyIdentityRegistration.fromJSON(definition);
  } catch (error) {
    fail(
      "INVALID_CURRENCY_POLICY",
      `Invalid currency identity policy: ${(error as Error).message}`
    );
  }
  return definition;
}

function readSmart(script: Buffer): SmartTransactionScript | undefined {
  try {
    const parsed = new SmartTransactionScript();
    parsed.fromBuffer(script);
    return parsed.paramsOptCC.isValid() ? parsed : undefined;
  } catch (_) {
    return undefined;
  }
}

async function referralHistory(
  rpc: RegistrationPolicyRpc,
  policy: IdentityRegistrationPolicy,
  beforeHeight: number
): Promise<{ recipients: string[]; evidence: RegistrationReferralEvidence }> {
  const id = policy.referralID!;
  const historyResponse = record(
    registrationRpcResult(
      await rpc.getIdentityHistory(id, 0, beforeHeight - 1),
      "getidentityhistory"
    ),
    "getidentityhistory"
  );
  if (
    !Array.isArray(historyResponse.history) ||
    !historyResponse.history.length
  ) {
    fail(
      "REFERRAL_HISTORY_UNAVAILABLE",
      "Referrer original registration history is required"
    );
  }
  const history = historyResponse.history
    .map((entry: unknown) => {
      const item = record(entry, "getidentityhistory entry");
      height(item.height, "Referral history height");
      if (item.height >= beforeHeight)
        fail(
          "REFERRAL_TOO_NEW",
          "Referrer must first register before the commitment block"
        );
      boundIdentity(item.identity, id, "Referral history", false);
      return item;
    })
    .sort(
      (a: any, b: any) =>
        a.height - b.height || a.output?.voutnum - b.output?.voutnum
    );

  // The earliest entry must be a verifiable creation, not an update returned
  // by a pruned index. Import-only histories need separate protocol handling.
  const first = history[0];
  const output = record(first.output, "Referral history output");
  hash(output.txid, "Referral transaction ID");
  hash(first.blockhash, "Referral block hash");
  if (!Number.isSafeInteger(output.voutnum) || output.voutnum < 0)
    fail("INVALID_RPC_RESPONSE", "Invalid referral identity output index");
  const responses = await Promise.all([
    rpc.getRawTransaction(output.txid, 0),
    rpc.getBlock(first.blockhash, 1),
  ]);
  const raw = registrationRpcResult<unknown>(responses[0], "getrawtransaction");
  if (typeof raw !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(raw))
    fail(
      "INVALID_RPC_RESPONSE",
      "Referral raw transaction must be hexadecimal bytes"
    );
  let tx: any;
  try {
    tx = Transaction.fromHex(raw, networks.verus);
  } catch (_) {
    fail(
      "INVALID_REFERRAL_HISTORY",
      "Cannot decode the original referral transaction"
    );
  }
  if (tx.getId() !== output.txid || output.voutnum >= tx.outs.length) {
    fail(
      "LOOKUP_MISMATCH",
      "Referrer raw transaction does not match its history outpoint"
    );
  }
  const block = record(
    registrationRpcResult(responses[1], "getblock"),
    "getblock"
  );
  if (
    block.hash !== first.blockhash ||
    block.height !== first.height ||
    !Number.isInteger(block.confirmations) ||
    block.confirmations < 1 ||
    !Array.isArray(block.tx) ||
    !block.tx.some(
      (entry: unknown) =>
        (typeof entry === "string" ? entry : (entry as any)?.txid) ===
        output.txid
    )
  ) {
    fail(
      "REFERRAL_NOT_CONFIRMED",
      "Referrer creation must belong to the reported active-chain block"
    );
  }
  let original: any;
  try {
    const identityScript = new IdentityScript();
    identityScript.fromBuffer(tx.outs[output.voutnum].script);
    original = identityScript.getIdentity();
  } catch (_) {
    fail(
      "INVALID_REFERRAL_HISTORY",
      "Referrer history does not point to an identity output"
    );
  }
  if (
    original.getIdentityAddress() !== id ||
    original.systemId.toAddress() !== policy.resolvedName.systemID ||
    (original.parent.toAddress() !== policy.resolvedName.parent &&
      id !== policy.resolvedName.parent)
  ) {
    fail(
      "LOOKUP_MISMATCH",
      "Original referrer identity has the wrong address, parent, or system"
    );
  }
  const evidence: RegistrationReferralEvidence = {
    identityID: id,
    firstHeight: first.height,
    blockHash: first.blockhash,
    txid: output.txid,
    identityVout: output.voutnum,
  };
  // LookupFirstIdentity's block-one exception is for PBaaS chains only. Avoid
  // interpreting imported/root definitions as ordinary paid registrations.
  if (
    first.height === 1 &&
    policy.nativeDefinition.parent &&
    !decodeDestination(policy.nativeDefinition.parent, I_ADDR_VERSION).equals(
      Buffer.alloc(20)
    )
  ) {
    return { recipients: [id], evidence };
  }

  const sourceReferrals: string[] = [];
  let afterPayment = policy.branch === "native";
  let foundReservation = false;
  for (let index = output.voutnum + 1; index < tx.outs.length; index++) {
    const parsed = readSmart(tx.outs[index].script);
    if (!parsed)
      fail(
        "INVALID_REFERRAL_HISTORY",
        "Unexpected output inside original referral registration"
      );
    const params = parsed.paramsOptCC;
    const evalCode = params.evalCode.toNumber();
    if (
      evalCode === EVALS.EVAL_IDENTITY_RESERVATION ||
      evalCode === EVALS.EVAL_IDENTITY_ADVANCEDRESERVATION
    ) {
      try {
        const reservation = new IdentityReservationScript();
        reservation.fromBuffer(tx.outs[index].script);
        if (
          reservation.getIdentityAddress(
            original.parent.toAddress(),
            policy.resolvedName.rootSystemName
          ) !== id
        )
          throw new Error("wrong identity");
        if (reservation.getReservation().name !== original.name)
          throw new Error("wrong name");
      } catch (_) {
        fail(
          "INVALID_REFERRAL_HISTORY",
          "Original referral reservation does not match its identity"
        );
      }
      evidence.reservationVout = index;
      foundReservation = true;
      break;
    }
    if (!afterPayment) {
      const expected =
        policy.branch === "token-payment"
          ? EVALS.EVAL_RESERVE_OUTPUT
          : EVALS.EVAL_RESERVE_TRANSFER;
      if (evalCode !== expected)
        fail(
          "UNSUPPORTED_REFERRAL_HISTORY",
          "Original referral payment branch differs from the current namespace"
        );
      afterPayment = true;
      continue;
    }
    if (
      evalCode !==
        (policy.branch === "native"
          ? EVALS.EVAL_NONE
          : EVALS.EVAL_RESERVE_OUTPUT) ||
      params.destinations.length !== 1 ||
      !params.destinations[0].type.eqn(4) ||
      !params.m.eqn(1) ||
      !params.n.eqn(1)
    ) {
      fail(
        "INVALID_REFERRAL_HISTORY",
        "Original referral payments must be ordered identity outputs"
      );
    }
    if (policy.branch !== "native") {
      try {
        const token = new TokenOutput();
        const data = params.getParamObject()!;
        if (
          token.fromBuffer(data) !== data.length ||
          !token.isValid() ||
          token.reserveValues.valueMap.size !== 1 ||
          token.firstCurrency() !== policy.issuerID
        )
          throw new Error("wrong currency");
      } catch (_) {
        fail(
          "INVALID_REFERRAL_HISTORY",
          "Original referral payment has the wrong reserve currency"
        );
      }
    }
    sourceReferrals.push(params.destinations[0].toAddress());
  }
  if (!foundReservation)
    fail(
      "REFERRAL_HISTORY_UNAVAILABLE",
      "Referrer history does not include its original reservation transaction"
    );
  const levels = CurrencyIdentityRegistration.fromJSON(
    policy.parentDefinition
  ).getIDReferralLevels();
  // These edge branches differ between the RPC and activated consensus traversal.
  if (
    (levels === 1 || id === policy.resolvedName.parent) &&
    sourceReferrals.length
  ) {
    fail(
      "UNSUPPORTED_REFERRAL_HISTORY",
      "This referral ancestry requires an unsupported activation-dependent traversal"
    );
  }
  return {
    recipients: [id, ...sourceReferrals.slice(0, levels - 1)],
    evidence,
  };
}

/** Resolve current PBaaS-era native and plain-token namespace policy. */
export async function resolveIdentityRegistrationPolicy(
  rpc: RegistrationPolicyRpc,
  request: RegistrationPolicyRequest
): Promise<IdentityRegistrationPolicy> {
  height(request.candidateHeight, "Candidate height");
  if (request.commitmentHeight != null) {
    height(request.commitmentHeight, "Commitment height");
    if (request.commitmentHeight >= request.candidateHeight)
      fail("COMMITMENT_NOT_CONFIRMED", "Commitment must be in a prior block");
  }
  const resolvedName = resolveIdentityRegistrationName(request);
  const [parentResponse, nativeResponse] = await Promise.all([
    rpc.getCurrency(resolvedName.parent),
    rpc.getCurrency(request.systemID),
  ]);
  const parentDefinition = boundCurrency(
    registrationRpcResult(parentResponse, "getcurrency parent"),
    resolvedName.parent
  );
  const nativeDefinition = boundCurrency(
    registrationRpcResult(nativeResponse, "getcurrency native"),
    request.systemID
  );
  if (nativeDefinition.systemid !== request.systemID)
    fail(
      "LOOKUP_MISMATCH",
      "Selected native currency belongs to another system"
    );
  const parent = CurrencyIdentityRegistration.fromJSON(parentDefinition);
  if (parent.noIDs())
    fail(
      "NAMESPACE_DISALLOWS_IDENTITIES",
      "The selected currency does not permit identities"
    );
  if (
    parent.isFractional() ||
    parent.isGateway() ||
    parent.isGatewayConverter() ||
    parentDefinition.gatewayconverterid
  ) {
    fail(
      "UNSUPPORTED_NAMESPACE",
      "Fractional and gateway identity pricing is not supported"
    );
  }
  if (parentDefinition.systemid !== request.systemID)
    fail(
      "WRONG_REGISTRATION_SYSTEM",
      "The selected namespace registers identities on another system"
    );
  const native = resolvedName.parent === request.systemID;
  if (!native && !parent.isToken())
    fail(
      "UNSUPPORTED_NAMESPACE",
      "Only native and plain token namespaces are supported"
    );
  if (
    parentDefinition.proofprotocol !== 1 &&
    parentDefinition.proofprotocol !== 2
  ) {
    fail(
      "UNSUPPORTED_NAMESPACE",
      "This currency proof protocol does not support the implemented identity payment branches"
    );
  }
  // RPC uses tip height and consensus uses candidate height around endBlock.
  if (
    parentDefinition.endblock &&
    request.candidateHeight === parentDefinition.endblock
  ) {
    fail(
      "UNSUPPORTED_POLICY_BOUNDARY",
      "Registration at the currency end-block boundary requires a refreshed quote"
    );
  }
  const chainIDPayment =
    parentDefinition.proofprotocol === 2 &&
    (!parentDefinition.endblock ||
      request.candidateHeight < parentDefinition.endblock);
  if (native && chainIDPayment)
    fail(
      "UNSUPPORTED_NAMESPACE",
      "Native PROOF_CHAINID registration accounting is not supported"
    );
  const policy: IdentityRegistrationPolicy = {
    resolvedName,
    branch: native ? "native" : chainIDPayment ? "token-payment" : "token-burn",
    candidateHeight: request.candidateHeight,
    commitmentHeight: request.commitmentHeight,
    parentDefinition,
    nativeDefinition,
    issuerID: resolvedName.parent,
    feePricingCurrencyID: resolvedName.parent,
    referralID: request.referralID,
    referralRecipients: [],
  };
  if (
    parent.IDReferralRequired() &&
    !parent.IDRequiresPermission() &&
    !request.referralID
  ) {
    fail(
      "REFERRAL_REQUIRED",
      "This namespace requires a referring identity signature"
    );
  }
  if (request.referralID) {
    identityAddress(request.referralID, "Referrer");
    const beforeHeight = request.commitmentHeight || request.candidateHeight;
    if (beforeHeight < 2)
      fail(
        "REFERRAL_TOO_NEW",
        "A referrer must exist in a block before the commitment"
      );
    const identity = await requireRegistrationIdentity(
      rpc,
      request.referralID,
      request.commitmentHeight ? beforeHeight - 1 : undefined
    );
    if (
      (identity.parent !== resolvedName.parent &&
        request.referralID !== resolvedName.parent) ||
      identity.systemid !== request.systemID
    ) {
      fail(
        "INVALID_REFERRAL",
        "Referrer must belong to the registration system and namespace"
      );
    }
    if (parent.getIDReferralLevels()) {
      if (!parent.IDReferrals())
        fail(
          "UNSUPPORTED_REFERRAL_POLICY",
          "Referral-required namespaces with nonzero levels but no economic referrals are unsupported"
        );
      const evidence = await referralHistory(rpc, policy, beforeHeight);
      policy.referralRecipients = evidence.recipients;
      policy.referralEvidence = evidence.evidence;
    }
  }
  policy.requiredAuthorityID = parent.IDRequiresPermission()
    ? resolvedName.parent
    : parent.IDReferralRequired()
    ? request.referralID
    : undefined;
  if (policy.requiredAuthorityID) {
    policy.requiredAuthority = await requireRegistrationIdentity(
      rpc,
      policy.requiredAuthorityID
    );
    if (policy.requiredAuthority.systemid !== request.systemID)
      fail(
        "WRONG_REGISTRATION_SYSTEM",
        "Required signing authority belongs to another system"
      );
  }
  await assertIdentityRegistrationAvailable(rpc, resolvedName.identityID);
  return policy;
}

function atomic(value: string, label: string): BN {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value))
    fail(
      "INVALID_AMOUNT",
      `${label} must be a nonnegative atomic integer string`
    );
  const amount = new BN(value);
  if (amount.gt(MAX_AMOUNT))
    fail("INVALID_AMOUNT", `${label} exceeds signed 64-bit range`);
  return amount;
}

/** Amounts remain integer strings across persistence/UI boundaries. */
export function quoteIdentityRegistration(
  policy: IdentityRegistrationPolicy,
  options: { commitmentFee?: string; offer?: string } = {}
): IdentityRegistrationQuote {
  const parent = CurrencyIdentityRegistration.fromJSON(policy.parentDefinition);
  const native = CurrencyIdentityRegistration.fromJSON(policy.nativeDefinition);
  const commitmentFee = atomic(
    options.commitmentFee == null
      ? DEFAULT_COMMITMENT_FEE
      : options.commitmentFee,
    "Commitment fee"
  );
  const economicReferral =
    !!policy.referralID && parent.getIDReferralLevels() > 0;
  if (economicReferral && !policy.referralRecipients.length)
    fail(
      "REFERRAL_HISTORY_UNAVAILABLE",
      "Cannot quote referral discounts without ordered history"
    );
  const minimum = economicReferral
    ? parent.IDReferredRegistrationAmount()
    : parent.IDFullRegistrationAmount();
  const offer =
    options.offer == null
      ? minimum
      : atomic(options.offer, "Registration offer");
  if (offer.lt(minimum))
    fail(
      "INSUFFICIENT_REGISTRATION_OFFER",
      "Registration offer is below the required namespace price"
    );
  const referralAmount = economicReferral
    ? parent.IDReferralAmount()
    : new BN(0);
  const remainder = offer.sub(
    referralAmount.muln(policy.referralRecipients.length)
  );
  if (remainder.isNeg())
    fail(
      "INVALID_REFERRAL_POLICY",
      "Referral payments exceed the registration offer"
    );
  const nativeFee =
    policy.branch === "native" ? remainder : native.IDImportFee();
  if (nativeFee.isNeg())
    fail("INVALID_CURRENCY_POLICY", "Native import fee cannot be negative");
  const transferFee =
    policy.branch === "token-burn"
      ? new BN(REGISTRATION_TRANSFER_FEE)
      : new BN(0);
  const total: Record<string, string> = {};
  total[policy.resolvedName.systemID] =
    policy.branch === "native"
      ? offer.toString(10)
      : nativeFee.add(transferFee).toString(10);
  if (policy.branch !== "native") total[policy.issuerID] = offer.toString(10);
  const operationTotal = { ...total };
  operationTotal[policy.resolvedName.systemID] = new BN(
    total[policy.resolvedName.systemID]
  )
    .add(commitmentFee)
    .toString(10);
  Object.values(operationTotal).forEach((amount) =>
    atomic(amount, "Total registration requirement")
  );
  return {
    branch: policy.branch,
    systemID: policy.resolvedName.systemID,
    parentID: policy.resolvedName.parent,
    issuerID: policy.issuerID,
    feePricingCurrencyID: policy.feePricingCurrencyID,
    candidateHeight: policy.candidateHeight,
    commitmentFee: commitmentFee.toString(10),
    registrationOffer: offer.toString(10),
    nativeFee: nativeFee.toString(10),
    importFee: policy.branch === "native" ? "0" : nativeFee.toString(10),
    transferFee: transferFee.toString(10),
    issuerPayment:
      policy.branch === "native"
        ? undefined
        : {
            currencyID: policy.issuerID,
            recipient: policy.issuerID,
            amount: remainder.toString(10),
            kind: policy.branch === "token-burn" ? "burn" : "payment",
          },
    referralPayments: policy.referralRecipients.map((recipient) => ({
      currencyID: policy.issuerID,
      recipient,
      amount: referralAmount.toString(10),
    })),
    totalRequired: total,
    totalOperationRequired: operationTotal,
  };
}
