import BN from "bn.js";
import {
  Identity,
  PartialIdentity,
  IDENTITY_FLAG_ACTIVECURRENCY,
  IDENTITY_FLAG_LOCKED,
  IDENTITY_FLAG_REVOKED,
  IDENTITY_FLAG_TOKENIZED_CONTROL,
} from "verus-typescript-primitives";
import { requireCondition, validAddress } from "./fundingPrimitives";
import {
  dropEmptyIdentityContent,
  validateIdentityDefinition,
  validateIdentityVersion,
  validatePartialIdentityDefinition,
} from "./identityValidation";
import { snapshotUpdateRequestValue } from "./requestSnapshot";
import {
  IdentityLockContext,
  normalizeIdentityLockUpdate,
  validateIdentityLockTransition,
} from "./identityLocks";

export interface LocalIdentityUpdateContext {
  chainId: string;
  /** The same next-block height and expiry used to construct the transaction. */
  nextBlockHeight: number;
  expiryHeight: number;
  rootSystemName?: string;
  /** Upload references count as a primary mutation of a revoked identity. */
  hasDataUploads?: boolean;
}

export interface LocalIdentityUpdateResult {
  identity: Identity;
  /** Resolve these identities on the configured chain before funding. */
  requiredAuthorities: Array<{
    address: string;
    role: "revocation" | "recovery";
  }>;
}

/**
 * Restrict update state to the daemon version exercised by the live audit.
 * A legacy source needs a separately verified migration path before enabling it.
 */
export function validateSupportedIdentityUpdateState(identity: Identity): void {
  validateIdentityVersion(identity.version);
  requireCondition(
    identity.version.eq(Identity.VERSION_PBAAS),
    "Identity updates from a pre-PBaaS identity version are not supported."
  );
  const knownFlags = IDENTITY_FLAG_ACTIVECURRENCY.or(IDENTITY_FLAG_LOCKED)
    .or(IDENTITY_FLAG_REVOKED)
    .or(IDENTITY_FLAG_TOKENIZED_CONTROL);
  requireCondition(
    BN.isBN(identity.flags) &&
      !identity.flags.isNeg() &&
      identity.flags.bitLength() <= 32 &&
      identity.flags.and(knownFlags.notn(32)).isZero(),
    "Unsupported identity update flags."
  );
}

function sameAddresses(
  left: Identity["primaryAddresses"] | Identity["privateAddresses"],
  right: Identity["primaryAddresses"] | Identity["privateAddresses"]
): boolean {
  return (
    (left || []).length === (right || []).length &&
    (left || []).every((value, index) =>
      value.toBuffer().equals(right![index].toBuffer())
    )
  );
}

function sameContentMap(left: Identity, right: Identity): boolean {
  return (
    left.contentMap.size === right.contentMap.size &&
    [...left.contentMap].every(([key, value]) =>
      value.equals(right.contentMap.get(key) || Buffer.alloc(0))
    )
  );
}

/** Post-PBaaS CIdentity::IsPrimaryMutation, including newly added uploads. */
function isPrimaryMutation(
  current: Identity,
  next: Identity,
  hasDataUploads: boolean
): boolean {
  return (
    !current.minSigs!.eq(next.minSigs!) ||
    !sameAddresses(current.primaryAddresses, next.primaryAddresses) ||
    current.name !== next.name ||
    !sameContentMap(current, next) ||
    next.contentMultiMap.kvContent.size !== 0 ||
    hasDataUploads ||
    !sameAddresses(current.privateAddresses, next.privateAddresses) ||
    (!current.unlockAfter.eq(next.unlockAfter) && !next.unlockAfter.isZero()) ||
    (current.isLocked() !== next.isLocked() && next.isLocked())
  );
}

/** Authority existence checks shared by partial and full local update paths. */
export function getIdentityUpdateRequiredAuthorities(
  current: Identity,
  next: Identity,
  hasDataUploads = false,
  rootSystemName?: string
): LocalIdentityUpdateResult["requiredAuthorities"] {
  const currentAddress = current.getIdentityAddress(rootSystemName);
  const revoking = !current.isRevoked() && next.isRevoked();
  const recovering = current.isRevoked() && !next.isRevoked();
  const revocationChanged = !current.revocationAuthority
    .toBuffer()
    .equals(next.revocationAuthority.toBuffer());
  const recoveryChanged = !current.recoveryAuthority
    .toBuffer()
    .equals(next.recoveryAuthority.toBuffer());
  const requiredAuthorities: LocalIdentityUpdateResult["requiredAuthorities"] =
    [];
  if (!next.hasTokenizedIdControl()) {
    if (
      (revoking || (revocationChanged && !current.isRevoked())) &&
      next.revocationAuthority.toAddress() !== currentAddress
    ) {
      requiredAuthorities.push({
        address: next.revocationAuthority.toAddress()!,
        role: "revocation",
      });
    }
    if (
      (recovering ||
        recoveryChanged ||
        (current.isRevoked() &&
          (revocationChanged ||
            isPrimaryMutation(current, next, hasDataUploads)))) &&
      next.recoveryAuthority.toAddress() !== currentAddress
    ) {
      requiredAuthorities.push({
        address: next.recoveryAuthority.toAddress()!,
        role: "recovery",
      });
    }
  }
  return requiredAuthorities;
}

/** Reject invalid modern lock mutations using the actual inclusion context. */
export function validateLockMutation(
  current: Identity,
  next: Identity,
  height: BN,
  expiry: BN,
  context: IdentityLockContext
): void {
  requireCondition(height.eqn(context.nextBlockHeight), "Inconsistent identity lock height context.");
  validateIdentityLockTransition(current, next, context, expiry.toNumber());
}

/**
 * Apply an ordinary partial update using the current PBaaS daemon rules.
 * The base must be decoded from the spent identity output, with raw content.
 * This helper performs no RPC, encryption, signing, funding, or broadcasting.
 */
export function applyLocalIdentityUpdate(
  current: Identity,
  partial: PartialIdentity,
  context: LocalIdentityUpdateContext
): LocalIdentityUpdateResult {
  requireCondition(
    current instanceof Identity && !(current instanceof PartialIdentity),
    "Local identity update requires a full current identity."
  );
  validAddress(context.chainId, true);
  requireCondition(
    Number.isSafeInteger(context.nextBlockHeight) &&
      context.nextBlockHeight > 0 &&
      Number.isSafeInteger(context.expiryHeight) &&
      context.expiryHeight >= context.nextBlockHeight &&
      context.expiryHeight < 500000000,
    "Local identity update requires a valid next-block height and expiry."
  );
  validateSupportedIdentityUpdateState(current);
  const request = snapshotUpdateRequestValue(partial);
  dropEmptyIdentityContent(request);
  validatePartialIdentityDefinition(request);

  const next = snapshotUpdateRequestValue(current);
  const currentAddress = current.getIdentityAddress(context.rootSystemName);
  next.clearContentMultiMap();

  // Presence flags are authoritative. In particular, zero flags/timelocks and
  // explicitly present empty vectors/maps must not turn into omitted fields.
  next.name = request.name;
  if (request.containsParent()) next.parent = request.parent;
  if (request.containsSystemId()) next.systemId = request.systemId;
  if (request.containsFlags()) next.flags = request.flags;
  if (request.containsPrimaryAddresses())
    next.primaryAddresses = request.primaryAddresses;
  if (request.containsMinSigs()) next.minSigs = request.minSigs;
  if (request.containsRevocation())
    next.revocationAuthority = request.revocationAuthority;
  if (request.containsRecovery())
    next.recoveryAuthority = request.recoveryAuthority;
  if (request.containsContentMap()) next.contentMap = request.contentMap;
  if (request.containsContentMultiMap())
    next.contentMultiMap = request.toContentMultiMap();
  if (request.containsPrivateAddresses())
    next.privateAddresses = request.privateAddresses;
  if (request.containsUnlockAfter()) next.unlockAfter = request.unlockAfter;

  // updateidentity overrides the requested version with the active version.
  // Only the PBaaS era is supported by this builder.
  next.upgradeVersion(Identity.VERSION_PBAAS);
  requireCondition(
    next.parent.toBuffer().equals(current.parent.toBuffer()) &&
      next.getIdentityAddress(context.rootSystemName) === currentAddress,
    "An identity update cannot change its parent or identity address."
  );
  requireCondition(
    next.systemId.toBuffer().equals(current.systemId.toBuffer()),
    "An identity update cannot change its system."
  );

  const protectedFlags = IDENTITY_FLAG_ACTIVECURRENCY.or(
    IDENTITY_FLAG_TOKENIZED_CONTROL
  );
  next.flags = next.flags
    .and(IDENTITY_FLAG_LOCKED.or(IDENTITY_FLAG_REVOKED))
    .or(current.flags.and(protectedFlags));

  const revoking = !current.isRevoked() && next.isRevoked();
  requireCondition(
    !revoking ||
      next.hasTokenizedIdControl() ||
      (current.recoveryAuthority.toAddress() !== currentAddress &&
        next.recoveryAuthority.toAddress() !== currentAddress),
    "Cannot revoke a self-recovering identity without tokenized control."
  );

  // The RPC checks authority mutations before normalizing lock transitions.
  const requiredAuthorities = getIdentityUpdateRequiredAuthorities(
    current,
    next,
    !!context.hasDataUploads,
    context.rootSystemName
  );

  const height = new BN(context.nextBlockHeight);
  const expiry = new BN(context.expiryHeight);
  normalizeIdentityLockUpdate(current, next, height, expiry);
  validateLockMutation(current, next, height, expiry, context);
  validateSupportedIdentityUpdateState(next);
  validateIdentityDefinition(next);
  return { identity: next, requiredAuthorities };
}
