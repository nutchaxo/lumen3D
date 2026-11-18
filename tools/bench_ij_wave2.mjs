// Benchmark of the heavy Advanced Studio operations on a synthetic 5735 x 5735 image (the size of a native
// Studio slice of a large embryo). NOT a test: tests/run_all.py only runs test_*.* files, so this is never part of CI.
//
//   node --max-old-space-size=4096 tools/bench_ij_wave2.mjs [--size 5735] [--only 8|16] [--ops regex]
//
// It runs the REAL worker code (ij-core, ij-analysis, ij-proc-shared, ij-engine and every ij-proc-<pkg>.js) inside a
// worker_threads Worker that stands in for the Web Worker (own global scope, no vm context), drives the engine through its own request protocol
// ({ id, cmd, args } -> { id, ok, result }) and times each request wall-clock, selection-free, one channel at a time
// (the "per channel" figure of PLAN-wave2 §5). Each step is undone (or its new images closed) before the next, so every
// operation starts from the same pixels. The engine runs with its production settings (adaptive bands, undo kept).
//
// The image is deterministic: ~size^2/12000 Gaussian blobs of 8-30 px over a speckled floor, 2 channels (the second a
// shifted, partly correlated copy, for Image Calculator and Costes). Binary operations run on an 8-bit mask of the
// first channel; they are 8-bit only, as in ImageJ, so the 16-bit column shows "-" for them.
//
// Expected (PLAN-wave2 §5, a desktop CPU): rolling ball r=50 2-5 s, EDM 1-2 s, Watershed 5-15 s, Find Maxima 1-3 s
// (5-10 s segmented), Rotate bilinear <= 2 s, Image Calculator <= 1 s, Costes <= 1 s (8/16-bit).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

// A real Web Worker looks names up in an ordinary global scope. Under vm.runInContext every `Math.*` / global lookup
// goes through the interceptor-backed global of the context, which inflates some timings 10-30x. So the whole bench
// (engine, request protocol, timing) runs in a worker_threads Worker, the scripts evaluated in that worker's own
// global with vm.runInThisContext; the main thread only launches the workers and prints the table.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const argv = process.argv.slice(2);
const argOf = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : dflt; };
const SIZE = Number(argOf('size', 5735));
const ONLY = argOf('only', '');
const OPS_RX = new RegExp(argOf('ops', '.'), 'i');

const PACKAGES = ['bg', 'filters', 'seg', 'multi', 'geom', 'roi', 'coloc'];
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

// ── the engine, in a context that plays the Web Worker ──
function startEngine() {
  const events = [];
  const pending = new Map();
  const w = globalThis;
  w.self = w;
  if (!w.navigator) w.navigator = {};
  w.postMessage = (m) => {
    if (m && !m.event && m.id !== undefined && pending.has(m.id)) {
      if (!m.ok && process.env.BENCH_DEBUG) console.error(JSON.stringify(m).slice(0, 400));
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.ok) p.resolve(m.result); else p.reject(Object.assign(new Error('engine ' + p.cmd + ': ' + (m.error && (m.error.code || m.error.message))), m.error || {}));
    } else if (m && m.event) events.push(m);
  };
  const run = (f) => vm.runInThisContext(read(f), { filename: f });
  for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-engine.js']) run(f);
  for (const p of PACKAGES) run(`ij-proc-${p}.js`);
  w.IJEngine.start(w, { storage: 'memory', budgetBytes: 12 * 1024 ** 3, idleMs: 3600000 });
  let seq = 0;
  const request = (cmd, args) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, cmd });
    w.onmessage({ data: { id, cmd, args: args || {} } });
  });
  return { w, request, events };
}

// ── the synthetic image ──
function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function makeField(size) {
  const rnd = lcg(12345);
  const acc = new Float32Array(size * size);
  const nBlobs = Math.round(size * size / 12000);
  for (let b = 0; b < nBlobs; b++) {
    const cx = rnd() * size, cy = rnd() * size, r = 8 + rnd() * 22, amp = 40 + rnd() * 180;
    const x0 = Math.max(0, Math.floor(cx - 2 * r)), x1 = Math.min(size - 1, Math.ceil(cx + 2 * r));
    const y0 = Math.max(0, Math.floor(cy - 2 * r)), y1 = Math.min(size - 1, Math.ceil(cy + 2 * r));
    const inv = 1 / (2 * r * r / 4);
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy, row = y * size;
      for (let x = x0; x <= x1; x++) { const dx = x - cx; acc[row + x] += amp * Math.exp(-(dx * dx + dy * dy) * inv); }
    }
  }
  return acc;
}
function fillChannel(field, size, bitDepth, shift, seed) {
  const rnd = lcg(seed);
  const n = size * size;
  const out = bitDepth === 8 ? new Uint8Array(n) : new Uint16Array(n);
  const max = bitDepth === 8 ? 255 : 65535, gain = bitDepth === 8 ? 1 : 200;
  for (let y = 0; y < size; y++) {
    const ys = Math.min(size - 1, y + shift) * size, row = y * size;
    for (let x = 0; x < size; x++) {
      const v = (field[ys + Math.min(size - 1, x + shift)] + 4 + rnd() * 6) * gain;
      out[row + x] = v > max ? max : v;
    }
  }
  return out;
}


// ── dense cases (a sparse blob mask hides every algorithm whose cost follows the foreground / the pass count) ──
// A "cells" mask: a Voronoi tessellation of ~SIZE^2/100000 jittered seeds (one per grid cell, so the nearest seed is always
// within the 5 x 5 neighbouring grid cells and the tessellation is exact), the cells white (255), a 1-px black line wherever
// the right or lower neighbour belongs to another cell. Deterministic.
function makeCellsMask(size) {
  const rnd = lcg(777);
  const g = Math.max(2, Math.round(Math.sqrt(size * size / 100000))); // 18 x 18 = 324 seeds at 5735
  const cell = size / g;
  const sx = new Float64Array(g * g), sy = new Float64Array(g * g);
  for (let j = 0; j < g; j++) for (let i = 0; i < g; i++) { sx[j * g + i] = (i + rnd()) * cell; sy[j * g + i] = (j + rnd()) * cell; }
  const id = new Uint16Array(size * size);
  for (let y = 0; y < size; y++) {
    const gj = Math.min(g - 1, Math.floor(y / cell));
    for (let x = 0; x < size; x++) {
      const gi = Math.min(g - 1, Math.floor(x / cell));
      let best = 1e30, bi = 0;
      for (let j = Math.max(0, gj - 2); j <= Math.min(g - 1, gj + 2); j++) for (let i = Math.max(0, gi - 2); i <= Math.min(g - 1, gi + 2); i++) {
        const k = j * g + i, dx = sx[k] - x, dy = sy[k] - y, d = dx * dx + dy * dy;
        if (d < best) { best = d; bi = k; }
      }
      id[y * size + x] = bi;
    }
  }
  const out = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const o = y * size + x;
    out[o] = (x + 1 < size && id[o + 1] !== id[o]) || (y + 1 < size && id[o + size] !== id[o]) ? 0 : 255;
  }
  return out;
}
// A smooth grey image of a few hundred LARGE blobs (radius 40-120 px): Find Maxima / segmented has long, gently sloping flanks to flood.
function makeBigBlobs(size) {
  const rnd = lcg(4242);
  const acc = new Float32Array(size * size);
  const nBlobs = Math.round(size * size / 100000);
  for (let b = 0; b < nBlobs; b++) {
    const cx = rnd() * size, cy = rnd() * size, r = 40 + rnd() * 80, amp = 60 + rnd() * 150;
    const x0 = Math.max(0, Math.floor(cx - 2 * r)), x1 = Math.min(size - 1, Math.ceil(cx + 2 * r));
    const y0 = Math.max(0, Math.floor(cy - 2 * r)), y1 = Math.min(size - 1, Math.ceil(cy + 2 * r));
    const inv = 1 / (2 * r * r / 4);
    for (let y = y0; y <= y1; y++) { const dy = y - cy, row = y * size; for (let x = x0; x <= x1; x++) { const dx = x - cx; acc[row + x] += amp * Math.exp(-(dx * dx + dy * dy) * inv); } }
  }
  const out = new Uint8Array(size * size);
  for (let i = 0; i < out.length; i++) { const v = acc[i] + 3; out[i] = v > 255 ? 255 : v; }
  return out;
}

// ── timing ──
const fmt = (ms) => (ms < 1000 ? ms.toFixed(0) + ' ms' : (ms / 1000).toFixed(2) + ' s');
const results = new Map(); // op -> { 8: ms|string, 16: ms|string }

async function timed(label, depth, fn) {
  if (!OPS_RX.test(label)) return;
  const row = results.get(label) || {};
  results.set(label, row);
  const t0 = performance.now();
  try { await fn(); row[depth] = performance.now() - t0; } catch (err) { row[depth] = 'ERR ' + (err && err.code || 'error'); console.error('  ' + label + ' (' + depth + '-bit): ' + (err && (err.message || err.code)) + (err && err.details ? ' ' + JSON.stringify(err.details) : '')); }
  console.error('  ' + label.padEnd(34) + String(depth).padStart(2) + '-bit  ' + (typeof row[depth] === 'number' ? fmt(row[depth]) : row[depth]));
}

async function benchDepth(bitDepth) {
  console.error(`\n== ${bitDepth}-bit, ${SIZE} x ${SIZE}, one channel at a time ==`);
  const { w, request } = startEngine();
  const t0 = performance.now();
  const field = makeField(SIZE);
  const img = w.IJImage.create({ name: 'bench' + bitDepth, width: SIZE, height: SIZE, bitDepth, channels: [{ name: 'A', color: '#00ff00' }, { name: 'B', color: '#ff00ff' }], calibration: { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'um' } });
  img.channels[0].data.set(fillChannel(field, SIZE, bitDepth, 0, 1));
  img.channels[1].data.set(fillChannel(field, SIZE, bitDepth, 3, 2));
  const bytes = w.IJTiff.write(img);
  const { docId } = await request('doc.open', { bytes, name: 'bench' });
  console.error(`  synthetic image built and opened in ${fmt(performance.now() - t0)}`);

  const step = async (op, params, extra) => {
    const r = await request('doc.run', Object.assign({ docId, op, params: params || {}, roi: null, channel: 0 }, extra || {}));
    if (r.newDocIds && r.newDocIds.length) { for (const id of r.newDocIds) await request('doc.close', { docId: id }); } else await request('doc.undo', { docId });
    return r;
  };
  const compute = (op, params, extra) => request('doc.compute', Object.assign({ docId, op, params, roi: null, channel: 0 }, extra || {}));

  await timed('Subtract Background r=50', bitDepth, () => step('subtractBackground', { radius: 50, light: false, createBackground: false, sliding: false, disableSmoothing: false, correctCorners: true }));
  await timed('Subtract Background paraboloid', bitDepth, () => step('subtractBackground', { radius: 50, light: false, createBackground: false, sliding: true, disableSmoothing: false, correctCorners: true }));
  await timed('Enhance Contrast saturated 0.35', bitDepth, () => compute('saturatedRange', { saturated: 0.35 }));
  await timed('Enhance Contrast Equalize', bitDepth, () => step('enhanceEqualize', { classic: false, rect: { x: 0, y: 0, w: SIZE, h: SIZE } }));
  await timed('Smooth (3x3)', bitDepth, () => step('filter3x3', { type: 'smooth' }));
  await timed('Unsharp Mask sigma 2', bitDepth, () => step('unsharpMask', { sigma: 2, weight: 0.6 }));
  await timed('Gaussian Blur sigma 2', bitDepth, () => step('gaussian', { sigma: 2, scaled: false }));
  await timed('Median r=2', bitDepth, () => step('rank', { type: 'median', radius: 2 }));
  await timed('Variance r=2', bitDepth, () => step('rankExtra', { type: 'variance', radius: 2 }));
  await timed('Top Hat r=10', bitDepth, () => step('topHat', { radius: 10, light: false, dontSubtract: false }));
  await timed('Rotate 30 deg bilinear', bitDepth, () => step('rotate', { angle: 30, interpolation: 'bilinear', rect: { x: 0, y: 0, w: SIZE, h: SIZE } }, { channel: 'all' }));
  await timed('Scale x0.5 bilinear (new)', bitDepth, () => step('scaleNew', { xscale: 0.5, yscale: 0.5, width: Math.round(SIZE / 2), height: Math.round(SIZE / 2), interpolation: 'bilinear', average: true, title: 'scaled' }, { channel: 'all', noRoi: true }));
  await timed('Bin 2x2 average', bitDepth, () => step('bin', { xshrink: 2, yshrink: 2, method: 'average' }, { channel: 'all' }));
  await timed('Image Calculator add (A + B)', bitDepth, () => step('imageCalculator', { op: 'add', float32: false, all: false, channel1: 0, channel2: 1 }, { docIds: [docId], noRoi: true }));
  await timed('Find Maxima count (prom. 10)', bitDepth, () => compute('findMaxima', { prominence: 10, strict: false, excludeEdges: false, light: false, aboveLower: null }));
  await timed('Find Maxima segmented', bitDepth, () => step('findMaximaImage', { output: 'segmented', prominence: 10, strict: false, excludeEdges: false, light: false, aboveLower: null }, { noRoi: true }));
  await timed('Colocalization Costes', bitDepth, () => compute('coloc', { ch1: 0, ch2: 1, doc2: null, mode: 'costes', t1: 0, t2: 0, excludeZero: false, denominator: 'all' }));
  await timed('Colocalization none', bitDepth, () => compute('coloc', { ch1: 0, ch2: 1, doc2: null, mode: 'none', t1: 0, t2: 0, excludeZero: false, denominator: 'all' }));

  if (bitDepth === 8) {
    // an 8-bit binary mask of channel A: the blobs above 60 become 255
    const m = w.IJImage.create({ name: 'mask', width: SIZE, height: SIZE, bitDepth: 8, channels: [{ name: 'M', color: '#ffffff' }] });
    const a = img.channels[0].data, md = m.channels[0].data;
    for (let i = 0; i < md.length; i++) md[i] = a[i] > 60 ? 255 : 0;
    const mask = await request('doc.open', { bytes: w.IJTiff.write(m), name: 'mask' });
    const bin = async (op, params) => { const r = await request('doc.run', { docId: mask.docId, op, params: params || {}, roi: null, channel: 0 }); await request('doc.undo', { docId: mask.docId }); return r; };
    await timed('Distance Map (EDM)', bitDepth, () => bin('edm', { output: 'overwrite' }));
    await timed('Ultimate Points', bitDepth, () => bin('ultimatePoints', { output: 'overwrite' }));
    await timed('Watershed', bitDepth, () => bin('watershed', { output: 'overwrite' }));
    await timed('Voronoi', bitDepth, () => bin('voronoi', { output: 'overwrite' }));
    await timed('Skeletonize', bitDepth, () => bin('skeletonize', {}));
    await timed('Outline', bitDepth, () => bin('segOutline', {}));
    await timed('Erode (binary)', bitDepth, () => bin('binary', { op: 'erode' }));

    // dense cases: the 'cells' mask (white cells, 1-px black borders) and a smooth large-blob grey image
    const cm = w.IJImage.create({ name: 'cells', width: SIZE, height: SIZE, bitDepth: 8, channels: [{ name: 'M', color: '#ffffff' }] });
    cm.channels[0].data.set(makeCellsMask(SIZE));
    const cells = await request('doc.open', { bytes: w.IJTiff.write(cm), name: 'cells' });
    const dbin = async (op, params) => { const r = await request('doc.run', { docId: cells.docId, op, params: params || {}, roi: null, channel: 0 }); await request('doc.undo', { docId: cells.docId }); return r; };
    await timed('Distance Map (EDM) [dense]', bitDepth, () => dbin('edm', { output: 'overwrite' }));
    await timed('Ultimate Points [dense]', bitDepth, () => dbin('ultimatePoints', { output: 'overwrite' }));
    await timed('Watershed [dense]', bitDepth, () => dbin('watershed', { output: 'overwrite' }));
    await timed('Voronoi [dense]', bitDepth, () => dbin('voronoi', { output: 'overwrite' }));
    await timed('Skeletonize [dense]', bitDepth, () => dbin('skeletonize', {}));
    await timed('Outline [dense]', bitDepth, () => dbin('segOutline', {}));
    await timed('Erode (binary) [dense]', bitDepth, () => dbin('binary', { op: 'erode' }));
    const bb = w.IJImage.create({ name: 'bigblobs', width: SIZE, height: SIZE, bitDepth: 8, channels: [{ name: 'A', color: '#00ff00' }] });
    bb.channels[0].data.set(makeBigBlobs(SIZE));
    const big = await request('doc.open', { bytes: w.IJTiff.write(bb), name: 'bigblobs' });
    await timed('Find Maxima segmented [big blobs]', bitDepth, async () => {
      const r = await request('doc.run', { docId: big.docId, op: 'findMaximaImage', params: { output: 'segmented', prominence: 10, strict: false, excludeEdges: false, light: false, aboveLower: null }, roi: null, channel: 0, noRoi: true });
      for (const id of (r.newDocIds || [])) await request('doc.close', { docId: id });
    });
  }
}

function printTable() {
  const names = Array.from(results.keys());
  const w0 = Math.max(...names.map((n) => n.length), 9);
  const cell = (v) => (v === undefined ? '-' : typeof v === 'number' ? fmt(v) : String(v));
  const lines = [`| ${'Operation'.padEnd(w0)} | ${'8-bit'.padStart(9)} | ${'16-bit'.padStart(9)} |`, `|${'-'.repeat(w0 + 2)}|${'-'.repeat(10)}:|${'-'.repeat(10)}:|`];
  for (const n of names) lines.push(`| ${n.padEnd(w0)} | ${cell(results.get(n)[8]).padStart(9)} | ${cell(results.get(n)[16]).padStart(9)} |`);
  console.log(`\n${SIZE} x ${SIZE} pixels, one channel (node ${process.version}, ${process.platform}), wall-clock of one request, production engine settings\n`);
  console.log(lines.join('\n'));
}

if (isMainThread) {
  for (const bd of [8, 16]) {
    if (ONLY && Number(ONLY) !== bd) continue;
    await new Promise((resolve) => {
      const w = new Worker(fileURLToPath(import.meta.url), { argv: process.argv.slice(2), workerData: { depth: bd }, resourceLimits: { maxOldGenerationSizeMb: 12288, stackSizeMb: 8 } });
      w.on('message', (rows) => { for (const [k, v] of rows) results.set(k, Object.assign(results.get(k) || {}, v)); });
      w.on('error', (e) => { console.error(e); process.exitCode = 1; });
      w.on('exit', resolve);
    });
  }
  printTable();
  process.exit(process.exitCode || 0);
} else {
  await benchDepth(workerData.depth);
  parentPort.postMessage(Array.from(results));
  setTimeout(() => process.exit(0), 50); // the engine's timers and message channels would keep the worker alive
}
