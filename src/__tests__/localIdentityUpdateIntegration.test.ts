import BN from "bn.js";
import { Transaction, networks, smarttxs } from "@bitgo/utxo-lib";
import {
  ContentMultiMap,
  Identity,
  IdentityID,
  IdentityScript,
  IdentityUpdateRequestDetails,
  PartialIdentity,
} from "verus-typescript-primitives";
import VerusIdInterface from "../VerusIdInterface";
import { TEST_ID_3, VERUSTEST_I_ADDR } from "./fixtures/verusid";

const HEIGHT = 10000;

function fixture() {
  const current = Identity.fromJson(TEST_ID_3.identity);
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const state = {
    onHeight: () => {},
    authorityResult: undefined as any,
  };
  const client = new VerusIdInterface(
    VERUSTEST_I_ADDR,
    "http://offline.invalid",
    undefined,
    async (request): Promise<any> => {
      calls.push({ method: request.method, params: request.params as any });
      if (request.method === "getinfo") {
        state.onHeight();
        return {
          id: request.id,
          error: null,
          result: { blocks: HEIGHT, longestchain: HEIGHT },
        };
      }
      if (request.method === "getidentity") {
        return state.authorityResult === undefined
          ? {
              id: request.id,
              result: null,
              error: { code: -5, message: "Identity not found" },
            }
          : { id: request.id, error: null, result: state.authorityResult };
      }
      throw new Error("Unexpected outbound RPC: " + request.method);
    }
  );
  const source = () => {
    const tx = Transaction.fromHex(
      smarttxs.createUnfundedIdentityUpdate(
        current.toBuffer().toString("hex"),
        networks.verus,
        HEIGHT + 20
      ),
      networks.verus
    );
    tx.addInput(Buffer.alloc(32, 47), 0);
    return tx;
  };
  const request = (fields: Record<string, unknown> = {}) =>
    new IdentityUpdateRequestDetails({
      identity: new PartialIdentity({
        name: current.name,
        parent: current.parent,
        ...fields,
      }),
    });
  const run = (
    value: IdentityUpdateRequestDetails,
    currentHeight: number | undefined = HEIGHT,
    suppliedTemplate?: string
  ) =>
    client.createUpdateIdentityTransaction(
      value,
      current.primaryAddresses![0].toAddress()!,
      source().toHex(),
      HEIGHT - 1,
      undefined,
      VERUSTEST_I_ADDR,
      undefined,
      undefined,
      currentHeight,
      suppliedTemplate,
      false,
      true
    );
  return { current, calls, state, client, source, request, run };
}

describe("local ordinary update integration", () => {
  test("constructs from source bytes without identity JSON or construction RPCs", async () => {
    const f = fixture();
    f.current.contentMultiMap = ContentMultiMap.fromJson({
      [VERUSTEST_I_ADDR]: "abcd",
    });
    f.current.contentMap.set(VERUSTEST_I_ADDR, Buffer.alloc(32, 9));
    // An RPC JSON identity would discard this raw state and rewrite policy.
    f.state.authorityResult = {
      identity: { ...TEST_ID_3.identity, minimumsignatures: 13 },
    };
    const result = await f.run(f.request());
    expect(result.identity.contentMultiMap.kvContent.size).toBe(0);
    expect(result.identity.contentMap.get(VERUSTEST_I_ADDR)).toEqual(
      Buffer.alloc(32, 9)
    );
    expect(result.identity.minSigs).toEqual(f.current.minSigs);
    expect(f.calls).toEqual([]);
    const tx = Transaction.fromHex(result.hex, networks.verus);
    expect(tx.ins).toHaveLength(0);
    expect(tx.outs).toHaveLength(1);
    expect(tx.expiryHeight).toBe(HEIGHT + 20);
  });

  test("snapshots partial requests before the height RPC and retries without fallback", async () => {
    const f = fixture();
    const request = f.request({
      contentMap: new Map([[VERUSTEST_I_ADDR, Buffer.alloc(32, 9)]]),
    });
    f.state.onHeight = () => {
      request.identity!.contentMap.get(VERUSTEST_I_ADDR)!.fill(8);
      request.identity!.setRecovery(
        IdentityID.fromAddress(VERUSTEST_I_ADDR).toAddress()!
      );
    };
    // Omit currentHeight via the public API to force the async boundary.
    const result = await f.client.createUpdateIdentityTransaction(
      request,
      f.current.primaryAddresses![0].toAddress()!,
      f.source().toHex(),
      HEIGHT - 1,
      undefined,
      VERUSTEST_I_ADDR,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      true
    );
    expect(result.identity.contentMap.get(VERUSTEST_I_ADDR)).toEqual(
      Buffer.alloc(32, 9)
    );
    expect(result.identity.recoveryAuthority.toBuffer()).toEqual(
      f.current.recoveryAuthority.toBuffer()
    );
    expect(f.calls.map((x) => x.method)).toEqual(["getinfo"]);
    await f.run(f.request());
    expect(f.calls.map((x) => x.method)).toEqual(["getinfo"]);
  });

  test("rejects a mismatched source transaction ID without fallback", async () => {
    const f = fixture();
    const request = f.request();
    request.setTxidFromString("01".repeat(32));
    await expect(f.run(request)).rejects.toThrow(/txid does not match/);
    await expect(f.run(request)).rejects.toThrow(/txid does not match/);
    expect(f.calls).toEqual([]);
  });

  test("honors the requested chain and expiry before any construction callbacks", async () => {
    const f = fixture();
    const wrongChain = f.request();
    wrongChain.systemID = new IdentityID(Buffer.alloc(20, 8));
    wrongChain.toggleContainsSystem();
    await expect(f.run(wrongChain)).rejects.toThrow(/chain|system/i);
    const expired = f.request();
    expired.expiryHeight = new BN(HEIGHT);
    expired.toggleExpires();
    await expect(f.run(expired)).rejects.toThrow(/expir/i);
    const valid = f.request();
    valid.expiryHeight = new BN(HEIGHT + 6);
    valid.toggleExpires();
    const result = await f.run(valid);
    expect(Transaction.fromHex(result.hex, networks.verus).expiryHeight).toBe(
      HEIGHT + 6
    );
    const laterTemplate = smarttxs.createUnfundedIdentityUpdate(
      f.current.toBuffer().toString("hex"),
      networks.verus,
      HEIGHT + 7
    );
    await expect(f.run(valid, HEIGHT, laterTemplate)).rejects.toThrow(/expir/i);
    expect(f.calls).toEqual([]);
  });

  test.each([1, 2, 3])(
    "rejects request and supplied expiry at height + %i before RPC work",
    async (delta) => {
      const f = fixture();
      const request = f.request();
      request.expiryHeight = new BN(HEIGHT + delta);
      request.toggleExpires();
      await expect(f.run(request)).rejects.toThrow(/expir/i);
      const template = smarttxs.createUnfundedIdentityUpdate(
        f.current.toBuffer().toString("hex"),
        networks.verus,
        HEIGHT + delta
      );
      await expect(f.run(f.request(), HEIGHT, template)).rejects.toThrow(
        /expir/i
      );
      expect(f.calls).toEqual([]);
    }
  );

  test("accepts the daemon relay expiry floor at height + 4", async () => {
    const f = fixture();
    const request = f.request();
    request.expiryHeight = new BN(HEIGHT + 4);
    request.toggleExpires();
    const local = await f.run(request);
    const tx = Transaction.fromHex(local.hex, networks.verus);
    expect(tx.expiryHeight).toBe(HEIGHT + 4);
    await expect(f.run(request, HEIGHT, local.hex)).resolves.toHaveProperty(
      "hex",
      local.hex
    );
    expect(f.calls).toEqual([]);
  });

  test("binds an unlock height to the final locally selected transaction expiry", async () => {
    const f = fixture();
    f.current.lock(new BN(60));
    const result = await f.run(f.request({ flags: new BN(0) }));
    const tx = Transaction.fromHex(result.hex, networks.verus);
    const script = new IdentityScript();
    script.fromBuffer(tx.outs[0].script);
    expect(script.getIdentity().unlockAfter.toNumber()).toBe(
      tx.expiryHeight + 60
    );
    expect(script.getIdentity().isLocked()).toBe(false);
    expect(f.calls).toEqual([]);
  });

  test("checks unlocks against the actual supplied template expiry", async () => {
    const f = fixture();
    f.current.lock(new BN(60));
    const updated = Identity.fromJson(f.current.toJson());
    updated.unlock(new BN(HEIGHT + 1), new BN(HEIGHT + 30));
    const template = smarttxs.createUnfundedIdentityUpdate(
      updated.toBuffer().toString("hex"),
      networks.verus,
      HEIGHT + 30
    );
    const result = await f.run(
      f.request({ flags: new BN(0) }),
      HEIGHT,
      template
    );
    expect(result.identity.unlockAfter.toNumber()).toBe(HEIGHT + 90);
    const tampered = Transaction.fromHex(template, networks.verus);
    tampered.expiryHeight += 1;
    await expect(
      f.run(f.request({ flags: new BN(0) }), HEIGHT, tampered.toHex())
    ).rejects.toThrow(/do not match/);
  });

  test("rejects a supplied template with an excessively distant expiry", async () => {
    const f = fixture();
    const template = smarttxs.createUnfundedIdentityUpdate(
      f.current.toBuffer().toString("hex"),
      networks.verus,
      HEIGHT + 1000000
    );
    await expect(f.run(f.request(), HEIGHT, template)).rejects.toThrow(
      /expir/i
    );
    expect(f.calls).toEqual([]);
  });

  test("requires changed external authorities to exist on the configured chain", async () => {
    const f = fixture();
    const authority = Identity.fromJson(TEST_ID_3.identity);
    authority.name = "local-update-authority";
    const address = authority.getIdentityAddress();
    authority.revocationAuthority = IdentityID.fromAddress(address);
    authority.recoveryAuthority = IdentityID.fromAddress(address);
    const request = f.request({
      recoveryAuthority: IdentityID.fromAddress(address),
    });
    await expect(f.run(request)).rejects.toThrow(/authority does not exist/);
    expect(f.calls).toEqual([{ method: "getidentity", params: [address] }]);
    f.state.authorityResult = { identity: authority.toJson() };
    const result = await f.run(request);
    expect(result.identity.recoveryAuthority.toAddress()).toBe(address);
    expect(f.calls.map((x) => x.method)).toEqual([
      "getidentity",
      "getidentity",
    ]);
    f.state.authorityResult = { identity: f.current.toJson() };
    await expect(f.run(request)).rejects.toThrow(/authority does not exist/);
  });

  test.each([
    { version: 0 },
    { version: undefined },
    { primaryaddresses: [] },
    { minimumsignatures: 0 },
    { minimumsignatures: 2 },
    { revocationauthority: undefined },
    { recoveryauthority: new IdentityID(Buffer.alloc(20)).toAddress() },
  ])(
    "rejects structurally invalid authority lookup data: %j",
    async (invalid) => {
      const f = fixture();
      const authority = Identity.fromJson(TEST_ID_3.identity);
      authority.name = "invalid-local-update-authority";
      authority.minSigs = new BN(1);
      authority.primaryAddresses = [authority.primaryAddresses![0]];
      const request = f.request({
        revocationAuthority: IdentityID.fromAddress(
          authority.getIdentityAddress()
        ),
      });
      f.state.authorityResult = {
        identity: { ...authority.toJson(), ...invalid },
      };
      await expect(f.run(request)).rejects.toThrow();
      expect(f.calls.map((x) => x.method)).toEqual(["getidentity"]);
    }
  );

  test("rejects invalid local mutations without remote construction or funding", async () => {
    const f = fixture();
    await expect(
      f.run(f.request({ systemId: new IdentityID(Buffer.alloc(20, 3)) }))
    ).rejects.toThrow(/cannot change its system/);
    f.current.lock(new BN(60));
    await expect(f.run(f.request({ unlockAfter: new BN(59) }))).rejects.toThrow(
      /cannot be shortened/
    );
    expect(f.calls).toEqual([]);
  });
});
