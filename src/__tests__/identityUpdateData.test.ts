import { BN } from "bn.js";
import { Transaction, networks, smarttxs } from "@bitgo/utxo-lib";
import {
  BufferDataVdxfObject,
  ContentMultiMap,
  CrossChainDataRef,
  CrossChainDataRefKey,
  CrossChainProof,
  DataDescriptor,
  DataDescriptorKey,
  DataStringKey,
  DEST_PKH,
  EHashTypes,
  ETypes,
  EVALS,
  EvidenceData,
  FqnContentMultiMap,
  Identity,
  IdentityScript,
  IdentityUpdateRequestDetails,
  MMRDescriptor,
  MMRDescriptorKey,
  MultiPartDescriptor,
  OptCCParams,
  PartialSignData,
  PBaaSEvidenceRef,
  PubKey,
  SaplingPaymentAddress,
  SignatureData,
  SignatureDataKey,
  SmartTransactionScript,
  TxDestination,
  TransferDestination,
  UTXORef,
  VDXFDataDescriptor,
  VdxfUniValue,
  VectorUint256Key,
  fromBase58Check,
  hashData,
  getMMRRoot,
  nameAndParentAddrToIAddr,
} from "verus-typescript-primitives";
import {
  VerusIdInterface,
  verifyIdentityUpdateData,
  verifyIdentityUpdateFunding
} from "../index";
import { TEST_ID_3, VERUSTEST_I_ADDR } from "./fixtures/verusid";
import { defaultIdentityUpdateFeeCap, identityUpdateFeeCap } from "../identity/updateFundingVerification";
import { MAX_IDENTITY_UPDATE_TRANSACTION_BYTES } from "../identity/updateLimits";

const CHAIN = VERUSTEST_I_ADDR;
// The daemon reserves script overhead before splitting serialized evidence.
const CHUNK_BYTES = 5724;
const VIEWING_KEY = Buffer.alloc(32, 7);
const NOTARY_PUBLIC_KEY = Buffer.from(
  "03e1894e9d487125be5a8c6657a8ce01bc81ba7816d698dbfcfb0483754eb5a2d9",
  "hex"
);

const vdxf = (key: string, data: Buffer): Buffer =>
  new BufferDataVdxfObject(data.toString("hex"), key).toBuffer();

test("includes the daemon's storage charge in the default upload fee allowance", () => {
  const f = fixture([["storage ".repeat(1500)]]);
  const storageBytes = f.tx.outs.slice(0, -1).reduce(
    (sum: number, output: { script: Buffer }) => sum + output.script.length, 0
  );
  const cap = new BN(identityUpdateFeeCap(defaultIdentityUpdateFeeCap(f.tx.toHex())));
  expect(cap.gte(new BN(storageBytes).muln(1000).addn(100000))).toBe(true);
});

test("rejects oversized transactions before signing even without a funding approval", () => {
  const client = new VerusIdInterface(CHAIN, "https://offline.invalid");
  expect(() => client.signUpdateIdentityTransaction(
    "00".repeat(MAX_IDENTITY_UPDATE_TRANSACTION_BYTES + 1), [], []
  )).toThrow(/size limit/);
});

function evidenceBytes(proof: CrossChainProof, multipart = false): Buffer {
  // Notary header: version/type, system, null outpoint, and supporting state.
  return Buffer.concat([
    Buffer.from([1, multipart ? 2 : 3]),
    fromBase58Check(CHAIN).hash,
    Buffer.alloc(36),
    Buffer.from([2]),
    proof.toBuffer(),
  ]);
}

function evidenceOutput(bytes: Buffer): { script: Buffer; value: number } {
  const destination = new TxDestination(new PubKey(NOTARY_PUBLIC_KEY));
  const params = (evalCode: number, vData: Buffer[]) =>
    new OptCCParams({
      version: new BN(3),
      evalCode: new BN(evalCode),
      m: new BN(1),
      n: new BN(1),
      destinations: [destination],
      vData,
    });

  return {
    value: 0,
    script: new SmartTransactionScript(
      params(EVALS.EVAL_NONE, []),
      params(EVALS.EVAL_NOTARY_EVIDENCE, [bytes])
    ).toBuffer(),
  };
}

function evidenceOutputs(
  proof: CrossChainProof
): Array<{ script: Buffer; value: number }> {
  const bytes = evidenceBytes(proof);
  const single = evidenceOutput(bytes);
  const script = new SmartTransactionScript();
  script.fromBuffer(single.script);

  const conditionBytes =
    script.paramsOptCC.toChunk().length +
    1 +
    script.masterOptCC.toChunk().length;

  if (conditionBytes < 6000) return [single];

  const outputs: Array<{ script: Buffer; value: number }> = [];

  for (let start = 0; start < bytes.length; start += CHUNK_BYTES) {
    const chunk = new EvidenceData({
      version: new BN(1),
      type: new BN(ETypes.TYPE_MULTIPART_DATA),
      md: new MultiPartDescriptor({
        index: new BN(outputs.length),
        total_length: new BN(bytes.length),
        start: new BN(start),
      }),
      vdxfd: "",
      data_vec: bytes.subarray(start, start + CHUNK_BYTES),
    });

    outputs.push(
      evidenceOutput(
        evidenceBytes(new CrossChainProof({ chainObjects: [chunk] }), true)
      )
    );
  }

  return outputs;
}

/** Synthetic authenticated decryption keeps these tests independent of wallet crypto. */
function fixture(
  messages: string[][] = [["requested upload"]],
  encryptToAddress?: string
) {
  const plaintexts = new Map<string, Buffer>();
  const leaves: DataDescriptor[] = [];
  let ciphertextNumber = 0;
  let publicRecipientNumber = 0;

  const encrypt = (
    plaintext: DataDescriptor,
    publishViewingKey = false
  ): DataDescriptor => {
    const bytes = new VDXFDataDescriptor(
      plaintext,
      DataDescriptorKey.vdxfid
    ).toBuffer();

    // Model the authentication tag's size and assign a unique ciphertext ID.
    // The callback below supplies the corresponding authenticated plaintext.
    const ciphertext = Buffer.alloc(bytes.length + 16);
    ciphertext.writeUInt32LE(++ciphertextNumber);
    plaintexts.set(ciphertext.toString("hex"), bytes);

    return new DataDescriptor({
      flags: DataDescriptor.FLAG_ENCRYPTED_DATA,
      objectdata: ciphertext,
      epk: Buffer.alloc(32, ciphertextNumber),
      ...(publishViewingKey ? { ivk: Buffer.alloc(32, 7 + publicRecipientNumber++) } : {}),
    });
  };

  const keys = messages.map((_, index) =>
    nameAndParentAddrToIAddr(`upload-${index}`, CHAIN)
  );
  const request = IdentityUpdateRequestDetails.fromCLIJson(
    {
      name: TEST_ID_3.identity.name,
      parent: CHAIN,
      contentmultimap: Object.fromEntries(
        messages.map((items, index) => [
          keys[index],
          {
            data: {
              createmmr: true,
              mmrdata: items.map(message => ({ message })),
              ...(encryptToAddress
                ? { encrypttoaddress: encryptToAddress }
                : {})
            },
          }
        ])
      ),
    },
    {}
  );

  const identity = Identity.fromJson(TEST_ID_3.identity);
  identity.upgradeVersion();
  const tx = Transaction.fromHex(
    smarttxs.createUnfundedIdentityUpdate(
      identity.toBuffer().toString("hex"),
      networks.verus,
      30020
    ),
    networks.verus
  );
  tx.outs = [];

  const links: Record<string, string[]> = {};
  const groups: CrossChainProof[] = [];
  const groupIndexes: number[] = [];
  const groupLeaves: DataDescriptor[][] = [];

  for (let group = 0; group < messages.length; group++) {
    const descriptors = messages[group].map(message => {
      const encrypted = encrypt(
        new DataDescriptor({
          objectdata: Buffer.from(message),
          salt: Buffer.alloc(32, 9),
        })
      );

      leaves.push(encrypted);

      return encrypted;
    });
    groupLeaves.push(descriptors);

    let storedData: Buffer;
    if (descriptors.length === 1) {
      storedData = new VDXFDataDescriptor(
        descriptors[0],
        DataDescriptorKey.vdxfid
      ).toBuffer();
    } else {
      const leafHashes = messages[group].map(message => hashData(Buffer.concat([Buffer.from(message), Buffer.alloc(32, 9)])));
      const hashes = Buffer.concat([Buffer.from([descriptors.length]), ...leafHashes]);
      const mmr = new MMRDescriptor({
        version: new BN(1),
        objectHashType: EHashTypes.HASH_SHA256,
        mmrHashType: EHashTypes.HASH_BLAKE2BMMR,
        mmrRoot: encrypt(new DataDescriptor({ objectdata: getMMRRoot(leafHashes) })),
        mmrHashes: encrypt(
          new DataDescriptor({
            objectdata: vdxf(VectorUint256Key.vdxfid, hashes)
          })
        ),
        dataDescriptors: descriptors,
      });
      storedData = vdxf(MMRDescriptorKey.vdxfid, mmr.toBuffer());
    }

    const evidence = new EvidenceData({
      version: new BN(1),
      type: new BN(ETypes.TYPE_DATA),
      md: undefined,
      vdxfd: DataDescriptorKey.vdxfid,
      data_vec: storedData,
    });
    const proof = new CrossChainProof({ chainObjects: [evidence] });
    groups.push(proof);
    groupIndexes.push(tx.outs.length);

    // A null transaction hash refers to this transaction; n is the first
    // output of the evidence group, including when it spans several outputs.
    const ref = new CrossChainDataRef(
      new PBaaSEvidenceRef({
        flags: PBaaSEvidenceRef.FLAG_ISEVIDENCE,
        output: new UTXORef({
          hash: Buffer.alloc(32),
          n: new BN(tx.outs.length)
        }),
        objectNum: new BN(0),
        subObject: new BN(0),
      })
    );
    const link = encrypt(
      new DataDescriptor({
        objectdata: vdxf(CrossChainDataRefKey.vdxfid, ref.toBuffer()),
        ...(descriptors.length > 1 ? { mimeType: "application/json" } : {}),
      }),
      !encryptToAddress
    );
    links[keys[group]] = [
      new VDXFDataDescriptor(link, DataDescriptorKey.vdxfid)
        .toBuffer()
        .toString("hex")
    ];
    tx.outs.push(...evidenceOutputs(proof));
  }

  const replaceIdentity = () => {
    identity.contentMultiMap = ContentMultiMap.fromJson(links);
    const output = {
      value: 0,
      script: IdentityScript.fromIdentity(identity).toBuffer()
    };
    if (
      tx.outs.length &&
      tx.outs[tx.outs.length - 1].script.equals(identityOutput)
    )
      tx.outs.pop();
    tx.outs.push(output);
    identityOutput = output.script;
  };
  let identityOutput = Buffer.alloc(0);
  replaceIdentity();

  const decrypt = jest.fn(async (descriptor: DataDescriptor) => {
    const plaintext = plaintexts.get(descriptor.objectdata.toString("hex"));

    if (!plaintext) throw new Error("Authentication failed");

    return Buffer.from(plaintext);
  });

  return {
    request,
    tx,
    decrypt,
    plaintexts,
    leaves,
    groupLeaves,
    keys,
    links,
    groups,
    groupIndexes,
    replaceIdentity,
    encrypt
  };
}

type UploadFixture = ReturnType<typeof fixture>;

function assignPrivateRecipient(f: UploadFixture) {
  const [key, original] = [...f.request.signDataMap!.entries()][0];
  const data = original.toCLIJson();
  delete data.encrypttoaddress;

  // Direct property assignment does not update PartialSignData's wire flags.
  const requested = PartialSignData.fromCLIJson(data);
  requested.encryptToAddress = SaplingPaymentAddress.fromAddressString(
    TEST_ID_3.identity.privateaddress
  );
  f.request.signDataMap!.set(key, requested);

  expect(
    requested.flags.and(PartialSignData.CONTAINS_ENCRYPTTOADDRESS).isZero()
  ).toBe(true);
}

function replaceOnlyEvidenceGroup(f: UploadFixture) {
  // Mutations rebuild the evidence while retaining the identity's link output.
  const identityOutput = f.tx.outs[f.tx.outs.length - 1];
  f.tx.outs = [...evidenceOutputs(f.groups[0]), identityOutput];
}

function replaceSingleLeaf(f: UploadFixture, plaintext: DataDescriptor) {
  f.leaves[0] = f.encrypt(plaintext);
  f.groups[0].chainObjects[0].data_vec = new VDXFDataDescriptor(
    f.leaves[0],
    DataDescriptorKey.vdxfid
  ).toBuffer();
  replaceOnlyEvidenceGroup(f);
}

function addSignature(
  f: UploadFixture,
  change?: (signature: SignatureData) => void
) {
  const [key, original] = [...f.request.signDataMap!.entries()][0];
  const signer = TEST_ID_3.identity.identityaddress;
  f.request.signDataMap!.set(
    key,
    PartialSignData.fromCLIJson({
      ...original.toCLIJson(),
      address: signer,
    })
  );

  // Only signature metadata and its size are verified here, not the signature's validity.
  const signature = new SignatureData({
    version: new BN(1),
    systemID: CHAIN,
    hashType: new BN(
      f.groupLeaves[0].length > 1
        ? EHashTypes.HASH_BLAKE2BMMR
        : EHashTypes.HASH_SHA256
    ),
    signatureHash: Buffer.alloc(32, f.groupLeaves[0].length > 1 ? 0 : 4),
    identityID: signer,
    sigType: new BN(1),
    vdxfKeys: (original.vdxfKeys || []).map(value => value.toAddress()!),
    vdxfKeyNames: (original.vdxfKeyNames || []).map(value =>
      value.toString("utf8").toLowerCase()
    ),
    boundHashes: (original.boundHashes || []).map(value => Buffer.from(value)),
    signatureAsVch: Buffer.alloc(65, 8),
  });
  change?.(signature);
  const encrypted = f.encrypt(
    new DataDescriptor({ objectdata: signature.toBuffer() })
  );
  f.groups[0].chainObjects.push(
    new EvidenceData({
      version: new BN(1),
      type: new BN(ETypes.TYPE_DATA),
      md: undefined,
      vdxfd: SignatureDataKey.vdxfid,
      data_vec: vdxf(SignatureDataKey.vdxfid, encrypted.toBuffer()),
    })
  );

  const ref = new CrossChainDataRef(
    new PBaaSEvidenceRef({
      flags: PBaaSEvidenceRef.FLAG_ISEVIDENCE,
      output: new UTXORef({ hash: Buffer.alloc(32), n: new BN(0) }),
      objectNum: new BN(0),
      subObject: new BN(1),
    })
  );
  const link = f.encrypt(
    new DataDescriptor({
      objectdata: vdxf(CrossChainDataRefKey.vdxfid, ref.toBuffer()),
      label: "signature",
      mimeType: "application/json",
    }),
    true
  );

  // Signed uploads concatenate data and signature links in one CMM value.
  f.links[f.keys[0]][0] += new VDXFDataDescriptor(
    link,
    DataDescriptorKey.vdxfid
  )
    .toBuffer()
    .toString("hex");
  replaceOnlyEvidenceGroup(f);
  f.replaceIdentity();
}

describe("identity upload evidence verification", () => {
  test("binds a single uploaded message and passes the link viewing key to the wallet callback", async () => {
    const f = fixture();

    await expect(
      verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)
    ).resolves.toBe(true);
    expect(f.decrypt).toHaveBeenCalledTimes(2);
    expect(
      f.decrypt.mock.calls.every(([descriptor]) =>
        descriptor.ivk.equals(VIEWING_KEY)
      )
    ).toBe(true);
    expect(
      f.decrypt.mock.calls.every(([descriptor]) => descriptor.hasIVK())
    ).toBe(true);
    expect((f.decrypt.mock.calls[0] as any)[1]).toMatchObject({
      contentKey: f.keys[0]
    });
  });

  test("passes the requested private recipient to the wallet without publishing viewing keys", async () => {
    const encryptToAddress = TEST_ID_3.identity.privateaddress;
    const f = fixture([["private upload"]], encryptToAddress);

    await expect(
      verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)
    ).resolves.toBe(true);

    expect(f.decrypt).toHaveBeenCalledTimes(2);
    for (const call of f.decrypt.mock.calls) {
      expect(call[0].hasIVK()).toBe(false);
      expect(call[0].hasSSK()).toBe(false);
      expect((call as any)[1]).toEqual({
        contentKey: f.keys[0],
        encryptToAddress
      });
    }
  });

  test("retains a private recipient assigned after request construction", async () => {
    const encryptToAddress = TEST_ID_3.identity.privateaddress;
    const f = fixture([["private upload"]], encryptToAddress);
    assignPrivateRecipient(f);

    await expect(
      verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)
    ).resolves.toBe(true);

    for (const call of f.decrypt.mock.calls) {
      expect(call[0].hasIVK()).toBe(false);
      expect((call as any)[1]).toEqual({
        contentKey: f.keys[0],
        encryptToAddress
      });
    }
  });

  test.each(["ivk", "ssk"] as const)(
    "rejects an unexpected %s published in an evidence descriptor",
    async field => {
      const f = fixture();
      f.leaves[0][field] = Buffer.alloc(32, 5);
      f.groups[0].chainObjects[0].data_vec = new VDXFDataDescriptor(
        f.leaves[0],
        DataDescriptorKey.vdxfid
      ).toBuffer();
      f.tx.outs[0] = evidenceOutputs(f.groups[0])[0];

      await expect(
        verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)
      ).rejects.toThrow();
    }
  );

  test.each([
    "missing public IVK",
    "published private IVK",
    "published public SSK",
    "published private SSK"
  ])("rejects a link with %s", async kind => {
    const privateUpload = kind.includes("private");
    const f = fixture(
      [["requested upload"]],
      privateUpload ? TEST_ID_3.identity.privateaddress : undefined
    );
    const link = new VDXFDataDescriptor();
    link.fromBuffer(Buffer.from(f.links[f.keys[0]][0], "hex"));
    if (kind === "missing public IVK") delete (link.dataDescriptor as any).ivk;
    else if (kind === "published private IVK")
      link.dataDescriptor.ivk = Buffer.from(VIEWING_KEY);
    else link.dataDescriptor.ssk = Buffer.alloc(32, 6);
    f.links[f.keys[0]][0] = link.toBuffer().toString("hex");
    f.replaceIdentity();

    await expect(
      verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)
    ).rejects.toThrow();
  });

  test("binds separate content keys and MMR leaves to the requested item count and order", async () => {
    const f = fixture([["first", "second"], ["third"]]);

    await expect(
      verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)
    ).resolves.toBe(true);
  });

  test.each(["message", "messagehex", "messagebase64"])(
    "matches the decoded bytes of a %s request",
    async encoding => {
      const f = fixture([["unicode upload: café 🚀"]]);
      const [key] = [...f.request.signDataMap!.entries()][0];
      const data = Buffer.from("unicode upload: café 🚀");
      const encoded =
        encoding === "messagehex"
          ? data.toString("hex")
          : encoding === "messagebase64"
          ? data.toString("base64")
          : data.toString("utf8");
      f.request.signDataMap!.set(
        key,
        PartialSignData.fromCLIJson({
          [encoding]: encoded,
          createmmr: true,
        } as any)
      );

      await expect(
        verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)
      ).resolves.toBe(true);
    }
  );

  test("checks an explicitly requested MMR salt", async () => {
    const f = fixture([["first", "second"]]);
    const requested = [...f.request.signDataMap!.entries()][0][1];
    const mmr = requested.data as any;
    mmr.salt = [Buffer.alloc(32, 9), Buffer.alloc(32, 9)];
    mmr.flags = mmr.flags.or(new BN(1));

    await expect(
      verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)
    ).resolves.toBe(true);

    mmr.salt[0][0] ^= 1;

    await expect(
      verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)
    ).rejects.toThrow(/salt/);
  });

  test.each([DataStringKey.vdxfid, DataStringKey.qualifiedname.name])(
    "matches daemon VDXF bytes for the requested key %s",
    async contentKey => {
      const f = fixture();
      const [key] = [...f.request.signDataMap!.entries()][0];
      const value = { [contentKey]: "typed upload" };
      f.request.signDataMap!.set(
        key,
        PartialSignData.fromCLIJson({ vdxfdata: value, createmmr: true })
      );
      replaceSingleLeaf(
        f,
        new DataDescriptor({
          objectdata: VdxfUniValue.fromJson(value).toBuffer(),
          salt: Buffer.alloc(32, 9),
        })
      );

      await expect(
        verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)
      ).resolves.toBe(true);
    }
  );

  test("binds a hash-only MMR leaf to its requested hash", async () => {
    const f = fixture([["hash placeholder", "second"]]);
    const [key] = [...f.request.signDataMap!.entries()][0];
    const expectedHash = Buffer.alloc(32, 3);
    f.request.signDataMap!.set(
      key,
      PartialSignData.fromCLIJson({
        createmmr: true,
        mmrdata: [
          { datahash: expectedHash.toString("hex") },
          { message: "second" }
        ],
      })
    );

    const taggedMMR = new BufferDataVdxfObject();
    taggedMMR.fromBuffer(f.groups[0].chainObjects[0].data_vec);
    const mmr = new MMRDescriptor();
    mmr.fromBuffer(taggedMMR.toDataBuffer());
    mmr.dataDescriptors[0] = f.encrypt(
      new DataDescriptor({ objectdata: Buffer.alloc(0) })
    );
    mmr.mmrHashes = f.encrypt(
      new DataDescriptor({
        objectdata: vdxf(
          VectorUint256Key.vdxfid,
          Buffer.concat([
            Buffer.from([2]),
            expectedHash,
            hashData(Buffer.concat([Buffer.from("second"), Buffer.alloc(32, 9)])),
          ])
        ),
      })
    );
    mmr.mmrRoot = f.encrypt(new DataDescriptor({objectdata: getMMRRoot([expectedHash,
      hashData(Buffer.concat([Buffer.from("second"), Buffer.alloc(32, 9)]))])}));
    f.groups[0].chainObjects[0].data_vec = vdxf(
      MMRDescriptorKey.vdxfid,
      mmr.toBuffer()
    );
    replaceOnlyEvidenceGroup(f);

    await expect(
      verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)
    ).resolves.toBe(true);
    const requested = [...f.request.signDataMap!.entries()][0][1];
    (requested.data as any).data[0].data[0] ^= 1;

    await expect(
      verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)
    ).rejects.toThrow(/hash/);
  });

  test.each(["filename", "single hash"])(
    "fails closed for an unverifiable %s upload",
    async kind => {
      const f = fixture();
      const [key] = [...f.request.signDataMap!.entries()][0];
      const input =
        kind === "filename"
          ? { filename: "/server-only/upload.bin" }
          : { datahash: "03".repeat(32) };
      f.request.signDataMap!.set(
        key,
        PartialSignData.fromCLIJson({ ...input, createmmr: true })
      );
      if (kind === "single hash")
        replaceSingleLeaf(
          f,
          new DataDescriptor({ objectdata: Buffer.alloc(0) })
        );

      await expect(
        verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)
      ).rejects.toThrow(/filename|hash-only/);
    }
  );

  test.each([1, 2])("rejects data signatures before decrypting %i items", async count => {
    const f = fixture([Array.from({length: count}, (_, index) => `item ${index}`)]);
    addSignature(f);
    await expect(verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)).rejects.toThrow(/signature|signer/i);
    expect(f.decrypt).not.toHaveBeenCalled();
  });

  test("rejects a signer assigned without updating serialization flags", async () => {
    const f = fixture();
    const requested = [...f.request.signDataMap!.entries()][0][1];
    requested.address = PartialSignData.fromCLIJson({message: "x", address: TEST_ID_3.identity.identityaddress}).address;
    expect(requested.flags.and(PartialSignData.CONTAINS_ADDRESS).isZero()).toBe(true);
    await expect(verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)).rejects.toThrow(/signature|signer/i);
    expect(f.decrypt).not.toHaveBeenCalled();
  });

  test.each(["zero", "reused"])("rejects a %s encryption EPK", async kind => {
    const f = fixture();
    const encoded = new VDXFDataDescriptor();
    encoded.fromBuffer(Buffer.from(f.links[f.keys[0]][0], "hex"));
    f.leaves[0].epk = kind === "zero" ? Buffer.alloc(32) : encoded.dataDescriptor.epk;
    f.groups[0].chainObjects[0].data_vec = new VDXFDataDescriptor(f.leaves[0], DataDescriptorKey.vdxfid).toBuffer();
    replaceOnlyEvidenceGroup(f);
    await expect(verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)).rejects.toThrow(/encrypted/);
  });

  test("binds evidence to the configured chain", async () => {
    const f = fixture();
    await expect(verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt, TEST_ID_3.identity.identityaddress))
      .rejects.toThrow(/systems/);
    expect(f.decrypt).not.toHaveBeenCalled();
  });

  test("rejects reuse of a public viewing key across content keys", async () => {
    const f = fixture([["one"], ["two"]]);
    const first = new VDXFDataDescriptor();
    const second = new VDXFDataDescriptor();
    first.fromBuffer(Buffer.from(f.links[f.keys[0]][0], "hex"));
    second.fromBuffer(Buffer.from(f.links[f.keys[1]][0], "hex"));
    second.dataDescriptor.ivk = first.dataDescriptor.ivk;
    f.links[f.keys[1]][0] = second.toBuffer().toString("hex");
    f.replaceIdentity();
    await expect(verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)).rejects.toThrow(/viewing keys/);
  });

  test.each(["root", "leaf hash"])("rejects a corrupted MMR %s despite valid plaintext", async kind => {
    const f = fixture([["first", "second", "third"]]);
    const taggedMMR = new BufferDataVdxfObject();
    taggedMMR.fromBuffer(f.groups[0].chainObjects[0].data_vec);
    const mmr = new MMRDescriptor();
    mmr.fromBuffer(taggedMMR.toDataBuffer());
    const descriptor = kind === "root" ? mmr.mmrRoot : mmr.mmrHashes;
    const key = descriptor.objectdata.toString("hex");
    const plain = new VDXFDataDescriptor();
    plain.fromBuffer(f.plaintexts.get(key)!);
    plain.dataDescriptor.objectdata[plain.dataDescriptor.objectdata.length - 1] ^= 1;
    f.plaintexts.set(key, plain.toBuffer());
    await expect(verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)).rejects.toThrow(/MMR.*(root|hash)/);
  });

  test("retains requested bytes while an asynchronous wallet callback is pending", async () => {
    const f = fixture();
    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      resume = resolve;
    });
    const decrypt = async (descriptor: DataDescriptor) => {
      entered();
      await gate;

      return f.decrypt(descriptor);
    };

    const verification = verifyIdentityUpdateData(
      f.request,
      f.tx.toHex(),
      decrypt
    );
    await started;

    // Mutate the caller's request after verification has retained its copy.
    const upload = [...f.request.signDataMap!.entries()][0][1];
    (upload.data as any).data[0].data[0] ^= 1;
    resume();

    await expect(verification).resolves.toBe(true);
  });

  test("accepts a requested upload split across canonical daemon multipart outputs", async () => {
    const f = fixture([["large upload ".repeat(1300)]]);
    expect(f.tx.outs.length).toBeGreaterThan(3);

    await expect(
      verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)
    ).resolves.toBe(true);
  });

  test("rejects needless multipart encoding of evidence that fits in one output", async () => {
    const f = fixture();
    const bytes = evidenceBytes(f.groups[0]);
    const chunk = new EvidenceData({
      version: new BN(1),
      type: new BN(ETypes.TYPE_MULTIPART_DATA),
      vdxfd: "",
      md: new MultiPartDescriptor({
        index: new BN(0),
        total_length: new BN(bytes.length),
        start: new BN(0)
      }),
      data_vec: bytes,
    });
    f.tx.outs[0] = evidenceOutput(
      evidenceBytes(new CrossChainProof({ chainObjects: [chunk] }), true)
    );

    await expect(
      verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)
    ).rejects.toThrow(/multipart/);
  });

  test("rejects splitting a large upload into more outputs than the daemon needs", async () => {
    const f = fixture([["large upload ".repeat(1300)]]);
    const bytes = evidenceBytes(f.groups[0]);
    const parts = [];
    for (let start = 0; start < bytes.length; start += 1000) {
      const chunk = new EvidenceData({
        version: new BN(1),
        type: new BN(ETypes.TYPE_MULTIPART_DATA),
        vdxfd: "",
        md: new MultiPartDescriptor({
          index: new BN(start / 1000),
          total_length: new BN(bytes.length),
          start: new BN(start),
        }),
        data_vec: bytes.subarray(start, start + 1000),
      });
      parts.push(
        evidenceOutput(
          evidenceBytes(new CrossChainProof({ chainObjects: [chunk] }), true)
        )
      );
    }
    f.tx.outs = [...parts, f.tx.outs[f.tx.outs.length - 1]];

    await expect(
      verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)
    ).rejects.toThrow(/chunk length/);
  });

  test("splits precisely at the daemon's 6,000-byte condition boundary", async () => {
    const conditionSize = (f: UploadFixture) => {
      const script = new SmartTransactionScript();
      script.fromBuffer(evidenceOutput(evidenceBytes(f.groups[0])).script);

      return script.paramsOptCC.toChunk().length +
        1 +
        script.masterOptCC.toChunk().length;
    };
    const sample = fixture([["a".repeat(5000)]]);
    const largestSingle = 5000 + 5999 - conditionSize(sample);
    const below = fixture([["a".repeat(largestSingle)]]);
    expect(conditionSize(below)).toBe(5999);
    expect(below.tx.outs).toHaveLength(2);

    await expect(
      verifyIdentityUpdateData(below.request, below.tx.toHex(), below.decrypt)
    ).resolves.toBe(true);

    const boundary = fixture([["a".repeat(largestSingle + 1)]]);
    expect(conditionSize(boundary)).toBe(6000);
    expect(boundary.tx.outs).toHaveLength(3);

    await expect(
      verifyIdentityUpdateData(
        boundary.request,
        boundary.tx.toHex(),
        boundary.decrypt
      )
    ).resolves.toBe(true);

    boundary.tx.outs = [
      evidenceOutput(evidenceBytes(boundary.groups[0])),
      boundary.tx.outs[2]
    ];

    await expect(
      verifyIdentityUpdateData(
        boundary.request,
        boundary.tx.toHex(),
        boundary.decrypt
      )
    ).rejects.toThrow(/size limit/);
  });

  test("rejects additional unreferenced evidence outputs before funding", async () => {
    const f = fixture();
    f.tx.outs.splice(1, 0, f.tx.outs[0]);

    await expect(
      verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)
    ).rejects.toThrow();
  });

  test("rejects missing evidence and missing requested CMM links", async () => {
    const missingEvidence = fixture();
    missingEvidence.tx.outs.shift();

    await expect(
      verifyIdentityUpdateData(
        missingEvidence.request,
        missingEvidence.tx.toHex(),
        missingEvidence.decrypt
      )
    ).rejects.toThrow();

    const missingLink = fixture();
    delete missingLink.links[missingLink.keys[0]];
    missingLink.replaceIdentity();

    await expect(
      verifyIdentityUpdateData(
        missingLink.request,
        missingLink.tx.toHex(),
        missingLink.decrypt
      )
    ).rejects.toThrow();
  });

  test("rejects extra returned links under a requested upload key", async () => {
    const f = fixture();
    f.links[f.keys[0]].push(f.links[f.keys[0]][0]);
    f.replaceIdentity();

    await expect(
      verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)
    ).rejects.toThrow();
  });

  test("rejects authenticated plaintext that differs by one byte from the upload", async () => {
    const f = fixture();
    const key = f.leaves[0].objectdata.toString("hex");
    const plaintext = new VDXFDataDescriptor();
    plaintext.fromBuffer(f.plaintexts.get(key)!);
    plaintext.dataDescriptor.objectdata[0] ^= 1;
    f.plaintexts.set(key, plaintext.toBuffer());

    await expect(
      verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)
    ).rejects.toThrow();
  });

  test("rejects reversed plaintext MMR leaves", async () => {
    const f = fixture([["first", "second"]]);
    const [first, second] = f.leaves.map(leaf =>
      leaf.objectdata.toString("hex")
    );
    const firstBytes = f.plaintexts.get(first)!;
    f.plaintexts.set(first, f.plaintexts.get(second)!);
    f.plaintexts.set(second, firstBytes);

    await expect(
      verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)
    ).rejects.toThrow();
  });

  test("rejects a different requested MMR item count", async () => {
    const f = fixture([["first", "second"]]);
    const requested = [...f.request.signDataMap!.entries()][0][1];
    (requested.data as any).data.pop();

    await expect(
      verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)
    ).rejects.toThrow();
  });

  test.each([
    "missing callback",
    "authentication error",
    "malformed plaintext",
    "trailing plaintext"
  ])("fails closed for %s", async kind => {
    const f = fixture();
    let decrypt: any = f.decrypt;
    if (kind === "missing callback") decrypt = undefined;
    if (kind === "authentication error")
      decrypt = async () => {
        throw new Error("Authentication failed");
      };
    if (kind === "malformed plaintext")
      decrypt = async () => Buffer.from("invalid plaintext");
    if (kind === "trailing plaintext")
      decrypt = async (descriptor: DataDescriptor) =>
        Buffer.concat([await f.decrypt(descriptor), Buffer.from([0])]);

    await expect(
      verifyIdentityUpdateData(f.request, f.tx.toHex(), decrypt)
    ).rejects.toThrow();
  });

  test.each(["reordered parts", "missing part", "repeated part"])(
    "rejects multipart evidence with %s",
    async kind => {
      const f = fixture([["large upload ".repeat(1300)]]);
      if (kind === "reordered parts")
        [f.tx.outs[0], f.tx.outs[1]] = [f.tx.outs[1], f.tx.outs[0]];
      if (kind === "missing part") f.tx.outs.splice(1, 1);
      if (kind === "repeated part") f.tx.outs.splice(1, 0, f.tx.outs[0]);

      await expect(
        verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)
      ).rejects.toThrow();
    }
  );

  test("rejects trailing padding in serialized evidence", async () => {
    const f = fixture();
    const script = new SmartTransactionScript();
    script.fromBuffer(f.tx.outs[0].script);
    script.paramsOptCC.vData[0] = Buffer.concat([
      script.paramsOptCC.vData[0],
      Buffer.from([0])
    ]);
    f.tx.outs[0].script = script.toBuffer();

    await expect(
      verifyIdentityUpdateData(f.request, f.tx.toHex(), f.decrypt)
    ).rejects.toThrow();
  });
});

function builderFixture(
  mode: "plain" | "combined",
  messages = [["requested upload"]],
  encryptToAddress?: string,
  parseVdxfObjects = false
) {
  const f = fixture(messages, encryptToAddress);
  const changeAddress = TEST_ID_3.identity.primaryaddresses[0];
  const recipient = new TransferDestination({
    type: DEST_PKH,
    destinationBytes: fromBase58Check(changeAddress).hash,
  });
  const payment = (amount: string) => ({
    currencies: { [CHAIN]: amount },
    address: recipient
  });
  const paymentTransaction = (amount: string) =>
    Transaction.fromHex(
      VerusIdInterface.createUnfundedCurrencyTransferTransaction(
        CHAIN,
        [payment(amount)],
        30020
      ),
      networks.verus
    );

  const fundingSource = paymentTransaction("10000000");
  fundingSource.addInput(Buffer.alloc(32, 31), 0);
  const oldIdentity = Identity.fromJson(TEST_ID_3.identity);
  const identitySource = Transaction.fromHex(
    smarttxs.createUnfundedIdentityUpdate(
      oldIdentity.toBuffer().toString("hex"),
      networks.verus,
      30000
    ),
    networks.verus
  );
  identitySource.addInput(Buffer.alloc(32, 32), 0);

  const utxos = [
    {
      txid: fundingSource.getId(),
      outputIndex: 0,
      address: changeAddress,
      script: fundingSource.outs[0].script.toString("hex"),
      satoshis: 10000000,
      height: 29900,
      isspendable: true,
      blocktime: 1,
    }
  ];

  const funding = { changePosition: undefined as number | undefined };
  const rpc = jest.fn(async (request: any) => {
    if (request.method === "fundrawtransaction") {
      const funded = Transaction.fromHex(request.params[0], networks.verus);
      funded.addInput(Buffer.from(fundingSource.getId(), "hex").reverse(), 0);
      const spent = funded.outs.reduce(
        (total: number, output: any) => total + output.value,
        0
      );
      let changepos = funded.outs.length;

      // Return all remaining native value after the fixed test miner fee.
      funded.outs.push(
        ...paymentTransaction(String(10000000 - spent - 10000)).outs
      );

      if (funding.changePosition !== undefined) {
        const change = funded.outs.pop()!;
        changepos = funding.changePosition;
        funded.outs.splice(changepos, 0, change);
      }

      return {
        result: { hex: funded.toHex(), fee: 0.0001, changepos },
        error: null,
        id: request.id
      };
    }
    if (
      request.method === "getrawtransaction" &&
      request.params[0] === fundingSource.getId()
    ) {
      return { result: fundingSource.toHex(), error: null, id: request.id };
    }
    throw new Error(`Unexpected RPC ${request.method}`);
  });
  const client = new VerusIdInterface(
    CHAIN,
    "http://offline.invalid",
    undefined,
    rpc
  );
  const build = (decryptData: typeof f.decrypt | undefined = f.decrypt) =>
    mode === "plain"
      ? client.createUpdateIdentityTransaction(
          f.request,
          changeAddress,
          identitySource.toHex(),
          29999,
          utxos,
          CHAIN,
          undefined,
          undefined,
          30000,
          f.tx.toHex(),
          parseVdxfObjects,
          true,
          false,
          decryptData
        )
      : client.createUpdateIdentityWithCurrencyTransferTransaction(
          f.request,
          changeAddress,
          identitySource.toHex(),
          29999,
          [payment("50000")],
          utxos,
          {
            chainIAddr: CHAIN,
            currentHeight: 30000,
            updateIdentityTransactionHex: f.tx.toHex(),
            parseVdxfObjects,
            isTestnet: true,
            decryptData
          }
        );

  return { ...f, build, rpc, funding };
}

function ordinaryContentFixture(
  mode: "plain" | "combined",
  parseVdxfObjects: boolean,
  includeEmptyValue = false
) {
  const f = builderFixture(mode, undefined, undefined, parseVdxfObjects);
  const values = [
    "ab",
    { [DataStringKey.vdxfid]: "approved data" },
    ...(includeEmptyValue ? [""] : []),
  ];

  // Replace the upload with ordinary CMM content, retaining its exact bytes.
  f.request.identity!.contentMultiMap = FqnContentMultiMap.fromJson({
    [CHAIN]: values,
  });
  f.request.flags = f.request.flags!.xor(
    IdentityUpdateRequestDetails.IDENTITY_UPDATE_REQUEST_CONTAINS_SIGNDATA
  );
  f.request.signDataMap = undefined;
  f.tx.outs = [f.tx.outs[f.tx.outs.length - 1]];
  delete f.links[f.keys[0]];
  f.links[CHAIN] = values.map(value =>
    typeof value === "string"
      ? value
      : VdxfUniValue.fromJson(value).toBuffer().toString("hex")
  );
  f.replaceIdentity();

  return f;
}

describe.each(["plain", "combined"] as const)(
  "%s upload builder validation",
  mode => {
    test("verifies the requested upload before funding and preserves dynamic fee sizing", async () => {
      const f = builderFixture(mode, [["large upload ".repeat(1300)]]);
      const result = await f.build();

      expect(result.fundingApproval).toBeDefined();
      expect(Number(result.fundingApproval!.maxFee)).toBeGreaterThan(100000);
      expect(
        verifyIdentityUpdateFunding(
          result.fundingApproval!,
          result.hex,
          result.utxos
        )
      ).toBe(true);
      expect(
        f.rpc.mock.calls.filter(
          ([request]) => request.method === "fundrawtransaction"
        )
      ).toHaveLength(1);
      expect(f.decrypt.mock.invocationCallOrder[0]).toBeLessThan(
        f.rpc.mock.invocationCallOrder[0]
      );
    });

    test("rejects uploads without a decryption callback before making any RPC call", async () => {
      const f = builderFixture(mode);

      await expect(f.build(null as any)).rejects.toThrow(/decryption callback/);
      expect(f.rpc).not.toHaveBeenCalled();
    });

    test("funds private evidence when the recipient was assigned after construction", async () => {
      const encryptToAddress = TEST_ID_3.identity.privateaddress;
      const f = builderFixture(mode, [["private upload"]], encryptToAddress);
      assignPrivateRecipient(f);

      const result = await f.build();

      expect(result.fundingApproval).toBeDefined();
      for (const call of f.decrypt.mock.calls) {
        expect(call[0].hasIVK()).toBe(false);
        expect((call as any)[1].encryptToAddress).toBe(encryptToAddress);
      }
      expect(
        f.rpc.mock.calls.filter(
          ([request]) => request.method === "fundrawtransaction"
        )
      ).toHaveLength(1);
    });

    test("rejects public evidence for a directly assigned private recipient before funding", async () => {
      const f = builderFixture(mode);
      assignPrivateRecipient(f);

      await expect(f.build()).rejects.toThrow(/encrypted|private|upload/);

      expect(f.decrypt).not.toHaveBeenCalled();
      expect(f.rpc).not.toHaveBeenCalled();
    });

    test.each([false, true])(
      "preserves requested raw, VDXF, and empty CMM values with parsing=%s",
      async parseVdxfObjects => {
        const f = ordinaryContentFixture(mode, parseVdxfObjects, true);

        const result = await f.build();
        const funded = Transaction.fromHex(result.hex, networks.verus);
        const script = new IdentityScript();
        script.fromBuffer(funded.outs[0].script);
        const values = script.getIdentity().contentMultiMap.kvContent
          .getByAddress(CHAIN)!;

        expect(values.map(value => (value as Buffer).toString("hex")))
          .toEqual(f.links[CHAIN]);
        expect(result.fundingApproval).toBeDefined();
        expect(f.decrypt).not.toHaveBeenCalled();
      }
    );

    test.each([
      ["empty values", false],
      ["empty values", true],
      ["VDXF version padding", false],
      ["VDXF version padding", true],
    ] as const)(
      "rejects unrequested CMM %s before funding with parsing=%s",
      async (padding, parseVdxfObjects) => {
        const f = ordinaryContentFixture(mode, parseVdxfObjects);

        if (padding === "empty values") {
          f.links[CHAIN].push(...Array(3000).fill(""));
        } else {
          const original = Buffer.from(f.links[CHAIN][1], "hex");
          // Parsed VDXF JSON discards this oversized outer version varint.
          f.links[CHAIN][1] = Buffer.concat([
            original.subarray(0, 20),
            Buffer.alloc(3000, 0x80),
            Buffer.from([0]),
            original.subarray(21),
          ]).toString("hex");
        }
        f.replaceIdentity();

        await expect(f.build()).rejects.toThrow(/content|multimap|CMM/i);

        expect(f.rpc).not.toHaveBeenCalled();
        expect(f.decrypt).not.toHaveBeenCalled();
      }
    );

    test.each(["before evidence", "between multipart chunks"] as const)(
      "rejects funding change inserted %s",
      async placement => {
        const f = builderFixture(
          mode,
          placement === "between multipart chunks"
            ? [["large upload ".repeat(1300)]]
            : undefined
        );
        f.funding.changePosition = placement === "before evidence" ? 0 : 1;

        await expect(f.build()).rejects.toThrow(/evidence|position|index/i);
      }
    );

    test("accepts change after all evidence and before the identity", async () => {
      const f = builderFixture(mode, [["large upload ".repeat(1300)]]);
      f.funding.changePosition = f.tx.outs.length - 1;

      const result = await f.build();
      const funded = Transaction.fromHex(result.hex, networks.verus);

      // Moving the identity leaves every local evidence reference unchanged.
      for (let index = 0; index < f.funding.changePosition; index++) {
        expect(funded.outs[index].script.equals(f.tx.outs[index].script))
          .toBe(true);
      }
      expect(
        verifyIdentityUpdateFunding(
          result.fundingApproval!,
          result.hex,
          result.utxos
        )
      ).toBe(true);
    });

    test("rejects the 1,000-output fee inflation attack before funding", async () => {
      const f = builderFixture(mode);
      f.tx.outs.splice(
        1,
        0,
        ...Array.from({ length: 1000 }, () => f.tx.outs[0])
      );

      await expect(f.build()).rejects.toThrow(/evidence|upload/);
      expect(f.rpc).not.toHaveBeenCalled();
    });
  }
);
