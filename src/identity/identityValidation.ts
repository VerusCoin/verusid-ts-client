import BN from "bn.js";
import {
  CurrencyValueMap,
  DEST_FULLID,
  FLAG_DEST_GATEWAY,
  IDENTITY_REGISTRATION_MAX_BYTES,
  I_ADDR_VERSION,
  Identity,
  IdentityID,
  KeyID,
  NULL_I_ADDR,
  PartialIdentity,
  R_ADDR_VERSION,
  RESERVE_TRANSFER_CROSS_SYSTEM,
  RESERVE_TRANSFER_IDENTITY_EXPORT,
  RESERVE_TRANSFER_VALID,
  ReserveTransfer,
  TransferDestination,
  fromBase58Check,
} from "verus-typescript-primitives";
import { requireCondition, validAddress } from "./fundingPrimitives";
import { RegistrationError } from "./registrationPolicy";

/** Check before upgrading, which otherwise also promotes invalid old versions. */
export function validateIdentityVersion(version: Identity["version"]): void {
  requireCondition(
    BN.isBN(version) &&
      version.gte(Identity.VERSION_FIRSTVALID) &&
      version.lte(Identity.VERSION_LASTVALID),
    "Unsupported identity version."
  );
}

function validateIdentityThreshold(
  minSigs: Identity["minSigs"],
  keyCount = 25
): void {
  requireCondition(
    BN.isBN(minSigs) &&
      minSigs.gten(1) &&
      minSigs.lten(13) &&
      minSigs.lten(keyCount),
    "Identity signature threshold must be 1 to 13 and no greater than its primary key count."
  );
}

/** Check before serializing: primary address types are lost in the wire format. */
export function validateIdentityPrimaryAddresses(
  keys: Identity["primaryAddresses"],
  minSigs?: Identity["minSigs"]
): void {
  requireCondition(
    Array.isArray(keys) && keys.length >= 1 && keys.length <= 25,
    "Identity requires 1 to 25 primary keys."
  );
  const primaryIDs = new Set<string>();
  for (const key of keys) {
    requireCondition(
      key instanceof KeyID &&
        key.version === R_ADDR_VERSION &&
        key.varlength === false &&
        Buffer.isBuffer(key.hash) &&
        key.hash.length === 20 &&
        !key.hash.equals(Buffer.alloc(20)),
      "Identity supports nonnull KeyID primary keys only."
    );
    const id = key.hash.toString("hex");
    requireCondition(
      !primaryIDs.has(id),
      "Identity primary keys must be unique."
    );
    primaryIDs.add(id);
  }
  if (minSigs !== undefined) {
    validateIdentityThreshold(minSigs, keys.length);
  }
}

function validateIdentityDestination(
  value: IdentityID,
  label: string,
  allowNull = false
): void {
  requireCondition(
    value instanceof IdentityID &&
      value.version === I_ADDR_VERSION &&
      value.varlength === false &&
      Buffer.isBuffer(value.hash) &&
      value.hash.length === 20 &&
      (allowNull || !value.hash.equals(Buffer.alloc(20))),
    `${label} must be a valid identity destination.`
  );
}

/** The daemon cannot serialize a multimap key with zero values. Copy first. */
export function dropEmptyIdentityContent(identity: Identity): void {
  const content = identity.contentMultiMap.kvContent;
  for (const [key, values] of content.entries()) {
    if (values.length === 0) content.delete(key);
  }
}

/** PrecheckIdentityPrimary measures this export wrapper, not just the identity. */
export function validateIdentitySize(identity: Identity): void {
  const identityID = identity.getIdentityAddress();
  const wrapped = new ReserveTransfer({
    version: new BN(1),
    flags: RESERVE_TRANSFER_VALID.or(RESERVE_TRANSFER_IDENTITY_EXPORT).or(
      RESERVE_TRANSFER_CROSS_SYSTEM
    ),
    values: new CurrencyValueMap({
      valueMap: new Map([[identity.systemId.toAddress()!, new BN(1)]]),
    }),
    feeCurrencyID: identity.systemId.toAddress()!,
    feeAmount: new BN(0),
    destCurrencyID: identityID,
    destSystemID: NULL_I_ADDR,
    transferDestination: new TransferDestination({
      // The daemon's FULLID destination sets the gateway flag for its ID.
      type: DEST_FULLID.or(FLAG_DEST_GATEWAY),
      destinationBytes: identity.toBuffer(),
      gatewayID: identityID,
    }),
  });
  if (wrapped.toBuffer().length > IDENTITY_REGISTRATION_MAX_BYTES) {
    throw new RegistrationError(
      "IDENTITY_TOO_LARGE",
      "Identity exceeds the daemon's wrapped size limit."
    );
  }
}

/** Partial requests must be checked before JSON or binary conversion loses types. */
export function validatePartialIdentityDefinition(
  identity: PartialIdentity
): void {
  requireCondition(
    identity instanceof PartialIdentity,
    "Expected a partial identity definition."
  );
  validateIdentityFields(identity, identity);
}

function validateIdentityFields(
  identity: Identity,
  partial?: PartialIdentity
): void {
  if (!partial || partial.containsVersion())
    validateIdentityVersion(identity.version);
  if (!partial || partial.containsPrimaryAddresses()) {
    validateIdentityPrimaryAddresses(identity.primaryAddresses);
  }
  if (!partial || partial.containsMinSigs()) {
    const keyCount =
      !partial || partial.containsPrimaryAddresses()
        ? identity.primaryAddresses!.length
        : undefined;
    validateIdentityThreshold(identity.minSigs, keyCount);
  }
  requireCondition(
    typeof identity.name === "string" &&
      Buffer.byteLength(identity.name, "utf8") >= 1 &&
      Buffer.byteLength(identity.name, "utf8") <= 64,
    "Identity name must contain 1 to 64 bytes."
  );

  // Updates may legitimately revoke, lock or tokenize an identity, and root
  // identities have a null parent. Registration has stricter policy checks.
  if (!partial || partial.containsFlags()) {
    requireCondition(
      BN.isBN(identity.flags) &&
        !identity.flags.isNeg() &&
        identity.flags.bitLength() <= 32,
      "Identity flags must be an unsigned 32-bit integer."
    );
  }
  if (!partial || partial.containsUnlockAfter()) {
    requireCondition(
      BN.isBN(identity.unlockAfter) &&
        !identity.unlockAfter.isNeg() &&
        identity.unlockAfter.bitLength() <= 32,
      "Identity timelock must be an unsigned 32-bit integer."
    );
  }
  if (!partial || partial.containsParent())
    validateIdentityDestination(identity.parent, "Identity parent", true);
  if (!partial || partial.containsSystemId())
    validateIdentityDestination(identity.systemId, "Identity system", true);
  if (!partial || partial.containsRevocation())
    validateIdentityDestination(
      identity.revocationAuthority,
      "Revocation authority"
    );
  if (!partial || partial.containsRecovery())
    validateIdentityDestination(
      identity.recoveryAuthority,
      "Recovery authority"
    );

  if (!partial || partial.containsContentMap()) {
    requireCondition(
      identity.contentMap instanceof Map,
      "Invalid identity content map."
    );
    for (const [key, value] of identity.contentMap) {
      const decodedKey = fromBase58Check(key);
      // PBaaS reads this map directly; only the legacy vector reader rejects a
      // null key. Multimap keys below still must be nonnull in every PBaaS ID.
      requireCondition(
        decodedKey.version === I_ADDR_VERSION &&
          decodedKey.hash.length === 20 &&
          (identity.version.gte(Identity.VERSION_PBAAS) ||
            !decodedKey.hash.equals(Buffer.alloc(20))),
        "Invalid identity content map key."
      );
      requireCondition(
        Buffer.isBuffer(value) && value.length === 32,
        "Identity content map values must contain 32 bytes."
      );
    }
  }
  if (!partial || partial.containsContentMultiMap()) {
    for (const [key, values] of identity.contentMultiMap.kvContent.entries()) {
      validAddress(key.toIAddress(), true);
      requireCondition(
        Array.isArray(values) && values.length > 0,
        "Identity content multimap keys must contain at least one value."
      );
    }
  }
  if (
    (!partial || partial.containsPrivateAddresses()) &&
    identity.privateAddresses !== undefined
  ) {
    requireCondition(
      Array.isArray(identity.privateAddresses),
      "Invalid private addresses."
    );
    for (const address of identity.privateAddresses) {
      requireCondition(
        address &&
          Buffer.isBuffer(address.d) &&
          address.d.length === 11 &&
          Buffer.isBuffer(address.pkD) &&
          address.pkD.length === 32,
        "Identity private address requires an 11-byte diversifier and 32-byte key."
      );
    }
  }
}

/** Structural checks for new update outputs; historical prevouts stay readable. */
export function validateIdentityDefinition(identity: Identity): void {
  requireCondition(
    identity instanceof Identity && !(identity instanceof PartialIdentity),
    "Identity output requires a full identity definition."
  );
  validateIdentityFields(identity);
  const serialized = identity.toBuffer();
  const decoded = new Identity();
  requireCondition(
    decoded.fromBuffer(serialized, 0, false) === serialized.length &&
      decoded.toBuffer().equals(serialized),
    "Identity requires a canonical full identity encoding."
  );
  validateIdentitySize(identity);
}
