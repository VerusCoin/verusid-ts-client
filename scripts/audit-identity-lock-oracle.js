#!/usr/bin/env node
"use strict";

// This audit never invokes RPC. It compiles the daemon's actual lock methods,
// consensus mutation predicate, and RPC normalization block in a small C++
// shell. Keep this separate from the TypeScript implementation under test.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHash } = require("crypto");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const daemonRoot = path.resolve(
  process.env.VERUS_DAEMON_SOURCE || path.join(root, "../VerusCoin")
);
const fixturePath = path.join(
  root,
  "src/__tests__/fixtures/local-upload/identity-lock-oracle.json"
);
const hash = (value) => createHash("sha256").update(value).digest("hex");

function extractBlock(file, marker, scope) {
  const source = fs.readFileSync(path.join(daemonRoot, file), "utf8");
  const scopeStart = scope ? source.indexOf(scope) : 0;
  assert(scopeStart >= 0, "Missing daemon scope: " + scope);
  const start = source.indexOf(marker, scopeStart);
  assert(start >= 0, "Missing daemon marker: " + marker);
  const opening = source.indexOf("{", start);
  let depth = 1;
  let end = opening + 1;
  // The selected bodies contain no brace characters in string literals or
  // comments. Refuse a future source revision introducing that ambiguity.
  for (; depth && end < source.length; end++) {
    if (source[end] === "{") depth++;
    else if (source[end] === "}") depth--;
  }
  assert.strictEqual(depth, 0, "Unbalanced extracted C++ body");
  const text = source.slice(start, end);
  const quotedOrComment =
    text.match(
      /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g
    ) || [];
  assert(
    quotedOrComment.every((value) => !/[{}]/.test(value)),
    "Brace parser requires reviewing changed C++ source"
  );
  return {
    file,
    marker,
    ...(scope ? { scope } : {}),
    line: source.slice(0, start).split("\n").length,
    sha256: hash(text),
    text,
  };
}

function sourceInputs() {
  const header = "src/pbaas/identity.h";
  const implementation = "src/pbaas/identity.cpp";
  const snippets = [
    extractBlock(header, "    void Lock(int32_t unlockTime)"),
    extractBlock(
      header,
      "    void Unlock(uint32_t height, uint32_t txExpiryHeight)"
    ),
    extractBlock(header, "    bool IsLocked() const"),
    extractBlock(header, "    bool IsRevoked() const"),
    extractBlock(header, "    bool HasActiveCurrency() const"),
    extractBlock(header, "    bool HasTokenizedControl() const"),
    extractBlock(
      implementation,
      "bool CIdentity::IsLocked(uint32_t height) const"
    ),
    extractBlock(
      implementation,
      "bool CIdentity::IsInvalidMutation(const CIdentity &newIdentity, uint32_t height, uint32_t expiryHeight) const"
    ),
    extractBlock(
      "src/rpc/pbaasrpc.cpp",
      "    if (oldID.IsLocked() != newID.IsLocked())",
      "UniValue updateidentity(const UniValue& params, bool fHelp)"
    ),
    extractBlock(
      "src/pbaas/pbaas.cpp",
      "uint160 CConnectedChains::vARRRChainID() const"
    ),
    extractBlock(
      "src/pbaas/pbaas.cpp",
      "bool CConnectedChains::ForceIdentityUnlock(uint32_t height) const"
    ),
    extractBlock(
      "src/pbaas/pbaas.cpp",
      "bool CConnectedChains::IdentityLockOverride(const CIdentity &identity, uint32_t height) const"
    ),
  ];
  const source = fs.readFileSync(path.join(daemonRoot, header), "utf8");
  const constants = [
    "VERSION_VAULT",
    "VERSION_PBAAS",
    "VERSION_FIRSTVALID",
    "VERSION_LASTVALID",
  ].map((name) => {
    const match = source.match(
      new RegExp("static const uint8_t " + name + " = [^;]+;")
    );
    assert(match, "Missing version constant: " + name);
    return match[0];
  });
  const flags = [
    "FLAG_REVOKED",
    "FLAG_ACTIVECURRENCY",
    "FLAG_LOCKED",
    "FLAG_TOKENIZED_CONTROL",
    "MAX_UNLOCK_DELAY",
  ].map((name) => {
    const match = source.match(new RegExp("\\b" + name + " = ([^,\\n/]+)"));
    assert(match, "Missing flag/delay constant: " + name);
    return `enum { ${name} = ${match[1].trim()} };`;
  });
  const overrideHeight = fs
    .readFileSync(path.join(daemonRoot, "src/pbaas/pbaas.cpp"), "utf8")
    .match(/^#define FORCE_IDENTITY_UNLOCK_HEIGHT \d+$/m);
  assert(overrideHeight, "Missing override height constant");
  return {
    snippets,
    constants: [...constants, ...flags],
    overrideHeight: overrideHeight[0],
  };
}

function cppSource({ snippets, constants, overrideHeight }) {
  const methods = snippets
    .slice(0, 6)
    .map((value) => value.text)
    .join("\n");
  return `#include <cstdint>
#include <iostream>
#include <string>
#include <vector>
#include <limits>
#include <map>
#include <set>
using uint160 = std::string;
using CIdentityID = std::string;
std::string DecodeDestination(const std::string& value) { return value; }
std::string GetDestinationID(const std::string& value) { return value; }
std::string ASSETCHAINS_CHAINID;
${overrideHeight}
struct CActivationHeight {
  enum { ACTIVATE_VERUSVAULT = 1, ACTIVATE_IDCONSENSUS2 = 2, ACTIVATE_PBAAS = 3 };
};
struct CConstVerusSolutionVector { static int GetVersionByHeight(uint32_t) { return 100; } };
struct CIdentity;
struct CConnectedChains {
  struct Upgrade { uint32_t upgradeBlockHeight; };
  std::map<int, Upgrade> activeUpgradesByKey;
  int ForceIdentityUnlockKey() const { return 1; }
  uint160 vARRRChainID() const;
  bool ForceIdentityUnlock(uint32_t height) const;
  bool IdentityLockOverride(const CIdentity&, uint32_t) const;
} ConnectedChains;
struct CIdentity {
  ${constants.join("\n  ")}
  uint32_t nVersion = VERSION_PBAAS, flags = 0, unlockAfter = 0;
  uint32_t parent = 1, systemID = 1;
  std::string name = "oracle";
  std::string id = "oracle";
  std::vector<int> contentMultiMap;
  CIdentityID GetID() const { return id; }
  bool IsLocked(uint32_t height) const;
  bool IsInvalidMutation(const CIdentity&, uint32_t height, uint32_t expiryHeight) const;
  ${methods}
};
${snippets[6].text}
${snippets[7].text}
${snippets
  .slice(9)
  .map((value) => value.text)
  .join("\n")}
int main() {
  static_assert(sizeof(uint32_t) == 4 && sizeof(int32_t) == 4, "32-bit integer model required");
  std::string mode;
  uint64_t oldFlags, oldUnlock, newFlags, newUnlock, height64, expiry64, upgradeHeight;
  std::string chain, id;
  while (std::cin >> mode >> oldFlags >> oldUnlock >> newFlags >> newUnlock >> height64 >> expiry64 >> chain >> id >> upgradeHeight) {
    if ((oldFlags | oldUnlock | newFlags | newUnlock | height64 | expiry64) > UINT32_MAX || height64 == 0) return 2;
    CIdentity oldID, newID;
    ASSETCHAINS_CHAINID = chain;
    oldID.id = newID.id = id;
    ConnectedChains.activeUpgradesByKey.clear();
    if (upgradeHeight <= UINT32_MAX) ConnectedChains.activeUpgradesByKey[1] = { static_cast<uint32_t>(upgradeHeight) };
    oldID.flags = oldFlags; oldID.unlockAfter = oldUnlock;
    newID.flags = newFlags; newID.unlockAfter = newUnlock;
    uint32_t height = height64, expiry = expiry64;
    if (mode == "normalize") {
      // Preceding updateidentity mask: preserve the current protected flags.
      newID.flags &= newID.FLAG_LOCKED + newID.FLAG_REVOKED;
      newID.flags |= (oldID.flags & (oldID.FLAG_ACTIVECURRENCY + oldID.FLAG_TOKENIZED_CONTROL));
      uint32_t nHeight = height - 1;
      struct { uint32_t nExpiryHeight; } txNew = { expiry };
${snippets[8].text}
    } else if (mode == "lock") {
      newID = oldID; newID.Lock(static_cast<int32_t>(newUnlock));
    } else if (mode == "unlock") {
      newID = oldID; newID.Unlock(height, expiry);
    } else if (mode != "validate") return 3;
    std::cout << "{\\"flags\\":" << newID.flags << ",\\"unlockAfter\\":" << newID.unlockAfter
      << ",\\"oldLockedAtHeight\\":" << (oldID.IsLocked(height) ? "true" : "false")
      << ",\\"newLockedAtHeight\\":" << (newID.IsLocked(height) ? "true" : "false")
      << ",\\"oldOverride\\":" << (ConnectedChains.IdentityLockOverride(oldID, height) ? "true" : "false")
      << ",\\"newOverride\\":" << (ConnectedChains.IdentityLockOverride(newID, height) ? "true" : "false")
      << ",\\"invalidMutation\\":" << (oldID.IsInvalidMutation(newID, height, expiry) ? "true" : "false") << "}\\n";
  }
}
`;
}

function cases() {
  const M = 60 * 24 * 22 * 365;
  const result = [];
  const add = (
    name,
    mode,
    oldFlags,
    oldUnlock,
    newFlags,
    newUnlock,
    height = 1001,
    expiry = 1020,
    scope = "modern-sdk",
    context
  ) =>
    result.push({
      name,
      mode,
      current: { flags: oldFlags, unlockAfter: oldUnlock },
      requested: { flags: newFlags, unlockAfter: newUnlock },
      height,
      expiry,
      scope,
      ...(context ? { context } : {}),
    });
  const sourceStates = [
    ["unlocked", 0, 0],
    ["expired", 0, 1000],
    ["at-height", 0, 1001],
    ["pending", 0, 1100],
    ["flagged-zero", 2, 0],
    ["flagged", 2, 60],
    ["flagged-max", 2, M],
    ["flagged-over-max", 2, M + 1],
    ["flagged-high", 2, 0x7fffffff],
    ["flagged-u32", 2, 0xffffffff],
    ["revoked", 0x8000, 0],
    ["revoked-pending", 0x8000, 1100],
    ["revoked-flagged", 0x8002, 60],
    ["revoked-flagged-u32", 0x8002, 0xffffffff],
  ];
  const targetValues = [
    0,
    1,
    59,
    60,
    1000,
    1001,
    1020,
    1021,
    1080,
    1100,
    M,
    M + 1,
    0x7fffffff,
    0x80000000,
    0xffffffff,
  ];
  for (const [state, oldFlags, oldUnlock] of sourceStates) {
    for (const newFlags of [0, 2, 0x8000, 0x8002]) {
      for (const value of new Set([...targetValues, oldUnlock])) {
        for (const mode of ["normalize", "validate"]) {
          add(
            `${state}/${mode}/flags-${newFlags}/time-${value}`,
            mode,
            oldFlags,
            oldUnlock,
            newFlags,
            value
          );
        }
      }
    }
    // Direct primitive tests cover the strict height comparison and revocation.
    for (const height of [1000, 1001, 1100, 1101]) {
      add(
        `${state}/unlock/height-${height}`,
        "unlock",
        oldFlags,
        oldUnlock,
        oldFlags,
        oldUnlock,
        height,
        1120
      );
    }
  }
  for (const value of [
    0,
    1,
    M - 1,
    M,
    M + 1,
    0x7fffffff,
    0x80000000,
    0xffffffff,
  ]) {
    add(`direct-lock/${value}`, "lock", 0, 0, 2, value);
  }
  for (const expiry of [0, 1, 1001, 499999999, 0xffffffff - M, 0xffffffff]) {
    for (const oldUnlock of [1, M, M + 1, 0xffffffff - 1000, 0xffffffff]) {
      for (const mode of ["unlock", "normalize", "validate"]) {
        add(
          `uint32/${mode}/delay-${oldUnlock}/expiry-${expiry}`,
          mode,
          2,
          oldUnlock,
          0,
          0,
          1001,
          expiry,
          expiry >= 1001 && expiry < 500000000
            ? "modern-sdk"
            : "daemon-arithmetic-only"
        );
      }
    }
  }
  const exemptIDs = [
    "iSXF8KbbvpHDWBm4zHxeA4n7uc1LsfR15X",
    "i4UxDzYtNR5oeGEEVritXuzAKjKzoVgiPK",
    "i5nQeKAWmxaXdNYv36qLQzz6XV8gZEqbaV",
  ];
  const contexts = exemptIDs.flatMap((identityId, index) =>
    [66999, 67000, 70000, 76999, 77000].map((height) => ({
      name: `exempt-${index}/height-${height}`,
      height,
      chain: "vARRR.vrsc.@",
      identityId,
    }))
  );
  contexts.push(
    {
      name: "other-chain",
      height: 70000,
      chain: "other",
      identityId: exemptIDs[0],
    },
    {
      name: "unlisted-identity",
      height: 70000,
      chain: "vARRR.vrsc.@",
      identityId: "oracle",
    },
    {
      name: "upgrade-before",
      height: 65000,
      chain: "vARRR.vrsc.@",
      identityId: exemptIDs[0],
      upgradeHeight: 65001,
    },
    {
      name: "upgrade-at",
      height: 65000,
      chain: "vARRR.vrsc.@",
      identityId: exemptIDs[0],
      upgradeHeight: 65000,
    },
    {
      name: "upgrade-after",
      height: 65001,
      chain: "vARRR.vrsc.@",
      identityId: exemptIDs[0],
      upgradeHeight: 65000,
    }
  );
  for (const { name, height, ...context } of contexts) {
    for (const [state, oldFlags, oldUnlock] of [
      ["flagged", 2, 900000],
      ["pending", 0, 900000],
      ["threshold", 0, 800000],
      ["revoked", 0x8000, 900000],
    ]) {
      for (const [newFlags, newUnlock] of [
        [0, 0],
        [0, 970020],
        [2, 900000],
        [0x8000, 0],
      ]) {
        for (const mode of ["normalize", "validate"]) {
          add(
            `override/${name}/${state}/${mode}/flags-${newFlags}/time-${newUnlock}`,
            mode,
            oldFlags,
            oldUnlock,
            newFlags,
            newUnlock,
            height,
            height + 20,
            "modern-sdk",
            context
          );
        }
      }
    }
  }
  return result;
}

function collect() {
  const source = sourceInputs();
  const cpp = cppSource(source);
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "verus-lock-oracle-")
  );
  try {
    const sourceFile = path.join(directory, "oracle.cpp");
    const binary = path.join(directory, "oracle");
    fs.writeFileSync(sourceFile, cpp);
    const compiler = process.env.CXX || "c++";
    execFileSync(
      compiler,
      ["-std=c++17", "-O2", "-Wall", "-Wextra", sourceFile, "-o", binary],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const inputs = cases();
    const stdin =
      inputs
        .map((value) =>
          [
            value.mode,
            value.current.flags,
            value.current.unlockAfter,
            value.requested.flags,
            value.requested.unlockAfter,
            value.height,
            value.expiry,
            value.context?.chain || "other",
            value.context?.identityId || "oracle",
            value.context?.upgradeHeight ?? 0x100000000,
          ].join(" ")
        )
        .join("\n") + "\n";
    const output = execFileSync(binary, [], {
      input: stdin,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    })
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.strictEqual(output.length, inputs.length);
    return {
      provenance: {
        command: "node scripts/audit-identity-lock-oracle.js --write",
        compiler: execFileSync(compiler, ["--version"], {
          encoding: "utf8",
        }).split("\n")[0],
        sourceFiles: [
          ...new Set(source.snippets.map((value) => value.file)),
        ].map((file) => ({
          file,
          sha256: hash(fs.readFileSync(path.join(daemonRoot, file))),
        })),
        snippets: source.snippets.map(({ text, ...metadata }) => metadata),
        harnessSha256: hash(cpp),
        constants: [...source.constants, source.overrideHeight],
        assumptions: [
          "Identity version 3, PBaaS and IDCONSENSUS2 active at every tested height.",
          "Parent, name, system ID and identity ID are unchanged; content multimap is empty.",
          "Chain and identity destination decoding are represented by stable symbolic strings; equality, exemption membership and all override methods execute unchanged daemon source.",
          "Upgrade activation is absent unless the fixture context supplies its exact block height; both inactive and active historical upgrade cases are included.",
          "Authority, source-chain inclusion, transaction relay and wallet signing checks are outside this lock oracle.",
          "Native C++ uint32_t arithmetic and int32_t argument conversion are retained without rewriting extracted function bodies.",
        ],
      },
      cases: inputs.map((input, index) => ({
        ...input,
        daemon: output[index],
      })),
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const fixture = collect();
  if (process.argv.includes("--write")) {
    fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + "\n");
  } else {
    const saved = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    assert.deepStrictEqual(
      fixture.cases,
      saved.cases,
      "Daemon-source lock oracle changed; inspect before replacing fixtures"
    );
    assert.deepStrictEqual(
      fixture.provenance.snippets,
      saved.provenance.snippets,
      "Extracted daemon methods changed"
    );
    assert.deepStrictEqual(
      fixture.provenance.constants,
      saved.provenance.constants,
      "Daemon lock constants changed"
    );
    assert.strictEqual(
      fixture.provenance.harnessSha256,
      saved.provenance.harnessSha256,
      "Compiled oracle shell changed; regenerate and inspect fixtures"
    );
  }
  console.log(
    `Verified ${fixture.cases.length} lock cases using extracted daemon C++ (${fixture.provenance.harnessSha256}).`
  );
}

module.exports = { collect };
