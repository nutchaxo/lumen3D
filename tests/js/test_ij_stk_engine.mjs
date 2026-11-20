// Stacks, hyperstacks and the 24-bit RGB type in the worker engine of the Advanced Studio
// (js/modules/studio/advanced-studio/ij-engine.js + IJStack / the registry fields of ij-core.js), run under Node with a fake
// `self` and the REAL modules. Contract: DOCS/studio-advanced/stacks/API.md §1–§6, §8.
//   • IJStack: index maths, orders, the RGB → grey of ImageJ's TypeConverter, packing;
//   • the document model after every kind of operation on a 2 channel × 3 slice × 2 frame document
//     (channels[c].data === channels[c].planes[t * nZ + z], plane shapes, rgb ⇒ 3 × 8-bit);
//   • doc.create / doc.import / duplicate with ranges / labels / setPosition, info fields;
//   • pixel ops over the requested planes (current, all, ranges, explicit lists), per-plane undo / redo, ROI patches, noUndo;
//   • size ops on a stack (every plane, IJ_SIZE_MISMATCH, calibration only, 'whole'), new-document ops (plane / each / whole);
//   • compute ops at `pos` and on the luminance of an RGB image; the RGB rules (each / gray / refused);
//   • tiles keyed with the plane, the budget over every plane, composite undo steps, the worker context `E`,
//     the journal replay of a planes run equal to the live result.
//
// Run: node tests/js/test_ij_stk_engine.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const sandbox = { console, setTimeout, clearTimeout, MessageChannel, performance, TextEncoder, TextDecoder };
sandbox.self = sandbox;
vm.createContext(sandbox);
for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-engine.js']) {
  vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sandbox, { filename: f });
}
const { IJEngine, IJStack, IJOpRegistry } = sandbox;
assert.ok(IJEngine && IJStack && IJOpRegistry, 'modules loaded');

const A = (x) => Array.from(x);
const P = (x) => JSON.parse(JSON.stringify(x));
const closers = [];

// ── the engine client (fake self) ───────────────────────────────────────────────────────────────────────────
function client(opts = {}) {
  const log = [];
  const waiters = new Map();
  let n = 0;
  const fake = {
    navigator: {}, onmessage: null,
    postMessage(m) {
      log.push(m);
      if (m.id !== undefined && 'ok' in m) { const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m); } }
    }
  };
  const eng = IJEngine.start(fake, Object.assign({ storage: 'memory', idleMs: 3600000, bandPixels: 1 << 20, verifyInputs: true }, opts));
  closers.push(() => eng.dispose());
  const c = {
    log, eng,
    call(cmd, args) { return new Promise((res) => { const id = ++n; waiters.set(id, res); fake.onmessage({ data: { id, cmd, args } }); }); },
    async ok(cmd, args) {
      const m = await c.call(cmd, args);
      assert.ok(m.ok, `${cmd} failed: ${m.error && m.error.code}`);
      return m.result;
    },
    async err(cmd, args) {
      const m = await c.call(cmd, args);
      assert.ok(!m.ok, `${cmd} should have failed`);
      return m.error;
    },
    events(name) { return log.filter((m) => m.event === name); },
    // one plane of one channel through the tile path (level 0), at (z, t)
    async plane(id, ch, z, t) {
      const r = await c.ok('doc.tile', { docId: id, channel: ch, level: 0, tx: 0, ty: 0, pos: { z, t } });
      return A(r.data);
    },
    async open(img, o = {}) {
      const r = await c.ok('doc.import', Object.assign({ image: img }, o));
      return r.docId;
    },
    // the document record the engine holds (a test aid): every invariant of API.md §2
    doc(id) { return eng.inspectDoc(id); },
    check(id, what) {
      const d = eng.inspectDoc(id);
      assert.ok(d, 'document ' + id);
      const NP = d.nZ * d.nT;
      assert.ok(d.nZ >= 1 && d.nT >= 1, what + ': dims');
      assert.ok(d.z >= 0 && d.z < d.nZ && d.t >= 0 && d.t < d.nT, what + ': position in range');
      const Ctor = { 8: 'Uint8Array', 16: 'Uint16Array', 32: 'Float32Array' }[d.bitDepth];
      for (const ch of d.channels) {
        assert.equal(ch.planes.length, NP, what + ': one plane per (z,t)');
        for (const a of ch.planes) assert.ok(a.constructor.name === Ctor && a.length === d.width * d.height, what + ': plane shape');
        assert.ok(ch.data === ch.planes[d.t * d.nZ + d.z], what + ': channels[c].data === planes[t*nZ+z]');
      }
      if (d.rgb) assert.ok(d.channels.length === 3 && d.bitDepth === 8, what + ': rgb = 3 x 8-bit');
      if (d.labels) assert.equal(d.labels.length, (d.rgb ? 1 : d.channels.length) * NP, what + ': labels length');
      return d;
    }
  };
  return c;
}

// A stack image (API.md §3). value(c, z, t, i) → the pixel i of channel c at (z, t).
function mkImage(o) {
  const W = o.W || 6, H = o.H || 4, bd = o.bd || 8, nC = o.nC || 1, nZ = o.nZ || 1, nT = o.nT || 1;
  const Ctor = bd === 8 ? Uint8Array : bd === 16 ? Uint16Array : Float32Array;
  const f = o.f || ((c, z, t, i) => (c * 40 + z * 10 + t * 3 + (i % 7)));
  const colors = ['#ffffff', '#00ff00', '#ff0000', '#0000ff'];
  const channels = [];
  for (let c = 0; c < nC; c++) {
    const planes = [];
    for (let t = 0; t < nT; t++) for (let z = 0; z < nZ; z++) { const a = new Ctor(W * H); for (let i = 0; i < a.length; i++) a[i] = f(c, z, t, i); planes.push(a); }
    channels.push({ name: o.names ? o.names[c] : 'C' + (c + 1), color: colors[c % 4], planes });
  }
  return Object.assign({ name: o.name || 'stk', width: W, height: H, bitDepth: bd, nZ, nT, channels, calibration: { pixelWidth: 0.5, pixelHeight: 0.5, pixelDepth: 2, unit: 'um' } },
    o.labels ? { labels: o.labels } : {}, o.hyperstack ? { hyperstack: true } : {}, o.rgb ? { rgb: true } : {});
}

// ── test operations (registered here: the spec fields stack / rgb of API.md §5) ──────────────────────────────────
const noApron = { x: 0, y: 0 };
function addFn(v) { return (src) => { const o = new src.data.constructor(src.data.length); for (let i = 0; i < o.length; i++) o[i] = Math.min(255, src.data[i] + v); return o; }; }
// adds p.value (a pixel op over the planes the request names; the engine runs prepare + the pass once per plane)
IJOpRegistry.define('tAdd', { kind: 'pixel', version: 1, prepare: (view, c, p) => ({ apron: noApron, fn: addFn(p.value) }) });
// the same op but one plane only (no DOES_STACKS)
IJOpRegistry.define('tAddPlane', { kind: 'pixel', version: 1, stack: 'plane', prepare: (view, c, p) => ({ apron: noApron, fn: addFn(p.value) }) });
// adds a value that depends on the PLANE the view stands on: proves every plane gets its own view
IJOpRegistry.define('tAddByPos', { kind: 'pixel', version: 1, prepare: (view, c) => ({ apron: noApron, fn: addFn(1 + view.z + 4 * view.t + 16 * c) }) });
// refused on RGB (a plugin filter without DOES_RGB)
IJOpRegistry.define('tNoRgb', { kind: 'pixel', version: 1, rgb: false, prepare: () => ({ apron: noApron, fn: addFn(1) }) });
// size ops
IJOpRegistry.define('tCropAll', {
  kind: 'size', version: 1,
  async run(view, params, roi, io) {
    const w = params.w, h = params.h, W = view.width;
    const channels = view.channels.map((ch) => {
      const d = new ch.data.constructor(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = ch.data[y * W + x];
      return { data: d, name: ch.name, color: ch.color, display: Object.assign({}, ch.display) };
    });
    return { width: w, height: h, bitDepth: view.bitDepth, channels };
  }
});
IJOpRegistry.define('tCropByZ', {          // the planes disagree in size: IJ_SIZE_MISMATCH
  kind: 'size', version: 1,
  async run(view) {
    const w = view.width - view.z;
    const channels = view.channels.map((ch) => ({ data: new ch.data.constructor(w * view.height), name: ch.name, color: ch.color }));
    return { width: w, height: view.height, bitDepth: view.bitDepth, channels };
  }
});
IJOpRegistry.define('tCalOnly', {          // the same arrays: only the calibration changes
  kind: 'size', version: 1,
  async run(view, params) {
    return { width: view.width, height: view.height, bitDepth: view.bitDepth, calibration: Object.assign({}, view.calibration, { pixelWidth: params.pw }), channels: view.channels.map((ch) => ({ data: ch.data })) };
  }
});
IJOpRegistry.define('tReverseZ', {         // a 'whole' op: sees every plane, answers a stack image (same arrays, reordered)
  kind: 'size', version: 1, stack: 'whole',
  async run(view) {
    const nZ = view.nZ, nT = view.nT;
    const channels = view.channels.map((ch) => {
      const planes = [];
      for (let t = 0; t < nT; t++) for (let z = nZ - 1; z >= 0; z--) planes.push(ch.planes[t * nZ + z]);
      return { name: ch.name, color: ch.color, planes };
    });
    return { width: view.width, height: view.height, bitDepth: view.bitDepth, nZ, nT, channels };
  }
});
IJOpRegistry.define('tDropLastZ', {        // a 'whole' op that changes the dimensions (nZ - 1) and the labels
  kind: 'size', version: 1, stack: 'whole',
  async run(view) {
    const nZ = view.nZ - 1, nT = view.nT;
    const channels = view.channels.map((ch) => {
      const planes = [];
      for (let t = 0; t < nT; t++) for (let z = 0; z < nZ; z++) planes.push(ch.planes[t * view.nZ + z]);
      return { name: ch.name, color: ch.color, planes };
    });
    return { width: view.width, height: view.height, bitDepth: view.bitDepth, nZ, nT, channels, labels: view.labels ? view.labels.filter((l, i) => (i % view.nZ) !== view.nZ - 1) : undefined };
  }
});
// new-document ops
IJOpRegistry.define('tPlus1Doc', {         // 'plane' (the default): sees the plane at pos
  kind: 'newdoc', version: 1,
  async run(view) {
    return [{ name: 'plus1', width: view.width, height: view.height, bitDepth: view.bitDepth, channels: view.channels.map((ch) => ({ name: ch.name, color: ch.color, data: ch.data.map((v) => v + 1) })) }];
  }
});
IJOpRegistry.define('tEachDoc', {          // 'each': run per (z,t), ONE stack document assembled
  kind: 'newdoc', version: 1, stack: 'each',
  async run(view) {
    return [{ name: 'each', width: view.width, height: view.height, bitDepth: view.bitDepth, channels: view.channels.map((ch) => ({ name: ch.name, color: ch.color, data: ch.data.map((v) => v + 100 + view.z) })) }];
  }
});
IJOpRegistry.define('tMaxZDoc', {          // 'whole': a Z projection of channel 0 at the frame of pos, as a 2-D document
  kind: 'newdoc', version: 1, stack: 'whole',
  async run(view, params, roi, io) {
    const ch = view.channels[0];
    const out = new ch.data.constructor(view.width * view.height);
    for (let z = 0; z < view.nZ; z++) { const p = io.planes(0)[io.pos.t * view.nZ + z]; for (let i = 0; i < out.length; i++) if (p[i] > out[i]) out[i] = p[i]; }
    return [{ name: 'maxz', width: view.width, height: view.height, bitDepth: view.bitDepth, channels: [{ name: 'max', data: out }] }];
  }
});
// compute ops
IJOpRegistry.define('tProbe', {            // 'plane' + rgb 'gray' (defaults)
  kind: 'compute', version: 1,
  async run(view, params, roi, io) {
    return { nC: view.nC, nCh: view.channels.length, bd: view.bitDepth, rgb: view.rgb, z: view.z, t: view.t, first: view.channels[0].data[0], pos: { z: io.pos.z, t: io.pos.t }, weighted: params.rgbWeighted, planes: view.channels[0].planes.length };
  }
});
IJOpRegistry.define('tProbeWhole', {       // sees the three channels of an RGB image
  kind: 'compute', version: 1, stack: 'whole', rgb: 'whole',
  async run(view, params, roi, io) {
    return { nCh: view.channels.length, rgb: view.rgb, planes: view.channels[0].planes.length, firsts: view.channels.map((c) => c.planes.map((p) => p[0])), pos: { z: io.pos.z, t: io.pos.t } };
  }
});

// ── 1. IJStack: index maths, orders, grey conversion, packing ───────────────────────────────────────────────────
{
  const dims = { nC: 3, nZ: 4, nT: 5 };
  assert.equal(IJStack.size(dims), 60);
  let n = 0;
  for (let t = 0; t < 5; t++) for (let z = 0; z < 4; z++) for (let c = 0; c < 3; c++) {
    n++;
    assert.equal(IJStack.stackIndex(dims, c, z, t), n, 'ImagePlus.getStackIndex: channels vary fastest, then slices, then frames');
    assert.deepEqual(P(IJStack.position(dims, n)), { c, z, t }, 'convertIndexToPosition is the inverse');
    assert.equal(IJStack.planeIndex(dims, z, t), t * 4 + z);
  }
  assert.deepEqual(P(IJStack.clampPos(dims, { c: 9, z: -3, t: 2.7 })), { c: 2, z: 0, t: 2 });
  assert.deepEqual(P(IJStack.clampPos(dims, {})), { c: 0, z: 0, t: 0 });
  assert.deepEqual(P(IJStack.dims({ channels: [1, 2], nZ: 3, nT: 4 })), { nC: 2, nZ: 3, nT: 4 });
  assert.deepEqual(P(IJStack.dims({ channels: [1, 2, 3], rgb: true })), { nC: 1, nZ: 1, nT: 1 }, 'an RGB image has nC = 1');
  assert.deepEqual(P(IJStack.dims({ nC: 2, nZ: 3, nT: 1, channels: [1, 2] })), { nC: 2, nZ: 3, nT: 1 });
  assert.equal(IJStack.parseOrder('XYCZT'), 'xyczt'); assert.equal(IJStack.parseOrder('xyzct(default)'), 'xyzct');
  for (const bad of ['xyzzt', 'czxyt', 'xyc', '', 'xyczt1']) assert.throws(() => IJStack.parseOrder(bad), (e) => e.code === 'IJ_BAD_ARGS', bad);
  // reorderIndices: new flat index → old flat index (HyperStackConverter.shuffle). 2 channels, 3 slices, 2 frames: xyczt → xyzct
  const d2 = { nC: 2, nZ: 3, nT: 2 };
  const map = IJStack.reorderIndices(d2, 'xyczt', 'xyzct');
  assert.equal(map.constructor.name, 'Int32Array'); assert.equal(map.length, 12);
  for (let t = 0; t < 2; t++) for (let c = 0; c < 2; c++) for (let z = 0; z < 3; z++) {
    const newIdx = z + 3 * c + 6 * t;           // xyzct: z fastest, then c, then t
    const oldIdx = c + 2 * z + 6 * t;           // xyczt: c fastest, then z, then t
    assert.equal(map[newIdx], oldIdx);
  }
  assert.deepEqual(A(IJStack.reorderIndices(d2, 'xyczt', 'xyczt')), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 'the identity order');
  // a round trip through two orders is the identity
  const m1 = IJStack.reorderIndices(d2, 'xyczt', 'xytzc'), m2 = IJStack.reorderIndices(d2, 'xytzc', 'xyczt');
  for (let i = 0; i < 12; i++) assert.equal(m1[m2[i]], i);
  // RGB → grey: ImageJ 1.54p TypeConverter.convertRGBToByte = (int)(r*rw + g*gw + b*bw + 0.5), weights 1/3 each (double) unless weighted
  const w3 = 0.3333333333333333;
  for (const [r, g, b] of [[0, 0, 0], [255, 255, 255], [10, 20, 30], [1, 1, 2], [200, 17, 99], [254, 255, 255], [3, 3, 4]]) {
    assert.equal(IJStack.rgbToGray(r, g, b, false), Math.trunc(r * w3 + g * w3 + b * w3 + 0.5), 'unweighted ' + [r, g, b]);
    assert.equal(IJStack.rgbToGray(r, g, b, true), Math.trunc(r * 0.299 + g * 0.587 + b * 0.114 + 0.5), 'weighted ' + [r, g, b]);
  }
  assert.equal(IJStack.rgbToGray(255, 255, 255, false), 255); assert.equal(IJStack.rgbToGray(255, 255, 255, true), 255);
  assert.equal(IJStack.rgbToGray(1, 2, 3, false, 1, 0, 0), 1, 'explicit weights');
  const gp = IJStack.grayPlane(Uint8Array.of(10, 255), Uint8Array.of(20, 255), Uint8Array.of(30, 255), false);
  assert.deepEqual(A(gp), [20, 255]); assert.equal(gp.constructor.name, 'Uint8Array');
  assert.equal(IJStack.pack(1, 2, 3), 0x010203); assert.deepEqual(P(IJStack.unpack(0xff0a0b0c)), { r: 10, g: 11, b: 12 });
  assert.equal(IJStack.bitDepthOf({ bitDepth: 8, rgb: true }), 24); assert.equal(IJStack.bitDepthOf({ bitDepth: 16 }), 16); assert.equal(IJStack.bitDepthOf({ bitDepth: 8, bitDepthIJ: 24 }), 24);
  // the registry validates the new spec fields and fills the defaults of API.md §5
  const spec = (name, s) => IJOpRegistry.define(name, Object.assign({ version: 1 }, s));
  const pix = spec('tDef1', { kind: 'pixel', prepare: () => ({}) }), siz = spec('tDef2', { kind: 'size', run: async () => null });
  const nd = spec('tDef3', { kind: 'newdoc', run: async () => [] }), cm = spec('tDef4', { kind: 'compute', run: async () => ({}) });
  assert.deepEqual([pix.stack, siz.stack, nd.stack, cm.stack], ['ask', 'all', 'plane', 'plane']);
  assert.deepEqual([pix.rgb, siz.rgb, nd.rgb, cm.rgb], ['each', 'each', 'each', 'gray']);
  for (const [kind, extra] of [['pixel', { stack: 'all' }], ['pixel', { stack: 'whole' }], ['size', { stack: 'ask' }], ['newdoc', { stack: 'ask' }], ['compute', { stack: 'each' }], ['pixel', { rgb: 'gray' }], ['size', { rgb: 'gray' }], ['compute', { rgb: true }]]) {
    assert.throws(() => IJOpRegistry.define('tBad' + Math.random().toString(36).slice(2, 8), Object.assign({ kind, version: 1, prepare: () => ({}), run: async () => null }, extra)), (e) => e.code === 'IJ_BAD_ARGS', kind + JSON.stringify(extra));
  }
  console.log('IJStack + registry spec fields: OK');
}

// ── 2. the document model: create / import / info / position / labels ─────────────────────────────────────────────────
{
  const c = client();
  // doc.create: a 2-channel 5 × 3 hyperstack of 16-bit
  const cr = await c.ok('doc.create', { width: 5, height: 4, bitDepth: 16, channels: [{ name: 'a', color: '#00ff00' }, { name: 'b', color: '#ff0000' }], nZ: 3, nT: 2, hyperstack: true, name: 'hy' });
  let info = cr.info;
  assert.deepEqual(P([info.nC, info.nZ, info.nT, info.z, info.t, info.nSlices, info.stackIndex, info.hyperstack, info.rgb, info.label, info.bitDepth, info.bitDepthIJ]),
    [2, 3, 2, 0, 0, 12, 1, true, false, null, 16, 16]);
  assert.equal(info.bytes, 2 * 6 * 20 * 2, 'bytes over every plane');
  c.check(cr.docId, 'create');
  // distinct arrays per plane
  const d = c.doc(cr.docId);
  assert.equal(new Set(d.channels[0].planes).size, 6);
  // a single-plane create is exactly what it was
  const one = await c.ok('doc.create', { width: 3, height: 3, bitDepth: 8, channels: [{ name: 'x' }] });
  assert.deepEqual(P([one.info.nZ, one.info.nT, one.info.nSlices, one.info.hyperstack, one.info.rgb, one.info.bitDepthIJ]), [1, 1, 1, false, false, 8]);
  c.check(one.docId, 'create 1x1');
  // fills
  const ramp = await c.ok('doc.create', { width: 8, height: 2, bitDepth: 8, channels: [{ name: 'r' }], fill: 'ramp' });
  assert.deepEqual(await c.plane(ramp.docId, 0, 0, 0), [0, 32, 64, 96, 128, 160, 192, 224, 0, 32, 64, 96, 128, 160, 192, 224], 'NewImage.createByteImage ramp: floor(x*256/w)');
  const white = await c.ok('doc.create', { width: 2, height: 2, bitDepth: 8, channels: [{ name: 'w' }], fill: 'white' });
  assert.deepEqual(await c.plane(white.docId, 0, 0, 0), [255, 255, 255, 255]);
  const white16 = await c.ok('doc.create', { width: 2, height: 2, bitDepth: 16, channels: [{ name: 'w' }], fill: 'white' });
  assert.deepEqual(await c.plane(white16.docId, 0, 0, 0), [0, 0, 0, 0]); assert.equal(white16.info.channels[0].display.invert, true, '16-bit white is zeros on an inverted table (NewImage)');
  assert.equal((await c.err('doc.create', { width: 2, height: 2, bitDepth: 8, channels: [{ name: 'w' }], fill: 'noise' })).code, 'IJ_BAD_ARGS');
  // RGB create
  const rgb = await c.ok('doc.create', { width: 4, height: 3, bitDepth: 8, channels: [], rgb: true, nZ: 2, fill: 'white' });
  assert.deepEqual(P([rgb.info.rgb, rgb.info.nC, rgb.info.bitDepth, rgb.info.bitDepthIJ, rgb.info.channels.map((x) => x.name), rgb.info.nSlices, rgb.info.mode]), [true, 1, 8, 24, ['Red', 'Green', 'Blue'], 2, 'composite']);
  c.check(rgb.docId, 'create rgb');
  assert.equal((await c.err('doc.create', { width: 2, height: 2, bitDepth: 16, channels: [], rgb: true })).code, 'IJ_BAD_ARGS');
  assert.equal((await c.err('doc.create', { width: 2, height: 2, bitDepth: 8, channels: [{}], nZ: 0 })).code, 'IJ_BAD_ARGS');

  // doc.import of a stack image: labels, hyperstack, positions, plane-specific values
  const labels = Array.from({ length: 12 }, (_, i) => (i % 3 === 0 ? 'L' + (i + 1) : null));
  const img = mkImage({ nC: 2, nZ: 3, nT: 2, hyperstack: true, labels, bd: 16 });
  const id = await c.open(img, { sessionKey: 'k-model' });
  info = (await c.ok('doc.info', { docId: id }));
  assert.deepEqual(P([info.nC, info.nZ, info.nT, info.nSlices, info.hyperstack, info.label, info.stackIndex]), [2, 3, 2, 12, true, 'L1', 1]);
  c.check(id, 'import');
  // every plane keeps its own pixels (value = c*40 + z*10 + t*3 + i%7)
  for (let t = 0; t < 2; t++) for (let z = 0; z < 3; z++) for (let ch = 0; ch < 2; ch++) {
    const got = await c.plane(id, ch, z, t);
    assert.deepEqual(got.slice(0, 7), [0, 1, 2, 3, 4, 5, 6].map((i) => ch * 40 + z * 10 + t * 3 + i), `plane c${ch} z${z} t${t}`);
  }
  // setPosition: data follows, info follows, clamped; the label of the plane on show
  let r = await c.ok('doc.setPosition', { docId: id, z: 2, t: 1, c: 1 });
  assert.deepEqual(P([r.info.z, r.info.t, r.info.active, r.info.stackIndex, r.info.label]), [2, 1, 1, 1 * 6 + 2 * 2 + 1 + 1, null]);
  c.check(id, 'setPosition');
  assert.equal(c.doc(id).channels[0].data, c.doc(id).channels[0].planes[1 * 3 + 2]);
  r = await c.ok('doc.setPosition', { docId: id, z: 99, t: -4 });
  assert.deepEqual(P([r.info.z, r.info.t]), [2, 0], 'clamped');
  r = await c.ok('doc.setPosition', { docId: id, z: 0 });
  assert.equal(r.info.label, null, 'the label of the plane on show: active channel 1 at z0 t0 is stack index 2 (no label there)');
  assert.equal(r.info.stackIndex, 2, 'active channel 1 at z0 t0 → n = 2');
  assert.equal((await c.err('doc.setPosition', { docId: 'nope', z: 0 })).code, 'IJ_NO_DOC');
  // doc.pixel reads the plane of `pos`
  const px = await c.ok('doc.pixel', { docId: id, x: 1, y: 0, pos: { z: 2, t: 1 } });
  assert.deepEqual(P(px.values), [0 * 40 + 20 + 3 + 1, 40 + 20 + 3 + 1]);
  assert.deepEqual(P((await c.ok('doc.pixel', { docId: id, x: 1, y: 0 })).values), [1, 41], 'default = the current plane (z0 t0)');
  assert.equal((await c.err('doc.pixel', { docId: id, x: 0, y: 0, pos: { z: 3, t: 0 } })).code, 'IJ_BAD_ARGS');
  // labels
  assert.deepEqual(P((await c.ok('doc.labels', { docId: id })).labels), labels);
  assert.equal((await c.ok('doc.labels', { docId: (await c.ok('doc.create', { width: 2, height: 2, bitDepth: 8, channels: [{}] })).docId })).labels, null);
  // bad stack images are refused as a request
  const bad = (m) => Object.assign({}, mkImage({ nZ: 2 }), m);
  assert.equal((await c.err('doc.import', { image: bad({ nZ: 3 }) })).code, 'IJ_BAD_ARGS', 'planes disagree with nZ');
  assert.equal((await c.err('doc.import', { image: bad({ labels: ['a'] }) })).code, 'IJ_BAD_ARGS', 'labels length');
  assert.equal((await c.err('doc.import', { image: bad({ rgb: true }) })).code, 'IJ_BAD_ARGS', 'rgb needs 3 channels');
  const short = mkImage({ nZ: 2 }); short.channels[0].planes[1] = new Uint8Array(3);
  assert.equal((await c.err('doc.import', { image: short })).code, 'IJ_BAD_ARGS', 'plane length');
  // a stack image without nZ / nT: its planes make a z-stack
  const zs = mkImage({ nZ: 4 }); delete zs.nZ; delete zs.nT;
  assert.equal((await c.ok('doc.import', { image: zs })).info.nZ, 4);
  // an image of the first versions (data, no planes) still imports
  const legacy = { name: 'old', width: 3, height: 2, bitDepth: 8, channels: [{ name: 'g', data: Uint8Array.of(1, 2, 3, 4, 5, 6) }] };
  const old = await c.ok('doc.import', { image: legacy });
  assert.deepEqual(P([old.info.nZ, old.info.nT, old.info.nSlices]), [1, 1, 1]); c.check(old.docId, 'legacy image');
  console.log('document model: create / import / info / position / labels: OK');
}

// ── 3. pixel ops over planes, undo / redo per plane, ROI patches, noUndo, events ──────────────────────────────────────
{
  const c = client();
  const mk = () => c.open(mkImage({ nC: 2, nZ: 3, nT: 2, hyperstack: true }), { sessionKey: 'k-pix' });
  const id = await mk();
  const orig = {};
  for (let t = 0; t < 2; t++) for (let z = 0; z < 3; z++) for (let ch = 0; ch < 2; ch++) orig[`${ch}.${z}.${t}`] = await c.plane(id, ch, z, t);
  const add = (a, v) => a.map((x) => Math.min(255, x + v));
  const same = async (what, expect) => {
    for (let t = 0; t < 2; t++) for (let z = 0; z < 3; z++) for (let ch = 0; ch < 2; ch++) assert.deepEqual(await c.plane(id, ch, z, t), expect(ch, z, t), what + ` c${ch} z${z} t${t}`);
    c.check(id, what);
  };
  // (a) no `planes`: the current plane (z0 t0), every channel
  let r = await c.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 5 }, channel: 'all' });
  assert.equal(r.changed.planes.length, 1); assert.deepEqual(P(r.changed.planes), [0]);
  await same('current plane', (ch, z, t) => (z === 0 && t === 0 ? add(orig[`${ch}.0.0`], 5) : orig[`${ch}.${z}.${t}`]));
  assert.equal(c.events('invalidate').pop().planes.length, 1);
  assert.deepEqual(P(c.events('invalidate').pop().planes), [0]);
  // (b) `pos` names another plane
  r = await c.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 7 }, channel: 'all', pos: { z: 2, t: 1 } });
  assert.deepEqual(P(r.changed.planes), [5]);
  await same('pos', (ch, z, t) => { let a = orig[`${ch}.${z}.${t}`]; if (z === 0 && t === 0) a = add(a, 5); if (z === 2 && t === 1) a = add(a, 7); return a; });
  // (c) undo restores the identity of the arrays (references, not copies)
  const planesBefore = c.doc(id).channels[0].planes.slice();
  await c.ok('doc.undo', { docId: id });
  await same('undo pos', (ch, z, t) => (z === 0 && t === 0 ? add(orig[`${ch}.0.0`], 5) : orig[`${ch}.${z}.${t}`]));
  await c.ok('doc.redo', { docId: id });
  assert.notEqual(c.doc(id).channels[0].planes[5], undefined);
  assert.deepEqual(c.doc(id).channels[0].planes.map((a, i) => a === planesBefore[i]), [true, true, true, true, true, true], 'redo puts the very arrays back');
  await c.ok('doc.undo', { docId: id }); await c.ok('doc.undo', { docId: id });
  await same('undo all', (ch, z, t) => orig[`${ch}.${z}.${t}`]);
  assert.equal((await c.err('doc.undo', { docId: id })).code, 'IJ_NOTHING_TO_UNDO');
  // (d) planes: 'all' — a plane-dependent op shows every plane got its own view
  r = await c.ok('doc.run', { docId: id, op: 'tAddByPos', params: {}, channel: 'all', planes: 'all' });
  assert.deepEqual(P(r.changed.planes), [0, 1, 2, 3, 4, 5]);
  await same('all, by position', (ch, z, t) => add(orig[`${ch}.${z}.${t}`], 1 + z + 4 * t + 16 * ch));
  assert.equal(r.info.undoDepth, 1, 'one undo step for the whole stack');
  await c.ok('doc.undo', { docId: id });
  await same('undo of all', (ch, z, t) => orig[`${ch}.${z}.${t}`]);
  await c.ok('doc.redo', { docId: id });
  await same('redo of all', (ch, z, t) => add(orig[`${ch}.${z}.${t}`], 1 + z + 4 * t + 16 * ch));
  await c.ok('doc.undo', { docId: id });
  // (e) ranges (inclusive; a missing axis = all of it) and explicit lists
  r = await c.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 3 }, channel: 0, planes: { z: [1, 2], t: [1, 1] } });
  assert.deepEqual(P(r.changed.planes), [4, 5]);
  await same('range', (ch, z, t) => (ch === 0 && t === 1 && z >= 1 ? add(orig[`${ch}.${z}.${t}`], 3) : orig[`${ch}.${z}.${t}`]));
  await c.ok('doc.undo', { docId: id });
  r = await c.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 2 }, channel: 1, planes: { t: [0, 0] } });
  assert.deepEqual(P(r.changed.planes), [0, 1, 2]);
  await c.ok('doc.undo', { docId: id });
  r = await c.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 9 }, channel: 'all', planes: [3, 1, 3] });
  assert.deepEqual(P(r.changed.planes), [1, 3], 'an explicit list is sorted and de-duplicated');
  await same('explicit list', (ch, z, t) => ((t * 3 + z === 1 || t * 3 + z === 3) ? add(orig[`${ch}.${z}.${t}`], 9) : orig[`${ch}.${z}.${t}`]));
  await c.ok('doc.undo', { docId: id });
  for (const planes of [{ z: [0, 3] }, { z: [2, 1] }, [6], [-1], 'some', { t: 'x' }]) {
    assert.equal((await c.err('doc.run', { docId: id, op: 'tAdd', params: { value: 1 }, channel: 'all', planes })).code, 'IJ_BAD_ARGS', JSON.stringify(planes));
  }
  assert.equal((await c.err('doc.run', { docId: id, op: 'tAdd', params: { value: 1 }, pos: { z: 5, t: 0 } })).code, 'IJ_BAD_ARGS');
  await same('refusals left nothing', (ch, z, t) => orig[`${ch}.${z}.${t}`]);
  // (f) a spec without DOES_STACKS refuses a set of planes but runs on pos
  assert.equal((await c.err('doc.run', { docId: id, op: 'tAddPlane', params: { value: 1 }, planes: 'all' })).code, 'IJ_BAD_ARGS');
  r = await c.ok('doc.run', { docId: id, op: 'tAddPlane', params: { value: 4 }, channel: 'all', pos: { z: 1, t: 0 } });
  assert.deepEqual(P(r.changed.planes), [1]); await c.ok('doc.undo', { docId: id });
  // (g) a partial ROI patch on a plane: undo restores the rectangle only, the rest stays
  const roi = { type: 'rect', x: 1, y: 1, w: 2, h: 2 };
  await c.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 20 }, channel: 0, roi, planes: [0, 4] });
  const w = 6;
  const expect = (ch, z, t) => {
    const a = orig[`${ch}.${z}.${t}`].slice();
    if (ch === 0 && (t * 3 + z === 0 || t * 3 + z === 4)) for (let y = 1; y < 3; y++) for (let x = 1; x < 3; x++) a[y * w + x] = Math.min(255, a[y * w + x] + 20);
    return a;
  };
  await same('roi on planes', expect);
  await c.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 1 }, channel: 0, roi, planes: [0] });
  await c.ok('doc.undo', { docId: id });
  await same('undo of the second roi step', expect);
  await c.ok('doc.undo', { docId: id });
  await same('undo of the first roi step', (ch, z, t) => orig[`${ch}.${z}.${t}`]);
  // (h) noUndo over planes: no step, planes swapped, rev bumped, the undo history gone
  await c.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 1 }, channel: 0, planes: [2] });
  r = await c.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 6 }, channel: 'all', planes: 'all', noUndo: true });
  assert.equal(r.info.undoDepth, 0); assert.equal(r.info.redoDepth, 0);
  await same('noUndo', (ch, z, t) => add(ch === 0 && t * 3 + z === 2 ? add(orig[`${ch}.${z}.${t}`], 1) : orig[`${ch}.${z}.${t}`], 6));
  // (i) the planes the engine did not touch keep their arrays (identity) in a one-plane run
  const idB = await mk();
  const before = c.doc(idB).channels[1].planes.slice();
  await c.ok('doc.run', { docId: idB, op: 'tAdd', params: { value: 1 }, channel: 0, planes: [2] });
  const after = c.doc(idB).channels[1].planes;
  assert.ok(before.every((a, i) => a === after[i]), 'untouched channel keeps every array');
  const ch0 = c.doc(idB).channels[0].planes;
  assert.ok(ch0[2] !== undefined && ch0.filter((a, i) => i !== 2).every((a, i) => a !== undefined));
  console.log('pixel ops over planes, per-plane undo / redo, ROI patches, noUndo: OK');
}

// ── 4. size ops on stacks ────────────────────────────────────────────────────────────────────────────────────────────
{
  const c = client();
  const labels = Array.from({ length: 12 }, (_, i) => 'S' + i);
  const id = await c.open(mkImage({ nC: 2, nZ: 3, nT: 2, hyperstack: true, labels, W: 6, H: 4 }), { sessionKey: 'k-size' });
  const want = async (w, h, fn) => {
    for (let t = 0; t < 2; t++) for (let z = 0; z < 3; z++) for (let ch = 0; ch < 2; ch++) assert.deepEqual(await c.plane(id, ch, z, t), fn(ch, z, t), `c${ch} z${z} t${t}`);
  };
  const origArr = {};
  for (let t = 0; t < 2; t++) for (let z = 0; z < 3; z++) for (let ch = 0; ch < 2; ch++) origArr[`${ch}.${z}.${t}`] = await c.plane(id, ch, z, t);
  const planes0 = c.doc(id).channels[0].planes.slice();
  // a crop of every plane (the builtin op), journaled on a stack with the position and undone as one step
  await c.ok('doc.setPosition', { docId: id, z: 1, t: 1 });
  let r = await c.ok('doc.run', { docId: id, op: 'tCropAll', params: { w: 4, h: 3 }, channel: 'all' });
  assert.deepEqual(P([r.info.width, r.info.height, r.info.nZ, r.info.nT, r.info.z, r.info.t, r.info.undoDepth]), [4, 3, 3, 2, 1, 1, 1]);
  assert.equal(r.changed.sizeChanged, true); assert.equal(r.changed.planes, 'all');
  c.check(id, 'crop all planes');
  await want(4, 3, (ch, z, t) => { const a = []; for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) a.push(origArr[`${ch}.${z}.${t}`][y * 6 + x]); return a; });
  assert.deepEqual(P(c.doc(id).labels), labels, 'labels survive a size step on the same stack');
  await c.ok('doc.undo', { docId: id });
  assert.deepEqual(P([c.doc(id).width, c.doc(id).height]), [6, 4]);
  assert.ok(c.doc(id).channels[0].planes.every((a, i) => a === planes0[i]), 'undo restores the very arrays');
  c.check(id, 'undo crop');
  await want(6, 4, (ch, z, t) => origArr[`${ch}.${z}.${t}`]);
  await c.ok('doc.redo', { docId: id });
  assert.equal(c.doc(id).width, 4); c.check(id, 'redo crop');
  await c.ok('doc.undo', { docId: id });
  // the builtin crop with a rectangle, as ImageJ's Crop on a stack
  r = await c.ok('doc.run', { docId: id, op: 'crop', params: {}, roi: { type: 'rect', x: 1, y: 1, w: 3, h: 2 }, channel: 'all' });
  assert.deepEqual(P([r.info.width, r.info.height, r.info.nSlices]), [3, 2, 12]);
  assert.equal(c.doc(id).provenance.cropOrigin.x, 1);
  await c.ok('doc.undo', { docId: id });
  // planes that disagree: IJ_SIZE_MISMATCH, nothing changed, no undo step
  const e = await c.err('doc.run', { docId: id, op: 'tCropByZ', params: {}, channel: 'all' });
  assert.equal(e.code, 'IJ_SIZE_MISMATCH');
  assert.deepEqual(P([c.doc(id).width, c.doc(id).undo.length]), [6, 0]); c.check(id, 'size mismatch');
  // calibration only: every plane keeps its array, the page is told calibration:true
  r = await c.ok('doc.run', { docId: id, op: 'tCalOnly', params: { pw: 3 }, channel: 'all' });
  assert.equal(r.changed.calibration, true); assert.equal(r.changed.sizeChanged, false); assert.deepEqual(P(r.changed.planes), []);
  assert.equal(r.info.calibration.pixelWidth, 3);
  assert.ok(c.doc(id).channels[0].planes.every((a, i) => a === planes0[i]));
  await c.ok('doc.undo', { docId: id });
  assert.equal(c.doc(id).calibration.pixelWidth, 0.5);
  // 'whole': reversal in z keeps the arrays, reordered; the position stays; undo gives the order back
  r = await c.ok('doc.run', { docId: id, op: 'tReverseZ', params: {}, channel: 'all' });
  const rev = c.doc(id).channels[0].planes;
  for (let t = 0; t < 2; t++) for (let z = 0; z < 3; z++) assert.ok(rev[t * 3 + z] === planes0[t * 3 + (2 - z)], `reversed z${z} t${t}`);
  c.check(id, 'whole reverse');
  assert.equal(r.changed.sizeChanged, true);
  await c.ok('doc.undo', { docId: id });
  assert.ok(c.doc(id).channels[0].planes.every((a, i) => a === planes0[i])); c.check(id, 'undo reverse');
  // 'whole' that changes the dimensions: nZ 3 → 2, the labels follow, the position is clamped; undo restores all of it
  await c.ok('doc.setPosition', { docId: id, z: 2, t: 1 });
  r = await c.ok('doc.run', { docId: id, op: 'tDropLastZ', params: {}, channel: 'all' });
  assert.deepEqual(P([r.info.nZ, r.info.nT, r.info.nSlices, r.info.z, r.info.t]), [2, 2, 8, 1, 1]);
  assert.equal(c.doc(id).labels.length, 8); assert.equal(c.doc(id).labels[0], 'S0');
  c.check(id, 'whole drop');
  await c.ok('doc.undo', { docId: id });
  assert.deepEqual(P([c.doc(id).nZ, c.doc(id).z, c.doc(id).labels.length]), [3, 1, 12]); c.check(id, 'undo drop');
  assert.ok(c.doc(id).channels[0].planes.every((a, i) => a === planes0[i]));
  // convert (the builtin, applyLut-free) keeps the stack: 8 → 16 bit on every plane
  r = await c.ok('doc.run', { docId: id, op: 'convert', params: { bitDepth: 16 }, channel: 'all' });
  assert.deepEqual(P([r.info.bitDepth, r.info.nSlices]), [16, 12]);
  c.check(id, 'convert'); assert.equal(c.doc(id).channels[1].planes[5].constructor.name, 'Uint16Array');
  await c.ok('doc.undo', { docId: id });
  assert.equal(c.doc(id).bitDepth, 8); c.check(id, 'undo convert');
  // revert goes back to the loaded stack, dimensions included
  await c.ok('doc.run', { docId: id, op: 'tDropLastZ', params: {}, channel: 'all' });
  await c.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 1 }, channel: 'all', planes: 'all' });
  r = await c.ok('doc.revert', { docId: id });
  assert.deepEqual(P([r.info.nZ, r.info.nT, r.info.nSlices]), [3, 2, 12]);
  c.check(id, 'revert');
  await want(6, 4, (ch, z, t) => origArr[`${ch}.${z}.${t}`]);
  assert.deepEqual(P(c.doc(id).labels), labels, 'revert restores the labels');
  // a size op on a document that turns a 1x1 image into a stack ('whole' result with planes)
  IJOpRegistry.define('tMakeStack', { kind: 'size', version: 1, stack: 'whole', async run(view) {
    return { width: view.width, height: view.height, bitDepth: view.bitDepth, nZ: 3, hyperstack: false, channels: view.channels.map((ch) => ({ name: ch.name, planes: [ch.data, ch.data.map((v) => v + 1), ch.data.map((v) => v + 2)] })) };
  } });
  const one = await c.open(mkImage({ nC: 1 }), { sessionKey: 'k-one' });
  r = await c.ok('doc.run', { docId: one, op: 'tMakeStack', params: {} });
  assert.deepEqual(P([r.info.nZ, r.info.nT, r.info.nSlices, r.info.hyperstack]), [3, 1, 3, false]);
  assert.equal(r.changed.planes, 'all');
  c.check(one, 'made a stack');
  await c.ok('doc.undo', { docId: one });
  assert.deepEqual(P([c.doc(one).nZ, c.doc(one).nT]), [1, 1]); c.check(one, 'made a stack, undone');
  console.log('size ops on stacks (all / whole / mismatch / calibration), undo / redo / revert: OK');
}

// ── 5. new-document ops, compute at pos, the RGB rules ───────────────────────────────────────────────────────────────
{
  const c = client();
  const id = await c.open(mkImage({ nC: 2, nZ: 3, nT: 2, hyperstack: true }), { sessionKey: 'k-new' });
  // newdoc 'plane': the plane at pos → a 2-D document
  let r = await c.ok('doc.run', { docId: id, op: 'tPlus1Doc', params: {}, channel: 'all', pos: { z: 2, t: 1 } });
  assert.equal(r.newDocIds.length, 1);
  const nd = r.newDocIds[0];
  assert.deepEqual(P([r.newInfos[0].nZ, r.newInfos[0].nT, r.newInfos[0].nC]), [1, 1, 2]);
  assert.deepEqual(await c.plane(nd, 1, 0, 0), (await c.plane(id, 1, 2, 1)).map((v) => v + 1)); c.check(nd, 'newdoc plane');
  // newdoc 'each': ONE stack document, plane k = the run on plane k
  r = await c.ok('doc.run', { docId: id, op: 'tEachDoc', params: {}, channel: 'all' });
  assert.equal(r.newDocIds.length, 1);
  const ed = r.newDocIds[0];
  assert.deepEqual(P([r.newInfos[0].nZ, r.newInfos[0].nT, r.newInfos[0].nC, r.newInfos[0].hyperstack]), [3, 2, 2, true]);
  for (let t = 0; t < 2; t++) for (let z = 0; z < 3; z++) assert.deepEqual(await c.plane(ed, 0, z, t), (await c.plane(id, 0, z, t)).map((v) => v + 100 + z), `each z${z} t${t}`);
  c.check(ed, 'newdoc each');
  // newdoc 'whole': the op sees every plane (io.planes / io.pos), a projection of the frame of pos
  r = await c.ok('doc.run', { docId: id, op: 'tMaxZDoc', params: {}, channel: 0, pos: { z: 0, t: 1 } });
  const md = r.newDocIds[0];
  const expectMax = []; const p0 = await c.plane(id, 0, 0, 1), p1 = await c.plane(id, 0, 1, 1), p2 = await c.plane(id, 0, 2, 1);
  for (let i = 0; i < p0.length; i++) expectMax.push(Math.max(p0[i], p1[i], p2[i]));
  assert.deepEqual(await c.plane(md, 0, 0, 0), expectMax); c.check(md, 'newdoc whole');
  // builtin cropToNew and toMask on a stack act on the plane at pos
  r = await c.ok('doc.run', { docId: id, op: 'cropToNew', params: { x: 1, y: 1, w: 3, h: 2 }, channel: 'all', pos: { z: 1, t: 1 } });
  assert.deepEqual(P([r.newInfos[0].width, r.newInfos[0].nSlices]), [3, 2]);
  assert.equal((await c.plane(r.newDocIds[0], 0, 0, 0))[0], (await c.plane(id, 0, 1, 1))[1 * 6 + 1]);

  // compute at pos; the view carries every plane in channel.planes
  let out = await c.ok('doc.compute', { docId: id, op: 'tProbe', params: {}, channel: 0, pos: { z: 1, t: 1 } });
  assert.deepEqual(P([out.nC, out.nCh, out.z, out.t, out.first, out.pos, out.planes, out.rgb]), [2, 2, 1, 1, 0 * 40 + 10 + 3 + 0, { z: 1, t: 1 }, 6, false]);
  out = await c.ok('doc.compute', { docId: id, op: 'tProbe', params: {}, channel: 0 });
  assert.deepEqual(P([out.z, out.t]), [0, 0], 'default = the current plane');
  await c.ok('doc.setPosition', { docId: id, z: 2, t: 0 });
  out = await c.ok('doc.compute', { docId: id, op: 'tProbe', params: {}, channel: 0 });
  assert.deepEqual(P([out.z, out.t, out.first]), [2, 0, 20]);
  assert.equal((await c.err('doc.compute', { docId: id, op: 'tProbe', params: {}, pos: { z: 3, t: 0 } })).code, 'IJ_BAD_ARGS');

  // ---- RGB
  const rgbImg = mkImage({ nC: 3, nZ: 2, nT: 1, names: ['Red', 'Green', 'Blue'], rgb: true, f: (c2, z, t, i) => 10 * (c2 + 1) + z * 3 + (i % 3) });
  const rid = await c.open(rgbImg, { sessionKey: 'k-rgb' });
  let info = await c.ok('doc.info', { docId: rid });
  assert.deepEqual(P([info.rgb, info.nC, info.nSlices, info.bitDepth, info.bitDepthIJ, info.channels.length, info.mode]), [true, 1, 2, 8, 24, 3, 'composite']);
  c.check(rid, 'rgb import');
  // doc.pixel gives the three values
  assert.deepEqual(P((await c.ok('doc.pixel', { docId: rid, x: 0, y: 0 })).values), [10, 20, 30]);
  assert.deepEqual(P((await c.ok('doc.pixel', { docId: rid, x: 1, y: 0, pos: { z: 1, t: 0 } })).values), [14, 24, 34]);
  // pixel op: 'each' (default) processes the three colour planes, whatever channel was asked
  await c.ok('doc.run', { docId: rid, op: 'tAdd', params: { value: 5 }, channel: 1, planes: 'all' });
  assert.deepEqual(P((await c.ok('doc.pixel', { docId: rid, x: 0, y: 0 })).values), [15, 25, 35]);
  assert.deepEqual(P((await c.ok('doc.pixel', { docId: rid, x: 0, y: 0, pos: { z: 1, t: 0 } })).values), [18, 28, 38]);
  await c.ok('doc.undo', { docId: rid });
  // rgb: false → refused like a filter without DOES_RGB, nothing changes
  const nr = await c.err('doc.run', { docId: rid, op: 'tNoRgb', params: {}, channel: 'all' });
  assert.equal(nr.code, 'IJ_BAD_TYPE');
  assert.equal(c.doc(rid).undo.length, 0);
  assert.equal((await c.err('doc.run', { docId: rid, op: 'convert', params: { bitDepth: 16 }, channel: 'all' })).code, 'IJ_BAD_TYPE', 'builtin convert is not an RGB op');
  assert.equal((await c.err('doc.run', { docId: rid, op: 'binary', params: { op: 'erode' }, channel: 'all' })).code, 'IJ_BAD_TYPE');
  // a size op keeps the image RGB while the result is still three 8-bit channels
  const rs = await c.ok('doc.run', { docId: rid, op: 'crop', params: {}, roi: { type: 'rect', x: 0, y: 0, w: 4, h: 3 }, channel: 'all' });
  assert.deepEqual(P([rs.info.rgb, rs.info.width, rs.info.bitDepthIJ, rs.info.nSlices]), [true, 4, 24, 2]); c.check(rid, 'rgb crop');
  await c.ok('doc.undo', { docId: rid });
  assert.equal(c.doc(rid).width, 6);
  // compute: the default rgb 'gray' hands the op ONE 8-bit luminance channel, unweighted (r+g+b)/3 unless said
  out = await c.ok('doc.compute', { docId: rid, op: 'tProbe', params: {}, channel: 0 });
  assert.deepEqual(P([out.nC, out.nCh, out.bd, out.rgb, out.first, out.weighted, out.planes]), [1, 1, 8, false, IJStack.rgbToGray(10, 20, 30, false), false, 1]);
  out = await c.ok('doc.compute', { docId: rid, op: 'tProbe', params: { rgbWeighted: true }, channel: 0, pos: { z: 1, t: 0 } });
  assert.deepEqual(P([out.first, out.weighted, out.z]), [IJStack.rgbToGray(13, 23, 33, true), true, 1]);
  // rgb: 'whole' → the three channels and view.rgb
  out = await c.ok('doc.compute', { docId: rid, op: 'tProbeWhole', params: {}, channel: 0, pos: { z: 1, t: 0 } });
  assert.deepEqual(P([out.nCh, out.rgb, out.planes, out.firsts, out.pos]), [3, true, 2, [[10, 13], [20, 23], [30, 33]], { z: 1, t: 0 }]);
  // measurements read the luminance: histogram / stats of an RGB image
  const hs = await c.ok('doc.stats', { docId: rid, channel: 2, measurements: ['mean', 'min', 'max'] });
  assert.equal(hs.rows.length, 1);
  const lum = [];
  for (let i = 0; i < 24; i++) lum.push(IJStack.rgbToGray(10 + (i % 3), 20 + (i % 3), 30 + (i % 3), false));
  assert.equal(hs.row.min, Math.min(...lum)); assert.equal(hs.row.max, Math.max(...lum));
  const hw = await c.ok('doc.stats', { docId: rid, measurements: ['min'], rgbWeighted: true, pos: { z: 1, t: 0 } });
  assert.equal(hw.row.min, IJStack.rgbToGray(13, 23, 33, true));
  const hist = await c.ok('doc.histogram', { docId: rid, bins: 256, stats: false });
  assert.equal(hist.counts.reduce((a, b) => a + b, 0), 24, 'histogram of the luminance plane');
  // a gray-spec newdoc op on RGB: toMask sees the luminance (channel 0 of a 1-channel view), result is not RGB
  const tm = await c.ok('doc.run', { docId: rid, op: 'toMask', params: { lower: 0, upper: 255 }, channel: 2 });
  assert.equal(tm.newInfos[0].rgb, false); assert.equal(tm.newInfos[0].nC, 1);
  // newdoc 'each' op on RGB keeps the RGB type (3 x 8-bit result of an 'each' spec)
  const er = await c.ok('doc.run', { docId: rid, op: 'tEachDoc', params: {}, channel: 'all' });
  assert.deepEqual(P([er.newInfos[0].rgb, er.newInfos[0].nZ, er.newInfos[0].nSlices]), [true, 2, 2]); c.check(er.newDocIds[0], 'rgb each');
  // duplicate keeps RGB when the three colour channels come along
  const dup = await c.ok('doc.duplicate', { docId: rid });
  assert.deepEqual(P([dup.info.rgb, dup.info.nZ]), [true, 2]);
  const dup2 = await c.ok('doc.duplicate', { docId: rid, channels: [0, 1] });
  assert.equal(dup2.info.rgb, false);
  console.log('new-document ops (plane / each / whole), compute at pos, the RGB rules: OK');
}

// ── 6. duplicate with ranges, labels ─────────────────────────────────────────────────────────────────────────────────────
{
  const c = client();
  const labels = Array.from({ length: 12 }, (_, i) => 'n' + (i + 1));
  const id = await c.open(mkImage({ nC: 2, nZ: 3, nT: 2, hyperstack: true, labels }), { sessionKey: 'k-dup' });
  await c.ok('doc.setPosition', { docId: id, z: 2, t: 1 });
  const dup = await c.ok('doc.duplicate', { docId: id, range: { c: [1, 1], z: [1, 2], t: [1, 1] }, name: 'part' });
  assert.deepEqual(P([dup.info.nC, dup.info.nZ, dup.info.nT, dup.info.nSlices, dup.info.hyperstack, dup.info.name, dup.info.z, dup.info.t]), [1, 2, 1, 2, true, 'part', 1, 0]);
  c.check(dup.docId, 'range duplicate');
  assert.deepEqual(await c.plane(dup.docId, 0, 0, 0), await c.plane(id, 1, 1, 1));
  assert.deepEqual(await c.plane(dup.docId, 0, 1, 0), await c.plane(id, 1, 2, 1));
  // labels of the planes kept: stack index n = t*nC*nZ + z*nC + c + 1 of the source
  assert.deepEqual(P(c.doc(dup.docId).labels), ['n' + (1 * 6 + 1 * 2 + 1 + 1), 'n' + (1 * 6 + 2 * 2 + 1 + 1)]);
  const full = await c.ok('doc.duplicate', { docId: id });
  assert.deepEqual(P([full.info.nC, full.info.nZ, full.info.nT]), [2, 3, 2]); assert.deepEqual(P(c.doc(full.docId).labels), labels);
  // the copies are independent arrays
  assert.notEqual(c.doc(full.docId).channels[0].planes[0], c.doc(id).channels[0].planes[0]);
  const withRoi = await c.ok('doc.duplicate', { docId: id, roi: { type: 'rect', x: 1, y: 1, w: 3, h: 2 }, range: { z: [0, 0], t: [0, 0] } });
  assert.deepEqual(P([withRoi.info.width, withRoi.info.height, withRoi.info.nSlices]), [3, 2, 2]);
  for (const range of [{ z: [0, 3] }, { t: [1, 0] }, { c: [0, 2] }, { z: [1] }]) assert.equal((await c.err('doc.duplicate', { docId: id, range })).code, 'IJ_BAD_ARGS', JSON.stringify(range));
  // slice labels: an undo step of its own, journaled, refused out of range
  const r = await c.ok('doc.setLabel', { docId: id, n: 3, label: 'third' });
  assert.equal(c.doc(id).labels[2], 'third'); assert.equal(r.info.undoDepth, 1);
  assert.equal(c.events('invalidate').pop().labels, true);
  await c.ok('doc.undo', { docId: id });
  assert.equal(c.doc(id).labels[2], 'n3');
  await c.ok('doc.redo', { docId: id });
  assert.equal(c.doc(id).labels[2], 'third');
  const e1 = await c.err('doc.setLabel', { docId: id, n: 13, label: 'x' }); assert.equal(e1.code, 'IJ_BAD_ARGS');
  assert.equal((await c.err('doc.setLabel', { docId: id, n: 0, label: 'x' })).code, 'IJ_BAD_ARGS');
  const nolabels = await c.ok('doc.create', { width: 3, height: 3, bitDepth: 8, channels: [{}], nZ: 2 });
  await c.ok('doc.setLabel', { docId: nolabels.docId, n: 2, label: 'only' });
  assert.deepEqual(P(c.doc(nolabels.docId).labels), [null, 'only']);
  await c.ok('doc.undo', { docId: nolabels.docId });
  assert.equal(c.doc(nolabels.docId).labels, null, 'no label left = no list');
  console.log('duplicate ranges, slice labels: OK');
}

// ── 7. tiles keyed with the plane ───────────────────────────────────────────────────────────────────────────────────────
{
  const c = client();
  const W = 2600, H = 40;   // > 1024 wide: levels 1 and 2 exist
  const id = await c.open(mkImage({ W, H, nZ: 2, nT: 2, nC: 1, f: (ch, z, t, i) => (z * 50 + t * 100 + (i % 9)) }), { sessionKey: 'k-tile' });
  const tile = async (z, t, level) => A((await c.ok('doc.tile', { docId: id, channel: 0, level, tx: 0, ty: 0, pos: { z, t } })).data);
  const t00 = await tile(0, 0, 1), t11 = await tile(1, 1, 1);
  assert.notDeepEqual(t00, t11, 'two planes, two pyramids');
  assert.deepEqual(await tile(0, 0, 1), t00, 'a cached level is served again');
  // an edit of ONE plane: its level changes, another plane's level is the same array contents
  await c.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 40 }, channel: 0, pos: { z: 1, t: 1 } });
  const t11b = await tile(1, 1, 1);
  assert.notDeepEqual(t11b, t11, 'the edited plane is rebuilt');
  assert.deepEqual(await tile(0, 0, 1), t00, 'the other plane is unchanged');
  assert.notDeepEqual(await tile(1, 1, 2), await tile(0, 0, 2));
  await c.ok('doc.undo', { docId: id });
  assert.deepEqual(await tile(1, 1, 1), t11, 'undo: the old array is the old pyramid again');
  // purge keeps the cache honest: closing frees it
  assert.ok(c.eng.usedBytes() > 0);
  await c.ok('doc.close', { docId: id, discard: true });
  assert.equal((await c.ok('doc.list', {})).docs.length, 0);
  console.log('tiles keyed with the plane: OK');
}

// ── 8. the budget over every plane ────────────────────────────────────────────────────────────────────────────────────────
{
  // 4 planes of 64 x 64 x 8-bit (4 KiB each, 16 KiB the channel): the document + the new arrays of a 4-plane run (16 KiB more) do
  // not fit in 28 KiB — while one plane at a time (noUndo) does
  const make = async (budget) => {
    const c = client({ budgetBytes: budget });
    const id = await c.open(mkImage({ W: 64, H: 64, nZ: 2, nT: 2 }), { sessionKey: 'k-bud' });
    return { c, id };
  };
  {
    const { c, id } = await make(28 * 1024);
    const est1 = await c.ok('doc.estimate', { docId: id, op: 'tAdd', params: { value: 1 }, channel: 0 });
    const estAll = await c.ok('doc.estimate', { docId: id, op: 'tAdd', params: { value: 1 }, channel: 0, planes: 'all' });
    assert.equal(estAll.needBytes, 4 * est1.needBytes, 'the need counts every plane');
    assert.equal(estAll.fitsWithoutUndo, true, 'one plane at a time fits');
    assert.equal(est1.fits, true); assert.equal(estAll.fits, false, 'the 4-plane run does not fit with its undo step');
    const before = c.doc(id).channels[0].planes.slice();
    const e = await c.err('doc.run', { docId: id, op: 'tAdd', params: { value: 1 }, channel: 0, planes: 'all' });
    assert.equal(e.code, 'IJ_OVER_BUDGET'); assert.ok(e.details.needBytes >= 4 * 4096);
    assert.ok(c.doc(id).channels[0].planes.every((a, i) => a === before[i]), 'refused before anything changed');
    assert.equal(c.doc(id).undo.length, 0);
    // without an undo step the same run fits plane by plane
    const r = await c.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 1 }, channel: 0, planes: 'all', noUndo: true });
    assert.equal(r.info.undoDepth, 0);
    assert.ok(c.doc(id).channels[0].planes.every((a, i) => a !== before[i]));
  }
  {
    // reclaimable bytes count every plane of an undo step: the first step (16 KiB of old arrays) is evicted to make room for the second
    const { c, id } = await make(40 * 1024);
    const first = await c.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 1 }, channel: 0, planes: 'all' });
    assert.equal(first.info.undoDepth, 1);
    const r = await c.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 2 }, channel: 0, planes: 'all' });
    assert.equal(r.info.undoDepth, 1, 'the oldest step gave way');
    c.check(id, 'budget eviction');
    assert.ok(c.eng.usedBytes() <= 40 * 1024, 'within the budget: ' + c.eng.usedBytes());
  }
  console.log('budget over every plane: OK');
}

// ── 9. composite undo steps (doc.undoGroup) ───────────────────────────────────────────────────────────────────────────────
{
  const c = client();
  const id = await c.open(mkImage({ nC: 1, nZ: 3, nT: 1, W: 6, H: 4 }), { sessionKey: 'k-grp' });
  const orig = [await c.plane(id, 0, 0, 0), await c.plane(id, 0, 1, 0), await c.plane(id, 0, 2, 0)];
  const planes0 = c.doc(id).channels[0].planes.slice();
  await c.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 1 }, channel: 0, planes: [0] });          // one step before the group
  await c.ok('doc.undoGroup.begin', { docId: id });
  await c.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 2 }, channel: 0, planes: [0, 1] });
  await c.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 3 }, channel: 0, planes: [1, 2] });
  await c.ok('doc.run', { docId: id, op: 'tCropAll', params: { w: 4, h: 3 }, channel: 'all' });            // a size step inside the group
  assert.equal(c.doc(id).undo.length, 4, 'steps are kept while the group is open');
  const end = await c.ok('doc.undoGroup.end', { docId: id, labelKey: 'macro.run' });
  assert.equal(end.steps, 3);
  assert.equal(c.doc(id).undo.length, 2, 'one step before + ONE composite');
  assert.equal(c.doc(id).undo[1].group.length, 3); assert.equal(c.doc(id).undo[1].labelKey, 'macro.run'); assert.equal(c.doc(id).undo[1].replayable, false);
  assert.deepEqual(P([(await c.ok('doc.info', { docId: id })).undoDepth, (await c.ok('doc.info', { docId: id })).redoDepth]), [2, 0]);
  const cropped = [await c.plane(id, 0, 0, 0), await c.plane(id, 0, 1, 0), await c.plane(id, 0, 2, 0)];
  const u = await c.ok('doc.undo', { docId: id });
  assert.deepEqual(P([u.info.width, u.info.height]), [6, 4]); assert.equal(u.changed.sizeChanged, true);
  assert.deepEqual(P([u.info.undoDepth, u.info.redoDepth]), [1, 1]);
  c.check(id, 'composite undo');
  const afterUndo = [await c.plane(id, 0, 0, 0), await c.plane(id, 0, 1, 0), await c.plane(id, 0, 2, 0)];
  assert.deepEqual(afterUndo[0], orig[0].map((v) => v + 1), 'back to the state before the group (plane 0 had the first step)');
  assert.deepEqual(afterUndo[1], orig[1]); assert.deepEqual(afterUndo[2], orig[2]);
  const rd = await c.ok('doc.redo', { docId: id });
  assert.equal(rd.info.width, 4); c.check(id, 'composite redo');
  assert.deepEqual([await c.plane(id, 0, 0, 0), await c.plane(id, 0, 1, 0), await c.plane(id, 0, 2, 0)], cropped, 'redo re-applies the steps in their order');
  await c.ok('doc.undo', { docId: id }); await c.ok('doc.undo', { docId: id });
  assert.ok(c.doc(id).channels[0].planes.every((a, i) => a === planes0[i]), 'everything undone: the original arrays');
  // an empty / single-step group leaves no composite; a group nests; end without begin is refused
  await c.ok('doc.undoGroup.begin', { docId: id }); await c.ok('doc.undoGroup.end', { docId: id });
  assert.equal(c.doc(id).undo.length, 0);
  await c.ok('doc.undoGroup.begin', { docId: id });
  await c.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 1 }, channel: 0 });
  await c.ok('doc.undoGroup.end', { docId: id });
  assert.equal(c.doc(id).undo.length, 1); assert.equal(c.doc(id).undo[0].group, undefined);
  await c.ok('doc.undo', { docId: id });
  await c.ok('doc.undoGroup.begin', { docId: id });
  await c.ok('doc.undoGroup.begin', { docId: id });
  await c.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 1 }, channel: 0, planes: [0] });
  assert.equal((await c.ok('doc.undoGroup.end', { docId: id })).depth, 1);
  await c.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 1 }, channel: 0, planes: [1] });
  assert.equal((await c.ok('doc.undoGroup.end', { docId: id })).steps, 2);
  assert.equal(c.doc(id).undo.length, 1);
  assert.equal((await c.err('doc.undoGroup.end', { docId: id })).code, 'IJ_BAD_ARGS');
  console.log('composite undo steps: OK');
}

// ── 10. the journal replays a planes run exactly (a crash, then a restore on a second engine) ──────────────────────────────
{
  const storage = IJEngine.createMemoryStorage();
  const key = 'ds1|stk|replay';
  const a = client({ storage });
  const id = await a.open(mkImage({ nC: 2, nZ: 3, nT: 2, hyperstack: true, labels: Array.from({ length: 12 }, (_, i) => 'q' + i) }), { sessionKey: key });
  await a.ok('doc.setPosition', { docId: id, z: 1, t: 1, c: 1 });
  await a.ok('doc.run', { docId: id, op: 'tAddByPos', params: {}, channel: 'all', planes: 'all' });
  await a.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 11 }, channel: 0, roi: { type: 'rect', x: 1, y: 1, w: 3, h: 2 }, planes: { z: [1, 2], t: [0, 0] } });
  await a.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 2 }, channel: 'all', pos: { z: 2, t: 1 } });
  await a.ok('doc.setLabel', { docId: id, n: 5, label: 'five' });
  await a.ok('doc.undo', { docId: id });                         // the label step
  await a.ok('doc.redo', { docId: id });
  await a.ok('doc.run', { docId: id, op: 'tCropAll', params: { w: 5, h: 3 }, channel: 'all' });
  await a.ok('doc.undo', { docId: id });
  await a.ok('doc.run', { docId: id, op: 'tReverseZ', params: {}, channel: 'all' });
  await a.eng.whenIdle();
  // the journal entries name the plane the request stood on and the explicit planes
  const jr = (await storage.load(key)).docs[id].journal;
  const runs = jr.filter((e) => e.kind === 'run');
  assert.deepEqual(P(runs[0].planes), [0, 1, 2, 3, 4, 5]); assert.deepEqual(P(runs[0].pos), { z: 1, t: 1 });
  assert.deepEqual(P(runs[1].planes), [1, 2]); assert.deepEqual(P(runs[1].pos), { z: 1, t: 1 });
  assert.deepEqual(P(runs[2].planes), [5]); assert.deepEqual(P(runs[2].pos), { z: 2, t: 1 });
  assert.ok(jr.some((e) => e.kind === 'label' && e.n === 5 && e.label === 'five'));
  assert.deepEqual(P(runs[3].pos), { z: 1, t: 1 }, 'a size op journals the position too');
  const want = {};
  const snapshot = async (cl, did) => {
    const o = {};
    for (let t = 0; t < 2; t++) for (let z = 0; z < 3; z++) for (let ch = 0; ch < 2; ch++) o[`${ch}.${z}.${t}`] = await cl.plane(did, ch, z, t);
    return o;
  };
  Object.assign(want, await snapshot(a, id));
  const liveLabels = P(a.doc(id).labels), liveInfo = await a.ok('doc.info', { docId: id });
  a.eng.dispose();
  const b = client({ storage });
  const res = await b.ok('session.restore', { key });
  assert.deepEqual(P(res.docIds), [id]); assert.equal(res.warnings.length, 0, JSON.stringify(res.warnings));
  assert.deepEqual(await snapshot(b, id), want, 'baseline + journal replay of the planes runs = the live result');
  assert.deepEqual(P(b.doc(id).labels), liveLabels);
  const bi = await b.ok('doc.info', { docId: id });
  assert.deepEqual(P([bi.nZ, bi.nT, bi.nC, bi.hyperstack, bi.rev]), P([liveInfo.nZ, liveInfo.nT, liveInfo.nC, liveInfo.hyperstack, liveInfo.rev]));
  b.check(id, 'restored');
  // the restored document keeps working: undo the reversal, the planes come back in z order
  await b.ok('doc.undo', { docId: id });
  b.check(id, 'restored, undo');
  // a snapshot (flush) of the stack + a later journal, then a restore: the planes are stored one by one
  await b.ok('doc.setPosition', { docId: id, z: 0, t: 1 });
  await b.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 4 }, channel: 'all', planes: 'all' });
  assert.equal((await b.ok('flush', {})).ok, true);
  await b.ok('doc.run', { docId: id, op: 'tAddByPos', params: {}, channel: 1, planes: [2, 3] });
  const want2 = await snapshot(b, id);
  await b.eng.whenIdle();
  b.eng.dispose();
  const cc = client({ storage });
  await cc.ok('session.restore', { key });
  assert.deepEqual(await snapshot(cc, id), want2, 'snapshot + journal');
  cc.check(id, 'restored from a snapshot');
  assert.deepEqual(P(await cc.ok('doc.info', { docId: id })).z, 0); assert.equal((await cc.ok('doc.info', { docId: id })).t, 1, 'the position comes back (display.pos)');
  console.log('journal replay of planes runs, snapshot + journal of a stack: OK');
}

// ── 11. the worker context E (packages' commands, the macro run lane) ───────────────────────────────────────────────────────
{
  const c = client();
  const events = [];
  IJOpRegistry.defineCommand('doc.testStack', {
    pkg: 'test',
    async handler(args, E) {
      const out = {};
      out.dims = E.dims(args.docId);
      out.pos0 = E.getPosition(args.docId);
      out.moved = E.setPosition(args.docId, { z: 2, t: 1, c: 1 });
      out.pos1 = E.getPosition(args.docId);
      out.sameLive = E.plane(args.docId, 1, 2, 1) === E.planes(args.docId, 1)[1 * 3 + 2];
      out.viewIsLive = E.readDoc(args.docId).channels[1].data === E.plane(args.docId, 1, 2, 1);
      out.viewAt = E.readDoc(args.docId, { z: 0, t: 0 }).channels[0].data === E.plane(args.docId, 0, 0, 0);
      out.label = E.getLabel(args.docId, 4); out.labels = E.labels(args.docId);
      out.clamped = E.setPosition(args.docId, { z: 50, t: 50 });
      E.setPosition(args.docId, { z: 0, t: 0, c: 0 });
      // runOp: async, locks the document itself; a planes run
      const r = await E.runOp(args.docId, 'tAdd', { value: 3 }, { planes: [0, 3], channel: 0 });
      out.ran = P(r);
      // commitPlanes: ONE undo step replacing two planes of channel 1
      const d = E.dims(args.docId);
      const mk = (v) => new Uint8Array(d.width * d.height).fill(v);
      E.reserve(2 * d.width * d.height);
      const cp = await E.commitPlanes(args.docId, [{ c: 1, z: 0, t: 0, data: mk(77) }, { c: 1, z: 2, t: 1, data: mk(88) }], { labelKey: 'macro.x' });
      out.committed = P(cp);
      out.after = [E.plane(args.docId, 1, 0, 0)[0], E.plane(args.docId, 1, 2, 1)[0]];
      // a bad commit is refused and changes nothing
      try { await E.commitPlanes(args.docId, [{ c: 1, z: 0, t: 0, data: new Uint8Array(3) }]); out.badCommit = 'accepted'; } catch (e) { out.badCommit = e.code; }
      try { await E.commitPlanes(args.docId, [{ c: 0, z: 9, t: 0, data: mk(1) }]); out.badCommit2 = 'accepted'; } catch (e) { out.badCommit2 = e.code; }
      // a stack image through createDoc
      const info = E.createDoc({ name: 'fromE', width: 2, height: 2, bitDepth: 8, nZ: 2, nT: 1, channels: [{ name: 'a', planes: [Uint8Array.of(1, 2, 3, 4), Uint8Array.of(5, 6, 7, 8)] }] });
      out.created = P([info.nZ, info.nSlices, info.docId.length > 0]);
      return out;
    }
  });
  const labels = Array.from({ length: 12 }, (_, i) => 'e' + (i + 1));
  const id = await c.open(mkImage({ nC: 2, nZ: 3, nT: 2, hyperstack: true, labels }), { sessionKey: 'k-E' });
  const o = await c.ok('doc.testStack', { docId: id });
  assert.deepEqual(P(o.dims), { width: 6, height: 4, nC: 2, nZ: 3, nT: 2, bitDepth: 8, bitDepthIJ: 8, rgb: false, hyperstack: true });
  assert.deepEqual(P(o.pos0), { c: 0, z: 0, t: 0 }); assert.deepEqual(P(o.moved), { c: 1, z: 2, t: 1 }); assert.deepEqual(P(o.pos1), { c: 1, z: 2, t: 1 });
  assert.deepEqual(P([o.sameLive, o.viewIsLive, o.viewAt]), [true, true, true]);
  assert.equal(o.label, 'e4'); assert.deepEqual(P(o.labels), labels);
  assert.deepEqual(P(o.clamped), { c: 1, z: 2, t: 1 });
  assert.deepEqual(P(o.ran.changed.planes), [0, 3]); assert.deepEqual(P(o.ran.newDocIds), []);
  assert.deepEqual(P(o.committed.changed.planes), [0, 5]); assert.deepEqual(P(o.committed.changed.channels), [1]);
  assert.deepEqual(o.after, [77, 88]);
  assert.equal(o.badCommit, 'IJ_BAD_ARGS'); assert.equal(o.badCommit2, 'IJ_BAD_ARGS');
  assert.deepEqual(P(o.created), [2, 2, true]);
  const pos = c.events('position');
  assert.ok(pos.length >= 2 && pos[0].docId === id && pos[0].z === 2 && pos[0].t === 1 && pos[0].c === 1, 'the position event follows E.setPosition');
  // the undo stack: the tAdd run and the commit are two steps; the commit is not replayable
  const d = c.doc(id);
  assert.equal(d.undo.length, 2); assert.equal(d.undo[1].replayable, false); assert.equal(d.undo[1].op, 'macro.x');
  c.check(id, 'after E');
  await c.ok('doc.undo', { docId: id });
  assert.equal(c.doc(id).channels[1].planes[0][0], 40, 'the commit undone: channel 1 plane 0 is back (value 40 + 0)');
  assert.equal(c.doc(id).channels[1].planes[5][0], 40 + 20 + 3, 'plane (z2,t1) of channel 1 is back');
  console.log('worker context E: dims / position / planes / labels / runOp / commitPlanes / createDoc: OK');
}

// ── 12. reads at `pos`: preview, stats, histogram, profile, threshold, particles, estimate, and a gray 'whole' compute ───────
{
  IJOpRegistry.define('tProbeGrayWhole', {
    kind: 'compute', version: 1, stack: 'whole',
    async run(view, params, roi, io) { return { nCh: view.channels.length, planes: view.channels[0].planes.length, lum: view.channels[0].planes.map((p) => p[0]), rgb: view.rgb, z: view.z }; }
  });
  const c = client();
  const W = 8, H = 6;
  const id = await c.open(mkImage({ W, H, nC: 1, nZ: 2, nT: 2, f: (ch, z, t, i) => (z === 1 && t === 1 ? 200 : z * 20 + t * 5 + (i % 4)) }), { sessionKey: 'k-reads' });
  // preview at pos equals the run on that plane (level 0)
  const wantPlane = (await c.plane(id, 0, 1, 1)).map((v) => Math.min(255, v + 3));
  await c.ok('doc.preview', { docId: id, op: 'tAdd', params: { value: 3 }, channel: 0, seq: 1, x0: 0, y0: 0, x1: W, y1: H, level: 0, pos: { z: 1, t: 1 } });
  const pv = c.events('preview').pop();
  assert.equal(pv.seq, 1); assert.deepEqual(A(pv.channels[0]), wantPlane, 'preview of the plane at pos');
  await c.ok('doc.preview', { docId: id, op: 'tAdd', params: { value: 3 }, channel: 0, seq: 2, x0: 0, y0: 0, x1: W, y1: H, level: 0 });
  assert.deepEqual(A(c.events('preview').pop().channels[0]), (await c.plane(id, 0, 0, 0)).map((v) => v + 3), 'default = the current plane');
  // stats / histogram at pos
  const st = await c.ok('doc.stats', { docId: id, measurements: ['mean', 'min', 'max'], pos: { z: 1, t: 1 } });
  assert.deepEqual(P([st.row.mean, st.row.min, st.row.max]), [200, 200, 200]);
  const st0 = await c.ok('doc.stats', { docId: id, measurements: ['min', 'max'] });
  assert.deepEqual(P([st0.row.min, st0.row.max]), [0, 3]);
  const hi = await c.ok('doc.histogram', { docId: id, bins: 256, stats: false, pos: { z: 1, t: 1 } });
  assert.equal(hi.counts[200], W * H);
  assert.equal((await c.ok('doc.histogram', { docId: id, bins: 256, stats: false })).counts[200], 0);
  // profile along a line at pos
  const pr = await c.ok('doc.profile', { docId: id, line: { type: 'line', x1: 0, y1: 2, x2: 7, y2: 2, width: 1 }, pos: { z: 1, t: 1 } });
  assert.ok(A(pr.values).every((v) => Math.abs(v - 200) < 1e-6), 'profile on the plane at pos');
  // threshold at pos: the range of THAT plane
  const th = await c.ok('doc.threshold', { docId: id, method: 'Default', pos: { z: 1, t: 1 } });
  assert.ok(Number.isFinite(th.lower));
  // estimate: the planes of the request
  const e1 = await c.ok('doc.estimate', { docId: id, op: 'tAdd', params: { value: 1 }, channel: 0 });
  const e4 = await c.ok('doc.estimate', { docId: id, op: 'tAdd', params: { value: 1 }, channel: 0, planes: { z: [0, 1], t: [0, 1] } });
  assert.equal(e4.needBytes, 4 * e1.needBytes);
  assert.equal((await c.err('doc.estimate', { docId: id, op: 'tAddPlane', params: { value: 1 }, channel: 0, planes: 'all' })).code, 'IJ_BAD_ARGS');
  const es = await c.ok('doc.estimate', { docId: id, op: 'tCropAll', params: { w: 4, h: 3 } });
  assert.ok(es.needBytes >= 3 * W * H, 'a size op run per plane keeps the other planes\' results too: ' + es.needBytes);
  // binary particles at pos (8-bit mask planes: 255 blob in plane (1,1) only)
  const mask = mkImage({ W: 10, H: 10, nC: 1, nZ: 2, nT: 1, f: (ch, z, t, i) => ((z === 1 && (i % 10) >= 2 && (i % 10) < 5 && Math.floor(i / 10) >= 2 && Math.floor(i / 10) < 5) ? 255 : 0) });
  const mid = await c.open(mask, { sessionKey: 'k-mask' });
  const none = await c.ok('doc.particles', { docId: mid, channel: 0, opts: {}, keys: ['area'], pos: { z: 0, t: 0 } });
  const some = await c.ok('doc.particles', { docId: mid, channel: 0, opts: {}, keys: ['area'], pos: { z: 1, t: 0 } });
  assert.deepEqual(P([none.summary.count, some.summary.count, some.rows[0].area]), [0, 1, 2.25], 'particles of the plane at pos (9 px at 0.5 um = 2.25 um2)');
  // an RGB image: the gray 'whole' compute sees the luminance of every plane
  const rgbImg = mkImage({ nC: 3, nZ: 3, nT: 1, rgb: true, names: ['Red', 'Green', 'Blue'], f: (ch, z) => 30 * (ch + 1) + z });
  const rid = await c.open(rgbImg, { sessionKey: 'k-rgb2' });
  const gw = await c.ok('doc.compute', { docId: rid, op: 'tProbeGrayWhole', params: {}, channel: 0, pos: { z: 2, t: 0 } });
  assert.deepEqual(P([gw.nCh, gw.planes, gw.rgb, gw.z, gw.lum]), [1, 3, false, 2, [0, 1, 2].map((z) => IJStack.rgbToGray(30 + z, 60 + z, 90 + z, false))]);
  console.log('reads at pos (preview / stats / histogram / profile / threshold / particles / estimate), gray whole compute: OK');
}

// ── 13. a composite undo step survives a restart (it forces a snapshot) ───────────────────────────────────────────────────
{
  const storage = IJEngine.createMemoryStorage();
  const key = 'ds1|stk|group';
  const a = client({ storage });
  const id = await a.open(mkImage({ nC: 1, nZ: 3, nT: 1 }), { sessionKey: key });
  await a.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 1 }, channel: 0, planes: [0] });
  await a.ok('doc.undoGroup.begin', { docId: id });
  await a.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 2 }, channel: 0, planes: [0, 1] });
  await a.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 4 }, channel: 0, planes: [1, 2] });
  await a.ok('doc.undoGroup.end', { docId: id, labelKey: 'm' });
  const afterGroup = [await a.plane(id, 0, 0, 0), await a.plane(id, 0, 1, 0), await a.plane(id, 0, 2, 0)];
  await a.eng.whenIdle(); a.eng.dispose();
  let b = client({ storage });
  await b.ok('session.restore', { key });
  assert.deepEqual([await b.plane(id, 0, 0, 0), await b.plane(id, 0, 1, 0), await b.plane(id, 0, 2, 0)], afterGroup, 'the steps of a group replay one by one');
  await b.ok('doc.undo', { docId: id });                                   // the one step before the group (the group is not in the restored stack)
  b.eng.dispose();
  // undo the composite live, then crash: the undo is not replayable, so the state was snapshotted
  const key2 = 'ds1|stk|group2';
  const a2 = client({ storage });
  const id2 = await a2.open(mkImage({ nC: 1, nZ: 3, nT: 1 }), { sessionKey: key2 });
  const first = [await a2.plane(id2, 0, 0, 0), await a2.plane(id2, 0, 1, 0), await a2.plane(id2, 0, 2, 0)];
  await a2.ok('doc.undoGroup.begin', { docId: id2 });
  await a2.ok('doc.run', { docId: id2, op: 'tAdd', params: { value: 2 }, channel: 0, planes: 'all' });
  await a2.ok('doc.run', { docId: id2, op: 'tAdd', params: { value: 4 }, channel: 0, planes: [1] });
  await a2.ok('doc.undoGroup.end', { docId: id2 });
  await a2.ok('doc.undo', { docId: id2 });
  assert.deepEqual([await a2.plane(id2, 0, 0, 0), await a2.plane(id2, 0, 1, 0), await a2.plane(id2, 0, 2, 0)], first);
  await a2.eng.whenIdle(); a2.eng.dispose();
  b = client({ storage });
  await b.ok('session.restore', { key: key2 });
  assert.deepEqual([await b.plane(id2, 0, 0, 0), await b.plane(id2, 0, 1, 0), await b.plane(id2, 0, 2, 0)], first, 'a restart after undoing a composite step');
  b.eng.dispose();
  console.log('composite undo steps and the journal: OK');
}

// ── 14. review fixes: frozen reads, the noUndo budget, posOf, engine.ops, label / docCreated events ───────────────────────────
{
  const tick = () => new Promise((r) => setTimeout(r, 0));
  // (a) a read keeps the plane it was asked for even when doc.setPosition lands while it is suspended at an await
  {
    const c = client();
    const W = 512, H = 512;
    const img = mkImage({ W, H, nZ: 2, f: (ch, z, t, i) => { if (z === 1) return 7; const x = i % W, y = (i / W) | 0; return (x % 8 < 3 && y % 8 < 3) ? 255 : 0; } });
    const id = await c.open(img, { sessionKey: 'k-frozen' });
    const p = c.ok('doc.particles', { docId: id, pos: { z: 0, t: 0 }, keys: ['mean'], opts: { minSize: 0, maxSize: Infinity }, measureImage: true });
    for (let k = 0; k < 3; k++) await tick();
    await c.ok('doc.setPosition', { docId: id, z: 1 });
    const res = await p;
    assert.ok(res.rows.length > 1000, 'many particles: ' + res.rows.length);
    assert.equal(res.rows.filter((r) => r.mean !== 255).length, 0, 'every particle measured on plane 0, not on the plane moved to meanwhile');
    assert.equal((await c.ok('doc.info', { docId: id })).z, 1, 'the position did move');
    // the same for stats, histogram and threshold: the read at the CURRENT plane is frozen too
    const st = await c.ok('doc.stats', { docId: id, measurements: ['mean'] });
    assert.equal(st.row.mean, 7, 'current plane is z=1 now');
  }
  // (b) noUndo over every plane: the budget is checked per plane while the baseline still holds the old arrays; estimate is honest
  {
    const W = 512, H = 512, nZ = 16, plane = W * H;
    const mk = () => mkImage({ W, H, nZ, f: (ch, z, t, i) => (z + i) & 255 });
    const c = client({ storage: false, budgetBytes: 6 * 1024 * 1024 });
    const id = await c.open(mk(), { sessionKey: 'k-nu' });
    const est = await c.ok('doc.estimate', { docId: id, op: 'tAdd', params: { value: 1 }, planes: 'all' });
    assert.equal(est.fits, false); assert.equal(est.fitsWithoutUndo, false, 'estimate: the new planes add up while the baseline holds the old ones');
    const e = await c.err('doc.run', { docId: id, op: 'tAdd', params: { value: 1 }, planes: 'all', noUndo: true });
    assert.equal(e.code, 'IJ_OVER_BUDGET', 'refused cleanly, not run past the budget');
    assert.ok(c.eng.usedBytes() <= c.eng.budgetBytes, 'memory stays inside the budget: ' + c.eng.usedBytes());
    // roomy enough: the estimate says yes and the run succeeds
    const c2 = client({ storage: false, budgetBytes: 12 * 1024 * 1024 });
    const id2 = await c2.open(mk(), { sessionKey: 'k-nu2' });
    const est2 = await c2.ok('doc.estimate', { docId: id2, op: 'tAdd', params: { value: 1 }, planes: 'all' });
    assert.equal(est2.fitsWithoutUndo, true);
    await c2.ok('doc.run', { docId: id2, op: 'tAdd', params: { value: 1 }, planes: 'all', noUndo: true });
    assert.equal((await c2.plane(id2, 0, 3, 0))[0], (3 & 255) + 1);
    assert.ok(plane > 0);
    // refused before any plane changed: the undo history, the revision and the pixels stay as they were (no invalidate)
    const c3 = client({ storage: false, budgetBytes: 16 * plane + plane + plane / 2 });
    const id3 = await c3.open(mk(), { sessionKey: 'k-nu3' });
    await c3.ok('doc.run', { docId: id3, op: 'tAdd', params: { value: 2 }, roi: { type: 'rect', x: 0, y: 0, w: 4, h: 4 }, planes: [0] });
    const before = await c3.ok('doc.info', { docId: id3 });
    assert.equal(before.undoDepth, 1);
    const p5 = A(await c3.plane(id3, 0, 5, 0));
    const nInval = c3.events('invalidate').length;
    const e3 = await c3.err('doc.run', { docId: id3, op: 'tAdd', params: { value: 1 }, planes: 'all', noUndo: true });
    assert.equal(e3.code, 'IJ_OVER_BUDGET');
    const after = await c3.ok('doc.info', { docId: id3 });
    assert.equal(after.undoDepth, 1, 'a refusal before any plane changed keeps the undo history');
    assert.equal(after.rev, before.rev, 'and the revision');
    assert.equal(c3.events('invalidate').length, nInval, 'and posts no invalidate');
    assert.deepEqual(A(await c3.plane(id3, 0, 5, 0)), p5);
  }
  // (c) posOf: a request over several documents names the plane of each other one; a redirect of the same stack size reads the measured plane
  {
    IJOpRegistry.define('tReadOther', {
      kind: 'compute', version: 1,
      async run(view, params, roi, io) { const o = io.readDoc(params.other); return { v: o.channels[0].data[0], z: o.z, t: o.t }; }
    });
    const c = client();
    const a = await c.open(mkImage({ nZ: 4, f: (ch, z) => 10 + z }), { sessionKey: 'k-pa' });
    const b = await c.open(mkImage({ nZ: 4, f: (ch, z) => 100 + z }), { sessionKey: 'k-pb' });
    const small = await c.open(mkImage({ nZ: 1, f: () => 55 }), { sessionKey: 'k-ps' });
    await c.ok('doc.setPosition', { docId: b, z: 1 });      // the engine's own plane of b lags the screen (z 3 there)
    const withPos = await c.ok('doc.compute', { docId: a, docIds: [b], op: 'tReadOther', params: { other: b }, posOf: { [b]: { z: 3, t: 0 } } });
    assert.deepEqual(P([withPos.v, withPos.z]), [103, 3], 'posOf names the plane of the other document');
    const without = await c.ok('doc.compute', { docId: a, docIds: [b], op: 'tReadOther', params: { other: b } });
    assert.deepEqual(P([without.v, without.z]), [101, 1], 'no posOf: its current plane');
    // Redirect: same size stack -> the measured plane (Analyzer.getRedirectImageOrStack), whatever b shows
    const st = await c.ok('doc.stats', { docId: a, measurements: ['mean'], pos: { z: 2, t: 0 }, redirect: { docId: b, channel: 0 }, posOf: { [b]: { z: 0, t: 0 } } });
    assert.equal(st.row.mean, 102, 'the redirect stack is read at the measured slice');
    // another size of stack (or one image): its own plane (posOf, else current)
    const st2 = await c.ok('doc.stats', { docId: small, measurements: ['mean'], redirect: { docId: b, channel: 0 }, posOf: { [b]: { z: 3, t: 0 } } });
    assert.equal(st2.row.mean, 103, 'a redirect that is not the same size of stack reads the plane the page shows for it');
    const st3 = await c.ok('doc.stats', { docId: small, measurements: ['mean'], redirect: { docId: b, channel: 0 } });
    assert.equal(st3.row.mean, 101);
  }
  // (d) engine.ops: every registered op with what the page decides on
  {
    const c = client();
    const ops = await c.ok('engine.ops', {});
    const by = new Map(ops.map((o) => [o.name, o]));
    assert.deepEqual(P(by.get('invert')), { name: 'invert', kind: 'pixel', stack: 'ask', rgb: 'each' });
    assert.deepEqual(P(by.get('tAddPlane')), { name: 'tAddPlane', kind: 'pixel', stack: 'plane', rgb: 'each' });
    assert.equal(by.get('tCropAll').kind, 'size'); assert.equal(by.get('tCropAll').stack, 'all');
    assert.equal(by.get('tNoRgb').rgb, false);
    assert.equal(ops.length, IJOpRegistry.list().length, 'every op');
  }
  // (e) undo of a label / size step tells the page (invalidate labels / calibration / sizeChanged)
  {
    const c = client();
    const id = await c.open(mkImage({ nZ: 3, labels: ['a', 'b', 'c'] }), { sessionKey: 'k-lab' });
    await c.ok('doc.setLabel', { docId: id, n: 2, label: 'B' });
    assert.equal(c.events('invalidate').pop().labels, true);
    await c.ok('doc.undo', { docId: id });
    const u = c.events('invalidate').pop();
    assert.deepEqual(P([u.calibration, u.labels, u.sizeChanged]), [true, true, false], 'the undo of Set Label forwards calibration + labels');
    await c.ok('doc.run', { docId: id, op: 'tDropLastZ', params: {} });
    await c.ok('doc.undo', { docId: id });
    assert.equal(c.events('invalidate').pop().sizeChanged, true);
    assert.deepEqual(P((await c.ok('doc.labels', { docId: id })).labels), ['a', 'b', 'c']);
  }
  // (f) E.runOp returns the new infos and the engine announces the documents a worker-side request made (docCreated); a page doc.run does not
  {
    const c = client();
    IJOpRegistry.defineCommand('doc.testRunNew', {
      pkg: 'test2',
      async handler(args, E) { const r = await E.runOp(args.docId, 'tPlus1Doc', {}, { pos: { z: 1, t: 0 } }); return P(r); }
    });
    const id = await c.open(mkImage({ nZ: 3 }), { sessionKey: 'k-new' });
    const before = c.events('docCreated').length;
    const r = await c.ok('doc.testRunNew', { docId: id });
    assert.equal(r.newDocIds.length, 1); assert.equal(r.newInfos.length, 1); assert.equal(r.newInfos[0].docId, r.newDocIds[0]);
    const ev = c.events('docCreated');
    assert.equal(ev.length, before + 1, 'announced once');
    assert.equal(ev[ev.length - 1].info.docId, r.newDocIds[0]); assert.equal(ev[ev.length - 1].source, id);
    const direct = await c.ok('doc.run', { docId: id, op: 'tPlus1Doc', params: {} });
    assert.equal(direct.newDocIds.length, 1);
    assert.equal(c.events('docCreated').length, before + 1, 'a page doc.run answers with its documents and announces nothing');
  }
  // (g) a 'whole' op on RGB: the luminance copy of every plane is budgeted, then given back
  {
    const W = 256, H = 256, nZ = 8;
    const rgb = () => mkImage({ W, H, nC: 3, nZ, rgb: true, names: ['Red', 'Green', 'Blue'], f: (ch, z) => 30 * (ch + 1) + z });
    const base = 3 * nZ * W * H;                          // the document itself
    const c = client({ budgetBytes: base + nZ * W * H / 2 });   // not even room for half the luminance planes
    const id = await c.open(rgb(), { sessionKey: 'k-gw' });
    const e = await c.err('doc.compute', { docId: id, op: 'tProbeGrayWhole', params: {}, channel: 0 });
    assert.equal(e.code, 'IJ_OVER_BUDGET', 'the luminance planes of the whole stack are refused, not allocated past the budget');
    const c2 = client({ budgetBytes: base * 3 });
    const id2 = await c2.open(rgb(), { sessionKey: 'k-gw2' });
    const used = c2.eng.usedBytes();
    const ok = await c2.ok('doc.compute', { docId: id2, op: 'tProbeGrayWhole', params: {}, channel: 0 });
    assert.equal(ok.planes, nZ);
    assert.ok(c2.eng.usedBytes() <= used + W * H, 'the transient reservation was released');
  }
  // (h) a stack's preview names the plane it was computed on
  {
    const c = client();
    const id = await c.open(mkImage({ nZ: 3 }), { sessionKey: 'k-pv' });
    await c.ok('doc.preview', { docId: id, op: 'tAdd', params: { value: 1 }, channel: 0, seq: 1, x0: 0, y0: 0, x1: 6, y1: 4, level: 0, pos: { z: 2, t: 0 } });
    assert.equal(c.events('preview').pop().pi, 2);
    const one = await c.open(mkImage({ nZ: 1 }), { sessionKey: 'k-pv1' });
    await c.ok('doc.preview', { docId: one, op: 'tAdd', params: { value: 1 }, channel: 0, seq: 2, x0: 0, y0: 0, x1: 6, y1: 4, level: 0 });
    assert.equal(c.events('preview').pop().pi, undefined, 'a single image: the event is what it always was');
  }
  console.log('review fixes (frozen reads, noUndo budget, posOf, engine.ops, label events, docCreated, gray whole budget, preview pi): OK');
}

for (const f of closers) f();
console.log('ij stk engine: OK');
