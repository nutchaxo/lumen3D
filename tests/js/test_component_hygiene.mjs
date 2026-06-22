// Unit/structural tests for the component-hygiene batch:
//   LEAK-020 MeasurementStore._state Map grew one entry per (scope,dataset), never purged
//   LEAK-016 ChannelPanel registered a document 'click' listener with no teardown
//   BUG-044  ChannelPanel.setState could push max to 1.01 (>1) when min===1.0
//   BUG-070  ChannelPanel.init wrote _container.innerHTML='' then immediately overwrote it
//
// Run: node tests/js/test_component_hygiene.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── LEAK-020: MeasurementStore dropDataset / reset (vm behavioral) ──
{
  const MS = loadModule('js/core/measurement-store.js', 'MeasurementStore', { console });
  MS.add('A', 'viewer', { distance: 5 });
  MS.add('B', 'viewer', { distance: 6 });
  assert.equal(MS.list('A', 'viewer').length, 1, 'A has one measurement');
  assert.equal(MS.dropDataset('A', 'viewer'), true, 'LEAK-020: dropDataset removes the Map entry');
  assert.equal(MS.list('A', 'viewer').length, 0, 'LEAK-020: dropped dataset is gone');
  assert.equal(MS.list('B', 'viewer').length, 1, 'LEAK-020: sibling dataset untouched');
  MS.reset();
  assert.equal(MS.list('B', 'viewer').length, 0, 'LEAK-020: reset purges everything');
  assert.equal(typeof MS.dropDataset, 'function', 'dropDataset exported');
  assert.equal(typeof MS.reset, 'function', 'reset exported');
}

// ── channel-panel structural (DOM-bound, not vm-loadable for behaviour) ──
{
  const src = readFileSync(path.join(ROOT, 'js/components/channel-panel.js'), 'utf8');

  // BUG-070
  assert.ok(!/_container\.innerHTML = '';/.test(src), 'BUG-070: redundant innerHTML="" removed');

  // BUG-044
  assert.ok(/Math\.min\(_clamp01\(item\.min[^\n]*\), 0\.99\)/.test(src), 'BUG-044: min capped at 0.99');
  assert.ok(/_clamp01\(Math\.max\(_clamp01\(item\.max/.test(src), 'BUG-044: max re-clamped into [0,1]');

  // LEAK-016
  assert.ok(/const _onDocClick =/.test(src), 'LEAK-016: doc click handler is a named const');
  assert.ok(/document\.removeEventListener\('click', _onDocClick\)/.test(src), 'LEAK-016: handler removable in dispose');
  assert.ok(/addEventListener\('pagehide', dispose\)/.test(src), 'LEAK-016: dispose wired to pagehide teardown');
  const ret = src.slice(src.lastIndexOf('return {'));
  assert.ok(/\bdispose\b/.test(ret), 'LEAK-016: dispose exposed on the public API');
}

console.log('component hygiene (LEAK-016/020, BUG-044/070): OK');
