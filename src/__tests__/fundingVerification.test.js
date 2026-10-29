const {
  address,
  ECPair,
  networks,
  Transaction,
  TransactionBuilder,
} = require("@bitgo/utxo-lib");
const {
  readFundingPrevouts,
  verifyFundingTransaction,
} = require("../identity/fundingVerification");

const network = networks.verus;
const key = ECPair.fromPrivateKeyBuffer(Buffer.alloc(32, 61), network);
const outputScript = address.toOutputScript(key.getAddress(), network);
let nonce = 0;

const transaction = (inputs, values = [7000, 9000]) => {
  const builder = new TransactionBuilder(network);
  builder.setVersion(4);
  builder.setVersionGroupId(0x892f2085);
  builder.setExpiryHeight(200);
  inputs.forEach((input) => builder.addInput(input.txid, input.vout));
  values.forEach((value) => builder.addOutput(outputScript, value));
  return builder.buildIncomplete();
};
const fixture = ({ coinbase = false, sharedSource = false } = {}) => {
  const marker = Buffer.alloc(32, 0x6a);
  marker.writeUInt32LE(++nonce, 0);
  const source = transaction([{ txid: marker.toString("hex"), vout: 0 }]);
  if (coinbase) {
    source.ins[0].hash = Buffer.alloc(32);
    source.ins[0].index = 0xffffffff;
    source.ins[0].script = Buffer.from("0101", "hex");
  }
  const prevouts = (sharedSource ? [0, 1] : [1]).map((vout) => ({
    txid: source.getId(),
    vout,
    rawTransaction: source.toHex(),
    address: key.getAddress(),
  }));
  const candidate = transaction(prevouts, [1000]);
  const funded = { txHex: candidate.toHex(), prevouts };
  return { source, prevouts, candidate, funded };
};
const copyPrevouts = (entries) => entries.map((entry) => ({ ...entry }));
const parse = (hex) => Transaction.fromHex(hex, network);

describe("shared funding transaction approval boundary", () => {
  test("permits only input-script changes without attempting signature verification", () => {
    const { candidate, funded } = fixture();
    candidate.ins[0].script = Buffer.from("0101", "hex");
    const verified = verifyFundingTransaction(funded, candidate.toHex());
    expect(verified.toHex()).toBe(candidate.toHex());
    expect(verified.ins[0].script.toString("hex")).toBe("0101");
    expect(parse(funded.txHex).ins[0].script.length).toBe(0);
  });

  test("retains approved nonzero locktime and expiry instead of imposing an adapter policy", () => {
    const { candidate, funded } = fixture();
    candidate.locktime = 123;
    candidate.expiryHeight = 456;
    funded.txHex = candidate.toHex();
    const verified = verifyFundingTransaction(funded, candidate.toHex());
    expect(verified.locktime).toBe(123);
    expect(verified.expiryHeight).toBe(456);
  });

  test.each([
    [
      "locktime",
      (tx) => {
        tx.locktime++;
      },
    ],
    [
      "expiry",
      (tx) => {
        tx.expiryHeight++;
      },
    ],
    [
      "input transaction",
      (tx) => {
        tx.ins[0].hash[0] ^= 1;
      },
    ],
    [
      "input index",
      (tx) => {
        tx.ins[0].index++;
      },
    ],
    [
      "input sequence",
      (tx) => {
        tx.ins[0].sequence--;
      },
    ],
    [
      "output value",
      (tx) => {
        tx.outs[0].value++;
      },
    ],
    [
      "output script",
      (tx) => {
        tx.outs[0].script = Buffer.from("51", "hex");
      },
    ],
    [
      "extra output",
      (tx) => {
        tx.outs.push({ ...tx.outs[0] });
      },
    ],
  ])("rejects a candidate with changed %s", (_label, mutate) => {
    const { candidate, funded } = fixture();
    mutate(candidate);
    expect(() => verifyFundingTransaction(funded, candidate.toHex())).toThrow(
      /changed after approval/
    );
  });

  test("rejects an already signed approval even if the candidate is identical", () => {
    const { candidate, funded } = fixture();
    candidate.ins[0].script = Buffer.from("0101", "hex");
    funded.txHex = candidate.toHex();
    expect(() => verifyFundingTransaction(funded, candidate.toHex())).toThrow();
  });

  test.each([
    [
      "non-Sapling version",
      (tx) => {
        tx.version = 3;
        tx.versionGroupId = 0x03c48270;
      },
    ],
    [
      "incorrect version group",
      (tx) => {
        tx.versionGroupId = 0x03c48270;
      },
    ],
    [
      "coinbase candidate",
      (tx) => {
        tx.ins[0].hash = Buffer.alloc(32);
        tx.ins[0].index = 0xffffffff;
      },
    ],
  ])(
    "rejects unsupported %s even when the approval has matching bytes",
    (_label, mutate) => {
      const { candidate, funded } = fixture();
      expect(() => {
        mutate(candidate);
        funded.txHex = candidate.toHex();
        verifyFundingTransaction(funded, funded.txHex);
      }).toThrow();
    }
  );

  test("rejects a nonzero shielded balance in the wire bytes", () => {
    const { funded } = fixture();
    const bytes = Buffer.from(funded.txHex, "hex");
    // Transparent Sapling ends with valueBalance (8 bytes), then three zero
    // vector counts. BitGo's serializer always writes zero valueBalance, so
    // change the actual wire bytes instead of a normalized object property.
    expect(bytes.subarray(-11).equals(Buffer.alloc(11))).toBe(true);
    bytes[bytes.length - 11] = 1;
    const hex = bytes.toString("hex");
    expect(() =>
      verifyFundingTransaction({ ...funded, txHex: hex }, hex)
    ).toThrow();
  });

  test.each(["not-hex", "00"])(
    "rejects malformed candidate bytes %s",
    (bytes) => {
      expect(() => verifyFundingTransaction(fixture().funded, bytes)).toThrow();
    }
  );

  test("rejects trailing bytes on either candidate or approval", () => {
    const { funded } = fixture();
    expect(() =>
      verifyFundingTransaction(funded, funded.txHex + "00")
    ).toThrow();
    expect(() =>
      verifyFundingTransaction(
        { ...funded, txHex: funded.txHex + "00" },
        funded.txHex
      )
    ).toThrow();
  });
});

describe("shared raw funding evidence", () => {
  test("resolves distinct outputs of one source in candidate order", () => {
    const { source, prevouts, candidate } = fixture({ sharedSource: true });
    candidate.ins.reverse();
    prevouts.reverse();
    const decoded = readFundingPrevouts(candidate, prevouts);
    expect(decoded.map((item) => item.vout)).toEqual([1, 0]);
    expect(decoded.map((item) => item.output.value)).toEqual([9000, 7000]);
    decoded.forEach((item) => {
      expect(item.address).toBe(key.getAddress());
      expect(item.output.script.equals(source.outs[item.vout].script)).toBe(
        true
      );
    });
  });

  test("uses source output bytes rather than additional cached amount/script fields", () => {
    const { prevouts, candidate } = fixture();
    const decoded = readFundingPrevouts(
      candidate,
      prevouts.map((item) => ({
        ...item,
        value: "1",
        values: {},
        scriptHex: "00",
      }))
    );
    expect(decoded[0].output.value).toBe(9000);
    expect(decoded[0].output.script.equals(outputScript)).toBe(true);
  });

  test.each([
    [
      "wrong transaction ID",
      (f, entries) => {
        entries[0].txid = "ab".repeat(32);
      },
    ],
    [
      "wrong output index",
      (f, entries) => {
        entries[0].vout = 0;
      },
    ],
    [
      "missing evidence",
      (f, entries) => {
        entries.length = 0;
      },
    ],
    [
      "extra evidence",
      (f, entries) => {
        entries.push({ ...entries[0] });
      },
    ],
    [
      "missing raw source",
      (f, entries) => {
        delete entries[0].rawTransaction;
      },
    ],
    [
      "empty raw source",
      (f, entries) => {
        entries[0].rawTransaction = "";
      },
    ],
    [
      "malformed raw source",
      (f, entries) => {
        entries[0].rawTransaction = "00";
      },
    ],
    [
      "trailing source bytes",
      (f, entries) => {
        entries[0].rawTransaction += "00";
      },
    ],
    [
      "forged source value",
      (f, entries) => {
        f.source.outs[1].value++;
        entries[0].rawTransaction = f.source.toHex();
      },
    ],
    [
      "out-of-range index",
      (f, entries) => {
        f.candidate.ins[0].index = 99;
        entries[0].vout = 99;
      },
    ],
    [
      "nonfinal sequence",
      (f) => {
        f.candidate.ins[0].sequence = 1;
      },
    ],
  ])("rejects %s", (_label, mutate) => {
    const f = fixture();
    const entries = copyPrevouts(f.prevouts);
    mutate(f, entries);
    expect(() => readFundingPrevouts(f.candidate, entries)).toThrow();
  });

  test("rejects duplicated outpoints rather than counting the same funds twice", () => {
    const { prevouts, candidate } = fixture();
    candidate.ins.push({ ...candidate.ins[0] });
    expect(() =>
      readFundingPrevouts(candidate, [...prevouts, { ...prevouts[0] }])
    ).toThrow(/Duplicate/);
  });

  test("rejects conflicting source bytes for two outputs claiming the same source", () => {
    const { prevouts, candidate, source } = fixture({ sharedSource: true });
    source.outs[1].value++;
    prevouts[1].rawTransaction = source.toHex();
    expect(() => readFundingPrevouts(candidate, prevouts)).toThrow();
  });

  test("rejects coinbase sources by default and accepts them only by explicit adapter policy", () => {
    const { prevouts, candidate } = fixture({ coinbase: true });
    expect(() => readFundingPrevouts(candidate, prevouts)).toThrow();
    expect(
      readFundingPrevouts(candidate, prevouts, { allowCoinbase: true })[0]
        .output.value
    ).toBe(9000);
  });

  test("allows explicitly trusted metadata only when raw evidence is missing", () => {
    const { prevouts, candidate } = fixture();
    const missing = prevouts.map((item) => ({ ...item, rawTransaction: "" }));
    const trustedPrevouts = prevouts.map((item) => ({
      txid: item.txid,
      vout: item.vout,
      script: outputScript,
      value: 9000,
    }));
    expect(() => readFundingPrevouts(candidate, missing)).toThrow();
    expect(
      readFundingPrevouts(candidate, missing, { trustedPrevouts })[0].output
        .value
    ).toBe(9000);
    expect(() =>
      readFundingPrevouts(candidate, missing, {
        trustedPrevouts: [{ ...trustedPrevouts[0], vout: 0 }],
      })
    ).toThrow();
    const malformed = prevouts.map((item) => ({
      ...item,
      rawTransaction: "00",
    }));
    expect(() =>
      readFundingPrevouts(candidate, malformed, { trustedPrevouts })
    ).toThrow();
    // Supplied raw evidence remains authoritative even when the fallback differs.
    expect(
      readFundingPrevouts(candidate, prevouts, {
        trustedPrevouts: [{ ...trustedPrevouts[0], value: 1 }],
      })[0].output.value
    ).toBe(9000);
  });
});
