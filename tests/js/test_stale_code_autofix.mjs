// "Try to fix automatically" in the Updates tab's stale-code banner: the button is offered
// for every PHP remedy (not the Python restart, not while an update runs), one click is
// one run (a second click and a concurrent re-check do nothing), and what the server says
// to do next (wait / recheck / manual / reinstall) drives what the tab does after.
//
// Run: node tests/js/test_stale_code_autofix.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (s) => s.replace(/^import\s[^;]*;/gm, '').replace(/^export\s+(function|const|let|class)/gm, '$1');
const t = (k, d, params) => {
  let v = d ?? '';
  for (const [n, val] of Object.entries(params || {})) v = v.replace(new RegExp(`\\{${n}\\}`, 'g'), String(val));
  return v;
};

const OC = { enabled: true, restrictApi: '/block_api_functions', validateTimestamps: true, revalidateFreq: 120 };
const staleAnswer = (rec = {}, extra = {}) => ({
  codeStale: true, codeVersion: null, filesVersion: '1.84.3', reinstallSupported: true,
  codeDiagnosis: { backend: 'php', direction: 'code_older', parked: [], libraryOutdated: true,
    probe: { cause: 'opcache', opcache: OC, outdated: [], recovery: { invalidated: 0, tried: 28, blocked: true, ...rec } } },
  ...extra,
});
const FRESH = { codeStale: false, codeVersion: '1.84.3', filesVersion: '1.84.3' };

/** versions: the answers of action=version in order (the last one repeats); fix: the answers of the POSTs by action. */
function load(versions, fix = {}) {
  const timers = [];
  const calls = [];
  const toasts = [];
  let gate = null;
  const src = strip(read('js/pages/admin/stale-code.js')) + '\n' + strip(read('js/pages/admin/tab-updates.js')) + `
;globalThis.__T = { setVersions: (v) => { _versions = v; }, block: () => staleCodeBlock(), fix: () => fixStale(), busy: () => _repair.busy,
  recheck: () => recheck(), setUpdating: (b) => { _updating = b; }, armed: () => _staleAutoTimer !== null };`;
  const ctx = vm.createContext({
    console, JSON, Math, Number, Array, Object, String, Boolean, Date, Promise, RegExp,
    setTimeout: (fn, ms) => { if (ms === 1500) { fn(); return 0; }   // the retry pause of a read runs at once
      const rec = { ms, live: true }; rec.fn = () => { rec.live = false; fn(); }; timers.push(rec); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].live = false; },
    API_ADMIN: 'api/admin.php', Utils: {}, t,
    escHtml: (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    apiFetch: async (url) => {
      if (!/action=version/.test(url)) return null;
      calls.push('version');
      return versions.length > 1 ? versions.shift() : versions[0];
    },
    apiFetchStatus: async (url, o) => {
      const action = /action=([a-z_]+)/.exec(url)[1];
      calls.push(action + (o && o.body ? ' ' + o.body : ''));
      if (gate) await gate;
      return fix[action] ?? null;
    },
    toast: (m) => toasts.push(m),
    el: () => null, refreshIcons() {}, renderReleaseNotesTree: () => '',
    fetchPluginUpdates: async () => ({ configured: true, list: [] }), runPluginUpdates: async () => ({}), updateAffordance: () => '',
    document: { querySelectorAll: () => [] }, location: { reload() {} }, fetch: async () => ({ ok: false }),
  });
  vm.runInContext(src, ctx, { filename: 'tab-updates.js' });
  return { T: ctx.__T, timers, calls, toasts, hold: (p) => { gate = p; } };
}
const live = (timers) => timers.filter((x) => x.live);
const A = (id, ok, count, failed, detail) => ({ id, ran: true, ok, count, failed, ...(detail ? { detail } : {}) });
const answer = (data, status = 200) => ({ status, ok: status < 400, data });

// ---- the button: every PHP remedy, never the Python restart, never during an update ----
{
  const php = (extra, top = {}) => ({ codeStale: true, codeVersion: '1.84.2', filesVersion: '1.84.3', ...top,
    codeDiagnosis: { backend: 'php', direction: 'code_older', parked: [], ...extra } });
  const cases = {
    parked: php({ parked: ['api/a.php'] }),
    opcache: php({}),
    wait: php({ opcache: OC }),
    reupload: php({ libraryOutdated: true, opcache: { ...OC, enabled: false } }),
    incomplete: php({ direction: 'code_newer' }),
    permissions: php({ probe: { cause: 'not_written', outdated: [{ path: 'api/_admin_lib.php' }] } }),
    recheck: php({ recovery: { invalidated: 3, filesTried: 3 } }),
  };
  for (const [name, v] of Object.entries(cases)) {
    const { T } = load([v]);
    T.setVersions(v);
    const out = T.block();
    assert.ok(out.includes('id="btn-stale-autofix"') && out.includes('Try to fix automatically'), `${name}: button shown`);
    assert.ok(out.includes('id="btn-stale-recheck"'), `${name}: re-check stays`);
  }
  const py = { codeStale: true, codeVersion: '1.84.2', filesVersion: '1.84.3', codeDiagnosis: { backend: 'python', action: 'restart', direction: 'code_older' } };
  const { T } = load([py]);
  T.setVersions(py);
  assert.ok(!T.block().includes('btn-stale-autofix'), 'python restart: no button');
  assert.ok(T.block().includes('btn-stale-recheck'));
  const { T: U } = load([cases.opcache]);
  U.setVersions(cases.opcache);
  U.setUpdating(true);
  assert.equal(U.block(), '', 'no banner while an update runs');
}

// ---- next: wait ----
// The server refreshed the dates: the banner re-reads (still stale), one timer of waitSeconds + 5 s, the lines are shown.
{
  const v = staleAnswer({ touched: 27, touchFailed: 0 });
  const { T, timers, calls } = load([v], { stale_fix: answer({ next: 'wait', waitSeconds: 120, filesVersion: '1.84.3', actions: [A('invalidate', false, 0, 28, ['blocked']), A('touch', true, 27, 0)] }) });
  T.setVersions(v);
  await T.fix();
  assert.equal(calls.filter((c) => c.startsWith('stale_fix')).length, 1);
  assert.ok(!calls.some((c) => c.startsWith('update_apply')), 'wait never reinstalls');
  assert.equal(live(timers).length, 1); assert.equal(live(timers)[0].ms, 125000);
  const out = T.block();
  assert.ok(out.includes('File dates refreshed: 27 (failed: 0)') && out.includes('Opcache: the host blocks clearing it'));
  assert.equal(out.split('re-checks by itself').length - 1, 1, 'the wait sentence appears once');
  assert.equal((out.match(/Automatic re-check at/g) || []).length, 1);
  assert.ok(out.includes('re-checks by itself') && /Automatic re-check at \d\d:\d\d:\d\d\./.test(out));
  assert.equal(T.busy(), false);
}
// Invalidation that failed without being blocked (no opcache): not the "host blocks" wording.
{
  const v = staleAnswer({});
  const { T } = load([v], { stale_fix: answer({ next: 'recheck', filesVersion: '1.84.3', actions: [A('invalidate', false, 0, 0)] }) });
  T.setVersions(v);
  await T.fix();
  const out = T.block();
  assert.ok(out.includes('Opcache: nothing to clear') && !out.includes('blocks clearing'));
}
// The fresh read does not show the touched dates (an older probe): the tab arms the timer itself, once.
{
  const v = staleAnswer({});   // no touch report: remedy "wait" without an automatic timer
  const { T, timers } = load([v], { stale_fix: answer({ next: 'wait', waitSeconds: 60, filesVersion: '1.84.3', actions: [A('touch', true, 5, 0)] }) });
  T.setVersions(v);
  await T.fix();
  assert.equal(live(timers).length, 1); assert.equal(live(timers)[0].ms, 65000);
}
// The timer fires one re-check; when the code is fresh the banner is gone.
{
  const v = staleAnswer({ touched: 5 });
  const { T, timers, calls } = load([v, FRESH], { stale_fix: answer({ next: 'wait', waitSeconds: 120, filesVersion: '1.84.3', actions: [A('touch', true, 5, 0)] }) });
  T.setVersions(v);
  await T.fix();
  const before = calls.filter((c) => c === 'version').length;
  live(timers)[0].fn();
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.equal(calls.filter((c) => c === 'version').length, before + 1);
  assert.equal(T.block(), '', 'fresh code: no banner');
}

// ---- next: recheck ----
{
  const { T, calls, toasts } = load([FRESH],
    { stale_fix: answer({ next: 'recheck', filesVersion: '1.84.3', actions: [A('finish_parked', true, 2, 0), A('invalidate', true, 28, 0), A('touch', true, 28, 0)] }) });
  T.setVersions(staleAnswer({ invalidated: 28, blocked: false }));
  await T.fix();
  assert.ok(calls.includes('version'), 'the versions were read again');
  assert.equal(T.block(), '', 'the code is fresh now');
  assert.deepEqual(toasts, ['The server now runs the new code.']);
  assert.equal(T.busy(), false);
}
// Still stale after the fix: the banner stays, with the lines of what was done and no success toast.
{
  const v = staleAnswer({ invalidated: 4, blocked: false });
  const { T, toasts } = load([v], { stale_fix: answer({ next: 'recheck', filesVersion: '1.84.3',
    actions: [A('finish_parked', false, 1, 2), A('invalidate', true, 4, 0), A('opcache_reset', false, 0, 0)] }) });
  T.setVersions(v);
  await T.fix();
  const out = T.block();
  assert.ok(out.includes('Parked files put in place: 1, still parked: 2') && out.includes('Opcache: cleared 4 files') && out.includes('Opcache: the reset was refused'));
  assert.deepEqual(toasts, []);
}

// ---- next: manual ----
{
  const v = staleAnswer({ touched: 0, touchFailed: 28 });
  const { T, calls, timers } = load([v], { stale_fix: answer({ next: 'manual', filesVersion: '1.84.3', reasons: ['touch_failed'],
    actions: [A('touch', false, 0, 28), A('repair_permissions', true, 0, 0)] }) });
  T.setVersions(v);
  await T.fix();
  assert.ok(!calls.some((c) => c.startsWith('update_apply')));
  assert.equal(live(timers).length, 0);
  const out = T.block();
  assert.ok(out.includes('Upload api/_admin_lib.php'), 'the manual remedy is on the banner');
  assert.ok(out.includes('File dates refreshed: 0 (failed: 28)') && out.includes('Permissions repaired: 0 fixed, 0 failed'));
  assert.ok(!out.includes('touch_failed'));
}
// Nothing ran: say so.
{
  const v = staleAnswer({});
  const { T } = load([v], { stale_fix: answer({ next: 'manual', filesVersion: '1.84.3', actions: [{ id: 'touch', ran: false, ok: false }] }) });
  T.setVersions(v);
  await T.fix();
  assert.ok(T.block().includes('Nothing could be fixed from here.'));
}

// ---- next: reinstall ----
{
  const v = staleAnswer({}, {});
  v.codeDiagnosis.probe = { cause: 'not_written', outdated: [{ path: 'api/_admin_lib.php', owner: 'sftp' }], opcache: OC };
  const { T, calls } = load([FRESH], {
    stale_fix: answer({ next: 'reinstall', filesVersion: '1.84.3', actions: [A('repair_permissions', true, 3, 0)] }),
    update_apply: answer({ ok: true, applied: '1.84.3', reinstalled: true, pendingFinalize: 0 }),
  });
  T.setVersions(v);
  await T.fix();
  assert.deepEqual(calls.filter((c) => !c.startsWith('version')), ['stale_fix {}', 'update_apply {"reinstall":true,"version":"1.84.3"}']);
  assert.equal(T.block(), '');
}
// A failed reinstall keeps its sentence and still re-checks; a failed fix call does not reinstall.
{
  const v = staleAnswer({});
  const { T, calls } = load([v], {
    stale_fix: answer({ next: 'reinstall', filesVersion: '1.84.3', actions: [] }),
    update_apply: answer({ error: 'write_failed' }, 500),
  });
  T.setVersions(v);
  await T.fix();
  const out = T.block();
  assert.ok(out.includes('The reinstall failed. (HTTP 500') && !out.includes('write_failed'));
  assert.ok(calls.includes('version'));
  const { T: U, calls: c2 } = load([v], { stale_fix: answer({ error: 'internal_error' }, 500) });
  U.setVersions(v);
  await U.fix();
  assert.ok(!c2.some((c) => c.startsWith('update_apply')));
  assert.ok(U.block().includes('The automatic fix could not run. (HTTP 500') && !U.block().includes('internal_error'));
}

// ---- one click is one run ----
{
  const v = staleAnswer({});
  const { T, calls, hold } = load([v], { stale_fix: answer({ next: 'manual', filesVersion: '1.84.3', actions: [A('touch', true, 1, 0)] }) });
  T.setVersions(v);
  let release;
  hold(new Promise((r) => { release = r; }));
  const first = T.fix();
  assert.equal(T.busy(), true);
  const second = T.fix();                      // a second click while the first runs
  assert.ok(T.block().includes('Fixing…'), 'spinner label while it runs');
  assert.ok(/id="btn-stale-autofix" disabled/.test(T.block()) && /id="btn-stale-recheck" disabled/.test(T.block()), 'both buttons disabled');
  const reads = calls.filter((c) => c === 'version').length;
  T.recheck();                                  // a re-check meanwhile does not take the versions read over
  assert.equal(calls.filter((c) => c === 'version').length, reads, 'recheck leaves the versions read to the fix');
  release();
  await first; await second;
  assert.equal(calls.filter((c) => c.startsWith('stale_fix')).length, 1, 'one POST for two clicks');
  assert.equal(T.busy(), false);
}
// A pending automatic timer is cancelled by a fix and cannot read while it runs.
{
  const v = staleAnswer({ touched: 5 });
  const { T, timers, calls, hold } = load([v], { stale_fix: answer({ next: 'manual', filesVersion: '1.84.3', actions: [] }) });
  T.setVersions(v);
  // arm one the way a read does
  T.recheck();
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  const armed = live(timers)[0];
  assert.ok(armed, 'a timer was armed by the read');
  let release;
  hold(new Promise((r) => { release = r; }));
  const run = T.fix();
  assert.equal(armed.live, false, 'the fix cancelled the pending timer');
  const reads = calls.filter((c) => c === 'version').length;
  armed.fn();
  assert.equal(calls.filter((c) => c === 'version').length, reads, 'a superseded timer reads nothing');
  release();
  await run;
}

console.log('test_stale_code_autofix: OK');
