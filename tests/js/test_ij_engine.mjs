// Worker engine of the Advanced Studio (js/modules/studio/advanced-studio/ij-engine.js),
// run under Node with a fake `self` and the REAL pure modules (ij-core.js, ij-analysis.js):
//   • Z projection, every method, against a straight reference; blocks of one band in any order;
//   • doc.run in bands equals the pure module on the whole image (gaussian / rank / binary with
//     an apron, ROI composite), undo / redo / revert, crop / rotate / convert, 32-bit invert;
//   • the memory budget: refusal before running, eviction of the oldest undo step;
//   • cancel (queued and mid-way) leaves the document untouched; doc.pixel is served between
//     two slices of a running operation; progress events;
//   • the tile pyramid (edge tiles, repeated downsample2, invalidated by an edit);
//   • crash recovery with the in-memory storage: baseline only, snapshot + journal replay,
//     an undo that crosses a snapshot, an undo that does not, idle snapshot, Save + close,
//     keep for later, discard, session meta, a storage write refused for quota;
//   • stats / histogram / profile / threshold / particles / duplicate / cropToNew / toMask /
//     TIFF export + open / preview (level 0 equals the whole-image result, superseded dropped).
//
// Run: node tests/js/test_ij_engine.mjs
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
const { IJEngine, IJOps, IJFilters, IJBinary, IJRoi, IJThreshold, IJTiff } = sandbox;
assert.ok(IJEngine && IJOps && IJFilters, 'modules loaded');

// ── helpers ───────────────────────────────────────────────────────────────────────────────────
const A = (x) => Array.from(x);
const P = (x) => JSON.parse(JSON.stringify(x));   // the engine runs in its own realm: compare by value
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const closers = [];

function client(opts = {}) {
  const log = [];
  const waiters = new Map();
  const hooks = [];
  let n = 0;
  const fake = {
    navigator: {}, onmessage: null,
    postMessage(m) {
      log.push(m);
      if (m.id !== undefined && 'ok' in m) { const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m); } }
      else for (const h of hooks) h(m);
    }
  };
  const eng = IJEngine.start(fake, Object.assign({ storage: 'memory', idleMs: 3600000, bandPixels: 1 << 20 }, opts));
  closers.push(() => eng.dispose());
  const c = {
    log, eng, fake, hooks,
    lastId: 0,
    call(cmd, args) { return new Promise((res) => { const id = ++n; c.lastId = id; waiters.set(id, res); fake.onmessage({ data: { id, cmd, args } }); }); },
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
    // Put `chans` (arrays of W*H bytes) in a new document through a depth-1 projection.
    async makeDoc(W, H, chans, o = {}) {
      const method = o.method || 'max';
      const begin = await c.ok('doc.project.begin', {
        docId: o.docId, name: o.name || 'img', method, width: W, height: H, depth: 1,
        channels: chans.map((_, i) => ({ name: 'C' + (i + 1), color: ['#ffffff', '#00ff00', '#ff0000'][i] || '#ffffff' })),
        calibration: o.calibration || { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'µm' },
        provenance: o.provenance || { datasetId: 'ds1', sessionKey: o.sessionKey || 'ds1|k|0|z|0|0|' + method }
      });
      for (let i = 0; i < chans.length; i++) {
        await c.ok('doc.project.add', { docId: begin.docId, channel: i, y0: 0, rows: H, z0: 0, depth: 1, data: Uint8Array.from(chans[i]) });
      }
      const fin = await c.ok('doc.project.finish', { docId: begin.docId });
      return { id: begin.docId, info: fin.info, begin };
    },
    async pixels(id, ch = 0) {
      const info = await c.ok('doc.info', { docId: id });
      assert.ok(info.width <= 1024 && info.height <= 1024);
      const t = await c.ok('doc.tile', { docId: id, channel: ch, level: 0, tx: 0, ty: 0 });
      return A(t.data);
    }
  };
  return c;
}

function blobImage(W, H, seed) {
  const r = rng(seed);
  const d = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const bump = 120 * Math.exp(-(((x - W * 0.3) ** 2 + (y - H * 0.4) ** 2) / 120)) + 90 * Math.exp(-(((x - W * 0.7) ** 2 + (y - H * 0.7) ** 2) / 60));
    d[y * W + x] = Math.min(255, Math.floor(bump + r() * 40));
  }
  return d;
}

// ── 1. projection: every method ────────────────────────────────────────────────────────────────
{
  const W = 9, H = 7;
  for (const depth of [4, 5]) {
    const r = rng(7 + depth);
    const planes = [0, 1].map(() => Array.from({ length: depth }, () => Uint8Array.from({ length: W * H }, () => Math.floor(r() * 256))));
    const methods = { max: 8, min: 8, sum: 16, avg: 32, sd: 32, median: 32 };
    const refOf = (method, c, i) => {
      const v = planes[c].map((p) => p[i]);
      const n = v.length;
      const sum = v.reduce((a, b) => a + b, 0);
      switch (method) {
        case 'max': return Math.max(...v);
        case 'min': return Math.min(...v);
        case 'sum': return sum;
        case 'avg': return sum / n;
        case 'sd': { const ss = v.reduce((a, b) => a + b * b, 0); return Math.sqrt(Math.max(0, n * ss - sum * sum) / (n * (n - 1))); }
        default: { const s = [...v].sort((a, b) => a - b); return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }
      }
    };
    for (const [method, bits] of Object.entries(methods)) {
      const results = [];
      for (const order of ['forward', 'shuffled']) {
        const c = client();
        const b = await c.ok('doc.project.begin', {
          name: 'p', method, width: W, height: H, depth, channels: [{ name: 'a', color: '#fff' }, { name: 'b', color: '#0f0' }],
          calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'µm' }, provenance: {}
        });
        assert.equal(b.outputBitDepth, bits, `${method} output depth`);
        assert.ok(b.estimateBytes > 0);
        const blocks = [];
        for (const ch of [0, 1]) for (const [y0, rows] of [[0, 3], [3, H - 3]]) for (const [z0, d] of [[0, 2], [2, depth - 2]]) blocks.push({ ch, y0, rows, z0, d });
        if (order === 'shuffled') { const rr = rng(99); blocks.sort(() => rr() - 0.5); }
        let last = 0;
        for (const k of blocks) {
          const data = new Uint8Array(k.d * k.rows * W);
          for (let zi = 0; zi < k.d; zi++) for (let q = 0; q < k.rows; q++) for (let x = 0; x < W; x++) data[(zi * k.rows + q) * W + x] = planes[k.ch][k.z0 + zi][(k.y0 + q) * W + x];
          const res = await c.ok('doc.project.add', { docId: b.docId, channel: k.ch, y0: k.y0, rows: k.rows, z0: k.z0, depth: k.d, data });
          assert.ok(res.fraction >= last - 1e-12 && res.fraction <= 1 + 1e-12, 'progress is monotonic');
          last = res.fraction;
        }
        assert.ok(Math.abs(last - 1) < 1e-9, 'all blocks in');
        const fin = await c.ok('doc.project.finish', { docId: b.docId });
        assert.equal(fin.info.bitDepth, bits);
        const out = [await c.pixels(b.docId, 0), await c.pixels(b.docId, 1)];
        results.push(out);
        for (const ch of [0, 1]) for (let i = 0; i < W * H; i++) {
          const want = bits === 32 ? Math.fround(refOf(method, ch, i)) : refOf(method, ch, i);
          assert.ok(Math.abs(out[ch][i] - want) <= (bits === 32 ? 1e-4 * Math.max(1, Math.abs(want)) : 0), `${method} depth ${depth} ch ${ch} px ${i}: ${out[ch][i]} vs ${want}`);
        }
      }
      assert.deepEqual(results[0], results[1], `${method}: block order does not matter`);
    }
  }
  // Sum goes to 32 bits beyond 257 planes (255 * 258 > 65535).
  const c = client();
  const b258 = await c.ok('doc.project.begin', { name: 'big', method: 'sum', width: 2, height: 2, depth: 258, channels: [{ name: 'a', color: '#fff' }], calibration: {}, provenance: {} });
  assert.equal(b258.outputBitDepth, 32);
  const b257 = await c.ok('doc.project.begin', { name: 'ok', method: 'sum', width: 2, height: 2, depth: 257, channels: [{ name: 'a', color: '#fff' }], calibration: {}, provenance: {} });
  assert.equal(b257.outputBitDepth, 16);
  // An incomplete projection is refused, and a pending one can be closed.
  const e = await c.err('doc.project.finish', { docId: b257.docId });
  assert.equal(e.code, 'IJ_INCOMPLETE');
  await c.ok('doc.close', { docId: b257.docId });
  assert.equal((await c.err('doc.project.add', { docId: b257.docId, channel: 0, y0: 0, rows: 1, z0: 0, depth: 1, data: new Uint8Array(2) })).code, 'IJ_NO_PROJECT');
  console.log('projection (6 methods, block order, 16/32-bit sum): OK');
}

// ── 2. run / undo / redo / revert, and banded == whole-image maths ───────────────────────────────────
{
  const W = 97, H = 61;
  const img = blobImage(W, H, 3);
  const c = client({ bandPixels: W * 7, adaptive: false });   // 7-row bands: every op crosses band seams
  const { id } = await c.makeDoc(W, H, [img]);
  const orig = A(img);
  const chan = { width: W, height: H, bitDepth: 8, data: img };
  const run = (op, params, roi, channel = 0) => c.ok('doc.run', { docId: id, op, params, roi, channel });

  // invert (whole image)
  let r = await run('invert', {}, null);
  assert.equal(r.rev, 1);
  assert.deepEqual(P(r.changed), { channels: [0], sizeChanged: false });
  let px = await c.pixels(id);
  assert.deepEqual(px, orig.map((v) => 255 - v));
  assert.ok(c.events('invalidate').length >= 1);
  r = await c.ok('doc.undo', { docId: id });
  assert.deepEqual(await c.pixels(id), orig);
  assert.equal(r.info.redoDepth, 1);
  r = await c.ok('doc.redo', { docId: id });
  assert.deepEqual(await c.pixels(id), orig.map((v) => 255 - v));
  await c.ok('doc.undo', { docId: id });

  // fill inside a rectangle only; undo stores just the rectangle
  const rect = { type: 'rect', x: 10, y: 5, w: 30, h: 20 };
  await run('fill', { value: 7 }, rect);
  px = await c.pixels(id);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const inside = x >= 10 && x < 40 && y >= 5 && y < 25;
    assert.equal(px[y * W + x], inside ? 7 : orig[y * W + x], `fill ${x},${y}`);
  }
  await c.ok('doc.undo', { docId: id });
  assert.deepEqual(await c.pixels(id), orig);

  // gaussian with an oval ROI, banded: inside the ellipse = the whole-image filter, outside untouched
  const oval = { type: 'oval', x: 12, y: 8, w: 60, h: 40 };
  await run('gaussian', { sigma: 2.5 }, oval);
  const g = IJFilters.gaussian(chan, 2.5, 2.5, { accuracy: 0.002 }).data;
  const om = IJRoi.mask(oval, W, H);
  px = await c.pixels(id);
  let diffs = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const inside = x >= om.x && x < om.x + om.w && y >= om.y && y < om.y + om.h && om.data[(y - om.y) * om.w + (x - om.x)];
    if (px[y * W + x] !== (inside ? g[y * W + x] : orig[y * W + x])) diffs++;
  }
  assert.equal(diffs, 0, 'banded gaussian with an apron equals the whole-image filter');
  await c.ok('doc.undo', { docId: id });
  // scaled sigma: 1.25 µm at 0.5 µm/px = 2.5 px
  await run('gaussian', { sigma: 1.25, scaled: true }, null);
  assert.deepEqual(await c.pixels(id), A(g), 'scaled sigma = sigma / pixel size');
  await c.ok('doc.undo', { docId: id });

  // rank filters, no ROI
  for (const [type, radius] of [['median', 2], ['mean', 1.5], ['max', 3], ['min', 1]]) {
    await run('rank', { type, radius }, null);
    assert.deepEqual(await c.pixels(id), A(IJFilters.rank(chan, radius, type).data), `rank ${type}`);
    await c.ok('doc.undo', { docId: id });
  }

  // math, applyLut (display-aware), clearOutside
  await run('math', { op: 'add', value: 100 }, null);
  assert.deepEqual(await c.pixels(id), orig.map((v) => Math.min(255, v + 100)));
  await c.ok('doc.undo', { docId: id });
  await run('applyLut', { min: 50, max: 200 }, null);
  assert.deepEqual(await c.pixels(id), A(IJOps.applyLut(chan, 50, 200).data));
  await c.ok('doc.undo', { docId: id });
  assert.equal((await c.err('doc.run', { docId: id, op: 'clearOutside', params: { value: 0 }, roi: null, channel: 0 })).code, 'IJ_NEEDS_ROI');
  await run('clearOutside', { value: 0 }, rect);
  px = await c.pixels(id);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const inside = x >= 10 && x < 40 && y >= 5 && y < 25;
    assert.equal(px[y * W + x], inside ? orig[y * W + x] : 0);
  }
  await c.ok('doc.undo', { docId: id });
  assert.equal((await c.err('doc.run', { docId: id, op: 'nope', params: {}, roi: null, channel: 0 })).code, 'IJ_UNKNOWN_OP');

  // size changes: crop, rotate, flip, convert; each undoable
  let ri = await run('crop', {}, { type: 'rect', x: 10, y: 5, w: 30, h: 20 });
  assert.equal(ri.changed.sizeChanged, true);
  assert.equal(ri.info.width, 30); assert.equal(ri.info.height, 20);
  px = await c.pixels(id);
  assert.equal(px[0], orig[5 * W + 10]); assert.equal(px[30 * 20 - 1], orig[24 * W + 39]);
  ri = await c.ok('doc.undo', { docId: id });
  assert.equal(ri.info.width, W);
  assert.deepEqual(await c.pixels(id), orig);
  ri = await run('rotate90', { dir: 'right' }, null);
  assert.equal(ri.info.width, H); assert.equal(ri.info.height, W);
  assert.equal(ri.info.calibration.unit, 'µm');
  assert.deepEqual(await c.pixels(id), A(IJOps.rotate90(chan, 'right').data));
  await c.ok('doc.undo', { docId: id });
  await run('flipH', {}, null);
  assert.deepEqual(await c.pixels(id), A(IJOps.flipH(chan).data));
  await c.ok('doc.undo', { docId: id });
  await run('flipV', {}, rect);
  px = await c.pixels(id);
  const flipped = IJOps.flipV(IJOps.crop(chan, 10, 5, 30, 20)).data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const inside = x >= 10 && x < 40 && y >= 5 && y < 25;
    assert.equal(px[y * W + x], inside ? flipped[(y - 5) * 30 + (x - 10)] : orig[y * W + x]);
  }
  await c.ok('doc.undo', { docId: id });
  ri = await run('convert', { bitDepth: 16 }, null);
  assert.equal(ri.info.bitDepth, 16);
  assert.deepEqual(await c.pixels(id), orig, '8 → 16 keeps the values');
  ri = await run('convert', { bitDepth: 32 }, null);
  assert.equal(ri.info.bitDepth, 32);
  // 32-bit invert about the data range: v' = max + min - v
  const mn = Math.min(...orig), mx = Math.max(...orig);
  await run('invert', {}, null);
  assert.deepEqual(await c.pixels(id), orig.map((v) => mx + mn - v));
  await c.ok('doc.undo', { docId: id });
  await c.ok('doc.undo', { docId: id });
  ri = await c.ok('doc.undo', { docId: id });
  assert.equal(ri.info.bitDepth, 8);
  assert.deepEqual(await c.pixels(id), orig);
  assert.equal((await c.err('doc.undo', { docId: id })).code, 'IJ_NOTHING_TO_UNDO');

  // revert: back to the baseline, and the revert itself can be undone
  await run('invert', {}, null);
  await run('gaussian', { sigma: 1 }, null);
  await c.eng.whenIdle();
  ri = await c.ok('doc.revert', { docId: id });
  assert.deepEqual(await c.pixels(id), orig, 'revert restores the loaded image');
  await c.ok('doc.undo', { docId: id });
  assert.notDeepEqual(await c.pixels(id), orig, 'undo of the revert brings the edits back');
  assert.equal(c.events('storageError').length, 0);

  // binary morphology on a mask made by toMask, banded == whole image
  const tm = await run('toMask', { lower: 100, upper: 255 }, null);
  assert.equal(tm.newDocIds.length, 1);
  const mid = tm.newDocIds[0];
  const mask = await c.pixels(mid);
  assert.ok(mask.every((v) => v === 0 || v === 255) && mask.some((v) => v === 255));
  const mimg = { width: W, height: H, bitDepth: 8, data: Uint8Array.from(mask) };
  for (const [op, o] of [['erode', { iterations: 2 }], ['dilate', { iterations: 1 }], ['open', { iterations: 2 }], ['close', { iterations: 1 }], ['outline', {}], ['fillHoles', {}]]) {
    await c.ok('doc.run', { docId: mid, op: 'binary', params: Object.assign({ op }, o), roi: null, channel: 0 });
    const want = IJBinary[op](mimg, Object.assign({}, o)).data;
    assert.deepEqual(await c.pixels(mid), A(want), `binary ${op}`);
    await c.ok('doc.undo', { docId: mid });
  }
  await run('convert', { bitDepth: 16 }, null);
  assert.equal((await c.err('doc.run', { docId: id, op: 'binary', params: { op: 'erode' }, roi: null, channel: 0 })).code, 'IJ_NOT_BINARY');
  console.log('run / undo / redo / revert, banded filters, size ops, binary: OK');
}

// ── 3. memory budget ───────────────────────────────────────────────────────────────────────────────
{
  const W = 200, H = 200;               // 40 000 B per 8-bit channel
  const data = Uint8Array.from({ length: W * H }, (_, i) => i & 255);
  const c = client({ budgetBytes: 110000 });
  const { id } = await c.makeDoc(W, H, [data]);
  // 40 KB master; invert needs another 40 KB (and keeps the old one as the undo step): fits
  let r = await c.ok('doc.run', { docId: id, op: 'invert', params: {}, roi: null, channel: 0 });
  assert.equal(r.info.undoDepth, 1);
  // second invert would need 40 KB more than the 110 KB left; the undo step is evicted instead
  r = await c.ok('doc.run', { docId: id, op: 'invert', params: {}, roi: null, channel: 0 });
  assert.equal(r.rev, 2);
  assert.ok(r.info.undoDepth <= 2);
  // a creation that cannot fit is refused BEFORE it runs, nothing is evicted for nothing
  const e = await c.err('doc.create', { name: 'huge', width: 2000, height: 2000, bitDepth: 8, channels: [{ name: 'a', color: '#fff' }], calibration: {} });
  assert.equal(e.code, 'IJ_OVER_BUDGET');
  assert.ok(e.details && e.details.needBytes > 0 && e.details.budgetBytes === 110000);
  assert.equal((await c.ok('doc.info', { docId: id })).rev, 2);
  // an op that cannot fit even with every undo step gone leaves the document alone
  const c2 = client({ budgetBytes: 70000 });
  const d2 = await c2.makeDoc(W, H, [data]);
  const e2 = await c2.err('doc.run', { docId: d2.id, op: 'invert', params: {}, roi: null, channel: 0 });
  assert.equal(e2.code, 'IJ_OVER_BUDGET');
  const i2 = await c2.ok('doc.info', { docId: d2.id });
  assert.equal(i2.rev, 0); assert.equal(i2.undoDepth, 0);
  assert.deepEqual(await c2.pixels(d2.id), A(data));
  // a projection too big for the budget is refused at begin
  const e3 = await c2.err('doc.project.begin', { name: 'p', method: 'sd', width: 1000, height: 1000, depth: 3, channels: [{ name: 'a', color: '#fff' }], calibration: {}, provenance: {} });
  assert.equal(e3.code, 'IJ_OVER_BUDGET');
  assert.ok(c.events('budget').length >= 1);
  assert.equal(IJEngine.defaultBudget({ deviceMemory: 8 }), 2 * 1073741824);
  assert.equal(IJEngine.defaultBudget({ deviceMemory: 1 }), 536870912);
  assert.equal(IJEngine.defaultBudget({}), 1073741824);
  console.log('budget: refusal before running, undo eviction: OK');
}

// ── 4. cancel, and doc.pixel served between slices ───────────────────────────────────────────────────
{
  const W = 300, H = 300;
  const img = blobImage(W, H, 11);
  const c = client({ sliceMs: 0.001, bandPixels: W * 3, adaptive: false });
  const { id } = await c.makeDoc(W, H, [img]);
  const before = await c.pixels(id);

  // cancelled while still queued behind another operation: it never starts
  const first = c.call('doc.run', { docId: id, op: 'invert', params: {}, roi: null, channel: 0 });
  const second = c.call('doc.run', { docId: id, op: 'gaussian', params: { sigma: 3 }, roi: null, channel: 0 });
  c.fake.onmessage({ data: { id: 9001, cmd: 'cancel', args: { targetId: c.lastId } } });
  assert.equal((await first).ok, true);
  const sm = await second;
  assert.equal(sm.ok, false); assert.equal(sm.error.code, 'IJ_CANCELLED');
  assert.equal((await c.ok('doc.info', { docId: id })).rev, 1, 'only the first operation ran');
  await c.ok('doc.undo', { docId: id });

  // mid-way cancel: the first progress event cancels the run that emitted it
  const hook = (m) => { if (m.event === 'progress' && !hook.done) { hook.done = true; c.fake.onmessage({ data: { id: 9002, cmd: 'cancel', args: { targetId: m.id } } }); } };
  c.hooks.push(hook);
  const m = await c.call('doc.run', { docId: id, op: 'gaussian', params: { sigma: 3 }, roi: null, channel: 0 });
  assert.equal(hook.done, true, 'a progress event was emitted');
  assert.equal(m.ok, false);
  assert.equal(m.error.code, 'IJ_CANCELLED');
  c.hooks.length = 0;
  const info = await c.ok('doc.info', { docId: id });
  assert.equal(info.undoDepth, 0);
  assert.deepEqual(await c.pixels(id), before, 'a cancelled run leaves the pixels alone');

  // pixel answered while a long op is still running; progress events accumulate
  const c2 = client({ sliceMs: 0.001, bandPixels: W * 3, adaptive: false });
  const d2 = await c2.makeDoc(W, H, [img]);
  const orig = A(img);
  let pixelAnswerIndex = -1, runAnswerIndex = -1, asked = false;
  const sent = [];
  c2.hooks.push((ev) => {
    if (ev.event === 'progress' && !asked) {
      asked = true;
      c2.call('doc.pixel', { docId: d2.id, x: 5, y: 7 }).then((pm) => { sent.push(pm); pixelAnswerIndex = c2.log.indexOf(pm); });
    }
  });
  const run = await c2.call('doc.run', { docId: d2.id, op: 'gaussian', params: { sigma: 4 }, roi: null, channel: 0 });
  runAnswerIndex = c2.log.indexOf(run);
  assert.ok(run.ok);
  assert.equal(asked, true);
  assert.ok(pixelAnswerIndex >= 0 && pixelAnswerIndex < runAnswerIndex, 'doc.pixel was answered before the long op finished');
  assert.equal(sent[0].result.values[0], orig[7 * W + 5], 'a read during an op sees the document as it was (commit is atomic)');
  const prog = c2.events('progress');
  assert.ok(prog.length >= 2, 'several progress events');
  assert.ok(prog.every((p) => p.fraction >= 0 && p.fraction <= 1 && typeof p.stepKey === 'string'));
  for (let i = 1; i < prog.length; i++) assert.ok(prog[i].fraction >= prog[i - 1].fraction - 1e-12, 'progress never goes back');
  assert.equal((await c2.call('doc.pixel', { docId: d2.id, x: 1e6, y: 0 })).result.values.length, 0);
  console.log('cancel, doc.pixel between slices, progress: OK');
}

// ── 5. tile pyramid ───────────────────────────────────────────────────────────────────────────────────
{
  const W = 2500, H = 1200;
  const data = Uint8Array.from({ length: W * H }, (_, i) => ((i % W) * 7 + Math.floor(i / W) * 13) & 255);
  const c = client();
  const { id, info } = await c.makeDoc(W, H, [data]);
  assert.equal(info.levels, 3, '2500 → 1250 → 625');
  assert.equal(info.tileSize, 1024);
  const t00 = await c.ok('doc.tile', { docId: id, channel: 0, level: 0, tx: 0, ty: 0 });
  assert.equal(t00.width, 1024); assert.equal(t00.height, 1024);
  assert.equal(t00.data[3 * 1024 + 5], data[3 * W + 5]);
  const t21 = await c.ok('doc.tile', { docId: id, channel: 0, level: 0, tx: 2, ty: 1 });
  assert.equal(t21.width, 452); assert.equal(t21.height, 176);
  assert.equal(t21.data[0], data[1024 * W + 2048]);
  const t10 = await c.ok('doc.tile', { docId: id, channel: 0, level: 1, tx: 1, ty: 0 });
  assert.equal(t10.width, 226); assert.equal(t10.height, 600);
  const lv1 = IJOps.downsample2({ width: W, height: H, bitDepth: 8, data });
  assert.equal(lv1.width, 1250);
  assert.equal(t10.data[4 * 226 + 9], lv1.data[4 * 1250 + 1024 + 9]);
  const t20 = await c.ok('doc.tile', { docId: id, channel: 0, level: 2, tx: 0, ty: 0 });
  assert.equal(t20.width, 625); assert.equal(t20.height, 300);
  assert.equal((await c.err('doc.tile', { docId: id, channel: 0, level: 0, tx: 3, ty: 0 })).code, 'IJ_BAD_TILE');
  assert.equal((await c.err('doc.tile', { docId: id, channel: 0, level: 3, tx: 0, ty: 0 })).code, 'IJ_BAD_TILE');
  // an edit invalidates the cached levels
  await c.ok('doc.run', { docId: id, op: 'invert', params: {}, roi: null, channel: 0 });
  const t10b = await c.ok('doc.tile', { docId: id, channel: 0, level: 1, tx: 1, ty: 0 });
  assert.notEqual(t10b.data[4 * 226 + 9], t10.data[4 * 226 + 9]);
  assert.equal(c.events('invalidate').some((e) => e.sizeChanged === false && e.channels.length === 1), true);
  console.log('tiles (edge tiles, levels, invalidation): OK');
}

// ── 6. crash recovery: snapshot + journal replay, in-memory storage ───────────────────────────────────────
{
  const W = 64, H = 48;
  const img = blobImage(W, H, 21), img2 = blobImage(W, H, 22);
  const rectA = { type: 'rect', x: 4, y: 4, w: 20, h: 12 };
  const mk = async (storage, extra = {}) => client(Object.assign({ storage }, extra));
  const ops = {
    invert: (c, id) => c.ok('doc.run', { docId: id, op: 'invert', params: {}, roi: null, channel: 'all' }),
    gauss: (c, id) => c.ok('doc.run', { docId: id, op: 'gaussian', params: { sigma: 1.5 }, roi: null, channel: 'all' }),
    fill: (c, id) => c.ok('doc.run', { docId: id, op: 'fill', params: { value: 9 }, roi: rectA, channel: 0 }),
    math: (c, id) => c.ok('doc.run', { docId: id, op: 'math', params: { op: 'add', value: 30 }, roi: null, channel: 1 })
  };
  const state = async (c, id) => [await c.pixels(id, 0), await c.pixels(id, 1)];
  const sessionKey = 'ds1|k|0|z|0|0|max';

  // (a) baseline only + journal, no snapshot yet
  {
    const storage = IJEngine.createMemoryStorage();
    const a = await mk(storage);
    const { id } = await a.makeDoc(W, H, [img, img2], { sessionKey });
    await ops.invert(a, id); await ops.fill(a, id); await ops.math(a, id);
    const want = await state(a, id);
    await a.eng.whenIdle();
    a.eng.dispose();                                      // crash: nothing but what storage holds
    const b = await mk(storage);
    const list = await b.ok('session.list', { datasetId: 'ds1' });
    assert.equal(list.sessions.length, 1);
    assert.equal(list.sessions[0].key, sessionKey);
    assert.equal(list.sessions[0].unsaved, true);
    assert.equal(list.sessions[0].docs, 1);
    assert.equal((await b.ok('session.list', { datasetId: 'other' })).sessions.length, 0);
    const res = await b.ok('session.restore', { key: sessionKey });
    assert.deepEqual(P(res.docIds), [id]);
    assert.equal(res.warnings.length, 0);
    assert.deepEqual(await state(b, id), want, 'baseline + journal replay');
    const inf = await b.ok('doc.info', { docId: id });
    assert.equal(inf.rev, 3);
    assert.equal(inf.name, 'img'); assert.equal(inf.channels.length, 2);
    // the restored document keeps working: revert goes to the stored baseline
    await b.ok('doc.revert', { docId: id });
    assert.deepEqual(await state(b, id), [A(img), A(img2)]);
  }

  // (b) a snapshot in the middle, journal after it
  {
    const storage = IJEngine.createMemoryStorage();
    const a = await mk(storage);
    const { id } = await a.makeDoc(W, H, [img, img2], { sessionKey });
    await ops.gauss(a, id);
    await a.ok('flush', {});
    const snap = (await storage.load(sessionKey)).docs[id].snapshot;
    assert.ok(snap && snap.rev === 1 && snap.journalSeq === 1, 'snapshot written by flush');
    assert.equal((await storage.load(sessionKey)).docs[id].journal.length, 0, 'the snapshot dropped the journal it covers');
    await ops.fill(a, id); await ops.invert(a, id);
    assert.equal((await storage.load(sessionKey)).docs[id].journal.length, 2);
    const want = await state(a, id);
    await a.eng.whenIdle(); a.eng.dispose();
    const b = await mk(storage);
    await b.ok('session.restore', { key: sessionKey });
    assert.deepEqual(await state(b, id), want, 'snapshot + replay');
  }

  // (c) undo of a step the snapshot already contains forces a new snapshot (it cannot be replayed)
  {
    const storage = IJEngine.createMemoryStorage();
    const a = await mk(storage);
    const { id } = await a.makeDoc(W, H, [img, img2], { sessionKey });
    await ops.gauss(a, id);
    await a.ok('flush', {});
    await a.ok('doc.undo', { docId: id });                // crosses the snapshot
    await ops.fill(a, id);                                // applied on the un-gaussed image
    const want = await state(a, id);
    assert.deepEqual(want[0].slice(0, 3).length, 3);
    await a.eng.whenIdle(); a.eng.dispose();
    const b = await mk(storage);
    await b.ok('session.restore', { key: sessionKey });
    assert.deepEqual(await state(b, id), want, 'undo across a snapshot is recoverable');
  }

  // (d) an undo of a journaled step is journaled; redo too
  {
    const storage = IJEngine.createMemoryStorage();
    const a = await mk(storage);
    const { id } = await a.makeDoc(W, H, [img, img2], { sessionKey });
    await ops.invert(a, id); await ops.fill(a, id); await ops.math(a, id);
    await a.ok('doc.undo', { docId: id }); await a.ok('doc.undo', { docId: id }); await a.ok('doc.redo', { docId: id });
    const want = await state(a, id);
    const kinds = (await storage.load(sessionKey)).docs[id].journal.map((e) => e.kind);
    await a.eng.whenIdle(); a.eng.dispose();
    assert.deepEqual(P((await storage.load(sessionKey)).docs[id].journal.map((e) => e.kind)), ['run', 'run', 'run', 'undo', 'undo', 'redo']);
    void kinds;
    const b = await mk(storage);
    await b.ok('session.restore', { key: sessionKey });
    assert.deepEqual(await state(b, id), want, 'undo / redo replay');
  }

  // (e) idle snapshot, session meta, display state, Save + close vs keep for later, discard
  {
    const storage = IJEngine.createMemoryStorage();
    const a = await mk(storage, { idleMs: 30 });
    const { id } = await a.makeDoc(W, H, [img, img2], { sessionKey });
    await ops.invert(a, id);
    await a.ok('doc.setDisplay', { docId: id, channel: 0, min: 20, max: 180, lut: 'Fire', invert: true, mode: 'color', active: 1, visible: [true, false] });
    await a.ok('session.putMeta', { results: [{ Area: 3 }], rois: [{ name: 'r1', roi: rectA }], measurements: ['area', 'mean'], windows: { bc: { x: 1, y: 2 } } });
    await sleep(120);
    await a.eng.whenIdle();
    const stored = await storage.load(sessionKey);
    assert.ok(stored.docs[id].snapshot && stored.docs[id].snapshot.rev === 1, 'idle snapshot written after the quiet period');
    assert.ok(a.events('saved').length >= 2);
    a.eng.dispose();
    const b = await mk(storage);
    const res = await b.ok('session.restore', { key: sessionKey });
    assert.deepEqual(JSON.parse(JSON.stringify(res.meta)), { results: [{ Area: 3 }], rois: [{ name: 'r1', roi: rectA }], measurements: ['area', 'mean'], windows: { bc: { x: 1, y: 2 } } });
    const inf = await b.ok('doc.info', { docId: id });
    assert.equal(inf.channels[0].display.min, 20); assert.equal(inf.channels[0].display.max, 180);
    assert.equal(inf.channels[0].display.lut, 'Fire'); assert.equal(inf.channels[0].display.invert, true);
    assert.equal(inf.mode, 'color'); assert.equal(inf.active, 1); assert.deepEqual(A(inf.visible), [true, false]);
    // keep for later: closing an unsaved document keeps its record
    await b.ok('doc.close', { docId: id });
    assert.equal((await b.ok('session.list', {})).sessions.length, 1);
    // restore again, save, close: the record is removed
    await b.ok('session.restore', { key: sessionKey });
    await b.ok('doc.markSaved', { docId: id });
    await b.ok('doc.close', { docId: id });
    await b.eng.whenIdle();
    assert.equal((await b.ok('session.list', {})).sessions.length, 0, 'saved + closed = nothing left to recover');
  }
  {
    const storage = IJEngine.createMemoryStorage();
    const a = await mk(storage);
    const { id } = await a.makeDoc(W, H, [img], { sessionKey });
    await a.eng.whenIdle();
    assert.equal((await a.ok('session.list', {})).sessions.length, 1);
    // an OPEN document keeps its stored baseline: its next snapshot would reference it
    const kept = await a.ok('session.discard', { key: sessionKey });
    assert.deepEqual(P(kept.kept), [id]);
    assert.equal((await a.ok('session.list', {})).sessions.length, 1, 'session.discard leaves an open document stored');
    // closing it with discard is what drops its stored state, and nothing comes back on flush
    await a.ok('doc.close', { docId: id, discard: true });
    assert.equal((await a.ok('session.list', {})).sessions.length, 0);
    await a.ok('flush', {});
    await a.ok('session.putMeta', { key: sessionKey, results: [] });
    assert.equal((await a.ok('session.list', {})).sessions.length, 0, 'no ghost session after discard + flush + putMeta');
    assert.equal((await a.err('session.restore', { key: sessionKey })).code, 'IJ_NO_SESSION');
    // no live document: the whole stored session goes
    const { id: id2 } = await a.makeDoc(W, H, [img], { sessionKey: 'ds1|other' });
    await a.ok('doc.close', { docId: id2 });             // clean-by-doc? no: unsaved → kept for later
    assert.equal((await a.ok('session.list', {})).sessions.length, 1);
    assert.deepEqual(P((await a.ok('session.discard', { key: 'ds1|other' })).kept), []);
    assert.equal((await a.ok('session.list', {})).sessions.length, 0);
  }

  // (f) a document created from another one (toMask, duplicate) is recoverable on its own
  {
    const storage = IJEngine.createMemoryStorage();
    const a = await mk(storage);
    const { id } = await a.makeDoc(W, H, [img], { sessionKey });
    const tm = await a.ok('doc.run', { docId: id, op: 'toMask', params: { lower: 90, upper: 255 }, roi: null, channel: 0 });
    const dup = await a.ok('doc.duplicate', { docId: id, roi: rectA, name: 'dup' });
    assert.equal(dup.info.width, 20); assert.equal(dup.info.height, 12);
    await a.ok('doc.run', { docId: tm.newDocIds[0], op: 'binary', params: { op: 'dilate' }, roi: null, channel: 0 });
    const want = await a.pixels(tm.newDocIds[0]);
    const wantDup = await a.pixels(dup.docId);
    await a.eng.whenIdle(); a.eng.dispose();
    const b = await mk(storage);
    const res = await b.ok('session.restore', { key: sessionKey });
    assert.equal(res.docIds.length, 3);
    assert.deepEqual(await b.pixels(tm.newDocIds[0]), want);
    assert.deepEqual(await b.pixels(dup.docId), wantDup);
  }

  // (g) a refused write (quota) raises storageError and the document says it is not protected
  {
    const base = IJEngine.createMemoryStorage();
    let refuse = false;
    const flaky = Object.assign({}, base, {
      putJournal(k, e) { if (refuse) { const err = new Error('full'); err.name = 'QuotaExceededError'; return Promise.reject(err); } return base.putJournal(k, e); }
    });
    const a = await mk(flaky);
    const { id } = await a.makeDoc(W, H, [img], { sessionKey });
    assert.equal((await a.ok('doc.info', { docId: id })).protected, true);
    refuse = true;
    const origError = console.error; console.error = () => {};
    await ops.invert(a, id);
    await a.eng.whenIdle();
    console.error = origError;
    const ev = a.events('storageError');
    assert.ok(ev.length >= 1 && ev[0].code === 'IJ_STORAGE_QUOTA', 'storageError event with the quota code');
    assert.equal((await a.ok('doc.info', { docId: id })).protected, false);
    // the work itself is untouched
    assert.deepEqual(await a.pixels(id), A(img).map((v) => 255 - v));
    // no storage at all: said once, nothing crashes
    const n = await mk('indexeddb');   // no indexedDB in this context
    assert.equal(n.events('storageError')[0].code, 'IJ_STORAGE_UNAVAILABLE');
    const nd = await n.makeDoc(W, H, [img], {});
    assert.equal((await n.ok('doc.info', { docId: nd.id })).protected, false);
    assert.deepEqual(P((await n.ok('session.list', {})).sessions), []);
    await n.ok('doc.run', { docId: nd.id, op: 'invert', params: {}, roi: null, channel: 0 });
    // revert works from RAM when there is no storage
    await n.ok('doc.revert', { docId: nd.id });
    assert.deepEqual(await n.pixels(nd.id), A(img));
  }
  console.log('recovery: baseline, snapshot + journal, undo across snapshot, idle snapshot, save/keep/discard, quota: OK');
}

// ── 7. analysis commands, new documents, TIFF, preview ───────────────────────────────────────────────────────
{
  const W = 120, H = 90;
  const img = blobImage(W, H, 5);
  const c = client({ sliceMs: 0.001, bandPixels: W * 4, adaptive: false });
  const { id } = await c.makeDoc(W, H, [img], { calibration: { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'µm' } });
  const rect = { type: 'rect', x: 20, y: 10, w: 40, h: 30 };

  // stats against the pure module, calibrated
  const row = (await c.ok('doc.stats', { docId: id, roi: rect, channel: 0, measurements: ['area', 'mean', 'min', 'max', 'bx', 'perim'] })).row;
  const want = IJOps.statistics({ width: W, height: H, bitDepth: 8, data: img }, IJRoi.mask(rect, W, H), { calibration: { pixelWidth: 0.5, pixelHeight: 0.5 } });
  assert.equal(row.area, want.area); assert.equal(row.mean, want.mean); assert.equal(row.min, want.min); assert.equal(row.max, want.max);
  assert.equal(row.bx, 10); assert.equal(row.perim, 140 * 0.5);
  assert.deepEqual(Object.keys(row).sort(), ['area', 'bx', 'max', 'mean', 'min', 'perim']);
  const line = { type: 'line', x1: 5, y1: 5, x2: 65, y2: 5, width: 1 };
  const lrow = (await c.ok('doc.stats', { docId: id, roi: line, channel: 0 })).row;
  assert.equal(lrow.length, 30);
  assert.equal(lrow.angle, 0);
  const prof = await c.ok('doc.profile', { docId: id, line, channel: 0 });
  assert.equal(prof.values.length, 61);
  assert.equal(prof.stepUm, 0.5);
  const hist = await c.ok('doc.histogram', { docId: id, roi: null, channel: 0, bins: 256 });
  assert.equal(hist.counts.length, 256);
  assert.equal(A(hist.counts).reduce((s, v) => s + v, 0), W * H);
  const th = await c.ok('doc.threshold', { docId: id, channel: 0, method: 'Otsu', dark: true, roi: null });
  const thRef = IJThreshold.levels({ width: W, height: H, bitDepth: 8, data: img }, 'Otsu', { dark: true });
  assert.equal(th.lower, thRef.lower); assert.equal(th.upper, thRef.upper);

  // particles on a two-square mask
  const sq = new Uint8Array(W * H);
  for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) sq[y * W + x] = 255;
  for (let y = 40; y < 46; y++) for (let x = 60; x < 70; x++) sq[y * W + x] = 255;
  const m = await c.makeDoc(W, H, [sq], { name: 'mask' });
  const pa = await c.ok('doc.particles', { docId: m.id, channel: 0, opts: { minSize: 0, maxSize: 1e9, calibration: null } });
  assert.equal(pa.summary.count, 2);
  assert.equal(pa.rows[0].areaPx, 100); assert.equal(pa.rows[1].areaPx, 60);
  assert.equal(pa.rows[0].area, 25); assert.equal(pa.outlines.length, 2);
  // A ring (10×10 square with a 4×4 hole): without "Include holes" the image measurements
  // cover the particle's own pixels only (Mean = Min = 255); with it the hole counts (Min 0).
  const ring = new Uint8Array(W * H);
  for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) ring[y * W + x] = (x >= 13 && x < 17 && y >= 13 && y < 17) ? 0 : 255;
  const rm = await c.makeDoc(W, H, [ring], { name: 'ring' });
  const noHoles = (await c.ok('doc.particles', { docId: rm.id, channel: 0, opts: { minSize: 0, maxSize: 1e9 } })).rows[0];
  assert.equal(noHoles.areaPx, 84); assert.equal(noHoles.mean, 255); assert.equal(noHoles.min, 255);
  const withHoles = (await c.ok('doc.particles', { docId: rm.id, channel: 0, opts: { minSize: 0, maxSize: 1e9, includeHoles: true } })).rows[0];
  assert.equal(withHoles.min, 0); assert.ok(withHoles.mean < 255);
  await c.ok('doc.close', { docId: rm.id, discard: true });
  const pb = await c.ok('doc.particles', { docId: m.id, channel: 0, opts: { minSize: 20, unit: 'um2', excludeEdges: false } });
  assert.equal(pb.summary.count, 1, 'um² size limits are converted with the calibration (20 µm² = 80 px: the 100 px square stays, the 60 px one goes)');
  const d16 = await c.makeDoc(W, H, [img], { method: 'sum' });
  assert.equal(d16.info.bitDepth, 16);
  assert.equal((await c.err('doc.particles', { docId: d16.id, channel: 0, opts: {} })).code, 'IJ_NOT_BINARY');
  // cropToNew and duplicate
  const ct = await c.ok('doc.run', { docId: id, op: 'cropToNew', params: { name: 'piece' }, roi: rect, channel: 'all' });
  const piece = await c.ok('doc.info', { docId: ct.newDocIds[0] });
  assert.equal(piece.width, 40); assert.equal(piece.height, 30); assert.equal(piece.name, 'piece');
  assert.equal((await c.ok('doc.info', { docId: id })).rev, 0, 'the source is untouched');
  const list = await c.ok('doc.list', {});
  assert.equal(list.docs.length, 4);

  // TIFF round trip through exportTiff / doc.open
  await c.ok('doc.run', { docId: id, op: 'gaussian', params: { sigma: 1 }, roi: null, channel: 0 });
  const tiff = await c.ok('doc.exportTiff', { docId: id });
  const opened = await c.ok('doc.open', { bytes: tiff.bytes });
  assert.equal(opened.info.width, W);
  assert.deepEqual(await c.pixels(opened.docId), await c.pixels(id), 'TIFF export → open keeps every voxel');
  assert.equal(opened.info.calibration.pixelWidth, 0.5);

  // preview: the region of the preview equals the whole-image result; a newer seq drops the older
  const pre = [];
  c.hooks.push((ev) => { if (ev.event === 'preview') pre.push(ev); });
  const gw = IJFilters.gaussian({ width: W, height: H, bitDepth: 8, data: await (async () => Uint8Array.from(await c.pixels(id)))() }, 2, 2, { accuracy: 0.002 }).data;
  const cur = Uint8Array.from(await c.pixels(id));
  const ref = IJFilters.gaussian({ width: W, height: H, bitDepth: 8, data: cur }, 2, 2, { accuracy: 0.002 }).data;
  void gw;
  const ack = await c.ok('doc.preview', { docId: id, seq: 1, op: 'gaussian', params: { sigma: 2 }, roi: null, channel: 0, level: 0, x0: 10, y0: 12, x1: 70, y1: 52 });
  assert.equal(ack.dropped, undefined);
  assert.equal(pre.length, 1);
  const pv = pre[0];
  assert.equal(pv.seq, 1); assert.equal(pv.level, 0); assert.equal(pv.x0, 10); assert.equal(pv.y0, 12); assert.equal(pv.w, 60); assert.equal(pv.h, 40);
  assert.equal(pv.bitDepth, 8);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 60; x++) assert.equal(pv.channels[0][y * 60 + x], ref[(12 + y) * W + 10 + x], `preview ${x},${y}`);
  assert.equal((await c.ok('doc.info', { docId: id })).rev, 1, 'a preview never edits the document');
  pre.length = 0;
  const q1 = c.call('doc.preview', { docId: id, seq: 3, op: 'gaussian', params: { sigma: 2 }, roi: null, channel: 0, level: 0, x0: 0, y0: 0, x1: W, y1: H });
  const q2 = c.call('doc.preview', { docId: id, seq: 4, op: 'gaussian', params: { sigma: 3 }, roi: null, channel: 0, level: 0, x0: 0, y0: 0, x1: W, y1: H });
  const [r1, r2] = await Promise.all([q1, q2]);
  assert.equal(r1.result.dropped, true); assert.equal(r2.result.dropped, undefined);
  assert.deepEqual(pre.map((e) => e.seq), [4], 'only the newest preview is delivered');
  // zoomed-out preview: computed on the coarser grid
  pre.length = 0;
  await c.ok('doc.preview', { docId: id, seq: 5, op: 'gaussian', params: { sigma: 4 }, roi: null, channel: 0, level: 1, x0: 0, y0: 0, x1: W, y1: H });
  assert.equal(pre[0].level, 1); assert.equal(pre[0].w, 60); assert.equal(pre[0].h, 45);
  assert.equal((await c.err('doc.preview', { docId: id, seq: 6, op: 'crop', params: {}, roi: null, channel: 0, level: 0, x0: 0, y0: 0, x1: 5, y1: 5 })).code, 'IJ_PREVIEW_UNSUPPORTED');

  // display state is not undoable and never touches pixels
  const sd = await c.ok('doc.setDisplay', { docId: id, channel: 0, min: 5, max: 99, lut: 'Ice' });
  assert.equal(sd.info.channels[0].display.max, 99);
  assert.equal(sd.info.undoDepth, 1);
  assert.equal((await c.err('doc.setDisplay', { docId: id, mode: 'weird' })).code, 'IJ_BAD_ARGS');
  assert.equal((await c.err('doc.nothing', {})).code, 'IJ_UNKNOWN_CMD');
  assert.equal((await c.err('doc.info', { docId: 'zz' })).code, 'IJ_NO_DOC');
  console.log('analysis commands, new documents, TIFF round trip, preview: OK');
}

// ── 8. review fixes: ordering of reads, saved revision, durability, ghost sessions, worker start ─────────────
{
  const W = 512, H = 512;
  const r = rng(99);
  const big = Uint8Array.from({ length: W * H }, () => Math.floor(r() * 256));
  const origError = console.error;

  // (a) a read issued while an operation runs waits for it (stats, histogram, duplicate, export)
  {
    const c = client({ bandPixels: 1 << 16, sliceMs: 5 });
    const { id } = await c.makeDoc(W, H, [big]);
    const before = (await c.ok('doc.stats', { docId: id, roi: null })).row;
    const run = c.call('doc.run', { docId: id, op: 'gaussian', params: { sigma: 20 }, roi: null, channel: 0 });
    const st = c.call('doc.stats', { docId: id, roi: null });
    const hi = c.call('doc.histogram', { docId: id, roi: null });
    const ex = c.call('doc.exportTiff', { docId: id });
    const du = c.call('doc.duplicate', { docId: id });
    const [rr, ss, hh, ee, dd] = await Promise.all([run, st, hi, ex, du]);
    assert.ok(rr.ok && ss.ok && hh.ok && ee.ok && dd.ok);
    const after = (await c.ok('doc.stats', { docId: id, roi: null })).row;
    assert.ok(after.stdDev < before.stdDev / 3, 'the blur really lowered the spread');
    assert.equal(ss.result.row.stdDev, after.stdDev, 'a stats read queued behind the operation sees its result');
    assert.equal(ss.result.row.mean, after.mean);
    assert.equal(A(hh.result.counts).reduce((x, y) => x + y, 0), W * H);
    assert.equal(ee.result.rev, 1, 'the export is of the revision after the operation');
    const reopened = await c.ok('doc.open', { bytes: ee.result.bytes });
    assert.deepEqual(await c.pixels(reopened.docId), await c.pixels(id), 'TIFF export holds the operation');
    assert.deepEqual(await c.pixels(dd.result.docId), await c.pixels(id), 'duplicate holds the operation');
  }

  // (b) an opened TIFF keeps its name and is not unsaved; markSaved takes the revision that was exported
  {
    const c = client();
    const { id } = await c.makeDoc(40, 30, [blobImage(40, 30, 5)]);
    const ex = await c.ok('doc.exportTiff', { docId: id });
    const op = await c.ok('doc.open', { bytes: ex.bytes, name: 'piece' });
    assert.equal(op.info.name, 'piece');
    assert.equal(op.info.unsaved, false, 'a file just read is clean');
    await c.ok('doc.run', { docId: op.docId, op: 'invert', params: {}, roi: null, channel: 0 });
    assert.equal((await c.ok('doc.info', { docId: op.docId })).unsaved, true);
    // export at rev 0, an edit commits, then the file write ends: the edit is not saved
    assert.equal(ex.rev, 0);
    await c.ok('doc.run', { docId: id, op: 'invert', params: {}, roi: null, channel: 0 });
    const ms = await c.ok('doc.markSaved', { docId: id, rev: ex.rev });
    assert.equal(ms.unsaved, true);
    assert.equal((await c.ok('doc.info', { docId: id })).unsaved, true, 'the edit made after the export stays unsaved');
    assert.equal((await c.ok('doc.markSaved', { docId: id })).unsaved, false);
  }

  // (c) keep for later writes the last snapshot even when the journal had failed; flush says when it could not
  {
    const base = IJEngine.createMemoryStorage();
    let failJournal = false, failSnap = false;
    const quota = () => { const e = new Error('full'); e.name = 'QuotaExceededError'; return Promise.reject(e); };
    const flaky = Object.assign({}, base, {
      putJournal(k, e) { return failJournal ? quota() : base.putJournal(k, e); },
      putSnapshot(k, s) { return failSnap && s.kind === 'snapshot' ? quota() : base.putSnapshot(k, s); }
    });
    console.error = () => {};
    const key = 'ds1|keep|0';
    const a = client({ storage: flaky, retryMs: [3600000] });
    const img = blobImage(64, 48, 3);
    const { id } = await a.makeDoc(64, 48, [img], { sessionKey: key });
    failJournal = true;
    await a.ok('doc.run', { docId: id, op: 'invert', params: {}, roi: null, channel: 0 });
    await a.eng.whenIdle();
    assert.equal((await a.ok('doc.info', { docId: id })).protected, false);
    failJournal = false;
    const closed = await a.ok('doc.close', { docId: id });
    assert.equal(closed.ok, true); assert.equal(closed.kept, true);
    const b = client({ storage: base });
    await b.ok('session.restore', { key });
    assert.deepEqual(await b.pixels(id), A(img).map((v) => 255 - v), 'the close wrote the last state');

    // flush: refused write -> ok:false with the document listed; then healthy -> ok:true
    const c2 = client({ storage: flaky, retryMs: [3600000] });
    const d2 = await c2.makeDoc(64, 48, [img], { sessionKey: 'ds1|flush|0' });
    failJournal = true; failSnap = true;
    await c2.ok('doc.run', { docId: d2.id, op: 'invert', params: {}, roi: null, channel: 0 });
    const f1 = await c2.ok('flush', {});
    assert.equal(f1.ok, false); assert.deepEqual(P(f1.unsafe), [d2.id]);
    const stillOpen = await c2.ok('doc.close', { docId: d2.id });
    assert.equal(stillOpen.ok, false, 'a close that could not keep the work says so');
    assert.equal((await c2.ok('doc.list', {})).docs.length, 1, 'and the document stays in the engine (its retry still runs)');
    failJournal = false; failSnap = false;
    const f2 = await c2.ok('flush', {});
    assert.equal(f2.ok, true); assert.deepEqual(P(f2.unsafe), []);
    console.error = origError;
  }

  // (d) no ghost session: a failed baseline is not listed, then the retry stores it; putMeta alone creates nothing
  {
    const base = IJEngine.createMemoryStorage();
    let failBase = true;
    const flaky = Object.assign({}, base, {
      putSnapshot(k, s) { if (failBase && s.kind === 'baseline') { const e = new Error('full'); e.name = 'QuotaExceededError'; return Promise.reject(e); } return base.putSnapshot(k, s); }
    });
    console.error = () => {};
    const key = 'ds1|ghost|0';
    const a = client({ storage: flaky, retryMs: [25] });
    const img = blobImage(64, 48, 8);
    const { id } = await a.makeDoc(64, 48, [img], { sessionKey: key });
    await a.eng.whenIdle();
    assert.equal((await a.ok('session.list', {})).sessions.length, 0, 'baseline refused: nothing to resume');
    await a.ok('session.putMeta', { key, results: [{ Area: 1 }] });
    assert.equal((await a.ok('session.list', {})).sessions.length, 0, 'putMeta does not create a session');
    failBase = false;
    await sleep(150); await a.eng.whenIdle();
    const l = (await a.ok('session.list', {})).sessions;
    assert.equal(l.length, 1, 'the baseline write is retried');
    assert.equal(l[0].docs, 1);
    assert.equal((await a.ok('doc.info', { docId: id })).protected, true);
    console.error = origError;
  }

  // (e) a replay with a hole in the journal stops there and says so; the next commit does not collide
  {
    const base = IJEngine.createMemoryStorage();
    const key = 'ds1|gap|0';
    const a = client({ storage: base });
    const img = blobImage(64, 48, 12);
    const { id } = await a.makeDoc(64, 48, [img], { sessionKey: key });
    for (const v of [10, 20, 30]) await a.ok('doc.run', { docId: id, op: 'math', params: { op: 'add', value: v }, roi: null, channel: 0 });
    await a.eng.whenIdle(); a.eng.dispose();
    const holed = Object.assign({}, base, {
      async load(k, w) {
        const r = await base.load(k, w);
        for (const d of Object.values(r.docs)) d.journal = d.journal.filter((e) => e.seq !== 2);
        return r;
      }
    });
    console.error = () => {};
    const b = client({ storage: holed });
    const res = await b.ok('session.restore', { key });
    console.error = origError;
    assert.equal(res.warnings.length, 1);
    assert.equal(res.warnings[0].code, 'IJ_REPLAY_STOPPED'); assert.equal(res.warnings[0].seq, 3);
    assert.deepEqual(await b.pixels(id), A(img).map((v) => Math.min(255, v + 10)), 'only the contiguous part was replayed');
    await b.ok('doc.run', { docId: id, op: 'invert', params: {}, roi: null, channel: 0 });
    await b.eng.whenIdle();
    const seqs = (await base.load(key)).docs[id].journal.map((e) => e.seq);
    assert.equal(new Set(seqs).size, seqs.length, 'no seq collision');
    assert.equal(Math.max(...seqs), 4, 'the new entry starts after every stored one (seq 4, not 2)');
  }

  // (f) a snapshot captured before an unjournaled commit does not vouch for it
  {
    const base = IJEngine.createMemoryStorage();
    let failJournal = false;
    let release = null;
    const gate = new Promise((res) => { release = res; });
    let hold = false;
    const flaky = Object.assign({}, base, {
      putJournal(k, e) { if (failJournal) { const er = new Error('full'); er.name = 'QuotaExceededError'; return Promise.reject(er); } return base.putJournal(k, e); },
      async putSnapshot(k, s) { if (hold && s.kind === 'snapshot') await gate; return base.putSnapshot(k, s); }
    });
    console.error = () => {};
    const a = client({ storage: flaky, retryMs: [3600000] });
    const { id } = await a.makeDoc(64, 48, [blobImage(64, 48, 4)], { sessionKey: 'ds1|vouch|0' });
    failJournal = true;
    await a.ok('doc.run', { docId: id, op: 'invert', params: {}, roi: null, channel: 0 });
    await a.eng.whenIdle();
    hold = true;
    const fl = a.call('flush', {});                       // snapshot of rev 1, held
    await sleep(10);
    await a.ok('doc.run', { docId: id, op: 'invert', params: {}, roi: null, channel: 0 });   // rev 2, not journaled
    release();
    await fl;
    await a.eng.whenIdle();
    assert.equal((await a.ok('doc.info', { docId: id })).protected, false, 'the snapshot of rev 1 cannot vouch for rev 2');
    console.error = origError;
  }

  // (g) projection: the band the caller streams with decides the estimate, and the engine answers the band that fits
  {
    const c = client({ budgetBytes: 40 * 1048576 });
    const base = { name: 'p', method: 'median', width: 2000, height: 2000, depth: 50, channels: [{ name: 'a', color: '#ffffff' }] };
    const small = await c.ok('doc.project.begin', Object.assign({ docId: 'pa' }, base, { bandRows: 64 }));
    assert.equal(small.bandRows, 64);
    await c.ok('doc.close', { docId: 'pa' });
    const asked = await c.ok('doc.project.begin', Object.assign({ docId: 'pb' }, base, { bandRows: 2000 }));
    assert.ok(asked.bandRows < 2000 && asked.bandRows >= 8, 'a whole-height band does not fit: ' + asked.bandRows);
    assert.ok(asked.estimateBytes <= 40 * 1048576);
    assert.equal(asked.estimateBytes, sandbox.IJProject.estimateBytes({ method: 'median', width: 2000, height: 2000, depth: 50, channels: 1, bandRows: asked.bandRows }));
    await c.ok('doc.close', { docId: 'pb' });
    const huge = await c.err('doc.project.begin', Object.assign({ docId: 'pc' }, base, { width: 20000, height: 20000, depth: 50 }));
    assert.equal(huge.code, 'IJ_OVER_BUDGET');
  }

  // (h) a point measures X / Y as centroid columns; particles carry the image measurements of the analysed channel
  {
    const c = client();
    const m = new Uint8Array(64 * 48);
    const box = (x0, y0, w, h) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) m[y * 64 + x] = 255; };
    box(5, 5, 8, 6); box(30, 20, 10, 10);
    const { id } = await c.makeDoc(64, 48, [m], { calibration: { pixelWidth: 2, pixelHeight: 2, unit: 'µm' } });
    const pt = (await c.ok('doc.stats', { docId: id, roi: { type: 'point', points: [[7.5, 8.5]] } })).row;
    assert.equal(pt.xCentroid, 15); assert.equal(pt.yCentroid, 17); assert.equal(pt.mean, 255);
    const pa = await c.ok('doc.particles', { docId: id, channel: 0, opts: {} });
    assert.equal(pa.rows.length, 2);
    for (const row of pa.rows) {
      assert.equal(row.mean, 255); assert.equal(row.min, 255); assert.equal(row.max, 255);
      assert.equal(row.intDen, row.area * 255); assert.equal(row.rawIntDen, row.areaPx * 255);
    }
    assert.equal(pa.rows[0].areaPx, 48);
    const off = await c.ok('doc.particles', { docId: id, channel: 0, measureImage: false, opts: {} });
    assert.equal(off.rows[0].mean, undefined);
  }

  // (i) a worker whose engine did not start answers every request with an error instead of leaving it pending
  {
    const posted = [];
    const wk = { postMessage: (m) => posted.push(m), importScripts() { throw new Error('boom'); }, onmessage: null, console: { error() {} } };
    wk.self = wk;
    vm.createContext(wk);
    vm.runInContext(fs.readFileSync(path.join(DIR, 'ij-worker.js'), 'utf8'), wk, { filename: 'ij-worker.js' });
    wk.onmessage({ data: { init: { scripts: ['x.js'], budgetBytes: 1 } } });
    assert.deepEqual(P(posted[0]), { event: 'initError', code: 'IJ_WORKER_INIT' });
    wk.onmessage({ data: { id: 7, cmd: 'session.list', args: {} } });
    assert.equal(posted[1].id, 7); assert.equal(posted[1].ok, false); assert.equal(posted[1].error.code, 'IJ_WORKER_INIT');
    // and the engine answers a ping for the page's watchdog
    const c = client();
    assert.ok((await c.ok('ping', {})).at > 0);
  }
  console.log('review fixes: ordered reads, revisions, durability, ghost sessions, replay gaps, bands, particles, worker init: OK');
}

for (const f of closers) f();
console.log('ij engine: OK');
process.exit(0);
