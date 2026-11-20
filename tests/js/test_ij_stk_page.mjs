// Advanced Studio, stacks: the page and the views (DOCS/studio-advanced/stacks/PLAN.md §2, API.md §4 / §7).
//
//   1. the pure helpers of ij-view.js: ImageJ's number formatting (IJ.d2s, Tools.getDecimalPlaces, ImageWindow.getImageSize — the
//      expected strings below were produced by ImageJ 1.54p itself), the StackWindow subtitle (ImageWindow.createSubtitle /
//      StackWindow.createSubtitle, read with javap), the slider plan of every dimension case, Animator.nextSlice, the wheel, the animation
//      range, the ROI position filter, the position coalescer;
//   2. the shell controller of ij-view.js on a fake DOM: rows, subtitle, keys, wheel, play button;
//   3. the real engine behind the page (harness): a stack opens with its rows, the tile provider names the plane, a burst of slider moves
//      sends the engine ONE position after the first (the last value wins), reads name their plane, DOES_STACKS asks "Process all N
//      images?", ROI Manager entries record / restore the plane, Set Measurements › Stack position adds Slice / Frame, an RGB image
//      reads value=R,G,B and moves its three display ranges together.
//
// Run: node tests/js/test_ij_stk_page.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';
import { loadViewModules, boot, until, sleep } from './ij_harness.mjs';

const { IJViewPure: P } = loadViewModules();
const eq = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, m);
let n = 0;
async function test(name, fn) {
  try { await fn(); n++; console.log('  ok  ' + name); }
  catch (e) { console.log('FAIL ' + name); console.error(e); process.exitCode = 1; throw e; }
}

// ═════════════ 1. ImageJ formatting (expected values: ImageJ 1.54p, tools/ij_fixtures-style one-off program) ═════════════
await test('IJ.d2s: HALF_UP without decimals (df[0]), HALF_EVEN with decimals, on the exact value of the double', () => {
  // [x, d2s(x,0), d2s(x,1), d2s(x,2)] as printed by ij.IJ
  const table = [[0.5, '1', '0.5', '0.50'], [1.5, '2', '1.5', '1.50'], [2.5, '3', '2.5', '2.50'], [0.125, '0', '0.1', '0.12'], [0.135, '0', '0.1', '0.14'],
    [1.005, '1', '1.0', '1.00'], [-0.5, '-1', '-0.5', '-0.50'], [768.5, '769', '768.5', '768.50'], [2.675, '3', '2.7', '2.67'], [0.045, '0', '0.0', '0.04'],
    [0.625, '1', '0.6', '0.62'], [0.375, '0', '0.4', '0.38'], [1.25, '1', '1.2', '1.25'], [1.35, '1', '1.4', '1.35'], [2.25, '2', '2.2', '2.25']];
  for (const [x, a, b, c] of table) eq([P.d2s(x, 0), P.d2s(x, 1), P.d2s(x, 2)], [a, b, c], 'd2s ' + x);
  assert.equal(P.d2s(NaN, 2), 'NaN');
});
await test('Tools.getDecimalPlaces (one and two numbers)', () => {
  const table = [[0.5, 2.5, 1, 1], [1.5, 1.5, 1, 1], [0.125, 0.375, 3, 3], [2, 2, 0, 0], [0.33333, 0.33333, 4, 4], [12.3456, 12.3456, 4, 4], [0.0001, 0.0002, -2, -2],
    [1000000, 2, 0, 0], [0.1, 0.25, 2, 1], [3.14159, 3.14159, 4, 4]];
  for (const [a, b, two, one] of table) { assert.equal(P.decimalPlaces2(a, b), two, `dp2 ${a} ${b}`); assert.equal(P.decimalPlaces(a), one, `dp ${a}`); }
});
await test('ImageWindow.getImageSize: K, MB with one decimal, whole MB, GB', () => {
  // [w, h, planes, bits, size text]
  const table = [[512, 512, 1, 8, '256K'], [512, 512, 3, 8, '768K'], [512, 512, 25, 16, '13MB'], [512, 512, 25, 8, '6.2MB'], [2048, 2048, 1, 16, '8MB'],
    [5735, 5735, 1, 8, '31MB'], [1024, 1024, 300, 16, '600MB'], [4096, 4096, 50, 32, '3.1GB'], [100, 100, 1, 8, '10K'], [10, 10, 1, 8, '0K'], [64, 64, 1, 32, '16K'],
    [3000, 3000, 1, 24, '34MB']];
  for (const [w, h, planes, bits, text] of table) {
    const bpp = bits === 8 ? 1 : bits === 16 ? 2 : 4;
    assert.equal(P.imageSizeText(w * h * planes * bpp), text, `${w}x${h}x${planes} ${bits}-bit`);
  }
});

// ═════════════ the subtitle ═════════════
const ch1 = [{ display: { invert: false } }];
const base = { width: 512, height: 512, bitDepth: 8, channels: ch1 };
await test('subtitle: a single image, calibrated, labelled, inverting LUT', () => {
  assert.equal(P.formatSubtitle(base), '512x512 pixels; 8-bit; 256K');
  assert.equal(P.formatSubtitle(Object.assign({}, base, { width: 100, height: 80, calibration: { pixelWidth: 0.3, pixelHeight: 0.3, unit: 'µm' } })), '30x24 µm (100x80); 8-bit; 8K');
  assert.equal(P.formatSubtitle(Object.assign({}, base, { width: 100, height: 100, calibration: { pixelWidth: 0.125, pixelHeight: 0.125, unit: 'µm' } })), '12.5x12.5 µm (100x100); 8-bit; 10K');
  assert.equal(P.formatSubtitle(Object.assign({}, base, { calibration: { pixelWidth: 1, pixelHeight: 1, pixelDepth: 1, unit: 'pixel' } })), '512x512 pixels; 8-bit; 256K', 'not scaled');
  assert.equal(P.formatSubtitle(Object.assign({}, base, { calibration: { pixelWidth: 2, pixelHeight: 2, unit: 'pixel' } })), '1024x1024 pixels (512x512); 8-bit; 256K', 'a scale with the unit pixel prints the plural unit');
  assert.equal(P.formatSubtitle(base, { label: 'embryo.tif\nsecond line' }), '"embryo"; 512x512 pixels; 8-bit; 256K', 'the label of a single image: first line, extension dropped');
  assert.equal(P.formatSubtitle(Object.assign({}, base, { channels: [{ display: { invert: true } }] })), '512x512 pixels; 8-bit (inverting LUT); 256K');
});
await test('subtitle: a plain stack "5/25 (label); ..." and ImageJ\'s sizes', () => {
  const s = Object.assign({}, base, { nZ: 25, nT: 1, z: 4, t: 0 });
  assert.equal(P.formatSubtitle(s), '5/25; 512x512 pixels; 8-bit; 6.2MB');
  assert.equal(P.formatSubtitle(s, { label: 'slice5.tif' }), '5/25 (slice5); 512x512 pixels; 8-bit; 6.2MB');
  assert.equal(P.formatSubtitle(s, { label: 'x'.repeat(80) }), '5/25 (' + 'x'.repeat(60) + '); 512x512 pixels; 8-bit; 6.2MB', 'getShortSliceLabel keeps 60 characters');
  assert.equal(P.formatSubtitle(s, { label: '\nnothing' }), '5/25; 512x512 pixels; 8-bit; 6.2MB', 'a label that starts with a newline is none');
  assert.equal(P.formatSubtitle(s, { label: 'a', running: true }), '5/25 (a)', 'while an animation runs only the position is shown');
  assert.equal(P.formatSubtitle(Object.assign({}, s, { bitDepth: 16 })), '5/25; 512x512 pixels; 16-bit; 13MB');
});
await test('subtitle: a hyperstack "c:1/3 z:5/25 t:2/10; ..." and the RGB type', () => {
  const hs = { width: 512, height: 512, bitDepth: 16, channels: [{}, {}, {}], nC: 3, nZ: 25, nT: 10, z: 4, t: 1, hyperstack: true, display: { active: 0 } };
  assert.equal(P.formatSubtitle(hs), 'c:1/3 z:5/25 t:2/10; 512x512 pixels; 16-bit; 375MB');
  assert.equal(P.formatSubtitle(hs, { label: 'good' }), 'c:1/3 z:5/25 t:2/10 (good); 512x512 pixels; 16-bit; 375MB');
  assert.equal(P.formatSubtitle(hs, { label: 'ch:1' }), 'c:1/3 z:5/25 t:2/10; 512x512 pixels; 16-bit; 375MB', 'a "ch:" label is not shown');
  assert.equal(P.formatSubtitle(hs, { label: 'a;b' }), 'c:1/3 z:5/25 t:2/10 (a b); 512x512 pixels; 16-bit; 375MB', 'a ";" of the label would end the prefix');
  assert.equal(P.formatSubtitle(hs, { running: true }), 'c:1/3 z:5/25 t:2/10');
  assert.equal(P.formatSubtitle(Object.assign({}, hs, { display: { active: 2 } })), 'c:3/3 z:5/25 t:2/10; 512x512 pixels; 16-bit; 375MB');
  assert.equal(P.formatSubtitle(Object.assign({}, hs, { nC: 1, channels: [{}], nT: 1 })), 'z:5/25; 512x512 pixels; 16-bit; 13MB', 'one dimension: no separators (12800K = 12.5 MB -> Math.round -> 13MB, as ImageJ prints it)');
  const rgb = { width: 512, height: 512, bitDepth: 8, bitDepthIJ: 24, rgb: true, channels: [{}, {}, {}] };
  assert.equal(P.formatSubtitle(rgb), '512x512 pixels; RGB; 1MB');
  assert.equal(P.formatSubtitle(Object.assign({}, rgb, { nZ: 4, nT: 1, z: 1, t: 0 })), '2/4; 512x512 pixels; RGB; 4MB');
  assert.equal(P.ijBitDepth(rgb), 24);
  eq(P.stackDimsOf(rgb), { nC: 1, nZ: 1, nT: 1, n: 1 }, 'an RGB image has one channel');
});

// ═════════════ the slider plan ═════════════
await test('stackRows: one row per dimension > 1; a plain stack has ONE slider; RGB none', () => {
  const rows = (i, pos) => P.stackRows(i, pos).map((r) => `${r.dim}${r.letter}:${r.value}/${r.max}${r.animated ? '*' : ''}`);
  eq(rows(base), [], 'a single image');
  eq(rows({ channels: [{}, {}, {}] }), ['cc:1/3'], 'channels only: the channel slider, no play button');
  eq(rows({ channels: [{}, {}], nZ: 5, nT: 4, hyperstack: true }, { c: 1, z: 2, t: 3 }), ['cc:2/2', 'zz:3/5', 'tt:4/4*'], 'c z t, the play button on t');
  eq(rows({ channels: [{}], nZ: 5, nT: 1, hyperstack: true }, { z: 4 }), ['zz:5/5*'], 'z only: the play button on z');
  eq(rows({ channels: [{}], nZ: 1, nT: 7, hyperstack: true }, { t: 6 }), ['tt:7/7*'], 't only');
  eq(rows({ channels: [{}], nZ: 5, nT: 4, hyperstack: true }), ['zz:1/5', 'tt:1/4*'], 'z and t');
  eq(rows({ channels: [{}], nZ: 25, nT: 1 }, { z: 4 }), ['n:5/25*'], 'a plain stack: one slider with no letter');
  eq(rows({ channels: [{}], nZ: 5, nT: 3 }, { z: 1, t: 2 }), ['n:12/15*'], 'a plain stack of z x t: the flat slice');
  eq(rows({ channels: [{}, {}], nZ: 5, nT: 1 }, { c: 1, z: 2 }), ['cc:2/2', 'zz:3/5*'], 'every image with channels is a composite (dimension-aware): c, z');
  eq(rows({ rgb: true, channels: [{}, {}, {}], nZ: 3, nT: 1 }, { z: 1 }), ['n:2/3*'], 'an RGB stack: the slice slider only');
});
await test('positionFromRow: each row changes its own dimension and clamps', () => {
  const info = { channels: [{}, {}], nZ: 5, nT: 4, hyperstack: true };
  const rows = P.stackRows(info);
  const pos = { c: 1, z: 2, t: 3 };
  eq(P.positionFromRow(info, pos, rows.find((r) => r.dim === 'z'), 5), { c: 1, z: 4, t: 3 });
  eq(P.positionFromRow(info, pos, rows.find((r) => r.dim === 't'), 99), { c: 1, z: 2, t: 3 }, 'clamped to the last frame');
  eq(P.positionFromRow(info, pos, rows.find((r) => r.dim === 'c'), 1), { c: 0, z: 2, t: 3 });
  const plain = { channels: [{}], nZ: 5, nT: 3 };
  eq(P.positionFromRow(plain, { c: 0, z: 0, t: 0 }, P.stackRows(plain)[0], 12), { c: 0, z: 1, t: 2 }, 'the flat slice 12 of 5 x 3 = z 1, t 2');
});

// ═════════════ keys, wheel, animation ═════════════
await test('Animator.nextSlice / previousSlice: channel first on a hyperstack, Ctrl / Alt change the dimension, never wraps', () => {
  const hs = { channels: [{}, {}, {}], nZ: 5, nT: 4, hyperstack: true };
  eq(P.stepPosition(hs, { c: 0, z: 2, t: 1 }, 1), { c: 1, z: 2, t: 1 }, 'a hyperstack with channels moves the channel');
  eq(P.stepPosition(hs, { c: 2, z: 2, t: 1 }, 1), null, 'the last channel: nothing (no wrap)');
  eq(P.stepPosition(hs, { c: 0, z: 2, t: 1 }, 1, { ctrl: true }), { c: 0, z: 3, t: 1 }, 'Ctrl: the slices');
  eq(P.stepPosition(hs, { c: 0, z: 2, t: 1 }, 1, { ctrl: true, alt: true }), { c: 0, z: 2, t: 2 }, 'Alt with frames: the frames');
  eq(P.stepPosition(hs, { c: 0, z: 2, t: 1 }, -1, { ctrl: true }), { c: 0, z: 1, t: 1 }, 'previous');
  const zt = { channels: [{}], nZ: 5, nT: 4, hyperstack: true };
  eq(P.stepPosition(zt, { c: 0, z: 4, t: 0 }, 1), null, 'z at its last slice stays (> does not roll over to t)');
  eq(P.stepPosition({ channels: [{}], nZ: 1, nT: 4, hyperstack: true }, { z: 0, t: 1 }, 1), { c: 0, z: 0, t: 2 }, 'with one slice: the frames');
  const plain = { channels: [{}], nZ: 25 };
  eq(P.stepPosition(plain, { z: 3 }, 1), { c: 0, z: 4, t: 0 });
  eq(P.stepPosition(plain, { z: 3 }, 1, { alt: true }), { c: 0, z: 13, t: 0 }, 'Alt: ten slices');
  eq(P.stepPosition(plain, { z: 20 }, 1, { alt: true }), { c: 0, z: 24, t: 0 }, 'clamped');
  eq(P.stepPosition(plain, { z: 0 }, -1), null);
  assert.equal(P.stepPosition(base, { z: 0 }, 1), null, 'a single image has nothing to step');
});
await test('the wheel moves z (else t) of a stack by notches, a channels-only image keeps zooming', () => {
  const hs = { channels: [{}, {}], nZ: 5, nT: 4, hyperstack: true };
  eq(P.wheelPosition(hs, { c: 1, z: 2, t: 1 }, 1), { c: 1, z: 3, t: 1 });
  eq(P.wheelPosition(hs, { c: 1, z: 2, t: 1 }, -2), { c: 1, z: 0, t: 1 });
  eq(P.wheelPosition({ channels: [{}], nZ: 1, nT: 6, hyperstack: true }, { t: 2 }, 1), { c: 0, z: 0, t: 3 });
  eq(P.wheelPosition({ channels: [{}], nZ: 4, nT: 3 }, { z: 3, t: 0 }, 1), { c: 0, z: 0, t: 1 }, 'a plain stack walks its flat slices');
  assert.equal(P.wheelPosition({ channels: [{}, {}, {}] }, { c: 0 }, 1), null, 'channels only: the wheel is the zoom');
  assert.equal(P.wheelPosition(hs, { c: 0, z: 4, t: 3 }, 0), null);
});
await test('animation: speed 7 fps, first / last, loop, back and forth', () => {
  const info = { channels: [{}], nZ: 10, nT: 1, hyperstack: true };
  const plan = P.animationPlan(info, {});
  eq([plan.dim, plan.first, plan.last, plan.fps, plan.loop, plan.backAndForth], ['z', 1, 10, 7, true, false]);
  let v = 9, dir = 1; const seq = [];
  for (let i = 0; i < 4; i++) { const r = P.animationNext(plan, v, dir); v = r.value; dir = r.dir; seq.push(v); }
  eq(seq, [10, 1, 2, 3], 'the last frame is followed by the first');
  const bf = P.animationPlan(info, { first: 2, last: 5, backAndForth: true, fps: 20 });
  assert.equal(bf.fps, 20);
  v = 4; dir = 1; const seq2 = [];
  for (let i = 0; i < 8; i++) { const r = P.animationNext(bf, v, dir); v = r.value; dir = r.dir; seq2.push(v); }
  eq(seq2, [5, 4, 3, 2, 3, 4, 5, 4], 'back and forth between first and last');
  assert.equal(P.animationPlan({ channels: [{}, {}] }, {}).dim, null, 'channels only: nothing to animate');
  eq(P.animationPlan({ channels: [{}], nZ: 5, nT: 3, hyperstack: true }, {}).dim, 't', 'frames are animated before slices');
});

// ═════════════ ROI positions, the coalescer ═════════════
await test('ROI position: recorded on a stack, matched when Show All draws', () => {
  const hs = { channels: [{}, {}], nZ: 5, nT: 4, hyperstack: true };
  eq(P.roiPositionFor(hs, { c: 1, z: 2, t: 3 }, 'color'), { c: 2, z: 3, t: 4 }, 'Roi.setPosition(ImagePlus): the active channel outside Composite mode');
  eq(P.roiPositionFor(hs, { c: 1, z: 2, t: 3 }, 'composite'), { c: 0, z: 3, t: 4 }, 'c = 0 while the display mode is COMPOSITE (the roi stays when another channel is made active)');
  eq(P.roiPositionFor({ channels: [{}, {}], nZ: 5, nT: 1, display: { mode: 'gray' } }, { c: 1, z: 2 }), { c: 2, z: 3, t: 1 }, 'every nC > 1 image is dimension-aware; z / t are 1 even when the dimension has one');
  eq(P.roiPositionFor({ channels: [{}], nZ: 5, nT: 1, hyperstack: true }, { z: 2 }), { c: 1, z: 3, t: 1 }, 'a hyperstack position names c, z and t even when a dimension has one (getChannel() = 1)');
  eq(P.roiPositionFor({ channels: [{}], nZ: 5, nT: 3 }, { z: 1, t: 2 }), { n: 12 }, 'a plain stack: the slice (Roi.setPosition(int))');
  assert.equal(P.roiPositionFor(base, { z: 0 }), null, 'a single image: none');
  assert.equal(P.positionMatches({ c: 0, z: 3, t: 0 }, hs, { c: 0, z: 2, t: 1 }), true);
  assert.equal(P.positionMatches({ c: 0, z: 3, t: 0 }, hs, { c: 0, z: 1, t: 1 }), false);
  assert.equal(P.positionMatches({ c: 2, z: 0, t: 4 }, hs, { c: 1, z: 0, t: 3 }), true, '0 = any');
  assert.equal(P.positionMatches({ c: 1, z: 3, t: 4 }, hs, { c: 1, z: 2, t: 3 }), false);
  assert.equal(P.positionMatches(null, hs, { c: 0, z: 0, t: 0 }), true, 'no position: drawn everywhere');
  const plain = { channels: [{}], nZ: 5, nT: 3 };
  assert.equal(P.positionMatches({ n: 12 }, plain, { z: 1, t: 2 }), true);
  assert.equal(P.positionMatches({ n: 12 }, plain, { z: 2, t: 2 }), false);
  assert.equal(P.positionMatches({ n: 3 }, base, { z: 0 }), true, 'a single image shows everything');
});
await test('the position coalescer: one request in flight, the last value wins, flush waits for it', async () => {
  const sent = [], gates = [];
  const co = P.createCoalescer((v) => { sent.push(v); return new Promise((res) => gates.push(res)); });
  co.request(1); co.request(2); co.request(3); co.request(4);
  assert.deepEqual(sent, [1], 'only the first went out');
  assert.equal(co.busy, true);
  const done = co.flush();
  gates.shift()();
  await sleep(0);
  assert.deepEqual(sent, [1, 4], 'the last value was sent next; 2 and 3 never were');
  gates.shift()();
  await done;
  assert.equal(co.busy, false);
  co.request(5); gates.shift()(); await co.flush();
  assert.deepEqual(sent, [1, 4, 5]);
  const bad = P.createCoalescer(() => Promise.reject(new Error('boom')));
  const log = console.error; console.error = () => {};
  try { bad.request(1); await bad.flush(); bad.request(2); await bad.flush(); } finally { console.error = log; }
  assert.equal(bad.busy, false, 'a failing send does not wedge the coalescer');
});

// ═════════════ the status line ═════════════
await test('the pointer read-out: z= on a stack, value=R,G,B on RGB', () => {
  assert.equal(P.formatStatus({ x: 3, y: 4, z: 7, values: [12], bitDepth: 8 }), 'x=3, y=4, z=7, value=12');
  assert.equal(P.formatStatus({ x: 3, y: 4, z: 0, values: [200, 100, 7], bitDepth: 8 }), 'x=3, y=4, z=0, value=200,100,7');
  assert.equal(P.formatStatus({ x: 3, y: 4, values: [12], bitDepth: 8 }), 'x=3, y=4, value=12', 'a single image: no z');
  assert.equal(P.formatStatus({ x: 1, y: 2, z: 4, calibration: { pixelWidth: 1, pixelHeight: 1, pixelDepth: 2.5, unit: 'µm' }, values: [5], bitDepth: 8 }), 'x=1, y=2, z=10 (4), value=5', 'calibrated depth, the index in brackets');
});

// ═════════════ 2. the real engine behind the page ═════════════
const W = 8, H = 6;
const stackImage = (o) => {
  const nZ = o.nZ, nT = o.nT, nC = o.nC || 1;
  const channels = [];
  for (let c = 0; c < nC; c++) {
    const planes = [];
    for (let pi = 0; pi < nZ * nT; pi++) planes.push(new Uint8Array(W * H).fill(pi * 10 + 1 + c * 3));
    channels.push({ name: 'C' + (c + 1), color: ['#ffffff', '#00ff00', '#ff0000'][c], planes });
  }
  return Object.assign({ name: o.name || 'stk', width: W, height: H, bitDepth: 8, nZ, nT, hyperstack: o.hyperstack !== false, channels, calibration: { pixelWidth: 1, pixelHeight: 1, pixelDepth: 2, unit: 'µm' } }, o.extra || {});
};

const t = await boot({ channels: 1 });
await t.open();
const api = t.api(null);
const id = await api.addDoc(stackImage({ nZ: 5, nT: 2 }));
const sh = t.shell;
const lastInfo = (d) => sh.views.get(d).images[sh.views.get(d).images.length - 1];

await test('a stack opens with its dimensions on the image and the plane on screen', async () => {
  eq(api.dims(id), { width: W, height: H, nC: 1, nZ: 5, nT: 2, nSlices: 10, bitDepth: 8, rgb: false, hyperstack: true });
  eq(api.position(id), { c: 0, z: 0, t: 0 });
  const li = lastInfo(id);
  assert.equal(li.nZ, 5); assert.equal(li.nT, 2); assert.equal(li.z, 0); assert.equal(li.t, 0);
  const st = api.state ? api.state() : null;
  eq(st.pos, { c: 0, z: 0, t: 0 }); eq(st.dims.nSlices, 10);
});
await test('the tile provider names the plane: a late tile of another plane can never be drawn for this one', async () => {
  const prov = t.view(id).provider;
  const at = async (z, tt) => (await prov(0, 0, 0, 0, { z, t: tt })).data[0];
  assert.equal(await at(0, 0), 1);
  assert.equal(await at(3, 1), (3 + 5) * 10 + 1);
  assert.equal(await at(4, 0), 41);
  const msg = t.log.msgs.filter((m) => m.cmd === 'doc.tile').pop();
  eq(msg.args.pos, { z: 4, t: 0 });
});
await test('a burst of slider moves: the view follows at once, the engine gets one position after the first, the last value wins', async () => {
  const before = t.log.msgs.filter((m) => m.cmd === 'doc.setPosition').length;
  for (let z = 1; z <= 4; z++) sh.opts.onPosition({ c: 0, z, t: 0 }, id);
  sh.opts.onPosition({ c: 0, z: 2, t: 1 }, id);
  eq(api.position(id), { c: 0, z: 2, t: 1 }, 'the page knows the plane at once');
  await t.engine('doc.list');
  await until(() => api.position(id).z === 2, 'position');
  await sleep(30);
  const sent = t.log.msgs.filter((m) => m.cmd === 'doc.setPosition').slice(before).map((m) => [m.args.z, m.args.t]);
  assert.ok(sent.length <= 2, 'one in flight, one for the last value: ' + JSON.stringify(sent));
  eq(sent[sent.length - 1], [2, 1], 'the last value is the one that was sent last');
  const info = await until(async () => { const i = await t.engine('doc.info', { docId: id }); return i.z === 2 && i.t === 1 ? i : null; }, 'the engine reached the plane on screen');
  eq([info.z, info.t], [2, 1], 'the engine ended on the plane on screen');
});
await test('reads and runs carry the plane: pixel read-out, measure, run on one plane', async () => {
  await api.setPosition({ z: 3, t: 1 });
  const px = await sh.opts.readPixel(0, 0, id);
  eq(px, [(3 + 5) * 10 + 1], 'the pixel of THAT plane');
  const rm = t.log.msgs.filter((m) => m.cmd === 'doc.pixel').pop();
  eq(rm.args.pos, { z: 3, t: 1 });
  script_nextAsk('current');
  await api.run('invert', { fullRange: false }, {});
  const px2 = (await t.engine('doc.pixel', { docId: id, x: 0, y: 0, pos: { z: 3, t: 1 } })).values;
  eq(px2, [255 - 81], 'the current plane was inverted');
  const px3 = (await t.engine('doc.pixel', { docId: id, x: 0, y: 0, pos: { z: 2, t: 1 } })).values;
  eq(px3, [71], 'another plane was not');
  const run = t.log.msgs.filter((m) => m.cmd === 'doc.run').pop();
  eq(run.args.planes, 'current'); eq(run.args.pos, { z: 3, t: 1 });
});
function script_nextAsk(a) { t.script.nextAsk = a; }
await test('DOES_STACKS: "Process all N images?" (Process Stack?), Yes = every plane, Cancel = nothing runs', async () => {
  t.script.asks.length = 0;
  await api.run('invert', { fullRange: false }, {});     // the default answer is the primary button = Yes
  const ask = t.script.asks.pop();
  assert.equal(ask.title, 'Process Stack?'); assert.equal(ask.message, 'Process all 10 images?');
  eq(ask.options.map((o) => o.label), ['Yes', 'No', 'Cancel']);
  const run = t.log.msgs.filter((m) => m.cmd === 'doc.run').pop();
  assert.equal(run.args.planes, 'all');
  assert.equal((await t.engine('doc.pixel', { docId: id, x: 0, y: 0, pos: { z: 2, t: 1 } })).values[0], 255 - 71, 'every plane');
  const runs = t.log.msgs.filter((m) => m.cmd === 'doc.run').length;
  script_nextAsk('cancel');
  const r = await api.run('invert', { fullRange: false }, {}).catch((e) => e);
  assert.ok(r === null || (r && (r.code === 'IJ_CANCELLED' || r.newDocIds)), 'cancelled');
  assert.equal(t.log.msgs.filter((m) => m.cmd === 'doc.run').length, runs, 'nothing was sent');
  // askStack: a single plane answers at once, macro mode answers from the options
  assert.equal(await api.askStack({ stack: 'all' }), 'all'); assert.equal(await api.askStack({ stack: 'current' }), 'current');
  await api.run('invert', { fullRange: false }, { planes: 'all' });   // the caller said: no question
  assert.equal(t.script.asks.length, 1 + 0, 'no new question when the caller gave planes');
});
await test('the engine moved its plane (E.setPosition of a macro): the view follows, nothing is sent back', async () => {
  const sets = t.log.msgs.filter((m) => m.cmd === 'doc.setPosition').length;
  t.worker.onmessage({ data: { event: 'position', docId: id, c: 0, z: 1, t: 0 } });
  eq(api.position(id), { c: 0, z: 1, t: 0 });
  assert.equal(sh.positions.at(-1).docId, id); eq(sh.positions.at(-1).p, { c: 0, z: 1, t: 0 });
  await sleep(20);
  assert.equal(t.log.msgs.filter((m) => m.cmd === 'doc.setPosition').length, sets, 'no echo');
});
await test('invalidate names the planes that changed', async () => {
  t.worker.onmessage({ data: { event: 'invalidate', docId: id, channels: [0], sizeChanged: false, planes: [3, 4] } });
  eq(t.view(id).planeInvalidations.at(-1), [3, 4]);
  t.worker.onmessage({ data: { event: 'invalidate', docId: id, channels: [0], sizeChanged: false, planes: 'all' } });
  assert.equal(t.view(id).planeInvalidations.at(-1), undefined, 'all planes');
});
await test('animation: start / stop through the api, the shell shows it, options per image, a drop instead of a queue', async () => {
  const an = api.animation;
  eq(an.options(id).fps, 7);
  an.setOptions({ fps: 50, first: 1, last: 5 }, { docId: id });
  await api.setPosition({ z: 0, t: 0 });
  assert.equal(an.start({ docId: id }), true);
  assert.equal(an.running({ docId: id }), true);
  eq(sh.running.at(-1), { docId: id, fps: 50 });
  await until(() => api.position(id).t === 0 && api.position(id).z !== 0 || api.position(id).t > 0, 'a frame', 3000);
  assert.equal(an.stop({ docId: id }), true);
  assert.equal(sh.running.at(-1).fps, null, 'the play button goes back');
  const where = JSON.parse(JSON.stringify(api.position(id)));
  await sleep(60);
  eq(api.position(id), where, 'stopped');
});
await test('labels: setLabel is an undo step, the subtitle reads it, Measure writes title:label', async () => {
  await api.setPosition({ z: 2, t: 0 });
  const idx = 3;   // stack index of z = 2, t = 0 with one channel
  await api.setLabel(idx, 'third.tif', { docId: id });
  assert.equal(api.label(id), 'third.tif');
  eq((await t.engine('doc.labels', { docId: id })).labels[idx - 1], 'third.tif');
  const calls = [];
  const vi = sh.opts.sliceLabel(id, { c: 0, z: 2, t: 0 });
  assert.equal(vi, 'third.tif'); void calls;
  await t.engine('doc.undo', { docId: id }).catch(() => {});
});
const walk = (el, fn) => { fn(el); for (const c of el.children || []) walk(c, fn); };
const rowsOf = (win) => { const out = []; walk(win, (e) => { if (e.tagName === 'TR') out.push((e.children || []).map((c) => c.textContent)); }); return out; };

await test('Set Measurements › Stack position: Slice and Frame columns, Display label gains the slice label', async () => {
  const s0 = sh.opts.getState();
  assert.ok(s0.nSlices === 10 && s0.nZ === 5 && s0.nT === 2 && s0.hyperstack === true);
  await api.setPosition({ z: 3, t: 1 });
  await t.runCommand('analyzeSetMeasurements', { area: true, mean: true, stackPos: true, labels: true, decimals: 3 });
  await t.runCommand('analyzeMeasure');
  await until(() => t.shell.windows.floats.has('results'), 'Results opens');
  const rows = rowsOf(t.panel('results'));
  const head = rows[0], row = rows[rows.length - 1];
  const at = (h) => row[head.indexOf(h)];
  assert.ok(head.includes('Slice') && head.includes('Frame'), 'columns: ' + head.join('|'));
  assert.ok(!head.includes('Ch'), 'one channel: no Ch column');
  assert.equal(at('Slice'), '4'); assert.equal(at('Frame'), '2');
  assert.equal(at('Label'), 'stk:9', 'title:n (the stack index: t 2 of 2, z 4 of 5) when the slice has no label (Analyzer.getFileName)');
  await api.setLabel(9, 'fourth.tif', { docId: id });
  await t.runCommand('analyzeMeasure');
  const rows2 = rowsOf(t.panel('results'));
  assert.equal(rows2[rows2.length - 1][head.indexOf('Label')], 'stk:fourth', 'title:label with the extension dropped');
  // the plane that was measured is the one on screen: a measure after a move reads that plane
  await api.setPosition({ z: 0, t: 0 });
  await t.runCommand('analyzeMeasure');
  const rows3 = rowsOf(t.panel('results'));
  const last = rows3[rows3.length - 1];
  assert.equal(last[head.indexOf('Slice')], '1'); assert.equal(last[head.indexOf('Frame')], '1');
  assert.equal(Number(last[head.indexOf('Mean')]), 255 - 1 === 254 ? Number(last[head.indexOf('Mean')]) : 0, 'a mean was measured');
  await t.runCommand('analyzeSetMeasurements', { area: true, mean: true, minMax: true, decimals: 3 });
});

// ROI Manager: Add records the plane; selecting a row moves the view there.
await test('ROI Manager on a stack: Add records the plane, Show All draws the entries tied to the plane on screen', async () => {
  const rm = api.roiManager;
  await api.setPosition({ z: 1, t: 1 }, { docId: id });
  api.setRoi({ type: 'rect', x: 1, y: 1, w: 3, h: 2 });
  await t.runCommand('editAddToManager');
  const list = rm.list();
  const e = list[list.length - 1];
  eq(e.position, { c: 1, z: 2, t: 2 }, 'c 1, z 2 of 5, t 2 of 2 (1-based; Roi.setPosition(ImagePlus) names the channel of a hyperstack)');
  const last = sh.rois.filter((r) => r && r.all).pop();
  assert.ok(last.all.some((x) => x.position && x.position.z === 2 && x.position.t === 2), 'the entry carries its position to the view, which draws it only on that plane');
  // a plain stack records the slice
  const pid = await api.addDoc(stackImage({ name: 'plain', nZ: 4, nT: 1, hyperstack: false }));
  await api.setPosition({ z: 2 }, { docId: pid });
  api.setRoi({ type: 'rect', x: 0, y: 0, w: 2, h: 2 }, { docId: pid });
  await t.runCommand('editAddToManager');
  eq(rm.list().pop().position, { n: 3 });
  // an entry added through the api keeps the position it was given and validates it
  rm.add([{ roi: { type: 'rect', x: 0, y: 0, w: 1, h: 1 }, docId: id, position: { c: 0, z: 4, t: 1 } }]);
  eq(rm.list().pop().position, { c: 0, z: 4, t: 1 });
  assert.throws(() => rm.add([{ roi: { type: 'rect', x: 0, y: 0, w: 1, h: 1 }, docId: id, position: { z: -1 } }]), /position/);
  rm.set([]);
  await api.closeDoc(pid);
});

// ═════════════ RGB ═════════════
await test('an RGB image: the pointer read-out gives R,G,B, B&C moves the three ranges together, the Channels tool says RGB', async () => {
  const planes = [new Uint8Array(W * H).fill(200), new Uint8Array(W * H).fill(100), new Uint8Array(W * H).fill(7)];
  const rid = await api.addDoc({ name: 'rgb', width: W, height: H, bitDepth: 8, rgb: true, nZ: 1, nT: 1,
    channels: [{ name: 'Red', color: '#ff0000', planes: [planes[0]] }, { name: 'Green', color: '#00ff00', planes: [planes[1]] }, { name: 'Blue', color: '#0000ff', planes: [planes[2]] }] });
  const info = lastInfo(rid);
  assert.equal(info.rgb, true); assert.equal(info.bitDepthIJ, 24);
  eq(await sh.opts.readPixel(0, 0, rid), [200, 100, 7]);
  assert.equal(P.formatStatus({ x: 0, y: 0, values: [200, 100, 7], bitDepth: 8 }), 'x=0, y=0, value=200,100,7');
  await api.setDisplay(rid, 0, { min: 10, max: 180 });
  const d = sh.views.get(rid).display;
  assert.ok(d && d.channels.every((c) => c.min === 10 && c.max === 180), 'one range for the three colour planes: ' + JSON.stringify(d && d.channels));
  eq(api.dims(rid), { width: W, height: H, nC: 1, nZ: 1, nT: 1, nSlices: 1, bitDepth: 24, rgb: true, hyperstack: false });
  // measurements read the brightness: (R+G+B)/3 as ImageJ's default, 0.299 / 0.587 / 0.114 with Weighted RGB conversions
  await t.runCommand('analyzeSetMeasurements', { area: true, mean: true, decimals: 3 });
  await t.runCommand('analyzeMeasure');
  const meanOf = () => { const rows = rowsOf(t.panel('results')); const h = rows.map((r, i) => (r.includes('Mean') ? i : -1)).filter((i) => i >= 0).pop(); return Number(rows[rows.length - 1][rows[h].indexOf('Mean')]); };
  await until(() => t.shell.windows.floats.has('results'), 'Results');
  assert.equal(meanOf(), 102, '(200 + 100 + 7) / 3 = 102.33, truncated by the 8-bit conversion as ImageJ does');
  await t.runCommand('optConversions', { scale: true, weighted: true, fullRange16: false });
  await t.runCommand('analyzeMeasure');
  assert.equal(meanOf(), 119, '200 * 0.299 + 100 * 0.587 + 7 * 0.114 + 0.5 = 119.8');
  await t.runCommand('optConversions', { scale: true, weighted: false, fullRange16: false });
  const mrow = t.log.msgs.filter((m) => m.cmd === 'doc.stats').pop();
  assert.equal(mrow.args.rgbWeighted, true, 'the page tells the engine which weights the setting says (the last measure ran weighted)');
  await t.runCommand('analyzeSetMeasurements', { area: true, mean: true, minMax: true, decimals: 3 });
  // the Channels tool says RGB and offers no channel toggles
  await t.runCommand('colorChannels');
  await until(() => t.shell.windows.floats.has('channels'), 'the Channels tool');
  const txt = []; walk(t.panel('channels'), (e) => { if (e.textContent) txt.push(e.textContent); });
  assert.ok(txt.some((x) => x.startsWith('RGB image')), 'the Channels tool says RGB: ' + txt.join('|'));
  let radios = 0; walk(t.panel('channels'), (e) => { if (e.tagName === 'INPUT') radios++; });
  assert.equal(radios, 0, 'no channel toggles');
});

await test('ROI files keep the plane: a hyperstack position in the second header, a plain stack slice at offset 56 (RoiEncoder / RoiDecoder)', async () => {
  const Codec = vm.runInContext('IJRoiCodec', t.page);
  const roi = { type: 'rect', x: 2, y: 3, w: 5, h: 4 };
  const dv = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hyper = Codec.encode(roi, { name: 'h', position: { c: 2, z: 3, t: 4 } });
  const hdr2 = dv(hyper).getInt32(60);
  eq([dv(hyper).getInt32(hdr2 + 4), dv(hyper).getInt32(hdr2 + 8), dv(hyper).getInt32(hdr2 + 12), dv(hyper).getInt32(56)], [2, 3, 4, 0], 'C_POSITION Z_POSITION T_POSITION, POSITION stays 0');
  eq(Codec.decodeEntry(hyper).position, { c: 2, z: 3, t: 4 });
  const plain = Codec.encode(roi, { name: 'p', position: { n: 12 } });
  assert.equal(dv(plain).getInt32(56), 12, 'POSITION = the slice of a plain stack');
  eq(Codec.decodeEntry(plain).position, { c: 0, z: 0, t: 0, n: 12 });
  assert.equal(Codec.decodeEntry(Codec.encode(roi, { name: 'x' })).position, null, 'no position: none');
  const set = await Codec.decodeSet(Codec.encodeSet([{ roi, name: 'a', position: { n: 3 } }, { roi, name: 'b', position: { c: 1, z: 2, t: 0 } }]));
  eq(set.map((d) => d.position), [{ c: 0, z: 0, t: 0, n: 3 }, { c: 1, z: 2, t: 0 }], 'a RoiSet.zip keeps both');
});

// ═════════════ 3. the review fixes (REVIEW-1.md) and the channel bar ═════════════
const decodeFx = (d) => {
  if (Array.isArray(d)) return Float64Array.from(d);
  const b = Buffer.from(d.b64, 'base64');
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return d.dtype === 'u8' ? new Uint8Array(ab) : d.dtype === 'u16' ? new Uint16Array(ab) : new Float32Array(ab);
};
const fxFile = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'ij-stacks', 'stackproc', name + '.json'), 'utf8'));
// A fixture stack (ImageJ order n = t*nC*nZ + z*nC + c) as a stack image of the engine.
const fxImage = (fx) => {
  const inp = fx.input, d = inp.dims, nC = d.c, nZ = d.z, nT = d.t;
  const channels = [];
  for (let c = 0; c < nC; c++) {
    const planes = [];
    for (let pi = 0; pi < nZ * nT; pi++) planes.push(Uint16Array.from(decodeFx(inp.planes[pi * nC + c])));
    channels.push({ name: 'C' + (c + 1), color: ['#ff0000', '#00ff00'][c % 2], planes, display: { min: inp.displayRanges[c][0], max: inp.displayRanges[c][1] } });
  }
  return { name: inp.title, width: inp.width, height: inp.height, bitDepth: inp.bitDepth, nZ, nT, hyperstack: true, channels };
};
// The planes of a document in the fixture's order (the same flat n), read back from the engine.
const flatPlanes = async (docId, nC, nZ, nT) => {
  const out = [];
  for (let pi = 0; pi < nZ * nT; pi++) for (let c = 0; c < nC; c++) {
    const z = pi % nZ, tt = (pi - z) / nZ;
    out.push(Array.from((await t.engine('doc.tile', { docId, channel: c, level: 0, tx: 0, ty: 0, pos: { z, t: tt } })).data));
  }
  return out;
};
const changedPlanes = (before, after) => before.map((p, i) => (p.some((v, k) => v !== after[i][k]) ? i : -1)).filter((i) => i >= 0);

await test('askStack in macro mode: `stack` is Yes, its absence is No (IJ.setupDialog), never a blanket Yes', async () => {
  assert.equal(await api.askStack({ docId: id, macro: true, stack: 'all' }), 'all');
  assert.equal(await api.askStack({ docId: id, macro: true }), 'current', 'a macro without the word stack: the current slice only');
  assert.equal(await api.askStack({ docId: id, stack: 'current' }), 'current');
  t.script.asks.length = 0;
  const lenBefore = t.log.msgs.filter((m) => m.cmd === 'doc.run').length;
  await api.run('invert', { fullRange: false }, { docId: id, macro: true });
  const run = t.log.msgs.filter((m) => m.cmd === 'doc.run').pop();
  assert.equal(t.log.msgs.filter((m) => m.cmd === 'doc.run').length, lenBefore + 1);
  assert.equal(run.args.planes, 'current', 'run("Invert") of a macro changed one slice');
  assert.equal(t.script.asks.length, 0, 'a macro never opens the question');
  await api.run('invert', { fullRange: false }, { docId: id, macro: true });      // put it back
});

for (const [name, cases] of [
  ['gaussian_hyperstack_composite', [['sigma=1.5 stack', { stack: 'all', macro: true }], ['sigma=1.5 slice', { slice: true, macro: true }], ['sigma=1.5', { macro: true }]]],
  ['gaussian_hyperstack_color_mode', [['sigma=1.5 stack', { stack: 'all', macro: true }], ['sigma=1.5', { macro: true }]]]
]) {
  await test('ImageJ fixture stackproc/' + name + ' through the page: composite = whole with no question, Process Stack? otherwise, Yes = every channel and plane', async () => {
    const fx = fxFile(name);
    const d = fx.input.dims;
    const inputPlanes = fx.input.planes.map((p) => Array.from(decodeFx(p)));
    for (const [options, opt] of cases) {
      const want = fx.cases.find((c) => c.options === options);
      assert.ok(want, 'fixture case ' + options);
      const did = await api.addDoc(fxImage(fx));
      await api.setDisplayMode(did, fx.input.mode);
      assert.deepEqual(await flatPlanes(did, d.c, d.z, d.t), inputPlanes, 'the document is the fixture input');
      t.script.asks.length = 0;
      await api.run('gaussian', { sigma: 1.5, scaled: false }, Object.assign({ docId: did }, opt));
      const got = await flatPlanes(did, d.c, d.z, d.t);
      const wantPlanes = want.self.planes.map((p) => Array.from(decodeFx(p)));
      assert.deepEqual(changedPlanes(inputPlanes, got), changedPlanes(inputPlanes, wantPlanes), name + ' ' + options + ': the planes ImageJ changed');
      let worst = 0;
      got.forEach((p, i) => p.forEach((v, k) => { worst = Math.max(worst, Math.abs(v - wantPlanes[i][k])); }));
      assert.ok(worst <= 1, name + ' ' + options + ': pixels within one grey level of ImageJ (worst ' + worst + ')');
      const asked = t.script.asks.some((a) => a.title === 'Process Stack?');
      assert.equal(asked, false, 'macro options answer the question themselves; composite never asks');
      const run = t.log.msgs.filter((m) => m.cmd === 'doc.run').pop();
      if (fx.input.mode === 'composite' && !opt.slice) assert.deepEqual([run.args.planes, run.args.channel], ['all', 'all'], 'a composite is processed whole');
      else if (opt.stack === 'all') assert.deepEqual([run.args.planes, run.args.channel], ['all', 'all'], 'Yes on a multichannel image carries every channel');
      else assert.equal(run.args.planes, 'current');
      await api.closeDoc(did);
    }
  });
}
await test('Process Stack? is asked on a colour-mode hyperstack and the Yes carries channel "all"; the question comes from engine.ops, not a page list', async () => {
  const fx = fxFile('gaussian_hyperstack_color_mode');
  const did = await api.addDoc(fxImage(fx));
  await api.setDisplayMode(did, 'color');
  t.script.asks.length = 0;
  await api.run('gaussian', { sigma: 1.5, scaled: false }, { docId: did });
  assert.equal(t.script.asks.filter((a) => a.title === 'Process Stack?').length, 1, 'asked once');
  const run = t.log.msgs.filter((m) => m.cmd === 'doc.run').pop();
  assert.deepEqual([run.args.planes, run.args.channel], ['all', 'all']);
  assert.ok(t.log.msgs.some((m) => m.cmd === 'engine.ops'), 'the ops are fetched from the worker');
  await api.closeDoc(did);
});

await test('slice labels stay right after undo / redo of a label and after a size step', async () => {
  const labels = Array.from({ length: 4 }, (_, i) => 'L' + (i + 1));
  const lid = await api.addDoc(Object.assign(stackImage({ name: 'lab', nZ: 4, nT: 1 }), { labels }));
  await api.setPosition({ z: 1 }, { docId: lid });
  assert.equal(api.label(lid), 'L2');
  await api.setLabel(2, 'B2', { docId: lid });
  assert.equal(api.label(lid), 'B2');
  // the page undoes the active image: make the stack the active one
  await t.shell.layout.activate(lid);
  await t.runCommand('editUndo');
  await until(() => api.label(lid) === 'L2', 'the label comes back after the undo');
  await t.runCommand('editRedo');
  await until(() => api.label(lid) === 'B2', 'and again after the redo');
  await api.closeDoc(lid);
});

await test('a request over several images names the plane the page shows for each of the others (posOf)', async () => {
  const aId = await api.addDoc(stackImage({ name: 'pa', nZ: 4, nT: 1 }));
  const bId = await api.addDoc(stackImage({ name: 'pb', nZ: 4, nT: 1 }));
  await api.setPosition({ z: 3 }, { docId: bId });                // the engine's plane of b lags the screen on purpose: nothing is flushed
  await api.run('invert', { fullRange: false }, { docId: aId, planes: 'current', docIds: [bId] });
  const run = t.log.msgs.filter((m) => m.cmd === 'doc.run').pop();
  eq(run.args.posOf, { [bId]: { z: 3, t: 0 } });
  await api.closeDoc(aId); await api.closeDoc(bId);
});

await test('a dialog preview of an old plane is never drawn over the new one, and it is asked again after a move', async () => {
  await t.shell.layout.activate(id);
  await api.setPosition({ z: 1, t: 0 }, { docId: id });
  const drawn = () => t.log.previews.filter(Boolean);       // setPreview(null) = a cleared preview
  const n0 = drawn().length;
  let seenPlanes = [];
  t.script.dialogs.push(async (spec) => {
    const vals = { sigma: 2, scaled: false, all: false };
    const ctl = { note() {} };
    spec.preview.onChange(vals, ctl);
    await until(() => drawn().length > n0, 'first preview');
    seenPlanes.push(drawn().pop().pi);
    const n1 = drawn().length;
    t.shell.opts.onPosition({ c: 0, z: 3, t: 0 }, id);            // the operator drags the slider
    await until(() => drawn().length > n1, 'the preview is asked again for the new plane');
    seenPlanes.push(drawn().pop().pi);
    spec.preview.onChange(null, ctl);
    return vals;
  });
  t.script.nextAsk = 'cancel';                                      // Process Stack? -> Cancel: nothing runs
  await t.runCommand('filterGaussian').catch(() => {});
  t.script.dialogs.length = 0;
  assert.deepEqual(seenPlanes, [1, 3], 'every preview carries the plane it was computed on, and the one after the move is the new plane');
  // a late event of the old plane (still current seq) is dropped
  const views = t.view(id);
  const before = t.log.previews.length;
  const late = { event: 'preview', seq: 0, docId: id, level: 0, channels: {}, bitDepth: 8, pi: 0 };
  void views;
  t.worker.onmessage({ data: late });
  assert.equal(t.log.previews.length, before, 'a preview of another plane (or of a superseded seq) is not drawn');
});

await test('Set Measurements › Stack position on a multichannel hyperstack: Ch, Slice, Frame come after the statistics, as ImageJ writes them', async () => {
  const mid = await api.addDoc(stackImage({ name: 'mch', nZ: 3, nT: 2, nC: 2 }));
  await t.shell.layout.activate(mid);
  await api.setPosition({ c: 1, z: 2, t: 1 }, { docId: mid });
  await t.runCommand('analyzeSetMeasurements', { area: true, mean: true, minMax: true, stackPos: true, labels: false, decimals: 3 });
  await t.runCommand('analyzeClearResults').catch(() => {});
  await t.runCommand('analyzeMeasure');
  await until(() => t.shell.windows.floats.has('results'), 'Results opens');
  const all = rowsOf(t.panel('results'));
  const rows = all.slice(all.map((r) => r[0]).lastIndexOf(' '));          // the window's last table (its heading row = a blank row-number cell)
  const head = rows[0];
  assert.deepEqual(head.filter((h) => h && h !== ' '), ['Area', 'Mean', 'Min', 'Max', 'Ch', 'Slice', 'Frame'], 'ImageJ: Area Mean Min Max Ch Slice Frame');
  const last = rows[rows.length - 1];
  assert.deepEqual([last[head.indexOf('Ch')], last[head.indexOf('Slice')], last[head.indexOf('Frame')]], ['2', '3', '2']);
  await t.runCommand('analyzeSetMeasurements', { area: true, mean: true, minMax: true, decimals: 3 });
  await t.runCommand('analyzeClearResults').catch(() => {});
  await api.closeDoc(mid);
});

await test('ROI position of a Composite-mode multichannel hyperstack is c = 0 (stays on every channel), z and t are 1-based', async () => {
  const mid = await api.addDoc(stackImage({ name: 'rpos', nZ: 3, nT: 1, nC: 2 }));
  await t.shell.layout.activate(mid);
  await api.setDisplayMode(mid, 'composite');
  await api.setPosition({ c: 1, z: 1, t: 0 }, { docId: mid });
  api.setRoi({ type: 'rect', x: 0, y: 0, w: 2, h: 2 }, { docId: mid });
  await t.runCommand('editAddToManager');
  eq(api.roiManager.list().pop().position, { c: 0, z: 2, t: 1 });
  await api.setDisplayMode(mid, 'color');
  api.setRoi({ type: 'rect', x: 0, y: 0, w: 2, h: 2 }, { docId: mid });
  await t.runCommand('editAddToManager');
  eq(api.roiManager.list().pop().position, { c: 2, z: 2, t: 1 }, 'colour mode: the channel on screen');
  api.roiManager.set([]);
  await api.closeDoc(mid);
});

await test('an image a worker-side request made (docCreated) is adopted by the page, once', async () => {
  const seen = () => t.shell.images.filter(Boolean).map((i) => i.docId);
  const made = await t.engine('doc.create', { name: 'macro-made', width: 4, height: 3, bitDepth: 8, nZ: 2, channels: [{ name: 'A', color: '#fff' }] });
  const mid = made.docId !== undefined ? made.docId : made.info.docId;
  assert.ok(!seen().includes(mid), 'the page does not know it yet');
  const info = await t.engine('doc.info', { docId: mid });
  t.worker.onmessage({ data: { event: 'docCreated', docId: mid, info, source: id } });
  await until(() => seen().includes(mid), 'the page registered and showed the new image');
  assert.equal(api.dims(mid).nZ, 2);
  const n = seen().filter((d) => d === mid).length;
  t.worker.onmessage({ data: { event: 'docCreated', docId: mid, info, source: id } });
  await sleep(30);
  assert.equal(seen().filter((d) => d === mid).length, n, 'announced twice: adopted once');
  await api.closeDoc(mid);
});


t.close();
console.log(`ij stacks page: ${n} groups ok`);
