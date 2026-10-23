#!/usr/bin/env node
'use strict';

// Run `npm run build` first. This script never broadcasts or records signed
// daemon reference transactions. Only their public output scripts are saved.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { randomBytes, createDecipheriv } = require('crypto');
const { rpc } = require('./local-upload-daemon-rpc');
const p = require('verus-typescript-primitives');
const { Transaction, networks } = require('@bitgo/utxo-lib');
const bech32 = require('bech32');
const { VerusIdInterface, verifyIdentityUpdateData, verifyIdentityUpdateFunding } = require('../lib');
const { readIdentityUpdateEvidence } = require('../lib/identity/updateDataEvidence');
const { parseScript } = require('../lib/identity/fundingPrimitives');
const recipient = require('../src/__tests__/fixtures/local-upload/public-recipient.json');
const native = process.env.VERUS_NATIVE_CRYPTO || '/tmp/local-upload-native-crypto';
const keys = [
  'iK7a5JNJnbeuYWVHCDRpJosj3irGJ5Qa8c',
  'iP2cgAhoWvJr28BhJiTQPD7KBqAXbJNYeW',
  'iCiPUjJsBYVhr4G5hbp8u6i8v2QoaLJaua',
];
const encodeAddress = (address) => Buffer.from(bech32.bech32.fromWords(bech32.bech32.decode(address, 1023).words)).toString('hex');
const decrypt = (descriptor) => Buffer.from(execFileSync(native, [
  'decrypt', descriptor.ivk?.toString('hex') || recipient.ivk, descriptor.epk.toString('hex'), descriptor.objectdata.toString('hex'),
], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim(), 'hex');
const walletCrypto = {
  randomBytes,
  createPublicRecipient: () => ({ address: recipient.address, ivk: Buffer.from(recipient.ivk, 'hex') }),
  encrypt: (bytes, address) => {
    const value = JSON.parse(execFileSync(native, ['encrypt', encodeAddress(address), bytes.toString('hex')], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
    return { epk: Buffer.from(value.epk, 'hex'), ciphertext: Buffer.from(value.ciphertext, 'hex') };
  },
  decryptData: decrypt,
};

function temporaryKeyWallet() {
  const keysByCiphertext = new Map();
  const exactKey = (descriptor) => descriptor.epk.toString('hex') + ':' + descriptor.objectdata.toString('hex');
  const decryptData = (descriptor) => {
    const key = keysByCiphertext.get(exactKey(descriptor));
    assert(key, 'Unknown ciphertext: no retained temporary symmetric key');
    const data = descriptor.objectdata;
    const decipher = createDecipheriv('chacha20-poly1305', key, Buffer.alloc(12), { authTagLength: 16 });
    decipher.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  };
  const crypto = { ...walletCrypto, decryptData, encrypt: (bytes, address) => {
    // Child stdout is consumed in memory. Never log/store the temporary key.
    const result = JSON.parse(execFileSync(native, ['encrypt', encodeAddress(address),
      bytes.toString('hex'), 'temporary-ssk'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
    const encrypted = { epk: Buffer.from(result.epk, 'hex'), ciphertext: Buffer.from(result.ciphertext, 'hex') };
    keysByCiphertext.set(exactKey({ epk: encrypted.epk, objectdata: encrypted.ciphertext }), Buffer.from(result.ssk, 'hex'));
    return encrypted;
  } };
  return { crypto, clear: () => { for (const key of keysByCiphertext.values()) key.fill(0); keysByCiphertext.clear(); } };
}

function normalizeGroups(tx) {
  // Funding outputs are excluded; preserve positions of evidence + definition.
  const uploadOutputs = tx.outs.filter((output) => {
    try {
      const script = parseScript(p.SmartTransactionScript, output.script);
      return [p.EVALS.EVAL_IDENTITY_PRIMARY, p.EVALS.EVAL_NOTARY_EVIDENCE].includes(script.paramsOptCC.evalCode.toNumber());
    } catch (_) { return false; }
  });
  const groups = readIdentityUpdateEvidence(uploadOutputs);
  return { uploadOutputs, groups };
}

async function audit() {
  const info = await rpc('getinfo');
  assert.strictEqual(info.testnet, true);
  const source = await rpc('getidentity', ['alice@']);
  const rawSource = await rpc('getrawtransaction', [source.txid]);
  const available = await rpc('listunspent', [1, 9999999]);
  const nativeCoin = available.find((coin) => coin.spendable && coin.amount > 1 && coin.scriptPubKey.startsWith('76a914'));
  const reserveCoin = available.find((coin) => coin.spendable && coin.currencyvalues &&
    Object.keys(coin.currencyvalues).some((id) => id !== info.chainid));
  assert(nativeCoin && reserveCoin, 'Live native and reserve inputs are required for funding audit');
  const utxo = (coin) => ({
    txid: coin.txid, outputIndex: coin.vout, script: coin.scriptPubKey,
    satoshis: Math.round(coin.amount * 100000000), address: coin.address,
    height: info.blocks - coin.confirmations + 1, isspendable: true, blocktime: 1,
  });
  const sdk = new VerusIdInterface('VRSCTEST', 'http://127.0.0.1:18843');
  const outboundCalls = [];
  sdk.interface = new Proxy({}, { get: (_object, method) => async (...args) => {
    outboundCalls.push({ method });
    const methods = { getIdentity: 'getidentity', fundRawTransaction: 'fundrawtransaction',
      getRawTransaction: 'getrawtransaction', getCurrency: 'getcurrency' };
    if (!methods[method]) throw new Error('Construction attempted unexpected RPC: ' + method);
    const result = await rpc(methods[method], args);
    if (method === 'fundRawTransaction') console.log(`Daemon funding fee=${result.fee}, change position=${result.changepos}`);
    return { result, error: null };
  } });
  const cases = [
    { name: 'public-single', uploads: [{ message: 'synthetic local public upload' }] },
    { name: 'private-mmr-three', uploads: [{ encrypttoaddress: recipient.address, mmrdata: [{ message: 'one' }, { message: 'two' }, { message: 'three' }], mmrsalt: ['01'.repeat(32), '02'.repeat(32), '03'.repeat(32)] }] },
    { name: 'external-recipient-temporary-key', uploads: [{ encrypttoaddress: recipient.address, mmrdata: [{ message: 'external recipient verification' }], mmrsalt: ['67'.repeat(32)] }] },
    { name: 'private-multipart', uploads: [{ encrypttoaddress: recipient.address, mmrdata: [{ message: 'm'.repeat(12000) }], mmrsalt: ['04'.repeat(32)] }] },
    { name: 'private-three-keys', uploads: keys.map((key, i) => ({ encrypttoaddress: recipient.address, mmrdata: [{ message: `key${i}` }], mmrsalt: [Buffer.alloc(32, i + 5).toString('hex')] })) },
  ];
  const records = [];
  for (const fixture of cases) {
    const temporary = fixture.name === 'external-recipient-temporary-key' ? temporaryKeyWallet() : undefined;
    const caseCrypto = temporary?.crypto || walletCrypto;
    const caseDecrypt = caseCrypto.decryptData;
    const uploads = fixture.uploads.map((upload) => ({ ...upload, createmmr: true }));
    const signDataMap = new p.KvMap();
    uploads.forEach((upload, i) => signDataMap.set(p.CompactIAddressObject.fromAddress(keys[i]), p.PartialSignData.fromCLIJson(upload)));
    const request = new p.IdentityUpdateRequestDetails({
      identity: p.PartialIdentity.fromJson({ name: source.identity.name, parent: source.identity.parent }),
      signDataMap,
    });
    const prepared = await sdk.prepareIdentityUpdateTransaction(request, rawSource, info.blocks, undefined, false, true, caseDecrypt, caseCrypto, info.chainid);
    const local = Transaction.fromHex(prepared.unfundedTxHex, networks.verus);
    await verifyIdentityUpdateData(request, prepared.unfundedTxHex, caseDecrypt, info.chainid);
    const localDecoded = await rpc('decoderawtransaction', [prepared.unfundedTxHex]);
    assert.strictEqual(localDecoded.vout.length, local.outs.length);
    const localGroups = normalizeGroups(local);
    const expectedKeys = keys.slice(0, uploads.length).sort((a, b) => p.fromBase58Check(a).hash.compare(p.fromBase58Check(b).hash));
    const references = [];
    for (const key of expectedKeys) {
      const rawReference = prepared.identityOnOutput.contentMultiMap.kvContent.getByAddress(key)[0];
      const outer = new p.VDXFDataDescriptor(); outer.fromBuffer(rawReference);
      const rawDecrypted = decrypt(outer.dataDescriptor);
      const plain = new p.VDXFDataDescriptor(); plain.fromBuffer(rawDecrypted);
      const object = new p.BufferDataVdxfObject(); object.fromBuffer(plain.dataDescriptor.objectdata);
      const ref = new p.CrossChainDataRef(); ref.fromBuffer(object.toDataBuffer());
      const daemonPlain = await rpc('decryptdata', [{ datadescriptor: outer.dataDescriptor.toJson(), ivk: recipient.ivk }]);
      references.push({ key, reference: ref.toJson(), daemonDecryptedReference: daemonPlain, encryptedReferenceHex: rawReference.toString('hex') });
    }
    assert.deepStrictEqual(references.map((record) => record.reference.output.voutnum), [...localGroups.groups.keys()]);

    const contentmultimap = {};
    uploads.forEach((upload, i) => { contentmultimap[keys[i]] = [{ data: upload }]; });
    const daemonHex = await rpc('updateidentity', [{
      name: source.identity.name, parent: source.identity.parent, contentmultimap,
    }, true]);
    const daemon = Transaction.fromHex(typeof daemonHex === 'string' ? daemonHex : daemonHex.hex, networks.verus);
    const daemonGroups = normalizeGroups(daemon);
    assert.strictEqual(daemonGroups.groups.size, localGroups.groups.size);
    assert.deepStrictEqual([...daemonGroups.groups.values()].map((g) => g.outputIndexes.length),
      [...localGroups.groups.values()].map((g) => g.outputIndexes.length));
    // Independently reserialize every daemon evidence group through primitives.
    for (const group of daemonGroups.groups.values()) {
      const evidence = new p.NotaryEvidence({ systemId: info.chainid, evidence: group.proof });
      const reconstructed = p.createNotaryEvidenceOutputs(evidence);
      assert.deepStrictEqual(reconstructed.map((o) => o.script), group.outputIndexes.map((i) => daemonGroups.uploadOutputs[i].script));
    }
    const daemonTemplate = Transaction.fromHex(daemon.toHex(), networks.verus);
    daemonTemplate.ins = [];
    daemonTemplate.outs = daemonGroups.uploadOutputs;
    await verifyIdentityUpdateData(request, daemonTemplate.toHex(), decrypt, info.chainid);
    const changeAddress = source.identity.primaryaddresses[0];
    const fundingResult = fixture.name === 'private-multipart'
      ? await sdk.createUpdateIdentityWithCurrencyTransferTransaction(
        request, changeAddress, rawSource, source.blockheight,
        [{ currencies: { [Object.keys(reserveCoin.currencyvalues).find((id) => id !== info.chainid)]: '1' },
          address: new p.TransferDestination({ type: p.DEST_PKH, destinationBytes: p.fromBase58Check(reserveCoin.address).hash }) }],
        [utxo(nativeCoin), utxo(reserveCoin)],
        { chainIAddr: info.chainid, currentHeight: info.blocks,
          updateIdentityTransactionHex: prepared.unfundedTxHex, isTestnet: true,
          expectedIdentityPrimaryAddresses: source.identity.primaryaddresses,
          expectedIdentityMinimumSignatures: source.identity.minimumsignatures,
          decryptData: caseDecrypt }
      )
      : await sdk.createUpdateIdentityTransaction(
        request, changeAddress, rawSource, source.blockheight, [utxo(nativeCoin)],
        info.chainid, undefined, undefined, info.blocks, prepared.unfundedTxHex,
        false, true, false, caseDecrypt
      );
    assert(fundingResult.fundingApproval);
    verifyIdentityUpdateFunding(fundingResult.fundingApproval, fundingResult.hex);
    const funded = Transaction.fromHex(fundingResult.hex, networks.verus);
    const evidenceOutputCount = local.outs.length - 1;
    assert.deepStrictEqual(funded.outs.slice(0, evidenceOutputCount).map((out) => out.script),
      local.outs.slice(0, evidenceOutputCount).map((out) => out.script));
    // Moving real daemon change before/inside evidence must fail approval.
    for (const insertAt of new Set([0, Math.min(1, evidenceOutputCount - 1)])) {
      const tampered = Transaction.fromHex(fundingResult.hex, networks.verus);
      const changeIndex = tampered.outs.findIndex((out, index) => index >= evidenceOutputCount &&
        !local.outs.some((expected) => out.script.equals(expected.script)));
      const change = tampered.outs.splice(changeIndex, 1)[0];
      tampered.outs.splice(insertAt, 0, change);
      assert.throws(() => verifyIdentityUpdateFunding(fundingResult.fundingApproval, tampered.toHex()));
    }
    records.push({
      name: fixture.name, uploads, sourceIdentity: source.identity.identityaddress,
      sourceTxid: source.txid, height: info.blocks, expiryHeight: local.expiryHeight,
      localTemplateHex: prepared.unfundedTxHex,
      localGroupOutputCounts: [...localGroups.groups.values()].map((g) => g.outputIndexes.length),
      daemonGroupOutputCounts: [...daemonGroups.groups.values()].map((g) => g.outputIndexes.length),
      daemonOutputScripts: daemonGroups.uploadOutputs.map((o) => o.script.toString('hex')),
      fundedUnsignedHex: fundingResult.hex, fundingApproval: fundingResult.fundingApproval,
      fundingInputCurrencies: fixture.name === 'private-multipart'
        ? [nativeCoin.currencyvalues, reserveCoin.currencyvalues] : [nativeCoin.currencyvalues],
      references,
    });
    temporary?.clear();
    console.log(`Passed ${fixture.name}: ${local.outs.length} local outputs, exact daemon evidence bytes, bidirectional verification, live funding and displaced-change rejection.`);
  }
  const output = { daemonVersion: info.VRSCversion, height: info.blocks, constructionRpcCalls: outboundCalls, broadcast: false, cases: records };
  fs.writeFileSync(path.join(__dirname, '../src/__tests__/fixtures/local-upload/builder-interoperability.json'), JSON.stringify(output, null, 2) + '\n');
}
audit().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
