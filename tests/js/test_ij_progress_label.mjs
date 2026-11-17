// The projection's loading label: Mvoxels (not channel values), a fraction weighted by the values
// read (agrees with the voxel count on a shorter last band, ends at exactly 1), one decimal below
// 10 M with no floor, grouped digits per language. Expected values are computed by hand from the
// definitions (voxels = w·h·planes; the old code showed values and a plane-weighted percentage).
//
// Run: node tests/js/test_ij_progress_label.mjs
import assert from 'node:assert/strict';
import { boot, until, DIR } from './ij_harness.mjs';
import fs from 'node:fs';
import path from 'node:path';

const t0 = await boot();
const { mvox, projectionProgress } = t0.IJApp;
t0.close();

// 1. The user's case: 5735² × 200 planes × 3 channels = 6578 Mvoxels (the old label said 19734).
{
  const w = 5735, h = 5735, d = 200, ch = 3, est = w * h * d * ch;
  const p = projectionProgress({ width: w, height: h, depth: d, channels: ch, loaded: est, donePlanes: 1, totalPlanes: 1, lang: 'en' });
  assert.equal(p.mv, '6,578'); assert.equal(p.total, '6,578'); assert.equal(p.fraction, 1); assert.equal(p.pct, 100);
  assert.equal(projectionProgress({ width: w, height: h, depth: d, channels: ch, loaded: est, donePlanes: 1, totalPlanes: 1, lang: 'fr' }).mv.replace(/\s/g, ' '), '6 578');
}
// 2. Last, shorter band: 12 bands of 512 rows over 5735 (last 103). After band 11 the percentage
//    matches the voxel share (5632/5735 = 98.2 %), not 11/12 = 92 %.
{
  const w = 5735, h = 5735, d = 200, ch = 3, est = w * h * d * ch;
  const loaded = w * 5632 * d * ch;
  const p = projectionProgress({ width: w, height: h, depth: d, channels: ch, loaded, donePlanes: 11 * d, totalPlanes: 12 * d, lang: 'en' });
  assert.equal(p.pct, 98);
  assert.ok(Math.abs(p.fraction - 5632 / 5735) < 1e-12);
  assert.equal(p.mv, '6,460');
  assert.equal(p.total, '6,578');
  assert.ok(est > loaded);
}
// 3. No floor, one decimal below 10 M.
assert.equal(mvox(262144, 'en'), '0.3');
assert.equal(mvox(0, 'en'), '0.0');
assert.equal(mvox(9.94e6, 'en'), '9.9');
assert.equal(mvox(10.4e6, 'en'), '10');
{
  const p = projectionProgress({ width: 512, height: 512, depth: 1, channels: 1, loaded: 512 * 512, donePlanes: 1, totalPlanes: 1, lang: 'en' });
  assert.equal(p.mv, '0.3'); assert.equal(p.total, '0.3');
}
// 4. Unknown total falls back to the plane fraction.
{
  const p = projectionProgress({ width: 0, height: 0, depth: 0, channels: 1, loaded: 0, donePlanes: 3, totalPlanes: 4, lang: 'en' });
  assert.equal(p.fraction, 0.75); assert.equal(p.total, '?');
}
// 5. The four locales carry the same placeholders and none still says MB.
{
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');
  const get = (c) => JSON.parse(fs.readFileSync(path.join(DIR, 'lang', c + '.json'), 'utf8')).load.status;
  const en = get('en');
  assert.equal(ph(en), '{bands},{band},{mv},{pct},{total},{z0},{z1}');
  for (const c of ['fr', 'es', 'nl']) assert.equal(ph(get(c)), ph(en), c);
  assert.ok(!/\bMB\b|\bMo\b/.test(en));
}
// 6. Through the real flow: fractions never decrease, end at 1, and the last label reads mv == total.
{
  const t = await boot();
  t.script.dialogs.push((spec) => ({ method: 'sum', start: 1, stop: 5, level: 0 }));
  t.IJApp.mount(t.root, { ctx: t.ctx, api: t.api });
  await until(() => t.shells[0] && t.shells[0].images.find((i) => i && i.name), 'projection loaded');
  const prog = t.shells[0].progress.filter((p) => p && typeof p.fraction === 'number' && p.label && /Loading/.test(p.label));
  assert.ok(prog.length >= 2, 'several progress steps');
  for (let i = 1; i < prog.length; i++) assert.ok(prog[i].fraction >= prog[i - 1].fraction);
  assert.equal(prog[prog.length - 1].fraction, 1);
  const m = /— ([\d.,]+) Mvoxels read of ([\d.,]+)/.exec(prog[prog.length - 1].label);
  assert.ok(m && m[1] === m[2], prog[prog.length - 1].label);
  t.close();
}
console.log('OK (progress label)');
