const {
  address,
  ECPair,
  networks,
  TransactionBuilder,
} = require("@bitgo/utxo-lib");
const {
  Identity,
  IdentityScript,
  TransferDestination,
  DEST_PKH,
  fromBase58Check,
} = require("verus-typescript-primitives");
const { TEST_ID_3, VERUSTEST_I_ADDR } = require("./fixtures/verusid");
const { default: VerusIdInterface } = require("../VerusIdInterface");
const {
  assertUnverifiedPrevoutsAllowed,
  readFundingPrevouts,
} = require("../identity/fundingVerification");
const {
  createIdentityUpdateFundingApproval,
} = require("../identity/updateFundingVerification");

const ERROR = "Unverified prevouts are only allowed when NODE_ENV is test.";
const network = networks.verus;
const key = ECPair.fromPrivateKeyBuffer(Buffer.alloc(32, 71), network);
const OWNER = key.getAddress();
const SYSTEM = VERUSTEST_I_ADDR;
const HEIGHT = 200;
const unsafeEnvironments = ["production", "development", undefined];

const withEnvironment = async (environment, run) => {
  const previous = process.env.NODE_ENV;
  try {
    if (environment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = environment;
    await run();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
};

const nativeOutput = (value) => ({
  value,
  script: address.toOutputScript(OWNER, network),
});
const transaction = (inputs, outputs) => {
  const builder = new TransactionBuilder(network);
  builder.setVersion(4);
  builder.setVersionGroupId(0x892f2085);
  builder.setExpiryHeight(HEIGHT + 20);
  inputs.forEach((input) => builder.addInput(input.txid, input.vout));
  outputs.forEach((output) => builder.addOutput(output.script, output.value));
  return builder.buildIncomplete();
};
const fixture = (combined = false) => {
  const identity = Identity.fromJson({
    ...TEST_ID_3.identity,
    primaryaddresses: [OWNER],
    minimumsignatures: 1,
  });
  identity.upgradeVersion();
  const definitionOutput = {
    value: 0,
    script: IdentityScript.fromIdentity(identity).toBuffer(),
  };
  const funding = transaction(
    [{ txid: "13".repeat(32), vout: 0 }],
    [nativeOutput(10000)]
  );
  const definition = transaction(
    [{ txid: "14".repeat(32), vout: 0 }],
    [definitionOutput]
  );
  const sources = [funding, definition];
  const prevouts = sources.map((source) => ({
    txid: source.getId(),
    vout: 0,
    rawTransaction: source.toHex(),
  }));
  const planned = [definitionOutput, ...(combined ? [nativeOutput(1000)] : [])];
  const outputs = [...planned, nativeOutput(combined ? 8900 : 9900)];
  const candidate = transaction(prevouts, outputs);
  const inputs = sources.map((source, index) => ({
    txid: source.getId(),
    outputIndex: 0,
    rawTransaction: source.toHex(),
    script: source.outs[0].script.toString("hex"),
    satoshis: source.outs[0].value,
    address: index ? identity.getIdentityAddress() : OWNER,
    height: 1,
    isspendable: true,
    blocktime: 1,
  }));
  const request = {
    txHex: candidate.toHex(),
    unfundedTxHex: transaction([], planned).toHex(),
    systemId: SYSTEM,
    changeAddress: OWNER,
    nativeFee: "100",
    fees: { [SYSTEM]: "100" },
    explicitFees: {},
    maxFee: "1000",
    identity: {
      txid: definition.getId(),
      outputIndex: 0,
      identityAddress: identity.getIdentityAddress(),
    },
  };
  const trustedPrevouts = inputs.map((input) => ({
    txid: input.txid,
    vout: input.outputIndex,
    script: Buffer.from(input.script, "hex"),
    value: input.satoshis,
  }));
  const rpc = jest.fn(async () => {
    throw new Error("Fixture must not call RPC");
  });
  const client = new VerusIdInterface(
    SYSTEM,
    "http://offline.invalid",
    undefined,
    rpc
  );
  const funded = transaction([prevouts[0]], outputs);
  const build = () =>
    combined
      ? client.createUpdateIdentityWithCurrencyTransferTransaction(
          identity,
          OWNER,
          definition.toHex(),
          HEIGHT - 1,
          [
            {
              currencies: { [SYSTEM]: "1000" },
              address: new TransferDestination({
                type: DEST_PKH,
                destinationBytes: fromBase58Check(OWNER).hash,
              }),
            },
          ],
          [inputs[0]],
          {
            chainIAddr: SYSTEM,
            maxFee: 0.001,
            currentHeight: HEIGHT,
            allowUnverifiedPrevouts: true,
            fundRawTransactionResult: {
              hex: funded.toHex(),
              fee: 0.000001,
              changepos: outputs.length - 1,
            },
          }
        )
      : client.createUpdateIdentityTransaction(
          identity,
          OWNER,
          definition.toHex(),
          HEIGHT - 1,
          [inputs[0]],
          SYSTEM,
          0.001,
          { hex: funded.toHex(), fee: 0.000001, changepos: outputs.length - 1 },
          HEIGHT,
          undefined,
          true,
          false,
          true
        );
  return { candidate, prevouts, inputs, request, trustedPrevouts, rpc, build };
};

describe("unverified prevouts require the explicit test environment", () => {
  test.each(unsafeEnvironments)(
    "rejects the direct opt-out in NODE_ENV=%s",
    async (environment) => {
      await withEnvironment(environment, async () => {
        expect(() => assertUnverifiedPrevoutsAllowed(true)).toThrow(ERROR);
        expect(() => assertUnverifiedPrevoutsAllowed(false)).not.toThrow();
      });
    }
  );

  test.each(unsafeEnvironments)(
    "rejects any supplied trusted fallback in NODE_ENV=%s",
    async (environment) => {
      await withEnvironment(environment, async () => {
        const f = fixture();
        for (const trustedPrevouts of [[], f.trustedPrevouts]) {
          // The guard applies even though every source already has valid raw bytes.
          expect(() =>
            readFundingPrevouts(f.candidate, f.prevouts, { trustedPrevouts })
          ).toThrow(ERROR);
        }
        expect(() =>
          readFundingPrevouts(null, null, { trustedPrevouts: [] })
        ).toThrow(ERROR);
      });
    }
  );

  test.each(unsafeEnvironments)(
    "rejects approval opt-out before mapping inputs in NODE_ENV=%s",
    async (environment) => {
      await withEnvironment(environment, async () => {
        expect(() =>
          createIdentityUpdateFundingApproval(null, null, true)
        ).toThrow(ERROR);
        const f = fixture();
        expect(() =>
          createIdentityUpdateFundingApproval(f.request, f.inputs, true)
        ).toThrow(ERROR);
      });
    }
  );

  const APIs = [
    [
      "plain update",
      (client) =>
        client.createUpdateIdentityTransaction(
          undefined,
          OWNER,
          "",
          0,
          [],
          SYSTEM,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          false,
          true
        ),
    ],
    [
      "combined update",
      (client) =>
        client.createUpdateIdentityWithCurrencyTransferTransaction(
          undefined,
          OWNER,
          "",
          0,
          [],
          [],
          { allowUnverifiedPrevouts: true }
        ),
    ],
    [
      "revoke",
      (client) =>
        client.createRevokeIdentityTransaction(
          undefined,
          OWNER,
          "",
          0,
          [],
          SYSTEM,
          undefined,
          undefined,
          undefined,
          true
        ),
    ],
    [
      "recover",
      (client) =>
        client.createRecoverIdentityTransaction(
          undefined,
          OWNER,
          "",
          0,
          [],
          SYSTEM,
          undefined,
          undefined,
          undefined,
          true
        ),
    ],
    [
      "internal funding fetch",
      (client) => client.getVerifiedFundingUtxosFromTransaction("", [], true),
    ],
  ];
  test.each(
    unsafeEnvironments.flatMap((environment) =>
      APIs.map(([name, invoke]) => [environment, name, invoke])
    )
  )(
    "NODE_ENV=%s rejects %s before parsing requests or calling RPC",
    async (environment, _name, invoke) => {
      await withEnvironment(environment, async () => {
        const rpc = jest.fn(async () => {
          throw new Error("Unexpected RPC");
        });
        const client = new VerusIdInterface(
          SYSTEM,
          "http://offline.invalid",
          undefined,
          rpc
        );
        await expect(invoke(client)).rejects.toThrow(ERROR);
        expect(rpc).not.toHaveBeenCalled();
      });
    }
  );

  test.each([...unsafeEnvironments, "test"])(
    "ordinary verified evidence remains usable in NODE_ENV=%s",
    async (environment) => {
      await withEnvironment(environment, async () => {
        const f = fixture();
        expect(
          readFundingPrevouts(f.candidate, f.prevouts).map(
            (input) => input.output.value
          )
        ).toEqual([10000, 0]);
        expect(
          readFundingPrevouts(f.candidate, f.prevouts, {
            trustedPrevouts: undefined,
          })
        ).toHaveLength(2);
        const approval = createIdentityUpdateFundingApproval(
          f.request,
          f.inputs,
          false
        );
        expect(approval).toBeDefined();
        expect(Object.isFrozen(approval)).toBe(true);
      });
    }
  );

  test("test fixtures may use fallback evidence without creating a portable approval", async () => {
    await withEnvironment("test", async () => {
      const f = fixture();
      const missing = f.prevouts.map(({ rawTransaction, ...input }) => input);
      expect(() => assertUnverifiedPrevoutsAllowed(true)).not.toThrow();
      expect(
        readFundingPrevouts(f.candidate, missing, {
          trustedPrevouts: f.trustedPrevouts,
        }).map((input) => input.output.value)
      ).toEqual([10000, 0]);
      const inputs = f.inputs.map(({ rawTransaction, ...input }) => input);
      expect(
        createIdentityUpdateFundingApproval(f.request, inputs, true)
      ).toBeUndefined();
      expect(() =>
        createIdentityUpdateFundingApproval(f.request, inputs, false)
      ).toThrow();
    });
  });

  test.each([false, true])(
    "NODE_ENV=test retains public fixture funding (combined=%s)",
    async (combined) => {
      await withEnvironment("test", async () => {
        const f = fixture(combined);
        const result = await f.build();
        expect(result.hex).toBeTruthy();
        expect(result.utxos).toHaveLength(2);
        expect(result.fundingApproval).toBeUndefined();
        expect(f.rpc).not.toHaveBeenCalled();
      });
    }
  );

  test("fails closed when the runtime has no process object", () => {
    const previous = global.process;
    const invokeWithoutProcess = (enabled) => {
      try {
        global.process = undefined;
        return assertUnverifiedPrevoutsAllowed(enabled);
      } finally {
        global.process = previous;
      }
    };
    expect(() => invokeWithoutProcess(true)).toThrow(ERROR);
    expect(() => invokeWithoutProcess(false)).not.toThrow();
    expect(global.process).toBe(previous);
  });
});
