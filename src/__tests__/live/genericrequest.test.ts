import { VerusIdInterface } from '../../index'
import { TEST_ID, VERUSTEST_I_ADDR } from '../fixtures/verusid';
import {
  AppEncryptionRequestOrdinalVDXFObject,
  AuthenticationRequestOrdinalVDXFObject,
  IdentityUpdateRequestOrdinalVDXFObject,
  IdentityUpdateResponseOrdinalVDXFObject,
  OrdinalVDXFObject,
  ProvisionIdentityDetailsOrdinalVDXFObject,
  VerusPayInvoiceDetails,
  VerusPayInvoiceDetailsOrdinalVDXFObject
} from 'verus-typescript-primitives';
import { VerifiableSignatureData } from 'verus-typescript-primitives/dist/vdxf/classes/VerifiableSignatureData';
import { TEST_CREATED_AT, TEST_SALT, TEST_SYSTEM_ID, TEST_UNSIGNED_VERIFIABLE_SIG_DATA } from '../fixtures/genericenvelope';
import { TEST_ID_UPDATE_REQUEST_DETAILS, TEST_ID_UPDATE_RESPONSE_DETAILS } from '../fixtures/identityupdate';

describe('verifyGenericRequest details validation', () => {
  const VerusId = new VerusIdInterface("VRSCTEST", "127.0.0.1");

  async function createSignedRequest(details: Array<OrdinalVDXFObject>) {
    return VerusId.createGenericRequest(
      {
        createdAt: TEST_CREATED_AT,
        salt: TEST_SALT,
        details: details,
        signature: new VerifiableSignatureData(TEST_UNSIGNED_VERIFIABLE_SIG_DATA)
      },
      "UrEJQMk9PD4Fo9i8FNb1ZSFRrC9TrD4j6CGbFvbFHVH83bStroHH",
      TEST_ID,
      18167,
      VERUSTEST_I_ADDR
    );
  }

  function makeInvoiceDetail() {
    const invoiceDetails = new VerusPayInvoiceDetails({
      requestedcurrencyid: TEST_SYSTEM_ID.toAddress()!
    });
    invoiceDetails.setFlags({ acceptsAnyAmount: true, acceptsAnyDestination: true });
    return new VerusPayInvoiceDetailsOrdinalVDXFObject({ data: invoiceDetails });
  }

  test('rejects AuthenticationRequest not at index 0', async () => {
    const req = await createSignedRequest([
      new IdentityUpdateResponseOrdinalVDXFObject({ data: TEST_ID_UPDATE_RESPONSE_DETAILS }),
      new AuthenticationRequestOrdinalVDXFObject()
    ]);

    const ok = await VerusId.verifyGenericRequest(
      req,
      TEST_ID,
      VERUSTEST_I_ADDR,
      TEST_CREATED_AT.toNumber()
    );

    expect(ok).toBe(false);
  });

  test('rejects multiple AuthenticationRequest objects', async () => {
    const req = await createSignedRequest([
      new AuthenticationRequestOrdinalVDXFObject(),
      new AuthenticationRequestOrdinalVDXFObject()
    ]);

    const ok = await VerusId.verifyGenericRequest(
      req,
      TEST_ID,
      VERUSTEST_I_ADDR,
      TEST_CREATED_AT.toNumber()
    );

    expect(ok).toBe(false);
  });

  test('rejects ProvisionIdentityDetails without AuthenticationRequest', async () => {
    const req = await createSignedRequest([
      new ProvisionIdentityDetailsOrdinalVDXFObject()
    ]);

    const ok = await VerusId.verifyGenericRequest(
      req,
      TEST_ID,
      VERUSTEST_I_ADDR,
      TEST_CREATED_AT.toNumber()
    );

    expect(ok).toBe(false);
  });

  test('rejects AppEncryptionRequest without AuthenticationRequest', async () => {
    const req = await createSignedRequest([
      new AppEncryptionRequestOrdinalVDXFObject()
    ]);

    const ok = await VerusId.verifyGenericRequest(
      req,
      TEST_ID,
      VERUSTEST_I_ADDR,
      TEST_CREATED_AT.toNumber()
    );

    expect(ok).toBe(false);
  });

  test('rejects ProvisionIdentityDetails before AuthenticationRequest', async () => {
    const req = await createSignedRequest([
      new ProvisionIdentityDetailsOrdinalVDXFObject(),
      new AuthenticationRequestOrdinalVDXFObject()
    ]);

    const ok = await VerusId.verifyGenericRequest(
      req,
      TEST_ID,
      VERUSTEST_I_ADDR,
      TEST_CREATED_AT.toNumber()
    );

    expect(ok).toBe(false);
  });

  test('rejects AppEncryptionRequest before AuthenticationRequest', async () => {
    const req = await createSignedRequest([
      new AppEncryptionRequestOrdinalVDXFObject(),
      new AuthenticationRequestOrdinalVDXFObject()
    ]);

    const ok = await VerusId.verifyGenericRequest(
      req,
      TEST_ID,
      VERUSTEST_I_ADDR,
      TEST_CREATED_AT.toNumber()
    );

    expect(ok).toBe(false);
  });

  test('rejects multiple ProvisionIdentityDetails objects', async () => {
    const req = await createSignedRequest([
      new AuthenticationRequestOrdinalVDXFObject(),
      new ProvisionIdentityDetailsOrdinalVDXFObject(),
      new ProvisionIdentityDetailsOrdinalVDXFObject()
    ]);

    const ok = await VerusId.verifyGenericRequest(
      req,
      TEST_ID,
      VERUSTEST_I_ADDR,
      TEST_CREATED_AT.toNumber()
    );

    expect(ok).toBe(false);
  });

  test('rejects multiple AppEncryptionRequest objects', async () => {
    const req = await createSignedRequest([
      new AuthenticationRequestOrdinalVDXFObject(),
      new AppEncryptionRequestOrdinalVDXFObject(),
      new AppEncryptionRequestOrdinalVDXFObject()
    ]);

    const ok = await VerusId.verifyGenericRequest(
      req,
      TEST_ID,
      VERUSTEST_I_ADDR,
      TEST_CREATED_AT.toNumber()
    );

    expect(ok).toBe(false);
  });

  test('rejects IdentityUpdateRequest when not last', async () => {
    const req = await createSignedRequest([
      new IdentityUpdateRequestOrdinalVDXFObject({ data: TEST_ID_UPDATE_REQUEST_DETAILS }),
      new IdentityUpdateResponseOrdinalVDXFObject({ data: TEST_ID_UPDATE_RESPONSE_DETAILS })
    ]);

    const ok = await VerusId.verifyGenericRequest(
      req,
      TEST_ID,
      VERUSTEST_I_ADDR,
      TEST_CREATED_AT.toNumber()
    );

    expect(ok).toBe(false);
  });

  test('rejects VerusPayInvoiceDetails with IdentityUpdateRequest', async () => {
    const req = await createSignedRequest([
      makeInvoiceDetail(),
      new IdentityUpdateRequestOrdinalVDXFObject({ data: TEST_ID_UPDATE_REQUEST_DETAILS })
    ]);

    const ok = await VerusId.verifyGenericRequest(
      req,
      TEST_ID,
      VERUSTEST_I_ADDR,
      TEST_CREATED_AT.toNumber()
    );

    expect(ok).toBe(false);
  });

  test('accepts AuthenticationRequest at index 0 and IdentityUpdateRequest last', async () => {
    const req = await createSignedRequest([
      new AuthenticationRequestOrdinalVDXFObject(),
      new IdentityUpdateRequestOrdinalVDXFObject({ data: TEST_ID_UPDATE_REQUEST_DETAILS })
    ]);

    const ok = await VerusId.verifyGenericRequest(
      req,
      TEST_ID,
      VERUSTEST_I_ADDR,
      TEST_CREATED_AT.toNumber()
    );

    expect(ok).toBe(true);
  });

  test('accepts single ProvisionIdentityDetails and AppEncryptionRequest after AuthenticationRequest', async () => {
    const req = await createSignedRequest([
      new AuthenticationRequestOrdinalVDXFObject(),
      new ProvisionIdentityDetailsOrdinalVDXFObject(),
      new AppEncryptionRequestOrdinalVDXFObject()
    ]);

    const ok = await VerusId.verifyGenericRequest(
      req,
      TEST_ID,
      VERUSTEST_I_ADDR,
      TEST_CREATED_AT.toNumber()
    );

    expect(ok).toBe(true);
  });
});
