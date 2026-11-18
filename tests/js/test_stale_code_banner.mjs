// The stale-code banner of the Updates tab (staleCodeBlock in tab-updates.js) must
// name the parked files in its remedy sentence. The shared t() interpolates {files}
// itself, so passing the version as `files` once left "(1.84.1)" instead of the list.
//
// Run: node tests/js/test_stale_code_banner.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (s) => s.replace(/^import\s[^;]*;/gm, '').replace(/^export\s+(function|const|let|class)/gm, '$1');

// Same interpolation as the real t(): the params fill every {name} of the sentence.
const t = (k, d, params) => {
  let v = d ?? '';
  for (const [n, val] of Object.entries(params || {})) v = v.replace(new RegExp(`\\{${n}\\}`, 'g'), String(val));
  return v;
};

function load(fetchLog, status, toasts) {
  const src = strip(read('js/pages/admin/stale-code.js')) + '\n' + strip(read('js/pages/admin/tab-updates.js')) + `
;globalThis.__T = { setVersions: (v) => { _versions = v; }, block: () => staleCodeBlock(), result: () => staleRepairResult(), busy: () => _repair.busy, fix: () => fixStale(), exhausted: () => _staleExhausted, loadVersions: () => loadVersions() };`;
  const ctx = vm.createContext({
    console, JSON, Math, Number, Array, Object, String, Boolean, Date, Promise, RegExp,
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {},
    API_ADMIN: 'api/admin.php',
    Utils: {}, t,
    escHtml: (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    apiFetch: async () => { if (fetchLog) fetchLog.count++; return fetchLog && fetchLog.answer ? fetchLog.answer : null; }, apiFetchStatus: async (url, o) => (status ? status(url, o) : null), toast: (m) => { if (toasts) toasts.push(m); },
    el: () => null, refreshIcons() {},
    renderReleaseNotesTree: () => '',
    fetchPluginUpdates: async () => ({ configured: true, list: [] }),
    runPluginUpdates: async () => ({}), updateAffordance: () => '',
    document: { querySelectorAll: () => [] }, location: { reload() { if (toasts) toasts.reloaded = true; } },
    fetch: async () => ({ ok: false }),
  });
  vm.runInContext(src, ctx, { filename: 'tab-updates.js' });
  return ctx.__T;
}

const OPCACHE = { enabled: true, restrictApi: '', validateTimestamps: true, revalidateFreq: 2 };

// Parked files: the remedy lists them, never the files' version.
{
  const T = load();
  T.setVersions({
    codeStale: true, codeVersion: '1.82.1', filesVersion: '1.84.1',
    codeDiagnosis: {
      backend: 'php', direction: 'code_older', parked: ['api/_admin_lib.php'], opcache: OPCACHE,
      recovery: { opcacheReset: false, invalidated: 0, swapped: 0, parkedBefore: 1 },
    },
  });
  const out = T.block();
  assert.ok(out.includes('rename each *.lumen-new file over its target (api/_admin_lib.php)')
    || out.includes('(api/_admin_lib.php)'), 'remedy names the parked file');
  assert.ok(!out.includes('(1.84.1)'), 'remedy must not show the files version in place of the list');
  // Body keeps the versions.
  assert.ok(out.includes('version 1.82.1') && out.includes('version 1.84.1'), 'body states both versions');
}

// Several parked files are joined.
{
  const T = load();
  T.setVersions({
    codeStale: true, codeVersion: '1.82.1', filesVersion: '1.84.1',
    codeDiagnosis: { backend: 'php', direction: 'code_older', parked: ['api/a.php', 'api/b.php'], opcache: OPCACHE },
  });
  assert.ok(T.block().includes('api/a.php, api/b.php'));
}

// Other remedies still receive the files version (reupload) and the wait (wait).
{
  const T = load();
  T.setVersions({
    codeStale: true, codeVersion: '1.82.1', filesVersion: '1.84.1',
    codeDiagnosis: { backend: 'php', direction: 'code_older', parked: [], opcache: { ...OPCACHE, validateTimestamps: false, revalidateFreq: 0 }, libraryOutdated: true },
  });
  assert.ok(T.block().includes('Upload the files of version 1.84.1 again'));
  T.setVersions({
    codeStale: true, codeVersion: '1.82.1', filesVersion: '1.84.1',
    codeDiagnosis: { backend: 'php', direction: 'code_older', parked: [], opcache: OPCACHE },
  });
  assert.ok(T.block().includes('every 2 s'));
}

// ---- 1.84.2 ----
const LATE = { path: 'api/_admin_lib.php', exists: true, writable: false, dirWritable: false, owner: 'sftp', group: 'sftp', perms: '0644' };
const permDiag = (extra = {}) => ({
  codeStale: true, codeVersion: null, filesVersion: '1.84.2', ...extra,
  codeDiagnosis: {
    backend: 'php', parked: [], libraryOutdated: true, opcache: OPCACHE,
    probe: { cause: 'not_written', outdated: [LATE], php: { user: 'www-data' }, recovery: { invalidated: 3, tried: 3, blocked: false } },
  },
});

// Permissions card, reinstall supported: late file facts, PHP user, the combined button.
{
  const T = load();
  T.setVersions(permDiag({ reinstallSupported: true }));
  const out = T.block();
  assert.ok(out.includes('api/_admin_lib.php') && out.includes('0644') && out.includes('sftp:sftp'), 'late file facts');
  assert.ok(out.includes('writable by PHP: no') && !out.includes('PHP can replace'), 'older probe: falls back to writable');
  assert.ok(out.includes('PHP runs as www-data.'));
  assert.ok(out.includes('id="btn-stale-autofix"') && out.includes('Try to fix automatically'));
  assert.ok(!out.includes('btn-stale-repair') && !out.includes('Repair permissions'), 'the permissions button is folded into the automatic fix');
  assert.ok(out.includes('reinstalls the version from here'), 'permissions remedy points at the automatic fix');
  assert.ok(!/\{[a-z]+\}/.test(out), 'no raw token left');
}
// A probe that reports `replaceable` shows that, not `writable`.
{
  const T = load();
  const d = permDiag({ reinstallSupported: true });
  d.codeDiagnosis.probe.outdated = [{ ...LATE, replaceable: true }];
  T.setVersions(d);
  const a = T.block();
  assert.ok(a.includes('PHP can replace: yes') && !a.includes('writable by PHP'), 'replaceable yes (dir writable)');
  d.codeDiagnosis.probe.outdated = [{ ...LATE, replaceable: false }];
  T.setVersions(d);
  assert.ok(T.block().includes('PHP can replace: no'), 'replaceable no');
}
// Without reinstall support: the same button, and the reupload advice.
{
  const T = load();
  T.setVersions(permDiag());
  const out = T.block();
  assert.ok(out.includes('id="btn-stale-autofix"'));
  assert.ok(!out.includes('reinstalls the version from here'));
  assert.ok(out.includes('upload version 1.84.2 again'));
}
// Names are escaped.
{
  const T = load();
  const d = permDiag();
  d.codeDiagnosis.probe.outdated = [{ ...LATE, path: 'api/<b>x</b>.php' }];
  T.setVersions(d);
  const out = T.block();
  assert.ok(out.includes('api/&lt;b&gt;x&lt;/b&gt;.php') && !out.includes('<b>x</b>'));
}
// The page keeps asking (first read + 4 retries), then says "processes"; no repair button there.
{
  const answer = {
    codeStale: true, codeVersion: null, filesVersion: '1.84.2',
    codeDiagnosis: { backend: 'php', parked: [], probe: { cause: 'opcache', outdated: [], recovery: { invalidated: 4, tried: 4, blocked: false } } },
  };
  const log = { count: 0, answer };
  const T = load(log);
  await T.loadVersions();
  assert.equal(log.count, 5, 'initial read plus four retries');
  assert.equal(T.exhausted(), true);
  const out = T.block();
  assert.ok(out.includes('other PHP processes of the host still hold the old one'), 'processes text');
  assert.ok(out.includes('id="btn-stale-autofix"'), 'every PHP remedy offers the automatic fix');
  // A fresh answer stops the retries and resets the state.
  log.answer = { codeStale: false, codeVersion: '1.84.2', filesVersion: '1.84.2' };
  log.count = 0;
  await T.loadVersions();
  assert.equal(log.count, 1);
  assert.equal(T.exhausted(), false);
}

// ---- fixStale ----
const post = (calls, answers) => async (url, o) => {
  const action = /action=([a-z_]+)/.exec(url)[1];
  calls.push({ action, body: o && o.body ? JSON.parse(o.body) : null });
  return answers[action];
};
const A = (id, ok, count, failed, detail) => ({ id, ran: true, ok, count, failed, ...(detail ? { detail } : {}) });
const fixOk = (extra = {}) => ({ status: 200, ok: true, data: {
  stale: true, next: 'reinstall', filesVersion: '1.84.2', reinstallSupported: true,
  actions: [A('repair_permissions', false, 4, 1, ['api/<i>x</i>.php', 'api/_admin_lib.php']), { id: 'opcache_reset', ran: false, ok: false }, { id: 'bogus', ran: true, ok: true }], ...extra } });
async function runFix(answers, extra = {}) {
  const calls = []; const toasts = [];
  const log = { count: 0, answer: permDiag({ reinstallSupported: true, ...extra }) };
  const T = load(log, post(calls, answers), toasts);
  T.setVersions(log.answer);
  await T.fix();
  return { T, calls, toasts, out: T.block() };
}
// Reinstall pins the version, and only reinstalled:true says so; lines are translated, paths escaped.
{
  const { calls, out, T } = await runFix({ stale_fix: fixOk(), update_apply: { status: 200, ok: true, data: { ok: true, applied: '1.84.2', reinstalled: true, pendingFinalize: 0 } } });
  assert.deepEqual(calls.map((c) => c.action), ['stale_fix', 'update_apply']);
  assert.deepEqual(calls[1].body, { reinstall: true, version: '1.84.2' });
  assert.ok(out.includes('Version 1.84.2 reinstalled') && out.includes('Permissions repaired: 4 fixed, 1 failed'));
  assert.ok(!out.includes('opcache_reset') && !out.includes('bogus') && !out.includes('Opcache'), 'only the steps that ran are listed');
  assert.ok(out.includes('api/&lt;i&gt;x&lt;/i&gt;.php') && !out.includes('<i>x</i>'));
  assert.ok(out.includes('PHP cannot change these files'));
  assert.ok(!/\{[a-z]+\}/.test(out), 'no raw token');
  assert.equal(T.busy(), false);
}
// next other than reinstall: no update_apply; reasons and details are never printed raw.
{
  const { calls, out } = await runFix({ stale_fix: { status: 200, ok: true, data: { next: 'manual', filesVersion: '1.84.2', actions: [A('invalidate', false, 0, 4, ['blocked']), A('touch', true, 0, 4)], reasons: ['touch_failed'] } } });
  assert.deepEqual(calls.map((c) => c.action), ['stale_fix']);
  assert.ok(out.includes('Opcache: the host blocks clearing it') && out.includes('File dates refreshed: 0 (failed: 4)'));
  assert.ok(!out.includes('touch_failed'));
}
// A 200 without reinstalled:true is not "reinstalled"; parked files are not done.
{
  const a = await runFix({ stale_fix: fixOk(), update_apply: { status: 200, ok: true, data: { ok: true, applied: '1.84.2' } } });
  assert.ok(!a.out.includes('Version 1.84.2 reinstalled') && a.out.includes('The reinstall failed.'));
  const b = await runFix({ stale_fix: fixOk(), update_apply: { status: 200, ok: true, data: { ok: true, applied: '1.84.2', reinstalled: true, pendingFinalize: 2 } } });
  assert.ok(!b.out.includes('Version 1.84.2 reinstalled') && b.out.includes('parked beside their target'));
}
// Another version landed: reload, no false "reinstalled".
{
  const r = await runFix({ stale_fix: fixOk(), update_apply: { status: 200, ok: true, data: { ok: true, applied: '1.84.3', reinstalled: undefined } } });
  assert.equal(r.toasts.reloaded, true);
  assert.ok(!r.out.includes('Version 1.84.2 reinstalled'));
  assert.equal(r.T.busy(), false);
}
// Errors: translated sentences, never the raw code.
{
  const ok = fixOk();
  const a = await runFix({ stale_fix: ok, update_apply: { status: 400, ok: false, data: { error: 'no_update_available' } } });
  assert.ok(a.out.includes('still runs older code') && !a.out.includes('no_update_available'));
  const m = await runFix({ stale_fix: ok, update_apply: { status: 409, ok: false, data: { error: 'reinstall_version_mismatch', current: '1.84.2', latest: '1.85.0', requested: '1.84.2' } } });
  assert.ok(m.out.includes('a newer version 1.85.0 is published: run the normal update instead') && !m.out.includes('reinstall_version_mismatch') && !/\{[a-z]+\}/.test(m.out), 'mismatch sentence');
  const o = await runFix({ stale_fix: ok, update_apply: { status: 409, ok: false, data: { error: 'reinstall_version_mismatch', current: '1.84.2', latest: '1.84.1', requested: '1.84.2' } } });
  assert.ok(o.out.includes('differs from the files on disk (1.84.2)') && !o.out.includes('newer version'), 'older release is not called newer');
  const u = await runFix({ stale_fix: ok, update_apply: { status: 409, ok: false, data: { error: 'reinstall_unsupported' } } });
  assert.ok(u.out.includes('still runs older code') && !u.out.includes('reinstall_unsupported'), 'unsupported library sentence');
  const b = await runFix({ stale_fix: ok, update_apply: { status: 500, ok: false, data: { error: 'write_failed' } } });
  assert.ok(b.out.includes('a file could not be written') || b.out.includes('unexpected error') || b.out.includes('HTTP 500'));
  assert.ok(!b.out.includes('(write_failed)'));
  const c = await runFix({ stale_fix: ok, update_apply: { status: 500, ok: false, data: { error: 'totally_new_code' } } });
  assert.ok(!c.out.includes('totally_new_code') && c.out.includes('unexpected error'));
  const d = await runFix({ stale_fix: { status: 403, ok: false, data: { error: 'forbidden' } } });
  assert.ok(!d.out.includes('forbidden') && d.out.includes('HTTP 403') && d.out.includes('The automatic fix could not run.') && d.T.busy() === false);
  const e = await runFix({ stale_fix: { status: 0, ok: false, data: null } });
  assert.ok(e.out.includes('The automatic fix could not run.') && e.T.busy() === false);
  const f = await runFix({ stale_fix: null });
  assert.ok(f.out.includes('The automatic fix could not run.') && f.T.busy() === false);
}

console.log('test_stale_code_banner: OK');
