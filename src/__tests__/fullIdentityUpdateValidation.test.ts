import BN from "bn.js";
import { Transaction, networks, smarttxs } from "@bitgo/utxo-lib";
import {
  Identity,
  IdentityID,
  IdentityScript,
  TransferDestination,
  DEST_PKH,
  fromBase58Check,
  IDENTITY_FLAG_ACTIVECURRENCY,
  IDENTITY_FLAG_TOKENIZED_CONTROL,
  IDENTITY_FLAG_LOCKED,
  IDENTITY_FLAG_REVOKED,
  IDENTITY_MAX_UNLOCK_DELAY,
} from "verus-typescript-primitives";
import { VerusIdInterface } from "../index";
import {
  validateFullIdentityUpdate,
  validateIdentityUpdateTransitionInvariants,
} from "../identity/fullIdentityUpdateValidation";
import { validateIdentityLocksWithoutHeight } from "../identity/identityLocks";
import { TEST_ID_3, VERUSTEST_I_ADDR } from "./fixtures/verusid";

const HEIGHT = 30000;
const EXPIRY = HEIGHT + 20;
const CHANGE = TEST_ID_3.identity.primaryaddresses[0];
const context = { chainId: VERUSTEST_I_ADDR, nextBlockHeight: HEIGHT + 1, expiryHeight: EXPIRY };
function identity(): Identity { return Identity.fromJson(TEST_ID_3.identity); }
function copy(value: Identity): Identity {
  const result = new Identity();
  result.fromBuffer(value.toBuffer(), 0, false);
  return result;
}
function template(value: Identity): string {
  const tx = Transaction.fromHex(smarttxs.createUnfundedIdentityUpdate(
    value.toBuffer().toString("hex"), networks.verus, EXPIRY
  ), networks.verus);
  tx.addInput(Buffer.alloc(32, 47), 0);
  return tx.toHex();
}
function fixture(current: Identity, authority?: Identity) {
  const state = { fundedHex: "" };
  const rpc = jest.fn(async (request: any): Promise<any> => {
    if (request.method === "getidentity") {
      return authority && request.params[0] === authority.getIdentityAddress()
        ? { id: request.id, error: null, result: { identity: authority.toJson() } }
        : { id: request.id, result: null, error: { code: -5, message: "Identity not found" } };
    }
    if (request.method === "fundrawtransaction") {
      state.fundedHex = request.params[0];
      throw new Error("Reached funding");
    }
    throw new Error(`Unexpected RPC ${request.method}`);
  });
  const client = new VerusIdInterface(VERUSTEST_I_ADDR, "https://offline.invalid", undefined, rpc);
  const run = (next: Identity, mode: "plain" | "combined") => mode === "plain"
    ? client.createUpdateIdentityTransaction(
      next, CHANGE, template(current), HEIGHT - 1, undefined, VERUSTEST_I_ADDR,
      undefined, undefined, HEIGHT, undefined, false, true
    )
    : client.createUpdateIdentityWithCurrencyTransferTransaction(
      next, CHANGE, template(current), HEIGHT - 1,
      [{
        currencies: { [VERUSTEST_I_ADDR]: "1" },
        address: new TransferDestination({
          type: DEST_PKH, destinationBytes: fromBase58Check(CHANGE).hash,
        }),
      }], [], {
        chainIAddr: VERUSTEST_I_ADDR, currentHeight: HEIGHT,
        isTestnet: true, parseVdxfObjects: false,
      }
    );
  return { run, rpc, state };
}
const invalidCases: Array<[string, (current: Identity, next: Identity) => void, RegExp]> = [
  ["system mutation", (_current, next) => { next.systemId = IdentityID.fromAddress(next.getIdentityAddress()); }, /change its system/],
  ["active-currency flag", (_current, next) => { next.flags = next.flags.or(IDENTITY_FLAG_ACTIVECURRENCY); }, /separately supported/],
  ["tokenized-control flag", (_current, next) => { next.flags = next.flags.or(IDENTITY_FLAG_TOKENIZED_CONTROL); }, /separately supported/],
  ["unknown flags", (_current, next) => { next.flags = next.flags.or(new BN(16)); }, /unsupported.*flags/i],
  ["removed lock", (current, next) => { current.flags = IDENTITY_FLAG_LOCKED.clone(); current.unlockAfter = new BN(60); next.flags = new BN(0); next.unlockAfter = new BN(0); }, /lock/],
  ["shortened lock", (current, next) => { current.flags = next.flags = IDENTITY_FLAG_LOCKED.clone(); current.unlockAfter = new BN(60); next.unlockAfter = new BN(59); }, /shortened/],
  ["shortened pending unlock", (current, next) => { current.flags = next.flags = new BN(0); current.unlockAfter = new BN(HEIGHT + 100); next.unlockAfter = new BN(HEIGHT + 99); }, /shortened/],
  ["shortened pending relock", (current, next) => { current.flags = new BN(0); current.unlockAfter = new BN(HEIGHT + 100); next.flags = IDENTITY_FLAG_LOCKED.clone(); next.unlockAfter = new BN(1); }, /shorten/],
  ["excessive new lock", (current, next) => { current.flags = new BN(0); current.unlockAfter = new BN(0); next.flags = IDENTITY_FLAG_LOCKED.clone(); next.unlockAfter = IDENTITY_MAX_UNLOCK_DELAY.addn(1); }, /lock|delay/],
  ["self-recovery revocation", (current, next) => { current.setRecovery(current.getIdentityAddress()); next.setRecovery(current.getIdentityAddress()); next.flags = next.flags.or(IDENTITY_FLAG_REVOKED); }, /self-recovering/],
];

describe("complete identity updates validate exact final state before funding", () => {
  test.each(invalidCases.flatMap(([name, mutate, error]) =>
    (["plain", "combined"] as const).map(mode => ({ name, mutate, error, mode }))
  ))("rejects $name through $mode and retry", async ({ mutate, error, mode }) => {
    const current = identity();
    const next = copy(current);
    mutate(current, next);
    const f = fixture(current);
    await expect(f.run(next, mode)).rejects.toThrow(error);
    await expect(f.run(next, mode)).rejects.toThrow(error);
    expect(f.rpc).not.toHaveBeenCalled();
  });

  test.each(["plain", "combined"] as const)("preserves an exact supported final lock in %s", async mode => {
    const current = identity();
    current.flags = IDENTITY_FLAG_LOCKED.clone();
    current.unlockAfter = new BN(60);
    const next = copy(current);
    next.flags = new BN(0);
    next.unlockAfter = new BN(EXPIRY + 60);
    const before = next.toBuffer();
    const f = fixture(current);
    let hex: string;
    if (mode === "plain") {
      const result = await f.run(next, mode);
      hex = result.hex;
    } else {
      await expect(f.run(next, mode)).rejects.toThrow("Reached funding");
      hex = f.state.fundedHex;
    }
    const tx = Transaction.fromHex(hex!, networks.verus);
    const script = new IdentityScript();
    script.fromBuffer(tx.outs[0].script);
    expect(script.getIdentity(false).toBuffer()).toEqual(before);
    expect(next.toBuffer()).toEqual(before);
  });

  test.each(["revocation", "recovery"] as const)("resolves a changed %s authority before funding", async role => {
    const current = identity();
    const next = copy(current);
    const authority = identity();
    authority.name = `full-update-${role}`;
    authority.setRevocation(authority.getIdentityAddress());
    authority.setRecovery(authority.getIdentityAddress());
    if (role === "recovery") next.setRecovery(authority.getIdentityAddress());
    else next.setRevocation(authority.getIdentityAddress());
    const missing = fixture(current);
    await expect(missing.run(next, "combined")).rejects.toThrow(/authority/);
    expect(missing.rpc.mock.calls.map(call => call[0].method)).toEqual(["getidentity"]);
    const found = fixture(current, authority);
    await expect(found.run(next, "combined")).rejects.toThrow("Reached funding");
    expect(found.rpc.mock.calls.map(call => call[0].method)).toEqual(["getidentity", "fundrawtransaction"]);
  });

  test("uses the actual next-block height for expired absolute locks", () => {
    const current = identity();
    current.flags = new BN(0);
    current.unlockAfter = new BN(HEIGHT - 1);
    const next = copy(current);
    next.unlockAfter = new BN(0);
    expect(() => validateFullIdentityUpdate(current, next, context)).not.toThrow();
    expect(() => validateFullIdentityUpdate(current, next, {
      ...context, nextBlockHeight: HEIGHT - 2,
    })).toThrow(/unlock height/);
  });

  test("rejects changed parent and removed protected flags without chain assumptions", () => {
    const current = identity();
    const next = copy(current);
    next.parent = IdentityID.fromAddress(current.getIdentityAddress());
    expect(() => validateIdentityUpdateTransitionInvariants(current, next)).toThrow(/parent/);
    for (const flag of [IDENTITY_FLAG_ACTIVECURRENCY, IDENTITY_FLAG_TOKENIZED_CONTROL]) {
      current.flags = flag.clone();
      expect(() => validateIdentityUpdateTransitionInvariants(current, identity())).toThrow(/separately supported/);
    }
  });

  test("rejects new over-maximum permanent locks without inferring a chain height", () => {
    const current = identity();
    current.flags = new BN(0);
    current.unlockAfter = new BN(0);
    const next = copy(current);
    next.flags = IDENTITY_FLAG_LOCKED.clone();
    next.unlockAfter = IDENTITY_MAX_UNLOCK_DELAY.addn(1);
    expect(() => validateIdentityLocksWithoutHeight(current, next, VERUSTEST_I_ADDR, EXPIRY)).toThrow(/lock|delay/);
    current.flags = IDENTITY_FLAG_LOCKED.clone();
    current.unlockAfter = next.unlockAfter.clone();
    next.flags = new BN(0);
    next.unlockAfter = IDENTITY_MAX_UNLOCK_DELAY.addn(EXPIRY);
    expect(() => validateIdentityLocksWithoutHeight(current, next, VERUSTEST_I_ADDR, EXPIRY)).not.toThrow();
  });
});
