import { createCipheriv, createDecipheriv, createHash } from "crypto";
import { Transaction, networks, smarttxs } from "@bitgo/utxo-lib";
import {
  DATA_TYPE_FILENAME,
  DataDescriptor,
  DEST_PKH,
  HASH_TYPE_KECCAK256,
  Identity,
  IdentityID,
  IdentityScript,
  IdentityUpdateRequestDetails,
  KeyID,
  PartialMMRData,
  PartialSignData,
  TransferDestination,
  fromBase58Check,
  nameAndParentAddrToIAddr,
} from "verus-typescript-primitives";
import VerusIdInterface from "../VerusIdInterface";
import {
  buildLocalIdentityUpdateData,
  LocalIdentityUploadCrypto,
} from "../identity/localUpdateData";
import { verifyIdentityUpdateData } from "../identity/updateDataVerification";
import { TEST_ID_3, VERUSTEST_I_ADDR } from "./fixtures/verusid";

const CHAIN = VERUSTEST_I_ADDR;
const HEIGHT = 30000;
const CHANGE = TEST_ID_3.identity.primaryaddresses[0];
const CONTENT_KEY = nameAndParentAddrToIAddr("closed-upload-options", CHAIN);
const PUBLIC = require("./fixtures/local-upload/public-recipient.json");
const filename = "/private/never-read-or-send-this-upload.txt";

function request() {
  return IdentityUpdateRequestDetails.fromCLIJson({
    name: TEST_ID_3.identity.name,
    parent: CHAIN,
    contentmultimap: {
      [CONTENT_KEY]: {
        data: {
          createmmr: true,
          mmrdata: [
            { message: "approved first" },
            { message: "approved second" },
          ],
          mmrsalt: ["01".repeat(32), "02".repeat(32)],
        },
      },
    },
  });
}

function wallet() {
  let counter = 0;
  const temporaryKeys = new Map<string, Buffer>();
  const randomBytes = jest.fn(async () => Buffer.alloc(32, 7));
  const createPublicRecipient = jest.fn(async () => ({
    address: PUBLIC.address,
    ivk: Buffer.from(PUBLIC.ivk, "hex"),
  }));
  // This test cipher exercises authenticated callbacks. Native Sapling parity
  // is separately covered by the recorded daemon interoperability fixtures.
  const encrypt = jest.fn(async (bytes: Buffer) => {
    const epk = createHash("sha256")
      .update(`epk-${++counter}`)
      .digest();
    const key = createHash("sha256").update(`temporary-${counter}`).digest();
    const cipher = createCipheriv("chacha20-poly1305", key, Buffer.alloc(12));
    const ciphertext = Buffer.concat([
      cipher.update(bytes),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    temporaryKeys.set(epk.toString("hex") + ciphertext.toString("hex"), key);
    return { epk, ciphertext };
  });
  const decryptData = jest.fn(async (descriptor: DataDescriptor) => {
    const key = temporaryKeys.get(
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
    randomBytes,
    createPublicRecipient,
    encrypt,
    decryptData,
  };
  return {
    crypto,
    callbacks: [randomBytes, createPublicRecipient, encrypt, decryptData],
  };
}

type BadOption = {
  name: string;
  mutate(upload: PartialSignData): void;
  error: RegExp;
};
const unsupported: BadOption[] = [
  {
    name: "identity data signer assigned without its presence flag",
    mutate: (upload) => {
      upload.address = IdentityID.fromAddress(CHAIN);
    },
    error: /data signatures are not supported/,
  },
  {
    name: "transparent data signer",
    mutate: (upload) => {
      upload.address = KeyID.fromAddress(CHANGE);
    },
    error: /data signatures are not supported/,
  },
  {
    name: "signer flag without a signer object",
    mutate: (upload) => {
      upload.flags = upload.flags.or(PartialSignData.CONTAINS_ADDRESS);
    },
    error: /data signatures are not supported/,
  },
  {
    name: "prior data signature",
    mutate: (upload) => {
      upload.signature = Buffer.from("prior-signature");
    },
    error: /data signatures are not supported/,
  },
  {
    name: "empty prior data signature",
    mutate: (upload) => {
      upload.signature = Buffer.alloc(0);
    },
    error: /data signatures are not supported/,
  },
  {
    name: "prior-signature flag without signature bytes",
    mutate: (upload) => {
      upload.flags = upload.flags.or(PartialSignData.CONTAINS_CURRENTSIG);
    },
    error: /data signatures are not supported/,
  },
  {
    name: "Keccak object hashing",
    mutate: (upload) => {
      upload.hashType = HASH_TYPE_KECCAK256.clone();
    },
    error: /Unsupported identity upload hash type/,
  },
  {
    name: "Keccak MMR hashing",
    mutate: (upload) => {
      (upload.data as PartialMMRData).mmrhashtype = HASH_TYPE_KECCAK256.clone();
    },
    error: /Unsupported identity upload MMR hash type/,
  },
  {
    name: "prior MMR vector",
    mutate: (upload) => {
      (upload.data as PartialMMRData).priormmr = [Buffer.alloc(32, 1)];
    },
    error: /Prior MMR uploads are not supported/,
  },
  {
    name: "empty prior MMR vector",
    mutate: (upload) => {
      (upload.data as PartialMMRData).priormmr = [];
    },
    error: /Prior MMR uploads are not supported/,
  },
  {
    name: "prior-MMR flag without a vector",
    mutate: (upload) => {
      const mmr = upload.data as PartialMMRData;
      mmr.flags = mmr.flags.or(PartialMMRData.CONTAINS_PRIORMMR);
    },
    error: /Prior MMR uploads are not supported/,
  },
  {
    name: "top-level remote filename",
    mutate: (upload) => {
      upload.dataType = DATA_TYPE_FILENAME.clone();
      upload.data = Buffer.from(filename);
    },
    error: /inline data, not a remote filename/,
  },
  {
    name: "MMR remote filename",
    mutate: (upload) => {
      (upload.data as PartialMMRData).data[1] = {
        type: DATA_TYPE_FILENAME.clone(),
        data: Buffer.from(filename),
      };
    },
    error: /inline data, not a remote filename/,
  },
  {
    name: "upload label",
    mutate: (upload) => {
      (upload as any).label = "do not silently discard";
    },
    error: /Unsupported identity upload metadata or options/,
  },
  {
    name: "upload MIME metadata",
    mutate: (upload) => {
      (upload as any).mimetype = "image/png";
    },
    error: /Unsupported identity upload metadata or options/,
  },
  {
    name: "alternate upload MIME spelling",
    mutate: (upload) => {
      (upload as any).mimeType = "image/png";
    },
    error: /Unsupported identity upload metadata or options/,
  },
  {
    name: "leaf label",
    mutate: (upload) => {
      ((upload.data as PartialMMRData).data[0] as any).label = "leaf metadata";
    },
    error: /Unsupported identity upload item metadata/,
  },
  {
    name: "leaf MIME metadata",
    mutate: (upload) => {
      ((upload.data as PartialMMRData).data[0] as any).mimetype = "image/png";
    },
    error: /Unsupported identity upload item metadata/,
  },
  {
    name: "MMR container metadata",
    mutate: (upload) => {
      (upload.data as any).label = "MMR metadata";
    },
    error: /Unsupported identity upload MMR options/,
  },
  {
    name: "signature prefix binding",
    mutate: (upload) => {
      upload.prefixString = Buffer.from("prefix");
    },
    error: /signature bindings are not supported/,
  },
  {
    name: "signature VDXF key binding",
    mutate: (upload) => {
      upload.vdxfKeys = [IdentityID.fromAddress(CHAIN)];
    },
    error: /signature bindings are not supported/,
  },
  {
    name: "signature name binding",
    mutate: (upload) => {
      upload.vdxfKeyNames = [Buffer.from("signed-name")];
    },
    error: /signature bindings are not supported/,
  },
  {
    name: "signature hash binding",
    mutate: (upload) => {
      upload.boundHashes = [Buffer.alloc(32, 1)];
    },
    error: /signature bindings are not supported/,
  },
];

type EntryPoint =
  | "plain local"
  | "combined local"
  | "plain supplied"
  | "combined supplied"
  | "supplied verifier";
const entryPoints: EntryPoint[] = [
  "plain local",
  "combined local",
  "plain supplied",
  "combined supplied",
  "supplied verifier",
];

describe("unsupported upload options fail closed at public boundaries", () => {
  let sourceHex: string;
  let templateHex: string;
  let fixtureWallet: ReturnType<typeof wallet>;

  beforeAll(async () => {
    fixtureWallet = wallet();
    const identity = Identity.fromJson(TEST_ID_3.identity);
    identity.upgradeVersion();
    const source = Transaction.fromHex(
      smarttxs.createUnfundedIdentityUpdate(
        identity.toBuffer().toString("hex"),
        networks.verus,
        HEIGHT + 20
      ),
      networks.verus
    );
    source.addInput(Buffer.alloc(32, 0x43), 0);
    sourceHex = source.toHex();
    const assembled = await buildLocalIdentityUpdateData({
      request: request(),
      chainId: CHAIN,
      crypto: fixtureWallet.crypto,
    });
    identity.clearContentMultiMap();
    for (const [key, values] of assembled.contentMultiMap) {
      identity.contentMultiMap.kvContent.set(key, values);
    }
    const template = Transaction.fromHex(
      smarttxs.createUnfundedIdentityUpdate(
        identity.toBuffer().toString("hex"),
        networks.verus,
        HEIGHT + 20
      ),
      networks.verus
    );
    template.outs = [
      ...assembled.outputs,
      { value: 0, script: IdentityScript.fromIdentity(identity).toBuffer() },
    ];
    templateHex = template.toHex();
    await expect(
      verifyIdentityUpdateData(
        request(),
        templateHex,
        fixtureWallet.crypto.decryptData,
        CHAIN
      )
    ).resolves.toBe(true);
  });

  function entry(mode: EntryPoint) {
    // A valid request reaches funding; rejected options must not even read the
    // height. No currentHeight is supplied so these tests cover that ordering.
    const rpc = jest.fn(async (call: any): Promise<any> => {
      if (call.method === "getinfo") {
        return { id: call.id, error: null, result: { blocks: HEIGHT, longestchain: HEIGHT } };
      }
      throw new Error("reached funding: " + call.method);
    });
    const client = new VerusIdInterface(
      CHAIN,
      "http://offline.invalid",
      undefined,
      rpc
    );
    const supplied = mode.includes("supplied") ? templateHex : undefined;
    const crypto = supplied ? undefined : fixtureWallet.crypto;
    const run = (value: IdentityUpdateRequestDetails) => {
      if (mode === "supplied verifier") {
        return verifyIdentityUpdateData(
          value,
          templateHex,
          fixtureWallet.crypto.decryptData,
          CHAIN
        );
      }
      if (mode.startsWith("plain")) {
        return client.createUpdateIdentityTransaction(
          value,
          CHANGE,
          sourceHex,
          HEIGHT - 1,
          [],
          CHAIN,
          undefined,
          undefined,
          undefined,
          supplied,
          false,
          true,
          false,
          fixtureWallet.crypto.decryptData,
          crypto
        );
      }
      return client.createUpdateIdentityWithCurrencyTransferTransaction(
        value,
        CHANGE,
        sourceHex,
        HEIGHT - 1,
        [
          {
            currencies: { [CHAIN]: "10000" },
            address: new TransferDestination({
              type: DEST_PKH,
              destinationBytes: fromBase58Check(CHANGE).hash,
            }),
          },
        ],
        [],
        {
          chainIAddr: CHAIN,
          isTestnet: true,
          parseVdxfObjects: false,
          updateIdentityTransactionHex: supplied,
          decryptData: fixtureWallet.crypto.decryptData,
          localUploadCrypto: crypto,
        }
      );
    };
    return { run, rpc };
  }

  describe.each(entryPoints)("%s", (mode) => {
    it("accepts the supported control request through upload verification", async () => {
      const f = entry(mode);
      if (mode === "supplied verifier") {
        await expect(f.run(request())).resolves.toBe(true);
        expect(f.rpc).not.toHaveBeenCalled();
      } else {
        await expect(f.run(request())).rejects.toThrow(
          "reached funding: fundrawtransaction"
        );
        expect(f.rpc.mock.calls.map(([call]) => call.method)).toEqual([
          "getinfo",
          "fundrawtransaction",
        ]);
      }
    });

    it.each(unsupported)(
      "rejects $name before callbacks or RPC, including retry",
      async (bad) => {
        const value = request();
        bad.mutate([...value.signDataMap!.entries()][0][1]);
        const f = entry(mode);
        for (const callback of fixtureWallet.callbacks) callback.mockClear();

        // Reusing the exact same rejected object cannot trigger a remote fallback
        // or normalize away fields that binary serialization would omit.
        await expect(f.run(value)).rejects.toThrow(bad.error);
        await expect(f.run(value)).rejects.toThrow(bad.error);

        for (const callback of fixtureWallet.callbacks) {
          expect(callback).not.toHaveBeenCalled();
        }
        expect(f.rpc).not.toHaveBeenCalled();
      }
    );

    it("rejects an unsupported second upload before processing the first", async () => {
      const value = request();
      const second = PartialSignData.fromCLIJson({
        createmmr: true,
        message: "second upload",
        hashtype: "keccak256",
      });
      const extra = IdentityUpdateRequestDetails.fromCLIJson({
        name: TEST_ID_3.identity.name,
        parent: CHAIN,
        contentmultimap: {
          [nameAndParentAddrToIAddr("unsupported-second-upload", CHAIN)]: {
            data: { createmmr: true, message: "second upload" },
          },
        },
      });
      value.signDataMap!.set([...extra.signDataMap!.entries()][0][0], second);
      const f = entry(mode);
      for (const callback of fixtureWallet.callbacks) callback.mockClear();
      await expect(f.run(value)).rejects.toThrow(
        /Unsupported identity upload hash type/
      );
      for (const callback of fixtureWallet.callbacks)
        expect(callback).not.toHaveBeenCalled();
      expect(f.rpc).not.toHaveBeenCalled();
    });
  });
});
