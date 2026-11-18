// The Updates tab re-checks a stale banner by itself when the server refreshed the date
// of its files (remedy "wait" with touched > 0): once, after waitSeconds + 5 s, never
// after a manual re-check took over, and the "touch" remedy says waiting cannot help.
//
// Run: node tests/js/test_stale_code_autorecheck.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (s) => s.replace(/^import\s[^;]*;/gm, '').replace(/^export\s+(function|const|let|class)/gm, '$1');
const t = (k, d, params) => {
  let v = d ?? '';
  for (const [n, val] of Object.entries(params || {})) v = v.replace(new RegExp(`\{${n}\}`, 'g'), String(val));
  return v;
};

const OC = { enabled: true, restrictApi: '/block_api_functions', validateTimestamps: true, revalidateFreq: 120 };
const stale = (rec) => ({
  codeStale: true, codeVersion: null, filesVersion: '1.84.3',
  codeDiagnosis: { backend: 'php', direction: 'code_older', parked: [], libraryOutdated: true,
    probe: { cause: 'opcache', opcache: OC, outdated: [], recovery: { invalidated: 0, tried: 28, blocked: true, ...rec } } },
});

function load(answers) {
  const timers = [];
  const calls = { count: 0 };
  const src = strip(read('js/pages/admin/stale-code.js')) + '\n' + strip(read('js/pages/admin/tab-updates.js')) + `
;globalThis.__T = { setVersions: (v) => { _versions = v; }, block: () => staleCodeBlock(), load: () => loadVersions().then(() => render()), recheck: () => recheck(),
  armed: () => _staleAutoTimer !== null };`;
  const ctx = vm.createContext({
    console, JSON, Math, Number, Array, Object, String, Boolean, Date, Promise, RegExp,
    setTimeout: (fn, ms) => { const rec = { ms, live: true }; rec.fn = () => { rec.live = false; fn(); }; timers.push(rec); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].live = false; },
    API_ADMIN: 'api/admin.php', Utils: {}, t,
    escHtml: (v) => String(v ?? ''),
    apiFetch: async (url) => { if (/action=version/.test(url)) { calls.count++; return answers.shift() ?? null; } return null; },
    apiFetchStatus: async () => null, toast() {},
    el: () => null, refreshIcons() {}, renderReleaseNotesTree: () => '',
    fetchPluginUpdates: async () => ({ configured: true, list: [] }), runPluginUpdates: async () => ({}), updateAffordance: () => '',
    document: { querySelectorAll: () => [] }, location: { reload() {} }, fetch: async () => ({ ok: false }),
  });
  vm.runInContext(src, ctx, { filename: 'tab-updates.js' });
  return { T: ctx.__T, timers, calls };
}
const live = (timers) => timers.filter((x) => x.live);

// Touched files: one timer of waitSeconds + 5 s; it fires once and re-reads the versions.
{
  const { T, timers, calls } = load([stale({ touched: 27, touchFailed: 0 }), stale({ touched: 27, touchFailed: 0 }), { codeStale: false, filesVersion: '1.84.3', codeVersion: '1.84.3' }]);
  await T.load();
  assert.equal(calls.count, 1);
  assert.equal(live(timers).length, 1); assert.equal(live(timers)[0].ms, 125000);
  const out = T.block();
  assert.ok(out.includes('PHP re-reads them within 120 s') && out.includes('re-checks by itself'), 'touched wait sentence');
  assert.match(out, /Automatic re-check at \d\d:\d\d:\d\d\./);
  assert.ok(!out.includes('Wait that long'), 'the plain wait text is not shown');
  // Fire it: a second read, and it does not arm again while the banner stays up.
  live(timers)[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.count, 2, 'the timer re-read the versions');
  assert.equal(live(timers).length, 0, 'once per load: no second timer');
}

// A manual re-check cancels the pending timer and rearms the automatic one.
{
  const { T, timers, calls } = load([stale({ touched: 5 }), stale({ touched: 5 })]);
  await T.load();
  const first = live(timers)[0];
  assert.ok(first);
  T.recheck();
  assert.equal(first.live, false, 'the pending timer was cancelled');
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.equal(calls.count, 2);
  assert.equal(live(timers).length, 1, 'rearmed after the manual read');
  assert.equal(live(timers)[0].ms, 125000);
}

// A timer whose read was superseded does nothing.
{
  const { T, timers, calls } = load([stale({ touched: 5 }), stale({ touched: 5 })]);
  await T.load();
  const first = live(timers)[0];
  const p = T.load();           // newer generation, not awaited yet
  first.fn();                   // the old timer fires meanwhile
  await p;
  assert.equal(calls.count, 2, 'the stale timer did not read again');
}

// Not touched / failed to touch: no automatic re-check; the touch remedy is not "wait".
{
  const { T, timers } = load([stale({ touched: 0, touchFailed: 28 })]);
  await T.load();
  assert.equal(live(timers).length, 0);
  const out = T.block();
  assert.ok(out.includes('Upload api/_admin_lib.php'), 'touch remedy asks for an SFTP upload');
  assert.ok(!out.includes('Wait that long') && !out.includes('re-checks by itself'));
  assert.match(out, /touched=0, touchFailed=28/);
}
{
  const { T, timers } = load([stale({})]);
  await T.load();
  assert.equal(live(timers).length, 0, 'an older probe (no touch report) arms nothing');
  assert.ok(T.block().includes('Wait that long'));
}

console.log('test_stale_code_autorecheck: OK');
