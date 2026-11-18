// ij-proc-shared.js: the primitives the processing packages share (PLAN-wave2 §2.4).
//   - IJShared.makeFloatEDM against a brute-force Euclidean distance, with and without edgesAreBackground,
//     on random masks of many shapes (the golden fixtures of a real ImageJ 1.54f will be compared to it
//     bit for bit once recorded; until then this is the reference), and the all-foreground value;
//   - maskToRoi, thresholdMask, the light-background convention.
//
// Run: node tests/js/test_ij_shared.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const sb = { console };
sb.self = sb;
vm.createContext(sb);
for (const f of ['ij-core.js', 'ij-proc-shared.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sb, { filename: f });
const S = sb.IJShared, R = sb.IJRoi;

function brute(m, w, h, edge) {
  const o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!m[y * w + x]) continue;
    let best = Infinity;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if (!m[yy * w + xx]) best = Math.min(best, (x - xx) ** 2 + (y - yy) ** 2);
    if (edge) best = Math.min(best, (x + 1) ** 2, (w - x) ** 2, (y + 1) ** 2, (h - y) ** 2);
    o[y * w + x] = best === Infinity ? Math.sqrt(2 ** 31) : Math.sqrt(best);
  }
  return o;
}

let bad = 0, n = 0;
for (let t = 0; t < 120; t++) {
  const w = 3 + ((t * 7) % 23), h = 3 + ((t * 5) % 19);
  const m = new Uint8Array(w * h);
  let seed = t * 7919 + 1;
  for (let i = 0; i < m.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; m[i] = ((seed >> 8) % 100) < (20 + (t % 60)) ? 255 : 0; }
  for (const edge of [false, true]) {
    const a = S.makeFloatEDM(m, w, h, { edgesAreBackground: edge }), b = brute(m, w, h, edge);
    n++;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-4) { bad++; break; }
  }
}
assert.equal(bad, 0, `${bad} of ${n} maps differ from the brute-force distance`);
assert.ok(S.makeFloatEDM(new Uint8Array(6).fill(255), 3, 2)[0] > 46000, 'no background: ImageJ keeps sqrt(2^31)');
assert.equal(S.makeFloatEDM(new Uint8Array(6), 3, 2)[4], 0, 'background pixels are 0');
// the background value is a parameter (inverting LUT conventions)
const inv = new Uint8Array([255, 255, 255, 255, 0, 255, 255, 255, 255]);
assert.equal(S.makeFloatEDM(inv, 3, 3, { backgroundValue: 255 })[4], 1, 'a foreground pixel next to a 255-background');
assert.throws(() => S.makeFloatEDM(new Uint8Array(5), 3, 2), (e) => e.code === 'IJ_BAD_ARGS');

// maskToRoi: a filled box is a rectangle, anything else a mask selection, empty is null
assert.deepEqual(JSON.parse(JSON.stringify(S.maskToRoi(Uint8Array.from([0, 1, 1, 0, 1, 1]), 3, 2))), { type: 'rect', x: 1, y: 0, w: 2, h: 2 });
const ring = S.maskToRoi(Uint8Array.from([1, 1, 1, 1, 0, 1, 1, 1, 1]), 3, 3);
assert.equal(ring.type, 'mask'); assert.equal(R.area(ring), 8);
assert.equal(S.maskToRoi(new Uint8Array(4), 2, 2), null);

// thresholdMask is inclusive on both sides and never selects NaN
const f = { data: Float32Array.of(0, 1, 2, 3, NaN, 5) };
assert.deepEqual(Array.from(S.thresholdMask(f, 1, 3)), [0, 255, 255, 255, 0, 0]);
assert.deepEqual(Array.from(S.thresholdMask({ data: Uint8Array.of(10, 200) }, 0, 100)), [255, 0]);

// ImageJ: invert = (light && !invertedLut) || (!light && invertedLut)
assert.equal(S.lightBackgroundInvert(true, false), true);
assert.equal(S.lightBackgroundInvert(false, false), false);
assert.equal(S.lightBackgroundInvert(false, true), true);
assert.equal(S.lightBackgroundInvert(true, true), false);
assert.equal(S.hasInvertedLut({ invert: true }), true);
assert.equal(S.hasInvertedLut(null), false);

// makeFloatEDMAsync: the same bits as the synchronous call, ticks a monotone fraction in [0, 1] (several times on a
// large image), and a throwing tick/check aborts the transform.
{
  const w = 700, h = 900;
  const m = new Uint8Array(w * h);
  let seed = 99;
  for (let i = 0; i < m.length; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; m[i] = seed % 97 < 3 ? 0 : 255; }
  for (const edge of [false, true]) {
    const a = S.makeFloatEDM(m, w, h, { edgesAreBackground: edge });
    const fr = [];
    const b = await S.makeFloatEDMAsync(m, w, h, { edgesAreBackground: edge, tick: async (f) => { fr.push(f); }, check: async () => {} });
    assert.ok(a.every((v, i) => Object.is(v, b[i])), 'async EDM is bit-identical to the synchronous one');
    assert.ok(fr.length >= 4, 'it ticks several times: ' + fr.length);
    assert.ok(fr.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= fr[i - 1])), 'progress is monotone in [0, 1]');
  }
  let n = 0;
  await assert.rejects(S.makeFloatEDMAsync(m, w, h, { check: () => { if (++n === 3) throw new Error('cancelled'); } }), /cancelled/);
  assert.equal(n, 3, 'the transform stops at the first failing check');
}

// A side longer than 46340 px: the squared distance passes 2^31 and must stay a double (ImageJ saturates at sqrt(2^31 - 1),
// it never wraps to a negative int and reports 0). One background pixel at the origin, nothing else.
for (const [w, h] of [[50000, 1], [1, 50000], [50000, 2]]) {
  const m = new Uint8Array(w * h).fill(255);
  m[0] = 0;
  for (const edge of [false, true]) {
    const e = S.makeFloatEDM(m, w, h, { edgesAreBackground: edge });
    if (!edge) for (const i of [w * h - 1, w * h - 2]) {
      const last = Math.fround(Math.sqrt(2147483647));
      assert.equal(e[i], last, `${w}x${h} edges=${edge}: pixel ${i} saturates at sqrt(2^31-1), got ${e[i]}`);
    }
    assert.ok(e.every((v) => v >= 0), `${w}x${h}: no negative or zero wrap-around distance beyond the origin`);
    assert.equal(e.indexOf(0), 0, `${w}x${h}: only the background pixel is 0`);
  }
}

console.log('ij shared: OK');
