// Wave-2 integration pass: defects that only show when several packages meet (found by the cross-package review).
//   - a non-modal dialog (menus stay usable) never runs its step on another image than the one it was opened on
//   - Bin and Arrange Channels read the display state: it is copied into the journaled params (resolve), so a reload
//     replays them to the pixels the operator saw
//   - fltDataRange has its own busy label
//
// Run: node tests/js/test_ij_integration.mjs
import assert from 'node:assert/strict';
import { boot, until, J } from './ij_harness.mjs';

const arr = (a) => Array.from(a);
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); } catch (err) { failed++; console.log('FAIL ' + name); console.error(err); }
}
async function activate(t, docId) {
  const c = t.shell.opts.commands.find((x) => x.id === 'winImg' + docId);
  assert.ok(c, 'window menu entry of ' + docId);
  await c.run();
  await until(() => t.activeId() === docId, 'image ' + docId + ' on screen');
}
const defaults = (spec) => { const v = {}; for (const f of spec.fields) if (f.type !== 'message') v[f.id] = f.value; return v; };
const sum = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };

await test('a dialog left open while another image becomes active runs nothing (filters, Find Maxima, Translate, Specify)', async () => {
  const t = await boot({ channels: 2 });
  await t.open();
  const A = t.activeId();
  await t.runCommand('colorSplitChannels');
  const docs = await t.docs();
  const B = docs.find((d) => d.docId !== A && /^C1-/.test(d.name)).docId;
  await activate(t, A);
  const snapshot = async () => {
    const out = {};
    for (const d of await t.docs()) for (let c = 0; c < d.channels.length; c++) out[d.docId + ':' + c] = sum(await t.pixels(d.docId, c)) + '/' + d.rev;
    return out;
  };
  const switching = (toDoc) => async (spec) => { const v = defaults(spec); await activate(t, toDoc); return v; };
  for (const [id, over] of [['mathGamma', {}], ['noiseRemoveOutliers', {}], ['transformTranslate', {}], ['selSpecify', { width: 9, height: 7, x: 2, y: 3 }]]) {
    await activate(t, A);
    const before = await snapshot();
    const nDocs = (await t.docs()).length;
    t.script.dialogs.push(async (spec) => Object.assign(await switching(B)(spec), over));
    await t.shell.opts.onCommand(t.cmd(id), { source: 'menu' });
    assert.deepEqual(await snapshot(), before, id + ': no image was changed');
    assert.equal((await t.docs()).length, nDocs);
    assert.equal(t.shell.activeRoi == null, true, id + ': no selection was put on the image that became active');
  }
  // Find Maxima: the point selection and the results belong to the original image
  await activate(t, A);
  const rowsBefore = t.log.msgs.filter((m) => m.cmd === 'session.putMeta').length;
  t.script.dialogs.push(async (spec) => Object.assign(await switching(B)(spec), { output: 'points', prominence: 10 }));
  await t.shell.opts.onCommand(t.cmd('procFindMaxima'), { source: 'menu' });
  assert.equal(t.shell.activeRoi == null, true, 'Find Maxima: no point selection on the other image');
  t.close();
});

// A size step takes a snapshot of its result at once, so a reload rarely replays it; the contract (PLAN §2.1, R7) is
// still that `resolve` copies the display state into the journaled params and `run` reads nothing else: tested on the
// registered operations directly, with the display of the replaying document being the baseline one.
const io = { reserve() {}, release() {}, tick() {}, check() {}, channel: 'all' };
const makeView = (bd, display, n = 2) => {
  const w = 12, h = 10, channels = [];
  for (let c = 0; c < n; c++) {
    const data = bd === 8 ? new Uint8Array(w * h) : new Uint16Array(w * h);
    for (let i = 0; i < data.length; i++) data[i] = (i * 37 + c * 11 + (i >> 2) * 5) % (bd === 8 ? 251 : 4001);
    channels.push({ data, name: 'C' + (c + 1), color: '#ffffff', display: Object.assign({}, display[c] || display[0]) });
  }
  return { id: 1, name: 'v', width: w, height: h, bitDepth: bd, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' }, provenance: null, channels, active: 0 };
};
const fingerprint = (res) => J({ w: res.width, h: res.height, ch: res.channels.map((c) => [arr(c.data), c.display || null, c.color || null]), active: res.active });

await test('Bin: the display state is copied into the params (resolve) and run reads only the params', async () => {
  const t = await boot({ channels: 1 });
  const spec = t.page.IJOpRegistry.get('bin');
  assert.equal(typeof spec.resolve, 'function');
  for (const bd of [8, 16]) {
    for (const method of ['average', 'sum', 'median']) {
      const inv = makeView(bd, [{ min: 5, max: 200, lut: 'Grays', invert: true }, { min: 0, max: 100, lut: 'Grays', invert: false }]);
      const base = makeView(bd, [{ min: 0, max: 255, lut: 'Grays', invert: false }]);
      const p = spec.resolve(inv, { xshrink: 2, yshrink: 2, method }, [0, 1]);
      assert.ok(Array.isArray(p.disp) && p.disp.length === 2 && p.disp[0].invert === true, 'the invert flag of every channel is journaled');
      assert.equal(spec.resolve(inv, p, [0, 1]), p, 'idempotent');
      const live = fingerprint(await spec.run(inv, p, null, io));
      const replay = fingerprint(await spec.run(base, p, null, io));
      assert.deepEqual(replay.ch.map((c) => c[0]), live.ch.map((c) => c[0]), bd + '-bit ' + method + ': a replay on the baseline display gives the same pixels');
      if (method === 'sum' && bd === 16) assert.deepEqual(replay.ch.map((c) => c[1] && c[1].max), live.ch.map((c) => c[1] && c[1].max), 'and the same display maximum');
    }
  }
  // sensitive: without the journaled params the invert flag would matter
  const inv = makeView(8, [{ min: 5, max: 200, lut: 'Grays', invert: true }]);
  const noInv = makeView(8, [{ min: 5, max: 200, lut: 'Grays', invert: false }]);
  const a = fingerprint(await spec.run(inv, spec.resolve(inv, { xshrink: 2, yshrink: 2, method: 'average' }), null, io));
  const b = fingerprint(await spec.run(noInv, spec.resolve(noInv, { xshrink: 2, yshrink: 2, method: 'average' }), null, io));
  assert.notDeepEqual(a.ch[0][0], b.ch[0][0], 'the test can tell an inverted LUT from a plain one');
  t.close();
});

await test('Arrange Channels: grey-or-colour and the display ranges are copied into the params (resolve)', async () => {
  const t = await boot({ channels: 1 });
  const spec = t.page.IJOpRegistry.get('arrangeChannels');
  assert.equal(typeof spec.resolve, 'function');
  const grey = makeView(8, [{ min: 10, max: 101, lut: 'Grays', invert: false }, { min: 20, max: 102, lut: 'Grays', invert: false }, { min: 30, max: 103, lut: 'Grays', invert: false }], 3);
  const coloured = makeView(8, [{ min: 0, max: 255, lut: '#ff0000', invert: false }, { min: 0, max: 255, lut: '#00ff00', invert: false }, { min: 0, max: 255, lut: '#0000ff', invert: false }], 3);
  const p = spec.resolve(grey, { order: [2, 0] }, [0, 1, 2]);
  assert.deepEqual(J(p.disp.map((d) => d.grey)), [true, true, true]);
  const live = fingerprint(await spec.run(grey, p, null, io));
  // a replay on a document whose display is now coloured and whose ranges differ gives the colours the operator saw
  const replay = fingerprint(await spec.run(coloured, p, null, io));
  assert.deepEqual(replay, live);
  assert.deepEqual(live.ch.map((c) => [c[1].min, c[1].max]), [[30, 103], [10, 101]], 'the ranges follow the channels');
  assert.deepEqual(live.ch.map((c) => c[2]), ['#ff0000', '#00ff00'], 'all-grey channels take the colour of their new slot');
  // the other way round: coloured channels stay coloured whatever the replaying display says
  const pc = spec.resolve(coloured, { order: [2, 0] }, [0, 1, 2]);
  assert.deepEqual(J(pc.disp.map((d) => d.grey)), [false, false, false]);
  const r2 = fingerprint(await spec.run(grey, pc, null, io));
  assert.deepEqual(r2.ch.map((c) => c[2]), [null, null], 'coloured channels are left alone');
  t.close();
});

await test('Arrange Channels (same arrays, same geometry) keeps the selection and the view; a crop still drops them', async () => {
  const t = await boot({ channels: 3 });
  await t.open();
  const A = t.activeId();
  const roi = { type: 'rect', x: 3, y: 2, w: 8, h: 6 };
  t.shell.opts.onRoi(roi, { final: true, source: 'draw' });
  const fits = () => t.shell.calls.filter((c) => c[0] === 'fit').length;
  const f0 = fits();
  const res = await t.engine('doc.run', { docId: A, op: 'arrangeChannels', params: { order: [2, 0] }, roi: null, channel: 'all' });
  assert.deepEqual([res.changed.sizeChanged, res.changed.sameGeometry], [true, true]);
  await t.runCommand('colorArrangeChannels', { order: '21' });
  assert.deepEqual(J(t.shell.activeRoi), roi, 'the selection is still there after the reorder');
  assert.equal(fits(), f0, 'and the view was not re-fitted');
  await t.runCommand('editUndo');
  assert.deepEqual(J(t.shell.activeRoi), roi, 'undo keeps the selection too');
  assert.equal(fits(), f0);
  const crop = await t.engine('doc.run', { docId: A, op: 'crop', params: {}, roi, channel: 'all' });
  assert.deepEqual([crop.changed.sizeChanged, !!crop.changed.sameGeometry], [true, false]);
  t.close();
});

await test('Split Channels of a composite shown in grey mode gives grey LUTs (ChannelSplitter)', async () => {
  const t = await boot({ channels: 2 });
  await t.open();
  const A = t.activeId();
  await t.runCommand('colorSplitChannels');
  const coloured = (await t.docs()).filter((d) => /^C\d-/.test(d.name));
  assert.equal(coloured.length, 2);
  assert.ok(coloured.every((d) => d.channels[0].display.lut !== 'Grays'), 'a composite in colour mode keeps the channel colours');
  await activate(t, A);
  await t.engine('doc.setDisplay', { docId: A, mode: 'gray' });
  await t.runCommand('colorSplitChannels');
  const seen = new Set(coloured.map((d) => d.docId));
  const grey = (await t.docs()).filter((d) => /^C\d-/.test(d.name) && !seen.has(d.docId));
  assert.equal(grey.length, 2);
  assert.ok(grey.every((d) => d.channels[0].display.lut === 'Grays' && !d.channels[0].display.invert), 'grey mode: Grays');
  t.close();
});

await test('api.state().doc shows the display the operator sees after a display change', async () => {
  const probeSource = `(function () {
    IJApp.extend({ pkg: 'coloc', commands: [{ id: 'zProbe', menu: ['Analyze'], order: 990, run: async (api) => {
      const st = api.state();
      globalThis.__probe = JSON.parse(JSON.stringify({ doc: st.doc.channels.map((c) => c.display), docs: st.docs.map((d) => d.channels.map((c) => c.display)) }));
    } }] });
  })();`;
  const t = await boot({ channels: 2, pageSources: { 'ij-cmds-coloc.js': probeSource } });
  await t.open();
  const A = t.activeId();
  const inv = (await t.docs())[0].channels[0].display.invert;
  assert.equal(!!inv, false);
  await t.runCommand('zProbe');
  assert.equal(t.page.__probe.doc[0].invert, false);
  await t.runCommand('lutInvert');
  await t.runCommand('zProbe');
  assert.equal(t.page.__probe.doc[0].invert, true, 'Invert LUT shows in api.state().doc');
  assert.equal(t.page.__probe.docs[0][0].invert, true, 'and in docs');
  assert.equal(t.page.__probe.doc[1].invert, false, 'only on the active channel');
  t.close();
});

console.log(failed ? failed + ' failed' : 'ij integration: ok');
if (failed) process.exit(1);
