"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateIdentityVersion = validateIdentityVersion;
exports.validateIdentityPrimaryAddresses = validateIdentityPrimaryAddresses;
exports.dropEmptyIdentityContent = dropEmptyIdentityContent;
exports.validateIdentitySize = validateIdentitySize;
exports.validatePartialIdentityDefinition = validatePartialIdentityDefinition;
exports.validateIdentityDefinition = validateIdentityDefinition;
const bn_js_1 = __importDefault(require("bn.js"));
const verus_typescript_primitives_1 = require("verus-typescript-primitives");
const fundingPrimitives_1 = require("./fundingPrimitives");
const registrationPolicy_1 = require("./registrationPolicy");
/** Check before upgrading, which otherwise also promotes invalid old versions. */
function validateIdentityVersion(version) {
    (0, fundingPrimitives_1.requireCondition)(bn_js_1.default.isBN(version) &&
        version.gte(verus_typescript_primitives_1.Identity.VERSION_FIRSTVALID) &&
        version.lte(verus_typescript_primitives_1.Identity.VERSION_LASTVALID), "Unsupported identity version.");
}
function validateIdentityThreshold(minSigs, keyCount = 25) {
    (0, fundingPrimitives_1.requireCondition)(bn_js_1.default.isBN(minSigs) &&
        minSigs.gten(1) &&
        minSigs.lten(13) &&
        minSigs.lten(keyCount), "Identity signature threshold must be 1 to 13 and no greater than its primary key count.");
}
/** Check before serializing: primary address types are lost in the wire format. */
function validateIdentityPrimaryAddresses(keys, minSigs) {
    (0, fundingPrimitives_1.requireCondition)(Array.isArray(keys) && keys.length >= 1 && keys.length <= 25, "Identity requires 1 to 25 primary keys.");
    const primaryIDs = new Set();
    for (const key of keys) {
        (0, fundingPrimitives_1.requireCondition)(key instanceof verus_typescript_primitives_1.KeyID &&
            key.version === verus_typescript_primitives_1.R_ADDR_VERSION &&
            key.varlength === false &&
            Buffer.isBuffer(key.hash) &&
            key.hash.length === 20 &&
            !key.hash.equals(Buffer.alloc(20)), "Identity supports nonnull KeyID primary keys only.");
        const id = key.hash.toString("hex");
        (0, fundingPrimitives_1.requireCondition)(!primaryIDs.has(id), "Identity primary keys must be unique.");
        primaryIDs.add(id);
    }
    if (minSigs !== undefined) {
        validateIdentityThreshold(minSigs, keys.length);
    }
}
function validateIdentityDestination(value, label, allowNull = false) {
    (0, fundingPrimitives_1.requireCondition)(value instanceof verus_typescript_primitives_1.IdentityID &&
        value.version === verus_typescript_primitives_1.I_ADDR_VERSION &&
        value.varlength === false &&
        Buffer.isBuffer(value.hash) &&
        value.hash.length === 20 &&
        (allowNull || !value.hash.equals(Buffer.alloc(20))), `${label} must be a valid identity destination.`);
}
/** The daemon cannot serialize a multimap key with zero values. Copy first. */
function dropEmptyIdentityContent(identity) {
    const content = identity.contentMultiMap.kvContent;
    for (const [key, values] of content.entries()) {
        if (values.length === 0)
            content.delete(key);
    }
}
/** PrecheckIdentityPrimary measures this export wrapper, not just the identity. */
function validateIdentitySize(identity) {
    const identityID = identity.getIdentityAddress();
    const wrapped = new verus_typescript_primitives_1.ReserveTransfer({
        version: new bn_js_1.default(1),
        flags: verus_typescript_primitives_1.RESERVE_TRANSFER_VALID.or(verus_typescript_primitives_1.RESERVE_TRANSFER_IDENTITY_EXPORT).or(verus_typescript_primitives_1.RESERVE_TRANSFER_CROSS_SYSTEM),
        values: new verus_typescript_primitives_1.CurrencyValueMap({
            valueMap: new Map([[identity.systemId.toAddress(), new bn_js_1.default(1)]]),
        }),
        feeCurrencyID: identity.systemId.toAddress(),
        feeAmount: new bn_js_1.default(0),
        destCurrencyID: identityID,
        destSystemID: verus_typescript_primitives_1.NULL_I_ADDR,
        transferDestination: new verus_typescript_primitives_1.TransferDestination({
            // The daemon's FULLID destination sets the gateway flag for its ID.
            type: verus_typescript_primitives_1.DEST_FULLID.or(verus_typescript_primitives_1.FLAG_DEST_GATEWAY),
            destinationBytes: identity.toBuffer(),
            gatewayID: identityID,
        }),
    });
    if (wrapped.toBuffer().length > verus_typescript_primitives_1.IDENTITY_REGISTRATION_MAX_BYTES) {
        throw new registrationPolicy_1.RegistrationError("IDENTITY_TOO_LARGE", "Identity exceeds the daemon's wrapped size limit.");
    }
}
/** Partial requests must be checked before JSON or binary conversion loses types. */
function validatePartialIdentityDefinition(identity) {
    (0, fundingPrimitives_1.requireCondition)(identity instanceof verus_typescript_primitives_1.PartialIdentity, "Expected a partial identity definition.");
    validateIdentityFields(identity, identity);
}
function validateIdentityFields(identity, partial) {
    if (!partial || partial.containsVersion())
        validateIdentityVersion(identity.version);
    if (!partial || partial.containsPrimaryAddresses()) {
        validateIdentityPrimaryAddresses(identity.primaryAddresses);
    }
    if (!partial || partial.containsMinSigs()) {
        const keyCount = !partial || partial.containsPrimaryAddresses()
            ? identity.primaryAddresses.length
            : undefined;
        validateIdentityThreshold(identity.minSigs, keyCount);
    }
    (0, fundingPrimitives_1.requireCondition)(typeof identity.name === "string" &&
        Buffer.byteLength(identity.name, "utf8") >= 1 &&
        Buffer.byteLength(identity.name, "utf8") <= 64, "Identity name must contain 1 to 64 bytes.");
    // Updates may legitimately revoke, lock or tokenize an identity, and root
    // identities have a null parent. Registration has stricter policy checks.
    if (!partial || partial.containsFlags()) {
        (0, fundingPrimitives_1.requireCondition)(bn_js_1.default.isBN(identity.flags) &&
            !identity.flags.isNeg() &&
            identity.flags.bitLength() <= 32, "Identity flags must be an unsigned 32-bit integer.");
    }
    if (!partial || partial.containsUnlockAfter()) {
        (0, fundingPrimitives_1.requireCondition)(bn_js_1.default.isBN(identity.unlockAfter) &&
            !identity.unlockAfter.isNeg() &&
            identity.unlockAfter.bitLength() <= 32, "Identity timelock must be an unsigned 32-bit integer.");
    }
    if (!partial || partial.containsParent())
        validateIdentityDestination(identity.parent, "Identity parent", true);
    if (!partial || partial.containsSystemId())
        validateIdentityDestination(identity.systemId, "Identity system", true);
    if (!partial || partial.containsRevocation())
        validateIdentityDestination(identity.revocationAuthority, "Revocation authority");
    if (!partial || partial.containsRecovery())
        validateIdentityDestination(identity.recoveryAuthority, "Recovery authority");
    if (!partial || partial.containsContentMap()) {
        (0, fundingPrimitives_1.requireCondition)(identity.contentMap instanceof Map, "Invalid identity content map.");
        for (const [key, value] of identity.contentMap) {
            const decodedKey = (0, verus_typescript_primitives_1.fromBase58Check)(key);
            // PBaaS reads this map directly; only the legacy vector reader rejects a
            // null key. Multimap keys below still must be nonnull in every PBaaS ID.
            (0, fundingPrimitives_1.requireCondition)(decodedKey.version === verus_typescript_primitives_1.I_ADDR_VERSION &&
                decodedKey.hash.length === 20 &&
                (identity.version.gte(verus_typescript_primitives_1.Identity.VERSION_PBAAS) ||
                    !decodedKey.hash.equals(Buffer.alloc(20))), "Invalid identity content map key.");
            (0, fundingPrimitives_1.requireCondition)(Buffer.isBuffer(value) && value.length === 32, "Identity content map values must contain 32 bytes.");
        }
    }
    if (!partial || partial.containsContentMultiMap()) {
        for (const [key, values] of identity.contentMultiMap.kvContent.entries()) {
            (0, fundingPrimitives_1.validAddress)(key.toIAddress(), true);
            (0, fundingPrimitives_1.requireCondition)(Array.isArray(values) && values.length > 0, "Identity content multimap keys must contain at least one value.");
        }
    }
    if ((!partial || partial.containsPrivateAddresses()) &&
        identity.privateAddresses !== undefined) {
        (0, fundingPrimitives_1.requireCondition)(Array.isArray(identity.privateAddresses), "Invalid private addresses.");
        for (const address of identity.privateAddresses) {
            (0, fundingPrimitives_1.requireCondition)(address &&
                Buffer.isBuffer(address.d) &&
                address.d.length === 11 &&
                Buffer.isBuffer(address.pkD) &&
                address.pkD.length === 32, "Identity private address requires an 11-byte diversifier and 32-byte key.");
        }
    }
}
/** Structural checks for new update outputs; historical prevouts stay readable. */
function validateIdentityDefinition(identity) {
    (0, fundingPrimitives_1.requireCondition)(identity instanceof verus_typescript_primitives_1.Identity && !(identity instanceof verus_typescript_primitives_1.PartialIdentity), "Identity output requires a full identity definition.");
    validateIdentityFields(identity);
    const serialized = identity.toBuffer();
    const decoded = new verus_typescript_primitives_1.Identity();
    (0, fundingPrimitives_1.requireCondition)(decoded.fromBuffer(serialized, 0, false) === serialized.length &&
        decoded.toBuffer().equals(serialized), "Identity requires a canonical full identity encoding.");
    validateIdentitySize(identity);
}
