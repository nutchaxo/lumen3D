// Unit tests for autonomous plugin discovery + dynamic toolbar generation
// (js/core/plugin-registry.js):
//   - discover() hybrid fallback: /api/plugins → manifest.json → embedded default
//   - discover() ignores non-JSON bodies (raw PHP served by a static host)
//   - loadModules() registers every discovered tool from its plugin.json
//   - buildToolbarButtons() generates buttons per metadata: correct cluster,
//     order, data-plugin-id vs data-tool, requires-gated visibility, idempotent
//
// Run: node tests/js/test_plugin_autonomy.mjs
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── minimal DOM ───────────────────────────────────────────────────────────────
class El {
  constructor(tag) {
    this.tagName = tag; this.dataset = {}; this._c = new Set(); this.style = {};
    this._a = {}; this.children = []; this.title = ''; this.id = '';
    this.className = ''; this.onload = null; this.onerror = null; this._parent = null;
  }
  get classList() {
    const c = this._c;
    return {
      add: x => c.add(x), remove: x => c.delete(x),
      toggle: (x, on) => { if (on === undefined) { c.has(x) ? c.delete(x) : c.add(x); } else { on ? c.add(x) : c.delete(x); } return c.has(x); },
      contains: x => c.has(x),
    };
  }
  setAttribute(k, v) { this._a[k] = String(v); }
  getAttribute(k) { return k in this._a ? this._a[k] : null; }
  appendChild(ch) { ch._parent = this; this.children.push(ch); return ch; }
  remove() { if (this._parent) { const i = this._parent.children.indexOf(this); if (i >= 0) this._parent.children.splice(i, 1); } }
  querySelectorAll(sel) { return sel === '[data-plugin-generated]' ? this.children.filter(c => c.dataset && c.dataset.pluginGenerated) : []; }
}
const containers = {};
for (const g of ['tools', 'export', 'visuals', 'layouts']) containers[`[data-tool-group="${g}"]`] = new El('div');
const document = {
  createElement: t => new El(t),
  querySelector: sel => containers[sel] || null,
  querySelectorAll: () => [],
  body: { appendChild: el => { if (el.tagName === 'script') queueMicrotask(() => el.onload && el.onload()); } },
};

// Swappable fetch so each test drives a different discovery scenario.
let currentFetch = async () => ({ ok: false, status: 404 });
const lucide = { createIcons() {} };
const PR = loadModule('js/core/plugin-registry.js', 'PluginRegistry', {
  document,
  window: { lucide },
  lucide,
  I18n: { t: k => k, translateDOM() {} },
  fetch: (...a) => currentFetch(...a),
  queueMicrotask,
});

const btns = g => containers[`[data-tool-group="${g}"]`].children;

// ── discover(): embedded fallback when nothing is reachable ───────────────────
currentFetch = async () => ({ ok: false, status: 404 });
{
  const paths = await PR.discover('js/modules');
  assert.equal(paths.length, 18, 'discover embedded default = 18 module paths');
  assert.ok(paths.includes('channels/histogram') && paths.includes('shaders/fluorescence'),
    'embedded default spans channels + shaders, not just tools');
}

// ── discover(): generated manifest when the live endpoint is absent ───────────
currentFetch = async (url) => {
  if (url.includes('api/plugins')) return { ok: false, status: 404 };
  if (url.includes('manifest.json')) return { ok: true, status: 200, json: async () => ({ plugins: [{ path: 'tools/screenshot' }, { path: 'shaders/fluorescence' }] }) };
  return { ok: false, status: 404 };
};
{
  const paths = await PR.discover('js/modules');
  assert.deepEqual(paths, ['tools/screenshot', 'shaders/fluorescence'], 'discover falls back to manifest.json');
}

// ── discover(): the live endpoint wins when present ───────────────────────────
currentFetch = async (url) => (url === 'api/plugins'
  ? { ok: true, status: 200, json: async () => ({ plugins: [{ path: 'tools/measure-distance' }] }) }
  : { ok: false, status: 404 });
{
  const paths = await PR.discover('js/modules');
  assert.deepEqual(paths, ['tools/measure-distance'], 'discover prefers the live /api/plugins endpoint');
}

// ── discover(): a static host serving raw PHP (non-JSON) is ignored ───────────
currentFetch = async (url) => (url === 'api/plugins.php'
  ? { ok: true, status: 200, json: async () => { throw new Error('not json'); } }
  : { ok: false, status: 404 });
{
  const paths = await PR.discover('js/modules');
  assert.equal(paths.length, 18, 'non-JSON php body is rejected, falls through to embedded default');
}

// ── loadModules(): registers every discovered tool from disk ──────────────────
currentFetch = async (url) => {
  const m = url.match(/js\/modules\/(.+)\/plugin\.json$/);
  if (m) {
    const f = path.join(ROOT, 'js/modules', m[1], 'plugin.json');
    if (existsSync(f)) return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(f, 'utf8')) };
  }
  return { ok: false, status: 404 };
};
const all = await PR.discover('js/modules');
await PR.loadModules('js/modules', all);
assert.equal(PR.listByPlacement('tools').length, 14, 'loadModules registered all 14 tool plugins');
assert.equal(PR.listByPlacement('shaders').length, 2, '2 shaders registered');
assert.equal(PR.listByPlacement('channels').length, 2, '2 channel plugins registered');

// ── buildToolbarButtons(): generation, clustering, ordering, types, visibility ─
PR.buildToolbarButtons({
  dataset: { volumeSources: [{ kind: 'webstack', available: true }] }, // no deepzoom2d source
  groups: [
    { group: 'tools', container: '[data-tool-group="tools"]' },
    { group: 'export', container: '[data-tool-group="export"]' },
    { group: 'visuals', container: '[data-tool-group="visuals"]' },
    { group: 'layouts', container: '[data-tool-group="layouts"]' },
  ],
});
assert.equal(btns('export').length, 4, 'export cluster has 4 generated buttons');
assert.ok(btns('export').every(b => b.dataset.pluginId), 'export buttons are data-plugin-id (activate-wired)');
assert.deepEqual(btns('export').map(b => b.dataset.pluginId),
  ['download-center', 'save-workspace', 'restore-workspace', 'screenshot'], 'export honors plugin.json order');
assert.equal(btns('visuals').length, 4, 'visuals cluster has 4 buttons');
assert.equal(btns('tools').length, 2, 'tools cluster has the 2 tool-subtype chips');
assert.ok(btns('tools').every(b => b.dataset.tool && !b.dataset.pluginId && b.className.includes('tool-chip')),
  'tool-subtype plugins become data-tool chips (ToolManager-wired), not data-plugin-id');
assert.deepEqual(btns('tools').map(b => b.dataset.tool), ['slice', 'measure'], 'tool chips ordered slice then measure');
assert.equal(btns('layouts').length, 4, 'layouts cluster has 4 buttons');

const dz = btns('layouts').find(b => b.id === 'btn-toggle-deepzoom');
assert.ok(dz && dz.style.display === 'none', 'deepzoom hidden: requires deepzoom2d source which is absent');
const zs = btns('layouts').find(b => b.id === 'btn-toggle-zstack');
assert.ok(zs && zs.dataset.pluginId === 'zstack-browser' && zs.style.display !== 'none', 'zstack visible + data-plugin-id');

// ── buildToolbarButtons(): idempotent rebuild + requires re-evaluated ─────────
PR.buildToolbarButtons({
  dataset: { volumeSources: [{ kind: 'deepzoom2d', available: true }] },
  groups: [{ group: 'layouts', container: '[data-tool-group="layouts"]' }],
});
assert.equal(btns('layouts').length, 4, 'rebuild does not duplicate (idempotent)');
const dz2 = btns('layouts').find(b => b.id === 'btn-toggle-deepzoom');
assert.ok(dz2 && dz2.style.display !== 'none', 'deepzoom shown once the dataset offers a deepzoom2d source');

console.log('plugin autonomy (discover hybrid + dynamic toolbar generation): OK');
