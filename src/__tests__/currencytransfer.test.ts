import { networks, smarttxs, Transaction } from "@bitgo/utxo-lib";
import {
  DEST_ID,
  DEST_PKH,
  EVALS,
  FLAG_DEST_AUX,
  fromBase58Check,
  ReserveTransfer,
  TokenOutput,
  TransferDestination,
} from "verus-typescript-primitives";
import { VerusIdInterface } from "../index";
import { CurrencyTransferOutput } from "../VerusIdInterface";
import { TEST_ID_2, TEST_ID_3, VERUSTEST_I_ADDR } from "./fixtures/verusid";

describe("createUnfundedCurrencyTransferTransaction", () => {
  const EXPIRY_HEIGHT = 31697;
  const NATIVE_SATOSHIS = "100000";
  const TOKEN_SATOSHIS = "250000";
  const RESERVE_TRANSFER_FEE_SATOSHIS = "20000";
  const TOKEN_CURRENCY = TEST_ID_2.identity.identityaddress;
  const DESTINATION_ADDRESS = TEST_ID_3.identity.primaryaddresses[0];

  const createTransferDestination = (address: string, type = DEST_PKH) =>
    new TransferDestination({
      type,
      destinationBytes: fromBase58Check(address).hash,
    });

  const createCurrencyTransferOutput = (
    overrides: Partial<CurrencyTransferOutput> = {}
  ): CurrencyTransferOutput => ({
    currencies: {
      [VERUSTEST_I_ADDR]: NATIVE_SATOSHIS,
    },
    address: createTransferDestination(DESTINATION_ADDRESS),
    ...overrides,
  });

  const createTx = (outputs: CurrencyTransferOutput[]) =>
    Transaction.fromHex(
      VerusIdInterface.createUnfundedCurrencyTransferTransaction(
        VERUSTEST_I_ADDR,
        outputs,
        EXPIRY_HEIGHT
      ),
      networks.verus
    );

  const unpackOutput = (
    tx: ReturnType<typeof Transaction.fromHex>,
    index = 0
  ) => smarttxs.unpackOutput(tx.outs[index], VERUSTEST_I_ADDR, false, true);

  test("is exposed as a public static API", () => {
    expect(
      typeof VerusIdInterface.createUnfundedCurrencyTransferTransaction
    ).toBe("function");
  });

  test("creates an unfunded native P2PKH transfer with sapling metadata", () => {
    const tx = createTx([createCurrencyTransferOutput()]);
    const outputInfo = unpackOutput(tx);

    expect(tx.ins).toHaveLength(0);
    expect(tx.outs).toHaveLength(1);
    expect(tx.version).toBe(4);
    expect(tx.versionGroupId).toBe(0x892f2085);
    expect(tx.expiryHeight).toBe(EXPIRY_HEIGHT);
    expect(tx.outs[0].value).toBe(Number(NATIVE_SATOSHIS));
    expect(tx.outs[0].script.toString("hex")).toMatch(
      /^76a914[0-9a-f]{40}88ac$/
    );
    expect(outputInfo.destinations).toEqual([DESTINATION_ADDRESS]);
    expect(outputInfo.values[VERUSTEST_I_ADDR].toString()).toBe(
      NATIVE_SATOSHIS
    );
  });

  test("creates token reserve-output scripts for non-native currency transfers", () => {
    const tx = createTx([
      createCurrencyTransferOutput({
        currencies: {
          [TOKEN_CURRENCY]: TOKEN_SATOSHIS,
        },
      }),
    ]);
    const outputInfo = unpackOutput(tx);

    expect(tx.outs[0].value).toBe(0);
    expect(outputInfo.destinations).toEqual([DESTINATION_ADDRESS]);
    expect(outputInfo.values[VERUSTEST_I_ADDR].toString()).toBe("0");
    expect(outputInfo.values[TOKEN_CURRENCY].toString()).toBe(TOKEN_SATOSHIS);
    expect(outputInfo.params![0].eval).toBe(EVALS.EVAL_RESERVE_OUTPUT);
    expect(
      (outputInfo.params![0].data as TokenOutput).reserveValues.valueMap
        .get(TOKEN_CURRENCY)!
        .toString()
    ).toBe(TOKEN_SATOSHIS);
  });

  test("creates smart native outputs for identity destinations", () => {
    const identityDestinationAddress = TEST_ID_2.identity.identityaddress;
    const tx = createTx([
      createCurrencyTransferOutput({
        address: createTransferDestination(identityDestinationAddress, DEST_ID),
      }),
    ]);
    const outputInfo = unpackOutput(tx);

    expect(tx.outs[0].value).toBe(Number(NATIVE_SATOSHIS));
    expect(tx.outs[0].script.toString("hex")).not.toMatch(
      /^76a914[0-9a-f]{40}88ac$/
    );
    expect(outputInfo.destinations).toEqual([identityDestinationAddress]);
    expect(outputInfo.values[VERUSTEST_I_ADDR].toString()).toBe(
      NATIVE_SATOSHIS
    );
  });

  test("creates multi-currency reserve transfers with native fees and refund destinations", () => {
    const refundDestination = createTransferDestination(DESTINATION_ADDRESS);
    const sourceDestination = createTransferDestination(DESTINATION_ADDRESS);
    const tx = createTx([
      createCurrencyTransferOutput({
        currencies: {
          [VERUSTEST_I_ADDR]: NATIVE_SATOSHIS,
          [TOKEN_CURRENCY]: TOKEN_SATOSHIS,
        },
        address: sourceDestination,
        convertto: VERUSTEST_I_ADDR,
        refundto: refundDestination,
      }),
    ]);
    const outputInfo = unpackOutput(tx);
    const reserveTransfer = outputInfo.params![0].data as ReserveTransfer;

    expect(tx.outs[0].value).toBe(
      Number(NATIVE_SATOSHIS) + Number(RESERVE_TRANSFER_FEE_SATOSHIS)
    );
    expect(outputInfo.fees[VERUSTEST_I_ADDR].toString()).toBe(
      RESERVE_TRANSFER_FEE_SATOSHIS
    );
    expect(
      reserveTransfer.reserveValues.valueMap.get(VERUSTEST_I_ADDR)!.toString()
    ).toBe(NATIVE_SATOSHIS);
    expect(
      reserveTransfer.reserveValues.valueMap.get(TOKEN_CURRENCY)!.toString()
    ).toBe(TOKEN_SATOSHIS);
    expect(reserveTransfer.destCurrencyID).toBe(VERUSTEST_I_ADDR);
    expect(reserveTransfer.feeCurrencyID).toBe(VERUSTEST_I_ADDR);
    expect(reserveTransfer.feeAmount.toString()).toBe(
      RESERVE_TRANSFER_FEE_SATOSHIS
    );
    expect(reserveTransfer.isConversion()).toBe(true);
    expect(reserveTransfer.transferDestination.hasAuxDests()).toBe(true);
    expect(
      reserveTransfer.transferDestination.type.and(FLAG_DEST_AUX).toString()
    ).toBe(FLAG_DEST_AUX.toString());
    expect(reserveTransfer.transferDestination.getAddressString()).toBe(
      DESTINATION_ADDRESS
    );
    expect(
      reserveTransfer.transferDestination.auxDests[0].getAddressString()
    ).toBe(DESTINATION_ADDRESS);
    expect(sourceDestination.hasAuxDests()).toBe(false);
    expect(sourceDestination.auxDests).toHaveLength(0);
  });

  test("keeps explicit non-native reserve-transfer fees out of the native output value", () => {
    const tx = createTx([
      createCurrencyTransferOutput({
        currencies: {
          [VERUSTEST_I_ADDR]: NATIVE_SATOSHIS,
        },
        convertto: TOKEN_CURRENCY,
        feecurrency: TOKEN_CURRENCY,
        feesatoshis: "123",
      }),
    ]);
    const outputInfo = unpackOutput(tx);
    const reserveTransfer = outputInfo.params![0].data as ReserveTransfer;

    expect(tx.outs[0].value).toBe(Number(NATIVE_SATOSHIS));
    expect(outputInfo.fees[TOKEN_CURRENCY].toString()).toBe("123");
    expect(reserveTransfer.feeCurrencyID).toBe(TOKEN_CURRENCY);
    expect(reserveTransfer.feeAmount.toString()).toBe("123");
  });

  test("preserves caller output order", () => {
    const tx = createTx([
      createCurrencyTransferOutput(),
      createCurrencyTransferOutput({
        currencies: {
          [TOKEN_CURRENCY]: TOKEN_SATOSHIS,
        },
      }),
    ]);

    expect(tx.outs).toHaveLength(2);
    expect(unpackOutput(tx, 0).values[VERUSTEST_I_ADDR].toString()).toBe(
      NATIVE_SATOSHIS
    );
    expect(unpackOutput(tx, 1).values[TOKEN_CURRENCY].toString()).toBe(
      TOKEN_SATOSHIS
    );
  });

  test.each([
    [
      "missing address",
      () => ({
        ...createCurrencyTransferOutput(),
        address: undefined as unknown as TransferDestination,
      }),
      "Must specify address for all outputs",
    ],
    [
      "empty currency values",
      () => createCurrencyTransferOutput({ currencies: {} }),
      "Currency transfer output must include at least one currency value.",
    ],
    [
      "negative currency value",
      () =>
        createCurrencyTransferOutput({
          currencies: { [VERUSTEST_I_ADDR]: "-1" },
        }),
      "Currency transfer output currency value for " +
        VERUSTEST_I_ADDR +
        " must be a non-negative integer satoshi value.",
    ],
    [
      "fractional currency value",
      () =>
        createCurrencyTransferOutput({
          currencies: { [VERUSTEST_I_ADDR]: "1.5" },
        }),
      "Currency transfer output currency value for " +
        VERUSTEST_I_ADDR +
        " must be a non-negative integer satoshi value.",
    ],
    [
      "VDXF tag",
      () =>
        createCurrencyTransferOutput({
          vdxftag: "iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq",
        }),
      "VDXF tags not fully implemented",
    ],
    [
      "reserve fee on a non-reserve output",
      () =>
        createCurrencyTransferOutput({
          feesatoshis: RESERVE_TRANSFER_FEE_SATOSHIS,
        }),
      "Reserve transfer fee is only valid for reserve transfer outputs.",
    ],
    [
      "fee currency on a non-reserve output",
      () => createCurrencyTransferOutput({ feecurrency: TOKEN_CURRENCY }),
      "Fee currency is only valid for reserve transfer outputs.",
    ],
    [
      "refund destination on a non-reserve output",
      () =>
        createCurrencyTransferOutput({
          refundto: createTransferDestination(DESTINATION_ADDRESS),
        }),
      "Refund destination is only valid for reserve transfer outputs.",
    ],
    [
      "destination system on a non-reserve output",
      () =>
        createCurrencyTransferOutput({
          destsystem: TEST_ID_2.identity.identityaddress,
        }),
      "Destination system is only valid for reserve transfer outputs.",
    ],
    [
      "via without convertto",
      () => createCurrencyTransferOutput({ via: TOKEN_CURRENCY }),
      "Reserve-to-reserve currency transfers with via must also specify convertto.",
    ],
    [
      "cross-system transfer without explicit fee",
      () =>
        createCurrencyTransferOutput({
          exportto: TEST_ID_2.identity.identityaddress,
        }),
      "Cross-system currency transfers require explicit reserve transfer feesatoshis.",
    ],
    [
      "non-native fee currency without explicit fee",
      () =>
        createCurrencyTransferOutput({
          convertto: TOKEN_CURRENCY,
          feecurrency: TOKEN_CURRENCY,
        }),
      "Non-native reserve transfer fee currency requires explicit feesatoshis.",
    ],
    [
      "preconvert with non-native fee currency",
      () =>
        createCurrencyTransferOutput({
          convertto: TOKEN_CURRENCY,
          preconvert: true,
          feecurrency: TOKEN_CURRENCY,
          feesatoshis: "1",
        }),
      "Preconvert, mint, and burn reserve transfer fees must use the native chain currency.",
    ],
    [
      "preconvert without convertto",
      () => createCurrencyTransferOutput({ preconvert: true }),
      "Preconvert currency transfers require convertto.",
    ],
    [
      "mint without convertto",
      () => createCurrencyTransferOutput({ mintnew: true }),
      "Mint currency transfers require convertto.",
    ],
    [
      "refund destination on mint",
      () =>
        createCurrencyTransferOutput({
          convertto: TOKEN_CURRENCY,
          mintnew: true,
          refundto: createTransferDestination(DESTINATION_ADDRESS),
        }),
      "Refund destination is only valid for export, preconvert, or conversion reserve transfer outputs.",
    ],
    [
      "unsupported destination type",
      () =>
        createCurrencyTransferOutput({
          address: new TransferDestination({
            type: DEST_PKH.add(DEST_ID),
            destinationBytes: fromBase58Check(DESTINATION_ADDRESS).hash,
          }),
        }),
      "Unsupported transfer destination type.",
    ],
  ])("rejects %s", (_name, createOutput, expectedMessage) => {
    expect(() => createTx([createOutput()])).toThrow(expectedMessage);
  });
});
