#!/usr/bin/env node
'use strict';

// Reference/audit tooling only. Never imported by the SDK.
// Credentials are read at runtime and deliberately never recorded in fixtures.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const allowedMethods = new Set([
  'getinfo', 'getblockchaininfo', 'help', 'listidentities', 'getidentity',
  'getrawtransaction', 'decoderawtransaction', 'decodescript', 'getvdxfid',
  'signdata', 'decryptdata', 'z_getencryptionaddress', 'z_validateaddress',
  'updateidentity', 'fundrawtransaction', 'listunspent', 'getwalletinfo',
  'getidentitycontent', 'getcurrencybalance', 'getcurrency',
  'signrawtransaction', 'sendrawtransaction', 'getrawmempool', 'gettransaction',
  'getblock', 'getblockhash', 'getblockcount',
  'getmininginfo', 'getgenerate',
]);

function configuration() {
  const studyPath = process.env.VERUS_UPLOAD_STUDY ||
    path.join(__dirname, '../docs/local-identity-upload-study.md');
  const study = fs.existsSync(studyPath) ? fs.readFileSync(studyPath, 'utf8') : '';
  const field = (name) => study.match(new RegExp('^' + name + '=(.+)$', 'm'))?.[1];
  const user = process.env.VERUS_RPC_USER || field('rpcuser');
  const password = process.env.VERUS_RPC_PASSWORD || field('rpcpassword');
  const url = new URL(process.env.VERUS_RPC_URL || 'http://127.0.0.1:18843');
  if (!user || !password) throw new Error('Supply VERUS_RPC_USER and VERUS_RPC_PASSWORD, or the local study.');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('This synthetic-data audit harness only connects to a loopback daemon.');
  }
  return { url, auth: user + ':' + password };
}

async function rpc(method, params = []) {
  if (!allowedMethods.has(method)) throw new Error('RPC method is outside the audit allowlist: ' + method);
  if (method === 'signrawtransaction' || method === 'sendrawtransaction') {
    if (process.env.VERUS_UPLOAD_LIVE !== '1') {
      throw new Error('Live testnet signing/broadcast requires VERUS_UPLOAD_LIVE=1.');
    }
    const info = await rpc('getinfo');
    if (!info.testnet || info.chainid !== 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq') {
      throw new Error('Live upload audit only permits the authorized VRSCTEST chain.');
    }
  }
  if (method === 'updateidentity' && params[1] !== true) {
    throw new Error('Reference updateidentity requires returntx=true; broadcasting is prohibited.');
  }
  if (method === 'z_getencryptionaddress' &&
      (!params[0]?.seed || params[0]?.address || params[0]?.rootkey || params[0]?.returnsecret)) {
    throw new Error('Only synthetic seed-derived, non-secret recipients are permitted.');
  }
  const { url, auth } = configuration();
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method: 'POST', auth, timeout: 30000,
      headers: { 'content-type': 'application/json' },
    }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.error) {
            const error = new Error(method + ': ' + parsed.error.message);
            error.code = parsed.error.code;
            reject(error);
          } else resolve(parsed.result);
        } catch (error) { reject(error); }
      });
    });
    request.on('error', (error) => reject(new Error(error.message)));
    request.on('timeout', () => request.destroy(new Error('Local daemon RPC timed out')));
    request.end(JSON.stringify({ jsonrpc: '1.0', id: method, method, params }));
  });
}

module.exports = { rpc };

if (require.main === module) {
  const method = process.argv[2];
  const params = JSON.parse(process.argv[3] || '[]');
  rpc(method, params).then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
