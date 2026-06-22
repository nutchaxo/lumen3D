// Regression tests for bugs found reviewing PR #55 (plugin system autonomy, v1.1.0):
//   #1 (tool-manager) 'c'/'m' shortcuts went dead on pages that don't load
//      PluginRegistry (tracking.html) — the shortcut table became PluginRegistry-seeded.
//   #2 (deepzoom-2d) toolbar button visual state desynced on non-toolbar exit paths
//      (Escape / dz-exit / failed load) because _enter/_exit only touched `active`
//      while bindToolbarButtons toggles btn-solid/btn-ghost.
//   #6 (viewer.js) btn-export was double-wired (manual handler + download-center plugin).
//
// Run: node tests/js/test_plugin_review_fixes.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// ── #1: ToolManager shortcuts work WITHOUT PluginRegistry (tracking.html scenario) ──
{
  const mkBtn = (tool) => ({ dataset: { tool }, disabled: false, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } });
  const btns = ['navigate', 'cut', 'measure'].map(mkBtn);
  let keydown = null;
  const doc = {
    body: { dataset: {} },
    addEventListener: (ev, fn) => { if (ev === 'keydown') keydown = fn; },
    querySelectorAll: (sel) => (sel === '[data-tool]' ? btns : []),
    querySelector: (sel) => {
      const m = /data-tool="([^"]+)"/.exec(sel);
      return m ? (btns.find(b => b.dataset.tool === m[1]) || null) : null;
    },
  };
  // PluginRegistry intentionally absent from the sandbox (tracking.html does not load it).
  const TM = loadModule('js/core/tool-manager.js', 'ToolManager', { document: doc });
  const activated = [];
  TM.init({ onChange: (t) => activated.push(t), defaultTool: 'navigate' });
  assert.ok(typeof keydown === 'function', 'keydown handler installed');
  keydown({ key: 'c', target: { tagName: 'DIV' } });
  keydown({ key: 'm', target: { tagName: 'DIV' } });
  assert.ok(activated.includes('cut'), "#1: 'c' activates the cut tool without PluginRegistry");
  assert.ok(activated.includes('measure'), "#1: 'm' activates the measure tool without PluginRegistry");

  // and a shortcut for a tool with no button on this page is a harmless no-op
  const before = activated.length;
  keydown({ key: 'z', target: { tagName: 'DIV' } }); // no mapping
  assert.equal(activated.length, before, 'unmapped key is a no-op');

  const src = read('js/core/tool-manager.js');
  assert.ok(/_shortcuts = \{[^}]*c: 'cut'[^}]*m: 'measure'/.test(src), "#1: core c/m shortcuts seeded independent of PluginRegistry");
}

// ── #2: deepzoom-2d _enter/_exit keep btn-solid/btn-ghost in sync with bindToolbarButtons ──
{
  const dz = read('js/modules/tools/deepzoom-2d/index.js');
  assert.ok(/classList\.add\('active', 'btn-solid'\);\s*btn\.classList\.remove\('btn-ghost'\)/.test(dz),
    '#2: _enter adds active+btn-solid and removes btn-ghost');
  assert.ok(/classList\.remove\('active', 'btn-solid'\);\s*btn\.classList\.add\('btn-ghost'\)/.test(dz),
    '#2: _exit removes active+btn-solid and restores btn-ghost (every exit path symmetric)');
}

// ── #6: viewer.js no longer double-wires btn-export (plugin handles it) ──
{
  const v = read('js/pages/viewer.js');
  assert.ok(!/getElementById\('btn-export'\)\?\.addEventListener/.test(v),
    '#6: manual btn-export click handler removed (download-center plugin opens the modal)');
}

console.log('plugin-autonomy review fixes (#1 shortcuts, #2 deepzoom state, #6 export double-wire): OK');
