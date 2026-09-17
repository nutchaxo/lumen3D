// What the Updates tab and the release-notes page draw from an update_check
// answer that brings several versions (js/pages/admin/tab-updates.js,
// js/pages/admin/tab-changelog.js):
//   • one pill per version, oldest first, the last one marked as the target;
//   • the selected version's notes as a foldable tree inside the scroll box,
//     entries folded (titles only) until the operator asks for details;
//   • the fold toggle and the link to the dedicated page;
//   • a server older than the notes asset (body only) still shows one version;
//   • the page lists the pending versions open, then the installed history with
//     the current version marked, and says so when there is nothing to install.
// Both modules are loaded headlessly the way test_admin_dirty_detection.mjs does.
//
// Run: node tests/js/test_admin_release_notes_ui.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';
import { renderReleaseNotesTree } from '../../js/pages/admin/markdown.js';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const EN = JSON.parse(read('lang/en.json'));
const tEn = (k, d, params) => {
  let v = k.split('.').reduce((o, p) => (o && typeof o === 'object' ? o[p] : undefined), EN);
  if (typeof v !== 'string') return d ?? '';
  for (const [name, val] of Object.entries(params || {})) v = v.replace(new RegExp(`\\{${name}\\}`, 'g'), String(val));
  return v;
};
const count = (html, re) => (html.match(re) || []).length;

function stubEl() {
  return {
    value: '', textContent: '', innerHTML: '', style: {}, className: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, setAttribute() {}, getAttribute: () => null, remove() {},
  };
}

function loadModule(rel, tail) {
  let src = read(rel)
    .replace(/^import\s[^;]*;/gm, '')
    .replace(/^export\s+(function|const|let|class)/gm, '$1');
  src += tail;
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, JSON, Math, Number, Array, Object, String, Boolean, Date, Promise,
    API_ADMIN: 'api/admin.php',
    Utils: { formatDate: (iso) => String(iso).slice(0, 10) },
    t: tEn,
    escHtml: (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    apiFetch: async () => null, apiFetchStatus: async () => ({ ok: false }), toast() {},
    el: () => stubEl(), refreshIcons() {},
    renderReleaseNotesTree,
    fetchPluginUpdates: async () => ({ list: [] }), runPluginUpdates: async () => ({}), updateAffordance: () => '',
    document: { querySelectorAll: () => [] }, location: { reload() {} }, fetch: async () => ({ ok: false }),
  });
  vm.runInContext(src, ctx, { filename: rel });
  return ctx.__T;
}

const MD = (v, title) => `# Changelog v${v} (Web Platform)\n\n## [FIXED]\n\n- **${title}**: the details of ${title}.\n- **Second ${v}**: more.\n\n## [ADDED]\n\n- **Added in ${v}**: something.\n`;
const CHECK = {
  current: '1.54.0', latest: '1.55.0', available: true, publishedAt: '2026-09-17T10:00:00Z', htmlUrl: 'https://x/rel',
  notes: MD('1.55.0', 'Latest body'),
  changelogs: [
    { version: '1.54.1', markdown: MD('1.54.1', 'Fix A') },
    { version: '1.54.2', markdown: MD('1.54.2', 'Fix B') },
    { version: '1.55.0', markdown: MD('1.55.0', 'Feature C') },
  ],
  changelogsSource: 'asset',
};

// ── 1. Updates tab ───────────────────────────────────────────────────────────
{
  const T = loadModule('js/pages/admin/tab-updates.js', `
;globalThis.__T = {
  set: (c) => { _check = c; _preflight = null; _notesVersion = null; _notesOpen = false; },
  select: (v) => { _notesVersion = v; },
  open: (o) => { _notesOpen = o; },
  block: () => updateBlock(),
  pending: () => pendingChangelogs(),
};`);

  T.set(CHECK);
  let html = T.block();
  const PILL = /class="adm-vpill( is-active)?"/g;
  assert.equal(count(html, PILL), 3, 'one pill per version the update brings');
  const pills = (html.match(/<div class="adm-vpills"[\s\S]*?<\/div>/) || [''])[0];
  assert.ok(/data-version="1\.54\.1"[^>]*>v1\.54\.1/.test(pills) && pills.indexOf('v1.54.1') < pills.indexOf('v1.54.2') && pills.indexOf('v1.54.2') < pills.indexOf('v1.55.0'),
    'pills are oldest first');
  assert.equal(count(html, /adm-vpill-tag/g), 1, 'exactly one pill carries the target tag');
  assert.ok(/data-version="1\.55\.0"[^>]*>v1\.55\.0<span class="adm-vpill-tag">will be installed<\/span>/.test(html), 'the last version is the one that will be installed');
  assert.ok(/data-version="1\.55\.0" *class="adm-vpill is-active"|class="adm-vpill is-active" data-version="1\.55\.0"/.test(html), 'the target is selected by default');
  assert.ok(/3 new versions/.test(html), 'the heading counts the new versions');
  assert.ok(/id="release-notes">\s*<div class="adm-cl">/.test(html), 'the notes render as the foldable tree inside the scroll box');
  assert.ok(/Feature C/.test(html) && !/Fix A/.test(html), 'only the selected version is shown');
  assert.equal(count(html, /<details class="adm-cl-item">/g), 3, 'entries start folded (titles only)');
  assert.equal(count(html, /<details class="adm-cl-item" open>/g), 0);
  assert.ok(/id="btn-notes-toggle">[\s\S]*Show details/.test(html), 'the toggle offers the details');
  assert.ok(/href="admpan\.html\?changelog=1" target="_blank" rel="noopener"/.test(html), 'a link opens the dedicated page in its own tab');
  assert.ok(/id="btn-update"/.test(html), 'the update button is still there');

  T.select('1.54.1');
  html = T.block();
  assert.ok(/Fix A/.test(html) && !/Feature C/.test(html), 'a pill switches the notes');
  assert.ok(/data-version="1\.54\.1" *class="adm-vpill is-active"|class="adm-vpill is-active" data-version="1\.54\.1"/.test(html), 'the selected pill is active');

  T.open(true);
  html = T.block();
  assert.equal(count(html, /<details class="adm-cl-item" open>/g), 3, 'with details asked, every entry is unfolded');
  assert.ok(/Titles only/.test(html), 'the toggle then offers titles only');

  // An unknown selection (a version that vanished on re-check) falls back to the target.
  T.select('9.9.9');
  html = T.block();
  assert.ok(/Feature C/.test(html), 'an unknown selection falls back to the target');

  // A server older than the notes asset: the body stands for the latest version.
  T.set({ ...CHECK, changelogs: undefined, changelogsSource: undefined });
  assert.deepEqual([...T.pending()].map((c) => c.version), ['1.55.0'], 'body-only answers give one version');
  html = T.block();
  assert.equal(count(html, PILL), 0, 'a single version needs no pill');
  assert.ok(/published on 2026-09-17/.test(html), 'a single version shows the release date');
  assert.ok(/Latest body/.test(html));

  // Up to date: no notes at all.
  T.set({ ...CHECK, available: false, changelogs: [] });
  html = T.block();
  assert.ok(/You are up to date/.test(html) && !/release-notes/.test(html), 'nothing to read when up to date');
}

// ── 2. The dedicated page ────────────────────────────────────────────────────
{
  const T = loadModule('js/pages/admin/tab-changelog.js', `
;globalThis.__T = {
  set: (c, h) => { _check = c; _history = h; _loading = false; },
  body: () => bodyBlock(),
};`);
  const HISTORY = { current: '1.54.0', versions: [
    { version: '1.54.0', markdown: MD('1.54.0', 'Installed now') },
    { version: '1.53.1', markdown: MD('1.53.1', 'Older') },
  ] };

  T.set(CHECK, HISTORY);
  let html = T.body();
  assert.equal(count(html, /<details class="adm-cl-version is-pending" open>/g), 3, 'pending versions are open and marked');
  assert.equal(count(html, /<details class="adm-cl-version">/g), 2, 'installed versions are folded');
  assert.ok(html.indexOf('New in this update') < html.indexOf('v1.54.1') && html.indexOf('v1.55.0') < html.indexOf('Installed versions') && html.indexOf('Installed versions') < html.indexOf('v1.54.0'),
    'pending first (oldest → target), then the installed history');
  assert.equal(count(html, /adm-cl-tag--target/g), 1, 'the target is tagged once');
  assert.ok(/v1\.55\.0<\/span><span class="adm-cl-tag adm-cl-tag--target">will be installed/.test(html));
  assert.equal(count(html, /adm-cl-tag--pending/g), 2, 'the other pending versions are tagged new');
  assert.ok(/v1\.54\.0<\/span><span class="adm-cl-tag adm-cl-tag--current">installed/.test(html), 'the current version is tagged');
  assert.equal(count(html, /<details class="adm-cl-sec" open>/g), 10, 'every section of every version folds on its own');
  assert.equal(count(html, /<details class="adm-cl-item">/g), 15, 'every entry folds on its own');

  T.set({ ...CHECK, available: false, changelogs: [] }, HISTORY);
  html = T.body();
  assert.ok(/Nothing to install: you are up to date/.test(html), 'up to date is said');
  assert.equal(count(html, /<details class="adm-cl-version"/g), 2, 'the installed history is still listed');

  T.set(null, null);
  html = T.body();
  assert.ok(/Release notes unavailable/.test(html), 'no answer at all is reported');
}

console.log('admin release notes UI (pills · tree · toggle · page · fallbacks): OK');
