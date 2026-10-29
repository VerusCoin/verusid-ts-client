"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIN_IDENTITY_UPDATE_EXPIRY_DELTA = exports.MAX_IDENTITY_UPDATE_EXPIRY_DELTA = exports.MAX_IDENTITY_UPDATE_TRANSACTION_BYTES = void 0;
exports.validateIdentityUpdateTransactionSize = validateIdentityUpdateTransactionSize;
const fundingPrimitives_1 = require("./fundingPrimitives");
/** Leave room below the daemon's 2 MB consensus ceiling and block limit. */
exports.MAX_IDENTITY_UPDATE_TRANSACTION_BYTES = 1800000;
/** Bound supplied templates while allowing the daemon's next-block + 20 expiry. */
exports.MAX_IDENTITY_UPDATE_EXPIRY_DELTA = 40;
/** Relay requires expiry >= next block + TX_EXPIRING_SOON_THRESHOLD (3). */
exports.MIN_IDENTITY_UPDATE_EXPIRY_DELTA = 4;
/** Check retained templates, funded transactions, and the final signed bytes. */
function validateIdentityUpdateTransactionSize(hex) {
    (0, fundingPrimitives_1.requireCondition)(typeof hex === "string" &&
        hex.length % 2 === 0 &&
        /^[0-9a-f]+$/i.test(hex) &&
        hex.length / 2 <= exports.MAX_IDENTITY_UPDATE_TRANSACTION_BYTES, "Identity update exceeds the application transaction size limit or has invalid encoding.");
}
