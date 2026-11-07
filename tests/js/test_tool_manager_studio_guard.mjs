// ToolManager steps back from the keyboard while the Studio overlay is open: the
// Studio's own letters (v, d) and Escape must not switch the page's tool underneath.
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

function makeDocument() {
  const listeners = {};
  const buttons = ['navigate', 'slice', 'measure-distance', 'cut', 'measure'].map(tool => ({
    dataset: { tool },
    disabled: false,
    classList: { toggle() {} },
    addEventListener() {},
  }));
  return {
    body: { dataset: {} },
    listeners,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    querySelectorAll(sel) { return sel === '[data-tool]' ? buttons : []; },
    querySelector(sel) {
      const m = /^\[data-tool="(.+)"\]$/.exec(sel);
      return m ? buttons.find(b => b.dataset.tool === m[1]) || null : null;
    },
  };
}

function keydown(doc, key) {
  for (const fn of doc.listeners.keydown || []) {
    fn({ key, ctrlKey: false, metaKey: false, altKey: false, repeat: false, target: { tagName: 'CANVAS' } });
  }
}

const document = makeDocument();
let studioOpen = false;
const StudioEditor = { isOpen: () => studioOpen };
const PluginRegistry = {
  listByPlacement: () => [
    { id: 'slice-inspector', subtype: 'tool', tool: 'slice', shortcut: 'c' },
    { id: 'measure-distance', subtype: 'tool', tool: 'measure-distance', shortcut: 'm' },
  ],
};
const ToolManager = loadModule('js/core/tool-manager.js', 'ToolManager', { document, StudioEditor, PluginRegistry });
assert.ok(ToolManager, 'ToolManager loads');

const changes = [];
ToolManager.init({ defaultTool: 'navigate', onChange: tool => changes.push(tool) });

keydown(document, 'c');
assert.equal(ToolManager.current(), 'slice', 'shortcut works with the Studio closed');
assert.deepEqual(changes, ['slice']);

studioOpen = true;
for (const key of ['v', 'V', 'Escape', 'm', 'c', 'd']) keydown(document, key);
assert.equal(ToolManager.current(), 'slice', 'the Studio keeps the page tool untouched');
assert.deepEqual(changes, ['slice'], 'no onChange while the Studio is open');

studioOpen = false;
keydown(document, 'Escape');
assert.equal(ToolManager.current(), 'navigate', 'shortcuts resume once the Studio closes');
assert.deepEqual(changes, ['slice', 'navigate']);

// A page without the Studio loaded keeps its shortcuts.
const doc2 = makeDocument();
const TM2 = loadModule('js/core/tool-manager.js', 'ToolManager', { document: doc2 });
const changes2 = [];
TM2.init({ onChange: tool => changes2.push(tool) });
keydown(doc2, 'm');
assert.equal(TM2.current(), 'measure');
keydown(doc2, 'v');
assert.deepEqual(changes2, ['measure', 'navigate']);

console.log('test_tool_manager_studio_guard: OK');
