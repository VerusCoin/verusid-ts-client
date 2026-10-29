import { BN } from "bn.js";
import { createCipheriv, createDecipheriv, createHash } from "crypto";
import { Transaction, networks, smarttxs } from "@bitgo/utxo-lib";
import {
  BufferDataVdxfObject,
  ContentMultiMap,
  CrossChainDataRef,
  DATA_TYPE_BASE64,
  DATA_TYPE_RAWSTRINGDATA,
  DATA_TYPE_VDXFDATA,
  DataByteKey,
  DataByteVectorKey,
  DataDescriptor,
  DataDescriptorKey,
  DataStringKey,
  FqnContentMultiMap,
  FqnVdxfUniValue,
  HASH_TYPE_KECCAK256,
  Identity,
  IdentityScript,
  IdentityUpdateRequestDetails,
  MMRDescriptor,
  PartialMMRData,
  PartialSignData,
  PBaaSEvidenceRef,
  SaplingPaymentAddress,
  SmartTransactionScript,
  VdxfUniValue,
  VectorUint256Key,
  fromBase58Check,
  getMMRRoot,
  hashData,
  nameAndParentAddrToIAddr,
} from "verus-typescript-primitives";
import {
  buildLocalIdentityUpdateData,
  captureLocalIdentityUploadCrypto,
  LocalIdentityUploadCrypto,
  MAX_LOCAL_IDENTITY_UPLOAD_BYTES,
} from "../identity/localUpdateData";
import { readIdentityUpdateEvidence } from "../identity/updateDataEvidence";
import { verifyIdentityUpdateData } from "../identity/updateDataVerification";
import { TEST_ID_3, VERUSTEST_I_ADDR } from "./fixtures/verusid";

const CHAIN = VERUSTEST_I_ADDR;
const PUBLIC = require("./fixtures/local-upload/public-recipient.json");
const SALT = Buffer.alloc(32, 0x19);
const COMMITMENTS: any[] = require("./fixtures/local-upload/commitments.json");

function requestFor(data: any[] = [{ message: "private upload bytes" }]) {
  return IdentityUpdateRequestDetails.fromCLIJson({
    name: TEST_ID_3.identity.name,
    parent: CHAIN,
    contentmultimap: Object.fromEntries(
      data.map((value, index) => [
        nameAndParentAddrToIAddr(`local-upload-${index}`, CHAIN),
        { data: { createmmr: true, ...value } },
      ])
    ),
  });
}

/**
 * Unit-test authenticated cipher, not a Sapling implementation. The temporary
 * key map models the wallet's external-recipient verification boundary.
 */
function wallet() {
  let sequence = 0;
  let recipients = 0;
  const keys = new Map<string, Buffer>();
  const plaintexts: Buffer[] = [];
  const encrypt = jest.fn(async (plaintext: Buffer, _address: string) => {
    const epk = createHash("sha256")
      .update(`epk-${++sequence}`)
      .digest();
    const key = createHash("sha256").update(`test-key-${sequence}`).digest();
    const cipher = createCipheriv("chacha20-poly1305", key, Buffer.alloc(12));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const ciphertext = Buffer.concat([body, cipher.getAuthTag()]);
    keys.set(epk.toString("hex") + ciphertext.toString("hex"), key);
    plaintexts.push(Buffer.from(plaintext));
    return { epk, ciphertext };
  });
  const decryptData = jest.fn(async (descriptor: DataDescriptor) => {
    const key = keys.get(
      descriptor.epk.toString("hex") + descriptor.objectdata.toString("hex")
    );
    if (!key) throw new Error("Authentication failed");
    const decipher = createDecipheriv(
      "chacha20-poly1305",
      key,
      Buffer.alloc(12)
    );
    decipher.setAuthTag(descriptor.objectdata.subarray(-16));
    return Buffer.concat([
      decipher.update(descriptor.objectdata.subarray(0, -16)),
      decipher.final(),
    ]);
  });
  const crypto: LocalIdentityUploadCrypto = {
    randomBytes: jest.fn(async () => Buffer.from(SALT)),
    encrypt,
    decryptData,
    createPublicRecipient: jest.fn(async () => {
      if (++recipients === 1)
        return { address: PUBLIC.address, ivk: Buffer.from(PUBLIC.ivk, "hex") };
      const recipient = SaplingPaymentAddress.fromAddressString(PUBLIC.address);
      recipient.pkD = createHash("sha256")
        .update(`public-${recipients}`)
        .digest();
      return {
        address: recipient.toAddressString(),
        ivk: createHash("sha256").update(`ivk-${recipients}`).digest(),
      };
    }),
  };
  return { crypto, plaintexts, keys };
}

function decode<T extends { fromBuffer(bytes: Buffer): number }>(
  object: T,
  bytes: Buffer
): T {
  expect(object.fromBuffer(bytes)).toBe(bytes.length);
  return object;
}

function untag(bytes: Buffer): Buffer {
  return decode(new BufferDataVdxfObject(), bytes).toDataBuffer();
}

async function template(
  request: IdentityUpdateRequestDetails,
  crypto = wallet().crypto
) {
  const result = await buildLocalIdentityUpdateData({
    request,
    chainId: CHAIN,
    crypto,
  });
  const identity = Identity.fromJson(TEST_ID_3.identity);
  identity.upgradeVersion();
  identity.contentMultiMap = ContentMultiMap.fromJson(
    Object.fromEntries(
      [...result.contentMultiMap].map(([key, values]) => [
        key.toIAddress(),
        values.map((value) => value.toString("hex")),
      ])
    )
  );
  const tx = Transaction.fromHex(
    smarttxs.createUnfundedIdentityUpdate(
      identity.toBuffer().toString("hex"),
      networks.verus,
      30020
    ),
    networks.verus
  );
  tx.outs = [
    ...result.outputs,
    { value: 0, script: IdentityScript.fromIdentity(identity).toBuffer() },
  ];
  return { result, tx, crypto };
}

describe("local identity upload assembly", () => {
  it.each(COMMITMENTS)(
    "matches live daemon descriptor bytes: $name",
    async (fixture) => {
      const w = wallet();
      await buildLocalIdentityUpdateData({
        request: requestFor([fixture.request]),
        chainId: CHAIN,
        crypto: w.crypto,
      });
      const mmr = fixture.result.mmrdescriptor;
      const expected = mmr.datadescriptors.map((descriptor: any) =>
        DataDescriptor.fromJson(descriptor).toBuffer()
      );
      if (expected.length > 1) {
        expected.push(DataDescriptor.fromJson(mmr.mmrroot).toBuffer());
        expected.push(DataDescriptor.fromJson(mmr.mmrhashes).toBuffer());
      }
      expect(w.plaintexts.slice(0, expected.length).map(untag)).toEqual(
        expected
      );
    }
  );

  it.each([1, 2, 3, 7])(
    "verifies public uploads with %i ordered leaves",
    async (count) => {
      const request = requestFor([
        {
          mmrdata: Array.from({ length: count }, (_, n) => ({
            message: `leaf-${n}`,
          })),
          mmrsalt: Array.from({ length: count }, () => SALT.toString("hex")),
        },
      ]);
      const f = await template(request);
      await expect(
        verifyIdentityUpdateData(request, f.tx.toHex(), f.crypto.decryptData)
      ).resolves.toBe(true);
      expect(f.crypto.randomBytes).not.toHaveBeenCalled();
      expect(f.crypto.encrypt).toHaveBeenCalledTimes(
        count + 1 + (count > 1 ? 2 : 0)
      );
      for (const output of f.result.outputs) expect(output.value).toBe(0);
    }
  );

  it.each([
    ["sha256", "blake2b", 5, 1],
    ["sha256D", "sha256", 4, 5],
    ["blake2b", "sha256D", 1, 4],
  ])(
    "commits mixed bytes/hash-only leaves with %s and %s",
    async (objectName, mmrName, objectType, mmrType) => {
      const suppliedHash = Buffer.from(Array.from({ length: 32 }, (_, n) => n));
      const request = requestFor([
        {
          hashtype: objectName,
          mmrhashtype: mmrName,
          mmrdata: [
            { message: "a" },
            { datahash: suppliedHash.toString("hex") },
            { message: "b" },
          ],
          mmrsalt: [SALT, SALT, SALT].map((salt) => salt.toString("hex")),
        },
      ]);
      const f = await template(request);
      await expect(
        verifyIdentityUpdateData(request, f.tx.toHex(), f.crypto.decryptData)
      ).resolves.toBe(true);
      const group = readIdentityUpdateEvidence(f.result.outputs).get(0)!;
      const mmr = decode(
        new MMRDescriptor(),
        untag(group.proof.chainObjects[0].data_vec)
      );
      const root = decode(
        new DataDescriptor(),
        untag(await f.crypto.decryptData(mmr.mmrRoot, { contentKey: "" }))
      );
      const hashes = [
        hashData(Buffer.concat([Buffer.from("a"), SALT]), objectType as number),
        objectType === 5 ? suppliedHash : Buffer.from(suppliedHash).reverse(),
        hashData(Buffer.concat([Buffer.from("b"), SALT]), objectType as number),
      ];
      expect(root.objectdata).toEqual(getMMRRoot(hashes, mmrType as number));
    }
  );

  it("serializes ordinary VDXF bytes and preserves explicit binary payloads", async () => {
    const value = { [DataStringKey.vdxfid]: "typed VDXF" };
    const request = requestFor([
      { mmrdata: [{ vdxfdata: value }, { serializedhex: "ff000180" }] },
    ]);
    const w = wallet();
    const f = await template(request, w.crypto);
    await expect(
      verifyIdentityUpdateData(request, f.tx.toHex(), w.crypto.decryptData)
    ).resolves.toBe(true);
    const plains = w.plaintexts.map((bytes) =>
      decode(new DataDescriptor(), untag(bytes))
    );
    expect(plains[0].objectdata).toEqual(
      VdxfUniValue.fromJson(value).toBuffer()
    );
    expect(plains[1].objectdata).toEqual(Buffer.from("ff000180", "hex"));
  });

  it.each([false, true])(
    "preserves binary-only VDXF byte vectors (MMR: %s)",
    async (mmr) => {
      const value = { [DataByteVectorKey.vdxfid]: "ff000180" };
      const request = requestFor([
        mmr ? { mmrdata: [{ vdxfdata: value }] } : { vdxfdata: value },
      ]);
      const upload = [...request.signDataMap!.entries()][0][1];
      // The new JSON contract deliberately refuses to drop the vector wrapper.
      expect(() => upload.toCLIJson()).toThrow(/byte-vector wrapper/);
      const w = wallet();
      const f = await template(request, w.crypto);
      expect(
        decode(new DataDescriptor(), untag(w.plaintexts[0])).objectdata
      ).toEqual(VdxfUniValue.fromDaemonJson(value).toBuffer());
      await expect(
        verifyIdentityUpdateData(request, f.tx.toHex(), w.crypto.decryptData)
      ).resolves.toBe(true);
    }
  );

  it("preserves typed nested descriptors whose metadata requires binary serialization", async () => {
    const nested = new DataDescriptor({
      objectdata: Buffer.from("ff000180", "hex"),
      vdxfKey: DataByteVectorKey.vdxfid,
      label: "binary metadata",
    });
    const value = new VdxfUniValue({
      values: [{ [DataDescriptorKey.vdxfid]: nested }],
    });
    expect(() => value.toDaemonJson()).toThrow(/drops vdxfkey/);
    const request = requestFor();
    const upload = [...request.signDataMap!.entries()][0][1];
    upload.dataType = DATA_TYPE_VDXFDATA.clone();
    upload.data = FqnVdxfUniValue.fromVdxfUniValue(value);
    const w = wallet();
    const f = await template(request, w.crypto);
    expect(
      decode(new DataDescriptor(), untag(w.plaintexts[0])).objectdata
    ).toEqual(value.toBuffer());
    await expect(
      verifyIdentityUpdateData(request, f.tx.toHex(), w.crypto.decryptData)
    ).resolves.toBe(true);
  });

  it("uses numeric daemon byte JSON without converting its value to text", async () => {
    const request = requestFor([{ vdxfdata: { [DataByteKey.vdxfid]: 255 } }]);
    const w = wallet();
    const f = await template(request, w.crypto);
    expect(
      decode(new DataDescriptor(), untag(w.plaintexts[0])).objectdata
    ).toEqual(Buffer.from([255]));
    await expect(
      verifyIdentityUpdateData(request, f.tx.toHex(), w.crypto.decryptData)
    ).resolves.toBe(true);
  });

  it.each([DATA_TYPE_BASE64, DATA_TYPE_RAWSTRINGDATA])(
    "preserves decoded local MMR bytes for request-envelope type %s",
    async (type) => {
      const request = requestFor([{ mmrdata: [{ message: "placeholder" }] }]);
      const upload = [...request.signDataMap!.entries()][0][1];
      const bytes = Buffer.from("ff008001", "hex");
      (upload.data as PartialMMRData).data[0] = { type, data: bytes };
      expect(() => upload.toCLIJson()).toThrow(/serializedhex/);
      const w = wallet();
      const f = await template(request, w.crypto);
      expect(
        decode(new DataDescriptor(), untag(w.plaintexts[0])).objectdata
      ).toEqual(bytes);
      await expect(
        verifyIdentityUpdateData(request, f.tx.toHex(), w.crypto.decryptData)
      ).resolves.toBe(true);
    }
  );

  it.each([
    "trailing hashes",
    "truncated hashes",
    "wrong version",
    "wrong tag",
  ])("rejects an authenticated MMR hash vector with %s", async (kind) => {
    const request = requestFor([
      { mmrdata: [{ message: "first" }, { message: "second" }] },
    ]);
    const w = wallet();
    const encrypt = w.crypto.encrypt;
    w.crypto.encrypt = async (bytes, recipient) => {
      const descriptor = decode(new DataDescriptor(), untag(bytes));
      if (
        descriptor.objectdata
          .subarray(0, 20)
          .equals(fromBase58Check(VectorUint256Key.vdxfid).hash)
      ) {
        const vector = decode(
          new BufferDataVdxfObject(),
          descriptor.objectdata
        );
        const hashes = vector.toDataBuffer();
        if (kind === "trailing hashes") hashes[0] = 1;
        if (kind === "truncated hashes") hashes[0] = 3;
        const changed = new BufferDataVdxfObject(
          hashes.toString("hex"),
          kind === "wrong tag" ? DataStringKey.vdxfid : VectorUint256Key.vdxfid
        );
        if (kind === "wrong version") changed.version = new BN(2);
        descriptor.objectdata = changed.toBuffer();
        bytes = new BufferDataVdxfObject(
          descriptor.toBuffer().toString("hex"),
          DataDescriptorKey.vdxfid
        ).toBuffer();
      }
      return encrypt(bytes, recipient);
    };
    const f = await template(request, w.crypto);
    await expect(
      verifyIdentityUpdateData(request, f.tx.toHex(), w.crypto.decryptData)
    ).rejects.toThrow(/hash vector|Unexpected identity upload data type/);
  });

  it("keeps external-recipient keys private and authenticates every descriptor", async () => {
    const request = requestFor([
      { message: "external", encrypttoaddress: PUBLIC.address },
    ]);
    const w = wallet();
    delete w.crypto.createPublicRecipient;
    const f = await template(request, w.crypto);
    const link = decode(
      new DataDescriptor(),
      untag([...f.result.contentMultiMap.values()][0][0])
    );
    expect(link.ivk?.length || 0).toBe(0);
    expect(link.ssk?.length || 0).toBe(0);
    for (const key of w.keys.values())
      expect(f.tx.toHex()).not.toContain(key.toString("hex"));
    await expect(
      verifyIdentityUpdateData(request, f.tx.toHex(), w.crypto.decryptData)
    ).resolves.toBe(true);
    expect(w.crypto.decryptData).toHaveBeenCalledTimes(2);
    w.keys.clear();
    await expect(
      verifyIdentityUpdateData(request, f.tx.toHex(), w.crypto.decryptData)
    ).rejects.toThrow("Authentication");
  });

  it("orders uint160 content keys and uses absolute first-output positions", async () => {
    const request = requestFor([
      { message: "a" },
      { message: "b" },
      { message: "c" },
    ]);
    const w = wallet();
    const result = await buildLocalIdentityUpdateData({
      request,
      chainId: CHAIN,
      crypto: w.crypto,
      firstOutputIndex: 4,
    });
    const keys = [...result.contentMultiMap.keys()].map(
      (key) => fromBase58Check(key.toIAddress()).hash
    );
    expect(keys).toEqual([...keys].sort(Buffer.compare));
    for (const [index, [, values]] of [...result.contentMultiMap].entries()) {
      const outer = decode(new DataDescriptor(), untag(values[0]));
      expect(outer.ivk.length).toBe(32);
      const plain = decode(
        new DataDescriptor(),
        untag(await w.crypto.decryptData(outer, { contentKey: "" }))
      );
      const ref = decode(new CrossChainDataRef(), untag(plain.objectdata))
        .ref as PBaaSEvidenceRef;
      expect(ref.output.n.toNumber()).toBe(4 + index);
      expect(ref.output.hash).toEqual(Buffer.alloc(32));
      expect(ref.objectNum.isZero() && ref.subObject.isZero()).toBe(true);
    }
  });

  it("splits encrypted evidence, retains one logical leaf, and rejects corruption", async () => {
    const request = requestFor([
      { messagehex: Buffer.alloc(12000, 0x45).toString("hex") },
    ]);
    const f = await template(request);
    expect(f.result.outputs.length).toBe(3);
    expect(f.crypto.encrypt).toHaveBeenCalledTimes(2);
    const groups = readIdentityUpdateEvidence(f.result.outputs);
    expect(groups.size).toBe(1);
    await expect(
      verifyIdentityUpdateData(request, f.tx.toHex(), f.crypto.decryptData)
    ).resolves.toBe(true);
    expect(() =>
      readIdentityUpdateEvidence([
        f.result.outputs[1],
        f.result.outputs[0],
        f.result.outputs[2],
      ])
    ).toThrow();
    expect(() =>
      readIdentityUpdateEvidence(f.result.outputs.slice(0, 2))
    ).toThrow();
  });

  it("splits at the strict 6000-byte condition boundary", async () => {
    const small = await template(
      requestFor([{ messagehex: Buffer.alloc(5000).toString("hex") }])
    );
    const smart = decode(
      new SmartTransactionScript(),
      small.result.outputs[0].script
    );
    const condition =
      smart.paramsOptCC.toChunk().length +
      1 +
      smart.masterOptCC.toChunk().length;
    const belowBytes = 5000 + 5999 - condition;
    const below = await template(
      requestFor([{ messagehex: Buffer.alloc(belowBytes).toString("hex") }])
    );
    const atRequest = requestFor([
      { messagehex: Buffer.alloc(belowBytes + 1).toString("hex") },
    ]);
    const at = await template(atRequest);
    expect(below.result.outputs).toHaveLength(1);
    expect(at.result.outputs).toHaveLength(2);
    await expect(
      verifyIdentityUpdateData(atRequest, at.tx.toHex(), at.crypto.decryptData)
    ).resolves.toBe(true);
  });

  it("captures methods on class adapters without cloning wallet private state", async () => {
    const w = wallet();
    class WalletAdapter implements LocalIdentityUploadCrypto {
      #crypto = w.crypto;
      randomBytes(length: number) {
        return this.#crypto.randomBytes(length);
      }
      encrypt(bytes: Buffer, address: string) {
        return this.#crypto.encrypt(bytes, address);
      }
      createPublicRecipient() {
        return this.#crypto.createPublicRecipient!();
      }
      decryptData(descriptor: DataDescriptor, context: any) {
        return this.#crypto.decryptData(descriptor, context);
      }
    }
    const adapter = new WalletAdapter();
    const captured = captureLocalIdentityUploadCrypto(adapter);
    adapter.encrypt = () => {
      throw new Error("mutated callback");
    };
    const request = requestFor();
    const f = await template(request, captured);
    await expect(
      verifyIdentityUpdateData(request, f.tx.toHex(), captured.decryptData)
    ).resolves.toBe(true);
  });

  it("rejects ordinary content sharing an upload key before callbacks", async () => {
    const request = requestFor();
    const contentKey = [...request.signDataMap!.entries()][0][0].toIAddress();
    request.identity!.contentMultiMap = FqnContentMultiMap.fromJson({
      [contentKey]: "abcd",
    });
    const w = wallet();
    await expect(
      buildLocalIdentityUpdateData({
        request,
        chainId: CHAIN,
        crypto: w.crypto,
      })
    ).rejects.toThrow("ordinary content");
    expect(w.crypto.encrypt).not.toHaveBeenCalled();
    expect(w.crypto.createPublicRecipient).not.toHaveBeenCalled();
  });

  it.each([
    [
      "signer",
      (upload: any) => {
        upload.address = {};
      },
    ],
    [
      "prior signature",
      (upload: any) => {
        upload.signature = Buffer.alloc(0);
      },
    ],
    [
      "signature flag",
      (upload: any) => {
        upload.flags = upload.flags.or(new BN(8));
      },
    ],
    [
      "missing recipient",
      (upload: any) => {
        upload.flags = upload.flags.or(new BN(4));
      },
    ],
    [
      "signature binding",
      (upload: any) => {
        upload.prefixString = Buffer.alloc(0);
      },
    ],
    [
      "unsupported hash",
      (upload: any) => {
        upload.hashType = HASH_TYPE_KECCAK256;
      },
    ],
    [
      "false createmmr",
      (upload: any) => {
        upload.createMMR = false;
      },
    ],
    [
      "non-boolean createmmr",
      (upload: any) => {
        upload.createMMR = "true";
      },
    ],
    [
      "metadata",
      (upload: any) => {
        upload.label = "unsupported";
      },
    ],
    [
      "prior MMR",
      (upload: any) => {
        upload.data.priormmr = [];
      },
    ],
    [
      "item metadata",
      (upload: any) => {
        upload.data.data[0].label = "ignored";
      },
    ],
    [
      "short salt",
      (upload: any) => {
        upload.data.salt = [Buffer.alloc(31)];
      },
    ],
    [
      "too many salts",
      (upload: any) => {
        upload.data.salt = [SALT, SALT];
      },
    ],
    [
      "MMR unknown option",
      (upload: any) => {
        upload.data.extra = true;
      },
    ],
    [
      "invalid recipient",
      (upload: any) => {
        upload.encryptToAddress = new SaplingPaymentAddress({
          d: Buffer.alloc(10),
          pkD: Buffer.alloc(32, 1),
        });
      },
    ],
  ])("rejects %s before callbacks", async (_label, change) => {
    const request = requestFor([{ mmrdata: [{ message: "valid" }] }]);
    change([...request.signDataMap!.entries()][0][1]);
    const w = wallet();
    await expect(
      buildLocalIdentityUpdateData({
        request,
        chainId: CHAIN,
        crypto: w.crypto,
      })
    ).rejects.toThrow();
    expect(w.crypto.encrypt).not.toHaveBeenCalled();
    expect(w.crypto.randomBytes).not.toHaveBeenCalled();
    expect(w.crypto.createPublicRecipient).not.toHaveBeenCalled();
  });

  it.each(
    [
      [{ filename: "/never-read-this-file" }],
      [{ messagehex: "" }],
      [{ mmrdata: [] }],
      [{ datahash: "01".repeat(32) }],
      [{ messagehex: "01".repeat(MAX_LOCAL_IDENTITY_UPLOAD_BYTES + 1) }],
      [{ message: "x".repeat(7000) }, { message: "y".repeat(7000) }],
    ].map((data) => ({ data }))
  )(
    "rejects invalid data and multipart combinations before callbacks",
    async ({ data }) => {
      const request = requestFor(data);
      const w = wallet();
      await expect(
        buildLocalIdentityUpdateData({
          request,
          chainId: CHAIN,
          crypto: w.crypto,
        })
      ).rejects.toThrow();
      expect(w.crypto.encrypt).not.toHaveBeenCalled();
      expect(w.crypto.createPublicRecipient).not.toHaveBeenCalled();
    }
  );

  it.each([
    { mmrdata: ["raw-string"] },
    { mmrdata: [{ serializedbase64: "AA==" }] },
    { mmrdata: [{ serializedhex: "0" }] },
    { mmrdata: [{ message: "one" }, { datahash: "01" }] },
    { mmrdata: [{ message: "one", label: "discarded metadata" }] },
    { mmrdata: [{ message: "one" }], priormmr: [] },
  ])("rejects incompatible MMR CLI input during parsing: %j", (data) => {
    expect(() => requestFor([data])).toThrow();
  });

  it("snapshots request bytes before callbacks can mutate them", async () => {
    const request = requestFor();
    const w = wallet();
    const original = w.crypto.randomBytes;
    w.crypto.randomBytes = async (length) => {
      ([...request.signDataMap!.entries()][0][1].data as Buffer).fill(0x51);
      return original(length);
    };
    await buildLocalIdentityUpdateData({
      request,
      chainId: CHAIN,
      crypto: w.crypto,
    });
    expect(
      decode(new DataDescriptor(), untag(w.plaintexts[0])).objectdata.toString()
    ).toBe("private upload bytes");
  });

  it.each([
    "short salt",
    "short epk",
    "long ciphertext",
    "reused epk",
    "bad IVK",
    "wrong network",
  ])("rejects invalid wallet result: %s", async (kind) => {
    const w = wallet();
    const encrypt = w.crypto.encrypt;
    if (kind === "short salt")
      w.crypto.randomBytes = async () => Buffer.alloc(31);
    if (kind === "bad IVK")
      w.crypto.createPublicRecipient = async () => ({
        address: PUBLIC.address,
        ivk: Buffer.alloc(31),
      });
    if (kind === "wrong network")
      w.crypto.createPublicRecipient = async () => ({
        address: "ztestsapling1wrong",
        ivk: Buffer.alloc(32, 1),
      });
    if (["short epk", "long ciphertext", "reused epk"].includes(kind)) {
      w.crypto.encrypt = async (bytes, address) => {
        const result = await encrypt(bytes, address);
        if (kind === "short epk") result.epk = Buffer.alloc(31);
        if (kind === "long ciphertext")
          result.ciphertext = Buffer.concat([
            result.ciphertext,
            Buffer.alloc(1),
          ]);
        if (kind === "reused epk") result.epk = Buffer.alloc(32, 1);
        return result;
      };
    }
    await expect(
      buildLocalIdentityUpdateData({
        request: requestFor(),
        chainId: CHAIN,
        crypto: w.crypto,
      })
    ).rejects.toThrow();
  });
});
