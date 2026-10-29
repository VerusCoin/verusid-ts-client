import { BN } from "bn.js";

// Capture mutable request data before RPC or callback awaits. Preserve primitive
// classes and fields: binary round-trips can normalize invalid addresses or drop
// fields assigned without updating their serialization flags.
export function snapshotUpdateRequestValue<T>(value: T): T {
  if (value == null || typeof value !== "object") return value;
  if (Buffer.isBuffer(value)) return Buffer.from(value) as T;
  if (BN.isBN(value)) return value.clone() as T;
  if (Array.isArray(value)) return value.map(snapshotUpdateRequestValue) as T;

  if (value instanceof Map) {
    return new Map(
      [...value].map(([key, entry]) => [
        snapshotUpdateRequestValue(key),
        snapshotUpdateRequestValue(entry),
      ])
    ) as T;
  }

  const copy = Object.create(Object.getPrototypeOf(value));

  for (const key of Object.keys(value)) {
    copy[key] = snapshotUpdateRequestValue((value as any)[key]);
  }

  return copy;
}
