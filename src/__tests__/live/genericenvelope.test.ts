import { VerusIdInterface } from '../../index'
import { TEST_ID, VERUSTEST_I_ADDR } from '../fixtures/verusid';
import {
  GenericRequest,
  GenericResponse,
  IdentityUpdateRequestOrdinalVDXFObject,
  IdentityUpdateResponseOrdinalVDXFObject,
  OrdinalVDXFObject,
  SaplingPaymentAddress
} from 'verus-typescript-primitives';
import { VerifiableSignatureData } from 'verus-typescript-primitives/dist/vdxf/classes/VerifiableSignatureData';
import { TEST_CREATED_AT, TEST_SALT, TEST_SAPLING_ADDR, TEST_UNSIGNED_VERIFIABLE_SIG_DATA } from '../fixtures/genericenvelope';
import { TEST_ID_UPDATE_REQUEST_DETAILS, TEST_ID_UPDATE_RESPONSE_DETAILS } from '../fixtures/identityupdate';

describe('Creates and identity update requests', () => {
  const VerusId = new VerusIdInterface("VRSCTEST", "127.0.0.1");

  async function testGenericRequest(details: Array<OrdinalVDXFObject>) {
    const req = await VerusId.createGenericRequest(
      {
        createdAt: TEST_CREATED_AT,
        salt: TEST_SALT,
        encryptResponseToAddress: SaplingPaymentAddress.fromAddressString(TEST_SAPLING_ADDR),
        details: details,
        signature: new VerifiableSignatureData(TEST_UNSIGNED_VERIFIABLE_SIG_DATA)
      },
      "UrEJQMk9PD4Fo9i8FNb1ZSFRrC9TrD4j6CGbFvbFHVH83bStroHH",
      TEST_ID,
      18167,
      VERUSTEST_I_ADDR
    );

    const verifImmediate = await VerusId.verifyGenericRequest(
      req,
      TEST_ID,
      VERUSTEST_I_ADDR,
      TEST_CREATED_AT.toNumber()
    );

    expect(verifImmediate).toBe(true);

    const verif = await VerusId.verifyGenericRequest(
      GenericRequest.fromWalletDeeplinkUri(req.toWalletDeeplinkUri()),
      TEST_ID,
      VERUSTEST_I_ADDR,
      TEST_CREATED_AT.toNumber()
    );

    expect(verif).toBe(true)
  }

  async function testGenericResponse(details: Array<OrdinalVDXFObject>) {
    const reqHash = Buffer.from("a5b4749f931a2f91c804209c822f76071fcca2751179d8859c38a75a4f94bfbc", 'hex');

    const res = await VerusId.createGenericResponse(
      {
        createdAt: TEST_CREATED_AT,
        salt: TEST_SALT,
        details: details,
        requestHash: reqHash,
        signature: new VerifiableSignatureData(TEST_UNSIGNED_VERIFIABLE_SIG_DATA)
      },
      "UrEJQMk9PD4Fo9i8FNb1ZSFRrC9TrD4j6CGbFvbFHVH83bStroHH",
      TEST_ID,
      18167,
      VERUSTEST_I_ADDR
    );

    const verifImmediate = await VerusId.verifyGenericResponse(
      res,
      TEST_ID,
      VERUSTEST_I_ADDR,
      TEST_CREATED_AT.toNumber()
    );

    expect(verifImmediate).toBe(true);

    const resBuffer = res.toBuffer();
    const resFromBuf = new GenericResponse();
    resFromBuf.fromBuffer(resBuffer);

    const verif = await VerusId.verifyGenericResponse(
      resFromBuf,
      TEST_ID,
      VERUSTEST_I_ADDR,
      TEST_CREATED_AT.toNumber()
    );

    expect(verif).toBe(true)
  }

  test('can sign and verify basic identity update request', async () => {
    testGenericResponse([new IdentityUpdateRequestOrdinalVDXFObject({ data: TEST_ID_UPDATE_REQUEST_DETAILS })]);
  });

  test('can sign and verify basic identity update response', async () => {
    testGenericRequest([new IdentityUpdateResponseOrdinalVDXFObject({ data: TEST_ID_UPDATE_RESPONSE_DETAILS })]);
  });
});
