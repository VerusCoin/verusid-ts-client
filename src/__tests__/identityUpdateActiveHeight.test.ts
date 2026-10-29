import BN from "bn.js";
import { Transaction, networks, smarttxs } from "@bitgo/utxo-lib";
import {
  DEST_PKH,
  Identity,
  IdentityScript,
  IdentityUpdateRequestDetails,
  PartialIdentity,
  TransferDestination,
  fromBase58Check,
} from "verus-typescript-primitives";
import { VerusIdInterface } from "../index";
import { TEST_ID_3, VERUSTEST_I_ADDR } from "./fixtures/verusid";

const HEIGHT = 30000;
const CHANGE = TEST_ID_3.identity.primaryaddresses[0];
type Mode = "plain" | "combined";

function fixture(info: unknown, sourceUnlock = 0, sourceFlags = 0) {
  const current = Identity.fromJson(TEST_ID_3.identity);
  current.flags = new BN(sourceFlags);
  current.unlockAfter = new BN(sourceUnlock);
  const source = Transaction.fromHex(
    smarttxs.createUnfundedIdentityUpdate(
      current.toBuffer().toString("hex"),
      networks.verus,
      HEIGHT + 20
    ),
    networks.verus
  );
  source.addInput(Buffer.alloc(32, 79), 0);
  const state = { fundedHex: "" };
  const rpc = jest.fn(async (request: any): Promise<any> => {
    if (request.method === "getinfo") {
      return { id: request.id, error: null, result: info };
    }
    if (request.method === "fundrawtransaction") {
      state.fundedHex = request.params[0];
      throw new Error("Reached funding");
    }
    throw new Error(`Unexpected RPC ${request.method}`);
  });
  const client = new VerusIdInterface(
    VERUSTEST_I_ADDR,
    "https://offline.invalid",
    undefined,
    rpc
  );
  const run = (
    request: Identity | IdentityUpdateRequestDetails,
    mode: Mode,
    currentHeight?: number
  ) =>
    mode === "plain"
      ? client.createUpdateIdentityTransaction(
          request,
          CHANGE,
          source.toHex(),
          HEIGHT - 1,
          undefined,
          VERUSTEST_I_ADDR,
          undefined,
          undefined,
          currentHeight,
          undefined,
          false,
          true
        )
      : client.createUpdateIdentityWithCurrencyTransferTransaction(
          request,
          CHANGE,
          source.toHex(),
          HEIGHT - 1,
          [
            {
              currencies: { [VERUSTEST_I_ADDR]: "1" },
              address: new TransferDestination({
                type: DEST_PKH,
                destinationBytes: fromBase58Check(CHANGE).hash,
              }),
            },
          ],
          [],
          {
            chainIAddr: VERUSTEST_I_ADDR,
            currentHeight,
            isTestnet: true,
            parseVdxfObjects: false,
          }
        );
  return { current, rpc, run, state };
}

function partial(current: Identity, fields: Record<string, unknown> = {}) {
  return new IdentityUpdateRequestDetails({
    identity: new PartialIdentity({
      name: current.name,
      parent: current.parent,
      ...fields,
    }),
  });
}

describe("identity update lock checks use the active chain height", () => {
  test.each(
    (["plain", "combined"] as const).flatMap((mode) =>
      (["full", "partial"] as const).map((kind) => ({ mode, kind }))
    )
  )(
    "rejects premature pending unlock in $mode/$kind while longestchain is ahead",
    async ({ mode, kind }) => {
      const f = fixture(
        { blocks: HEIGHT, longestchain: HEIGHT + 100 },
        HEIGHT + 50
      );
      const next = Identity.fromJson(f.current.toJson());
      next.unlockAfter = new BN(0);
      const request =
        kind === "full" ? next : partial(f.current, { unlockAfter: new BN(0) });
      await expect(f.run(request, mode)).rejects.toThrow(/lock|unlock/i);
      expect(f.rpc.mock.calls.map((call) => call[0].method)).toEqual([
        "getinfo",
      ]);
    }
  );

  test.each(["plain", "combined"] as const)(
    "binds unlock normalization to active-height expiry in %s",
    async (mode) => {
      const f = fixture({ blocks: HEIGHT, longestchain: HEIGHT + 100 }, 60, 2);
      const request = partial(f.current, {
        flags: new BN(0),
        unlockAfter: new BN(0),
      });
      let hex: string;
      if (mode === "plain") hex = (await f.run(request, mode)).hex;
      else {
        await expect(f.run(request, mode)).rejects.toThrow("Reached funding");
        hex = f.state.fundedHex;
      }
      const tx = Transaction.fromHex(hex!, networks.verus);
      expect(tx.expiryHeight).toBe(HEIGHT + 20);
      const script = new IdentityScript();
      script.fromBuffer(tx.outs[0].script);
      expect(script.getIdentity(false).unlockAfter.toNumber()).toBe(
        HEIGHT + 80
      );
    }
  );

  test.each(
    [undefined, null, -1, 1.5, "30000", NaN, Infinity, 499999980].flatMap(
      (blocks) =>
        (["plain", "combined"] as const).map((mode) => ({ blocks, mode }))
    )
  )(
    "rejects malformed active blocks=$blocks in $mode without falling back to longestchain",
    async ({ blocks, mode }) => {
      const f = fixture({ blocks, longestchain: HEIGHT });
      await expect(f.run(partial(f.current), mode)).rejects.toThrow(
        /preparation height/
      );
      expect(f.rpc.mock.calls.map((call) => call[0].method)).toEqual([
        "getinfo",
      ]);
    }
  );

  test.each([null, undefined])(
    "rejects a missing getinfo result (%s)",
    async (result) => {
      const f = fixture(result);
      await expect(f.run(partial(f.current), "plain")).rejects.toThrow(
        /preparation height/
      );
      expect(f.rpc).toHaveBeenCalledTimes(1);
    }
  );

  test("accepts an explicitly supplied active height without another RPC", async () => {
    const f = fixture(undefined);
    const result = await f.run(partial(f.current), "plain", HEIGHT);
    expect(Transaction.fromHex(result.hex, networks.verus).expiryHeight).toBe(
      HEIGHT + 20
    );
    expect(f.rpc).not.toHaveBeenCalled();
  });
});
