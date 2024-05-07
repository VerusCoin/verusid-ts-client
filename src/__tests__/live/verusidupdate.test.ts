import { BigNumber, IDENTITY_FLAG_REVOKED, Identity } from 'verus-typescript-primitives';
import { VerusIdInterface } from '../../index'
import { TEST_ID, TEST_UTXOS, TEST_ID_2, TEST_ID_2_RAW_TX, VERUSTEST_I_ADDR, TEST_ID_2_FUNDED_UPDATE, TEST_ID_2_UPDATE_NO_CHANGE, TEST_ID_3, TEST_UTXOS_TEST_ID_3, TEST_ID_3_FUNDRAWTX_RES, TEST_ID_3_RAW_TX, TEST_ID_3_RECOVERY_REVOKE_WIF, TEST_ID_3_SIGNED_TX, TEST_UTXOS_REVOKE_TEST_ID_3, TEST_ID_3_REVOKE_FUNDRAWTX_RES, TEST_ID_3_REVOKE, TEST_ID_3_REVOKE_RAW_TX, TEST_ID_3_REVOKE_SIGNED_TX } from '../fixtures/verusid';

describe('Creates VerusID update transactions', () => {
  const VerusId = new VerusIdInterface(VERUSTEST_I_ADDR, "http://localhost")

  test('can create basic identity update tx', async () => {
    const res = await VerusId.createUpdateIdentityTransaction(
      Identity.fromJson(TEST_ID_2.identity),
      TEST_ID_2.identity.primaryaddresses[0],
      TEST_UTXOS,
      VERUSTEST_I_ADDR,
      0.0001,
      TEST_ID_2_FUNDED_UPDATE,
      TEST_ID_2,
      TEST_ID_2_RAW_TX,
      18167
    );

    expect(res.hex).toEqual(TEST_ID_2_UPDATE_NO_CHANGE);
  });

  test('can create and sign basic identity update tx', async () => {
    const res = await VerusId.createUpdateIdentityTransaction(
      Identity.fromJson(TEST_ID_3.identity),
      TEST_ID_3.identity.primaryaddresses[0],
      TEST_UTXOS_TEST_ID_3,
      VERUSTEST_I_ADDR,
      0.0001,
      TEST_ID_3_FUNDRAWTX_RES,
      TEST_ID_3,
      TEST_ID_3_RAW_TX,
      31677
    );

    const signedTx = VerusId.signUpdateIdentityTransaction(res.hex, res.utxos, [[TEST_ID_3_RECOVERY_REVOKE_WIF], [TEST_ID_3_RECOVERY_REVOKE_WIF]]);

    expect(signedTx).toEqual(TEST_ID_3_SIGNED_TX);
  });

  test('can create and sign basic revoke identity tx', async () => {
    const identity = Identity.fromJson(TEST_ID_3_REVOKE.identity);
    identity.flags = identity.flags.xor(IDENTITY_FLAG_REVOKED);
    
    const res = await VerusId.createUpdateIdentityTransaction(
      identity,
      TEST_ID_3_REVOKE.identity.primaryaddresses[0],
      TEST_UTXOS_REVOKE_TEST_ID_3,
      VERUSTEST_I_ADDR,
      0.0001,
      TEST_ID_3_REVOKE_FUNDRAWTX_RES,
      TEST_ID_3_REVOKE,
      TEST_ID_3_REVOKE_RAW_TX,
      33084
    );

    const signedTx = VerusId.signUpdateIdentityTransaction(res.hex, res.utxos, [[TEST_ID_3_RECOVERY_REVOKE_WIF], [TEST_ID_3_RECOVERY_REVOKE_WIF]]);

    expect(signedTx).toEqual(TEST_ID_3_REVOKE_SIGNED_TX);
  });
});
