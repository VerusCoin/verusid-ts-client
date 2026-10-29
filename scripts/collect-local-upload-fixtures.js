#!/usr/bin/env node
'use strict';

// Explicit reference RPCs, kept separate from all SDK construction paths.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { rpc } = require('./local-upload-daemon-rpc');
const p = require('verus-typescript-primitives');
const bech32 = require('bech32');

const outputDir = path.join(__dirname, '../src/__tests__/fixtures/local-upload');
const native = process.env.VERUS_NATIVE_CRYPTO || '/tmp/local-upload-native-crypto';
const publicSeed = '42'.repeat(32); // Public synthetic test material, never a wallet seed.
const modes = ['sha256', 'sha256D', 'blake2b'];
const modeId = { sha256: p.EHashTypes.HASH_SHA256, sha256D: p.EHashTypes.HASH_SHA256D, blake2b: p.EHashTypes.HASH_BLAKE2BMMR };
const tagged = (json) => new p.VDXFDataDescriptor(p.DataDescriptor.fromJson(json), p.DataDescriptorKey.vdxfid).toBuffer();
const nativeDecrypt = (descriptor, ivk) => Buffer.from(execFileSync(native, [
  'decrypt', ivk, descriptor.epk, descriptor.objectdata,
], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim(), 'hex');
const write = (name, data) => fs.writeFileSync(path.join(outputDir, name),
  JSON.stringify(data, null, 2) + '\n');

async function collect() {
  fs.mkdirSync(outputDir, { recursive: true });
  const info = await rpc('getinfo');
  const blockchain = await rpc('getblockchaininfo');
  assert.strictEqual(info.testnet, true, 'Only a testnet daemon is permitted');
  const help = await rpc('help');
  const metadata = {
    date: '2026-10-20', daemonVersion: info.VRSCversion, version: info.version,
    protocolVersion: info.protocolversion, chainId: info.chainid, chain: info.name,
    height: info.blocks, bestBlockHash: blockchain.bestblockhash,
    availableReferenceMethods: ['signdata', 'decryptdata', 'updateidentity', 'fundrawtransaction']
      .filter((method) => help.includes(method)),
    nativeAdapter: 'librustzcash and libsodium from local VerusCoin build; not the Mobile bridge',
    broadcast: false,
  };
  write('daemon-metadata.json', metadata);
  const derived = await rpc('z_getencryptionaddress', [{ seed: publicSeed, returnsecret: false }]);
  const recipient = { syntheticPublicSeed: publicSeed, address: derived.address, ivk: derived.ivk };
  assert.strictEqual(Buffer.from(recipient.ivk, 'hex').length, 32);
  write('public-recipient.json', recipient);
  const cases = [];
  for (const objectMode of modes) for (const mmrMode of modes) for (const count of [1, 2, 3, 5, 7]) {
    const request = {
      createmmr: true, hashtype: objectMode, mmrhashtype: mmrMode,
      mmrdata: Array.from({ length: count }, (_, i) => ({ serializedhex: Buffer.from(`audit leaf ${i}: ${'x'.repeat(i)}`).toString('hex') })),
      mmrsalt: Array.from({ length: count }, (_, i) => Buffer.alloc(32, i + 1).toString('hex')),
    };
    const result = await rpc('signdata', [request]);
    const descriptor = p.MMRDescriptor.fromJson(result.mmrdescriptor);
    const leaves = request.mmrdata.map((item, i) => p.hashData(Buffer.concat([
      Buffer.from(item.serializedhex, 'hex'), Buffer.from(request.mmrsalt[i], 'hex'),
    ]), modeId[objectMode]));
    assert.deepStrictEqual(descriptor.mmrHashes.decodeHashVector(), leaves);
    assert.deepStrictEqual(descriptor.mmrRoot.objectdata,
      p.getMMRRoot(leaves, modeId[count === 1 ? objectMode : mmrMode]));
    cases.push({ name: `${objectMode}/${mmrMode}/${count}`, request, result });
  }
  for (const [name, data] of [
    ['hash-only', [{ datahash: '0123456789abcdef'.repeat(4) }, { message: 'ordinary leaf' }]],
    ['vdxf-string', [{ vdxfdata: { iK7a5JNJnbeuYWVHCDRpJosj3irGJ5Qa8c: 'audit VDXF string' } }]],
  ]) {
    const request = { createmmr: true, mmrdata: data, mmrsalt: data.map(() => '11'.repeat(32)) };
    const result = await rpc('signdata', [request]);
    cases.push({ name, request, result });
  }
  write('commitments.json', cases);

  const request = {
    createmmr: true, encrypttoaddress: recipient.address,
    mmrdata: [{ message: 'native interoperability one' }, { message: 'native interoperability two' }],
    mmrsalt: ['23'.repeat(32), '45'.repeat(32)],
  };
  const result = await rpc('signdata', [request]);
  const encrypted = result.mmrdescriptor_encrypted;
  const plain = result.mmrdescriptor;
  const records = [];
  for (const [name, ciphertext, plaintext] of [
    ['root', encrypted.mmrroot, plain.mmrroot],
    ['hashes', encrypted.mmrhashes, plain.mmrhashes],
    ...plain.datadescriptors.map((item, i) => [`leaf${i}`, encrypted.datadescriptors[i], item]),
  ]) {
    assert.deepStrictEqual(nativeDecrypt(ciphertext, recipient.ivk), tagged(plaintext));
    const daemonDecrypted = await rpc('decryptdata', [{ datadescriptor: ciphertext, ivk: recipient.ivk }]);
    records.push({ name, encrypted: ciphertext, taggedPlaintextHex: tagged(plaintext).toString('hex'), daemonDecrypted });
  }
  const decodedAddress = bech32.bech32.decode(recipient.address, 1023);
  const addressBytes = Buffer.from(bech32.bech32.fromWords(decodedAddress.words));
  const plaintext = tagged(plain.datadescriptors[0]);
  const localEncrypted = JSON.parse(execFileSync(native, [
    'encrypt', addressBytes.toString('hex'), plaintext.toString('hex'),
  ], { encoding: 'utf8' }));
  const localDescriptor = { version: 1, flags: 5, objectdata: localEncrypted.ciphertext, epk: localEncrypted.epk };
  const localDecrypted = await rpc('decryptdata', [{ datadescriptor: localDescriptor, ivk: recipient.ivk }]);
  assert.deepStrictEqual(nativeDecrypt(localDescriptor, recipient.ivk), plaintext);
  assert.deepStrictEqual(localDecrypted, plain.datadescriptors[0].objectdata);
  const damaged = { ...localDescriptor, objectdata: (localDescriptor.objectdata.startsWith('00') ? '01' : '00') + localDescriptor.objectdata.slice(2) };
  assert.throws(() => nativeDecrypt(damaged, recipient.ivk));
  await assert.rejects(rpc('decryptdata', [{ datadescriptor: damaged, ivk: recipient.ivk }]));
  assert.throws(() => nativeDecrypt(localDescriptor, '01'.repeat(32)));
  await assert.rejects(rpc('decryptdata', [{ datadescriptor: localDescriptor, ivk: '01'.repeat(32) }]));
  write('native-interoperability.json', { request, result, records, localEncrypted: localDescriptor,
    daemonDecrypted: localDecrypted, authenticatedRejection: { corruptedCiphertext: true, wrongViewingKey: true } });
  console.log(`Recorded ${cases.length} commitment cases, ${records.length} daemon-to-native decryptions, and native-to-daemon decryption at height ${info.blocks}.`);
}

collect().catch((error) => { console.error(error.message); process.exitCode = 1; });
