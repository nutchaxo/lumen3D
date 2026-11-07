// Fine empty-space cells of a dense volume (volume-viewer.js _createDenseCells, ?denseCells=1).
//   • the published dilation (_dilateCells3, separable, 9 reads per cell) is byte-identical
//     to the 3×3×3 maximum it replaced (27 reads per cell), on random data and degenerate
//     shapes (an axis of one cell);
//   • the texture reads 255 (never skipped) and is marked for upload from its creation,
//     before any brick's cells are published;
//   • flush() publishes at once; setNeverSkip(true) (a denoise blur in place) publishes 255
//     everywhere, setNeverSkip(false) the raw cells again.
//
// Run: node tests/js/test_dense_cells.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, loadModule } from './harness.mjs';

const require = createRequire(import.meta.url);
const THREE = require('../../js/vendor/three.min.js');
const VV = readFileSync(path.join(ROOT, 'js/viewers/volume-viewer.js'), 'utf8');

function extract(name) {
  const start = VV.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  let i = VV.indexOf('{', start), depth = 0;
  for (; i < VV.length; i++) {
    if (VV[i] === '{') depth++;
    else if (VV[i] === '}' && --depth === 0) break;
  }
  return VV.slice(start, i + 1);
}

const CellMax = loadModule('js/core/cell-max.js', 'CellMax', { self: {} });
let frames = 0;
const { _dilateCells3, _createDenseCells } = new Function('THREE', 'CellMax', 'VOLUME_BRICK_SIZE', '_scheduleFrame',
  `${extract('_dilateCells3')}\n${extract('_createDenseCells')}\nreturn { _dilateCells3, _createDenseCells };`
)(THREE, CellMax, 64, () => { frames++; });

// The 3×3×3 maximum as it was published before (27 reads per cell).
function dilate27(raw, cnx, cny, cnz) {
  const data = new Uint8Array(raw.length);
  for (let z = 0; z < cnz; z++) for (let y = 0; y < cny; y++) for (let x = 0; x < cnx; x++) {
    const o = ((z * cny + y) * cnx + x) * 4;
    let r = 0, g = 0, b = 0, a = 0;
    for (let dz = Math.max(0, z - 1); dz <= Math.min(cnz - 1, z + 1); dz++)
      for (let dy = Math.max(0, y - 1); dy <= Math.min(cny - 1, y + 1); dy++)
        for (let dx = Math.max(0, x - 1); dx <= Math.min(cnx - 1, x + 1); dx++) {
          const q = ((dz * cny + dy) * cnx + dx) * 4;
          if (raw[q] > r) r = raw[q];
          if (raw[q + 1] > g) g = raw[q + 1];
          if (raw[q + 2] > b) b = raw[q + 2];
          if (raw[q + 3] > a) a = raw[q + 3];
        }
    data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = a;
  }
  return data;
}

let seed = 1357913;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
{
  const shapes = [[1, 1, 1], [1, 5, 3], [7, 1, 4], [6, 4, 1], [2, 2, 2], [13, 9, 11], [33, 17, 5]];
  for (let k = 0; k < 40; k++) shapes.push([1 + (rnd() * 20) | 0, 1 + (rnd() * 20) | 0, 1 + (rnd() * 12) | 0]);
  for (const [cnx, cny, cnz] of shapes) {
    const n = cnx * cny * cnz * 4;
    const raw = new Uint8Array(n);
    // Sparse: mostly zeros, a few values, some 255 (bricks in flight).
    for (let i = 0; i < n; i++) { const u = rnd(); raw[i] = u < 0.85 ? 0 : u < 0.97 ? (rnd() * 254) | 0 : 255; }
    const dst = new Uint8Array(n), tmp = new Uint8Array(n);
    _dilateCells3(raw, dst, tmp, cnx, cny, cnz);
    assert.deepEqual(dst, dilate27(raw, cnx, cny, cnz), `separable dilation = 27-tap at ${cnx}×${cny}×${cnz}`);
  }
  console.log(`separable 3×3×3 dilation byte-identical to the 27-tap one (${shapes.length} shapes): OK`);
}

{
  // 200 × 130 × 70 voxels = 25 × 17 × 9 cells; bricks 4 × 3 × 2, brick (1, 0, 0) not stored.
  const active = [];
  for (let bz = 0; bz < 2; bz++) for (let by = 0; by < 3; by++) for (let bx = 0; bx < 4; bx++) if (!(bx === 1 && by === 0 && bz === 0)) active.push({ bx, by, bz });
  const cells = _createDenseCells(200, 130, 70, active);
  const data = cells.map.image.data;
  assert.equal(cells.map.version > 0, true, 'marked for upload at creation');
  assert.ok(data.every(v => v === 255), 'never skipped before the first publish');
  const brick = new Uint8Array(8 * 8 * 8 * 4);
  brick[((3 * 8 + 3) * 8 + 3) * 4 + 1] = 77;   // one cell of channel 1 in brick (0,0,0)
  for (const b of active) cells.set(b.bx, b.by, b.bz, brick);
  const v0 = cells.map.version;
  frames = 0;
  cells.flush();
  assert.ok(cells.map.version > v0 && frames === 1, 'flush publishes now');
  const at = (x, y, z, c) => data[((z * 17 + y) * 25 + x) * 4 + c];
  assert.equal(at(3, 3, 3, 1), 77);
  assert.equal(at(4, 4, 4, 1), 77, 'dilated by one cell');
  assert.equal(at(5, 3, 3, 1), 0);
  assert.equal(at(12, 3, 3, 1), 0, 'a brick the level does not store reads 0');
  cells.setNeverSkip(true);
  assert.ok(data.every(v => v === 255), 'blurred voxels: never skipped');
  cells.set(0, 0, 0, brick);   // a brick arriving while blurred keeps 255 on publish
  cells.flush();
  assert.ok(data.every(v => v === 255));
  cells.setNeverSkip(false);
  assert.equal(at(3, 3, 3, 1), 77, 'raw cells again');
  assert.equal(at(12, 3, 3, 1), 0);
  cells.dispose();
  console.log('dense cells: 255 until published, flush, never-skip while blurred: OK');
}

// The viewer wires them: flush at the stream's end, never-skip around a blur upload.
assert.match(VV, /if \(!stopped\(\)\) denseCells\?\.flush\(\);/);
assert.match(VV, /if \(blurred\) entry\.denseCells\?\.setNeverSkip\?\.\(true\);/);
assert.match(VV, /if \(!blurred\) entry\.denseCells\?\.setNeverSkip\?\.\(false\);\s+return true;/);
console.log('dense cells: OK');
