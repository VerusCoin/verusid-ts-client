import BN from "bn.js";
import {
  crypto,
  ECPair,
  networks,
  script,
  Transaction,
  TransactionBuilder,
} from "@bitgo/utxo-lib";
import {
  AdvancedNameReservation,
  CurrencyOptions,
  CurrencyValueMap,
  EVALS,
  Identity,
  IdentityID,
  IdentityReservationScript,
  IdentityScript,
  KeyID,
  nameAndParentAddrToIAddr,
  OptCCParams,
  ReserveTransfer,
  SaplingPaymentAddress,
  SmartTransactionScript,
  TokenOutput,
  TxDestination,
} from "verus-typescript-primitives";
import {
  CreateIdentityRegistrationTransactionRequest,
  VerusIdInterface,
} from "../index";
import { paymentOutput } from "../identity/registrationTransaction";

const SYSTEM = nameAndParentAddrToIAddr("VRSC");
const TOKEN = nameAndParentAddrToIAddr("community", SYSTEM);
const key = ECPair.fromPrivateKeyBuffer(Buffer.alloc(32, 7), networks.verus);
const address = key.getAddress();
const wif = key.toWIF();
const hashAt = (height: number) => height.toString(16).padStart(64, "0");
const nativeDefinition = () => ({
  version: 1,
  name: "VRSC",
  parent: new IdentityID(Buffer.alloc(20)).toAddress(),
  currencyid: SYSTEM,
  systemid: SYSTEM,
  options: CurrencyOptions.PBAAS | CurrencyOptions.ID_REFERRALS,
  proofprotocol: 1,
  startblock: 0,
  endblock: 0,
  blocktime: 60,
  idregistrationfees: 1,
  idreferrallevels: 3,
  idimportfees: 0.01,
});

function harness(tokenProof?: number) {
  let tip = 100;
  let identityError: { code: number; message: string } | undefined;
  let missingCommitmentBlock = false;
  let staleUnspent = false;
  const native = nativeDefinition();
  const token = {
    ...nativeDefinition(),
    name: "community",
    parent: SYSTEM,
    currencyid: TOKEN,
    options: CurrencyOptions.TOKEN,
    proofprotocol: tokenProof || 1,
  };
  const transactions = new Map<string, { tx: any; height: number }>();
  const identityResponses = new Map<string, any>();
  const spent = new Set<string>();
  const calls: string[] = [];
  const client = new VerusIdInterface(
    SYSTEM,
    "http://unused.invalid",
    undefined,
    async (request: any): Promise<any> => {
      calls.push(request.method);
      const [first, second] = request.params || [];
      const ok = (result: unknown) => ({ id: request.id, error: null, result });
      if (request.method === "getinfo")
        return ok({ blocks: tip, longestchain: tip, chainid: SYSTEM });
      if (request.method === "getcurrency")
        return ok(first === TOKEN ? token : native);
      if (request.method === "getidentity") {
        if (identityError)
          return { id: request.id, result: null, error: identityError };
        if (identityResponses.has(first))
          return ok(identityResponses.get(first));
        if (first === SYSTEM)
          return ok({
            identity: {
              name: "VRSC",
              parent: native.parent,
              systemid: SYSTEM,
              identityaddress: SYSTEM,
              version: 3,
              flags: 0,
              timelock: 0,
              primaryaddresses: [address],
              minimumsignatures: 1,
            },
          });
        return {
          id: request.id,
          result: null,
          error: { code: -5, message: "Identity not found" },
        };
      }
      if (request.method === "getrawtransaction") {
        const source = transactions.get(first);
        if (!source) throw new Error("Missing test source");
        return ok(source.tx.toHex());
      }
      if (request.method === "gettxout") {
        const source = transactions.get(first);
        const output = source?.tx.outs[second];
        if (!source || !output || spent.has(`${first}:${second}`))
          return ok(null);
        const value = String(output.value).padStart(9, "0");
        return ok({
          bestblock: staleUnspent ? hashAt(tip - 1) : hashAt(tip),
          confirmations: source.height ? tip - source.height + 1 : 0,
          value: `${value.slice(0, -8)}.${value.slice(-8)}`,
          coinbase: false,
          scriptPubKey: { hex: output.script.toString("hex") },
        });
      }
      if (request.method === "getblock") {
        const height = first.length > 10 ? parseInt(first, 16) : Number(first);
        return ok({
          hash: hashAt(height),
          height,
          confirmations: tip - height + 1,
          tx: missingCommitmentBlock
            ? []
            : Array.from(transactions)
                .filter(([, item]) => item.height === height)
                .map(([txid]) => txid),
        });
      }
      throw new Error(`Unexpected RPC request ${request.method}`);
    }
  );
  const source = new TransactionBuilder(networks.verus);
  source.setVersion(4);
  source.setVersionGroupId(0x892f2085);
  source.setExpiryHeight(500);
  source.addInput(Buffer.alloc(32, 9), 0);
  let fundingScript = script.pubKeyHash.output.encode(
    crypto.hash160(key.getPublicKeyBuffer())
  );
  if (tokenProof != null) {
    const dest = new TxDestination(KeyID.fromAddress(address));
    const master = new OptCCParams({
      version: new BN(3),
      evalCode: new BN(0),
      m: new BN(1),
      n: new BN(1),
      destinations: [dest],
      vData: [],
    });
    const reserve = new TokenOutput({
      version: new BN(1),
      values: new CurrencyValueMap({
        valueMap: new Map([[TOKEN, new BN(200000000)]]),
      }),
    });
    const condition = new OptCCParams({
      version: new BN(3),
      evalCode: new BN(EVALS.EVAL_RESERVE_OUTPUT),
      m: new BN(1),
      n: new BN(1),
      destinations: [dest],
      vData: [reserve.toBuffer()],
    });
    fundingScript = new SmartTransactionScript(master, condition).toBuffer();
  }
  source.addOutput(fundingScript, 200000000);
  const funding = source.buildIncomplete();
  transactions.set(funding.getId(), { tx: funding, height: 10 });
  const parentID = tokenProof == null ? SYSTEM : TOKEN;
  const request = {
    name: tokenProof == null ? "Alice" : "Alice.community@",
    rootSystemName: "VRSC",
    systemID: SYSTEM,
    controller: address,
    salt: Buffer.alloc(32, 23),
    funding: [{ txid: funding.getId(), vout: 0 }],
    changeAddress: address,
    approvedCosts: {
      [SYSTEM]: "200000000",
      ...(tokenProof == null ? {} : { [TOKEN]: "200000000" }),
    },
  };
  const identityID = nameAndParentAddrToIAddr("Alice", parentID);
  const identity = {
    version: 3,
    flags: 0,
    name: "Alice",
    parent: parentID,
    systemid: SYSTEM,
    minimumsignatures: 1,
    primaryaddresses: [address],
    timelock: 0,
    recoveryauthority: identityID,
    revocationauthority: identityID,
  };
  const mine = (hex: string) => {
    tip += 1;
    const tx = Transaction.fromHex(hex, networks.verus);
    transactions.set(tx.getId(), { tx, height: tip });
    tx.ins.forEach((input: any) =>
      spent.add(
        `${Buffer.from(input.hash).reverse().toString("hex")}:${input.index}`
      )
    );
    return tx;
  };
  const addAuthority = (
    name: string,
    parent: string,
    keys: any[],
    threshold: number,
    flags = 0
  ) => {
    const id = nameAndParentAddrToIAddr(name, parent);
    const identity = new Identity({
      version: new BN(3),
      flags: new BN(flags),
      minSigs: new BN(threshold),
      primaryAddresses: keys.map((pair) =>
        KeyID.fromAddress(pair.getAddress())
      ),
      name,
      parent: IdentityID.fromAddress(parent),
      systemId: IdentityID.fromAddress(SYSTEM),
      revocationAuthority: IdentityID.fromAddress(id),
      recoveryAuthority: IdentityID.fromAddress(id),
      unlockAfter: new BN(0),
    });
    const builder = new TransactionBuilder(networks.verus);
    builder.setVersion(4);
    builder.setVersionGroupId(0x892f2085);
    builder.setExpiryHeight(500);
    builder.addInput(Buffer.alloc(32, 51), 0);
    builder.addOutput(IdentityScript.fromIdentity(identity).toBuffer(), 0);
    const tx = builder.buildIncomplete();
    transactions.set(tx.getId(), { tx, height: 20 });
    const result = {
      identity: identity.toJson("VRSC"),
      txid: tx.getId(),
      vout: 0,
      blockheight: 20,
    };
    identityResponses.set(id, result);
    return result;
  };
  return {
    client,
    calls,
    native,
    token,
    request,
    identity,
    transactions,
    spent,
    mine,
    addAuthority,
    setIdentityError: (value: typeof identityError) => {
      identityError = value;
    },
    setMissingCommitmentBlock: () => {
      missingCommitmentBlock = true;
    },
    setStaleUnspent: () => {
      staleUnspent = true;
    },
  };
}

async function commitAndConfirm(h: ReturnType<typeof harness>) {
  const commitment = await h.client.createNameReservationTransaction(h.request);
  const signed = h.client.signIdentityRegistrationTransaction({
    transaction: commitment.transaction,
    keys: commitment.transaction.prevouts.map(() => [wif]),
  });
  expect(signed.signingStatus).toBe("complete");
  h.client.validateIdentityRegistrationTransaction(
    commitment.transaction,
    signed.txHex
  );
  const tx = h.mine(signed.txHex);
  const reveal: CreateIdentityRegistrationTransactionRequest = {
    reservation: commitment.reservation,
    commitment: { txid: tx.getId(), vout: commitment.commitmentVout },
    identity: h.identity,
    funding: [{ txid: tx.getId(), vout: 1 }],
    changeAddress: address,
    approvedCosts: h.request.approvedCosts,
  };
  return { commitment, signed, tx, reveal };
}

describe("public identity registration builders", () => {
  test.each([
    "missing change",
    "excessive fee",
    "redirected change",
    "missing reserve change",
  ])("rejects %s before touching signing keys", async (attack) => {
    const h = harness(attack === "missing reserve change" ? 2 : undefined);
    const { transaction: prepared } =
      await h.client.createNameReservationTransaction(h.request);
    const modified = Transaction.fromHex(prepared.txHex, networks.verus);
    if (attack === "missing change") modified.outs.pop();
    else if (attack === "excessive fee") modified.outs[1].value -= 100000000;
    else {
      const recipient =
        attack === "redirected change"
          ? ECPair.fromPrivateKeyBuffer(
              Buffer.alloc(32, 99),
              networks.verus
            ).getAddress()
          : address;
      const replacement = new TransactionBuilder(networks.verus);
      replacement.addOutput(recipient, modified.outs[1].value);
      modified.outs[1].script = replacement.buildIncomplete().outs[0].script;
    }
    const txHex = modified.toHex();
    // An invalid WIF would fail with a different error if key handling ran first.
    expect(() =>
      h.client.signIdentityRegistrationTransaction({
        transaction: prepared,
        txHex,
        keys: prepared.prevouts.map(() => ["not-a-WIF"]),
      })
    ).toThrow("differs from the approved registration plan");
    expect(() =>
      h.client.signIdentityRegistrationTransaction({
        transaction: prepared,
        partialTransactions: [txHex],
        keys: prepared.prevouts.map(() => ["not-a-WIF"]),
      })
    ).toThrow("differs from the approved registration plan");
    expect(() =>
      h.client.mergeIdentityRegistrationTransactions({
        transaction: prepared,
        partialTransactions: [txHex],
      })
    ).toThrow("differs from the approved registration plan");
  });

  test("requires economic approval at signing and keeps returned approval receipts immutable", async () => {
    const h = harness();
    const { transaction: prepared } =
      await h.client.createNameReservationTransaction(h.request);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.outputPlan[1].values)).toBe(true);
    expect(Object.isFrozen(prepared.approvedCosts)).toBe(true);
    expect(() =>
      h.client.signIdentityRegistrationTransaction({
        txHex: prepared.txHex,
        prevouts: prepared.prevouts,
        keys: [[wif]],
      } as any)
    ).toThrow("original prepared registration transaction");
    expect(() =>
      h.client.signIdentityRegistrationTransaction({
        transaction: { ...prepared, approvedCosts: { [SYSTEM]: "100" } },
        keys: [["not-a-WIF"]],
      })
    ).toThrow("exceeds the approved atomic cost");
    expect(() =>
      h.client.validateIdentityRegistrationTransaction({
        ...prepared,
        changeAddress: ECPair.fromPrivateKeyBuffer(
          Buffer.alloc(32, 99),
          networks.verus
        ).getAddress(),
      })
    ).toThrow("Change is not paid to the approved destination");
  });

  test("reconciles a restored plan's actual native fee against its quote before signing", async () => {
    const h = harness();
    const { transaction: prepared } =
      await h.client.createNameReservationTransaction(h.request);
    const restored = JSON.parse(JSON.stringify(prepared));
    const modified = Transaction.fromHex(restored.txHex, networks.verus);
    modified.outs[1].value -= 100000000;
    restored.nativeFee = String(Number(restored.nativeFee) + 100000000);
    restored.outputPlan[1].value = String(modified.outs[1].value);
    restored.outputPlan[1].values[SYSTEM] = restored.outputPlan[1].value;
    restored.txHex = restored.hex = modified.toHex();
    // Value conservation alone succeeds; the retained quote must still prevent overpayment.
    expect(() =>
      h.client.signIdentityRegistrationTransaction({
        transaction: restored,
        keys: [["not-a-WIF"]],
      })
    ).toThrow("fee differs from the approved quote");
  });

  test("builds, signs, confirms and reveals a native identity from verified funding", async () => {
    const h = harness();
    const { commitment, tx, reveal } = await commitAndConfirm(h);
    expect(tx.outs[commitment.commitmentVout].value).toBe(0);
    expect(commitment.transaction.txHex).not.toContain(
      h.request.salt.toString("hex")
    );
    const restored = AdvancedNameReservation.fromHex(
      commitment.reservation.reservationHex
    );
    expect(restored.name).toBe("Alice");
    const prepared = await h.client.createIdentityRegistrationTransaction(
      reveal
    );
    expect(prepared.outputPlan.map((output) => output.role)).toEqual([
      "identity",
      "reservation",
      "change",
    ]);
    expect(prepared.prevouts[0]).toMatchObject({
      txid: tx.getId(),
      vout: 0,
      value: "0",
      confirmations: 1,
    });
    expect(prepared.nativeFee).toBe("100000000");
    const signed = h.client.signIdentityRegistrationTransaction({
      transaction: prepared,
      keys: prepared.prevouts.map(() => [wif]),
    });
    expect(signed.signingStatus).toBe("complete");
    expect(
      h.client.validateIdentityRegistrationTransaction(prepared, signed.txHex)
    ).toMatchObject({ valid: true, signingStatus: "complete" });
    expect(
      h.client.inspectIdentityRegistrationSignatures({
        ...prepared,
        txHex: signed.txHex,
      }).signingStatus
    ).toBe("complete");
    const registered = Transaction.fromHex(signed.txHex, networks.verus);
    const identityScript = new IdentityScript();
    identityScript.fromBuffer(registered.outs[0].script);
    expect(identityScript.getIdentity().getIdentityAddress()).toBe(
      commitment.reservation.identityAddress
    );
    const reservationScript = new IdentityReservationScript();
    reservationScript.fromBuffer(registered.outs[1].script);
    expect(reservationScript.getReservation().toBuffer().toString("hex")).toBe(
      commitment.reservation.reservationHex
    );
    expect(h.calls).not.toContain("sendrawtransaction");
    expect(h.calls).not.toContain("registernamecommitment");
    expect(h.calls).not.toContain("registeridentity");
  });

  test.each([
    [1, "burn"],
    [2, "issuer-payment"],
  ])(
    "registers a plain token subidentity using proof %s",
    async (proof, role) => {
      const h = harness(proof as number);
      const { commitment, reveal } = await commitAndConfirm(h);
      expect(commitment.reservation.parentID).toBe(TOKEN);
      const prepared = await h.client.createIdentityRegistrationTransaction(
        reveal
      );
      expect(prepared.outputPlan.map((output) => output.role)).toEqual([
        "identity",
        role,
        "reservation",
        "change",
      ]);
      expect(prepared.nativeFee).toBe("1000000");
      expect(prepared.outputPlan[1].values[TOKEN]).toBe("100000000");
      expect(prepared.outputPlan[1].value).toBe(proof === 1 ? "20000" : "0");
      if (proof === 1) {
        const smart = new SmartTransactionScript();
        smart.fromBuffer(Buffer.from(prepared.outputPlan[1].scriptHex, "hex"));
        const transfer = new ReserveTransfer();
        transfer.fromBuffer(smart.paramsOptCC.getParamObject()!);
        expect(transfer.firstCurrency()).toBe(TOKEN);
        expect(transfer.firstValue()!.toString()).toBe("100000000");
      }
      const signed = h.client.signIdentityRegistrationTransaction({
        transaction: prepared,
        keys: prepared.prevouts.map(() => [wif]),
      });
      expect(signed.signingStatus).toBe("complete");
      expect(
        h.client.validateIdentityRegistrationTransaction(prepared, signed.txHex)
      ).toMatchObject({ valid: true, signingStatus: "complete" });
    }
  );

  test("preserves the issuer reserve output and all change for a zero-price token namespace", async () => {
    const h = harness(2);
    h.token.idregistrationfees = 0;
    const { reveal } = await commitAndConfirm(h);
    const prepared = await h.client.createIdentityRegistrationTransaction(
      reveal
    );
    expect(prepared.quote.registrationOffer).toBe("0");
    expect(prepared.nativeFee).toBe("1000000");
    expect(prepared.outputPlan.map((output) => output.role)).toEqual([
      "identity",
      "issuer-payment",
      "reservation",
      "change",
    ]);
    const issuerScript = new SmartTransactionScript();
    issuerScript.fromBuffer(
      Buffer.from(prepared.outputPlan[1].scriptHex, "hex")
    );
    expect(issuerScript.paramsOptCC.evalCode.toNumber()).toBe(
      EVALS.EVAL_RESERVE_OUTPUT
    );
    // CTokenOutput single-currency encoding is version VARINT, raw uint160,
    // amount VARINT. Both the constructor and C++ validity permit zero atoms.
    expect(issuerScript.paramsOptCC.getParamObject()!.toString("hex")).toBe(
      "01" + IdentityID.fromAddress(TOKEN).toBuffer().toString("hex") + "00"
    );
    expect(prepared.outputPlan[3].values[TOKEN]).toBe("200000000");
    expect(prepared.outputPlan[3].value).toBe("198990000");
    const signed = h.client.signIdentityRegistrationTransaction({
      transaction: prepared,
      keys: prepared.prevouts.map(() => [wif]),
    });
    expect(signed.signingStatus).toBe("complete");
    expect(
      h.client.validateIdentityRegistrationTransaction(prepared, signed.txHex)
    ).toMatchObject({
      valid: true,
      signingStatus: "complete",
    });
  });

  test("registers a restricted subidentity by merging controller and two issuer signatures on the commitment", async () => {
    const h = harness(2);
    const issuerKeys = [8, 9].map((value) =>
      ECPair.fromPrivateKeyBuffer(Buffer.alloc(32, value), networks.verus)
    );
    h.token.options |= CurrencyOptions.ID_ISSUANCE;
    h.addAuthority("community", SYSTEM, issuerKeys, 2, 1);
    const { commitment, reveal } = await commitAndConfirm(h);
    expect(commitment.reservation.authorizationID).toBe(TOKEN);
    expect(commitment.transaction.revealAuthorities).toEqual([
      {
        identityID: TOKEN,
        primaryAddresses: issuerKeys.map((pair) => pair.getAddress()),
        minimumSignatures: 2,
        revoked: false,
      },
    ]);
    const prepared = await h.client.createIdentityRegistrationTransaction(
      reveal
    );
    expect(prepared.requiredSignatures[0].threshold).toBe(2);
    expect(
      prepared.requiredSignatures[0].requirements.map(
        (requirement) => requirement.threshold
      )
    ).toEqual([1, 2]);
    const controller = h.client.signIdentityRegistrationTransaction({
      transaction: prepared,
      keys: [[wif], [wif]],
    });
    const firstIssuer = h.client.signIdentityRegistrationTransaction({
      transaction: prepared,
      keys: [[issuerKeys[0].toWIF()], []],
    });
    const secondIssuer = h.client.signIdentityRegistrationTransaction({
      transaction: prepared,
      keys: [[issuerKeys[1].toWIF()], []],
    });
    expect(controller.signingStatus).toBe("partial");
    expect(
      h.client.validateIdentityRegistrationTransaction(
        prepared,
        firstIssuer.txHex
      )
    ).toMatchObject({ valid: true, signingStatus: "partial" });
    const merged = h.client.mergeIdentityRegistrationTransactions({
      transaction: prepared,
      partialTransactions: [
        controller.txHex,
        firstIssuer.txHex,
        secondIssuer.txHex,
      ],
    });
    expect(merged.signingStatus).toBe("complete");
    expect(
      merged.inputs[0].requirements.map(
        (requirement) => requirement.missingSignatures
      )
    ).toEqual([0, 0]);
    expect(
      h.client.validateIdentityRegistrationTransaction(prepared, merged.txHex)
    ).toMatchObject({ valid: true, signingStatus: "complete" });
  });

  test("rejects spoofed issuer thresholds and locked issuers before paying the commitment fee", async () => {
    const h = harness(2);
    const issuerKeys = [8, 9].map((value) =>
      ECPair.fromPrivateKeyBuffer(Buffer.alloc(32, value), networks.verus)
    );
    h.token.options |= CurrencyOptions.ID_ISSUANCE;
    const evidence = h.addAuthority("community", SYSTEM, issuerKeys, 2, 1);
    evidence.identity.minimumsignatures = 1;
    await expect(
      h.client.createNameReservationTransaction(h.request)
    ).rejects.toMatchObject({ code: "AUTHORITY_MISMATCH" });
    h.addAuthority("community", SYSTEM, issuerKeys, 2, 3);
    await expect(
      h.client.createNameReservationTransaction(h.request)
    ).rejects.toMatchObject({ code: "LOCKED_AUTHORITY" });
  });

  test("rejects altered reservation metadata and identity name bytes", async () => {
    const h = harness();
    const { reveal } = await commitAndConfirm(h);
    await expect(
      h.client.createIdentityRegistrationTransaction({
        ...reveal,
        reservation: {
          ...reveal.reservation,
          commitmentHashHex: "ab".repeat(32),
        },
      })
    ).rejects.toMatchObject({ code: "RESERVATION_MISMATCH" });
    await expect(
      h.client.createIdentityRegistrationTransaction({
        ...reveal,
        identity: { ...h.identity, name: "alice" },
      })
    ).rejects.toThrow("exactly match reserved name");
  });

  test("rejects source substitution, spent commitment and active-chain mismatch", async () => {
    const h = harness();
    const { reveal, tx } = await commitAndConfirm(h);
    const altered = tx.clone();
    altered.locktime = 1;
    await expect(
      h.client.createIdentityRegistrationTransaction({
        ...reveal,
        commitment: { ...reveal.commitment, rawTransaction: altered.toHex() },
      })
    ).rejects.toMatchObject({ code: "PREVOUT_MISMATCH" });
    h.spent.add(`${tx.getId()}:0`);
    await expect(
      h.client.createIdentityRegistrationTransaction(reveal)
    ).rejects.toMatchObject({ code: "COMMITMENT_SPENT" });
    h.spent.delete(`${tx.getId()}:0`);
    h.setMissingCommitmentBlock();
    await expect(
      h.client.createIdentityRegistrationTransaction(reveal)
    ).rejects.toMatchObject({ code: "COMMITMENT_REORGED" });
  });

  test("requires confirmed commitment and a consistent tip", async () => {
    const h = harness();
    const { reveal, tx } = await commitAndConfirm(h);
    h.transactions.get(tx.getId())!.height = 0;
    await expect(
      h.client.createIdentityRegistrationTransaction(reveal)
    ).rejects.toMatchObject({ code: "COMMITMENT_UNCONFIRMED" });
    h.transactions.get(tx.getId())!.height = 101;
    h.setStaleUnspent();
    await expect(
      h.client.createIdentityRegistrationTransaction(reveal)
    ).rejects.toMatchObject({ code: "STALE_CHAIN_CONTEXT" });
  });

  test("refreshes pricing and authorization while enforcing the approved budget", async () => {
    const h = harness();
    const { reveal } = await commitAndConfirm(h);
    h.native.idregistrationfees = 3;
    await expect(
      h.client.createIdentityRegistrationTransaction(reveal)
    ).rejects.toMatchObject({ code: "COST_LIMIT_EXCEEDED" });
    h.native.idregistrationfees = 1;
    h.native.options |= CurrencyOptions.ID_ISSUANCE;
    await expect(
      h.client.createIdentityRegistrationTransaction(reveal)
    ).rejects.toMatchObject({ code: "POLICY_CHANGED" });
  });

  test("stops commitment creation on lookup errors or insufficient whole-operation approval", async () => {
    const h = harness();
    h.setIdentityError({ code: -32603, message: "Address index unavailable" });
    await expect(
      h.client.createNameReservationTransaction(h.request)
    ).rejects.toMatchObject({ code: "RPC_ERROR" });
    h.setIdentityError(undefined);
    await expect(
      h.client.createNameReservationTransaction({
        ...h.request,
        approvedCosts: { [SYSTEM]: "10000" },
      })
    ).rejects.toMatchObject({ code: "COST_LIMIT_EXCEEDED" });
  });

  test("keeps centralized token-payment expiry before its end-block policy change", async () => {
    const h = harness(2);
    h.token.endblock = 110;
    const resolved = await h.client.resolveIdentityRegistration(h.request);
    expect(resolved.policy.branch).toBe("token-payment");
    expect(resolved.snapshot.expiryHeight).toBe(109);
    h.token.endblock = 104;
    await expect(
      h.client.resolveIdentityRegistration(h.request)
    ).rejects.toMatchObject({ code: "UNSUPPORTED_POLICY_BOUNDARY" });
    h.token.endblock = 99;
    expect(
      (await h.client.resolveIdentityRegistration(h.request)).policy.branch
    ).toBe("token-burn");
  });

  test("rejects changes to a signed transaction after the prepared plan is approved", async () => {
    const h = harness();
    const { reveal } = await commitAndConfirm(h);
    const prepared = await h.client.createIdentityRegistrationTransaction(
      reveal
    );
    const modified = Transaction.fromHex(prepared.txHex, networks.verus);
    modified.outs[modified.outs.length - 1].value -= 1;
    expect(() =>
      h.client.validateIdentityRegistrationTransaction(
        prepared,
        modified.toHex()
      )
    ).toThrow("differs from the approved registration plan");
    const partial = h.client.signIdentityRegistrationTransaction({
      transaction: prepared,
      keys: [[wif], []],
    });
    expect(
      h.client.validateIdentityRegistrationTransaction(prepared, partial.txHex)
    ).toMatchObject({ valid: true, signingStatus: "partial" });
    const broken = Transaction.fromHex(partial.txHex, networks.verus);
    broken.ins[0].script[broken.ins[0].script.length - 1] ^= 1;
    expect(() =>
      h.client.validateIdentityRegistrationTransaction(prepared, broken.toHex())
    ).toThrow();
  });
});

// Use real reserve scripts so their serialized sizes, change and signatures
// exercise the public builder without sharing its relay-fee calculation.
function reserveFunding(
  h: ReturnType<typeof harness>,
  sources: Array<{ currencies: number; native: number }>
) {
  let nextCurrency = 1;
  h.transactions.clear();
  h.request.funding = sources.map(({ currencies, native }, index) => {
    const values: Record<string, string> = { [SYSTEM]: String(native) };
    for (let i = 0; i < currencies; i++) {
      const id = Buffer.alloc(20, 0x42);
      id.writeUInt32LE(nextCurrency++, 0);
      values[new IdentityID(id).toAddress()!] = "1";
    }
    const output = paymentOutput(address, values, SYSTEM, "change");
    const builder = new TransactionBuilder(networks.verus);
    builder.setVersion(4);
    builder.setVersionGroupId(0x892f2085);
    builder.setExpiryHeight(500);
    builder.addInput(Buffer.alloc(32, index + 60), 0);
    builder.addOutput(Buffer.from(output.scriptHex, "hex"), native);
    const tx = builder.buildIncomplete();
    h.transactions.set(tx.getId(), { tx, height: 10 });
    return { txid: tx.getId(), vout: 0 };
  });
}

describe("registration relay fees", () => {
  test.each([
    [69, 1999, "10000"],
    [70, 2027, "20000"],
    [140, 3987, "20000"],
    [141, 4015, "30000"],
  ])(
    "prices %i-currency commitment change from its actual script",
    async (count, size, fee) => {
      const h = harness();
      reserveFunding(h, [{ currencies: count as number, native: 200000000 }]);
      const { transaction } = await h.client.createNameReservationTransaction(
        h.request
      );
      const change = transaction.outputPlan.find(
        (output) => output.role === "change"
      )!;
      expect(Buffer.from(change.scriptHex, "hex").length).toBe(size);
      expect(transaction.nativeFee).toBe(fee);
      expect(transaction.quote.commitmentFee).toBe(fee);
      expect(transaction.quote.totalOperationRequired[SYSTEM]).toBe(
        String(100000000 + Number(fee))
      );
      expect(transaction.quote.nativeFee).toBe("100000000");
      expect(change.value).toBe(String(200000000 - Number(fee)));
      const signed = h.client.signIdentityRegistrationTransaction({
        transaction,
        keys: transaction.prevouts.map(() => [wif]),
      });
      expect(
        h.client.validateIdentityRegistrationTransaction(
          transaction,
          signed.hex
        )
      ).toMatchObject({ valid: true, signingStatus: "complete" });
    }
  );

  test("preserves an explicitly approved higher commitment fee", async () => {
    const h = harness();
    reserveFunding(h, [{ currencies: 75, native: 200000000 }]);
    const { transaction } = await h.client.createNameReservationTransaction({
      ...h.request,
      commitmentFee: "50000",
    });
    expect(transaction.nativeFee).toBe("50000");
    expect(transaction.quote.totalOperationRequired[SYSTEM]).toBe("100050000");
  });

  test("applies the base fee before selecting funding for a zero-fee request", async () => {
    const h = harness();
    const { transaction } = await h.client.createNameReservationTransaction({
      ...h.request,
      commitmentFee: "0",
    });
    expect(transaction.nativeFee).toBe("10000");
    expect(transaction.quote.totalOperationRequired[SYSTEM]).toBe("100010000");
  });

  test("retains the paid commitment fee in the reveal's combined quote", async () => {
    const h = harness();
    reserveFunding(h, [{ currencies: 75, native: 200000000 }]);
    const { commitment, reveal } = await commitAndConfirm(h);
    const prepared = await h.client.createIdentityRegistrationTransaction({
      ...reveal,
      commitmentFee: commitment.transaction.quote.commitmentFee,
    });
    expect(prepared.quote.commitmentFee).toBe("20000");
    expect(prepared.quote.totalOperationRequired[SYSTEM]).toBe("100020000");
    expect(prepared.nativeFee).toBe("100000000");
    expect(prepared.quote.totalRequired[SYSTEM]).toBe("100000000");
  });

  test("returns the final quote when additional funding raises the fee twice", async () => {
    const h = harness();
    reserveFunding(h, [
      { currencies: 75, native: 10000 },
      { currencies: 75, native: 10000 },
      { currencies: 0, native: 200000000 },
    ]);
    let rejected: any;
    try {
      await h.client.createNameReservationTransaction({
        ...h.request,
        approvedCosts: { [SYSTEM]: "100010000" },
      });
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toMatchObject({
      code: "COST_LIMIT_EXCEEDED",
      details: {
        quote: { commitmentFee: "30000" },
        requiredCosts: { [SYSTEM]: "100030000" },
      },
    });
    const { transaction } = await h.client.createNameReservationTransaction({
      ...h.request,
      approvedCosts: rejected.details.requiredCosts,
    });
    expect(transaction.prevouts).toHaveLength(3);
    expect(transaction.nativeFee).toBe("30000");
    expect(transaction.quote).toEqual(rejected.details.quote);
    expect(h.calls).not.toContain("sendrawtransaction");
  });

  test("rechecks funding for both stages after increasing the commitment fee", async () => {
    const h = harness();
    reserveFunding(h, [{ currencies: 75, native: 100010000 }]);
    await expect(
      h.client.createNameReservationTransaction(h.request)
    ).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
  });

  test("rejects an older prepared commitment whose fee is below the relay floor", async () => {
    const h = harness();
    reserveFunding(h, [{ currencies: 75, native: 200000000 }]);
    const { transaction } = await h.client.createNameReservationTransaction(
      h.request
    );
    const stale = JSON.parse(JSON.stringify(transaction));
    const tx = Transaction.fromHex(stale.txHex, networks.verus);
    tx.outs[1].value += 10000;
    stale.txHex = stale.hex = tx.toHex();
    stale.outputPlan[1].value = String(tx.outs[1].value);
    stale.outputPlan[1].values[SYSTEM] = String(tx.outs[1].value);
    stale.nativeFee = stale.quote.commitmentFee = "10000";
    stale.quote.totalOperationRequired[SYSTEM] = "100010000";
    expect(() =>
      h.client.signIdentityRegistrationTransaction({
        transaction: stale,
        keys: [["invalid-wif"]],
      })
    ).toThrow(expect.objectContaining({ code: "INSUFFICIENT_RELAY_FEE" }));
  });

  test("quotes a reveal's identity fee factor without raising an approved cap", async () => {
    const h = harness(2);
    const { reveal } = await commitAndConfirm(h);
    const recipient = require("./fixtures/local-upload/public-recipient.json");
    const identity = Identity.fromJson(h.identity);
    identity.privateAddresses = Array.from({ length: 110 }, () =>
      SaplingPaymentAddress.fromAddressString(recipient.address)
    );
    let rejected: any;
    try {
      await h.client.createIdentityRegistrationTransaction({
        ...reveal,
        identity,
        approvedCosts: { [SYSTEM]: "1000000", [TOKEN]: "100000000" },
      });
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toMatchObject({
      code: "COST_LIMIT_EXCEEDED",
      details: {
        quote: {
          nativeFee: "1090000",
          importFee: "1000000",
          registrationOffer: "100000000",
          totalRequired: { [SYSTEM]: "1090000", [TOKEN]: "100000000" },
          totalOperationRequired: { [SYSTEM]: "1100000", [TOKEN]: "100000000" },
        },
        requiredCosts: { [SYSTEM]: "1090000", [TOKEN]: "100000000" },
      },
    });
    const prepared = await h.client.createIdentityRegistrationTransaction({
      ...reveal,
      identity,
      approvedCosts: rejected.details.requiredCosts,
    });
    expect(prepared.nativeFee).toBe("1090000");
    const signed = h.client.signIdentityRegistrationTransaction({
      transaction: prepared,
      keys: prepared.prevouts.map(() => [wif]),
    });
    expect(
      h.client.validateIdentityRegistrationTransaction(prepared, signed.hex)
    ).toMatchObject({ valid: true, signingStatus: "complete" });
  });

  test.each([undefined, 2])(
    "applies the base relay floor to low-price reveals (%s)",
    async (proof) => {
      const h = harness(proof);
      if (proof) h.native.idimportfees = 0.00001;
      else h.native.idregistrationfees = 0.00001;
      const { reveal } = await commitAndConfirm(h);
      const prepared = await h.client.createIdentityRegistrationTransaction(
        reveal
      );
      expect(prepared.nativeFee).toBe("10000");
      expect(prepared.quote.totalRequired[SYSTEM]).toBe("10000");
      expect(prepared.quote.totalOperationRequired[SYSTEM]).toBe("20000");
      expect(prepared.quote.importFee).toBe(proof ? "1000" : "0");
      expect(prepared.quote.registrationOffer).toBe(
        proof ? "100000000" : "1000"
      );
    }
  );
});
