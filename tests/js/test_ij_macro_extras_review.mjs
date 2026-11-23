// Regressions of the review of the macro extras (DOCS/studio-advanced/macros/REVIEW-extras.md):
//   • Process › Math › Macro with a loop is time-sliced and cancellable: an endless loop in a pixel run or in the first run ends on the
//     op's cancel (the engine then answers again), and a newer preview stops an endless older one;
//   • Math › Macro with a selection and a code that names getPixel (ImageJ 1.54p ImageMath + PlugInFilterRunner, probed on the jar):
//     getPixel in the first run → the whole plane, unmasked; named but run only per pixel → zeros outside the bounding rectangle;
//   • an installed set reused by the worker only for the same TEXT (two texts with one FNV-1a 32 hash);
//   • ROI Manager buttons recorded only when their action went through (Delete answered No / Cancel, Rename cancelled or unchanged,
//     Update without a selection, AND with one row, Properties cancelled); the Show All / Labels boxes record ImageJ's lines;
//   • a macro's Install… is never stored, and a stored installed set restored at a Studio open runs no code before the operator picks
//     a row;
//   • B&C Auto: no qualifying bin resets the range, records nothing and starts the halving over (IJOps.autoContrast `reset`);
//   • AutoRun: two rules, as MacroInstaller has (editor install: file name startsWith; Install…: path indexOf).
//
// Run: node tests/js/test_ij_macro_extras_review.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { engineContext, engineClient, xrt, withExtras, standIn, DIR } from './ij_macro_worker_extras_support.mjs';
import { boot, until, sleep, MACRO_FILES } from './ij_harness.mjs';

for (const f of MACRO_FILES) {
  if (!fs.existsSync(path.join(DIR, f))) { console.log('SKIP test_ij_macro_extras_review: ' + f + ' is absent'); process.exit(0); }
}
if (standIn()) { console.log('SKIP test_ij_macro_extras_review: ij-macro-lang.js has no IJMacro.pixelProgram / prepare'); process.exit(0); }

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (err) { console.error('FAIL ' + name); throw err; }
}
const J = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const deq = (a, b, m) => assert.deepEqual(J(a), J(b), m);
const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ': no answer within ' + ms + ' ms (the worker thread is blocked)')), ms))]);
const cal = { pixelWidth: 1, pixelHeight: 1, pixelDepth: 1, unit: 'pixel' };
const gray8 = (W, H, f) => {
  const p = new Uint8Array(W * H);
  for (let i = 0; i < p.length; i++) p[i] = f(i);
  return { name: 'img', width: W, height: H, bitDepth: 8, nZ: 1, nT: 1, calibration: cal, channels: [{ name: 'c', color: '#ffffff', planes: [p] }] };
};

// ═════════════════════════════ Math › Macro in the engine ═════════════════════════════
const sb = engineContext();

await test('Math › Macro: an endless loop in a pixel run or in the first run ends on the op\'s cancel; the engine answers again', async () => {
  const c = engineClient(sb);
  // the client numbers its requests 1, 2, … and does not hand the numbers out: counted here
  let issued = 0;
  const call0 = c.call;
  c.call = (cmd, args) => { issued++; return call0(cmd, args); };
  try {
    const id = await c.open(gray8(16, 16, (i) => i & 255));
    for (const code of ['if (x==3) { while (true) {} }', 'k=0; while (true) {}', 'for (i=0; i<1e15; i++) { v=v+0; }', 'do { k=1; } while (true)']) {
      const before = c.doc(id).channels[0].planes[0].slice();
      const run = c.call('doc.run', { docId: id, op: 'macroMath', params: { code } });
      const runId = issued;
      await sleep(150);
      c.call('cancel', { targetId: runId });
      const m = await within(run, 8000, code);
      assert.equal(m.ok, false, code + ' must not complete');
      assert.equal(m.error.code, 'IJ_CANCELLED', code + ': ' + m.error.code + ' ' + m.error.message);
      deq(Array.from(c.doc(id).channels[0].planes[0]), Array.from(before), 'a cancelled step changes nothing');
    }
    const ok = await within(c.call('doc.run', { docId: id, op: 'macroMath', params: { code: 'v=v*2' } }), 8000, 'v=v*2 after the cancels');
    assert.ok(ok.ok, 'the engine runs the next step');
    assert.equal(c.doc(id).channels[0].planes[0][5], 10);
  } finally { c.dispose(); }
});

await test('Math › Macro preview: a newer preview stops an endless older one (supersession seen inside the loop)', async () => {
  const c = engineClient(sb);
  try {
    const id = await c.open(gray8(16, 16, (i) => i & 255));
    const region = { x0: 0, y0: 0, x1: 16, y1: 16, level: 0 };
    const p1 = c.call('doc.preview', Object.assign({ docId: id, seq: 1, op: 'macroMath', params: { code: 'k=0; while (true) {}' } }, region));
    await sleep(150);
    const p2 = c.call('doc.preview', Object.assign({ docId: id, seq: 2, op: 'macroMath', params: { code: 'v=255-v' } }, region));
    const m1 = await within(p1, 8000, 'the older preview');
    assert.ok(m1.ok && m1.result.dropped === true, 'the older preview is dropped: ' + JSON.stringify(m1.error || m1.result));
    const m2 = await within(p2, 8000, 'the newer preview');
    assert.ok(m2.ok && !m2.result.dropped, 'the newer preview answers');
  } finally { c.dispose(); }
});

await test('Math › Macro with a selection and getPixel: whole plane when the first run calls it, zeros outside the rectangle otherwise', async () => {
  // the jar (IJ.run(imp, "Macro...", …), 12×8 8-bit, pixel i = 100 + i, Roi(3,2,5,4))
  const W = 12, H = 8, src = (i) => 100 + i;
  const roi = { type: 'rect', x: 3, y: 2, w: 5, h: 4 };
  const c = engineClient(sb);
  try {
    let id = await c.open(gray8(W, H, src));
    let m = await c.call('doc.run', { docId: id, op: 'macroMath', params: { code: 'v=getPixel(x,y)+1' }, roi });
    assert.ok(m.ok, JSON.stringify(m.error));
    deq(Array.from(c.doc(id).channels[0].planes[0]), Array.from({ length: W * H }, (_, i) => src(i) + 1), 'every pixel +1, the rectangle ignored');
    // undo restores the whole plane (the step covered it)
    await c.ok('doc.undo', { docId: id });
    deq(Array.from(c.doc(id).channels[0].planes[0]), Array.from({ length: W * H }, (_, i) => src(i)));
    id = await c.open(gray8(W, H, src));
    m = await c.call('doc.run', { docId: id, op: 'macroMath', params: { code: 'if (x>0) v=getPixel(x-1,y)+1; else v=7;' }, roi });
    assert.ok(m.ok, JSON.stringify(m.error));
    const want = Array.from({ length: W * H }, (_, i) => {
      const x = i % W, y = (i / W) | 0;
      return x >= 3 && x < 8 && y >= 2 && y < 6 ? src(i - 1) + 1 : 0;
    });
    deq(Array.from(c.doc(id).channels[0].planes[0]), want, 'the rectangle computed, every other pixel 0');
    // a code without getPixel keeps the selection (only the rectangle changes)
    id = await c.open(gray8(W, H, src));
    m = await c.call('doc.run', { docId: id, op: 'macroMath', params: { code: 'v=v+1' }, roi });
    assert.ok(m.ok);
    const pl = c.doc(id).channels[0].planes[0];
    assert.equal(pl[0], 100); assert.equal(pl[2 * W + 3], src(2 * W + 3) + 1);
  } finally { c.dispose(); }
});

await test('B&C Auto: no qualifying bin is ContrastAdjuster\'s reset (flag `reset`), the halving starts over at 5000', () => {
  const hist = new Uint32Array(256).fill(4);   // 1024 pixels: threshold = ⌊1024 / t⌋ exceeds 4 once t ≤ 204
  let thr = 0, k = 0, r;
  for (; k < 20; k++) { r = sb.IJOps.autoContrast(hist, 1024, thr); if (r.reset) break; assert.equal(r.reset, false); thr = r.nextAutoThreshold; }
  assert.ok(r.reset, 'a click finds no bin');
  assert.equal(r.nextAutoThreshold, 156, 'the 6th click (5000, 2500, 1250, 625, 312, 156): threshold 6, no bin above it');
  assert.equal(sb.IJOps.autoContrast(hist, 1024, 0).nextAutoThreshold, 5000);
});

await test('AutoRun: the editor\'s Install Macros tests the file name with startsWith, Install… the path with indexOf', () => {
  const P = sb.IJMacroParams;
  const src = 'macro "AutoRun" { print(1); }\n';
  assert.notEqual(P.installPlan(src, { fileName: 'MyStartupMacros.ijm', origin: 'editor' }).autoRun, null, 'MacroInstaller.setFileName: startsWith');
  assert.equal(P.installPlan(src, { fileName: 'StartupMacros.ijm', origin: 'editor' }).autoRun, null);
  assert.equal(P.installPlan(src, { fileName: 'MyStartupMacros.ijm', origin: 'file' }).autoRun, null, 'MacroInstaller.run: path.indexOf');
  assert.equal(P.installPlan(src, { fileName: 'a.ijm', path: '/StartupMacros/a.ijm', origin: 'macro' }).autoRun, null, 'a folder named StartupMacros');
  assert.notEqual(P.installPlan(src, { fileName: 'a.ijm', path: '/Data/a.ijm', origin: 'file' }).autoRun, null);
});

// ═════════════════════════════ installed sets in the worker ═════════════════════════════
function fnvHex(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}
await test('two installed sets with the same 32-bit hash: each runs its own text', async () => {
  const A = 'macro "Go" { print("set 5uzx"); }\n', B = 'macro "Go" { print("set g2ad"); }\n';
  assert.equal(fnvHex(A), fnvHex(B), 'the pair collides');
  const t = withExtras(await xrt());
  try {
    const entry = (source) => ({ entry: { kind: 'installed', set: 'installed', hash: fnvHex(source), source, name: 'Go', index: 0, start: null } });
    const logOf = (r) => J(t.W.IJMacroProto.log.apply([], r.log));
    let r = await t.runX('', entry(A));
    deq(logOf(r), ['set 5uzx']);
    r = await t.runX('', entry(B));
    deq(logOf(r), ['set g2ad'], 'the second set is prepared from its own text');
  } finally { t.close(); }
});

// ═════════════════════════════ the page ═════════════════════════════
const t = await boot({ channels: 1, immediateMessages: true });
const actions = [];
t.api('macro').on('action', (ev) => actions.push(J(ev)));
await t.open();
const X = t.extras();
const page = () => vm.runInContext('IJMacroPage', t.page);
const rmOps = () => actions.filter((a) => a.kind === 'rm').map((a) => a.op);

await test('ROI Manager: a refused, cancelled or unchanged button records nothing; one that went through records its line', async () => {
  const api = t.api('edit');
  api.setRoi({ type: 'rect', x: 2, y: 2, w: 6, h: 6 });
  await t.rmAction('Add');
  api.setRoi({ type: 'rect', x: 4, y: 4, w: 5, h: 5 });
  await t.rmAction('Add');
  await t.rmAction('Deselect');
  actions.length = 0;
  // Delete with no row selected asks "Delete all?": No and Cancel delete nothing (RoiManager.java:561-565)
  t.script.nextAsk = 'no';
  await t.rmAction('Delete');
  t.script.nextAsk = 'cancel';
  await t.rmAction('Delete');
  // Rename: cancelled, then the same name (RoiManager.java:659-663)
  await t.rmAction('Select', { index: 0 });
  actions.length = 0;
  await t.rmAction('Rename', { dialogs: [null] });
  await t.rmAction('Rename', { dialogs: [{}] });
  // Properties cancelled
  await t.rmAction('Properties', { dialogs: [null] });
  // AND with one row (RoiManager.java:1786-1789)
  await t.rmAction('AND');
  // Update without a selection on the image (RoiManager.java:629-631)
  api.setRoi(null);
  await t.rmAction('Update');
  deq(rmOps(), [], 'nothing recorded');
  // one that goes through
  await t.rmAction('Rename', { dialogs: [{ name: 'cell A' }] });
  deq(rmOps(), ['Rename']);
  assert.equal(actions.pop().name, 'cell A');
  await t.rmAction('Deselect');
  actions.length = 0;
  t.script.nextAsk = 'yes';
  await t.rmAction('Delete');
  deq(rmOps(), ['Delete'], 'Delete all → Yes records Delete');
});

await test('ROI Manager boxes: Show All records Show All / Show None; Labels records only ImageJ\'s lines', async () => {
  await t.rmAction('Show All', { on: false });
  await t.rmAction('Labels', { on: false });
  actions.length = 0;
  await t.rmAction('Labels', { on: true });       // showAll off → "Show All with labels" (the box turns Show All on in ImageJ)
  await t.rmAction('Show All', { on: true });     // labels on → still "Show All" (RoiManager.java:305-311)
  await t.rmAction('Labels', { on: false });      // show all on → "Show All without labels"
  await t.rmAction('Show All', { on: false });
  await t.rmAction('Labels', { on: false });      // both off → nothing
  await t.rmAction('Labels', { on: true });
  await t.rmAction('Show All', { on: false });
  actions.length = 0;
  await t.rmAction('Labels', { on: false });      // labels off with show all off → nothing (:317-319)
  deq(rmOps(), []);
});

await test('a macro\'s Install… lasts for this open only; a stored set restored at an open runs no code until a row is picked', async () => {
  const evil = 'function f() { print("side effect at prepare"); return 1; }\nvar g = f();\nmacro "A" { print("A " + g); }\n';
  page()._internals.reset();
  await X.removeInstalled();
  const res = await X.rpc('install.set', { name: 'x.ijm', path: '/Data/x.ijm', source: evil });
  assert.equal(res.count, 1);
  deq(X.installed().map((r) => r.label), ['A'], 'installed for this open');
  assert.equal(await X.macroRecord('installed'), null, 'never stored');
  deq(t.macroLog(), [], 'install.set runs nothing');
  await X.removeInstalled();
  // a set a macro stored under the old rule is not restored
  await X.put('macros', { id: 'installed', name: 'x.ijm', source: evil, at: 1, origin: 'macro' });
  page()._internals.reset();
  await X.startup();
  deq(X.installed(), [], 'a macro-stored set is not restored');
  // an operator's stored set comes back as rows, its globals untouched until the first entry run
  await X.put('macros', { id: 'installed', name: 'x.ijm', source: evil, at: 2, origin: 'file' });
  page()._internals.reset();
  await X.startup();
  await sleep(50);
  deq(X.installed().map((r) => r.label), ['A']);
  deq(t.macroLog(), [], 'the restore runs no code');
  await t.runInstalled('A');
  await until(() => t.macroLog().length >= 2, 'the entry run', 10000);
  deq(t.macroLog(), ['side effect at prepare', 'A 1'], 'the globals are prepared by the first entry run');
  await X.removeInstalled();
});

t.close();
console.log(passed + ' tests passed');
