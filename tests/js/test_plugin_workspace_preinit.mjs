// Regression test: PluginRegistry.setWorkspaceState() must NOT call a module's
// setState() while the module is only 'registered' (index.js ran implement() but
// initAll() hasn't handed it a ViewerContext yet — so `this._ctx` is still null).
//
// This guards the load-time crash where the viewer restored a saved workspace
// (camera + plugin states) BEFORE PluginRegistry.initAll() ran, throwing:
//   setState failed for "measure-distance": Cannot read properties of null (reading 'measurements')
//   setState failed for "zstack-browser":  Cannot read properties of null (reading '_state')
// viewer.js now defers the plugin restore until after initAll(); the registry
// also refuses to setState a not-yet-initialized module as defense in depth.
//
// Run: node tests/js/test_plugin_workspace_preinit.mjs
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── minimal DOM (script injection resolves onload synchronously) ──────────────
const document = {
  createElement: () => ({ dataset: {}, style: {}, setAttribute() {}, set onload(fn) { queueMicrotask(() => fn && fn()); } }),
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { appendChild: (el) => { if (el && typeof el.onload === 'function') el.onload(); } },
};

const PR = loadModule('js/core/plugin-registry.js', 'PluginRegistry', {
  document,
  window: {},
  I18n: { t: (k) => k },           // no forPlugin → initAll uses the literal fallback ctx.i18n
  fetch: async (url) => {
    const m = url.match(/js\/modules\/(.+)\/plugin\.json$/);
    if (m) {
      const f = path.join(ROOT, 'js/modules', m[1], 'plugin.json');
      if (existsSync(f)) return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(f, 'utf8')) };
    }
    return { ok: false, status: 404 };
  },
  queueMicrotask,
});

await PR.loadModules('js/modules', ['tools/zstack-browser', 'tools/measure-distance']);

// Two spies standing in for the real index.js implementations.
const calls = { zstack: [], measure: [] };
const makeImpl = (bucket) => ({
  _ctx: null,
  init(ctx) { this._ctx = ctx; return this; },
  // Mirrors the real plugins: setState dereferences this._ctx, so being called
  // pre-init (this._ctx === null) would throw exactly the reported TypeError.
  setState(s) {
    if (this._ctx === null) throw new TypeError('setState called before init — this._ctx is null');
    calls[bucket].push(s);
  },
});
PR.implement('zstack-browser', makeImpl('zstack'));
PR.implement('measure-distance', makeImpl('measure'));

// ── 1. Pre-init: setWorkspaceState must skip 'registered' modules silently ─────
assert.doesNotThrow(() => PR.setWorkspaceState({
  'zstack-browser': { zstackActive: true, zstackSlice: 5 },
  'measure-distance': { measurements: [{ id: 'm1' }] },
}), 'setWorkspaceState must not throw or call setState before initAll()');
assert.equal(calls.zstack.length, 0, 'zstack setState NOT called pre-init');
assert.equal(calls.measure.length, 0, 'measure setState NOT called pre-init');

// ── 2. After initAll: setWorkspaceState delivers state to initialized modules ──
await PR.initAll({ /* shared ViewerContext façade — fields unused by the spies */ });
PR.setWorkspaceState({
  'zstack-browser': { zstackActive: true, zstackSlice: 5 },
  'measure-distance': { measurements: [{ id: 'm1' }] },
});
assert.deepEqual(calls.zstack, [{ zstackActive: true, zstackSlice: 5 }], 'zstack setState received state post-init');
assert.deepEqual(calls.measure, [{ measurements: [{ id: 'm1' }] }], 'measure setState received state post-init');

console.log('plugin workspace pre-init guard (no this._ctx null crash on restore): OK');
