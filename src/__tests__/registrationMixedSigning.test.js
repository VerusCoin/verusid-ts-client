// Combine real selection, independent funding verification, and signature
// merging. Fixtures are encoded directly; neither the SDK output planner nor
// its prevout/outputPlan amount metadata supplies the accounting oracle.
const {
  address,
  crypto,
  ECPair,
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
  IdentityCommitmentScript,
  IdentityID,
  KeyID,
  OptCCParams,
  SmartTransactionScript,
  TokenOutput,
  TxDestination,
} = require("verus-typescript-primitives");
const {
  fundRegistration,
  readRegistrationPrevout,
  validateRegistrationTransaction,
} = require("../identity/registrationTransaction");
const {
  verifyRegistrationFunding,
} = require("../identity/registrationFundingVerification");
const {
  inspectIdentityRegistrationSignatures,
  mergeIdentityRegistrationTransactions,
  signIdentityRegistrationTransaction,
} = require("../identity/registrationSigning");

const network = networks.verus;
const keys = [31, 32, 33, 34, 35, 36, 37].map((byte) =>
  ECPair.fromPrivateKeyBuffer(Buffer.alloc(32, byte), network)
);
const keyDestination = (key) =>
  new TxDestination(new KeyID(crypto.hash160(key.getPublicKeyBuffer())));
const idDestination = (byte) =>
  new TxDestination(new IdentityID(Buffer.alloc(20, byte)));
const A = keyDestination(keys[0]);
const B = keyDestination(keys[1]);
const ID = idDestination(41);
const ID_CHANGE = idDestination(42);
const R_CHANGE = keyDestination(keys[4]);
const RECIPIENT = keyDestination(keys[5]);
const SYSTEM = idDestination(51).toAddress();
const TOKEN = idDestination(52).toAddress();
const OTHER = idDestination(53).toAddress();
const THIRD = idDestination(54).toAddress();
const FEE = "100";
const snapshot = {
  systemID: SYSTEM,
  rootSystemName: "VRSCTEST",
  tipHeight: 100,
  tipHash: "cd".repeat(32),
  candidateHeight: 101,
  expiryDelta: 20,
  expiryHeight: 121,
};
const identityAuthorities = [
  {
    identityID: ID.toAddress(),
    primaryAddresses: [keys[2].getAddress(), keys[3].getAddress()],
    minimumSignatures: 2,
  },
  {
    identityID: ID_CHANGE.toAddress(),
    primaryAddresses: [keys[4].getAddress(), keys[6].getAddress()],
    minimumSignatures: 2,
  },
];
const authorizations = {
  a: { destinations: [A], threshold: 1, groups: [[keys[0]], []] },
  b: { destinations: [B], threshold: 1, groups: [[], [keys[1]]] },
  identity: {
    destinations: [ID],
    threshold: 1,
    groups: [[keys[2]], [keys[3]]],
  },
  // One outer key plus both identity primary keys satisfies two destinations.
  // The second outer key is deliberately unavailable to both signers.
  mixed: {
    destinations: [A, ID, B],
    threshold: 2,
    groups: [[keys[0], keys[2]], [keys[3]]],
  },
};
let nonce = 0;

const condition = (evalCode, destinations, threshold, vData = []) =>
  new OptCCParams({
    version: new BN(3),
    evalCode: new BN(evalCode),
    m: new BN(threshold),
    n: new BN(destinations.length),
    destinations,
    vData,
  });
const tokenPayload = (values) =>
  new TokenOutput({
    version: new BN(1),
    values: new CurrencyValueMap({
      valueMap: new Map(
        Object.entries(values).map(([id, amount]) => [id, new BN(amount)])
      ),
    }),
  }).toBuffer();
const smartOutput = (auth, reserves, master = "matching") => {
  const hasReserves = Object.keys(reserves).length !== 0;
  const params = condition(
    hasReserves ? EVALS.EVAL_RESERVE_OUTPUT : EVALS.EVAL_NONE,
    auth.destinations,
    auth.threshold,
    hasReserves ? [tokenPayload(reserves)] : []
  );
  return new SmartTransactionScript(
    master === "empty"
      ? condition(EVALS.EVAL_NONE, [], 0)
      : condition(EVALS.EVAL_NONE, auth.destinations, auth.threshold),
    params
  ).toBuffer();
};
const parse = (hex) => Transaction.fromHex(hex, network);
const outpoint = (input) => `${input.txid}:${input.vout}`;
const source = (outputScript, nativeValue, extra = {}) => {
  const builder = new TransactionBuilder(network);
  builder.setVersion(4);
  builder.setVersionGroupId(0x892f2085);
  builder.setExpiryHeight(90);
  const previousHash = Buffer.alloc(32, 0x18);
  previousHash.writeUInt32LE(++nonce, 0);
  builder.addInput(previousHash, 0);
  // Vary vout as well as txid so key assignment cannot assume output zero.
  const vout = nonce % 2;
  if (vout) builder.addOutput(RECIPIENT.toAddress(), 0);
  builder.addOutput(outputScript, nativeValue);
  const tx = builder.buildIncomplete();
  return { txid: tx.getId(), vout, rawTransaction: tx.toHex(), ...extra };
};
const input = (kind, auth = "a", master = "matching", native = 1000) => ({
  kind,
  auth,
  master,
  native,
});
const ordinarySource = (spec) => {
  const auth = authorizations[spec.auth];
  const reserves =
    spec.kind === "single"
      ? { [TOKEN]: "40" }
      : spec.kind === "multi"
      ? { [TOKEN]: "60", [OTHER]: "9007199254740993", [THIRD]: "7" }
      : {};
  const bytes =
    spec.kind === "p2pkh"
      ? address.toOutputScript(auth.destinations[0].toAddress(), network)
      : smartOutput(auth, reserves, spec.master);
  return source(bytes, spec.native, { spec, groups: auth.groups });
};
const commitmentSource = (value, restricted) =>
  source(
    IdentityCommitmentScript.fromCommitment(
      new CommitmentHash({ hash: Buffer.alloc(32, 55) }),
      A,
      restricted ? ID : undefined
    ).toBuffer(),
    value,
    {
      spec: { kind: "commitment", restricted },
      groups: restricted ? [[keys[0], keys[2]], [keys[3]]] : [[keys[0]], []],
    }
  );
const rpcFor = (sources) => ({
  getRawTransaction: jest.fn(async (txid) => ({
    error: null,
    result: sources.find((item) => item.txid === txid).rawTransaction,
  })),
  getTxOut: jest.fn(async (txid, vout, includeMempool) => {
    expect(includeMempool).toBe(true);
    const item = sources.find(
      (candidate) => candidate.txid === txid && candidate.vout === vout
    );
    if (!item) throw new Error("Unexpected fixture outpoint");
    const output = parse(item.rawTransaction).outs[vout];
    const decimal = String(output.value).padStart(9, "0");
    return {
      error: null,
      result: {
        bestblock: snapshot.tipHash,
        confirmations: 2,
        coinbase: false,
        value: `${decimal.slice(0, -8)}.${decimal.slice(-8)}`,
        scriptPubKey: { hex: output.script.toString("hex") },
      },
    };
  }),
});

// This decoder and BigInt arithmetic are independent of both SDK validators.
const rawAmounts = (output) => {
  const amounts = { [SYSTEM]: BigInt(output.value) };
  if (script.pubKeyHash.output.check(output.script)) return amounts;
  const smart = new SmartTransactionScript();
  smart.fromBuffer(output.script, 0, output.script.length);
  if (smart.paramsOptCC.evalCode.eqn(EVALS.EVAL_RESERVE_OUTPUT)) {
    const payload = smart.paramsOptCC.vData[0];
    const token = new TokenOutput();
    expect(token.fromBuffer(payload)).toBe(payload.length);
    for (const [id, value] of token.reserveValues.valueMap) {
      expect(id).not.toBe(SYSTEM);
      amounts[id] = BigInt(value.toString(10));
    }
  } else {
    expect([EVALS.EVAL_NONE, EVALS.EVAL_IDENTITY_COMMITMENT]).toContain(
      smart.paramsOptCC.evalCode.toNumber()
    );
  }
  return amounts;
};
const add = (totals, amounts) => {
  Object.entries(amounts).forEach(([id, value]) => {
    totals[id] = (totals[id] || 0n) + BigInt(value);
  });
  return totals;
};
const nonzero = (amounts) =>
  Object.fromEntries(
    Object.entries(amounts)
      .filter(([, amount]) => BigInt(amount) !== 0n)
      .map(([id, amount]) => [id, String(amount)])
  );
const outputBytes = (tx) =>
  tx.outs.map((output) => ({
    scriptHex: output.script.toString("hex"),
    value: String(output.value),
  }));
const assertConserved = (
  hex,
  allSources,
  approvedOutputs,
  expectedChange,
  changeAddress
) => {
  const tx = parse(hex);
  const incoming = {};
  const spent = new Set();
  tx.ins.forEach((spend) => {
    const id = `${Buffer.from(spend.hash).reverse().toString("hex")}:${
      spend.index
    }`;
    expect(spent.has(id)).toBe(false);
    spent.add(id);
    const origin = allSources.find((item) => outpoint(item) === id);
    expect(origin).toBeDefined();
    const raw = parse(origin.rawTransaction);
    expect(raw.getId()).toBe(origin.txid);
    add(incoming, rawAmounts(raw.outs[spend.index]));
  });
  const outgoing = {};
  tx.outs.forEach((output) => add(outgoing, rawAmounts(output)));
  const delta = {};
  new Set([...Object.keys(incoming), ...Object.keys(outgoing)]).forEach(
    (id) => {
      delta[id] = (incoming[id] || 0n) - (outgoing[id] || 0n);
    }
  );
  expect(nonzero(delta)).toEqual({ [SYSTEM]: FEE });
  expect(outputBytes(tx).slice(0, approvedOutputs.length)).toEqual(
    approvedOutputs.map((output) => ({
      scriptHex: output.scriptHex,
      value: output.value,
    }))
  );
  const change = tx.outs.slice(approvedOutputs.length);
  if (!Object.keys(expectedChange).length) {
    expect(change).toHaveLength(0);
  } else {
    expect(change).toHaveLength(1);
    expect(nonzero(rawAmounts(change[0]))).toEqual(expectedChange);
    if (script.pubKeyHash.output.check(change[0].script)) {
      expect(address.fromOutputScript(change[0].script, network)).toBe(
        changeAddress
      );
    } else {
      const smart = new SmartTransactionScript();
      smart.fromBuffer(change[0].script, 0, change[0].script.length);
      expect(smart.paramsOptCC.m.toNumber()).toBe(1);
      expect(
        smart.paramsOptCC.destinations.map((dest) => dest.toAddress())
      ).toEqual([changeAddress]);
    }
  }
};

const cases = [
  {
    name: "P2PKH plus native CC, matching masters and R change",
    inputs: [input("p2pkh"), input("native", "b")],
  },
  {
    name: "P2PKH plus single reserve controlled by a 2-of-2 identity",
    inputs: [input("p2pkh"), input("single", "identity")],
  },
  {
    name: "native identity with empty master plus multi-reserve key and i change",
    inputs: [input("native", "identity", "empty"), input("multi", "b")],
    identityChange: true,
  },
  {
    name: "all four input types plus zero-value restricted commitment",
    inputs: [
      input("p2pkh"),
      input("native", "b", "empty"),
      input("single", "identity"),
      input("multi", "mixed"),
    ],
    commitmentValue: 0,
    restricted: true,
  },
  {
    name: "all four input types plus nonzero restricted commitment and i change",
    inputs: [
      input("p2pkh"),
      input("native", "identity"),
      input("single", "b"),
      input("multi", "mixed"),
    ],
    commitmentValue: 700,
    restricted: true,
    identityChange: true,
  },
  {
    name: "mixed key/identity 2-of-3 native condition with matching master",
    inputs: [
      input("p2pkh", "b"),
      input("native", "mixed"),
      input("single"),
      input("multi", "identity"),
    ],
    identityChange: true,
  },
  {
    name: "mixed key/identity 2-of-3 native condition with empty master and simple commitment",
    inputs: [
      input("p2pkh", "b"),
      input("native", "mixed", "empty"),
      input("single", "identity"),
      input("multi"),
    ],
    commitmentValue: 0,
  },
  // Empty reserve masters represent historical spendable sources, not a claim
  // that current contextual checks permit creating these reserve outputs.
  {
    name: "historical single/multi-reserve empty masters with nested identities",
    inputs: [
      input("p2pkh"),
      input("native", "identity", "empty"),
      input("single", "mixed", "empty"),
      input("multi", "b", "empty"),
    ],
    identityChange: true,
  },
  {
    name: "zero-native smart/reserve inputs with nonzero commitment and multi-reserve change",
    inputs: [
      input("p2pkh"),
      input("native", "mixed", "matching", 0),
      input("single", "identity", "matching", 0),
      input("multi", "b"),
    ],
    commitmentValue: 250,
    restricted: true,
  },
  {
    name: "exact native and reserve balances across all four input types, with no change",
    inputs: [
      input("p2pkh"),
      input("native", "identity", "empty"),
      input("single", "b"),
      input("multi", "mixed"),
    ],
    exact: true,
  },
];

const build = async (spec) => {
  const candidates = spec.inputs.map(ordinarySource);
  const mandatorySource =
    spec.commitmentValue === undefined
      ? undefined
      : commitmentSource(spec.commitmentValue, !!spec.restricted);
  const selected = [
    ...(mandatorySource ? [mandatorySource] : []),
    ...candidates,
  ];
  const totals = {};
  selected.forEach((item) =>
    add(totals, rawAmounts(parse(item.rawTransaction).outs[item.vout]))
  );
  const spend = {
    [SYSTEM]: totals[SYSTEM] - BigInt(FEE) - (spec.exact ? 0n : 1n),
  };
  Object.entries(totals).forEach(([id, amount]) => {
    if (id === SYSTEM) return;
    if (spec.exact) spend[id] = amount;
    else if (id === TOKEN) spend[id] = amount - 1n;
  });
  const reserves = Object.fromEntries(
    Object.entries(spend)
      .filter(([id]) => id !== SYSTEM)
      .map(([id, amount]) => [id, String(amount)])
  );
  const paymentScript = Object.keys(reserves).length
    ? smartOutput({ destinations: [RECIPIENT], threshold: 1 }, reserves)
    : address.toOutputScript(RECIPIENT.toAddress(), network);
  const outputs = [
    {
      role: "issuer-payment",
      scriptHex: paymentScript.toString("hex"),
      value: String(spend[SYSTEM]),
      values: Object.fromEntries(
        Object.entries(spend).map(([id, amount]) => [id, String(amount)])
      ),
    },
  ];
  const change = {};
  Object.entries(totals).forEach(([id, amount]) => {
    change[id] =
      amount - (spend[id] || 0n) - (id === SYSTEM ? BigInt(FEE) : 0n);
  });
  // This suffix must stay unselected, including its distinct key and reserves.
  const unused = ordinarySource(input("multi", "a", "matching", 1000000));
  const sources = [...selected, unused];
  const rpc = rpcFor(sources);
  const mandatory = mandatorySource
    ? await readRegistrationPrevout(rpc, mandatorySource, snapshot, true)
    : undefined;
  const changeAddress = (
    spec.identityChange ? ID_CHANGE : R_CHANGE
  ).toAddress();
  const funded = await fundRegistration(
    rpc,
    snapshot,
    outputs,
    FEE,
    [...candidates, unused],
    changeAddress,
    mandatory
  );
  expect(funded.prevouts.map(outpoint)).toEqual(selected.map(outpoint));
  expect(
    rpc.getTxOut.mock.calls.map(([txid, vout]) => `${txid}:${vout}`)
  ).not.toContain(outpoint(unused));
  const approval = {
    snapshot,
    nativeFee: FEE,
    changeAddress,
    outputs,
    ...(mandatorySource ? { commitment: mandatorySource } : {}),
  };
  const args = {
    txHex: funded.txHex,
    prevouts: funded.prevouts,
    identityAuthorities,
  };
  const keyGroups = [0, 1].map((group) =>
    funded.prevouts.map((prevout) => {
      const origin = selected.find(
        (item) => outpoint(item) === outpoint(prevout)
      );
      return origin.groups[group].map((key) => key.toWIF());
    })
  );
  const verify = (hex) => {
    expect(verifyRegistrationFunding(funded, approval, hex)).toBe(true);
    expect(
      validateRegistrationTransaction(
        { ...funded, snapshot, nativeFee: FEE },
        hex
      )
    ).toBe(true);
    assertConserved(hex, sources, outputs, nonzero(change), changeAddress);
    expect(outputBytes(parse(hex))).toEqual(outputBytes(parse(funded.txHex)));
  };
  return { funded, approval, args, keyGroups, selected, verify };
};

describe("heterogeneous identity registration funding through signing and merge", () => {
  test.each(cases)("$name", async (spec) => {
    const fixture = await build(spec);
    const { args, keyGroups, selected, verify } = fixture;
    const unsigned = inspectIdentityRegistrationSignatures(args);
    expect(unsigned.signingStatus).toBe("unsigned");
    expect(unsigned.inputs.every((status) => !status.complete)).toBe(true);
    verify(unsigned.txHex);

    const first = signIdentityRegistrationTransaction({
      ...args,
      keys: keyGroups[0],
    });
    const second = signIdentityRegistrationTransaction({
      ...args,
      keys: keyGroups[1],
    });
    expect(first.signingStatus).toBe("partial");
    expect(second.signingStatus).toBe("partial");
    verify(first.txHex);
    verify(second.txHex);
    selected.forEach((origin, index) => {
      const requirement = first.inputs[index].requirements.find(
        (item) => item.identityID === ID.toAddress()
      );
      if (requirement) {
        expect(requirement.threshold).toBe(2);
        expect(requirement.signedKeyIDs).toEqual([keys[2].getAddress()]);
        expect(requirement.missingSignatures).toBe(1);
        expect(first.inputs[index].complete).toBe(false);
      }
      if (origin.spec.auth === "mixed") {
        expect(first.inputs[index].threshold).toBe(2);
        expect(
          first.inputs[index].requirements.map((item) => item.missingSignatures)
        ).toEqual([0, 1, 1]);
      }
    });

    const merged = mergeIdentityRegistrationTransactions({
      ...args,
      partialTransactions: [first.txHex, second.txHex],
    });
    expect(merged.signingStatus).toBe("complete");
    expect(merged.inputs.every((status) => status.complete)).toBe(true);
    verify(merged.txHex);
    expect(
      inspectIdentityRegistrationSignatures({ ...args, txHex: merged.txHex })
        .signingStatus
    ).toBe("complete");
    // Duplicate partials and reversed merge order cannot duplicate signatures.
    expect(
      mergeIdentityRegistrationTransactions({
        ...args,
        partialTransactions: [second.txHex, first.txHex, first.txHex],
      }).txHex
    ).toBe(merged.txHex);
    selected.forEach((origin, index) => {
      if (origin.spec.auth === "mixed") {
        expect(
          merged.inputs[index].requirements.map(
            (item) => item.missingSignatures
          )
        ).toEqual([0, 0, 1]);
      }
    });
  });

  test("rejects changed outputs, fees, reserves, and selected inputs in external partials", async () => {
    const { funded, approval, args, keyGroups, verify } = await build(cases[4]);
    const original = signIdentityRegistrationTransaction({
      ...args,
      keys: keyGroups[0],
    });
    const mutations = {
      "extra native fee": (tx) => {
        tx.outs[tx.outs.length - 1].value -= 1;
      },
      "changed payment recipient": (tx) => {
        const smart = new SmartTransactionScript();
        smart.fromBuffer(tx.outs[0].script, 0, tx.outs[0].script.length);
        const token = new TokenOutput();
        token.fromBuffer(smart.paramsOptCC.vData[0]);
        const values = Object.fromEntries(
          [...token.reserveValues.valueMap].map(([id, amount]) => [
            id,
            amount.toString(10),
          ])
        );
        tx.outs[0].script = smartOutput(
          { destinations: [R_CHANGE], threshold: 1 },
          values
        );
      },
      "changed reserve change amount": (tx) => {
        const index = tx.outs.length - 1;
        const values = rawAmounts(tx.outs[index]);
        tx.outs[index].script = smartOutput(
          { destinations: [ID_CHANGE], threshold: 1 },
          Object.fromEntries(
            Object.entries(values)
              .filter(([id]) => id !== SYSTEM)
              .map(([id, amount]) => [
                id,
                String(amount - (id === OTHER ? 1n : 0n)),
              ])
          )
        );
      },
      "changed identity change destination": (tx) => {
        const index = tx.outs.length - 1;
        tx.outs[index].script = smartOutput(
          { destinations: [ID], threshold: 1 },
          Object.fromEntries(
            Object.entries(rawAmounts(tx.outs[index]))
              .filter(([id]) => id !== SYSTEM)
              .map(([id, amount]) => [id, String(amount)])
          )
        );
      },
      "reordered outputs": (tx) => {
        tx.outs.reverse();
      },
      "reordered inputs": (tx) => {
        tx.ins.reverse();
      },
    };
    for (const mutate of Object.values(mutations)) {
      const altered = parse(original.txHex);
      mutate(altered);
      expect(() =>
        verifyRegistrationFunding(funded, approval, altered.toHex())
      ).toThrow(/changed after approval/);
      expect(() =>
        validateRegistrationTransaction(
          { ...funded, snapshot, nativeFee: FEE },
          altered.toHex()
        )
      ).toThrow(/differs from the approved/);
      expect(() =>
        mergeIdentityRegistrationTransactions({
          ...args,
          partialTransactions: [altered.toHex()],
        })
      ).toThrow(/changes the approved transaction/);
      expect(() =>
        signIdentityRegistrationTransaction({
          ...args,
          keys: keyGroups[1],
          partialTransactions: [altered.toHex()],
        })
      ).toThrow(/changes the approved transaction/);
    }
    verify(original.txHex);
    expect(
      signIdentityRegistrationTransaction({
        ...args,
        keys: keyGroups[1],
        partialTransactions: [original.txHex],
      }).signingStatus
    ).toBe("complete");
  });
});
