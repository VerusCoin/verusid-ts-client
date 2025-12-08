import { BN } from "bn.js";
import { ContentMultiMap, DATA_TYPE_MMRDATA, IDENTITY_VERSION_PBAAS, IdentityID, IdentityUpdateRequestDetails, IdentityUpdateResponseDetails, KeyID, PartialIdentity, PartialMMRData, PartialSignData, PartialSignDataInitData, SaplingPaymentAddress } from "verus-typescript-primitives";
import { TEST_EXPIRY_HEIGHT, TEST_REQUEST_ID, TEST_SYSTEM_ID, TEST_TXID_RESPONSE } from "./genericenvelope";

export const TEST_CONTENTMAP = new Map();
TEST_CONTENTMAP.set("iPsFBfFoCcxtuZNzE8yxPQhXVn4dmytf8j", Buffer.alloc(32));
TEST_CONTENTMAP.set("iK7a5JNJnbeuYWVHCDRpJosj3irGJ5Qa8c", Buffer.alloc(32));

export const TEST_ID_UPDATE_PARTIAL_IDENTITY = new PartialIdentity({
  flags: new BN("0"),
  version: IDENTITY_VERSION_PBAAS,
  min_sigs: new BN(1),
  primary_addresses: [
    KeyID.fromAddress("RQVsJRf98iq8YmRQdehzRcbLGHEx6YfjdH"),
    KeyID.fromAddress("RP4Qct9197i5vrS11qHVtdyRRoAHVNJS47")
  ],
  parent: IdentityID.fromAddress("iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq"),
  system_id: IdentityID.fromAddress("iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq"),
  name: "TestID",
  content_map: TEST_CONTENTMAP,
  content_multimap: ContentMultiMap.fromJson({
    iPsFBfFoCcxtuZNzE8yxPQhXVn4dmytf8j: [
      { iK7a5JNJnbeuYWVHCDRpJosj3irGJ5Qa8c: 'Test String 123454321' },
      { iK7a5JNJnbeuYWVHCDRpJosj3irGJ5Qa8c: 'Test String 123454321' },
      { iK7a5JNJnbeuYWVHCDRpJosj3irGJ5Qa8c: 'Test String 123454321' },
      { iK7a5JNJnbeuYWVHCDRpJosj3irGJ5Qa8c: 'Test String 123454321' }
    ],
    iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq: '6868686868686868686868686868686868686868',
    i5v3h9FWVdRFbNHU7DfcpGykQjRaHtMqu7: [
      '6868686868686868686868686868686868686868',
      '6868686868686868686868686868686868686868',
      '6868686868686868686868686868686868686868'
    ],
    i81XL8ZpuCo9jmWLv5L5ikdxrGuHrrpQLz: { iK7a5JNJnbeuYWVHCDRpJosj3irGJ5Qa8c: 'Test String 123454321' }
  }),
  recovery_authority: IdentityID.fromAddress("i81XL8ZpuCo9jmWLv5L5ikdxrGuHrrpQLz"),
  revocation_authority: IdentityID.fromAddress("i5v3h9FWVdRFbNHU7DfcpGykQjRaHtMqu7"),
  unlock_after: new BN("123456", 10),
  private_addresses: [SaplingPaymentAddress.fromAddressString("zs1wczplx4kegw32h8g0f7xwl57p5tvnprwdmnzmdnsw50chcl26f7tws92wk2ap03ykaq6jyyztfa")]
});

export const TEST_ID_UPDATE_MMR_DATA = new PartialMMRData({
  flags: new BN('0', 10),
  data: [
    { type: new BN('2', 10), data: Buffer.from('src/__tests__/pbaas/partialmmrdata.test.ts', 'utf-8') },
    { type: new BN('3', 10), data: Buffer.from('Hello test message 12345', 'utf-8') },
  ],
  salt: [Buffer.from('=H319X:)@H2Z'), Buffer.from('s*1UHmVr?feI')],
  mmrhashtype: new BN('1', 10), // e.g. PartialMMRData.HASH_TYPE_SHA256
  priormmr: [
    Buffer.from('80a28cdff6bd91a2e96a473c234371fd8b67705a8c4956255ce7b8c7bf20470f02381c9a935f06cdf986a7c5facd77625befa11cf9fd4b59857b457394a8af979ab2830087a3b27041b37bc318484175'),
    Buffer.from('d97fd4bbd9e88ca0c5822c12d5c9b272b2044722aa48b1c8fde178be6b59ccea509f403d3acd226c16ba3c32f0cb92e2fcaaa02b40d0bc5257e0fbf2e6c3d3d7f1a1df066967b193d131158ba5bef732')
  ],
})

export const TEST_ID_UPDATE_SIGNDATA_MMR: PartialSignDataInitData = {
  flags: new BN('0', 10),
  address: IdentityID.fromAddress('iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq'),
  prefixString: Buffer.from('example prefix', 'utf8'),
  vdxfKeys: [IdentityID.fromAddress('i81XL8ZpuCo9jmWLv5L5ikdxrGuHrrpQLz')],
  vdxfKeyNames: [Buffer.from('VDXFNAME', 'utf8')],
  boundHashes: [Buffer.from('0873c6ba879ce87f5c207a4382b273cac164361af0b9fe63d6d7b0d7af401fec', 'hex'), Buffer.from('0873c6ba879ce87f5c207a4382b273cac164361af0b9fe63d6d7b0d7af401fec', 'hex')],
  hashType: new BN('1', 10),
  encryptToAddress: SaplingPaymentAddress.fromAddressString(
    'zs1wczplx4kegw32h8g0f7xwl57p5tvnprwdmnzmdnsw50chcl26f7tws92wk2ap03ykaq6jyyztfa'
  ),
  createMMR: true,
  signature: Buffer.from('AeNjMwABQSAPBEuajDkRyy+OBJsWmDP3EUoqN9UjCJK9nmoSQiNoZWBK19OgGCYdEqr1CiFfBf8SFHVoUv4r2tb5Q3qsMTrp', 'base64'),
  dataType: DATA_TYPE_MMRDATA,
  data: TEST_ID_UPDATE_MMR_DATA, // This is the PartialMMRData object
}

export const TEST_ID_UPDATE_SIGNDATA_MAP = new Map();
TEST_ID_UPDATE_SIGNDATA_MAP.set("iBvyi1nuCrTA4g44xN9N7EU1t6a7gwb4h8", new PartialSignData(TEST_ID_UPDATE_SIGNDATA_MMR))

export const TEST_ID_UPDATE_REQUEST_DETAILS = new IdentityUpdateRequestDetails({
  requestID: TEST_REQUEST_ID,
  systemID: TEST_SYSTEM_ID,
  identity: TEST_ID_UPDATE_PARTIAL_IDENTITY,
  expiryHeight: TEST_EXPIRY_HEIGHT,
  signDataMap: TEST_ID_UPDATE_SIGNDATA_MAP
});

export const TEST_ID_UPDATE_TXID_BUF = Buffer.from(TEST_TXID_RESPONSE, 'hex').reverse();

export const TEST_ID_UPDATE_RESPONSE_DETAILS = new IdentityUpdateResponseDetails({
  requestID: TEST_REQUEST_ID,
  txid: TEST_ID_UPDATE_TXID_BUF
});