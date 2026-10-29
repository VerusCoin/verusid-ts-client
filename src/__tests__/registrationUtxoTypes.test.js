// Audit the funding whitelist against VerusCoin src/cc/eval.h, including evals
// unknown to the primitives parser. Build CC envelopes directly as wire scripts
// so fixture construction cannot silently omit unsupported eval codes.
const {
  address,
  ECPair,
  networks,
  opcodes,
  script,
  Transaction,
  TransactionBuilder,
} = require("@bitgo/utxo-lib");
const {
  BigNumber: BN,
  CommitmentHash,
  CurrencyValueMap,
  IdentityCommitmentScript,
  IdentityID,
  KeyID,
  SmartTransactionScript,
  TokenOutput,
  TxDestination,
} = require("verus-typescript-primitives");
const {
  fundRegistration,
  readFundingOutput,
  readRegistrationPrevout,
} = require("../identity/registrationTransaction");
const {
  verifyRegistrationFunding,
} = require("../identity/registrationFundingVerification");

// All 44 distinct FOREACH_EVAL values. EVAL_LAST (0x14) is only an alias.
const DAEMON_EVALS = [
  ["NONE", 0x00],
  ["STAKEGUARD", 0x01],
  ["CURRENCY_DEFINITION", 0x02],
  ["NOTARY_EVIDENCE", 0x03],
  ["EARNEDNOTARIZATION", 0x04],
  ["ACCEPTEDNOTARIZATION", 0x05],
  ["FINALIZE_NOTARIZATION", 0x06],
  ["CURRENCYSTATE", 0x07],
  ["RESERVE_TRANSFER", 0x08],
  ["RESERVE_OUTPUT", 0x09],
  ["IDENTITY_ADVANCEDRESERVATION", 0x0a],
  ["RESERVE_DEPOSIT", 0x0b],
  ["CROSSCHAIN_EXPORT", 0x0c],
  ["CROSSCHAIN_IMPORT", 0x0d],
  ["IDENTITY_PRIMARY", 0x0e],
  ["IDENTITY_REVOKE", 0x0f],
  ["IDENTITY_RECOVER", 0x10],
  ["IDENTITY_COMMITMENT", 0x11],
  ["IDENTITY_RESERVATION", 0x12],
  ["FINALIZE_EXPORT", 0x13],
  ["FEE_POOL", 0x14],
  ["NOTARY_SIGNATURE", 0x15],
  ["VOTING_GOVERNANCE", 0x16],
  ["VOTING_VOTE", 0x17],
  ["VOTING_POLL", 0x18],
  ["VOTING_SPEND", 0x19],
  ["QUANTUM_KEY", 0x1a],
  ["IMPORTPAYOUT", 0xe1],
  ["IMPORTCOIN", 0xe2],
  ["ASSETS", 0xe3],
  ["FAUCET", 0xe4],
  ["REWARDS", 0xe5],
  ["DICE", 0xe6],
  ["FSM", 0xe7],
  ["AUCTION", 0xe8],
  ["LOTTO", 0xe9],
  ["MOFN", 0xea],
  ["CHANNELS", 0xeb],
  ["ORACLES", 0xec],
  ["PRICES", 0xed],
  ["PEGS", 0xee],
  ["TRIGGERS", 0xef],
  ["PAYMENTS", 0xf0],
  ["GATEWAYS", 0xf1],
];
const UNSUPPORTED_EVALS = DAEMON_EVALS.filter(
  ([, code]) => code !== 0 && code !== 9
);
const destination = (byte, identity = false) =>
  new TxDestination(
    identity
      ? new IdentityID(Buffer.alloc(20, byte))
      : new KeyID(Buffer.alloc(20, byte))
  );
const SYSTEM = destination(1, true).toAddress();
const TOKEN = destination(2, true).toAddress();
const OTHER = destination(3, true).toAddress();
const OWNER = destination(5);
const OWNER_BYTES = Buffer.alloc(20, 5);
const KEY_SCRIPT = address.toOutputScript(OWNER.toAddress(), networks.verus);
const snapshot = {
  systemID: SYSTEM,
  rootSystemName: "VRSCTEST",
  tipHeight: 100,
  tipHash: "ab".repeat(32),
  candidateHeight: 101,
  expiryDelta: 20,
  expiryHeight: 121,
};
let nonce = 0;

const tokenOutput = (values) =>
  new TokenOutput({
    version: new BN(1),
    values: new CurrencyValueMap({
      valueMap: new Map(
        Object.entries(values).map(([id, amount]) => [id, new BN(amount)])
      ),
    }),
  });
const rawParams = (evalCode, data = []) =>
  script.compile([Buffer.from([3, evalCode, 1, 1]), OWNER_BYTES, ...data]);
const rawSmartScript = (evalCode, data = []) =>
  script.compile([
    rawParams(0),
    opcodes.OP_CHECKCRYPTOCONDITION,
    rawParams(evalCode, data),
    opcodes.OP_DROP,
  ]);
const transaction = (hex) => Transaction.fromHex(hex, networks.verus);
const builder = () => {
  const tx = new TransactionBuilder(networks.verus);
  tx.setVersion(4);
  tx.setVersionGroupId(0x892f2085);
  tx.setExpiryHeight(snapshot.expiryHeight);
  return tx;
};
const source = (outputScript, value = 10000, coinbase = false) => {
  const tx = builder();
  const hash = Buffer.alloc(32, 0x17);
  hash.writeUInt32LE(++nonce, 0);
  tx.addInput(hash, 0);
  tx.addOutput(outputScript, value);
  const raw = tx.buildIncomplete();
  if (coinbase) {
    raw.ins[0].hash = Buffer.alloc(32);
    raw.ins[0].index = 0xffffffff;
    raw.ins[0].script = Buffer.from("0101", "hex");
  }
  return { txid: raw.getId(), vout: 0, rawTransaction: raw.toHex() };
};
const prevout = (input) => {
  const output = transaction(input.rawTransaction).outs[input.vout];
  return {
    ...input,
    scriptHex: output.script.toString("hex"),
    value: String(output.value),
    // Deliberately omit any special payload value. Neither verifier may trust
    // this metadata when a caller tries to spend a special-purpose output.
    values: { [SYSTEM]: String(output.value) },
    confirmations: 2,
    height: 99,
  };
};
const rpcFor = (sources) => ({
  getTxOut: jest.fn(async (txid, vout) => {
    const input = sources.find(
      (item) => item.txid === txid && item.vout === vout
    );
    if (!input) throw new Error("Unexpected fixture outpoint");
    const raw = transaction(input.rawTransaction);
    const output = raw.outs[vout];
    const amount = String(output.value).padStart(9, "0");
    return {
      error: null,
      result: {
        value: `${amount.slice(0, -8)}.${amount.slice(-8)}`,
        scriptPubKey: { hex: output.script.toString("hex") },
        bestblock: snapshot.tipHash,
        confirmations: 2,
        coinbase: raw.isCoinbase(),
      },
    };
  }),
});
const select = (sources) =>
  fundRegistration(
    rpcFor(sources),
    snapshot,
    [],
    "1000",
    sources,
    OWNER.toAddress()
  );
const approval = (commitment) => ({
  snapshot,
  nativeFee: "1000",
  changeAddress: OWNER.toAddress(),
  outputs: [],
  ...(commitment ? { commitment } : {}),
});

// Bypass selection entirely, as a compromised/incorrect planner could. The
// separate accounting verifier must reject the actual unsupported source bytes.
const forgedPlan = (inputs) => {
  const tx = builder();
  let nativeTotal = 0;
  inputs.forEach((input) => {
    tx.addInput(input.txid, input.vout);
    nativeTotal += transaction(input.rawTransaction).outs[input.vout].value;
  });
  tx.addOutput(KEY_SCRIPT, nativeTotal - 1000);
  return {
    txHex: tx.buildIncomplete().toHex(),
    prevouts: inputs.map(prevout),
    outputPlan: [
      {
        role: "change",
        scriptHex: KEY_SCRIPT.toString("hex"),
        value: String(nativeTotal - 1000),
        values: { [SYSTEM]: String(nativeTotal - 1000) },
      },
    ],
  };
};
const rejectsIndependent = (inputs, commitment) =>
  expect(() =>
    verifyRegistrationFunding(forgedPlan(inputs), approval(commitment))
  ).toThrow(expect.objectContaining({ code: "REGISTRATION_FUNDING_MISMATCH" }));
const rejectsSelected = async (input) => {
  const insufficient = source(KEY_SCRIPT, 500);
  // The ordinary input never covers the fee alone, so every ordering must
  // actually inspect and reject the unsupported source, rather than skip it.
  for (const inputs of [
    [input],
    [input, insufficient],
    [insufficient, input],
  ]) {
    await expect(select(inputs)).rejects.toThrow();
    rejectsIndependent(inputs);
  }
};

describe("identity registration UTXO type whitelist", () => {
  test("covers every distinct daemon eval value, including unknown primitive evals", () => {
    expect(DAEMON_EVALS.map(([, code]) => code)).toEqual([
      ...Array.from({ length: 27 }, (_, index) => index),
      ...Array.from({ length: 17 }, (_, index) => 0xe1 + index),
    ]);
    expect(UNSUPPORTED_EVALS).toHaveLength(42);
  });

  test.each(UNSUPPORTED_EVALS)(
    "rejects selected EVAL_%s (%i) in every funding order",
    async (_name, evalCode) => {
      // Arbitrary nonempty payload is intentional: the eval is unsupported
      // regardless of whether its daemon-specific payload happens to be valid.
      // The genuine token-bearing commitment receives separate coverage below.
      const bytes = rawSmartScript(evalCode, [Buffer.alloc(32, 8)]);
      expect(script.decompile(script.decompile(bytes)[2])[0][1]).toBe(evalCode);
      expect(() => readFundingOutput(bytes, 10000, SYSTEM)).toThrow();
      await rejectsSelected(source(bytes));
    }
  );

  test.each([
    ["P2PKH", KEY_SCRIPT],
    ["ordinary EVAL_NONE", rawSmartScript(0)],
  ])(
    "accepts %s and returns only the authorized native fee",
    async (_name, bytes) => {
      const input = source(bytes);
      const result = await select([input]);
      expect(result.prevouts.map((item) => item.txid)).toEqual([input.txid]);
      const output = transaction(result.txHex).outs[0];
      expect(output.value).toBe(9000);
      expect(output.script).toEqual(KEY_SCRIPT);
      expect(verifyRegistrationFunding(result, approval())).toBe(true);
    }
  );

  test("accepts ordinary EVAL_RESERVE_OUTPUT and returns all unrelated reserves", async () => {
    const values = { [TOKEN]: "9007199254740993", [OTHER]: "42" };
    const bytes = rawSmartScript(9, [tokenOutput(values).toBuffer()]);
    const input = source(bytes);
    const result = await select([input]);
    const output = transaction(result.txHex).outs[0];
    expect(output.value).toBe(9000);
    const parsed = new SmartTransactionScript();
    parsed.fromBuffer(output.script, 0, output.script.length);
    expect(parsed.paramsOptCC.evalCode.toNumber()).toBe(9);
    const token = new TokenOutput();
    expect(token.fromBuffer(parsed.paramsOptCC.vData[0])).toBe(
      parsed.paramsOptCC.vData[0].length
    );
    expect(
      Object.fromEntries(
        [...token.reserveValues.valueMap].map(([id, amount]) => [
          id,
          amount.toString(10),
        ])
      )
    ).toEqual(values);
    expect(verifyRegistrationFunding(result, approval())).toBe(true);
  });

  test("ignores unsupported unselected trailing inputs after approved funding is sufficient", async () => {
    const ordinary = source(KEY_SCRIPT);
    const unused = source(rawSmartScript(0xf1, [Buffer.alloc(32, 8)]));
    const rpc = rpcFor([ordinary, unused]);
    const result = await fundRegistration(
      rpc,
      snapshot,
      [],
      "1000",
      [ordinary, unused],
      OWNER.toAddress()
    );
    expect(result.prevouts.map((item) => item.txid)).toEqual([ordinary.txid]);
    expect(rpc.getTxOut).toHaveBeenCalledTimes(1);
  });

  test("rejects a real advanced commitment with hidden token balances on both funding paths", async () => {
    const advanced = new CommitmentHash({
      tokenOutput: tokenOutput({ [TOKEN]: "9007199254740993", [OTHER]: "42" }),
    });
    expect(advanced.isAdvanced()).toBe(true);
    const bytes = rawSmartScript(0x11, [advanced.toBuffer()]);
    const parsed = new IdentityCommitmentScript();
    parsed.fromBuffer(bytes, 0, bytes.length);
    expect(parsed.getCommitment().isAdvanced()).toBe(true);
    expect(
      parsed
        .getCommitment()
        .tokenOutput.reserveValues.valueMap.get(TOKEN)
        .toString(10)
    ).toBe("9007199254740993");
    const input = source(bytes);
    await rejectsSelected(input);
    await expect(
      readRegistrationPrevout(rpcFor([input]), input, snapshot, true)
    ).rejects.toThrow(
      expect.objectContaining({ code: "UNSUPPORTED_COMMITMENT" })
    );
    rejectsIndependent([input], input);
    // Even a caller injecting its own pre-read mandatory record cannot make
    // the selector release a transaction that silently discards those tokens.
    await expect(
      fundRegistration(
        rpcFor([input]),
        snapshot,
        [],
        "1000",
        [],
        OWNER.toAddress(),
        prevout(input)
      )
    ).rejects.toThrow(
      expect.objectContaining({ code: "REGISTRATION_FUNDING_MISMATCH" })
    );
  });

  test("ordinary commitment value is allowed only through the exact mandatory outpoint", async () => {
    const bytes = rawSmartScript(0x11, [Buffer.alloc(32, 8)]);
    const input = source(bytes);
    await rejectsSelected(input);
    const mandatory = await readRegistrationPrevout(
      rpcFor([input]),
      input,
      snapshot,
      true
    );
    const result = await fundRegistration(
      rpcFor([input]),
      snapshot,
      [],
      "1000",
      [],
      OWNER.toAddress(),
      mandatory
    );
    expect(transaction(result.txHex).outs[0].value).toBe(9000);
    expect(verifyRegistrationFunding(result, approval(input))).toBe(true);
    expect(() =>
      verifyRegistrationFunding(
        result,
        approval({ txid: "ff".repeat(32), vout: 0 })
      )
    ).toThrow(
      expect.objectContaining({ code: "REGISTRATION_FUNDING_MISMATCH" })
    );
  });

  const publicKey = ECPair.fromPrivateKeyBuffer(
    Buffer.alloc(32, 7),
    networks.verus
  ).getPublicKeyBuffer();
  test.each([
    [
      "P2SH",
      script.compile([
        opcodes.OP_HASH160,
        Buffer.alloc(20, 8),
        opcodes.OP_EQUAL,
      ]),
    ],
    ["P2PK", script.compile([publicKey, opcodes.OP_CHECKSIG])],
    [
      "bare multisig",
      script.compile([
        opcodes.OP_1,
        publicKey,
        opcodes.OP_1,
        opcodes.OP_CHECKMULTISIG,
      ]),
    ],
    [
      "CLTV-wrapped P2PKH",
      script.compile([
        script.number.encode(100),
        opcodes.OP_CHECKLOCKTIMEVERIFY,
        opcodes.OP_DROP,
        ...script.decompile(KEY_SCRIPT),
      ]),
    ],
    ["OP_RETURN", script.compile([opcodes.OP_RETURN, Buffer.from("audit")])],
    ["anyone-can-spend", script.compile([opcodes.OP_TRUE])],
    ["empty", Buffer.alloc(0)],
  ])(
    "rejects unsupported %s script funding in every selected position",
    async (_name, bytes) => {
      await rejectsSelected(source(bytes));
    }
  );

  test.each([
    ["P2PKH", KEY_SCRIPT],
    ["ordinary EVAL_NONE", rawSmartScript(0)],
    [
      "reserve output",
      rawSmartScript(9, [tokenOutput({ [TOKEN]: "42" }).toBuffer()]),
    ],
  ])(
    "rejects coinbase %s funding even with matching live metadata",
    async (_name, bytes) => {
      const input = source(bytes, 10000, true);
      expect(transaction(input.rawTransaction).isCoinbase()).toBe(true);
      await rejectsSelected(input);
      await expect(
        readRegistrationPrevout(rpcFor([input]), input, snapshot)
      ).rejects.toThrow(
        expect.objectContaining({ code: "UNSUPPORTED_FUNDING" })
      );
    }
  );
});
