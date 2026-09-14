import { DEST_PKH, fromBase58Check, Identity, IdentityUpdateRequestDetails, ReserveTransfer, TransferDestination } from 'verus-typescript-primitives';
import { VerusIdInterface } from '../../index'
import { TEST_UTXOS, TEST_ID_2, TEST_ID_2_RAW_TX, VERUSTEST_I_ADDR, TEST_ID_2_FUNDED_UPDATE, TEST_ID_2_UPDATE_NO_CHANGE, TEST_ID_3, TEST_UTXOS_TEST_ID_3, TEST_ID_3_FUNDRAWTX_RES, TEST_ID_3_RAW_TX, TEST_ID_3_RECOVERY_REVOKE_WIF, TEST_ID_3_SIGNED_TX, TEST_UTXOS_REVOKE_TEST_ID_3, TEST_ID_3_REVOKE_FUNDRAWTX_RES, TEST_ID_3_REVOKE, TEST_ID_3_REVOKE_RAW_TX, TEST_ID_3_REVOKE_SIGNED_TX, TEST_ID_3_RECOVER, TEST_ID_3_RECOVER_RAW_TX, TEST_UTXOS_RECOVER_TEST_ID_3, TEST_ID_3_RECOVER_FUNDRAWTX_RES, TEST_ID_3_RECOVER_SIGNED_TX, TEST_ID_4_RECOVER, TEST_ID_4_RECOVER_RAW_TX, TEST_UTXOS_RECOVER_TEST_ID_4, TEST_ID_4_RECOVERY_REVOKE_WIF, TEST_ID_4_RECOVER_FUNDRAWTX_RES, TEST_ID_4_RECOVER_SIGNED_TX, TEST_ID_4_RECOVERY_CHANGE_WIF, TEST_ID_5, TEST_ID_5_RAW_TRANSACTION, TEST_ID_5_UTXOS, TEST_ID_5_SIGNDATA_UPDATE_FUNDED_TX, TEST_ID_5_SIGNDATA_UPDATE_UNFUNDED_TX, TEST_ID_5_SIGNER_WIF, TEST_ID_5_SIGNED_TX, TEST_ID_5_REQUEST_JSON, TEST_ID_5_REQUEST_JSON_DIFF_KEY, TEST_ID_5_REQUEST_JSON_DIFF_PRIM_ADDRS, TEST_ID_5_REQUEST_JSON_DIFF_CMM, TEST_ID_3_UNFUNDED_HEX } from '../fixtures/verusid';
import { networks, smarttxs, Transaction, TransactionBuilder } from '@bitgo/utxo-lib';
import { BN } from 'bn.js';
import { TEST_REQUEST_ID } from '../fixtures/genericenvelope';

describe('Creates VerusID update transactions', () => {
  const VerusId = new VerusIdInterface(VERUSTEST_I_ADDR, "http://localhost")
  const TRANSFER_SATOSHIS = "100000";
  const RESERVE_TRANSFER_FEE_SATOSHIS = "20000";
  const ALLOW_UNVERIFIED_PREVOUTS = true;

  const createCurrencyTransferOutput = (destination: string) => ({
    currencies: {
      [VERUSTEST_I_ADDR]: TRANSFER_SATOSHIS
    },
    address: new TransferDestination({
      type: DEST_PKH,
      destinationBytes: fromBase58Check(destination).hash
    })
  })

  const createReserveTransferOutput = (destination: string) => ({
    ...createCurrencyTransferOutput(destination),
    convertto: TEST_ID_2.identity.identityaddress,
    feesatoshis: RESERVE_TRANSFER_FEE_SATOSHIS
  })

  const toLegacySingleCurrencyOutput = (output: { currencies: { [currency: string]: string | number } }) => {
    const currency = Object.keys(output.currencies)[0];

    return {
      ...output,
      currency,
      satoshis: output.currencies[currency]
    }
  }

  const createFundedIdentityCurrencyTransferResult = (currencyTransferOutput = createCurrencyTransferOutput(TEST_ID_3.identity.primaryaddresses[0])) => {
    const currencyTransferTx = Transaction.fromHex(
      smarttxs.createUnfundedCurrencyTransfer(
        VERUSTEST_I_ADDR,
        [toLegacySingleCurrencyOutput(currencyTransferOutput)],
        networks.verus
      ),
      networks.verus
    );
    const fundedTx = Transaction.fromHex(TEST_ID_3_FUNDRAWTX_RES.hex, networks.verus);

    fundedTx.outs[0].value -= currencyTransferTx.outs[0].value;
    fundedTx.outs.push(currencyTransferTx.outs[0]);

    return {
      ...TEST_ID_3_FUNDRAWTX_RES,
      hex: fundedTx.toHex()
    }
  }

  const createTamperedFundedIdentityCurrencyTransferResult = () => {
    const fundedResult = createFundedIdentityCurrencyTransferResult();
    const fundedTx = Transaction.fromHex(fundedResult.hex, networks.verus);

    fundedTx.outs[0].value -= 1;
    fundedTx.outs[2].value += 1;

    return {
      ...fundedResult,
      hex: fundedTx.toHex()
    }
  }

  const createTamperedFundedIdentityCurrencyTransferDestinationResult = () => {
    const expectedCurrencyTransferOutput = createReserveTransferOutput(TEST_ID_3.identity.primaryaddresses[0]);
    const tamperedCurrencyTransferTx = Transaction.fromHex(
      smarttxs.createUnfundedCurrencyTransfer(
        VERUSTEST_I_ADDR,
        [toLegacySingleCurrencyOutput(createReserveTransferOutput(TEST_UTXOS_TEST_ID_3[0].address))],
        networks.verus
      ),
      networks.verus
    );
    const fundedResult = createFundedIdentityCurrencyTransferResult(expectedCurrencyTransferOutput);
    const fundedTx = Transaction.fromHex(fundedResult.hex, networks.verus);

    fundedTx.outs[2] = tamperedCurrencyTransferTx.outs[0];

    return {
      ...fundedResult,
      hex: fundedTx.toHex()
    }
  }

  const createTamperedIdentityDestinationFundRawTxResult = () => {
    const tamperedIdentity = Identity.fromJson(TEST_ID_3.identity);
    tamperedIdentity.setPrimaryAddresses([TEST_UTXOS_TEST_ID_3[0].address]);
    tamperedIdentity.upgradeVersion();

    const tamperedIdentityTx = Transaction.fromHex(
      smarttxs.createUnfundedIdentityUpdate(
        tamperedIdentity.toBuffer().toString('hex'),
        networks.verus,
        31677 + 20
      ),
      networks.verus
    );
    const fundedTx = Transaction.fromHex(TEST_ID_3_FUNDRAWTX_RES.hex, networks.verus);

    fundedTx.outs[1] = tamperedIdentityTx.outs[0];

    return {
      ...TEST_ID_3_FUNDRAWTX_RES,
      hex: fundedTx.toHex()
    }
  }

  const createVerifiedPrevoutFixture = () => {
    const prevTxBuilder = new TransactionBuilder(networks.verus);

    prevTxBuilder.setVersion(4);
    prevTxBuilder.setVersionGroupId(0x892f2085);
    prevTxBuilder.setExpiryHeight(0);
    prevTxBuilder.addInput(Buffer.alloc(32, 1), 0);
    prevTxBuilder.addOutput(TEST_ID_3.identity.primaryaddresses[0], 999980000);

    const prevTx = prevTxBuilder.buildIncomplete();
    const fundedTx = Transaction.fromHex(TEST_ID_3_FUNDRAWTX_RES.hex, networks.verus);

    fundedTx.ins[0].hash = Buffer.from(prevTx.getId(), 'hex').reverse();
    fundedTx.ins[0].index = 0;

    const untrustedUtxos = [{
      ...TEST_UTXOS_TEST_ID_3[TEST_UTXOS_TEST_ID_3.length - 1],
      txid: prevTx.getId(),
      outputIndex: 0,
      script: "00",
      satoshis: 1
    }];
    const verusId = new VerusIdInterface(
      VERUSTEST_I_ADDR,
      "http://localhost",
      undefined,
      async (req) => {
        if (req.method === "getrawtransaction" && Array.isArray(req.params) && req.params[0] === prevTx.getId()) {
          return {
            id: req.id,
            result: prevTx.toHex(),
            error: null
          };
        }

        return {
          id: req.id,
          result: null,
          error: {
            code: -1,
            message: "Unexpected RPC request"
          }
        };
      }
    );

    return {
      fundRawTransactionResult: {
        ...TEST_ID_3_FUNDRAWTX_RES,
        hex: fundedTx.toHex()
      },
      prevTx,
      untrustedUtxos,
      verusId
    }
  }

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
      18167,
      undefined,
      true,
      false,
      ALLOW_UNVERIFIED_PREVOUTS
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
      31677,
      undefined,
      true,
      false,
      ALLOW_UNVERIFIED_PREVOUTS
    );

    const signedTx = VerusId.signUpdateIdentityTransaction(res.hex, res.utxos, [[TEST_ID_3_RECOVERY_REVOKE_WIF], [TEST_ID_3_RECOVERY_REVOKE_WIF]]);

    expect(signedTx).toEqual(TEST_ID_3_SIGNED_TX);
  });

  test('verifies prevout amounts and scripts from raw transactions before fee validation', async () => {
    const { fundRawTransactionResult, prevTx, untrustedUtxos, verusId } = createVerifiedPrevoutFixture();

    const res = await verusId.createUpdateIdentityTransaction(
      Identity.fromJson(TEST_ID_3.identity),
      TEST_ID_3.identity.primaryaddresses[0],
      TEST_ID_3_RAW_TX,
      TEST_ID_3.blockheight,
      untrustedUtxos,
      VERUSTEST_I_ADDR,
      0.0001,
      fundRawTransactionResult,
      31677
    );

    expect(res.utxos[0].txid).toBe(prevTx.getId());
    expect(res.utxos[0].satoshis).toBe(999980000);
    expect(res.utxos[0].script).toBe(prevTx.outs[0].script.toString('hex'));
    expect(res.deltas.get(VERUSTEST_I_ADDR)!.toString()).toBe("-10000");
  });

  test('rejects verified prevout raw transactions with mismatched hashes', async () => {
    const { fundRawTransactionResult, prevTx, untrustedUtxos } = createVerifiedPrevoutFixture();
    const wrongPrevTxBuilder = new TransactionBuilder(networks.verus);

    wrongPrevTxBuilder.setVersion(4);
    wrongPrevTxBuilder.setVersionGroupId(0x892f2085);
    wrongPrevTxBuilder.setExpiryHeight(0);
    wrongPrevTxBuilder.addInput(Buffer.alloc(32, 2), 0);
    wrongPrevTxBuilder.addOutput(TEST_ID_3.identity.primaryaddresses[0], 999980000);

    const wrongPrevTx = wrongPrevTxBuilder.buildIncomplete();
    const verusId = new VerusIdInterface(
      VERUSTEST_I_ADDR,
      "http://localhost",
      undefined,
      async (req) => ({
        id: req.id,
        result: wrongPrevTx.toHex(),
        error: null
      })
    );

    await expect(verusId.createUpdateIdentityTransaction(
      Identity.fromJson(TEST_ID_3.identity),
      TEST_ID_3.identity.primaryaddresses[0],
      TEST_ID_3_RAW_TX,
      TEST_ID_3.blockheight,
      untrustedUtxos,
      VERUSTEST_I_ADDR,
      0.0001,
      fundRawTransactionResult,
      31677
    )).rejects.toThrow("Prevout transaction hash mismatch for " + prevTx.getId() + ".");
  });

  test('catches identity update when funded identity destination is modified', async () => {
    let error;

    try {
      await VerusId.createUpdateIdentityTransaction(
        Identity.fromJson(TEST_ID_3.identity),
        TEST_ID_3.identity.primaryaddresses[0],
        TEST_ID_3_RAW_TX,
        TEST_ID_3.blockheight,
        TEST_UTXOS_TEST_ID_3,
        VERUSTEST_I_ADDR,
        0.0001,
        createTamperedIdentityDestinationFundRawTxResult(),
        31677,
        undefined,
        true,
        false,
        ALLOW_UNVERIFIED_PREVOUTS
      );
    } catch(e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect((error as Error).message).toBe("Transaction hex does not match unfunded component.");
  });

  test('can create combined identity update and explicit currency transfer tx', async () => {
    const res = await VerusId.createUpdateIdentityWithCurrencyTransferTransaction(
      Identity.fromJson(TEST_ID_3.identity),
      TEST_ID_3.identity.primaryaddresses[0],
      TEST_ID_3_RAW_TX,
      TEST_ID_3.blockheight,
      [createCurrencyTransferOutput(TEST_ID_3.identity.primaryaddresses[0])],
      TEST_UTXOS_TEST_ID_3,
      {
        chainIAddr: VERUSTEST_I_ADDR,
        maxFee: 0.0001,
        fundRawTransactionResult: createFundedIdentityCurrencyTransferResult(),
        currentHeight: 31677,
        allowUnverifiedPrevouts: ALLOW_UNVERIFIED_PREVOUTS
      }
    );

    const completedTx = Transaction.fromHex(res.hex, networks.verus);

    expect(completedTx.ins.length).toBe(2);
    expect(completedTx.outs.length).toBe(3);
    expect(completedTx.outs[2].script.toString('hex')).toMatch(/^76a914[0-9a-f]{40}88ac$/);
    expect(res.utxos.length).toBe(2);
    expect(res.deltas.get(VERUSTEST_I_ADDR)!.toString()).toBe("-110000");
  });

  test('can create combined identity update and explicit multi-currency reserve transfer tx', async () => {
    const nativeUtxo = TEST_UTXOS_TEST_ID_3[TEST_UTXOS_TEST_ID_3.length - 1];
    const tokenUtxo = TEST_UTXOS_TEST_ID_3[2];
    const tokenInfo = smarttxs.unpackOutput(
      {
        value: tokenUtxo.satoshis,
        script: Buffer.from(tokenUtxo.script, 'hex')
      },
      VERUSTEST_I_ADDR,
      true
    );
    const tokenCurrency = Object.keys(tokenInfo.values).find(currency => currency !== VERUSTEST_I_ADDR)!;
    const tokenSatoshis = tokenInfo.values[tokenCurrency].toString();
    const verusId = new VerusIdInterface(
      VERUSTEST_I_ADDR,
      "http://localhost",
      undefined,
      async (req): Promise<any> => {
        if (req.method === "fundrawtransaction" && Array.isArray(req.params)) {
          const tx = Transaction.fromHex(req.params[0], networks.verus);
          const changeTxBuilder = new TransactionBuilder(networks.verus);
          const nativeOutputValue = tx.outs.reduce((total: number, output: { value: number }) => total + output.value, 0);
          const changeValue = nativeUtxo.satoshis - nativeOutputValue - 10000;

          tx.addInput(Buffer.from(nativeUtxo.txid, 'hex').reverse(), nativeUtxo.outputIndex);
          tx.addInput(Buffer.from(tokenUtxo.txid, 'hex').reverse(), tokenUtxo.outputIndex);
          changeTxBuilder.addOutput(TEST_ID_3.identity.primaryaddresses[0], changeValue);
          tx.outs.push(changeTxBuilder.buildIncomplete().outs[0]);

          return {
            id: req.id,
            result: {
              hex: tx.toHex(),
              changepos: tx.outs.length - 1,
              fee: 0.0001
            },
            error: null
          };
        }

        return {
          id: req.id,
          result: null,
          error: {
            code: -1,
            message: "Unexpected RPC request"
          }
        };
      }
    );

    const res = await verusId.createUpdateIdentityWithCurrencyTransferTransaction(
      Identity.fromJson(TEST_ID_3.identity),
      TEST_ID_3.identity.primaryaddresses[0],
      TEST_ID_3_RAW_TX,
      TEST_ID_3.blockheight,
      [{
        currencies: {
          [VERUSTEST_I_ADDR]: TRANSFER_SATOSHIS,
          [tokenCurrency]: tokenSatoshis
        },
        convertto: VERUSTEST_I_ADDR,
        feecurrency: VERUSTEST_I_ADDR,
        address: new TransferDestination({
          type: DEST_PKH,
          destinationBytes: fromBase58Check(TEST_ID_3.identity.primaryaddresses[0]).hash
        }),
        refundto: new TransferDestination({
          type: DEST_PKH,
          destinationBytes: fromBase58Check(TEST_ID_3.identity.primaryaddresses[0]).hash
        })
      }],
      [nativeUtxo, tokenUtxo],
      {
        chainIAddr: VERUSTEST_I_ADDR,
        maxFee: 0.01,
        currentHeight: 31677,
        allowUnverifiedPrevouts: ALLOW_UNVERIFIED_PREVOUTS
      }
    );
    const completedTx = Transaction.fromHex(res.hex, networks.verus);
    const currencyTransferOutputInfo = smarttxs.unpackOutput(completedTx.outs[1], VERUSTEST_I_ADDR, false, true);
    const reserveTransfer = currencyTransferOutputInfo.params![0].data as ReserveTransfer;

    expect(currencyTransferOutputInfo.values[tokenCurrency].toString()).toBe(tokenSatoshis);
    expect(currencyTransferOutputInfo.fees[VERUSTEST_I_ADDR].toString()).toBe(RESERVE_TRANSFER_FEE_SATOSHIS);
    expect(reserveTransfer.transferDestination.hasAuxDests()).toBe(true);
    expect(reserveTransfer.transferDestination.auxDests[0].getAddressString()).toBe(TEST_ID_3.identity.primaryaddresses[0]);
    expect(res.deltas.get(VERUSTEST_I_ADDR)!.toString()).toBe("-130000");
    expect(res.deltas.get(tokenCurrency)!.toString()).toBe("-" + tokenSatoshis);
  });

  test('rejects ambiguous reserve transfer fee parameters', async () => {
    await expect(VerusId.createUpdateIdentityWithCurrencyTransferTransaction(
      Identity.fromJson(TEST_ID_3.identity),
      TEST_ID_3.identity.primaryaddresses[0],
      TEST_ID_3_RAW_TX,
      TEST_ID_3.blockheight,
      [{
        ...createCurrencyTransferOutput(TEST_ID_3.identity.primaryaddresses[0]),
        feesatoshis: RESERVE_TRANSFER_FEE_SATOSHIS
      }],
      TEST_UTXOS_TEST_ID_3,
      {
        chainIAddr: VERUSTEST_I_ADDR,
        currentHeight: 31677,
        allowUnverifiedPrevouts: ALLOW_UNVERIFIED_PREVOUTS
      }
    )).rejects.toThrow("Reserve transfer fee is only valid for reserve transfer outputs.");
  });

  test('requires explicit reserve transfer fees for cross-system outputs', async () => {
    await expect(VerusId.createUpdateIdentityWithCurrencyTransferTransaction(
      Identity.fromJson(TEST_ID_3.identity),
      TEST_ID_3.identity.primaryaddresses[0],
      TEST_ID_3_RAW_TX,
      TEST_ID_3.blockheight,
      [{
        ...createCurrencyTransferOutput(TEST_ID_3.identity.primaryaddresses[0]),
        exportto: TEST_ID_2.identity.identityaddress
      }],
      TEST_UTXOS_TEST_ID_3,
      {
        chainIAddr: VERUSTEST_I_ADDR,
        currentHeight: 31677,
        allowUnverifiedPrevouts: ALLOW_UNVERIFIED_PREVOUTS
      }
    )).rejects.toThrow("Cross-system currency transfers require explicit reserve transfer feesatoshis.");
  });

  test('rejects refund destination outside export, preconvert, or conversion outputs', async () => {
    await expect(VerusId.createUpdateIdentityWithCurrencyTransferTransaction(
      Identity.fromJson(TEST_ID_3.identity),
      TEST_ID_3.identity.primaryaddresses[0],
      TEST_ID_3_RAW_TX,
      TEST_ID_3.blockheight,
      [{
        ...createCurrencyTransferOutput(TEST_ID_3.identity.primaryaddresses[0]),
        convertto: TEST_ID_2.identity.identityaddress,
        feesatoshis: RESERVE_TRANSFER_FEE_SATOSHIS,
        mintnew: true,
        refundto: new TransferDestination({
          type: DEST_PKH,
          destinationBytes: fromBase58Check(TEST_ID_3.identity.primaryaddresses[0]).hash
        })
      }],
      TEST_UTXOS_TEST_ID_3,
      {
        chainIAddr: VERUSTEST_I_ADDR,
        currentHeight: 31677,
        allowUnverifiedPrevouts: ALLOW_UNVERIFIED_PREVOUTS
      }
    )).rejects.toThrow("Refund destination is only valid for export, preconvert, or conversion reserve transfer outputs.");
  });

  test('catches combined identity update when primary address is not the expected destination', async () => {
    let error;

    try {
      await VerusId.createUpdateIdentityWithCurrencyTransferTransaction(
        Identity.fromJson(TEST_ID_3.identity),
        TEST_ID_3.identity.primaryaddresses[0],
        TEST_ID_3_RAW_TX,
        TEST_ID_3.blockheight,
        [createCurrencyTransferOutput(TEST_ID_3.identity.primaryaddresses[0])],
        TEST_UTXOS_TEST_ID_3,
        {
          chainIAddr: VERUSTEST_I_ADDR,
          maxFee: 0.0001,
          fundRawTransactionResult: createFundedIdentityCurrencyTransferResult(),
          currentHeight: 31677,
          expectedIdentityPrimaryAddress: TEST_UTXOS_TEST_ID_3[0].address,
          allowUnverifiedPrevouts: ALLOW_UNVERIFIED_PREVOUTS
        }
      );
    } catch(e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect((error as Error).message).toBe("Identity primary address must be exactly " + TEST_UTXOS_TEST_ID_3[0].address + ".");
  });

  test('catches combined identity update when funded currency transfer output is modified', async () => {
    let error;

    try {
      await VerusId.createUpdateIdentityWithCurrencyTransferTransaction(
        Identity.fromJson(TEST_ID_3.identity),
        TEST_ID_3.identity.primaryaddresses[0],
        TEST_ID_3_RAW_TX,
        TEST_ID_3.blockheight,
        [createCurrencyTransferOutput(TEST_ID_3.identity.primaryaddresses[0])],
        TEST_UTXOS_TEST_ID_3,
        {
          chainIAddr: VERUSTEST_I_ADDR,
          maxFee: 0.0001,
          fundRawTransactionResult: createTamperedFundedIdentityCurrencyTransferResult(),
          currentHeight: 31677,
          allowUnverifiedPrevouts: ALLOW_UNVERIFIED_PREVOUTS
        }
      );
    } catch(e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect((error as Error).message).toBe("Transaction hex does not match unfunded component.");
  });

  test('catches combined identity update when reserve transfer destination is modified', async () => {
    let error;

    try {
      await VerusId.createUpdateIdentityWithCurrencyTransferTransaction(
        Identity.fromJson(TEST_ID_3.identity),
        TEST_ID_3.identity.primaryaddresses[0],
        TEST_ID_3_RAW_TX,
        TEST_ID_3.blockheight,
        [createReserveTransferOutput(TEST_ID_3.identity.primaryaddresses[0])],
        TEST_UTXOS_TEST_ID_3,
        {
          chainIAddr: VERUSTEST_I_ADDR,
          maxFee: 0.01,
          fundRawTransactionResult: createTamperedFundedIdentityCurrencyTransferDestinationResult(),
          currentHeight: 31677,
          allowUnverifiedPrevouts: ALLOW_UNVERIFIED_PREVOUTS
        }
      );
    } catch(e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect((error as Error).message).toBe("Transaction hex does not match unfunded component.");
  });

  test('can create basic identity update tx without utxo list', async () => {
    const res = await VerusId.createUpdateIdentityTransaction(
      Identity.fromJson(TEST_ID_3.identity),
      TEST_ID_3.identity.primaryaddresses[0],
      TEST_ID_3_RAW_TX,
      TEST_ID_3.blockheight,
      undefined,
      VERUSTEST_I_ADDR,
      0.0001,
      TEST_ID_3_FUNDRAWTX_RES,
      31677
    );

    expect(res.hex).toEqual(TEST_ID_3_UNFUNDED_HEX);
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
      33084,
      ALLOW_UNVERIFIED_PREVOUTS
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
      231034,
      ALLOW_UNVERIFIED_PREVOUTS
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
      239481,
      ALLOW_UNVERIFIED_PREVOUTS
    );

    const signedTx = VerusId.signUpdateIdentityTransaction(res.hex, res.utxos, [[TEST_ID_4_RECOVERY_CHANGE_WIF], [TEST_ID_4_RECOVERY_REVOKE_WIF]]);

    expect(signedTx).toEqual(TEST_ID_4_RECOVER_SIGNED_TX);
  });

  test('can create and sign update identity with cmm update including signdata', async () => {
    const details = {
      requestid: TEST_REQUEST_ID.toJson(),
      expiryheight: new BN("1700000000", 10).toString()
    }
    
    const reqDet = IdentityUpdateRequestDetails.fromCLIJson(
      TEST_ID_5_REQUEST_JSON,
      details
    );

    const res = await VerusId.createUpdateIdentityTransaction(
      reqDet,
      TEST_ID_5.identity.primaryaddresses[0],
      TEST_ID_5_RAW_TRANSACTION,
      TEST_ID_5.blockheight,
      TEST_ID_5_UTXOS,
      VERUSTEST_I_ADDR,
      0.0001,
      TEST_ID_5_SIGNDATA_UPDATE_FUNDED_TX,
      18167,
      TEST_ID_5_SIGNDATA_UPDATE_UNFUNDED_TX,
      true,
      true,
      ALLOW_UNVERIFIED_PREVOUTS
    );

    const signedTx = VerusId.signUpdateIdentityTransaction(res.hex, res.utxos, [[TEST_ID_5_SIGNER_WIF], [TEST_ID_5_SIGNER_WIF]]);

    expect(signedTx).toEqual(TEST_ID_5_SIGNED_TX);
  });

  test('allows an identity update without cmm changes when the current identity has cmm entries', async () => {
    const updatedPrimaryAddress = TEST_ID_3.identity.primaryaddresses[0];
    const identityWithExistingCmm = Identity.fromJson({
      ...TEST_ID_5.identity,
      contentmultimap: {
        [VERUSTEST_I_ADDR]: ['01']
      }
    });
    const updatedIdentity = Identity.fromJson({
      ...TEST_ID_5.identity,
      primaryaddresses: [updatedPrimaryAddress]
    });
    const currentIdentityTx = smarttxs.createUnfundedIdentityUpdate(
      identityWithExistingCmm.toBuffer().toString('hex'),
      networks.verus,
      18187
    );
    const updateIdentityTx = smarttxs.createUnfundedIdentityUpdate(
      updatedIdentity.toBuffer().toString('hex'),
      networks.verus,
      18187
    );
    const request = IdentityUpdateRequestDetails.fromCLIJson({
      name: TEST_ID_5.identity.name,
      primaryaddresses: [updatedPrimaryAddress]
    });

    const result = await VerusId.createUpdateIdentityTransaction(
      request,
      updatedPrimaryAddress,
      currentIdentityTx,
      TEST_ID_5.blockheight,
      undefined,
      VERUSTEST_I_ADDR,
      0.0001,
      undefined,
      18167,
      updateIdentityTx,
      true,
      true
    );

    expect(result.hex).toEqual(updateIdentityTx);
    expect(result.identity.toJson().primaryaddresses).toEqual([updatedPrimaryAddress]);
    expect(result.identity.toJson().contentmultimap).toEqual({});
  });

  test('catches an identity update with a different cmm key', async () => {
    const reqDet = IdentityUpdateRequestDetails.fromCLIJson(
      TEST_ID_5_REQUEST_JSON_DIFF_KEY,
      {
        requestid: TEST_REQUEST_ID.toJson(),
        expiryheight: new BN("1700000000", 10).toString()
      }
    );

    let error;

    try {
      await VerusId.createUpdateIdentityTransaction(
        reqDet,
        TEST_ID_5.identity.primaryaddresses[0],
        TEST_ID_5_RAW_TRANSACTION,
        TEST_ID_5.blockheight,
        TEST_ID_5_UTXOS,
        VERUSTEST_I_ADDR,
        0.0001,
        TEST_ID_5_SIGNDATA_UPDATE_FUNDED_TX,
        18167,
        TEST_ID_5_SIGNDATA_UPDATE_UNFUNDED_TX,
        true,
        true,
        ALLOW_UNVERIFIED_PREVOUTS
      )
    } catch(e) {
      error = e;
    }

    expect(error).toBeDefined();
  });

  test('catches update identity request txid mismatch', async () => {
    const reqDet = IdentityUpdateRequestDetails.fromCLIJson(
      TEST_ID_5_REQUEST_JSON,
      {
        requestid: TEST_REQUEST_ID.toJson(),
        expiryheight: new BN("1700000000", 10).toString()
      }
    );
    reqDet.setTxidFromString("00".repeat(32));

    let error;

    try {
      await VerusId.createUpdateIdentityTransaction(
        reqDet,
        TEST_ID_5.identity.primaryaddresses[0],
        TEST_ID_5_RAW_TRANSACTION,
        TEST_ID_5.blockheight,
        TEST_ID_5_UTXOS,
        VERUSTEST_I_ADDR,
        0.0001,
        TEST_ID_5_SIGNDATA_UPDATE_FUNDED_TX,
        18167,
        TEST_ID_5_SIGNDATA_UPDATE_UNFUNDED_TX,
        true,
        true,
        ALLOW_UNVERIFIED_PREVOUTS
      )
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect((error as Error).message).toBe("Identity update request txid does not match the txid of the identity transaction");
  });

  test('catches an identity update with different primary addresses', async () => {
    const reqDet = IdentityUpdateRequestDetails.fromCLIJson(
      TEST_ID_5_REQUEST_JSON_DIFF_PRIM_ADDRS,
      {
        requestid: TEST_REQUEST_ID.toJson(),
        expiryheight: new BN("1700000000", 10).toString()
      }
    );

    let error;

    try {
      await VerusId.createUpdateIdentityTransaction(
        reqDet,
        TEST_ID_5.identity.primaryaddresses[0],
        TEST_ID_5_RAW_TRANSACTION,
        TEST_ID_5.blockheight,
        TEST_ID_5_UTXOS,
        VERUSTEST_I_ADDR,
        0.0001,
        TEST_ID_5_SIGNDATA_UPDATE_FUNDED_TX,
        18167,
        TEST_ID_5_SIGNDATA_UPDATE_UNFUNDED_TX,
        true,
        true,
        ALLOW_UNVERIFIED_PREVOUTS
      )
    } catch(e) {
      error = e;
    }

    expect(error).toBeDefined();
  });

  test('catches an unrequested cmm update', async () => {
    const reqDet = IdentityUpdateRequestDetails.fromCLIJson(
      TEST_ID_5_REQUEST_JSON_DIFF_CMM,
      {
        requestid: TEST_REQUEST_ID.toJson(),
        expiryheight: new BN("1700000000", 10).toString()
      }
    );

    let error;

    try {
      await VerusId.createUpdateIdentityTransaction(
        reqDet,
        TEST_ID_5.identity.primaryaddresses[0],
        TEST_ID_5_RAW_TRANSACTION,
        TEST_ID_5.blockheight,
        TEST_ID_5_UTXOS,
        VERUSTEST_I_ADDR,
        0.0001,
        TEST_ID_5_SIGNDATA_UPDATE_FUNDED_TX,
        18167,
        TEST_ID_5_SIGNDATA_UPDATE_UNFUNDED_TX,
        true,
        true,
        ALLOW_UNVERIFIED_PREVOUTS
      )
    } catch(e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect((error as Error).message).toBe("Unexpected contentmultimap entries in identity transaction");
  });
});
