import { VerusIdInterface, primitives } from '../../index'
import { TEST_ID, VERUSTEST_I_ADDR } from '../fixtures/verusid';
import {
  ECPair,
  networks
} from "@bitgo/utxo-lib";
import { LoginConsentProvisioningChallenge, LoginConsentProvisioningResponse, LoginConsentProvisioningResult, LoginConsentResponse, LOGIN_CONSENT_PROVISIONING_ERROR_KEY_CREATION_FAILED, LOGIN_CONSENT_PROVISIONING_RESULT_STATE_FAILED } from 'verus-typescript-primitives';

describe('Creates and validates login consent requests', () => {
  const VerusId = new VerusIdInterface("VRSCTEST", "https://api.verus.services")

  test('can sign and verify basic login consent request', async () => {
    const req = await VerusId.createLoginConsentRequest(
      "i8jHXEEYEQ7KEoYe6eKXBib8cUBZ6vjWSd",
      new primitives.LoginConsentChallenge({
        challenge_id: "iKNufKJdLX3Xg8qFru9AuLBvivAEJ88PW4",
        requested_access: [
          new primitives.RequestedPermission(primitives.IDENTITY_VIEW.vdxfid),
        ],
        redirect_uris: [
          new primitives.RedirectUri(
            "127.0.0.1",
            primitives.LOGIN_CONSENT_REDIRECT_VDXF_KEY.vdxfid
          ),
        ],
        created_at: 1527992841,
      }),
      "UrEJQMk9PD4Fo9i8FNb1ZSFRrC9TrD4j6CGbFvbFHVH83bStroHH",
      TEST_ID,
      18167,
      VERUSTEST_I_ADDR
    );

    const res = await VerusId.createLoginConsentResponse(
      "i8jHXEEYEQ7KEoYe6eKXBib8cUBZ6vjWSd",
      new primitives.LoginConsentDecision({
        decision_id: "iKNufKJdLX3Xg8qFru9AuLBvivAEJ88PW4",
        request: req,
        created_at: 1527992841,
      }),
      "UrEJQMk9PD4Fo9i8FNb1ZSFRrC9TrD4j6CGbFvbFHVH83bStroHH",
      TEST_ID,
      18167,
      VERUSTEST_I_ADDR
    );

    expect(await VerusId.verifyLoginConsentRequest(
      primitives.LoginConsentRequest.fromWalletDeeplinkUri(req.toWalletDeeplinkUri()),
      TEST_ID,
      VERUSTEST_I_ADDR
    )).toBe(true)

    const _res = new LoginConsentResponse()
    _res.fromBuffer(res.toBuffer())

    expect(await VerusId.verifyLoginConsentResponse(
      _res,
      TEST_ID,
      VERUSTEST_I_ADDR
    )).toBe(true)
  });

  test('can sign and verify basic provisioning request', async () => {
    const wif = "UrEJQMk9PD4Fo9i8FNb1ZSFRrC9TrD4j6CGbFvbFHVH83bStroHH"
    const keyPair = ECPair.fromWIF(wif, networks.verustest)

    const req = await VerusIdInterface.createVerusIdProvisioningRequest(
      keyPair.getAddress(),
      new LoginConsentProvisioningChallenge({
        challenge_id: "iKNufKJdLX3Xg8qFru9AuLBvivAEJ88PW4",
        created_at: 1664382484,
        salt: "i6NawEzHMocZnU4h8pPkGpHApvsrHjxwXE",
        context: new primitives.Context({
          ["i4KyLCxWZXeSkw15dF95CUKytEK3HU7em9"]: "test",
        }),
        name: "😊",
        system_id: "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV",
        parent: "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV"
      }),
      wif
    );

    const res = await VerusId.createVerusIdProvisioningResponse(
      "i8jHXEEYEQ7KEoYe6eKXBib8cUBZ6vjWSd",
      new primitives.LoginConsentProvisioningDecision({
        decision_id: "iKNufKJdLX3Xg8qFru9AuLBvivAEJ88PW4",
        created_at: 1664246317,
        result: new LoginConsentProvisioningResult({
          state: LOGIN_CONSENT_PROVISIONING_RESULT_STATE_FAILED.vdxfid,
          error_key:
            LOGIN_CONSENT_PROVISIONING_ERROR_KEY_CREATION_FAILED.vdxfid,
          error_desc: "Failed to create ID",
          identity_address: "i8jHXEEYEQ7KEoYe6eKXBib8cUBZ6vjWSd",
          system_id: "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV",
          fully_qualified_name: "test.verus",
          parent: "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV",
          info_uri: "127.0.0.1",
          provisioning_txids: [
            new primitives.ProvisioningTxid(
              "f5a68faabd7f89bfe8e634c06cce85dfeb068f7320f8f342626e85a489cc2fa2",
              primitives.IDENTITY_UPDATE_TXID.vdxfid
            ),
          ],
        }),
        request: req,
      }),
      "UrEJQMk9PD4Fo9i8FNb1ZSFRrC9TrD4j6CGbFvbFHVH83bStroHH",
      TEST_ID,
      18167,
      VERUSTEST_I_ADDR
    );

    const reqVerification =
      await VerusIdInterface.verifyVerusIdProvisioningRequest(
        req,
        keyPair.getAddress()
      );

    expect(reqVerification).toBe(true)

    const _res = new LoginConsentProvisioningResponse()
    _res.fromBuffer(res.toBuffer())

    expect(await VerusId.verifyVerusIdProvisioningResponse(
      _res,
      TEST_ID,
      VERUSTEST_I_ADDR
    )).toBe(true)

    req.signature!.signature = "IL++d7Xu/eS5KtXNvWcgC8sIs1zXQlr4kvDYIsNbEWD4QdElPU1zZcyDeYr1upFVzRbD0C8oilh0dW4kH057OJ0="

    const incorrectVerification =
      await VerusIdInterface.verifyVerusIdProvisioningRequest(
        req,
        keyPair.getAddress()
      );

    expect(incorrectVerification).toBe(false)
  });
});
