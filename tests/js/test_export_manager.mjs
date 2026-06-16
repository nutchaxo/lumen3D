// Unit test for ELE-02 / SEC-004: export-manager._itemHtml must HTML-escape
// item.path inside the href attribute (it was interpolated raw, allowing
// attribute breakout / HTML injection).
//
// Run: node tests/js/test_export_manager.mjs
import assert from 'node:assert/strict';
import { loadModule, escapeHtml } from './harness.mjs';

const Utils = { escapeHtml, formatFileSize: () => '1 KB' };
const docStub = {
  querySelector: () => null,
  createElement: () => ({ classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {}, style: {}, click() {} }),
  body: { appendChild() {} },
};
const EM = loadModule('js/core/export-manager.js', 'ExportManager', {
  Utils, window: {}, document: docStub,
  URL: { createObjectURL: () => '', revokeObjectURL() {} }, Blob: function () {},
});

assert.ok(EM && typeof EM._itemHtml === 'function', 'ExportManager._itemHtml must be exposed');

const evil = '"><img src=x onerror=alert(1)>';
const html = EM._itemHtml({ path: evil, label: 'Lbl', format: 'PNG' });

assert.ok(!html.includes('onerror=alert(1)>'), 'raw injected markup must not survive');
assert.ok(!html.includes('"><img'), 'attribute breakout sequence must be escaped');
assert.ok(html.includes('href="&quot;&gt;&lt;img'), 'item.path must be HTML-escaped in href');

// a benign path still renders correctly
const ok = EM._itemHtml({ path: 'DATA_WEB/fixed/x/vol.bin', label: 'Vol', format: 'BIN' });
assert.ok(ok.includes('href="DATA_WEB/fixed/x/vol.bin"'), 'benign path renders unchanged');

console.log('ELE-02 export-manager href escaping: OK');
