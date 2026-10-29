import BN from "bn.js";
import { Transaction, networks } from "@bitgo/utxo-lib";
import {
  AdvancedNameReservation,
  CurrencyOptions,
  Identity,
  IdentityID,
  IdentityReservationScript,
  IdentityScript,
  KeyID,
  nameAndParentAddrToIAddr,
  OptCCParams,
  SmartTransactionScript,
  TxDestination,
  EVALS,
} from "verus-typescript-primitives";
import {
  assertIdentityRegistrationAvailable,
  quoteIdentityRegistration,
  RegistrationPolicyRequest,
  resolveIdentityRegistrationPolicy,
} from "../identity/registrationPolicy";

const systemID = nameAndParentAddrToIAddr("VRSC");
const parentID = nameAndParentAddrToIAddr("community", systemID);
const referralID = nameAndParentAddrToIAddr("Referrer", systemID);
const nullID = new IdentityID(Buffer.alloc(20)).toAddress();
const primary = new KeyID(Buffer.alloc(20, 1));
const ok = (result: unknown) => ({ result, error: null, id: 1 });
const missing = () => ({
  result: null,
  error: { code: -5, message: "Identity not found" },
  id: 1,
});
const nativeDefinition = (patch: Record<string, unknown> = {}) => ({
  version: 1,
  currencyid: systemID,
  name: "VRSC",
  parent: nullID,
  systemid: systemID,
  options: CurrencyOptions.PBAAS | CurrencyOptions.ID_REFERRALS,
  proofprotocol: 1,
  startblock: 0,
  endblock: 0,
  idregistrationfees: 100,
  idreferrallevels: 3,
  idimportfees: 0.01,
  ...patch,
});
const tokenDefinition = (patch: Record<string, unknown> = {}) => ({
  ...nativeDefinition(),
  currencyid: parentID,
  name: "community",
  parent: systemID,
  options: CurrencyOptions.TOKEN,
  proofprotocol: 2,
  ...patch,
});
const request: RegistrationPolicyRequest = {
  name: "Alice",
  rootSystemName: "VRSC",
  systemID,
  candidateHeight: 100,
};
function identityJSON(name: string, parent = systemID) {
  const id = nameAndParentAddrToIAddr(name, parent);
  return {
    name,
    parent,
    systemid: systemID,
    identityaddress: id,
    version: 3,
    flags: 0,
    primaryaddresses: [primary.toAddress()],
    minimumsignatures: 1,
  };
}

function mockRpc(parent = nativeDefinition()) {
  return {
    getCurrency: jest.fn(async (id: string) =>
      ok(id === parent.currencyid ? parent : nativeDefinition())
    ),
    getIdentity: jest.fn(
      async (_id: string, _height?: number): Promise<unknown> => missing()
    ),
    getIdentityHistory: jest.fn(
      async (_id: string, _start?: number, _end?: number): Promise<unknown> => {
        throw new Error("Unexpected history request");
      }
    ),
    getRawTransaction: jest.fn(
      async (_txid: string, _verbose?: number): Promise<unknown> => {
        throw new Error("Unexpected raw transaction request");
      }
    ),
    getBlock: jest.fn(
      async (_hash: string, _verbosity?: number): Promise<unknown> => {
        throw new Error("Unexpected block request");
      }
    ),
  };
}

function referralFixture(ancestors: string[] = []) {
  const identity = new Identity({
    version: new BN(3),
    flags: new BN(0),
    minSigs: new BN(1),
    primaryAddresses: [primary],
    name: "Referrer",
    parent: IdentityID.fromAddress(systemID),
    systemId: IdentityID.fromAddress(systemID),
    revocationAuthority: IdentityID.fromAddress(referralID),
    recoveryAuthority: IdentityID.fromAddress(referralID),
    unlockAfter: new BN(0),
  });
  const tx = new Transaction(networks.verus);
  tx.addInput(Buffer.alloc(32, 1), 0);
  tx.addOutput(IdentityScript.fromIdentity(identity).toBuffer(), 0);
  for (const ancestor of ancestors) {
    const params = new OptCCParams({
      version: new BN(3),
      evalCode: new BN(EVALS.EVAL_NONE),
      m: new BN(1),
      n: new BN(1),
      destinations: [new TxDestination(IdentityID.fromAddress(ancestor))],
      vData: [],
    });
    tx.addOutput(
      new SmartTransactionScript(params, params).toBuffer(),
      2000000000
    );
  }
  tx.addOutput(
    IdentityReservationScript.fromReservation(
      new AdvancedNameReservation({
        name: "Referrer",
        parent: IdentityID.fromAddress(systemID),
        salt: Buffer.alloc(32, 2),
      })
    ).toBuffer(),
    0
  );
  const rpc = mockRpc();
  rpc.getIdentity.mockImplementation(async (id) =>
    id === referralID ? ok({ identity: identityJSON("Referrer") }) : missing()
  );
  rpc.getIdentityHistory.mockResolvedValue(
    ok({
      history: [
        {
          identity: identityJSON("Referrer"),
          height: 50,
          blockhash: "ab".repeat(32),
          output: { txid: tx.getId(), voutnum: 0 },
        },
      ],
    })
  );
  rpc.getRawTransaction.mockResolvedValue(ok(tx.toHex()));
  rpc.getBlock.mockResolvedValue(
    ok({
      hash: "ab".repeat(32),
      height: 50,
      confirmations: 50,
      tx: [tx.getId()],
    })
  );
  return { rpc, tx };
}

describe("identity registration namespace policy and quotes", () => {
  test("resolves the exact leaf and prices native registration using atomic integers", async () => {
    const policy = await resolveIdentityRegistrationPolicy(mockRpc(), request);
    expect(policy.resolvedName).toMatchObject({
      name: "Alice",
      parent: systemID,
      fullName: "Alice.VRSC@",
    });
    expect(quoteIdentityRegistration(policy)).toMatchObject({
      branch: "native",
      registrationOffer: "10000000000",
      nativeFee: "10000000000",
      commitmentFee: "10000",
      importFee: "0",
      transferFee: "0",
      totalRequired: { [systemID]: "10000000000" },
      totalOperationRequired: { [systemID]: "10000010000" },
    });
  });

  test.each([
    [2, "token-payment", "0", "1000000"],
    [1, "token-burn", "20000", "1020000"],
  ])(
    "separates token payment, import fee and burn transfer cost for proof %s",
    async (proofprotocol, branch, transferFee, nativeTotal) => {
      const policy = await resolveIdentityRegistrationPolicy(
        mockRpc(tokenDefinition({ proofprotocol })),
        {
          ...request,
          name: "Alice.community@",
        }
      );
      expect(quoteIdentityRegistration(policy)).toMatchObject({
        branch,
        nativeFee: "1000000",
        importFee: "1000000",
        transferFee,
        issuerPayment: {
          currencyID: parentID,
          recipient: parentID,
          amount: "10000000000",
        },
        totalRequired: { [systemID]: nativeTotal, [parentID]: "10000000000" },
      });
    }
  );

  test("requires issuer authorization before collecting a commitment fee", async () => {
    const rpc = mockRpc(
      tokenDefinition({
        options:
          CurrencyOptions.TOKEN |
          CurrencyOptions.ID_ISSUANCE |
          CurrencyOptions.ID_REFERRALREQUIRED,
      })
    );
    rpc.getIdentity.mockImplementation(async (id) =>
      id === parentID ? ok({ identity: identityJSON("community") }) : missing()
    );
    const policy = await resolveIdentityRegistrationPolicy(rpc, {
      ...request,
      name: "Alice.community@",
    });
    expect(policy.requiredAuthorityID).toBe(parentID);
    expect(policy.requiredAuthority!.identityaddress).toBe(parentID);
  });

  test("referral-required authorization with zero economic levels does not discount the price", async () => {
    const definition = nativeDefinition({
      options: CurrencyOptions.PBAAS | CurrencyOptions.ID_REFERRALREQUIRED,
      idreferrallevels: 0,
    });
    const rpc = mockRpc(definition);
    rpc.getIdentity.mockImplementation(async (id) =>
      id === referralID ? ok({ identity: identityJSON("Referrer") }) : missing()
    );
    await expect(
      resolveIdentityRegistrationPolicy(rpc, request)
    ).rejects.toMatchObject({ code: "REFERRAL_REQUIRED" });
    const policy = await resolveIdentityRegistrationPolicy(rpc, {
      ...request,
      referralID,
    });
    expect(policy.requiredAuthorityID).toBe(referralID);
    expect(quoteIdentityRegistration(policy).registrationOffer).toBe(
      "10000000000"
    );
    expect(quoteIdentityRegistration(policy).referralPayments).toEqual([]);
  });

  test("reconstructs ordered referral ancestry from the original transaction and discounts once", async () => {
    const ancestor = nameAndParentAddrToIAddr("Ancestor", systemID);
    const secondAncestor = nameAndParentAddrToIAddr("SecondAncestor", systemID);
    const { rpc } = referralFixture([ancestor, secondAncestor]);
    const policy = await resolveIdentityRegistrationPolicy(rpc, {
      ...request,
      referralID,
      commitmentHeight: 80,
    });
    expect(rpc.getIdentity).toHaveBeenCalledWith(referralID, 79);
    expect(rpc.getIdentityHistory).toHaveBeenCalledWith(referralID, 0, 79);
    expect(policy.referralRecipients).toEqual([
      referralID,
      ancestor,
      secondAncestor,
    ]);
    expect(quoteIdentityRegistration(policy)).toMatchObject({
      registrationOffer: "8000000000",
      nativeFee: "2000000000",
      referralPayments: [referralID, ancestor, secondAncestor].map(
        (recipient) => ({
          recipient,
          currencyID: systemID,
          amount: "2000000000",
        })
      ),
      totalRequired: { [systemID]: "8000000000" },
    });
  });

  test("preserves each integer division when calculating non-divisible referral prices", async () => {
    const { rpc } = referralFixture();
    rpc.getCurrency.mockResolvedValue(
      ok(nativeDefinition({ idregistrationfees: "0.00000101" }))
    );
    const policy = await resolveIdentityRegistrationPolicy(rpc, {
      ...request,
      referralID,
      commitmentHeight: 80,
    });
    expect(quoteIdentityRegistration(policy)).toMatchObject({
      registrationOffer: "80",
      nativeFee: "60",
      referralPayments: [{ amount: "20" }],
    });
    expect(() => quoteIdentityRegistration(policy, { offer: "79" })).toThrow(
      "below"
    );
  });

  test.each([
    [
      CurrencyOptions.TOKEN | CurrencyOptions.NO_IDS,
      "NAMESPACE_DISALLOWS_IDENTITIES",
    ],
    [
      CurrencyOptions.TOKEN | CurrencyOptions.NFT_TOKEN,
      "NAMESPACE_DISALLOWS_IDENTITIES",
    ],
    [
      CurrencyOptions.TOKEN | CurrencyOptions.FRACTIONAL,
      "UNSUPPORTED_NAMESPACE",
    ],
    [CurrencyOptions.GATEWAY, "UNSUPPORTED_NAMESPACE"],
  ])(
    "rejects unsupported currency options %s before availability/funding",
    async (options, code) => {
      const rpc = mockRpc(tokenDefinition({ options }));
      await expect(
        resolveIdentityRegistrationPolicy(rpc, {
          ...request,
          name: "Alice.community@",
        })
      ).rejects.toMatchObject({ code });
      expect(rpc.getIdentity).not.toHaveBeenCalled();
    }
  );

  test("rejects native centralized-payment accounting and currency lifetime boundary", async () => {
    await expect(
      resolveIdentityRegistrationPolicy(
        mockRpc(nativeDefinition({ proofprotocol: 2 })),
        request
      )
    ).rejects.toMatchObject({ code: "UNSUPPORTED_NAMESPACE" });
    await expect(
      resolveIdentityRegistrationPolicy(
        mockRpc(tokenDefinition({ endblock: 100 })),
        { ...request, name: "Alice.community@" }
      )
    ).rejects.toMatchObject({ code: "UNSUPPORTED_POLICY_BOUNDARY" });
  });

  test("rejects wrong-system namespaces and mismatched name-derived currency addresses", async () => {
    await expect(
      resolveIdentityRegistrationPolicy(
        mockRpc(tokenDefinition({ systemid: referralID })),
        { ...request, name: "Alice.community@" }
      )
    ).rejects.toMatchObject({ code: "WRONG_REGISTRATION_SYSTEM" });
    await expect(
      resolveIdentityRegistrationPolicy(
        mockRpc(nativeDefinition({ name: "WrongName" })),
        request
      )
    ).rejects.toMatchObject({ code: "LOOKUP_MISMATCH" });
  });

  test("only exact daemon absence counts as available, including revoked-name protection", async () => {
    const rpc = mockRpc();
    const id = nameAndParentAddrToIAddr("Alice", systemID);
    await expect(
      assertIdentityRegistrationAvailable(rpc, id)
    ).resolves.toBeUndefined();
    rpc.getIdentity.mockResolvedValue({
      result: null,
      error: { code: -5, message: "Address index unavailable" },
    });
    await expect(
      assertIdentityRegistrationAvailable(rpc, id)
    ).rejects.toMatchObject({ code: "RPC_ERROR" });
    rpc.getIdentity.mockResolvedValue(ok(null));
    await expect(
      assertIdentityRegistrationAvailable(rpc, id)
    ).rejects.toMatchObject({ code: "INVALID_RPC_RESPONSE" });
    rpc.getIdentity.mockResolvedValue(
      ok({ identity: { ...identityJSON("Alice"), flags: 0x8000 } })
    );
    await expect(
      assertIdentityRegistrationAvailable(rpc, id)
    ).rejects.toMatchObject({ code: "IDENTITY_EXISTS" });
  });

  test("rejects source transaction substitution and stale-chain referral history", async () => {
    const { rpc, tx } = referralFixture();
    tx.locktime = 1;
    rpc.getRawTransaction.mockResolvedValue(ok(tx.toHex()));
    await expect(
      resolveIdentityRegistrationPolicy(rpc, {
        ...request,
        referralID,
        commitmentHeight: 80,
      })
    ).rejects.toMatchObject({ code: "LOOKUP_MISMATCH" });
    const other = referralFixture().rpc;
    other.getBlock.mockResolvedValue(
      ok({ hash: "ab".repeat(32), height: 50, confirmations: -1, tx: [] })
    );
    await expect(
      resolveIdentityRegistrationPolicy(other, {
        ...request,
        referralID,
        commitmentHeight: 80,
      })
    ).rejects.toMatchObject({ code: "REFERRAL_NOT_CONFIRMED" });
  });

  test("a referrer first registered in the commitment block is too new", async () => {
    const { rpc } = referralFixture();
    await expect(
      resolveIdentityRegistrationPolicy(rpc, {
        ...request,
        referralID,
        commitmentHeight: 50,
      })
    ).rejects.toMatchObject({ code: "REFERRAL_TOO_NEW" });
  });
});
