import {BN} from 'bn.js';
import {ECPair, Transaction, networks, smarttxs} from '@bitgo/utxo-lib';
import {Identity, IdentityScript, TransferDestination, DEST_ID, DEST_PKH, fromBase58Check,
  SmartTransactionScript, OptCCParams, TxDestination, IdentityID, EVALS, TokenOutput, CurrencyValueMap,
  nameAndParentAddrToIAddr, IdentityUpdateRequestDetails, PartialIdentity, SaplingPaymentAddress, ReserveTransfer, KeyID} from 'verus-typescript-primitives';
import {VerusIdInterface, verifyIdentityUpdateFunding, IdentityUpdateFundingApproval} from '../index';
import {TEST_ID_3, VERUSTEST_I_ADDR} from './fixtures/verusid';
import {defaultIdentityUpdateFeeCap, identityUpdateFeeCap} from '../identity/updateFundingVerification';
import { IDENTITY_FLAG_ACTIVECURRENCY, IDENTITY_FLAG_TOKENIZED_CONTROL, IDENTITY_FLAG_REVOKED, IDENTITY_FLAG_LOCKED, IDENTITY_MAX_UNLOCK_DELAY } from 'verus-typescript-primitives';

const CHAIN = VERUSTEST_I_ADDR;
const SUBJECT = TEST_ID_3.identity.identityaddress;
const CHANGE = nameAndParentAddrToIAddr('fee-source', CHAIN);
const TOKEN = nameAndParentAddrToIAddr('token', CHAIN);
const OTHER = nameAndParentAddrToIAddr('other-token', CHAIN);
const key = ECPair.fromPrivateKeyBuffer(Buffer.alloc(32, 17), networks.verus);
const MAIN = key.getAddress();
const HEIGHT = 30000;
type Values = {[id: string]: string};
const destination = (address: string) => new TransferDestination({type: address === MAIN ? DEST_PKH : DEST_ID,
  destinationBytes: fromBase58Check(address).hash});
const outputs = (currencies: Values, address = MAIN): any[] => Transaction.fromHex(
  VerusIdInterface.createUnfundedCurrencyTransferTransaction(CHAIN, [{currencies, address: destination(address)}], HEIGHT + 20), networks.verus,
).outs;
const transaction = (currencies: Values, marker: number, address = MAIN): any => {
  const tx = Transaction.fromHex(VerusIdInterface.createUnfundedCurrencyTransferTransaction(CHAIN,
    [{currencies, address: destination(address)}], HEIGHT + 20), networks.verus);
  tx.addInput(Buffer.alloc(32, marker), 0);
  return tx;
};
const stringify = (values: Map<string, bigint>): Values => Object.fromEntries([...values].map(([id, value]) => [id, value.toString()]));
const fixture = (mode: 'plain' | 'combined' = 'plain', balances: Values[] = [{[CHAIN]: '1000000', [TOKEN]: '900000000000000001'}],
  sent: Values = {[CHAIN]: '20000', [TOKEN]: '777'}, fee = BigInt("10000")) => {
  const identity = Identity.fromJson({...TEST_ID_3.identity, primaryaddresses: [MAIN], minimumsignatures: 1});
  identity.upgradeVersion();
  const sourceId = Transaction.fromHex(smarttxs.createUnfundedIdentityUpdate(identity.toBuffer().toString('hex'), networks.verus, HEIGHT + 20), networks.verus);
  sourceId.addInput(Buffer.alloc(32, 90), 0);
  const sources = balances.map((values, index) => transaction(values, index + 30));
  const utxos = sources.map(tx => ({txid: tx.getId(), outputIndex: 0, address: MAIN, script: tx.outs[0].script.toString('hex'),
    satoshis: tx.outs[0].value, height: 1, isspendable: true, blocktime: 1}));
  const raw = new Map<string, any>(sources.map(tx => [tx.getId(), tx]));
  const funded = Transaction.fromHex(smarttxs.createUnfundedIdentityUpdate(identity.toBuffer().toString('hex'), networks.verus, HEIGHT + 20), networks.verus);
  for (const input of utxos) funded.addInput(Buffer.from(input.txid, 'hex').reverse(), input.outputIndex);
  const remaining = new Map<string, bigint>();
  for (const values of balances) for (const [id, value] of Object.entries(values)) remaining.set(id, (remaining.get(id) || BigInt("0")) + BigInt(value));
  remaining.set(CHAIN, (remaining.get(CHAIN) || BigInt("0")) - fee);
  if (mode === 'combined') {
    funded.outs.push(...outputs(sent));
    for (const [id, value] of Object.entries(sent)) remaining.set(id, (remaining.get(id) || BigInt("0")) - BigInt(value));
  }
  if ([...remaining.values()].some(value => value > BigInt("0"))) funded.outs.push(...outputs(stringify(remaining), CHANGE));
  const client = new VerusIdInterface(CHAIN, 'http://offline.invalid', undefined, async request => {
    if (request.method === 'getrawtransaction') {
      const tx = raw.get(request.params![0] as string);
      return tx ? {result: tx.toHex(), error: null, id: request.id} : {result: null, error: {code: -5, message: 'Missing'}, id: request.id};
    }
    throw new Error(`Unexpected RPC ${request.method}`);
  });
  const build = (maxFee: number | undefined = 0.001) => mode === 'plain'
    ? client.createUpdateIdentityTransaction(identity, CHANGE, sourceId.toHex(), HEIGHT - 1, utxos, CHAIN, maxFee,
      {hex: funded.toHex(), fee: Number(fee) / 1e8, changepos: 1}, HEIGHT)
    : client.createUpdateIdentityWithCurrencyTransferTransaction(identity, CHANGE, sourceId.toHex(), HEIGHT - 1,
      [{currencies: sent, address: destination(MAIN)}], utxos, {chainIAddr: CHAIN, maxFee,
        fundRawTransactionResult: {hex: funded.toHex(), fee: Number(fee) / 1e8, changepos: 2}, currentHeight: HEIGHT,
        expectedIdentityPrimaryAddresses: [MAIN], expectedIdentityMinimumSignatures: 1});
  const replaceSourceScript = (script: Buffer) => {
    const old = sources[0].getId();
    sources[0].outs[0].script = script;
    const id = sources[0].getId();
    raw.delete(old); raw.set(id, sources[0]); utxos[0].txid = id; utxos[0].script = script.toString('hex');
    funded.ins[0].hash = Buffer.from(id, 'hex').reverse();
  };
  return {identity, sourceId, sources, utxos, raw, funded, client, build, replaceSourceScript};
};
const approvalOf = (result: any): IdentityUpdateFundingApproval => {
  expect(result.fundingApproval).toBeDefined();
  return result.fundingApproval;
};

// Replace both source and target coherently, so these tests exercise transition
// validation rather than only detecting bytes changed after approval.
async function approvalWithLocks(oldFlags: number, oldUnlock: number, newFlags: number, newUnlock: number) {
  const f = fixture();
  const built = await f.build();
  const approval: IdentityUpdateFundingApproval = JSON.parse(JSON.stringify(approvalOf(built)));
  const current = Identity.fromJson(f.identity.toJson());
  current.flags = new BN(oldFlags);
  current.unlockAfter = new BN(oldUnlock);
  const next = Identity.fromJson(current.toJson());
  next.flags = new BN(newFlags);
  next.unlockAfter = new BN(newUnlock);
  const source = Transaction.fromHex(f.sourceId.toHex(), networks.verus);
  source.outs[0].script = IdentityScript.fromIdentity(current).toBuffer();
  const previousTxid = approval.identity.txid;
  approval.identity.txid = source.getId();
  const prevout = approval.prevouts.find(value => value.txid === previousTxid)!;
  prevout.txid = source.getId();
  prevout.rawTransaction = source.toHex();
  const candidate = Transaction.fromHex(approval.txHex, networks.verus);
  candidate.ins.find((input: any) => Buffer.from(input.hash).reverse().toString('hex') === previousTxid)
    .hash = Buffer.from(source.getId(), 'hex').reverse();
  const template = Transaction.fromHex(approval.unfundedTxHex, networks.verus);
  candidate.outs[0].script = IdentityScript.fromIdentity(next).toBuffer();
  template.outs[0].script = candidate.outs[0].script;
  approval.txHex = candidate.toHex();
  approval.unfundedTxHex = template.toHex();
  const inputs = built.utxos.map(input => input.txid === previousTxid ? {
    ...input, txid: source.getId(), script: source.outs[0].script.toString('hex'), rawTransaction: source.toHex(),
  } : input);
  return { approval, inputs, client: f.client };
}

const lockContext = { chainId: CHAIN, nextBlockHeight: HEIGHT + 1 };
test.each([
  ['pending removal', 0, HEIGHT + 100, 0, 0],
  ['pending shortening', 0, HEIGHT + 100, 0, HEIGHT + 99],
  ['short relock', 0, HEIGHT + 100, 2, 1],
  ['overflowing relock', 0, HEIGHT + 100, 2, 0xffffffff],
  ['absolute lock within expiry', 0, 0, 0, HEIGHT + 19],
] as const)('rejects independent receipts for %s with and without trusted height',
  async (_name, oldFlags, oldUnlock, newFlags, newUnlock) => {
    const { approval } = await approvalWithLocks(oldFlags, oldUnlock, newFlags, newUnlock);
    expect(() => verifyIdentityUpdateFunding(approval)).toThrow(/lock/i);
    expect(() => verifyIdentityUpdateFunding(approval, approval.txHex, undefined, lockContext)).toThrow(/lock/i);
  });

test('accepts a daemon-valid over-maximum relock while the absolute lock is pending', async () => {
  const { approval } = await approvalWithLocks(0, HEIGHT + 100, 2, IDENTITY_MAX_UNLOCK_DELAY.toNumber() + 1);
  expect(verifyIdentityUpdateFunding(approval)).toBe(true);
  expect(verifyIdentityUpdateFunding(approval, approval.txHex, undefined, lockContext)).toBe(true);
});

test('requires independent current height to remove an elapsed countdown, including when signing', async () => {
  const { approval, client, inputs } = await approvalWithLocks(0, HEIGHT, 0, 0);
  expect(() => verifyIdentityUpdateFunding(approval)).toThrow(/lock/i);
  // An external receipt's claimed height is not trusted evidence of expiry.
  expect(() => verifyIdentityUpdateFunding({ ...approval, nextBlockHeight: HEIGHT + 1 } as any)).toThrow(/lock/i);
  expect(() => verifyIdentityUpdateFunding(approval, approval.txHex, undefined,
    { ...lockContext, nextBlockHeight: HEIGHT })).toThrow(/lock/i);
  expect(verifyIdentityUpdateFunding(approval, approval.txHex, undefined, lockContext)).toBe(true);
  const keys = inputs.map(() => [key.toWIF()]);
  expect(() => client.signUpdateIdentityTransaction(approval.txHex, inputs, keys, approval)).toThrow(/lock/i);
  const signed = client.signUpdateIdentityTransaction(approval.txHex, inputs, keys, approval, lockContext);
  expect(verifyIdentityUpdateFunding(approval, signed, inputs, lockContext)).toBe(true);
});

test('checks wrapping unlock arithmetic and inclusion-height bounds independently', async () => {
  const { approval } = await approvalWithLocks(2, 0xffffffff, 0, HEIGHT + 19);
  expect(verifyIdentityUpdateFunding(approval, approval.txHex, undefined, lockContext)).toBe(true);
  expect(() => verifyIdentityUpdateFunding(approval)).toThrow(/lock/i);
  expect(() => verifyIdentityUpdateFunding(approval, approval.txHex, undefined,
    { ...lockContext, chainId: OTHER })).toThrow(/chain/i);
  for (const nextBlockHeight of [0, -1, 1.5, NaN, Infinity, HEIGHT + 21]) {
    expect(() => verifyIdentityUpdateFunding(approval, approval.txHex, undefined,
      { ...lockContext, nextBlockHeight })).toThrow(/height|expired/i);
  }
});

test.each(['system', 'currency flag', 'tokenized control', 'self revocation', 'excessive new lock'])(
  'rejects independently supplied funding approvals with an unsupported %s transition',
  async kind => {
    const f = fixture();
    const built = await f.build();
    // Model an externally supplied, internally consistent receipt, rather than
    // altering a candidate after approval (already covered by binding tests).
    const approval: IdentityUpdateFundingApproval = JSON.parse(JSON.stringify(approvalOf(built)));
    const next = Identity.fromJson(f.identity.toJson());
    if (kind === 'system') next.systemId = IdentityID.fromAddress(OTHER);
    if (kind === 'currency flag') next.flags = IDENTITY_FLAG_ACTIVECURRENCY.clone();
    if (kind === 'tokenized control') next.flags = IDENTITY_FLAG_TOKENIZED_CONTROL.clone();
    if (kind === 'self revocation') {
      next.flags = IDENTITY_FLAG_REVOKED.clone();
      next.recoveryAuthority = IdentityID.fromAddress(SUBJECT);
    }
    if (kind === 'excessive new lock') {
      next.flags = IDENTITY_FLAG_LOCKED.clone();
      next.unlockAfter = IDENTITY_MAX_UNLOCK_DELAY.addn(1);
    }
    const script = IdentityScript.fromIdentity(next).toBuffer();
    const candidate = Transaction.fromHex(approval.txHex, networks.verus);
    const template = Transaction.fromHex(approval.unfundedTxHex, networks.verus);
    candidate.outs[0].script = script;
    template.outs[0].script = script;
    approval.txHex = candidate.toHex();
    approval.unfundedTxHex = template.toHex();
    expect(() => verifyIdentityUpdateFunding(approval)).toThrow(/system|protected|flag|revoke|recover|lock/i);
  }
);

test.each(['remove', 'shorten'])(
  'rejects an independent receipt that tries to %s a flagged identity lock',
  async kind => {
    const f = fixture();
    const approval: IdentityUpdateFundingApproval =
      JSON.parse(JSON.stringify(approvalOf(await f.build())));
    const current = Identity.fromJson(f.identity.toJson());
    current.flags = IDENTITY_FLAG_LOCKED.clone();
    current.unlockAfter = new BN(60);
    const source = Transaction.fromHex(f.sourceId.toHex(), networks.verus);
    source.outs[0].script = IdentityScript.fromIdentity(current).toBuffer();
    const previousTxid = approval.identity.txid;
    const nextTxid = source.getId();
    approval.identity.txid = nextTxid;
    const prevout = approval.prevouts.find(value => value.txid === previousTxid)!;
    prevout.txid = nextTxid;
    prevout.rawTransaction = source.toHex();
    const candidate = Transaction.fromHex(approval.txHex, networks.verus);
    candidate.ins.find((input: any) =>
      Buffer.from(input.hash).reverse().toString('hex') === previousTxid
    ).hash = Buffer.from(nextTxid, 'hex').reverse();
    const template = Transaction.fromHex(approval.unfundedTxHex, networks.verus);
    if (kind === 'shorten') {
      const next = Identity.fromJson(current.toJson());
      next.unlockAfter = new BN(1);
      candidate.outs[0].script = IdentityScript.fromIdentity(next).toBuffer();
      template.outs[0].script = candidate.outs[0].script;
    }
    approval.txHex = candidate.toHex();
    approval.unfundedTxHex = template.toHex();
    expect(() => verifyIdentityUpdateFunding(approval)).toThrow(/lock|delay/i);
  }
);

test.each([false, true])('uses the configured chain ID for reserve payments (native substitution: %s)', async nativeSubstitution => {
  const sent = {[nativeSubstitution ? CHAIN : TOKEN]: '50000000'};
  const balances = nativeSubstitution
    ? {[CHAIN]: '100000000'}
    : {[CHAIN]: '100000000', [TOKEN]: '50000000'};
  const f = fixture('combined', [balances], sent);
  const getCurrency = jest.spyOn(f.client.interface, 'getCurrency').mockResolvedValue({
    result: {currencyid: TOKEN}, error: null,
  } as any);

  // Omit chainIAddr: the configured i-address must determine which value is native.
  const attempt = f.client.createUpdateIdentityWithCurrencyTransferTransaction(
    f.identity, CHANGE, f.sourceId.toHex(), HEIGHT - 1,
    [{currencies: {[TOKEN]: '50000000'}, address: destination(MAIN)}],
    f.utxos, {
      currentHeight: HEIGHT,
      fundRawTransactionResult: {hex: f.funded.toHex(), fee: 0.0001, changepos: 2},
      expectedIdentityPrimaryAddresses: [MAIN],
      expectedIdentityMinimumSignatures: 1,
    }
  );

  if (nativeSubstitution) {
    await expect(attempt).rejects.toThrow();
  } else {
    const built = await attempt;
    const approval = approvalOf(built);
    expect(approval.systemId).toBe(CHAIN);
    expect(built.deltas.get(TOKEN)!.toFixed(0)).toBe('-50000000');
    expect(built.deltas.get(CHAIN)!.toFixed(0)).toBe('-10000');

    const signed = f.client.signUpdateIdentityTransaction(
      built.hex, built.utxos, built.utxos.map(() => [key.toWIF()]), approval
    );
    expect(verifyIdentityUpdateFunding(approval, signed, built.utxos)).toBe(true);
  }

  expect(getCurrency).not.toHaveBeenCalled();
});

describe.each(['plain', 'combined'] as const)('%s independent identity funding verification', mode => {
  test('creates immutable raw-prevout approval and verifies signed bytes without changing exact atomic balances', async () => {
    const f = fixture(mode);
    const built = await f.build();
    const approval = approvalOf(built);
    expect(Object.isFrozen(approval.prevouts[0])).toBe(true);
    expect(approval).toMatchObject({systemId: CHAIN, changeAddress: CHANGE, nativeFee: '10000', maxFee: '100000'});
    expect(verifyIdentityUpdateFunding(approval, built.hex, built.utxos)).toBe(true);
    const signed = f.client.signUpdateIdentityTransaction(built.hex, built.utxos, built.utxos.map(() => [key.toWIF()]), approval);
    expect(verifyIdentityUpdateFunding(approval, signed, built.utxos)).toBe(true);
  });

  test.each([1, 2, 5, 9])('conserves native and all reserves across %i distinct funding distributions', async count => {
    const balances = Array.from({length: count}, (_, index) => ({[CHAIN]: String(1000000 + index),
      [TOKEN]: String(BigInt("90000000000000001") + BigInt(index)), [OTHER]: String(index + 1)}));
    const f = fixture(mode, balances, {[CHAIN]: '20000', [TOKEN]: '777'});
    const built = await f.build();
    expect(verifyIdentityUpdateFunding(approvalOf(built), built.hex)).toBe(true);
    expect(built.utxos).toHaveLength(count + 1);
  });

  test.each([CHAIN, TOKEN, OTHER])('rejects a one-satoshi missing change amount in %s', async currency => {
    const f = fixture(mode, [{[CHAIN]: '1000000', [TOKEN]: '900000000000000001', [OTHER]: '53'}]);
    const built = await f.build();
    const approved = approvalOf(built);
    const changed = Transaction.fromHex(built.hex, networks.verus);
    const index = changed.outs.length - 1;
    const amounts: Values = {[CHAIN]: mode === 'combined' ? '969999' : '989999',
      [TOKEN]: mode === 'combined' ? '899999999999999223' : '900000000000000000', [OTHER]: '52'};
    const actual = smarttxs.unpackOutput(changed.outs[index], CHAIN).values;
    for (const id of [CHAIN, TOKEN, OTHER]) if (id !== currency) amounts[id] = actual[id].toString();
    changed.outs[index] = outputs(amounts, CHANGE)[0];
    expect(() => verifyIdentityUpdateFunding(approved, changed.toHex())).toThrow('changed after approval');
  });

  test('rejects a native-valued definition input instead of silently adding it to the fee', async () => {
    const f = fixture(mode);
    f.sourceId.outs[0].value = 100000000;
    await expect(f.build(0.0001)).rejects.toThrow('carrying native value');
  });

  test('rejects duplicate selected outpoints', async () => {
    const f = fixture(mode);
    f.funded.ins.push({...f.funded.ins[0]});
    await expect(f.build()).rejects.toThrow('Duplicate');
  });

  test.each([NaN, Infinity, -1, 0.000000001])('rejects invalid fee cap %s', async fee => {
    await expect(fixture(mode).build(fee)).rejects.toThrow('fee cap');
  });

  test('accepts exact fee cap and rejects one atomic unit above it', async () => {
    await expect(fixture(mode).build(0.0001)).resolves.toHaveProperty('fundingApproval');
    await expect(fixture(mode, undefined, undefined, BigInt("10001")).build(0.0001)).rejects.toThrow('maximum');
  });

  test('rejects an output-only reserve currency that the original fee validator omitted', async () => {
    const f = fixture(mode);
    const original = smarttxs.unpackOutput(f.funded.outs[f.funded.outs.length - 1], CHAIN).values;
    f.funded.outs[f.funded.outs.length - 1] = outputs({...Object.fromEntries(Object.entries(original).map(([id, n]: any) => [id, n.toString()])), [OTHER]: '1'}, CHANGE)[0];
    await expect(f.build()).rejects.toThrow();
  });

  test('rejects arbitrary script/value metadata substitutions before signing', async () => {
    const f = fixture(mode);
    const built = await f.build();
    for (const replacement of [{satoshis: 1}, {script: '00'}, {txid: 'ab'.repeat(32)}, {outputIndex: 99}]) {
      const inputs = built.utxos.map(input => ({...input}));
      Object.assign(inputs[0], replacement);
      expect(() => f.client.signUpdateIdentityTransaction(built.hex, inputs, inputs.map(() => [key.toWIF()]), approvalOf(built))).toThrow(/Signing input/);
    }
  });

  test('rejects forged raw funding transactions and wrong source addresses', async () => {
    const f = fixture(mode);
    f.utxos[0].address = CHANGE;
    await expect(f.build()).rejects.toThrow('indexed address');
    const g = fixture(mode);
    g.sources[0].outs[0].value++;
    await expect(g.build()).rejects.toThrow('hash mismatch');
  });

  test.each(['identity primary', 'zero threshold', 'duplicate primary', 'invalid version'])(
    'rejects an invalid requested identity definition: %s', async kind => {
      const f = fixture(mode);
      if (kind === 'identity primary') f.identity.primaryAddresses = [IdentityID.fromAddress(SUBJECT)];
      if (kind === 'zero threshold') f.identity.minSigs = new BN(0);
      if (kind === 'duplicate primary') f.identity.primaryAddresses!.push(f.identity.primaryAddresses![0]);
      if (kind === 'invalid version') f.identity.version = new BN(0);

      await expect(f.build()).rejects.toThrow(/KeyID|threshold|unique|version/);
    }
  );
});

test.each(['plain', 'combined'] as const)('%s supports exact funding with no change output', async mode => {
  const sent: Values = mode === 'combined' ? {[CHAIN]: '20000'} : {};
  const f = fixture(mode, [{[CHAIN]: mode === 'combined' ? '30000' : '10000'}], sent);
  const built = await f.build();
  expect(verifyIdentityUpdateFunding(approvalOf(built))).toBe(true);
  expect(Transaction.fromHex(built.hex, networks.verus).outs).toHaveLength(mode === 'combined' ? 2 : 1);
});

const malformed = (kind: string): Buffer => {
  const destination = new TxDestination(IdentityID.fromAddress(CHANGE));
  const cc = (destinations: TxDestination[] = [destination]) => new OptCCParams({version: new BN(3), evalCode: new BN(EVALS.EVAL_NONE),
    m: new BN(1), n: new BN(1), destinations, vData: []});
  const master = cc();
  const condition = cc();
  if (kind === 'empty destinations') {master.destinations = []; condition.destinations = [];}
  if (kind === 'alternate master') master.destinations = [new TxDestination(IdentityID.fromAddress(OTHER))];
  if (kind === 'old version') {master.version = new BN(2); condition.version = new BN(2);}
  if (kind.includes('token') || kind === 'native in reserve map') {
    const token = new TokenOutput({version: new BN(kind === 'invalid token version' ? 2 : 1),
      values: new CurrencyValueMap({valueMap: new Map([[kind === 'native in reserve map' ? CHAIN : TOKEN, new BN('900000000000000001')]])})});
    condition.evalCode = new BN(EVALS.EVAL_RESERVE_OUTPUT);
    const payload = token.toBuffer();
    condition.vData = [kind === 'trailing token bytes' ? Buffer.concat([payload, Buffer.from([0])]) : payload];
  }
  return new SmartTransactionScript(master, condition).toBuffer();
};

test.each(['empty destinations', 'alternate master', 'old version', 'invalid token version', 'trailing token bytes', 'native in reserve map'])(
  'rejects %s in change even if reported deltas balance', async kind => {
    const f = fixture('plain');
    f.funded.outs[1].script = malformed(kind);
    await expect(f.build()).rejects.toThrow();
  },
);

test.each(['invalid token version', 'trailing token bytes', 'native in reserve map', 'old version'])(
  'rejects a historical malformed %s funding prevout instead of silently losing reserves', async kind => {
    const f = fixture('plain');
    const smart = new SmartTransactionScript();
    smart.fromBuffer(malformed(kind));
    // Bind both the index and script to the same address; the failure must be
    // the malformed funding encoding rather than a forged address label.
    f.utxos[0].address = CHANGE;
    f.replaceSourceScript(smart.toBuffer());
    await expect(f.build()).rejects.toThrow();
  },
);

test('rejects altered approved fee/change context and malformed raw sources independently', async () => {
  const f = fixture();
  const result = await f.build();
  const original = approvalOf(result);
  for (const patch of [{nativeFee: '10001'}, {maxFee: '9999'}, {changeAddress: OTHER}, {fees: {[CHAIN]: '10000', [TOKEN]: '1'}}]) {
    expect(() => verifyIdentityUpdateFunding({...original, ...patch})).toThrow();
  }
  const corrupt = {...original, prevouts: original.prevouts.map((input, index) => index ? input : {...input, rawTransaction: input.rawTransaction + '00'})};
  expect(() => verifyIdentityUpdateFunding(corrupt)).toThrow();
});

// Duplicate map keys must be rejected, even when the last JS value matches
// change: the daemon's std::map decoder retains the first amount instead.
test.each(['plain', 'combined'] as const)('%s rejects duplicate currency keys in a historical raw prevout', async mode => {
  const f = fixture(mode, [{[CHAIN]: '1000000', [TOKEN]: '1000', [OTHER]: '77'}], {[CHAIN]: '20000'});
  const smart = new SmartTransactionScript();
  smart.fromBuffer(f.sources[0].outs[0].script);
  const payload = Buffer.from(smart.paramsOptCC.vData[0]);
  const first = payload.length - 56;
  fromBase58Check(TOKEN).hash.copy(payload, first);
  fromBase58Check(TOKEN).hash.copy(payload, first + 28);
  payload.writeBigInt64LE(BigInt('1000'), first + 20);
  payload.writeBigInt64LE(BigInt('77'), first + 48);
  smart.paramsOptCC.vData = [payload];
  f.replaceSourceScript(smart.toBuffer());
  const token = new TokenOutput();
  token.fromBuffer(payload);
  expect(token.reserveValues.valueMap.get(TOKEN)!.toString()).toBe('77');
  expect(token.toBuffer().equals(payload)).toBe(false);
  // Make the original permissive accounting balance using its last value.
  f.funded.outs[f.funded.outs.length - 1] = outputs({[CHAIN]: mode === 'combined' ? '970000' : '990000', [TOKEN]: '77'}, CHANGE)[0];
  await expect(f.build()).rejects.toThrow('reserve currency encoding');
});

test.each(['plain', 'combined'] as const)('%s rejects reserve change omitted before approval', async mode => {
  const f = fixture(mode);
  const index = f.funded.outs.length - 1;
  const values = smarttxs.unpackOutput(f.funded.outs[index], CHAIN).values;
  f.funded.outs[index] = outputs({[CHAIN]: values[CHAIN].toString(), [TOKEN]: (BigInt(values[TOKEN].toString()) - BigInt(1)).toString()}, CHANGE)[0];
  await expect(f.build()).rejects.toThrow();
});

test('bounds the default ordinary fee and includes a change allowance for large identities', async () => {
  const f = fixture('plain', [{[CHAIN]: '1000000'}]);
  const ordinary = smarttxs.createUnfundedIdentityUpdate(f.identity.toBuffer().toString('hex'), networks.verus, HEIGHT + 20);
  expect(defaultIdentityUpdateFeeCap(ordinary)).toBe(0.001);
  f.identity.contentMap = new Map(Array.from({length: 20}, (_, index) =>
    [nameAndParentAddrToIAddr(`content${index}`, CHAIN), Buffer.alloc(32, index)]));
  const large = smarttxs.createUnfundedIdentityUpdate(f.identity.toBuffer().toString('hex'), networks.verus, HEIGHT + 20);
  expect(defaultIdentityUpdateFeeCap(large)).toBeGreaterThanOrEqual(0.0021);
  expect(BigInt(identityUpdateFeeCap(defaultIdentityUpdateFeeCap(large, '10000'))) -
    BigInt(identityUpdateFeeCap(defaultIdentityUpdateFeeCap(large)))).toBe(BigInt('10000'));
});

test.each(['plain', 'combined'] as const)('%s uses a conservative default and still honors a deliberate explicit cap', async mode => {
  const f = fixture(mode, [{[CHAIN]: '100000000'}], {[CHAIN]: '20000'}, BigInt('1000000'));
  // Omit the public maxFee directly; the fixture's build() intentionally supplies a cap.
  const attempt = mode === 'plain'
    ? f.client.createUpdateIdentityTransaction(f.identity, CHANGE, f.sourceId.toHex(), HEIGHT - 1, f.utxos, CHAIN,
      undefined, {hex: f.funded.toHex(), fee: 0.01, changepos: 1}, HEIGHT)
    : f.client.createUpdateIdentityWithCurrencyTransferTransaction(f.identity, CHANGE, f.sourceId.toHex(), HEIGHT - 1,
      [{currencies: {[CHAIN]: '20000'}, address: destination(MAIN)}], f.utxos,
      {chainIAddr: CHAIN, fundRawTransactionResult: {hex: f.funded.toHex(), fee: 0.01, changepos: 2}, currentHeight: HEIGHT,
        expectedIdentityPrimaryAddresses: [MAIN], expectedIdentityMinimumSignatures: 1});
  await expect(attempt).rejects.toThrow('maximum');
  const deliberate = await f.build(0.01);
  expect(deliberate.fundingApproval!.nativeFee).toBe('1000000');
  expect(deliberate.fundingApproval!.maxFee).toBe('1000000');
});

describe.each(['plain', 'combined'] as const)('%s partial update private-address authorization', mode => {
  const prepare = (kind: 'addition' | 'extra' | 'requested addition' | 'requested removal') => {
    const f = fixture(mode);
    const privateAddress = f.identity.privateAddresses[0];
    const previous = Identity.fromJson(f.identity.toJson());
    previous.privateAddresses = kind === 'addition' || kind === 'requested addition' ? [] : [privateAddress];
    f.sourceId.outs[0].script = IdentityScript.fromIdentity(previous).toBuffer();

    const updated = Identity.fromJson(previous.toJson());
    updated.privateAddresses = kind === 'requested removal' ? [] : [privateAddress];
    if (kind === 'extra') {
      const extra = new SaplingPaymentAddress({
        d: Buffer.from(privateAddress.d),
        pkD: Buffer.from(privateAddress.pkD),
      });
      extra.d[0] ^= 1;
      updated.privateAddresses.push(extra);
    }
    const template = smarttxs.createUnfundedIdentityUpdate(updated.toBuffer().toString('hex'), networks.verus, HEIGHT + 20);
    f.funded.outs[0].script = IdentityScript.fromIdentity(updated).toBuffer();
    const request = IdentityUpdateRequestDetails.fromCLIJson({
      name: previous.name,
      parent: previous.parent.toAddress()!,
      primaryaddresses: [MAIN],
      ...(kind === 'requested addition' ? {privateaddress: privateAddress.toAddressString()} : {}),
    });
    if (kind === 'requested removal') {
      request.identity!.privateAddresses = [];
      request.identity!.contains = request.identity!.contains.or(PartialIdentity.PARTIAL_ID_CONTAINS_PRIV_ADDRS);
    }

    const run = () => mode === 'plain'
      ? f.client.createUpdateIdentityTransaction(request, CHANGE, f.sourceId.toHex(), HEIGHT - 1, f.utxos, CHAIN, 0.001,
        {hex: f.funded.toHex(), fee: 0.0001, changepos: 1}, HEIGHT, template)
      : f.client.createUpdateIdentityWithCurrencyTransferTransaction(request, CHANGE, f.sourceId.toHex(), HEIGHT - 1,
        [{currencies: {[CHAIN]: '20000', [TOKEN]: '777'}, address: destination(MAIN)}], f.utxos, {
          chainIAddr: CHAIN, maxFee: 0.001,
          fundRawTransactionResult: {hex: f.funded.toHex(), fee: 0.0001, changepos: 2}, currentHeight: HEIGHT,
          expectedIdentityPrimaryAddresses: [MAIN], expectedIdentityMinimumSignatures: 1,
          updateIdentityTransactionHex: template,
        });
    return {run, updated};
  };

  test.each(['addition', 'extra'] as const)('rejects unrequested private-address %s hidden by JSON serialization', async kind => {
    await expect(prepare(kind).run()).rejects.toThrow(/private.address/i);
  });

  test.each(['requested addition', 'requested removal'] as const)('accepts %s', async kind => {
    const f = prepare(kind);
    const result = await f.run();
    expect((result.identity.privateAddresses || []).map(address => address.toBuffer().toString('hex')))
      .toEqual(f.updated.privateAddresses.map(address => address.toBuffer().toString('hex')));
    expect(verifyIdentityUpdateFunding(approvalOf(result), result.hex)).toBe(true);
  });
});

describe.each(['plain', 'combined'] as const)('%s partial update destination types', mode => {
  test.each(['recoveryAuthority', 'revocationAuthority', 'parent', 'systemId'] as const)(
    'rejects a KeyID in %s before serialization can convert it to an IdentityID', async field => {
      const f = fixture(mode);
      // Use the existing destination for the valid baseline. Parent/system
      // cannot change, and a new authority must exist on the configured chain.
      const hash = f.identity[field].hash;
      const updated = Identity.fromJson(f.identity.toJson());
      updated[field] = new IdentityID(Buffer.from(hash));
      const template = smarttxs.createUnfundedIdentityUpdate(updated.toBuffer().toString('hex'), networks.verus, HEIGHT + 20);
      f.funded.outs[0].script = IdentityScript.fromIdentity(updated).toBuffer();

      const run = (value: IdentityID | KeyID) => {
        const request = new IdentityUpdateRequestDetails({identity: new PartialIdentity({
          name: f.identity.name, parent: f.identity.parent, [field]: value,
        })});
        return mode === 'plain'
          ? f.client.createUpdateIdentityTransaction(request, CHANGE, f.sourceId.toHex(), HEIGHT - 1, f.utxos, CHAIN, 0.001,
            {hex: f.funded.toHex(), fee: 0.0001, changepos: 1}, HEIGHT, template)
          : f.client.createUpdateIdentityWithCurrencyTransferTransaction(request, CHANGE, f.sourceId.toHex(), HEIGHT - 1,
            [{currencies: {[CHAIN]: '20000', [TOKEN]: '777'}, address: destination(MAIN)}], f.utxos, {
              chainIAddr: CHAIN, maxFee: 0.001, currentHeight: HEIGHT,
              fundRawTransactionResult: {hex: f.funded.toHex(), fee: 0.0001, changepos: 2},
              expectedIdentityPrimaryAddresses: [MAIN], expectedIdentityMinimumSignatures: 1,
              updateIdentityTransactionHex: template,
            });
      };

      // Both types write the same 20-byte hash. The supplied class and address
      // prefix are the only opportunity to catch an unintended authority.
      await expect(run(new IdentityID(Buffer.from(hash)))).resolves.toHaveProperty('fundingApproval');
      await expect(run(new KeyID(Buffer.from(hash)))).rejects.toThrow(/identity destination/i);
    }
  );
});

test('rejects a forged balanced approval containing a multi-currency reserve transfer', async () => {
  const f = fixture('combined');
  const payment = {currencies: {[TOKEN]: '777'}, address: destination(MAIN), convertto: CHAIN};
  const transferTx = Transaction.fromHex(
    VerusIdInterface.createUnfundedCurrencyTransferTransaction(CHAIN, [payment], HEIGHT + 20), networks.verus
  );
  f.funded.outs[1] = transferTx.outs[0];
  const result = await f.client.createUpdateIdentityWithCurrencyTransferTransaction(
    f.identity, CHANGE, f.sourceId.toHex(), HEIGHT - 1, [payment], f.utxos, {
      chainIAddr: CHAIN, maxFee: 0.001, currentHeight: HEIGHT,
      fundRawTransactionResult: {hex: f.funded.toHex(), fee: 0.0001, changepos: 2},
      expectedIdentityPrimaryAddresses: [MAIN], expectedIdentityMinimumSignatures: 1,
    }
  );
  const approved = approvalOf(result);
  expect(verifyIdentityUpdateFunding(approved)).toBe(true);

  const changed = Transaction.fromHex(result.hex, networks.verus);
  const planned = Transaction.fromHex(approved.unfundedTxHex, networks.verus);
  const script = new SmartTransactionScript();
  script.fromBuffer(changed.outs[1].script);
  const transfer = new ReserveTransfer();
  transfer.fromBuffer(script.paramsOptCC.vData[0]);
  transfer.reserveValues.valueMap.set(CHAIN, new BN(1));
  script.paramsOptCC.vData = [transfer.toBuffer()];
  changed.outs[1].script = script.toBuffer();
  changed.outs[1].value++;
  changed.outs[2].value--;
  planned.outs[1] = changed.outs[1];

  // Keep every amount balanced and replace the retained template too. The
  // independent verifier must still enforce the daemon's one-currency rule.
  const forged = {...approved, txHex: changed.toHex(), unfundedTxHex: planned.toHex()};
  expect(() => verifyIdentityUpdateFunding(forged)).toThrow('Invalid explicit reserve-transfer encoding');
});
