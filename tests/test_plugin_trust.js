/* Parity: js/core/plugin-trust.js canonical hash vs the shared vector (Node).
   Twin of tests/test_plugin_trust.py — both must agree. */
'use strict';
const fs = require('fs');
const path = require('path');

// Node exposes WebCrypto as globalThis.crypto (>=20). plugin-trust.js reads crypto.subtle.
if (typeof crypto === 'undefined') global.crypto = require('crypto').webcrypto;
const PluginTrust = require(path.join(__dirname, '..', 'js', 'core', 'plugin-trust.js'));

const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'plugin-trust-vector.json'), 'utf-8'));

(async () => {
  let fails = 0;
  for (const c of v.files) {
    const bytes = new Uint8Array(Buffer.from(c.b64, 'base64'));
    const got = await PluginTrust.fileHash(bytes);
    if (got !== c.fileHash) { fails++; console.log(`  FAIL fileHash ${c.rel}: ${got} != ${c.fileHash}`); }
  }
  const fhs = {};
  for (const c of v.files) fhs[c.rel] = c.fileHash;
  const composite = await PluginTrust.pluginHash(fhs);
  if (composite !== v.pluginHash) { fails++; console.log(`  FAIL pluginHash: ${composite} != ${v.pluginHash}`); }

  const sf = v.singleFile;
  const single = await PluginTrust.pluginHash({ [sf.rel]: sf.fileHash });
  if (single !== sf.pluginHash) { fails++; console.log('  FAIL singleFile pluginHash'); }

  if (fails) { console.log(`${fails} PARITY FAILURES`); process.exit(1); }
  console.log(`ALL ${v.files.length + 2} PLUGIN-TRUST HASH CASES PASSED (js)`);
})();
