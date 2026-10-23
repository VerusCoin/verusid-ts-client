import { createCipheriv, createDecipheriv, createHash } from "crypto";
import { Transaction, networks, smarttxs } from "@bitgo/utxo-lib";
import {
  DataDescriptor,
  DEST_PKH,
  EVALS,
  Identity,
  IdentityUpdateRequestDetails,
  PartialMMRData,
  SmartTransactionScript,
  TransferDestination,
  fromBase58Check,
  nameAndParentAddrToIAddr,
} from "verus-typescript-primitives";
import VerusIdInterface from "../VerusIdInterface";
import { LocalIdentityUploadCrypto } from "../identity/localUpdateData";
import { verifyIdentityUpdateFunding } from "../identity/updateFundingVerification";
import { TEST_ID_3, VERUSTEST_I_ADDR } from "./fixtures/verusid";

const PUBLIC = require("./fixtures/local-upload/public-recipient.json");
const HEIGHT = 30000;
const CHAIN = VERUSTEST_I_ADDR;
const TOKEN = nameAndParentAddrToIAddr("local-upload-transfer-token", CHAIN);
const CHANGE = TEST_ID_3.identity.primaryaddresses[0];
const PRIVATE_MESSAGE = "private-upload-never-send-to-rpc:".repeat(260);
const BALANCE = "9007199254740993";
const CHANGE_TOKEN = "9007199254740893";

function fixture(privateUpload = true) {
  const destination = new TransferDestination({
    type: DEST_PKH,
    destinationBytes: fromBase58Check(CHANGE).hash,
  });
  const outputTransaction = (currencies: Record<string, string>) =>
    Transaction.fromHex(
      VerusIdInterface.createUnfundedCurrencyTransferTransaction(
        CHAIN,
        [{ currencies, address: destination }],
        HEIGHT + 20
      ),
      networks.verus
    );
  const fundingSource = outputTransaction({
    [CHAIN]: "10000000",
    [TOKEN]: BALANCE,
  });
  fundingSource.addInput(Buffer.alloc(32, 33), 0);
  const identity = Identity.fromJson(TEST_ID_3.identity);
  const identitySource = Transaction.fromHex(
    smarttxs.createUnfundedIdentityUpdate(
      identity.toBuffer().toString("hex"),
      networks.verus,
      HEIGHT + 20
    ),
    networks.verus
  );
  identitySource.addInput(Buffer.alloc(32, 34), 0);
  const request = IdentityUpdateRequestDetails.fromCLIJson({
    name: identity.name,
    parent: CHAIN,
    contentmultimap: {
      [nameAndParentAddrToIAddr("local-upload-transfer-data", CHAIN)]: {
        data: {
          createmmr: true,
          mmrdata: [{ message: PRIVATE_MESSAGE }, { serializedhex: "ff0100" }],
          ...(privateUpload ? { encrypttoaddress: PUBLIC.address } : {}),
        },
      },
    },
  });
  const keys = new Map<string, Buffer>();
  let encrypted = 0;
  const state = {
    changePosition: undefined as number | undefined,
    mutateFunded: (_tx: any) => {},
    failDecryption: false,
    onHeight: () => {},
    events: [] as string[],
  };
  // Authenticated symmetric fixture; live daemon/native parity is covered by
  // the separate native interoperability harness.
  const crypto: LocalIdentityUploadCrypto = {
    randomBytes: async () => Buffer.alloc(32, 19),
    createPublicRecipient: async () => ({
      address: PUBLIC.address,
      ivk: Buffer.from(PUBLIC.ivk, "hex"),
    }),
    encrypt: async (plaintext, _recipient) => {
      const epk = createHash("sha256")
        .update(`ephemeral-${++encrypted}`)
        .digest();
      const key = createHash("sha256")
        .update(`temporary-key-${encrypted}`)
        .digest();
      const cipher = createCipheriv("chacha20-poly1305", key, Buffer.alloc(12));
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      keys.set(epk.toString("hex") + ciphertext.toString("hex"), key);
      return { epk, ciphertext };
    },
    decryptData: async (descriptor: DataDescriptor) => {
      state.events.push("decrypt");
      if (state.failDecryption)
        throw new Error("authenticated decryption failed");
      const key = keys.get(
        descriptor.epk.toString("hex") + descriptor.objectdata.toString("hex")
      );
      if (!key) throw new Error("unknown ciphertext");
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
    },
  };
  const calls: Array<{ method: string; params: any[] }> = [];
  const rpc = jest.fn(async (call: any) => {
    state.events.push(call.method);
    calls.push({ method: call.method, params: call.params });
    if (call.method === "getinfo") {
      state.onHeight();
      return { id: call.id, error: null, result: { blocks: HEIGHT, longestchain: HEIGHT } };
    }
    if (call.method === "fundrawtransaction") {
      const tx = Transaction.fromHex(call.params[0], networks.verus);
      tx.addInput(Buffer.from(fundingSource.getId(), "hex").reverse(), 0);
      const change = outputTransaction({
        [CHAIN]: "9940000",
        [TOKEN]: CHANGE_TOKEN,
      }).outs[0];
      const changepos = state.changePosition ?? tx.outs.length;
      tx.outs.splice(changepos, 0, change);
      state.mutateFunded(tx);
      return {
        id: call.id,
        error: null,
        result: { hex: tx.toHex(), fee: 0.0001, changepos },
      };
    }
    if (
      call.method === "getrawtransaction" &&
      call.params[0] === fundingSource.getId()
    ) {
      return { id: call.id, error: null, result: fundingSource.toHex() };
    }
    throw new Error("Unexpected RPC: " + call.method);
  });
  const client = new VerusIdInterface(
    CHAIN,
    "http://offline.invalid",
    undefined,
    rpc
  );
  const utxos = [
    {
      txid: fundingSource.getId(),
      outputIndex: 0,
      address: CHANGE,
      // Deliberately untrusted hints; raw prevout bytes must win.
      script: "00",
      satoshis: 1,
      height: HEIGHT - 100,
      isspendable: true,
      blocktime: 1,
    },
  ];
  const transfer = {
    currencies: { [CHAIN]: "50000", [TOKEN]: "100" },
    address: destination,
  };
  const run = (currentHeight: number | undefined = HEIGHT) =>
    client.createUpdateIdentityWithCurrencyTransferTransaction(
      request,
      CHANGE,
      identitySource.toHex(),
      HEIGHT - 1,
      [transfer],
      utxos,
      {
        chainIAddr: CHAIN,
        currentHeight,
        isTestnet: true,
        localUploadCrypto: crypto,
        parseVdxfObjects: false,
      }
    );
  return {
    run,
    request,
    calls,
    rpc,
    state,
    keys,
    client,
    crypto,
    transfer,
    identitySource,
    utxos,
  };
}

describe("local encrypted upload with transfers", () => {
  it.each([true, false])(
    "verifies multipart uploads and mixed-currency funding (private: %s)",
    async (privateUpload) => {
      const f = fixture(privateUpload);
      const result = await f.run();
      expect(result.fundingApproval).toBeDefined();
      expect(
        verifyIdentityUpdateFunding(
          result.fundingApproval!,
          result.hex,
          result.utxos
        )
      ).toBe(true);
      expect(f.calls.map((call) => call.method)).toEqual([
        "fundrawtransaction",
        "getrawtransaction",
      ]);
      expect(f.state.events.lastIndexOf("decrypt")).toBeLessThan(
        f.state.events.indexOf("fundrawtransaction")
      );
      const tx = Transaction.fromHex(result.hex, networks.verus);
      const evals = tx.outs.map((output: any) => {
        const script = new SmartTransactionScript();
        script.fromBuffer(output.script);
        return script.paramsOptCC.evalCode.toNumber();
      });
      const identityIndex = evals.indexOf(EVALS.EVAL_IDENTITY_PRIMARY);
      expect(identityIndex).toBeGreaterThan(1);
      expect(
        evals
          .slice(0, identityIndex)
          .every((value: number) => value === EVALS.EVAL_NOTARY_EVIDENCE)
      ).toBe(true);
      const payment = smarttxs.unpackOutput(tx.outs[identityIndex + 1], CHAIN);
      const change = smarttxs.unpackOutput(tx.outs[identityIndex + 2], CHAIN);
      expect(payment.values[TOKEN].toString()).toBe("100");
      expect(change.values[TOKEN].toString()).toBe(CHANGE_TOKEN);
      expect(result.deltas.get(CHAIN)!.toFixed(0)).toBe("-60000");
      expect(result.deltas.get(TOKEN)!.toFixed(0)).toBe("-100");
      const outbound = JSON.stringify(f.calls);
      expect(outbound).not.toContain(PRIVATE_MESSAGE);
      expect(outbound).not.toContain(
        Buffer.from(PRIVATE_MESSAGE).toString("hex")
      );
      for (const key of f.keys.values())
        expect(outbound).not.toContain(key.toString("hex"));
    }
  );

  it("fails decryption and retries without construction or funding RPCs", async () => {
    const f = fixture();
    f.state.failDecryption = true;
    await expect(f.run()).rejects.toThrow("authenticated decryption");
    await expect(f.run()).rejects.toThrow("authenticated decryption");
    expect(f.calls).toEqual([]);
  });

  it.each([0, 1])(
    "rejects change before or inside evidence at index %i",
    async (position) => {
      const f = fixture();
      f.state.changePosition = position;
      await expect(f.run()).rejects.toThrow(/evidence|outputs|match/);
      expect(f.calls.map((call) => call.method)).toEqual([
        "fundrawtransaction",
        "getrawtransaction",
      ]);
    }
  );

  it("rejects funding header mutation after local verification", async () => {
    const f = fixture();
    f.state.mutateFunded = (tx) => {
      tx.expiryHeight++;
    };
    await expect(f.run()).rejects.toThrow(/header|match|changed/);
  });

  it("snapshots request, payment, and crypto methods before a height RPC", async () => {
    const f = fixture();
    f.state.onHeight = () => {
      const upload = [...f.request.signDataMap!.entries()][0][1];
      ((upload.data as PartialMMRData).data[0].data as Buffer).fill(0x58);
      f.transfer.currencies[TOKEN] = "999";
      f.crypto.encrypt = async () => {
        throw new Error("mutated encryption callback");
      };
    };
    const result =
      await f.client.createUpdateIdentityWithCurrencyTransferTransaction(
        f.request,
        CHANGE,
        f.identitySource.toHex(),
        HEIGHT - 1,
        [f.transfer],
        f.utxos,
        { chainIAddr: CHAIN, isTestnet: true, localUploadCrypto: f.crypto }
      );
    expect(
      verifyIdentityUpdateFunding(
        result.fundingApproval!,
        result.hex,
        result.utxos
      )
    ).toBe(true);
    expect(result.deltas.get(TOKEN)!.toFixed(0)).toBe("-100");
    expect(f.calls.map((call) => call.method)).toEqual([
      "getinfo",
      "fundrawtransaction",
      "getrawtransaction",
    ]);
  });
});
