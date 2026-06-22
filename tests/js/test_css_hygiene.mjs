// Structural tests for the CSS hygiene batch. CSS rendering cannot be unit-verified
// without a browser, so these lock the *mechanism*: DEAD-025 z-index values are
// preserved exactly (no stacking change) and PERF-034 shimmer is compositor-driven.
// NOTE: the visual result of PERF-034 still warrants a quick browser glance.
//   DEAD-025 raw giant z-index literals -> centralized value-identical --z-* tokens
//   PERF-034 shimmer keyframes animate transform (overlay) instead of background-position
//
// Run: node tests/js/test_css_hygiene.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// ── DEAD-025: tokens defined with the EXACT old values, no raw giant literals left ──
{
  const vars = read('css/variables.css');
  const expected = {
    '--z-viewer-base': '1000', '--z-viewer-raised': '1010', '--z-viewer-elevated': '1100',
    '--z-admin-overlay': '9998', '--z-viewer-popover': '9999', '--z-viewer-modal': '10000',
    '--z-viewer-modal-top': '10020',
  };
  for (const [tok, val] of Object.entries(expected)) {
    assert.ok(new RegExp(`${tok}:\\s*${val};`).test(vars), `DEAD-025: ${tok} preserves value ${val} (no stacking change)`);
  }
  for (const f of ['css/viewer.css', 'css/tools.css', 'css/admpan.css']) {
    const s = read(f);
    const raw = s.match(/z-index:\s*[1-9][0-9]{3,}/g) || [];
    assert.equal(raw.length, 0, `DEAD-025: no raw giant z-index literal left in ${f} (got ${raw})`);
    assert.ok(/z-index:\s*var\(--z-/.test(s), `DEAD-025: ${f} uses --z-* tokens`);
  }
}

// ── PERF-034: each shimmer keyframe animates transform, not background-position ──
{
  const checks = [
    ['css/base.css', '@keyframes shimmer'],
    ['css/viewer.css', '@keyframes blur-shimmer'],
    ['css/admpan.css', '@keyframes adm-shimmer'],
  ];
  for (const [f, kf] of checks) {
    const s = read(f);
    const block = s.slice(s.indexOf(kf), s.indexOf(kf) + 140);
    assert.ok(/translateX/.test(block), `PERF-034: ${kf} animates translateX`);
    assert.ok(!/background-position/.test(block), `PERF-034: ${kf} no longer animates background-position`);
  }
  // the shimmer is now carried by transform-animated overlay pseudo-elements
  assert.ok(/\.skeleton::after\b/.test(read('css/components.css')), 'PERF-034: .skeleton uses an ::after overlay');
  assert.ok(/\.blur-progress-fill::after\b/.test(read('css/viewer.css')), 'PERF-034: progress fill uses an ::after overlay');
  assert.ok(/\.skeleton-card::after\b/.test(read('css/admpan.css')), 'PERF-034: admin skeleton uses an ::after overlay');
}

console.log('CSS hygiene (DEAD-025 value-preserving z-tokens, PERF-034 transform shimmer): OK');
