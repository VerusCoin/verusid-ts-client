import {
  CommitmentHash,
  IdentityCommitmentScript,
  IdentityID,
  KeyID,
  TxDestination,
} from "verus-typescript-primitives";
import BN from "bn.js";
import {
  crypto,
  ECPair,
  networks,
  script,
  SmartTransactionSignature,
  SmartTransactionSignatures,
  Transaction,
  TransactionBuilder,
} from "@bitgo/utxo-lib";
import {
  inspectIdentityRegistrationSignatures,
  mergeIdentityRegistrationTransactions,
  RegistrationIdentityAuthority,
  signIdentityRegistrationTransaction,
} from "../identity/registrationSigning";

const network = networks.verus;
const keys = [1, 2, 3, 4].map((number) =>
  ECPair.fromPrivateKeyBuffer(Buffer.alloc(32, number), network)
);
const authorityID = new IdentityID(Buffer.alloc(20, 17));
const controller = new TxDestination(
  new KeyID(crypto.hash160(keys[0].getPublicKeyBuffer()))
);
const authority: RegistrationIdentityAuthority = {
  identityID: authorityID.toAddress()!,
  primaryAddresses: [keys[1].getAddress(), keys[2].getAddress()],
  minimumSignatures: 2,
};

function transactionBuilder(): any {
  const builder = new TransactionBuilder(network);
  builder.setVersion(4);
  builder.setVersionGroupId(0x892f2085);
  builder.setExpiryHeight(1000);
  return builder;
}

function fixture(commitment = true, value = 10000, identity = authority) {
  const previous = transactionBuilder();
  previous.addInput("12".repeat(32), 0);
  previous.addOutput(
    commitment
      ? IdentityCommitmentScript.fromCommitment(
          new CommitmentHash({ hash: Buffer.alloc(32, 42) }),
          controller,
          new TxDestination(authorityID)
        ).toBuffer()
      : script.pubKeyHash.output.encode(
          crypto.hash160(keys[0].getPublicKeyBuffer())
        ),
    value
  );
  const source = previous.buildIncomplete();
  const spending = transactionBuilder();
  spending.addInput(source, 0);
  spending.addOutput(keys[3].getAddress(), 0);
  return {
    spending,
    args: {
      txHex: spending.buildIncomplete().toHex(),
      prevouts: [
        {
          txid: source.getId(),
          vout: 0,
          rawTransaction: source.toHex(),
          value: String(value),
          scriptHex: source.outs[0].script.toString("hex"),
        },
      ],
      identityAuthorities: [identity],
    },
  };
}

describe("local identity registration signing", () => {
  test("matches the dependency's P2PKH digest and fulfillment exactly", () => {
    const { spending, args } = fixture(false);
    spending.sign(0, keys[0], undefined, Transaction.SIGHASH_ALL, 10000);
    const signed = signIdentityRegistrationTransaction({
      ...args,
      keys: [[keys[0].toWIF()]],
    });
    expect(signed.txHex).toBe(spending.buildIncomplete().toHex());
    expect(signed.signingStatus).toBe("complete");
    expect(signed.inputs[0].requirements[0].missingSignatures).toBe(0);
  });

  test("merges controller and two identity keys on the same zero-value commitment", () => {
    const { args } = fixture(true, 0);
    const inspect = inspectIdentityRegistrationSignatures(args);
    expect(inspect.signingStatus).toBe("unsigned");
    expect(
      inspect.inputs[0].requirements.map(
        (requirement) => requirement.missingSignatures
      )
    ).toEqual([1, 2]);
    const controllerOnly = signIdentityRegistrationTransaction({
      ...args,
      keys: [[keys[0].toWIF()]],
    });
    expect(controllerOnly.signingStatus).toBe("partial");
    const authorityOnly = signIdentityRegistrationTransaction({
      ...args,
      keys: [[keys[1].toWIF(), keys[2].toWIF()]],
    });
    expect(authorityOnly.signingStatus).toBe("partial");
    const merged = mergeIdentityRegistrationTransactions({
      ...args,
      partialTransactions: [controllerOnly.txHex, authorityOnly.txHex],
    });
    expect(merged.signingStatus).toBe("complete");
    expect(
      merged.inputs[0].requirements.map(
        (requirement) => requirement.missingSignatures
      )
    ).toEqual([0, 0]);
    const transaction = Transaction.fromHex(merged.txHex, network);
    const signatures = SmartTransactionSignatures.fromChunk(
      script.decompile(transaction.ins[0].script)[0]
    );
    expect(signatures.signatures).toHaveLength(3);
    const keyHashes = signatures.signatures.map((entry: any) =>
      crypto.hash160(entry.pubKeyData).toString("hex")
    );
    expect(keyHashes).toEqual([...keyHashes].sort());
    expect(
      mergeIdentityRegistrationTransactions({
        ...args,
        txHex: merged.txHex,
        partialTransactions: [controllerOnly.txHex, merged.txHex],
      }).txHex
    ).toBe(merged.txHex);
    expect(merged.txid).toBe(transaction.getId());
    expect(merged.txid).not.toBe(
      Transaction.fromHex(args.txHex, network).getId()
    );
  });

  test("matches the dependency's first smart signature before assembling further signatures", () => {
    const { spending, args } = fixture();
    spending.sign(0, keys[0], undefined, Transaction.SIGHASH_ALL, 10000);
    const signed = signIdentityRegistrationTransaction({
      ...args,
      keys: [[keys[0].toWIF()]],
    });
    expect(signed.txHex).toBe(spending.buildIncomplete().toHex());
  });

  test("counts a shared key for both the controller and an identity condition", () => {
    const { args } = fixture(true, 0, {
      ...authority,
      primaryAddresses: [keys[0].getAddress()],
      minimumSignatures: 1,
    });
    const signed = signIdentityRegistrationTransaction({
      ...args,
      keys: [[keys[0].toWIF()]],
    });
    expect(signed.signingStatus).toBe("complete");
    expect(
      signed.inputs[0].requirements.map(
        (requirement) => requirement.signedKeyIDs
      )
    ).toEqual([[keys[0].getAddress()], [keys[0].getAddress()]]);
  });

  test("does not infer an identity's threshold or keys from its i-address", () => {
    const { args } = fixture();
    const unresolved = { ...args, identityAuthorities: [] };
    const inspected = inspectIdentityRegistrationSignatures(unresolved);
    expect(inspected.inputs[0].requirements[1]).toMatchObject({
      threshold: null,
      missingSignatures: null,
      unresolvedIdentity: true,
    });
    expect(() =>
      signIdentityRegistrationTransaction({
        ...unresolved,
        keys: [[keys[1].toWIF()]],
      })
    ).toThrow(/authority context/);
    const fullySigned = signIdentityRegistrationTransaction({
      ...args,
      keys: [[keys[0].toWIF(), keys[1].toWIF(), keys[2].toWIF()]],
    });
    expect(
      inspectIdentityRegistrationSignatures({
        ...unresolved,
        txHex: fullySigned.txHex,
      }).signingStatus
    ).toBe("partial");
  });

  test.each([
    [
      "output value",
      (tx: any) => {
        tx.outs[0].value = 1;
      },
    ],
    [
      "output script",
      (tx: any) => {
        tx.outs[0].script = script.pubKeyHash.output.encode(
          Buffer.alloc(20, 55)
        );
      },
    ],
    [
      "input",
      (tx: any) => {
        tx.ins[0].index = 1;
      },
    ],
    [
      "sequence",
      (tx: any) => {
        tx.ins[0].sequence = 42;
      },
    ],
    [
      "expiry",
      (tx: any) => {
        tx.expiryHeight += 1;
      },
    ],
    [
      "locktime",
      (tx: any) => {
        tx.locktime = 1;
      },
    ],
  ])("rejects externally changed %s", (_label, change) => {
    const { args } = fixture();
    const changed = Transaction.fromHex(args.txHex, network);
    (change as (tx: any) => void)(changed);
    expect(() =>
      mergeIdentityRegistrationTransactions({
        ...args,
        partialTransactions: [changed.toHex()],
      })
    ).toThrow(/changes the approved/);
  });

  test("binds the exact previous transaction, index, script, and native value", () => {
    const { args } = fixture();
    for (const replacement of [
      { txid: "00".repeat(32) },
      { vout: 1 },
      { rawTransaction: fixture(false).args.prevouts[0].rawTransaction },
      { scriptHex: "00" },
      { value: "10001" },
    ]) {
      expect(() =>
        inspectIdentityRegistrationSignatures({
          ...args,
          prevouts: [{ ...args.prevouts[0], ...replacement }],
        })
      ).toThrow(/prevout/i);
    }
  });

  test("rejects duplicate outpoints", () => {
    const { args } = fixture();
    const transaction = Transaction.fromHex(args.txHex, network);
    transaction.ins.push(transaction.ins[0]);
    expect(() =>
      inspectIdentityRegistrationSignatures({
        ...args,
        txHex: transaction.toHex(),
        prevouts: [args.prevouts[0], args.prevouts[0]],
      })
    ).toThrow(/duplicated/);
  });

  test("rejects foreign signing keys and invalid signatures", () => {
    const { args } = fixture();
    expect(() =>
      signIdentityRegistrationTransaction({
        ...args,
        keys: [[keys[3].toWIF()]],
      })
    ).toThrow(/Cannot prove/);
    const signed = signIdentityRegistrationTransaction({
      ...args,
      keys: [[keys[0].toWIF()]],
    });
    const transaction = Transaction.fromHex(signed.txHex, network);
    const signatures = SmartTransactionSignatures.fromChunk(
      script.decompile(transaction.ins[0].script)[0]
    );
    signatures.signatures[0].oneSignature[10] ^= 1;
    transaction.ins[0].script = script.compile([signatures.toBuffer()]);
    expect(() =>
      inspectIdentityRegistrationSignatures({
        ...args,
        txHex: transaction.toHex(),
      })
    ).toThrow(/Invalid registration input signature/);
  });

  test.each([
    Transaction.SIGHASH_NONE,
    Transaction.SIGHASH_ALL | Transaction.SIGHASH_ANYONECANPAY,
  ])("rejects smart sighash mode %s", (hashType) => {
    const { args } = fixture();
    const transaction = Transaction.fromHex(args.txHex, network);
    const previous = args.prevouts[0];
    const digest = transaction.hashForSignatureByNetwork(
      0,
      Buffer.from(previous.scriptHex, "hex"),
      10000,
      hashType,
      false
    );
    transaction.ins[0].script = script.compile([
      new SmartTransactionSignatures(1, hashType, [
        new SmartTransactionSignature(
          1,
          1,
          keys[0].getPublicKeyBuffer(),
          keys[0].sign(digest).toRSBuffer(undefined, 0)
        ),
      ]).toBuffer(),
    ]);
    expect(() =>
      inspectIdentityRegistrationSignatures({
        ...args,
        txHex: transaction.toHex(),
      })
    ).toThrow(/SIGHASH_ALL/);
  });

  test("rejects non-ALL P2PKH signatures", () => {
    const { spending, args } = fixture(false);
    spending.sign(0, keys[0], undefined, Transaction.SIGHASH_NONE, 10000);
    expect(() =>
      inspectIdentityRegistrationSignatures({
        ...args,
        txHex: spending.buildIncomplete().toHex(),
      })
    ).toThrow(/SIGHASH_ALL/);
  });

  test("rejects high-S compact signatures even though the dependency normalizes them", () => {
    const { args } = fixture();
    const signed = signIdentityRegistrationTransaction({
      ...args,
      keys: [[keys[0].toWIF()]],
    });
    const transaction = Transaction.fromHex(signed.txHex, network);
    const collection = SmartTransactionSignatures.fromChunk(
      script.decompile(transaction.ins[0].script)[0]
    );
    const compact: Buffer = collection.signatures[0].oneSignature;
    const order = new BN(
      "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
      16
    );
    order
      .sub(new BN(compact.subarray(32)))
      .toArrayLike(Buffer, "be", 32)
      .copy(compact, 32);
    transaction.ins[0].script = script.compile([collection.toBuffer()]);
    expect(() =>
      inspectIdentityRegistrationSignatures({
        ...args,
        txHex: transaction.toHex(),
      })
    ).toThrow(/low-S/);
  });

  test("rejects duplicate signatures and trailing bytes in a smart fulfillment", () => {
    const { args } = fixture();
    const signed = signIdentityRegistrationTransaction({
      ...args,
      keys: [[keys[0].toWIF()]],
    });
    const transaction = Transaction.fromHex(signed.txHex, network);
    const collection = SmartTransactionSignatures.fromChunk(
      script.decompile(transaction.ins[0].script)[0]
    );
    transaction.ins[0].script = script.compile([
      Buffer.concat([collection.toBuffer(), Buffer.from([0])]),
    ]);
    expect(() =>
      inspectIdentityRegistrationSignatures({
        ...args,
        txHex: transaction.toHex(),
      })
    ).toThrow(/canonical/);
    collection.signatures.push(collection.signatures[0]);
    transaction.ins[0].script = script.compile([collection.toBuffer()]);
    expect(() =>
      inspectIdentityRegistrationSignatures({
        ...args,
        txHex: transaction.toHex(),
      })
    ).toThrow(/Duplicate/);
  });

  test("rejects unknown consensus branches and invalid identity contexts", () => {
    const { args } = fixture();
    expect(() =>
      inspectIdentityRegistrationSignatures({
        ...args,
        network: {
          ...network,
          consensusBranchId: { ...network.consensusBranchId, 4: 1 },
        },
      })
    ).toThrow(/consensus branch/);
    expect(() =>
      inspectIdentityRegistrationSignatures({
        ...args,
        identityAuthorities: [{ ...authority, revoked: true }],
      })
    ).toThrow(/revoked/);
    expect(() =>
      inspectIdentityRegistrationSignatures({
        ...args,
        identityAuthorities: [
          {
            ...authority,
            primaryAddresses: [keys[1].getAddress(), keys[1].getAddress()],
          },
        ],
      })
    ).toThrow(/Duplicate/);
    expect(() =>
      inspectIdentityRegistrationSignatures({
        ...args,
        identityAuthorities: [{ ...authority, minimumSignatures: 3 }],
      })
    ).toThrow(/threshold/);
  });
});
