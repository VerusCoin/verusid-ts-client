import { Identity, PartialIdentity } from "verus-typescript-primitives";
/** Check before upgrading, which otherwise also promotes invalid old versions. */
export declare function validateIdentityVersion(version: Identity["version"]): void;
/** Check before serializing: primary address types are lost in the wire format. */
export declare function validateIdentityPrimaryAddresses(keys: Identity["primaryAddresses"], minSigs?: Identity["minSigs"]): void;
/** The daemon cannot serialize a multimap key with zero values. Copy first. */
export declare function dropEmptyIdentityContent(identity: Identity): void;
/** PrecheckIdentityPrimary measures this export wrapper, not just the identity. */
export declare function validateIdentitySize(identity: Identity): void;
/** Partial requests must be checked before JSON or binary conversion loses types. */
export declare function validatePartialIdentityDefinition(identity: PartialIdentity): void;
/** Structural checks for new update outputs; historical prevouts stay readable. */
export declare function validateIdentityDefinition(identity: Identity): void;
