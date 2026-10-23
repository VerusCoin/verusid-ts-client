import { requireCondition } from "./fundingPrimitives";

/** Leave room below the daemon's 2 MB consensus ceiling and block limit. */
export const MAX_IDENTITY_UPDATE_TRANSACTION_BYTES = 1800000;
/** Bound supplied templates while allowing the daemon's next-block + 20 expiry. */
export const MAX_IDENTITY_UPDATE_EXPIRY_DELTA = 40;
/** Relay requires expiry >= next block + TX_EXPIRING_SOON_THRESHOLD (3). */
export const MIN_IDENTITY_UPDATE_EXPIRY_DELTA = 4;

/** Check retained templates, funded transactions, and the final signed bytes. */
export function validateIdentityUpdateTransactionSize(hex: string): void {
  requireCondition(
    typeof hex === "string" &&
      hex.length % 2 === 0 &&
      /^[0-9a-f]+$/i.test(hex) &&
      hex.length / 2 <= MAX_IDENTITY_UPDATE_TRANSACTION_BYTES,
    "Identity update exceeds the application transaction size limit or has invalid encoding."
  );
}
