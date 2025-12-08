import { BN } from "bn.js";
import { CompactAddressObject, IdentityID, VerifiableSignatureDataInterface } from "verus-typescript-primitives";
import { TEST_ID } from "./verusid";

export const TEST_SYSTEM_ID = IdentityID.fromAddress("iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq");
export const TEST_REQUEST_ID = "iPsFBfFoCcxtuZNzE8yxPQhXVn4dmytf8j"
export const TEST_CREATED_AT = new BN("1700000000", 10);
export const TEST_EXPIRY_HEIGHT = new BN("123456");
export const TEST_SALT = Buffer.from('=H319X:)@H2Z');
export const TEST_TXID_RESPONSE = "2474d2c7b3586cedd8bf7f4a9af7c26e794ea2fc44853f17a30148e2ed857a95";

export const TEST_UNSIGNED_VERIFIABLE_SIG_DATA: VerifiableSignatureDataInterface = {
  systemID: CompactAddressObject.fromIAddress(TEST_SYSTEM_ID.toAddress()!),
  identityID: CompactAddressObject.fromIAddress(TEST_ID.identity.identityaddress)
}

export const TEST_SAPLING_ADDR = "zs1wczplx4kegw32h8g0f7xwl57p5tvnprwdmnzmdnsw50chcl26f7tws92wk2ap03ykaq6jyyztfa"