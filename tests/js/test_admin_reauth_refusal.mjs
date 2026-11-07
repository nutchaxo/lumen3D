// A wrong password typed into a re-auth prompt (Security tab, plugin approval,
// catalog install/update) is answered 401 bad_password / bad_current while the
// session is still valid: the admin fetch wrappers must hand the refusal to the
// caller and leave the panel alone. Any other 401 is a lost session and still
// sends the operator to the login gate.
//
// Run: node tests/js/test_admin_reauth_refusal.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './harness.mjs';

globalThis.window = { addEventListener() {}, location: { origin: 'http://h' } };
globalThis.document = { getElementById: () => null };

let next = null;
globalThis.fetch = async () => {
  const { status, body } = next;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => body,
  };
};
const reply = (status, body) => { next = { status, body: typeof body === 'string' ? body : JSON.stringify(body) }; };

const shared = await import(pathToFileURL(path.join(ROOT, 'js/pages/admin/shared.js')).href);
let gates = 0;
shared.setUnauthorizedHandler(() => { gates++; });

const origError = console.error, origWarn = console.warn;
console.error = () => {}; console.warn = () => {};
try {
  // ── a refused re-auth password keeps the panel ───────────────
  for (const code of ['bad_password', 'bad_current']) {
    gates = 0;
    reply(401, { error: code });
    const r = await shared.apiFetchStatus('api/admin.php?action=approve_plugin', { method: 'POST', body: '{}' });
    assert.equal(r.status, 401);
    assert.equal(r.ok, false);
    assert.deepEqual(r.data, { error: code }, 'apiFetchStatus hands the refusal to the caller');
    assert.equal(gates, 0, `apiFetchStatus: 401 ${code} does not show the login gate`);

    reply(401, { error: code });
    const d = await shared.apiFetch('api/admin.php?action=marketplace_install', { method: 'POST', body: '{}' });
    assert.deepEqual(d, { error: code }, 'apiFetch returns the refusal body');
    assert.equal(gates, 0, `apiFetch: 401 ${code} does not show the login gate`);
  }

  // ── a lost session still goes to the login gate ──────────────
  for (const body of [{ error: 'Not authenticated' }, { error: 'Unauthorized' }, '', '<html>401</html>', 'null']) {
    gates = 0;
    reply(401, body);
    const r = await shared.apiFetchStatus('api/datasets.php?action=list');
    assert.equal(r.status, 401);
    assert.equal(gates, 1, `apiFetchStatus: 401 ${JSON.stringify(body)} shows the login gate`);

    reply(401, body);
    const d = await shared.apiFetch('api/datasets.php?action=list');
    assert.equal(d, null, 'apiFetch returns null on a lost session');
    assert.equal(gates, 2, `apiFetch: 401 ${JSON.stringify(body)} shows the login gate`);
  }

  // ── ordinary answers are unchanged ───────────────────────────
  gates = 0;
  reply(200, { ok: true });
  assert.deepEqual(await shared.apiFetch('api/x'), { ok: true });
  reply(200, 'not json');
  assert.equal(await shared.apiFetch('api/x'), null, 'a non-JSON body is still null');
  reply(500, 'oops');
  const r = await shared.apiFetchStatus('api/x');
  assert.equal(r.data, null);
  assert.equal(r.status, 500);
  assert.equal(gates, 0);
} finally {
  console.error = origError; console.warn = origWarn;
}

// ── the Security tab paints the refusal from its code ──────────
{
  const src = readFileSync(path.join(ROOT, 'js/pages/admin/tab-security.js'), 'utf8');
  assert.ok(/r\.data\?\.error === 'bad_current'/.test(src), 'tab-security maps bad_current to its message');
  assert.ok(!/r\.status === 401 \|\|/.test(src), 'tab-security no longer reads every 401 as a wrong current password');
}

console.log('test_admin_reauth_refusal: OK');
