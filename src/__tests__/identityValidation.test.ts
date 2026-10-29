import BN from "bn.js";
import {
  ContentMultiMap,
  Identity,
  IdentityID,
  IdentityScript,
  KeyID,
  PartialIdentity,
  R_ADDR_VERSION,
  nameAndParentAddrToIAddr,
} from "verus-typescript-primitives";
import {
  dropEmptyIdentityContent,
  validateIdentityDefinition,
  validateIdentityPrimaryAddresses,
  validatePartialIdentityDefinition,
} from "../identity/identityValidation";
import { verifyIdentityDefinitionOutput } from "../identity/updateFundingVerification";
import { TEST_ID_3, VERUSTEST_I_ADDR } from "./fixtures/verusid";

function identity(): Identity {
  const result = Identity.fromJson(TEST_ID_3.identity);
  result.upgradeVersion();
  return result;
}

describe("identity definition validation", () => {
  test.each([0, 1, 2, 4, 0x8000, 0x8007])(
    "preserves valid update flags %i and null root parents",
    (flags) => {
      const value = identity();
      value.flags = new BN(flags);
      value.parent = new IdentityID(Buffer.alloc(20));
      value.systemId = IdentityID.fromAddress(
        nameAndParentAddrToIAddr(value.name)
      );
      value.unlockAfter = new BN(60000);
      expect(() => validateIdentityDefinition(value)).not.toThrow();
    }
  );

  test.each([1, 2, 3])("accepts supported identity version %i", (version) => {
    const value = identity();
    value.version = new BN(version);
    expect(() => validateIdentityDefinition(value)).not.toThrow();
  });

  test("upgrades legacy identities without a private-address vector", () => {
    const value = identity();
    value.version = new BN(1);
    // The primitive permits an absent vector and serializes it as count zero.
    (value as any).privateAddresses = undefined;
    value.upgradeVersion();
    expect(() => validateIdentityDefinition(value)).not.toThrow();
    const decoded = new Identity();
    decoded.fromBuffer(value.toBuffer());
    expect(decoded.privateAddresses || []).toEqual([]);
  });

  test.each([
    ["identity destination", () => new IdentityID(Buffer.alloc(20, 1))],
    ["null hash", () => new KeyID(Buffer.alloc(20))],
    ["short hash", () => new KeyID(Buffer.alloc(19, 1))],
    ["long hash", () => new KeyID(Buffer.alloc(21, 1))],
    [
      "wrong address version",
      () =>
        Object.assign(new KeyID(Buffer.alloc(20, 1)), {
          version: R_ADDR_VERSION + 1,
        }),
    ],
    [
      "variable-length encoding",
      () => Object.assign(new KeyID(Buffer.alloc(20, 1)), { varlength: true }),
    ],
  ] as const)(
    "rejects %s before primary type information is serialized away",
    (_, key) => {
      const value = identity();
      value.primaryAddresses = [key() as KeyID];
      value.minSigs = new BN(1);
      expect(() => validateIdentityDefinition(value)).toThrow(/KeyID/);
    }
  );

  test.each([0, 26])("rejects %i primary keys", (count) => {
    const value = identity();
    value.primaryAddresses = Array.from(
      { length: count },
      (_, index) => new KeyID(Buffer.alloc(20, index + 1))
    );
    value.minSigs = new BN(1);
    expect(() => validateIdentityDefinition(value)).toThrow(/1 to 25/);
  });

  test("rejects duplicate primary hashes", () => {
    const value = identity();
    value.primaryAddresses = [
      value.primaryAddresses![0],
      value.primaryAddresses![0],
    ];
    expect(() => validateIdentityDefinition(value)).toThrow(/unique/);
  });

  test.each([0, -1, 14, 26])("rejects threshold %i", (minSigs) => {
    const value = identity();
    value.minSigs = new BN(minSigs);
    expect(() => validateIdentityDefinition(value)).toThrow(/threshold/);
  });

  test("rejects a threshold exceeding the key count", () => {
    const value = identity();
    value.primaryAddresses = [value.primaryAddresses![0]];
    value.minSigs = new BN(2);
    expect(() => validateIdentityDefinition(value)).toThrow(/threshold/);
  });

  test("allows partial key validation while requiring a threshold on full outputs", () => {
    const value = identity();
    value.minSigs = undefined;
    expect(() =>
      validateIdentityPrimaryAddresses(value.primaryAddresses)
    ).not.toThrow();
    expect(() => validateIdentityDefinition(value)).toThrow(/threshold/);
  });

  test.each([
    ["version", new BN(0)],
    ["version", new BN(4)],
    ["flags", new BN(-1)],
    ["flags", new BN("100000000", 16)],
    ["unlockAfter", new BN(-1)],
    ["unlockAfter", new BN("100000000", 16)],
  ] as const)("rejects out-of-range %s %s", (field, invalid) => {
    const value = identity();
    value[field] = invalid;
    expect(() => validateIdentityDefinition(value)).toThrow();
  });

  test.each(["", "x".repeat(65), "é".repeat(33)])(
    "rejects an invalid name length",
    (name) => {
      const value = identity();
      value.name = name;
      expect(() => validateIdentityDefinition(value)).toThrow(/1 to 64 bytes/);
    }
  );

  test.each(["revocationAuthority", "recoveryAuthority"] as const)(
    "rejects a null %s",
    (field) => {
      const value = identity();
      value[field] = new IdentityID(Buffer.alloc(20));
      expect(() => validateIdentityDefinition(value)).toThrow(
        /identity destination/
      );
    }
  );

  test("drops only zero-value groups and retains zero-length values", () => {
    const value = identity();
    value.contentMultiMap = ContentMultiMap.fromJson({
      [VERUSTEST_I_ADDR]: [],
      [value.getIdentityAddress()]: [""],
    });
    expect(() => validateIdentityDefinition(value)).toThrow(
      /at least one value/
    );
    dropEmptyIdentityContent(value);
    expect(value.contentMultiMap.toJson()).toEqual({
      [value.getIdentityAddress()]: [""],
    });
    expect(() => validateIdentityDefinition(value)).not.toThrow();
  });

  test("rejects content that the daemon cannot deserialize canonically", () => {
    const value = identity();
    value.contentMap.set(VERUSTEST_I_ADDR, Buffer.alloc(31));
    expect(() => validateIdentityDefinition(value)).toThrow(/32 bytes/);
    value.contentMap.clear();
    value.contentMultiMap = ContentMultiMap.fromJson({
      [new IdentityID(Buffer.alloc(20)).toAddress()!]: ["ab"],
    });
    expect(() => validateIdentityDefinition(value)).toThrow(
      /Unsupported currency/
    );
  });

  test.each([1, 2, 3])(
    "matches null content-map key handling for version %i",
    (version) => {
      const value = identity();
      value.version = new BN(version);
      value.contentMap.set(
        new IdentityID(Buffer.alloc(20)).toAddress()!,
        Buffer.alloc(32)
      );
      if (version === 3) {
        expect(() => validateIdentityDefinition(value)).not.toThrow();
      } else {
        expect(() => validateIdentityDefinition(value)).toThrow(
          /content map key/
        );
      }
    }
  );

  test("rejects malformed private address byte lengths before serialization", () => {
    const value = identity();
    value.privateAddresses[0].d = Buffer.alloc(10);
    expect(() => validateIdentityDefinition(value)).toThrow(/11-byte/);
  });

  test.each([5735, 5736])(
    "matches the daemon export-wrapper size boundary at %i identity bytes",
    (size) => {
      const value = identity();
      value.contentMultiMap = ContentMultiMap.fromJson({
        [VERUSTEST_I_ADDR]: "ab".repeat(5000),
      });
      const bytes = 5000 + size - value.getByteLength();
      value.contentMultiMap = ContentMultiMap.fromJson({
        [VERUSTEST_I_ADDR]: "ab".repeat(bytes),
      });
      expect(value.toBuffer().length).toBe(size);
      if (size === 5735)
        expect(() => validateIdentityDefinition(value)).not.toThrow();
      else
        expect(() => validateIdentityDefinition(value)).toThrow(
          /wrapped size limit/
        );
    }
  );

  test("validates newly approved output definitions without imposing modern rules on historic prevouts", () => {
    const value = identity();
    value.primaryAddresses = [
      value.primaryAddresses![0],
      value.primaryAddresses![0],
    ];
    const output = {
      script: IdentityScript.fromIdentity(value).toBuffer(),
      value: 0,
    };
    expect(() =>
      verifyIdentityDefinitionOutput(output, value.getIdentityAddress())
    ).not.toThrow();
    expect(() =>
      verifyIdentityDefinitionOutput(output, value.getIdentityAddress(), true)
    ).toThrow(/unique/);
  });

  test("rejects a noncanonical zero-value content group in an approved script", () => {
    const value = identity();
    value.contentMultiMap = ContentMultiMap.fromJson({
      [VERUSTEST_I_ADDR]: [],
    });
    const output = {
      script: IdentityScript.fromIdentity(value).toBuffer(),
      value: 0,
    };
    expect(() =>
      verifyIdentityDefinitionOutput(output, value.getIdentityAddress(), true)
    ).toThrow(/at least one value/);
  });
});

describe("partial identity request validation", () => {
  test("accepts absent optional fields and a standalone valid threshold", () => {
    expect(() =>
      validatePartialIdentityDefinition(new PartialIdentity({ name: "alice" }))
    ).not.toThrow();
    expect(() =>
      validatePartialIdentityDefinition(
        new PartialIdentity({ name: "alice", minSigs: new BN(13) })
      )
    ).not.toThrow();
  });

  test.each([
    "parent",
    "systemId",
    "revocationAuthority",
    "recoveryAuthority",
  ] as const)(
    "rejects a KeyID supplied as %s before conversion erases its type",
    (field) => {
      const partial = new PartialIdentity({
        name: "alice",
        [field]: new KeyID(Buffer.alloc(20, 1)),
      });
      expect(() => validatePartialIdentityDefinition(partial)).toThrow(
        /identity destination/
      );
    }
  );

  test.each(["flags", "unlockAfter"] as const)(
    "checks standalone %s bounds",
    (field) => {
      for (const value of [new BN(-1), new BN("100000000", 16)]) {
        const partial = new PartialIdentity({ name: "alice", [field]: value });
        expect(() => validatePartialIdentityDefinition(partial)).toThrow(
          /unsigned 32-bit/
        );
      }
      const partial = new PartialIdentity({
        name: "alice",
        [field]: new BN(0),
      });
      expect(() => validatePartialIdentityDefinition(partial)).not.toThrow();
    }
  );

  test.each([0, 14])("rejects standalone threshold %i", (minSigs) => {
    const partial = new PartialIdentity({
      name: "alice",
      minSigs: new BN(minSigs),
    });
    expect(() => validatePartialIdentityDefinition(partial)).toThrow(
      /threshold/
    );
  });

  test("checks a threshold against explicitly supplied primary keys", () => {
    const partial = new PartialIdentity({
      name: "alice",
      minSigs: new BN(2),
      primaryAddresses: [new KeyID(Buffer.alloc(20, 1))],
    });
    expect(() => validatePartialIdentityDefinition(partial)).toThrow(
      /threshold/
    );
  });

  test("rejects malformed optional private and metadata content", () => {
    const value = identity();
    const partial = new PartialIdentity({
      name: value.name,
      privateAddresses: value.privateAddresses,
    });
    partial.privateAddresses[0].pkD = Buffer.alloc(31);
    expect(() => validatePartialIdentityDefinition(partial)).toThrow(
      /32-byte key/
    );

    const metadata = new PartialIdentity({
      name: value.name,
      contentMap: new Map([[VERUSTEST_I_ADDR, Buffer.alloc(31)]]),
    });
    expect(() => validatePartialIdentityDefinition(metadata)).toThrow(
      /32 bytes/
    );
  });
});
