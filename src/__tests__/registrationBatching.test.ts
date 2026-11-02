import { networks, TransactionBuilder } from "@bitgo/utxo-lib";
import {
  ApiRequest,
  IdentityID,
  KeyID,
  TxDestination,
} from "verus-typescript-primitives";
import { VerusdRpcInterface } from "verusd-rpc-ts-client";
import {
  createRegistrationRpc,
  registrationReadMany,
  RegistrationRead,
} from "../identity/registrationRpc";
import {
  assertRegistrationSnapshot,
  fundRegistration,
  paymentOutput,
  readRegistrationPrevout,
  readRegistrationPrevouts,
  RegistrationChainSnapshot,
  RegistrationFundingInput,
} from "../identity/registrationTransaction";

const SYSTEM = new TxDestination(
  new IdentityID(Buffer.alloc(20, 1))
).toAddress();
const OWNER = new TxDestination(new KeyID(Buffer.alloc(20, 2))).toAddress();
const snapshot: RegistrationChainSnapshot = {
  systemID: SYSTEM,
  rootSystemName: "VRSCTEST",
  tipHeight: 100,
  tipHash: "ab".repeat(32),
  candidateHeight: 101,
  expiryDelta: 20,
  expiryHeight: 121,
};

const ok = (result: unknown) => ({ result, error: null });

function funding(nonce = 1, outputs = 1) {
  const output = paymentOutput(OWNER, { [SYSTEM]: "50000" }, SYSTEM, "change");
  const builder = new TransactionBuilder(networks.verus);
  builder.setVersion(4);
  builder.setVersionGroupId(0x892f2085);
  builder.setExpiryHeight(90);
  builder.addInput(Buffer.alloc(32, nonce), 0);
  for (let i = 0; i < outputs; i++) {
    builder.addOutput(Buffer.from(output.scriptHex, "hex"), 50000);
  }
  const tx = builder.buildIncomplete();
  return {
    input: {
      txid: tx.getId(),
      vout: 0,
      rawTransaction: tx.toHex(),
    } as RegistrationFundingInput,
    unspent: {
      bestblock: snapshot.tipHash,
      confirmations: 2,
      value: "0.00050000",
      scriptPubKey: { hex: output.scriptHex },
      version: 4,
      coinbase: false,
    },
  };
}

function fixture() {
  const source = funding();
  const calls = {
    chain: SYSTEM,
    getCurrency: jest.fn(async () =>
      ok({ currencyid: SYSTEM, name: "VRSCTEST" })
    ),
    getInfo: jest.fn(async () => ok({ blocks: snapshot.tipHeight })),
    getBlock: jest.fn(async () =>
      ok({
        hash: snapshot.tipHash,
        height: snapshot.tipHeight,
        confirmations: 1,
      })
    ),
    getRawTransaction: jest.fn(async (_txid?: string) =>
      ok(source.input.rawTransaction)
    ),
    getTxOut: jest.fn(async (_txid?: string, _vout?: number) =>
      ok(source.unspent)
    ),
  };
  const rpc = calls as unknown as VerusdRpcInterface;

  // Model a host-owned batch transport, leaving real validation in the SDK.
  const requestMany = jest.fn(async (reads: ApiRequest[]) => {
    const methods = Object.keys(calls);
    return Promise.all(
      reads.map((read) => {
        const method = methods.find((name) => name.toLowerCase() === read.cmd)!;
        return (calls as any)[method](...read.getParams());
      })
    );
  });
  const batched = Object.assign({}, calls, {
    requestMany,
  }) as unknown as VerusdRpcInterface;
  return { calls, rpc, batched, requestMany, source };
}

describe("registration batch reads", () => {
  test("uses sequential single requests when no batch hook is supplied", async () => {
    const h = fixture();
    let finish!: () => void;
    h.calls.getInfo.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(ok({ blocks: 100 }));
        })
    );

    const pending = registrationReadMany(h.rpc, [
      ["getInfo"],
      ["getBlock", "100", 1],
    ]);
    expect(h.calls.getInfo).toHaveBeenCalledTimes(1);
    expect(h.calls.getBlock).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(h.calls.getBlock).toHaveBeenCalledTimes(1);
  });

  test("preserves parallel single requests for callsites that explicitly opt in", async () => {
    const h = fixture();
    let finish!: () => void;
    h.calls.getInfo.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(ok({ blocks: 100 }));
        })
    );

    const pending = registrationReadMany(
      createRegistrationRpc(h.rpc),
      [["getInfo"], ["getBlock", "100", 1]],
      true
    );
    expect(h.calls.getInfo).toHaveBeenCalledTimes(1);
    expect(h.calls.getBlock).toHaveBeenCalledTimes(1);
    finish();
    await pending;
    expect(h.requestMany).not.toHaveBeenCalled();
  });

  test.each([
    ["missing results", []],
    ["missing one result", [ok({ blocks: 100 })]],
    ["extra result", [ok({}), ok({}), ok({})]],
    ["invalid result envelope", [ok({ blocks: 100 }), null]],
  ])("rejects a malformed batch with %s", async (_, response) => {
    const h = fixture();
    h.requestMany.mockResolvedValue(response as any);

    await expect(
      assertRegistrationSnapshot(h.batched, snapshot)
    ).rejects.toThrow();
  });

  test("splits large read groups into sequential batches of at most twenty", async () => {
    const h = fixture();
    const sizes: number[] = [];
    let active = 0;
    let maximumActive = 0;
    h.requestMany.mockImplementation(async (reads) => {
      sizes.push(reads.length);
      active++;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active--;
      return reads.map((read) => ok(read.getParams()[1]));
    });
    const reads: RegistrationRead[] = Array.from({ length: 45 }, (_, vout) => [
      "getTxOut",
      h.source.input.txid,
      vout,
      true,
    ]);
    const responses = await registrationReadMany(h.batched, reads);

    expect(sizes).toEqual([20, 20, 5]);
    expect(maximumActive).toBe(1);
    expect(responses.map((response) => response.result)).toEqual(
      Array.from({ length: 45 }, (_, i) => i)
    );
  });

  test("groups snapshot revalidation at the already known height", async () => {
    const h = fixture();
    await assertRegistrationSnapshot(h.batched, snapshot);

    expect(h.requestMany).toHaveBeenCalledTimes(1);
    expect(
      h.requestMany.mock.calls[0][0].map((read) => read.prepare())
    ).toEqual([
      [SYSTEM, "getinfo", []],
      [SYSTEM, "getblock", ["100", 1]],
    ]);
  });

  test("keeps existing clients working without a batch hook", async () => {
    const h = fixture();
    await assertRegistrationSnapshot(h.rpc, snapshot);

    expect(h.calls.getInfo).toHaveBeenCalledTimes(1);
    expect(h.calls.getBlock).toHaveBeenCalledWith("100", 1);
    expect(h.requestMany).not.toHaveBeenCalled();
  });

  test.each([
    ["info height", { blocks: 101 }, null],
    [
      "block hash",
      null,
      { hash: "cd".repeat(32), height: 100, confirmations: 1 },
    ],
    [
      "block height",
      null,
      { hash: snapshot.tipHash, height: 99, confirmations: 1 },
    ],
    [
      "confirmations",
      null,
      { hash: snapshot.tipHash, height: 100, confirmations: 2 },
    ],
  ])(
    "still rejects a changed %s in a batched snapshot",
    async (_, info, block) => {
      const h = fixture();
      if (info) h.calls.getInfo.mockResolvedValue(ok(info));
      if (block) h.calls.getBlock.mockResolvedValue(ok(block));

      await expect(
        assertRegistrationSnapshot(h.batched, snapshot)
      ).rejects.toMatchObject({
        code: "STALE_CHAIN_CONTEXT",
      });
    }
  );

  test("groups missing transaction bytes and the fresh spendability check", async () => {
    const h = fixture();
    const { txid, vout } = h.source.input;
    const result = await readRegistrationPrevout(
      h.batched,
      { txid, vout },
      snapshot
    );

    expect(
      h.requestMany.mock.calls[0][0].map((read) => read.prepare())
    ).toEqual([
      [SYSTEM, "getrawtransaction", [txid, 0]],
      [SYSTEM, "gettxout", [txid, vout, true]],
    ]);
    expect(result.rawTransaction).toBe(h.source.input.rawTransaction);
    expect(result.values).toEqual({ [SYSTEM]: "50000" });
  });

  test("reuses supplied transaction bytes but always checks spendability", async () => {
    const h = fixture();
    await readRegistrationPrevout(h.batched, h.source.input, snapshot);

    expect(h.calls.getRawTransaction).not.toHaveBeenCalled();
    expect(h.calls.getTxOut).toHaveBeenCalledWith(h.source.input.txid, 0, true);
  });

  test("rejects a spent output returned by a batch", async () => {
    const h = fixture();
    const { txid, vout } = h.source.input;
    h.calls.getTxOut.mockResolvedValue(ok(null));

    await expect(
      readRegistrationPrevout(h.batched, { txid, vout }, snapshot)
    ).rejects.toMatchObject({
      code: "FUNDING_SPENT",
    });
  });

  test("still binds a batched raw transaction to the requested hash", async () => {
    const h = fixture();
    const { txid, vout } = h.source.input;
    h.calls.getRawTransaction.mockResolvedValue(
      ok(funding(2).input.rawTransaction)
    );

    await expect(
      readRegistrationPrevout(h.batched, { txid, vout }, snapshot)
    ).rejects.toMatchObject({
      code: "PREVOUT_MISMATCH",
    });
  });

  test("still binds a batched unspent output to its transaction bytes", async () => {
    const h = fixture();
    const { txid, vout } = h.source.input;
    h.calls.getTxOut.mockResolvedValue(
      ok({ ...h.source.unspent, value: "0.00060000" })
    );

    await expect(
      readRegistrationPrevout(h.batched, { txid, vout }, snapshot)
    ).rejects.toMatchObject({
      code: "PREVOUT_MISMATCH",
    });
  });

  test("fetches shared transaction bytes once for a known group of outputs", async () => {
    const h = fixture();
    const source = funding(3, 2);
    h.calls.getRawTransaction.mockResolvedValue(
      ok(source.input.rawTransaction)
    );
    const txid = source.input.txid;
    const result = await readRegistrationPrevouts(
      h.batched,
      [
        { txid, vout: 1 },
        { txid, vout: 0 },
      ],
      snapshot
    );

    expect(h.requestMany).toHaveBeenCalledTimes(1);
    expect(
      h.requestMany.mock.calls[0][0].map((read) => read.prepare())
    ).toEqual([
      [SYSTEM, "getrawtransaction", [txid, 0]],
      [SYSTEM, "gettxout", [txid, 1, true]],
      [SYSTEM, "gettxout", [txid, 0, true]],
    ]);
    expect(result.map((prevout) => prevout.vout)).toEqual([1, 0]);
    expect(
      result.every(
        (prevout) => prevout.rawTransaction === source.input.rawTransaction
      )
    ).toBe(true);
  });

  test("batches only the approved funding inputs needed to cover costs", async () => {
    const h = fixture();
    const sources = [funding(1), funding(2), funding(3)];
    h.calls.getTxOut.mockImplementation(async (txid) =>
      ok(sources.find((source) => source.input.txid === txid)?.unspent)
    );
    const result = await fundRegistration(
      h.batched,
      snapshot,
      [paymentOutput(OWNER, { [SYSTEM]: "75000" }, SYSTEM, "issuer-payment")],
      "1000",
      sources.map((source) => source.input),
      OWNER
    );

    expect(result.prevouts.map((prevout) => prevout.txid)).toEqual(
      sources.slice(0, 2).map((source) => source.input.txid)
    );
    expect(h.requestMany).toHaveBeenCalledTimes(1);
    expect(
      h.requestMany.mock.calls[0][0].map((read) => read.prepare())
    ).toEqual(
      sources
        .slice(0, 2)
        .map((source) => [SYSTEM, "gettxout", [source.input.txid, 0, true]])
    );
    expect(h.calls.getRawTransaction).not.toHaveBeenCalled();
    expect(result.outputPlan[1].values).toEqual({ [SYSTEM]: "24000" });
  });
});

describe("registration read reuse", () => {
  test("shares simultaneous currency reads and reuses them only for this operation", async () => {
    const h = fixture();
    const scoped = createRegistrationRpc(h.rpc);
    const [first, second] = await Promise.all([
      scoped.getCurrency(SYSTEM),
      scoped.getCurrency(SYSTEM),
    ]);
    await scoped.getCurrency(SYSTEM);
    expect(first).toEqual(second);
    expect(h.calls.getCurrency).toHaveBeenCalledTimes(1);

    // Nested registration helpers keep the scope; a new preparation gets fresh data.
    expect(createRegistrationRpc(scoped)).toBe(scoped);
    await createRegistrationRpc(h.rpc).getCurrency(SYSTEM);
    expect(h.calls.getCurrency).toHaveBeenCalledTimes(2);
  });

  test("does not retain failed currency lookups", async () => {
    const h = fixture();
    h.calls.getCurrency.mockResolvedValueOnce({
      result: null,
      error: { code: -5, message: "Currency not found" },
    } as any);
    const scoped = createRegistrationRpc(h.rpc);

    expect((await scoped.getCurrency(SYSTEM)).error).toBeTruthy();
    expect((await scoped.getCurrency(SYSTEM)).error).toBeNull();
    expect(h.calls.getCurrency).toHaveBeenCalledTimes(2);
  });

  test("does not retain rejected currency requests", async () => {
    const h = fixture();
    h.calls.getCurrency.mockRejectedValueOnce(new Error("Connection lost"));
    const scoped = createRegistrationRpc(h.rpc);

    await expect(scoped.getCurrency(SYSTEM)).rejects.toThrow("Connection lost");
    await expect(scoped.getCurrency(SYSTEM)).resolves.toHaveProperty(
      "error",
      null
    );
    expect(h.calls.getCurrency).toHaveBeenCalledTimes(2);
  });

  test("reuses raw bytes while refreshing spendability on every read", async () => {
    const h = fixture();
    const scoped = createRegistrationRpc(h.rpc);
    const { txid, vout } = h.source.input;
    await readRegistrationPrevout(scoped, { txid, vout }, snapshot);
    h.calls.getTxOut.mockResolvedValueOnce(ok(null));

    await expect(
      readRegistrationPrevout(scoped, { txid, vout }, snapshot)
    ).rejects.toMatchObject({
      code: "FUNDING_SPENT",
    });
    expect(h.calls.getRawTransaction).toHaveBeenCalledTimes(1);
    expect(h.calls.getTxOut).toHaveBeenCalledTimes(2);
  });
});
