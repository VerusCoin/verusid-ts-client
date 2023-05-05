import { VerusIdInterface, primitives } from '../../index'
import { TEST_ID, VERUSTEST_I_ADDR } from '../fixtures/verusid';

describe('Creates and validates signed session objectes', () => {
  const VerusId = new VerusIdInterface("VRSCTEST", "https://api.verus.services")

  test('can sign and verify basic signed session object', async () => {
    const obj = await VerusId.createSignedSessionObject(
      "i8jHXEEYEQ7KEoYe6eKXBib8cUBZ6vjWSd",
      new primitives.SignedSessionObjectData({
        session_id: "i8jHXEEYEQ7KEoYe6eKXBib8cUBZ6vjWSd",
        timestamp_micro: 320492835,
        body: "test body"
      }),
      "UrEJQMk9PD4Fo9i8FNb1ZSFRrC9TrD4j6CGbFvbFHVH83bStroHH",
      TEST_ID,
      18167,
      VERUSTEST_I_ADDR
    );

    expect(await VerusId.verifySignedSessionObject(
      new primitives.SignedSessionObject({
        system_id: VERUSTEST_I_ADDR,
        signature: obj.signature,
        signing_id: "i8jHXEEYEQ7KEoYe6eKXBib8cUBZ6vjWSd",
        data: new primitives.SignedSessionObjectData({
          session_id: "i8jHXEEYEQ7KEoYe6eKXBib8cUBZ6vjWSd",
          timestamp_micro: 320492835,
          body: "test body"
        })
      }),
      TEST_ID,
      VERUSTEST_I_ADDR
    )).toBe(true)

    expect(await VerusId.verifySignedSessionObject(
      new primitives.SignedSessionObject({
        system_id: VERUSTEST_I_ADDR,
        signature: obj.signature,
        signing_id: "i8jHXEEYEQ7KEoYe6eKXBib8cUBZ6vjWSd",
        data: new primitives.SignedSessionObjectData({
          session_id: "i8jHXEEYEQ7KEoYe6eKXBib8cUBZ6vjWSd",
          timestamp_micro: 320492835,
          body: "test body not signed"
        })
      }),
      TEST_ID,
      VERUSTEST_I_ADDR
    )).toBe(false)
  });
});
