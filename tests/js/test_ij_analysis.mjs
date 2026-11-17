// ij-analysis.js: ImageJ thresholds, binary morphology, particle analysis, Gaussian and rank filters.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';

const src = readFileSync(path.join(ROOT, 'js/modules/studio/advanced-studio/ij-analysis.js'), 'utf8');
const holder = {};
new Function('self', src)(holder); // same realm: typed arrays compare directly
const { IJThreshold, IJBinary, IJParticles, IJFilters } = holder;
assert.ok(IJThreshold && IJBinary && IJParticles && IJFilters, 'the four globals are attached to self');

function near(a, b, tol, msg) {
  assert.ok(Math.abs(a - b) <= tol, `${msg || 'near'}: ${a} vs ${b} (tol ${tol})`);
}

// Deterministic PRNG so failures reproduce.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
function gauss(r) { return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r()); }

function bimodal8(lo, hi, sd, n, seed) {
  const r = rng(seed), counts = new Float64Array(256);
  for (let i = 0; i < n; i++) {
    const v = Math.round((i & 1 ? hi : lo) + sd * gauss(r));
    counts[Math.max(0, Math.min(255, v))]++;
  }
  return counts;
}

function spikes(a, b, n) {
  const c = new Float64Array(256);
  c[a] = n; c[b] = n;
  return c;
}

// ---------------------------------------------------------------- thresholds
{
  assert.deepEqual(IJThreshold.methods(), ['Default', 'Huang', 'IsoData', 'Li', 'MaxEntropy', 'Mean', 'Otsu', 'Triangle']);

  // Two equal spikes at 50 and 200: every closed form is known.
  const sp = spikes(50, 200, 1000);
  assert.equal(IJThreshold.level(sp, 'Mean'), 125, 'Mean = floor(125)');
  assert.equal(IJThreshold.level(sp, 'Default'), 125, 'IJ_IsoData: (50+200)/2');
  assert.equal(IJThreshold.level(sp, 'IsoData'), 125, 'intermeans: (50+200)/2');
  assert.equal(IJThreshold.level(sp, 'Otsu'), 50, 'Otsu: first maximum of the between-class variance');
  assert.equal(IJThreshold.level(sp, 'Li'), 108, 'Li: (200-50)/ln(200/50) = 108.2 → 108');

  // Triangle by hand: peak 50 at bin 0, tail 30,10,5,2,1 → ImageJ mirrors the histogram,
  // the largest distance to the peak-to-tail line is at reversed bin 253 → split 252 → 255-252.
  const tri = new Float64Array(256);
  [50, 30, 10, 5, 2, 1].forEach((v, i) => { tri[i] = v; });
  assert.equal(IJThreshold.level(tri, 'Triangle'), 3, 'Triangle (hand-computed)');

  // Equal-weight Gaussian mixture, modes 60 and 190: symmetry gives the midpoint (125).
  const mix = bimodal8(60, 190, 12, 40000, 7);
  const t = {};
  for (const m of IJThreshold.methods()) t[m] = IJThreshold.level(mix, m);
  for (const m of IJThreshold.methods()) assert.ok(t[m] > 75 && t[m] < 175, `${m} between the modes: ${t[m]}`);
  near(t.Mean, 125, 2, 'Mean midpoint');
  assert.ok(t.Otsu >= 96 && t.Otsu <= 154, `Otsu inside the empty valley (the criterion is flat there): ${t.Otsu}`);
  near(t.Default, 125, 2, 'Default midpoint');
  near(t.IsoData, 125, 2, 'IsoData midpoint');
  near(t.Li, 113, 6, 'Li ≈ (190-60)/ln(190/60) = 112.8');
  assert.ok(t.MaxEntropy > 90 && t.MaxEntropy < 160, `MaxEntropy in the valley: ${t.MaxEntropy}`);
  assert.ok(t.Huang > 90 && t.Huang < 160, `Huang in the valley: ${t.Huang}`);
  near(t.Triangle, 125, 60, 'Triangle between the modes');

  // Otsu's variance criterion is maximal at its own answer (brute force over the histogram).
  {
    const total = mix.reduce((a, b) => a + b, 0);
    const bcv = (k) => {
      let n1 = 0, s1 = 0, S = 0;
      for (let i = 0; i < 256; i++) S += i * mix[i];
      for (let i = 0; i <= k; i++) { n1 += mix[i]; s1 += i * mix[i]; }
      const n2 = total - n1;
      if (!n1 || !n2) return 0;
      const m1 = s1 / n1, m2 = (S - s1) / n2;
      return (n1 / total) * (n2 / total) * (m1 - m2) * (m1 - m2);
    };
    let best = 0;
    for (let k = 0; k < 256; k++) if (bcv(k) > bcv(best)) best = k;
    assert.ok(bcv(t.Otsu) >= bcv(best) * (1 - 1e-9), 'Otsu maximises the between-class variance');
  }

  // Method names: case-insensitive, unknown refused, a histogram must have 256 bins; empty → 0.
  assert.equal(IJThreshold.level(sp, 'otsu'), 50);
  assert.throws(() => IJThreshold.level(sp, 'Nope'), (e) => e.code === 'IJ_BAD_METHOD');
  assert.throws(() => IJThreshold.level(new Float64Array(100), 'Otsu'), (e) => e.code === 'IJ_BAD_HISTOGRAM');
  assert.equal(IJThreshold.level(new Float64Array(256), 'Huang'), 0);
  // Not mutated: Default zeroes bins 0 and 255 on a copy only.
  const edge = spikes(0, 255, 10);
  IJThreshold.level(edge, 'Default');
  assert.equal(edge[0], 10); assert.equal(edge[255], 10);

  // levels(): dark / light semantics on a real 8-bit image.
  const w = 20, h = 20, d = new Uint8Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = (i % 20) < 10 ? 50 : 200;
  const ch8 = { width: w, height: h, bitDepth: 8, data: d };
  const dark = IJThreshold.levels(ch8, 'Otsu', { dark: true });
  assert.equal(dark.level, 50);
  assert.deepEqual([dark.lower, dark.upper], [51, 255]);
  const light = IJThreshold.levels(ch8, 'Otsu', { dark: false });
  assert.deepEqual([light.lower, light.upper], [0, 50]);
  const m = IJThreshold.toMask(ch8, dark.lower, dark.upper);
  assert.equal(m.filter((v) => v === 255).length, 200, 'bright half selected');
  assert.equal(m.filter((v) => v === 0).length, 200);
  // mask box restricts the histogram: only the dark left half → degenerate but defined.
  const mb = { x: 0, y: 0, w: 10, h: 20, data: new Uint8Array(200).fill(1) };
  const hs = IJThreshold.histogram(ch8, { maskBox: mb });
  assert.equal(hs.counts[50], 200); assert.equal(hs.counts[200], 0);

  // 16-bit: 256 bins over [min, max], bins mapped back with min + bin/255 · (max-min).
  const d16 = new Uint16Array(w * h);
  for (let i = 0; i < d16.length; i++) d16[i] = (i % 20) < 10 ? 1000 : 40000;
  const ch16 = { width: w, height: h, bitDepth: 16, data: d16 };
  const l16 = IJThreshold.levels(ch16, 'Otsu', { dark: true });
  assert.equal(l16.level, 0, 'spikes sit in bins 0 and 255');
  near(l16.lower, 1000 + (1 / 255) * 39000, 1e-9, '16-bit lower');
  near(l16.upper, 40000, 1e-9, '16-bit upper');
  const m16 = IJThreshold.toMask(ch16, l16.lower, l16.upper);
  assert.equal(m16.filter((v) => v === 255).length, 200);
  // 32-bit with NaN: NaN never counted nor selected.
  const d32 = new Float32Array(w * h);
  for (let i = 0; i < d32.length; i++) d32[i] = (i % 20) < 10 ? 0.25 : 3.5;
  d32[0] = NaN;
  const ch32 = { width: w, height: h, bitDepth: 32, data: d32 };
  const l32 = IJThreshold.levels(ch32, 'Mean', { dark: false });
  assert.ok(l32.upper >= 0.25 && l32.upper < 3.5 && l32.lower === 0.25);
  assert.equal(IJThreshold.toMask(ch32, 0, 1)[0], 0, 'NaN not selected');
  // Flat image: lower = upper = min.
  const flat = { width: 4, height: 4, bitDepth: 16, data: new Uint16Array(16).fill(700) };
  const lf = IJThreshold.levels(flat, 'Default', { dark: true });
  assert.deepEqual([lf.lower, lf.upper], [700, 700]);
  console.log('thresholds: OK');
}

// -------------------------------------------------------------------- binary
function grid(rows) {
  const h = rows.length, w = rows[0].length, a = new Uint8Array(w * h);
  rows.forEach((r, y) => [...r].forEach((c, x) => { if (c === '#') a[y * w + x] = 255; }));
  return { a, w, h };
}
function show(a, w, h) {
  const out = [];
  for (let y = 0; y < h; y++) {
    let s = '';
    for (let x = 0; x < w; x++) s += a[y * w + x] ? '#' : '.';
    out.push(s);
  }
  return out;
}
{
  const blk = grid([
    '.......',
    '.#####.',
    '.#####.',
    '.#####.',
    '.#####.',
    '.#####.',
    '.......'
  ]);
  const er = IJBinary.erode(blk.a, blk.w, blk.h);
  assert.deepEqual(show(er, 7, 7), ['.......', '.......', '..###..', '..###..', '..###..', '.......', '.......'], 'erode: 8-neighbourhood, count 1');
  const dil = IJBinary.dilate(er, 7, 7);
  assert.deepEqual(show(dil, 7, 7), show(blk.a, 7, 7), 'dilate undoes the erosion of a square');
  assert.ok(er.every((v) => v === 0 || v === 255) && er !== blk.a, 'a new 0/255 array');

  // channel call shape
  const viaCh = IJBinary.erode({ width: 7, height: 7, bitDepth: 8, data: blk.a });
  assert.deepEqual(Array.from(viaCh.data), Array.from(er));
  assert.equal(viaCh.bitDepth, 8);

  // Edge: out-of-image counts as background, so a block in the corner erodes from the border.
  const corner = grid(['###..', '###..', '###..', '.....']);
  assert.deepEqual(show(IJBinary.erode(corner.a, 5, 4), 5, 4), ['.....', '.#...', '.....', '.....']);
  // Dilation does not grow from outside.
  const one = grid(['#....', '.....', '.....']);
  assert.deepEqual(show(IJBinary.dilate(one.a, 5, 3), 5, 3), ['##...', '##...', '.....']);

  // count: a pixel needs >= count background neighbours to be eroded.
  const bar = grid(['.......', '.#####.', '.#####.', '.#####.', '.......']);
  const c3 = show(IJBinary.erode(bar.a, 7, 5, { count: 3 }), 7, 5);
  assert.deepEqual(c3, ['.......', '.......', '..###..', '.......', '.......'], 'an edge pixel has 3 background neighbours: count 3 removes it');
  assert.deepEqual(show(IJBinary.erode(bar.a, 7, 5, { count: 4 }), 7, 5), ['.......', '..###..', '.#####.', '..###..', '.......'], 'count 4 removes only the corners (5 background neighbours)');
  // iterations
  const er2 = IJBinary.erode(blk.a, 7, 7, { iterations: 2 });
  assert.deepEqual(show(er2, 7, 7), ['.......', '.......', '.......', '...#...', '.......', '.......', '.......']);

  // open removes specks and keeps big blocks; close fills 1-pixel gaps.
  const speck = grid(['.........', '.#.......', '.....###.', '.....###.', '.....###.', '.........']);
  assert.deepEqual(show(IJBinary.open(speck.a, 9, 6), 9, 6), ['.........', '.........', '.....###.', '.....###.', '.....###.', '.........']);
  const gap = grid(['.........', '.###.###.', '.###.###.', '.###.###.', '.........']);
  assert.deepEqual(show(IJBinary.close(gap.a, 9, 5), 9, 5), ['.........', '.#######.', '.#######.', '.#######.', '.........']);

  // fillHoles: 4-connected background reaching the border stays; enclosed ones are filled,
  // including a hole enclosed only diagonally (flood is 4-connected).
  const ring = grid(['#######', '#.....#', '#.#.#.#', '#.....#', '#######']);
  assert.ok(IJBinary.fillHoles(ring.a, 7, 5).every((v) => v === 255), 'enclosed hole + island filled');
  const open = grid(['#####', '#...#', '#...#', '##.##']);
  assert.deepEqual(show(IJBinary.fillHoles(open.a, 5, 4), 5, 4), show(open.a, 5, 4), 'leaking cavity is not filled');
  const diag = grid(['..#..', '.#.#.', '..#..', '.....']);
  assert.deepEqual(show(IJBinary.fillHoles(diag.a, 5, 4), 5, 4), ['..#..', '.###.', '..#..', '.....'], 'diagonal enclosure is a hole');

  // outline: the 1-pixel border of a filled shape.
  const sq = grid(['.......', '.#####.', '.#####.', '.#####.', '.#####.', '.#####.', '.......']);
  assert.deepEqual(show(IJBinary.outline(sq.a, 7, 7), 7, 7),
    ['.......', '.#####.', '.#...#.', '.#...#.', '.#...#.', '.#####.', '.......']);
  // touching the image border: those pixels are outline (outside = background)
  const edgeSq = grid(['###', '###', '###']);
  assert.deepEqual(show(IJBinary.outline(edgeSq.a, 3, 3), 3, 3), ['###', '#.#', '###']);
  assert.throws(() => IJBinary.erode(blk.a, 7, 7, { count: 9 }), (e) => e.code === 'IJ_BAD_PARAMS');
  assert.throws(() => IJBinary.erode(blk.a, 6, 7), (e) => e.code === 'IJ_BAD_IMAGE');
  console.log('binary: OK');
}

// ----------------------------------------------------------------- particles
{
  function rects(w, h, list) {
    const a = new Uint8Array(w * h);
    for (const [x0, y0, ww, hh] of list) for (let y = y0; y < y0 + hh; y++) for (let x = x0; x < x0 + ww; x++) a[y * w + x] = 255;
    return a;
  }
  const W = 30, H = 20;
  const m = rects(W, H, [[2, 2, 3, 3], [10, 4, 2, 2], [20, 10, 1, 1]]);
  const r = IJParticles.analyze(m, W, H, {});
  assert.equal(r.count, 3);
  assert.deepEqual(r.particles.map((p) => p.areaPx), [9, 4, 1], 'raster order of the first pixel');
  near(r.particles[0].perimeter, 12 - 4 * (2 - Math.SQRT2), 1e-12, '3×3 perimeter (ImageJ traced)');
  near(r.particles[1].perimeter, 8 - 4 * (2 - Math.SQRT2), 1e-12, '2×2 perimeter = 5.657 (ImageJ documentation)');
  near(r.particles[2].perimeter, 4 - 2 * (2 - Math.SQRT2), 1e-12, '1×1 perimeter = 2√2 (ImageJ documentation)');
  assert.equal(r.particles[2].circularity, 1, 'circularity capped at 1');
  near(r.particles[0].circularity, Math.min(1, 4 * Math.PI * 9 / ((12 - 4 * (2 - Math.SQRT2)) ** 2)), 1e-12);
  const p0 = r.particles[0];
  assert.deepEqual([p0.bx, p0.by, p0.bw, p0.bh], [2, 2, 3, 3]);
  near(p0.xCentroid, 3.5, 1e-12); near(p0.yCentroid, 3.5, 1e-12);
  assert.equal(p0.outline.length, 4);
  assert.deepEqual(p0.outline.map((p) => p.join(',')).sort(), ['2,2', '2,5', '5,2', '5,5']);
  assert.equal(r.totalArea, 14); near(r.averageSize, 14 / 3, 1e-12);
  near(r.areaFraction, 14 / (W * H), 1e-12);
  near(r.percentArea, 100 * 14 / (W * H), 1e-9);

  // Calibration: area and perimeter in µm, centroid in µm.
  const rc = IJParticles.analyze(m, W, H, { calibration: { pixelWidth: 0.5, pixelHeight: 0.5 } });
  near(rc.particles[0].area, 9 * 0.25, 1e-12);
  near(rc.particles[0].perimeter, 0.5 * (12 - 4 * (2 - Math.SQRT2)), 1e-12);
  near(rc.particles[0].circularity, r.particles[0].circularity, 1e-12, 'isotropic scaling keeps circularity');
  near(rc.particles[0].xCentroid, 1.75, 1e-12);

  // 8-connectivity: diagonal pixels are one particle (outline visits the touching corner twice).
  const dg = new Uint8Array(5 * 5);
  dg[1 * 5 + 1] = 255; dg[2 * 5 + 2] = 255; dg[3 * 5 + 3] = 255;
  const rd = IJParticles.analyze(dg, 5, 5, {});
  assert.equal(rd.count, 1); assert.equal(rd.particles[0].areaPx, 3);

  // Holes: area excludes them by default, includes them with includeHoles.
  const ring = new Uint8Array(7 * 7);
  for (let y = 1; y <= 5; y++) for (let x = 1; x <= 5; x++) ring[y * 7 + x] = 255;
  ring[3 * 7 + 3] = 0;
  const rh1 = IJParticles.analyze(ring, 7, 7, {});
  assert.equal(rh1.count, 1); assert.equal(rh1.particles[0].areaPx, 24);
  const rh2 = IJParticles.analyze(ring, 7, 7, { includeHoles: true });
  assert.equal(rh2.particles[0].areaPx, 25);
  near(rh2.particles[0].xCentroid, 3.5, 1e-12);
  // Island in a hole: counted separately by default, swallowed with includeHoles.
  const isl = new Uint8Array(9 * 9);
  for (let y = 1; y <= 7; y++) for (let x = 1; x <= 7; x++) isl[y * 9 + x] = 255;
  for (let y = 2; y <= 6; y++) for (let x = 2; x <= 6; x++) isl[y * 9 + x] = 0;
  isl[4 * 9 + 4] = 255;
  const ri1 = IJParticles.analyze(isl, 9, 9, {});
  assert.deepEqual(ri1.particles.map((p) => p.areaPx), [24, 1], 'ring (49-25) then the island');
  const ri2 = IJParticles.analyze(isl, 9, 9, { includeHoles: true });
  assert.deepEqual(ri2.particles.map((p) => p.areaPx), [49]);

  // Filters: size (pixels), circularity, edges.
  const big = rects(30, 20, [[0, 0, 4, 4], [10, 5, 5, 5], [20, 8, 2, 2], [26, 15, 4, 5]]);
  assert.equal(IJParticles.analyze(big, 30, 20, {}).count, 4);
  assert.deepEqual(IJParticles.analyze(big, 30, 20, { minSize: 5 }).particles.map((p) => p.areaPx), [16, 25, 20]);
  assert.deepEqual(IJParticles.analyze(big, 30, 20, { minSize: 5, maxSize: 20 }).particles.map((p) => p.areaPx), [16, 20]);
  assert.deepEqual(IJParticles.analyze(big, 30, 20, { excludeEdges: true }).particles.map((p) => p.areaPx), [25, 4]);
  // A thin 1×9 bar has a low circularity; the square a high one.
  const shapes = rects(30, 20, [[2, 2, 9, 1], [10, 10, 6, 6]]);
  const rs = IJParticles.analyze(shapes, 30, 20, {});
  assert.ok(rs.particles[0].circularity < 0.5 && rs.particles[1].circularity > 0.8);
  assert.deepEqual(IJParticles.analyze(shapes, 30, 20, { minCirc: 0.8 }).particles.map((p) => p.areaPx), [36]);
  assert.deepEqual(IJParticles.analyze(shapes, 30, 20, { maxCirc: 0.5 }).particles.map((p) => p.areaPx), [9]);
  // Values other than 255 are foreground; the input is not modified.
  const copy = Array.from(big);
  IJParticles.analyze(big, 30, 20, {});
  assert.deepEqual(Array.from(big), copy);
  // Mask box restricts the analysis.
  const box = { x: 8, y: 0, w: 10, h: 20, data: new Uint8Array(200).fill(1) };
  assert.deepEqual(IJParticles.analyze(big, 30, 20, { maskBox: box }).particles.map((p) => p.areaPx), [25]);
  // Empty image.
  const empty = IJParticles.analyze(new Uint8Array(100), 10, 10, {});
  assert.equal(empty.count, 0); assert.equal(empty.averageSize, 0); assert.equal(empty.totalArea, 0);

  // A digital disk is nearly circular; a random blob field matches a flood-fill reference count.
  const D = 61, disk = new Uint8Array(D * D);
  for (let y = 0; y < D; y++) for (let x = 0; x < D; x++) if ((x - 30) ** 2 + (y - 30) ** 2 <= 400) disk[y * D + x] = 255;
  const rdk = IJParticles.analyze(disk, D, D, {});
  assert.equal(rdk.count, 1);
  assert.ok(rdk.particles[0].circularity > 0.85 && rdk.particles[0].circularity <= 1, `disk circularity ${rdk.particles[0].circularity}`);
  near(rdk.particles[0].areaPx, Math.PI * 400, 20, 'disk area');
  near(rdk.particles[0].xCentroid, 30.5, 1e-9);

  const R = rng(42), RW = 80, RH = 60, rnd = new Uint8Array(RW * RH);
  for (let i = 0; i < rnd.length; i++) rnd[i] = R() < 0.35 ? 255 : 0;
  const rr = IJParticles.analyze(rnd, RW, RH, {});
  // reference: 8-connected labelling
  const seen = new Uint8Array(rnd.length); const sizes = [];
  for (let i = 0; i < rnd.length; i++) {
    if (!rnd[i] || seen[i]) continue;
    const st = [i]; seen[i] = 1; let n = 0;
    while (st.length) {
      const j = st.pop(); n++;
      const x = j % RW, y = (j - x) / RW;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= RW || yy >= RH) continue;
        const k = yy * RW + xx;
        if (rnd[k] && !seen[k]) { seen[k] = 1; st.push(k); }
      }
    }
    sizes.push(n);
  }
  assert.equal(rr.count, sizes.length, 'component count equals the reference labelling');
  assert.deepEqual(rr.particles.map((p) => p.areaPx), sizes, 'component sizes equal the reference');
  console.log('particles: OK');
}

// ------------------------------------------------------------------ gaussian
function image(bd, w, h, f) {
  const d = bd === 8 ? new Uint8Array(w * h) : bd === 16 ? new Uint16Array(w * h) : new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = f(i % w, (i - (i % w)) / w, i);
  return { width: w, height: h, bitDepth: bd, data: d };
}
{
  assert.equal(IJFilters.kernelRadius(2, 0.002), 9, 'ceil(2·√(−2 ln 0.002)) + 1');
  assert.equal(IJFilters.kernelRadius(2, 0.0002), Math.ceil(2 * Math.sqrt(-2 * Math.log(0.0002))) + 1);

  // normalised kernel
  for (const sigma of [0.7, 1.5, 3, 8, 25]) {
    const k = IJFilters.makeKernel(sigma, 0.0002, 4000);
    let s = k.kernel[0];
    for (let i = 1; i < k.radius; i++) s += 2 * k.kernel[i];
    near(s, 1, 1e-5, `kernel sum σ=${sigma}`);
    for (let i = 1; i < k.radius; i++) assert.ok(k.kernel[i] <= k.kernel[i - 1] + 1e-9, 'monotone');
    near(k.sums[0] * 2 + k.kernel[0], 1, 1e-5, 'edge weights: centre + 2·tail = 1');
  }

  // impulse response ≈ analytic Gaussian (within the accuracy bound), symmetric, unit mass
  const N = 61, sigma = 2.5;
  const imp = image(32, N, N, (x, y) => (x === 30 && y === 30 ? 1 : 0));
  const g = IJFilters.gaussian(imp, sigma, sigma, {});
  assert.equal(g.width, N); assert.equal(g.bitDepth, 32);
  const peak = 1 / (2 * Math.PI * sigma * sigma);
  let mass = 0, worst = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const v = g.data[y * N + x];
    mass += v;
    worst = Math.max(worst, Math.abs(v - peak * Math.exp(-((x - 30) ** 2 + (y - 30) ** 2) / (2 * sigma * sigma))));
  }
  near(mass, 1, 1e-4, 'impulse mass');
  assert.ok(worst < 2e-3 * peak * 2, `impulse vs analytic Gaussian: ${worst / peak}`);
  for (let d = 1; d < 12; d++) {
    assert.equal(g.data[30 * N + 30 + d], g.data[30 * N + 30 - d], 'x symmetry');
    assert.equal(g.data[(30 + d) * N + 30], g.data[(30 - d) * N + 30], 'y symmetry');
    assert.equal(g.data[30 * N + 30 + d], g.data[(30 + d) * N + 30], 'isotropic');
  }

  // anisotropic: sigmaY = 0 blurs along x only
  const gx = IJFilters.gaussian(imp, 2, 0, {});
  for (let y = 0; y < N; y++) if (y !== 30) assert.equal(gx.data[y * N + 30], 0, 'no blur along y');
  assert.ok(gx.data[30 * N + 29] > 0);
  const gn = IJFilters.gaussian(imp, 0, 0, {});
  assert.deepEqual(Array.from(gn.data), Array.from(imp.data), 'σ = 0 is the identity');

  // constants are preserved at every depth, edges included
  for (const [bd, v] of [[8, 100], [16, 12345], [32, 2.5]]) {
    const c = image(bd, 17, 13, () => v);
    const o = IJFilters.gaussian(c, 3, 2, {});
    for (let i = 0; i < o.data.length; i++) near(o.data[i], v, bd === 32 ? 1e-5 : 0, `constant ${bd}-bit`);
  }
  // Flipped input gives the flipped output (edge replication is symmetric).
  const rnd = rng(3);
  const a = image(16, 24, 18, () => Math.floor(rnd() * 60000));
  const af = image(16, 24, 18, (x, y) => a.data[y * 24 + (23 - x)]);
  const ga = IJFilters.gaussian(a, 2, 1.5, {}), gaf = IJFilters.gaussian(af, 2, 1.5, {});
  for (let y = 0; y < 18; y++) for (let x = 0; x < 24; x++) assert.equal(ga.data[y * 24 + x], gaf.data[y * 24 + (23 - x)]);

  // 8-bit: rounded half up and clamped; mean brightness kept
  const step = image(8, 40, 8, (x) => (x < 20 ? 0 : 255));
  const gs = IJFilters.gaussian(step, 3, 0, {});
  assert.ok(gs.data[0] === 0 && gs.data[39] === 255 && gs.data[19] > 100 && gs.data[19] < 155);
  assert.ok(gs.data.every((v, i) => i % 40 === 0 || v >= gs.data[i - 1] || i % 40 === 0), 'monotone edge');

  // region = the same numbers as a crop of the full result, 3 bit depths, computed alone
  for (const bd of [8, 16, 32]) {
    const im = image(bd, 50, 40, () => Math.floor(rnd() * (bd === 8 ? 256 : 60000)));
    const full = IJFilters.gaussian(im, 2.2, 1.7, {});
    const reg = IJFilters.gaussian(im, 2.2, 1.7, { region: { x0: 7, y0: 5, x1: 31, y1: 22 } });
    assert.deepEqual([reg.width, reg.height, reg.x0, reg.y0], [24, 17, 7, 5]);
    for (let y = 0; y < 17; y++) for (let x = 0; x < 24; x++) {
      assert.equal(reg.data[y * 24 + x], full.data[(5 + y) * 50 + 7 + x], `region ${bd}-bit`);
    }
    // a region on the image edge, too
    const rEdge = IJFilters.gaussian(im, 2.2, 1.7, { region: { x0: 0, y0: 0, x1: 10, y1: 6 } });
    for (let y = 0; y < 6; y++) for (let x = 0; x < 10; x++) assert.equal(rEdge.data[y * 10 + x], full.data[y * 50 + x]);
  }
  assert.equal(IJFilters.gaussianApron(2, 0.002, 8), 8);
  assert.equal(IJFilters.gaussianApron(0, 0.002, 8), 0);
  assert.throws(() => IJFilters.gaussian(imp, 2, 2, { region: { x0: 5, y0: 5, x1: 5, y1: 9 } }), (e) => e.code === 'IJ_BAD_REGION');

  // cooperative hook: called with progress, may throw to cancel
  let calls = 0, lastDone = 0, total = 0;
  IJFilters.gaussian(image(8, 20, 200, () => 1), 2, 2, { yieldEvery: { rows: 50, fn: (d, t) => { calls++; lastDone = d; total = t; } } });
  assert.ok(calls >= 4 && lastDone <= total, `hook calls ${calls}`);
  assert.throws(() => IJFilters.gaussian(image(8, 20, 200, () => 1), 2, 2, { yieldEvery: () => { throw Object.assign(new Error('x'), { code: 'IJ_CANCELLED' }); } }),
    (e) => e.code === 'IJ_CANCELLED');
  console.log('gaussian: OK');
}

// -------------------------------------------------------------------- rank
{
  const off = IJFilters.kernelOffsets;
  assert.equal(off(0.5).nPixels, 5, 'radius 0.5: r²+1 = 1 → plus sign');
  assert.equal(off(1).nPixels, 9, 'radius 1: r²+1 = 2 → 3×3');
  assert.equal(off(2).nPixels, 21, 'radius 2: r²+1 = 5 → 5×5 without corners');
  assert.deepEqual(Array.from(off(2).dxs), [1, 2, 2, 2, 1]);
  assert.equal(off(1.6).nPixels, off(1.75).nPixels, 'ImageJ widens 1.5–1.75 to 1.75');
  assert.equal(off(2.6).nPixels, off(2.85).nPixels, 'and 2.5–2.85 to 2.85');
  assert.equal(off(3).nPixels, 37, 'radius 3: r²+1 = 10, half widths 1,2,3,3,3,2,1 → 37');
  assert.equal(IJFilters.rankApron(3), 3);

  // brute-force reference of the documented definition
  function brute(ch, radius, type) {
    const k = off(radius), { width: w, height: h, data } = ch, kR = k.kRadius;
    const out = new data.constructor(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const vals = [];
      for (let r = 0; r <= 2 * kR; r++) for (let dx = -k.dxs[r]; dx <= k.dxs[r]; dx++) {
        vals.push(data[Math.min(h - 1, Math.max(0, y + r - kR)) * w + Math.min(w - 1, Math.max(0, x + dx))]);
      }
      let v;
      if (type === 'min') v = Math.min(...vals);
      else if (type === 'max') v = Math.max(...vals);
      else if (type === 'mean') { v = vals.reduce((a, b) => a + b, 0) / vals.length; if (ch.bitDepth !== 32) v = Math.floor(v + 0.5); }
      else { vals.sort((a, b) => a - b); v = vals[vals.length >> 1]; }
      out[y * w + x] = v;
    }
    return out;
  }
  const R = rng(99);
  for (const bd of [8, 16, 32]) {
    const im = image(bd, 37, 29, () => (bd === 8 ? Math.floor(R() * 256) : bd === 16 ? Math.floor(R() * 65536) : R() * 100 - 20));
    for (const radius of [0.5, 1, 2, 3.5]) {
      for (const type of ['median', 'mean', 'min', 'max']) {
        const got = IJFilters.rank(im, radius, type, {});
        const want = brute(im, radius, type);
        for (let i = 0; i < want.length; i++) {
          const ok = bd === 32 && type === 'mean' ? Math.abs(got.data[i] - want[i]) < 1e-4 * (1 + Math.abs(want[i])) : got.data[i] === Math.fround(want[i]);
          if (!ok) assert.fail(`${bd}-bit ${type} r=${radius} px ${i}: ${got.data[i]} vs ${want[i]}`);
        }
        // a region equals the crop of the full result
        const reg = IJFilters.rank(im, radius, type, { region: { x0: 3, y0: 4, x1: 20, y1: 17 } });
        assert.deepEqual([reg.width, reg.height], [17, 13]);
        for (let y = 0; y < 13; y++) for (let x = 0; x < 17; x++) {
          assert.equal(Object.is(reg.data[y * 17 + x], got.data[(4 + y) * 37 + 3 + x]), true, `region ${bd}-bit ${type}`);
        }
      }
    }
  }

  // known patterns
  const delta = image(8, 9, 9, (x, y) => (x === 4 && y === 4 ? 255 : 0));
  assert.ok(IJFilters.rank(delta, 1, 'median', {}).data.every((v) => v === 0), 'median removes a hot pixel');
  const mx = IJFilters.rank(delta, 1, 'max', {});
  assert.equal(Array.from(mx.data).filter((v) => v === 255).length, 9, 'max spreads to the 3×3 kernel');
  const mx2 = IJFilters.rank(delta, 2, 'max', {});
  assert.equal(Array.from(mx2.data).filter((v) => v === 255).length, 21, 'radius 2 kernel has 21 pixels');
  const mn = IJFilters.rank(image(8, 9, 9, (x, y) => (x === 4 && y === 4 ? 0 : 255)), 1, 'min', {});
  assert.equal(Array.from(mn.data).filter((v) => v === 0).length, 9);
  const mean = IJFilters.rank(delta, 1, 'mean', {});
  assert.equal(mean.data[4 * 9 + 4], Math.floor(255 / 9 + 0.5)); // 28
  assert.equal(mean.data[0], 0);
  // constants and edges
  for (const bd of [8, 16, 32]) {
    const c = image(bd, 11, 7, () => 5);
    for (const t of ['median', 'mean', 'min', 'max']) assert.ok(IJFilters.rank(c, 2, t, {}).data.every((v) => v === 5));
  }
  // a vertical ramp is fixed by a median (monotone data, symmetric window)
  const ramp = image(16, 12, 12, (x, y) => y * 1000);
  const mr = IJFilters.rank(ramp, 2, 'median', {});
  for (let y = 2; y < 10; y++) assert.equal(mr.data[y * 12 + 5], y * 1000);
  // NaN: ignored in a window, NaN only when all NaN
  const nan = image(32, 5, 5, (x, y) => (x === 2 && y === 2 ? NaN : 4));
  const mnan = IJFilters.rank(nan, 1, 'median', {});
  assert.ok(mnan.data.every((v) => v === 4), 'NaN ignored by the median');
  const allNan = image(32, 3, 3, () => NaN);
  assert.ok(Number.isNaN(IJFilters.rank(allNan, 1, 'mean', {}).data[4]));

  // 16-bit larger kernels (two-level histogram) on a larger image
  const bigI = image(16, 120, 90, () => Math.floor(R() * 4000) * 16);
  const gotBig = IJFilters.rank(bigI, 6, 'median', { region: { x0: 10, y0: 10, x1: 60, y1: 40 } });
  const wantBig = brute(bigI, 6, 'median');
  for (let y = 0; y < 30; y++) for (let x = 0; x < 50; x++) assert.equal(gotBig.data[y * 50 + x], wantBig[(10 + y) * 120 + 10 + x]);

  assert.throws(() => IJFilters.rank(delta, 1, 'mode', {}), (e) => e.code === 'IJ_BAD_PARAMS');
  assert.throws(() => IJFilters.rank(delta, -1, 'mean', {}), (e) => e.code === 'IJ_BAD_PARAMS');
  let ticks = 0;
  IJFilters.rank(image(8, 30, 300, () => 3), 1, 'median', { yieldEvery: { rows: 100, fn: () => { ticks++; } } });
  assert.equal(ticks, 3, 'hook every 100 rows');
  console.log('rank filters: OK');
}

console.log('ij-analysis: OK');
