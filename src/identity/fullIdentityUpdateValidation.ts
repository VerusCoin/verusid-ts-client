import BN from "bn.js";
import {
  Identity,
  PartialIdentity,
  IDENTITY_FLAG_ACTIVECURRENCY,
  IDENTITY_FLAG_TOKENIZED_CONTROL,
} from "verus-typescript-primitives";
import { requireCondition, validAddress } from "./fundingPrimitives";
import { validateIdentityDefinition } from "./identityValidation";
import {
  getIdentityUpdateRequiredAuthorities,
  LocalIdentityUpdateContext,
  LocalIdentityUpdateResult,
  validateLockMutation,
  validateSupportedIdentityUpdateState,
} from "./localIdentityUpdate";

/**
 * Check source/target invariants that require no assumed chain height.
 * The funding verifier can repeat these checks against retained prevout bytes.
 * Currency launch and tokenization require dedicated, separately verified flows.
 */
export function validateIdentityUpdateTransitionInvariants(
  current: Identity,
  next: Identity
): void {
  requireCondition(
    current instanceof Identity && !(current instanceof PartialIdentity) &&
      next instanceof Identity && !(next instanceof PartialIdentity),
    "Identity transitions require complete source and target definitions."
  );
  validateSupportedIdentityUpdateState(current);
  validateSupportedIdentityUpdateState(next);
  requireCondition(
    current.parent.toBuffer().equals(next.parent.toBuffer()) &&
      current.getIdentityAddress() === next.getIdentityAddress(),
    "An identity update cannot change its parent or identity address."
  );
  requireCondition(
    current.systemId.toBuffer().equals(next.systemId.toBuffer()),
    "An identity update cannot change its system."
  );
  const protectedFlags = IDENTITY_FLAG_ACTIVECURRENCY.or(IDENTITY_FLAG_TOKENIZED_CONTROL);
  requireCondition(
    current.flags.and(protectedFlags).eq(next.flags.and(protectedFlags)),
    "Changing active-currency or tokenized-control flags requires a separately supported transition."
  );
  const revoking = !current.isRevoked() && next.isRevoked();
  const address = current.getIdentityAddress();
  requireCondition(
    !revoking || next.hasTokenizedIdControl() ||
      (current.recoveryAuthority.toAddress() !== address &&
        next.recoveryAuthority.toAddress() !== address),
    "Cannot revoke a self-recovering identity without tokenized control."
  );
}

/**
 * Validate an explicitly supplied final identity without rewriting its flags,
 * locks, private addresses, or contents. Partial updates normalize separately.
 */
export function validateFullIdentityUpdate(
  current: Identity,
  next: Identity,
  context: LocalIdentityUpdateContext
): LocalIdentityUpdateResult["requiredAuthorities"] {
  validAddress(context.chainId, true);
  requireCondition(
    Number.isSafeInteger(context.nextBlockHeight) && context.nextBlockHeight > 0 &&
      Number.isSafeInteger(context.expiryHeight) &&
      context.expiryHeight >= context.nextBlockHeight &&
      context.expiryHeight < 500000000,
    "Identity update requires a valid next-block height and transaction expiry."
  );
  validateIdentityUpdateTransitionInvariants(current, next);
  validateIdentityDefinition(next);
  validateLockMutation(
    current, next, new BN(context.nextBlockHeight), new BN(context.expiryHeight), context
  );
  return getIdentityUpdateRequiredAuthorities(current, next);
}
