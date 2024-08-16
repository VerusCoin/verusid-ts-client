import { VerusIdInterface } from '../../index'
import { TEST_ID, VERUSTEST_I_ADDR } from '../fixtures/verusid';

describe('Makes live API Verusd RPC calls', () => {
  const VerusId = new VerusIdInterface("VRSCTEST", "https://api.verus.services")

  test('can sign and verify basic message', async () => {
    const sig = await VerusId.signMessage(
      "i8jHXEEYEQ7KEoYe6eKXBib8cUBZ6vjWSd",
      "signedmessage",
      "UrEJQMk9PD4Fo9i8FNb1ZSFRrC9TrD4j6CGbFvbFHVH83bStroHH",
      TEST_ID,
      18167,
      VERUSTEST_I_ADDR
    )

    expect(sig).toBe(
      "AgX3RgAAAUEgkH849JQVsiFEJeg33Zxdakm2Ty6aNthhq1aptFliLLtMJDV1AiQDEhiB0ikP4EJn7VzGI3ahPMs5DC2rJLfqaQ=="
    );

    const correctVerification = await VerusId.verifyMessage(
      "i8jHXEEYEQ7KEoYe6eKXBib8cUBZ6vjWSd",
      sig,
      "signedmessage",
      TEST_ID,
      VERUSTEST_I_ADDR
    );

    expect(correctVerification).toBe(true);
  });

  test('it rejects incorrect signature', async () => {
    const incorrectVerification = await VerusId.verifyMessage(
      "i8jHXEEYEQ7KEoYe6eKXBib8cUBZ6vjWSd",
      "AfdGAAABQR/LWEju39WoEBsEmkzWLIoCjvGUhDkom/exPHNytst+vnYgBy7+z+eUOV5jFr5atSUkADYST7V2Ji0nxrg8C0Vv",
      "signedmessage",
      TEST_ID,
      VERUSTEST_I_ADDR
    );

    expect(incorrectVerification).toBe(false);
  })
});
