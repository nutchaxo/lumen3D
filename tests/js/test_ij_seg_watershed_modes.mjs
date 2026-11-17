// Advanced Studio, package P3 (seg): the watershed of Find Maxima / Watershed / Voronoi runs ImageJ's scan passes first and
// switches a level to the event-driven mode after a few passes; the event lists are capped and reserved.
//
//   • the pixels are those of ImageJ's scan-only loop: the checksums below were produced by the scan-only implementation
//     (HEAD before the event mode) on inputs that make a level need many passes (checkerboard, speckle), few passes
//     (rings of a Voronoi) and more list room than the cap allows (checkerboard: the event lists overflow, the level
//     finishes by scan);
//   • the memory the watershed asks for (ctl.reserve) stays within a few bytes per pixel, whatever the input.
//
// Regenerate the checksums against another implementation: IJ_SEG_DIR=<dir with ij-proc-shared.js + ij-proc-seg.js> node …
// Run: node tests/js/test_ij_seg_watershed_modes.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { DIR } from './ij_harness.mjs';

const sb = { console, setTimeout, clearTimeout };
sb.self = sb;
vm.createContext(sb);
for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-proc-seg.js']) {
  const dir = (f === 'ij-proc-shared.js' || f === 'ij-proc-seg.js') && process.env.IJ_SEG_DIR ? process.env.IJ_SEG_DIR : DIR;
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sb, { filename: f });
}
const { IJSeg } = sb;

let seed = 4242;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
function fnv(a) {
  const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16) + ':' + b.length;
}
function recorder() {
  const r = { reserved: 0, tick: async () => {}, check() {}, reserve(n) { r.reserved += n; } };
  return r;
}

const CASES = [];
{
  const S = 400, n = S * S;
  const checker = Float32Array.from({ length: n }, (_, i) => (((i % S) + ((i / S) | 0)) & 1) ? 1 : 0);
  CASES.push(['find maxima segmented, checkerboard 0/1', S, () => IJSeg.findMaxima({ data: checker, width: S, height: S }, { tolerance: 0, strict: false, excludeOnEdges: false, isEDM: false, threshold: IJSeg.NO_THRESHOLD, outputType: IJSeg.SEGMENTED }, recorder())]);
  const noise = Uint8Array.from({ length: n }, () => Math.floor(rnd() * 256));
  CASES.push(['find maxima segmented, 8-bit noise, tolerance 5', S, () => IJSeg.findMaxima({ data: noise, width: S, height: S }, { tolerance: 5, strict: false, excludeOnEdges: false, isEDM: false, threshold: IJSeg.NO_THRESHOLD, outputType: IJSeg.SEGMENTED }, recorder())]);
  const ramp = Uint16Array.from({ length: n }, (_, i) => Math.floor((i % S) * 10 + rnd() * 3));
  CASES.push(['find maxima segmented, 16-bit ramp with noise (long levels)', S, () => IJSeg.findMaxima({ data: ramp, width: S, height: S }, { tolerance: 0, strict: false, excludeOnEdges: true, isEDM: false, threshold: IJSeg.NO_THRESHOLD, outputType: IJSeg.SEGMENTED }, recorder())]);
}
{
  const S = 500, n = S * S;
  const speckle = Uint8Array.from({ length: n }, () => (rnd() < 0.7 ? 255 : 0));
  const blobs = new Uint8Array(n);
  for (let b = 0; b < 140; b++) {
    const cx = rnd() * S, cy = rnd() * S, r = 5 + rnd() * 25;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(S - 1, Math.ceil(cy + r)); y++) for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(S - 1, Math.ceil(cx + r)); x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) blobs[y * S + x] = 255;
  }
  for (const [name, mask] of [['speckle', speckle], ['blobs', blobs]]) {
    CASES.push([`watershed of ${name}`, S, () => IJSeg.watershedBinary(mask.slice(), S, S, false, recorder())]);
    CASES.push([`voronoi of ${name}`, S, () => IJSeg.voronoiFloat(mask.slice(), S, S, false, recorder())]);
  }
}

{
  // a level that switches to the event mode and finishes in it (4 grey levels), and one whose lists outgrow the cap mid-pass
  const S = 400, n = S * S;
  const four = Uint8Array.from({ length: n }, () => Math.floor(rnd() * 4));
  CASES.push(['find maxima segmented, 4 grey levels (event mode to the end)', S, () => IJSeg.findMaxima({ data: four, width: S, height: S }, { tolerance: 0, strict: false, excludeOnEdges: false, isEDM: false, threshold: IJSeg.NO_THRESHOLD, outputType: IJSeg.SEGMENTED }, recorder())]);
  const sparse = Uint8Array.from({ length: n }, () => (rnd() < 0.002 ? 200 : 100 + Math.floor(rnd() * 3)));
  CASES.push(['find maxima segmented, sparse peaks (event lists overflow mid-pass)', S, () => IJSeg.findMaxima({ data: sparse, width: S, height: S }, { tolerance: 5, strict: false, excludeOnEdges: false, isEDM: false, threshold: IJSeg.NO_THRESHOLD, outputType: IJSeg.SEGMENTED }, recorder())]);
}

const GOLD = process.env.IJ_SEG_PRINT ? {} : JSON.parse(fs.readFileSync(new URL('./fixtures/seg-watershed-modes.json', import.meta.url), 'utf8'));
const got = {};
let passed = 0;
for (const [name, S, run] of CASES) {
  const r = await run();
  const out = r && r.out !== undefined ? r.out : r;
  got[name] = fnv(out);
  if (process.env.IJ_SEG_PRINT) continue;
  assert.equal(got[name], GOLD[name], name + ': pixels differ from the scan-only watershed');
  passed++;
  console.log('  ok  ' + name);
}
if (process.env.IJ_SEG_PRINT) { console.log(JSON.stringify(got, null, 2)); process.exit(0); }

// memory: the lists of the event mode are bounded and reserved (nothing grows unannounced)
{
  const S = 400, n = S * S;
  const checker = Float32Array.from({ length: n }, (_, i) => (((i % S) + ((i / S) | 0)) & 1) ? 1 : 0);
  const ctl = recorder();
  await IJSeg.findMaxima({ data: checker, width: S, height: S }, { tolerance: 0, strict: false, excludeOnEdges: false, isEDM: false, threshold: IJSeg.NO_THRESHOLD, outputType: IJSeg.SEGMENTED }, ctl);
  // 16 B per maximum (n/2 of them) + at most ~4 B per pixel for the watershed work lists (about 2.7 B capped + ImageJ list)
  assert.ok(ctl.reserved <= 16 * n * 0.5 + 4 * n, 'reserved ' + ctl.reserved + ' bytes');
  const ctlW = recorder();
  const sp = Uint8Array.from({ length: n }, () => (rnd() < 0.7 ? 255 : 0));
  await IJSeg.watershedBinary(sp, S, S, false, ctlW);
  assert.ok(ctlW.reserved > 0 && ctlW.reserved <= 10 * n, 'watershed reserved ' + ctlW.reserved + ' bytes (' + (ctlW.reserved / n).toFixed(2) + ' B/px)');
  passed++;
  console.log('  ok  memory reserved through ctl.reserve stays bounded');
}
console.log(passed + ' tests passed');
