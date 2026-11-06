// Legal editor: the Save button follows the unsaved state of the model on every
// render. Adding or deleting a section, or switching the editing language, rebuilds
// the tab's markup — the rebuilt button must stay enabled while edits are unsaved.
//
// Run: node tests/js/test_admin_legal_save_state.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

function fakeNode(attrs) {
  const listeners = {};
  return {
    attrs, listeners, value: attrs.value ?? '',
    disabled: 'disabled' in attrs,
    getAttribute: (n) => attrs[n],
    addEventListener: (ev, fn) => { (listeners[ev] ||= []).push(fn); },
    fire(ev, extra) { (listeners[ev] || []).forEach((fn) => fn({ target: this, ...extra })); },
  };
}

// Parses the opening tags of the rendered markup into fake nodes so the module's
// own selectors and getElementById see what the browser would.
function parseTags(html) {
  const nodes = [];
  const rx = /<(button|input|textarea|select)\b([^>]*)>/g;
  let m;
  while ((m = rx.exec(html))) {
    const attrs = { tag: m[1] };
    const arx = /([a-zA-Z-]+)(?:="([^"]*)")?/g;
    let a;
    while ((a = arx.exec(m[2]))) attrs[a[1]] = a[2] ?? '';
    nodes.push(fakeNode(attrs));
  }
  return nodes;
}

function setup() {
  const src = readFileSync(path.join(ROOT, 'js/pages/admin/tab-legal.js'), 'utf8')
    .replace(/^import\s[^;]*;/gm, '')
    .replace(/^export\s+(function|const|let|class)/gm, '$1');

  let nodes = [];
  const root = {
    _html: '',
    set innerHTML(v) { this._html = v; nodes = parseTags(v); },
    get innerHTML() { return this._html; },
    querySelectorAll(sel) {
      const cls = sel.replace(/^\./, '');
      return nodes.filter((n) => (n.attrs.class || '').split(/\s+/).includes(cls));
    },
  };
  const unsaved = [];
  const server = { legal: { sections: [{ title: { en: 'A' }, body: { en: 'a' } }, { title: { en: 'B' }, body: { en: 'b' } }] }, posts: [] };
  const sandbox = {
    console, JSON, Object, Array, String, Promise,
    API_SITE: 'api/site.php',
    I18n: { getAvailableLanguages: () => [{ code: 'en', native: 'English' }, { code: 'fr', native: 'Français' }], getLanguage: () => 'en' },
    t: (_k, d) => d,
    escHtml: (v) => String(v ?? '').replace(/"/g, '&quot;'),
    apiFetch: async () => JSON.parse(JSON.stringify(server.legal)),
    apiFetchStatus: async (_url, opts) => { server.posts.push(JSON.parse(opts.body)); return { ok: true, status: 200 }; },
    toast() {}, refreshIcons() {},
    el: (id) => (id === 'legal-root' ? root : nodes.find((n) => n.attrs.id === id) || null),
    setUnsaved: (on, tab) => unsaved.push([on, tab]),
    registerDirtyGuard() {}, bindTabSave() {},
    confirm: () => true,
  };
  vm.runInContext(src + '\n;globalThis.__T = { tab: LegalTab, load, dirty: () => _dirty };', vm.createContext(sandbox), { filename: 'tab-legal.js' });
  return { T: sandbox.__T, el: sandbox.el, root, server, unsaved };
}

const saveBtn = (el) => el('legal-save');

// 1. A fresh load is clean: Save disabled.
{
  const { T, el } = setup();
  T.tab.mount();
  await T.load();
  assert.equal(T.dirty(), false);
  assert.equal(saveBtn(el).disabled, true, 'nothing to save after a load');
}

// 2. Deleting a section re-renders: Save stays enabled and saves the deletion.
{
  const { T, el, root, server } = setup();
  T.tab.mount();
  await T.load();
  const del = root.querySelectorAll('.adm-sec-del');
  assert.equal(del.length, 2);
  del[0].fire('click');
  assert.equal(T.dirty(), true);
  assert.equal(saveBtn(el).disabled, false, 'the deletion can be saved with the button');
  saveBtn(el).fire('click');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(server.posts.length, 1);
  assert.equal(server.posts[0].sections.length, 1);
  assert.equal(server.posts[0].sections[0].title.en, 'B');
  assert.equal(T.dirty(), false);
}

// 3. Adding a section re-renders: Save enabled.
{
  const { T, el } = setup();
  T.tab.mount();
  await T.load();
  el('legal-add').fire('click');
  assert.equal(T.dirty(), true);
  assert.equal(saveBtn(el).disabled, false, 'a new section can be saved with the button');
}

// 4. Switching the editing language mid-edit keeps Save enabled; a clean switch keeps it disabled.
{
  const { T, el, root } = setup();
  T.tab.mount();
  await T.load();
  el('legal-loc').fire('change', { target: { value: 'fr' } });
  assert.equal(saveBtn(el).disabled, true, 'a language switch alone has nothing to save');
  const title = root.querySelectorAll('.adm-sec-title')[0];
  title.value = 'Titre';
  title.fire('input');
  assert.equal(saveBtn(el).disabled, false);
  el('legal-loc').fire('change', { target: { value: 'en' } });
  assert.equal(T.dirty(), true);
  assert.equal(saveBtn(el).disabled, false, 'switching language keeps the unsaved edit saveable');
}

// 5. A relabel (UI language switch) keeps the state too.
{
  const { T, el } = setup();
  T.tab.mount();
  await T.load();
  el('legal-add').fire('click');
  T.tab.relabel();
  assert.equal(saveBtn(el).disabled, false);
}

console.log('test_admin_legal_save_state: OK');
