// Run: node tests/js/test_export_manager_explorer.mjs
//
// Unit tests for the Download Center's file-explorer render helpers
// (ExportManager._explorerRow / _breadcrumbHtml / _iconForExt). These are pure
// string builders; every dataset-supplied field must be HTML-escaped, file rows
// must be real download anchors, and folder rows must navigate (never download).
import assert from 'node:assert/strict';
import { loadModule, escapeHtml } from './harness.mjs';

const Utils = { escapeHtml, formatFileSize: (n) => `${n} B` };

// Minimal DOM/Blob/URL stubs — the helpers under test touch none of them, but
// loadModule runs the whole IIFE, whose _ensureModal/_downloadBlob reference them.
const docStub = {
  querySelector: () => null,
  getElementById: () => null,
  createElement: () => ({
    classList: { add() {}, remove() {} },
    addEventListener() {},
    appendChild() {},
    set innerHTML(_v) {}, get innerHTML() { return ''; }
  }),
  body: { appendChild() {}, classList: { add() {}, remove() {} } }
};

const EM = loadModule('js/core/export-manager.js', 'ExportManager', {
  Utils, window: {}, document: docStub,
  URL: { createObjectURL: () => '', revokeObjectURL() {} }, Blob: function () {}
});

// ── exposed helpers ─────────────────────────────────────────────────────────
assert.equal(typeof EM._explorerRow, 'function', '_explorerRow exposed');
assert.equal(typeof EM._breadcrumbHtml, 'function', '_breadcrumbHtml exposed');
assert.equal(typeof EM._iconForExt, 'function', '_iconForExt exposed');

// ── extension → icon mapping ────────────────────────────────────────────────
assert.equal(EM._iconForExt('csv'), 'table');
assert.equal(EM._iconForExt('IMS'), 'box');        // case-insensitive
assert.equal(EM._iconForExt('glb'), 'shapes');
assert.equal(EM._iconForExt('unknownext'), 'file'); // fallback

// ── file row ────────────────────────────────────────────────────────────────
const fileRow = EM._explorerRow({
  name: 'raw.ims', kind: 'file', ext: 'IMS', sizeBytes: 1024,
  path: 'raw.ims', href: 'DATA_WEB/fixed/Foo/download/raw.ims'
});
assert.ok(fileRow.includes('download>'), 'file row is a download anchor');
assert.ok(fileRow.includes('href="DATA_WEB/fixed/Foo/download/raw.ims"'), 'file row points at href');
assert.ok(fileRow.includes('IMS'), 'file row shows the extension badge');
assert.ok(fileRow.includes('1024 B'), 'file row shows the formatted size');
assert.ok(!fileRow.includes('data-explorer-nav'), 'file row does not navigate');

// ── folder row ──────────────────────────────────────────────────────────────
const dirRow = EM._explorerRow({ name: 'images', kind: 'dir', path: 'images', count: 3 });
assert.ok(dirRow.includes('data-explorer-nav="images"'), 'folder row navigates to its path');
assert.ok(dirRow.includes('3 items'), 'folder row shows its child count');
assert.ok(!dirRow.includes('download>'), 'folder row is not a download anchor');

// ── XSS: malicious filename/path/href must be escaped in every interpolation ──
const evil = '"><img src=x onerror=alert(1)>';
const evilRow = EM._explorerRow({ name: evil, kind: 'file', ext: 'PNG', path: evil, href: evil });
assert.ok(!evilRow.includes('<img src=x'), 'raw HTML breakout must be escaped (file)');
assert.ok(evilRow.includes('&quot;&gt;&lt;img'), 'escaped payload present (file)');

const evilDir = EM._explorerRow({ name: evil, kind: 'dir', path: evil, count: 1 });
assert.ok(!evilDir.includes('<img src=x'), 'raw HTML breakout must be escaped (folder)');

// ── breadcrumb ──────────────────────────────────────────────────────────────
const bc = EM._breadcrumbHtml('a/b');
assert.ok(bc.includes('data-explorer-nav=""'), 'breadcrumb has a root crumb');
assert.ok(bc.includes('data-explorer-nav="a"'), 'breadcrumb has the first segment');
assert.ok(bc.includes('data-explorer-nav="a/b"'), 'breadcrumb accumulates the path');

const bcEvil = EM._breadcrumbHtml('"><script>x</script>');
assert.ok(!bcEvil.includes('<script>'), 'breadcrumb escapes segment text');

console.log('test_export_manager_explorer: OK');
