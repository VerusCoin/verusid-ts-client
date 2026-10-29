import BN from "bn.js";
import { Transaction, networks } from "@bitgo/utxo-lib";
import {
  ContentMultiMap,
  Identity,
  IdentityID,
  IdentityScript,
  PartialIdentity,
  SaplingPaymentAddress,
  IDENTITY_MAX_UNLOCK_DELAY,
} from "verus-typescript-primitives";
import { applyLocalIdentityUpdate } from "../identity/localIdentityUpdate";
import { TEST_ID_3, VERUSTEST_I_ADDR } from "./fixtures/verusid";

const daemonFixtures = require("./fixtures/local-upload/ordinary-edits.json");
const context = {
  chainId: VERUSTEST_I_ADDR,
  nextBlockHeight: 1001,
  expiryHeight: 1020,
};
const external = IdentityID.fromAddress(VERUSTEST_I_ADDR);

function identity(): Identity {
  return Identity.fromJson(TEST_ID_3.identity);
}

function update(current: Identity, fields: Record<string, unknown> = {}) {
  return new PartialIdentity({ name: current.name, ...fields });
}

function apply(current: Identity, fields: Record<string, unknown> = {}) {
  return applyLocalIdentityUpdate(current, update(current, fields), context);
}

function sourceIdentity(source: any): Identity {
  const tx = Transaction.fromHex(source.rawTransaction, networks.verus);
  expect(tx.getId()).toBe(source.txid);
  const script = new IdentityScript();
  script.fromBuffer(tx.outs[source.vout].script);
  return script.getIdentity(false);
}

describe("local ordinary identity mutation", () => {
  test.each(daemonFixtures.cases as any[])(
    "matches daemon reference: $name",
    (fixture) => {
      const current = sourceIdentity(daemonFixtures.sources[fixture.source]);
      const request = PartialIdentity.fromJson(fixture.request);
      const run = () =>
        applyLocalIdentityUpdate(current, request, {
          chainId: daemonFixtures.daemon.chainId,
          nextBlockHeight: daemonFixtures.daemon.height + 1,
          expiryHeight:
            fixture.expiryHeight || daemonFixtures.daemon.height + 21,
        });
      if (fixture.error) {
        expect(run).toThrow(/self-recovering/);
      } else {
        expect(run().identity.toBuffer().toString("hex")).toBe(
          fixture.identityHex
        );
      }
    }
  );

  test("clears historical multimap entries and preserves exact new raw values", () => {
    const current = identity();
    const key = current.getIdentityAddress();
    current.contentMultiMap = ContentMultiMap.fromJson({ [key]: "abcdef" });
    const before = current.toBuffer();
    expect(apply(current).identity.contentMultiMap.kvContent.size).toBe(0);
    const replacement = ContentMultiMap.fromJson({
      [key]: ["", "deadbeef00"],
    });
    const request = update(current, { contentMultiMap: replacement });
    const result = applyLocalIdentityUpdate(current, request, context).identity;
    expect(result.contentMultiMap.toBuffer()).toEqual(replacement.toBuffer());
    expect(current.toBuffer()).toEqual(before);
    const values = result.contentMultiMap.kvContent.getByAddress(key)!;
    (values[1] as Buffer)[0] = 1;
    expect(request.toContentMultiMap().toBuffer()).toEqual(
      replacement.toBuffer()
    );
  });

  test("preserves and replaces complete private vectors, including explicit clearing", () => {
    const current = identity();
    current.privateAddresses = [1, 2].map(
      (index) =>
        new SaplingPaymentAddress({
          d: Buffer.alloc(11, index),
          pkD: Buffer.alloc(32, index),
        })
    );
    const preserved = apply(current).identity;
    expect(preserved.privateAddresses.map((x) => x.toBuffer())).toEqual(
      current.privateAddresses.map((x) => x.toBuffer())
    );
    preserved.privateAddresses[1].pkD.fill(9);
    expect(current.privateAddresses[1].pkD).toEqual(Buffer.alloc(32, 2));
    const replacement = apply(current, {
      privateAddresses: [current.privateAddresses[1]],
    }).identity;
    expect(replacement.privateAddresses).toHaveLength(1);
    expect(replacement.privateAddresses[0].pkD).toEqual(Buffer.alloc(32, 2));
    const clear = update(current, { privateAddresses: [] });
    // Empty vectors need an explicit presence bit in the current primitives.
    clear.contains = clear.contains.or(
      PartialIdentity.PARTIAL_ID_CONTAINS_PRIV_ADDRS
    );
    expect(
      applyLocalIdentityUpdate(current, clear, context).identity
        .privateAddresses
    ).toEqual([]);
  });

  test("uses presence bits for zero flags, zero timelock, and empty maps", () => {
    const current = identity();
    current.flags = new BN(5);
    current.unlockAfter = new BN(10);
    current.contentMap.set(current.getIdentityAddress(), Buffer.alloc(32, 3));
    const next = apply(current, {
      flags: new BN(0),
      unlockAfter: new BN(0),
      contentMap: new Map(),
    }).identity;
    expect(next.flags.toNumber()).toBe(5);
    expect(next.unlockAfter.toNumber()).toBe(0);
    expect(next.contentMap.size).toBe(0);
  });

  test.each([new BN(8), new BN(256), new BN(-1), new BN("100000000", 16)])(
    "rejects unsupported retained source flags %s before request normalization",
    (flags) => {
      const current = identity();
      current.flags = flags;
      expect(() => apply(current, { flags: new BN(0) })).toThrow(
        /Unsupported identity update flags/
      );
      expect(current.flags).toEqual(flags);
    }
  );

  test.each([1, 2])(
    "rejects unverified source-version %i migration before construction",
    (version) => {
      const current = identity();
      current.version = new BN(version);
      expect(() => apply(current, { version: new BN(3) })).toThrow(
        /pre-PBaaS identity version/
      );
      expect(current.version.toNumber()).toBe(version);
    }
  );

  test("keeps imported system IDs and rejects address, parent and system changes", () => {
    const current = identity();
    current.systemId = new IdentityID(Buffer.alloc(20, 7));
    expect(apply(current).identity.systemId.toBuffer()).toEqual(
      current.systemId.toBuffer()
    );
    expect(() => apply(current, { systemId: external })).toThrow(/system/);
    expect(() =>
      apply(current, { parent: new IdentityID(Buffer.alloc(20, 8)) })
    ).toThrow(/parent or identity address/);
    expect(() => apply(current, { name: "different" })).toThrow(
      /parent or identity address/
    );
  });

  test("normalizes a new lock and uses the selected expiry for an unlock", () => {
    const current = identity();
    expect(
      apply(current, {
        flags: new BN(2),
        unlockAfter: new BN(0),
      }).identity.unlockAfter.toNumber()
    ).toBe(1);
    expect(
      apply(current, {
        flags: new BN(2),
        unlockAfter: IDENTITY_MAX_UNLOCK_DELAY.addn(1),
      }).identity.unlockAfter
    ).toEqual(IDENTITY_MAX_UNLOCK_DELAY);
    current.lock(new BN(60));
    const unlocked = apply(current, { flags: new BN(0) }).identity;
    expect(unlocked.isLocked()).toBe(false);
    expect(unlocked.unlockAfter.toNumber()).toBe(context.expiryHeight + 60);
    const extended = apply(current, {
      flags: new BN(0),
      unlockAfter: new BN(2000),
    }).identity;
    expect(extended.unlockAfter.toNumber()).toBe(2000);
  });

  test("cannot shorten active lock delays or pending unlock heights", () => {
    const current = identity();
    current.lock(new BN(60));
    expect(() => apply(current, { unlockAfter: new BN(59) })).toThrow(
      /cannot be shortened/
    );
    current.flags = new BN(0);
    current.unlockAfter = new BN(1500);
    expect(() => apply(current, { unlockAfter: new BN(1499) })).toThrow(
      /cannot be shortened/
    );
    expect(() =>
      apply(current, { flags: new BN(2), unlockAfter: new BN(100) })
    ).toThrow(/Relocking/);
    expect(() =>
      apply(current, { flags: new BN(2), unlockAfter: new BN(500) })
    ).not.toThrow();
  });

  test("cannot create an absolute lock that ends before transaction expiry", () => {
    const current = identity();
    expect(() =>
      apply(current, { unlockAfter: new BN(context.expiryHeight) })
    ).toThrow(/absolute unlock height/);
    expect(() =>
      apply(current, { unlockAfter: new BN(context.expiryHeight + 1) })
    ).not.toThrow();
  });

  test("rejects self recovery during revocation according to both RPC and consensus", () => {
    const current = identity();
    current.recoveryAuthority = IdentityID.fromAddress(
      current.getIdentityAddress()
    );
    expect(() => apply(current, { flags: new BN(0x8000) })).toThrow(
      /self-recovering/
    );
    expect(() =>
      apply(current, { flags: new BN(0x8000), recoveryAuthority: external })
    ).toThrow(/self-recovering/);
    current.recoveryAuthority = external;
    expect(() =>
      apply(current, {
        flags: new BN(0x8000),
        recoveryAuthority: IdentityID.fromAddress(current.getIdentityAddress()),
      })
    ).toThrow(/self-recovering/);
    current.flags = new BN(4);
    expect(() => apply(current, { flags: new BN(0x8000) })).not.toThrow();
  });

  test("returns the relevant external authority lookups without remote construction", () => {
    const current = identity();
    expect(apply(current).requiredAuthorities).toEqual([]);
    expect(
      apply(current, {
        revocationAuthority: external,
        recoveryAuthority: external,
      }).requiredAuthorities
    ).toEqual([
      { address: VERUSTEST_I_ADDR, role: "revocation" },
      { address: VERUSTEST_I_ADDR, role: "recovery" },
    ]);
    current.flags = new BN(0x8000);
    current.recoveryAuthority = external;
    expect(apply(current, { flags: new BN(0) }).requiredAuthorities).toEqual([
      { address: VERUSTEST_I_ADDR, role: "recovery" },
    ]);
    expect(
      applyLocalIdentityUpdate(current, update(current), {
        ...context,
        hasDataUploads: true,
      }).requiredAuthorities
    ).toEqual([{ address: VERUSTEST_I_ADDR, role: "recovery" }]);
    expect(
      apply(current, { revocationAuthority: external }).requiredAuthorities
    ).toEqual([{ address: VERUSTEST_I_ADDR, role: "recovery" }]);
  });

  test.each([
    { nextBlockHeight: 0 },
    { expiryHeight: 1000 },
    { expiryHeight: 500000000 },
    { expiryHeight: 0xffffffff },
    { expiryHeight: 0x100000000 },
    { expiryHeight: 1001.5 },
  ])("rejects an invalid height/expiry context: %j", (invalid) => {
    const current = identity();
    expect(() =>
      applyLocalIdentityUpdate(current, update(current), {
        ...context,
        ...invalid,
      })
    ).toThrow(/height and expiry/);
  });
});
