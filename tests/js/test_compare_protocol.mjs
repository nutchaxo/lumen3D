// Structural tests for the Compare page ↔ panel protocol.
//
// compare.html mounts viewer.html / 2d.html in iframes and drives them by
// postMessage. Every message the host sends must have a receiver in BOTH pages
// (or be volume-only by design), every message a page sends to its host must be
// handled by compare.js, and nothing may post to the wildcard origin. The
// three files touch the DOM at load, so this reads the sources.
//
// Run: node tests/js/test_compare_protocol.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r/g, '');
const compare = read('js/pages/compare.js');
const viewer = read('js/pages/viewer.js');
const page2d = read('js/pages/2d.js');
const html = read('compare.html');

const types = (src, re) => new Set(Array.from(src.matchAll(re), m => m[1]));

// ── host → panel ──
const hostSends = types(compare, /type: '([A-Z_]+)'/g);
// Volume-only messages: a photograph has no z-stack, channels or quality levels.
const volumeOnly = new Set(['TOGGLE_ZSTACK', 'ZSTACK_HOVER_STATE', 'SET_CHANNEL_ACTIVE', 'SET_QUALITY', 'SYNC_CAMERA', 'SYNC_TIME', 'SYNC_CHANNELS', 'SYNC_EXPOSURE', 'SYNC_Z', 'SYNC_ZSTACK_SLICE', 'SYNC_SLICER_SPEC']);
// Photograph-only.
const photoOnly = new Set(['WM_SET_PHYSICAL_VIEW']);
for (const t of hostSends) {
  const inViewer = viewer.includes(`'${t}'`);
  const in2d = page2d.includes(`'${t}'`);
  if (photoOnly.has(t)) assert.ok(in2d, `2d.js receives ${t}`);
  else if (volumeOnly.has(t)) assert.ok(inViewer, `viewer.js receives ${t}`);
  else assert.ok(inViewer && in2d, `both pages receive ${t}`);
}
for (const must of ['PANEL_HELLO', 'SET_TOOL', 'PLUGIN_ACTIVATE', 'TOGGLE_SIDEBAR', 'APPLY_WORKSPACE_STATE', 'SET_QUALITY', 'TOGGLE_ZSTACK']) {
  assert.ok(hostSends.has(must), `host sends ${must}`);
}

// ── panel → host ──
const handled = types(compare, /case '([A-Z_]+)'/g);
for (const src of [viewer, page2d]) {
  const sent = new Set([
    ...types(src, /_postToHost\(\{ type: '([A-Z_]+)'/g),
    ...types(src, /window\.parent\.postMessage\(\{ type: '([A-Z_]+)'/g),
    ...types(src, /window\.parent\.postMessage\(\{\s*type: '([A-Z_]+)'/g),
  ]);
  // A tracking plugin's own admin messages are not this wire.
  for (const t of sent) {
    if (t === 'ORIENTATION_RESULT' || t === 'SCREENSHOT_RESPONSE') continue;
    assert.ok(handled.has(t), `compare.js handles ${t}`);
  }
}
for (const must of ['PANEL_READY', 'PANEL_ERROR', 'PANEL_DATASET', 'PLUGIN_STATE', 'TOOL_CHANGED', 'QUALITY_STATUS', 'WM_PHYSICAL_VIEW', 'SYNC_CAMERA', 'SYNC_TIME', 'SYNC_CHANNELS', 'SYNC_EXPOSURE', 'SYNC_Z', 'SYNC_ZSTACK_SLICE', 'SYNC_SLICER_SPEC', 'SIDEBAR_CLOSED', 'REQUEST_COMPARE_STUDIO']) {
  assert.ok(handled.has(must), `compare.js handles ${must}`);
}
// Both pages announce themselves, hand the host their toolbar, and fail loudly.
for (const [name, src] of [['viewer.js', viewer], ['2d.js', page2d]]) {
  assert.ok(src.includes("type: 'PANEL_READY'") && src.includes('describeToolbar'), `${name} sends PANEL_READY with its toolbar`);
  assert.ok(src.includes("type: 'PANEL_ERROR'"), `${name} sends PANEL_ERROR`);
  assert.ok(src.includes("type: 'PLUGIN_STATE'") && src.includes('onToolbarState'), `${name} relays toolbar state`);
  assert.ok(src.includes("context: ") && src.includes("'panel'"), `${name} loads its plugins with the hosting context`);
}
assert.ok(page2d.includes('getWorkspaceState') && page2d.includes('applyWorkspaceState') && page2d.includes('getStudioSliceResult'),
  'App2D exposes the workspace and Studio API the host uses');

// ── SEC-012: never the wildcard origin, in either direction ──
assert.equal((compare.match(/postMessage\([^;]*'\*'\)/g) || []).length, 0, 'compare.js never posts to *');
assert.ok(compare.includes('Utils.trustedTargetOrigin()'), 'compare.js posts to its own origin');
assert.equal((page2d.match(/postMessage\([^;]*'\*'\)/g) || []).length, 0, '2d.js never posts to *');

// ── the dead high-detail handshake is gone for good ──
for (const dead of ['START_HIGH_DETAIL', 'deferHighQuality', 'panelPriority', 'activePanels=', 'quality=auto']) {
  assert.ok(!compare.includes(dead), `compare.js no longer uses ${dead}`);
}

// ── page ──
assert.ok(!/IRIBHM compare/.test(compare), 'white-label: no hardcoded brand in the figure stamp');
assert.ok(compare.includes("InstanceConfig.get('brand.name'"), 'figure stamp reads the instance brand');
assert.ok(html.includes('id="lang-dropdown"'), 'compare.html has the language switcher');
assert.ok(html.includes('id="compare-tool-chips"') && html.includes('id="compare-quality"') && html.includes('id="btn-compare-studio"'), 'toolbar hooks');
assert.ok(html.includes('id="modal-search"') && html.includes('id="modal-type-chips"'), 'dataset picker filters');
assert.ok(!/onclick=/.test(html), 'no inline handlers (CSP)');
for (const key of ['compare.addDataset', 'compare.decompose', 'compare.export', 'compare.save', 'compare.restore', 'compare.syncZ', 'compare.syncTime', 'compare.syncCamera', 'compare.syncChannels', 'compare.studio', 'compare.qualityAuto']) {
  assert.ok(html.includes(`data-i18n="${key}"`), `compare.html translates ${key}`);
}

// ── locale parity for every compare.* key the page or its controller uses ──
{
  const en = JSON.parse(read('lang/en.json'));
  const used = new Set([
    ...Array.from(html.matchAll(/data-i18n(?:-title|-aria|-placeholder)?="(compare\.[a-zA-Z]+)"/g), m => m[1]),
    ...Array.from(compare.matchAll(/_t\('(compare\.[a-zA-Z]+)'/g), m => m[1]),
  ]);
  assert.ok(used.size >= 25, `the page uses a real set of compare.* keys (${used.size})`);
  for (const code of ['en', 'fr', 'es', 'nl']) {
    const dict = JSON.parse(read(`lang/${code}.json`));
    for (const key of used) {
      const v = key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), dict);
      assert.equal(typeof v, 'string', `${code}: ${key} translated`);
    }
  }
  assert.ok(en.compare.syncCamera !== 'Camera (3D)', 'the camera sync now also covers photographs');
}

// ── behaviour: the origin guard and the panel identity guard (vm) ──
{
  const ORIGIN = 'https://lab.example';
  const Utils = loadModule('js/core/utils.js', 'Utils', {
    window: { location: { origin: ORIGIN } }, document: {}, requestAnimationFrame: () => {},
  });
  const docStub = {
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    createElement: () => ({ classList: { add() {}, remove() {}, toggle() {} }, style: {}, appendChild() {}, dataset: {} }),
    body: { appendChild() {} },
  };
  const CompareApp = loadModule('js/pages/compare.js', 'CompareApp', {
    window: { location: { origin: ORIGIN }, addEventListener() {}, postMessage() {} },
    document: docStub, Utils, requestAnimationFrame: () => {}, setTimeout, clearTimeout,
  });
  // A message from a frame that is not one of the panels never reaches a handler.
  let touched = false;
  CompareApp._handleIframeMessage({ origin: ORIGIN, data: { type: 'PANEL_READY', sourceIndex: '7', get toolbar() { touched = true; return {}; } } });
  assert.equal(touched, false, 'unknown panel index is ignored');
}

console.log('compare ↔ panel protocol: OK');
