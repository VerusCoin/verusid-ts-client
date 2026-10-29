// Differential fixtures pin intentional adapter policies while both verifiers
// share source binding and transaction approval. No SDK planner constructs the
// transactions or supplies the expected native amounts.
const {
  address,
  ECPair,
  networks,
  opcodes,
  script,
  TransactionBuilder,
} = require("@bitgo/utxo-lib");
const { Identity, IdentityScript } = require("verus-typescript-primitives");
const { TEST_ID_3, VERUSTEST_I_ADDR } = require("./fixtures/verusid");
const {
  verifyRegistrationFunding,
} = require("../identity/registrationFundingVerification");
const {
  createIdentityUpdateFundingApproval,
  verifyIdentityUpdateFunding,
} = require("../identity/updateFundingVerification");

const network = networks.verus;
const key = ECPair.fromPrivateKeyBuffer(Buffer.alloc(32, 62), network);
const changeKey = ECPair.fromPrivateKeyBuffer(Buffer.alloc(32, 63), network);
const recipientKey = ECPair.fromPrivateKeyBuffer(Buffer.alloc(32, 64), network);
const SYSTEM = VERUSTEST_I_ADDR;
const CHANGE = changeKey.getAddress();
const FEE = "100";
const snapshot = { systemID: SYSTEM, expiryHeight: 200 };
let nonce = 0;
const nativeOutput = (value, recipient = key.getAddress()) => ({
  script: address.toOutputScript(recipient, network),
  value,
});
const transaction = (inputs, outputs, locktime = 0) => {
  const builder = new TransactionBuilder(network);
  builder.setVersion(4);
  builder.setVersionGroupId(0x892f2085);
  builder.setExpiryHeight(snapshot.expiryHeight);
  inputs.forEach((input) => builder.addInput(input.txid, input.vout));
  outputs.forEach((output) => builder.addOutput(output.script, output.value));
  const result = builder.buildIncomplete();
  result.locktime = locktime;
  return result;
};
const source = (output, coinbase = false) => {
  const marker = Buffer.alloc(32, 0x7b);
  marker.writeUInt32LE(++nonce, 0);
  const tx = transaction([{ txid: marker.toString("hex"), vout: 0 }], [output]);
  if (coinbase) {
    tx.ins[0].hash = Buffer.alloc(32);
    tx.ins[0].index = 0xffffffff;
    tx.ins[0].script = Buffer.from("0101", "hex");
  }
  return tx;
};
const reference = (tx) => ({
  txid: tx.getId(),
  vout: 0,
  rawTransaction: tx.toHex(),
});
const p2pk = (pair) =>
  script.compile([pair.getPublicKeyBuffer(), opcodes.OP_CHECKSIG]);
const fixture = ({
  fundingScript,
  fundingAddress = key.getAddress(),
  coinbase = false,
  layout = "trailing",
  locktime = 0,
  p2pkPayment = false,
  p2pkChange = false,
} = {}) => {
  const identity = Identity.fromJson({
    ...TEST_ID_3.identity,
    primaryaddresses: [key.getAddress()],
    minimumsignatures: 1,
  });
  identity.upgradeVersion();
  const identityOutput = {
    script: IdentityScript.fromIdentity(identity).toBuffer(),
    value: 0,
  };
  const payment = nativeOutput(1000, recipientKey.getAddress());
  if (p2pkPayment) payment.script = p2pk(recipientKey);
  const planned = [identityOutput, payment];
  const firstChange = nativeOutput(layout === "split" ? 4000 : 8900, CHANGE);
  if (p2pkChange) firstChange.script = p2pk(changeKey);
  const secondChange = nativeOutput(4900, CHANGE);
  const layouts = {
    trailing: [...planned, firstChange],
    before: [firstChange, ...planned],
    middle: [identityOutput, firstChange, payment],
    split: [firstChange, identityOutput, secondChange, payment],
  };
  const outputs = layouts[layout];
  const funding = source(
    { script: fundingScript || nativeOutput(0).script, value: 10000 },
    coinbase
  );
  const definition = source(identityOutput);
  const fundingPrevout = reference(funding);
  const definitionPrevout = reference(definition);
  const updateTx = transaction(
    [fundingPrevout, definitionPrevout],
    outputs,
    locktime
  );
  const update = {
    txHex: updateTx.toHex(),
    unfundedTxHex: transaction([], planned, locktime).toHex(),
    systemId: SYSTEM,
    changeAddress: CHANGE,
    nativeFee: FEE,
    fees: { [SYSTEM]: FEE },
    explicitFees: {},
    maxFee: "1000",
    identity: {
      txid: definition.getId(),
      outputIndex: 0,
      identityAddress: identity.getIdentityAddress(),
    },
    prevouts: [
      { ...fundingPrevout, outputIndex: 0, address: fundingAddress },
      {
        ...definitionPrevout,
        outputIndex: 0,
        address: identity.getIdentityAddress(),
      },
    ],
  };
  const registrationTx = transaction([fundingPrevout], outputs, locktime);
  const registration = {
    txHex: registrationTx.toHex(),
    prevouts: [fundingPrevout],
  };
  const registrationApproval = {
    snapshot,
    nativeFee: FEE,
    changeAddress: CHANGE,
    outputs: planned.map((output, index) => ({
      role: index ? "issuer-payment" : "identity",
      value: String(output.value),
      scriptHex: output.script.toString("hex"),
      values: { [SYSTEM]: String(output.value) },
    })),
  };
  const signingInputs = [funding, definition].map((tx, index) => ({
    txid: tx.getId(),
    outputIndex: 0,
    rawTransaction: tx.toHex(),
    satoshis: tx.outs[0].value,
    script: tx.outs[0].script.toString("hex"),
    address: update.prevouts[index].address,
  }));
  return { update, registration, registrationApproval, signingInputs };
};

describe("shared funding verifier adapter policies", () => {
  test("both adapters accept ordinary P2PKH funding and one trailing change output", () => {
    const { update, registration, registrationApproval } = fixture();
    expect(verifyIdentityUpdateFunding(update)).toBe(true);
    expect(verifyRegistrationFunding(registration, registrationApproval)).toBe(
      true
    );
  });

  test.each([true, false])(
    "only updates accept canonical P2PK funding (compressed=%s)",
    (compressed) => {
      const fundingKey = ECPair.fromPrivateKeyBuffer(
        Buffer.alloc(32, 65),
        network
      );
      fundingKey.compressed = compressed;
      const { update, registration, registrationApproval } = fixture({
        fundingScript: p2pk(fundingKey),
        fundingAddress: fundingKey.getAddress(),
      });
      expect(verifyIdentityUpdateFunding(update)).toBe(true);
      expect(() =>
        verifyRegistrationFunding(registration, registrationApproval)
      ).toThrow();
      expect(() =>
        verifyIdentityUpdateFunding({
          ...update,
          prevouts: update.prevouts.map((entry, index) =>
            index ? entry : { ...entry, address: CHANGE }
          ),
        })
      ).toThrow(/indexed address/);
    }
  );

  test("both adapters reject a P2PK input with an invalid curve point", () => {
    const invalid = script.compile([
      Buffer.concat([Buffer.from([2]), Buffer.alloc(32, 0xff)]),
      opcodes.OP_CHECKSIG,
    ]);
    const { update, registration, registrationApproval } = fixture({
      fundingScript: invalid,
    });
    expect(() => verifyIdentityUpdateFunding(update)).toThrow();
    expect(() =>
      verifyRegistrationFunding(registration, registrationApproval)
    ).toThrow();
  });

  test.each(["p2pkPayment", "p2pkChange"])(
    "P2PK input support does not permit %s",
    (property) => {
      const { update, registration, registrationApproval } = fixture({
        [property]: true,
      });
      expect(() => verifyIdentityUpdateFunding(update)).toThrow();
      expect(() =>
        verifyRegistrationFunding(registration, registrationApproval)
      ).toThrow();
    }
  );

  test("update accounting permits coinbase sources; registration still rejects them", () => {
    const { update, registration, registrationApproval } = fixture({
      coinbase: true,
    });
    // Accounting acceptance does not assert maturity or current unspent state.
    expect(verifyIdentityUpdateFunding(update)).toBe(true);
    expect(() =>
      verifyRegistrationFunding(registration, registrationApproval)
    ).toThrow(/Coinbase/);
  });

  test.each(["before", "middle", "split"])(
    "only updates accept %s change placement",
    (layout) => {
      const { update, registration, registrationApproval } = fixture({
        layout,
      });
      expect(verifyIdentityUpdateFunding(update)).toBe(true);
      expect(() =>
        verifyRegistrationFunding(registration, registrationApproval)
      ).toThrow();
    }
  );

  test("an approved nonzero template locktime remains update-specific", () => {
    const { update, registration, registrationApproval } = fixture({
      locktime: 123,
    });
    expect(verifyIdentityUpdateFunding(update)).toBe(true);
    expect(() =>
      verifyRegistrationFunding(registration, registrationApproval)
    ).toThrow();
  });

  test("the internal trusted fallback creates no portable approval and cannot weaken public verification", () => {
    const { update, signingInputs } = fixture();
    const missing = signingInputs.map(({ rawTransaction, ...input }) => input);
    const { prevouts, ...intent } = update;
    expect(
      createIdentityUpdateFundingApproval(intent, missing, true)
    ).toBeUndefined();
    expect(() =>
      createIdentityUpdateFundingApproval(intent, missing, false)
    ).toThrow();
    const withoutEvidence = {
      ...update,
      prevouts: prevouts.map(({ rawTransaction, ...prevout }) => prevout),
    };
    expect(() =>
      verifyIdentityUpdateFunding(withoutEvidence, update.txHex, missing)
    ).toThrow();
    const verified = createIdentityUpdateFundingApproval(
      intent,
      signingInputs,
      false
    );
    expect(verified).toBeDefined();
    expect(Object.isFrozen(verified.prevouts[0])).toBe(true);
    // An explicit opt-out never publishes an approval, even if raw bytes happen to be present.
    expect(
      createIdentityUpdateFundingApproval(intent, signingInputs, true)
    ).toBeUndefined();
  });

  test("the public API exports the update verifier", () => {
    const publicApi = require("../index");
    expect(publicApi.verifyIdentityUpdateFunding).toBe(
      verifyIdentityUpdateFunding
    );
  });
});
