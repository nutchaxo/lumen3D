// Tests for the misc-core batch:
//   EDGE-031 VolumeSourceManager.normalizeSources accepted unknown kind / bad path
//   BUG-031  measure-distance kept a manual mirror push instead of re-reading the store
//   BUG-069  orientation-axes per-frame _update had a dead empty forEach
//   PERF-012 histogram slider drag fired onStateChange per pointermove (undebounced)
//
// volume-source-manager.js is vm-loadable (behavioral); the module index.js files
// touch THREE/DOM at load (structural + node --check).
//
// Run: node tests/js/test_misc_core_robustness.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// ── EDGE-031: normalizeSources rejects unhandleable entries (vm behavioral) ──
{
  const VSM = loadModule('js/core/volume-source-manager.js', 'VolumeSourceManager', { console });
  // unknown kind dropped; valid one kept
  const mixed = VSM.normalizeSources({ volumeSources: [
    { kind: 'bricks', path: 'a/b' },
    { kind: 'quantum-foam', path: 'x' },          // unknown -> dropped
    { kind: 'webstack', path: { not: 'a string' } }, // bad path -> dropped
  ] });
  assert.deepEqual(mixed.map(s => s.kind), ['bricks'], 'EDGE-031: only the handleable source survives');
  // all-invalid -> falls back to the default webstack source (never empty)
  const fallback = VSM.normalizeSources({ path: 'ds1', volumeSources: [{ kind: 'bogus' }] });
  assert.equal(fallback.length, 1, 'EDGE-031: falls back to a default source when none valid');
  assert.equal(fallback[0].kind, 'webstack', 'EDGE-031: fallback is the webstack default');
  // no volumeSources -> default (regression)
  assert.equal(VSM.normalizeSources({ path: 'ds2' })[0].kind, 'webstack', 'default path unchanged');
}

// ── BUG-031: measure-distance re-reads the store (no manual mirror push) ──
{
  const s = read('js/modules/tools/measure-distance/index.js');
  assert.ok(!/this\._measurements\.push\(/.test(s), 'BUG-031: manual mirror push removed');
  // the create path re-reads the store after add()
  const seg = s.slice(s.indexOf('measurements.add('), s.indexOf('measurements.add(') + 800);
  assert.ok(/this\._measurements = this\._ctx\.measurements\.list\('viewer'\)/.test(seg),
    'BUG-031: mirror re-read from the store after add()');
}

// ── BUG-069: orientation-axes dead forEach removed ──
{
  const s = read('js/modules/tools/orientation-axes/index.js');
  const upd = s.slice(s.indexOf('_update()'), s.indexOf('_update()') + 700);
  assert.ok(!/children\.forEach/.test(upd), 'BUG-069: dead per-frame forEach removed from _update');
  assert.ok(!/const invCam =/.test(upd), 'BUG-069: unused invCam removed');
}

// ── PERF-012: histogram drag coalesced into a single rAF ──
{
  const s = read('js/modules/channels/histogram/index.js');
  assert.ok(/requestAnimationFrame\(\(\) => \{ _rafId = 0; apply\(_latestX\)/.test(s),
    'PERF-012: drag updates coalesced into one rAF');
  assert.ok(/cancelAnimationFrame\(_rafId\)/.test(s) && /if \(_latestX != null\) apply\(_latestX\)/.test(s),
    'PERF-012: pointerup cancels pending rAF and flushes the final value');
}

console.log('misc-core robustness (EDGE-031, BUG-031, BUG-069, PERF-012): OK');
