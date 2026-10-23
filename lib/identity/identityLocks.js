"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isIdentityLockedAtHeight = isIdentityLockedAtHeight;
exports.normalizeIdentityLockUpdate = normalizeIdentityLockUpdate;
exports.validateIdentityLockTransition = validateIdentityLockTransition;
exports.validateIdentityLocksWithoutHeight = validateIdentityLocksWithoutHeight;
const bn_js_1 = __importDefault(require("bn.js"));
const verus_typescript_primitives_1 = require("verus-typescript-primitives");
const fundingPrimitives_1 = require("./fundingPrimitives");
// identity.h: CIdentity::MAX_UNLOCK_DELAY. Keep private BNs so returned identity
// fields cannot alias and mutate the primitives package's exported constant.
const MAX_UNLOCK_DELAY = new bn_js_1.default(60 * 24 * 22 * 365);
const VARRR_CHAIN = (0, verus_typescript_primitives_1.fqnToAddress)("vARRR.vrsc.@");
const EXEMPT_IDS = new Set([
    "iSXF8KbbvpHDWBm4zHxeA4n7uc1LsfR15X",
    "i4UxDzYtNR5oeGEEVritXuzAKjKzoVgiPK",
    "i5nQeKAWmxaXdNYv36qLQzz6XV8gZEqbaV",
]);
function uint32(value) {
    return value.maskn(32);
}
function validateTimelock(identity) {
    (0, fundingPrimitives_1.requireCondition)(bn_js_1.default.isBN(identity.unlockAfter) && !identity.unlockAfter.isNeg() &&
        identity.unlockAfter.bitLength() <= 32, "Identity timelock must be an unsigned 32-bit integer.");
}
function validateContext(context) {
    (0, fundingPrimitives_1.validAddress)(context.chainId, true);
    (0, fundingPrimitives_1.requireCondition)(Number.isSafeInteger(context.nextBlockHeight) &&
        context.nextBlockHeight > 0 && context.nextBlockHeight <= 0xffffffff, "Identity lock verification requires a valid candidate block height.");
}
function validateExpiry(expiryHeight) {
    (0, fundingPrimitives_1.requireCondition)(Number.isSafeInteger(expiryHeight) && expiryHeight > 0 && expiryHeight < 500000000, "Identity lock verification requires a valid transaction expiry.");
}
/** CIdentity::IsLocked(height), including the historical vARRR exception. */
function isIdentityLockedAtHeight(identity, context) {
    validateContext(context);
    validateTimelock(identity);
    if (identity.version.lt(verus_typescript_primitives_1.Identity.VERSION_VAULT) || identity.isRevoked())
        return false;
    if (identity.isLocked())
        return true;
    if (context.chainId === VARRR_CHAIN && identity.unlockAfter.gtn(800000) &&
        context.nextBlockHeight < 77000 && EXEMPT_IDS.has(identity.getIdentityAddress())) {
        // Before 67000 the daemon consults an on-chain upgrade activation record.
        // A height and identity alone cannot establish its value. Fail closed.
        (0, fundingPrimitives_1.requireCondition)(context.nextBlockHeight >= 67000, "Historical vARRR identity lock verification requires unavailable upgrade activation state.");
        return false;
    }
    return identity.unlockAfter.gten(context.nextBlockHeight);
}
/**
 * updateidentity's lock-bit normalization over binary uint32 timelocks.
 * This deliberately does not emulate the RPC JSON parser's numeric coercions.
 */
function normalizeIdentityLockUpdate(current, next, height, expiry) {
    validateTimelock(current);
    validateTimelock(next);
    if (current.isLocked() === next.isLocked())
        return;
    const newLocked = next.isLocked();
    const requestedUnlock = next.unlockAfter.clone();
    next.flags = next.flags.and(verus_typescript_primitives_1.IDENTITY_FLAG_LOCKED.notn(32))
        .or(next.isRevoked() ? new bn_js_1.default(0) : current.flags.and(verus_typescript_primitives_1.IDENTITY_FLAG_LOCKED));
    next.unlockAfter = current.unlockAfter.clone();
    if (newLocked) {
        // CIdentity::Lock takes int32_t, even though unlockAfter is uint32_t.
        const signedDelay = requestedUnlock.fromTwos(32);
        next.unlockAfter = signedDelay.lten(0) ? new bn_js_1.default(1)
            : bn_js_1.default.min(signedDelay, MAX_UNLOCK_DELAY).clone();
        next.flags = next.flags.or(verus_typescript_primitives_1.IDENTITY_FLAG_LOCKED);
    }
    else {
        // CIdentity::Unlock uses wrapping uint32 arithmetic before its upper cap.
        if (next.isRevoked()) {
            next.flags = next.flags.and(verus_typescript_primitives_1.IDENTITY_FLAG_LOCKED.notn(32));
            next.unlockAfter = new bn_js_1.default(0);
        }
        else if (next.isLocked()) {
            next.flags = next.flags.and(verus_typescript_primitives_1.IDENTITY_FLAG_LOCKED.notn(32));
            next.unlockAfter = uint32(next.unlockAfter.add(expiry));
        }
        else if (height.gt(next.unlockAfter)) {
            next.unlockAfter = new bn_js_1.default(0);
        }
        next.unlockAfter = bn_js_1.default.min(next.unlockAfter, uint32(expiry.add(MAX_UNLOCK_DELAY))).clone();
        if (requestedUnlock.gt(next.unlockAfter))
            next.unlockAfter = requestedUnlock;
    }
}
/** The lock portion of post-PBaaS CIdentity::IsInvalidMutation. */
function validateIdentityLockTransition(current, next, context, expiryHeight) {
    validateContext(context);
    validateExpiry(expiryHeight);
    (0, fundingPrimitives_1.requireCondition)(context.nextBlockHeight <= expiryHeight, "Identity update has expired.");
    validateTimelock(current);
    validateTimelock(next);
    if (next.isRevoked())
        return;
    const expiry = new bn_js_1.default(expiryHeight);
    const currentLocked = isIdentityLockedAtHeight(current, context);
    const nextLocked = isIdentityLockedAtHeight(next, context);
    if (currentLocked) {
        (0, fundingPrimitives_1.requireCondition)(nextLocked, "An identity lock cannot be removed before its unlock height.");
        if (current.isLocked()) {
            (0, fundingPrimitives_1.requireCondition)(next.isLocked() ? next.unlockAfter.gte(current.unlockAfter)
                : next.unlockAfter.gte(uint32(current.unlockAfter.add(expiry))) ||
                    (current.unlockAfter.gt(MAX_UNLOCK_DELAY) &&
                        next.unlockAfter.eq(uint32(MAX_UNLOCK_DELAY.add(expiry)))), "An identity lock cannot be shortened or unlocked before its delay and transaction expiry.");
        }
        else if (next.isLocked()) {
            (0, fundingPrimitives_1.requireCondition)(uint32(expiry.add(next.unlockAfter)).gte(current.unlockAfter), "Relocking cannot shorten an identity's pending unlock.");
        }
        else {
            (0, fundingPrimitives_1.requireCondition)(next.unlockAfter.gte(current.unlockAfter), "A pending identity unlock height cannot be shortened.");
        }
    }
    else if (nextLocked) {
        (0, fundingPrimitives_1.requireCondition)(next.isLocked() ? next.unlockAfter.lte(MAX_UNLOCK_DELAY) : next.unlockAfter.gt(expiry), "Invalid identity lock delay or absolute unlock height.");
    }
}
/**
 * Verification without independently trusted height requires validity at every
 * nonexpired inclusion height. Lock state changes only at these boundaries.
 * A caller with trusted current context can instead verify at that actual height.
 */
function validateIdentityLocksWithoutHeight(current, next, chainId, expiryHeight) {
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
