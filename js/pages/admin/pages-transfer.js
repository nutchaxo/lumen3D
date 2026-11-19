/**
 * Admin SPA — page import / export, the file format (pure, no DOM)
 * ================================================================
 * A page bundle carries one or more pages of the page builder (the built-in
 * home / about and the custom pages of the menu) from one instance to another,
 * or into a backup:
 *
 *   {
 *     "$schema": "lumen-pages/1",
 *     "exportedAt": ISO date, "platform": "1.61.0", "source": "host",
 *     "pages": [ { slug, title:{loc}, nav?:{label:{loc}, show}, published?:{sections,background?}, draft?:{…} } ],
 *     "media": [ { name, type, data:<base64> } ],      // images of config/uploads/ the pages use
 *     "variables": { name: "value" | {loc} }            // fixed page variables the pages use
 *   }
 *
 * `draft` is written only when it differs from `published`; a page carries at least
 * one of the two. `nav` exists for custom pages only (home / about are linked by the
 * Identity tab). A raw page document (`config/pages/<slug>.json` as a host serves
 * it: {title, published, schemaVersion}) is accepted too, its slug taken from the
 * file name.
 *
 * Everything here is pure so the format is locked by tests/js/test_pages_transfer.mjs;
 * the dialog and the requests live in pages-transfer-ui.js.
 */

'use strict';

export const SCHEMA = 'lumen-pages/1';
// /2 = the same file with several entries per slug (a page's versions) and the optional
// per-entry label / note / createdAt / active. A writer picks /2 only when a slug repeats.
export const SCHEMA_V2 = 'lumen-pages/2';
export const SUPPORTED_SCHEMAS = Object.freeze([SCHEMA, SCHEMA_V2]);
export const MAX_SCHEMA = 2;
export const SLUG_RX = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const BUILTIN_SLUGS = Object.freeze(['home', 'about']);
export const FILE_EXTENSION = '.lumen-pages.json';

// Limits of the server side, checked here so a refusal is explained before any write.
export const PAGE_MAX_BYTES = 2097152;           // site_validate_page / _validate_page_doc
export const MEDIA_MAX_BYTES = 8388608;          // api/media.php MEDIA_MAX
export const FILE_MAX_BYTES = 128 * 1024 * 1024;
const MAX_PAGES = 200;
const MAX_ENTRIES_V2 = 1000;
// The server's own bounds (dev_server.py _PV_* / api/_page_versions_lib.php PV_*): a block nests at most
// MAX_BLOCK_DEPTH containers, one version's blocks weigh at most 4 MiB together, a localized value holds
// at most 64 locales of 4000 characters.
export const MAX_BLOCK_DEPTH = 64;
export const VERSION_MAX_BYTES = 4 * 1024 * 1024;
const LOC_MAX_KEYS = 64;
const LOC_MAX_CHARS = 4000;
export const LABEL_MAX = 120;
export const NOTE_MAX = 2000;
const MAX_MEDIA = 500;
const MAX_SECTIONS = 300;
const MAX_COLUMNS = 12;
const MAX_WIDGETS = 500;

// A media library file as api/media.php names it: media_safe_name keeps
// [a-z0-9_-] stems of ≤ 60 chars, a dedup suffix adds "-N".
const MEDIA_NAME_RX = /^[A-Za-z0-9_-]{1,72}\.(?:png|jpe?g|webp|gif|avif)$/i;
// A reference to it inside page content: a relative URL as the media picker
// inserts it (optionally ./ or / rooted), in a plain value, a CSS url(…) or HTML.
// An absolute URL (https://host/config/uploads/…) points at its own host and is
// left alone: the character before "config" must not be part of a path.
const MEDIA_REF_RX = /(^|[^A-Za-z0-9_.\/-])((?:\.\/|\/)?config\/uploads\/)([A-Za-z0-9_-]{1,72}\.(?:png|jpe?g|webp|gif|avif))(?![A-Za-z0-9_.-])/gi;
const TOKEN_RX = /\{(\w{1,64})\}/g;
const VAR_NAME_RX = /^\w{1,64}$/;

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

export function isBuiltinSlug(slug) { return BUILTIN_SLUGS.includes(slug); }

/** UTF-8 length of the JSON of `v` — the size the server measures. */
export function jsonBytes(v) {
  const s = JSON.stringify(v);
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
  return unescape(encodeURIComponent(s)).length;
}

/**
 * Length of the JSON of `v` with every non-ASCII character written as \uXXXX — what the server's page-doc
 * gate measures (Python's json.dumps, PHP's json_encode). Never smaller than the UTF-8 length.
 */
export function escapedJsonLength(v) {
  const s = JSON.stringify(v);
  let extra = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) extra += 5;
  return s.length + extra;
}

/**
 * Nesting depth of `v` (a scalar is 0, a container 1 + its deepest child), walked without recursion and
 * stopped once it passes `cap`: a hostile file nests as deep as JSON.parse allows, which a recursive
 * clone or walk cannot survive.
 */
export function depthOf(v, cap) {
  const stack = [[v, 1]];
  let deepest = 0;
  while (stack.length) {
    const [node, d] = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (d > deepest) deepest = d;
    if (d > cap) return d;
    for (const child of (Array.isArray(node) ? node : Object.values(node))) {
      if (child !== null && typeof child === 'object') stack.push([child, d + 1]);
    }
  }
  return deepest;
}

/** `v` with every string passed through `fn` (objects and arrays rebuilt). */
export function mapStrings(v, fn) {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (isObj(v)) {
    const out = {};
    for (const k of Object.keys(v)) out[k] = mapStrings(v[k], fn);
    return out;
  }
  return v;
}

function eachString(v, fn) {
  const stack = [v];
  while (stack.length) {
    const x = stack.pop();
    if (typeof x === 'string') fn(x);
    else if (Array.isArray(x)) for (let i = x.length - 1; i >= 0; i--) stack.push(x[i]);
    else if (isObj(x)) for (const k of Object.keys(x)) stack.push(x[k]);
  }
}

/** Names of the media library files (config/uploads/<name>) that `v` references. */
export function collectMediaRefs(v) {
  const names = new Set();
  eachString(v, (s) => {
    if (s.indexOf('config/uploads/') === -1) return;
    for (const m of s.matchAll(MEDIA_REF_RX)) names.add(m[3]);
  });
  return [...names];
}

/** `v` with the media references renamed by `renames` (old name → new name). */
export function renameMediaRefs(v, renames) {
  const map = renames instanceof Map ? renames : new Map(Object.entries(renames || {}));
  if (!map.size) return clone(v);
  return mapStrings(v, (s) => (s.indexOf('config/uploads/') === -1 ? s
    : s.replace(MEDIA_REF_RX, (all, pre, dir, name) => (map.has(name) ? pre + dir + map.get(name) : all))));
}

/** The {token} names used in the strings of `v`. */
export function collectTokens(v) {
  const names = new Set();
  eachString(v, (s) => { if (s.indexOf('{') !== -1) for (const m of s.matchAll(TOKEN_RX)) names.add(m[1]); });
  return [...names];
}

/** A localizable value: a string, or an object of per-locale strings. */
function isLocalized(v) {
  if (typeof v === 'string') return true;
  if (!isObj(v)) return false;
  return Object.keys(v).every((k) => /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?$/.test(k) && typeof v[k] === 'string');
}
export function isLocalizedValue(v) { return isLocalized(v); }
/** A localized object over the server's bounds (64 locales, 4000 characters a value) — it would be refused on write. */
function localizedTooBig(v) {
  if (!isObj(v)) return false;
  const keys = Object.keys(v);
  if (keys.length > LOC_MAX_KEYS) return true;
  return keys.some((k) => typeof v[k] === 'string' && [...v[k]].length > LOC_MAX_CHARS);
}
export function localizedOrEmpty(v) { return isLocalized(v) ? clone(v) : {}; }

/** The page content of a document block: {sections, background?}, legacy {blocks} kept. */
export function contentBlock(b) {
  if (!isObj(b)) return null;
  if (!Array.isArray(b.sections) && !Array.isArray(b.blocks)) return null;
  const out = {};
  if (Array.isArray(b.sections)) out.sections = clone(b.sections);
  else out.blocks = clone(b.blocks);
  if (isObj(b.background) && typeof b.background.preset === 'string' && b.background.preset) {
    out.background = { preset: b.background.preset, params: isObj(b.background.params) ? clone(b.background.params) : {} };
  }
  return out;
}

/** Structural gate of one content block — the server's site_validate_page, said earlier. */
export function checkContent(b, key) {
  if (!isObj(b)) return 'not an object';
  if (depthOf(b, MAX_BLOCK_DEPTH) > MAX_BLOCK_DEPTH) return 'too deeply nested';
  if (b.sections !== undefined) {
    if (!Array.isArray(b.sections) || b.sections.length > MAX_SECTIONS) return 'invalid sections';
    for (const s of b.sections) {
      if (!isObj(s)) return 'invalid section';
      if (s.columns === undefined) continue;
      if (!Array.isArray(s.columns) || s.columns.length > MAX_COLUMNS) return 'invalid columns';
      for (const c of s.columns) {
        if (!isObj(c)) return 'invalid column';
        if (c.widgets === undefined) continue;
        if (!Array.isArray(c.widgets) || c.widgets.length > MAX_WIDGETS) return 'invalid widgets';
        for (const w of c.widgets) if (!isObj(w) || typeof w.type !== 'string' || !w.type) return 'invalid widget';
      }
    }
  } else if (b.blocks !== undefined) {
    if (!Array.isArray(b.blocks) || b.blocks.length > MAX_WIDGETS) return 'invalid blocks';
    for (const w of b.blocks) if (!isObj(w) || typeof w.type !== 'string' || !w.type) return 'invalid widget';
  } else {
    return 'no sections';
  }
  // The server counts the document the way its JSON encoder writes it (non-ASCII as \uXXXX), and a block's UTF-8 size too.
  if (jsonBytes(b) > PAGE_MAX_BYTES || escapedJsonLength({ [key === 'draft' ? 'draft' : 'published']: b }) > PAGE_MAX_BYTES) return 'too large';
  return null;
}

/** Widget count of a content block (sections, or legacy blocks). */
export function widgetCount(b) {
  if (!isObj(b)) return 0;
  if (Array.isArray(b.blocks)) return b.blocks.length;
  let n = 0;
  for (const s of (Array.isArray(b.sections) ? b.sections : [])) {
    for (const c of (isObj(s) && Array.isArray(s.columns) ? s.columns : [])) n += (isObj(c) && Array.isArray(c.widgets)) ? c.widgets.length : 0;
  }
  return n;
}

/** The languages the text of a page is written in (keys of its localized values). */
export function pageLocales(page) {
  const locs = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!isObj(v)) return;
    const keys = Object.keys(v);
    if (keys.length && keys.every((k) => /^[a-z]{2}$/.test(k) && typeof v[k] === 'string')) { keys.forEach((k) => locs.add(k)); return; }
    keys.forEach((k) => walk(v[k]));
  };
  walk([page.published, page.draft]);
  return [...locs].sort();
}

/** The page block a reader sees first: the published one, else the draft. */
export function primaryContent(page) { return page.published || page.draft || null; }

/** Is a stored page document empty — nothing authored, nothing to export? */
export function isEmptyDoc(doc) {
  if (!isObj(doc)) return true;
  return ['published', 'draft'].every((k) => {
    const b = doc[k];
    if (!isObj(b)) return true;
    const n = Array.isArray(b.sections) ? b.sections.length : (Array.isArray(b.blocks) ? b.blocks.length : 0);
    return n === 0 && !(isObj(b.background) && b.background.preset);
  });
}

/**
 * One page entry of a bundle from a stored page document (as api/site.php
 * answers an admin: published + the private draft).
 * `navEntry` = the page's row of instance.nav.customPages (custom pages only).
 */
export function pageEntry(slug, doc, navEntry) {
  const d = isObj(doc) ? doc : {};
  const entry = { slug, title: localizedOrEmpty(d.title) };
  if (!isBuiltinSlug(slug) && isObj(navEntry)) {
    entry.nav = { label: localizedOrEmpty(navEntry.label), show: navEntry.show !== false };
  }
  const pub = contentBlock(d.published);
  const draft = contentBlock(d.draft);
  if (pub) entry.published = pub;
  if (draft && (!pub || JSON.stringify(draft) !== JSON.stringify(pub))) entry.draft = draft;
  if (!pub && !draft) entry.published = { sections: [] };
  return entry;
}

/** The fixed page variables (instance.variables) the pages of a bundle use. */
export function usedVariables(pages, variables) {
  const out = {};
  if (!isObj(variables)) return out;
  for (const name of collectTokens(pages)) {
    if (Object.prototype.hasOwnProperty.call(variables, name) && isLocalized(variables[name])) out[name] = clone(variables[name]);
  }
  return out;
}

/** The bundle object. `media` = [{name, type, data}] already read by the caller. */
export function buildBundle({ pages, media, variables, platform, source, now }) {
  const seen = new Set();
  let repeated = false;
  for (const p of (pages || [])) {
    const slug = p && p.slug;
    if (seen.has(slug)) { repeated = true; break; }
    seen.add(slug);
  }
  const bundle = {
    $schema: repeated ? SCHEMA_V2 : SCHEMA,
    exportedAt: (now instanceof Date ? now : new Date()).toISOString(),
  };
  if (platform) bundle.platform = String(platform);
  if (source) bundle.source = String(source);
  bundle.pages = clone(pages || []);
  bundle.media = (media || []).map((m) => ({ name: m.name, type: m.type || mediaType(m.name), data: m.data }));
  bundle.variables = isObj(variables) ? clone(variables) : {};
  return bundle;
}

/** File name of a bundle: <slug>.lumen-pages.json for one page, <source>-pages-<date> for several. */
export function bundleFileName(bundle, source) {
  const pages = (bundle && Array.isArray(bundle.pages)) ? bundle.pages : [];
  const date = String(bundle && bundle.exportedAt || '').slice(0, 10) || 'export';
  const host = String(source || '').toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
  if (pages.length === 1) return `${host}-${pages[0].slug}-${date}${FILE_EXTENSION}`;
  return `${host}-pages-${date}${FILE_EXTENSION}`;
}

export function mediaType(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' }[ext] || 'application/octet-stream';
}

/** Decoded size of a base64 string (no data: prefix). */
export function base64Bytes(b64) {
  const s = String(b64 || '').replace(/\s+/g, '');
  if (!s) return 0;
  const pad = s.endsWith('==') ? 2 : (s.endsWith('=') ? 1 : 0);
  return Math.floor(s.length * 3 / 4) - pad;
}

function b64Head(b64, n) {
  const chunk = String(b64).replace(/\s+/g, '').slice(0, Math.ceil(n / 3) * 4);
  try {
    if (typeof atob === 'function') return Array.from(atob(chunk), (c) => c.charCodeAt(0));
  } catch (_) { return null; }
  return null;
}

/** The image format the first bytes prove (api/media.php media_magic_ext), or null. */
export function magicType(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const s = (a, b) => String.fromCharCode(...bytes.slice(a, b));
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return 'webp';
  if (bytes[0] === 0x89 && s(1, 4) === 'PNG') return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (s(0, 6) === 'GIF87a' || s(0, 6) === 'GIF89a') return 'gif';
  if (s(4, 8) === 'ftyp' && (s(8, 12) === 'avif' || s(8, 12) === 'avis')) return 'avif';
  return null;
}

/** Slug of a page from the name of a raw page file ("about.json" → "about"). */
export function slugFromFileName(fileName) {
  const base = String(fileName || '').split(/[\\/]/).pop().toLowerCase()
    .replace(/\.lumen-pages\.json$|\.json$/, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 64);
  return SLUG_RX.test(base) ? base : '';
}

const ISO_RX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
function isIsoDate(v) { return typeof v === 'string' && ISO_RX.test(v) && !Number.isNaN(Date.parse(v)); }

/** A free-text field of a /2 entry: control characters out (newlines kept in a note), trimmed, capped. */
function cleanText(v, max, multiline) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const t = v.replace(multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, '').trim();
  return t.length > max ? t.slice(0, max).trim() : t;
}

/**
 * The entries of one slug oldest first (file order when the dates are equal). A slug
 * whose entries do not ALL carry a date keeps its file order: with a partial order
 * any rule would reshuffle entries the operator never dated.
 */
function orderVersions(pages) {
  const bySlug = new Map();
  pages.forEach((p, i) => { if (p.slug) { if (!bySlug.has(p.slug)) bySlug.set(p.slug, []); bySlug.get(p.slug).push(i); } });
  for (const idxs of bySlug.values()) {
    if (idxs.length < 2 || !idxs.every((i) => pages[i].createdAt)) continue;
    const sorted = idxs.map((i, k) => ({ e: pages[i], k, t: Date.parse(pages[i].createdAt) }))
      .sort((a, b) => (a.t - b.t) || (a.k - b.k)).map((x) => x.e);
    idxs.forEach((i, k) => { pages[i] = sorted[k]; });
  }
}

/**
 * Parse and validate an import file. Never throws.
 * → { ok:true, bundle, raw:boolean, warnings:[] } | { ok:false, errors:[{code, page?, detail?}] }
 * Error codes: json, schema, version, pages, slug, duplicate, active, content, media, variables, size.
 * `lumen-pages/2` (several entries per slug = versions) is read too; /1 stays strict (a repeated slug is `duplicate`).
 */
export function parseBundle(text, fileName) {
  try {
    return parseBundleInner(text, fileName);
  } catch (e) {
    // Never reachable through the depth gate below; a parser or stack limit that still fires is a refusal, not a crash.
    return { ok: false, errors: [{ code: 'content', detail: 'unreadable structure' }] };
  }
}

function parseBundleInner(text, fileName) {
  const errors = [];
  const warnings = [];
  if (typeof text !== 'string' || !text.trim()) return { ok: false, errors: [{ code: 'json' }] };
  if (text.length > FILE_MAX_BYTES) return { ok: false, errors: [{ code: 'size', detail: `${Math.round(text.length / 1048576)} MB > ${FILE_MAX_BYTES / 1048576} MB` }] };
  let data;
  try { data = JSON.parse(text); } catch (e) { return { ok: false, errors: [{ code: 'json', detail: String(e && e.message || e) }] }; }
  if (!isObj(data)) return { ok: false, errors: [{ code: 'schema' }] };
  // The deepest legitimate file: entry (3 levels) + a block at its own cap. Anything deeper is hostile or damaged,
  // and refused before any recursive walk or clone could run out of stack.
  if (depthOf(data, MAX_BLOCK_DEPTH + 8) > MAX_BLOCK_DEPTH + 8) return { ok: false, errors: [{ code: 'content', detail: 'too deeply nested' }] };

  // A raw page document, as config/pages/<slug>.json is served.
  let raw = false;
  if (data.$schema === undefined && data.pages === undefined && (contentBlock(data.published) || contentBlock(data.draft))) {
    raw = true;
    data = { $schema: SCHEMA, pages: [{ slug: slugFromFileName(fileName), title: data.title, published: data.published, draft: data.draft, schemaVersion: data.schemaVersion }], media: [], variables: {} };
  }
  if (typeof data.$schema !== 'string' || !/^lumen-pages\/\d+$/.test(data.$schema)) return { ok: false, errors: [{ code: 'schema' }] };
  if (!SUPPORTED_SCHEMAS.includes(data.$schema)) return { ok: false, errors: [{ code: 'version', detail: data.$schema }] };
  const v2 = data.$schema === SCHEMA_V2;
  if (!Array.isArray(data.pages) || !data.pages.length || data.pages.length > (v2 ? MAX_ENTRIES_V2 : MAX_PAGES)) return { ok: false, errors: [{ code: 'pages' }] };
  // Versions of one page share a slug: the cap on pages counts distinct slugs, in /2 as in /1.
  if (v2 && new Set(data.pages.map((p) => (isObj(p) && typeof p.slug === 'string' ? p.slug : ''))).size > MAX_PAGES) return { ok: false, errors: [{ code: 'pages' }] };

  const pages = [];
  const seen = new Set();
  const activeSeen = new Set();
  data.pages.forEach((p, i) => {
    if (!isObj(p)) { errors.push({ code: 'pages', page: i }); return; }
    const slug = typeof p.slug === 'string' ? p.slug : '';
    // A raw file whose name gives no slug still imports: the operator types it.
    if (!(raw && slug === '') && !SLUG_RX.test(slug)) { errors.push({ code: 'slug', page: i, detail: slug }); return; }
    if (slug && seen.has(slug) && !v2) { errors.push({ code: 'duplicate', page: i, detail: slug }); return; }
    if (slug) seen.add(slug);
    const pub = p.published === undefined || p.published === null ? null : contentBlock(p.published);
    const draft = p.draft === undefined || p.draft === null ? null : contentBlock(p.draft);
    if ((p.published != null && !pub) || (p.draft != null && !draft) || (!pub && !draft)) { errors.push({ code: 'content', page: i, detail: slug }); return; }
    for (const [key, b] of [['published', pub], ['draft', draft]]) {
      const err = b ? checkContent(b, key) : null;
      if (err) { errors.push({ code: err === 'too large' ? 'size' : 'content', page: i, detail: `${slug}: ${err}` }); return; }
    }
    if (localizedTooBig(p.title) || (isObj(p.nav) && localizedTooBig(p.nav.label))) { errors.push({ code: 'content', page: i, detail: `${slug}: title too long` }); return; }
    const entry = { slug, title: localizedOrEmpty(p.title) };
    if (p.title !== undefined && p.title !== null && !isLocalized(p.title) && !(Array.isArray(p.title) && !p.title.length)) warnings.push({ code: 'title', page: i, detail: slug });
    if (isObj(p.nav) && !isBuiltinSlug(slug)) entry.nav = { label: localizedOrEmpty(p.nav.label), show: p.nav.show !== false };
    if (pub) entry.published = pub;
    if (draft) entry.draft = draft;
    if (Number.isInteger(p.schemaVersion) && p.schemaVersion > 0) entry.schemaVersion = p.schemaVersion;
    // The name, note, date and active flag of a version travel in /1 files too (an older reader ignores them):
    // a single version exported by itself must come back under its own name.
    const label = cleanText(p.label, LABEL_MAX, false);
    const note = cleanText(p.note, NOTE_MAX, true);
    if (label) entry.label = label;
    if (note) entry.note = note;
    if (isIsoDate(p.createdAt)) entry.createdAt = p.createdAt;
    if (p.active === true) {
      if (slug && activeSeen.has(slug)) { errors.push({ code: 'active', page: i, detail: slug }); return; }
      if (slug) activeSeen.add(slug);
      entry.active = true;
    }
    const total = jsonBytes({ title: entry.title, nav: entry.nav, published: pub, draft });
    if (total > VERSION_MAX_BYTES) { errors.push({ code: 'size', page: i, detail: `${slug}: ${Math.round(total / 1048576)} MB > ${VERSION_MAX_BYTES / 1048576} MB` }); return; }
    pages.push(entry);
  });
  if (v2) orderVersions(pages);

  const media = [];
  if (data.media !== undefined && data.media !== null) {
    if (!Array.isArray(data.media) || data.media.length > MAX_MEDIA) errors.push({ code: 'media' });
    else {
      const names = new Set();
      data.media.forEach((m, i) => {
        if (!isObj(m) || typeof m.name !== 'string' || !MEDIA_NAME_RX.test(m.name) || typeof m.data !== 'string') { errors.push({ code: 'media', detail: isObj(m) ? String(m.name || i) : String(i) }); return; }
        if (names.has(m.name)) { errors.push({ code: 'media', detail: m.name }); return; }
        const b64 = m.data.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) { errors.push({ code: 'media', detail: m.name }); return; }
        const size = base64Bytes(b64);
        if (!size || size > MEDIA_MAX_BYTES) { errors.push({ code: 'media', detail: m.name }); return; }
        const head = b64Head(b64, 12);
        if (head && !magicType(head)) { errors.push({ code: 'media', detail: m.name }); return; }
        names.add(m.name);
        media.push({ name: m.name, type: mediaType(m.name), data: b64, size });
      });
    }
  }

  const variables = {};
  if (data.variables !== undefined && data.variables !== null) {
    if (!isObj(data.variables)) errors.push({ code: 'variables' });
    else {
      for (const [k, v] of Object.entries(data.variables)) {
        if (!VAR_NAME_RX.test(k) || !isLocalized(v)) { errors.push({ code: 'variables', detail: k }); continue; }
        variables[k] = clone(v);
      }
    }
  }

  // Images the pages reference but the file does not carry: they keep pointing at
  // config/uploads/<name>, which exists only if this instance already has the file.
  const carried = new Set(media.map((m) => m.name));
  const missingMedia = collectMediaRefs(pages).filter((n) => !carried.has(n));
  if (missingMedia.length) warnings.push({ code: 'mediaMissing', detail: missingMedia.join(', ') });

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    raw,
    warnings,
    bundle: {
      $schema: data.$schema,
      exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : '',
      platform: typeof data.platform === 'string' ? data.platform : '',
      source: typeof data.source === 'string' ? data.source : '',
      pages, media, variables,
    },
  };
}

/**
 * The import plan: one row per page of the bundle, its target slug and what the
 * import does to it. `existing` = slugs this instance already has (built-in
 * pages always exist). Targets may be edited by the operator, then re-planned.
 * → [{ index, source, target, builtin, exists, error }]   error: 'slug' | 'duplicate' | null
 */
export function planImport(bundle, existing, targets) {
  const have = new Set([...BUILTIN_SLUGS, ...(existing || [])]);
  const rows = bundle.pages.map((p, i) => {
    const target = (targets && typeof targets[i] === 'string') ? targets[i].trim().toLowerCase() : p.slug;
    return { index: i, source: p.slug, target, builtin: isBuiltinSlug(target), exists: have.has(target), error: SLUG_RX.test(target) ? null : 'slug' };
  });
  const count = new Map();
  rows.forEach((r) => count.set(r.target, (count.get(r.target) || 0) + 1));
  rows.forEach((r) => { if (!r.error && count.get(r.target) > 1) r.error = 'duplicate'; });
  return rows;
}

/**
 * The media to write and the renames they need, given what the library holds.
 * `library` = Map name → { sameBytes:boolean } for the bundle's names that the
 * instance already has. An identical file is reused; a different one under the
 * same name is uploaded (the server picks name-1, name-2…) and the pages follow
 * the name the server answers. → { reuse:[name], upload:[media] }
 */
export function planMedia(bundle, library) {
  const reuse = [];
  const upload = [];
  for (const m of bundle.media) {
    const have = library instanceof Map ? library.get(m.name) : null;
    if (have && have.sameBytes) reuse.push(m.name);
    else upload.push(m);
  }
  return { reuse, upload };
}

/** Variables to add to instance.variables: the absent ones; a different value already set is kept and reported. */
export function planVariables(bundle, current) {
  const add = {};
  const conflicts = [];
  const cur = isObj(current) ? current : {};
  for (const [k, v] of Object.entries(bundle.variables || {})) {
    if (!Object.prototype.hasOwnProperty.call(cur, k)) add[k] = clone(v);
    else if (JSON.stringify(cur[k]) !== JSON.stringify(v)) conflicts.push(k);
  }
  return { add, conflicts };
}

/**
 * The writes of one page, in order, for the existing api/site.php actions:
 *   publish → save_draft(published) + publish [+ save_draft(draft) when the file has a different draft]
 *   draft   → save_draft(draft ?? published)   (the page's published version is left as it is)
 * `content` blocks already carry the renamed media references.
 */
export function pageWrites(page, { publish }) {
  const title = isObj(page.title) && Object.keys(page.title).length ? page.title : null;
  const withTitle = (draft) => (title ? { draft, title } : { draft });
  if (publish) {
    const pub = page.published || page.draft;
    const steps = [{ action: 'save_draft', body: withTitle(pub) }, { action: 'publish' }];
    if (page.published && page.draft) steps.push({ action: 'save_draft', body: { draft: page.draft } });
    return steps;
  }
  return [{ action: 'save_draft', body: withTitle(page.draft || page.published) }];
}

// ── Export file name ────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * The host part of an export file name: lower-case, no leading "www.", no port, only
 * [a-z0-9.-]; an IPv6 literal becomes ipv6-<groups>; "site" when nothing usable is left.
 */
export function fileHost(host) {
  let h = String(host == null ? '' : host).trim().toLowerCase();
  let v6 = false;
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    h = end === -1 ? h.slice(1) : h.slice(1, end);
    v6 = true;
  } else if ((h.match(/:/g) || []).length > 1) {
    v6 = true;
  } else {
    h = h.replace(/:\d*$/, '');
  }
  if (v6) h = 'ipv6-' + h.replace(/%.*$/, '').split(':').filter(Boolean).join('-');
  else h = h.replace(/^www\./, '');
  h = h.replace(/[^a-z0-9.-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60).replace(/^[-.]+|[-.]+$/g, '');
  return h || 'site';
}

/**
 * <host>_<pages>_<ddMMyyHHmm>.json — the local date of `now`, zero padded, no separators.
 * `slugs`: one page = its slug (also when all its versions travel); several = joined
 * with "+" up to 40 characters, else "<n>-pages". `now` is injectable (tests).
 */
export function exportFileName({ host, slugs, now } = {}) {
  const uniq = [];
  for (const s of (Array.isArray(slugs) ? slugs : [])) {
    const c = String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9_-]+/g, '');
    if (c && !uniq.includes(c)) uniq.push(c);
  }
  let pages;
  if (!uniq.length) pages = 'pages';
  else if (uniq.length === 1) pages = uniq[0];
  else { const joined = uniq.join('+'); pages = joined.length <= 40 ? joined : `${uniq.length}-pages`; }
  const d = (now instanceof Date && !Number.isNaN(now.getTime())) ? now : new Date();
  const stamp = pad2(d.getDate()) + pad2(d.getMonth() + 1) + pad2(d.getFullYear() % 100) + pad2(d.getHours()) + pad2(d.getMinutes());
  return `${fileHost(host)}_${pages}_${stamp}.json`;
}

// ── Compatibility with this site ────────────────────────────────────────────

const SEMVER_RX = /^v?(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?(?:[-+][0-9A-Za-z.+-]*)?$/;

/** "1.86.0" → [1, 86, 0]; "1.86" → [1, 86, 0]; "v1.86.0-beta" → [1, 86, 0]; anything else → null. */
export function parseSemver(v) {
  if (typeof v !== 'string') return null;
  const m = SEMVER_RX.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
}

/** −1 / 0 / 1 comparing two platform versions numerically, null when either is not a version. */
export function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** Widget types used by one content block (sections → columns → widgets, legacy blocks, nested). Iterative: the file may nest as deep as it likes. */
function collectWidgetTypes(b, out) {
  const stack = [];
  const push = (list) => { if (Array.isArray(list)) for (let i = list.length - 1; i >= 0; i--) stack.push(list[i]); };
  if (Array.isArray(b)) push(b);
  else if (isObj(b)) {
    push(b.blocks);
    for (const s of (Array.isArray(b.sections) ? b.sections : [])) {
      if (!isObj(s)) continue;
      for (const c of (Array.isArray(s.columns) ? s.columns : [])) if (isObj(c)) push(c.widgets);
    }
  }
  while (stack.length) {
    const w = stack.pop();
    if (!isObj(w)) continue;
    if (typeof w.type === 'string' && w.type) out.add(w.type);
    for (const k of ['widgets', 'children', 'blocks']) push(w[k]);
  }
}

/**
 * Can this site take this bundle? `bundle` = a parsed bundle or the raw JSON object.
 * `site` = { platform:"1.86.0", widgetTypes: Iterable<string>, maxPageSchema: 2,
 *            variables?: {name:…} | Iterable<string>, tokens?: Iterable<string> }.
 * → { ok, blockers, warnings, pages } — items { code, page?, slug?, detail }:
 *   schemaNewer {found,max}                     blocker, whole file
 *   platformNewer {exported,site}               blocker, whole file
 *   siteUnknown {site}                          blocker, whole file (this site's own version is unreadable: nothing can be compared)
 *   widgetUnknown string[]                      blocker, that page
 *   pageSchemaNewer {found,max}                 blocker, that page
 *   platformUnknown string                      warning (the raw value, '' when absent)
 *   platformOlder {exported,site}               warning (file older than the site's major.minor)
 *   tokenUndefined string[]                     warning, that page
 * pages[i] = { index, slug, ok, issues } — ok = no blocker of that page (a whole-file
 * blocker is in `blockers` without `page`), issues = every code raised for it.
 */
export function checkCompatibility(bundle, site) {
  try {
    return checkCompatibilityInner(bundle, site);
  } catch (e) {
    return { ok: false, blockers: [{ code: 'unreadable', detail: '' }], warnings: [], pages: [] };
  }
}

function checkCompatibilityInner(bundle, site) {
  const b = isObj(bundle) ? bundle : {};
  const s = isObj(site) ? site : {};
  const blockers = [];
  const warnings = [];
  const entries = Array.isArray(b.pages) ? b.pages : [];

  const sm = typeof b.$schema === 'string' ? /^lumen-pages\/(\d+)$/.exec(b.$schema) : null;
  if (sm && Number(sm[1]) > MAX_SCHEMA) blockers.push({ code: 'schemaNewer', detail: { found: Number(sm[1]), max: MAX_SCHEMA } });

  const exported = typeof b.platform === 'string' ? b.platform.trim() : '';
  const cmp = compareSemver(exported, s.platform);
  // Fail closed: a site that cannot say which platform it runs cannot tell that a file is too recent for it.
  if (!parseSemver(s.platform)) blockers.push({ code: 'siteUnknown', detail: { site: typeof s.platform === 'string' ? s.platform : '' } });
  if (!parseSemver(exported)) warnings.push({ code: 'platformUnknown', detail: exported });
  else if (cmp === 1) blockers.push({ code: 'platformNewer', detail: { exported, site: String(s.platform) } });
  else if (cmp !== null) {
    const f = parseSemver(exported);
    const t = parseSemver(s.platform);
    if (f[0] < t[0] || (f[0] === t[0] && f[1] < t[1])) warnings.push({ code: 'platformOlder', detail: { exported, site: String(s.platform) } });
  }

  const known = s.widgetTypes == null ? null : new Set(s.widgetTypes);
  const maxPage = Number.isFinite(s.maxPageSchema) ? s.maxPageSchema : null;
  let siteVars = null;
  if (s.variables != null || s.tokens != null) {
    siteVars = new Set(s.tokens || []);
    const v = s.variables;
    if (isObj(v)) Object.keys(v).forEach((k) => siteVars.add(k));
    else if (v != null) for (const k of v) siteVars.add(k);
  }
  const bundleVars = isObj(b.variables) ? b.variables : {};

  const pages = entries.map((p, index) => {
    const slug = isObj(p) && typeof p.slug === 'string' ? p.slug : '';
    const issues = [];
    const raise = (list, code, detail) => { list.push({ code, page: index, slug, detail }); if (!issues.includes(code)) issues.push(code); };
    let ok = true;
    if (isObj(p)) {
      if (known) {
        const types = new Set();
        collectWidgetTypes(p.published, types);
        collectWidgetTypes(p.draft, types);
        collectWidgetTypes(p.blocks, types);
        const unknown = [...types].filter((t) => !known.has(t)).sort();
        if (unknown.length) { raise(blockers, 'widgetUnknown', unknown); ok = false; }
      }
      if (maxPage !== null && Number.isFinite(p.schemaVersion) && p.schemaVersion > maxPage) {
        raise(blockers, 'pageSchemaNewer', { found: p.schemaVersion, max: maxPage });
        ok = false;
      }
      const tokens = collectTokens([p.title, p.nav, p.published, p.draft, p.blocks])
        .filter((t) => !Object.prototype.hasOwnProperty.call(bundleVars, t) && !(siteVars && siteVars.has(t))).sort();
      if (tokens.length) raise(warnings, 'tokenUndefined', tokens);
    }
    return { index, slug, ok, issues };
  });

  return { ok: blockers.length === 0, blockers, warnings, pages };
}
