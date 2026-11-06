// The fine empty-space skip changes no pixel. A CPU port of the ray-march's sampling
// loop (trilinear read of a bordered brick, jittered / absolute sample lattice, the
// three accumulation modes, channelValues) runs every ray twice — without the skip and
// with the 8³ cell test of the shader — and the two results must be IDENTICAL, for
// random windows, gammas, opacities and channel switches, so the claim "a moved slider
// needs no recomputation" holds too: the cell maxima never change between the runs.
//
// Run: node tests/js/test_cell_skip_parity.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadModule, ROOT } from './harness.mjs';

const CellMax = loadModule('js/core/cell-max.js', 'CellMax', { self: {} });
const VV = readFileSync(path.join(ROOT, 'js/viewers/volume-viewer.js'), 'utf8').replace(/\r\n/g, '\n');

// The shader must carry exactly the thresholds this port uses.
assert.match(VV, /float fineThreshold\(\) \{\s*return renderMode == 1 \? 0\.0 : \(renderMode == 2 \? 0\.0025 : 0\.01\);/, 'thresholds of the shader');
assert.match(VV, /if \(d > 0\.0025\)/, 'mode 2 ignores a density <= 0.0025');
assert.match(VV, /if \(localAlpha > 0\.01\)/, 'DVR ignores a local alpha <= 0.01');
const threshold = (mode) => (mode === 1 ? 0 : mode === 2 ? 0.0025 : 0.01);

let seed = 987654321;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// A 3-channel volume of 44 × 38 × 30 voxels: sparse blobs + a faint haze patch.
const DIM = [44, 38, 30], COMPS = 3;
const vol = new Uint8Array(DIM[0] * DIM[1] * DIM[2] * COMPS);
for (let b = 0; b < 9; b++) {
  const c = [rnd() * DIM[0], rnd() * DIM[1], rnd() * DIM[2]], r = 2 + rnd() * 6, ch = (rnd() * COMPS) | 0, peak = 8 + rnd() * 247;
  for (let z = 0; z < DIM[2]; z++) for (let y = 0; y < DIM[1]; y++) for (let x = 0; x < DIM[0]; x++) {
    const d = Math.hypot(x - c[0], y - c[1], z - c[2]);
    if (d < r) { const i = ((z * DIM[1] + y) * DIM[0] + x) * COMPS + ch; vol[i] = Math.max(vol[i], Math.round(peak * (1 - d / r))); }
  }
}
for (let z = 10; z < 16; z++) for (let y = 20; y < 26; y++) for (let x = 24; x < 30; x++) vol[((z * DIM[1] + y) * DIM[0] + x) * COMPS + 1] = 2;

// The stored 66³ brick: stored index s holds volume voxel s − 1, clamped to the volume.
const EDGE = 66;
const stored = new Uint8Array(EDGE * EDGE * EDGE * COMPS);
for (let z = 0; z < EDGE; z++) for (let y = 0; y < EDGE; y++) for (let x = 0; x < EDGE; x++) {
  const sx = Math.min(DIM[0] - 1, Math.max(0, x - 1)), sy = Math.min(DIM[1] - 1, Math.max(0, y - 1)), sz = Math.min(DIM[2] - 1, Math.max(0, z - 1));
  for (let c = 0; c < COMPS; c++) stored[((z * EDGE + y) * EDGE + x) * COMPS + c] = vol[((sz * DIM[1] + sy) * DIM[0] + sx) * COMPS + c];
}
const cells = CellMax.fromBox(stored, COMPS, EDGE, EDGE, EDGE, { apron: 1 });
const CN = 8;   // cells per axis of the brick

// Trilinear read at the continuous voxel position p (voxel i spans [i, i+1]).
function sample(p) {
  const t = p.map((v) => v - 0.5);
  const i0 = t.map(Math.floor), f = t.map((v, k) => v - i0[k]);
  const out = [0, 0, 0, 0];
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const w = (dx ? f[0] : 1 - f[0]) * (dy ? f[1] : 1 - f[1]) * (dz ? f[2] : 1 - f[2]);
    const x = Math.min(DIM[0] - 1, Math.max(0, i0[0] + dx)), y = Math.min(DIM[1] - 1, Math.max(0, i0[1] + dy)), z = Math.min(DIM[2] - 1, Math.max(0, i0[2] + dz));
    for (let c = 0; c < COMPS; c++) out[c] += w * vol[((z * DIM[1] + y) * DIM[0] + x) * COMPS + c] / 255;
  }
  return out;
}

function channelValues(val, st) {
  const v = [0, 0, 0, 0];
  for (let c = 0; c < COMPS; c++) {
    if (!st.en[c]) continue;
    let x = Math.min(1, Math.max(0, (val[c] - st.min[c]) / Math.max(st.max[c] - st.min[c], 0.0001)));
    if (st.gamma[c] !== 1) x = Math.pow(x, st.gamma[c]);
    v[c] = x * st.opacity[c];
  }
  return v;
}

function march(origin, dir, mode, st, useSkip) {
  // Ray in voxel units: the data box is [0, DIM]; dirTex·dim has length nu.
  const lo = [0, 0, 0], hi = DIM;
  let t0 = -Infinity, t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    const a = (lo[k] - origin[k]) / dir[k], b = (hi[k] - origin[k]) / dir[k];
    t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b));
  }
  if (t0 >= t1) return null;
  t0 = Math.max(t0, 0);
  const rayLength = t1 - t0;
  const nu = Math.hypot(...dir);   // dir is in voxels per unit t
  let delta = 1 / nu;
  const cosV = Math.max(Math.abs(dir[2]) / nu, 0.05);
  if (mode === 1) delta /= cosV;
  delta = Math.min(delta, rayLength);
  let t = mode === 1 ? Math.ceil(t0 / delta) * delta - t0 : st.jitter * delta;
  const mip = [0, 0, 0, 0], ceil = st.opacity.map((o, c) => (st.en[c] ? o * 0.999 : 0));
  let accumA = 0; const accum = [0, 0, 0];
  let clebT = 1; const cleb = [0, 0, 0];
  const dvrExp = delta / 0.01;
  let cached = null, emptyCell = false, evals = 0;
  for (let i = 0; i < 4096 && t < rayLength; i++) {
    if (mode === 0 && accumA > 0.97) break;
    const pos = [0, 1, 2].map((k) => origin[k] + (t0 + t) * dir[k]);
    if (useSkip) {
      const fc = pos.map((q, k) => Math.floor(Math.min(DIM[k] - 1, Math.max(0, q)) / 8));
      const key = fc.join(',');
      if (key !== cached) {
        cached = key;
        const o = ((fc[2] * CN + fc[1]) * CN + fc[0]) * 4;
        const m = [cells[o] / 255, cells[o + 1] / 255, cells[o + 2] / 255, cells[o + 3] / 255];
        const v = channelValues(m, st);
        emptyCell = v.every((x) => x <= threshold(mode));
      }
      if (emptyCell) {
        // exit of the cell on the sample lattice
        let skip = Infinity;
        for (let k = 0; k < 3; k++) {
          if (Math.abs(dir[k]) < 1e-12) continue;
          const face = dir[k] > 0 ? Math.min((fc[k] + 1) * 8, DIM[k]) : fc[k] * 8;
          skip = Math.min(skip, (face - pos[k]) / dir[k]);
        }
        skip = Math.max(0, skip);
        t += Math.max(delta, Math.ceil(skip / delta) * delta);
        continue;
      }
    }
    evals++;
    const val = sample(pos);
    const v = channelValues(val, st);
    if (mode === 1) {
      for (let c = 0; c < 4; c++) mip[c] = Math.max(mip[c], v[c]);
      if (mip.every((x, c) => x >= ceil[c])) break;
    } else if (mode === 2) {
      const d = Math.max(...v);
      if (d > 0.0025) {
        const a = 1 - Math.exp(-st.absorption * delta * d);
        const w = clebT * delta;
        for (let c = 0; c < 3; c++) cleb[c] += w * v[c];
        clebT *= 1 - a;
        if (clebT < 0.004) break;
      }
    } else {
      const la = Math.max(...v);
      if (la > 0.01) {
        const a = 1 - Math.pow(Math.max(1 - 0.05 * la, 0), dvrExp);
        for (let c = 0; c < 3; c++) accum[c] += (1 - accumA) * a * v[c];
        accumA += (1 - accumA) * a;
      }
    }
    t += delta;
  }
  return { out: mode === 1 ? mip : mode === 2 ? cleb.concat(clebT) : accum.concat(accumA), evals };
}

let rays = 0, saved = 0, total = 0;
for (let round = 0; round < 60; round++) {
  const st = {
    en: [rnd() < 0.85, rnd() < 0.85, rnd() < 0.85],
    min: [0, 1, 2].map(() => rnd() * 0.15),
    max: [0, 1, 2].map(() => 0.25 + rnd() * 0.75),
    gamma: [0, 1, 2].map(() => (rnd() < 0.4 ? 1 : 0.5 + rnd() * 2)),
    opacity: [0, 1, 2].map(() => 0.3 + rnd() * 0.7),
    absorption: 3 + rnd() * 10,
    jitter: rnd()
  };
  for (let r = 0; r < 120; r++) {
    // a ray from outside the box through a random point of it
    const target = [rnd() * DIM[0], rnd() * DIM[1], rnd() * DIM[2]];
    const d = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
    const len = Math.hypot(...d) || 1;
    const dir = d.map((v) => v / len * (0.6 + rnd() * 0.8));
    const origin = target.map((v, k) => v - dir[k] * 90);
    for (const mode of [0, 1, 2]) {
      const a = march(origin, dir, mode, st, false);
      const b = march(origin, dir, mode, st, true);
      assert.equal(a === null, b === null);
      if (!a) continue;
      rays++;
      total += a.evals; saved += a.evals - b.evals;
      for (let k = 0; k < a.out.length; k++) {
        // Identical sample sets; only the rounding of t (a jump = one multiply-add, a walk = many
        // additions) moves a sample by ~1e-14 voxel.
        assert.ok(Math.abs(b.out[k] - a.out[k]) < 1e-9, `mode ${mode} component ${k}: ${b.out[k]} (skip) vs ${a.out[k]}`);
      }
    }
  }
}
assert.ok(saved / total > 0.2, `the cell test must skip a real share of the samples (${(100 * saved / total).toFixed(1)} %)`);
console.log(`cell skip parity: ${rays} rays equal to 1e-9, ${(100 * saved / total).toFixed(1)} % of the samples skipped: OK`);

// ── Raw maxima march (RAW_OUT, the maximum projection cache) ─────────────────────────
// The march keeps the raw per-channel maximum of the samples, whatever the window. A cell
// is jumped over when, in EVERY channel, its maximum is 0 (every sample of it reads 0 in
// that channel: it cannot raise a maximum >= 0) or its maximum + RAW_SKIP_MARGIN is at or
// under the ray's running maximum. The maxima must be those of the march without the skip,
// for volumes of 1, 2 and 3 channels — the channels a volume lacks are 0 in its cells and
// must not veto the skip (the earlier all-channels test never fired below four channels).
const RAW_SKIP_MARGIN = 0.002;
assert.match(VV, /#define RAW_SKIP_MARGIN 0\.002/);
assert.match(VV, /vec4 quietChannel = vec4\(lessThanEqual\(gFineMax, vec4\(0\.0\)\)\);\s+vec4 underChannel = vec4\(lessThanEqual\(gFineMax \+ vec4\(RAW_SKIP_MARGIN\), gRayMax\)\);\s+bool empty = all\(greaterThan\(quietChannel \+ underChannel, vec4\(0\.0\)\)\);/, 'the shader carries the per-channel rule of this port');

function rawVolume(comps) {
  const v = new Uint8Array(DIM[0] * DIM[1] * DIM[2] * comps);
  for (let b = 0; b < 14; b++) {
    const c = [rnd() * DIM[0], rnd() * DIM[1], rnd() * DIM[2]], r = 3 + rnd() * 7, ch = (rnd() * comps) | 0, peak = 30 + rnd() * 225;
    for (let z = 0; z < DIM[2]; z++) for (let y = 0; y < DIM[1]; y++) for (let x = 0; x < DIM[0]; x++) {
      const d = Math.hypot(x - c[0], y - c[1], z - c[2]);
      if (d < r) { const i = ((z * DIM[1] + y) * DIM[0] + x) * comps + ch; v[i] = Math.max(v[i], Math.round(peak * (1 - d / r))); }
    }
  }
  const st = new Uint8Array(EDGE * EDGE * EDGE * comps);
  for (let z = 0; z < EDGE; z++) for (let y = 0; y < EDGE; y++) for (let x = 0; x < EDGE; x++) {
    const sx = Math.min(DIM[0] - 1, Math.max(0, x - 1)), sy = Math.min(DIM[1] - 1, Math.max(0, y - 1)), sz = Math.min(DIM[2] - 1, Math.max(0, z - 1));
    for (let c = 0; c < comps; c++) st[((z * EDGE + y) * EDGE + x) * comps + c] = v[((sz * DIM[1] + sy) * DIM[0] + sx) * comps + c];
  }
  return { comps, vol: v, cells: CellMax.fromBox(st, comps, EDGE, EDGE, EDGE, { apron: 1 }) };
}

function rawSample(V, p) {
  const t = p.map((q) => q - 0.5);
  const i0 = t.map(Math.floor), f = t.map((q, k) => q - i0[k]);
  const out = [0, 0, 0, 0];
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const w = (dx ? f[0] : 1 - f[0]) * (dy ? f[1] : 1 - f[1]) * (dz ? f[2] : 1 - f[2]);
    const x = Math.min(DIM[0] - 1, Math.max(0, i0[0] + dx)), y = Math.min(DIM[1] - 1, Math.max(0, i0[1] + dy)), z = Math.min(DIM[2] - 1, Math.max(0, i0[2] + dz));
    for (let c = 0; c < V.comps; c++) out[c] += w * V.vol[((z * DIM[1] + y) * DIM[0] + x) * V.comps + c] / 255;
  }
  return out;
}

// rule: 'none' (no cell test), 'zero' (only cells at 0 in every channel), 'all' (the former all-channels test), 'channel' (the shader's).
function rawMarch(V, origin, dir, rule) {
  let t0 = -Infinity, t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    const a = (0 - origin[k]) / dir[k], b = (DIM[k] - origin[k]) / dir[k];
    t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b));
  }
  if (t0 >= t1) return null;
  t0 = Math.max(t0, 0);
  const rayLength = t1 - t0, nu = Math.hypot(...dir);
  const delta = Math.min(1 / nu / Math.max(Math.abs(dir[2]) / nu, 0.05), rayLength);
  const jitter = Math.ceil(t0 / delta) * delta - t0;
  const mip = [0, 0, 0, 0];
  let k = 0, t = jitter, evals = 0;
  for (let i = 0; i < 4096 && t < rayLength; i++) {
    const pos = [0, 1, 2].map((a) => origin[a] + (t0 + t) * dir[a]);
    if (rule !== 'none') {
      const fc = pos.map((q, a) => Math.floor(Math.min(DIM[a] - 1, Math.max(0, q)) / 8));
      const o = ((fc[2] * CN + fc[1]) * CN + fc[0]) * 4;
      const m = [0, 1, 2, 3].map((c) => V.cells[o + c] / 255);
      const empty = rule === 'zero' ? m.every((x) => x <= 0)
        : rule === 'all' ? (m.every((x) => x <= 0) || m.every((x, c) => x + RAW_SKIP_MARGIN <= mip[c]))
        : m.every((x, c) => x <= 0 || x + RAW_SKIP_MARGIN <= mip[c]);
      if (empty) {
        let skip = Infinity;
        for (let a = 0; a < 3; a++) {
          if (Math.abs(dir[a]) < 1e-12) continue;
          const face = dir[a] > 0 ? Math.min((fc[a] + 1) * 8, DIM[a]) : fc[a] * 8;
          skip = Math.min(skip, (face - pos[a]) / dir[a]);
        }
        k += Math.max(1, Math.ceil(Math.max(0, skip) / delta));
        t = jitter + k * delta;
        continue;
      }
    }
    evals++;
    const val = rawSample(V, pos);
    for (let c = 0; c < 4; c++) mip[c] = Math.max(mip[c], val[c]);
    k += 1;
    t = jitter + k * delta;
  }
  return { mip, evals };
}

for (const comps of [1, 2, 3]) {
  const V = rawVolume(comps);
  let n = 0, total = 0, byAll = 0, byChannel = 0;
  for (let r = 0; r < 3000; r++) {
    const target = [rnd() * DIM[0], rnd() * DIM[1], rnd() * DIM[2]];
    const d = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
    const len = Math.hypot(...d) || 1;
    const dir = d.map((q) => q / len * (0.6 + rnd() * 0.8));
    const origin = target.map((q, a) => q - dir[a] * 90);
    const ref = rawMarch(V, origin, dir, 'none');
    if (!ref) continue;
    const all = rawMarch(V, origin, dir, 'all'), ch = rawMarch(V, origin, dir, 'channel');
    // Below four channels the former test's "under the ray maximum" half never fired.
    assert.equal(all.evals, rawMarch(V, origin, dir, 'zero').evals, `${comps} channel(s): the all-channels test only skipped empty cells`);
    for (let c = 0; c < 4; c++) {
      assert.ok(Math.abs(ch.mip[c] - ref.mip[c]) < 1e-9, `${comps} channel(s), channel ${c}: ${ch.mip[c]} (skip) vs ${ref.mip[c]}`);
      assert.ok(Math.abs(all.mip[c] - ref.mip[c]) < 1e-9);
    }
    n++; total += ref.evals; byAll += ref.evals - all.evals; byChannel += ref.evals - ch.evals;
  }
  const pAll = 100 * byAll / total, pCh = 100 * byChannel / total;
  assert.ok(byChannel > byAll, `${comps} channel(s): the per-channel test must skip more than the all-channels one (${pCh.toFixed(1)} vs ${pAll.toFixed(1)} %)`);
  assert.ok(pCh - pAll > 2, `${comps} channel(s): the per-channel test must add a real share of skipped samples (${pCh.toFixed(1)} vs ${pAll.toFixed(1)} %)`);
  console.log(`raw maxima skip, ${comps} channel(s): ${n} rays equal to 1e-9, ${pCh.toFixed(1)} % skipped (all-channels test: ${pAll.toFixed(1)} %): OK`);
}
