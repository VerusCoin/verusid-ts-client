// Daemon limits apply after combining currencies from independently valid UTXOs.
const {
  address,
  networks,
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
  paymentOutput,
  readFundingOutput,
} = require("../identity/registrationTransaction");
const {
  verifyRegistrationFunding,
  verifyIdentityRegistrationFunding,
} = require("../identity/registrationFundingVerification");
const { default: VerusIdInterface } = require("../VerusIdInterface");

const owner = new TxDestination(new KeyID(Buffer.alloc(20, 7)));
const identityOwner = new TxDestination(new IdentityID(Buffer.alloc(20, 8)));
const system = new IdentityID(Buffer.alloc(20, 1)).toAddress();
const snapshot = {
  systemID: system,
  rootSystemName: "VRSCTEST",
  tipHeight: 100,
  tipHash: "ab".repeat(32),
  candidateHeight: 101,
  expiryDelta: 20,
  expiryHeight: 121,
};
const amounts = (count, offset = 0) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => {
      const bytes = Buffer.alloc(20, 17);
      bytes.writeUInt32LE(i + offset + 1, 0);
      return [new IdentityID(bytes).toAddress(), "1"];
    })
  );
const params = (code, dest, vData = []) =>
  new OptCCParams({
    version: new BN(3),
    evalCode: new BN(code),
    m: new BN(1),
    n: new BN(1),
    destinations: [dest],
    vData,
  });
// Deliberately bypass paymentOutput to reproduce unsafe bytes from an external
// candidate or an older selector. This matches the daemon's wire structure.
const reserveScript = (values, dest = owner) =>
  new SmartTransactionScript(
    params(EVALS.EVAL_NONE, dest),
    params(EVALS.EVAL_RESERVE_OUTPUT, dest, [
      new TokenOutput({
        version: new BN(1),
        values: new CurrencyValueMap({
          valueMap: new Map(
            Object.entries(values).map(([id, value]) => [id, new BN(value)])
          ),
        }),
      }).toBuffer(),
    ])
  ).toBuffer();
const tx = (inputs, outputs) => {
  const builder = new TransactionBuilder(networks.verus);
  builder.setVersion(4);
  builder.setVersionGroupId(0x892f2085);
  builder.setExpiryHeight(snapshot.expiryHeight);
  inputs.forEach((input) => builder.addInput(input.txid, input.vout));
  outputs.forEach((output) => builder.addOutput(output.script, output.value));
  return builder.buildIncomplete();
};
const fixture = (count) => {
  const split = Math.ceil(count / 2);
  const reserves = [amounts(split), amounts(count - split, split)];
  const prevouts = reserves.map((values, index) => {
    const source = tx(
      [{ txid: String(index + 1).repeat(64), vout: 0 }],
      [{ script: reserveScript(values), value: 6000 }]
    );
    return {
      txid: source.getId(),
      vout: 0,
      rawTransaction: source.toHex(),
      scriptHex: source.outs[0].script.toString("hex"),
      value: "6000",
      values: { [system]: "6000", ...values },
      confirmations: 2,
      height: 99,
    };
  });
  const commitment = IdentityCommitmentScript.fromCommitment(
    new CommitmentHash({ hash: Buffer.alloc(32, 3) }),
    owner
  ).toBuffer();
  const outputs = [
    {
      role: "commitment",
      scriptHex: commitment.toString("hex"),
      value: "0",
      values: { [system]: "0" },
    },
  ];
  const changeScript = reserveScript(amounts(count));
  const candidate = tx(prevouts, [
    { script: commitment, value: 0 },
    { script: changeScript, value: 2000 },
  ]);
  const quote = {
    systemID: system,
    issuerID: system,
    commitmentFee: "10000",
    registrationOffer: "100000000",
    nativeFee: "100000000",
    importFee: "0",
    transferFee: "0",
    referralPayments: [],
    totalRequired: { [system]: "100000000" },
    totalOperationRequired: { [system]: "100010000" },
  };
  const prepared = {
    txHex: candidate.toHex(),
    hex: candidate.toHex(),
    prevouts,
    outputPlan: [
      ...outputs,
      {
        role: "change",
        scriptHex: changeScript.toString("hex"),
        value: "2000",
        values: { [system]: "2000", ...amounts(count) },
      },
    ],
    snapshot,
    quote,
    nativeFee: "10000",
    changeAddress: owner.toAddress(),
    approvedCosts: quote.totalOperationRequired,
    stage: "commitment",
    identityAuthorities: [],
    revealAuthorities: [],
    requiredSignatures: [],
    signingStatus: "unsigned",
  };
  const rpc = {
    getTxOut: jest.fn(async (txid) => ({
      error: null,
      result: {
        bestblock: snapshot.tipHash,
        confirmations: 2,
        coinbase: false,
        value: "0.00006000",
        scriptPubKey: {
          hex: prevouts.find((input) => input.txid === txid).scriptHex,
        },
      },
    })),
  };
  const approval = {
    snapshot,
    nativeFee: "10000",
    changeAddress: owner.toAddress(),
    outputs,
  };
  return { prepared, approval, rpc, changeScript };
};

test.each([
  [owner, 212],
  [identityOwner, 211],
])("accepts the last spendable reserve change size for %s", (dest, count) => {
  const output = paymentOutput(
    dest.toAddress(),
    amounts(count),
    system,
    "change"
  );
  expect(output.scriptHex).toBe(
    reserveScript(amounts(count), dest).toString("hex")
  );
  expect(
    readFundingOutput(Buffer.from(output.scriptHex, "hex"), 0, system)
  ).toEqual({ [system]: "0", ...amounts(count) });
});

test.each([
  [owner, 213],
  [identityOwner, 212],
])("rejects the first oversized reserve change for %s", (dest, count) => {
  expect(() =>
    paymentOutput(dest.toAddress(), amounts(count), system, "change")
  ).toThrow();
  expect(() =>
    readFundingOutput(reserveScript(amounts(count), dest), 0, system)
  ).toThrow();
});

test.each([213, 253, 360])(
  "rejects consolidation of valid inputs into %i-currency change before returning or signing",
  async (count) => {
    const { prepared, approval, rpc, changeScript } = fixture(count);
    prepared.prevouts.forEach((input) => {
      const output = Transaction.fromHex(input.rawTransaction, networks.verus)
        .outs[0];
      expect(() =>
        readFundingOutput(output.script, output.value, system)
      ).not.toThrow();
    });
    if (count === 360) expect(changeScript.length).toBeGreaterThan(10000);
    await expect(
      fundRegistration(
        rpc,
        snapshot,
        approval.outputs,
        "10000",
        prepared.prevouts,
        owner.toAddress()
      )
    ).rejects.toThrow();
    expect(rpc.getTxOut).toHaveBeenCalledTimes(2);
    expect(() => verifyRegistrationFunding(prepared, approval)).toThrow(
      expect.objectContaining({ code: "REGISTRATION_FUNDING_MISMATCH" })
    );
    expect(() => verifyIdentityRegistrationFunding(prepared)).toThrow(
      expect.objectContaining({ code: "REGISTRATION_FUNDING_MISMATCH" })
    );
    const client = new VerusIdInterface(system, "http://unused.invalid");
    expect(() =>
      client.signIdentityRegistrationTransaction({
        transaction: prepared,
        keys: [["invalid-wif"], ["invalid-wif"]],
      })
    ).toThrow(/daemon/);
  }
);

test("a smaller mixed input set still produces exact native and reserve change", async () => {
  const { prepared, approval, rpc } = fixture(212);
  const result = await fundRegistration(
    rpc,
    snapshot,
    approval.outputs,
    "10000",
    prepared.prevouts,
    owner.toAddress()
  );
  expect(result.txHex).toBe(prepared.txHex);
  expect(verifyRegistrationFunding(result, approval)).toBe(true);
});
