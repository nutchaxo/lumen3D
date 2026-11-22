// End-to-end macros of the Advanced Studio (DOCS/studio-advanced/macros/INTEGRATION.md §9.4): real macro text through the real
// page controller (ij-app.js + ij-cmds-macro.js), the real worker (ij-worker.js → ij-engine.js + ij-macro-lang.js + ij-proc-macro.js)
// and the real run() bridge (ij-macro-cmds.js), in the Node harness. Nothing is stubbed but the browser chrome.
//
// Run: node tests/js/test_ij_macro_e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { boot, until, sleep, DIR, MACRO_FILES } from './ij_harness.mjs';

for (const f of MACRO_FILES) {
  if (!fs.existsSync(path.join(DIR, f))) { console.log('SKIP test_ij_macro_e2e: ' + f + ' is absent'); process.exit(0); }
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (err) { console.error('FAIL ' + name); throw err; }
}
const arr = (x) => Array.from(x);
// macro sources are joined from lines; BS = the escaped backslash of a macro string literal ("\\Update:" in the macro text is the
// one-backslash Log command at run time)
const lines = (...l) => l.join('\n');
const BS = '\\\\';
const page = (t) => vm.runInContext('IJMacroPage', t.page);
const tr = (t, k, p) => t.ctx.i18n.t(k, p);

async function fresh() {
  const t = await boot({ channels: 1, immediateMessages: true });
  await t.open();
  assert.ok(!t.failedPackages().has('macro'), 'package macro loads in the worker');
  const net = [];
  for (const w of t.workers) {
    for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']) w.far[k] = function () { net.push(k); throw new Error(k + ' is forbidden'); };
  }
  t.net = net;
  return t;
}
async function run(t, src, o) {
  const r = await t.runMacro(src, o);
  assert.ok(r && typeof r === 'object', 'a RunResult');
  return r;
}
async function okRun(t, src) {
  const r = await run(t, src);
  assert.equal(r.ok, true, 'macro ran: ' + JSON.stringify(r.error));
  return r;
}
const info = (t, docId) => t.engine('doc.info', { docId });
const docByName = async (t, name) => (await t.docs()).find((d) => d.name === name);
const plane = async (t, docId, z) => arr((await t.engine('doc.tile', { docId, channel: 0, level: 0, tx: 0, ty: 0, pos: { z: z || 0, t: 0 } })).data);
const quoted = (s) => '"' + String(s).replace(/"/g, '\\"') + '"';

await test('a pixel loop over a 256×256 16-bit image writes the engine planes; the image born in the run has no undo step', async () => {
  const t = await fresh();
  const r = await okRun(t, lines(
    'newImage("loop", "16-bit black", 256, 256, 1);',
    'for (y = 0; y < 256; y++) for (x = 0; x < 256; x++) setPixel(x, y, x * 256 + y);',
    'print(getPixel(10, 20));',
    'print(bitDepth());'));
  assert.deepEqual(arr(t.macroLog()), ['2580', '16']);
  const d = await docByName(t, 'loop');
  assert.ok(d, 'the new image is open');
  const px = await plane(t, d.docId);
  assert.equal(px.length, 256 * 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) if (px[y * 256 + x] !== x * 256 + y) assert.fail('pixel ' + x + ',' + y + ' = ' + px[y * 256 + x]);
  assert.equal((await info(t, d.docId)).undoDepth, 0, 'no undo step for an image born in the run');
  assert.ok(arr(r.changedDocs).includes(d.docId), 'changedDocs names it');
  assert.equal(t.IJApp.apiFor('macro').macro.running(), null, 'the lane ended');
  assert.deepEqual(t.net, []);
  t.close();
});

await test('run("Gaussian Blur...", "sigma=2") equals the interactive command with sigma 2; one undo step restores the bytes', async () => {
  const t = await fresh();
  const fig = t.activeId();
  await t.runCommand('imageDuplicate', {});
  await until(async () => (await t.docs()).length === 2, 'the duplicate');
  const dup = (await t.docs()).find((d) => d.docId !== fig).docId;
  const pre = await plane(t, fig);
  assert.deepEqual(await plane(t, dup), pre, 'identical copies');
  await until(() => t.activeId() === dup, 'the duplicate is active');
  await t.runCommand('filterGaussian', { sigma: 2 });
  const interactive = await plane(t, dup);
  assert.notDeepEqual(interactive, pre, 'the interactive blur changed the copy');
  const depth0 = (await info(t, fig)).undoDepth;
  await okRun(t, lines('selectImage(' + quoted((await info(t, fig)).name) + ');', 'run("Gaussian Blur...", "sigma=2");'));
  assert.deepEqual(await plane(t, fig), interactive, 'the macro result equals the interactive one');
  assert.equal((await info(t, fig)).undoDepth, depth0 + 1, 'one undo step');
  await t.engine('doc.undo', { docId: fig });
  assert.deepEqual(await plane(t, fig), pre, 'Undo restores the pre-run bytes');
  t.close();
});

await test('run("Add...", "value=10 stack") adds to every slice of a z-stack', async () => {
  const t = await fresh();
  await okRun(t, lines(
    'newImage("zs", "8-bit ramp", 64, 8, 4);',
    'for (s = 1; s <= 4; s++) { setSlice(s); setPixel(0, 0, s); }',
    'setSlice(2);',
    'run("Add...", "value=10 stack");'));
  const d = await docByName(t, 'zs');
  for (let z = 0; z < 4; z++) {
    const px = await plane(t, d.docId, z);
    assert.equal(px[0], z + 1 + 10, 'slice ' + (z + 1) + ' (0,0)');
    assert.equal(px[32], Math.floor(32 * 256 / 64) + 10, 'slice ' + (z + 1) + ' ramp');
  }
  t.close();
});

await test('setBatchMode(true) + newImage: no document left, nothing stored for it', async () => {
  const t = await fresh();
  await t.flush();
  const docs0 = (await t.docs()).map((d) => d.docId).sort();
  const sessions = async () => {
    const out = [];
    for (const s of await t.store.shared.list()) {
      const g = await t.store.shared.load(s.key);
      out.push(JSON.stringify(Object.keys((g && g.docs) || {}).sort().map((k) => [k, (g.docs[k].journal || []).length])));
    }
    return out.join('|');
  };
  const stored0 = await sessions();
  const r = await okRun(t, lines(
    'setBatchMode(true);',
    'newImage("tmp", "8-bit white", 32, 32, 1);',
    'run("Invert");',
    'print(getPixel(1, 1));',
    'print(nImages);'));
  assert.deepEqual(arr(t.macroLog()), ['0', '2']);
  assert.deepEqual((await t.docs()).map((d) => d.docId).sort(), docs0, 'the batch image is gone at the end');
  assert.ok(!t.shell.images.filter(Boolean).some((i) => i.name === 'tmp'), 'it was never shown');
  await t.flush();
  assert.equal(await sessions(), stored0, 'no session entry, no journal entry');
  assert.ok(arr(r.undo.changed).every((id) => !docs0.includes(id)), 'no image open before the run changed');
  t.close();
});

await test('one macro run = one undo step per image it changed; undo of each restores it', async () => {
  const t = await fresh();
  const fig = t.activeId();
  await t.runCommand('imageDuplicate', {});
  await until(async () => (await t.docs()).length === 2, 'the duplicate');
  const dup = (await t.docs()).find((d) => d.docId !== fig).docId;
  const nf = (await info(t, fig)).name, nd = (await info(t, dup)).name;
  const pre = { fig: await plane(t, fig), dup: await plane(t, dup) };
  const d0 = { fig: (await info(t, fig)).undoDepth, dup: (await info(t, dup)).undoDepth };
  const r = await okRun(t, lines(
    'selectImage(' + quoted(nf) + ');',
    'setPixel(0, 0, 7); run("Invert"); run("Gaussian Blur...", "sigma=1");',
    'selectImage(' + quoted(nd) + ');',
    'for (i = 0; i < 10; i++) setPixel(i, 1, 200);',
    'run("Add...", "value=3");'));
  assert.deepEqual(arr(r.undo.changed).sort(), [fig, dup].sort());
  assert.equal((await info(t, fig)).undoDepth, d0.fig + 1, 'one step for the first image');
  assert.equal((await info(t, dup)).undoDepth, d0.dup + 1, 'one step for the second image');
  const post = await plane(t, fig);
  await t.engine('doc.undo', { docId: fig });
  await t.engine('doc.undo', { docId: dup });
  assert.deepEqual(await plane(t, fig), pre.fig, 'first image restored');
  assert.deepEqual(await plane(t, dup), pre.dup, 'second image restored');
  await t.engine('doc.redo', { docId: fig });
  assert.deepEqual(await plane(t, fig), post, 'Redo brings the result back');
  t.close();
});

await test('abort within 100 ms keeps what the run wrote as one undo step: endless loop (uncommitted working copy), wait(), an interactive dialog', async () => {
  const t = await fresh();
  const fig = t.activeId();
  const sel = 'selectImage(' + quoted((await info(t, fig)).name) + ');';
  const pre = await plane(t, fig);
  const d0 = (await info(t, fig)).undoDepth;
  const M = t.IJApp.apiFor('macro').macro;
  const abortAfter = async (src, ms) => {
    const pending = t.runMacro(src);
    await until(() => M.running(), 'the run started');
    await sleep(ms);
    const t0 = performance.now();
    page(t).abort();
    const r = await pending;
    return { r, dt: performance.now() - t0 };
  };
  let x = await abortAfter(lines(sel, 'setPixel(0, 0, 99);', 'i = 0;', 'while (true) i++;'), 150);
  assert.equal(x.r.aborted, true);
  assert.ok(x.dt < 100, 'the loop stopped in ' + x.dt.toFixed(1) + ' ms');
  assert.equal(M.running(), null, 'the lane is gone');
  assert.equal((await plane(t, fig))[0], 99, 'the uncommitted write of the aborted run is kept');
  assert.equal((await info(t, fig)).undoDepth, d0 + 1, 'as one undo step');
  x = await abortAfter(lines(sel, 'setPixel(1, 0, 98);', 'wait(10000);'), 150);
  assert.equal(x.r.aborted, true);
  assert.ok(x.dt < 100, 'wait() stopped in ' + x.dt.toFixed(1) + ' ms');
  assert.equal((await plane(t, fig))[1], 98);
  // run() without options shows the dialog to the operator (who never answers here); the abort closes it
  let closed = false;
  t.script.dialogs.push(() => new Promise(() => {}));
  const before = t.log.dialogSpecs.length;
  const pending = t.runMacro(lines(sel, 'setPixel(2, 0, 97);', 'run("Gaussian Blur...");', 'print("never");'));
  await until(() => t.log.dialogSpecs.length > before, 'the dialog is open');
  const spec = t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
  assert.ok(spec.signal, 'the dialog carries the lane signal');
  spec.signal.addEventListener('abort', () => { closed = true; });
  assert.equal(M.running().paused, true, 'the lane is paused while the operator answers');
  const t0 = performance.now();
  page(t).abort();
  const r = await pending;
  assert.ok(performance.now() - t0 < 100, 'the run ended within 100 ms');
  assert.equal(r.aborted, true);
  assert.equal(closed, true, 'the dialog was closed');
  assert.equal(M.running(), null, 'the lane is gone');
  assert.ok(!arr(t.macroLog()).includes('never'));
  const px = await plane(t, fig);
  assert.deepEqual([px[0], px[1], px[2]], [99, 98, 97], 'every run kept its write');
  assert.equal((await info(t, fig)).undoDepth, d0 + 3, 'one step per run');
  for (let k = 0; k < 3; k++) await t.engine('doc.undo', { docId: fig });
  assert.deepEqual(await plane(t, fig), pre, 'three undos restore the original');
  t.close();
});

await test('errors: ImageJ\'s texts and lines, the translated refusals, the Macro Error window', async () => {
  const t = await fresh();
  const r1 = await run(t, lines('x = 1;', 'run("Nope");'));
  assert.equal(r1.ok, false);
  assert.equal(r1.error.message, 'Unrecognized command: "Nope"');
  assert.equal(r1.error.line, 2);
  const r2 = await run(t, 'run("Open from Library...");');
  assert.equal(r2.ok, false);
  assert.equal(r2.error.message, tr(t, 'err.macRefused', { command: 'Open from Library...', reason: tr(t, 'err.macReasonLibrary') }));
  const r3 = await run(t, lines('a = 2;', 'b = a + ;', ''));
  assert.equal(r3.ok, false);
  assert.equal(r3.error.line, 2);
  assert.ok(typeof r3.error.dialogText === 'string' && r3.error.dialogText.indexOf(r3.error.message) >= 0, 'ImageJ\'s dialog text');
  assert.ok(t.panel('macroError'), 'the Macro Error window is open');
  const r4 = await run(t, lines('print("before");', 'open("/x.tif");'));
  assert.equal(r4.ok, false);
  assert.equal(r4.error.message, tr(t, 'err.macFileLater', { name: 'open("/x.tif")' }), 'the translated "not available yet" text');
  assert.equal(r4.error.line, 2);
  const r5 = await run(t, 'exec("ls");');
  assert.equal(r5.error.message, tr(t, 'err.macExec'));
  // GenericDialog's macro-mode texts (1.54p): a number that is not one; a choice not in the list (named by its key, as labels.get() does)
  const r6 = await run(t, 'run("Gaussian Blur...", "sigma=abc");');
  assert.equal(r6.error.message, lines('Numeric value expected in run() function', ' ', '\t Dialog box title: "Gaussian Blur..."', '\t Key: "sigma"',
    '\t Value or variable name: "abc"'));
  const r7 = await run(t, 'run("Rotate... ", "angle=15 grid=1 interpolation=Nope");');
  assert.equal(r7.error.message, '"Nope" is not a valid choice for "interpolation"');
  // a single image's Z Project reads the site's dataset: refused before its dialog
  const r8 = await run(t, 'run("Z Project...", "projection=[Max Intensity]");');
  assert.equal(r8.error.message, tr(t, 'err.macRefused', { command: 'Z Project...', reason: tr(t, 'err.macReasonLibrary') }));
  t.close();
});

await test('print and \\Update: in the Log; getInfo("log") agrees', async () => {
  const t = await fresh();
  await okRun(t, lines('print("a");', 'print("' + BS + 'Update:b");', 'print("c");'));
  assert.deepEqual(arr(t.macroLog()), ['b', 'c']);
  await okRun(t, lines('print("' + BS + 'Clear");', 'print("d");', 's = getInfo("log");', 'print(lengthOf(s) + " " + startsWith(s, "d"));'));
  assert.deepEqual(arr(t.macroLog()), ['d', '2 1'], 'getInfo("log") = "d\n"');
  assert.ok(t.panel('macroLog'), 'the Log window is open');
  t.close();
});

await test('makeRectangle + getStatistics; the selection reaches the page', async () => {
  const t = await fresh();
  await okRun(t, lines(
    'newImage("st", "8-bit black", 64, 64, 1);',
    'setColor(100);',
    'fillRect(10, 10, 20, 20);',
    'makeRectangle(10, 10, 20, 20);',
    'getStatistics(area, mean, min, max);',
    'print(area + " " + mean + " " + min + " " + max);'));
  assert.deepEqual(arr(t.macroLog()), ['400 100 100 100']);
  const d = await docByName(t, 'st');
  assert.ok(t.IJApp.apiFor('macro').macro.mirror().selections[d.docId], 'the page holds the selection');
  t.close();
});

await test('setThreshold on a hidden (batch) image: getThreshold, Convert to Mask uses it, the Threshold window never opens', async () => {
  const t = await fresh();
  await okRun(t, lines(
    'setBatchMode(true);',
    'newImage("th", "8-bit ramp", 256, 4, 1);',
    'setThreshold(10, 100);',
    'getThreshold(l, u);',
    'print(l + " " + u);',
    'run("Convert to Mask");',
    'print(getPixel(5, 0) + " " + getPixel(50, 0) + " " + getPixel(200, 0));'));
  const log = arr(t.macroLog());
  assert.equal(log[0], '10 100');
  const [a, b, c] = log[1].split(' ').map(Number);
  assert.equal(a, c, 'both outside the range alike');
  assert.ok([a, b].includes(255) && [a, b].includes(0), 'a binary mask from the range: ' + log[1]);
  assert.ok(!t.shell.windows.floats.has('threshold'), 'the Threshold window never opened');
  t.close();
});

// ImageJ 1.54p refuses a comparison as a bare function argument ("')' expected", checked on the jar): the extra parentheses are ImageJ's
await test('nResults / getResult after run("Measure"); setResult + updateResults reach the Results table', async () => {
  const t = await fresh();
  await okRun(t, lines('run("Measure");', 'print(nResults);', 'print((getResult("Mean", 0) == getValue("Mean")));', 'setResult("X", 0, 5);', 'updateResults();'));
  assert.deepEqual(arr(t.macroLog()), ['1', '1']);
  const res = t.IJApp.apiFor('macro').macro.results.get();
  assert.ok(arr(res.headings).includes('X'), 'the Results table has a column X: ' + arr(res.headings).join(','));
  assert.equal(res.columns.X[0], 5);
  t.close();
});

await test('Stack.setPosition / Stack.setSlice / getSliceNumber on a hyperstack', async () => {
  const t = await fresh();
  await okRun(t, lines(
    'newImage("hs", "8-bit ramp", 32, 32, 3, 4, 5);',
    'print(nSlices);',
    'Stack.setPosition(2, 3, 4);',
    'print(getSliceNumber());',
    'Stack.setSlice(2);',
    'print(getSliceNumber());',
    'Stack.getPosition(c, z, f);',
    'print(c + " " + z + " " + f);'));
  // ImageJ's stack index: (t-1)·nC·nZ + (z-1)·nC + c
  assert.deepEqual(arr(t.macroLog()), ['60', String(3 * 12 + 2 * 3 + 2), String(3 * 12 + 1 * 3 + 2), '2 2 4']);
  t.close();
});

await test('call("ij.IJ.pad", 7, 3) and a refused call(); no network call in any run', async () => {
  const t = await fresh();
  await okRun(t, 'print(call("ij.IJ.pad", 7, 3));');
  assert.deepEqual(arr(t.macroLog()), ['007']);
  const r = await run(t, 'call("java.lang.System.exit", 0);');
  assert.equal(r.ok, false);
  assert.equal(r.error.message, tr(t, 'err.macCallRefused', { target: 'java.lang.System.exit' }));
  assert.deepEqual(t.net, []);
  t.close();
});

console.log(`test_ij_macro_e2e: ${passed} passed`);
process.exit(0);
