// Identity must save ONLY the fields it edits, merged onto the document as it is
// on the server now (the page editor and the Types tab write the same file), and
// must keep unsaved edits across tab revisits and language switches. The merge runs
// server-side (?merge=<dotted paths>, api/site.php site_merge_paths / dev_server.py
// _merge_paths); the stub below applies the same rule.
//
// Run: node tests/js/test_admin_branding_merge.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

function setup() {
  let src = readFileSync(path.join(ROOT, 'js/pages/admin/tab-branding.js'), 'utf8')
    .replace(/^import\s[^;]*;/gm, '')
    .replace(/^export\s+(function|const|let|class)/gm, '$1');

  const server = { instance: { brand: { name: 'Old', tagline: { en: 'tag' }, accent: 'keep' }, variables: { v: 1 }, nav: { customPages: [{ slug: 'p' }] }, datasetTypes: { '3d': { label: 'X' } } }, posts: [], urls: [], gets: 0, failGet: false, failPost: false };
  // Twin of the server's merge: each listed dotted path is replaced by the body's
  // value at that path (removed when the body has none); nothing else changes.
  const mergePaths = (current, incoming, paths) => {
    const out = JSON.parse(JSON.stringify(current));
    for (const p of paths) {
      const segs = p.split('.');
      let src = incoming, found = true;
      for (const s of segs) { if (src && typeof src === 'object' && s in src) src = src[s]; else { found = false; break; } }
      let node = out, ok = true;
      for (const s of segs.slice(0, -1)) {
        if (!node[s] || typeof node[s] !== 'object') { if (!found) { ok = false; break; } node[s] = {}; }
        node = node[s];
      }
      if (!ok) continue;
      if (found) node[segs[segs.length - 1]] = JSON.parse(JSON.stringify(src)); else delete node[segs[segs.length - 1]];
    }
    return out;
  };
  const inputs = {
    path: [{ k: 'brand.name', value: 'New name' }],
    loc: [{ p: 'brand.tagline', code: 'en', value: 'new tag' }, { p: 'brand.tagline', code: 'fr', value: '' }],
    toggle: [{ k: 'nav.showAbout', checked: false }],
  };
  const mkInput = (attrs, extra) => ({ getAttribute: (n) => attrs[n], ...extra, addEventListener() {} });
  const root = {
    innerHTML: '',
    querySelector: (s) => (s === 'input' ? {} : null),
    querySelectorAll(sel) {
      if (sel === 'input[data-path]') return inputs.path.map((i) => mkInput({ 'data-path': i.k }, { value: i.value }));
      if (sel === 'input[data-loc-path]') return inputs.loc.map((i) => mkInput({ 'data-loc-path': i.p, 'data-loc': i.code }, { value: i.value }));
      if (sel === 'input[data-toggle]') return inputs.toggle.map((i) => mkInput({ 'data-toggle': i.k }, { checked: i.checked }));
      if (sel === '.adm-link-row') return [];
      return [];
    },
  };
  const sandbox = {
    console, JSON, Object, Array, String, Promise, Date,
    API_SITE: 'api/site.php', I18n: null,
    t: (_k, d) => d ?? '', escHtml: (v) => String(v ?? ''),
    apiFetch: async () => { server.gets++; return server.failGet ? null : JSON.parse(JSON.stringify(server.instance)); },
    apiFetchStatus: async (url, opts) => {
      if (server.failPost) return { ok: false, status: 500, data: null };
      server.urls.push(url);
      const body = JSON.parse(opts.body);
      server.posts.push(body);
      const merge = new URL(url, 'http://x/').searchParams.get('merge');
      server.instance = merge ? mergePaths(server.instance, body, merge.split(',')) : body;
      return { ok: true, status: 200, data: { ok: true, rev: 'r' } };
    },
    toast() {}, refreshIcons() {},
    el: (id) => (id === 'branding-root' ? root : (id === 'branding-save' || id === 'branding-reset') ? { addEventListener() {}, disabled: false } : id === 'branding-links' || id === 'branding-add-link' ? { addEventListener() {}, appendChild() {} } : null),
    setUnsaved() {}, registerDirtyGuard() {}, bindTabSave() {},
    InstanceConfig: undefined,
  };
  src += '\n;globalThis.__T = { tab: BrandingTab, save, state: () => ({ dirty: _dirty, loaded: _loaded }), markDirty: () => _mark(true) };';
  vm.runInContext(src, vm.createContext(sandbox), { filename: 'tab-branding.js' });
  return { T: sandbox.__T || null, sandbox, server };
}

const { sandbox, server } = (() => { const s = setup(); return s; })();
const ctx = sandbox;
// vm.runInContext defined __T on the context's global (the sandbox object itself).
const T = ctx.__T;

// First activation loads the document.
T.tab.mount();
T.tab.activate();
await new Promise((r) => setTimeout(r, 5));
assert.equal(server.gets, 1);
assert.equal(T.state().loaded, true);

// The operator edits and saves.
T.markDirty();
// Meanwhile the page editor adds a variable and a custom page to the same file.
server.instance.variables = { v: 2, added: 'by editor' };
server.instance.nav.customPages.push({ slug: 'newpage' });
await T.save();

assert.equal(server.posts.length, 1);
assert.equal(server.gets, 1, 'no read-modify-write round trip: the server merges');
const merge = new URL(server.urls[0], 'http://x/').searchParams.get('merge').split(',');
assert.ok(merge.includes('brand.name') && merge.includes('nav.showAbout') && merge.includes('brand.tagline'),
  'the save names exactly the fields the form edits');
assert.ok(!merge.some((p) => ['brand', 'nav', 'variables', 'datasetTypes'].includes(p)),
  'no whole branch that other tabs share is replaced');
assert.equal(server.posts[0].variables, undefined, 'the body carries the form fields only');
const saved = server.instance;
assert.equal(saved.brand.name, 'New name', 'the edited field is written');
assert.deepEqual(saved.brand.tagline, { en: 'new tag' }, 'localized field cleaned of empty locales');
assert.equal(saved.nav.showAbout, false, 'toggle written');
assert.equal(saved.brand.accent, 'keep', 'a brand key the form does not show survives');
assert.deepEqual(saved.variables, { v: 2, added: 'by editor' }, 'variables written elsewhere meanwhile are NOT reverted');
assert.equal(saved.nav.customPages.length, 2, 'the page created in the editor stays in the menu');
assert.deepEqual(saved.datasetTypes, { '3d': { label: 'X' } }, 'dataset-type names are untouched');
assert.equal(T.state().dirty, false);

// A revisit while dirty must not reload over the edits.
T.markDirty();
const getsBefore = server.gets;
T.tab.activate();
await Promise.resolve();
assert.equal(server.gets, getsBefore, 'activate() does not refetch while there are unsaved edits');

// A refused save keeps the edits (still dirty, nothing reported as saved).
server.failPost = true;
T.markDirty();
await T.save();
assert.equal(T.state().dirty, true, 'a failed save leaves the form dirty');

console.log('admin identity save (field-level merge · no clobber · edits kept on revisit): OK');
