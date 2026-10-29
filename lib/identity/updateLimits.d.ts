/** Leave room below the daemon's 2 MB consensus ceiling and block limit. */
export declare const MAX_IDENTITY_UPDATE_TRANSACTION_BYTES = 1800000;
/** Bound supplied templates while allowing the daemon's next-block + 20 expiry. */
export declare const MAX_IDENTITY_UPDATE_EXPIRY_DELTA = 40;
/** Relay requires expiry >= next block + TX_EXPIRING_SOON_THRESHOLD (3). */
export declare const MIN_IDENTITY_UPDATE_EXPIRY_DELTA = 4;
/** Check retained templates, funded transactions, and the final signed bytes. */
export declare function validateIdentityUpdateTransactionSize(hex: string): void;
