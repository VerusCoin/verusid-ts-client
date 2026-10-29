// Cross the accepted funding script/authority categories, then independently
// decode raw currency balances using BigInt. No paymentOutput, readFundingOutput,
// TokenOutput decoder, or selector balance metadata is used as the oracle.
const {
  address,
  networks,
  script,
  Transaction,
  TransactionBuilder,
} = require("@bitgo/utxo-lib");
const {
  BigNumber: BN,
  CommitmentHash,
  CurrencyValueMap,
  EVALS,
  I_ADDR_VERSION,
  IdentityCommitmentScript,
  IdentityID,
  KeyID,
  OptCCParams,
  SmartTransactionScript,
  TokenOutput,
  TxDestination,
  toBase58Check,
} = require("verus-typescript-primitives");
const {
  fundRegistration,
  readRegistrationPrevout,
  validateRegistrationTransaction,
} = require("../identity/registrationTransaction");
const {
  verifyRegistrationFunding,
} = require("../identity/registrationFundingVerification");

const key = (index) =>
  new TxDestination(new KeyID(Buffer.alloc(20, 10 + index)));
const identity = (index) =>
  new TxDestination(new IdentityID(Buffer.alloc(20, 30 + index)));
const SYSTEM = identity(1).toAddress();
const TOKEN = identity(2).toAddress();
const OTHER = identity(3).toAddress();
const UNRELATED = identity(4).toAddress();
const ZERO = identity(5).toAddress();
const snapshot = {
  systemID: SYSTEM,
  rootSystemName: "VRSCTEST",
  tipHeight: 100,
  tipHash: "ab".repeat(32),
  candidateHeight: 101,
  expiryDelta: 20,
  expiryHeight: 121,
};
const FEE = "1000";
const CHANGE = [
  ["key change", key(8)],
  ["identity change", identity(8)],
];
const STAGES = [
  ["no commitment", null],
  ["zero commitment", 0],
  ["funded commitment", 777],
];
let nonce = 0;

const params = (code, destinations, threshold, vData = []) =>
  new OptCCParams({
    version: new BN(3),
    evalCode: new BN(code),
    m: new BN(threshold),
    n: new BN(destinations.length),
    destinations,
    vData,
  });
const smartOutput = (destinations, threshold, master, reserves) =>
  new SmartTransactionScript(
    params(
      EVALS.EVAL_NONE,
      master === "empty" ? [] : destinations,
      master === "empty" ? 0 : threshold
    ),
    params(
      reserves == null ? EVALS.EVAL_NONE : EVALS.EVAL_RESERVE_OUTPUT,
      destinations,
      threshold,
      reserves == null
        ? []
        : [
            new TokenOutput({
              version: new BN(1),
              values: new CurrencyValueMap({
                valueMap: new Map(
                  Object.entries(reserves).map(([id, amount]) => [
                    id,
                    new BN(amount),
                  ])
                ),
              }),
            }).toBuffer(),
          ]
    )
  ).toBuffer();
const builder = () => {
  const result = new TransactionBuilder(networks.verus);
  result.setVersion(4);
  result.setVersionGroupId(0x892f2085);
  result.setExpiryHeight(snapshot.expiryHeight);
  return result;
};
const source = (outputs) => {
  const result = builder();
  const hash = Buffer.alloc(32, 71);
  hash.writeUInt32LE(++nonce, 0);
  result.addInput(hash, 0);
  outputs.forEach((output) => result.addOutput(output.script, output.value));
  const tx = result.buildIncomplete();
  return outputs.map((_, vout) => ({
    txid: tx.getId(),
    vout,
    rawTransaction: tx.toHex(),
  }));
};
const outpoint = (input) => `${input.txid}:${input.vout}`;
const raw = (hex) => Transaction.fromHex(hex, networks.verus);
const sourceOutput = (input) => raw(input.rawTransaction).outs[input.vout];
const rpcFor = (inputs) => ({
  getTxOut: jest.fn(async (txid, vout, includeMempool) => {
    expect(includeMempool).toBe(true);
    const input = inputs.find(
      (item) => item.txid === txid && item.vout === vout
    );
    expect(input).toBeDefined();
    const output = sourceOutput(input);
    const value = String(output.value).padStart(9, "0");
    return {
      error: null,
      result: {
        bestblock: snapshot.tipHash,
        confirmations: 2,
        coinbase: false,
        value: `${value.slice(0, -8)}.${value.slice(-8)}`,
        scriptPubKey: { hex: output.script.toString("hex") },
      },
    };
  }),
});

// Bitcoin Core VARINT (not CompactSize), used for token version and single value.
function decodeToken(bytes) {
  let offset = 0;
  const varint = () => {
    let result = BigInt(0);
    for (;;) {
      if (offset >= bytes.length) throw new Error("Truncated token varint");
      const byte = bytes[offset++];
      result = (result << BigInt(7)) | BigInt(byte & 0x7f);
      if (!(byte & 0x80)) return result;
      result++;
    }
  };
  const version = varint();
  const multi = Boolean(version & BigInt("0x80000000"));
  expect(version & ~BigInt("0x80000000")).toBe(BigInt(1));
  let count = 1;
  if (multi) {
    count = bytes[offset++];
    if (count === 253) {
      count = bytes.readUInt16LE(offset);
      offset += 2;
    } else if (count === 254) {
      count = bytes.readUInt32LE(offset);
      offset += 4;
    } else if (count === 255) {
      count = Number(bytes.readBigUInt64LE(offset));
      offset += 8;
    }
  }
  const result = {};
  for (let i = 0; i < count; i++) {
    const id = toBase58Check(
      bytes.subarray(offset, offset + 20),
      I_ADDR_VERSION
    );
    offset += 20;
    const value = multi ? bytes.readBigInt64LE(offset) : varint();
    if (multi) offset += 8;
    expect(result[id]).toBeUndefined();
    expect(id).not.toBe(SYSTEM);
    expect(value >= BigInt(0)).toBe(true);
    result[id] = value;
  }
  expect(offset).toBe(bytes.length);
  return result;
}
const balances = (output) => {
  const result = { [SYSTEM]: BigInt(output.value) };
  if (script.pubKeyHash.output.check(output.script)) return result;
  const chunks = script.decompile(output.script);
  const condition = script.decompile(chunks[2]);
  const [, code, , n] = condition[0];
  expect([
    EVALS.EVAL_NONE,
    EVALS.EVAL_RESERVE_OUTPUT,
    EVALS.EVAL_IDENTITY_COMMITMENT,
  ]).toContain(code);
  if (code === EVALS.EVAL_RESERVE_OUTPUT)
    Object.assign(result, decodeToken(condition[n + 1]));
  if (code === EVALS.EVAL_IDENTITY_COMMITMENT)
    expect(condition[n + 1]).toHaveLength(32);
  return result;
};
const add = (target, values) => {
  for (const [id, amount] of Object.entries(values))
    target[id] = (target[id] || BigInt(0)) + BigInt(amount);
  return target;
};
const nonzero = (values) =>
  Object.fromEntries(
    Object.entries(values)
      .filter(([, amount]) => BigInt(amount) !== BigInt(0))
      .map(([id, amount]) => [id, String(amount)])
  );
const totals = (inputs) =>
  inputs.reduce(
    (result, input) => add(result, balances(sourceOutput(input))),
    {}
  );

// Every basket already mixes both owner types and all four ordinary script
// families; each row then adds the authority/value form under test.
const basket = (target) => [
  {
    script: address.toOutputScript(key(0).toAddress(), networks.verus),
    value: 11000,
  },
  { script: smartOutput([identity(0)], 1, "empty"), value: 12000 },
  {
    script: smartOutput([key(1)], 1, "matching", {
      [TOKEN]: "9007199254740993",
    }),
    value: 13000,
  },
  {
    script: smartOutput([identity(1)], 1, "matching", {
      [TOKEN]: "37",
      [OTHER]: "41",
      [UNRELATED]: "43",
    }),
    value: 14000,
  },
  target,
];
const ASSETS = [
  ["native", undefined, 15000],
  ["empty reserve map", {}, 15000],
  ["single zero reserve", { [ZERO]: "0" }, 15000],
  ["single reserve only", { [TOKEN]: "53" }, 0],
  ["single reserve plus native", { [TOKEN]: "53" }, 15000],
  ["multiple reserves only", { [TOKEN]: "53", [OTHER]: "59" }, 0],
  ["multiple reserves plus native", { [TOKEN]: "53", [OTHER]: "59" }, 15000],
];
const AUTHORITIES = [];
for (let n = 1; n <= 4; n++) {
  for (let m = 1; m <= n; m++) {
    for (let keyCount = 0; keyCount <= n; keyCount++) {
      const destinations = Array.from({ length: n }, (_, index) =>
        index < keyCount ? key(index) : identity(index)
      );
      // Four indexed destinations require PUSHDATA1, which the daemon rejects.
      for (const master of n === 4 ? ["empty"] : ["empty", "matching"]) {
        AUTHORITIES.push({
          label: `${m}-of-${n}, ${keyCount} keys, ${
            n - keyCount
          } identities, ${master} master`,
          destinations,
          m,
          master,
        });
      }
    }
  }
}
const VARIANTS = AUTHORITIES.flatMap((auth) =>
  ASSETS.map(([label, reserves, value]) => ({
    label: `${auth.label}, ${label}`,
    auth,
    reserves,
    value,
  }))
);
const sourceCache = new Map();
function inputsFor(variant, sharedSource = false, reverseDestinations = false) {
  const cacheKey = `${variant.label}/${sharedSource}/${reverseDestinations}`;
  if (!sourceCache.has(cacheKey)) {
    const destinations = variant.auth.destinations.slice();
    if (reverseDestinations) destinations.reverse();
    const outputs = basket({
      script: smartOutput(
        destinations,
        variant.auth.m,
        variant.auth.master,
        variant.reserves
      ),
      value: variant.value,
    });
    sourceCache.set(
      cacheKey,
      sharedSource
        ? source(outputs)
        : outputs.flatMap((output) => source([output]))
    );
  }
  return sourceCache.get(cacheKey);
}
const commitmentCache = new Map();
function commitmentFor(value) {
  if (value === null) return null;
  if (!commitmentCache.has(value))
    commitmentCache.set(
      value,
      source([
        {
          script: IdentityCommitmentScript.fromCommitment(
            new CommitmentHash({ hash: Buffer.alloc(32, 9) }),
            key(0)
          ).toBuffer(),
          value,
        },
      ])[0]
    );
  return commitmentCache.get(value);
}
const desiredChange = (profile, total) => {
  if (profile === "exact") return {};
  if (profile === "native only") return { [SYSTEM]: "1" };
  if (profile === "single reserve only") return { [TOKEN]: "1" };
  if (profile === "multiple reserves only")
    return { [TOKEN]: "1", [OTHER]: "1" };
  if (profile === "unrelated reserves only")
    return { [UNRELATED]: String(total[UNRELATED]) };
  return {
    [SYSTEM]: "1",
    [TOKEN]: "1",
    [OTHER]: "1",
    [UNRELATED]: String(total[UNRELATED]),
  };
};
function approvedOutputs(total, change) {
  const needed = Object.fromEntries(
    Object.entries(total).map(([id, amount]) => [
      id,
      (
        amount -
        BigInt(change[id] || 0) -
        (id === SYSTEM ? BigInt(FEE) : BigInt(0))
      ).toString(),
    ])
  );
  const payment = (values, dest, role) => {
    const reserve = Object.fromEntries(
      Object.entries(values).filter(
        ([id, amount]) => id !== SYSTEM && amount !== "0"
      )
    );
    const bytes = Object.keys(reserve).length
      ? smartOutput([dest], 1, "matching", reserve)
      : address.toOutputScript(dest.toAddress(), networks.verus);
    return {
      role,
      scriptHex: bytes.toString("hex"),
      value: values[SYSTEM] || "0",
      values: { ...values, [SYSTEM]: values[SYSTEM] || "0" },
    };
  };
  return [
    payment(
      { [SYSTEM]: needed[SYSTEM], [TOKEN]: needed[TOKEN] },
      key(6),
      "issuer-payment"
    ),
    payment(
      Object.fromEntries(
        Object.entries(needed).filter(([id]) => id !== SYSTEM && id !== TOKEN)
      ),
      key(7),
      "referral"
    ),
  ];
}
function assertWireAccounting(
  funded,
  selected,
  outputs,
  change,
  recipient,
  candidateHex = funded.txHex
) {
  const tx = raw(candidateHex);
  expect(
    tx.ins.map(
      (input) =>
        `${Buffer.from(input.hash).reverse().toString("hex")}:${input.index}`
    )
  ).toEqual(selected.map(outpoint));
  const incoming = totals(selected);
  const outgoing = tx.outs.reduce(
    (result, output) => add(result, balances(output)),
    {}
  );
  const difference = {};
  new Set([...Object.keys(incoming), ...Object.keys(outgoing)]).forEach(
    (id) => {
      difference[id] =
        (incoming[id] || BigInt(0)) - (outgoing[id] || BigInt(0));
    }
  );
  expect(nonzero(difference)).toEqual({ [SYSTEM]: FEE });
  outputs.forEach((output, i) => {
    expect(tx.outs[i].script.toString("hex")).toBe(output.scriptHex);
    expect(String(tx.outs[i].value)).toBe(output.value);
  });
  expect(tx.outs.length).toBe(
    outputs.length + (Object.keys(nonzero(change)).length ? 1 : 0)
  );
  expect(
    nonzero(
      tx.outs
        .slice(outputs.length)
        .reduce((result, output) => add(result, balances(output)), {})
    )
  ).toEqual(nonzero(change));
  tx.outs.slice(outputs.length).forEach((output) => {
    if (script.pubKeyHash.output.check(output.script)) {
      expect(address.fromOutputScript(output.script, networks.verus)).toBe(
        recipient.toAddress()
      );
    } else {
      const smart = new SmartTransactionScript();
      smart.fromBuffer(output.script);
      expect(smart.paramsOptCC.m.toNumber()).toBe(1);
      expect(smart.paramsOptCC.n.toNumber()).toBe(1);
      expect(
        smart.paramsOptCC.destinations.map((dest) => dest.toAddress())
      ).toEqual([recipient.toAddress()]);
    }
  });
}
async function runCase(
  variant,
  commitmentValue,
  recipient,
  profile = "native and reserves",
  sharedSource = false,
  reverseDestinations = false
) {
  const ordinary = inputsFor(variant, sharedSource, reverseDestinations);
  const commitment = commitmentFor(commitmentValue);
  const all = [...(commitment ? [commitment] : []), ...ordinary];
  const total = totals(all);
  const change = desiredChange(profile, total);
  const outputs = approvedOutputs(total, change);
  for (const ordered of [ordinary, ordinary.slice().reverse()]) {
    const rpc = rpcFor(all);
    const mandatory = commitment
      ? await readRegistrationPrevout(rpc, commitment, snapshot, true)
      : undefined;
    rpc.getTxOut.mockClear();
    // An unusable tail proves the selector stops after its exact chosen prefix.
    const unused = { txid: "ff".repeat(32), vout: 0, rawTransaction: "00" };
    const funded = await fundRegistration(
      rpc,
      snapshot,
      outputs,
      FEE,
      [...ordered, unused],
      recipient.toAddress(),
      mandatory
    );
    const selected = [...(commitment ? [commitment] : []), ...ordered];
    // Without this assertion a row might never exercise the target script.
    expect(funded.prevouts.map(outpoint)).toEqual(selected.map(outpoint));
    expect(rpc.getTxOut).toHaveBeenCalledTimes(ordinary.length);
    assertWireAccounting(funded, selected, outputs, change, recipient);
    expect(
      validateRegistrationTransaction({ ...funded, snapshot, nativeFee: FEE })
    ).toBe(true);
    expect(
      verifyRegistrationFunding(funded, {
        snapshot,
        nativeFee: FEE,
        changeAddress: recipient.toAddress(),
        outputs,
        ...(commitment ? { commitment } : {}),
      })
    ).toBe(true);
  }
}

describe("mixed funding category matrix", () => {
  test("covers every accepted arity, threshold, key/identity count and master category", () => {
    expect(AUTHORITIES).toHaveLength(60);
    expect(VARIANTS).toHaveLength(420);
  });
  // Empty-master reserve sources model historical UTXOs: the daemon can spend
  // them, although current PBaaS creation requires a different master shape.
  test.each(
    VARIANTS.flatMap((variant) =>
      STAGES.flatMap(([stage, value]) =>
        CHANGE.map(([label, dest]) => [
          `${variant.label}; ${stage}; ${label}`,
          variant,
          value,
          dest,
        ])
      )
    )
  )("%s", async (_label, variant, value, dest) => {
    await runCase(variant, value, dest);
  });
});

const mixed = VARIANTS.find(
  (variant) =>
    variant.auth.destinations.length === 3 &&
    variant.auth.m === 2 &&
    variant.auth.destinations[0].type.eq(TxDestination.TYPE_PKH) &&
    variant.auth.destinations[1].type.eq(TxDestination.TYPE_ID) &&
    variant.auth.master === "matching" &&
    variant.reserves &&
    variant.reserves[OTHER] &&
    variant.value === 0
);
describe("change shapes and same-transaction mixed funding", () => {
  test.each(
    [
      "exact",
      "native only",
      "single reserve only",
      "multiple reserves only",
      "unrelated reserves only",
      "native and reserves",
    ].flatMap((profile) =>
      STAGES.flatMap(([stage, value]) =>
        CHANGE.flatMap(([label, dest]) =>
          [false, true].map((shared) => [
            `${profile}; ${stage}; ${label}; shared source=${shared}`,
            profile,
            value,
            dest,
            shared,
          ])
        )
      )
    )
  )("%s", async (_label, profile, value, dest, shared) => {
    await runCase(mixed, value, dest, profile, shared, true);
  });
});

test("a funded commitment covers all native costs while selected reserve-only funding still returns every reserve", async () => {
  const commitment = commitmentFor(1001);
  const reserves = source([
    {
      script: smartOutput([identity(0)], 1, "matching", {
        [TOKEN]: "9007199254740993",
        [OTHER]: "41",
      }),
      value: 0,
    },
  ])[0];
  const selected = [commitment, reserves];
  const change = { [SYSTEM]: "1", [TOKEN]: "1", [OTHER]: "41" };
  const total = totals(selected);
  const outputs = approvedOutputs(total, change);
  const rpc = rpcFor(selected);
  const mandatory = await readRegistrationPrevout(
    rpc,
    commitment,
    snapshot,
    true
  );
  const funded = await fundRegistration(
    rpc,
    snapshot,
    outputs,
    FEE,
    [reserves],
    key(8).toAddress(),
    mandatory
  );
  assertWireAccounting(funded, selected, outputs, change, key(8));
  expect(
    verifyRegistrationFunding(funded, {
      snapshot,
      nativeFee: FEE,
      changeAddress: key(8).toAddress(),
      outputs,
      commitment,
    })
  ).toBe(true);
});

test.each(ASSETS)(
  "rejects five-destination %s funding mixed with supported inputs",
  async (_label, reserves, value) => {
    const target = {
      script: smartOutput(
        Array.from({ length: 5 }, (_, i) => key(i)),
        2,
        "empty",
        reserves
      ),
      value,
    };
    const inputs = basket(target).flatMap((output) => source([output]));
    // Force rejection before ordinary input balances could satisfy selection.
    await expect(
      fundRegistration(
        rpcFor(inputs),
        snapshot,
        [],
        FEE,
        [inputs[4], inputs[0]],
        key(8).toAddress()
      )
    ).rejects.toThrow();
  }
);
