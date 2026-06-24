// Run: node tests/js/test_export_manager_scope.mjs
//
// Guards the scope-aware Download Center render (regression caught in review):
//   - viewer / explorer scope  → the file explorer (download/ folder)
//   - tracking / compare scope → the export-buttons modal, INCLUDING the
//     page-supplied custom exports (tracking measurements, compare composites)
// A previous redesign dropped the custom-export path wholesale, silently
// breaking the Tracking and Compare Download Centers. This locks it down.
import assert from 'node:assert/strict';
import { loadModule, escapeHtml } from './harness.mjs';

const Utils = { escapeHtml, formatFileSize: (n) => `${n} B` };

// A DOM element stub that captures innerHTML so we can assert on the render.
function makeEl() {
  let html = '';
  return {
    set innerHTML(v) { html = v; }, get innerHTML() { return html; },
    className: '', classList: { add() {}, remove() {} },
    addEventListener() {}, appendChild() {}, querySelector() { return null; },
  };
}

const body = makeEl();
const docStub = {
  createElement: () => makeEl(),
  getElementById: (id) => (id === 'download-body' ? body : null),
  querySelector: () => null,
  body: { appendChild() {}, classList: { add() {}, remove() {} } },
};

const EM = loadModule('js/core/export-manager.js', 'ExportManager', {
  Utils, window: {}, document: docStub,
  URL: { createObjectURL: () => '', revokeObjectURL() {} }, Blob: function () {},
});

// ── tracking scope keeps its custom exports + the generated-export section ──
EM.openDownloadCenter({
  scope: 'tracking',
  getGraph: () => null,
  getCustomExports: () => [
    { action: 'tracking-measure-csv', label: 'Tracking measurements (CSV)', handler() {} },
  ],
});
assert.ok(body.innerHTML.includes('export-quick-actions'),
  'tracking scope renders the generated-export buttons, not the file explorer');
assert.ok(body.innerHTML.includes('data-export-action="tracking-measure-csv"'),
  'tracking scope surfaces page-supplied custom exports (regression guard)');
assert.ok(!body.innerHTML.includes('id="download-explorer"'),
  'tracking scope does not show the file explorer');

// ── compare scope (no dataset) still surfaces its custom figure exports ──
EM.openDownloadCenter({
  scope: 'compare',
  dataset: null,
  getCustomExports: () => [
    { action: 'compare-figure-png', label: 'Compare PNG', handler() {} },
  ],
});
assert.ok(body.innerHTML.includes('data-export-action="compare-figure-png"'),
  'compare scope (no dataset) still renders its custom exports, not an empty modal');

// ── viewer scope with a dataset shows the file explorer, not custom exports ──
EM.openDownloadCenter({
  scope: 'viewer',
  dataset: { name: 'DS', path: 'fixed/DS' },
  getCustomExports: () => [{ action: 'should-not-render', label: 'x', handler() {} }],
});
assert.ok(body.innerHTML.includes('id="download-explorer"'),
  'viewer scope renders the file explorer');
assert.ok(!body.innerHTML.includes('should-not-render'),
  'viewer scope does not render generated/custom export buttons');

console.log('test_export_manager_scope: OK');
