// Analyze > Local Thickness > Local Thickness (complete process): Hildebrand & Rüegsegger 1997 (ij-proc-fiji.js, IJLocalThickness / op localThickness).
//
// The Fiji plugin is GPL: it was only RUN (tests/fixtures/ij-wave3/fiji/localthickness: 4 images × threshold 128 / 100 × inverse on / off).
// Tolerance (PLAN-wave3 §6.3): ±1e-4. The interior pixels (object pixels whose 8 neighbours are all object pixels) agree to the last bit; the
// surface pixels and the ring of background the discs reach agree once Fiji's clean-up of the map is applied (a surface pixel takes the mean of
// its non-zero, non-surface 8-neighbours: found from the 3465 pixels the raw map gets wrong, ALL of them explained by that one rule).
// Independent check: a brute-force O(pixels × centres) reference written here from the definition, on random shapes.
//
// Run: node tests/js/test_ij_fiji_thickness.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const ctx = vm.createContext({ console, setTimeout, clearTimeout });
for (const f of ['ij-core.js', 'ij-proc-shared.js', 'ij-proc-fiji.js']) vm.runInContext(readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
const LT = vm.runInContext('IJLocalThickness', ctx);
const reg = vm.runInContext('IJOpRegistry', ctx);
const FX = path.join(ROOT, 'tests', 'fixtures', 'ij-wave3', 'fiji', 'localthickness');
const u8 = (d) => { const b = Buffer.from(d.data.b64, 'base64'); return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const f32 = (d) => { const b = Buffer.from(d.data.b64, 'base64'); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const hooks = { check() {}, async tick() {} };
const run = (fg, w, h) => LT.localThickness(fg, w, h, hooks, () => {});
const runRaw = (fg, w, h) => LT.localThickness(fg, w, h, hooks, () => {}, { clean: false });

// ── 1. the fixtures ──
let nInterior = 0, nCases = 0, nSurface = 0, supportOk = 0, nRawDiff = 0, worstAll = 0;
for (const f of readdirSync(FX).sort()) {
  const d = JSON.parse(readFileSync(path.join(FX, f), 'utf8'));
  const a = u8(d.input), w = d.input.width, h = d.input.height;
  for (const c of d.cases) {
    const fg = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) fg[i] = (c.params.inverse ? a[i] < c.params.threshold : a[i] >= c.params.threshold) ? 1 : 0;
    const got = (await run(fg, w, h)).data, want = f32(c.result.created[0].image);
    let worst = 0, sameSupport = true;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if ((got[i] > 0) !== (want[i] > 0)) sameSupport = false;
        let inter = fg[i] === 1;
        for (let dy = -1; dy <= 1 && inter; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h && !fg[yy * w + xx]) { inter = false; break; } }
        if (inter) { nInterior++; worst = Math.max(worst, Math.abs(got[i] - want[i])); } else if (Math.abs(got[i] - want[i]) > 1e-4) nSurface++;
        worstAll = Math.max(worstAll, Math.abs(got[i] - want[i]));
      }
    }
    assert.ok(worst <= 1e-4, `${f} ${JSON.stringify(c.params)}: interior difference ${worst}`);
    assert.ok(sameSupport, `${f} ${JSON.stringify(c.params)}: the thickness map covers the same pixels`);
    supportOk++; nCases++;
  }
}
assert.equal(nCases, 16);
assert.ok(nInterior > 20000);
assert.equal(nSurface, 0, 'surface and outer ring pixels that differ from Fiji: ' + nSurface);
assert.ok(worstAll <= 1e-4, 'every pixel of every map agrees with Fiji: worst ' + worstAll);
// the raw map (no clean-up) is what the definition gives: Fiji differs from it in exactly the surface / ring pixels (3465 in these 16 maps)
for (const f of readdirSync(FX).sort()) {
  const d = JSON.parse(readFileSync(path.join(FX, f), 'utf8'));
  const a = u8(d.input), w = d.input.width, h = d.input.height;
  for (const c of d.cases) {
    const fg = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) fg[i] = (c.params.inverse ? a[i] < c.params.threshold : a[i] >= c.params.threshold) ? 1 : 0;
    const raw = (await runRaw(fg, w, h)).data, want = f32(c.result.created[0].image);
    for (let i = 0; i < w * h; i++) if (Math.abs(raw[i] - want[i]) > 1e-4) nRawDiff++;
  }
}
assert.equal(nRawDiff, 3465, 'what the clean-up changes');

// ── 2. an independent brute force: for every pixel the largest sphere (any centre) that holds it ──
function brute(fg, w, h) {
  const n = w * h, r2 = new Int32Array(n);
  // squared distance to the nearest background pixel (the image border is not background)
  const bg = [];
  for (let i = 0; i < n; i++) if (!fg[i]) bg.push(i);
  for (let i = 0; i < n; i++) {
    if (!fg[i]) continue;
    const x = i % w, y = (i - x) / w;
    let best = Infinity;
    for (const b of bg) { const bx = b % w, by = (b - bx) / w; const dd = (bx - x) ** 2 + (by - y) ** 2; if (dd < best) best = dd; }
    r2[i] = best;
  }
  const out = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const px = p % w, py = (p - px) / w;
    let best = 0;
    for (let c = 0; c < n; c++) {
      if (!fg[c]) continue;
      const cx = c % w, cy = (c - cx) / w;
      if ((cx - px) ** 2 + (cy - py) ** 2 <= r2[c] && r2[c] > best) best = r2[c];
    }
    out[p] = best ? 2 * Math.sqrt(best) : 0;
  }
  return out;
}
{
  let seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let trial = 0; trial < 12; trial++) {
    const w = 14 + (trial % 5) * 3, h = 11 + (trial % 4) * 4;
    const fg = new Uint8Array(w * h);
    // blobs: a few filled discs plus a bar, then some noise
    for (let k = 0; k < 4; k++) { const cx = rnd() * w, cy = rnd() * h, r = 1 + rnd() * 5; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) fg[y * w + x] = 1; }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (rnd() < 0.05) fg[y * w + x] ^= 1;
    if (trial % 3 === 0) for (let x = 0; x < w; x++) fg[x] = 1;   // an object that touches the border: the border is not background
    let any = false, all = true;
    for (const v of fg) { if (v) any = true; else all = false; }
    if (!any || all) continue;
    const got = (await runRaw(fg, w, h)).data, want = brute(fg, w, h);
    for (let i = 0; i < w * h; i++) assert.ok(Math.abs(got[i] - want[i]) < 1e-5, `trial ${trial} pixel ${i}: ${got[i]} vs ${want[i]}`);
  }
}

// ── 3. by hand ──
{
  // a 3-px wide vertical strip in a 9 x 9 image: the centre line has r = 2, the thickness 4 on the strip and one pixel beyond it
  const w = 9, h = 9, fg = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 3; x <= 5; x++) fg[y * w + x] = 1;
  const t = (await run(fg, w, h)).data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) assert.equal(t[y * w + x], x >= 2 && x <= 6 ? 4 : 0, `(${x}, ${y})`);
  // a 7 x 7 square: the centre has r = 4, so the thickness is 8 at the centre; a corner pixel is only held by the sphere of ... at least r = 1
  const sq = new Uint8Array(81);
  for (let y = 1; y <= 7; y++) for (let x = 1; x <= 7; x++) sq[y * 9 + x] = 1;
  const s = (await run(sq, 9, 9)).data;
  assert.equal(s[4 * 9 + 4], 8); assert.ok(s[1 * 9 + 1] >= 2 && s[1 * 9 + 1] <= 8);
  // the maximum is returned for the display range
  assert.equal((await run(sq, 9, 9)).max, 8);
}

// ── 4. refusals, cancel, the operation ──
{
  await assert.rejects(run(new Uint8Array(16), 4, 4), (e) => e.code === 'IJ_FIJI_EMPTY');
  await assert.rejects(run(new Uint8Array(16).fill(1), 4, 4), (e) => e.code === 'IJ_FIJI_NO_BACKGROUND');
  let k = 0;
  const w = 600, h = 600, fg = new Uint8Array(w * h);
  for (let y = 100; y < 500; y++) for (let x = 100; x < 500; x++) fg[y * w + x] = 1;
  await assert.rejects(LT.localThickness(fg, w, h, { check() { if (++k > 5) throw Object.assign(new Error('c'), { code: 'IJ_CANCELLED' }); }, async tick() {} }, () => {}), (e) => e.code === 'IJ_CANCELLED');
  // a big square: the disc loop must not cost the number of pixels × the number of discs (union-find over the painted pixels)
  const t0 = Date.now();
  const r = await run(fg, w, h);
  assert.equal(r.max, 400);
  assert.ok(Date.now() - t0 < 6000, 'a 400 x 400 object in a 600 x 600 image: ' + (Date.now() - t0) + ' ms');

  const spec = reg.get('localThickness');
  assert.equal(spec.kind, 'newdoc'); assert.deepEqual(JSON.parse(JSON.stringify(spec.bitDepths)), [8]);
  for (const bad of [null, { threshold: 0 }, { threshold: 256 }, { threshold: 1.5 }, { threshold: 5, inverse: 'x' }]) assert.throws(() => spec.validate(bad), (e) => e.code === 'IJ_BAD_ARGS');
  assert.ok(spec.scratchBytes({ width: 100, height: 100 }, { threshold: 5 }) >= 100 * 100 * 17);
  const view = Object.freeze({ id: 'd', name: 'cells.tif', width: 9, height: 9, bitDepth: 8, active: 0, calibration: { pixelWidth: 2, pixelHeight: 2, unit: 'um' }, channels: [{ data: sq9() }] });
  function sq9() { const a = new Uint8Array(81); for (let y = 1; y <= 7; y++) for (let x = 1; x <= 7; x++) a[y * 9 + x] = 200; return a; }
  const out = await spec.run(view, { threshold: 128, inverse: false }, null, { channel: 0, tick: async () => {}, check() {}, reserve() {} });
  assert.equal(out.length, 1); assert.equal(out[0].name, 'cells_LocThk'); assert.equal(out[0].bitDepth, 32); assert.equal(out[0].channels[0].data[4 * 9 + 4], 8);
  assert.equal(out[0].calibration.unit, 'um');
  const inv = await spec.run(view, { threshold: 128, inverse: true }, null, { channel: 0, tick: async () => {}, check() {}, reserve() {} });
  assert.equal(inv[0].channels[0].data[4 * 9 + 4], 0, 'the inverse case measures the other phase (the frame around the square)');
}

console.log(`ij fiji thickness: OK (${nCases} fixture runs, ${nInterior} interior pixels exact, ${nSurface} surface pixels differ as documented)`);
