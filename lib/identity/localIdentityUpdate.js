"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateSupportedIdentityUpdateState = validateSupportedIdentityUpdateState;
exports.getIdentityUpdateRequiredAuthorities = getIdentityUpdateRequiredAuthorities;
exports.validateLockMutation = validateLockMutation;
exports.applyLocalIdentityUpdate = applyLocalIdentityUpdate;
const bn_js_1 = __importDefault(require("bn.js"));
const verus_typescript_primitives_1 = require("verus-typescript-primitives");
const fundingPrimitives_1 = require("./fundingPrimitives");
const identityValidation_1 = require("./identityValidation");
const requestSnapshot_1 = require("./requestSnapshot");
const identityLocks_1 = require("./identityLocks");
/**
 * Restrict update state to the daemon version exercised by the live audit.
 * A legacy source needs a separately verified migration path before enabling it.
 */
function validateSupportedIdentityUpdateState(identity) {
    (0, identityValidation_1.validateIdentityVersion)(identity.version);
    (0, fundingPrimitives_1.requireCondition)(identity.version.eq(verus_typescript_primitives_1.Identity.VERSION_PBAAS), "Identity updates from a pre-PBaaS identity version are not supported.");
    const knownFlags = verus_typescript_primitives_1.IDENTITY_FLAG_ACTIVECURRENCY.or(verus_typescript_primitives_1.IDENTITY_FLAG_LOCKED)
        .or(verus_typescript_primitives_1.IDENTITY_FLAG_REVOKED)
        .or(verus_typescript_primitives_1.IDENTITY_FLAG_TOKENIZED_CONTROL);
    (0, fundingPrimitives_1.requireCondition)(bn_js_1.default.isBN(identity.flags) &&
        !identity.flags.isNeg() &&
        identity.flags.bitLength() <= 32 &&
        identity.flags.and(knownFlags.notn(32)).isZero(), "Unsupported identity update flags.");
}
function sameAddresses(left, right) {
    return ((left || []).length === (right || []).length &&
        (left || []).every((value, index) => value.toBuffer().equals(right[index].toBuffer())));
}
function sameContentMap(left, right) {
    return (left.contentMap.size === right.contentMap.size &&
        [...left.contentMap].every(([key, value]) => value.equals(right.contentMap.get(key) || Buffer.alloc(0))));
}
/** Post-PBaaS CIdentity::IsPrimaryMutation, including newly added uploads. */
function isPrimaryMutation(current, next, hasDataUploads) {
    return (!current.minSigs.eq(next.minSigs) ||
        !sameAddresses(current.primaryAddresses, next.primaryAddresses) ||
        current.name !== next.name ||
        !sameContentMap(current, next) ||
        next.contentMultiMap.kvContent.size !== 0 ||
        hasDataUploads ||
        !sameAddresses(current.privateAddresses, next.privateAddresses) ||
        (!current.unlockAfter.eq(next.unlockAfter) && !next.unlockAfter.isZero()) ||
        (current.isLocked() !== next.isLocked() && next.isLocked()));
}
/** Authority existence checks shared by partial and full local update paths. */
function getIdentityUpdateRequiredAuthorities(current, next, hasDataUploads = false, rootSystemName) {
    const currentAddress = current.getIdentityAddress(rootSystemName);
    const revoking = !current.isRevoked() && next.isRevoked();
    const recovering = current.isRevoked() && !next.isRevoked();
    const revocationChanged = !current.revocationAuthority
        .toBuffer()
        .equals(next.revocationAuthority.toBuffer());
    const recoveryChanged = !current.recoveryAuthority
        .toBuffer()
        .equals(next.recoveryAuthority.toBuffer());
    const requiredAuthorities = [];
    if (!next.hasTokenizedIdControl()) {
        if ((revoking || (revocationChanged && !current.isRevoked())) &&
            next.revocationAuthority.toAddress() !== currentAddress) {
            requiredAuthorities.push({
                address: next.revocationAuthority.toAddress(),
                role: "revocation",
            });
        }
        if ((recovering ||
            recoveryChanged ||
            (current.isRevoked() &&
                (revocationChanged ||
                    isPrimaryMutation(current, next, hasDataUploads)))) &&
            next.recoveryAuthority.toAddress() !== currentAddress) {
            requiredAuthorities.push({
                address: next.recoveryAuthority.toAddress(),
                role: "recovery",
            });
        }
    }
    return requiredAuthorities;
}
/** Reject invalid modern lock mutations using the actual inclusion context. */
function validateLockMutation(current, next, height, expiry, context) {
    (0, fundingPrimitives_1.requireCondition)(height.eqn(context.nextBlockHeight), "Inconsistent identity lock height context.");
    (0, identityLocks_1.validateIdentityLockTransition)(current, next, context, expiry.toNumber());
}
/**
 * Apply an ordinary partial update using the current PBaaS daemon rules.
 * The base must be decoded from the spent identity output, with raw content.
 * This helper performs no RPC, encryption, signing, funding, or broadcasting.
 */
function applyLocalIdentityUpdate(current, partial, context) {
    (0, fundingPrimitives_1.requireCondition)(current instanceof verus_typescript_primitives_1.Identity && !(current instanceof verus_typescript_primitives_1.PartialIdentity), "Local identity update requires a full current identity.");
    (0, fundingPrimitives_1.validAddress)(context.chainId, true);
    (0, fundingPrimitives_1.requireCondition)(Number.isSafeInteger(context.nextBlockHeight) &&
        context.nextBlockHeight > 0 &&
        Number.isSafeInteger(context.expiryHeight) &&
        context.expiryHeight >= context.nextBlockHeight &&
        context.expiryHeight < 500000000, "Local identity update requires a valid next-block height and expiry.");
    validateSupportedIdentityUpdateState(current);
    const request = (0, requestSnapshot_1.snapshotUpdateRequestValue)(partial);
    (0, identityValidation_1.dropEmptyIdentityContent)(request);
    (0, identityValidation_1.validatePartialIdentityDefinition)(request);
    const next = (0, requestSnapshot_1.snapshotUpdateRequestValue)(current);
    const currentAddress = current.getIdentityAddress(context.rootSystemName);
    next.clearContentMultiMap();
    // Presence flags are authoritative. In particular, zero flags/timelocks and
    // explicitly present empty vectors/maps must not turn into omitted fields.
    next.name = request.name;
    if (request.containsParent())
        next.parent = request.parent;
    if (request.containsSystemId())
        next.systemId = request.systemId;
    if (request.containsFlags())
        next.flags = request.flags;
    if (request.containsPrimaryAddresses())
        next.primaryAddresses = request.primaryAddresses;
    if (request.containsMinSigs())
        next.minSigs = request.minSigs;
    if (request.containsRevocation())
        next.revocationAuthority = request.revocationAuthority;
    if (request.containsRecovery())
        next.recoveryAuthority = request.recoveryAuthority;
    if (request.containsContentMap())
        next.contentMap = request.contentMap;
    if (request.containsContentMultiMap())
        next.contentMultiMap = request.toContentMultiMap();
    if (request.containsPrivateAddresses())
        next.privateAddresses = request.privateAddresses;
    if (request.containsUnlockAfter())
        next.unlockAfter = request.unlockAfter;
    // updateidentity overrides the requested version with the active version.
    // Only the PBaaS era is supported by this builder.
    next.upgradeVersion(verus_typescript_primitives_1.Identity.VERSION_PBAAS);
    (0, fundingPrimitives_1.requireCondition)(next.parent.toBuffer().equals(current.parent.toBuffer()) &&
        next.getIdentityAddress(context.rootSystemName) === currentAddress, "An identity update cannot change its parent or identity address.");
    (0, fundingPrimitives_1.requireCondition)(next.systemId.toBuffer().equals(current.systemId.toBuffer()), "An identity update cannot change its system.");
    const protectedFlags = verus_typescript_primitives_1.IDENTITY_FLAG_ACTIVECURRENCY.or(verus_typescript_primitives_1.IDENTITY_FLAG_TOKENIZED_CONTROL);
    next.flags = next.flags
        .and(verus_typescript_primitives_1.IDENTITY_FLAG_LOCKED.or(verus_typescript_primitives_1.IDENTITY_FLAG_REVOKED))
        .or(current.flags.and(protectedFlags));
    const revoking = !current.isRevoked() && next.isRevoked();
    (0, fundingPrimitives_1.requireCondition)(!revoking ||
        next.hasTokenizedIdControl() ||
        (current.recoveryAuthority.toAddress() !== currentAddress &&
            next.recoveryAuthority.toAddress() !== currentAddress), "Cannot revoke a self-recovering identity without tokenized control.");
    // The RPC checks authority mutations before normalizing lock transitions.
    const requiredAuthorities = getIdentityUpdateRequiredAuthorities(current, next, !!context.hasDataUploads, context.rootSystemName);
    const height = new bn_js_1.default(context.nextBlockHeight);
    const expiry = new bn_js_1.default(context.expiryHeight);
    (0, identityLocks_1.normalizeIdentityLockUpdate)(current, next, height, expiry);
    validateLockMutation(current, next, height, expiry, context);
    validateSupportedIdentityUpdateState(next);
    (0, identityValidation_1.validateIdentityDefinition)(next);
    return { identity: next, requiredAuthorities };
}
