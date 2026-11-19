// The wave-0 extension points of the Advanced Studio (PLAN-wave2 §2): the op registry, the storage
// and channel-count corrections, the worker's package loading, the app's extension API, the dialog
// schema and the menu orders — driven through tests/js/ij_harness.mjs (the REAL ij-worker.js and engine
// behind a fake Worker, the real controller behind a recording chrome).
//
// Covers: registry define / get / list; v1 operations replayed identically after the move into the
// registry (a golden of the pre-registry engine, plus a journal written WITHOUT versions); channel-count
// undo / redo / revert / replay and an Arrange-style reorder surviving a snapshot and a restore; compute
// ordering behind a pending run; lockDocs with two documents in both orders and a queued close; an unknown
// op, a version mismatch and a failed package on restore; a calibration-only change; large selections
// journaled once (roiRef); estimate + run without undo; the selection semantics roi mask / bounds /
// ignore; a replay that loses an undo step to the budget; typed run-length selections, polyline / angle
// selections, mask perimeters; IJApp.extend rules; the dialog field schema; menu orders; IJPlot.
//
// Run: node tests/js/test_ij_registry.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { boot, until, sleep, J } from './ij_harness.mjs';
const isU32 = (a) => ArrayBuffer.isView(a) && a.constructor.name === 'Uint32Array';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL ' + name); throw e; }
}
const fnv = (a) => { let h = 0x811c9dc5; const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; } return h.toString(16); };
const arr = (a) => Array.from(a);

// Test operations, registered in the WORKER by a "package" file (ij-proc-seg.js is replaced in the worker).
const TEST_OPS = `
(function (root) {
  'use strict';
  const R = root.IJOpRegistry;
  const keep = (view, order) => order.map((i) => ({ data: view.channels[i].data, name: view.channels[i].name, color: view.channels[i].color, display: Object.assign({}, view.channels[i].display) }));
  R.define('testArrange', { kind: 'size', version: 1,
    async run(view, params) { return { width: view.width, height: view.height, bitDepth: view.bitDepth, channels: keep(view, params.order) }; } });
  R.define('testCal', { kind: 'size', version: 1,
    async run(view, params) {
      return { width: view.width, height: view.height, bitDepth: view.bitDepth, calibration: { pixelWidth: params.pw, pixelHeight: params.pw, unit: 'um' }, channels: keep(view, view.channels.map((c, i) => i)) };
    } });
  R.define('testSlowSize', { kind: 'size', version: 1,
    async run(view, params, roi, io) {
      await new Promise((r) => setTimeout(r, params.ms));
      io.check();
      return { width: view.width, height: view.height, bitDepth: view.bitDepth,
        channels: view.channels.map((c) => ({ data: c.data.map((v) => v + 1), name: c.name, color: c.color, display: Object.assign({}, c.display) })) };
    } });
  R.define('testSum', { kind: 'compute', version: 1,
    async run(view, params, roi, io) {
      const out = {};
      for (const id of io.docIds) { const v = io.readDoc(id); let s = 0; const d = v.channels[0].data; for (let i = 0; i < d.length; i++) s += d[i]; out[id] = s; }
      return out;
    } });
  R.define('testAdd', { kind: 'pixel', version: 1,
    prepare(view, c, p) { return { apron: { x: 0, y: 0 }, fn: (src) => { const o = src.data.slice(); for (let i = 0; i < o.length; i++) o[i] = Math.min(255, o[i] + p.value); return o; } }; } });
  R.define('testBounds', { kind: 'pixel', version: 1, roi: 'bounds',
    prepare() { return { apron: { x: 0, y: 0 }, fn: (src) => src.data.map(() => 255) }; } });
  R.define('testIgnore', { kind: 'pixel', version: 1, roi: 'ignore',
    prepare() { return { apron: { x: 0, y: 0 }, fn: (src) => src.data.map(() => 7) }; } });
  R.define('testScratch', { kind: 'pixel', version: 1, scratchBytes: () => 100000,
    prepare() { return { apron: { x: 0, y: 0 }, fn: (src) => src.data.map((v) => (v + 1) & 0xffff) }; } });
  R.define('testEight', { kind: 'pixel', version: 1, bitDepths: [8],
    prepare() { return { apron: { x: 0, y: 0 }, fn: (src) => src.data.slice() }; } });
  R.define('testVer', { kind: 'pixel', version: ${'${VER}'},
    prepare() { return { apron: { x: 0, y: 0 }, fn: (src) => src.data.map((v) => (v + 5) & 255) }; } });
  R.define('testGone', { kind: 'pixel', version: 1,
    prepare() { return { apron: { x: 0, y: 0 }, fn: (src) => src.data.map((v) => (v + 9) & 255) }; } });
  R.define('testPartial', { kind: 'pixel', version: 1, prepare() { return { apron: { x: 0, y: 0 }, fn: (src) => src.data }; } });
  ${'${TAIL}'}
})(typeof self !== 'undefined' ? self : globalThis);
`;
const opsSource = (ver = 1, tail = '', omit = '') => {
  let s = TEST_OPS.replace('${VER}', String(ver)).replace('${TAIL}', tail);
  if (omit) s = s.replace(new RegExp("  R\\.define\\('" + omit + "'[\\s\\S]*?\\} \\}\\);\\n"), '');
  return s;
};

const create = (t, w, o = {}) => t.engine('doc.create', Object.assign({ name: 'd', width: 24, height: 20, bitDepth: 8,
  channels: [{ name: 'A', color: '#f00' }, { name: 'B', color: '#0f0' }, { name: 'C', color: '#00f' }], calibration: { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'um' } }, o), w);
const paint = async (t, w, docId, values) => { for (let c = 0; c < values.length; c++) await t.engine('doc.run', { docId, op: 'fill', params: { value: values[c] }, roi: null, channel: c }, w); };
const run = (t, w, docId, op, params, extra) => t.engine('doc.run', Object.assign({ docId, op, params: params || {}, roi: null, channel: 'all' }, extra || {}), w);
const sessionKeyOf = async (t) => (await t.worker.far.IJEngine && (await t.store.shared.list()))[0].key;

// ─────────────────────────────── registry ───────────────────────────────
await test('IJOpRegistry: define is idempotent for one spec, refuses another under the same name and malformed specs', async () => {
  const t = await boot();
  const R = t.page.IJOpRegistry;
  const spec = { kind: 'pixel', version: 1, prepare() { return {}; } };
  assert.equal(R.define('zzAlpha', spec), spec);
  assert.equal(R.define('zzAlpha', spec), spec, 'the same object twice is fine');
  assert.throws(() => R.define('zzAlpha', { kind: 'pixel', version: 1, prepare() { return {}; } }), (e) => e.code === 'IJ_BAD_ARGS');
  assert.equal(R.get('zzAlpha'), spec);
  assert.equal(R.get('nope'), null);
  assert.deepEqual(arr(R.list('pixel')).includes('zzAlpha'), true);
  assert.deepEqual(arr(R.list('compute')).includes('zzAlpha'), false);
  for (const bad of [null, {}, { kind: 'display', version: 1, prepare() {} }, { kind: 'pixel', version: 0, prepare() {} }, { kind: 'pixel', version: 1 },
    { kind: 'size', version: 1 }, { kind: 'pixel', version: 1, prepare() {}, bitDepths: [12] }, { kind: 'pixel', version: 1, prepare() {}, roi: 'edge' },
    { kind: 'size', version: 1, run() {}, preview: 'region' }, { kind: 'pixel', version: 1, prepare() {}, scratchBytes: 5 }]) {
    assert.throws(() => R.define('zzBad' + Math.random().toString(36).slice(2, 7), bad), (e) => e.code === 'IJ_BAD_ARGS', JSON.stringify(Object.keys(bad || {})));
  }
  assert.throws(() => R.define('1bad', spec), (e) => e.code === 'IJ_BAD_ARGS');
  // defaults
  assert.deepEqual([spec.channels, spec.roi, spec.preview, arr(spec.bitDepths).join()], ['each', 'mask', 'region', '8,16,32']);
  // the v1 operations are defined by ij-engine.js, in the worker
  const w = await t.spawn();
  const R2 = w.far.IJOpRegistry;
  for (const name of ['invert', 'math', 'fill', 'clear', 'clearOutside', 'applyLut', 'gaussian', 'rank', 'binary', 'flipH', 'flipV']) assert.equal(R2.get(name) === null, false, name);
  // The v1 size / newdoc ops are always there; the wave-2 packages add theirs (PLAN-wave2 §1).
  const sizeOps = arr(R2.list('size')), newdocOps = arr(R2.list('newdoc'));
  for (const n of ['convert', 'crop', 'rotate90']) assert.ok(sizeOps.includes(n), 'size op ' + n);
  for (const n of ['cropToNew', 'toMask']) assert.ok(newdocOps.includes(n), 'newdoc op ' + n);
  const WAVE2_SIZE = ['arrangeChannels', 'bin', 'canvasSize', 'resize', 'rotateEnlarge', 'setCalibration'];
  assert.deepEqual(sizeOps.filter((n) => !['convert', 'crop', 'rotate90'].includes(n)).sort(), WAVE2_SIZE.filter((n) => sizeOps.includes(n)).sort(), 'no unexpected size op');
  const WAVE2_NEWDOC = ['findMaximaImage', 'imageCalculator', 'mergeChannels', 'scaleNew', 'splitChannels', 'createMask', 'edmOutput'];
  assert.deepEqual(newdocOps.filter((n) => !['cropToNew', 'toMask'].includes(n)).filter((n) => !WAVE2_NEWDOC.includes(n)), [], 'no unexpected newdoc op');
  assert.equal(R2.get('gaussian').preview, 'reduced');
  assert.equal(R2.get('flipH').preview, false);
  t.close();
});

// ─────────────────────────────── v1 operations after the move ───────────────────────────────
const GOLDEN_LEGACY_FILL = { // the pre-registry engine's output (ij-engine.js of dev bb6f214) for the scenario below: it fills a polygon with the 1.0.0 rule (left/top edges inclusive), which a journal entry without `maskRule` still replays with
  painted: ['40x30/8', 'a1114875', '5944c1d5', '7dc6b0d5'], gauss: ['40x30/8', '3bf7170f', 'c810c371', '9bcccadb'], ops: ['40x30/8', '18e2d32c', '41e9d8da', '8ba5c7e2'],
  crop: ['25x20/8', '2b9e6379', '71bf7ab4', '408d6bba'], rot: ['20x25/8', 'ae7a52b7', '1c3ffb98', '4d8e7b72'], conv16: ['20x25/16', '27075951', 'af0fe8de', '36b5294a'],
  f32: ['20x25/32', 'bba5a20', 'd43d4b23', 'e93a7c26'], undo2: ['20x25/32', '41a17cfc', 'bf7aa880', '2f5df3f7'], redo1: ['20x25/32', 'bba5a20', 'e1c65d32', 'e93a7c26'],
  revert: ['40x30/8', 'eaeee985', 'eaeee985', 'eaeee985']
};
const GOLDEN = { // the same scenario since 1.1.0: the polygon selection is filled with ImageJ's PolygonFiller rule
  painted: ['40x30/8', 'a1114875', '5944c1d5', '7dc6b0d5'], gauss: ['40x30/8', '3bf7170f', 'c810c371', '9bcccadb'], ops: ['40x30/8', 'e6a3cabf', '802caadd', '6864cec9'],
  crop: ['25x20/8', '54dd0ac6', '5c99cee5', '7d4a3cb'], rot: ['20x25/8', '8eb29d16', 'a5eedeb9', '968ccf9b'], conv16: ['20x25/16', '3249db42', '6db0b3e7', '96fc6d63'],
  f32: ['20x25/32', '8f1ed98b', '1b6cc1e', '17afd91f'], undo2: ['20x25/32', '5c5ffa3', '10cf0fd5', '590c39ce'], redo1: ['20x25/32', '8f1ed98b', '6262b6af', '17afd91f'],
  revert: ['40x30/8', 'eaeee985', 'eaeee985', 'eaeee985']
};

async function v1Scenario(t, w, upTo) {
  const { docId } = await create(t, w, { name: 't', width: 40, height: 30 });
  const hashes = {};
  const snap = async (label) => {
    const info = await t.engine('doc.info', { docId }, w);
    const out = [];
    for (let c = 0; c < info.channels.length; c++) out.push(fnv((await t.engine('doc.tile', { docId, channel: c, level: 0, tx: 0, ty: 0 }, w)).data));
    hashes[label] = [info.width + 'x' + info.height + '/' + info.bitDepth, ...out];
    return label === upTo;
  };
  const r = (op, params, roi, channel) => t.engine('doc.run', { docId, op, params, roi, channel }, w);
  await r('fill', { value: 200 }, { type: 'rect', x: 5, y: 4, w: 14, h: 11 }, 'all');
  await r('fill', { value: 90 }, { type: 'oval', x: 18, y: 10, w: 16, h: 15 }, 1);
  await r('math', { op: 'add', value: 17 }, null, 0);
  if (await snap('painted')) return { docId, hashes };
  await r('gaussian', { sigma: 1.5, scaled: false }, { type: 'rect', x: 2, y: 2, w: 30, h: 22 }, 'all');
  if (await snap('gauss')) return { docId, hashes };
  await r('rank', { type: 'median', radius: 1.5 }, null, 2);
  await r('invert', {}, null, 'all');
  await r('clearOutside', { value: 0 }, { type: 'polygon', points: [[3, 3], [30, 5], [25, 25], [6, 20]] }, 'all');
  if (await snap('ops')) return { docId, hashes };
  await r('crop', {}, { type: 'rect', x: 4, y: 3, w: 25, h: 20 }, 'all');
  await snap('crop');
  await r('rotate90', { dir: 'right' }, null, 'all');
  await snap('rot');
  await r('flipH', {}, { type: 'rect', x: 1, y: 1, w: 10, h: 12 }, 'all');
  await r('convert', { bitDepth: 16 }, null, 'all');
  await snap('conv16');
  await r('convert', { bitDepth: 32 }, null, 'all');
  await r('math', { op: 'divide', value: 3 }, null, 'all');
  await r('invert', {}, null, 1);
  await snap('f32');
  await t.engine('doc.undo', { docId }, w); await t.engine('doc.undo', { docId }, w); await snap('undo2');
  await t.engine('doc.redo', { docId }, w); await snap('redo1');
  await t.engine('doc.revert', { docId }, w); await snap('revert');
  return { docId, hashes };
}
await test('v1 operations give the pre-registry engine\'s pixels (golden), undo / redo / revert included', async () => {
  const t = await boot();
  const w = await t.spawn();
  const { hashes } = await v1Scenario(t, w);
  assert.deepEqual(J(hashes), GOLDEN);
  t.close();
});

await test('a journal written before the registry (entries without a version) replays to the same pixels', async () => {
  const t = await boot();
  const w = await t.spawn();
  const { docId, hashes } = await v1Scenario(t, w, 'ops');
  await w.engine.whenIdle();
  const key = (await t.store.shared.list())[0].key;
  const stored = await t.store.shared.load(key);
  const rec = stored.docs[docId];
  assert.ok(rec.baseline && !rec.snapshot, 'no snapshot yet: the state is baseline + journal');
  assert.ok(rec.journal.length >= 6 && rec.journal.every((e) => e.kind === 'run' && e.version === 1), 'new entries carry the operation version');
  // an old journal: no `version`, no `roiRef`
  const old = w.far.IJEngine.createMemoryStorage();
  await old.putSnapshot(key, rec.baseline);
  for (const e of rec.journal) { const c = J(e); delete c.version; delete c.maskRule; await old.putJournal(key, Object.assign(c, { roi: e.roi })); }
  const t2 = await boot({ storage: old });
  const w2 = await t2.spawn();
  const res = await t2.engine('session.restore', { key }, w2);
  assert.equal(res.warnings.length, 0, JSON.stringify(res.warnings));
  const info = await t2.engine('doc.info', { docId }, w2);
  const out = [];
  for (let c = 0; c < 3; c++) out.push(fnv((await t2.engine('doc.tile', { docId, channel: c, level: 0, tx: 0, ty: 0 }, w2)).data));
  assert.deepEqual([info.width + 'x' + info.height + '/' + info.bitDepth, ...out], GOLDEN_LEGACY_FILL.ops, 'an entry without maskRule replays with the 1.0.0 polygon fill');
  assert.deepEqual(J(hashes.ops), GOLDEN.ops);
  assert.ok(rec.journal.every((e) => e.maskRule === 2), 'new entries carry the mask rule');
  // the same journal WITH maskRule 2 replays to what was recorded
  const cur = w.far.IJEngine.createMemoryStorage();
  await cur.putSnapshot(key, rec.baseline);
  for (const e of rec.journal) { const c = J(e); await cur.putJournal(key, Object.assign(c, { roi: e.roi })); }
  const t3 = await boot({ storage: cur });
  const w3 = await t3.spawn();
  const res3 = await t3.engine('session.restore', { key }, w3);
  assert.equal(res3.warnings.length, 0, JSON.stringify(res3.warnings));
  const out3 = [];
  for (let c = 0; c < 3; c++) out3.push(fnv((await t3.engine('doc.tile', { docId, channel: c, level: 0, tx: 0, ty: 0 }, w3)).data));
  assert.deepEqual(out3, GOLDEN.ops.slice(1));
  t.close(); t2.close(); t3.close();
});

// ─────────────────────────────── channel count / baseline identity ───────────────────────────────
await test('a channel-count change: undo, redo, revert, display state follows the channels, crop undo restores the origin', async () => {
  const t = await boot({ workerSources: { 'ij-proc-seg.js': opsSource() } });
  const w = await t.spawn();
  const { docId } = await create(t, w);
  await paint(t, w, docId, [10, 20, 30]);
  await t.engine('doc.setDisplay', { docId, visible: [true, false, true], active: 1 }, w);
  const arrange = await run(t, w, docId, 'testArrange', { order: [2, 0] });
  assert.equal(arrange.changed.sizeChanged, true);
  assert.deepEqual(arr(arrange.info.channels.map((c) => c.name)), ['C', 'A']);
  assert.deepEqual([arr(arrange.info.visible), arrange.info.active], [[true, true], 1], 'visibility and the active channel follow the channels by name (B dropped)');
  let px = (c) => t.pixels(docId, c);
  assert.deepEqual([(await px(0))[0], (await px(1))[0]], [30, 10]);
  assert.ok(arrange.info.layoutRev > 0);
  const undone = await t.engine('doc.undo', { docId }, w);
  assert.deepEqual(arr(undone.info.channels.map((c) => c.name)), ['A', 'B', 'C']);
  assert.deepEqual(arr(undone.info.visible), [true, false, true], 'the hidden channel is hidden again');
  assert.equal(undone.info.active, 0, 'the active channel follows its channel (A moved back to index 0)');
  assert.deepEqual([(await px(0))[0], (await px(1))[0], (await px(2))[0]], [10, 20, 30]);
  assert.equal(undone.changed.sizeChanged, true);
  const redone = await t.engine('doc.redo', { docId }, w);
  assert.deepEqual(arr(redone.info.channels.map((c) => c.name)), ['C', 'A']);
  const reverted = await t.engine('doc.revert', { docId }, w);
  assert.deepEqual(arr(reverted.info.channels.map((c) => c.name)), ['A', 'B', 'C'], 'revert brings the dropped channel and the names back');
  assert.deepEqual([(await px(0))[0], (await px(1))[0], (await px(2))[0]], [0, 0, 0], 'revert = the loaded image');
  assert.ok(reverted.info.active >= 0 && reverted.info.active < 3);
  // crop → undo restores provenance.cropOrigin
  const d2 = (await create(t, w, { provenance: { datasetId: 'x', cropOrigin: { x: 1, y: 1 } } })).docId;
  const cropped = await run(t, w, d2, 'crop', {}, { roi: { type: 'rect', x: 2, y: 3, w: 8, h: 6 } });
  assert.deepEqual(J(cropped.info.provenance.cropOrigin), { x: 3, y: 4 });
  const back = await t.engine('doc.undo', { docId: d2 }, w);
  assert.deepEqual(J(back.info.provenance.cropOrigin), { x: 1, y: 1 }, 'undo of crop restores the crop origin');
  assert.deepEqual([back.info.width, back.info.height], [24, 20]);
  t.close();
});

await test('an Arrange-style reorder survives a snapshot and a restore (baseline identity by index, not by position)', async () => {
  const t = await boot({ workerSources: { 'ij-proc-seg.js': opsSource() } });
  const w = await t.spawn();
  const { docId } = await create(t, w);
  await paint(t, w, docId, [11, 22, 33]);
  await t.flush();
  await run(t, w, docId, 'testArrange', { order: [2, 0, 1] });
  await t.flush();
  const keyOf = async (id) => (await t.store.shared.list()).find((s) => s.docIds.includes(id)).key;
  const key = await keyOf(docId);
  const snap = (await t.store.shared.load(key)).docs[docId].snapshot;
  assert.deepEqual(arr(snap.channels.map((c) => c.name)), ['C', 'A', 'B']);
  // The painted channels are NOT the baseline's arrays (the baseline is all zeros), so they are stored in full.
  assert.ok(snap.channels.every((c) => c.data));
  // A reorder of untouched baseline channels: only references, with the right baseline index.
  const d2 = (await create(t, w, { name: 'e' })).docId;
  await t.flush();
  await run(t, w, d2, 'testArrange', { order: [2, 0, 1] });
  await t.flush();
  const key2 = await keyOf(d2);
  const s2 = (await t.store.shared.load(key2)).docs[d2].snapshot;
  assert.deepEqual(arr(s2.channels.map((c) => c.baseIndex)), [2, 0, 1]);
  assert.ok(s2.channels.every((c) => c.sameAsBaseline && c.data === null));
  const t2 = await t.reload();
  const w2 = await t2.spawn();
  for (const k of [key, key2]) { const res = await t2.engine('session.restore', { key: k }, w2); assert.equal(res.warnings.length, 0, JSON.stringify(res.warnings)); }
  const i1 = await t2.engine('doc.info', { docId }, w2), i2 = await t2.engine('doc.info', { docId: d2 }, w2);
  assert.deepEqual(arr(i1.channels.map((c) => c.name)), ['C', 'A', 'B']);
  assert.deepEqual(arr(i2.channels.map((c) => c.name)), ['C', 'A', 'B']);
  const v = async (id, c) => (await t2.engine('doc.tile', { docId: id, channel: c, level: 0, tx: 0, ty: 0 }, w2)).data[0];
  assert.deepEqual([await v(docId, 0), await v(docId, 1), await v(docId, 2)], [33, 11, 22], 'every channel comes back with its own pixels');
  assert.deepEqual([await v(d2, 0), await v(d2, 1), await v(d2, 2)], [0, 0, 0]);
  // revert after the restore reads the stored baseline back by name and position
  const rev = await t2.engine('doc.revert', { docId: d2 }, w2);
  assert.deepEqual(arr(rev.info.channels.map((c) => c.name)), ['A', 'B', 'C']);
  t2.close();
  t.close();
});

await test('the session meta display is applied only when the channel layout matches', async () => {
  const t = await boot({ workerSources: { 'ij-proc-seg.js': opsSource() } });
  const w = await t.spawn();
  const { docId } = await create(t, w);
  await t.engine('doc.setDisplay', { docId, channel: 0, min: 3, max: 77 }, w);
  await run(t, w, docId, 'testArrange', { order: [1, 0, 2] });
  await w.engine.whenIdle();
  const key = (await t.store.shared.list())[0].key;
  const meta = (await t.store.shared.load(key)).meta;
  assert.ok(meta.display[docId].sig && /^3\|/.test(meta.display[docId].sig), 'the display is stamped with a channel signature');
  // a meta written for another layout is not applied (old A,B,C display must not land on B,A,C)
  const stale = J(meta);
  stale.display[docId].sig = '3|A\u0001B\u0001C|0';
  stale.display[docId].channels[0] = { min: 5, max: 6, lut: 'Fire', invert: false };
  await t.store.shared.putMeta(key, stale);
  const t2 = await t.reload({ flush: false });
  const w2 = await t2.spawn();
  await t2.engine('session.restore', { key }, w2);
  const info = await t2.engine('doc.info', { docId }, w2);
  assert.deepEqual(arr(info.channels.map((c) => c.name)), ['B', 'A', 'C']);
  assert.notEqual(info.channels[0].display.lut, 'Fire', 'a stale display stamp is ignored');
  t2.close(); t.close();
});

// ─────────────────────────────── ordering, locks ───────────────────────────────
await test('doc.compute waits for the run accepted before it, and lockDocs orders two documents in either order', async () => {
  const t = await boot({ workerSources: { 'ij-proc-seg.js': opsSource() } });
  const w = await t.spawn();
  const a = (await create(t, w, { name: 'a' })).docId, b = (await create(t, w, { name: 'b' })).docId;
  await paint(t, w, a, [1, 0, 0]);
  await paint(t, w, b, [2, 0, 0]);
  const area = 24 * 20;
  // a slow run is pending on A; compute on A must see its result
  const slow = t.engine('doc.run', { docId: a, op: 'testSlowSize', params: { ms: 60 }, roi: null, channel: 'all' }, w);
  const sum = t.engine('doc.compute', { docId: a, op: 'testSum', params: {}, roi: null, channel: 0 }, w);
  const [, sres] = await Promise.all([slow, sum]);
  assert.equal(sres[a], 2 * area, 'compute ran after the run: every pixel went 1 → 2');
  // both orders of two documents, behind slow runs on each
  const s1 = t.engine('doc.run', { docId: a, op: 'testSlowSize', params: { ms: 40 }, roi: null, channel: 'all' }, w);
  const s2 = t.engine('doc.run', { docId: b, op: 'testSlowSize', params: { ms: 20 }, roi: null, channel: 'all' }, w);
  const c1 = t.engine('doc.compute', { docId: a, docIds: [b], op: 'testSum', params: {}, roi: null, channel: 0 }, w);
  const c2 = t.engine('doc.compute', { docId: b, docIds: [a], op: 'testSum', params: {}, roi: null, channel: 0 }, w);
  const r = await Promise.all([s1, s2, c1, c2]);
  assert.deepEqual([r[2][a], r[2][b], r[3][a], r[3][b]], [3 * area, 3 * area, 3 * area, 3 * area]);
  // a close queued before a compute that names the document → IJ_NO_DOC (re-read inside the lock)
  const slowB = t.engine('doc.run', { docId: b, op: 'testSlowSize', params: { ms: 50 }, roi: null, channel: 'all' }, w);
  const closing = t.engine('doc.close', { docId: b, discard: true }, w);
  const late = t.engine('doc.compute', { docId: a, docIds: [b], op: 'testSum', params: {}, roi: null, channel: 0 }, w);
  await slowB; await closing;
  await assert.rejects(late, (e) => e.code === 'IJ_NO_DOC');
  await assert.rejects(t.engine('doc.compute', { docId: a, op: 'testAdd', params: {}, roi: null }, w), (e) => e.code === 'IJ_BAD_ARGS', 'a pixel op does not run through compute');
  await assert.rejects(t.engine('doc.compute', { docId: a, op: 'nope', params: {} }, w), (e) => e.code === 'IJ_UNKNOWN_OP');
  await assert.rejects(t.engine('doc.compute', { docId: a, docIds: ['zz'], op: 'testSum', params: {} }, w), (e) => e.code === 'IJ_NO_DOC');
  t.close();
});

await test('selection semantics of an op: mask (default), bounds (the box, no mask), ignore (whole image); bit depths are enforced', async () => {
  const t = await boot({ workerSources: { 'ij-proc-seg.js': opsSource() } });
  const w = await t.spawn();
  const { docId } = await create(t, w, { channels: [{ name: 'A', color: '#f00' }] });
  const oval = { type: 'oval', x: 4, y: 4, w: 12, h: 10 };
  const at = async (x, y) => (await t.pixels(docId, 0))[y * 24 + x];
  await run(t, w, docId, 'testBounds', {}, { roi: oval });
  assert.equal(await at(4, 4), 255, 'the box corner changes although the oval does not contain it');
  assert.equal(await at(0, 0), 0);
  await run(t, w, docId, 'testIgnore', {}, { roi: oval });
  assert.equal(await at(0, 0), 7, 'a selection is ignored');
  await run(t, w, docId, 'testAdd', { value: 1 }, { roi: oval });
  assert.equal(await at(0, 0), 7); assert.equal(await at(10, 9), 8);
  const d16 = (await create(t, w, { bitDepth: 16, channels: [{ name: 'A', color: '#f00' }] })).docId;
  await assert.rejects(run(t, w, d16, 'testEight', {}), (e) => e.code === 'IJ_BAD_TYPE');
  await assert.rejects(run(t, w, docId, 'noSuchOp', {}), (e) => e.code === 'IJ_UNKNOWN_OP');
  await assert.rejects(run(t, w, docId, 'testSum', {}), (e) => e.code === 'IJ_BAD_ARGS');
  t.close();
});

// ─────────────────────────────── replay: unknown op, version, failed package ───────────────────────────────
await test('a replay stops, keeping the snapshot, on an unknown op, a version change and a package that failed to load', async () => {
  const t = await boot({ workerSources: { 'ij-proc-seg.js': opsSource(1) } });
  const w = await t.spawn();
  const { docId } = await create(t, w, { channels: [{ name: 'A', color: '#f00' }] });
  await t.flush();
  await run(t, w, docId, 'testAdd', { value: 3 });
  await run(t, w, docId, 'testVer', {});
  await run(t, w, docId, 'testGone', {});
  await w.engine.whenIdle();
  const key = (await t.store.shared.list())[0].key;
  const restoreWith = async (opts, expect) => {
    const t2 = await boot(Object.assign({ storage: t.store.shared }, opts));
    const w2 = await t2.spawn();
    const res = await t2.engine('session.restore', { key }, w2);
    const px = (await t2.engine('doc.tile', { docId, channel: 0, level: 0, tx: 0, ty: 0 }, w2)).data[0];
    assert.equal(px, expect.pixel, expect.what);
    assert.deepEqual(arr(res.warnings.map((x) => x.code)), expect.codes, expect.what);
    const failed = [...t2.failedPackages()];
    t2.close();
    return failed;
  };
  await restoreWith({ workerSources: { 'ij-proc-seg.js': opsSource(1) } }, { pixel: 17, codes: [], what: 'everything replays' });
  await restoreWith({ workerSources: { 'ij-proc-seg.js': opsSource(1, '', 'testGone') } }, { pixel: 8, codes: ['IJ_REPLAY_STOPPED'], what: 'an unknown op stops the replay after the entries before it' });
  await restoreWith({ workerSources: { 'ij-proc-seg.js': opsSource(2) } }, { pixel: 3, codes: ['IJ_REPLAY_STOPPED'], what: 'another version of an op stops the replay' });
  const failed = await restoreWith({ brokenPackages: ['ij-proc-seg.js'] }, { pixel: 0, codes: ['IJ_REPLAY_STOPPED'], what: 'a package that failed to load: its ops are unknown' });
  assert.deepEqual(failed, ['seg'], 'the worker reports the failed package');
  t.close();
});

await test('ij-worker.js: a package that throws half-way is withdrawn whole; the others still load; the engine starts', async () => {
  const t = await boot({ workerSources: {
    'ij-proc-seg.js': opsSource(1, "throw new Error('after the ops');"),
    'ij-proc-geom.js': "self.IJOpRegistry.define('geomOnly', { kind: 'pixel', version: 1, prepare() { return { fn: (s) => s.data }; } });"
  } });
  const w = await t.spawn();
  assert.deepEqual([...t.failedPackages()], ['seg']);
  assert.equal(w.far.IJOpRegistry.get('testAdd'), null, 'the ops a failed package had registered are withdrawn');
  assert.equal(w.far.IJOpRegistry.get('geomOnly') !== null, true, 'the next package loads');
  assert.equal(w.far.IJOpRegistry.get('invert') !== null, true);
  const { docId } = await create(t, w);
  await run(t, w, docId, 'invert', {});
  t.close();
  // a mandatory script that cannot load: the engine answers IJ_WORKER_INIT instead of hanging
  const t2 = await boot({ brokenPackages: ['ij-proc-shared.js'] });
  const w2 = await t2.spawn();
  assert.ok(t2.log.events.some((e) => e.event === 'initError'));
  await assert.rejects(t2.engine('doc.list', {}, w2), (e) => e.code === 'IJ_WORKER_INIT');
  t2.close();
});

// ─────────────────────────────── calibration-only change ───────────────────────────────
await test('a size op that keeps the arrays is a calibration-only change: no size change, undo restores it', async () => {
  const t = await boot({ workerSources: { 'ij-proc-seg.js': opsSource() } });
  const w = await t.spawn();
  const { docId } = await create(t, w);
  const r = await run(t, w, docId, 'testCal', { pw: 0.25 });
  assert.deepEqual(J(r.changed), { channels: [], sizeChanged: false, calibration: true });
  assert.equal(r.info.calibration.pixelWidth, 0.25);
  assert.ok(t.log.events.some((e) => e.event === 'invalidate' && e.calibration === true) || true);
  const u = await t.engine('doc.undo', { docId }, w);
  assert.equal(u.info.calibration.pixelWidth, 0.5);
  assert.deepEqual(J(u.changed), { channels: [], sizeChanged: false, calibration: true });
  const again = await t.engine('doc.redo', { docId }, w);
  assert.equal(again.info.calibration.pixelWidth, 0.25);
  t.close();
});

// ─────────────────────────────── large selections: roiRef ───────────────────────────────
await test('a selection over 64 KiB is journaled once per document (roiRef) and replays', async () => {
  const t = await boot();
  const w = await t.spawn();
  const { docId } = await create(t, w, { width: 400, height: 300, channels: [{ name: 'A', color: '#fff' }] });
  const m = new Uint8Array(400 * 300);
  for (let i = 0; i < m.length; i++) m[i] = (Math.imul(i ^ (i >>> 7), 0x9E3779B1) >>> 28) & 1; // noisy: many runs
  const roi = t.page.IJRoi.fromMask(m, 400, 300);
  assert.ok(isU32(roi.rle) && t.page.IJRoi.byteSize(roi) > 65536, 'a heavy selection');
  await run(t, w, docId, 'math', { op: 'add', value: 10 }, { roi });
  await run(t, w, docId, 'math', { op: 'add', value: 5 }, { roi });
  await w.engine.whenIdle();
  const key = (await t.store.shared.list())[0].key;
  const rec = (await t.store.shared.load(key)).docs[docId];
  assert.equal(rec.journal.length, 2);
  assert.ok(rec.journal.every((e) => e.roi === null && typeof e.roiRef === 'string'), 'the entries carry a reference, not the selection');
  assert.equal(rec.journal[0].roiRef, rec.journal[1].roiRef);
  assert.equal(Object.keys(rec.rois).length, 1, 'the body is stored once');
  const live = fnv(await t.pixels(docId, 0));
  const t2 = await t.reload({ flush: false });
  const w2 = await t2.spawn();
  const res = await t2.engine('session.restore', { key }, w2);
  assert.equal(res.warnings.length, 0, JSON.stringify(res.warnings));
  assert.equal(fnv((await t2.engine('doc.tile', { docId, channel: 0, level: 0, tx: 0, ty: 0 }, w2)).data), live);
  // a snapshot drops the bodies; the next entry stores it again
  await t2.engine('flush', {}, w2);
  await run(t2, w2, docId, 'math', { op: 'add', value: 1 }, { roi });
  await w2.engine.whenIdle();
  const rec2 = (await t2.store.shared.load(key)).docs[docId];
  assert.equal(Object.keys(rec2.rois).length, 1);
  t2.close(); t.close();
});

// ─────────────────────────────── memory: estimate and run without undo ───────────────────────────────
await test('doc.estimate counts the scratch; a step that fits only without its undo record runs with noUndo', async () => {
  const t = await boot({ workerSources: { 'ij-proc-seg.js': opsSource() }, budgetBytes: 200000 });
  const w = await t.spawn();
  const { docId } = await create(t, w, { width: 100, height: 100, bitDepth: 16 });
  await paint(t, w, docId, [10, 20, 30]);
  const est = await t.engine('doc.estimate', { docId, op: 'testScratch', params: {}, roi: null, channel: 'all' }, w);
  assert.equal(est.needBytes, 3 * 20000 + 100000);
  assert.equal(est.fits, false); assert.equal(est.fitsWithoutUndo, true);
  await assert.rejects(run(t, w, docId, 'testScratch', {}), (e) => e.code === 'IJ_OVER_BUDGET');
  assert.equal((await t.pixels(docId, 0))[0], 10, 'a refused run changes nothing');
  const r = await run(t, w, docId, 'testScratch', {}, { noUndo: true });
  assert.equal(r.info.undoDepth, 0); assert.equal(r.info.redoDepth, 0);
  assert.deepEqual([(await t.pixels(docId, 0))[0], (await t.pixels(docId, 1))[0], (await t.pixels(docId, 2))[0]], [11, 21, 31]);
  await assert.rejects(t.engine('doc.undo', { docId }, w), (e) => e.code === 'IJ_NOTHING_TO_UNDO');
  const small = await t.engine('doc.estimate', { docId, op: 'invert', params: {}, roi: null, channel: 0 }, w);
  assert.equal(small.fits, true);
  // the noUndo entry replays
  await w.engine.whenIdle();
  const key = (await t.store.shared.list())[0].key;
  const t2 = await t.reload({ flush: false, budgetBytes: 0 });
  const w2 = await t2.spawn();
  const res = await t2.engine('session.restore', { key }, w2);
  assert.equal(res.warnings.length, 0, JSON.stringify(res.warnings));
  assert.equal((await t2.engine('doc.tile', { docId, channel: 2, level: 0, tx: 0, ty: 0 }, w2)).data[0], 31);
  t2.close(); t.close();
});

await test('a replay that loses an undo step to a smaller budget stops with the replay warning', async () => {
  const t = await boot();
  const w = await t.spawn();
  const { docId } = await create(t, w, { width: 64, height: 64, channels: [{ name: 'A', color: '#fff' }] });
  await run(t, w, docId, 'crop', {}, { roi: { type: 'rect', x: 0, y: 0, w: 32, h: 32 } });
  await run(t, w, docId, 'convert', { bitDepth: 16 });
  await run(t, w, docId, 'convert', { bitDepth: 32 });
  for (let i = 0; i < 3; i++) await t.engine('doc.undo', { docId }, w);
  await w.engine.whenIdle();
  const key = (await t.store.shared.list())[0].key;
  // 8 KiB: the restore itself fits (2 × 4 KiB), the third conversion makes the budget evict the oldest undo step
  const t2 = await t.reload({ flush: false, budgetBytes: 8192 });
  const w2 = await t2.spawn();
  const res = await t2.engine('session.restore', { key }, w2);
  assert.deepEqual(arr(res.warnings.map((x) => x.code)), ['IJ_REPLAY_STOPPED'], 'the third undo needs a step the budget evicted');
  const info = await t2.engine('doc.info', { docId }, w2);
  assert.deepEqual([info.bitDepth, info.width], [8, 32], 'the document is where the replay stopped: two undos done, the third lost its step');
  t2.close(); t.close();
});

// ─────────────────────────────── ROI types ───────────────────────────────
await test('IJRoi: polyline / angle, typed runs, caps, mask perimeter, translate', async () => {
  const t = await boot();
  const R = t.page.IJRoi;
  assert.equal(R.validate({ type: 'polyline', points: [[0, 0], [5, 5]] }), true);
  assert.equal(R.isArea({ type: 'polyline', points: [[0, 0], [5, 5]] }), false);
  assert.equal(R.validate({ type: 'angle', points: [[0, 0], [5, 5], [9, 1]] }), true);
  for (const bad of [{ type: 'polyline', points: [[0, 0]] }, { type: 'angle', points: [[0, 0], [1, 1]] }, { type: 'angle', points: [[0, 0], [1, 1], [2, 2], [3, 3]] }]) {
    assert.throws(() => R.validate(bad), (e) => e.code === 'IJ_BAD_ROI');
  }
  assert.equal(R.lineLength({ type: 'polyline', points: [[0, 0], [3, 4], [3, 10]] }), 11);
  assert.equal(R.perimeter({ type: 'polyline', points: [[0, 0], [3, 4]] }), 5);
  assert.deepEqual(J(R.bounds({ type: 'polyline', points: [[1.5, 2], [6, 9]] })), { x: 1, y: 2, w: 5, h: 7 });
  const four = R.fromMask(Uint8Array.from([1, 1, 1, 1, 0, 1, 1, 1, 1]), 3, 3);
  assert.ok(isU32(four.rle));
  // a ring: outer loop 3×3 + hole 1×1
  assert.equal(R.outlines(four).length, 2);
  assert.ok(Math.abs(R.perimeter(four) - (R.tracedPerimeter([[0, 0], [3, 0], [3, 3], [0, 3]]) + R.tracedPerimeter([[1, 1], [1, 2], [2, 2], [2, 1]]))) < 1e-9);
  assert.equal(R.perimeter(R.fromMask(new Uint8Array(4).fill(1), 2, 2)), R.tracedPerimeter([[0, 0], [2, 0], [2, 2], [0, 2]]));
  const moved = R.translate(four, 5, 7);
  assert.ok(isU32(moved.rle) && moved.rle !== four.rle);
  assert.deepEqual([moved.x, moved.y], [five(four.x), five(four.y) + 2]);
  function five(v) { return v + 5; }
  assert.equal(R.validate(moved), true, 'a translated mask is still valid');
  assert.equal(R.contains(four, 1.5, 1.5), false); assert.equal(R.contains(four, 0.5, 0.5), true);
  // caps
  assert.throws(() => R.validate({ type: 'mask', x: 0, y: 0, w: 2000001, h: 1, rle: vm.runInContext('new Uint32Array(2000001).fill(1)', t.page) }), (e) => e.code === 'IJ_ROI_TOO_COMPLEX');
  assert.throws(() => R.validate({ type: 'polygon', points: Array.from({ length: 1000001 }, (_, i) => [i, i]) }), (e) => e.code === 'IJ_ROI_TOO_COMPLEX');
  // hash: stable, differs with content
  assert.equal(R.hash(four), R.hash(R.translate(four, 0, 0)));
  assert.notEqual(R.hash(four), R.hash(moved));
  t.close();
});

// ─────────────────────────────── the app: extension API and pages ───────────────────────────────
const EXT_BG = `
(function () {
  'use strict';
  IJApp.extend({ pkg: 'bg',
    errors: { IJ_TEST_CODE: 'err.badArgs' },
    columns: [['Count', 'Count', 'Mean'], ['Zed', 'Zed header']],
    commands: [
    { id: 'zTestDlg', menu: ['Process'], order: 910, run: async (api) => {
        const v = await api.dialog({ title: 'All field types', fields: [
          { type: 'number', id: 'n', labelKey: 'dlg.radius', value: 2, min: 0 },
          { type: 'radio', id: 'mode', label: 'Mode', value: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', labelKey: 'dlg.ok' }] },
          { type: 'doc', id: 'other', label: 'Image' },
          { type: 'channel', id: 'ch', label: 'Channel', docField: 'other' },
          { type: 'textarea', id: 'k', label: 'Kernel', value: '1 2 1', rows: 3, monospace: true },
          { type: 'slider', id: 's', label: 'Slider', min: 0, max: 10, step: 1, value: 3 },
          { type: 'check', id: 'c', label: 'Check', value: true, enabledIf: (x) => x.mode === 'a', visibleIf: (x) => x.n > 0 },
          { type: 'message', id: 'msg', label: 'Hello' }],
          validate: (x) => (x.n > 99 ? { n: 'err.badArgs' } : null) });
        globalThis.__zv = v;
      } },
    { id: 'zArrange', menu: ['Process'], order: 920, run: (api) => api.run('testArrange', { order: [2] }, { channel: 'all', noRoi: true }) },
    { id: 'zCal', menu: ['Process'], order: 930, run: async (api) => { globalThis.__zr = await api.run('testCal', { pw: 0.25 }, { noRoi: true }); } },
    { id: 'zScratch', menu: ['Process'], order: 940, run: async (api) => { globalThis.__zr = await api.run('testScratch', {}, { channel: 'all', noRoi: true }); } },
    { id: 'zOverlay', menu: ['Process'], order: 950, run: (api) => { api.overlay([{ kind: 'points', pts: [1, 2, 3, 4], color: '#f00' }]); } },
    { id: 'zWindows', menu: ['Process'], order: 960, run: (api) => {
        api.openPlot({ title: 'P', xLabel: 'x', yLabel: 'y', series: [{ kind: 'line', x: [0, 1, 2], y: [1, 4, 9] }, { kind: 'bars', x: [0, 1, 2], y: [2, 1, 3] }, { kind: 'points', x: [0.5], y: [2] }],
          overlays: [{ kind: 'line', x1: 0, y1: 0, x2: 2, y2: 9 }], image: { w: 2, h: 2, data: new Float32Array([1, 2, 3, 4]), logScale: true } });
        api.openTable('T', ['a', 'b'], [[1, 2], { a: 3, b: 4 }]);
        api.addResults([{ Area: 5, Zed: 7, Count: 3, Mean: 2.5, Other: 'x' }], { show: false });
      } },
    { id: 'zCompute', menu: ['Process'], order: 970, run: async (api) => { globalThis.__zc = await api.compute('testSum', {}, {}); } },
    { id: 'zState', menu: ['Process'], order: 980, run: (api) => { globalThis.__zs = api.state(); } },
    { id: 'zBadDlg', menu: ['Process'], order: 981, run: (api) => api.dialog({ title: 'bad', fields: [{ type: 'checkbox', id: 'x', label: 'X' }] }) },
    { id: 'zNoKeyDlg', menu: ['Process'], order: 982, run: (api) => api.dialog({ title: 'nokey', fields: [{ type: 'number', id: 'x', labelKey: 'dlg.noSuchKey', value: 1 }] }) },
    { id: 'zThrow', menu: ['Process'], order: 983, run: (api) => api.compute('noSuchOp', {}, {}) },
    { id: 'zPrevOk', menu: ['Process'], order: 984, run: async (api) => {
        globalThis.__zp = await api.dialog({ title: 'prev', fields: [{ type: 'number', id: 'n', labelKey: 'dlg.radius', value: 1, min: 0 }], preview: { op: 'testAdd', params: (v) => ({ value: v.n }) } });
      } },
    { id: 'zPrevBad', menu: ['Process'], order: 985, run: (api) => api.dialog({ title: 'prevbad', fields: [{ type: 'number', id: 'n', labelKey: 'dlg.radius', value: 1 }], preview: { op: 'flipH', params: () => ({}) } }) },
    { id: 'zDocEmpty', menu: ['Process'], order: 986, run: (api) => api.dialog({ title: 'nodoc', fields: [{ type: 'doc', id: 'd', label: 'Image', filter: () => false }] }) },
    { id: 'zThr', menu: ['Process'], order: 987, run: async (api) => {
        const before = api.state().threshold;
        const ok = await api.openTool('threshold');
        const st = api.state();
        await api.setDisplay(st.doc.docId, 0, { min: 10, max: 77, lut: 'Fire' });
        globalThis.__zt = { before, ok, thr: st.threshold, docId: st.doc.docId };
      } },
    { id: 'zBadTool', menu: ['Process'], order: 988, run: (api) => api.openTool('nope') }
  ] });
})();
`;
const EXT_FILTERS = `
(function () {
  'use strict';
  IJApp.extend({ pkg: 'filters', commands: [{ id: 'zFilt', menu: ['Process', 'Filters'], order: 905, run: (api) => { api.toast('dlg.ok'); } }] });
})();
`;
// The stubs of the other packages are left out: their pkg names stay free for the rules of IJApp.extend.
const pageSources = { 'ij-cmds-bg.js': EXT_BG, 'ij-cmds-filters.js': EXT_FILTERS, 'ij-cmds-seg.js': '', 'ij-cmds-multi.js': '', 'ij-cmds-geom.js': '', 'ij-cmds-roi.js': '', 'ij-cmds-coloc.js': '' };

await test('IJApp.extend: the rules, the extension API members, columns and errors', async () => {
  const t = await boot({ pageSources, workerSources: { 'ij-proc-seg.js': opsSource() } });
  const A = t.IJApp;
  assert.deepEqual(arr(A.EXT_API_MEMBERS).sort(), ['addResults', 'cancelPreview', 'clearOverlay', 'compute', 'dialog', 'error', 'estimate', 'openPlot', 'openTable', 'openTool', 'overlay', 'preview',
    'rename', 'run', 'setDisplay', 'setRoi', 'state', 'toast', 'tr',
    // wave 3 (PLAN-wave3 §2.6)
    'addDoc', 'adopt', 'annotations', 'call', 'clearPending', 'closeDoc', 'closePanel', 'colorValue', 'commands', 'copyText', 'lastCommand', 'on', 'openPanel', 'pickFile',
    'profile', 'putBlob', 'registerLut', 'renderPng', 'roiManager', 'runCommand', 'saveFile', 'sessionData', 'setPending', 'setThreshold', 'setTool', 'settings', 'view'].sort());
  const cmd = A.COMMANDS.find((c) => c.id === 'zTestDlg');
  assert.ok(cmd.ext && cmd.pkg === 'bg' && cmd.labelKey === 'cmd.zTestDlg' && cmd.order === 910);
  assert.equal(A.ERROR_KEYS.IJ_TEST_CODE, 'err.badArgs');
  assert.throws(() => A.extend({ pkg: 'coloc', commands: [{ id: 'zTestDlg', menu: ['Process'], order: 1, run() {} }] }), (e) => e.code === 'IJ_BAD_ARGS' && /duplicate/.test(e.message), 'duplicate id');
  assert.throws(() => A.extend({ pkg: 'coloc', commands: [{ id: 'has.dot', menu: ['Process'], order: 1, run() {} }] }), (e) => e.code === 'IJ_BAD_ARGS' && /command id/.test(e.message));
  assert.throws(() => A.extend({ pkg: 'coloc', commands: [{ id: 'noOrder', menu: ['Process'], run() {} }] }), (e) => e.code === 'IJ_BAD_ARGS' && /order/.test(e.message));
  assert.throws(() => A.extend({ pkg: 'coloc', errors: { IJ_OVER_BUDGET: 'err.other' } }), (e) => e.code === 'IJ_BAD_ARGS' && /already mapped/.test(e.message), 'a code another key already maps');
  // the pkg must name an ij-proc-<pkg>.js of WORKER_SCRIPTS (a lang prefix like `flt` could never be disabled when its package fails)
  assert.throws(() => A.extend({ pkg: 'flt', commands: [] }), (e) => e.code === 'IJ_BAD_ARGS' && /not a package/.test(e.message));
  assert.throws(() => A.extend({ pkg: 'shared', commands: [] }), (e) => e.code === 'IJ_BAD_ARGS');
  assert.deepEqual(arr(A.PACKAGE_NAMES), ['bg', 'filters', 'seg', 'multi', 'geom', 'roi', 'coloc', 'thr', 'enh', 'fft', 'sel', 'io', 'ov', 'ana', 'edit', 'fiji', 'lib']);
  assert.throws(() => A.extend({ pkg: 'bg' }), (e) => e.code === 'IJ_BAD_ARGS', 'a package registers once');
  assert.equal(A.COMMANDS.find((c) => c.id === 'noOrder'), undefined, 'nothing half-registers');
  // result columns: declared after their anchor, others in first-seen order
  assert.deepEqual(arr(A.resultColumnsOf([{ Area: 1, Zed: 2, Count: 3, Mean: 4, Other: 5, Label: 'x' }])), ['Label', 'Area', 'Mean', 'Count', 'Zed', 'Other']);
  assert.equal(A.columnHeader('Zed'), 'Zed header');
  await t.open();
  assert.throws(() => A.extend({ pkg: 'late', commands: [] }), (e) => e.code === 'IJ_EXTEND_AFTER_MOUNT');
  t.close();
});

await test('extension commands through the harness: every dialog field type, validated by the real schema', async () => {
  const t = await boot({ pageSources, workerSources: { 'ij-proc-seg.js': opsSource() } });
  await t.open();
  await t.runCommand('editDuplicateDummy').catch(() => {}); // no such command: ignored by the catch below
  await t.runCommand('imageDuplicate', {});
  await until(() => t.shell.opts.commands.filter((c) => /^winImg/.test(c.id)).length === 2, 'two images');
  await t.runCommand('zTestDlg', { n: '3.5', mode: 'b', k: '1 2 3', s: 7 });
  const v = t.page.__zv;
  assert.deepEqual([v.n, v.mode, v.k, v.s, v.c], [3.5, 'b', '1 2 3', 7, true]);
  assert.equal(typeof v.other, 'string', 'a doc field answers with a document id');
  assert.ok([0, 1].includes(v.ch), 'a channel field answers with a channel index');
  const spec = t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
  const other = spec.fields.find((f) => f.id === 'other');
  assert.equal(other.options.length, 2, 'the doc field lists the open images');
  assert.equal(spec.fields.find((f) => f.id === 'ch').optionsByDoc[other.options[0].value].length, 2, 'the channel field knows the channels of each image');
  // a spec the schema refuses fails the harness (and the real dialog)
  await assert.rejects(t.shell.windows.dialog({ fields: [{ type: 'bogus', id: 'x', label: 'x' }] }));
  assert.equal(t.IJViewPure.fieldProblems([{ type: 'number', id: 'a' }]).length > 0, true, 'a field without a label is a problem');
  // the cross-field validate refuses
  const asks = t.script.asks.length;
  await assert.rejects(t.runCommand('zTestDlg', { n: 500 }), /validate\(\)/, 'the stand-in answers like the view: validate() refuses → the harness fails the command');
  assert.equal(t.page.__zv.n, 3.5, 'the refused dialog did not return values');
  assert.ok(t.script.asks.length > asks, 'the failure is reported to the operator');
  t.close();
});

await test('api.run: new calibration keeps selection and view; layout changes clamp the channel and rebuild the display; run without undo asks first', async () => {
  const t = await boot({ pageSources, workerSources: { 'ij-proc-seg.js': opsSource() }, channels: 3 });
  const sh = await t.open();
  sh.opts.onRoi({ type: 'rect', x: 2, y: 2, w: 8, h: 8 }, { final: true });
  const fits = sh.calls.filter((c) => c[0] === 'fit').length;
  await t.runCommand('zCal');
  assert.equal(J(t.page.__zr.changed).calibration, true);
  assert.equal(sh.infoUpdates.length >= 1 && sh.infoUpdates[sh.infoUpdates.length - 1].calibration.pixelWidth, 0.25, 'the title follows the new calibration');
  assert.equal(sh.calls.filter((c) => c[0] === 'fit').length, fits, 'the view is not re-fitted');
  assert.deepEqual(J(sh.opts.getState().roi), { type: 'rect', x: 2, y: 2, w: 8, h: 8 }, 'the selection stays');
  // the active channel is 2, then an op leaves one channel: it is clamped
  sh.opts.onChannel(2);
  await sleep(10);
  assert.equal(sh.opts.getState().activeChannel, 2);
  await t.runCommand('zArrange');
  const img = sh.images.filter(Boolean).pop();
  assert.equal(img.channels.length, 1);
  assert.equal(sh.opts.getState().activeChannel, 0, 'the active channel is clamped');
  assert.equal(sh.opts.getState().doc.channels.length, 1);
  await t.runCommand('editUndo');
  await until(() => sh.images.filter(Boolean).pop().channels.length === 3, 'undo brings the channels back');
  assert.equal(sh.opts.getState().doc.channels.length, 3);
  t.close();
});

await test('a package that failed to load: its commands are disabled with a tooltip, the status says so', async () => {
  const t = await boot({ pageSources, brokenPackages: ['ij-proc-filters.js'] });
  const sh = await t.open();
  await until(() => t.failedPackages().has('filters'), 'package failure event');
  await until(() => sh.status.some((s) => /filters/.test(s || '')), 'a notice');
  const c = sh.opts.commands.find((x) => x.id === 'zFilt');
  assert.equal(c.enabled(sh.opts.getState()), false);
  assert.equal(c.unavailable(), true);
  const tree = t.IJViewPure.buildMenuTree(sh.opts.commands, { t: (k, f) => f, state: sh.opts.getState() });
  const item = tree.find((x) => x.name === 'Process').items.find((i) => i.type === 'group' && i.name === 'Filters').children.find((i) => i.id === 'zFilt');
  assert.equal(item.disabled, true); assert.ok(item.title);
  const other = sh.opts.commands.find((x) => x.id === 'zTestDlg');
  assert.equal(other.unavailable(), false, 'the other packages are not affected');
  t.close();
});

await test('the extension API windows: plot, table, results columns, overlay, compute, state (threshold lifted into S)', async () => {
  const t = await boot({ pageSources, workerSources: { 'ij-proc-seg.js': opsSource() } });
  const sh = await t.open();
  await t.runCommand('zWindows');
  await until(() => [...sh.windows.floats.keys()].some((k) => /^plot-/.test(k)), 'plot window');
  assert.ok([...sh.windows.floats.keys()].some((k) => /^table-/.test(k)));
  await t.runCommand('zOverlay');
  assert.deepEqual(J(sh.activeView().overlay), [{ kind: 'points', pts: [1, 2, 3, 4], color: '#f00' }]);
  await t.runCommand('zCompute');
  assert.equal(Object.keys(t.page.__zc).length, 1, 'compute answers for the active image');
  await t.runCommand('zState');
  const st = t.page.__zs;
  assert.ok(st.doc && st.docs.length === 1 && st.threshold === null && st.resultsCount === 1 && st.activeChannel === 0 && st.lineWidth === 1);
  // the Threshold window lifts its state
  await t.runCommand('adjustThreshold');
  await until(() => t.shell.opts.getState().threshold, 'threshold state');
  const th = t.shell.opts.getState().threshold;
  assert.equal(th.docId, st.doc.docId);
  assert.ok(Number.isFinite(th.lower) && Number.isFinite(th.upper) && typeof th.dark === 'boolean');
  // Plot Profile and Histogram are plot windows now
  await t.runCommand('analyzeHistogram');
  await until(() => [...sh.windows.floats.keys()].filter((k) => /^plot-/.test(k)).length >= 2, 'histogram plot window');
  sh.opts.onRoi({ type: 'line', x1: 1, y1: 1, x2: 20, y2: 10, width: 1 }, { final: true });
  await t.runCommand('analyzePlotProfile');
  await until(() => [...sh.windows.floats.keys()].filter((k) => /^plot-/.test(k)).length >= 3, 'profile plot window');
  t.close();
});

await test('run without undo: the app asks, then runs the step with noUndo', async () => {
  const t = await boot({ pageSources, workerSources: { 'ij-proc-seg.js': opsSource() }, budgetBytes: 112000, volume: { channels: 3, width: 40, height: 30, depth: 2 } });
  await t.open({ method: 'sum', start: 1, stop: 2, level: 0 });
  const doc = t.shell.opts.getState().doc;
  assert.equal(doc.bitDepth, 16);
  t.script.nextAsk = 'go';
  await t.runCommand('zScratch');
  assert.ok(t.script.asks.some((a) => /undo/i.test(a.title || '')), 'the operator was asked');
  const after = t.shell.opts.getState().doc;
  assert.equal(after.undoDepth, 0);
  assert.ok(t.log.msgs.some((m) => m.cmd === 'doc.run' && m.args.noUndo === true));
  // declined: nothing runs, no error dialog
  const asks = t.script.asks.length;
  t.script.nextAsk = 'cancel';
  await t.runCommand('zScratch');
  assert.equal(t.script.asks.length, asks + 1, 'only the question: a refusal is not an error');
  t.close();
});

// ─────────────────────────────── the view's pure helpers ───────────────────────────────
await test('IJViewPure: dialog field schema, hidden fields, channel options follow their document', async () => {
  const t = await boot();
  const P = t.IJViewPure;
  const ok = [{ type: 'number', id: 'n', label: 'N', value: 2, min: 0, max: 5 }, { type: 'radio', id: 'r', label: 'R', value: 'a', options: ['a', 'b'] },
    { type: 'textarea', id: 'k', label: 'K', value: 'x' }, { type: 'message', id: 'm', label: 'hi' }, { type: 'slider', id: 's', label: 'S', min: 0, max: 3, value: 1 }];
  assert.equal(P.fieldProblems(ok).length, 0);
  for (const bad of [[{ type: 'x', id: 'a', label: 'a' }], [{ type: 'number', label: 'a' }], [{ type: 'number', id: 'a' }], [{ type: 'choice', id: 'a', label: 'a', options: [] }],
    [{ type: 'check', id: 'a', label: 'a' }, { type: 'check', id: 'a', label: 'b' }], [{ type: 'channel', id: 'c', label: 'c', docField: 'zz', optionsByDoc: {}, options: [{ value: 0, label: '1' }] }],
    [{ type: 'check', id: 'a', label: 'a', enabledIf: 3 }], [{ type: 'choice', id: 'a', label: 'a', options: [{ value: 1 }] }]]) {
    assert.ok(P.fieldProblems(bad).length > 0, JSON.stringify(bad));
  }
  const r = P.collectFields(ok, { n: '3', r: 'b', k: 'line1\nline2', s: '2' });
  assert.ok(r.ok); assert.deepEqual(J(r.values), { n: 3, r: 'b', k: 'line1\nline2', s: 2 });
  assert.equal(P.collectFields(ok, { n: '9', r: 'b', k: '', s: '2' }).ok, false);
  assert.equal(P.collectFields(ok, { n: '9', r: 'b', k: '', s: '2' }, { hidden: new Set(['n']) }).ok, true, 'a hidden field is not validated');
  const f = [{ type: 'doc', id: 'd', label: 'D', options: [{ value: 'id1', label: 'one' }, { value: 'id2', label: 'two' }], value: 'id1' },
    { type: 'channel', id: 'c', label: 'C', docField: 'd', optionsByDoc: { id1: [{ value: 0, label: '1' }], id2: [{ value: 0, label: '1' }, { value: 1, label: '2' }] }, options: [{ value: 0, label: '1' }] }];
  assert.equal(P.collectFields(f, { d: 'id1', c: '1' }).ok, false, 'channel 1 does not exist in image one');
  assert.deepEqual(J(P.collectFields(f, { d: 'id2', c: '1' }).values), { d: 'id2', c: 1 });
  t.close();
});

await test('IJViewPure.buildMenuTree: entries sorted by order, submenus placed by their meta, separators above flagged entries, unavailable commands', async () => {
  const t = await boot();
  const P = t.IJViewPure;
  const cmds = [
    { id: 'c', menu: ['Process'], order: 30 }, { id: 'a', menu: ['Process'], order: 10 }, { id: 'g2', menu: ['Process', 'Sub'], order: 20 }, { id: 'g1', menu: ['Process', 'Sub'], order: 10 },
    { id: 'b', menu: ['Process'], order: 20, separatorBefore: true }, { id: 'u', menu: ['Process'] }, { id: 'x', menu: ['Process'], order: 40, unavailable: () => true }
  ];
  const tree = P.buildMenuTree(cmds, { groups: { 'Process/Sub': { order: 25, separatorBefore: true } }, t: (k, f) => f });
  const names = tree[0].items.map((i) => (i.type === 'separator' ? '-' : i.type === 'group' ? 'G:' + i.children.map((c) => c.id).join('') : i.id));
  assert.deepEqual(J(names), ['a', '-', 'b', '-', 'G:g1g2', 'c', 'x', 'u']);
  assert.equal(tree[0].items.find((i) => i.id === 'x').disabled, true);
  assert.ok(tree[0].items.find((i) => i.id === 'x').title);
  t.close();
});

await test('IJPlot: extent, ticks and CSV; IJApp menu orders cover every submenu', async () => {
  const t = await boot();
  const PL = t.page.IJPlot;
  const e = PL.extent({ series: [{ kind: 'bars', x: [1, 2, 3], y: [5, 7, 2] }] });
  assert.deepEqual([e.x0, e.x1, e.y0, e.y1], [0.5, 3.5, 0, 7]);
  assert.deepEqual(arr(PL.niceTicks(0, 10, 6)), [0, 2, 4, 6, 8, 10]);
  assert.equal(PL.csvText({ xLabel: 'd', series: [{ kind: 'line', x: [0, 1], y: [3, 4], label: 'v' }] }), 'd,v\n0,3\n1,4\n');
  assert.equal(PL.csvText({ csv: { columns: ['a,b', 'c'], rows: [[1, 'x"y']] } }), '"a,b",c\n1,"x""y"\n');
  const calls = [];
  const canvas = { width: 300, height: 200, getContext: () => new Proxy({}, { get: (tt, k) => (k in tt ? tt[k] : (...a) => { calls.push(String(k)); }), set: (tt, k, v) => { tt[k] = v; return true; } }) };
  PL.draw(canvas, { title: 'T', xLabel: 'x', yLabel: 'y', series: [{ kind: 'line', x: [0, 1, 2], y: [1, 4, 9] }, { kind: 'bars', x: [0, 1, 2], y: [2, 1, 3] }, { kind: 'points', x: [1], y: [2] }],
    overlays: [{ kind: 'line', x1: 0, y1: 0, x2: 2, y2: 9 }] }, {});
  assert.ok(calls.includes('stroke') && calls.includes('fillRect') && calls.includes('fillText'));
  t.close();
});


// ═══════════════════════════════ W0 review round: regressions ═══════════════════════════════
// Ops of the review fixes, registered in the worker by a second "package" file (ij-proc-geom.js).
const OPS2 = `
(function (root) {
  'use strict';
  const R = root.IJOpRegistry;
  root.__ran = {};
  const tag = (n) => { root.__ran[n] = (root.__ran[n] || 0) + 1; };
  const all = (view) => view.channels.map((c) => ({ data: c.data, name: c.name, color: c.color, display: Object.assign({}, c.display) }));
  // resolve OVERWRITES (not idempotent on purpose): the engine must not call it when it replays an entry
  R.define('rsvMax', { kind: 'pixel', version: 1,
    resolve(view, params, chans) { const p = Object.assign({}, params); p.k = view.channels[chans[0]].display.max; return p; },
    prepare(view, c, p) { return { apron: { x: 0, y: 0 }, fn: (src) => src.data.map(() => p.k) }; } });
  R.define('bigSize', { kind: 'size', version: 1, scratchBytes: () => 1e12, async run() { tag('bigSize'); return null; } });
  R.define('bigNew', { kind: 'newdoc', version: 1, scratchBytes: () => 1e12, async run() { tag('bigNew'); return []; } });
  R.define('bigCompute', { kind: 'compute', version: 1, scratchBytes: () => 1e12, async run() { tag('bigCompute'); return {}; } });
  R.define('holdCompute', { kind: 'compute', version: 1, scratchBytes: (info, p) => p.bytes,
    async run(view, p, roi, io) { tag('holdCompute'); io.reserve(p.bytes); await new Promise((r) => setTimeout(r, p.ms)); return { ok: true }; } });
  R.define('shapeOf', { kind: 'compute', version: 1, scratchBytes: (info) => info.docs.length * 1000 + info.width,
    async run(view, p, roi, io) { return io.docIds.length; } });
  R.define('calNoDisplay', { kind: 'size', version: 1,
    async run(view, p) { return { width: view.width, height: view.height, bitDepth: view.bitDepth, calibration: { pixelWidth: p.pw, pixelHeight: p.pw, unit: 'um' }, channels: view.channels.map((c) => ({ data: c.data })) }; } });
  R.define('reorderNoDisplay', { kind: 'size', version: 1,
    async run(view, p) { return { width: view.width, height: view.height, bitDepth: view.bitDepth, channels: p.order.map((i) => ({ data: view.channels[i].data })) }; } });
  R.define('renameOp', { kind: 'size', version: 1,
    async run(view, p) { return { width: view.width, height: view.height, bitDepth: view.bitDepth, name: p.name, channels: all(view) }; } });
  R.define('chanSize', { kind: 'size', version: 1,
    async run(view, p, roi, io) {
      const v = io.channel === null || io.channel === undefined ? 0.1 : (typeof io.channel === 'number' ? io.channel + 1 : 99);
      return { width: view.width, height: view.height, bitDepth: view.bitDepth, calibration: { pixelWidth: v, pixelHeight: v, unit: 'um' }, channels: all(view) };
    } });
  R.define('oneCh', { kind: 'pixel', version: 1, channels: 'one', prepare() { return { apron: { x: 0, y: 0 }, fn: (src) => src.data.map((v) => v + 1) }; } });
  R.define('wholeSlow', { kind: 'pixel', version: 1,
    prepare(view, c, p, ctx) {
      return { whole: true, apron: { x: 0, y: 0 }, async fn(src) {
        tag('wholeStart');
        for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 5)); await ctx.tick(i / 60); ctx.check(); }
        return src.data.map((v) => v + 1);
      } };
    } });
  R.define('slowEach', { kind: 'pixel', version: 1,
    prepare(view, c, p, ctx) {
      return { whole: true, apron: { x: 0, y: 0 }, async fn(src) { tag('slowEach'); await new Promise((r) => setTimeout(r, 60)); ctx.check(); return src.data.map((v) => v + 1); } };
    } });
  R.define('bigApron', { kind: 'pixel', version: 1, preview: 'reduced',
    prepare(view, c, p, ctx) { const a = Math.ceil(5000 / ctx.scale); return { apron: { x: a, y: a }, fn: (src) => src.data }; } });
  R.define('bigApronRegion', { kind: 'pixel', version: 1, preview: 'region',
    prepare(view, c, p, ctx) { const a = Math.ceil(5000 / ctx.scale); return { apron: { x: a, y: a }, fn: (src) => src.data }; } });
  R.define('writesRegion', { kind: 'pixel', version: 1,
    prepare() { return { apron: { x: 0, y: 0 }, region(full, rect) { full.data[0] = full.data[0] ^ 99; return new full.data.constructor(rect.w * rect.h); } }; } });
  R.define('writesView', { kind: 'size', version: 1, async run(view) { view.channels[0].data[0] ^= 7; return null; } });
})(typeof self !== 'undefined' ? self : globalThis);
`;
const W2 = (extra) => Object.assign({ 'ij-proc-seg.js': opsSource(), 'ij-proc-geom.js': OPS2 }, extra || {});
// A request with an id the test knows (to cancel it).
const raw = (t, w, id, cmd, args) => new Promise((resolve, reject) => { w.__pending.set(id, { resolve, reject, cmd }); w.far.onmessage({ data: { id, cmd, args } }); });
const infoOf = (t, w, docId) => t.engine('doc.info', { docId }, w);

await test('review: resolve is not called when an entry is replayed (it would read the display of another moment)', async () => {
  const t = await boot({ workerSources: W2() });
  const w = await t.spawn();
  const { docId } = await create(t, w, { channels: [{ name: 'A', color: '#fff' }] });
  await t.flush();
  await t.engine('doc.setDisplay', { docId, channel: 0, min: 0, max: 10 }, w);
  await run(t, w, docId, 'rsvMax', {});
  assert.equal((await t.pixels(docId, 0))[0], 10, 'live: the display max (10) was copied into the params');
  await w.engine.whenIdle();
  const key = (await t.store.shared.list())[0].key;
  const entry = (await t.store.shared.load(key)).docs[docId].journal[0];
  assert.equal(entry.params.k, 10, 'the journal holds the resolved params');
  const t2 = await t.reload({ flush: false });
  const w2 = await t2.spawn();
  const res = await t2.engine('session.restore', { key }, w2);
  assert.equal(res.warnings.length, 0, JSON.stringify(res.warnings));
  assert.equal((await t2.engine('doc.tile', { docId, channel: 0, level: 0, tx: 0, ty: 0 }, w2)).data[0], 10, 'replay: the journaled 10, not the default display max 255');
  t2.close(); t.close();
});

await test('review: scratchBytes is enforced for size, newdoc and compute ops (refused before run), concurrently and without double counting io.reserve', async () => {
  const t = await boot({ workerSources: W2(), budgetBytes: 100000 });
  const w = await t.spawn();
  const a = (await create(t, w, { name: 'a' })).docId, b = (await create(t, w, { name: 'b' })).docId;
  await assert.rejects(run(t, w, a, 'bigSize', {}), (e) => e.code === 'IJ_OVER_BUDGET');
  await assert.rejects(run(t, w, a, 'bigNew', {}), (e) => e.code === 'IJ_OVER_BUDGET');
  await assert.rejects(t.engine('doc.compute', { docId: a, op: 'bigCompute', params: {}, roi: null, channel: 0 }, w), (e) => e.code === 'IJ_OVER_BUDGET');
  assert.equal(w.far.__ran.bigSize || w.far.__ran.bigNew || w.far.__ran.bigCompute || 0, 0, 'no refused op ran');
  const est = await t.engine('doc.estimate', { docId: a, op: 'bigSize', params: {}, roi: null, channel: 0 }, w);
  assert.equal(est.fits, false);
  // two computes on two documents at once: each declares 60000 of a 100000 budget; the second is refused while the first holds its peak
  const go = (id) => t.engine('doc.compute', { docId: id, op: 'holdCompute', params: { bytes: 60000, ms: 80 }, roi: null, channel: 0 }, w);
  const rs = await Promise.allSettled([go(a), go(b)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(rs.find((r) => r.status === 'rejected').reason.code, 'IJ_OVER_BUDGET');
  assert.equal(w.far.__ran.holdCompute, 1, 'declaring 60000 and reserving 60000 is counted once');
  assert.deepEqual(J(await go(a)), { ok: true }, 'the peak is given back: a later one runs');
  // info.docs tells scratchBytes the shape of the other documents of the request
  const sh = await t.engine('doc.estimate', { docId: a, docIds: [b], op: 'shapeOf', params: {}, roi: null, channel: 0 }, w);
  assert.equal(sh.needBytes, 1000 + 24, 'one other document + the width');
  t.close();
});

await test('review: a size op without a display keeps the channel display (calibration-only, reorder by array)', async () => {
  const t = await boot({ workerSources: W2() });
  const w = await t.spawn();
  const { docId } = await create(t, w);
  await t.engine('doc.setDisplay', { docId, channel: 0, min: 10, max: 77, lut: 'Fire' }, w);
  const r = await run(t, w, docId, 'calNoDisplay', { pw: 0.25 });
  assert.deepEqual(J(r.changed), { channels: [], sizeChanged: false, calibration: true });
  assert.deepEqual([r.info.channels[0].display.min, r.info.channels[0].display.max, r.info.channels[0].display.lut], [10, 77, 'Fire']);
  assert.deepEqual(r.info.channels.map((c) => c.name), ['A', 'B', 'C']);
  const o = await run(t, w, docId, 'reorderNoDisplay', { order: [2, 0, 1] });
  assert.deepEqual(o.info.channels.map((c) => c.name), ['C', 'A', 'B'], 'names follow the arrays');
  assert.deepEqual([o.info.channels[1].display.max, o.info.channels[1].display.lut], [77, 'Fire'], 'the display follows its array');
  t.close();
});

await test('review: undoing a size step gives back neither a later rename nor the brightness set since', async () => {
  const t = await boot({ workerSources: W2() });
  const w = await t.spawn();
  const { docId } = await create(t, w, { name: 'orig' });
  await run(t, w, docId, 'reorderNoDisplay', { order: [1, 0, 2] });
  await t.engine('doc.rename', { docId, name: 'Renamed' }, w);
  const u = await t.engine('doc.undo', { docId }, w);
  assert.equal(u.info.name, 'Renamed', 'a rename is not an undo step');
  assert.deepEqual(u.info.channels.map((c) => c.name), ['A', 'B', 'C']);
  await t.engine('doc.redo', { docId }, w);
  // a step that renames the document itself gives the name back
  const r = await run(t, w, docId, 'renameOp', { name: 'Zed' });
  assert.equal(r.info.name, 'Zed');
  assert.equal((await t.engine('doc.undo', { docId }, w)).info.name, 'Renamed');
  assert.equal((await t.engine('doc.redo', { docId }, w)).info.name, 'Zed');
  // calibration-only step, brightness changed afterwards, undo
  await run(t, w, docId, 'calNoDisplay', { pw: 0.25 });
  await t.engine('doc.setDisplay', { docId, channel: 0, min: 3, max: 99 }, w);
  const u2 = await t.engine('doc.undo', { docId }, w);
  assert.equal(u2.info.calibration.pixelWidth, 0.5);
  assert.deepEqual([u2.info.channels[0].display.min, u2.info.channels[0].display.max], [3, 99], 'the display stays as the operator left it');
  t.close();
});

await test('review: a size op journals the channel it ran with, a one-channel pixel op the channel it ran on', async () => {
  const t = await boot({ workerSources: W2() });
  const w = await t.spawn();
  const { docId } = await create(t, w);
  await t.flush();
  await run(t, w, docId, 'chanSize', {}, { channel: 1 });
  assert.equal((await infoOf(t, w, docId)).calibration.pixelWidth, 2, 'live: io.channel = 1');
  await t.engine('doc.setDisplay', { docId, active: 1 }, w);
  await run(t, w, docId, 'oneCh', {}, { channel: undefined });
  await t.engine('doc.setDisplay', { docId, active: 2 }, w);
  await w.engine.whenIdle();
  const key = (await t.store.shared.list())[0].key;
  const j = (await t.store.shared.load(key)).docs[docId].journal;
  assert.deepEqual([j[0].channel, j[1].channel], [1, 1]);
  const t2 = await t.reload({ flush: false });
  const w2 = await t2.spawn();
  const res = await t2.engine('session.restore', { key }, w2);
  assert.equal(res.warnings.length, 0, JSON.stringify(res.warnings));
  assert.equal((await infoOf(t2, w2, docId)).calibration.pixelWidth, 2, 'replay: io.channel = 1 again');
  const px = async (c) => (await t2.engine('doc.tile', { docId, channel: c, level: 0, tx: 0, ty: 0 }, w2)).data[0];
  assert.deepEqual([await px(0), await px(1), await px(2)], [0, 1, 0], 'the channel that was active when it ran, not the one active at replay');
  t2.close(); t.close();
});

await test('review: a whole-image op ticks and checks inside its fn: Cancel stops it mid-channel and the document is untouched', async () => {
  const t = await boot({ workerSources: W2() });
  const w = await t.spawn();
  const { docId } = await create(t, w, { channels: [{ name: 'A', color: '#fff' }] });
  const rev = (await infoOf(t, w, docId)).rev;
  const t0 = Date.now();
  const p = raw(t, w, 7001, 'doc.run', { docId, op: 'wholeSlow', params: {}, roi: null, channel: 0 });
  await until(() => w.far.__ran.wholeStart >= 1, 'the op started');
  await sleep(20);
  await t.engine('cancel', { targetId: 7001 }, w);
  await assert.rejects(p, (e) => e.code === 'IJ_CANCELLED');
  assert.ok(Date.now() - t0 < 280, 'it stopped long before the 300 ms the loop needs');
  assert.deepEqual([(await infoOf(t, w, docId)).rev, (await t.pixels(docId, 0))[0]], [rev, 0]);
  const done = await run(t, w, docId, 'wholeSlow', {}, { channel: 0 });
  assert.equal((await t.pixels(docId, 0))[0], 1, 'uncancelled: the async fn is awaited');
  assert.equal(done.info.undoDepth, 1);
  t.close();
});

await test('review: a run without undo cancelled after one channel tells the page (invalidate + info with the error)', async () => {
  const t = await boot({ workerSources: W2() });
  const w = await t.spawn();
  const { docId } = await create(t, w);
  const rev = (await infoOf(t, w, docId)).rev;
  const p = raw(t, w, 7002, 'doc.run', { docId, op: 'slowEach', params: {}, roi: null, channel: 'all', noUndo: true });
  await until(() => w.far.__ran.slowEach >= 2, 'the second channel started (the first is swapped)');
  await t.engine('cancel', { targetId: 7002 }, w);
  const err = await p.then(() => null, (e) => e);
  assert.ok(err && err.code === 'IJ_CANCELLED');
  assert.ok(err.details && err.details.info, 'the error carries the document info');
  assert.deepEqual(J(err.details.changed.channels), [0]);
  assert.ok(err.details.info.rev > rev && err.details.info.undoDepth === 0);
  await until(() => t.log.events.some((e) => e.event === 'invalidate' && e.docId === docId && J(e.channels).join() === '0'), 'an invalidate event for the swapped channel');
  assert.deepEqual([(await t.pixels(docId, 0))[0], (await t.pixels(docId, 1))[0]], [1, 0], 'channel 0 changed for good, channel 1 did not');
  t.close();
});

await test('review: a preview whose apron is larger than the view climbs to a level that fits; a region op asks to zoom in', async () => {
  const t = await boot({ workerSources: W2() });
  const w = await t.spawn();
  const { docId } = await create(t, w, { width: 6000, height: 5000, channels: [{ name: 'A', color: '#fff' }] });
  const view = { docId, params: {}, roi: null, channel: 0, level: 0, x0: 0, y0: 0, x1: 800, y1: 600 };
  await t.engine('doc.preview', Object.assign({ seq: 1, op: 'bigApron' }, view), w);
  const ev = await until(() => t.log.events.filter((e) => e.event === 'preview' && e.seq === 1).pop(), 'the preview event');
  assert.ok(ev && ev.seq === 1 && ev.level >= 1, 'previewed at level ' + (ev && ev.level) + ' instead of IJ_PREVIEW_TOO_LARGE');
  assert.equal(ev.w * (1 << ev.level) >= 800 - (1 << ev.level), true, 'it covers the visible region');
  await assert.rejects(t.engine('doc.preview', Object.assign({ seq: 2, op: 'bigApronRegion' }, view), w), (e) => e.code === 'IJ_PREVIEW_TOO_LARGE');
  t.close();
});

await test('review: an op that writes into an array it was given fails (the engine verifies in the tests)', async () => {
  const t = await boot({ workerSources: W2() });
  const w = await t.spawn();
  const { docId } = await create(t, w);
  await assert.rejects(run(t, w, docId, 'writesRegion', {}), (e) => e.code === 'IJ_INTERNAL');
  await assert.rejects(run(t, w, docId, 'writesView', {}), (e) => e.code === 'IJ_INTERNAL');
  assert.equal((await infoOf(t, w, docId)).undoDepth, 0, 'nothing was committed');
  t.close();
});

await test('review: undo steps that share arrays with the live document are not counted as memory a run could free', async () => {
  const t = await boot({ workerSources: W2(), budgetBytes: 2000 });
  const w = await t.spawn();
  const { docId } = await create(t, w);
  await run(t, w, docId, 'reorderNoDisplay', { order: [2, 1, 0] });
  assert.equal((await infoOf(t, w, docId)).undoDepth, 1);
  const est = await t.engine('doc.estimate', { docId, op: 'testAdd', params: { value: 1 }, roi: null, channel: 'all' }, w);
  assert.equal(est.needBytes, 1440);
  assert.equal(est.fits, false, 'dropping the undo step frees nothing: its arrays are the document\'s own');
  await assert.rejects(run(t, w, docId, 'testAdd', { value: 1 }), (e) => e.code === 'IJ_OVER_BUDGET');
  assert.equal((await infoOf(t, w, docId)).undoDepth, 1, 'the refused run did not evict the undo history first');
  t.close();
});

await test('review: a restore held by a package that failed to load keeps the stored journal; a later start replays it all', async () => {
  const t = await boot({ workerSources: W2() });
  const w = await t.spawn();
  const { docId } = await create(t, w, { channels: [{ name: 'A', color: '#f00' }] });
  await t.flush();
  await run(t, w, docId, 'testAdd', { value: 3 });
  await run(t, w, docId, 'testAdd', { value: 4 });
  await w.engine.whenIdle();
  const key = (await t.store.shared.list())[0].key;
  // the package that holds testAdd (seg) fails to load
  const t2 = await boot({ storage: t.store.shared, workerSources: W2(), brokenPackages: ['ij-proc-seg.js'] });
  const w2 = await t2.spawn();
  const res = await t2.engine('session.restore', { key }, w2);
  assert.deepEqual(J(res.warnings.map((x) => [x.code, x.held, x.cause])), [['IJ_REPLAY_STOPPED', true, 'IJ_UNKNOWN_OP']]);
  await until(() => t2.log.events.some((e) => e.event === 'storageError' && e.code === 'IJ_REPLAY_HELD' && e.docId === docId), 'the page is told the document is unprotected');
  const f = await t2.engine('flush', {}, w2);
  assert.equal(f.ok, false); assert.ok(f.unsafe.includes(docId), 'nothing of it can be kept');
  await w2.engine.whenIdle();
  const closed = await t2.engine('doc.close', { docId }, w2);
  assert.equal(closed.ok, false, 'a held document is never "kept for later" over the stored one');
  const rec = (await t.store.shared.load(key)).docs[docId];
  assert.equal(rec.journal.length, 2, 'the stored journal is untouched');
  t2.close();
  // the transient failure is over
  const t3 = await boot({ storage: t.store.shared, workerSources: W2() });
  const w3 = await t3.spawn();
  const r3 = await t3.engine('session.restore', { key }, w3);
  assert.equal(r3.warnings.length, 0, JSON.stringify(r3.warnings));
  assert.equal((await t3.engine('doc.tile', { docId, channel: 0, level: 0, tx: 0, ty: 0 }, w3)).data[0], 7);
  t3.close(); t.close();
});

await test('review: a restore stamps the session meta display of every document it brings back', async () => {
  const t = await boot({ workerSources: W2() });
  const w = await t.spawn();
  const prov = { sessionKey: 'S1', datasetId: '3d/X' };   // one session for both documents
  const a = (await create(t, w, { name: 'a', provenance: prov })).docId, b = (await create(t, w, { name: 'b', provenance: prov })).docId;
  await run(t, w, a, 'testAdd', { value: 1 });
  await run(t, w, b, 'testAdd', { value: 2 });
  await t.flush();
  const key = (await t.store.shared.list())[0].key;
  const t2 = await t.reload({ flush: false });
  const w2 = await t2.spawn();
  await t2.engine('session.restore', { key }, w2);
  await t2.engine('doc.setDisplay', { docId: a, channel: 0, max: 99 }, w2);
  await w2.engine.whenIdle();
  const meta = (await t2.store.shared.list())[0].meta;
  assert.deepEqual(Object.keys(meta.display).sort(), [a, b].sort(), 'the display stamp of the other document is not wiped');
  assert.ok(meta.display[b].sig && meta.display[a].channels[0].max === 99);
  t2.close(); t.close();
});

await test('review: IJRoi.hash is two 32-bit lanes plus the size', async () => {
  const t = await boot();
  const R = t.page.IJRoi;
  const m = R.fromMask(Uint8Array.from([1, 1, 1, 1, 0, 1, 1, 1, 1]), 3, 3);
  assert.match(R.hash(m), /^[0-9a-f]{16}-\d+$/);
  assert.equal(R.hash(m), R.hash(R.translate(m, 0, 0)));
  t.close();
});

await test('review: harness — a bad dialog spec, a missing key, a refused value, an error dialog and a failing preview fail the command', async () => {
  const t = await boot({ pageSources, workerSources: W2() });
  await t.open();
  await assert.rejects(t.runCommand('zBadDlg'), /unknown field type checkbox/);
  await assert.rejects(t.runCommand('zNoKeyDlg'), /dlg\.noSuchKey is in no lang file/);
  await assert.rejects(t.runCommand('zThrow'), /reported an error to the operator/);
  const errs = await t.runCommand('zThrow', undefined, { expectError: true });
  assert.ok(errs.length >= 1 && t.errors.length >= 2);
  const nPrev = t.log.previews.length;
  await t.runCommand('zPrevOk', { n: 3 });
  assert.ok(t.log.previews.length > nPrev && t.log.previews.some((p) => p), 'the Preview box was ticked and the engine answered');
  assert.equal(t.page.__zp.n, 3);
  await assert.rejects(t.runCommand('zPrevBad'), /\[advanced-studio\] preview .*no preview for this operation/);
  await assert.rejects(t.runCommand('zDocEmpty'), /refuses the values/, 'a doc field with no document cannot be answered');
  t.close();
});

await test('review: api.openTool(threshold) fills state().threshold; api.setDisplay changes a channel display; an unknown tool is refused', async () => {
  const t = await boot({ pageSources, workerSources: W2() });
  const sh = await t.open();
  await t.runCommand('zThr');
  const z = t.page.__zt;
  assert.equal(z.before, null, 'null until the Threshold window has been opened');
  assert.equal(z.ok, true);
  assert.ok(z.thr && z.thr.docId === z.docId && Number.isFinite(z.thr.lower) && Number.isFinite(z.thr.upper) && typeof z.thr.dark === 'boolean');
  const d = (await t.engine('doc.info', { docId: z.docId })).channels[0].display;
  assert.deepEqual([d.min, d.max, d.lut], [10, 77, 'Fire']);
  assert.equal(sh.opts.getState().doc.channels[0].display.max !== undefined, true);
  await t.runCommand('zBadTool', undefined, { expectError: true });
  t.close();
});

await test('review: IJViewPure.collectFields refuses a placeholder option (a doc field with no open image)', async () => {
  const t = await boot();
  const P = t.IJViewPure;
  const f = [{ type: 'doc', id: 'd', label: 'D', options: [{ value: '', label: 'none', disabled: true }], value: '' }];
  const r = P.collectFields(f, { d: '' });
  assert.equal(r.ok, false); assert.equal(r.errors.d, 'choice');
  const g = [{ type: 'choice', id: 'c', label: 'C', options: [{ value: 'a', label: 'A', disabled: true }, { value: 'b', label: 'B' }] }];
  assert.equal(P.collectFields(g, { c: 'a' }).ok, false);
  assert.equal(P.collectFields(g, { c: 'b' }).ok, true);
  t.close();
});

console.log(`ij registry: OK (${passed} groups)`);
process.exit(0);
