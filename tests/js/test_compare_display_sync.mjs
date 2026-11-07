// How the volumes are drawn follows from one Compare panel to the others.
//
// A toggle plugin that says `"compareSync": "display"` in plugin.json (grid, axes, hidden
// volume) is relayed by the host: the page that was pressed posts SYNC_PLUGIN with the
// plugin's own getState(), the host forwards it to the other volume panels (and replays it
// to one that joins later), and a sibling applies it with setState() — silently. The render
// mode select travels the same way as SYNC_RENDER_MODE. This pins the registry half (vm) and
// the wiring of the three sources.
//
// Run: node tests/js/test_compare_display_sync.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r/g, '');

// ── registry: describeToolbar / getSyncState / applySyncState ──
const METAS = {
  'tools/grid':   { id: 'grid',   placement: 'tools', subtype: 'toggle', icon: 'grid', order: 1, compareSync: 'display' },
  'tools/plain':  { id: 'plain',  placement: 'tools', subtype: 'toggle', icon: 'x',    order: 2 },
  'tools/odd':    { id: 'odd',    placement: 'tools', subtype: 'toggle', icon: 'o',    order: 3, compareSync: 'camera' },
  'tools/nostate':{ id: 'nostate',placement: 'tools', subtype: 'toggle', icon: 'n',    order: 4, compareSync: 'display' },
};
const button = (title) => ({ title, style: {}, classList: { contains: () => false }, querySelector: () => null });
const document = {
  createElement: () => ({ dataset: {}, setAttribute() {}, onload: null, onerror: null }),
  querySelector: (sel) => { const m = sel.match(/data-plugin-id="([^"]+)"/); return m ? button(m[1]) : null; },
  querySelectorAll: () => [],
  body: { appendChild: el => queueMicrotask(() => el.onload && el.onload()) },
};
const PR = loadModule('js/core/plugin-registry.js', 'PluginRegistry', {
  document, window: {}, console: { ...console, warn() {}, info() {}, debug() {} },
  I18n: { t: k => k, translateDOM() {} }, queueMicrotask, CSS: { escape: s => s },
  PluginTrust: { evaluate: async () => ({ tier: 'dev', hash: 'stub', bytes: '' }) },
  URL: { createObjectURL: () => 'blob:stub', revokeObjectURL() {} }, Blob: class {},
  fetch: async (url) => {
    const m = String(url).match(/js\/modules\/(.+)\/plugin\.json$/);
    return m && METAS[m[1]] ? { ok: true, status: 200, json: async () => ({ ...METAS[m[1]] }) } : { ok: false, status: 404 };
  },
});
await PR.loadModules('js/modules', Object.keys(METAS), {});

const applied = [];
let mode = 0;
const grid = {
  init() {},
  getState() { return { gridMode: mode }; },
  setState(s) { mode = s.gridMode; applied.push(s); },
};
PR.implement('grid', grid);
PR.implement('plain', { init() {}, getState: () => ({ on: true }), setState() { throw new Error('a plugin outside the group must never be driven'); } });
PR.implement('odd', { init() {}, getState: () => ({}), setState() { throw new Error('an unknown group must never be driven'); } });
PR.implement('nostate', { init() {} });

// Not applied before initAll: the registry refuses a plugin that has no context yet.
assert.equal(PR.getSyncState('grid'), null, 'a plugin that is only registered is not read');
assert.equal(PR.applySyncState('grid', 'display', { gridMode: 1 }), false, 'nor driven');
await PR.initAll({});

// The description tells the host which toggles keep step.
const d = PR.describeToolbar();
assert.deepEqual(Array.from(d.toggles, t => [t.id, t.sync]),
  [['grid', 'display'], ['plain', null], ['odd', null], ['nostate', 'display']],
  'a declared group is described; an undeclared or unknown one is not');

// getSyncState: the plugin's own state, tagged with its group.
mode = 2;
assert.equal(JSON.stringify(PR.getSyncState('grid')), JSON.stringify({ id: 'grid', group: 'display', state: { gridMode: 2 } }));
assert.equal(PR.getSyncState('plain'), null, 'no group, nothing to share');
assert.equal(PR.getSyncState('odd'), null, 'a group the registry does not know, nothing to share');
assert.equal(PR.getSyncState('nostate'), null, 'a plugin without getState has nothing to share');
assert.equal(PR.getSyncState('missing'), null);

// applySyncState: setState, only inside the group, never throwing into the page.
assert.equal(PR.applySyncState('grid', 'display', { gridMode: 1 }), true);
assert.equal(mode, 1);
assert.equal(PR.applySyncState('grid', 'camera', { gridMode: 0 }), false, 'a sibling cannot drive a plugin through another group');
assert.equal(mode, 1);
assert.equal(PR.applySyncState('plain', 'display', {}), false, 'a plugin outside the group is left alone');
assert.equal(PR.applySyncState('odd', 'camera', {}), false);
assert.equal(PR.applySyncState('nostate', 'display', {}), false, 'no setState, nothing to apply');
assert.equal(PR.applySyncState('missing', 'display', {}), false);
assert.equal(applied.length, 1);

// ── the three real plugins declare it, and implement the pair the relay uses ──
for (const id of ['toggle-grid', 'toggle-axes', 'toggle-volume']) {
  const meta = JSON.parse(read(`js/modules/tools/${id}/plugin.json`));
  assert.equal(meta.compareSync, 'display', `${id} declares compareSync`);
  assert.ok(meta.contexts.includes('panel'), `${id} runs in a panel`);
  const src = read(`js/modules/tools/${id}/index.js`);
  assert.ok(/getState\(\)/.test(src) && /setState\(/.test(src) && src.includes('syncToolbarButton'),
    `${id}: getState / setState, and setState lights the toolbar button the host draws`);
}

// ── wiring ──
const viewer = read('js/pages/viewer.js');
const compare = read('js/pages/compare.js');
assert.ok(/PluginRegistry\.getSyncState\?\.\(id\)/.test(viewer) && viewer.includes("type: 'SYNC_PLUGIN'"),
  'viewer.js relays the operator\'s own press of a display toggle');
assert.ok(viewer.includes("data.type === 'SYNC_PLUGIN'") && viewer.includes('PluginRegistry.applySyncState?.(data.id, data.group, data.state)'),
  'viewer.js applies a sibling\'s');
assert.ok(viewer.includes("type: 'SYNC_RENDER_MODE'") && viewer.includes("data.type === 'SYNC_RENDER_MODE'"), 'viewer.js sends and receives the render mode');
// A sibling's state is applied without being posted back: only _activateHostPlugin and the select's change event post.
assert.equal((viewer.match(/type: 'SYNC_PLUGIN'/g) || []).length, 1, 'one emitter of SYNC_PLUGIN: the operator\'s press');
assert.equal((viewer.match(/type: 'SYNC_RENDER_MODE'/g) || []).length, 1, 'one emitter of SYNC_RENDER_MODE: the operator\'s change');
assert.ok(/if \(_isIframe && _isInitialized\) _postToHost\(\{ type: 'SYNC_RENDER_MODE'/.test(viewer), 'no render-mode chatter while the page boots');

assert.ok(compare.includes("case 'SYNC_PLUGIN':") && compare.includes("case 'SYNC_RENDER_MODE':"), 'the host relays both');
assert.ok(/_syncOptions = \{[^}]*display: true/.test(compare), 'on by default');
assert.ok(compare.includes("['z', 'time', 'camera', 'channels', 'display']"), 'the checkbox is bound');
assert.ok(/_broadcastVolumes\(data, panel\.index\)/.test(compare), 'relayed to the other volume panels only (a photograph has nothing to draw)');
assert.ok(compare.includes('Object.values(_lastSync.plugins || {})') && compare.includes('_lastSync.SYNC_RENDER_MODE'), 'replayed to a panel that joins later');
assert.ok(compare.includes('_pluginSource[id]') && compare.includes('delete _lastSync.plugins[id]'), 'what a closed panel shared is forgotten');
assert.ok(read('compare.html').includes('id="sync-display"') && read('compare.html').includes('data-i18n="compare.syncDisplay"'), 'compare.html has the checkbox');
for (const code of ['en', 'fr', 'es', 'nl']) {
  const dict = JSON.parse(read(`lang/${code}.json`));
  assert.equal(typeof dict.compare.syncDisplay, 'string', `${code}: compare.syncDisplay`);
  assert.equal(typeof dict.compare.syncDisplayHint, 'string', `${code}: compare.syncDisplayHint`);
}

console.log('compare display sync: OK');
