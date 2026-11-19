// Admin tab "Page import / export" (js/pages/admin/tab-pages-io.js + pages-io-api.js), run against
// the REAL modules with a small DOM model and an in-memory twin of api/site.php,
// api/page-versions.php, api/media.php and api/admin.php?action=version.
// Locks:
//   1. the page cards: order, status chip, collapsed until opened, versions newest first, deleted pages;
//   2. activate (publish / draft, safety snapshot, editor takeover), the controls of a card are off while
//      its request runs and a second request is refused, rename, delete (the active one is refused);
//   3. the import: verification report, newer platform / unknown widget refused, default = new version
//      (live page untouched), replace = confirm + safety snapshot, menu row of a new page, result summary;
//   4. export: file name <host>_<pages>_<ddMMyyHHmm>.json, one version / all versions (lumen-pages/2) / dialog;
//   5. strings that come from files stay inert (labels, notes, page names, file names: never markup);
//   6. a failed request is told in a translated sentence (never the server's words) and the list is read again;
//   7. wiring: nav item + panel + registration, the launcher buttons, normalizePageContent, locale parity.
//
// Run: node tests/js/test_pages_io_tab.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolveObjectURL } from 'node:buffer';
import { contentSignature } from '../../js/pages/admin/pages-versions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const clone = (v) => JSON.parse(JSON.stringify(v));

// Nothing here may keep the process alive (toast timers, the editor channel).
{
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => { const t = realSetTimeout(fn, ms, ...a); if (t && t.unref) t.unref(); return t; };
}

// ── A DOM model: the surface the tab and shared.js touch ────────────────────
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const unescapeHtml = (s) => s.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m]);
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const VOID = new Set(['img', 'input', 'br', 'hr', 'meta', 'link']);

class TextNode {
  constructor(t) { this.nodeType = 3; this.data = String(t); this.parentNode = null; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
}

class El {
  constructor(doc, tag) {
    this.ownerDocument = doc; this.nodeType = 1; this.tagName = String(tag).toUpperCase();
    this.childNodes = []; this.parentNode = null; this.attrs = new Map(); this.dataset = {}; this.handlers = {};
    this._classes = new Set(); this._value = ''; this.checked = false; this.disabled = false; this.hidden = false;
    this.files = null; this.style = {};
  }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get value() {
    if (this.tagName === 'OPTION') return this.attrs.has('value') ? this.attrs.get('value') : this.textContent;
    if (this.tagName !== 'SELECT') return this._value;
    const opts = this.all().filter((n) => n.tagName === 'OPTION');
    const picked = opts.find((o) => o.attrs.has('selected')) || opts[0];
    return picked ? (picked.attrs.get('value') ?? picked.textContent) : '';
  }
  set value(v) {
    if (this.tagName === 'OPTION') { this.attrs.set('value', String(v)); return; }
    if (this.tagName !== 'SELECT') { this._value = String(v); return; }
    this.all().filter((n) => n.tagName === 'OPTION').forEach((o) => { if ((o.attrs.get('value') ?? o.textContent) === String(v)) o.attrs.set('selected', ''); else o.attrs.delete('selected'); });
  }
  get id() { return this.attrs.get('id') || ''; }
  set id(v) { this.attrs.set('id', String(v)); }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() {
    const s = this._classes;
    return { add: (...c) => c.forEach((x) => s.add(x)), remove: (...c) => c.forEach((x) => s.delete(x)), contains: (c) => s.has(c), toggle: (c, on) => { const w = on === undefined ? !s.has(c) : on; if (w) s.add(c); else s.delete(c); return w; } };
  }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) {
    this.childNodes.forEach((n) => { n.parentNode = null; });
    this.childNodes = [];
    if (v !== '' && v != null) this.appendChild(new TextNode(v));
  }
  set innerHTML(html) {
    this.textContent = '';
    this.ownerDocument.innerHTMLWrites.push(String(html));
    const stack = [this];
    const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g;
    let m;
    while ((m = re.exec(String(html)))) {
      const top = stack[stack.length - 1];
      if (m[4] !== undefined) { top.appendChild(new TextNode(unescapeHtml(m[4]))); continue; }
      const tag = m[2].toLowerCase();
      if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
      const e = this.ownerDocument.createElement(tag);
      for (const a of m[3].matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) e.setAttribute(a[1], a[2] === undefined ? '' : unescapeHtml(a[2]));
      top.appendChild(e);
      if (!VOID.has(tag) && !/\/\s*$/.test(m[3])) stack.push(e);
    }
  }
  get innerHTML() { return ''; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument.body; }
  setAttribute(k, v) {
    if (k === 'class') { this.className = v; return; }
    this.attrs.set(k, String(v));
    if (k.startsWith('data-')) this.dataset[camel(k.slice(5))] = String(v);
    if (k === 'hidden') this.hidden = true;
  }
  getAttribute(k) { if (k === 'class') return this.className; return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  removeChild(c) { this.childNodes = this.childNodes.filter((n) => n !== c); c.parentNode = null; return c; }
  replaceChild(next, old) { const i = this.childNodes.indexOf(old); if (next.parentNode) next.parentNode.removeChild(next); this.childNodes[i] = next; next.parentNode = this; old.parentNode = null; return old; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  addEventListener(t, fn) { (this.handlers[t] ||= []).push(fn); }
  removeEventListener(t, fn) { this.handlers[t] = (this.handlers[t] || []).filter((f) => f !== fn); }
  focus() { if (!this.disabled) this.ownerDocument.activeElement = this; }
  scrollIntoView() {}
  click() { this.dispatch('click'); }
  dispatch(type, ev = {}) {
    if (type === 'click' && this.disabled) return null;
    const e = Object.assign({ type, target: this, currentTarget: null, defaultPrevented: false, _stop: false }, ev);
    e.preventDefault = () => { e.defaultPrevented = true; };
    e.stopPropagation = () => { e._stop = true; };
    for (let n = this; n && !e._stop; n = n.parentNode) {
      e.currentTarget = n;
      for (const fn of [...((n.handlers || {})[type] || [])]) fn(e);
    }
    if (!e._stop && this.isConnected) this.ownerDocument.deliver(type, e);
    if (this.tagName === 'A' && type === 'click' && this.download) this.ownerDocument.downloads.push({ name: this.download, href: this.href });
    return e;
  }
  matches(sel) {
    const parts = sel.match(/[.#]?[\w-]+|\[[^\]]+\]/g) || [];
    return parts.every((p) => {
      if (p[0] === '.') return this._classes.has(p.slice(1));
      if (p[0] === '#') return this.id === p.slice(1);
      if (p[0] === '[') {
        const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(p);
        const has = this.attrs.has(m[1]) || (m[1].startsWith('data-') && camel(m[1].slice(5)) in this.dataset);
        if (m[2] === undefined) return has;
        const val = this.attrs.has(m[1]) ? this.attrs.get(m[1]) : this.dataset[camel(m[1].slice(5))];
        return has && val === m[2];
      }
      return this.tagName === p.toUpperCase();
    });
  }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  querySelectorAll(sel) {
    const chains = sel.split(',').map((s) => s.trim().split(/\s+/));
    const hit = (n, chain) => {
      if (!n.matches(chain[chain.length - 1])) return false;
      let i = chain.length - 2;
      for (let p = n.parentNode; p && p !== this.parentNode && i >= 0; p = p.parentNode) if (p.matches && p.matches(chain[i])) i--;
      return i < 0;
    };
    return this.all().filter((n) => chains.some((c) => hit(n, c)));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

class Doc {
  constructor() {
    this.listeners = {}; this.activeElement = null; this.innerHTMLWrites = []; this.downloads = [];
    this.body = new El(this, 'body');
  }
  createElement(tag) { return new El(this, tag); }
  createTextNode(t) { return new TextNode(t); }
  getElementById(id) { return this.body.all().find((n) => n.id === id) || null; }
  querySelector(sel) { return this.body.querySelector(sel); }
  querySelectorAll(sel) { return this.body.querySelectorAll(sel); }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
  deliver(type, e) { for (const fn of [...(this.listeners[type] || [])]) fn(e); }
  fire(type, ev = {}) { const e = Object.assign({ type, target: this.body, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} }, ev); this.deliver(type, e); return e; }
}

// ── The server: an in-memory twin of what the tab talks to ──────────────────
const sec = (text) => ({ sections: [{ id: 's-' + text, props: {}, columns: [{ id: 'c1', width: 12, props: {}, widgets: [{ id: 'w1', type: 'heading', text: { en: text }, props: {} }] }] }] });
const widgetOf = (type) => ({ sections: [{ id: 's1', props: {}, columns: [{ id: 'c1', width: 12, props: {}, widgets: [{ id: 'w1', type, props: {} }] }] }] });
const b64 = (buf) => Buffer.from(buf).toString('base64');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

function makeServer(seed = {}) {
  const S = {
    instance: clone(seed.instance || { nav: { customPages: [] }, variables: {} }),
    pages: new Map(Object.entries(clone(seed.pages || {}))),
    hist: new Map(),                    // slug → { active, versions: [full oldest first] }
    media: new Map(Object.entries(seed.media || {})),
    platform: seed.platform === undefined ? '1.86.0' : seed.platform,
    log: [], inflight: 0, holds: new Map(), fail: new Map(), counter: 0, clock: Date.parse('2026-11-19T10:00:00Z'),
  };
  const now = () => new Date(S.clock += 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  const nextId = () => `v${(++S.counter).toString(16).padStart(12, '0')}`;
  const isEmpty = (d) => !d || !((d.published && (d.published.sections || []).length) || (d.draft && (d.draft.sections || []).length));
  const widgets = (b) => (b && b.sections ? b.sections.reduce((n, s) => n + s.columns.reduce((m, c) => m + c.widgets.length, 0), 0) : 0);
  const locales = (c) => { const out = new Set(); JSON.stringify([c.published, c.draft], (k, v) => { if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length && Object.keys(v).every((x) => /^[a-z]{2}$/.test(x) && typeof v[x] === 'string')) Object.keys(v).forEach((x) => out.add(x)); return v; }); return [...out].sort(); };
  const meta = (v, active) => ({
    id: v.id, label: v.label, note: v.note, origin: v.origin, createdAt: v.createdAt, updatedAt: v.updatedAt,
    exportedAt: v.exportedAt || '', source: v.source || '', platform: v.platform || '', widgets: widgets(v.content.published || v.content.draft),
    bytes: JSON.stringify(v.content).length, locales: locales(v.content), hasPublished: !!v.content.published, hasDraft: !!v.content.draft,
    title: v.content.title || {}, isActive: v.id === active,
  });
  S.addVersion = (slug, over) => {
    const h = S.hist.get(slug) || { active: null, versions: [] };
    const v = Object.assign({ id: nextId(), label: 'Version', note: '', origin: 'capture', createdAt: now(), updatedAt: '', content: { published: sec('x') } }, over);
    v.updatedAt = v.createdAt;
    h.versions.push(v);
    if (over && over.active) h.active = v.id;
    S.hist.set(slug, h);
    return v;
  };
  const liveFor = (slug) => S.pages.get(slug) || {};
  const applyLive = (slug, v, mode) => {
    const c = v.content;
    const cur = S.pages.get(slug) || { title: {}, published: { sections: [] } };
    const pub = c.published || c.draft;
    const draft = c.draft || c.published;
    const title = c.title && Object.keys(c.title).length ? c.title : (cur.title || {});
    if (mode === 'draft') S.pages.set(slug, Object.assign({}, cur, { title, draft: clone(draft) }));
    else S.pages.set(slug, { title, published: clone(pub), draft: clone(draft), schemaVersion: 2 });
  };
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const err = (status, code) => json({ error: code }, status);

  async function versions(u, body) {
    const action = u.searchParams.get('action');
    const slug = u.searchParams.get('slug');
    const id = u.searchParams.get('id');
    const hold = S.holds.get(action);
    if (hold) await hold.promise;
    const f = S.fail.get(action);
    if (f) return err(f.status, f.code);
    if (action === 'list') {
      const pages = {};
      for (const [s, h] of S.hist) {
        if (slug && s !== slug) continue;
        if (!h.versions.length) continue;
        pages[s] = { active: h.active, count: h.versions.length, versions: h.versions.slice().reverse().map((v) => meta(v, h.active)) };
      }
      return json({ schema: 'lumen-page-versions/1', limits: { maxVersions: 50, maxBytes: 33554432 }, pages });
    }
    const h = S.hist.get(slug);
    const find = () => (h ? h.versions.find((v) => v.id === id) : null);
    if (action === 'get') { const v = find(); return v ? json({ ok: true, version: Object.assign(meta(v, h.active), { content: clone(v.content) }) }) : err(404, 'not_found'); }
    if (action === 'add') {
      if (!['import', 'capture', 'auto', 'manual'].includes(body.origin)) return err(400, 'invalid_origin');
      const c = body.content;
      if (!c || !(c.published || c.draft)) return err(400, 'invalid_content');
      const hist = S.hist.get(slug) || { active: null, versions: [] };
      if (hist.versions.length >= 50) return err(409, 'too_many_versions');
      const v = S.addVersion(slug, { label: (body.label || 'Version').trim() || 'Version', note: body.note || '', origin: body.origin, content: clone(c), exportedAt: body.exportedAt, source: body.source, platform: body.platform });
      const out = { ok: true, id: v.id };
      if (body.activate) { const snap = activate(slug, v.id, body.activate, body.snapshotLabel); if (snap) out.snapshotId = snap; }
      out.version = meta(v, S.hist.get(slug).active);
      return json(out);
    }
    if (action === 'update') {
      const v = find();
      if (!v) return err(404, 'not_found');
      if (body.fromLive) {
        const live = liveFor(slug);
        v.content = Object.assign({}, v.content, { title: live.title, published: clone(live.published), draft: clone(live.draft) });
      }
      if (body.label !== undefined) v.label = String(body.label).trim() || 'Version';
      if (body.note !== undefined) v.note = String(body.note);
      v.updatedAt = now();
      return json({ ok: true, version: meta(v, h.active) });
    }
    if (action === 'activate') {
      if (!find()) return err(404, 'not_found');
      const snap = activate(slug, id, body.mode || 'publish', body.snapshotLabel);
      const out = { ok: true, rev: 'r1', active: S.hist.get(slug).active };
      if (snap) out.snapshotId = snap;
      return json(out);
    }
    if (action === 'delete') {
      const v = find();
      if (!v) return err(404, 'not_found');
      if (h.active === id) return err(409, 'active_version');
      h.versions = h.versions.filter((x) => x.id !== id);
      if (!h.versions.length) S.hist.delete(slug);
      return json({ ok: true, active: h.active });
    }
    if (action === 'purge') { S.hist.delete(slug); return json({ ok: true }); }
    return err(400, 'Unknown action');
  }
  function activate(slug, id, mode, snapshotLabel) {
    const h = S.hist.get(slug);
    const v = h.versions.find((x) => x.id === id);
    let snap = null;
    const live = liveFor(slug);
    if (!isEmpty(live)) {
      const sig = contentSignature(live);
      if (!h.versions.some((x) => contentSignature(x.content) === sig)) {
        const s = S.addVersion(slug, { label: snapshotLabel || 'Before activation', origin: 'auto', content: { title: live.title, published: clone(live.published), draft: clone(live.draft) } });
        snap = s.id;
      }
    }
    applyLive(slug, v, mode);
    if (mode === 'publish') h.active = id;
    return snap;
  }

  async function handle(url, init = {}) {
    const u = new URL(url, 'http://host/');
    const body = init.body ? JSON.parse(init.body) : null;
    const action = u.searchParams.get('action');
    S.log.push(`${init.method || 'GET'} ${u.pathname.replace(/^\//, '')}?${[...u.searchParams].map(([k, v]) => `${k}=${v}`).join('&')}${body ? ' ' + JSON.stringify(body) : ''}`);
    if (u.pathname.startsWith('/config/uploads/')) {
      const f = S.media.get(decodeURIComponent(u.pathname.slice('/config/uploads/'.length)));
      return f ? new Response(f, { status: 200, headers: { 'Content-Type': 'image/png' } }) : new Response('', { status: 404 });
    }
    if (u.pathname === '/api/admin.php' && action === 'version') return S.platform === null ? err(500, 'internal_error') : json({ ok: true, web: S.platform });
    if (u.pathname === '/api/page-versions.php') return versions(u, body);
    if (u.pathname === '/api/media.php') {
      if (action === 'list') return json({ files: [...S.media.keys()].map((name) => ({ name })) });
      if (action === 'upload') {
        let name = body.filename, i = 1;
        while (S.media.has(name)) name = body.filename.replace(/(\.\w+)$/, `-${i++}$1`);
        S.media.set(name, Buffer.from(body.data, 'base64'));
        return json({ ok: true, url: 'config/uploads/' + name });
      }
    }
    if (u.pathname === '/api/site.php') {
      const doc = u.searchParams.get('doc') || '';
      if (action === 'get' && doc === 'instance') return json(S.instance);
      if (action === 'get' && doc.startsWith('pages/')) return json(liveFor(doc.slice(6)));
      if (action === 'save' && doc === 'instance') {
        for (const p of (u.searchParams.get('merge') || '').split(',').filter(Boolean)) {
          const segs = p.split('.');
          let src = body, node = S.instance;
          for (const s of segs) src = src == null ? undefined : src[s];
          for (const s of segs.slice(0, -1)) node = node[s] = node[s] || {};
          node[segs[segs.length - 1]] = src;
        }
        return json({ ok: true });
      }
    }
    return err(404, 'unexpected ' + u.pathname);
  }
  S.fetch = async (url, init) => {
    S.inflight++;
    try { return await handle(url, init); } finally { S.inflight--; }
  };
  S.hold = (action) => { let release; const promise = new Promise((r) => { release = r; }); S.holds.set(action, { promise }); return () => { S.holds.delete(action); release(); }; };
  S.requests = (needle) => S.log.filter((l) => l.includes(needle));
  return S;
}

// ── A fresh page + tab instance per scenario ────────────────────────────────
const tick = () => new Promise((r) => setImmediate(r));
let moduleSeq = 0;
const realNormalizer = await loadNormalizer();

async function boot(seed) {
  const doc = new Doc();
  globalThis.document = doc;
  const root = doc.createElement('div');
  root.setAttribute('id', 'pages-io-root');
  doc.body.appendChild(root);
  for (const id of ['toast-container', 'toast-status', 'toast-alert']) { const n = doc.createElement('div'); n.setAttribute('id', id); doc.body.appendChild(n); }
  const server = makeServer(seed);
  globalThis.fetch = server.fetch;
  const env = { doc, server, opened: [], posts: [], confirms: [], prompts: [], confirmAnswer: true, promptAnswer: 'My label' };
  globalThis.window = {
    addEventListener() {}, removeEventListener() {},
    open: (url) => { const w = { url, location: { href: '' }, closed: false, close() { this.closed = true; } }; env.opened.push(w); return w; },
  };
  globalThis.location = { hostname: 'bemine.be', host: 'bemine.be', href: 'http://bemine.be/admpan.html' };
  globalThis.confirm = (m) => { env.confirms.push(m); return env.confirmAnswer; };
  globalThis.prompt = (m, d) => { env.prompts.push([m, d]); return env.promptAnswer; };
  globalThis.BroadcastChannel = class { constructor(n) { this.name = n; } postMessage(m) { env.posts.push(m); } close() {} };
  globalThis.PageRenderer = { WIDGET_TYPES: ['heading', 'richtext', 'image', 'hero', 'button', 'gallery', 'html'] };
  globalThis.PageVars = { tokens: () => ({ brand: 'B', year: '2026', date: 'x', time: 'y' }) };
  globalThis.URL.createObjectURL = globalThis.URL.createObjectURL || (() => 'blob:x');
  const mod = await import(`${pathToFileURL(path.join(ROOT, 'js/pages/admin/tab-pages-io.js')).href}?n=${++moduleSeq}`);
  mod.hooks.loadNormalizer = async () => realNormalizer;
  env.mod = mod;
  env.tab = mod.PagesIoTab;
  env.root = root;
  env.idle = async () => { let quiet = 0; for (let i = 0; i < 400 && quiet < 4; i++) { await tick(); quiet = server.inflight === 0 ? quiet + 1 : 0; } };
  env.q = (sel, from = root) => from.querySelector(sel);
  env.qa = (sel, from = root) => from.querySelectorAll(sel);
  env.card = (slug) => root.querySelectorAll('.pio-card').find((c) => c.dataset.slug === slug) || null;
  env.key = (scope, key) => scope.querySelectorAll('[data-key]').find((n) => n.dataset.key === key) || null;
  env.names = () => root.querySelectorAll('.pio-card').map((c) => c.dataset.slug);
  env.toasts = () => [...doc.getElementById('toast-status').children, ...doc.getElementById('toast-alert').children].map((n) => n.textContent);
  env.toastAlerts = () => doc.getElementById('toast-alert').children.map((n) => n.textContent);
  env.start = async () => { env.tab.mount(); env.tab.activate(); await env.idle(); };
  env.open = async (slug) => { const c = env.card(slug); env.key(c, 'toggle').click(); await env.idle(); return env.card(slug); };
  env.download = async (n = 0) => {
    const d = doc.downloads[n];
    const blob = resolveObjectURL(d.href);
    return { name: d.name, json: JSON.parse(await blob.text()) };
  };
  return env;
}

function mkFile(name, content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return { name, size: text.length, text: async () => text };
}
const dropFile = (env, file) => env.q('#pio-drop').dispatch('drop', { dataTransfer: { files: [file] } });

// What the page editor's sanitising does with content (the real function, read from tab-pages.js).
async function loadNormalizer() {
  const src = read('js/pages/admin/tab-pages.js').replace(/^import\s[^;]*;/gm, '').replace(/^export\s+(function|const|let|class)/gm, '$1');
  const sandbox = {
    console, JSON, Math, Number, Array, Object, String, Boolean, Date, Promise, Map, Set, URL, Error, RegExp, setTimeout, clearTimeout,
    encodeURIComponent, parseInt, parseFloat, isNaN, Infinity, API_SITE: 'api/site.php', I18n: null, Utils: null,
    t: (_k, d) => d ?? '', escHtml: (v) => String(v ?? ''), apiFetch: async () => null, apiFetchStatus: async () => ({ ok: false }),
    toast() {}, el: () => null, refreshIcons() {}, setUnsaved() {}, registerDirtyGuard() {}, navigateTo() {},
    renderFields() {}, renderGroups() {}, renderTranslatePanel() {}, renderVariablesPanel() {},
    document: { querySelector: () => ({}), createElement: () => ({ style: {} }), getElementById: () => null },
    window: { addEventListener() {}, open: () => null }, location: { origin: 'http://h', search: '' },
    navigator: { onLine: true }, history: { replaceState() {} }, confirm: () => true, BroadcastChannel: undefined,
    InstanceConfig: undefined, PageTemplates: undefined, PageBackground: undefined, PageRenderer: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${src}\n;globalThis.__N = normalizePageContent;`, sandbox, { filename: 'tab-pages.js' });
  return sandbox.__N;
}

const bundleOf = (pages, extra) => Object.assign({ $schema: 'lumen-pages/1', exportedAt: '2026-11-18T09:00:00.000Z', platform: '1.85.0', source: 'lab.be', pages, media: [], variables: {} }, extra || {});
const entry = (slug, block, extra) => Object.assign({ slug, title: {}, published: block }, extra || {});
const textOf = (n) => n.textContent.replace(/\s+/g, ' ').trim();

// ── 1. The cards ────────────────────────────────────────────────────────────
{
  const env = await boot({
    instance: { nav: { customPages: [{ slug: 'news', label: { en: 'News' }, show: true }] }, variables: {} },
    pages: { about: { title: { en: 'About' }, published: sec('B2'), draft: sec('B2') }, news: { title: { en: 'News' }, published: sec('N') } },
  });
  const s = env.server;
  const v1 = s.addVersion('about', { label: 'Spring redesign', origin: 'import', platform: '1.85.0', source: 'lab.be', note: 'From the lab', content: { title: { en: 'About' }, published: sec('B1') } });
  const v2 = s.addVersion('about', { label: 'Plain', origin: 'capture', active: true, content: { title: { en: 'About' }, published: sec('B2') } });
  s.addVersion('old', { label: 'Removed page', origin: 'capture', active: true, content: { title: { en: 'Old news' }, published: sec('O') } });
  await env.start();

  assert.deepEqual(env.names(), ['home', 'about', 'news', 'old'], 'built-in pages, menu pages, then pages that only exist as a history');
  assert.equal(textOf(env.q('#pio-site')), 'This site: v1.86.0');
  const chip = (slug) => textOf(env.q('.pio-chip', env.card(slug)));
  assert.equal(chip('about'), 'In sync with “Plain”');
  assert.equal(chip('home'), 'Default page — nothing stored');
  assert.equal(chip('news'), 'Not versioned');
  assert.equal(chip('old'), 'Deleted page — restorable');
  assert.ok(env.card('old').classList.contains('is-deleted'));

  const about = env.card('about');
  assert.equal(env.key(about, 'toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(env.q('.pio-card-body', about).hidden, true, 'closed: the body is hidden');
  assert.equal(env.qa('.pio-row', about).length, 0, 'closed: the version rows are not even built');
  const countAfterLoad = s.requests('action=get&slug=about').length;
  assert.equal(countAfterLoad, 1, 'only the active version is read at load');

  await env.open('about');
  assert.equal(env.key(env.card('about'), 'toggle').getAttribute('aria-expanded'), 'true');
  const rows = env.qa('.pio-row', env.card('about'));
  assert.deepEqual(rows.map((r) => textOf(env.q('.pio-label', r))), ['Plain', 'Spring redesign'], 'newest first');
  assert.ok(rows[0].classList.contains('is-active') && rows[0].classList.contains('is-live'), 'the active version equals the live page');
  assert.match(textOf(rows[0]), /active/);
  assert.match(textOf(rows[0]), /on the site/);
  assert.ok(!rows[1].classList.contains('is-live'), 'the other version is not the live one (read in the background)');
  assert.match(textOf(rows[1]), /imported/);
  assert.match(textOf(rows[1]), /From the lab/);
  assert.match(textOf(rows[1]), /v1\.85\.0/);
  assert.equal(env.key(rows[0], `row:${v2.id}:activate`).getAttribute('aria-label'), 'Activate: Plain', 'every icon button names its version');
  assert.ok(env.key(rows[1], `row:${v1.id}:more`).getAttribute('aria-haspopup') === 'menu');

  // The deleted page offers Restore and no "save current state".
  const old = await env.open('old');
  assert.ok(env.key(old, 'restore'), 'restore button');
  assert.equal(env.key(old, 'capture'), null);
  env.tab.relabel();
  assert.deepEqual(env.names(), ['home', 'about', 'news', 'old'], 'relabel redraws the same cards');
}

// ── 2. Activate, busy, rename, delete ───────────────────────────────────────
{
  const env = await boot({ instance: { nav: { customPages: [] }, variables: {} }, pages: { about: { title: { en: 'About' }, published: sec('B2'), draft: sec('B2') } } });
  const s = env.server;
  const v1 = s.addVersion('about', { label: 'First', origin: 'import', content: { title: { en: 'About' }, published: sec('B1') } });
  const v2 = s.addVersion('about', { label: 'Second', origin: 'capture', active: true, content: { title: { en: 'About' }, published: sec('B2') } });
  await env.start();
  await env.open('about');
  const act = (id, what) => env.key(env.card('about'), `row:${id}:${what}`);

  // Activate v1: the live page is the active version, so no safety snapshot is needed.
  act(v1.id, 'activate').focus();
  act(v1.id, 'activate').click();
  await env.idle();
  assert.ok(s.requests('page-versions.php?action=activate&slug=about&id=' + v1.id).length === 1);
  assert.match(s.requests('action=activate')[0], /"mode":"publish"/);
  assert.deepEqual(env.posts.filter((p) => p.t === 'takeover').map((p) => p.slug), ['about'], 'an editor open on the page is told to stop autosaving');
  assert.equal(s.pages.get('about').published.sections[0].id, 's-B1', 'v1 is live now');
  assert.equal(s.hist.get('about').active, v1.id);
  assert.equal(s.hist.get('about').versions.length, 2, 'nothing new to keep: the old live state was version 2');
  const rows = env.qa('.pio-row', env.card('about'));
  assert.ok(rows.find((r) => r.dataset.id === v1.id).classList.contains('is-active'));
  assert.ok(env.toasts().some((t) => t.includes('“First” is now live.')));
  assert.equal(env.doc.activeElement && env.doc.activeElement.dataset.key, `row:${v1.id}:activate`, 'focus goes back to the control that was used');
  assert.equal(env.card('about').getAttribute('aria-busy'), 'false');

  // The live page drifts (editor edit): "modified since", then activating keeps the drifted state as a version.
  s.pages.set('about', { title: { en: 'About' }, published: sec('B3'), draft: sec('B3'), schemaVersion: 2 });
  await env.tab.activate(); await env.idle();
  assert.equal(textOf(env.q('.pio-chip', env.card('about'))), 'Modified since “First”');
  act(v2.id, 'activate').click();
  await env.idle();
  const auto = s.hist.get('about').versions.find((v) => v.origin === 'auto');
  assert.ok(auto && auto.label === 'Before activation', 'the drifted live page was kept before being replaced');
  assert.ok(env.toasts().some((t) => t.includes('previous state was kept')));
  assert.equal(s.pages.get('about').published.sections[0].id, 's-B2');

  // Activate as a draft: the menu item, published block untouched.
  s.pages.set('about', { title: { en: 'About' }, published: sec('PUB'), draft: sec('PUB'), schemaVersion: 2 });
  act(v1.id, 'more').click();
  await env.idle();
  assert.equal(act(v1.id, 'more').getAttribute('aria-expanded'), 'true');
  act(v1.id, 'activate-draft').click();
  await env.idle();
  assert.match(s.requests('action=activate').at(-1), /"mode":"draft"/);
  assert.equal(s.pages.get('about').published.sections[0].id, 's-PUB', 'draft mode never touches what visitors see');
  assert.equal(s.pages.get('about').draft.sections[0].id, 's-B1');
  assert.equal(env.q('.pio-menu', env.card('about')), null, 'the menu closed');

  // Busy: the controls of the card are off while its request runs and a second request is refused.
  const release = s.hold('activate');
  act(v1.id, 'activate').click();
  await tick(); await tick();
  const card = env.card('about');
  assert.equal(card.getAttribute('aria-busy'), 'true');
  assert.ok(env.qa('.pio-icon-btn', card).every((b) => b.disabled), 'every icon button is disabled meanwhile');
  assert.ok(env.qa('.adm-btn', card).every((b) => b.disabled), 'and the page actions too');
  const before = s.requests('action=activate').length;
  act(v2.id, 'activate').handlers.click[0]({});     // a script (or a key repeat) reaching the handler anyway
  await tick(); await tick();
  assert.equal(s.requests('action=activate').length, before, 'a second request is not sent while one is in flight');
  release();
  await env.idle();
  assert.equal(env.card('about').getAttribute('aria-busy'), 'false');
  assert.ok(env.qa('.pio-icon-btn', env.card('about')).every((b) => !b.disabled), 'controls are back');

  // Rename inline.
  act(v1.id, 'rename').click();
  const field = env.key(env.card('about'), 'edit-label');
  assert.equal(field.value, 'First');
  field.value = 'Renamed <b>x</b>';
  field.dispatch('keydown', { key: 'Enter' });
  await env.idle();
  assert.match(s.requests('action=update').at(-1), /"label":"Renamed <b>x<\/b>"/);
  assert.equal(s.hist.get('about').versions.find((v) => v.id === v1.id).label, 'Renamed <b>x</b>');
  assert.ok(env.qa('.pio-label', env.card('about')).some((n) => n.textContent === 'Renamed <b>x</b>'), 'shown as text');
  assert.equal(env.doc.activeElement && env.doc.activeElement.dataset.key, `row:${v1.id}:rename`, 'focus returns to Rename');
  // Empty name and Escape send nothing.
  const updates = s.requests('action=update').length;
  act(v1.id, 'rename').click();
  env.key(env.card('about'), 'edit-label').value = '   ';
  env.key(env.card('about'), 'edit-label').dispatch('keydown', { key: 'Enter' });
  await env.idle();
  act(v1.id, 'rename').click();
  env.key(env.card('about'), 'edit-label').dispatch('keydown', { key: 'Escape' });
  await env.idle();
  assert.equal(s.requests('action=update').length, updates, 'an empty name or Escape changes nothing');
  assert.equal(env.key(env.card('about'), 'edit-label'), null);

  // Edit the note.
  act(v1.id, 'more').click(); await env.idle();
  act(v1.id, 'note').click();
  const note = env.key(env.card('about'), 'edit-note');
  note.value = 'line 1\nline 2';
  env.key(env.card('about'), 'edit-note-save').click();
  await env.idle();
  assert.equal(s.hist.get('about').versions.find((v) => v.id === v1.id).note, 'line 1\nline 2');

  // Delete: the active one is refused without a request; another one is confirmed first.
  const activeId = s.hist.get('about').active;
  act(activeId, 'more').click(); await env.idle();
  const deletes = s.requests('action=delete').length;
  act(activeId, 'delete').click(); await env.idle();
  assert.equal(s.requests('action=delete').length, deletes, 'the active version is never sent for deletion');
  assert.ok(env.toastAlerts().length === 0 && env.toasts().some((t) => t.includes('This is the active version')), 'and the operator is told why');
  const victim = s.hist.get('about').versions.find((v) => v.id !== activeId && v.origin !== 'auto');
  act(victim.id, 'more').click(); await env.idle();
  env.confirmAnswer = false;
  act(victim.id, 'delete').click(); await env.idle();
  assert.equal(s.requests('action=delete').length, deletes, 'declined');
  assert.ok(env.confirms.at(-1).includes('cannot be undone'));
  act(victim.id, 'more').click(); await env.idle();
  env.confirmAnswer = true;
  act(victim.id, 'delete').click(); await env.idle();
  assert.equal(s.requests('action=delete').length, deletes + 1);
  assert.ok(!s.hist.get('about').versions.some((v) => v.id === victim.id));
  assert.ok(!env.qa('.pio-row', env.card('about')).some((r) => r.dataset.id === victim.id), 'the row is gone');

  // Duplicate and update from the live page.
  const dup = s.hist.get('about').versions.length;
  act(activeId, 'more').click(); await env.idle();
  act(activeId, 'duplicate').click(); await env.idle();
  assert.equal(s.hist.get('about').versions.length, dup + 1);
  const copy = s.hist.get('about').versions.at(-1);
  assert.ok(copy.origin === 'manual' && copy.label.endsWith('(copy)'));
  act(copy.id, 'more').click(); await env.idle();
  act(copy.id, 'from-live').click(); await env.idle();
  assert.match(s.requests('action=update').at(-1), /"fromLive":true/);

  // Delete the history.
  env.key(env.card('about'), 'purge').click(); await env.idle();
  assert.equal(s.hist.has('about'), false);
  assert.equal(textOf(env.q('.pio-chip', env.card('about'))), 'Not versioned');
  assert.equal(env.qa('.pio-row', env.card('about')).length, 0);
}

// ── 3. Capture, restore, edit in the editor ────────────────────────────────
{
  const env = await boot({ instance: { nav: { customPages: [{ slug: 'news', label: { en: 'News' }, show: true }] }, variables: {} }, pages: { news: { title: { en: 'News' }, published: sec('N'), draft: sec('N2') } } });
  const s = env.server;
  s.addVersion('gone', { label: 'Lost page', origin: 'capture', active: true, content: { title: { en: 'Gone' }, nav: { label: { en: 'Gone' }, show: true }, published: sec('G') } });
  await env.start();
  const news = await env.open('news');
  env.promptAnswer = 'Before the move';
  env.key(news, 'capture').click(); await env.idle();
  const add = s.requests('action=add').at(-1);
  assert.match(add, /"origin":"capture"/);
  assert.match(add, /"label":"Before the move"/);
  const saved = s.hist.get('news').versions[0];
  assert.deepEqual(saved.content.published, sec('N'));
  assert.deepEqual(saved.content.draft, sec('N2'), 'the draft travels with the state');
  assert.deepEqual(saved.content.nav, { label: { en: 'News' }, show: true });
  assert.ok(env.card('news').classList.contains('is-open'));
  // Saving again an unchanged state adds nothing.
  s.hist.get('news').active = saved.id;
  await env.tab.activate(); await env.idle();
  const adds = s.requests('action=add').length;
  env.key(env.card('news'), 'capture').click(); await env.idle();
  assert.equal(s.requests('action=add').length, adds, 'already saved: no duplicate version');
  assert.ok(env.toasts().some((t) => t.includes('already saved as “Before the move”')));

  // Edit a version in the page editor: draft mode, then a tab on admpan.html?editor=news.
  env.opened.length = 0;
  const row = env.qa('.pio-row', env.card('news'))[0];
  env.key(row, `row:${saved.id}:edit`).click();
  assert.equal(env.opened.length, 1, 'the tab is opened inside the click');
  await env.idle();
  assert.match(s.requests('action=activate').at(-1), /"mode":"draft"/);
  assert.equal(env.opened[0].location.href, 'admpan.html?editor=news');
  assert.equal(env.opened[0].closed, false);

  // A failure closes the blank tab instead of leaving it.
  s.fail.set('activate', { status: 500, code: 'write_failed' });
  env.opened.length = 0;
  env.key(env.qa('.pio-row', env.card('news'))[0], `row:${saved.id}:edit`).click();
  await env.idle();
  assert.equal(env.opened[0].closed, true);
  assert.equal(env.opened[0].location.href, '');
  s.fail.clear();

  // Restore a deleted page: published again, and its menu row comes back.
  const gone = await env.open('gone');
  env.key(gone, 'restore').click(); await env.idle();
  assert.equal(s.pages.get('gone').published.sections[0].id, 's-G');
  assert.deepEqual(s.instance.nav.customPages.find((n) => n.slug === 'gone'), { slug: 'gone', label: { en: 'Gone' }, show: true });
  assert.equal(env.card('gone').classList.contains('is-deleted'), false, 'no longer a deleted page');
  assert.equal(textOf(env.q('.pio-chip', env.card('gone'))), 'In sync with “Lost page”');
}

// ── 4. Import ───────────────────────────────────────────────────────────────
const OK_PLATFORM = '1.85.0';
{
  const env = await boot({
    instance: { nav: { customPages: [] }, variables: { year: 'mine' } },
    pages: { about: { title: { en: 'About' }, published: sec('LIVE'), draft: sec('LIVE'), schemaVersion: 2 } },
    media: { 'logo.png': PNG },
  });
  const s = env.server;
  await env.start();
  const img = { sections: [{ id: 's9', props: {}, columns: [{ id: 'c9', width: 12, props: {}, widgets: [{ id: 'w9', type: 'image', props: { src: 'config/uploads/team.png' } }, { id: 'w8', type: 'heading', text: { en: '{lab} {year}' }, props: {} }] }] }] };
  const file = bundleOf([
    entry('about', sec('IMPORTED'), { title: { en: 'About us' } }),
    entry('team', img, { title: { en: 'Team' }, nav: { label: { en: 'Our team' }, show: true } }),
  ], { media: [{ name: 'team.png', type: 'image/png', data: b64(PNG) }], variables: { lab: 'IRIBHM', year: 'theirs' } });
  dropFile(env, mkFile('bemine.be_about_1811261000.json', file));
  await env.idle();

  const report = env.qa('.pio-check').map((li) => ({ level: ['ok', 'warn', 'error'].find((c) => li.classList.contains('is-' + c)), text: textOf(li) }));
  assert.ok(report.length >= 9, 'every check is listed, not only the problems');
  assert.ok(report.every((r) => r.level), 'each line is ok / warn / error');
  assert.ok(report.some((r) => r.level === 'ok' && /valid page export: 2 page\(s\), 2 version\(s\)/.test(r.text)));
  assert.ok(report.some((r) => r.level === 'ok' && /Format lumen-pages\/1: supported/.test(r.text)));
  assert.ok(report.some((r) => r.level === 'ok' && /platform v1\.85\.0, older than this site \(v1\.86\.0\): compatible/.test(r.text)));
  assert.ok(report.some((r) => r.level === 'ok' && /Every widget used by the pages exists on this site/.test(r.text)));
  assert.ok(report.some((r) => r.level === 'ok' && /1 image\(s\) in the file/.test(r.text)));
  assert.ok(report.some((r) => r.level === 'warn' && /already defined on this site.*year/.test(r.text)), 'a variable with another value is reported');
  assert.ok(report.some((r) => r.level === 'ok' && /These pages already exist: about.*live pages are not touched/.test(r.text)), 'an existing page is only added to');
  assert.ok(!report.some((r) => r.level === 'error'));
  assert.ok(env.q('.pio-verdict').classList.contains('is-warn'));
  assert.ok(env.qa('.pio-check .pio-mark').every((m) => m.getAttribute('aria-hidden') === 'true') && env.qa('.pio-check .adm-sr-only').length === report.length, 'a symbol is never the only signal');
  assert.equal(env.doc.activeElement.dataset.key, 'imp-head', 'focus lands on the import panel');

  // Defaults: the existing page gets a new version (live untouched), the new page is created.
  const selects = env.qa('select', env.q('#pio-import'));
  assert.deepEqual(selects.map((x) => x.value), ['version', 'create']);
  assert.equal(s.requests('action=add').length, 0, 'nothing is written before the operator confirms');
  const go = env.q('#pio-go');
  assert.equal(go.disabled, false);
  go.click();
  await env.idle();
  assert.equal(env.confirms.length, 0, 'no replace: no confirmation');
  const adds = s.requests('page-versions.php?action=add');
  assert.equal(adds.length, 2);
  assert.match(adds[0], /slug=about/);
  assert.match(adds[0], /"origin":"import"/);
  assert.ok(!/"activate"/.test(adds[0]), 'a plain version does not activate');
  assert.match(adds[1], /slug=team/);
  assert.match(adds[1], /"activate":"publish"/);
  assert.match(adds[1], /"platform":"1\.85\.0"/);
  assert.equal(s.pages.get('about').published.sections[0].id, 's-LIVE', 'the live page was not touched');
  assert.equal(s.hist.get('about').versions.length, 1);
  assert.equal(s.hist.get('about').versions[0].label, 'lab.be · 2026-11-18', 'default label: <source> · <date>');
  assert.equal(s.pages.get('team').published.sections[0].columns[0].widgets[0].props.src, 'config/uploads/team.png');
  assert.ok(s.media.has('team.png'), 'the image reached the library');
  assert.deepEqual(s.instance.nav.customPages, [{ slug: 'team', label: { en: 'Our team' }, show: true }], 'menu row of the new page');
  assert.equal(s.instance.variables.lab, 'IRIBHM');
  assert.equal(s.instance.variables.year, 'mine', 'a variable already set is kept');
  assert.deepEqual(env.posts.filter((p) => p.t === 'takeover').map((p) => p.slug).sort(), ['about', 'team']);
  const result = textOf(env.q('#pio-result'));
  assert.match(result, /was added to the history of about/);
  assert.match(result, /The page team was created/);
  assert.equal(env.doc.activeElement.id, 'pio-result');
  assert.ok(env.names().includes('team'), 'the new page is listed');
  assert.equal(env.q('#pio-go'), null, 'a finished import cannot be run twice');

  // Close the panel: the import button gets the focus back.
  env.key(env.q('#pio-import'), 'imp-close').click();
  assert.equal(env.q('#pio-import').children.length, 0);
  assert.equal(env.doc.activeElement.id, 'pio-import-btn');
}

{
  // Replace: confirm lists the pages, the live state is kept as an automatic version, then the new one is live.
  const env = await boot({ instance: { nav: { customPages: [] }, variables: {} }, pages: { about: { title: { en: 'About' }, published: sec('LIVE'), draft: sec('LIVE'), schemaVersion: 2 } } });
  const s = env.server;
  await env.start();
  dropFile(env, mkFile('about.json', bundleOf([entry('about', sec('NEW'), { title: { en: 'About' } })])));
  await env.idle();
  const select = env.qa('select', env.q('#pio-import'))[0];
  select.value = 'replace';
  select.dispatch('change');
  await env.idle();
  assert.ok(env.qa('.pio-check').some((li) => li.classList.contains('is-warn') && /will be replaced: about/.test(li.textContent)));
  env.confirmAnswer = false;
  env.q('#pio-go').click();
  await env.idle();
  assert.equal(env.confirms.length, 1);
  assert.match(env.confirms[0], /replaced: about.*kept in their history/);
  assert.equal(s.requests('action=add').length, 0, 'declined: nothing written');
  assert.equal(s.pages.get('about').published.sections[0].id, 's-LIVE');
  env.confirmAnswer = true;
  env.q('#pio-go').click();
  await env.idle();
  assert.match(s.requests('action=add')[0], /"activate":"publish"/);
  assert.equal(s.pages.get('about').published.sections[0].id, 's-NEW', 'the imported version is live');
  const versions = s.hist.get('about').versions;
  assert.deepEqual(versions.map((v) => v.origin).sort(), ['auto', 'import'], 'the replaced state was kept');
  const kept = versions.find((v) => v.origin === 'auto');
  assert.equal(kept.label, 'Before import');
  assert.equal(kept.content.published.sections[0].id, 's-LIVE', 'and it holds what was live');
  assert.match(textOf(env.q('#pio-result')), /is now live on about; the previous state was kept in its history/);
}

{
  // As a draft: the published block stays.
  const env = await boot({ instance: { nav: { customPages: [] }, variables: {} }, pages: { about: { title: { en: 'About' }, published: sec('LIVE'), draft: sec('LIVE'), schemaVersion: 2 } } });
  const s = env.server;
  await env.start();
  dropFile(env, mkFile('about.json', bundleOf([entry('about', sec('NEW'))])));
  await env.idle();
  const select = env.qa('select', env.q('#pio-import'))[0];
  select.value = 'replace'; select.dispatch('change');
  const radio = env.qa('input', env.q('#pio-import')).find((i) => i.value === 'draft');
  radio.checked = true; radio.dispatch('change');
  await env.idle();
  env.q('#pio-go').click(); await env.idle();
  assert.match(s.requests('action=add')[0], /"activate":"draft"/);
  assert.equal(s.pages.get('about').published.sections[0].id, 's-LIVE', 'draft mode leaves what visitors see');
  assert.equal(s.pages.get('about').draft.sections[0].id, 's-NEW');
}

{
  // A file made by a newer platform is refused before anything is written.
  const env = await boot({ instance: { nav: { customPages: [] }, variables: {} }, pages: {} });
  const s = env.server;
  await env.start();
  dropFile(env, mkFile('newer.json', bundleOf([entry('about', sec('X'))], { platform: '1.90.0' })));
  await env.idle();
  const errs = env.qa('.pio-check.is-error');
  assert.equal(errs.length, 1);
  assert.match(textOf(errs[0]), /platform v1\.90\.0; this site runs v1\.86\.0.*update this site first/);
  assert.ok(env.q('.pio-verdict').classList.contains('is-error'));
  assert.match(textOf(env.q('.pio-verdict')), /cannot be imported/);
  assert.equal(env.q('#pio-go'), null, 'no import button');
  assert.equal(env.qa('.pio-imp-row').length, 0, 'no rows to pick');
  assert.equal(s.requests('action=add').length, 0);

  // Newer format, unreadable file, not a page export, other extension.
  dropFile(env, mkFile('f3.json', bundleOf([entry('about', sec('X'))], { $schema: 'lumen-pages/3' })));
  await env.idle();
  assert.match(textOf(env.q('#pio-import')), /Format lumen-pages\/3 is unknown to this platform version: update it/);
  dropFile(env, mkFile('bad.json', '{not json'));
  await env.idle();
  const bad = textOf(env.q('#pio-import'));
  assert.match(bad, /not readable JSON/);
  assert.ok(!/Unexpected|JSON\.parse|position \d/.test(bad), 'the parser\'s own message is never shown');
  dropFile(env, mkFile('notes.txt', 'hello'));
  await env.idle();
  assert.equal(env.qa('.pio-check.is-error').length, 1);
  assert.equal(s.requests('action=add').length, 0);
}

{
  // An unknown widget blocks its page only; the others still import.
  const env = await boot({ instance: { nav: { customPages: [] }, variables: {} }, pages: {} });
  const s = env.server;
  await env.start();
  dropFile(env, mkFile('mix.json', bundleOf([entry('fancy', widgetOf('hologram')), entry('plain', sec('P'))])));
  await env.idle();
  const errs = env.qa('.pio-check.is-error');
  assert.equal(errs.length, 1);
  assert.match(textOf(errs[0]), /“fancy” uses widgets this site does not have: hologram/);
  const rows = env.qa('.pio-imp-row');
  assert.equal(rows.length, 2);
  assert.ok(rows[0].classList.contains('is-blocked') && env.qa('input', rows[0]).every((i) => i.disabled), 'the blocked row cannot be selected');
  assert.match(textOf(rows[0]), /Unknown widgets on this site: hologram/);
  assert.equal(env.q('#pio-go').disabled, false, 'the other page can still go');
  assert.match(textOf(env.q('#pio-go')), /Import 1 version/);
  env.q('#pio-go').click(); await env.idle();
  assert.deepEqual([...s.hist.keys()], ['plain']);
  assert.ok(!s.pages.has('fancy'));
}

{
  // A /2 file: several versions of one page, each becomes a version, the flagged one goes live.
  const env = await boot({ instance: { nav: { customPages: [] }, variables: {} }, pages: {} });
  const s = env.server;
  await env.start();
  const v = (label, at, text, extra) => entry('story', sec(text), Object.assign({ label, createdAt: at, note: 'n-' + label }, extra || {}));
  dropFile(env, mkFile('hist.json', bundleOf([v('Third', '2026-03-01T00:00:00Z', 'three'), v('First', '2026-01-01T00:00:00Z', 'one', { active: true }), v('Second', '2026-02-01T00:00:00Z', 'two')], { $schema: 'lumen-pages/2' })));
  await env.idle();
  const selects = env.qa('select', env.q('#pio-import'));
  assert.deepEqual(selects.map((x) => x.value), ['create', 'version', 'version'], 'oldest first; the flagged entry creates the page');
  assert.match(textOf(env.q('#pio-import')), /3 versions/);
  env.q('#pio-go').click(); await env.idle();
  const h = s.hist.get('story');
  assert.deepEqual(h.versions.map((x) => x.label), ['First', 'Second', 'Third']);
  assert.deepEqual(h.versions.map((x) => x.note), ['n-First', 'n-Second', 'n-Third']);
  assert.equal(h.active, h.versions[0].id, 'the version flagged active in the file is the active one');
  assert.equal(s.pages.get('story').published.sections[0].id, 's-one');
}

{
  // The history limit and a bad / doubled target are explained and block the import.
  const env = await boot({ instance: { nav: { customPages: [{ slug: 'news', label: { en: 'News' }, show: true }] }, variables: {} }, pages: { news: { title: {}, published: sec('N') } } });
  await env.start();
  for (let i = 0; i < 50; i++) env.server.addVersion('news', { label: 'v' + i, content: { published: sec('n' + i) } });
  env.server.hist.get('news').active = env.server.hist.get('news').versions[0].id;
  dropFile(env, mkFile('n.json', bundleOf([entry('news', sec('Z'))])));
  await env.idle();
  assert.match(textOf(env.q('#pio-import')), /history of “news” would exceed 50 versions/);
  assert.equal(env.q('#pio-go').disabled, true);
  const target = env.qa('input', env.q('#pio-import')).find((i) => i.dataset.key === 'imp:0:target');
  target.value = 'Bad Slug!'; target.dispatch('change');
  await env.idle();
  assert.match(textOf(env.q('#pio-import')), /“bad slug!” is not a valid page identifier/);
  assert.equal(env.q('#pio-go').disabled, true);
  const t2 = env.qa('input', env.q('#pio-import')).find((i) => i.dataset.key === 'imp:0:target');
  t2.value = 'fresh'; t2.dispatch('change');
  await env.idle();
  assert.equal(env.q('#pio-go').disabled, false, 'another target frees it');
  assert.equal(env.qa('select', env.q('#pio-import'))[0].value, 'create');
}

// ── 5. Export ───────────────────────────────────────────────────────────────
const stampRe = (d) => String(d.getDate()).padStart(2, '0') + String(d.getMonth() + 1).padStart(2, '0') + String(d.getFullYear() % 100).padStart(2, '0') + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
{
  const env = await boot({
    instance: { nav: { customPages: [{ slug: 'news', label: { en: 'News' }, show: true }] }, variables: { lab: 'IRIBHM' } },
    pages: {
      about: { title: { en: 'About' }, published: sec('LIVE {lab}'), draft: sec('LIVE {lab}'), schemaVersion: 2 },
      news: { title: { en: 'News' }, published: sec('N'), schemaVersion: 2 },
    },
  });
  const s = env.server;
  const v1 = s.addVersion('about', { label: 'Old', origin: 'import', platform: '1.85.0', content: { title: { en: 'About' }, published: sec('OLD') } });
  const v2 = s.addVersion('about', { label: 'Spring', origin: 'capture', note: 'kept', content: { title: { en: 'About' }, published: sec('SPRING') }, active: true });
  await env.start();
  const t0 = new Date();
  // One version of the page.
  await env.open('about');
  env.key(env.card('about'), `row:${v1.id}:export`).click(); await env.idle();
  const t1 = new Date();
  let dl = await env.download(0);
  assert.match(dl.name, /^bemine\.be_about_\d{10}\.json$/);
  assert.ok([stampRe(t0), stampRe(t1)].some((st) => dl.name === `bemine.be_about_${st}.json`), 'ddMMyyHHmm in local time');
  assert.equal(dl.json.$schema, 'lumen-pages/1', 'one version is a plain /1 file');
  assert.equal(dl.json.pages.length, 1);
  assert.equal(dl.json.pages[0].label, 'Old');
  assert.equal(dl.json.platform, '1.86.0');
  assert.equal(dl.json.source, 'bemine.be');

  // The live page.
  env.key(env.card('about'), 'export-live').click(); await env.idle();
  dl = await env.download(1);
  assert.equal(dl.json.pages.length, 1);
  assert.equal(dl.json.pages[0].published.sections[0].id, 's-LIVE {lab}');
  assert.deepEqual(dl.json.variables, { lab: 'IRIBHM' }, 'the variables the page uses travel with it');

  // All the versions: /2, oldest first, the live page (not saved anywhere) appended and flagged.
  env.key(env.card('about'), 'export-all').click(); await env.idle();
  dl = await env.download(2);
  assert.equal(dl.json.$schema, 'lumen-pages/2');
  assert.deepEqual(dl.json.pages.map((p) => p.label), ['Old', 'Spring', 'Current state']);
  assert.deepEqual(dl.json.pages.map((p) => !!p.active), [false, false, true]);
  assert.equal(dl.json.pages[1].note, 'kept');
  assert.ok(dl.json.pages.every((p) => p.slug === 'about' && p.createdAt));
  assert.match(dl.name, /^bemine\.be_about_\d{10}\.json$/, 'a page with all its versions is still named after its slug');

  // The dialog: two pages, with history.
  env.q('#pio-export-btn').click();
  const dlg = env.doc.querySelector('.pio-modal');
  assert.ok(dlg, 'the export dialog opened');
  assert.equal(dlg.getAttribute('aria-modal'), 'true');
  assert.ok(dlg.getAttribute('aria-labelledby'));
  assert.ok(env.doc.getElementById(dlg.getAttribute('aria-labelledby')), 'named by its title');
  assert.ok(env.root.parentNode.hasAttribute('inert') || env.doc.body.children.some((n) => n !== dlg && n.hasAttribute('inert')), 'the page behind is inert');
  const boxes = env.qa('input[data-slug]', dlg);
  assert.deepEqual(boxes.map((b) => b.dataset.slug), ['about', 'news']);
  assert.ok(boxes.every((b) => b.checked));
  env.qa('input', dlg).find((i) => i.id === 'pio-exp-history').checked = true;
  env.qa('button', dlg).find((b) => b.dataset.act === 'go').click();
  await env.idle();
  dl = await env.download(3);
  assert.ok(/^bemine\.be_about\+news_\d{10}\.json$/.test(dl.name), dl.name);
  assert.equal(dl.json.$schema, 'lumen-pages/2');
  assert.deepEqual([...new Set(dl.json.pages.map((p) => p.slug))], ['about', 'news']);
  assert.equal(env.doc.querySelector('.pio-modal'), null, 'closed after the download');
  assert.ok(env.doc.body.children.every((n) => !n.hasAttribute('inert')), 'the page is back');

  // Escape closes it; nothing selected disables Download.
  env.q('#pio-export-btn').click();
  const dlg2 = env.doc.querySelector('.pio-modal');
  const go = env.qa('button', dlg2).find((b) => b.dataset.act === 'go');
  env.qa('input[data-slug]', dlg2).forEach((b) => { b.checked = false; b.dispatch('change'); });
  assert.equal(go.disabled, true);
  env.doc.fire('keydown', { key: 'Escape' });
  assert.equal(env.doc.querySelector('.pio-modal'), null);
}

// ── 6. Strings from files are inert ─────────────────────────────────────────
{
  const EVIL = '<img src=x onerror=alert(1)>';
  const env = await boot({ instance: { nav: { customPages: [{ slug: 'news', label: { en: EVIL }, show: true }] }, variables: {} }, pages: { news: { title: { en: EVIL }, published: sec('N') } } });
  const s = env.server;
  s.addVersion('news', { label: EVIL, note: `${EVIL}\n<script>alert(2)</script>`, origin: 'import', source: EVIL, platform: '1.85.0', active: true, content: { title: { en: EVIL }, published: sec('N') } });
  await env.start();
  await env.open('news');
  const walk = (n) => [n, ...n.all()];
  const bad = (root) => walk(root).filter((n) => ['IMG', 'SCRIPT', 'IFRAME', 'SVG'].includes(n.tagName) && !n.attrs.has('data-lucide'));
  assert.deepEqual(bad(env.root), [], 'no element was created from a label, a note, a source or a menu name');
  assert.ok(env.card('news').textContent.includes(EVIL), 'the text is shown as written');
  assert.ok(!walk(env.root).some((n) => n.attrs && [...n.attrs.keys()].some((k) => /^on/i.test(k))), 'no handler attribute anywhere');
  // Importing a file whose labels, notes and name are hostile.
  dropFile(env, mkFile(`${EVIL}.json`, bundleOf([entry('news', sec('Z'), { title: { en: EVIL }, label: EVIL, note: EVIL })], { $schema: 'lumen-pages/2', source: EVIL })));
  await env.idle();
  assert.deepEqual(bad(env.root), []);
  assert.ok(env.q('#pio-import').textContent.includes(EVIL), 'file name and label are shown as text');
  env.q('#pio-go').click(); await env.idle();
  assert.deepEqual(bad(env.root), []);
  // The toasts (the one place shared.js uses markup) escape it too.
  assert.ok(env.doc.innerHTMLWrites.every((html) => !html.includes('<img')), 'nothing raw went through innerHTML');
}

// ── 7. Failures ─────────────────────────────────────────────────────────────
{
  const env = await boot({ instance: { nav: { customPages: [] }, variables: {} }, pages: { about: { title: {}, published: sec('A') } } });
  const s = env.server;
  const v1 = s.addVersion('about', { label: 'One', origin: 'capture', active: true, content: { published: sec('A') } });
  const v2 = s.addVersion('about', { label: 'Two', origin: 'capture', content: { published: sec('B') } });
  await env.start();
  await env.open('about');
  // The server fails with its own words: the operator reads a translated sentence.
  s.fail.set('activate', { status: 500, code: 'write_failed' });
  const lists = s.requests('action=list&slug=about').length;
  env.key(env.card('about'), `row:${v2.id}:activate`).click(); await env.idle();
  assert.ok(env.toastAlerts().some((t) => t === 'The server could not save the change. Check that it can write to its folders.'));
  assert.ok(!env.toastAlerts().some((t) => /write_failed/.test(t)), 'the code never reaches the DOM');
  assert.ok(s.requests('action=list&slug=about').length > lists, 'the list is read again after a failure');
  assert.equal(env.card('about').getAttribute('aria-busy'), 'false');
  assert.equal(s.pages.get('about').published.sections[0].id, 's-A');
  // Someone else deleted the version meanwhile: 404, the list refreshes and the row disappears.
  s.fail.clear();
  s.hist.get('about').versions = s.hist.get('about').versions.filter((v) => v.id !== v2.id);
  env.key(env.card('about'), `row:${v2.id}:activate`).click(); await env.idle();
  assert.ok(env.toastAlerts().some((t) => /does not exist any more/.test(t)));
  assert.ok(!env.qa('.pio-row', env.card('about')).some((r) => r.dataset.id === v2.id), 'the stale row is gone');
  // No network at all.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('NetworkError: boom internal'); };
  env.key(env.card('about'), `row:${v1.id}:activate`).click(); await env.idle();
  assert.ok(env.toastAlerts().some((t) => /cannot be reached/.test(t)));
  assert.ok(!env.toasts().some((t) => /boom internal/.test(t)));
  globalThis.fetch = realFetch;
}

{
  // The pages cannot be read: an error card with Retry, then it recovers.
  const env = await boot({ instance: { nav: { customPages: [] }, variables: {} }, pages: {} });
  const real = env.server.fetch;
  globalThis.fetch = async (u, i) => (String(u).includes('page-versions') ? new Response('boom', { status: 500 }) : real(u, i));
  await env.start();
  assert.match(textOf(env.q('#pio-list')), /could not be read/);
  assert.equal(env.qa('.pio-card').length, 0);
  globalThis.fetch = real;
  env.qa('button', env.q('#pio-list')).find((b) => b.textContent === 'Retry').click();
  await env.idle();
  assert.equal(env.qa('.pio-card').length, 2);
  // An import is refused when the site's pages cannot be listed.
  globalThis.fetch = async (u, i) => (String(u).includes('page-versions') ? new Response('boom', { status: 500 }) : real(u, i));
  dropFile(env, mkFile('x.json', bundleOf([entry('about', sec('Z'))])));
  await env.idle();
  assert.ok(env.qa('.pio-check.is-error').some((li) => /could not be read, so the import cannot be planned/.test(li.textContent)));
  assert.equal(env.q('#pio-go'), null);
  globalThis.fetch = real;
}

{
  // Site version unknown: said in the report; the file's version cannot be compared, so nothing is imported.
  const env = await boot({ instance: { nav: { customPages: [] }, variables: {} }, pages: {}, platform: null });
  await env.start();
  assert.equal(textOf(env.q('#pio-site')), 'Site version unknown');
  dropFile(env, mkFile('x.json', bundleOf([entry('about', sec('Z'))])));
  await env.idle();
  assert.ok(env.qa('.pio-check.is-error').some((li) => /version could not be read/.test(li.textContent)));
  assert.equal(env.q('#pio-go'), null);
}

// ── 7b. Review fixes ────────────────────────────────────────────────────────
{
  // A site whose own version cannot be read refuses a file that says it comes from a newer platform (it used to import with a warning).
  const env = await boot({ instance: { nav: { customPages: [] }, variables: {} }, pages: {}, platform: null });
  await env.start();
  dropFile(env, mkFile('future.json', bundleOf([entry('about', sec('Z'))], { platform: '9.0.0' })));
  await env.idle();
  assert.ok(env.qa('.pio-check.is-error').some((li) => /version could not be read/.test(li.textContent)), 'said as an error, not a warning');
  assert.ok(env.q('.pio-verdict').classList.contains('is-error'));
  assert.equal(env.q('#pio-go'), null, 'no Import button');
  assert.equal(env.server.requests('action=add').length, 0);
}

{
  // A file nested to the limit of what JSON.parse accepts: refused with a sentence, the panel never stays on "reading".
  const env = await boot({ instance: { nav: { customPages: [] }, variables: {} }, pages: {} });
  await env.start();
  const text = '{"$schema":"lumen-pages/1","pages":[{"slug":"a","published":{"sections":[],"x":' + '{"a":'.repeat(5000) + '1' + '}'.repeat(5000) + '}}]}';
  dropFile(env, mkFile('deep.json', text));
  await env.idle();
  assert.equal(env.q('.pio-status .spinner'), null, 'not stuck reading');
  assert.ok(env.qa('.pio-check.is-error').length >= 1);
  assert.equal(env.q('#pio-go'), null);
  // ... and the same when the reading itself throws.
  const bad = { name: 'x.json', size: 5, text: async () => { throw new RangeError('boom'); } };
  dropFile(env, bad);
  await env.idle();
  assert.equal(env.q('.pio-status .spinner'), null);
  assert.ok(env.qa('.pio-check.is-error').length >= 1);
}

{
  // Two files dropped one after the other: the panel never mixes the name of one with the pages of the other.
  const env = await boot({ instance: { nav: { customPages: [] }, variables: {} }, pages: {} });
  await env.start();
  const slow = (name, c) => ({ name, size: 100, text: async () => { for (let i = 0; i < 30; i++) await tick(); return JSON.stringify(c); } });
  dropFile(env, slow('big-alpha.json', bundleOf([entry('alpha', sec('A'))])));
  dropFile(env, mkFile('small-beta.json', bundleOf([entry('beta', sec('B'))])));
  for (let i = 0; i < 80; i++) await tick();
  await env.idle();
  assert.match(textOf(env.q('#pio-imp-title')), /big-alpha\.json/);
  assert.deepEqual(env.qa('.pio-imp-row', env.q('#pio-import')).map((r) => r.querySelector('input[type]').dataset.key), ['imp:0:include'], 'one row');
  assert.ok(env.qa('input', env.q('#pio-import')).some((i) => i.value === 'alpha'), 'the target is the page of the file named in the title');
  assert.ok(!env.qa('input', env.q('#pio-import')).some((i) => i.value === 'beta'));
  assert.ok(env.toasts().some((t) => /already running/.test(t)), 'the second file was told to wait');
  // Cancelling while a file is read leaves the panel closed when the read ends.
  const env2 = await boot({ instance: { nav: { customPages: [] }, variables: {} }, pages: {} });
  await env2.start();
  dropFile(env2, slow('late.json', bundleOf([entry('alpha', sec('A'))])));
  env2.key(env2.q('#pio-import'), 'imp-close').click();
  for (let i = 0; i < 80; i++) await tick();
  await env2.idle();
  assert.equal(env2.q('#pio-import').children.length, 0, 'closed stays closed');
}

{
  // An older server without api/page-versions.php: said as such, not as "could not be read" with a Retry that cannot help.
  const env = await boot({ instance: { nav: { customPages: [] }, variables: {} }, pages: {} });
  const real = env.server.fetch;
  globalThis.fetch = async (u, i) => (String(u).includes('page-versions') ? new Response('<html>Not Found</html>', { status: 404 }) : real(u, i));
  await env.start();
  assert.match(textOf(env.q('#pio-list')), /does not know page versions yet: update the platform/);
  assert.equal(env.qa('button', env.q('#pio-list')).length, 0, 'no Retry');
  dropFile(env, mkFile('x.json', bundleOf([entry('about', sec('Z'))])));
  await env.idle();
  assert.ok(env.qa('.pio-check.is-error').some((li) => /does not know page versions yet/.test(li.textContent)));
  assert.ok(!env.qa('.pio-check.is-error').some((li) => /Refresh and try again/.test(li.textContent)));
  assert.equal(env.q('#pio-go'), null);
  // The server's own "not found" for a version is NOT "unsupported".
  globalThis.fetch = real;
  const Api = await import(`${pathToFileURL(path.join(ROOT, 'js/pages/admin/pages-io-api.js')).href}`);
  const r = await Api.get('about', 'v000000000001');
  assert.equal(r.error, 'not_found');
}

{
  // A slug that is also a property of every object ("constructor") is a page like another one.
  const env = await boot({
    instance: { nav: { customPages: [{ slug: 'constructor', label: { en: 'Builder' }, show: true }] }, variables: {} },
    pages: { constructor: { title: { en: 'Builder' }, published: sec('C'), schemaVersion: 2 } },
  });
  env.server.addVersion('constructor', { label: 'Only', origin: 'capture', active: true, content: { title: { en: 'Builder' }, published: sec('C') } });
  await env.start();
  assert.deepEqual(env.names(), ['home', 'about', 'constructor'], 'the tab loads');
  assert.equal(textOf(env.q('.pio-chip', env.card('constructor'))), 'In sync with “Only”');
  assert.equal(textOf(env.q('.pio-chip', env.card('about'))), 'Default page — nothing stored', 'and a page without history is not mistaken for it');
  dropFile(env, mkFile('c.json', bundleOf([entry('constructor', sec('NEW'))])));
  await env.idle();
  assert.deepEqual(env.qa('select', env.q('#pio-import')).map((x) => x.value), ['version'], 'planned as an existing page');
  assert.ok(env.q('#pio-go') && !env.q('#pio-go').disabled);
}

{
  // In draft mode the wording says the draft is replaced, not the live page.
  const env = await boot({ instance: { nav: { customPages: [] }, variables: {} }, pages: { about: { title: { en: 'About' }, published: sec('LIVE'), draft: sec('LIVE'), schemaVersion: 2 } } });
  await env.start();
  dropFile(env, mkFile('about.json', bundleOf([entry('about', sec('NEW'))])));
  await env.idle();
  const select = env.qa('select', env.q('#pio-import'))[0];
  select.value = 'replace'; select.dispatch('change');
  await env.idle();
  const optionText = () => env.qa('option', env.qa('select', env.q('#pio-import'))[0]).map((o) => textOf(o));
  assert.ok(optionText().includes('Replace the live page (the current state is kept)'));
  const radio = env.qa('input', env.q('#pio-import')).find((i) => i.value === 'draft');
  radio.checked = true; radio.dispatch('change');
  await env.idle();
  assert.ok(optionText().includes('Replace the draft (the live page stays; the current state is kept)'), 'the option follows the mode');
  assert.ok(env.qa('.pio-check.is-warn').some((li) => /The draft of these pages will be replaced: about\. What visitors see does not change/.test(li.textContent)));
  assert.ok(!env.qa('.pio-check').some((li) => /These pages will be replaced/.test(li.textContent)));
  env.confirmAnswer = false;
  env.q('#pio-go').click(); await env.idle();
  assert.match(env.confirms[0], /^The draft of these pages will be replaced: about\. What visitors see does not change/);
}

{
  // A rename the server refuses keeps the editor open with what was typed.
  const env = await boot({ instance: { nav: { customPages: [] }, variables: {} }, pages: { about: { title: {}, published: sec('A') } } });
  const s = env.server;
  const v1 = s.addVersion('about', { label: 'One', origin: 'capture', active: true, content: { published: sec('A') } });
  await env.start();
  await env.open('about');
  env.key(env.card('about'), `row:${v1.id}:rename`).click();
  const field = () => env.key(env.card('about'), 'edit-label');
  field().value = 'Typed name';
  s.fail.set('update', { status: 500, code: 'write_failed' });
  env.key(env.card('about'), 'edit-label-save').click();
  await env.idle();
  assert.ok(env.toastAlerts().length >= 1, 'the failure is told');
  assert.ok(field(), 'the editor is still open');
  assert.equal(field().value, 'Typed name', 'with what was typed');
  s.fail.clear();
  env.key(env.card('about'), 'edit-label-save').click();
  await env.idle();
  assert.equal(field(), null, 'closed once the server took it');
  assert.equal(s.hist.get('about').versions[0].label, 'Typed name');
}

{
  // Cancel during an export: no file is saved.
  const env = await boot({ instance: { nav: { customPages: [] }, variables: {} }, pages: { about: { title: {}, published: sec('A'), schemaVersion: 2 } } });
  const s = env.server;
  s.addVersion('about', { label: 'One', origin: 'capture', active: true, content: { published: sec('A') } });
  await env.start();
  env.q('#pio-export-btn').click();
  const dlg = env.doc.querySelector('.pio-modal');
  env.qa('input', dlg).find((i) => i.id === 'pio-exp-history').checked = true;
  const release = s.hold('list');
  env.qa('button', dlg).find((b) => b.dataset.act === 'go').click();
  await tick();
  env.qa('button', dlg).find((b) => b.dataset.act === 'cancel').click();
  assert.equal(env.doc.querySelector('.pio-modal'), null, 'the dialog closed');
  release();
  await env.idle();
  await tick();
  assert.equal(env.doc.downloads.length, 0, 'nothing was saved after Cancel');
}

{
  // A page that has content but no menu row and no history is an existing page: replacing it is confirmed.
  const env = await boot({ instance: { nav: { customPages: [] }, variables: {} }, pages: { ghost: { title: { en: 'Ghost' }, published: sec('G'), draft: sec('G'), schemaVersion: 2 } } });
  const s = env.server;
  await env.start();
  assert.ok(!env.names().includes('ghost'));
  dropFile(env, mkFile('g.json', bundleOf([entry('ghost', sec('NEW'))])));
  await env.idle();
  const select = env.qa('select', env.q('#pio-import'))[0];
  assert.deepEqual(env.qa('option', select).map((o) => o.value), ['version', 'replace'], 'offered as an existing page');
  assert.ok(env.qa('.pg-xfer-tag').some((tg) => /existing page/.test(tg.textContent)));
  select.value = 'replace'; select.dispatch('change');
  await env.idle();
  env.q('#pio-go').click(); await env.idle();
  assert.equal(env.confirms.length, 1, 'the replacement is confirmed');
  assert.match(env.confirms[0], /ghost/);
  assert.ok(s.hist.get('ghost').versions.some((v) => v.origin === 'auto'), 'and the live state was kept');
  // A target typed by the operator is looked at too.
  const env2 = await boot({ instance: { nav: { customPages: [] }, variables: {} }, pages: { ghost: { title: { en: 'Ghost' }, published: sec('G'), draft: sec('G'), schemaVersion: 2 } } });
  await env2.start();
  dropFile(env2, mkFile('a.json', bundleOf([entry('about2', sec('NEW'))])));
  await env2.idle();
  assert.deepEqual(env2.qa('select', env2.q('#pio-import')).map((x) => x.value), ['create']);
  const target = env2.qa('input', env2.q('#pio-import')).find((i) => i.dataset.key === 'imp:0:target');
  target.value = 'ghost'; target.dispatch('change');
  await env2.idle();
  assert.deepEqual(env2.qa('select', env2.q('#pio-import')).map((x) => x.value), ['version'], 'renaming the import onto an existing page is seen');
}

{
  // The name and the note of a version survive its own export and import (a lone version is a /1 file).
  const env = await boot({ instance: { nav: { customPages: [] }, variables: {} }, pages: { news: { title: {}, published: sec('N'), schemaVersion: 2 } } });
  const s = env.server;
  const v = s.addVersion('news', { label: 'Spring redesign', note: 'my note', origin: 'capture', content: { published: sec('SPRING') } });
  await env.start();
  await env.open('news');
  env.key(env.card('news'), `row:${v.id}:export`).click(); await env.idle();
  const dl = await env.download(0);
  assert.equal(dl.json.$schema, 'lumen-pages/1');
  s.hist.delete('news');
  dropFile(env, mkFile(dl.name, dl.json));
  await env.idle();
  assert.match(textOf(env.q('.pio-imp-label', env.q('#pio-import'))), /Spring redesign/, 'the row carries the name of the file');
  env.q('#pio-go').click(); await env.idle();
  assert.equal(s.hist.get('news').versions[0].label, 'Spring redesign');
  assert.equal(s.hist.get('news').versions[0].note, 'my note');
}

{
  // Right after activating a version without a title, the page is "in sync" with it although its live title is another one.
  const env = await boot({ instance: { nav: { customPages: [] }, variables: {} }, pages: { about: { title: { en: 'About us' }, published: sec('A'), draft: sec('A'), schemaVersion: 2 } } });
  env.server.addVersion('about', { label: 'Plain', origin: 'capture', active: true, content: { published: sec('A') } });
  await env.start();
  assert.equal(textOf(env.q('.pio-chip', env.card('about'))), 'In sync with “Plain”');
}

// ── 8. Wiring, source rules, locales ────────────────────────────────────────
{
  const tab = read('js/pages/admin/tab-pages-io.js');
  const api = read('js/pages/admin/pages-io-api.js');
  for (const [name, src] of [['tab-pages-io.js', tab], ['pages-io-api.js', api]]) {
    assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|outerHTML|document\.write/.test(src), `${name} builds DOM nodes, never markup strings`);
    assert.ok(!/\.message\b/.test(src), `${name} never puts an error message in the DOM`);
  }
  assert.match(read('admpan.html'), /<button class="adm-nav-item" data-tab="pages-io">[\s\S]*?data-i18n="admin\.navPagesIO"/);
  assert.match(read('admpan.html'), /<section class="adm-tabpanel" id="tab-pages-io" data-tab="pages-io">\s*<div class="adm-tab-inner" id="pages-io-root">/);
  const html = read('admpan.html');
  assert.ok(html.indexOf('data-tab="pages-io"') > html.indexOf('data-tab="pages"') && html.indexOf('data-tab="pages-io"') < html.indexOf('data-tab="legal"'), 'right after Pages, in the public-site group');
  assert.match(read('js/pages/admpan.js'), /registerTab\(\{ id: 'pages-io', titleKey: 'admin\.navPagesIO'.*loadPageSystem\(\).*tab-pages-io\.js\$\{V\}`\)\)\.PagesIoTab/);
  const pages = read('js/pages/admin/tab-pages.js');
  assert.match(pages, /el\('pages-export'\)\.addEventListener\('click', \(\) => navigateTo\('pages-io'\)\)/);
  assert.match(pages, /el\('pages-import'\)\.addEventListener\('click', \(\) => navigateTo\('pages-io'\)\)/);
  assert.match(pages, /export function normalizePageContent\(b\)/);
  const css = read('css/admin-shell.css');
  for (const sel of ['.pio-card', '.pio-row', '.pio-toggle:focus-visible', '.pio-drop:focus-visible', '.pio-menu', '.pio-check']) assert.ok(css.includes(sel), `css ${sel}`);
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*?\.pio-row \{ flex-direction: column; \}/, 'narrow widths');

  // The sanitiser the import stores through is the editor's own.
  const n = realNormalizer({ sections: [null, { columns: [null, { widgets: [null, { type: 'heading', props: [] }] }] }], background: { preset: 'dots', params: { a: 1 } } });
  assert.equal(n.sections.length, 1);
  assert.equal(n.sections[0].columns[0].widgets[0].type, 'heading');
  assert.deepEqual(n.background, { preset: 'dots', params: { a: 1 } });
  assert.equal(realNormalizer({ blocks: [{ type: 'heading', text: { en: 'x' } }] }).sections[0].columns[0].widgets.length, 1, 'legacy flat pages become sections');

  // Locales: every key used exists in the four, with the same placeholders, translated.
  const keysOf = (o, pre = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keysOf(v, `${pre}${k}.`) : [`${pre}${k}`]));
  const lang = (c) => JSON.parse(read(`lang/${c}.json`));
  const get = (o, k) => k.split('.').reduce((a, p) => (a == null ? a : a[p]), o);
  const en = lang('en');
  const used = new Set();
  for (const src of [tab, api]) for (const m of src.matchAll(/'(pagesIo\.[A-Za-z0-9_.]+)'/g)) used.add(m[1]);
  assert.ok(used.size > 150);
  const enKeys = keysOf(en.pagesIo).sort();
  for (const k of used) assert.equal(typeof get(en, k), 'string', `en has ${k}`);
  for (const k of enKeys) assert.ok(used.has(`pagesIo.${k}`), `en pagesIo.${k} is used by the tab (no dead string)`);
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
  const same = [];
  for (const code of ['fr', 'es', 'nl']) {
    const l = lang(code);
    assert.deepEqual(keysOf(l.pagesIo).sort(), enKeys, `pagesIo parity in ${code}`);
    assert.equal(typeof l.admin.navPagesIO, 'string');
    assert.notEqual(l.admin.navPagesIO, en.admin.navPagesIO, `nav label translated in ${code}`);
    for (const k of enKeys) {
      assert.equal(ph(get(l.pagesIo, k)), ph(get(en.pagesIo, k)), `${code} ${k}: same placeholders`);
      if (get(l.pagesIo, k) === get(en.pagesIo, k)) same.push(`${code}:${k}`);
    }
  }
  // Words that are the same in the language ("Version", "OK", "Import", "{label} → {page}: {reason}"): nothing else may be a copy.
  const cognates = ['fr:badge.active', 'fr:count.many', 'fr:count.one', 'fr:defaultLabel', 'fr:import.action', 'fr:import.nVersions', 'fr:import.title',
    'fr:level.ok', 'fr:row.noteLabel', 'es:level.error', 'es:result.failed', 'nl:import.title', 'nl:level.ok', 'nl:result.failed'];
  assert.deepEqual(same.sort(), cognates.sort(), 'translations are real, not English copies');
  assert.equal(en.admin.navPagesIO, 'Page import / export');
  assert.equal(lang('fr').admin.navPagesIO, 'Import / export de pages');
  assert.equal(lang('es').admin.navPagesIO, 'Importar / exportar páginas');
  assert.equal(lang('nl').admin.navPagesIO, 'Pagina’s importeren / exporteren');
}

console.log('test_pages_io_tab: OK');
