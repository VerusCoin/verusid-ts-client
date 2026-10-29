// Exercise the SDK selector, with real transaction/script serialization.
// Expected balances come from raw source and result bytes, never from the
// selector's prevout/outputPlan metadata or its readFundingOutput helper.
const {address, networks, opcodes, script, Transaction, TransactionBuilder} = require('@bitgo/utxo-lib');
const {
  BigNumber: BN, CommitmentHash, CurrencyValueMap, EVALS, IdentityCommitmentScript,
  IdentityID, KeyID, OptCCParams, SmartTransactionScript, TokenOutput, TxDestination,
} = require('verus-typescript-primitives');
const {
  fundRegistration, readRegistrationPrevout, validateRegistrationTransaction,
} = require('../identity/registrationTransaction');

const destination = (byte, identity = false) => new TxDestination(
  identity ? new IdentityID(Buffer.alloc(20, byte)) : new KeyID(Buffer.alloc(20, byte)),
);
const SYSTEM = destination(1, true).toAddress();
const TOKEN = destination(2, true).toAddress();
const OTHER = destination(3, true).toAddress();
const UNUSED = destination(4, true).toAddress();
const OWNER = destination(5);
const RECIPIENT = destination(6);
const ID_OWNER = destination(7, true);
const snapshot = {
  systemID: SYSTEM, rootSystemName: 'VRSCTEST', tipHeight: 100,
  tipHash: 'ab'.repeat(32), candidateHeight: 101, expiryDelta: 20, expiryHeight: 121,
};
let nonce = 0;

const params = (evalCode, destinations, vData = []) => new OptCCParams({
  version: new BN(3), evalCode: new BN(evalCode), m: new BN(destinations.length ? 1 : 0),
  n: new BN(destinations.length), destinations, vData,
});
const reservePayload = (values, version = 1) => new TokenOutput({
  version: new BN(version),
  values: new CurrencyValueMap({
    valueMap: new Map(Object.entries(values).map(([id, amount]) => [id, new BN(amount)])),
  }),
}).toBuffer();
const smartScript = (evalCode, payloads, dest = OWNER) => new SmartTransactionScript(
  params(EVALS.EVAL_NONE, [dest]), params(evalCode, [dest], payloads),
).toBuffer();

// Build fixtures without paymentOutput: otherwise a bug shared by construction
// and selection could manufacture both the input and the expected answer.
const payment = (values, dest = RECIPIENT, role = 'issuer-payment') => {
  const reserves = Object.fromEntries(Object.entries(values).filter(([id]) => id !== SYSTEM));
  const outputScript = Object.keys(reserves).length
    ? smartScript(EVALS.EVAL_RESERVE_OUTPUT, [reservePayload(reserves)], dest)
    : dest.type.eq(TxDestination.TYPE_ID)
      ? new SmartTransactionScript(params(EVALS.EVAL_NONE, []), params(EVALS.EVAL_NONE, [dest])).toBuffer()
      : address.toOutputScript(dest.toAddress(), networks.verus);
  return {scriptHex: outputScript.toString('hex'), value: values[SYSTEM] || '0',
    values: {...values, [SYSTEM]: values[SYSTEM] || '0'}, role};
};

const source = (output, value = Number(output.value || 0)) => {
  const builder = new TransactionBuilder(networks.verus);
  builder.setVersion(4);
  builder.setVersionGroupId(0x892f2085);
  builder.setExpiryHeight(90);
  const hash = Buffer.alloc(32, 0x17);
  hash.writeUInt32LE(++nonce, 0);
  builder.addInput(hash, 0);
  builder.addOutput(Buffer.from(output.scriptHex, 'hex'), value);
  const tx = builder.buildIncomplete();
  return {txid: tx.getId(), vout: 0, rawTransaction: tx.toHex()};
};
const funds = (values, dest = OWNER) => source(payment(values, dest, 'change'));
const commitment = (value = 0) => source({
  scriptHex: IdentityCommitmentScript.fromCommitment(
    new CommitmentHash({hash: Buffer.alloc(32, 8)}), OWNER,
  ).toBuffer().toString('hex'),
}, value);
const transaction = raw => Transaction.fromHex(raw, networks.verus);
const outpoint = input => `${input.txid}:${input.vout}`;
const rpcFor = (sources, liveOverride = {}) => ({
  getRawTransaction: jest.fn(async txid => ({
    result: sources.find(item => item.txid === txid).rawTransaction, error: null,
  })),
  getTxOut: jest.fn(async (txid, vout, includeMempool) => {
    expect(includeMempool).toBe(true);
    const input = sources.find(item => item.txid === txid && item.vout === vout);
    if (!input) throw new Error('Unexpected fixture outpoint');
    const output = transaction(input.rawTransaction).outs[vout];
    const decimal = String(output.value).padStart(9, '0');
    return {error: null, result: {
      value: `${decimal.slice(0, -8)}.${decimal.slice(-8)}`,
      scriptPubKey: {hex: output.script.toString('hex')},
      bestblock: snapshot.tipHash, confirmations: 2, coinbase: false,
      ...liveOverride,
    }};
  }),
});

const add = (target, values) => {
  Object.entries(values).forEach(([id, value]) => {
    target[id] = (target[id] || BigInt(0)) + BigInt(value);
  });
  return target;
};
const nonzero = values => Object.fromEntries(Object.entries(values)
  .filter(([, value]) => BigInt(value) !== BigInt(0))
  .map(([id, value]) => [id, String(value)]));

// Independent accounting oracle: decode the actual wire scripts using only
// primitives and do all arithmetic with BigInt, independently of the SDK's BN.
const balances = output => {
  const result = {[SYSTEM]: BigInt(output.value)};
  if (script.pubKeyHash.output.check(output.script)) return result;
  const smart = new SmartTransactionScript();
  smart.fromBuffer(output.script, 0, output.script.length);
  const condition = smart.paramsOptCC;
  if (condition.evalCode.eqn(EVALS.EVAL_RESERVE_OUTPUT)) {
    const token = new TokenOutput();
    expect(token.fromBuffer(condition.vData[0])).toBe(condition.vData[0].length);
    for (const [id, value] of token.reserveValues.valueMap.entries()) {
      expect(id).not.toBe(SYSTEM);
      expect(value.isNeg()).toBe(false);
      result[id] = BigInt(value.toString(10));
    }
  } else {
    expect([EVALS.EVAL_NONE, EVALS.EVAL_IDENTITY_COMMITMENT]).toContain(condition.evalCode.toNumber());
  }
  return result;
};

const assertConserved = (result, sources, outputs, fee, changeDestination = OWNER) => {
  const tx = transaction(result.txHex);
  const inputs = {};
  const spent = new Set();
  tx.ins.forEach(input => {
    const key = `${Buffer.from(input.hash).reverse().toString('hex')}:${input.index}`;
    expect(spent.has(key)).toBe(false);
    spent.add(key);
    const raw = sources.find(item => outpoint(item) === key);
    expect(raw).toBeDefined();
    const origin = transaction(raw.rawTransaction);
    expect(origin.getId()).toBe(raw.txid);
    add(inputs, balances(origin.outs[input.index]));
  });
  const outgoing = {};
  tx.outs.forEach(output => add(outgoing, balances(output)));
  const difference = {};
  new Set([...Object.keys(inputs), ...Object.keys(outgoing)]).forEach(id => {
    difference[id] = (inputs[id] || BigInt(0)) - (outgoing[id] || BigInt(0));
  });
  // The ONLY lost value must be the explicitly requested native miner fee.
  expect(nonzero(difference)).toEqual(nonzero({[SYSTEM]: fee}));
  outputs.forEach((output, index) => {
    expect(tx.outs[index].script.toString('hex')).toBe(output.scriptHex);
    expect(String(tx.outs[index].value)).toBe(output.value);
  });
  expect(tx.outs.length).toBeGreaterThanOrEqual(outputs.length);
  expect(tx.outs.length).toBeLessThanOrEqual(outputs.length + 1);
  const change = tx.outs.slice(outputs.length);
  change.forEach(output => {
    if (script.pubKeyHash.output.check(output.script)) {
      expect(address.fromOutputScript(output.script, networks.verus)).toBe(changeDestination.toAddress());
    } else {
      const smart = new SmartTransactionScript();
      smart.fromBuffer(output.script, 0, output.script.length);
      expect(smart.paramsOptCC.destinations.map(dest => dest.toAddress()))
        .toEqual([changeDestination.toAddress()]);
    }
  });
  expect(validateRegistrationTransaction({...result, snapshot, nativeFee: fee})).toBe(true);
  return change.length ? nonzero(balances(change[0])) : {};
};

const select = async (sources, outputs, fee = '1000', dest = OWNER, mandatory) => {
  const result = await fundRegistration(rpcFor(sources), snapshot, outputs, fee,
    sources.filter(item => !mandatory || outpoint(item) !== outpoint(mandatory)),
    dest.toAddress(), mandatory);
  return {result, change: assertConserved(result, sources, outputs, fee, dest)};
};

describe('identity registration coin selection: raw-byte currency conservation', () => {
  test.each([
    ['exact native balance', {[SYSTEM]: '6000'}, {[SYSTEM]: '5000'}, {}],
    ['one atomic unit of native change', {[SYSTEM]: '6001'}, {[SYSTEM]: '5000'}, {[SYSTEM]: '1'}],
    ['exact native and reserve balances', {[SYSTEM]: '1000', [TOKEN]: '50'}, {[TOKEN]: '50'}, {}],
    ['reserve-only change', {[SYSTEM]: '1000', [TOKEN]: '51'}, {[TOKEN]: '50'}, {[TOKEN]: '1'}],
    ['native-only change', {[SYSTEM]: '1001', [TOKEN]: '50'}, {[TOKEN]: '50'}, {[SYSTEM]: '1'}],
    ['unrelated reserves on native funding', {[SYSTEM]: '6000', [OTHER]: '100', [UNUSED]: '77'},
      {[SYSTEM]: '5000'}, {[OTHER]: '100', [UNUSED]: '77'}],
    ['native and several reserve change amounts', {[SYSTEM]: '6001', [TOKEN]: '51', [OTHER]: '42', [UNUSED]: '7'},
      {[SYSTEM]: '5000', [TOKEN]: '50', [OTHER]: '1'}, {[SYSTEM]: '1', [TOKEN]: '1', [OTHER]: '41', [UNUSED]: '7'}],
    ['reserve precision beyond Number.MAX_SAFE_INTEGER', {[SYSTEM]: '1000', [TOKEN]: '9007199254740993'},
      {[TOKEN]: '9007199254740992'}, {[TOKEN]: '1'}],
    ['maximum consensus reserve balance', {[SYSTEM]: '1000', [TOKEN]: '5000000000000000000', [OTHER]: '42'},
      {[TOKEN]: '4999999999999999999'}, {[TOKEN]: '1', [OTHER]: '42'}],
    ['large unrelated reserve balance', {[SYSTEM]: '1000', [TOKEN]: '1', [OTHER]: '5000000000000000000'},
      {[TOKEN]: '1'}, {[OTHER]: '5000000000000000000'}],
    ['zero-valued reserve entries', {[SYSTEM]: '6001', [TOKEN]: '0', [OTHER]: '0'},
      {[SYSTEM]: '5000', [TOKEN]: '0'}, {[SYSTEM]: '1'}],
    ['largest supported native amount', {[SYSTEM]: '2100000000000000'},
      {[SYSTEM]: '1'}, {[SYSTEM]: '2099999999998999'}],
  ])('preserves %s exactly', async (_label, input, required, expected) => {
    const {change} = await select([funds(input)], [payment(required)]);
    expect(change).toEqual(expected);
  });

  test.each([['key address', OWNER], ['identity address', ID_OWNER]])('returns all currencies to the chosen %s', async (_label, dest) => {
    const {change} = await select([
      funds({[SYSTEM]: '5000', [TOKEN]: '9007199254740993', [OTHER]: '100'}, dest),
    ], [payment({[TOKEN]: '9007199254740990'})], '1000', dest);
    expect(change).toEqual({[SYSTEM]: '4000', [TOKEN]: '3', [OTHER]: '100'});
  });

  test('selects reserve-only and native inputs until every currency is covered; ignores later inputs', async () => {
    const candidates = [
      funds({[TOKEN]: '40', [UNUSED]: '9'}), funds({[SYSTEM]: '1001'}),
      funds({[TOKEN]: '10', [OTHER]: '2'}), funds({[SYSTEM]: '100000000'}),
    ];
    const rpc = rpcFor(candidates);
    const outputs = [payment({[TOKEN]: '50'})];
    const result = await fundRegistration(rpc, snapshot, outputs, '1000', candidates, OWNER.toAddress());
    expect(result.prevouts.map(outpoint)).toEqual(candidates.slice(0, 3).map(outpoint));
    expect(rpc.getTxOut).toHaveBeenCalledTimes(3);
    expect(assertConserved(result, candidates, outputs, '1000'))
      .toEqual({[SYSTEM]: '1', [OTHER]: '2', [UNUSED]: '9'});
  });

  test('a zero-value commitment returns every reserve and charges only its native fee', async () => {
    const candidates = [funds({[SYSTEM]: '1000000000000', [TOKEN]: '5000000000000000000', [OTHER]: '1'})];
    const output = transaction(commitment().rawTransaction).outs[0];
    const outputs = [{role: 'commitment', scriptHex: output.script.toString('hex'), value: '0', values: {[SYSTEM]: '0'}}];
    const {change} = await select(candidates, outputs);
    expect(change).toEqual({[SYSTEM]: '999999999000', [TOKEN]: '5000000000000000000', [OTHER]: '1'});
  });

  test('sums issuer and referral outputs independently in every currency', async () => {
    const candidates = [funds({[SYSTEM]: '1011', [TOKEN]: '9007199254740993', [OTHER]: '53'})];
    const outputs = [
      payment({[SYSTEM]: '5', [TOKEN]: '9007199254740980', [OTHER]: '30'}),
      payment({[SYSTEM]: '5', [TOKEN]: '12', [OTHER]: '22'}, ID_OWNER, 'referral'),
    ];
    expect((await select(candidates, outputs)).change).toEqual({[SYSTEM]: '1', [TOKEN]: '1', [OTHER]: '1'});
  });

  test('zero requested native fee does not donate a leftover native atomic unit', async () => {
    expect((await select([funds({[SYSTEM]: '1', [TOKEN]: '50'})], [payment({[TOKEN]: '50'})], '0')).change)
      .toEqual({[SYSTEM]: '1'});
  });

  test('rejects a multi-reserve payload beyond the daemon parameter-size limit', async () => {
    const reserves = Object.fromEntries(Array.from({length: 253}, (_unused, index) => {
      const bytes = Buffer.alloc(20, 0x17);
      bytes.writeUInt32LE(index + 1, 0);
      return [new TxDestination(new IdentityID(bytes)).toAddress(), String(index + 1)];
    }));
    await expect(select([funds({[SYSTEM]: '1000', ...reserves})], [payment({[SYSTEM]: '0'})]))
      .rejects.toMatchObject({code: 'UNSUPPORTED_SCRIPT_SIZE'});
  });

  test.each([
    ['reserve', {[SYSTEM]: '1000000000', [TOKEN]: '49'}, {[TOKEN]: '50'}],
    ['native fee', {[SYSTEM]: '999', [TOKEN]: '5000000000000000000'}, {[TOKEN]: '1'}],
    ['different reserve denomination', {[SYSTEM]: '1000', [OTHER]: '5000000000000000000'}, {[TOKEN]: '1'}],
  ])('rejects insufficient %s without substituting another currency', async (_label, input, required) => {
    await expect(select([funds(input)], [payment(required)])).rejects.toMatchObject({code: 'INSUFFICIENT_FUNDS'});
  });

  test.each([0, 6000, 6001])('accounts for the mandatory commitment value %s once', async amount => {
    const committed = commitment(amount);
    const native = funds({[SYSTEM]: '6000', [UNUSED]: '50'});
    const mandatory = await readRegistrationPrevout(rpcFor([committed]), committed, snapshot, true);
    const outputs = [payment({[SYSTEM]: '5000'})];
    const {result, change} = await select([committed, native], outputs, '1000', OWNER, mandatory);
    expect(result.prevouts[0].txid).toBe(committed.txid);
    expect(result.prevouts).toHaveLength(amount < 6000 ? 2 : 1);
    expect(change).toEqual(amount === 0 ? {[UNUSED]: '50'} : amount === 6000 ? {} : {[SYSTEM]: '1'});
  });

  test('rejects duplicates even after a sufficient input and when the duplicate is mandatory', async () => {
    const candidate = funds({[SYSTEM]: '1000'});
    const rpc = rpcFor([candidate]);
    await expect(fundRegistration(rpc, snapshot, [], '1000', [candidate, candidate], OWNER.toAddress()))
      .rejects.toMatchObject({code: 'DUPLICATE_INPUT'});
    expect(rpc.getTxOut).not.toHaveBeenCalled();
    const committed = commitment(1000);
    const mandatory = await readRegistrationPrevout(rpcFor([committed]), committed, snapshot, true);
    await expect(fundRegistration(rpc, snapshot, [], '1000', [committed], OWNER.toAddress(), mandatory))
      .rejects.toMatchObject({code: 'DUPLICATE_INPUT'});
  });

  test('fails closed when combined reserve inputs exceed the consensus currency limit by one', async () => {
    const candidates = [funds({[TOKEN]: '5000000000000000000'}), funds({[SYSTEM]: '1000', [TOKEN]: '1'})];
    await expect(select(candidates, [payment({[TOKEN]: '1'})]))
      .rejects.toMatchObject({code: 'INVALID_AMOUNT'});
  });

  test.each(['5000000000000000001', '9223372036854775807'])(
    'rejects a reserve input above the consensus currency limit: %s', async amount => {
      await expect(select([funds({[SYSTEM]: '1000', [TOKEN]: amount})], [payment({[TOKEN]: '1'})]))
        .rejects.toMatchObject({code: 'INVALID_AMOUNT'});
    },
  );

  test('rejects individually valid reserve inputs whose combined change exceeds the consensus limit', async () => {
    const candidates = [
      funds({[TOKEN]: '3000000000000000000'}),
      funds({[TOKEN]: '3000000000000000000'}),
      funds({[SYSTEM]: '1000'}),
    ];
    await expect(select(candidates, [payment({[SYSTEM]: '0'})]))
      .rejects.toMatchObject({code: 'INVALID_AMOUNT'});
  });

  test('accepts combined reserve inputs exactly at the consensus limit', async () => {
    const candidates = [
      funds({[TOKEN]: '2000000000000000000'}),
      funds({[TOKEN]: '3000000000000000000'}),
      funds({[SYSTEM]: '1000'}),
    ];
    expect((await select(candidates, [payment({[SYSTEM]: '0'})])).change)
      .toEqual({[TOKEN]: '5000000000000000000'});
  });

  test('applies the consensus limit independently to different reserve currencies', async () => {
    const candidates = [
      funds({[TOKEN]: '5000000000000000000'}),
      funds({[OTHER]: '5000000000000000000'}),
      funds({[SYSTEM]: '1000'}),
    ];
    expect((await select(candidates, [payment({[SYSTEM]: '0'})])).change)
      .toEqual({[TOKEN]: '5000000000000000000', [OTHER]: '5000000000000000000'});
  });

  test('rejects requested same-currency outputs whose sum exceeds the consensus limit', async () => {
    const candidates = [funds({[SYSTEM]: '1000', [TOKEN]: '5000000000000000000'})];
    await expect(select(candidates, [
      payment({[TOKEN]: '3000000000000000000'}),
      payment({[TOKEN]: '3000000000000000000'}, ID_OWNER, 'referral'),
    ])).rejects.toMatchObject({code: 'INVALID_AMOUNT'});
  });

  test.each(['-1', '1.1', '01', '1e8', '5000000000000000001', '9223372036854775808'])('rejects invalid atomic fee %s', async fee => {
    await expect(select([funds({[SYSTEM]: '100000'})], [], fee))
      .rejects.toMatchObject({code: 'INVALID_AMOUNT'});
  });

  test('preserves exact fees and every reserve in 64 reproducible mixed-currency selections', async () => {
    let seed = 0x4f7ab219;
    const random = limit => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % limit;
    };
    for (let trial = 0; trial < 64; trial++) {
      const candidates = [];
      const total = {};
      const count = 1 + random(6);
      for (let index = 0; index < count; index++) {
        const amounts = {[SYSTEM]: String(1000 + random(100000))};
        [TOKEN, OTHER, UNUSED].forEach(id => { amounts[id] = String(random(100000)); });
        // Periodic precision stress without exceeding signed 64-bit sums.
        if (trial % 4 === 0) amounts[UNUSED] = String(BigInt(amounts[UNUSED]) + BigInt('9007199254740993'));
        add(total, amounts);
        candidates.push(funds(amounts, trial % 2 ? ID_OWNER : OWNER));
      }
      const fee = String(1 + random(999));
      const required = {
        [SYSTEM]: String((total[SYSTEM] - BigInt(fee)) / BigInt(1 + random(4))),
        [TOKEN]: String(total[TOKEN] / BigInt(1 + random(4))),
        [OTHER]: String(total[OTHER] / BigInt(1 + random(4))),
      };
      // Shuffle the candidate order to stress changing selected subsets.
      for (let index = candidates.length - 1; index > 0; index--) {
        const other = random(index + 1);
        [candidates[index], candidates[other]] = [candidates[other], candidates[index]];
      }
      await select(candidates, [payment(required)], fee, trial % 2 ? ID_OWNER : OWNER);
    }
  });
});

describe('identity registration coin selection: reject ambiguous or unsupported funding', () => {
  const standard = () => Buffer.from(payment({[SYSTEM]: '1000'}, OWNER).scriptHex, 'hex');
  const mutatedSmart = update => {
    const original = new SmartTransactionScript();
    const bytes = smartScript(EVALS.EVAL_RESERVE_OUTPUT, [reservePayload({[TOKEN]: '1'})]);
    original.fromBuffer(bytes, 0, bytes.length);
    update(original);
    return original.toBuffer();
  };
  const multiPayload = () => reservePayload({[TOKEN]: '1', [OTHER]: '2'});
  const mutateMap = update => {
    const payload = multiPayload();
    // Two fixed-width currency records follow the version varint and count.
    const start = payload.length - 56;
    update(payload, start);
    return smartScript(EVALS.EVAL_RESERVE_OUTPUT, [payload]);
  };

  test.each([
    ['OP_RETURN', () => script.compile([opcodes.OP_RETURN, Buffer.from('funding')])],
    ['anyone-can-spend', () => Buffer.from('51', 'hex')],
    ['P2SH', () => script.scriptHash.output.encode(Buffer.alloc(20, 9))],
    ['bare public key', () => script.compile([Buffer.concat([Buffer.from([2]), Buffer.alloc(32, 9)]), opcodes.OP_CHECKSIG])],
    ['bare multisig', () => script.compile([opcodes.OP_1, Buffer.concat([Buffer.from([2]), Buffer.alloc(32, 9)]), opcodes.OP_1, opcodes.OP_CHECKMULTISIG])],
    ['empty script', () => Buffer.alloc(0)],
    ['truncated P2PKH', () => standard().subarray(0, 24)],
    ['P2PKH with trailing opcode', () => Buffer.concat([standard(), Buffer.from([opcodes.OP_NOP])])],
    ['commitment used as ordinary funding', () => transaction(commitment().rawTransaction).outs[0].script],
    ['reserve transfer', () => smartScript(EVALS.EVAL_RESERVE_TRANSFER, [reservePayload({[TOKEN]: '1'})])],
    ['reserve deposit', () => smartScript(EVALS.EVAL_RESERVE_DEPOSIT, [reservePayload({[TOKEN]: '1'})])],
    ['identity definition', () => smartScript(EVALS.EVAL_IDENTITY_PRIMARY, [reservePayload({[TOKEN]: '1'})])],
    ['unknown eval code', () => smartScript(255, [reservePayload({[TOKEN]: '1'})])],
    ['missing reserve payload', () => smartScript(EVALS.EVAL_RESERVE_OUTPUT, [])],
    ['extra reserve payload', () => smartScript(EVALS.EVAL_RESERVE_OUTPUT, [reservePayload({[TOKEN]: '1'}), Buffer.alloc(1)])],
    ['invalid token version', () => smartScript(EVALS.EVAL_RESERVE_OUTPUT, [reservePayload({[TOKEN]: '1'}, 0)])],
    ['unknown token version', () => smartScript(EVALS.EVAL_RESERVE_OUTPUT, [reservePayload({[TOKEN]: '1'}, 2)])],
    ['truncated token data', () => smartScript(EVALS.EVAL_RESERVE_OUTPUT, [reservePayload({[TOKEN]: '1'}).subarray(0, -1)])],
    ['trailing token data', () => smartScript(EVALS.EVAL_RESERVE_OUTPUT, [Buffer.concat([reservePayload({[TOKEN]: '1'}), Buffer.from([0])])])],
    ['native currency inside reserve map', () => smartScript(EVALS.EVAL_RESERVE_OUTPUT, [reservePayload({[SYSTEM]: '999999999'})])],
    ['zero native currency inside reserve map', () => smartScript(EVALS.EVAL_RESERVE_OUTPUT, [reservePayload({[SYSTEM]: '0'})])],
    ['zero currency identity', () => smartScript(EVALS.EVAL_RESERVE_OUTPUT, [reservePayload({[destination(0, true).toAddress()]: '1'})])],
    ['negative reserve', () => mutateMap((payload, start) => payload.fill(255, start + 20, start + 28))],
    ['reserve above signed 64-bit limit', () => smartScript(EVALS.EVAL_RESERVE_OUTPUT, [reservePayload({[TOKEN]: '9223372036854775808'})])],
    ['duplicate reserve currency', () => mutateMap((payload, start) => payload.copy(payload, start + 28, start, start + 20))],
    ['unsorted reserve map', () => mutateMap((payload, start) => {
      const first = Buffer.from(payload.subarray(start, start + 28));
      payload.copy(payload, start, start + 28, start + 56);
      first.copy(payload, start + 28);
    })],
    ['invalid condition threshold', () => mutatedSmart(value => { value.paramsOptCC.m = new BN(0); })],
    ['threshold exceeds destination count', () => mutatedSmart(value => { value.paramsOptCC.m = new BN(2); })],
    ['different master recipient', () => mutatedSmart(value => { value.masterOptCC.destinations = [RECIPIENT]; })],
    ['master data payload', () => mutatedSmart(value => { value.masterOptCC.vData = [Buffer.from([0])]; })],
    ['unsupported smart version', () => mutatedSmart(value => { value.paramsOptCC.version = new BN(2); })],
  ])('rejects %s before it can become change or a miner fee', async (_label, buildScript) => {
    const candidate = source({scriptHex: buildScript().toString('hex')}, 100000000);
    await expect(select([candidate], [payment({[SYSTEM]: '1000'})])).rejects.toThrow();
  });

  test('an empty reserve map does not invent funds or swallow native change', async () => {
    const candidate = source({scriptHex: smartScript(EVALS.EVAL_RESERVE_OUTPUT, [reservePayload({})]).toString('hex')}, 6001);
    const {change} = await select([candidate], [payment({[SYSTEM]: '5000'})]);
    expect(change).toEqual({[SYSTEM]: '1'});
  });

  test.each([
    ['unspent amount', {value: '0.01000001'}],
    ['unspent script', {scriptPubKey: {hex: '51'}}],
    ['changed chain tip', {bestblock: 'ff'.repeat(32)}],
    ['interest-bearing input', {interest: 0.00000001}],
    ['unconfirmed commitment', {confirmations: 0}],
  ])('rejects inconsistent %s instead of inflating the usable balance', async (_label, override) => {
    const candidate = commitment(1000000);
    await expect(readRegistrationPrevout(rpcFor([candidate], override), candidate, snapshot, true)).rejects.toThrow();
  });

  test.each(['output', 'mandatory input'])('selection rejects misleading %s amount metadata before returning a transaction', async kind => {
    const committed = commitment(6000);
    const mandatory = await readRegistrationPrevout(rpcFor([committed]), committed, snapshot, true);
    const outputs = [payment({[SYSTEM]: '5000'})];
    if (kind === 'output') outputs[0].values[SYSTEM] = '1';
    else mandatory.values[SYSTEM] = '7000';
    await expect(fundRegistration(rpcFor([committed]), snapshot, outputs, '1000', [], OWNER.toAddress(), mandatory))
      .rejects.toThrow();
  });
});

// Selection waits on live UTXO verification. Caller-owned form/approval objects
// must not change the approved economic intent while those requests are pending.
test.each(['outputs', 'funding', 'snapshot', 'mandatory input'])(
  'retains original approval when caller %s mutate during UTXO verification',
  async kind => {
    const committed = commitment(1000);
    const candidate = funds({[SYSTEM]: '10000', [TOKEN]: '10'});
    const sources = [committed, candidate];
    const rpc = rpcFor(sources);
    const mandatory = await readRegistrationPrevout(rpc, committed, snapshot, true);
    const outputs = [payment({[SYSTEM]: '5000'})];
    const approvedOutputs = outputs.map(output => ({...output, values: {...output.values}}));
    const funding = [{...candidate}];
    const approvedSnapshot = {...snapshot};
    const originalGetTxOut = rpc.getTxOut.getMockImplementation();
    let allowRpc;
    let reachedRpc;
    const pendingRpc = new Promise(resolve => {allowRpc = resolve;});
    const rpcStarted = new Promise(resolve => {reachedRpc = resolve;});
    rpc.getTxOut.mockImplementationOnce(async (...args) => {
      reachedRpc();
      await pendingRpc;
      return originalGetTxOut(...args);
    });
    const pending = fundRegistration(rpc, approvedSnapshot, outputs, '1000', funding, OWNER.toAddress(), mandatory);
    await rpcStarted;
    if (kind === 'outputs') {
      outputs[0].scriptHex = payment({[SYSTEM]: '5000'}, ID_OWNER).scriptHex;
      outputs[0].value = '1';
      outputs[0].values[SYSTEM] = '1';
    } else if (kind === 'funding') {
      funding[0].txid = 'ff'.repeat(32);
      funding[0].vout = 99;
      funding[0].rawTransaction = '00';
    } else if (kind === 'snapshot') {
      approvedSnapshot.systemID = TOKEN;
      approvedSnapshot.expiryHeight = 1;
    } else {
      mandatory.value = '999999';
      mandatory.values[SYSTEM] = '999999';
      mandatory.rawTransaction = '00';
    }
    allowRpc();
    const result = await pending;
    expect(transaction(result.txHex).expiryHeight).toBe(snapshot.expiryHeight);
    expect(assertConserved(result, sources, approvedOutputs, '1000'))
      .toEqual({[SYSTEM]: '5000', [TOKEN]: '10'});
  },
);
