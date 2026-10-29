import {
  address,
  ECPair,
  networks,
  Transaction,
  TransactionBuilder,
} from "@bitgo/utxo-lib";
import {
  AdvancedNameReservation,
  CurrencyOptions,
  Identity,
  IdentityCommitmentScript,
  IdentityID,
  IdentityScript,
  KeyID,
  VerusCLIVerusIDJson,
  nameAndParentAddrToIAddr,
} from "verus-typescript-primitives";
import { VerusdRpcInterface } from "verusd-rpc-ts-client";
import {
  CreateIdentityRegistrationTransactionRequest,
  createIdentityRegistrationTransaction,
  createNameReservationTransaction,
  resolveIdentityRegistration,
} from "../identity/registration";

const systemID = nameAndParentAddrToIAddr("VRSC");
const keys = [5, 6].map((number) =>
  ECPair.fromPrivateKeyBuffer(Buffer.alloc(32, number), networks.verus)
);
const owner = keys[0].getAddress();
const other = keys[1].getAddress();
const tipHash = "ab".repeat(32);
const ok = (result: unknown) => ({ result, error: null });

function fixture() {
  const builder = new TransactionBuilder(networks.verus);
  builder.setVersion(4);
  builder.setVersionGroupId(0x892f2085);
  builder.setExpiryHeight(90);
  builder.addInput(Buffer.alloc(32, 18), 0);
  builder.addOutput(owner, 20000000000);
  const source = builder.buildIncomplete();
  const sources = new Map<string, { tx: any; height: number }>([
    [source.getId(), { tx: source, height: 50 }],
  ]);
  let infoGate: Promise<void> | undefined;
  const methods = {
    chain: systemID,
    getInfo: async () => {
      const gate = infoGate;
      infoGate = undefined;
      if (gate) await gate;
      return ok({ blocks: 100, longestchain: 100, chainid: systemID });
    },
    getCurrency: async () =>
      ok({
        version: 1,
        currencyid: systemID,
        name: "VRSC",
        parent: new IdentityID(Buffer.alloc(20)).toAddress(),
        systemid: systemID,
        options: CurrencyOptions.PBAAS,
        proofprotocol: 1,
        startblock: 0,
        endblock: 0,
        idregistrationfees: 100,
        idreferrallevels: 0,
        idimportfees: 0.01,
        blocktime: 60,
      }),
    getBlock: async (heightText: string) => {
      const height = Number(heightText);
      return ok({
        hash: height === 100 ? tipHash : "cd".repeat(32),
        height,
        confirmations: 101 - height,
        tx: [...sources]
          .filter(([, item]) => item.height === height)
          .map(([id]) => id),
      });
    },
    getIdentity: async () => ({
      result: null,
      error: { code: -5, message: "Identity not found" },
    }),
    getRawTransaction: async (txid: string) =>
      ok(sources.get(txid)?.tx.toHex()),
    getTxOut: async (txid: string, index: number) => {
      const item = sources.get(txid);
      const output = item?.tx.outs[index];
      if (!item || !output) return ok(null);
      const atomic = String(output.value).padStart(9, "0");
      return ok({
        bestblock: tipHash,
        confirmations: 101 - item.height,
        coinbase: false,
        value: atomic.slice(0, -8) + "." + atomic.slice(-8),
        scriptPubKey: { hex: output.script.toString("hex") },
      });
    },
  };
  const rpc = methods as unknown as VerusdRpcInterface;
  const request = {
    name: "Alice",
    rootSystemName: "VRSC",
    systemID,
    controller: owner,
    salt: Buffer.alloc(32, 21),
    commitmentFee: "10000",
    offer: "10000000000",
    funding: [
      { txid: source.getId(), vout: 0, rawTransaction: source.toHex() },
    ],
    changeAddress: owner,
    approvedCosts: { [systemID]: "10000010000" },
  };
  const pauseInfo = () => {
    let release!: () => void;
    infoGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  };
  const revealRequest =
    async (): Promise<CreateIdentityRegistrationTransactionRequest> => {
      const committed = await createNameReservationTransaction(rpc, request);
      const tx = Transaction.fromHex(
        committed.transaction.txHex,
        networks.verus
      );
      sources.set(tx.getId(), { tx, height: 90 });
      const id = committed.reservation.identityAddress;
      return {
        reservation: { ...committed.reservation },
        commitment: { txid: tx.getId(), vout: 0, rawTransaction: tx.toHex() },
        identity: {
          version: 3,
          flags: 0,
          name: "Alice",
          parent: systemID,
          systemid: systemID,
          minimumsignatures: 1,
          primaryaddresses: [owner],
          timelock: 0,
          recoveryauthority: id,
          revocationauthority: id,
          contentmap: {},
        },
        funding: [{ txid: tx.getId(), vout: 1, rawTransaction: tx.toHex() }],
        changeAddress: owner,
        approvedCosts: { [systemID]: "10000000000" },
        offer: "10000000000",
      };
    };
  return { rpc, request, pauseInfo, revealRequest, source };
}

function changeDestination(txHex: string): string {
  const tx = Transaction.fromHex(txHex, networks.verus);
  return address.fromOutputScript(
    tx.outs[tx.outs.length - 1].script,
    networks.verus
  );
}

describe("registration request snapshots across asynchronous RPC reads", () => {
  test("keeps resolve name, offer and commitment fee from the original invocation", async () => {
    const h = fixture();
    const release = h.pauseInfo();
    const pending = resolveIdentityRegistration(h.rpc, h.request);
    h.request.name = "Different";
    h.request.offer = "15000000000";
    h.request.commitmentFee = "100000000";
    release();
    const resolved = await pending;
    expect(resolved.policy.resolvedName.name).toBe("Alice");
    expect(resolved.quote.registrationOffer).toBe("10000000000");
    expect(resolved.quote.commitmentFee).toBe("10000");
  });

  test("retains original controller, change, costs, salt and nested funding while form state changes", async () => {
    const h = fixture();
    const release = h.pauseInfo();
    const pending = createNameReservationTransaction(h.rpc, h.request);
    h.request.controller = other;
    h.request.changeAddress = other;
    h.request.commitmentFee = "100000000";
    h.request.offer = "15000000000";
    h.request.approvedCosts[systemID] = "20000000000";
    h.request.funding[0].vout = 99;
    h.request.funding[0].rawTransaction = "00";
    h.request.salt.fill(0);
    h.request.funding.push({
      txid: "ff".repeat(32),
      vout: 0,
      rawTransaction: "00",
    });
    release();
    const result = await pending;
    const tx = Transaction.fromHex(result.transaction.txHex, networks.verus);
    const commitment = new IdentityCommitmentScript();
    commitment.fromBuffer(tx.outs[0].script);
    expect(commitment.getController().toAddress()).toBe(owner);
    expect(result.reservation.controller).toBe(owner);
    expect(changeDestination(result.transaction.txHex)).toBe(owner);
    expect(result.transaction.nativeFee).toBe("10000");
    expect(result.transaction.prevouts[0].txid).toBe(h.source.getId());
    expect(tx.outs[1].value).toBe(19999990000);
    expect(
      AdvancedNameReservation.fromHex(result.reservation.reservationHex).salt
    ).toEqual(Buffer.alloc(32, 21));
  });

  test("does not upgrade the cost approval while the commitment request is pending", async () => {
    const h = fixture();
    h.request.approvedCosts[systemID] = "0";
    const release = h.pauseInfo();
    const pending = createNameReservationTransaction(h.rpc, h.request);
    h.request.approvedCosts[systemID] = "20000000000";
    release();
    await expect(pending).rejects.toMatchObject({
      code: "COST_LIMIT_EXCEEDED",
    });
  });

  test.each(["json", "primitive"])(
    "retains reveal ownership and change when the %s identity and outpoints mutate",
    async (kind) => {
      const h = fixture();
      const request = await h.revealRequest();
      if (kind === "primitive" && !(request.identity instanceof Identity))
        request.identity = Identity.fromJson(request.identity);
      const originalCommitment = request.commitment.txid;
      const release = h.pauseInfo();
      const pending = createIdentityRegistrationTransaction(h.rpc, request);
      request.changeAddress = other;
      request.offer = "15000000000";
      request.approvedCosts[systemID] = "20000000000";
      request.commitment.txid = "ff".repeat(32);
      request.funding[0].vout = 77;
      request.funding[0].rawTransaction = "00";
      (request.reservation as any).controller = other;
      (request.reservation as any).identityAddress = nameAndParentAddrToIAddr(
        "Other",
        systemID
      );
      if (request.identity instanceof Identity)
        request.identity.setPrimaryAddresses([other]);
      else request.identity.primaryaddresses![0] = other;
      release();
      const prepared = await pending;
      const tx = Transaction.fromHex(prepared.txHex, networks.verus);
      const identityScript = new IdentityScript();
      identityScript.fromBuffer(tx.outs[0].script);
      expect(identityScript.getIdentity().toJson().primaryaddresses).toEqual([
        owner,
      ]);
      expect(changeDestination(prepared.txHex)).toBe(owner);
      expect(prepared.nativeFee).toBe("10000000000");
      expect(prepared.prevouts[0].txid).toBe(originalCommitment);
      expect(prepared.prevouts[1].vout).toBe(1);
    }
  );

  test("does not upgrade reveal approval while chain evidence is pending", async () => {
    const h = fixture();
    const request = await h.revealRequest();
    request.approvedCosts[systemID] = "0";
    const release = h.pauseInfo();
    const pending = createIdentityRegistrationTransaction(h.rpc, request);
    request.approvedCosts[systemID] = "20000000000";
    release();
    await expect(pending).rejects.toMatchObject({
      code: "COST_LIMIT_EXCEEDED",
    });
  });
});

describe("registration identity validation and normalization", () => {
  test.each(["IdentityID", "wrong address version", "variable-length key"])(
    "rejects a primitive %s primary address before serialization or RPC",
    async (kind) => {
      const h = fixture();
      const request = await h.revealRequest();
      const identity = Identity.fromJson(
        request.identity as VerusCLIVerusIDJson
      );
      const primary =
        kind === "IdentityID"
          ? new IdentityID(Buffer.alloc(20, 42))
          : new KeyID(Buffer.alloc(20, 42));
      if (kind === "wrong address version")
        primary.version = new IdentityID().version;
      if (kind === "variable-length key") primary.varlength = true;
      identity.primaryAddresses = [primary];
      request.identity = identity;
      const originalAddress = primary.toAddress();
      const originalVarlength = primary.varlength;
      const serialize = jest.spyOn(identity, "toBuffer");
      const getInfo = jest.spyOn(h.rpc, "getInfo");

      await expect(
        createIdentityRegistrationTransaction(h.rpc, request)
      ).rejects.toThrow(/primary|KeyID/i);

      expect(serialize).not.toHaveBeenCalled();
      expect(getInfo).not.toHaveBeenCalled();
      expect(identity.primaryAddresses).toEqual([primary]);
      expect(primary.toAddress()).toBe(originalAddress);
      expect(primary.varlength).toBe(originalVarlength);
      expect(primary.hash).toEqual(Buffer.alloc(20, 42));
    }
  );

  test.each([
    ["json", 5735],
    ["json", 5736],
    ["primitive", 5735],
    ["primitive", 5736],
  ] as const)(
    "%s identity with %i serialized bytes respects the daemon's wrapped size limit",
    async (kind, size) => {
      const h = fixture();
      const request = await h.revealRequest();
      const json = request.identity as VerusCLIVerusIDJson;
      const contentKey = new IdentityID(Buffer.alloc(20, 43)).toAddress()!;
      json.contentmultimap = { [contentKey]: ["ab".repeat(5500)] };
      const contentLength =
        5500 + size - Identity.fromJson(json).toBuffer().length;
      json.contentmultimap = { [contentKey]: ["ab".repeat(contentLength)] };
      const identity = Identity.fromJson(json);
      expect(identity.toBuffer().length).toBe(size);
      request.identity = kind === "primitive" ? identity : json;

      const pending = createIdentityRegistrationTransaction(h.rpc, request);
      // The daemon limits the wrapped identity to 5872 bytes. Its reserve
      // transfer wrapper adds 137 bytes at this boundary: 5735 + 137 = 5872.
      if (size > 5735) {
        await expect(pending).rejects.toMatchObject({
          code: "IDENTITY_TOO_LARGE",
        });
      } else {
        const prepared = await pending;
        const tx = Transaction.fromHex(prepared.txHex, networks.verus);
        const script = new IdentityScript();
        script.fromBuffer(tx.outs[0].script);
        expect(script.getIdentity().toBuffer()).toEqual(identity.toBuffer());
      }
    }
  );

  test.each(["json", "primitive"])(
    "drops empty multimap groups from a %s identity while preserving values and caller data",
    async (kind) => {
      const h = fixture();
      const request = await h.revealRequest();
      const json = request.identity as VerusCLIVerusIDJson;
      const [emptyArrayKey, emptyObjectKey, emptyBytesKey, contentKey] = [
        44, 45, 46, 47,
      ].map((value) => new IdentityID(Buffer.alloc(20, value)).toAddress()!);
      json.contentmultimap = {
        [emptyArrayKey]: [],
        [emptyObjectKey]: {},
        [emptyBytesKey]: [""],
        [contentKey]: ["abcd"],
      };
      const identity = Identity.fromJson(json);
      expect(
        identity.contentMultiMap.kvContent.getByAddress(emptyArrayKey)
      ).toEqual([]);
      expect(
        identity.contentMultiMap.kvContent.getByAddress(emptyObjectKey)
      ).toEqual([]);
      const originalJson = JSON.stringify(json);
      const originalBytes = identity.toBuffer();
      request.identity = kind === "primitive" ? identity : json;

      const prepared = await createIdentityRegistrationTransaction(
        h.rpc,
        request
      );
      const tx = Transaction.fromHex(prepared.txHex, networks.verus);
      const script = new IdentityScript();
      script.fromBuffer(tx.outs[0].script);
      expect(script.getIdentity().contentMultiMap.toJson()).toEqual({
        [emptyBytesKey]: [""],
        [contentKey]: ["abcd"],
      });
      expect(JSON.stringify(json)).toBe(originalJson);
      expect(identity.toBuffer()).toEqual(originalBytes);
    }
  );
});
