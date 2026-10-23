import BN from "bn.js";
import {
  Identity,
  IDENTITY_FLAG_LOCKED,
  fqnToAddress,
} from "verus-typescript-primitives";
import { requireCondition, validAddress } from "./fundingPrimitives";

/** Trusted active-chain context, never the node's estimated longest chain. */
export interface IdentityLockContext {
  chainId: string;
  nextBlockHeight: number;
}

// identity.h: CIdentity::MAX_UNLOCK_DELAY. Keep private BNs so returned identity
// fields cannot alias and mutate the primitives package's exported constant.
const MAX_UNLOCK_DELAY = new BN(60 * 24 * 22 * 365);
const VARRR_CHAIN = fqnToAddress("vARRR.vrsc.@");
const EXEMPT_IDS = new Set([
  "iSXF8KbbvpHDWBm4zHxeA4n7uc1LsfR15X",
  "i4UxDzYtNR5oeGEEVritXuzAKjKzoVgiPK",
  "i5nQeKAWmxaXdNYv36qLQzz6XV8gZEqbaV",
]);

function uint32(value: BN): BN {
  return value.maskn(32);
}

function validateTimelock(identity: Identity): void {
  requireCondition(
    BN.isBN(identity.unlockAfter) && !identity.unlockAfter.isNeg() &&
      identity.unlockAfter.bitLength() <= 32,
    "Identity timelock must be an unsigned 32-bit integer."
  );
}

function validateContext(context: IdentityLockContext): void {
  validAddress(context.chainId, true);
  requireCondition(
    Number.isSafeInteger(context.nextBlockHeight) &&
      context.nextBlockHeight > 0 && context.nextBlockHeight <= 0xffffffff,
    "Identity lock verification requires a valid candidate block height."
  );
}

function validateExpiry(expiryHeight: number): void {
  requireCondition(
    Number.isSafeInteger(expiryHeight) && expiryHeight > 0 && expiryHeight < 500000000,
    "Identity lock verification requires a valid transaction expiry."
  );
}

/** CIdentity::IsLocked(height), including the historical vARRR exception. */
export function isIdentityLockedAtHeight(identity: Identity, context: IdentityLockContext): boolean {
  validateContext(context);
  validateTimelock(identity);
  if (identity.version.lt(Identity.VERSION_VAULT) || identity.isRevoked()) return false;
  if (identity.isLocked()) return true;
  if (context.chainId === VARRR_CHAIN && identity.unlockAfter.gtn(800000) &&
      context.nextBlockHeight < 77000 && EXEMPT_IDS.has(identity.getIdentityAddress())) {
    // Before 67000 the daemon consults an on-chain upgrade activation record.
    // A height and identity alone cannot establish its value. Fail closed.
    requireCondition(
      context.nextBlockHeight >= 67000,
      "Historical vARRR identity lock verification requires unavailable upgrade activation state."
    );
    return false;
  }
  return identity.unlockAfter.gten(context.nextBlockHeight);
}

/**
 * updateidentity's lock-bit normalization over binary uint32 timelocks.
 * This deliberately does not emulate the RPC JSON parser's numeric coercions.
 */
export function normalizeIdentityLockUpdate(
  current: Identity, next: Identity, height: BN, expiry: BN
): void {
  validateTimelock(current);
  validateTimelock(next);
  if (current.isLocked() === next.isLocked()) return;
  const newLocked = next.isLocked();
  const requestedUnlock = next.unlockAfter.clone();
  next.flags = next.flags.and(IDENTITY_FLAG_LOCKED.notn(32))
    .or(next.isRevoked() ? new BN(0) : current.flags.and(IDENTITY_FLAG_LOCKED));
  next.unlockAfter = current.unlockAfter.clone();
  if (newLocked) {
    // CIdentity::Lock takes int32_t, even though unlockAfter is uint32_t.
    const signedDelay = requestedUnlock.fromTwos(32);
    next.unlockAfter = signedDelay.lten(0) ? new BN(1)
      : BN.min(signedDelay, MAX_UNLOCK_DELAY).clone();
    next.flags = next.flags.or(IDENTITY_FLAG_LOCKED);
  } else {
    // CIdentity::Unlock uses wrapping uint32 arithmetic before its upper cap.
    if (next.isRevoked()) {
      next.flags = next.flags.and(IDENTITY_FLAG_LOCKED.notn(32));
      next.unlockAfter = new BN(0);
    } else if (next.isLocked()) {
      next.flags = next.flags.and(IDENTITY_FLAG_LOCKED.notn(32));
      next.unlockAfter = uint32(next.unlockAfter.add(expiry));
    } else if (height.gt(next.unlockAfter)) {
      next.unlockAfter = new BN(0);
    }
    next.unlockAfter = BN.min(next.unlockAfter, uint32(expiry.add(MAX_UNLOCK_DELAY))).clone();
    if (requestedUnlock.gt(next.unlockAfter)) next.unlockAfter = requestedUnlock;
  }
}

/** The lock portion of post-PBaaS CIdentity::IsInvalidMutation. */
export function validateIdentityLockTransition(
  current: Identity, next: Identity, context: IdentityLockContext, expiryHeight: number
): void {
  validateContext(context);
  validateExpiry(expiryHeight);
  requireCondition(context.nextBlockHeight <= expiryHeight, "Identity update has expired.");
  validateTimelock(current);
  validateTimelock(next);
  if (next.isRevoked()) return;
  const expiry = new BN(expiryHeight);
  const currentLocked = isIdentityLockedAtHeight(current, context);
  const nextLocked = isIdentityLockedAtHeight(next, context);
  if (currentLocked) {
    requireCondition(nextLocked, "An identity lock cannot be removed before its unlock height.");
    if (current.isLocked()) {
      requireCondition(
        next.isLocked() ? next.unlockAfter.gte(current.unlockAfter)
          : next.unlockAfter.gte(uint32(current.unlockAfter.add(expiry))) ||
            (current.unlockAfter.gt(MAX_UNLOCK_DELAY) &&
              next.unlockAfter.eq(uint32(MAX_UNLOCK_DELAY.add(expiry)))),
        "An identity lock cannot be shortened or unlocked before its delay and transaction expiry."
      );
    } else if (next.isLocked()) {
      requireCondition(
        uint32(expiry.add(next.unlockAfter)).gte(current.unlockAfter),
        "Relocking cannot shorten an identity's pending unlock."
      );
    } else {
      requireCondition(next.unlockAfter.gte(current.unlockAfter),
        "A pending identity unlock height cannot be shortened.");
    }
  } else if (nextLocked) {
    requireCondition(
      next.isLocked() ? next.unlockAfter.lte(MAX_UNLOCK_DELAY) : next.unlockAfter.gt(expiry),
      "Invalid identity lock delay or absolute unlock height."
    );
  }
}

/**
 * Verification without independently trusted height requires validity at every
 * nonexpired inclusion height. Lock state changes only at these boundaries.
 * A caller with trusted current context can instead verify at that actual height.
 */
export function validateIdentityLocksWithoutHeight(
  current: Identity, next: Identity, chainId: string, expiryHeight: number
): void {
  validateExpiry(expiryHeight);
  validateTimelock(current);
  validateTimelock(next);
  const heights = new Set([1, current.unlockAfter.toNumber() + 1,
    next.unlockAfter.toNumber() + 1, 67000, 77000]);
  for (const nextBlockHeight of heights) {
    if (nextBlockHeight <= expiryHeight) {
      validateIdentityLockTransition(current, next, { chainId, nextBlockHeight }, expiryHeight);
    }
  }
}
