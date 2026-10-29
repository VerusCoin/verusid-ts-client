"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIN_IDENTITY_UPDATE_EXPIRY_DELTA = exports.MAX_IDENTITY_UPDATE_EXPIRY_DELTA = exports.MAX_IDENTITY_UPDATE_TRANSACTION_BYTES = exports.MAX_LOCAL_IDENTITY_UPLOAD_ITEMS = exports.MAX_LOCAL_IDENTITY_UPLOAD_OUTPUT_BYTES = exports.MAX_LOCAL_IDENTITY_UPLOAD_BYTES = exports.verifyIdentityUpdateData = exports.verifyIdentityUpdateFunding = exports.primitives = exports.VerusIdInterface = exports.verifyIdentityRegistrationFunding = exports.verifyRegistrationFunding = exports.RegistrationError = void 0;
const VerusIdInterface_1 = __importDefault(require("./VerusIdInterface"));
exports.VerusIdInterface = VerusIdInterface_1.default;
const primitives = __importStar(require("verus-typescript-primitives"));
exports.primitives = primitives;
var registrationPolicy_1 = require("./identity/registrationPolicy");
Object.defineProperty(exports, "RegistrationError", { enumerable: true, get: function () { return registrationPolicy_1.RegistrationError; } });
var registrationFundingVerification_1 = require("./identity/registrationFundingVerification");
Object.defineProperty(exports, "verifyRegistrationFunding", { enumerable: true, get: function () { return registrationFundingVerification_1.verifyRegistrationFunding; } });
Object.defineProperty(exports, "verifyIdentityRegistrationFunding", { enumerable: true, get: function () { return registrationFundingVerification_1.verifyIdentityRegistrationFunding; } });
var updateFundingVerification_1 = require("./identity/updateFundingVerification");
Object.defineProperty(exports, "verifyIdentityUpdateFunding", { enumerable: true, get: function () { return updateFundingVerification_1.verifyIdentityUpdateFunding; } });
var updateDataVerification_1 = require("./identity/updateDataVerification");
Object.defineProperty(exports, "verifyIdentityUpdateData", { enumerable: true, get: function () { return updateDataVerification_1.verifyIdentityUpdateData; } });
var localUpdateData_1 = require("./identity/localUpdateData");
Object.defineProperty(exports, "MAX_LOCAL_IDENTITY_UPLOAD_BYTES", { enumerable: true, get: function () { return localUpdateData_1.MAX_LOCAL_IDENTITY_UPLOAD_BYTES; } });
Object.defineProperty(exports, "MAX_LOCAL_IDENTITY_UPLOAD_OUTPUT_BYTES", { enumerable: true, get: function () { return localUpdateData_1.MAX_LOCAL_IDENTITY_UPLOAD_OUTPUT_BYTES; } });
Object.defineProperty(exports, "MAX_LOCAL_IDENTITY_UPLOAD_ITEMS", { enumerable: true, get: function () { return localUpdateData_1.MAX_LOCAL_IDENTITY_UPLOAD_ITEMS; } });
var updateLimits_1 = require("./identity/updateLimits");
Object.defineProperty(exports, "MAX_IDENTITY_UPDATE_TRANSACTION_BYTES", { enumerable: true, get: function () { return updateLimits_1.MAX_IDENTITY_UPDATE_TRANSACTION_BYTES; } });
Object.defineProperty(exports, "MAX_IDENTITY_UPDATE_EXPIRY_DELTA", { enumerable: true, get: function () { return updateLimits_1.MAX_IDENTITY_UPDATE_EXPIRY_DELTA; } });
Object.defineProperty(exports, "MIN_IDENTITY_UPDATE_EXPIRY_DELTA", { enumerable: true, get: function () { return updateLimits_1.MIN_IDENTITY_UPDATE_EXPIRY_DELTA; } });
