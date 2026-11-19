/**
 * Admin SPA — page versions, the pure engine (no DOM, no requests)
 * ================================================================
 * A page keeps a history of versions (api/page-versions.php, DOCS/pages-library/SPEC.md).
 * This module holds what both the Import / export tab and the tests need without a
 * server: comparing the content of two versions, telling whether the live page is
 * still the version the operator activated, turning versions into bundle entries
 * (export) and planning what an import file does to the pages of this site.
 *
 * A "content" is { title?, nav?, published?, draft? } — a version's content, a live
 * page document ({title, published, draft, schemaVersion}) or a bundle entry.
 */

'use strict';

import {
  BUILTIN_SLUGS, SLUG_RX, isBuiltinSlug, pageEntry, contentBlock, localizedOrEmpty, checkCompatibility,
} from './pages-transfer.js';

/** Server limit of one page's history (SPEC §2). */
export const MAX_VERSIONS = 50;
export const ACTIONS = Object.freeze(['create', 'version', 'replace']);
export const ACTIVATE_MODES = Object.freeze(['publish', 'draft']);

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// ── Content signature ───────────────────────────────────────────────────────

/**
 * Canonical text of a value: keys sorted, an empty array and an empty object alike
 * (PHP encodes both as []), undefined and null dropped from objects.
 */
function canon(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return v.length ? '[' + v.map(canon).join(',') + ']' : '{}';
  if (isObj(v)) {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return keys.length ? '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : '{}';
  }
  return JSON.stringify(v) === undefined ? 'null' : JSON.stringify(v);
}

/** A stored version ({content}) or a content itself → the content. */
function unwrap(c) {
  if (!isObj(c)) return {};
  if (isObj(c.content) && c.published === undefined && c.draft === undefined && c.title === undefined) return c.content;
  return c;
}

/**
 * What makes two pages the same: title, published and draft block — the media and
 * background normalised as the exporter does, a draft equal to the published block
 * counting as no draft, key order and PHP's [] / {} confusion ignored.
 * → a string; two contents are equal exactly when their signatures are.
 */
export function contentSignature(content, { title = true } = {}) {
  const src = unwrap(content);
  const pub = contentBlock(src.published);
  let draft = contentBlock(src.draft);
  if (draft && pub && canon(draft) === canon(pub)) draft = null;
  return canon({ title: title ? localizedOrEmpty(src.title) : {}, published: pub, draft });
}

/** Does the content carry a title of its own (a version without one leaves the live title alone when activated)? */
export function hasTitle(content) {
  const t = localizedOrEmpty(unwrap(content).title);
  return isObj(t) && Object.keys(t).length > 0;
}

/**
 * Both signatures of a content, with and without its title, and whether it has one: what
 * `describeLive` needs to apply the server's rule (a title-less version equals the live page
 * whatever the live title is).
 */
export function contentSignatures(content) {
  return { full: contentSignature(content), bare: contentSignature(content, { title: false }), titled: hasTitle(content) };
}

/** Is the live page what activating `version` would leave? A version without a title leaves the live title alone. */
export function sameContent(live, version) {
  return hasTitle(version) ? contentSignature(live) === contentSignature(version)
    : contentSignature(live, { title: false }) === contentSignature(version, { title: false });
}

// ── Bundle entries ──────────────────────────────────────────────────────────

/**
 * The entries of a parsed bundle grouped by slug, in file order (oldest version first).
 * → Map slug → [{ index, page }]   (index = position in bundle.pages)
 */
export function entriesBySlug(bundle) {
  const map = new Map();
  const pages = bundle && Array.isArray(bundle.pages) ? bundle.pages : [];
  pages.forEach((page, index) => {
    const slug = isObj(page) && typeof page.slug === 'string' ? page.slug : '';
    if (!map.has(slug)) map.set(slug, []);
    map.get(slug).push({ index, page });
  });
  return map;
}

function timeOf(e) {
  const t = isObj(e) && typeof e.createdAt === 'string' ? Date.parse(e.createdAt) : NaN;
  return Number.isNaN(t) ? null : t;
}

/**
 * Index of the entry a page's import should leave live: the one flagged `active`, else
 * the newest (latest createdAt; the last one of the list when dates are missing or equal).
 * -1 for an empty list.
 */
export function pickActiveIndex(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const flagged = list.findIndex((e) => isObj(e) && e.active === true);
  if (flagged !== -1) return flagged;
  if (!list.length) return -1;
  let best = -1;
  let bestT = -Infinity;
  list.forEach((e, i) => {
    const t = timeOf(e);
    if (t !== null && t >= bestT) { best = i; bestT = t; }
  });
  return best === -1 ? list.length - 1 : best;
}

export function pickActiveForSlug(entries) {
  const i = pickActiveIndex(entries);
  return i === -1 ? null : entries[i];
}

function withMeta(entry, meta) {
  const m = isObj(meta) ? meta : {};
  if (typeof m.label === 'string' && m.label.trim()) entry.label = m.label.trim();
  if (typeof m.note === 'string' && m.note.trim()) entry.note = m.note;
  if (typeof m.createdAt === 'string' && m.createdAt && !Number.isNaN(Date.parse(m.createdAt))) entry.createdAt = m.createdAt;
  if (m.active === true) entry.active = true;
  return entry;
}

/**
 * A bundle entry for a stored version (`version` = the answer of page-versions `get`:
 * META fields + content). Several of them for one slug make a `lumen-pages/2` file.
 * null when the version carries no content.
 */
export function versionToBundleEntry(slug, version, { active } = {}) {
  if (!isObj(version) || !isObj(version.content)) return null;
  const c = version.content;
  const entry = pageEntry(slug, c, isObj(c.nav) ? c.nav : null);
  return withMeta(entry, { label: version.label, note: version.note, createdAt: version.createdAt, active: active === true });
}

/**
 * A bundle entry for the live page (a /1 entry; `meta` = optional {label, note, createdAt, active}).
 * `navEntry` = the page's row of instance.nav.customPages ({label, show}), custom pages only.
 */
export function pageEntryFromLive(slug, liveDoc, navEntry, meta) {
  return withMeta(pageEntry(slug, liveDoc, navEntry), meta);
}

// ── Live page vs its versions ───────────────────────────────────────────────

/**
 * Where does the live page stand against its history?
 * `versions` = the versions of the slug, each with its `content` (or a precomputed
 * `signature` = contentSignature(content)) and `id`, `label`, `isActive`.
 * → { state, id, label, matchedActive, comparable }
 *   'sync'        the live page equals a version (the active one when it does) → id/label of it
 *   'modified'    an active version exists and the live page no longer equals it → id/label of the active one
 *   'unversioned' no version matches and none is active
 * `comparable` is false when some version could not be compared (neither content nor
 * signature given): the answer is then the best one the others allow.
 */
export function describeLive(liveDoc, versions) {
  const list = Array.isArray(versions) ? versions.filter(isObj) : [];
  const out = { state: 'unversioned', id: null, label: '', matchedActive: false, comparable: true };
  const live = isObj(liveDoc) ? liveDoc : {};
  const liveEmpty = !contentBlock(live.published) && !contentBlock(live.draft);
  // A version is { content } or its precomputed { signature, signatureBare?, hasTitle? } (contentSignatures).
  const sigs = list.map((v) => {
    if (isObj(v.content)) return contentSignatures(v.content);
    if (typeof v.signature !== 'string') return null;
    return { full: v.signature, bare: typeof v.signatureBare === 'string' ? v.signatureBare : null, titled: v.hasTitle !== false };
  });
  out.comparable = sigs.every((x) => x !== null);
  const active = list.find((v) => v.isActive === true) || null;
  const pick = (v, matchedActive) => Object.assign(out, { id: v.id || null, label: typeof v.label === 'string' ? v.label : '', matchedActive });

  if (!liveEmpty) {
    const liveFull = contentSignature(live);
    const liveBare = contentSignature(live, { title: false });
    const matches = (x) => x !== null && (x.titled || x.bare === null ? x.full === liveFull : x.bare === liveBare);
    const ai = active ? list.indexOf(active) : -1;
    if (ai !== -1 && matches(sigs[ai])) { out.state = 'sync'; return pick(active, true); }
    // newest first in the answer of the server: the first match is the most recent one
    const mi = sigs.findIndex(matches);
    if (mi !== -1) { out.state = 'sync'; return pick(list[mi], false); }
  }
  if (active) { out.state = 'modified'; return pick(active, true); }
  return out;
}

// ── Import planning ─────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');

// A stored history is one JSON file of at most 32 MiB, written indented (the PHP twin's four spaces, the strictest):
// a version weighs about 3.2 times its compact `bytes` on disk (measured on real pages). `rowBytes` models the
// file for a version about to be added; `STORED_FACTOR` stands for the ones already stored.
export const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const STORED_FACTOR = 3.3;
const RECORD_FIELDS = 420;      // id, label, note, dates, source, platform: the version record around its content

function rowBytes(entry) {
  if (!isObj(entry)) return 0;
  try {
    const text = JSON.stringify({ title: entry.title, nav: entry.nav, published: entry.published, draft: entry.draft }, null, 4);
    // two more nesting levels (versions[] → version → content) indent every line by 12 more spaces
    return new TextEncoder().encode(text).length + (text.split('\n').length * 12) + RECORD_FIELDS;
  } catch (_) { return 0; }
}

/** Label of an imported version when the file gives none: "<source> · <yyyy-mm-dd>" ('' when neither is known). */
export function defaultImportLabel(bundle, entry) {
  const src = bundle && typeof bundle.source === 'string' ? bundle.source.trim() : '';
  const when = (entry && typeof entry.createdAt === 'string' && entry.createdAt) || (bundle && bundle.exportedAt) || '';
  const t = Date.parse(when);
  const date = Number.isNaN(t) ? '' : (() => { const d = new Date(t); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; })();
  return [src, date].filter(Boolean).join(' · ');
}

/**
 * What an import file does to this site: one row per entry of the bundle.
 *
 *   state   = { pages: [slug…] (custom pages that exist; home/about always do),
 *               versions: { slug: [META…] } (history of each slug, for limits and "restores") }
 *   choices = { activate: 'publish'|'draft' (default publish),
 *               compat?: checkCompatibility(...) result   (or `site` = its second argument),
 *               rows?: [{ include?: bool, target?: string, action?: 'create'|'version'|'replace' }]
 *                      indexed like bundle.pages; anything missing = the default }
 *
 * Defaults: target = the slug of the entry; a target that does not exist → the picked entry
 * of the group (flagged active, else newest) is 'create', the others 'version'; an existing
 * target → 'version' (the live page is not touched). 'replace' = add + activate over an
 * existing page, 'create' = add + activate for a page that does not exist yet: a wrong
 * word for the target's state is turned into its sibling (the intent to activate is kept).
 * On a new target the first activating row is 'create', later ones 'replace' (the page
 * exists by then). Rows are written in index order.
 *
 * Row: { index, source, target, label, labelDefault, createdAt, flaggedActive,
 *        builtin, exists, hasHistory, include, action, defaultAction, activate ('publish'|'draft'|null),
 *        createsPage, blocked, blockedBy:[codes], error: null|'slug'|'duplicate'|'limit' }
 * `error` only for rows that are included (an excluded row is never validated).
 * Result: { rows, activate, ok (no included row has an error), canImport (ok and ≥ 1 included row),
 *           counts: { included, create, version, replace, skipped, blocked, errors } }
 */
export function planVersionImport(bundle, state, choices) {
  const entries = bundle && Array.isArray(bundle.pages) ? bundle.pages : [];
  const st = isObj(state) ? state : {};
  const ch = isObj(choices) ? choices : {};
  const mode = ch.activate === 'draft' ? 'draft' : 'publish';
  const existing = new Set(BUILTIN_SLUGS);
  for (const s of (Array.isArray(st.pages) ? st.pages : [])) if (typeof s === 'string') existing.add(s);
  const metasOf = (slug) => {
    const v = isObj(st.versions) && Object.prototype.hasOwnProperty.call(st.versions, slug) ? st.versions[slug] : null;
    return Array.isArray(v) ? v : [];
  };
  const historyOf = (slug) => metasOf(slug).length;
  const historyBytes = (slug) => metasOf(slug).reduce((n, m) => n + Math.ceil(((isObj(m) && Number.isFinite(m.bytes) ? m.bytes : 0) * STORED_FACTOR) + RECORD_FIELDS), 0);
  const compat = isObj(ch.compat) ? ch.compat : (isObj(ch.site) ? checkCompatibility(bundle, ch.site) : null);
  const fileBlockers = compat ? compat.blockers.filter((b) => b.page === undefined).map((b) => b.code) : [];
  const pageCompat = new Map((compat ? compat.pages : []).map((p) => [p.index, p]));
  const choiceOf = (i) => {
    const r = ch.rows;
    const c = Array.isArray(r) ? r[i] : (isObj(r) ? r[i] : null);
    return isObj(c) ? c : {};
  };

  const rows = entries.map((entry, index) => {
    const c = choiceOf(index);
    const source = isObj(entry) && typeof entry.slug === 'string' ? entry.slug : '';
    const target = (typeof c.target === 'string' ? c.target : source).trim().toLowerCase();
    const pc = pageCompat.get(index);
    const blockedBy = [...fileBlockers];
    if (pc && !pc.ok && compat) {
      for (const b of compat.blockers) if (b.page === index && !blockedBy.includes(b.code)) blockedBy.push(b.code);
    }
    const blocked = blockedBy.length > 0;
    const label = (isObj(entry) && typeof entry.label === 'string' && entry.label) || defaultImportLabel(bundle, entry);
    return {
      index, source, target,
      label, labelDefault: !(isObj(entry) && entry.label),
      createdAt: isObj(entry) && entry.createdAt ? entry.createdAt : '',
      flaggedActive: isObj(entry) && entry.active === true,
      builtin: isBuiltinSlug(target),
      exists: existing.has(target),
      hasHistory: historyOf(target) > 0,
      include: c.include !== false && !blocked,
      action: 'version', defaultAction: 'version', activate: null, createsPage: false,
      blocked, blockedBy, error: null,
      _want: ACTIONS.includes(c.action) ? c.action : null,
    };
  });

  // Groups of included rows by target.
  const groups = new Map();
  for (const r of rows) {
    if (!r.include) continue;
    if (!SLUG_RX.test(r.target)) { r.error = 'slug'; continue; }
    if (!groups.has(r.target)) groups.set(r.target, []);
    groups.get(r.target).push(r);
  }

  for (const [target, list] of groups) {
    const exists = existing.has(target);
    // Two different pages landing on one NEW slug would create two pages at once.
    if (!exists && list.some((r) => r.source !== list[0].source)) {
      list.forEach((r) => { r.error = 'duplicate'; });
      continue;
    }
    // Default: on a new page the picked entry of the group creates it, the rest are versions.
    const pickedAt = exists ? -1 : pickActiveIndex(list.map((r) => entries[r.index]));
    list.forEach((r, k) => { r.defaultAction = k === pickedAt ? 'create' : 'version'; });
    let created = false;
    for (const r of list) {
      let a = r._want || r.defaultAction;
      if (a !== 'version') {
        if (exists) a = 'replace';
        else { a = created ? 'replace' : 'create'; created = true; }
      }
      r.action = a;
      r.activate = a === 'version' ? null : mode;
      r.createsPage = a === 'create' && !r.builtin;
    }
    // Room in the history. After a publish the page IS the version just applied, so only the first activation of
    // an existing page can need a safety snapshot; a draft activation leaves the published block as it was, which
    // matches no stored version, so each one after the first state change takes its own.
    const activations = list.filter((r) => r.action !== 'version').length;
    const reserve = mode === 'draft' ? (exists ? activations : Math.max(0, activations - 1)) : (exists && activations ? 1 : 0);
    const room = Math.max(0, MAX_VERSIONS - historyOf(target) - reserve);
    list.forEach((r, k) => { if (k >= room) r.error = r.error || 'limit'; });
    // The stored file is capped as well (SPEC §2): the rows that no longer fit in its remaining bytes are refused.
    let free = MAX_HISTORY_BYTES - historyBytes(target);
    for (const r of list) {
      if (r.error) continue;
      const need = rowBytes(entries[r.index]);
      if (need > free) r.error = 'limit'; else free -= need;
    }
  }

  for (const r of rows) delete r._want;

  const included = rows.filter((r) => r.include);
  const counts = {
    included: included.length,
    create: included.filter((r) => r.action === 'create').length,
    version: included.filter((r) => r.action === 'version').length,
    replace: included.filter((r) => r.action === 'replace').length,
    skipped: rows.filter((r) => !r.include && !r.blocked).length,
    blocked: rows.filter((r) => r.blocked).length,
    errors: included.filter((r) => r.error).length,
  };
  const ok = counts.errors === 0;
  return { rows, activate: mode, ok, canImport: ok && counts.included > 0, counts };
}
