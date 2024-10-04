import { BigNumber, IDENTITY_FLAG_REVOKED, Identity } from 'verus-typescript-primitives';
import { VerusIdInterface } from '../../index'
import { TEST_ID, TEST_UTXOS, TEST_ID_2, TEST_ID_2_RAW_TX, VERUSTEST_I_ADDR, TEST_ID_2_FUNDED_UPDATE, TEST_ID_2_UPDATE_NO_CHANGE, TEST_ID_3, TEST_UTXOS_TEST_ID_3, TEST_ID_3_FUNDRAWTX_RES, TEST_ID_3_RAW_TX, TEST_ID_3_RECOVERY_REVOKE_WIF, TEST_ID_3_SIGNED_TX, TEST_UTXOS_REVOKE_TEST_ID_3, TEST_ID_3_REVOKE_FUNDRAWTX_RES, TEST_ID_3_REVOKE, TEST_ID_3_REVOKE_RAW_TX, TEST_ID_3_REVOKE_SIGNED_TX, TEST_ID_3_RECOVER, TEST_ID_3_RECOVER_RAW_TX, TEST_UTXOS_RECOVER_TEST_ID_3, TEST_ID_3_RECOVER_FUNDRAWTX_RES, TEST_ID_3_RECOVER_SIGNED_TX, TEST_ID_4_RECOVER, TEST_ID_4_RECOVER_RAW_TX, TEST_UTXOS_RECOVER_TEST_ID_4, TEST_ID_4_RECOVERY_REVOKE_WIF, TEST_ID_4_RECOVER_FUNDRAWTX_RES, TEST_ID_4_RECOVER_SIGNED_TX, TEST_ID_4_RECOVERY_CHANGE_WIF } from '../fixtures/verusid';

describe('Creates VerusID update transactions', () => {
  const VerusId = new VerusIdInterface(VERUSTEST_I_ADDR, "http://localhost")

  test('can create basic identity update tx', async () => {
    const res = await VerusId.createUpdateIdentityTransaction(
      Identity.fromJson(TEST_ID_2.identity),
      TEST_ID_2.identity.primaryaddresses[0],
      TEST_ID_2_RAW_TX,
      TEST_ID_2.blockheight,
      TEST_UTXOS,
      VERUSTEST_I_ADDR,
      0.0001,
      TEST_ID_2_FUNDED_UPDATE,
      18167
    );

    expect(res.hex).toEqual(TEST_ID_2_UPDATE_NO_CHANGE);
  });

  test('can create and sign basic identity update tx', async () => {
    const res = await VerusId.createUpdateIdentityTransaction(
      Identity.fromJson(TEST_ID_3.identity),
      TEST_ID_3.identity.primaryaddresses[0],
      TEST_ID_3_RAW_TX,
      TEST_ID_3.blockheight,
      TEST_UTXOS_TEST_ID_3,
      VERUSTEST_I_ADDR,
      0.0001,
      TEST_ID_3_FUNDRAWTX_RES,
      31677
    );

    const signedTx = VerusId.signUpdateIdentityTransaction(res.hex, res.utxos, [[TEST_ID_3_RECOVERY_REVOKE_WIF], [TEST_ID_3_RECOVERY_REVOKE_WIF]]);

    expect(signedTx).toEqual(TEST_ID_3_SIGNED_TX);
  });

  test('can create and sign basic revoke identity tx', async () => {
    const identity = Identity.fromJson(TEST_ID_3_REVOKE.identity);
    
    const res = await VerusId.createRevokeIdentityTransaction(
      identity,
      TEST_ID_3_REVOKE.identity.primaryaddresses[0],
      TEST_ID_3_REVOKE_RAW_TX,
      TEST_ID_3_REVOKE.blockheight,
      TEST_UTXOS_REVOKE_TEST_ID_3,
      VERUSTEST_I_ADDR,
      0.0001,
      TEST_ID_3_REVOKE_FUNDRAWTX_RES,
      33084
    );

    const signedTx = VerusId.signUpdateIdentityTransaction(res.hex, res.utxos, [[TEST_ID_3_RECOVERY_REVOKE_WIF], [TEST_ID_3_RECOVERY_REVOKE_WIF]]);

    expect(signedTx).toEqual(TEST_ID_3_REVOKE_SIGNED_TX);
  });

  test('can create and sign basic recover identity tx', async () => {
    const identity = Identity.fromJson(TEST_ID_3_RECOVER.identity);
    
    const res = await VerusId.createRecoverIdentityTransaction(
      identity,
      TEST_ID_3_RECOVER.identity.primaryaddresses[0],
      TEST_ID_3_RECOVER_RAW_TX,
      TEST_ID_3_RECOVER.blockheight,
      TEST_UTXOS_RECOVER_TEST_ID_3,
      VERUSTEST_I_ADDR,
      0.0001,
      TEST_ID_3_RECOVER_FUNDRAWTX_RES,
      231034
    );

    const signedTx = VerusId.signUpdateIdentityTransaction(res.hex, res.utxos, [[TEST_ID_3_RECOVERY_REVOKE_WIF], [TEST_ID_3_RECOVERY_REVOKE_WIF]]);

    expect(signedTx).toEqual(TEST_ID_3_RECOVER_SIGNED_TX);
  });

  test('can create and sign recover identity with updated recovery auth, primary addr, and z-addr', async () => {
    const identity = Identity.fromJson(TEST_ID_3_RECOVER.identity);

    identity.setPrimaryAddresses([
      'RMibwG6ARv2bsrAX3BgxgMF775xJsJn8Xf',
      'RDCr3h5wYGoMh2QF7akoZy2GNsjCeSqgpu'
    ]);

    identity.setRecovery("iQghVEWZdpCJepn2JbKqkfMSKYR4fxKGGZ");
    identity.setRevocation("iQa13cLx5a4bB9nnd8EZPigrqLTsn75VrF");

    identity.setPrivateAddress("zs1n6vpyl0h4ktpqeqyvdsvfvm9epdmuusgqhmdk4y2n5eectcws2qzhjm6m88qs66pepu4uq6p0jl");
    
    const res = await VerusId.createRecoverIdentityTransaction(
      identity,
      TEST_UTXOS_RECOVER_TEST_ID_4[0].address,
      TEST_ID_4_RECOVER_RAW_TX,
      TEST_ID_4_RECOVER.blockheight,
      TEST_UTXOS_RECOVER_TEST_ID_4,
      VERUSTEST_I_ADDR,
      0.0001,
      TEST_ID_4_RECOVER_FUNDRAWTX_RES,
      239481
    );

    const signedTx = VerusId.signUpdateIdentityTransaction(res.hex, res.utxos, [[TEST_ID_4_RECOVERY_CHANGE_WIF], [TEST_ID_4_RECOVERY_REVOKE_WIF]]);

    expect(signedTx).toEqual(TEST_ID_4_RECOVER_SIGNED_TX);
  });
});
