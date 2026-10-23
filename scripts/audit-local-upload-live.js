#!/usr/bin/env node
'use strict';

// Explicitly authorized testnet acceptance/retrieval audit. This spends testnet
// fees and updates alice@. Retain exact signed bytes before broadcast; reruns
// query/retry that same transaction and never re-encrypt an existing attempt.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { randomBytes } = require('crypto');
const p = require('verus-typescript-primitives');
const { Transaction, networks } = require('@bitgo/utxo-lib');
const bech32 = require('bech32').bech32;
const { rpc } = require('./local-upload-daemon-rpc');
const { VerusIdInterface, verifyIdentityUpdateData, verifyIdentityUpdateFunding } = require('../lib');
const { parseScript } = require('../lib/identity/fundingPrimitives');
const { readIdentityUpdateEvidence } = require('../lib/identity/updateDataEvidence');
const native = process.env.VERUS_NATIVE_CRYPTO || '/tmp/local-upload-native-crypto';
const privateRecipient = require('../src/__tests__/fixtures/local-upload/public-recipient.json');
const statePath = path.join(__dirname, '../src/__tests__/fixtures/local-upload/live-acceptance.json');
const chainId = 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq';
const nativeOutpoint = { txid: 'd087a10ba5391aba4be7de13f5bfd9a9d234d323ebda5d8dff3be5c06646b603', vout: 99 };
const reserveOutpoint = { txid: '7c1cbdec73ded3a6255ef2646f71af2b9e8911e5692f8181daf5261a734ba406', vout: 1 };
const contentKeys = [
  'iK7a5JNJnbeuYWVHCDRpJosj3irGJ5Qa8c',
  'iP2cgAhoWvJr28BhJiTQPD7KBqAXbJNYeW',
  'iCiPUjJsBYVhr4G5hbp8u6i8v2QoaLJaua',
  'iLme69iDKF3hdEF7kSFeRxvyhVigF5Dbwu',
];
const save = (state) => {
  fs.writeFileSync(statePath + '.tmp', JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(statePath + '.tmp', statePath);
};
const decodeNative = (descriptor) => Buffer.from(execFileSync(native, [
  'decrypt', descriptor.ivk?.toString('hex') || privateRecipient.ivk,
  descriptor.epk.toString('hex'), descriptor.objectdata.toString('hex'),
], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim(), 'hex');
function requestOf(state) {
  const signDataMap = new p.KvMap();
  state.uploads.forEach((upload, index) => signDataMap.set(
    p.CompactIAddressObject.fromAddress(contentKeys[index]), p.PartialSignData.fromCLIJson(upload)
  ));
  return new p.IdentityUpdateRequestDetails({
    identity: p.PartialIdentity.fromJson({ name: state.source.identity.name, parent: state.source.identity.parent }),
    signDataMap,
  });
}
function uploadOnly(tx) {
  const copy = Transaction.fromHex(tx.toHex(), networks.verus);
  copy.ins = [];
  copy.outs = copy.outs.filter((output) => {
    try {
      const code = parseScript(p.SmartTransactionScript, output.script).paramsOptCC.evalCode.toNumber();
      return code === p.EVALS.EVAL_NOTARY_EVIDENCE || code === p.EVALS.EVAL_IDENTITY_PRIMARY;
    } catch (_) { return false; }
  });
  return copy;
}
async function prepare() {
  const info = await rpc('getinfo');
  assert(info.testnet && info.chainid === chainId);
  const source = await rpc('getidentity', ['alice@']);
  const available = await rpc('listunspent', [1, 9999999]);
  const coins = [nativeOutpoint, reserveOutpoint].map((outpoint) => {
    const coin = available.find((value) => value.txid === outpoint.txid && value.vout === outpoint.vout);
    assert(coin?.spendable, 'Reserved testnet funding input unavailable');
    return coin;
  });
  const state = {
    status: 'preparing', authorization: 'User explicitly authorized testnet spending and identity updates to complete acceptance/retrieval audit.',
    chainId, daemonVersion: info.VRSCversion, preparationHeight: info.blocks,
    source, sourceRawTransaction: await rpc('getrawtransaction', [source.txid]),
    uploads: [
      { createmmr: true, message: 'SDK local public upload live audit 2026-10-20' },
      { createmmr: true, encrypttoaddress: privateRecipient.address, message: 'SDK local private upload live audit 2026-10-20' },
      { createmmr: true, encrypttoaddress: privateRecipient.address,
        mmrdata: [{ message: 'live MMR leaf one' }, { message: 'live MMR leaf two' }, { message: 'live MMR leaf three' }],
        mmrsalt: ['81'.repeat(32), '82'.repeat(32), '83'.repeat(32)] },
      { createmmr: true, mmrdata: [{ message: 'local multipart live audit:'.repeat(480) }],
        mmrsalt: ['84'.repeat(32)] },
    ],
    publicRecipients: [], sdkRpcMethods: [], nativeFunding: nativeOutpoint, reserveFunding: reserveOutpoint,
  };
  const wallet = {
    randomBytes,
    createPublicRecipient: () => {
      const generated = JSON.parse(execFileSync(native, ['recipient'], { encoding: 'utf8' }));
      const address = bech32.encode('zs', bech32.toWords(Buffer.from(generated.addressBytes, 'hex')), 1023);
      const recipient = { address, ivk: generated.ivk };
      state.publicRecipients.push(recipient);
      return { address, ivk: Buffer.from(generated.ivk, 'hex') };
    },
    encrypt: (plaintext, address) => {
      const raw = Buffer.from(bech32.fromWords(bech32.decode(address, 1023).words));
      const result = JSON.parse(execFileSync(native, ['encrypt', raw.toString('hex'), plaintext.toString('hex')],
        { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
      return { epk: Buffer.from(result.epk, 'hex'), ciphertext: Buffer.from(result.ciphertext, 'hex') };
    },
    decryptData: decodeNative,
  };
  const sdk = new VerusIdInterface('VRSCTEST', 'http://127.0.0.1:18843');
  sdk.interface = new Proxy({}, { get: (_object, method) => async (...args) => {
    state.sdkRpcMethods.push(method);
    const allowed = { getIdentity: 'getidentity', getRawTransaction: 'getrawtransaction',
      fundRawTransaction: 'fundrawtransaction', getCurrency: 'getcurrency' };
    assert(allowed[method], 'Unexpected construction RPC: ' + method);
    return { result: await rpc(allowed[method], args), error: null };
  } });
  const utxos = coins.map((coin) => ({ txid: coin.txid, outputIndex: coin.vout,
    script: coin.scriptPubKey, satoshis: Math.round(coin.amount * 1e8),
    address: coin.address, height: info.blocks - coin.confirmations + 1, isspendable: true, blocktime: 1 }));
  const reserveCurrency = Object.keys(coins[1].currencyvalues).find((id) => id !== chainId);
  state.approvedTransfer = { currency: reserveCurrency, atomicAmount: '1', recipient: coins[1].address };
  const result = await sdk.createUpdateIdentityWithCurrencyTransferTransaction(
    requestOf(state), source.identity.primaryaddresses[0], state.sourceRawTransaction, source.blockheight,
    [{ currencies: { [reserveCurrency]: '1' }, address: new p.TransferDestination({
      type: p.DEST_PKH, destinationBytes: p.fromBase58Check(coins[1].address).hash,
    }) }], utxos,
    { chainIAddr: chainId, currentHeight: info.blocks, isTestnet: true,
      expectedIdentityPrimaryAddresses: source.identity.primaryaddresses,
      expectedIdentityMinimumSignatures: source.identity.minimumsignatures, localUploadCrypto: wallet }
  );
  assert(result.fundingApproval);
  verifyIdentityUpdateFunding(result.fundingApproval, result.hex);
  state.unsignedHex = result.hex;
  state.fundingApproval = result.fundingApproval;
  state.status = 'funding-verified';
  save(state);
  console.log(`Prepared local ${state.uploads.length}-key upload; verified fee ${Number(result.fundingApproval.nativeFee) / 1e8} VRSCTEST.`);
  return state;
}
async function retrieve(state) {
  const verbose = await rpc('getrawtransaction', [state.txid, 1]);
  assert.strictEqual(verbose.hex, state.signedHex);
  const chainTransaction = Transaction.fromHex(verbose.hex, networks.verus);
  verifyIdentityUpdateFunding(state.fundingApproval, verbose.hex);
  const uploadTransaction = uploadOnly(chainTransaction);
  let authenticatedDescriptorCount = 0;
  await verifyIdentityUpdateData(requestOf(state), uploadTransaction.toHex(), (descriptor) => {
    authenticatedDescriptorCount++;
    return decodeNative(descriptor);
  }, chainId);
  const definition = uploadTransaction.outs.map((output) => {
    try { return parseScript(p.IdentityScript, output.script).getIdentity(); } catch (_) { return undefined; }
  }).find(Boolean);
  assert(definition);
  const references = [];
  for (const [index, key] of contentKeys.entries()) {
    const outer = new p.VDXFDataDescriptor();
    outer.fromBuffer(definition.contentMultiMap.kvContent.getByAddress(key)[0]);
    const options = {
      datadescriptor: outer.dataDescriptor.toJson(), txid: state.txid, retrieve: true,
      ...(state.uploads[index].encrypttoaddress ? { ivk: privateRecipient.ivk } : {}),
    };
    try {
      const result = await rpc('decryptdata', [options]);
      references.push({ key, result });
    } catch (error) { references.push({ key, error: error.message }); }
  }
  state.retrieval = {
    transactionBytesExact: true, fundingReverified: true, everyRequestedLeafAuthenticated: true,
    authenticatedDescriptorCount, groupOutputCounts: [...readIdentityUpdateEvidence(uploadTransaction.outs, chainId).values()].map((group) => group.outputIndexes.length),
    daemonRetrieveResults: references,
  };
  state.confirmations = verbose.confirmations || 0;
  state.blockhash = verbose.blockhash;
  if (state.confirmations > 0) {
    const block = await rpc('getblock', [verbose.blockhash]);
    state.confirmationHeight = block.height;
    state.confirmedIdentity = await rpc('getidentity', ['alice@', block.height]);
    assert.strictEqual(state.confirmedIdentity.txid, state.txid);
    state.identityContent = await rpc('getidentitycontent', ['alice@', block.height, block.height, false]);
    state.status = 'confirmed-and-retrieved';
  }
  save(state);
  return state.confirmations;
}
async function main() {
  assert.strictEqual(process.env.VERUS_UPLOAD_LIVE, '1', 'Explicit live audit flag required');
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : await prepare();
  if (!state.signedHex) {
    const signed = await rpc('signrawtransaction', [state.unsignedHex]);
    assert.strictEqual(signed.complete, true, 'Daemon could not completely sign authorized testnet transaction');
    verifyIdentityUpdateFunding(state.fundingApproval, signed.hex);
    const onlyUploads = uploadOnly(Transaction.fromHex(signed.hex, networks.verus));
    await verifyIdentityUpdateData(requestOf(state), onlyUploads.toHex(), decodeNative, chainId);
    state.signedHex = signed.hex;
    state.txid = Transaction.fromHex(signed.hex, networks.verus).getId();
    state.status = 'signed-and-verified';
    save(state);
  }
  if (!['broadcast', 'confirmed-and-retrieved'].includes(state.status)) {
    try {
      const alreadyKnown = await rpc('getrawtransaction', [state.txid, 1]);
      assert.strictEqual(alreadyKnown.hex, state.signedHex);
    } catch (_) {
      state.broadcastAttemptedAt = new Date().toISOString();
      save(state);
      const txid = await rpc('sendrawtransaction', [state.signedHex]);
      assert.strictEqual(txid, state.txid);
    }
    state.status = 'broadcast';
    state.mempoolAccepted = (await rpc('getrawmempool')).includes(state.txid);
    save(state);
    console.log(`Broadcast verified testnet upload ${state.txid}; mempool accepted=${state.mempoolAccepted}.`);
  }
  for (let attempt = 0; attempt < 80; attempt++) {
    const confirmations = await retrieve(state);
    console.log(`Upload ${state.txid}: ${confirmations} confirmations; all requested leaves authenticated from retrieved transaction.`);
    if (confirmations > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 15000));
  }
  throw new Error('Still awaiting confirmation; rerun to query the retained signed transaction without rebuilding.');
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
