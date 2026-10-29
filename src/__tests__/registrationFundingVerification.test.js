// These fixtures build real transaction/script bytes directly from primitives.
// They never use the SDK coin selector, output planner, or transaction validator.
const {address: addresses, ECPair, networks, script, SmartTransactionSignatures, Transaction, TransactionBuilder} = require('@bitgo/utxo-lib');
const {
  AdvancedNameReservation, BigNumber: BN, CurrencyValueMap, EVALS, Identity,
  IdentityCommitmentScript, IdentityID, IdentityReservationScript, IdentityScript,
  KeyID, OptCCParams, SmartTransactionScript, TokenOutput, TxDestination,
  nameAndParentAddrToIAddr,
} = require('verus-typescript-primitives');
const {verifyIdentityRegistrationFunding} = require('../identity/registrationFundingVerification');
const {default: VerusIdInterface} = require('../VerusIdInterface');
const {signIdentityRegistrationTransaction} = require('../identity/registrationSigning');

const system = nameAndParentAddrToIAddr('VRSC');
const token = nameAndParentAddrToIAddr('community', system);
const otherToken = nameAndParentAddrToIAddr('unrelated', system);
const key = ECPair.fromPrivateKeyBuffer(Buffer.alloc(32, 7), networks.verus);
const address = key.getAddress();
const attacker = ECPair.fromPrivateKeyBuffer(Buffer.alloc(32, 8), networks.verus).getAddress();
const identityFunding = nameAndParentAddrToIAddr('payer', system);
const referral = nameAndParentAddrToIAddr('friend', system);
const reserveAmounts = {[token]: '200000000', [otherToken]: '9007199254740993'};
const destination = recipient => new TxDestination(recipient.startsWith('i')
  ? IdentityID.fromAddress(recipient) : KeyID.fromAddress(recipient));
const params = (evalCode, recipients, vData = []) => new OptCCParams({
  version: new BN(3), evalCode: new BN(evalCode), m: new BN(recipients.length ? 1 : 0),
  n: new BN(recipients.length), destinations: recipients.map(destination), vData,
});
const transferScript = (recipient, reserves = {}) => {
  if (!Object.keys(reserves).length && !recipient.startsWith('i')) {
    return addresses.toOutputScript(recipient, networks.verus);
  }
  const payload = Object.keys(reserves).length ? new TokenOutput({
    version: new BN(1), values: new CurrencyValueMap({
      valueMap: new Map(Object.entries(reserves).map(([id, amount]) => [id, new BN(amount)])),
      multivalue: Object.keys(reserves).length !== 1,
    }),
  }).toBuffer() : null;
  return new SmartTransactionScript(
    params(EVALS.EVAL_NONE, payload ? [recipient] : []),
    params(payload ? EVALS.EVAL_RESERVE_OUTPUT : EVALS.EVAL_NONE, [recipient], payload ? [payload] : []),
  ).toBuffer();
};
const transaction = (inputs, outputs) => {
  const builder = new TransactionBuilder(networks.verus);
  builder.setVersion(4);
  builder.setVersionGroupId(0x892f2085);
  builder.setExpiryHeight(120);
  inputs.forEach(input => builder.addInput(input.txid, input.vout));
  outputs.forEach(output => builder.addOutput(output.script, output.value));
  return builder.buildIncomplete();
};
const prevout = (source, vout, values = {}) => ({
  txid: source.getId(), vout, rawTransaction: source.toHex(),
  scriptHex: source.outs[vout].script.toString('hex'), value: String(source.outs[vout].value),
  values: {[system]: String(source.outs[vout].value), ...values}, confirmations: 10, height: 90,
});
const fixture = ({stage = 'commitment', reserves = reserveAmounts, fundingAddress = address, referralPayment = false, commitmentValue = 0} = {}) => {
  const reservation = new AdvancedNameReservation({
    name: 'Alice', parent: IdentityID.fromAddress(system), salt: Buffer.alloc(32, 5),
  });
  const commitment = IdentityCommitmentScript.fromCommitment(reservation.getCommitment(), destination(address)).toBuffer();
  const source = transaction([{txid: 'a'.repeat(64), vout: 0}], [
    {script: transferScript(fundingAddress, reserves), value: 200000000},
    {script: commitment, value: commitmentValue},
  ]);
  const nativeFee = stage === 'commitment' ? '10000' : referralPayment ? '80000000' : '100000000';
  const quote = {
    branch: 'native', systemID: system, issuerID: system, parentID: system,
    feePricingCurrencyID: system, candidateHeight: 101,
    commitmentFee: '10000', registrationOffer: '100000000', nativeFee: referralPayment ? '80000000' : '100000000',
    importFee: '0', transferFee: '0',
    referralPayments: referralPayment ? [{recipient: referral, currencyID: system, amount: '20000000'}] : [],
    totalRequired: {[system]: '100000000'}, totalOperationRequired: {[system]: '100010000'},
  };
  const identityAddress = reservation.getIdentityAddress();
  const identity = new Identity({
    version: new BN(3), flags: new BN(0), minSigs: new BN(1),
    primaryAddresses: [KeyID.fromAddress(address)], name: 'Alice',
    parent: IdentityID.fromAddress(system), systemId: IdentityID.fromAddress(system),
    revocationAuthority: IdentityID.fromAddress(identityAddress),
    recoveryAuthority: IdentityID.fromAddress(identityAddress), unlockAfter: new BN(0),
  });
  const outputs = stage === 'commitment' ? [{script: commitment, value: 0}] : [
    {script: IdentityScript.fromIdentity(identity).toBuffer(), value: 0},
    ...(referralPayment ? [{script: transferScript(referral), value: 20000000}] : []),
    {script: IdentityReservationScript.fromReservation(reservation).toBuffer(), value: 0},
  ];
  outputs.push({script: transferScript(fundingAddress, reserves), value: stage === 'commitment' ? 199990000 : 100000000 + commitmentValue});
  const prevouts = stage === 'commitment' ? [prevout(source, 0, reserves)] : [prevout(source, 1), prevout(source, 0, reserves)];
  const candidate = transaction(prevouts, outputs);
  const prepared = {
    stage, txHex: candidate.toHex(), hex: candidate.toHex(), nativeFee, changeAddress: fundingAddress,
    identityAuthorities: [], revealAuthorities: [], requiredSignatures: [], signingStatus: 'unsigned',
    ...(stage === 'registration' ? {commitment: {txid: source.getId(), vout: 1}} : {}),
    snapshot: {systemID: system, expiryHeight: 120, candidateHeight: 101}, quote, prevouts,
    approvedCosts: quote.totalOperationRequired,
    outputPlan: outputs.map((output, i) => ({
      role: i === outputs.length - 1 ? 'change' : stage === 'commitment' ? 'commitment' : i === 0 ? 'identity' :
        referralPayment && i === 1 ? 'referral' : 'reservation',
      scriptHex: output.script.toString('hex'), value: String(output.value),
      values: {[system]: String(output.value), ...(i === outputs.length - 1 ? reserves : {})},
    })),
  };
  return {stage, prepared, candidate, source, reserves, fundingAddress};
};
const replaceCandidate = (state, mutate, signed = false) => {
  mutate(state.candidate);
  state.prepared.txHex = state.candidate.toHex();
  // Coordinate every piece of planner metadata with the hostile bytes. The
  // independent guard must still reject these internally consistent plans.
  state.prepared.outputPlan = state.candidate.outs.map(output => ({
    role: 'change', scriptHex: output.script.toString('hex'), value: String(output.value),
    values: {[system]: String(output.value)},
  }));
  if (signed) state.candidateHex = state.candidate.toHex();
};
const rejected = state => expect(() => verifyIdentityRegistrationFunding(
  state.prepared, state.candidateHex, state.fundingAddress,
))
  .toThrow(expect.objectContaining({code: 'REGISTRATION_FUNDING_MISMATCH'}));

test.each([
  ['commitment', address, {}], ['commitment', address, reserveAmounts], ['commitment', identityFunding, reserveAmounts],
  ['registration', address, {}], ['registration', address, reserveAmounts], ['registration', identityFunding, reserveAmounts],
])('accepts exact %s funding/change for %s with reserves %j', (stage, fundingAddress, reserves) => {
  const {prepared} = fixture({stage, fundingAddress, reserves});
  expect(verifyIdentityRegistrationFunding(prepared)).toBe(true);
});

test.each(['commitment', 'registration'])('accepts the exact consensus reserve limit during %s', stage => {
  const {prepared} = fixture({stage, reserves: {[token]: '5000000000000000000'}});
  expect(verifyIdentityRegistrationFunding(prepared)).toBe(true);
});

test.each(['5000000000000000001', '9223372036854775807'])(
  'independently rejects a reserve amount above consensus MoneyRange: %s', amount => {
    rejected(fixture({reserves: {[token]: amount}}));
  },
);

test.each([
  ['same currency above the limit', token, '3000000000000000000', '3000000000000000000', false],
  ['same currency exactly at the limit', token, '2000000000000000000', '3000000000000000000', true],
  ['different currencies each at the limit', otherToken, '5000000000000000000', '5000000000000000000', true],
])('independently checks combined reserve funding: %s', (_label, additionalCurrency, firstAmount, secondAmount, valid) => {
  const state = fixture({reserves: {[token]: firstAmount}});
  const extraSource = transaction([{txid: 'b'.repeat(64), vout: 0}], [
    {script: transferScript(address, {[additionalCurrency]: secondAmount}), value: 0},
  ]);
  state.prepared.prevouts.push(prevout(extraSource, 0, {[additionalCurrency]: secondAmount}));
  const change = additionalCurrency === token
    ? {[token]: String(BigInt(firstAmount) + BigInt(secondAmount))}
    : {[token]: firstAmount, [additionalCurrency]: secondAmount};
  state.candidate.outs[1].script = transferScript(address, change);
  state.candidate = transaction(state.prepared.prevouts, state.candidate.outs);
  state.prepared.txHex = state.candidate.toHex();
  if (valid) expect(verifyIdentityRegistrationFunding(state.prepared)).toBe(true);
  else rejected(state);
});

test('allows a legitimate large native registration fee and its exact referral payment', () => {
  const {prepared} = fixture({stage: 'registration', referralPayment: true});
  expect(verifyIdentityRegistrationFunding(prepared)).toBe(true);
});

test('derives balances from source bytes without depending on planner values or roles', () => {
  const {prepared} = fixture();
  prepared.outputPlan = [{role: 'not-a-real-role', value: '99999999999999'}];
  prepared.prevouts[0].values = {[system]: '1'};
  expect(verifyIdentityRegistrationFunding(prepared)).toBe(true);
});

test.each(['commitment', 'registration'])('rejects %s fees even one atomic unit above the reviewed amount', stage => {
  const state = fixture({stage});
  replaceCandidate(state, tx => tx.outs[tx.outs.length - 1].value--, true);
  rejected(state);
});

test.each([
  ['missing all change', state => replaceCandidate(state, tx => tx.outs.pop(), true)],
  ['missing native change but preserving reserves', state => replaceCandidate(state, tx => {tx.outs[1].value = 0;}, true)],
  ['unrelated reserve silently burned', state => replaceCandidate(state, tx => {
    tx.outs[1].script = transferScript(address, {[token]: reserveAmounts[token]});
  }, true)],
  ['one reserve atomic unit silently burned above Number.MAX_SAFE_INTEGER', state => replaceCandidate(state, tx => {
    tx.outs[1].script = transferScript(address, {...reserveAmounts, [otherToken]: '9007199254740992'});
  }, true)],
  ['reserve change minted without an input', state => replaceCandidate(state, tx => {
    tx.outs[1].script = transferScript(address, {...reserveAmounts, [token]: '200000001'});
  }, true)],
  ['native and reserve change redirected together', state => replaceCandidate(state, tx => {
    tx.outs[1].script = transferScript(attacker, reserveAmounts);
  }, true)],
  ['native-only change redirected', state => replaceCandidate(state, tx => {
    tx.outs.push({script: transferScript(attacker), value: 1});
    tx.outs[1].value--;
  }, true)],
  ['change address in both plan and transaction redirected', state => {
    state.prepared.changeAddress = attacker;
    replaceCandidate(state, tx => {tx.outs[1].script = transferScript(attacker, reserveAmounts);}, true);
  }],
  ['absurd fee coordinated with prepared.nativeFee', state => {
    state.prepared.nativeFee = '199999999';
    replaceCandidate(state, tx => {tx.outs[1].value = 1;}, true);
  }],
  ['value hidden in commitment metadata', state => replaceCandidate(state, tx => {
    tx.outs[0].value = 1; tx.outs[1].value--;
  }, true)],
  ['arbitrary unspendable output', state => replaceCandidate(state, tx => {
    tx.outs.push({script: Buffer.from('6a', 'hex'), value: 0});
  }, true)],
  ['duplicate input coordinated with copied prevout', state => {
    state.prepared.prevouts.push({...state.prepared.prevouts[0]});
    replaceCandidate(state, tx => tx.ins.push({...tx.ins[0]}), true);
  }],
  ['source raw transaction hash mismatch', state => {
    state.source.outs[0].value++;
    state.prepared.prevouts[0].rawTransaction = state.source.toHex();
  }],
  ['missing raw source transaction', state => {delete state.prepared.prevouts[0].rawTransaction;}],
  ['nonexistent source output', state => {
    state.prepared.prevouts[0].vout = 100;
    replaceCandidate(state, tx => {tx.ins[0].index = 100;});
  }],
  ['different input hash', state => replaceCandidate(state, tx => {tx.ins[0].hash = Buffer.alloc(32, 1);})],
  ['nonfinal input sequence', state => replaceCandidate(state, tx => {tx.ins[0].sequence = 1;})],
  ['unsupported transaction version', state => replaceCandidate(state, tx => {tx.version = 3;})],
  ['nonzero lock time', state => replaceCandidate(state, tx => {tx.locktime = 1;})],
  ['malformed unsigned bytes', state => {state.prepared.txHex = 'not-hex';}],
  ['trailing transaction bytes', state => {state.prepared.txHex += '00';}],
  ['malformed source bytes', state => {state.prepared.prevouts[0].rawTransaction = '00';}],
  ['signed transaction differs from reviewed unsigned bytes', state => {
    state.candidate.outs[1].value--;
    state.candidateHex = state.candidate.toHex();
  }],
  ['malformed signed bytes', state => {state.candidateHex = '00';}],
])('rejects %s without trusting coordinated output-plan metadata', (_description, mutate) => {
  const state = fixture();
  mutate(state);
  rejected(state);
});

test.each([
  ['redirected referral', tx => {tx.outs[1].script = transferScript(attacker);}],
  ['underpaid referral and extra change', tx => {tx.outs[1].value--; tx.outs[3].value++;}],
  ['overpaid referral and reduced change', tx => {tx.outs[1].value++; tx.outs[3].value--;}],
  ['value embedded in identity metadata', tx => {tx.outs[0].value++; tx.outs[3].value--;}],
  ['value embedded in unspendable reservation metadata', tx => {tx.outs[2].value++; tx.outs[3].value--;}],
  ['missing reservation', tx => {tx.outs.splice(2, 1);}],
  ['duplicate identity output', tx => {tx.outs.push({...tx.outs[0]});}],
])('rejects registration %s', (_description, mutate) => {
  const state = fixture({stage: 'registration', referralPayment: true});
  replaceCandidate(state, mutate, true);
  rejected(state);
});

test('requires the actual saved name commitment outpoint during reveal', () => {
  const state = fixture({stage: 'registration'});
  state.prepared.commitment.vout = 0;
  rejected(state);
});

test.each([
  ['an arbitrary P2SH source', () => Buffer.from(`a914${'11'.repeat(20)}87`, 'hex')],
  ['an arbitrary OP_RETURN source', () => Buffer.from('6a', 'hex')],
  ['a reserve map duplicating the native currency', () => transferScript(address, {[system]: '100'})],
  ['a reserve map with a zero currency identity', () => transferScript(address, {[new IdentityID(Buffer.alloc(20)).toAddress()]: '100'})],
  ['trailing reserve payload bytes', () => {
    const smart = new SmartTransactionScript();
    smart.fromBuffer(transferScript(address, reserveAmounts));
    smart.paramsOptCC.vData[0] = Buffer.concat([smart.paramsOptCC.vData[0], Buffer.from('00', 'hex')]);
    return smart.toBuffer();
  }],
])('rejects %s even when source hash and cached amounts agree', (_description, makeScript) => {
  const state = fixture();
  state.source.outs[0].script = makeScript();
  state.prepared.prevouts[0] = prevout(state.source, 0, reserveAmounts);
  replaceCandidate(state, tx => {tx.ins[0].hash = Buffer.from(state.source.getId(), 'hex').reverse();}, true);
  rejected(state);
});


test('accepts native value on the mandatory commitment and returns it as exact change', () => {
  const {prepared} = fixture({stage: 'registration', commitmentValue: 6001});
  expect(verifyIdentityRegistrationFunding(prepared)).toBe(true);
});

test('rejects redirected candidate change using the retained prepared approval by default', () => {
  const {prepared, candidate} = fixture();
  candidate.outs[1].script = transferScript(attacker, reserveAmounts);
  expect(() => verifyIdentityRegistrationFunding(prepared, candidate.toHex()))
    .toThrow(expect.objectContaining({code: 'REGISTRATION_FUNDING_MISMATCH'}));
});

// The checked broadcast API performs both independent accounting and signature
// verification locally before the only mocked operation: the actual RPC send.
const checkedSender = (response) => {
  const rpc = jest.fn(async request => {
    expect(request.method).toBe('sendrawtransaction');
    return {id: request.id, error: null,
      result: response || Transaction.fromHex(request.params[0], networks.verus).getId()};
  });
  const client = new VerusIdInterface(system, 'http://unused.invalid', undefined, rpc);
  return {client, rpc};
};
const sign = prepared => signIdentityRegistrationTransaction({
  txHex: prepared.txHex, prevouts: prepared.prevouts, identityAuthorities: [],
  keys: prepared.prevouts.map(() => [key.toWIF()]),
});

const corruptPlan = (state, attack) => {
  const index = state.candidate.outs.length - 1;
  const change = state.candidate.outs[index];
  if (attack === 'excess fee') {
    state.prepared.nativeFee = String(Number(state.prepared.nativeFee) + change.value - 1);
    change.value = 1;
  } else if (attack === 'redirected change') {
    state.prepared.changeAddress = attacker;
    change.script = transferScript(attacker, state.reserves);
  } else {
    change.script = transferScript(address);
  }
  state.prepared.txHex = state.candidate.toHex();
  state.prepared.hex = state.candidate.toHex();
  state.prepared.outputPlan[index] = {
    role: 'change', scriptHex: change.script.toString('hex'), value: String(change.value),
    values: {[system]: String(change.value), ...(attack === 'lost reserve' ? {} : state.reserves)},
  };
};

describe('checked identity registration broadcast', () => {
  test.each(['commitment', 'registration'])('sends a completely signed %s after local verification', async stage => {
    const {prepared} = fixture({stage});
    const {client, rpc} = checkedSender();
    // The standalone default uses the retained prepared approval, without any
    // wallet-specific job record, funding address, storage, or account context.
    Object.freeze(prepared);
    const signed = client.signIdentityRegistrationTransaction({
      transaction: prepared, keys: prepared.prevouts.map(() => [key.toWIF()]),
    });
    expect(signed.signingStatus).toBe('complete');
    await expect(client.sendIdentityRegistrationTransaction(prepared, signed.txHex))
      .resolves.toMatchObject({result: signed.txid, error: null});
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0].params[0]).toBe(signed.txHex);
  });

  test.each(['commitment', 'registration'])('never sends unsigned %s bytes', async stage => {
    const {prepared} = fixture({stage});
    const {client, rpc} = checkedSender();
    await expect(client.sendIdentityRegistrationTransaction(prepared, prepared.txHex))
      .rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  test('never sends a partially signed reveal', async () => {
    const {prepared} = fixture({stage: 'registration'});
    const {client, rpc} = checkedSender();
    const partial = signIdentityRegistrationTransaction({
      txHex: prepared.txHex, prevouts: prepared.prevouts,
      identityAuthorities: [], keys: [[key.toWIF()], []],
    });
    expect(partial.signingStatus).toBe('partial');
    await expect(client.sendIdentityRegistrationTransaction(prepared, partial.txHex))
      .rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  test.each(['commitment', 'registration'].flatMap(stage =>
    ['excess fee', 'redirected change', 'lost reserve'].map(attack => [stage, attack]),
  ))('rejects coordinated %s %s on first send and retry despite a replaced public validator', async (stage, attack) => {
    const state = fixture({stage});
    const {client, rpc} = checkedSender();
    // First prove the real original transaction and signatures pass every
    // validator, then coordinate metadata and bytes to model a selector bug.
    const valid = sign(state.prepared);
    expect(client.validateIdentityRegistrationTransaction(state.prepared, valid.txHex))
      .toMatchObject({valid: true, signingStatus: 'complete'});
    corruptPlan(state, attack);
    const corrupted = sign(state.prepared);
    jest.spyOn(client, 'validateIdentityRegistrationTransaction').mockReturnValue({
      valid: true, signingStatus: 'complete', txid: corrupted.txid,
    });
    // The independent layer rejects the corrupt economics on its own, while
    // checked sends also retain the ordinary plan/signature validation.
    expect(() => verifyIdentityRegistrationFunding(
      state.prepared, corrupted.txHex, state.fundingAddress,
    )).toThrow(expect.objectContaining({code: 'REGISTRATION_FUNDING_MISMATCH'}));
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(client.sendIdentityRegistrationTransaction(
        state.prepared, corrupted.txHex, state.fundingAddress,
      )).rejects.toThrow();
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  test('does not reuse an earlier send validation after candidate bytes change', async () => {
    const state = fixture();
    const {client, rpc} = checkedSender();
    const signed = sign(state.prepared);
    await client.sendIdentityRegistrationTransaction(state.prepared, signed.txHex);
    expect(rpc).toHaveBeenCalledTimes(1);
    const changed = Transaction.fromHex(signed.txHex, networks.verus);
    changed.outs[1].value--;
    await expect(client.sendIdentityRegistrationTransaction(state.prepared, changed.toHex()))
      .rejects.toThrow();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  test('sends and identifies valid signatures in their original order', async () => {
    const {prepared} = fixture({fundingAddress: identityFunding});
    const secondKey = ECPair.fromPrivateKeyBuffer(Buffer.alloc(32, 9), networks.verus);
    prepared.identityAuthorities = [{
      identityID: identityFunding,
      primaryAddresses: [key.getAddress(), secondKey.getAddress()],
      minimumSignatures: 2,
    }];
    const {client, rpc} = checkedSender();
    const signed = client.signIdentityRegistrationTransaction({
      transaction: prepared, keys: [[key.toWIF(), secondKey.toWIF()]],
    });
    const candidate = Transaction.fromHex(signed.txHex, networks.verus);
    const fulfillment = SmartTransactionSignatures.fromChunk(script.decompile(candidate.ins[0].script)[0]);
    fulfillment.signatures.reverse();
    candidate.ins[0].script = script.compile([fulfillment.toBuffer()]);
    expect(candidate.getId()).not.toBe(signed.txid);
    await expect(client.sendIdentityRegistrationTransaction(prepared, candidate.toHex()))
      .resolves.toMatchObject({result: candidate.getId(), error: null});
    expect(rpc.mock.calls[0][0].params[0]).toBe(candidate.toHex());
  });

  test('reports an unknown outcome when the RPC returns a different transaction ID', async () => {
    const {prepared} = fixture();
    const signed = sign(prepared);
    const {client, rpc} = checkedSender('b'.repeat(64));
    await expect(client.sendIdentityRegistrationTransaction(prepared, signed.txHex))
      .rejects.toMatchObject({code: 'BROADCAST_UNKNOWN', details: {txid: signed.txid}});
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  test.each(['transport error', 'RPC error', 'missing response'])('reports an unknown outcome after a possible send: %s', async outcome => {
    const {prepared} = fixture();
    const signed = sign(prepared);
    const {client} = checkedSender();
    const send = jest.spyOn(client.interface, 'sendRawTransaction');
    if (outcome === 'transport error') send.mockRejectedValue(new Error('Response timed out'));
    else if (outcome === 'RPC error') send.mockResolvedValue({error: {code: -27, message: 'Transaction already in chain'}, result: null});
    else send.mockResolvedValue(undefined);
    await expect(client.sendIdentityRegistrationTransaction(prepared, signed.txHex))
      .rejects.toMatchObject({
        code: 'BROADCAST_UNKNOWN',
        message: expect.stringContaining('may have been submitted'),
        details: {txid: signed.txid},
      });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
