import { BN } from 'bn.js';
import { Transaction, networks, smarttxs } from '@bitgo/utxo-lib';
import { DEST_ID, DEST_PKH, fromBase58Check, Identity, nameAndParentAddrToIAddr, TransferDestination } from 'verus-typescript-primitives';
import { VerusIdInterface } from '../index';
import { CurrencyTransferOutput, IdentityUpdateCurrencyTransferOptions } from '../VerusIdInterface';
import { TEST_ID_2, TEST_ID_3, TEST_ID_3_RAW_TX, VERUSTEST_I_ADDR } from './fixtures/verusid';

const FIRST = TEST_ID_3.identity.primaryaddresses[0];
const SECOND = TEST_ID_2.identity.primaryaddresses[0];
const SUBJECT = TEST_ID_3.identity.identityaddress;
const FEE_SOURCE = TEST_ID_2.identity.identityaddress;
const TOKEN = nameAndParentAddrToIAddr('sweeptesttoken', VERUSTEST_I_ADDR);
const HEIGHT = 31677;
const destination = (address: string, identity = false) => new TransferDestination({
  type: identity ? DEST_ID : DEST_PKH, destinationBytes: fromBase58Check(address).hash,
});
const outputs = (payments: CurrencyTransferOutput[]) => Transaction.fromHex(
  VerusIdInterface.createUnfundedCurrencyTransferTransaction(VERUSTEST_I_ADDR, payments, HEIGHT + 20), networks.verus,
);

// Distinct identity funds, fee funds, destinations and reserve currencies make
// accidental consolidation observable. Every prevout is verified by raw txid.
const fixture = (primaryAddresses = [FIRST, SECOND], minimumSignatures = 2) => {
  const identity = Identity.fromJson(TEST_ID_3.identity);
  identity.setPrimaryAddresses(primaryAddresses);
  identity.minSigs = new BN(minimumSignatures);
  const returnOutput = {currencies: {[VERUSTEST_I_ADDR]: '100000', [SUBJECT]: '500'}, address: destination(FIRST)};
  const source = outputs([{...returnOutput, address: destination(SUBJECT, true)}]);
  source.addInput(Buffer.alloc(32, 71), 0);
  const funding = outputs([{currencies: {[VERUSTEST_I_ADDR]: '100000000', [TOKEN]: '77'}, address: destination(FEE_SOURCE, true)}]);
  funding.addInput(Buffer.alloc(32, 72), 0);
  const raw = new Map([[source.getId(), source], [funding.getId(), funding]]);
  const utxos = [source, funding].map((transaction, i) => ({
    address: i === 0 ? SUBJECT : FEE_SOURCE, txid: transaction.getId(), outputIndex: 0,
    script: '00', satoshis: 1, height: 1, isspendable: true,
  }));
  const state = {
    mutate: (_transaction: any) => {},
    onHeight: () => {},
    requests: [] as string[],
  };
  const client = new VerusIdInterface(VERUSTEST_I_ADDR, 'https://offline.invalid', undefined, async (request): Promise<any> => {
    state.requests.push(request.method);
    const params = request.params as any[];
    if (request.method === 'getinfo') {
      state.onHeight();
      return {id: request.id, error: null, result: {longestchain: HEIGHT}};
    }
    if (request.method === 'getrawtransaction') {
      if (!raw.has(params[0])) throw new Error('Unexpected raw transaction');
      return {id: request.id, error: null, result: raw.get(params[0])!.toHex()};
    }
    if (request.method === 'fundrawtransaction') {
      const transaction = Transaction.fromHex(params[0], networks.verus);
      for (const prevout of utxos) transaction.addInput(Buffer.from(prevout.txid, 'hex').reverse(), prevout.outputIndex);
      const feeChange = outputs([{currencies: {[VERUSTEST_I_ADDR]: '99990000', [TOKEN]: '77'},
        address: destination(params[2], params[2] === FEE_SOURCE)}]);
      transaction.outs.push(...feeChange.outs);
      state.mutate(transaction);
      return {id: request.id, error: null, result: {hex: transaction.toHex(), fee: 0.0001, changepos: 2}};
    }
    throw new Error('Unexpected RPC request: ' + request.method);
  });
  const options: IdentityUpdateCurrencyTransferOptions = {chainIAddr: VERUSTEST_I_ADDR, maxFee: 0.0001,
    currentHeight: HEIGHT, expectedIdentityPrimaryAddresses: [...primaryAddresses], expectedIdentityMinimumSignatures: minimumSignatures};
  const run = (overrides: IdentityUpdateCurrencyTransferOptions = {}, changeAddress = FEE_SOURCE) =>
    client.createUpdateIdentityWithCurrencyTransferTransaction(identity, changeAddress, TEST_ID_3_RAW_TX,
      TEST_ID_3.blockheight, [returnOutput], utxos, {...options, ...overrides});
  return {client, identity, options, raw, source, funding, utxos, returnOutput, state, run};
};

describe('combined identity update expected signing policy', () => {
  test('supports multiple primary addresses while keeping explicit returns separate from fee-source change', async () => {
    const f = fixture();
    const result = await f.run();
    const transaction = Transaction.fromHex(result.hex, networks.verus);
    const returned = smarttxs.unpackOutput(transaction.outs[1], VERUSTEST_I_ADDR);
    const change = smarttxs.unpackOutput(transaction.outs[2], VERUSTEST_I_ADDR);
    expect(result.identity.toJson()).toMatchObject({primaryaddresses: [FIRST, SECOND], minimumsignatures: 2});
    expect(returned.destinations).toEqual([FIRST]);
    expect(returned.values[VERUSTEST_I_ADDR].toString()).toBe('100000');
    expect(returned.values[SUBJECT].toString()).toBe('500');
    expect(change.destinations).toEqual([FEE_SOURCE]);
    expect(change.values[VERUSTEST_I_ADDR].toString()).toBe('99990000');
    expect(change.values[TOKEN].toString()).toBe('77');
    expect(result.deltas.get(VERUSTEST_I_ADDR)!.toString()).toBe('-110000');
    expect(result.deltas.get(SUBJECT)!.toString()).toBe('-500');
    expect(result.deltas.get(TOKEN)!.toString()).toBe('0');
    expect(result.utxos).toHaveLength(3);
    expect(result.utxos[0].satoshis).toBe(100000); // Verified raw value replaces fabricated metadata.
    expect(result.utxos[1].satoshis).toBe(100000000);
    expect(f.state.requests.filter(method => method === 'getrawtransaction')).toHaveLength(2);
  });

  test.each([
    ['order', {expectedIdentityPrimaryAddresses: [SECOND, FIRST]}],
    ['address set', {expectedIdentityPrimaryAddresses: [FIRST]}],
    ['threshold', {expectedIdentityMinimumSignatures: 1}],
  ])('rejects an unexpected %s', async (_label, override) => {
    const f = fixture();
    const options = {...override};
    if (_label === 'address set') Object.assign(options, {expectedIdentityMinimumSignatures: 1});
    await expect(f.run(options)).rejects.toThrow('Identity signing policy does not match');
    expect(f.state.requests).toEqual([]);
  });

  test.each([
    ['addresses without threshold', {expectedIdentityMinimumSignatures: undefined}],
    ['threshold without addresses', {expectedIdentityPrimaryAddresses: undefined}],
    ['mixed single and complete expectations', {expectedIdentityPrimaryAddress: FIRST}],
    ['empty address list', {expectedIdentityPrimaryAddresses: []}],
    ['duplicate addresses', {expectedIdentityPrimaryAddresses: [FIRST, FIRST]}],
    ['identity address as primary', {expectedIdentityPrimaryAddresses: [FIRST, SUBJECT]}],
    ['invalid address', {expectedIdentityPrimaryAddresses: [FIRST, 'not-an-address']}],
    ['zero threshold', {expectedIdentityMinimumSignatures: 0}],
    ['negative threshold', {expectedIdentityMinimumSignatures: -1}],
    ['fractional threshold', {expectedIdentityMinimumSignatures: 1.5}],
    ['threshold greater than address count', {expectedIdentityMinimumSignatures: 3}],
    ['NaN threshold', {expectedIdentityMinimumSignatures: NaN}],
    ['too many addresses', {expectedIdentityPrimaryAddresses: Array(26).fill(FIRST)}],
  ])('rejects malformed expectations: %s', async (_label, override) => {
    const f = fixture();
    await expect(f.run(override)).rejects.toThrow(/Expected identity|Choose either/);
    expect(f.state.requests).toEqual([]);
  });

  test('preserves the existing default single-primary-address guard', async () => {
    const f = fixture();
    await expect(f.run({expectedIdentityPrimaryAddresses: undefined, expectedIdentityMinimumSignatures: undefined}, FIRST))
      .rejects.toThrow('Identity primary address must be exactly ' + FIRST);
    const single = fixture([FIRST], 1);
    await expect(single.run({expectedIdentityPrimaryAddresses: undefined, expectedIdentityMinimumSignatures: undefined}, FIRST))
      .resolves.toHaveProperty('hex');
  });

  test('preserves explicit single-primary expectations with a separate change destination', async () => {
    const f = fixture([FIRST], 1);
    await expect(f.run({expectedIdentityPrimaryAddresses: undefined, expectedIdentityMinimumSignatures: undefined,
      expectedIdentityPrimaryAddress: FIRST})).resolves.toHaveProperty('hex');
    await expect(f.run({expectedIdentityPrimaryAddresses: undefined, expectedIdentityMinimumSignatures: undefined,
      expectedIdentityPrimaryAddress: SECOND})).rejects.toThrow('Identity primary address must be exactly ' + SECOND);
  });

  test('retains a copy of addresses and threshold across an RPC await', async () => {
    const f = fixture();
    const approved = {...f.options, currentHeight: undefined};
    f.state.onHeight = () => {
      approved.expectedIdentityPrimaryAddresses!.reverse();
      approved.expectedIdentityMinimumSignatures = 1;
    };
    await expect(f.client.createUpdateIdentityWithCurrencyTransferTransaction(f.identity, FEE_SOURCE, TEST_ID_3_RAW_TX,
      TEST_ID_3.blockheight, [f.returnOutput], f.utxos, approved)).resolves.toHaveProperty('hex');
  });

  test('does not accept policy changes made while awaiting the network', async () => {
    const f = fixture();
    const expected = {...f.options, currentHeight: undefined, expectedIdentityPrimaryAddresses: [SECOND, FIRST]};
    f.state.onHeight = () => { expected.expectedIdentityPrimaryAddresses.reverse(); };
    await expect(f.client.createUpdateIdentityWithCurrencyTransferTransaction(f.identity, FEE_SOURCE, TEST_ID_3_RAW_TX,
      TEST_ID_3.blockheight, [f.returnOutput], f.utxos, expected)).rejects.toThrow('Identity signing policy does not match');
  });

  test.each(['return', 'change', 'reserve change', 'native fee'])('retains transaction verification when the daemon tampers with %s', async part => {
    const f = fixture();
    f.state.mutate = transaction => {
      if (part === 'return') transaction.outs[1] = outputs([{...f.returnOutput, address: destination(SECOND)}]).outs[0];
      if (part === 'change') transaction.outs[2] = outputs([{currencies: {[VERUSTEST_I_ADDR]: '99990000', [TOKEN]: '77'}, address: destination(FIRST)}]).outs[0];
      if (part === 'reserve change') transaction.outs[2] = outputs([{currencies: {[VERUSTEST_I_ADDR]: '99990000', [TOKEN]: '76'}, address: destination(FEE_SOURCE, true)}]).outs[0];
      if (part === 'native fee') transaction.outs[2].value -= 10000;
    };
    await expect(f.run()).rejects.toThrow();
  });
});
