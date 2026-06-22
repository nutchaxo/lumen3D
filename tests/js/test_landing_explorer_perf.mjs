// Tests for the landing/explorer dedup + perf batch:
//   DEAD-035 toggleDropdown/switchLanguage duplicated -> shared Utils helpers
//   PERF-028 filter re-render did two innerHTML passes (mojibake repair) -> one write
//   PERF-031 hero O(n^2) connection sweep every frame (sqrt per pair, runs when hidden)
//   EDGE-045 thumbnail ?v=Date.now() cache-buster disabled browser caching
//
// utils.js is vm-loadable (behavioral); landing.js/explorer.js touch the DOM at load
// (structural read-asserts) + node --check.
//
// Run: node tests/js/test_landing_explorer_perf.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// ── DEAD-035: shared Utils.toggleDropdown / closeDropdowns (vm behavioral) ──
{
  let open = false;
  const el = {
    classList: { toggle: () => { open = !open; }, remove: () => { open = false; }, add: () => { open = true; }, contains: () => false },
    contains: () => false,
  };
  const U = loadModule('js/core/utils.js', 'Utils', {
    window: { location: { origin: 'http://x' } },
    document: { getElementById: () => el, querySelectorAll: () => [el], addEventListener() {}, removeEventListener() {} },
    setTimeout: () => {},   // swallow the deferred outside-click installer
    requestAnimationFrame: () => {},
  });
  assert.equal(typeof U.toggleDropdown, 'function', 'DEAD-035: Utils.toggleDropdown exported');
  assert.equal(typeof U.closeDropdowns, 'function', 'DEAD-035: Utils.closeDropdowns exported');
  U.toggleDropdown('lang-dropdown');
  assert.equal(open, true, 'DEAD-035: toggleDropdown opens the menu');
  U.closeDropdowns();
  assert.equal(open, false, 'DEAD-035: closeDropdowns clears open state');
}

// ── landing.js ──
{
  const s = read('js/pages/landing.js');
  // DEAD-035: page handlers delegate to Utils (no duplicated body)
  assert.ok(/Utils\.toggleDropdown\(id\)/.test(s), 'DEAD-035: landing toggleDropdown delegates to Utils');
  assert.ok(/Utils\.closeDropdowns\(\)/.test(s), 'DEAD-035: landing switchLanguage uses Utils.closeDropdowns');
  // PERF-028: a single innerHTML write (no second mojibake-repair pass)
  assert.ok(!/grid\.innerHTML = grid\.innerHTML/.test(s), 'PERF-028: second innerHTML repair pass removed');
  assert.ok(/&middot;/.test(s) && /&times;/.test(s), 'PERF-028: separators emitted as HTML entities at source');
  // PERF-031: skip-when-hidden + squared distance
  assert.ok(/!document\.hidden/.test(s), 'PERF-031: hero loop skips work while tab hidden');
  assert.ok(/maxDistSq/.test(s) && /Math\.sqrt\(distSq\)/.test(s), 'PERF-031: squared-distance gate before sqrt');
}

// ── explorer.js ──
{
  const s = read('js/pages/explorer.js');
  assert.ok(/Utils\.toggleDropdown\(id\)/.test(s), 'DEAD-035: explorer toggleDropdown delegates to Utils');
  assert.ok(/Utils\.closeDropdowns\(\)/.test(s), 'DEAD-035: explorer switchLanguage uses Utils.closeDropdowns');
  assert.ok(!/container\.innerHTML = container\.innerHTML/.test(s), 'PERF-028: second innerHTML repair pass removed');
  assert.equal((s.match(/Date\.now\(\)/g) || []).length, 0, 'EDGE-045: thumbnail ?v=Date.now() cache-buster removed');
  assert.ok(/&middot;/.test(s), 'PERF-028: explorer separator emitted as entity');
}

console.log('landing/explorer dedup + perf (DEAD-035, PERF-028/031, EDGE-045): OK');
