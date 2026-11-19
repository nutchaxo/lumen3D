/**
 * Admin SPA — Pages: import / export and the history of every page
 * ================================================================
 * One tab for what moves pages between sites and what keeps their versions
 * (DOCS/pages-library/SPEC.md §4–§6):
 *
 *   • each page is a collapsible card listing its versions (api/page-versions.php):
 *     activate (publish or as a draft), rename, edit the note, export, edit in the page
 *     editor, update from the live page, duplicate, delete — and, for the page, save
 *     its current state, export it (with or without history), delete its history;
 *   • a file is verified BEFORE anything is written (structure, format, the platform
 *     version it was made with against this site, widget types, size limits, images,
 *     variables, name conflicts), every check listed with its result, then imported as
 *     versions: an existing page is never overwritten unless the operator picks
 *     "replace", and then the state it replaces is kept by the server as a version.
 *
 * File contents are untrusted: every string from a file (labels, notes, titles) is put
 * in the page with textContent, never as markup. A card whose request is in flight has
 * its controls disabled; after a failure its list is read again.
 */

'use strict';

import {
  API_SITE, API_ADMIN, I18n, t, apiFetch, apiFetchStatus, toast, el, refreshIcons, fmtBytes, modalize, modalId,
} from './shared.js';
import {
  FILE_EXTENSION, FILE_MAX_BYTES, MEDIA_MAX_BYTES, isBuiltinSlug, parseBundle, buildBundle, exportFileName,
  checkCompatibility, compareSemver, collectMediaRefs, renameMediaRefs, usedVariables, planVariables, pageLocales,
  widgetCount, primaryContent, isEmptyDoc, mediaType, SCHEMA, MAX_SCHEMA,
} from './pages-transfer.js';
import {
  contentSignature, contentSignatures, describeLive, entriesBySlug, versionToBundleEntry, pageEntryFromLive, planVersionImport,
  MAX_VERSIONS,
} from './pages-versions.js';
import * as Api from './pages-io-api.js';
import { importMedia, importVariables, readLibraryFile, download } from './pages-transfer-ui.js';

// schemaVersion api/site.php stamps on every page document: a file made by a newer
// page schema is refused.
const PAGE_SCHEMA = 2;
const SLUG_OK = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const EDITOR_CHANNEL = 'lumen-page-editor';

const V = (() => { try { return new URL(import.meta.url).search; } catch (_) { return ''; } })();

// Where the editor's own sanitising comes from (the page editor module is large and
// only needed once something is imported or restored). Replaceable by a test.
export const hooks = {
  loadNormalizer: async () => (await import(`./tab-pages.js${V}`)).normalizePageContent,
};

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

// {name} placeholders filled in one pass, so a value that itself contains "{x}" is never expanded.
function tf(key, def, vars) {
  return String(t(key, def)).replace(/\{(\w+)\}/g, (m, k) => (vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}

function lang() {
  try { return (I18n && I18n.getLanguage && I18n.getLanguage()) || 'en'; } catch (_) { return 'en'; }
}

/** A localizable value as one string in the page language. */
function locText(v) {
  if (typeof v === 'string') return v;
  if (!isObj(v)) return '';
  return (typeof v[lang()] === 'string' && v[lang()]) || (typeof v.en === 'string' && v.en)
    || Object.values(v).find((x) => typeof x === 'string' && x) || '';
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (typeof iso !== 'string' || !iso || Number.isNaN(d.getTime())) return '';
  try { return d.toLocaleString(lang(), { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) { return d.toLocaleString(); }
}

// ── DOM building (textContent only) ─────────────────────────────────────────
function h(tag, props, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'data') { for (const [dk, dv] of Object.entries(v)) n.dataset[dk] = String(dv); }
    else if (k === 'on') { for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn); }
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden') n[k] = v === true ? true : v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(2)) {
    if (c == null || c === false) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
}
const icon = (name) => h('i', { 'data-lucide': name, 'aria-hidden': 'true' });
const sr = (text) => h('span', { class: 'adm-sr-only', text });

// ── State ───────────────────────────────────────────────────────────────────
const S = {
  mounted: false,
  loaded: false,
  error: false,
  unsupported: false,      // the server has no api/page-versions.php: a retry cannot help, an update can
  loading: null,
  again: false,
  platform: '',
  instance: {},
  // Keyed by slug, and a slug may be any word the pattern allows ("constructor"): no prototype to look through.
  hist: Object.create(null),   // slug → { active, count, versions: [META newest first] }
  live: Object.create(null),   // slug → { ok, doc }
  probed: new Map(),       // slug → true when the page has live content although it has no menu row nor history
  sigs: new Map(),         // 'slug/id/updatedAt' → contentSignatures (full, without title, has a title)
  tried: new Set(),        // the same keys, once a read was attempted (a failing one is not retried at every redraw)
  comparing: new Set(),    // slugs whose versions are being read in the background
  pages: [],               // [{ slug, builtin, name, inNav, deleted }]
  open: new Set(),
  busy: new Set(),
  edit: null,              // { slug, id, kind: 'label' | 'note', value? }  value = what was typed, kept when the save fails
  menu: null,              // { slug, id }
  menuFocus: null,         // the menu just opened: its first item takes the focus once
  importing: false,
  imp: null,
  tabId: `io${Math.random().toString(36).slice(2, 9)}`,
  chan: null,
  normalize: null,
};

const rootEl = () => el('pages-io-root');
const $id = (id) => el(id);
const listEl = () => $id('pio-list');

function announce(text) {
  const live = $id('pio-live');
  if (!live) return;
  live.textContent = '';
  live.textContent = text;
}

// ── Data ────────────────────────────────────────────────────────────────────
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const run = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
  return out;
}

async function readLive(slug) {
  const r = await apiFetchStatus(`${API_SITE}?action=get&doc=pages/${encodeURIComponent(slug)}`);
  if (!r.ok) return { ok: false, doc: null };
  return { ok: true, doc: isObj(r.data) ? r.data : {} };
}

const sigKey = (slug, meta) => `${slug}/${meta.id}/${meta.updatedAt || ''}`;

async function ensureSig(slug, meta) {
  const key = sigKey(slug, meta);
  if (S.sigs.has(key)) return true;
  S.tried.add(key);
  const r = await Api.get(slug, meta.id);
  if (!r.ok || !isObj(r.data.version) || !isObj(r.data.version.content)) return false;
  S.sigs.set(key, contentSignatures(r.data.version.content));
  return true;
}

function navRows() {
  const rows = S.instance && isObj(S.instance.nav) && Array.isArray(S.instance.nav.customPages) ? S.instance.nav.customPages : [];
  return rows.filter((n) => isObj(n) && typeof n.slug === 'string');
}

function liveEmpty(slug) {
  const l = S.live[slug];
  return !l || !l.ok || isEmptyDoc(l.doc);
}

function builtinName(slug) {
  return t(`pages.xfer.builtin_${slug}`, slug);
}

function buildPages() {
  const rows = navRows();
  const pages = ['home', 'about'].map((slug) => ({ slug, builtin: true, name: builtinName(slug), inNav: true, deleted: false }));
  for (const n of rows) {
    if (pages.some((p) => p.slug === n.slug)) continue;
    pages.push({ slug: n.slug, builtin: false, name: locText(n.label) || n.slug, inNav: true, deleted: false });
  }
  for (const slug of Object.keys(S.hist).sort()) {
    if (pages.some((p) => p.slug === slug)) continue;
    const first = S.hist[slug].versions[0];
    pages.push({ slug, builtin: false, name: (first && locText(first.title)) || slug, inNav: false, deleted: false });
  }
  S.pages = pages;
}

function markDeleted() {
  for (const p of S.pages) p.deleted = !p.builtin && !p.inNav && liveEmpty(p.slug);
}

function sanitizeHistories(pages) {
  const out = Object.create(null);
  if (!isObj(pages)) return out;
  for (const [slug, hist] of Object.entries(pages)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug) || !isObj(hist) || !Array.isArray(hist.versions)) continue;
    const versions = hist.versions.filter((v) => isObj(v) && typeof v.id === 'string');
    if (!versions.length) continue;
    out[slug] = { active: typeof hist.active === 'string' ? hist.active : null, count: versions.length, versions };
  }
  return out;
}

async function loadAll() {
  const [inst, hist, ver] = await Promise.all([
    apiFetchStatus(`${API_SITE}?action=get&doc=instance`),
    Api.list(),
    S.platform ? Promise.resolve(null) : apiFetch(`${API_ADMIN}?action=version`),
  ]);
  if (ver && typeof ver.web === 'string') S.platform = ver.web;
  if (!inst.ok || !hist.ok || !isObj(hist.data.pages)) {
    S.error = true;
    S.unsupported = hist.error === 'unsupported';
    S.loaded = true;
    renderAll();
    return;
  }
  S.error = false;
  S.unsupported = false;
  S.instance = isObj(inst.data) ? inst.data : {};
  S.hist = sanitizeHistories(hist.data.pages);
  buildPages();
  const lives = await pool(S.pages, 4, (p) => readLive(p.slug));
  S.live = Object.create(null);
  S.pages.forEach((p, i) => { S.live[p.slug] = lives[i]; });
  markDeleted();
  // The active version of every page answers "in sync / modified"; the others are read
  // when a card is opened.
  await pool(S.pages.filter((p) => S.hist[p.slug]), 3, async (p) => {
    const active = S.hist[p.slug].versions.find((v) => v.isActive);
    if (active) await ensureSig(p.slug, active);
  });
  S.loaded = true;
  S.menu = null;
  renderAll();
}

/** Read everything again; a call made while one runs asks for one more pass, never a parallel run. */
function refresh() {
  if (S.loading) { S.again = true; return S.loading; }
  S.loading = (async () => {
    try {
      do { S.again = false; await loadAll(); } while (S.again);
    } catch (e) {
      console.error('pages-io load', e);
      S.error = true;
      S.loaded = true;
      renderAll();
    }
  })().finally(() => { S.loading = null; });
  return S.loading;
}

/** One page again (its history, its live document), then its card. */
async function reloadSlug(slug) {
  const [hist, live, inst] = await Promise.all([Api.list(slug), readLive(slug), apiFetchStatus(`${API_SITE}?action=get&doc=instance`)]);
  if (inst.ok && isObj(inst.data)) S.instance = inst.data;
  if (hist.ok && isObj(hist.data.pages)) {
    const one = sanitizeHistories(hist.data.pages);
    if (one[slug]) S.hist[slug] = one[slug]; else delete S.hist[slug];
  }
  S.live[slug] = live;
  const before = S.pages.map((p) => p.slug).join('|');
  buildPages();
  S.pages.forEach((p) => { if (!(p.slug in S.live)) S.live[p.slug] = { ok: true, doc: {} }; });
  markDeleted();
  const active = S.hist[slug] && S.hist[slug].versions.find((v) => v.isActive);
  if (active) await ensureSig(slug, active);
  // The same pages: only this card changes (focus and scroll of the others stay).
  if (S.pages.map((p) => p.slug).join('|') === before) renderCard(slug); else renderList();
}

// ── Status of a page against its versions ───────────────────────────────────
function versionsForDescribe(slug) {
  const hist = S.hist[slug];
  if (!hist) return [];
  return hist.versions.map((m) => {
    const sg = S.sigs.get(sigKey(slug, m));
    return { id: m.id, label: m.label, isActive: m.isActive === true, signature: sg ? sg.full : undefined, signatureBare: sg ? sg.bare : undefined, hasTitle: sg ? sg.titled : undefined };
  });
}

function liveSignatures(slug) {
  const l = S.live[slug];
  return l && l.ok && !isEmptyDoc(l.doc) ? contentSignatures(l.doc) : null;
}

/** Is the live page what activating this version leaves? (A version without a title leaves the live title alone.) */
function isLiveVersion(slug, meta, live) {
  const sg = S.sigs.get(sigKey(slug, meta));
  if (!live || !sg) return false;
  return sg.titled ? sg.full === live.full : sg.bare === live.bare;
}

function chipFor(page) {
  const slug = page.slug;
  if (page.deleted) return { cls: 'is-deleted', text: t('pagesIo.chip.deleted', 'Deleted page — restorable') };
  const l = S.live[slug];
  if (l && !l.ok) return { cls: 'is-error', text: t('pagesIo.chip.unreadable', 'Cannot be read') };
  const hasHistory = !!S.hist[slug];
  if (!hasHistory) {
    return { cls: 'is-none', text: liveEmpty(slug) ? t('pagesIo.chip.default', 'Default page — nothing stored') : t('pagesIo.chip.none', 'Not versioned') };
  }
  const d = describeLive(l && l.ok ? l.doc : {}, versionsForDescribe(slug));
  if (d.state === 'sync') return { cls: 'is-sync', text: tf('pagesIo.chip.sync', 'In sync with “{label}”', { label: d.label }) };
  if (d.state === 'modified') return { cls: 'is-modified', text: tf('pagesIo.chip.modified', 'Modified since “{label}”', { label: d.label }) };
  return { cls: 'is-none', text: t('pagesIo.chip.none', 'Not versioned') };
}

// ── Rendering: the skeleton ─────────────────────────────────────────────────
function mountSkeleton() {
  const root = rootEl();
  if (!root) return false;
  root.textContent = '';
  const input = h('input', {
    type: 'file', id: 'pio-file', class: 'pio-file', accept: `${FILE_EXTENSION},.json,application/json`,
    tabindex: '-1', 'aria-hidden': 'true', hidden: true,
    on: { change: (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) handleFile(f); } },
  });
  const pick = () => { if (!S.importing && !(S.imp && S.imp.stage === 'reading')) input.click(); };
  const drop = h('div', {
    class: 'pio-drop', id: 'pio-drop', role: 'button', tabindex: '0',
    'aria-label': t('pagesIo.drop.aria', 'Choose a page file to import, or drop it here'),
    on: {
      click: pick,
      keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } },
      dragenter: (e) => { e.preventDefault(); drop.classList.add('is-over'); },
      dragover: (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; drop.classList.add('is-over'); },
      dragleave: () => { drop.classList.remove('is-over'); },
      drop: (e) => {
        e.preventDefault();
        e.stopPropagation();
        drop.classList.remove('is-over');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) handleFile(f);
      },
    },
  }, icon('file-up'),
  h('span', { class: 'pio-drop-text', text: t('pagesIo.drop.text', 'Drop a page file here, or click to choose one') }),
  h('span', { class: 'pio-drop-hint', text: t('pagesIo.drop.hint', 'It is verified first; nothing is written until you confirm.') }));

  root.appendChild(h('div', { class: 'adm-page-head' },
    h('div', {},
      h('h2', { class: 'adm-page-title', id: 'pio-title', text: t('pagesIo.title', 'Page import / export') }),
      h('p', { class: 'adm-page-sub', text: t('pagesIo.sub', 'Move pages between sites, and keep several versions of each page: activate one, rename it, export it or delete it.') })),
    h('div', { class: 'pio-head-actions' },
      h('span', { class: 'pio-chip is-info', id: 'pio-site', text: siteChipText() }),
      h('button', { type: 'button', class: 'adm-btn adm-btn-ghost adm-btn-sm', id: 'pio-refresh', on: { click: () => refresh() } },
        icon('refresh-cw'), t('pagesIo.refresh', 'Refresh')))));
  root.appendChild(h('div', { class: 'pio-toolbar' },
    h('button', { type: 'button', class: 'adm-btn adm-btn-accent', id: 'pio-import-btn', on: { click: pick } }, icon('file-up'), t('pagesIo.importBtn', 'Import a file…')),
    h('button', { type: 'button', class: 'adm-btn adm-btn-ghost', id: 'pio-export-btn', on: { click: () => openExportDialog() } }, icon('file-down'), t('pagesIo.exportBtn', 'Export…'))));
  root.appendChild(input);
  root.appendChild(drop);
  root.appendChild(h('p', { class: 'adm-sr-only', id: 'pio-live', 'aria-live': 'polite', 'aria-atomic': 'true' }));
  root.appendChild(h('div', { id: 'pio-import' }));
  root.appendChild(h('div', { id: 'pio-list', class: 'pio-list' }));
  refreshIcons(root);
  return true;
}

function siteChipText() {
  return S.platform ? tf('pagesIo.siteVersion', 'This site: v{v}', { v: S.platform }) : t('pagesIo.siteVersionUnknown', 'Site version unknown');
}

function renderAll() {
  const chip = $id('pio-site');
  if (chip) chip.textContent = siteChipText();
  syncControls();
  // The pages may have changed under an open import: its plan follows them.
  if (S.imp && S.imp.bundle && !S.imp.result && !S.importing) replan();
  renderImport();
  renderList();
}

function syncControls() {
  const off = S.importing;
  for (const id of ['pio-import-btn', 'pio-export-btn']) { const b = $id(id); if (b) b.disabled = off; }
  const drop = $id('pio-drop');
  if (drop) drop.setAttribute('aria-disabled', off ? 'true' : 'false');
}

// ── Rendering: the page cards ───────────────────────────────────────────────
function renderList() {
  const host = listEl();
  if (!host) return;
  host.textContent = '';
  if (!S.loaded) {
    host.appendChild(h('p', { class: 'pio-empty', role: 'status' }, h('span', { class: 'spinner spinner-sm' }), ' ', t('pagesIo.loading', 'Reading the pages…')));
    return;
  }
  if (S.error && S.unsupported) {
    host.appendChild(h('div', { class: 'pio-empty', role: 'alert' },
      h('p', { text: Api.errorText({ error: 'unsupported' }) })));
    return;
  }
  if (S.error) {
    host.appendChild(h('div', { class: 'pio-empty', role: 'alert' },
      h('p', { text: t('pagesIo.loadFailed', 'The pages and their versions could not be read.') }),
      h('button', { type: 'button', class: 'adm-btn adm-btn-ghost adm-btn-sm', on: { click: () => refresh() } }, t('admin.retry', 'Retry'))));
    return;
  }
  for (const p of S.pages) host.appendChild(buildCard(p));
  refreshIcons(host);
}

function findCard(slug) {
  const host = listEl();
  return host ? Array.from(host.children).find((c) => c.dataset && c.dataset.slug === slug) || null : null;
}

function findByKey(root, key) {
  return Array.from(root.querySelectorAll('[data-key]')).find((n) => n.dataset.key === key) || null;
}

/** Replace one card, keeping focus on the control that held it. */
function renderCard(slug) {
  const old = findCard(slug);
  const page = S.pages.find((p) => p.slug === slug);
  if (!old || !page) { renderList(); return; }
  const a = document.activeElement;
  const key = a && old.contains(a) && a.dataset ? a.dataset.key : null;
  const next = buildCard(page);
  old.parentNode.replaceChild(next, old);
  refreshIcons(next);
  if (key) {
    const target = findByKey(next, key);
    const fallback = findByKey(next, 'toggle');
    if (target && !target.disabled) target.focus(); else if (fallback) fallback.focus();
  }
}

function countText(n) {
  if (!n) return t('pagesIo.count.none', 'No version');
  return n === 1 ? t('pagesIo.count.one', '1 version') : tf('pagesIo.count.many', '{n} versions', { n });
}

function buildCard(page) {
  const slug = page.slug;
  const open = S.open.has(slug);
  const busy = S.busy.has(slug);
  const hist = S.hist[slug];
  const chip = chipFor(page);
  const bodyId = `pio-body-${slug}`;
  const toggle = h('button', {
    type: 'button', class: 'pio-toggle', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': bodyId, data: { key: 'toggle' },
    on: { click: () => toggleCard(slug) },
  }, icon('chevron-right'),
  h('span', { class: 'pio-name', text: page.name }),
  h('code', { class: 'pio-slug', text: slug }),
  h('span', { class: `pio-chip ${chip.cls}`, text: chip.text }),
  h('span', { class: 'pio-count', text: countText(hist ? hist.count : 0) }));
  const card = h('section', {
    class: `pio-card${open ? ' is-open' : ''}${page.deleted ? ' is-deleted' : ''}${busy ? ' is-busy' : ''}`,
    'aria-busy': busy ? 'true' : 'false', data: { slug },
  }, h('h3', { class: 'pio-card-head' }, toggle));
  const body = h('div', { class: 'pio-card-body', id: bodyId, hidden: !open });
  if (open) fillBody(body, page);
  card.appendChild(body);
  return card;
}

function fillBody(body, page) {
  const slug = page.slug;
  const hist = S.hist[slug];
  const busy = S.busy.has(slug) || S.importing;
  if (page.deleted) body.appendChild(h('p', { class: 'pio-note-line', text: t('pagesIo.deletedHint', 'This page no longer exists on the site; its history was kept. Activate a version to bring it back.') }));
  const btn = (key, ic, label, fn, cls) => h('button', {
    type: 'button', class: `adm-btn ${cls || 'adm-btn-ghost'} adm-btn-sm`, disabled: busy || undefined, data: { key }, on: { click: fn },
  }, icon(ic), label);
  const tools = h('div', { class: 'pio-page-actions', role: 'group', 'aria-label': tf('pagesIo.page.actionsFor', 'Actions for the page {name}', { name: page.name }) });
  if (page.deleted) tools.appendChild(btn('restore', 'undo-2', t('pagesIo.page.restore', 'Restore the page'), () => restorePage(slug), 'adm-btn-accent'));
  else {
    tools.appendChild(btn('capture', 'save', t('pagesIo.page.capture', 'Save the current state as a version'), () => capture(slug)));
    tools.appendChild(btn('editor', 'pencil-ruler', t('pagesIo.page.editor', 'Open in the editor'), () => openEditor(slug)));
  }
  if (!page.deleted) tools.appendChild(btn('export-live', 'file-down', t('pagesIo.page.exportLive', 'Export the page'), () => exportQuick(slug, 'live')));
  if (hist) tools.appendChild(btn('export-all', 'download', t('pagesIo.page.exportAll', 'Export with all versions'), () => exportQuick(slug, 'all')));
  if (hist) tools.appendChild(btn('purge', 'trash-2', t('pagesIo.page.purge', 'Delete the history'), () => purgeHistory(slug), 'adm-btn-danger'));
  body.appendChild(tools);
  if (!hist) {
    body.appendChild(h('p', { class: 'pio-empty-line', text: t('pagesIo.noVersions', 'No version is kept for this page yet. Save its current state, or import a file.') }));
    return;
  }
  const live = liveSignatures(slug);
  const ul = h('ul', { class: 'pio-versions' });
  for (const meta of hist.versions) ul.appendChild(buildRow(page, meta, live));
  body.appendChild(ul);
  // The other versions' contents are read in the background, to say which one the live page equals.
  compareInBackground(slug);
}

function widgetsText(n) {
  return `${n} ${n === 1 ? t('pages.xfer.widget', 'widget') : t('pages.xfer.widgets', 'widgets')}`;
}

function originLabel(o) {
  return { auto: t('pagesIo.origin.auto', 'automatic'), import: t('pagesIo.origin.import', 'imported'), capture: t('pagesIo.origin.capture', 'saved'), manual: t('pagesIo.origin.manual', 'copy') }[o] || '';
}

function buildRow(page, meta, live) {
  const slug = page.slug;
  const busy = S.busy.has(slug) || S.importing;
  const editing = S.edit && S.edit.slug === slug && S.edit.id === meta.id ? S.edit.kind : null;
  const isLive = isLiveVersion(slug, meta, live);
  const newer = compareSemver(meta.platform, S.platform) === 1;
  const li = h('li', { class: `pio-row${meta.isActive ? ' is-active' : ''}${isLive ? ' is-live' : ''}`, data: { id: meta.id } });

  const badges = h('span', { class: 'pio-badges' });
  if (meta.isActive) badges.appendChild(h('span', { class: 'pio-badge is-active', text: t('pagesIo.badge.active', 'active') }));
  if (isLive) badges.appendChild(h('span', { class: 'pio-badge is-live', text: t('pagesIo.badge.live', 'on the site') }));
  if (originLabel(meta.origin)) badges.appendChild(h('span', { class: 'pio-badge', text: originLabel(meta.origin) }));
  if (meta.hasPublished === false) badges.appendChild(h('span', { class: 'pio-badge', text: t('pagesIo.badge.draftOnly', 'draft only') }));

  const facts = [];
  const when = fmtDate(meta.createdAt);
  if (when) facts.push(when);
  facts.push(widgetsText(Number(meta.widgets) || 0));
  if (Array.isArray(meta.locales) && meta.locales.length) facts.push(meta.locales.map((l) => String(l).toUpperCase()).join(' '));
  if (Number.isFinite(meta.bytes)) facts.push(fmtBytes(meta.bytes));
  if (meta.source) facts.push(String(meta.source));
  const meta2 = h('p', { class: 'pio-facts' }, facts.join(' · '));
  if (meta.platform) {
    meta2.appendChild(document.createTextNode(' · '));
    const chip = h('span', { class: `pio-badge${newer ? ' is-warn' : ''}` });
    if (newer) chip.appendChild(h('span', { 'aria-hidden': 'true', text: '⚠ ' }));
    chip.appendChild(document.createTextNode(`v${meta.platform}`));
    if (newer) chip.appendChild(sr(`, ${t('pagesIo.row.newerPlatform', 'made with a newer platform than this site')}`));
    meta2.appendChild(chip);
  }

  const main = h('div', { class: 'pio-row-main' });
  if (editing === 'label') main.appendChild(inlineEditor(slug, meta, 'label'));
  else main.appendChild(h('div', { class: 'pio-row-title' }, h('span', { class: 'pio-label', text: meta.label || t('pagesIo.defaultLabel', 'Version') }), badges));
  main.appendChild(meta2);
  if (editing === 'note') main.appendChild(inlineEditor(slug, meta, 'note'));
  else if (meta.note) main.appendChild(h('p', { class: 'pio-note', text: meta.note }));
  li.appendChild(main);
  li.appendChild(buildRowActions(page, meta, busy));
  return li;
}

function inlineEditor(slug, meta, kind) {
  const multi = kind === 'note';
  const label = multi ? t('pagesIo.row.noteLabel', 'Note') : t('pagesIo.row.labelLabel', 'Version name');
  const typed = S.edit && S.edit.slug === slug && S.edit.id === meta.id && typeof S.edit.value === 'string' ? S.edit.value : null;
  const field = h(multi ? 'textarea' : 'input', {
    class: 'adm-field-input pio-edit-field', value: typed !== null ? typed : (multi ? (meta.note || '') : (meta.label || '')), 'aria-label': label,
    maxlength: multi ? '2000' : '120', rows: multi ? '3' : undefined, type: multi ? undefined : 'text', data: { key: `edit-${kind}` },
  });
  const save = async () => {
    const value = field.value;
    if ((kind === 'label' && !value.trim()) || value === (kind === 'label' ? meta.label : (meta.note || ''))) { S.edit = null; renderCard(slug); focusRow(slug, meta.id, kind === 'label' ? 'rename' : 'note'); return; }
    // The editor stays open, with what was typed, until the server has taken it: a failure must not eat the text.
    S.edit = { slug, id: meta.id, kind, value };
    const ok = await guarded(slug, async () => {
      const r = await Api.update(slug, meta.id, kind === 'label' ? { label: value.trim() } : { note: value });
      if (!r.ok) { toast(Api.errorText(r), 'error'); return false; }
      S.edit = null;
      return true;
    });
    if (ok) announce(t('pagesIo.row.saved', 'Saved.'));
    focusRow(slug, meta.id, kind === 'label' ? 'rename' : 'note');
  };
  const cancel = () => { S.edit = null; renderCard(slug); focusRow(slug, meta.id, kind === 'label' ? 'rename' : 'note'); };
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
    else if (e.key === 'Enter' && (!multi || e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
  });
  return h('div', { class: 'pio-edit' }, field,
    h('button', { type: 'button', class: 'adm-btn adm-btn-accent adm-btn-sm', data: { key: `edit-${kind}-save` }, on: { click: save } }, t('pagesIo.row.save', 'Save')),
    h('button', { type: 'button', class: 'adm-btn adm-btn-ghost adm-btn-sm', data: { key: `edit-${kind}-cancel` }, on: { click: cancel } }, t('admin.cancel', 'Cancel')));
}

function focusRow(slug, id, what) {
  const card = findCard(slug);
  const target = card && findByKey(card, `row:${id}:${what}`);
  if (target && !target.disabled) target.focus();
}

function buildRowActions(page, meta, busy) {
  const slug = page.slug;
  const name = meta.label || t('pagesIo.defaultLabel', 'Version');
  const act = (what, ic, label, fn) => h('button', {
    type: 'button', class: 'pio-icon-btn', title: label, 'aria-label': `${label}: ${name}`, disabled: busy || undefined,
    data: { key: `row:${meta.id}:${what}` }, on: { click: fn },
  }, icon(ic));
  const wrap = h('div', { class: 'pio-row-actions pio-menu-wrap' });
  wrap.appendChild(act('activate', 'check', t('pagesIo.row.activate', 'Activate'), () => activateVersion(page, meta, 'publish')));
  wrap.appendChild(act('edit', 'pencil-ruler', t('pagesIo.row.edit', 'Edit in the page editor'), () => editVersion(page, meta)));
  wrap.appendChild(act('rename', 'pencil', t('pagesIo.row.rename', 'Rename'), () => startEdit(slug, meta.id, 'label')));
  wrap.appendChild(act('export', 'download', t('pagesIo.row.export', 'Export this version'), () => exportQuick(slug, 'version', meta.id)));
  const menuOpen = !!(S.menu && S.menu.slug === slug && S.menu.id === meta.id);
  wrap.appendChild(h('button', {
    type: 'button', class: 'pio-icon-btn', title: t('pagesIo.row.more', 'More actions'), 'aria-label': `${t('pagesIo.row.more', 'More actions')}: ${name}`,
    'aria-haspopup': 'menu', 'aria-expanded': menuOpen ? 'true' : 'false', disabled: busy || undefined, data: { key: `row:${meta.id}:more` },
    on: { click: () => toggleMenu(slug, meta.id) },
  }, icon('more-horizontal')));
  if (menuOpen) {
    const item = (what, label, fn, danger) => h('button', {
      type: 'button', role: 'menuitem', class: `pio-menu-item${danger ? ' is-danger' : ''}`, data: { key: `row:${meta.id}:${what}` },
      on: { click: () => { closeMenu({ restore: true }); fn(); } },
    }, label);
    const menu = h('div', {
      class: 'pio-menu', role: 'menu', 'aria-label': `${t('pagesIo.row.more', 'More actions')}: ${name}`,
      on: { keydown: (e) => menuKey(e, slug, meta.id) },
    },
    item('activate-draft', t('pagesIo.row.activateDraft', 'Activate as a draft'), () => activateVersion(page, meta, 'draft')),
    item('note', t('pagesIo.row.editNote', 'Edit the note'), () => startEdit(slug, meta.id, 'note')),
    item('from-live', t('pagesIo.row.fromLive', 'Update from the live page'), () => updateFromLive(slug, meta)),
    item('duplicate', t('pagesIo.row.duplicate', 'Duplicate'), () => duplicateVersion(slug, meta)),
    item('delete', t('pagesIo.row.delete', 'Delete'), () => deleteVersion(slug, meta), true));
    wrap.appendChild(menu);
    // Focus enters the menu only when the operator just opened it, not at every redraw.
    if (S.menuFocus && S.menuFocus.slug === slug && S.menuFocus.id === meta.id) {
      S.menuFocus = null;
      setTimeout(() => { const first = menu.querySelector('[role="menuitem"]'); if (first && S.menu && S.menu.id === meta.id) first.focus(); }, 0);
    }
  }
  return wrap;
}

// ── Cards: open, menu, inline editing ───────────────────────────────────────
function toggleCard(slug) {
  if (S.open.has(slug)) S.open.delete(slug); else S.open.add(slug);
  renderCard(slug);
}

function toggleMenu(slug, id) {
  const same = S.menu && S.menu.slug === slug && S.menu.id === id;
  const prev = S.menu;
  S.menu = same ? null : { slug, id };
  S.menuFocus = same ? null : { slug, id };
  if (prev && prev.slug !== slug) renderCard(prev.slug);
  renderCard(slug);
  if (same) focusRow(slug, id, 'more');
}

function closeMenu({ restore } = {}) {
  const m = S.menu;
  if (!m) return;
  S.menu = null;
  renderCard(m.slug);
  if (restore) focusRow(m.slug, m.id, 'more');
}

function menuKey(e, slug, id) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu({ restore: true }); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
  const items = Array.from(e.currentTarget ? e.currentTarget.querySelectorAll('[role="menuitem"]') : []);
  if (!items.length) return;
  e.preventDefault();
  const i = items.indexOf(document.activeElement);
  let next = i;
  if (e.key === 'ArrowDown') next = (i + 1) % items.length;
  else if (e.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
  else if (e.key === 'Home') next = 0;
  else next = items.length - 1;
  items[next].focus();
}

function onDocumentClick(e) {
  if (!S.menu) return;
  for (let n = e.target; n; n = n.parentNode) if (n.classList && n.classList.contains('pio-menu-wrap')) return;
  closeMenu();
}

function startEdit(slug, id, kind) {
  S.edit = { slug, id, kind };
  renderCard(slug);
  const card = findCard(slug);
  const f = card && findByKey(card, `edit-${kind}`);
  if (f) f.focus();
}

/** Read the versions whose content is not known yet, three at a time, then redraw the card. */
async function compareInBackground(slug) {
  const hist = S.hist[slug];
  if (!hist || S.comparing.has(slug) || S.busy.has(slug)) return;
  const missing = hist.versions.filter((m) => { const k = sigKey(slug, m); return !S.sigs.has(k) && !S.tried.has(k); });
  if (!missing.length) return;
  S.comparing.add(slug);
  try { await pool(missing, 3, (m) => ensureSig(slug, m)); } finally { S.comparing.delete(slug); }
  if (!S.open.has(slug) || S.busy.has(slug) || S.edit || S.menu) return;
  renderCard(slug);
}

// ── Cards: requests ─────────────────────────────────────────────────────────
/** Run one card's request: its controls are off meanwhile, its lists are read again after (also after a failure). */
async function guarded(slug, fn) {
  if (S.busy.has(slug) || S.importing) return undefined;
  const card = findCard(slug);
  const a = document.activeElement;
  const key = card && a && card.contains(a) && a.dataset ? a.dataset.key : null;
  S.busy.add(slug);
  renderCard(slug);
  let result;
  try {
    result = await fn();
  } catch (e) {
    console.error('pages-io', e);
    toast(t('pagesIo.err.generic', 'The request failed. Try again.'), 'error');
  } finally {
    S.busy.delete(slug);
  }
  try { await reloadSlug(slug); } catch (e) { console.error('pages-io reload', e); renderCard(slug); }
  refocus(slug, key);
  return result;
}

/** Focus goes back to the control the operator used, or to the nearest one that is still there. */
function refocus(slug, key) {
  const card = findCard(slug);
  if (!card || !key) return;
  const row = /^row:([^:]+):/.exec(key);
  const ok = (n) => n && !n.disabled;
  const target = [findByKey(card, key), row && findByKey(card, `row:${row[1]}:more`), findByKey(card, 'toggle')].find(ok);
  if (target) target.focus();
}

function takeOver(slug) {
  try {
    if (!S.chan && typeof BroadcastChannel !== 'undefined') S.chan = new BroadcastChannel(EDITOR_CHANNEL);
    if (S.chan) S.chan.postMessage({ t: 'takeover', slug, id: S.tabId });
  } catch (_) { /* no channel: no editor tab to tell */ }
}

async function getNormalizer() {
  if (!S.normalize) S.normalize = await hooks.loadNormalizer();
  return S.normalize;
}

function pageOf(slug) { return S.pages.find((p) => p.slug === slug) || null; }

/**
 * The menu row of a custom page, written (read again first) when the page has none or its
 * publication reveals a hidden one — the editor's own rules (a new page is hidden until published).
 */
async function ensureNavRow(slug, { label, wantShow }) {
  if (isBuiltinSlug(slug)) return true;
  const fresh = await apiFetch(`${API_SITE}?action=get&doc=instance`);
  if (!isObj(fresh)) return false;
  if (!isObj(fresh.nav)) fresh.nav = {};
  if (!Array.isArray(fresh.nav.customPages)) fresh.nav.customPages = [];
  const row = fresh.nav.customPages.find((n) => n && n.slug === slug);
  if (!row) fresh.nav.customPages.push({ slug, label, show: !!wantShow });
  else if (wantShow && row.show === false) row.show = true;
  else return true;
  const r = await apiFetchStatus(`${API_SITE}?action=save&doc=instance&merge=${encodeURIComponent('nav.customPages')}`, { method: 'POST', body: JSON.stringify(fresh) });
  if (r.ok) {
    S.instance = fresh;
    try { if (typeof InstanceConfig !== 'undefined') await InstanceConfig.load(); } catch (_) { /* the menu refreshes on its next load */ }
  }
  return r.ok;
}

function navLabelFor(slug, nav, title) {
  if (nav && isObj(nav.label) && Object.keys(nav.label).length) return nav.label;
  if (isObj(title) && Object.keys(title).length) return title;
  return { [lang()]: slug };
}

/** After a version went live (or into the draft) of a custom page: its menu row. */
async function syncNavAfter(slug, id, mode) {
  if (isBuiltinSlug(slug)) return true;
  const row = navRows().find((n) => n.slug === slug);
  const wantPublish = mode === 'publish';
  if (row && !(wantPublish && row.show === false)) return true;
  const got = await Api.get(slug, id);
  const content = got.ok && isObj(got.data.version) && isObj(got.data.version.content) ? got.data.version.content : {};
  const nav = isObj(content.nav) ? content.nav : null;
  const wantShow = wantPublish && !(nav && nav.show === false);
  return ensureNavRow(slug, { label: navLabelFor(slug, nav, content.title), wantShow });
}

async function activateVersion(page, meta, mode, { quiet } = {}) {
  const slug = page.slug;
  if (compareSemver(meta.platform, S.platform) === 1
    && !confirm(tf('pagesIo.confirm.newer', 'This version was made with a newer platform (v{v}) than this site. Activate it anyway?', { v: meta.platform }))) return false;
  const ok = await guarded(slug, async () => {
    takeOver(slug);
    const r = await Api.activate(slug, meta.id, { mode, snapshotLabel: t('pagesIo.snapshotActivate', 'Before activation') });
    if (!r.ok) { toast(Api.errorText(r), 'error'); return false; }
    let navOk = true;
    try { navOk = await syncNavAfter(slug, meta.id, mode); } catch (e) { console.error('pages-io nav', e); navOk = false; }
    if (!quiet) {
      const key = mode === 'draft' ? ['pagesIo.done.draft', '“{label}” is now the draft of this page; what visitors see is unchanged.'] : ['pagesIo.done.activated', '“{label}” is now live.'];
      let msg = tf(key[0], key[1], { label: meta.label });
      if (r.data.snapshotId) msg += ` ${t('pagesIo.done.snapshot', 'The previous state was kept as a version.')}`;
      toast(msg, 'success');
      if (!navOk) toast(t('pagesIo.err.nav', 'The page is saved but the menu could not be updated: add it from Identity → Navigation.'), 'warning');
    }
    return true;
  });
  return ok === true;
}

async function restorePage(slug) {
  const hist = S.hist[slug];
  if (!hist) return;
  const meta = hist.versions.find((v) => v.isActive) || hist.versions[0];
  if (meta) await activateVersion(pageOf(slug) || { slug }, meta, 'publish');
}

function editorUrl(slug) { return `admpan.html?editor=${encodeURIComponent(slug)}`; }

function openEditor(slug) {
  const w = window.open(editorUrl(slug), '_blank');
  if (!w) toast(t('pagesIo.err.popup', 'The browser blocked the new tab. Allow pop-ups for this site, or open the editor from the Pages tab.'), 'warning');
}

/** Put the version in the page's draft (the previous state is kept as a version), then open the editor on it. */
async function editVersion(page, meta) {
  // The tab is opened inside the click, before the awaits: afterwards a browser takes it for a pop-up.
  const w = window.open('', '_blank');
  const ok = await activateVersion(page, meta, 'draft', { quiet: true });
  if (!ok) { if (w && typeof w.close === 'function') w.close(); return; }
  if (w) w.location.href = editorUrl(page.slug);
  else toast(t('pagesIo.err.popup', 'The browser blocked the new tab. Allow pop-ups for this site, or open the editor from the Pages tab.'), 'warning');
  toast(tf('pagesIo.done.editing', '“{label}” was put in the draft; the editor opens on it.', { label: meta.label }), 'success');
}

async function updateFromLive(slug, meta) {
  if (!confirm(tf('pagesIo.confirm.fromLive', 'Replace the content of “{label}” with the current state of the page?', { label: meta.label }))) return;
  const ok = await guarded(slug, async () => {
    const r = await Api.update(slug, meta.id, { fromLive: true });
    if (!r.ok) { toast(Api.errorText(r), 'error'); return false; }
    return true;
  });
  if (ok) toast(tf('pagesIo.done.updated', '“{label}” now holds the current state of the page.', { label: meta.label }), 'success');
}

async function duplicateVersion(slug, meta) {
  const ok = await guarded(slug, async () => {
    const got = await Api.get(slug, meta.id);
    if (!got.ok || !isObj(got.data.version) || !isObj(got.data.version.content)) { toast(Api.errorText(got), 'error'); return false; }
    const r = await Api.add(slug, {
      label: tf('pagesIo.copyOf', '{label} (copy)', { label: meta.label }), note: meta.note || '', origin: 'manual', content: got.data.version.content,
    });
    if (!r.ok) { toast(Api.errorText(r), 'error'); return false; }
    return true;
  });
  if (ok) toast(t('pagesIo.done.duplicated', 'Version duplicated.'), 'success');
}

async function deleteVersion(slug, meta) {
  if (meta.isActive) { toast(Api.errorText({ error: 'active_version' }), 'warning'); return; }
  if (!confirm(tf('pagesIo.confirm.delete', 'Delete the version “{label}”? This cannot be undone.', { label: meta.label }))) return;
  const ok = await guarded(slug, async () => {
    const r = await Api.remove(slug, meta.id);
    if (!r.ok) { toast(Api.errorText(r), 'error'); return false; }
    return true;
  });
  if (ok) toast(t('pagesIo.done.deleted', 'Version deleted.'), 'success');
}

async function purgeHistory(slug) {
  const page = pageOf(slug);
  const key = page && page.deleted ? ['pagesIo.confirm.purgeDeleted', 'Delete the whole history of “{name}”? The page no longer exists, so it cannot be restored afterwards.']
    : ['pagesIo.confirm.purge', 'Delete the whole history of “{name}”? The page itself stays as it is.'];
  if (!confirm(tf(key[0], key[1], { name: page ? page.name : slug }))) return;
  const ok = await guarded(slug, async () => {
    const r = await Api.purge(slug);
    if (!r.ok) { toast(Api.errorText(r), 'error'); return false; }
    return true;
  });
  if (ok) toast(t('pagesIo.done.purged', 'History deleted.'), 'success');
}

/** Save the live state as a version. Nothing is added when a version already holds it. */
async function capture(slug) {
  const l = S.live[slug];
  if (!l || !l.ok || isEmptyDoc(l.doc)) { toast(t('pagesIo.err.nothingToSave', 'This page has no content of its own yet: there is nothing to save.'), 'info'); return; }
  const d = describeLive(l.doc, versionsForDescribe(slug));
  if (d.state === 'sync') { toast(tf('pagesIo.done.alreadySaved', 'The current state is already saved as “{label}”.', { label: d.label }), 'info'); return; }
  const page = pageOf(slug);
  const stamp = fmtDate(new Date().toISOString());
  const label = prompt(t('pagesIo.prompt.capture', 'Name of this version:'), tf('pagesIo.captureDefault', 'Saved {date}', { date: stamp }));
  if (label === null) return;
  const nav = navRows().find((n) => n.slug === slug);
  const entry = pageEntryFromLive(slug, l.doc, nav || null);
  const content = {};
  if (isObj(entry.title) && Object.keys(entry.title).length) content.title = entry.title;
  if (entry.nav) content.nav = entry.nav;
  if (entry.published) content.published = entry.published;
  if (entry.draft) content.draft = entry.draft;
  const ok = await guarded(slug, async () => {
    const r = await Api.add(slug, { label: label.trim() || undefined, origin: 'capture', content, source: location.hostname, platform: S.platform });
    if (!r.ok) { toast(Api.errorText(r), 'error'); return false; }
    return true;
  });
  if (ok) { toast(tf('pagesIo.done.captured', 'State of “{name}” saved as a version.', { name: page ? page.name : slug }), 'success'); S.open.add(slug); renderCard(slug); }
}

// ── Export ──────────────────────────────────────────────────────────────────
/** The bundle entries of one page: live, every version (oldest first) or one version. { entries } | { error: <api result> } */
async function entriesFor(slug, mode, versionId) {
  const nav = navRows().find((n) => n.slug === slug) || null;
  if (mode === 'version') {
    const r = await Api.get(slug, versionId);
    if (!r.ok) return { error: r };
    const e = versionToBundleEntry(slug, r.data.version, { active: r.data.version.isActive === true });
    return { entries: e ? [e] : [] };
  }
  const live = await readLive(slug);
  if (mode === 'live') {
    if (!live.ok) return { error: { error: 'network', status: 0 } };
    return { entries: isEmptyDoc(live.doc) ? [] : [pageEntryFromLive(slug, live.doc, nav)] };
  }
  const lr = await Api.list(slug);
  if (!lr.ok) return { error: lr };
  const hist = lr.data.pages && lr.data.pages[slug];
  const metas = hist && Array.isArray(hist.versions) ? hist.versions.slice().reverse() : [];
  const full = await pool(metas, 3, (m) => Api.get(slug, m.id));
  const failed = full.find((r) => !r.ok);
  if (failed) return { error: failed };
  const versions = full.map((r) => r.data.version).filter((v) => isObj(v) && isObj(v.content));
  const liveHas = live.ok && !isEmptyDoc(live.doc);
  const liveSig = liveHas ? contentSignature(live.doc) : null;
  const sameAsLive = liveSig ? versions.find((v) => contentSignature(v.content) === liveSig) : null;
  const entries = versions.map((v) => versionToBundleEntry(slug, v, {
    active: sameAsLive ? v === sameAsLive : (!liveHas && v.isActive === true),
  })).filter(Boolean);
  if (liveHas && !sameAsLive) {
    entries.push(pageEntryFromLive(slug, live.doc, nav, { label: t('pagesIo.exportCurrent', 'Current state'), createdAt: new Date().toISOString(), active: true }));
  }
  return { entries };
}

/**
 * Build and download one file. spec = { slugs, mode: 'live' | 'all' | 'version', versionId?, media }
 * → true when a file was saved.
 */
async function doExport(spec, say, ctl) {
  const stopped = () => !!(ctl && ctl.aborted);
  const entries = [];
  for (const slug of spec.slugs) {
    if (stopped()) return false;
    say(tf('pagesIo.export.reading', 'Reading {slug}…', { slug }));
    const got = await entriesFor(slug, spec.mode, spec.versionId);
    if (stopped()) return false;
    if (got.error) { toast(Api.errorText(got.error), 'error'); return false; }
    entries.push(...got.entries);
  }
  if (stopped()) return false;
  if (!entries.length) { toast(t('pagesIo.export.nothing', 'There is nothing to export for the selected pages.'), 'info'); return false; }
  const media = [];
  const skipped = [];
  if (spec.media) {
    const names = collectMediaRefs(entries);
    for (let i = 0; i < names.length; i++) {
      if (stopped()) return false;
      say(tf('pagesIo.export.media', 'Reading images… {n}/{total}', { n: i + 1, total: names.length }));
      const f = await readLibraryFile(names[i]);
      if (!f || f.blob.size > MEDIA_MAX_BYTES) { skipped.push(names[i]); continue; }
      media.push({ name: names[i], type: f.blob.type || mediaType(names[i]), data: f.data });
    }
  }
  // Cancel pressed while the last request ran: no file is saved.
  if (stopped()) return false;
  const now = new Date();
  const bundle = buildBundle({
    pages: entries, media, variables: usedVariables(entries, S.instance && S.instance.variables),
    platform: S.platform, source: location.hostname, now,
  });
  download(JSON.stringify(bundle, null, 2), exportFileName({ host: location.hostname, slugs: spec.slugs, now }));
  toast(tf('pagesIo.export.done', '{n} entry(ies) exported.', { n: entries.length }), 'success');
  if (skipped.length) toast(tf('pagesIo.export.mediaSkipped', 'Images not included (missing or over 8 MB): {list}', { list: skipped.join(', ') }), 'warning');
  return true;
}

async function exportQuick(slug, mode, versionId) {
  if (S.busy.has(slug) || S.importing) return;
  S.busy.add(slug);
  renderCard(slug);
  try { await doExport({ slugs: [slug], mode, versionId, media: true }, announce); }
  catch (e) { console.error('pages-io export', e); toast(t('pagesIo.export.failed', 'The export failed.'), 'error'); }
  finally { S.busy.delete(slug); renderCard(slug); }
}

function exportable(page) {
  return !liveEmpty(page.slug) || !!S.hist[page.slug];
}

function openExportDialog() {
  if (S.importing || document.querySelector('.pio-modal')) return;
  const pages = S.pages.filter(exportable);
  const titleId = modalId('pio-exp-title');
  const overlay = h('div', { class: 'upl-exit pg-xfer pio-modal', role: 'dialog', 'aria-modal': 'true' });
  const card = h('div', { class: 'upl-exit-card pg-xfer-card' });
  overlay.appendChild(card);
  const checks = new Map();
  const list = h('div', { class: 'pg-xfer-list' });
  if (!pages.length) list.appendChild(h('p', { class: 'pg-xfer-row is-note', text: t('pagesIo.export.empty', 'No page has content to export yet.') }));
  for (const p of pages) {
    const input = h('input', { type: 'checkbox', checked: pages.length <= 6, data: { slug: p.slug } });
    checks.set(p.slug, input);
    const hist = S.hist[p.slug];
    list.appendChild(h('label', { class: 'pg-xfer-row' }, input,
      h('span', { class: 'pg-xfer-name' }, p.name, ' ', h('code', { text: p.slug })),
      h('span', { class: 'pg-xfer-note', text: hist ? countText(hist.count) : t('pagesIo.chip.none', 'Not versioned') })));
  }
  const withHistory = h('input', { type: 'checkbox', id: 'pio-exp-history' });
  const withMedia = h('input', { type: 'checkbox', id: 'pio-exp-media', checked: true });
  const status = h('p', { class: 'pg-xfer-status', 'aria-live': 'polite' });
  const go = h('button', { type: 'button', class: 'adm-btn adm-btn-accent', data: { act: 'go' } }, icon('download'), t('pages.xfer.download', 'Download'));
  const cancel = h('button', { type: 'button', class: 'adm-btn adm-btn-ghost', data: { act: 'cancel' } }, t('admin.cancel', 'Cancel'));
  const selected = () => pages.filter((p) => checks.get(p.slug).checked).map((p) => p.slug);
  const sync = () => { go.disabled = overlay.dataset.busy === '1' || !selected().length; };
  checks.forEach((c) => c.addEventListener('change', sync));
  card.appendChild(h('h3', { class: 'upl-exit-title', id: titleId }, icon('file-down'), t('pagesIo.export.title', 'Export pages')));
  card.appendChild(h('p', { class: 'upl-exit-body', text: t('pagesIo.export.sub', 'Choose the pages. The file name tells the site, the pages and the time; it can be imported on this site or on another one.') }));
  card.appendChild(list);
  card.appendChild(h('label', { class: 'pg-xfer-opt' }, withHistory, t('pagesIo.export.history', 'Include all the versions of each page')));
  card.appendChild(h('label', { class: 'pg-xfer-opt' }, withMedia, t('pages.xfer.includeMedia', 'Include the media library images these pages use')));
  card.appendChild(status);
  card.appendChild(h('div', { class: 'upl-exit-actions' }, cancel, go));
  document.body.appendChild(overlay);
  refreshIcons(overlay);
  let release = null;
  const ctl = { aborted: false };
  const close = () => {
    ctl.aborted = true;
    document.removeEventListener('keydown', onKey, true);
    if (release) release();
    overlay.remove();
  };
  const onKey = (e) => { if (e.key === 'Escape' && overlay.dataset.busy !== '1') { e.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey, true);
  cancel.addEventListener('click', close);
  go.addEventListener('click', async () => {
    const slugs = selected();
    if (!slugs.length) return;
    overlay.dataset.busy = '1';
    sync();
    try {
      const saved = await doExport({ slugs, mode: withHistory.checked ? 'all' : 'live', media: withMedia.checked }, (s) => { status.textContent = s; }, ctl);
      if (saved) { close(); return; }
    } catch (e) {
      console.error('pages-io export', e);
      status.textContent = t('pagesIo.export.failed', 'The export failed.');
    }
    if (ctl.aborted) return;
    delete overlay.dataset.busy;
    sync();
  });
  sync();
  release = modalize(overlay, { labelledBy: titleId, initialFocus: pages.length ? checks.get(pages[0].slug) : cancel, container: card });
}

// ── Import: reading the file, verifying it, planning ────────────────────────
function siteInfo() {
  let widgetTypes;
  try { if (typeof PageRenderer !== 'undefined' && PageRenderer && Array.isArray(PageRenderer.WIDGET_TYPES)) widgetTypes = PageRenderer.WIDGET_TYPES; } catch (_) { /* not loaded */ }
  let tokens = [];
  try { if (typeof PageVars !== 'undefined' && PageVars && PageVars.tokens) tokens = Object.keys(PageVars.tokens()); } catch (_) { /* not loaded */ }
  if (!tokens.length) { try { if (typeof InstanceConfig !== 'undefined' && InstanceConfig.tokens) tokens = Object.keys(InstanceConfig.tokens()); } catch (_) { /* not loaded */ } }
  return { platform: S.platform, widgetTypes, maxPageSchema: PAGE_SCHEMA, tokens, variables: S.instance && isObj(S.instance.variables) ? S.instance.variables : {} };
}

function importState() {
  const versions = Object.create(null);
  for (const [slug, hist] of Object.entries(S.hist)) versions[slug] = hist.versions;
  const pages = S.pages.filter((p) => !p.builtin && !p.deleted).map((p) => p.slug);
  // A page with content but neither a menu row (removed from Identity › Navigation) nor a history is still a page.
  for (const [slug, has] of S.probed) if (has && !pages.includes(slug)) pages.push(slug);
  return { pages, versions };
}

function replan() {
  const imp = S.imp;
  if (!imp || !imp.bundle) return;
  imp.plan = planVersionImport(imp.bundle, importState(), { activate: imp.activate, compat: imp.compat, rows: imp.choices });
}

const PARSE_ERRORS = {
  json: ['pages.xfer.err.json', 'This file is not readable JSON.'],
  schema: ['pages.xfer.err.schema', 'This file is not a page export ({schema}).'],
  version: ['pages.xfer.err.version', 'Format {detail} is unknown to this platform version: update it.'],
  pages: ['pages.xfer.err.pages', 'The file holds no valid page.'],
  slug: ['pages.xfer.err.slug', 'Invalid page identifier: “{detail}”.'],
  duplicate: ['pages.xfer.err.duplicate', 'Page listed twice: “{detail}”.'],
  active: ['pagesIo.parse.active', 'Several versions of “{detail}” are flagged as the active one.'],
  content: ['pages.xfer.err.content', 'Invalid page content ({detail}).'],
  size: ['pages.xfer.err.size', 'Too large ({detail}).'],
  media: ['pages.xfer.err.media', 'Invalid or oversized image in the file: {detail}.'],
  variables: ['pages.xfer.err.variables', 'Variable invalid in the file: {detail}.'],
};

function parseErrorText(e) {
  const [key, def] = PARSE_ERRORS[e.code] || PARSE_ERRORS.json;
  // A JSON syntax error's detail is the parser's own message: never shown.
  const detail = e.code === 'json' || e.detail == null ? '' : String(e.detail);
  return tf(key, def, { detail, schema: SCHEMA });
}

/** Does each slug have live content of its own (a page the lists above do not know)? The answers are kept in S.probed. */
async function probeSlugs(slugs) {
  const todo = [...new Set(slugs)].filter((slug) => typeof slug === 'string' && slug && !isBuiltinSlug(slug) && !S.pages.some((p) => p.slug === slug) && !S.probed.has(slug));
  await pool(todo, 4, async (slug) => {
    const l = await readLive(slug);
    S.probed.set(slug, l.ok && !isEmptyDoc(l.doc));
  });
}

async function handleFile(file) {
  // One file at a time: a second one dropped while the first is read would be planned against the first one's panel.
  if (S.importing || (S.imp && S.imp.stage === 'reading')) { toast(t('pagesIo.import.busy', 'An import is already running.'), 'warning'); return; }
  const imp = { fileName: file.name || '', stage: 'reading', parsed: null, bundle: null, compat: null, plan: null, activate: 'publish', choices: [], result: null, status: '' };
  S.imp = imp;
  S.probed = new Map();
  renderImport(true);
  // Another file may be dropped while this one is read: only the latest one fills the panel.
  const current = () => S.imp === imp;
  try {
    await readAndVerify(file, imp, current);
  } catch (e) {
    console.error('pages-io import', e);
    if (!current()) return;
    imp.stage = 'ready';
    imp.parsed = { ok: false, errors: [{ code: 'content', detail: 'unreadable structure' }] };
    imp.bundle = null;
    renderImport(true);
    announce(t('pagesIo.import.refused', 'The file cannot be imported.'));
  }
}

async function readAndVerify(file, imp, current) {
  let parsed;
  if (file.size > FILE_MAX_BYTES) {
    parsed = { ok: false, errors: [{ code: 'size', detail: `${Math.ceil(file.size / 1048576)} MB > ${FILE_MAX_BYTES / 1048576} MB` }] };
  } else if (!/\.json$/i.test(file.name || '')) {
    parsed = { ok: false, errors: [{ code: 'schema' }] };
  } else {
    let text = null;
    try { text = await file.text(); } catch (e) { console.error('pages-io read', e); }
    parsed = text === null ? { ok: false, errors: [{ code: 'json' }] } : parseBundle(text, file.name);
  }
  if (!current()) return;
  // The pages and histories as they are NOW: the plan is made against them.
  await refresh();
  if (parsed.ok) await probeSlugs(parsed.bundle.pages.map((p) => p.slug));
  if (!current()) return;
  imp.stage = 'ready';
  imp.stateError = S.error;
  imp.parsed = parsed;
  if (parsed.ok) {
    imp.bundle = parsed.bundle;
    imp.site = siteInfo();
    imp.compat = checkCompatibility(parsed.bundle, imp.site);
    replan();
  }
  renderImport(true);
  announce(parsed.ok ? t('pagesIo.import.verified', 'The file was verified.') : t('pagesIo.import.refused', 'The file cannot be imported.'));
}

function entryName(entry) {
  if (!entry) return '';
  if (entry.nav && locText(entry.nav.label)) return locText(entry.nav.label);
  if (locText(entry.title)) return locText(entry.title);
  return isBuiltinSlug(entry.slug) ? builtinName(entry.slug) : (entry.slug || '—');
}

// One line of the verification report: { level: 'ok' | 'warn' | 'error', text }.
function buildReport(imp) {
  const out = [];
  const add = (level, text) => out.push({ level, text });
  if (!imp.parsed || !imp.parsed.ok) {
    for (const e of (imp.parsed ? imp.parsed.errors : []).slice(0, 8)) add('error', parseErrorText(e));
    return out;
  }
  const bundle = imp.bundle;
  const compat = imp.compat;
  if (imp.stateError && S.unsupported) add('error', Api.errorText({ error: 'unsupported' }));
  else if (imp.stateError) add('error', t('pagesIo.check.stateError', 'The pages of this site could not be read, so the import cannot be planned. Refresh and try again.'));
  const groups = entriesBySlug(bundle);
  add('ok', tf('pagesIo.check.structure', 'The file is a valid page export: {n} page(s), {v} version(s).', { n: groups.size, v: bundle.pages.length }));
  const fileBlock = (code) => compat.blockers.find((b) => b.page === undefined && b.code === code);
  const newerFormat = fileBlock('schemaNewer');
  if (newerFormat) add('error', tf('pagesIo.check.formatNewer', 'Format {schema} is newer than this site can read (up to lumen-pages/{max}). Update this site first.', { schema: bundle.$schema, max: MAX_SCHEMA }));
  else add('ok', tf('pagesIo.check.format', 'Format {schema}: supported by this site.', { schema: bundle.$schema }));
  const newer = fileBlock('platformNewer');
  const unknown = compat.warnings.find((w) => w.code === 'platformUnknown' && w.page === undefined);
  const older = compat.warnings.find((w) => w.code === 'platformOlder' && w.page === undefined);
  if (fileBlock('siteUnknown')) add('error', t('pagesIo.check.siteUnknown', 'This site\'s version could not be read, so the file\'s version cannot be compared: reload the page and try again. Nothing is imported meanwhile.'));
  else if (newer) add('error', tf('pagesIo.check.platformNewer', 'Made with platform v{exported}; this site runs v{site}. A page from a newer platform may use things this site cannot show: update this site first.', newer.detail));
  else if (unknown) add('warn', t('pagesIo.check.platformUnknown', 'The file does not say which platform version made it, so its compatibility cannot be confirmed.'));
  else if (older) add('ok', tf('pagesIo.check.platformOlder', 'Made with platform v{exported}, older than this site (v{site}): compatible.', older.detail));
  else add('ok', tf('pagesIo.check.platform', 'Made with platform v{exported}; this site runs v{site}: compatible.', { exported: bundle.platform, site: S.platform }));
  const entryLabel = (i) => entryName(bundle.pages[i]) || bundle.pages[i].slug;
  if (imp.site.widgetTypes === undefined) add('warn', t('pagesIo.check.widgetsUnchecked', 'The widgets this site supports could not be listed, so the pages\' widgets were not checked.'));
  else {
    const wb = compat.blockers.filter((b) => b.code === 'widgetUnknown');
    if (!wb.length) add('ok', t('pagesIo.check.widgets', 'Every widget used by the pages exists on this site.'));
    for (const b of wb) add('error', tf('pagesIo.check.widgetUnknown', '“{page}” uses widgets this site does not have: {list}.', { page: entryLabel(b.page), list: b.detail.join(', ') }));
  }
  for (const b of compat.blockers.filter((x) => x.code === 'pageSchemaNewer')) {
    add('error', tf('pagesIo.check.pageSchema', '“{page}” was saved with a newer page format ({found}) than this site understands ({max}).', { page: entryLabel(b.page), found: b.detail.found, max: b.detail.max }));
  }
  add('ok', t('pagesIo.check.limits', 'Every page is within the size and structure limits.'));
  const missing = imp.parsed.warnings.find((w) => w.code === 'mediaMissing');
  if (bundle.media.length) add('ok', tf('pagesIo.check.media', '{n} image(s) in the file: formats and sizes verified ({size}).', { n: bundle.media.length, size: fmtBytes(bundle.media.reduce((n, m) => n + (m.size || 0), 0)) }));
  else if (!missing) add('ok', t('pagesIo.check.noMedia', 'The pages use no image from the media library.'));
  if (missing) add('warn', tf('pagesIo.check.mediaMissing', 'Images used by the pages but not in the file (they show only if this site already has them): {list}.', { list: missing.detail }));
  const vars = Object.keys(bundle.variables);
  const conflicts = vars.length ? planVariables(bundle, S.instance && S.instance.variables).conflicts : [];
  if (vars.length) add('ok', tf('pagesIo.check.variables', '{n} page variable(s) in the file.', { n: vars.length }));
  if (conflicts.length) add('warn', tf('pagesIo.check.varConflicts', 'Variables already defined on this site with another value; the ones already here are kept: {list}.', { list: conflicts.join(', ') }));
  const undef = new Set();
  for (const w of compat.warnings) if (w.code === 'tokenUndefined') w.detail.forEach((x) => undef.add(x));
  if (undef.size) add('warn', tf('pagesIo.check.tokens', 'Variables used in the pages that this site does not define (they will show as written): {list}.', { list: [...undef].sort().map((x) => `{${x}}`).join(', ') }));
  else add('ok', t('pagesIo.check.tokensOk', 'Every variable used in the pages is defined.'));
  if (imp.parsed.warnings.some((w) => w.code === 'title')) add('warn', t('pagesIo.check.titles', 'Some page titles were not understood and are left empty.'));
  const plan = imp.plan;
  const incl = plan.rows.filter((r) => r.include);
  for (const r of incl.filter((x) => x.error === 'slug')) add('error', tf('pagesIo.check.badTarget', 'The target “{slug}” is not a valid page identifier.', { slug: r.target }));
  for (const r of incl.filter((x) => x.error === 'duplicate')) add('error', tf('pagesIo.check.dupTarget', 'Several different pages would be created under the name “{slug}”.', { slug: r.target }));
  for (const r of incl.filter((x) => x.error === 'limit')) add('error', tf('pagesIo.check.limit', 'The history of “{slug}” would exceed {max} versions.', { slug: r.target, max: MAX_VERSIONS }));
  const existing = [...new Set(incl.filter((r) => r.exists).map((r) => r.target))];
  const replacing = [...new Set(incl.filter((r) => r.exists && r.action === 'replace').map((r) => r.target))];
  if (replacing.length && imp.activate === 'draft') add('warn', tf('pagesIo.check.replaceDraft', 'The draft of these pages will be replaced: {list}. What visitors see does not change, and the current state is kept in their history.', { list: replacing.join(', ') }));
  else if (replacing.length) add('warn', tf('pagesIo.check.replace', 'These pages will be replaced: {list}. What they show now is kept in their history.', { list: replacing.join(', ') }));
  else if (existing.length) add('ok', tf('pagesIo.check.existing', 'These pages already exist: {list}. The file is added to their history; the live pages are not touched.', { list: existing.join(', ') }));
  else add('ok', t('pagesIo.check.noConflict', 'No page with the same name exists on this site.'));
  return out;
}

// ── Import: the panel ───────────────────────────────────────────────────────
const LEVEL_MARK = { ok: '✓', warn: '⚠', error: '✗' };

function levelName(l) { return { ok: t('pagesIo.level.ok', 'OK'), warn: t('pagesIo.level.warn', 'Warning'), error: t('pagesIo.level.error', 'Error') }[l]; }

function renderImport(focusHead) {
  const host = $id('pio-import');
  if (!host) return;
  const imp = S.imp;
  const a = document.activeElement;
  const key = a && host.contains(a) && a.dataset ? a.dataset.key : null;
  host.textContent = '';
  if (!imp) return;
  const panel = h('section', { class: 'pio-panel', 'aria-labelledby': 'pio-imp-title', 'aria-busy': S.importing ? 'true' : 'false' });
  const head = h('h3', { class: 'pio-panel-title', id: 'pio-imp-title', tabindex: '-1', data: { key: 'imp-head' } }, icon('file-up'), `${t('pagesIo.import.title', 'Import')}: `, h('strong', { text: imp.fileName }));
  panel.appendChild(h('div', { class: 'pio-panel-head' }, head,
    h('button', { type: 'button', class: 'adm-btn adm-btn-ghost adm-btn-sm', disabled: S.importing || undefined, data: { key: 'imp-close' }, on: { click: closeImport } }, imp.result ? t('admin.close', 'Close') : t('admin.cancel', 'Cancel'))));
  if (imp.stage === 'reading') {
    panel.appendChild(h('p', { class: 'pio-status', role: 'status' }, h('span', { class: 'spinner spinner-sm' }), ' ', t('pagesIo.import.reading', 'Reading and verifying the file…')));
    host.appendChild(panel);
    refreshIcons(host);
    if (focusHead) head.focus();
    return;
  }
  const bundle = imp.bundle;
  if (bundle) {
    const origin = [bundle.source, bundle.platform ? `v${bundle.platform}` : '', fmtDate(bundle.exportedAt)].filter(Boolean).join(' · ');
    if (origin) panel.appendChild(h('p', { class: 'pio-origin', text: origin }));
  }
  const report = buildReport(imp);
  const warns = report.filter((r) => r.level === 'warn').length;
  const plan = imp.plan;
  const fileBlocked = !bundle || imp.stateError || (imp.compat && imp.compat.blockers.some((b) => b.page === undefined));
  let verdict;
  if (fileBlocked) verdict = { cls: 'is-error', text: t('pagesIo.verdict.blocked', 'This file cannot be imported. Nothing was written.') };
  else if (plan.counts.blocked >= plan.rows.length) verdict = { cls: 'is-error', text: t('pagesIo.verdict.allBlocked', 'None of the pages in this file can be imported on this site.') };
  else if (!plan.ok) verdict = { cls: 'is-error', text: tf('pagesIo.verdict.errors', '{n} problem(s) to fix before importing.', { n: plan.counts.errors }) };
  else if (plan.counts.blocked) verdict = { cls: 'is-warn', text: tf('pagesIo.verdict.partial', '{n} version(s) cannot be imported on this site; the others can.', { n: plan.counts.blocked }) };
  else if (!plan.counts.included) verdict = { cls: 'is-warn', text: t('pagesIo.verdict.none', 'Nothing is selected to import.') };
  else if (warns) verdict = { cls: 'is-warn', text: tf('pagesIo.verdict.warns', 'The file can be imported. {n} point(s) to check.', { n: warns }) };
  else verdict = { cls: 'is-ok', text: t('pagesIo.verdict.ok', 'All checks passed: the file is compatible with this site.') };
  panel.appendChild(h('p', { class: `pio-verdict ${verdict.cls}`, role: 'status', text: verdict.text }));

  panel.appendChild(h('h4', { class: 'pio-sub', text: t('pagesIo.import.report', 'Verification') }));
  const ul = h('ul', { class: 'pio-report' });
  for (const r of report) {
    ul.appendChild(h('li', { class: `pio-check is-${r.level}` }, h('span', { class: 'pio-mark', 'aria-hidden': 'true', text: LEVEL_MARK[r.level] }), sr(`${levelName(r.level)}: `), h('span', { text: r.text })));
  }
  panel.appendChild(ul);

  if (bundle && !fileBlocked) panel.appendChild(buildImportRows(imp));
  if (imp.result) panel.appendChild(buildResult(imp.result));
  host.appendChild(panel);
  refreshIcons(host);
  if (focusHead) {
    head.focus();
    if (typeof panel.scrollIntoView === 'function') panel.scrollIntoView({ block: 'start' });
  } else if (key) {
    const t2 = findByKey(host, key);
    if (t2 && !t2.disabled) t2.focus();
  }
}

function rowChoice(i) {
  const imp = S.imp;
  if (!isObj(imp.choices[i])) imp.choices[i] = {};
  return imp.choices[i];
}

function buildImportRows(imp) {
  const plan = imp.plan;
  const bundle = imp.bundle;
  const wrap = h('div', { class: 'pio-imp' });
  wrap.appendChild(h('h4', { class: 'pio-sub', text: t('pagesIo.import.versions', 'What will be imported') }));
  const groups = new Map();
  for (const r of plan.rows) { if (!groups.has(r.source)) groups.set(r.source, []); groups.get(r.source).push(r); }
  const disabled = !!imp.result || S.importing;
  for (const [source, rows] of groups) {
    const first = bundle.pages[rows[0].index];
    const g = h('div', { class: 'pio-group', role: 'group', 'aria-label': entryName(first) });
    g.appendChild(h('p', { class: 'pio-group-head' }, h('strong', { text: entryName(first) }), ' ', h('code', { text: source || '—' }),
      rows.length > 1 ? h('span', { class: 'pio-count', text: tf('pagesIo.import.nVersions', '{n} versions', { n: rows.length }) }) : null));
    for (const r of rows) g.appendChild(buildImportRow(imp, r, bundle.pages[r.index], disabled));
    wrap.appendChild(g);
  }
  const mode = (value, text) => h('label', { class: 'pio-radio' },
    h('input', { type: 'radio', name: 'pio-activate', value, checked: imp.activate === value, disabled: disabled || undefined, data: { key: `imp-mode-${value}` }, on: { change: () => { imp.activate = value; replan(); renderImport(); } } }), text);
  wrap.appendChild(h('fieldset', { class: 'pio-fieldset' },
    h('legend', { text: t('pagesIo.import.activateLegend', 'Pages created or replaced by the import') }),
    mode('publish', t('pagesIo.import.publish', 'Make the imported version live now')),
    mode('draft', t('pagesIo.import.asDraft', 'Put it in the draft only (visitors keep seeing the current version)'))));
  wrap.appendChild(h('p', { class: 'pio-hint', text: t('pagesIo.import.safe', 'Nothing is lost: a page that is replaced keeps what it showed as a version in its history, and you can activate it again at any time.') }));
  wrap.appendChild(h('p', { class: 'pio-status', id: 'pio-imp-status', role: 'status', 'aria-live': 'polite', text: imp.status || '' }));
  if (!imp.result) {
    const c = plan.counts;
    const go = h('button', {
      type: 'button', class: 'adm-btn adm-btn-accent', id: 'pio-go', disabled: (!plan.canImport || S.importing) || undefined, data: { key: 'imp-go' }, on: { click: runImport },
    }, icon('upload'), tf('pagesIo.import.go', 'Import {n} version(s)', { n: c.included }));
    wrap.appendChild(h('div', { class: 'pio-panel-actions' }, go));
  }
  return wrap;
}

function actionLabel(a, mode) {
  const draft = mode === 'draft';
  return {
    create: draft ? t('pagesIo.action.createDraft', 'Create the page with this version as its draft') : t('pagesIo.action.create', 'Create the page and make this version live'),
    version: t('pagesIo.action.version', 'Add as a version only (the live page is not touched)'),
    replace: draft ? t('pagesIo.action.replaceDraft', 'Replace the draft (the live page stays; the current state is kept)') : t('pagesIo.action.replace', 'Replace the live page (the current state is kept)'),
  }[a];
}

function buildImportRow(imp, r, entry, disabled) {
  const i = r.index;
  const off = disabled || r.blocked;
  const includeBox = h('input', {
    type: 'checkbox', checked: r.include, disabled: off || undefined, data: { key: `imp:${i}:include` },
    'aria-label': tf('pagesIo.import.include', 'Import “{label}”', { label: r.label }),
    on: { change: (e) => { rowChoice(i).include = e.target.checked; replan(); renderImport(); } },
  });
  const target = h('input', {
    type: 'text', class: 'adm-field-input', value: r.target, spellcheck: 'false', disabled: off || undefined, data: { key: `imp:${i}:target` },
    'aria-label': t('pages.xfer.target', 'Target page'), 'aria-invalid': r.error === 'slug' || r.error === 'duplicate' ? 'true' : undefined,
    on: { change: async (e) => {
      const c = rowChoice(i);
      c.target = e.target.value.trim().toLowerCase();
      delete c.action;
      replan();
      renderImport();
      // A new target may already hold a page the lists do not show: look before the plan says "new".
      if (SLUG_OK.test(c.target) && !S.probed.has(c.target)) { await probeSlugs([c.target]); if (S.imp === imp && !S.importing) { replan(); renderImport(); } }
    } },
  });
  const options = r.exists ? ['version', 'replace'] : ['create', 'version'];
  const select = h('select', {
    class: 'adm-field-input', disabled: off || undefined, 'aria-label': t('pagesIo.import.action', 'Action'), data: { key: `imp:${i}:action` },
    on: { change: (e) => { rowChoice(i).action = e.target.value; replan(); renderImport(); } },
  }, options.map((a) => h('option', { value: a, selected: r.action === a, text: actionLabel(a, imp.activate) })));
  const tags = h('span', { class: 'pio-badges' });
  if (r.blocked) tags.appendChild(h('span', { class: 'pg-xfer-tag is-error', text: t('pagesIo.import.blocked', 'cannot be imported') }));
  else if (r.builtin) tags.appendChild(h('span', { class: 'pg-xfer-tag is-warn', text: t('pagesIo.import.builtin', 'built-in page') }));
  else if (r.exists) tags.appendChild(h('span', { class: 'pg-xfer-tag is-warn', text: t('pagesIo.import.exists', 'existing page') }));
  else tags.appendChild(h('span', { class: 'pg-xfer-tag is-new', text: t('pages.xfer.newPage', 'new page') }));
  if (r.flaggedActive) tags.appendChild(h('span', { class: 'pio-badge is-active', text: t('pagesIo.import.flagged', 'active in the file') }));
  if (r.error === 'slug') tags.appendChild(h('span', { class: 'pg-xfer-tag is-error', text: t('pages.xfer.badSlug', 'invalid identifier') }));
  if (r.error === 'duplicate') tags.appendChild(h('span', { class: 'pg-xfer-tag is-error', text: t('pages.xfer.dupTarget', 'duplicate target') }));
  if (r.error === 'limit') tags.appendChild(h('span', { class: 'pg-xfer-tag is-error', text: t('pagesIo.import.full', 'history full') }));
  const facts = [fmtDate(r.createdAt)];
  const langs = pageLocales(entry);
  facts.push(widgetsText(widgetCount(primaryContent(entry))));
  if (langs.length) facts.push(langs.join(' ').toUpperCase());
  if (entry.draft && entry.published) facts.push(t('pages.xfer.withDraft', '+ draft'));
  const row = h('div', { class: `pio-imp-row${r.include ? '' : ' is-off'}${r.blocked ? ' is-blocked' : ''}` },
    h('div', { class: 'pio-imp-top' }, includeBox,
      h('span', { class: 'pio-imp-label' }, h('strong', { text: r.label || t('pagesIo.defaultLabel', 'Version') }), ' ', tags),
      h('span', { class: 'pio-facts', text: facts.filter(Boolean).join(' · ') })),
    h('div', { class: 'pio-imp-fields' },
      h('label', { class: 'pio-field' }, h('span', { text: t('pages.xfer.target', 'Target page') }), target),
      h('label', { class: 'pio-field pio-field-wide' }, h('span', { text: t('pagesIo.import.action', 'Action') }), select)));
  if (r.blocked) {
    const why = importBlockText(imp, r);
    if (why) row.appendChild(h('p', { class: 'pio-row-why', text: why }));
  }
  if (entry.note) row.appendChild(h('p', { class: 'pio-note', text: entry.note }));
  return row;
}

function importBlockText(imp, r) {
  const parts = [];
  for (const b of imp.compat.blockers) {
    if (b.page !== r.index) continue;
    if (b.code === 'widgetUnknown') parts.push(tf('pagesIo.block.widgets', 'Unknown widgets on this site: {list}.', { list: b.detail.join(', ') }));
    else if (b.code === 'pageSchemaNewer') parts.push(t('pagesIo.block.pageSchema', 'Saved with a newer page format than this site understands.'));
  }
  return parts.join(' ');
}

function buildResult(result) {
  const box = h('div', { class: 'pio-result', role: 'region', 'aria-label': t('pagesIo.result.title', 'Result of the import'), tabindex: '-1', id: 'pio-result' });
  box.appendChild(h('h4', { class: 'pio-sub', text: t('pagesIo.result.title', 'Result of the import') }));
  const ul = h('ul', { class: 'pio-report' });
  for (const d of result.done) ul.appendChild(h('li', { class: 'pio-check is-ok' }, h('span', { class: 'pio-mark', 'aria-hidden': 'true', text: '✓' }), sr(`${levelName('ok')}: `), h('span', { text: d.text })));
  for (const f of result.failed) ul.appendChild(h('li', { class: 'pio-check is-error' }, h('span', { class: 'pio-mark', 'aria-hidden': 'true', text: '✗' }), sr(`${levelName('error')}: `), h('span', { text: f.text })));
  for (const n of result.notes) ul.appendChild(h('li', { class: 'pio-check is-warn' }, h('span', { class: 'pio-mark', 'aria-hidden': 'true', text: '⚠' }), sr(`${levelName('warn')}: `), h('span', { text: n })));
  box.appendChild(ul);
  return box;
}

function closeImport() {
  if (S.importing) return;
  S.imp = null;
  renderImport();
  const b = $id('pio-import-btn');
  if (b) b.focus();
}

// ── Import: the writes ──────────────────────────────────────────────────────
/** What an entry stores as a version: title, menu row (custom pages), the blocks with the media renamed. */
async function contentOf(entry, target, renames) {
  const normalize = await getNormalizer();
  const c = {};
  if (isObj(entry.title) && Object.keys(entry.title).length) c.title = clone(entry.title);
  if (entry.nav && !isBuiltinSlug(target)) c.nav = clone(entry.nav);
  if (entry.published) c.published = normalize(renameMediaRefs(entry.published, renames));
  if (entry.draft) c.draft = normalize(renameMediaRefs(entry.draft, renames));
  return c;
}

function importCtx() {
  return {
    instance: () => S.instance,
    saveInstancePaths: async (paths) => {
      const r = await apiFetchStatus(`${API_SITE}?action=save&doc=instance&merge=${encodeURIComponent(paths.join(','))}`, { method: 'POST', body: JSON.stringify(S.instance) });
      if (r.ok) { try { if (typeof InstanceConfig !== 'undefined') await InstanceConfig.load(); } catch (_) { /* refreshed on the next load */ } }
      return r.ok;
    },
  };
}

function describeDone(row, name, mode, snapshot) {
  const vars = { label: row.label, page: name };
  if (row.action === 'version') return tf('pagesIo.result.version', '“{label}” was added to the history of {page}.', vars);
  if (mode === 'draft') return tf('pagesIo.result.draft', '“{label}” was put in the draft of {page}.', vars);
  if (row.action === 'create') return tf('pagesIo.result.created', 'The page {page} was created from “{label}”.', vars);
  if (snapshot) return tf('pagesIo.result.replacedKept', '“{label}” is now live on {page}; the previous state was kept in its history.', vars);
  return tf('pagesIo.result.replaced', '“{label}” is now live on {page}.', vars);
}

async function runImport() {
  const imp = S.imp;
  if (!imp || !imp.plan || !imp.plan.canImport || S.importing || imp.result) return;
  const rows = imp.plan.rows.filter((r) => r.include);
  const replacing = [...new Set(rows.filter((r) => r.action === 'replace' && r.exists).map((r) => r.target))];
  if (replacing.length && !confirm(imp.activate === 'draft'
    ? tf('pagesIo.confirm.replaceDraft', 'The draft of these pages will be replaced: {list}. What visitors see does not change, and the current state is kept in their history. Continue?', { list: replacing.join(', ') })
    : tf('pagesIo.confirm.replace', 'These pages will be replaced: {list}. What they show now is kept in their history. Continue?', { list: replacing.join(', ') }))) return;
  S.importing = true;
  window.addEventListener('beforeunload', onBeforeUnload);
  const say = (s) => { imp.status = s; const n = $id('pio-imp-status'); if (n) n.textContent = s; };
  syncControls();
  renderImport();
  renderList();
  const result = { done: [], failed: [], notes: [] };
  try {
    for (const slug of new Set(rows.map((r) => r.target))) takeOver(slug);
    const bundle = imp.bundle;
    const pagesIn = rows.map((r) => bundle.pages[r.index]);
    let renames = new Map();
    try { renames = await importMedia(bundle, pagesIn, say, result.notes); } catch (e) { console.error('pages-io media', e); result.notes.push(t('pagesIo.result.mediaFailed', 'The images could not be written; the pages keep their references.')); }
    try { await importVariables(importCtx(), bundle, pagesIn, say, result.notes); } catch (e) { console.error('pages-io variables', e); result.notes.push(t('pages.xfer.varsFailed', 'The page variables could not be saved.')); }
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const entry = bundle.pages[r.index];
      const name = pageName(r.target);
      say(tf('pages.xfer.writingPage', 'Page {n}/{total}: {slug}…', { n: i + 1, total: rows.length, slug: r.target }));
      try {
        const content = await contentOf(entry, r.target, renames);
        const res = await Api.add(r.target, {
          label: r.label, note: entry.note || '', origin: 'import', content,
          exportedAt: bundle.exportedAt, source: bundle.source, platform: bundle.platform,
          activate: r.activate || undefined, snapshotLabel: t('pagesIo.snapshotImport', 'Before import'),
        });
        if (!res.ok) {
          result.failed.push({ target: r.target, text: tf('pagesIo.result.failed', '“{label}” → {page}: {reason}', { label: r.label, page: name, reason: Api.errorText(res) }) });
          continue;
        }
        result.done.push({ target: r.target, text: describeDone(r, name, r.activate, !!res.data.snapshotId) });
        if (r.activate && !isBuiltinSlug(r.target)) {
          const nav = isObj(content.nav) ? content.nav : null;
          const wantShow = r.activate === 'publish' && !(nav && nav.show === false);
          const ok = await ensureNavRow(r.target, { label: navLabelFor(r.target, nav, content.title), wantShow });
          if (!ok) result.notes.push(tf('pagesIo.err.navFor', 'The menu could not be updated for {page}: add it from Identity → Navigation.', { page: name }));
        }
      } catch (e) {
        console.error('pages-io import', e);
        result.failed.push({ target: r.target, text: tf('pagesIo.result.failed', '“{label}” → {page}: {reason}', { label: r.label, page: name, reason: t('pagesIo.err.generic', 'The request failed. Try again.') }) });
      }
    }
  } finally {
    S.importing = false;
    window.removeEventListener('beforeunload', onBeforeUnload);
  }
  imp.result = result;
  imp.status = '';
  syncControls();
  await refresh();
  renderImport();
  const box = $id('pio-result');
  if (box) box.focus();
  if (result.done.length) toast(tf('pagesIo.result.toast', '{n} version(s) imported.', { n: result.done.length }), 'success');
  if (result.failed.length) toast(tf('pagesIo.result.toastFailed', '{n} version(s) could not be imported.', { n: result.failed.length }), 'error');
}

function pageName(slug) {
  const p = pageOf(slug);
  return p ? p.name : slug;
}

function onBeforeUnload(e) { e.preventDefault(); e.returnValue = ''; }

// ── The tab ─────────────────────────────────────────────────────────────────
let _docBound = false;

export const PagesIoTab = {
  id: 'pages-io',
  titleKey: 'admin.navPagesIO',
  titleDefault: 'Page import / export',
  mounted: false,
  mount() {
    if (!mountSkeleton()) return;
    if (!_docBound) { _docBound = true; document.addEventListener('click', onDocumentClick); }
    S.mounted = true;
    renderAll();
  },
  activate() { if (S.mounted && !S.importing) refresh(); },
  relabel() {
    if (!S.mounted) return;
    buildPages();
    mountSkeleton();
    renderAll();
  },
};
