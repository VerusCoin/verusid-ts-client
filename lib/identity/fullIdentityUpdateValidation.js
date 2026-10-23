"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateIdentityUpdateTransitionInvariants = validateIdentityUpdateTransitionInvariants;
exports.validateFullIdentityUpdate = validateFullIdentityUpdate;
const bn_js_1 = __importDefault(require("bn.js"));
const verus_typescript_primitives_1 = require("verus-typescript-primitives");
const fundingPrimitives_1 = require("./fundingPrimitives");
const identityValidation_1 = require("./identityValidation");
const localIdentityUpdate_1 = require("./localIdentityUpdate");
/**
 * Check source/target invariants that require no assumed chain height.
 * The funding verifier can repeat these checks against retained prevout bytes.
 * Currency launch and tokenization require dedicated, separately verified flows.
 */
function validateIdentityUpdateTransitionInvariants(current, next) {
    (0, fundingPrimitives_1.requireCondition)(current instanceof verus_typescript_primitives_1.Identity && !(current instanceof verus_typescript_primitives_1.PartialIdentity) &&
        next instanceof verus_typescript_primitives_1.Identity && !(next instanceof verus_typescript_primitives_1.PartialIdentity), "Identity transitions require complete source and target definitions.");
    (0, localIdentityUpdate_1.validateSupportedIdentityUpdateState)(current);
    (0, localIdentityUpdate_1.validateSupportedIdentityUpdateState)(next);
    (0, fundingPrimitives_1.requireCondition)(current.parent.toBuffer().equals(next.parent.toBuffer()) &&
        current.getIdentityAddress() === next.getIdentityAddress(), "An identity update cannot change its parent or identity address.");
    (0, fundingPrimitives_1.requireCondition)(current.systemId.toBuffer().equals(next.systemId.toBuffer()), "An identity update cannot change its system.");
    const protectedFlags = verus_typescript_primitives_1.IDENTITY_FLAG_ACTIVECURRENCY.or(verus_typescript_primitives_1.IDENTITY_FLAG_TOKENIZED_CONTROL);
    (0, fundingPrimitives_1.requireCondition)(current.flags.and(protectedFlags).eq(next.flags.and(protectedFlags)), "Changing active-currency or tokenized-control flags requires a separately supported transition.");
    const revoking = !current.isRevoked() && next.isRevoked();
    const address = current.getIdentityAddress();
    (0, fundingPrimitives_1.requireCondition)(!revoking || next.hasTokenizedIdControl() ||
        (current.recoveryAuthority.toAddress() !== address &&
            next.recoveryAuthority.toAddress() !== address), "Cannot revoke a self-recovering identity without tokenized control.");
}
/**
 * Validate an explicitly supplied final identity without rewriting its flags,
 * locks, private addresses, or contents. Partial updates normalize separately.
 */
function validateFullIdentityUpdate(current, next, context) {
    (0, fundingPrimitives_1.validAddress)(context.chainId, true);
    (0, fundingPrimitives_1.requireCondition)(Number.isSafeInteger(context.nextBlockHeight) && context.nextBlockHeight > 0 &&
        Number.isSafeInteger(context.expiryHeight) &&
        context.expiryHeight >= context.nextBlockHeight &&
        context.expiryHeight < 500000000, "Identity update requires a valid next-block height and transaction expiry.");
    validateIdentityUpdateTransitionInvariants(current, next);
    (0, identityValidation_1.validateIdentityDefinition)(next);
    (0, localIdentityUpdate_1.validateLockMutation)(current, next, new bn_js_1.default(context.nextBlockHeight), new bn_js_1.default(context.expiryHeight), context);
    return (0, localIdentityUpdate_1.getIdentityUpdateRequiredAuthorities)(current, next);
}
