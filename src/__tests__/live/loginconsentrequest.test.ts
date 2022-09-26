import { IDENTITY_VIEW, LoginConsentRequest, LOGIN_CONSENT_REDIRECT_VDXF_KEY } from 'verus-typescript-primitives';
import { RedirectUri } from 'verus-typescript-primitives/dist/vdxf/classes/Challenge';
import { VerusIdInterface } from '../../index'
import { TEST_ID, VERUSTEST_I_ADDR } from '../fixtures/verusid';

describe('Creates and validates login consent requests', () => {
  const VerusId = new VerusIdInterface("VRSCTEST", "https://api.verus.services")

  test('can sign and verify basic login consent request', async () => {
    const req = await VerusId.createLoginConsentRequest(
      "i8jHXEEYEQ7KEoYe6eKXBib8cUBZ6vjWSd",
      {
        challenge_id: "92e8jf9828fj8hngh2eng2eg",
        requested_access: [IDENTITY_VIEW.vdxfid],
        redirect_uris: [
          new RedirectUri("127.0.0.1", LOGIN_CONSENT_REDIRECT_VDXF_KEY.vdxfid),
        ],
        created_at: "1664206317"
      },
      "UrEJQMk9PD4Fo9i8FNb1ZSFRrC9TrD4j6CGbFvbFHVH83bStroHH",
      TEST_ID,
      18167,
      VERUSTEST_I_ADDR
    );

    expect(await VerusId.verifyLoginConsentRequest(
      LoginConsentRequest.fromWalletDeeplinkUri(req.toWalletDeeplinkUri()),
      TEST_ID,
      VERUSTEST_I_ADDR
    )).toBe(true)
  });
});
