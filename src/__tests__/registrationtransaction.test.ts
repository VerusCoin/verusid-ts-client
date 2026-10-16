import BN from "bn.js";
import { networks, TransactionBuilder } from "@bitgo/utxo-lib";
import {
  CommitmentHash,
  IdentityCommitmentScript,
  IdentityID,
  KeyID,
  TxDestination,
  CurrencyValueMap,
  DEST_ID,
  EVALS,
  OptCCParams,
  ReserveTransfer,
  RESERVE_TRANSFER_BURN_CHANGE_PRICE,
  RESERVE_TRANSFER_DESTINATION,
  RESERVE_TRANSFER_VALID,
  SmartTransactionScript,
  TransferDestination,
  fromBase58Check,
} from "verus-typescript-primitives";
import { VerusdRpcInterface } from "verusd-rpc-ts-client";
import {
  fundRegistration,
  parseTransaction,
  paymentOutput,
  readFundingOutput,
  readRegistrationPrevout,
  safeNative,
  validateRegistrationTransaction,
  RegistrationAmounts,
  RegistrationChainSnapshot,
  RegistrationFundingInput,
  RegistrationPlannedOutput,
} from "../identity/registrationTransaction";

const SYSTEM = new TxDestination(
  new IdentityID(Buffer.alloc(20, 1))
).toAddress();
const TOKEN = new TxDestination(
  new IdentityID(Buffer.alloc(20, 2))
).toAddress();
const OTHER_TOKEN = new TxDestination(
  new IdentityID(Buffer.alloc(20, 3))
).toAddress();
const CONTROLLER = new TxDestination(
  new KeyID(Buffer.alloc(20, 4))
).toAddress();
const RECIPIENT = new TxDestination(new KeyID(Buffer.alloc(20, 5))).toAddress();
const snapshot: RegistrationChainSnapshot = {
  systemID: SYSTEM,
  rootSystemName: "VRSCTEST",
  tipHeight: 100,
  tipHash: "ab".repeat(32),
  candidateHeight: 101,
  expiryDelta: 20,
  expiryHeight: 121,
};

type Source = {
  input: RegistrationFundingInput;
  scriptHex: string;
  value: number;
};
let sourceNonce = 1;

function source(scriptHex: string, value: number): Source {
  const builder = new TransactionBuilder(networks.verus);
  builder.setVersion(4);
  builder.setVersionGroupId(0x892f2085);
  builder.setExpiryHeight(100);
  builder.addInput(Buffer.alloc(32, sourceNonce++), 0);
  builder.addOutput(Buffer.from(scriptHex, "hex"), value);
  const tx = builder.buildIncomplete();
  return {
    input: { txid: tx.getId(), vout: 0, rawTransaction: tx.toHex() },
    scriptHex,
    value,
  };
}

function coins(atomic: number): string {
  const text = String(atomic).padStart(9, "0");
  return text.slice(0, -8) + "." + text.slice(-8);
}

function funding(values: RegistrationAmounts): Source {
  const output = paymentOutput(CONTROLLER, values, SYSTEM, "change");
  return source(output.scriptHex, safeNative(output.value));
}

function commitment(value = 0): Source {
  return source(
    IdentityCommitmentScript.fromCommitment(
      new CommitmentHash({ hash: Buffer.alloc(32, 7) }),
      new TxDestination(new KeyID(Buffer.alloc(20, 4)))
    )
      .toBuffer()
      .toString("hex"),
    value
  );
}

function rpcFor(sources: Source[], override: Record<string, unknown> = {}) {
  const find = (txid: string, vout: number) => {
    const found = sources.find(
      (item) => item.input.txid === txid && item.input.vout === vout
    );
    if (!found) throw new Error("Unexpected outpoint");
    return found;
  };
  const methods = {
    getRawTransaction: jest.fn(async (txid: string) => ({
      result: find(txid, 0).input.rawTransaction,
      error: null,
    })),
    getTxOut: jest.fn(
      async (txid: string, vout: number, includeMempool: boolean) => {
        expect(includeMempool).toBe(true);
        const item = find(txid, vout);
        return {
          error: null,
          result: {
            bestblock: snapshot.tipHash,
            confirmations: 2,
            value: coins(item.value),
            scriptPubKey: { hex: item.scriptHex },
            version: 4,
            coinbase: false,
            ...override,
          },
        };
      }
    ),
  };
  return { ...methods, rpc: methods as unknown as VerusdRpcInterface };
}

function planned(values: RegistrationAmounts): RegistrationPlannedOutput {
  return paymentOutput(RECIPIENT, values, SYSTEM, "issuer-payment");
}

describe("registration transaction funding and validation", () => {
  test("keeps the confirmed zero-value commitment first and appends approved funding", async () => {
    const nameCommitment = commitment();
    const coin = funding({ [SYSTEM]: "50000" });
    const calls = rpcFor([nameCommitment, coin]);
    const mandatory = await readRegistrationPrevout(
      calls.rpc,
      nameCommitment.input,
      snapshot,
      true
    );
    const result = await fundRegistration(
      calls.rpc,
      snapshot,
      [planned({ [SYSTEM]: "5000" })],
      "1000",
      [coin.input],
      CONTROLLER,
      mandatory
    );
    expect(result.prevouts.map((input) => input.txid)).toEqual([
      nameCommitment.input.txid,
      coin.input.txid,
    ]);
    expect(result.prevouts[0].value).toBe("0");
    expect(result.outputPlan.map((output) => output.role)).toEqual([
      "issuer-payment",
      "change",
    ]);
    expect(result.outputPlan[1].values).toEqual({ [SYSTEM]: "44000" });
    expect(
      validateRegistrationTransaction({
        ...result,
        snapshot,
        nativeFee: "1000",
      })
    ).toBe(true);
  });

  test("credits the actual native value of a mandatory commitment and returns its excess", async () => {
    const nameCommitment = commitment(7000);
    const calls = rpcFor([nameCommitment]);
    const mandatory = await readRegistrationPrevout(
      calls.rpc,
      nameCommitment.input,
      snapshot,
      true
    );
    const result = await fundRegistration(
      calls.rpc,
      snapshot,
      [planned({ [SYSTEM]: "5000" })],
      "1000",
      [],
      CONTROLLER,
      mandatory
    );
    expect(result.prevouts).toHaveLength(1);
    expect(result.outputPlan[1].values).toEqual({ [SYSTEM]: "1000" });
    expect(
      validateRegistrationTransaction({
        ...result,
        snapshot,
        nativeFee: "1000",
      })
    ).toBe(true);
  });

  test("preserves multiple reserve balances and amounts beyond JavaScript integer precision", async () => {
    const coin = funding({
      [SYSTEM]: "50000",
      [TOKEN]: "9007199254740993",
      [OTHER_TOKEN]: "42",
    });
    const calls = rpcFor([coin]);
    const result = await fundRegistration(
      calls.rpc,
      snapshot,
      [planned({ [TOKEN]: "9007199254740983" })],
      "1000",
      [coin.input],
      CONTROLLER
    );
    expect(result.outputPlan[1].values).toEqual({
      [SYSTEM]: "49000",
      [TOKEN]: "10",
      [OTHER_TOKEN]: "42",
    });
    const change = parseTransaction(result.txHex).outs[1];
    expect(readFundingOutput(change.script, change.value, SYSTEM)).toEqual(
      result.outputPlan[1].values
    );
    expect(
      validateRegistrationTransaction({
        ...result,
        snapshot,
        nativeFee: "1000",
      })
    ).toBe(true);
  });

  test("selects inputs in the approved order until every required currency is funded", async () => {
    const native = funding({ [SYSTEM]: "2000" });
    const reserve = funding({ [SYSTEM]: "0", [TOKEN]: "60" });
    const unused = funding({ [SYSTEM]: "3000" });
    const calls = rpcFor([native, reserve]);
    const result = await fundRegistration(
      calls.rpc,
      snapshot,
      [planned({ [TOKEN]: "50" })],
      "1000",
      [native.input, reserve.input, unused.input],
      CONTROLLER
    );
    expect(result.prevouts.map((input) => input.txid)).toEqual([
      native.input.txid,
      reserve.input.txid,
    ]);
    expect(calls.getTxOut).toHaveBeenCalledTimes(2);
    expect(result.outputPlan[1].values).toEqual({
      [SYSTEM]: "1000",
      [TOKEN]: "10",
    });
  });

  test("rejects insufficient reserve funds even when native funds cover all native outputs", async () => {
    const coin = funding({ [SYSTEM]: "50000", [TOKEN]: "49" });
    await expect(
      fundRegistration(
        rpcFor([coin]).rpc,
        snapshot,
        [planned({ [TOKEN]: "50" })],
        "1000",
        [coin.input],
        CONTROLLER
      )
    ).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
  });

  test("rejects repeated funding and a repeated mandatory outpoint before selecting coins", async () => {
    const coin = funding({ [SYSTEM]: "50000" });
    const calls = rpcFor([coin]);
    await expect(
      fundRegistration(
        calls.rpc,
        snapshot,
        [],
        "1000",
        [coin.input, coin.input],
        CONTROLLER
      )
    ).rejects.toMatchObject({ code: "DUPLICATE_INPUT" });
    expect(calls.getTxOut).not.toHaveBeenCalled();
    const nameCommitment = commitment();
    const mandatory = await readRegistrationPrevout(
      rpcFor([nameCommitment]).rpc,
      nameCommitment.input,
      snapshot,
      true
    );
    await expect(
      fundRegistration(
        calls.rpc,
        snapshot,
        [],
        "1000",
        [nameCommitment.input, coin.input],
        CONTROLLER,
        mandatory
      )
    ).rejects.toMatchObject({ code: "DUPLICATE_INPUT" });
  });

  test("fetches omitted raw bytes and rejects source transaction hash or vout mismatches", async () => {
    const coin = funding({ [SYSTEM]: "50000" });
    const calls = rpcFor([coin]);
    const verified = await readRegistrationPrevout(
      calls.rpc,
      { txid: coin.input.txid, vout: 0 },
      snapshot
    );
    expect(verified.rawTransaction).toBe(coin.input.rawTransaction);
    expect(calls.getRawTransaction).toHaveBeenCalledWith(coin.input.txid, 0);
    await expect(
      readRegistrationPrevout(
        calls.rpc,
        { ...coin.input, txid: "ff".repeat(32) },
        snapshot
      )
    ).rejects.toMatchObject({ code: "PREVOUT_MISMATCH" });
    await expect(
      readRegistrationPrevout(calls.rpc, { ...coin.input, vout: 1 }, snapshot)
    ).rejects.toMatchObject({ code: "INVALID_OUTPOINT" });
  });

  test.each([
    ["value", { value: "0.00050001" }, "PREVOUT_MISMATCH"],
    ["script", { scriptPubKey: { hex: "51" } }, "PREVOUT_MISMATCH"],
    ["tip", { bestblock: "ff".repeat(32) }, "STALE_CHAIN_CONTEXT"],
    ["coinbase", { coinbase: true }, "PREVOUT_MISMATCH"],
    ["interest", { interest: 0.00001 }, "UNSUPPORTED_FUNDING"],
    ["confirmation count", { confirmations: -1 }, "INVALID_CONFIRMATION"],
  ])(
    "rejects inconsistent live %s evidence",
    async (_label, override, code) => {
      const coin = funding({ [SYSTEM]: "50000" });
      await expect(
        readRegistrationPrevout(
          rpcFor([coin], override as Record<string, unknown>).rpc,
          coin.input,
          snapshot
        )
      ).rejects.toMatchObject({ code });
    }
  );

  test("derives coinbase status from raw bytes even when RPC claims ordinary funding", async () => {
    const coin = funding({ [SYSTEM]: "50000" });
    const transaction = parseTransaction(coin.input.rawTransaction!);
    transaction.ins[0].hash = Buffer.alloc(32);
    transaction.ins[0].index = 0xffffffff;
    coin.input = {
      txid: transaction.getId(),
      vout: 0,
      rawTransaction: transaction.toHex(),
    };
    await expect(
      readRegistrationPrevout(rpcFor([coin]).rpc, coin.input, snapshot)
    ).rejects.toMatchObject({ code: "PREVOUT_MISMATCH" });
    await expect(
      readRegistrationPrevout(
        rpcFor([coin], { coinbase: true }).rpc,
        coin.input,
        snapshot
      )
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FUNDING" });
  });

  test("requires commitment confirmation and detects mempool-spent funding", async () => {
    const nameCommitment = commitment();
    await expect(
      readRegistrationPrevout(
        rpcFor([nameCommitment], { confirmations: 0 }).rpc,
        nameCommitment.input,
        snapshot,
        true
      )
    ).rejects.toMatchObject({ code: "COMMITMENT_UNCONFIRMED" });
    const spent = {
      getTxOut: async () => ({ result: null, error: null }),
    } as unknown as VerusdRpcInterface;
    await expect(
      readRegistrationPrevout(spent, nameCommitment.input, snapshot, true)
    ).rejects.toMatchObject({ code: "COMMITMENT_SPENT" });
  });

  test("preserves the largest supported native integer and rejects the adjacent unsafe value", async () => {
    const coin = funding({ [SYSTEM]: "2100000000000000" });
    const result = await fundRegistration(
      rpcFor([coin]).rpc,
      snapshot,
      [planned({ [SYSTEM]: "1" })],
      "1",
      [coin.input],
      CONTROLLER
    );
    expect(result.outputPlan[1].value).toBe("2099999999999998");
    expect(
      validateRegistrationTransaction({ ...result, snapshot, nativeFee: "1" })
    ).toBe(true);
    expect(() => safeNative("9007199254740992")).toThrow("safe integer");
    expect(() => safeNative("2100000000000001")).toThrow("monetary limit");
    expect(() => safeNative("9223372036854775808")).toThrow("monetary range");
  });

  test.each([
    "output amount",
    "output destination",
    "expiry",
    "locktime",
    "input sequence",
    "version group",
  ])("rejects a candidate with changed %s", async (field) => {
    const coin = funding({ [SYSTEM]: "50000" });
    const result = await fundRegistration(
      rpcFor([coin]).rpc,
      snapshot,
      [planned({ [SYSTEM]: "5000" })],
      "1000",
      [coin.input],
      CONTROLLER
    );
    const tx = parseTransaction(result.txHex);
    if (field === "output amount") tx.outs[0].value++;
    if (field === "output destination")
      tx.outs[0].script = Buffer.from(
        paymentOutput(
          CONTROLLER,
          { [SYSTEM]: "5000" },
          SYSTEM,
          "issuer-payment"
        ).scriptHex,
        "hex"
      );
    if (field === "expiry") tx.expiryHeight++;
    if (field === "locktime") tx.locktime++;
    if (field === "input sequence") tx.ins[0].sequence--;
    if (field === "version group") tx.versionGroupId--;
    expect(() =>
      validateRegistrationTransaction(
        { ...result, snapshot, nativeFee: "1000" },
        tx.toHex()
      )
    ).toThrow("approved registration plan");
  });

  test("rejects signing metadata in a different order from the transaction inputs", async () => {
    const native = funding({ [SYSTEM]: "2000" });
    const reserve = funding({ [SYSTEM]: "0", [TOKEN]: "60" });
    const result = await fundRegistration(
      rpcFor([native, reserve]).rpc,
      snapshot,
      [planned({ [TOKEN]: "50" })],
      "1000",
      [native.input, reserve.input],
      CONTROLLER
    );
    result.prevouts.reverse();
    expect(() =>
      validateRegistrationTransaction({
        ...result,
        snapshot,
        nativeFee: "1000",
      })
    ).toThrow("approved outpoints");
  });

  test("rejects forged reserve metadata on a previous output", async () => {
    const coin = funding({ [SYSTEM]: "50000", [TOKEN]: "100" });
    const result = await fundRegistration(
      rpcFor([coin]).rpc,
      snapshot,
      [planned({ [TOKEN]: "90" })],
      "1000",
      [coin.input],
      CONTROLLER
    );
    result.prevouts[0].values[TOKEN] = "101";
    expect(() =>
      validateRegistrationTransaction({
        ...result,
        snapshot,
        nativeFee: "1000",
      })
    ).toThrow("previous output currency amounts");
  });

  test("derives reserve output balances from bytes rather than trusting output-plan metadata", async () => {
    const coin = funding({ [SYSTEM]: "50000", [TOKEN]: "100" });
    const result = await fundRegistration(
      rpcFor([coin]).rpc,
      snapshot,
      [planned({ [TOKEN]: "100" })],
      "1000",
      [coin.input],
      CONTROLLER
    );
    const tx = parseTransaction(result.txHex);
    const incorrect = planned({ [TOKEN]: "90" });
    tx.outs[0].script = Buffer.from(incorrect.scriptHex, "hex");
    result.txHex = tx.toHex();
    result.outputPlan[0].scriptHex = incorrect.scriptHex;
    expect(() =>
      validateRegistrationTransaction({
        ...result,
        snapshot,
        nativeFee: "1000",
      })
    ).toThrow("currency metadata");
  });

  test("rejects a transfer output mislabeled as a commitment", async () => {
    const coin = funding({ [SYSTEM]: "50000" });
    const result = await fundRegistration(
      rpcFor([coin]).rpc,
      snapshot,
      [planned({ [SYSTEM]: "5000" })],
      "1000",
      [coin.input],
      CONTROLLER
    );
    result.outputPlan[0].role = "commitment";
    expect(() =>
      validateRegistrationTransaction({
        ...result,
        snapshot,
        nativeFee: "1000",
      })
    ).toThrow();
  });

  test("validates a token burn and rejects a burn whose native value differs from its transfer fee", async () => {
    const burn = new ReserveTransfer({
      version: new BN(1),
      flags: RESERVE_TRANSFER_VALID.or(RESERVE_TRANSFER_BURN_CHANGE_PRICE),
      values: new CurrencyValueMap({
        valueMap: new Map([[TOKEN, new BN(100)]]),
      }),
      feeCurrencyID: SYSTEM,
      feeAmount: new BN(20000),
      destCurrencyID: TOKEN,
      transferDestination: new TransferDestination({
        type: DEST_ID,
        destinationBytes: fromBase58Check(TOKEN).hash,
      }),
    });
    const dest = new TxDestination(
      KeyID.fromAddress(RESERVE_TRANSFER_DESTINATION.getAddressString())
    );
    const master = new OptCCParams({
      version: new BN(3),
      evalCode: new BN(0),
      m: new BN(1),
      n: new BN(1),
      destinations: [dest],
      vData: [],
    });
    const condition = new OptCCParams({
      version: new BN(3),
      evalCode: new BN(EVALS.EVAL_RESERVE_TRANSFER),
      m: new BN(1),
      n: new BN(1),
      destinations: [dest],
      vData: [burn.toBuffer()],
    });
    const output: RegistrationPlannedOutput = {
      role: "burn",
      scriptHex: new SmartTransactionScript(master, condition)
        .toBuffer()
        .toString("hex"),
      value: "20000",
      values: { [SYSTEM]: "20000", [TOKEN]: "100" },
    };
    const coin = funding({ [SYSTEM]: "50000", [TOKEN]: "100" });
    const result = await fundRegistration(
      rpcFor([coin]).rpc,
      snapshot,
      [output],
      "1000",
      [coin.input],
      CONTROLLER
    );
    expect(
      validateRegistrationTransaction({
        ...result,
        snapshot,
        nativeFee: "1000",
      })
    ).toBe(true);
    burn.feeAmount = new BN(10000);
    condition.vData[0] = burn.toBuffer();
    const scriptHex = new SmartTransactionScript(master, condition)
      .toBuffer()
      .toString("hex");
    const tx = parseTransaction(result.txHex);
    tx.outs[0].script = Buffer.from(scriptHex, "hex");
    result.txHex = tx.toHex();
    result.outputPlan[0].scriptHex = scriptHex;
    expect(() =>
      validateRegistrationTransaction({
        ...result,
        snapshot,
        nativeFee: "1000",
      })
    ).toThrow("burn transfer");
  });
});
