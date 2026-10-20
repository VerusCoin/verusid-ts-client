"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.snapshotUpdateRequestValue = snapshotUpdateRequestValue;
const bn_js_1 = require("bn.js");
// Capture mutable request data before RPC or callback awaits. Preserve primitive
// classes and fields: binary round-trips can normalize invalid addresses or drop
// fields assigned without updating their serialization flags.
function snapshotUpdateRequestValue(value) {
    if (value == null || typeof value !== "object")
        return value;
    if (Buffer.isBuffer(value))
        return Buffer.from(value);
    if (bn_js_1.BN.isBN(value))
        return value.clone();
    if (Array.isArray(value))
        return value.map(snapshotUpdateRequestValue);
    if (value instanceof Map) {
        return new Map([...value].map(([key, entry]) => [
            snapshotUpdateRequestValue(key),
            snapshotUpdateRequestValue(entry),
        ]));
    }
    const copy = Object.create(Object.getPrototypeOf(value));
    for (const key of Object.keys(value)) {
        copy[key] = snapshotUpdateRequestValue(value[key]);
    }
    return copy;
}
