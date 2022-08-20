"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const verusd_rpc_ts_client_1 = require("verusd-rpc-ts-client");
const VRSC_I_ADDRESS = "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV";
class VerusIdInterface {
    constructor(chain, baseURL, config) {
        this.interface = new verusd_rpc_ts_client_1.VerusdRpcInterface(chain, baseURL, config);
    }
    signMessage(iAddrOrIdentity, message, primaryAddrWif) {
        return __awaiter(this, void 0, void 0, function* () {
            const _idres = yield this.interface.getIdentity(iAddrOrIdentity);
            const _infores = yield this.interface.getInfo();
            if (_idres.error)
                throw new Error(_idres.error.message);
            if (_infores.error)
                throw new Error(_infores.error.message);
            const identity = _idres.result;
            const info = _infores.result;
            let chainId;
            if (this.interface.chain === "VRSC") {
                chainId = VRSC_I_ADDRESS;
            }
            else {
                const _currres = yield this.interface.getCurrency(this.interface.chain);
                if (_currres.error)
                    throw new Error(_currres.error.message);
                chainId = _currres.result;
            }
        });
    }
}
exports.default = VerusIdInterface;
