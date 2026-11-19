// The shared-code fixes and the extension-API gaps closed after wave 3's first review (DOCS/studio-advanced/w1/ORCHESTRATOR-DECISIONS.md):
//   api.dropBlob and the pinning of the blobs a preview refers to, `gesture: true` commands, the modifiers handed to run(api, { alt, shift }),
//   api.setDisplayMode, a compute with no document (`docless`), the `display: '16/32'` reset of a pixel op, the Conversions options in effect,
//   the 8-bit display stretch of colorValue, Repeat Command's pre-fill rule, the last command, the entry flow's bit depth, the Window menu label,
//   the About box — through tests/js/ij_harness.mjs (the REAL ij-worker.js and engine behind a fake Worker, the real controller).
//
// Run: node tests/js/test_ij_ext_api4.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, until, sleep, J, EN } from './ij_harness.mjs';
import { ROOT } from './harness.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (err) { console.error('FAIL ' + name); throw err; }
}
const arr = (a) => Array.from(a);
const reject = async (p, code, what) => {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert.ok(err, what + ': it must reject');
  assert.equal(err.code, code, what + ': ' + (err && err.code));
  return err;
};
const throws = (fn, code, what) => {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, what + ': it must throw');
  assert.equal(err.code, code, what + ': ' + (err && err.code));
};
function* walk(el) { yield el; for (const c of el.children || []) yield* walk(c); }

// ── a package of the test: ops of the worker, commands of the page ──────────────────────────────────────────────
const FIJI_PROC = `
(function (root) {
  'use strict';
  const R = root.IJOpRegistry;
  R.define('blobSum', { kind: 'compute', version: 1, run: (view, params) => { let s = 0; for (const v of params.data) s += v; return { s, n: params.data.length }; } });
  R.define('blobPaint', { kind: 'pixel', version: 1, prepare(view, c, p) { return { apron: { x: 0, y: 0 }, fn: (src) => { const o = src.data.slice(); for (let i = 0; i < o.length && i < p.data.length; i++) o[i] = p.data[i]; return o; } }; } });
  R.define('docFree', { kind: 'compute', version: 1, docless: true, run: (view, params) => ({ viewIsNull: view === null, twice: params.a * 2 }) });
  R.define('needsDoc', { kind: 'compute', version: 1, run: (view) => ({ w: view.width }) });
  const plus50 = (src) => { const o = src.data.slice(); for (let i = 0; i < o.length; i++) o[i] = o[i] + 50; return o; };
  R.define('resetAll', { kind: 'pixel', version: 1, display: true, prepare() { return { apron: { x: 0, y: 0 }, fn: plus50 }; } });
  R.define('reset1632', { kind: 'pixel', version: 1, display: '16/32', prepare() { return { apron: { x: 0, y: 0 }, fn: plus50 }; } });
})(typeof self !== 'undefined' ? self : globalThis);
`;
const FIJI_CMDS = `
(function () {
  'use strict';
  globalThis.__order = [];
  IJApp.extend({
    pkg: 'fiji',
    commands: [
      { id: 'zHand', menu: ['Process'], order: 990, run(api) { globalThis.__api = api; } },
      { id: 'zSetPending', menu: ['Process'], order: 991, run(api) {
        api.setPending({ labelKey: 'dlg.ok', commit: async () => { globalThis.__order.push('commit'); }, cancel() { globalThis.__order.push('cancel'); } });
      } },
      { id: 'zGest', menu: ['Process'], order: 992, gesture: true, run() { globalThis.__order.push('gesture'); } },
      { id: 'zPlain', menu: ['Process'], order: 993, run() { globalThis.__order.push('plain'); } },
      { id: 'zMods', menu: ['Process'], order: 994, run(api, mods) { globalThis.__mods = mods; } },
      { id: 'zRep', menu: ['Process'], order: 995, run(api) { globalThis.__rep = (globalThis.__rep || 0) + 1; } },
      { id: 'zNested', menu: ['Process'], order: 996, run: (api) => api.runCommand('zRep') }
    ]
  });
})();
`;
const FREE = { 'ij-cmds-sel.js': '', 'ij-cmds-ov.js': '', 'ij-cmds-io.js': '', 'ij-cmds-thr.js': '' };
const SOURCES = { pageSources: Object.assign({ 'ij-cmds-fiji.js': FIJI_CMDS, 'ij-proc-fiji.js': FIJI_PROC }, FREE), workerSources: { 'ij-proc-fiji.js': FIJI_PROC } };
async function start(extra) {
  const t = await boot(Object.assign({}, SOURCES, extra || {}));
  await t.open();
  await t.runCommand('zHand');
  return { t, api: t.page.__api, id: t.activeId() };
}
const b16 = (w, h, data, name) => ({ name: name || 'six', width: w, height: h, bitDepth: 16, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' }, channels: [{ data: Uint16Array.from(data), name: 'C1', color: '#ffffff' }] });

// ═════════════ api.dropBlob and the pinning of a preview's blob ═════════════
await test('dropBlob gives a blob up; a blob a preview refers to is pinned against the memory reclaim until it is dropped or the preview cancelled; compute / estimate do not pin', async () => {
  const { t, api, id } = await start({ budgetBytes: 8 * 1048576 });
  await t.api(null).state();
  const a = await api.putBlob(new Uint8Array(3 * 1048576).fill(1));
  // pinned by a preview (no document uses it)
  await t.engine('doc.preview', { docId: id, seq: 1, op: 'blobPaint', params: { data: a }, roi: null, channel: 0, level: 0, x0: 0, y0: 0, x1: 2, y1: 2 });
  // a second blob that does not fit: the pinned one is NOT evicted, the new one is refused
  await reject(api.putBlob(new Uint8Array(6 * 1048576).fill(2)), 'IJ_OVER_BUDGET', 'the pinned blob stays, memory is short');
  const again = await t.engine('doc.compute', { docId: id, op: 'blobSum', params: { data: a }, roi: null, channel: 0 });
  assert.equal(again.n, 3 * 1048576, 'the blob is still there');
  assert.equal(await api.dropBlob(a), true, 'dropBlob with the marker object');
  assert.equal(await api.dropBlob(a.blobRef), false, 'a second drop: nothing to drop (the id as a string is accepted)');
  await reject(t.engine('doc.compute', { docId: id, op: 'blobSum', params: { data: a }, roi: null, channel: 0 }), 'IJ_NO_BLOB', 'dropped');
  const b = await api.putBlob(new Uint8Array(6 * 1048576).fill(2));
  assert.equal(typeof b.blobRef, 'string', 'the room is free again');
  await reject(api.dropBlob(7), 'IJ_BAD_ARGS', 'not a blobRef');
  await reject(api.dropBlob({}), 'IJ_BAD_ARGS', 'no blobRef');
  // a blob a committed step uses stays (its document holds it)
  const c = await api.putBlob(new Uint8Array(70000).fill(3));
  await t.engine('doc.run', { docId: id, op: 'blobPaint', params: { data: c }, roi: null, channel: 0 });
  assert.equal(await api.dropBlob(c), false, 'in use by a document');
  t.close();
});

await test('a compute or an estimate leaves its blob reclaimable; cancelling the preview unpins what the preview pinned', async () => {
  const { t, api, id } = await start({ budgetBytes: 8 * 1048576 });
  const a = await api.putBlob(new Uint8Array(3 * 1048576).fill(1));
  await t.engine('doc.compute', { docId: id, op: 'blobSum', params: { data: a }, roi: null, channel: 0 });
  // not pinned: a blob that does not fit gives it up
  const b = await api.putBlob(new Uint8Array(6 * 1048576).fill(2));
  await reject(t.engine('doc.compute', { docId: id, op: 'blobSum', params: { data: a }, roi: null, channel: 0 }), 'IJ_NO_BLOB', 'the computed blob was reclaimed');
  await api.dropBlob(b);
  // pinned by a preview, then the page cancels its preview
  const c = await api.putBlob(new Uint8Array(3 * 1048576).fill(3));
  await t.engine('doc.preview', { docId: id, seq: 5, op: 'blobPaint', params: { data: c }, roi: null, channel: 0, level: 0, x0: 0, y0: 0, x1: 2, y1: 2 });
  await reject(api.putBlob(new Uint8Array(6 * 1048576).fill(2)), 'IJ_OVER_BUDGET', 'pinned while the preview is up');
  api.cancelPreview();
  await until(async () => { try { const d = await api.putBlob(new Uint8Array(6 * 1048576).fill(2)); return !!d; } catch (_) { return false; } }, 'the pin was released');
  t.close();
});

// ═════════════ gesture commands and modifiers ═════════════
await test('a `gesture: true` command starts in the very task of the click, before the pending floating paste is committed; any other waits for the commit', async () => {
  const { t } = await start();
  const A = t.IJApp;
  assert.equal(A.COMMANDS.find((c) => c.id === 'zGest').gesture, true);
  assert.equal(A.COMMANDS.find((c) => c.id === 'zPlain').gesture, false);
  // (registration is refused once mounted: validated on a page that is not open)
  const t0 = await boot(SOURCES);
  throws(() => t0.IJApp.extend({ pkg: 'sel', commands: [{ id: 'zBadGesture', menu: ['Process'], order: 1, gesture: 'yes', run() {} }] }), 'IJ_BAD_ARGS', 'gesture must be a boolean');
  t0.close();
  const order = () => arr(t.page.__order);
  await t.runCommand('zSetPending');
  let p = t.shell.opts.onCommand(t.cmd('zGest'), { source: 'menu' });
  assert.deepEqual(order(), ['gesture'], 'run() was called synchronously, nothing awaited first');
  await p;
  assert.deepEqual(order(), ['gesture', 'commit'], 'the paste is committed after the command');
  t.page.__order.length = 0;
  await t.runCommand('zSetPending');
  p = t.shell.opts.onCommand(t.cmd('zPlain'), { source: 'menu' });
  assert.deepEqual(order(), [], 'an ordinary command waits for the commit');
  await p;
  assert.deepEqual(order(), ['commit', 'plain']);
  t.close();
});

await test('closing the Studio cancels a pending floating paste (its timer and blob refs are released)', async () => {
  const { t } = await start();
  await t.runCommand('zSetPending');
  assert.deepEqual(arr(t.page.__order), []);
  t.close();
  assert.deepEqual(arr(t.page.__order), ['cancel'], 'dispose() called the cancel of the pending state');
});

await test('run(api, { alt, shift, source }): the keys of the click reach the command; api.runCommand(id, { alt }) passes them on', async () => {
  const { t, api } = await start();
  await t.runCommand('zMods');
  assert.deepEqual(J(t.page.__mods), { alt: false, shift: false, source: 'menu' });
  await t.runCommand('zMods', undefined, { mods: { alt: true } });
  assert.deepEqual(J(t.page.__mods), { alt: true, shift: false, source: 'menu' });
  await t.runCommand('zMods', undefined, { mods: { shift: true, alt: true }, source: 'key' });
  assert.deepEqual(J(t.page.__mods), { alt: true, shift: true, source: 'key' });
  await api.runCommand('zMods', { shift: true });
  assert.deepEqual(J(t.page.__mods), { alt: false, shift: true, source: 'api' });
  await api.runCommand('zMods');
  assert.deepEqual(J(t.page.__mods), { alt: false, shift: false, source: 'api' });
  t.close();
});

// ═════════════ setDisplayMode ═════════════
await test('setDisplayMode: composite / color / gray ("grayscale" accepted), kept by the engine, announced as a display change; a bad mode or image rejects', async () => {
  const { t, api, id } = await start({ channels: 2 });
  const mode = async () => (await t.engine('doc.info', { docId: id })).mode;
  const events = [];
  api.on('doc', (e) => events.push(e.kind));
  assert.equal(await mode(), 'composite');
  await api.setDisplayMode(id, 'gray');
  assert.equal(await mode(), 'gray');
  assert.ok(events.includes('display'));
  await api.setDisplayMode(id, 'color');
  assert.equal(await mode(), 'color');
  await api.setDisplayMode(id, 'grayscale');
  assert.equal(await mode(), 'gray', '"grayscale" is the gray mode');
  await api.setDisplayMode(id, 'composite');
  assert.equal(await mode(), 'composite');
  await reject(api.setDisplayMode(id, 'rgb'), 'IJ_BAD_ARGS', 'unknown mode');
  await reject(api.setDisplayMode(999999, 'gray'), 'IJ_BAD_ARGS', 'unknown image');
  t.close();
});

await test('Image › Lookup Tables on a multichannel image shown in Grayscale: every channel takes the table and the image switches to Color (LutLoader.showLut); otherwise only the active channel', async () => {
  const { t, id } = await start({ channels: 2 });
  const info = async () => (await t.engine('doc.info', { docId: id }));
  const luts = async () => (await t.docs()).find((d) => d.docId === id).channels.map((c) => c.display.lut);
  await t.runCommand('lutFire');
  assert.equal((await info()).mode, 'composite');
  await until(async () => (await luts())[0] === 'Fire', 'the active channel has the table');
  const before = await luts();
  assert.equal(before[0], 'Fire'); assert.notEqual(before[1], 'Fire', 'a composite keeps the other channels as they are');
  await t.api(null).setDisplayMode(id, 'gray');
  await t.runCommand('lutIce');
  await until(async () => (await info()).mode === 'color', 'the image is in Color mode');
  await until(async () => (await luts()).every((l) => l === 'Ice'), 'every channel has the table');
  t.close();
});

// ═════════════ a compute with no document ═════════════
await test('compute with { docless: true } runs an op that declares `docless` with view = null; any other op is refused', async () => {
  const { t, api } = await start();
  const res = await api.compute('docFree', { a: 21 }, { docless: true, labelKey: 'op.compute' });
  assert.deepEqual(J(res), { viewIsNull: true, twice: 42 });
  const e0 = t.log.errors.length;
  assert.equal(await api.compute('needsDoc', {}, { docless: true }), null, 'the refusal is reported, nothing runs');
  assert.ok(t.log.errors.length > e0, 'an error dialog told the operator');
  // the engine refuses it too (IJ_BAD_ARGS), and a docless op still works with a document
  await reject(t.engine('doc.compute', { docId: null, op: 'needsDoc', params: {}, roi: null, channel: null }), 'IJ_BAD_ARGS', 'a compute op that needs a document');
  assert.equal((await t.engine('doc.compute', { docId: t.activeId(), op: 'docFree', params: { a: 1 }, roi: null, channel: 0 })).viewIsNull, false);
  // the registry validates the new spec fields
  const R = t.page.IJOpRegistry;
  throws(() => R.define('badDocless', { kind: 'pixel', version: 1, docless: true, prepare() {} }), 'IJ_BAD_ARGS', 'only a compute op can be docless');
  throws(() => R.define('badDisplay', { kind: 'pixel', version: 1, display: 'always', prepare() {} }), 'IJ_BAD_ARGS', 'display: true | false | "16/32"');
  t.close();
});

// ═════════════ spec.display: '16/32' ═════════════
await test("spec.display '16/32': a 16 / 32-bit image gets its display range reset as part of the undo step, an 8-bit one keeps it; `true` resets both", async () => {
  const { t, api } = await start();
  const eight = t.activeId();
  const sixteen = await api.addDoc(b16(8, 8, Array.from({ length: 64 }, (_, i) => i)));
  const disp = async (docId) => (await t.engine('doc.info', { docId })).channels[0].display;
  await api.setDisplay(sixteen, 0, { min: 0, max: 1000 });
  await api.setDisplay(eight, 0, { min: 10, max: 100 });
  await t.engine('doc.run', { docId: sixteen, op: 'reset1632', params: {}, roi: null, channel: 0 });
  const after = await disp(sixteen);
  assert.deepEqual([after.min, after.max], [50, 113], '16-bit: reset to the data range (resetMinAndMax)');
  await t.engine('doc.run', { docId: eight, op: 'reset1632', params: {}, roi: null, channel: 0 });
  const kept = await disp(eight);
  assert.deepEqual([kept.min, kept.max], [10, 100], '8-bit: the range stays');
  // undo puts the range back with the pixels
  await t.engine('doc.undo', { docId: sixteen });
  const back = await disp(sixteen);
  assert.deepEqual([back.min, back.max], [0, 1000], 'the display reset is part of the undo step');
  await t.engine('doc.run', { docId: eight, op: 'resetAll', params: {}, roi: null, channel: 0 });
  const all = await disp(eight);
  assert.notDeepEqual([all.min, all.max], [10, 100], 'display: true resets an 8-bit image too');
  t.close();
});

// ═════════════ Edit › Options › Conversions are in effect; invert of ImageJ's float order ═════════════
await test('Image › Type honours "Scale when converting"; Invert honours "Full range 16-bit inversions"; 32-bit Invert is max − (v − min) in float arithmetic', async () => {
  const { t, api } = await start();
  const edit = t.api('edit');
  const id16 = await api.addDoc(b16(2, 2, [0, 100, 1000, 65535], 'depth16'));
  const pix = async (docId) => arr(await t.pixels(docId, 0));
  await t.runCommand('typeBit8');
  assert.deepEqual(await pix(id16), [0, 0, 4, 255], 'scaled: (v - min) · 256 / (max - min + 1), rounded');
  await t.runCommand('editUndo');
  edit.settings.set('conv.scale', false);
  await t.runCommand('typeBit8');
  assert.deepEqual(await pix(id16), [0, 100, 255, 255], 'unscaled: clamped to 255');
  await t.runCommand('editUndo');
  assert.equal((await t.docs()).find((d) => d.docId === id16).bitDepth, 16);
  await t.runCommand('editInvert');
  assert.deepEqual(await pix(id16), [65535, 65435, 64535, 0], 'about the data range');
  await t.runCommand('editUndo');
  edit.settings.set('conv.fullRange16', true);
  await t.runCommand('editInvert');
  assert.deepEqual(await pix(id16), [65535, 65435, 64535, 0], 'the data spans 0..65535 here: full range and data range agree');
  await t.runCommand('editUndo');
  const part = await api.addDoc(b16(3, 1, [100, 150, 200], 'part16'));
  await t.runCommand('editInvert');
  assert.deepEqual(await pix(part), [65435, 65385, 65335], '65535 − v');
  edit.settings.set('conv.fullRange16', false);
  await t.runCommand('editUndo');
  await t.runCommand('editInvert');
  assert.deepEqual(await pix(part), [200, 150, 100]);
  // FloatProcessor.process(INVERT): v2 = max2 - (v1 - min2), every step a float
  const flt = await api.addDoc({ name: 'f32', width: 3, height: 1, bitDepth: 32, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' }, channels: [{ data: Float32Array.from([0.1, 0.7, 1.3]), name: 'F', color: '#ffffff' }] });
  await t.runCommand('editInvert');
  const f = Math.fround;
  assert.deepEqual(await pix(flt), [f(f(1.3) - f(f(0.1) - f(0.1))), f(f(1.3) - f(f(0.7) - f(0.1))), f(f(1.3) - f(f(1.3) - f(0.1)))]);
  // once the display range was changed (B&C), the image inverts about THAT range (FloatProcessor.invert reads getMin()/getMax()), and an undo / redo replays the same pixels
  const flt2 = await api.addDoc({ name: 'f32b', width: 3, height: 1, bitDepth: 32, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' }, channels: [{ data: Float32Array.from([0.1, 0.7, 1.3]), name: 'F', color: '#ffffff' }] });
  await api.setDisplay(flt2, 0, { min: -10, max: 120 });
  await t.runCommand('editInvert');
  const want = [0.1, 0.7, 1.3].map((v) => f(f(120) - f(f(v) - f(-10))));
  assert.deepEqual(await pix(flt2), want);
  await t.runCommand('editUndo');
  await t.runCommand('editRedo');
  assert.deepEqual(await pix(flt2), want, 'redo replays the resolved display range');
  t.close();
});

await test('colorValue on an 8-bit image searches the look-up table stretched over the display range (ByteProcessor.setMinAndMax)', async () => {
  const { t, api, id } = await start();
  t.api('edit').settings.set('colors.foreground', 'gray');
  await api.setDisplay(id, 0, { lut: 'Grays', invert: false, min: 0, max: 255 });
  assert.equal(await api.colorValue(id, 0, 'foreground'), 128, 'full range: the grey 128 is entry 128');
  await api.setDisplay(id, 0, { min: 50, max: 200 });
  assert.equal(await api.colorValue(id, 0, 'foreground'), 125, 'entry 125 shows the table position 256·75/150 = 128');
  t.close();
});

// ═════════════ Repeat Command and the last command ═════════════
await test('only Repeat Command pre-fills dialogs; a command run from elsewhere (Find Commands) computes its defaults afresh; text fields and defaults that changed are never put back', async () => {
  const { t, api } = await start();
  const spec = () => t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
  const field = (s, fid) => s.fields.find((f) => f.id === fid);
  // Duplicate, then rename the active copy, then run Duplicate through api.runCommand (the Find Commands path)
  await t.runCommand('imageDuplicate', { title: 'first copy' });
  const copy = t.activeId();
  await api.rename(copy, 'other');
  await api.runCommand('imageDuplicate');
  assert.equal(field(spec(), 'title').value, 'other-1', 'the title is computed from the image on screen, not the last run\'s answer');
  // a remembered number comes back through Repeat Command only
  await t.runCommand('filterGaussian', { sigma: 3.5 });
  assert.equal(field(spec(), 'sigma').value, 2);
  await api.runCommand('filterGaussian');
  assert.equal(field(spec(), 'sigma').value, 2, 'api.runCommand: the default, not the last value');
  await t.runCommand('filterGaussian', { sigma: 4 });
  await t.runCommand('procRepeatCommand');
  assert.equal(field(spec(), 'sigma').value, 4, 'Repeat Command: the last value (ImageJ keeps it in a static field)');
  // a field that opts out is never put back
  assert.ok(t.IJApp);
  t.close();
});

await test('a command another command started does not become Repeat Command\'s command; one started from a panel does', async () => {
  const { t, api } = await start();
  await t.runCommand('zNested');
  assert.equal(t.page.__rep, 1, 'the inner command ran');
  assert.deepEqual(J(api.lastCommand()), { id: 'zNested' }, 'ImageJ remembers the command the operator chose');
  await api.runCommand('zPlain');
  assert.deepEqual(J(api.lastCommand()), { id: 'zPlain' }, 'a call from outside any command (Find Commands) records');
  t.close();
});

// ═════════════ the Window menu, the About box, the Histogram dialog ═════════════
await test('imageSizeString: ImageWindow.getImageSize (K / MB / GB, half-even, ".0" dropped)', async () => {
  const { t } = await start();
  const S = t.IJApp.imageSizeString;
  assert.deepEqual([512, 1536, 2560, 64 * 1024, 1048575].map(S), ['0K', '2K', '2K', '64K', '1024K']);
  assert.deepEqual([1024 * 1024 * 5, 1024 * 10000, 1024 * 1048576].map(S), ['5MB', '10MB', '1GB']);
  t.close();
});

await test('Help › About: the "About this Advanced view" section, the Results window paragraph, the pixel source paragraph and every deviation that stays', async () => {
  const { t } = await start();
  await t.runCommand('helpAbout');
  const win = arr(t.shell.windows.floats.values()).find((w) => /^about-/.test(w.id));
  assert.ok(win, 'the About window opened');
  const text = arr(walk(win.spec.content)).map((n) => n.textContent || '').join('\n');
  for (const key of ['about.thisTitle', 'about.resultsWindow', 'about.pixelSource', 'about.limitsTitle']) assert.ok(text.includes(EN.about[key.split('.')[1]]), key);
  const dev = Object.keys(EN.about.dev);
  assert.equal(dev.length, 12, 'twelve deviations');
  for (const k of dev) assert.ok(text.includes(EN.about.dev[k]), 'about.dev.' + k);
  assert.ok(/Window > Results/.test(EN.about.resultsWindow) && /CSV/.test(EN.about.resultsWindow));
  assert.ok(/original TIFF/.test(EN.about.pixelSource) && /processed volume/.test(EN.about.pixelSource));
  t.close();
});

await test('Analyze › Histogram of a 32-bit image: typing X_min / X_max unticks "Use pixel value range" through the documented set({ id: value }) form', async () => {
  const { t, api } = await start();
  const f32 = await api.addDoc({ name: 'float', width: 4, height: 4, bitDepth: 32, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' }, channels: [{ data: Float32Array.from({ length: 16 }, (_, i) => i * 0.5), name: 'F', color: '#ffffff' }] });
  let patch = null;
  t.script.dialogs.push((s) => { patch = {}; s.onChange({ xMin: 1 }, (p) => Object.assign(patch, p), 'xMin'); return null; });
  await t.runCommand('analyzeHistogram');
  assert.deepEqual(J(patch), { useRange: false });
  assert.ok(f32 !== undefined);
  t.close();
});

// ═════════════ the Duplicate title helper, the scale bar's raster limit ═════════════
await test('Scale Bar burnt into the pixels: a label too large to rasterise is refused (IJ_OV_LABEL_TOO_LARGE, and with no canvas IJ_OV_LABEL_CANVAS: never burnt without its text); the font size field is bounded by twice the image', async () => {
  const t = await boot({ channels: 2, firePreview: false });
  await t.open();
  const id = t.activeId();
  const ui = t.page.IJOvUi;
  assert.equal(ui.MAX_RASTER_PIXELS, 33554432);
  throws(() => ui.rasterText('1000 µm', 5000, false, false, 0, 20000), 'IJ_OV_LABEL_TOO_LARGE', 'about 150 Mpx of label');
  throws(() => ui.rasterText('1000 µm', 5000, false, false, 90, 20000), 'IJ_OV_LABEL_TOO_LARGE', 'the same, rotated');
  ui.measure = () => 41;
  ui.rasterText = () => ({ w: 6, h: 4, data: new Uint8Array(24).fill(1), ax: 1, ay: 1 });
  let spec = null;
  const values = { width: 10, height: 5, thickness: 3, fontSize: 9, color: 'White', background: 'None', location: 'Lower Left', horizontal: true, vertical: false, bold: false, hideText: false, serif: false, overlay: false };
  t.script.dialogs.push((s) => { spec = s; return values; });
  await t.runCommand('toolsScaleBar');
  const f = spec.fields.find((x) => x.id === 'fontSize');
  assert.equal(f.max, 2 * Math.max(40, 30), 'bounded by twice the larger side of the image');
  // the refusal reaches the operator as a translated message
  ui.rasterText = () => { const e = new Error('too large'); e.code = 'IJ_OV_LABEL_TOO_LARGE'; throw e; };
  const errs = await t.runCommand('toolsScaleBar', values, { expectError: true });
  assert.equal(errs[0].message, EN.err.ovLabelTooLarge);
  ui.rasterText = () => null;
  const errs2 = await t.runCommand('toolsScaleBar', values, { expectError: true });
  assert.equal(errs2[0].message, EN.err.ovLabelCanvas, 'no drawing surface: refused too');
  assert.ok(id !== null);
  t.close();
});

await test('a package that failed in the worker only greys out its own parts: Analyze Particles without ij-proc-ana.js skips the "Show:" image with a message', async () => {
  const f = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'ij-wave3', 'ana', 'particles.json'), 'utf8'));
  const BIN = new Uint8Array(Buffer.from(f.input.data.b64, 'base64'));
  const t = await boot({ channels: 1, brokenPackages: ['ij-proc-ana.js'] });
  const create = t.page.document.createElement;
  t.page.document.createElement = (tag) => { const e = create(tag); let v = ''; Object.defineProperty(e, 'textContent', { get: () => v, set: (x) => { v = x; if (x === '') e.children.length = 0; }, configurable: true }); return e; };
  await t.open();
  assert.ok(t.failedPackages().has('ana'));
  const id = await t.api('ana').addDoc({ name: 'particles', width: 72, height: 56, bitDepth: 8, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' },
    channels: [{ data: BIN.slice(), name: 'c', color: '#ffffff' }] }, { sessionKey: (await t.store.shared.list())[0].key });
  await until(() => t.activeId() === id, 'the image is on screen');
  const docs0 = (await t.docs()).length;
  await t.runCommand('analyzeParticles', { show: 'masks', display: true, clear: true });
  assert.equal((await t.docs()).length, docs0, 'no mask image: its operation lives in the package that failed');
  assert.ok(t.log.status.some((s) => /ana/.test(String(s))), 'the status line says which tools could not be loaded');
  t.close();
});

console.log('ij ext api 4: ' + passed + ' groups ok');
