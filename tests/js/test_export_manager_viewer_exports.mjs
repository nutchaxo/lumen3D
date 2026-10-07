// Run: node tests/js/test_export_manager_viewer_exports.mjs
//
// The viewer's Download Center lists what the page and its plugins generate
// (PluginRegistry.collect('getExports') through viewer.js `_getAllCustomExports`,
// and a plugin's on-screen chart through `getGraph`) above the dataset's file
// explorer. Before this section the tracking plugins' exports (cell distances,
// neighbour tables, lineages, charts) were collected and never shown.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadModule, escapeHtml, ROOT } from './harness.mjs';

const Utils = { escapeHtml, formatFileSize: (n) => `${n} B` };

function makeEl() {
  let html = '';
  const listeners = {};
  return {
    listeners,
    set innerHTML(v) { html = v; }, get innerHTML() { return html; },
    className: '', classList: { add() {}, remove() {} },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    appendChild() {}, querySelector() { return null; },
  };
}

const body = makeEl();
let modal = null;
const docStub = {
  createElement: () => (modal = makeEl()),
  getElementById: (id) => (id === 'download-body' ? body : null),
  querySelector: () => null,
  addEventListener() {}, removeEventListener() {},
  body: { appendChild() {}, classList: { add() {}, remove() {} } },
};
const win = {};
const EM = loadModule('js/core/export-manager.js', 'ExportManager', {
  Utils, window: win, document: docStub,
  URL: { createObjectURL: () => '', revokeObjectURL() {} }, Blob: function () {},
});

// A click on an element carrying data-export-action, as the modal's delegate sees it.
function click(action) {
  const target = {
    closest(sel) {
      if (sel === '[data-export-action]') return { dataset: { exportAction: action } };
      return null;
    },
  };
  modal.listeners.click.forEach(fn => fn({ target, preventDefault() {} }));
}

const dataset = { name: 'Live DS', path: 'live/DS', type: 'live' };
const ran = [];
const trackingExports = [
  { action: 'tracking-measure-csv', icon: 'ruler', label: 'Cell distances CSV', enabled: true, handler: () => ran.push('measure') },
  { action: 'tracking-neighbors-csv', icon: 'network', label: 'Neighbours <CSV>', enabled: false, handler: () => ran.push('neighbors') },
  { action: 'tracking-measure-csv', label: 'duplicate', handler: () => ran.push('dup') },
  { action: 'no-handler', label: 'Dead entry' },
  null,
];

// ── plugin exports listed above the file explorer, which stays ──
EM.openDownloadCenter({
  scope: 'viewer',
  dataset,
  getCustomExports: () => trackingExports,
  getGraph: () => null,
  getMeasurements: () => [{ id: 1 }],
});
let html = body.innerHTML;
assert.ok(html.includes('dl-section-analysis'), 'viewer scope renders the analysis-exports section');
assert.ok(html.includes('id="download-explorer"'), 'the file explorer is kept');
assert.ok(html.indexOf('dl-section-analysis') < html.indexOf('id="download-explorer"'),
  'analysis exports come before the file explorer');
assert.ok(html.includes('data-export-action="tracking-measure-csv"'), 'enabled plugin export listed');
assert.ok(/data-export-action="tracking-neighbors-csv"\s+disabled title="Export unavailable"/.test(html),
  'a disabled plugin export is listed disabled, with the reason');
assert.ok(html.includes('Neighbours &lt;CSV&gt;'), 'labels are escaped');
assert.equal(html.split('data-export-action="tracking-measure-csv"').length - 1, 1, 'one button per action');
assert.ok(!html.includes('no-handler'), 'an entry without a handler is not offered');
assert.ok(!html.includes('data-export-action="graph-png"'), 'no graph buttons without a chart on screen');
assert.ok(!html.includes('data-export-action="measures-csv"'),
  'the generic Measurements CSV button gives way to the page\'s own export list');

click('tracking-measure-csv');
assert.deepEqual(ran, ['measure'], 'a click runs the plugin handler (the first entry of that action)');

// ── a chart on screen adds the graph exports (Plotly loaded) ──
win.Plotly = {};
EM.openDownloadCenter({
  scope: 'viewer',
  dataset,
  getCustomExports: () => [],
  getGraph: () => ({ data: [] }),
  getMeasurements: () => [],
});
html = body.innerHTML;
assert.ok(html.includes('dl-section-analysis'), 'a chart alone is enough for the section');
for (const action of ['graph-png', 'graph-svg', 'graph-csv']) {
  assert.ok(new RegExp(`data-export-action="${action}"\\s*>`).test(html), `${action} offered and enabled`);
}

// ── a throwing getGraph never breaks the Download Center ──
EM.openDownloadCenter({
  scope: 'viewer', dataset,
  getCustomExports: () => [], getGraph: () => { throw new Error('boom'); }, getMeasurements: () => [],
});
assert.ok(body.innerHTML.includes('id="download-explorer"'), 'explorer still rendered when getGraph throws');
assert.ok(!body.innerHTML.includes('dl-section-analysis'), 'nothing to export ⇒ no section');
delete win.Plotly;

// ── a page without its own export list keeps the Measurements CSV button ──
EM.openDownloadCenter({
  scope: 'explorer', dataset,
  getCustomExports: undefined, getGraph: undefined, getMeasurements: () => [{ id: 1 }],
});
html = body.innerHTML;
assert.ok(html.includes('data-export-action="measures-csv"'), 'Measurements CSV button kept without a page export list');
assert.ok(!html.includes('dl-section-analysis'), 'no analysis section without exports');

// ── the new strings exist in every locale ──
for (const code of ['en', 'fr', 'es', 'nl']) {
  const lang = JSON.parse(readFileSync(path.join(ROOT, 'lang', `${code}.json`), 'utf8'));
  for (const key of ['analysisTitle', 'analysisHint', 'graphPng', 'graphSvg', 'graphCsv', 'exportUnavailable']) {
    assert.equal(typeof lang.download?.[key], 'string', `lang/${code}.json has download.${key}`);
  }
}

// ── the viewer feeds both hooks into the Download Center it opens ──
const dc = readFileSync(path.join(ROOT, 'js/modules/tools/download-center/index.js'), 'utf8');
assert.ok(/getCustomExports:\s*this\._ctx\.getCustomExports/.test(dc), 'download-center passes getCustomExports');
assert.ok(/getGraph:\s*this\._ctx\.getGraph/.test(dc), 'download-center passes getGraph');
const viewer = readFileSync(path.join(ROOT, 'js/pages/viewer.js'), 'utf8');
assert.ok(/PluginRegistry\.collect\('getExports'\)/.test(viewer), 'viewer collects the plugins\' getExports()');

console.log('test_export_manager_viewer_exports: OK');
