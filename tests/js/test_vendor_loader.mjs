// PluginRegistry.loadVendor: one <script> per vendored library for the page, shared
// by every plugin asking at once (and by the inline loader a plugin keeps for older
// cores), a failed tag removed so the next call tries again, the SRI pinned once.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadModule, ROOT } from './harness.mjs';

function fakeDom() {
  const head = [];
  class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.attrs = {}; this.listeners = {}; this.children = []; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    set src(v) { this.attrs.src = String(v); }
    get src() { return this.attrs.src; }
    get id() { return this.attrs.id || ''; }
    set id(v) { this.attrs.id = String(v); }
    appendChild(c) { this.children.push(c); return c; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    fire(type) { (this.listeners[type] || []).slice().forEach(fn => fn({ type, target: this })); }
    remove() { const i = head.indexOf(this); if (i >= 0) head.splice(i, 1); }
    get sheet() { return {}; }
  }
  const document = {
    currentScript: null,
    head: { appendChild(el) { head.push(el); return el; } },
    createElement: (tag) => new El(tag),
    createTextNode: (s) => ({ text: s }),
    getElementById: (id) => head.find(e => e.attrs.id === id) || null,
    querySelectorAll(sel) {
      assert.equal(sel, 'script[data-vendor-state="loading"]', 'the only query the loaders make');
      return head.filter(e => e.tagName === 'SCRIPT' && e.attrs['data-vendor-state'] === 'loading');
    },
    addEventListener() {}
  };
  return { document, head, scripts: () => head.filter(e => e.tagName === 'SCRIPT') };
}

function loadRegistry(dom, win) {
  return loadModule('js/core/plugin-registry.js', 'PluginRegistry', {
    document: dom.document, window: win, CSS: { escape: s => s }, TextDecoder,
    setInterval: () => 1, clearInterval() {}
  });
}

const tick = () => new Promise(r => setTimeout(r, 0));

// 1. Two plugins asking at once: one tag, one promise, the pinned SRI, the style element first.
{
  const dom = fakeDom();
  const win = {};
  const PR = loadRegistry(dom, win);
  assert.equal(typeof PR.loadVendor, 'function');
  const a = PR.loadVendor('plotly');
  const b = PR.loadVendor('plotly');
  assert.equal(a, b, 'the same promise for both callers');
  assert.equal(dom.scripts().length, 1, 'one <script> for the page');
  const tag = dom.scripts()[0];
  assert.equal(tag.getAttribute('src'), 'js/vendor/plotly.min.js');
  assert.match(tag.integrity, /^sha384-/);
  assert.equal(tag.getAttribute('data-vendor-state'), 'loading');
  assert.ok(dom.document.getElementById('plotly.js-style-global'), 'Plotly\'s style element exists before it runs');
  win.Plotly = { version: 'x' };
  tag.fire('load');
  assert.equal(await a, win.Plotly);
  assert.equal(tag.getAttribute('data-vendor-state'), 'loaded');
  assert.equal(await PR.loadVendor('plotly'), win.Plotly, 'once defined, no new tag');
  assert.equal(dom.scripts().length, 1);
  await assert.rejects(PR.loadVendor('jquery'), (e) => e.code === 'UNKNOWN_VENDOR');
  await assert.rejects(PR.loadVendor('__proto__'), (e) => e.code === 'UNKNOWN_VENDOR');
}

// 2. A failed load: the tag goes, the next call tries again with a fresh one.
{
  const dom = fakeDom();
  const win = {};
  const PR = loadRegistry(dom, win);
  const first = PR.loadVendor('plotly');
  dom.scripts()[0].fire('error');
  await assert.rejects(first, /failed to load/);
  assert.equal(dom.scripts().length, 0, 'the failed tag is removed');
  const second = PR.loadVendor('plotly');
  assert.notEqual(second, first);
  assert.equal(dom.scripts().length, 1);
  win.Plotly = {};
  dom.scripts()[0].fire('load');
  assert.equal(await second, win.Plotly);
}

// 3. A tag that loads but defines nothing rejects, and is not joined again.
{
  const dom = fakeDom();
  const win = {};
  const PR = loadRegistry(dom, win);
  const p = PR.loadVendor('plotly');
  dom.scripts()[0].fire('load');
  await assert.rejects(p, /did not define itself/);
  PR.loadVendor('plotly');
  assert.equal(dom.scripts().length, 2, 'a new attempt, not the spent tag');
}

// 4. tracking-charts on a core without loadVendor joins the tag the core put in flight;
//    on a core with it, it goes through the core.
{
  const dom = fakeDom();
  const win = {};
  const PR = loadRegistry(dom, win);
  const coreLoad = PR.loadVendor('plotly');
  let impl = null;
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, Promise, Array, Object, Error,
    window: win, document: dom.document,
    PluginRegistry: { implement: (_id, o) => { impl = o; }, ensureNoncedStyle: () => true }
  });
  vm.runInContext(readFileSync(path.join(ROOT, 'js/modules/tools/tracking-charts/index.js'), 'utf8'), ctx, { filename: 'tracking-charts/index.js' });
  assert.ok(impl && typeof impl._ensurePlotly === 'function');
  const self = Object.create(impl);
  self._plotly = null;
  const old = self._ensurePlotly();
  assert.equal(dom.scripts().length, 1, 'the older-core path joins the tag in flight');
  win.Plotly = { v: 1 };
  dom.scripts()[0].fire('load');
  assert.equal(await old, win.Plotly);
  assert.equal(await coreLoad, win.Plotly);

  // With the core loader: delegated.
  delete win.Plotly;
  let asked = null;
  ctx.PluginRegistry.loadVendor = (name) => { asked = name; return Promise.resolve('core'); };
  const viaCore = Object.create(impl);
  viaCore._plotly = null;
  assert.equal(await viaCore._ensurePlotly(), 'core');
  assert.equal(asked, 'plotly');
}

// 5. The graphs plugin delegates to the core too, and keeps an inline loader that joins.
{
  const src = readFileSync(path.join(ROOT, 'js/modules/tools/graphs/index.js'), 'utf8');
  assert.match(src, /PluginRegistry\.loadVendor\('plotly'\)/);
  assert.match(src, /script\[data-vendor-state="loading"\]/);
  const reg = readFileSync(path.join(ROOT, 'js/core/plugin-registry.js'), 'utf8');
  const sri = /sri: '(sha384-[^']+)'/.exec(reg)[1];
  for (const f of ['js/modules/tools/graphs/index.js', 'js/modules/tools/tracking-charts/index.js']) {
    const body = readFileSync(path.join(ROOT, f), 'utf8');
    const m = /sha384-[A-Za-z0-9+/=]+/.exec(body);
    assert.ok(m && m[0] === sri, `${f}: its fallback SRI matches the core's`);
  }
}

await tick();
console.log('vendor loader: ok');
