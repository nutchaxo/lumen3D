// Fine empty-space cells (js/core/cell-max.js): the 8³ maximum covers every voxel a
// trilinear (or nearest) sample inside the cell can read, also after BC compression.
//
// Run: node tests/js/test_cell_max.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

const CellMax = loadModule('js/core/cell-max.js', 'CellMax', { self: {} });
const BC = loadModule('js/core/bc-codec.js', 'BCCodec', { self: {} });

let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// A brick of `comps` channels: sparse bright blobs on a zero background, plus noise
// patches, so cells are a mix of empty, faint and bright.
function makeBrick(edge, comps, density) {
  const data = new Uint8Array(edge * edge * edge * comps);
  const blobs = Math.max(1, Math.round(density * 12));
  for (let b = 0; b < blobs; b++) {
    const cx = rnd() * edge, cy = rnd() * edge, cz = rnd() * edge, r = 2 + rnd() * 9;
    const ch = (rnd() * comps) | 0, peak = 20 + rnd() * 235;
    for (let z = 0; z < edge; z++) for (let y = 0; y < edge; y++) for (let x = 0; x < edge; x++) {
      const dd = Math.hypot(x - cx, y - cy, z - cz);
      if (dd < r) data[((z * edge + y) * edge + x) * comps + ch] = Math.max(data[((z * edge + y) * edge + x) * comps + ch], Math.round(peak * (1 - dd / r) + (rnd() < 0.3 ? rnd() * 40 : 0)));
    }
  }
  return data;
}

// The brute-force footprint of cell (cx,cy,cz): stored indices 8c … 8c+7+2·apron.
function brute(values, comps, edge, apron, cx, cy, cz, c, blocks = false) {
  const span = 7 + 2 * apron;
  const spanXY = blocks ? Math.ceil((span + 1) / 4) * 4 - 1 : span;
  let m = 0;
  for (let z = cz * 8; z <= Math.min(edge - 1, cz * 8 + span); z++)
    for (let y = cy * 8; y <= Math.min(edge - 1, cy * 8 + spanXY); y++)
      for (let x = cx * 8; x <= Math.min(edge - 1, cx * 8 + spanXY); x++)
        m = Math.max(m, values[((z * edge + y) * edge + x) * comps + c]);
  return m;
}

// ── raw maxima equal the brute-force footprint maxima ────────────────────────
for (const [edge, apron] of [[66, 1], [64, 0]]) {
  for (const comps of [1, 2, 4]) {
    const data = makeBrick(edge, comps, 0.6);
    const cells = CellMax.fromBox(data, comps, edge, edge, edge, { apron });
    assert.equal(cells.length, 8 * 8 * 8 * 4);
    for (let cz = 0; cz < 8; cz++) for (let cy = 0; cy < 8; cy++) for (let cx = 0; cx < 8; cx++) {
      for (let c = 0; c < 4; c++) {
        const expected = c < comps ? brute(data, comps, edge, apron, cx, cy, cz, c) : 0;
        assert.equal(cells[((cz * 8 + cy) * 8 + cx) * 4 + c], expected, `edge ${edge} comps ${comps} cell ${cx},${cy},${cz} ch ${c}`);
      }
    }
  }
}

// ── a trilinear sample never exceeds its cell's maximum ─────────────────────
{
  const edge = 66, comps = 3, apron = 1;
  const data = makeBrick(edge, comps, 0.8);
  const cells = CellMax.fromBox(data, comps, edge, edge, edge, { apron });
  const at = (x, y, z, c) => data[((Math.min(edge - 1, Math.max(0, z)) * edge + Math.min(edge - 1, Math.max(0, y))) * edge + Math.min(edge - 1, Math.max(0, x))) * comps + c];
  for (let i = 0; i < 4000; i++) {
    // volume position p in [0, 64) → stored coordinate p + 1 (texel centre convention: t = p + 1 + ½ - ½)
    const p = [rnd() * 64, rnd() * 64, rnd() * 64];
    const c = (rnd() * comps) | 0;
    const t = p.map((v) => v + 1 - 0.5);      // stored texel coordinate of the sample, centres at integers
    const i0 = t.map(Math.floor), f = t.map((v, k) => v - i0[k]);
    let v = 0;
    for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      v += at(i0[0] + dx, i0[1] + dy, i0[2] + dz, c) * (dx ? f[0] : 1 - f[0]) * (dy ? f[1] : 1 - f[1]) * (dz ? f[2] : 1 - f[2]);
    }
    const cell = p.map((q) => Math.floor(q / 8));
    const m = cells[((cell[2] * 8 + cell[1]) * 8 + cell[0]) * 4 + c];
    assert.ok(v <= m + 1e-9, `trilinear ${v} exceeds its cell maximum ${m}`);
  }
}

// ── BC-decoded voxels stay under the cell maximum with the margin ────────────
{
  const edge = 66, apron = 1;
  let worst = 0;
  for (const comps of [1, 2, 3, 4]) {
    for (let round = 0; round < 6; round++) {
      const storedComps = comps === 3 ? 4 : comps;
      const data = makeBrick(edge, storedComps, 0.3 + round * 0.15);
      if (comps === 3) for (let i = 3; i < data.length; i += 4) data[i] = 0;
      const enc = BC.encodeBox(data, storedComps, edge, edge, edge, comps);
      const dec = BC.decodeBox(enc, storedComps, edge, edge, edge);
      const cells = CellMax.fromBox(data, storedComps, edge, edge, edge, { apron, margin: CellMax.BC_MARGIN, blocks: true });
      for (let cz = 0; cz < 8; cz++) for (let cy = 0; cy < 8; cy++) for (let cx = 0; cx < 8; cx++) {
        for (let c = 0; c < storedComps; c++) {
          const decodedMax = brute(dec, storedComps, edge, apron, cx, cy, cz, c);
          const sourceMax = brute(data, storedComps, edge, apron, cx, cy, cz, c, true);
          const cell = cells[((cz * 8 + cy) * 8 + cx) * 4 + c];
          worst = Math.max(worst, decodedMax - sourceMax);
          assert.ok(decodedMax <= cell + 1e-6, `BC decoded max ${decodedMax} over the cell maximum ${cell} (source ${sourceMax})`);
          if (sourceMax === 0) assert.equal(decodedMax, 0, 'zeros stay exact');
        }
      }
    }
  }
  assert.ok(worst < CellMax.BC_MARGIN, `worst measured BC overshoot ${worst.toFixed(2)} must stay under the margin ${CellMax.BC_MARGIN}`);
  console.log(`BC overshoot over the source cell maximum: ${worst.toFixed(2)} levels (margin ${CellMax.BC_MARGIN})`);
}

// ── a brick cut at the volume's edge: cells past the box are never skippable ─
{
  const cells = CellMax.fromBox(new Uint8Array(20 * 20 * 20), 1, 20, 20, 20, { apron: 1 });
  assert.equal(cells[0], 0, 'an empty cell inside the box is 0');
  assert.equal(cells[((7 * 8 + 7) * 8 + 7) * 4 + 0], 255, 'a cell past the box is 255');
}

console.log('cell max: OK');
