// While a platform update runs, the Updates tab (js/pages/admin/tab-updates.js)
// must keep reporting it through any re-render — a language switch (relabel) or
// the mount — and must offer no control that starts a second apply:
//   • the progress card stays visible and is repainted with the last progress
//     (bar, line in the current language, phase chips);
//   • no Update / Confirm / Cancel / Check button is drawn, and Check is inert;
//   • this holds during the synchronous PHP apply (one long request, no polling)
//     and during the restart probe (polling flag down);
//   • a refused apply, or an update that ends in error, gives the controls back.
// The module is loaded headlessly the way test_admin_release_notes_ui.mjs does.
//
// Run: node tests/js/test_updates_tab_running_guard.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

let lang = 'en';
const DICTS = {
  en: { 'admin.updateMsgDownload': 'Downloading the update…', 'admin.updateRestart': 'Restarting the server…',
    'admin.updateApplied': 'Update applied (v{v}) — reloading…' },
  fr: { 'admin.updateMsgDownload': 'Téléchargement de la mise à jour…', 'admin.updateRestart': 'Redémarrage du serveur…',
    'admin.updateApplied': 'Mise à jour appliquée (v{v}) — rechargement…' },
};
const t = (k, d, params) => {
  let v = DICTS[lang][k] ?? d ?? '';
  for (const [n, val] of Object.entries(params || {})) v = v.replace(new RegExp(`\\{${n}\\}`, 'g'), String(val));
  return v;
};

function stubEl(id) {
  return {
    id, value: '', textContent: '', innerHTML: '', style: {}, disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, setAttribute() {}, getAttribute: () => null, remove() {},
  };
}

function load() {
  const els = new Map();
  const el = (id) => { if (!els.has(id)) els.set(id, stubEl(id)); return els.get(id); };
  const calls = [];
  const env = { applyResult: null, status: null, timers: [] };
  let src = read('js/pages/admin/tab-updates.js')
    .replace(/^import\s[^;]*;/gm, '')
    .replace(/^export\s+(function|const|let|class)/gm, '$1');
  src += `
;globalThis.__T = {
  tab: UpdatesTab,
  state: () => ({ updating: _updating, polling: _polling, progress: _progress }),
  setCheck: (c) => { _check = c; },
  preflight: (p) => { _preflight = p; },
  confirm: () => confirmUpdate(),
  recheck: () => recheck(),
  restart: () => pollRestart(),
};`;
  const ctx = vm.createContext({
    console, JSON, Math, Number, Array, Object, String, Boolean, Date, Promise, RegExp,
    setTimeout: (fn, ms) => { env.timers.push({ fn, ms }); return env.timers.length; },
    clearTimeout() {},
    API_ADMIN: 'api/admin.php',
    Utils: { formatFileSize: (n) => `${n} B`, formatDate: (iso) => String(iso).slice(0, 10) },
    t,
    escHtml: (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    apiFetch: async (url) => { calls.push(url); return /update_status/.test(url) ? env.status : null; },
    apiFetchStatus: async (url) => { calls.push(url); return env.applyResult; },
    toast: (msg, kind) => { calls.push(`toast:${kind}:${msg}`); },
    el, refreshIcons() {},
    renderReleaseNotesTree: () => '',
    fetchPluginUpdates: async () => ({ configured: true, list: [] }),
    runPluginUpdates: async () => ({}), updateAffordance: () => '',
    document: { querySelectorAll: () => [] },
    location: { reload() { calls.push('reload'); } },
    fetch: async () => ({ ok: false }),
  });
  vm.runInContext(src, ctx, { filename: 'tab-updates.js' });
  return { T: ctx.__T, el, calls, env };
}

const CHECK = { current: '1.81.0', latest: '1.82.0', available: true };
const PREFLIGHT = { target: '1.82.0', ok: [], blocking: [], willQuarantine: [] };
const html = (h) => h.el('updates-root').innerHTML;
const cardVisible = (h) => /id="progress-card" style="display:block/.test(html(h));
const controls = (h) => ['btn-update', 'btn-confirm-update', 'btn-cancel-update', 'btn-recheck']
  .filter((id) => html(h).includes(`id="${id}"`));
const flush = () => new Promise((r) => setImmediate(r));

// ── 1. Asynchronous apply (Python server): language switch while polling ──────
{
  const h = load();
  h.T.setCheck(CHECK);
  h.T.preflight(PREFLIGHT);
  h.T.tab.relabel();
  assert.ok(!cardVisible(h), 'no update running: progress card hidden');
  assert.deepEqual(controls(h), ['btn-confirm-update', 'btn-cancel-update', 'btn-recheck']);

  h.env.applyResult = { ok: true, data: { ok: true } };
  h.env.status = { phase: 'download', pct: 40 };
  await h.T.confirm();
  await flush();
  assert.equal(h.T.state().updating, true);
  assert.equal(h.T.state().polling, true);
  assert.ok(cardVisible(h), 'progress card shown once the apply started');
  assert.equal(h.el('progress-bar').style.width, '40%');
  assert.equal(h.el('progress-msg').textContent, 'Downloading the update…');

  // The operator switches the admin language in the middle of the download.
  lang = 'fr';
  h.el('progress-bar').style.width = '0%';
  h.el('progress-msg').textContent = '';
  h.T.tab.relabel();
  assert.ok(cardVisible(h), 'relabel keeps the progress card visible');
  assert.deepEqual(controls(h), [], 'relabel offers no Update / Confirm / Check control');
  assert.equal(h.el('progress-bar').style.width, '40%', 'bar repainted after the re-render');
  assert.equal(h.el('progress-msg').textContent, 'Téléchargement de la mise à jour…',
    'progress line repainted in the new language');

  // "Check" cannot run while the update runs.
  const before = h.calls.length;
  h.T.recheck();
  await flush();
  assert.equal(h.calls.length, before, 'recheck is inert during an update');
  assert.equal(h.calls.filter((c) => /update_apply/.test(c)).length, 1);

  // Restart probe: the polling flag is down, the guard is not.
  h.T.restart();
  assert.equal(h.T.state().updating, true);
  h.T.tab.relabel();
  assert.ok(cardVisible(h));
  assert.deepEqual(controls(h), []);
  assert.equal(h.el('progress-msg').textContent, 'Redémarrage du serveur…');
  lang = 'en';
}

// ── 2. Synchronous PHP apply: re-render while the one request is in flight ────
{
  const h = load();
  lang = 'en';
  h.T.setCheck(CHECK);
  h.T.preflight(PREFLIGHT);
  h.T.tab.relabel();
  let resolve;
  h.env.applyResult = new Promise((r) => { resolve = r; });
  const pending = h.T.confirm();
  assert.equal(h.T.state().updating, true, 'guard raised before the request returns');
  h.T.tab.relabel();
  assert.ok(cardVisible(h), 'progress card shown during the synchronous apply');
  assert.deepEqual(controls(h), [], 'no Confirm button comes back during the request');

  resolve({ ok: true, data: { ok: true, applied: '1.82.0' } });
  await pending;
  assert.equal(h.el('progress-bar').style.width, '100%');
  assert.equal(h.el('progress-msg').textContent, 'Update applied (v1.82.0) — reloading…');
  h.T.tab.relabel();
  assert.ok(cardVisible(h), 'the applied message survives a re-render until the reload');
  assert.equal(h.el('progress-msg').textContent, 'Update applied (v1.82.0) — reloading…');
  assert.ok(h.env.timers.some((x) => x.ms === 2000), 'reload scheduled');
}

// ── 3. A refused apply gives the preflight controls back ─────────────────────
{
  const h = load();
  h.T.setCheck(CHECK);
  h.T.preflight(PREFLIGHT);
  h.T.tab.relabel();
  h.env.applyResult = { ok: false, status: 409, data: { error: 'already_running' } };
  await h.T.confirm();
  assert.equal(h.T.state().updating, false);
  assert.ok(!cardVisible(h));
  assert.deepEqual(controls(h), ['btn-confirm-update', 'btn-cancel-update', 'btn-recheck']);
  assert.ok(h.calls.some((c) => c.startsWith('toast:error:')));
}

// ── 4. An update that ends in error clears the guard and rechecks ────────────
{
  const h = load();
  h.T.setCheck(CHECK);
  h.T.preflight(PREFLIGHT);
  h.env.applyResult = { ok: true, data: { ok: true } };
  h.env.status = { phase: 'error', pct: 0, error: 'download_failed' };
  await h.T.confirm();
  await flush(); await flush();
  assert.equal(h.T.state().updating, false);
  assert.equal(h.T.state().polling, false);
  assert.ok(h.calls.some((c) => /update_check/.test(c)), 'the tab checks again after a failed run');
  h.T.setCheck(CHECK);
  h.T.tab.relabel();
  assert.ok(!cardVisible(h));
  assert.ok(controls(h).includes('btn-update') && controls(h).includes('btn-recheck'),
    'Update and Check are offered again');
}

console.log('test_updates_tab_running_guard: OK');
