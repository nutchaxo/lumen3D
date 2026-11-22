// Regressions of the integration review of the Advanced Studio's macros (DOCS/studio-advanced/macros/REVIEW-integration.md): real macro
// text through the real page, worker and run() bridge in the Node harness. Expected values are those of ImageJ 1.54p (ij-1.54p.jar,
// -batch), noted beside each case; the boot figure counts in nImages here (one image more than the jar's).
//
// Run: node tests/js/test_ij_macro_review.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, until, DIR, MACRO_FILES } from './ij_harness.mjs';

for (const f of MACRO_FILES) {
  if (!fs.existsSync(path.join(DIR, f))) { console.log('SKIP test_ij_macro_review: ' + f + ' is absent'); process.exit(0); }
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (err) { console.error('FAIL ' + name); throw err; }
}
const lines = (...l) => l.join('\n');
async function fresh(o) {
  const t = await boot(Object.assign({ channels: 1 }, o || {}));
  await t.open();
  assert.ok(!t.failedPackages().has('macro'), 'package macro loads in the worker');
  return t;
}
/** Runs `src` on a fresh Studio → { r, log }. */
async function run(src, o) {
  const t = await fresh(o);
  try {
    const r = await t.runMacro(src);
    return { r, log: Array.from(t.macroLog()) };
  } finally { t.close(); }
}
async function expectLog(src, want) {
  const { r, log } = await run(src);
  assert.equal(r.ok, true, 'macro ran: ' + JSON.stringify(r.error));
  assert.deepEqual(log, want);
}

// ─────────────────────────────── ImageJ fidelity ───────────────────────────────

await test('Set Scale from a macro sets the pixel width (ScaleDialog: scaleChanged || IJ.macroRunning())', async () => {
  // jar: mm 0.2 0.2 / 25
  await expectLog(lines('newImage("a","8-bit ramp",40,20,1);', 'run("Set Scale...","distance=10 known=2 pixel=1 unit=mm");',
    'getPixelSize(u,pw,ph); print(u+" "+pw+" "+ph);', 'makeRectangle(0,0,5,5); print(getValue("Area"));'), ['mm 0.2 0.2', '1']);
});

await test('Properties… reads channels / slices / frames, voxel_depth and frame (ImageProperties)', async () => {
  // jar: 0.5 0.5 2 pixels / 3 / 2 3 1
  await expectLog(lines('newImage("a","8-bit ramp",8,4,6);',
    'run("Properties...","channels=1 slices=6 frames=1 pixel_width=0.5 pixel_height=0.5 voxel_depth=2 frame=[3 sec]");',
    'getVoxelSize(w,h,d,u); print(w+" "+h+" "+d+" "+u); print(Stack.getFrameInterval());',
    'run("Properties...","channels=2 slices=3 frames=1"); getDimensions(W,H,c,z,t); print(c+" "+z+" "+t);'),
  ['0.5 0.5 2 pixels', '3', '2 3 1']);
  // jar: a sec interval within [1/30, 2] also sets the frame rate; another unit leaves it; depth= is the legacy slices=
  await expectLog(lines('newImage("a","8-bit ramp",8,4,3);',
    'run("Properties...","channels=1 slices=3 frames=1 pixel_width=1 pixel_height=1 voxel_depth=1 frame=[0.5 sec]"); print(Stack.getFrameRate());',
    'run("Properties...","channels=1 slices=3 frames=1 pixel_width=1 pixel_height=1 voxel_depth=1 frame=10ms");',
    'print(Stack.getFrameRate()+" "+Stack.getFrameInterval()); Stack.getUnits(x,y,z,tu,v); print(tu);',
    'run("Properties...","channels=1 depth=1 frames=3"); getDimensions(W,H,c,z,t); print(c+" "+z+" "+t);'),
  ['2', '2 10', 'ms', '1 1 3']);
});

await test('Scale… follows Scaler.showDialog in macro mode (width/height win, "-" fields, interpolation None)', async () => {
  await expectLog(lines('newImage("a","8-bit ramp",40,20,1); run("Scale...","width=10 height=10 interpolation=None create title=c");',
    'print(getWidth()+" "+getHeight());'), ['10 10']);
  await expectLog(lines('newImage("a","8-bit ramp",40,20,1); run("Scale...","x=- y=- width=10 height=4 interpolation=None create title=d");',
    'print(getWidth()+" "+getHeight());'), ['10 4']);
  // jar: 16 0 32 32 (no interpolation= in a macro means None)
  await expectLog(lines('newImage("a","8-bit ramp",8,4,1); run("Scale...","x=2 y=2 create title=b");',
    'print(getWidth()+" "+getPixel(1,0)+" "+getPixel(2,0)+" "+getPixel(3,0));'), ['16 0 32 32']);
});

await test('getValue("<column>[ limit][ raw]") reads its own options, never the Set Measurements state (IJ.getValue)', async () => {
  // jar: 127.5 191.5 127.5 191.5
  await expectLog(lines('newImage("a","8-bit ramp",256,4,1); setThreshold(128,255);',
    'run("Set Measurements...","mean limit redirect=None decimal=3"); print(getValue("Mean")); print(getValue("Mean limit"));',
    'run("Set Measurements...","mean redirect=None decimal=3"); print(getValue("Mean")); print(getValue("Mean limit"));'),
  ['127.5', '191.5', '127.5', '191.5']);
  // jar: 100 5 NaN 0
  await expectLog(lines('newImage("a","8-bit ramp",10,10,1); setVoxelSize(0.5,0.5,1,"um");',
    'print(getValue("Area raw")); print(getValue("X raw")); print(getValue("MeanX"));', 'makeRectangle(1,1,4,4); print(getValue("selection.width"));'),
  ['100', '5', 'NaN', '0']);
});

await test('Image Calculator… without create changes image 1; with create it opens "Result of …"', async () => {
  // jar (one image fewer): a b 2 255 / Result of a b 3
  await expectLog(lines('newImage("a b","8-bit ramp",8,4,1); newImage("c","8-bit white",8,4,1); selectImage("c");',
    'run("Image Calculator...","image1=[a b] operation=Max image2=c"); print(getTitle()+" "+nImages+" "+getPixel(0,0));',
    'selectImage("c"); run("Image Calculator...","image1=[a b] operation=Min image2=c create"); print(getTitle()+" "+nImages);'),
  ['a b 3 255', 'Result of a b 4']);
});

await test('Enhance Contrast… process_all normalises every slice of a stack', async () => {
  // jar: 127 255 ×3
  await expectLog(lines('newImage("a","8-bit black",8,4,3); for(s=1;s<=3;s++){setSlice(s);setPixel(0,0,10*s);setPixel(1,0,20*s);} setSlice(1);',
    'run("Enhance Contrast...","saturated=0 normalize process_all"); for(s=1;s<=3;s++){setSlice(s);print(getPixel(0,0)+" "+getPixel(1,0));}'),
  ['127 255', '127 255', '127 255']);
  // the stack histogram is not built yet: refused with a message, never ignored
  const { r } = await run('newImage("a","8-bit ramp",8,4,3); run("Enhance Contrast...","saturated=0.35 use");');
  assert.equal(r.ok, false);
  assert.match(String(r.error && r.error.message), /not available/);
});

await test('commands ImageJ runs as no-ops on a single image do not stop the macro; Statistics measures one plane', async () => {
  // jar: before / after 1 / b / 1 112 32
  await expectLog(lines('newImage("a","8-bit ramp",8,4,1); print("before"); run("Hyperstack to Stack"); print("after "+(nImages-1));',
    'run("Remove Slice Labels"); print("b"); run("Statistics"); print(nResults+" "+getResult("Mean",0)+" "+getResult("Voxels",0));'), ['before', 'after 1', 'b', '1 112 32']);
});

await test('setRGBWeights reaches run("8-bit") (ColorProcessor.setWeightingFactors)', async () => {
  // jar: 100
  await expectLog('newImage("a","RGB black",8,4,1); setPixel(0,0,0x6496c8); setRGBWeights(1,0,0); run("8-bit"); print(getPixel(0,0));', ['100']);
});

await test('composite + "slices": the substring keeps the plane on screen; frame rate and interval are independent; small fixes', async () => {
  // jar: 10 10 11 10 10 10
  await expectLog(lines('newImage("a","8-bit black",8,8,2,3,1); run("Set...","value=10 stack"); Stack.setDisplayMode("composite");',
    'Stack.setPosition(1,2,1); run("Add...","value=1 slices"); s=""; for(i=1;i<=nSlices;i++){setSlice(i); s=s+getPixel(0,0)+" ";} print(s);'),
  ['10 10 11 10 10 10 ']);
  // jar: 0 5 5 2
  await expectLog(lines('newImage("a","8-bit black",8,8,3); Stack.setFrameRate(5); print(Stack.getFrameInterval()); print(Stack.getFrameRate());',
    'Stack.setFrameInterval(2); print(Stack.getFrameRate()); print(Stack.getFrameInterval());'), ['0', '5', '5', '2']);
  let x = await run('newImage("a","8-bit ramp",8,4,1); print("x"); Stack.getStatistics(n,mean); print(n);');
  assert.equal(x.r.ok, false); assert.deepEqual(x.log, ['x']); assert.match(String(x.r.error.message), /Stack required/);
  x = await run('selectWindow("nope");');
  assert.equal(x.r.error.message, 'No window with the title "nope" found.');
  // jar: 1 Composite / 0 (the sources close unless keep)
  await expectLog(lines('newImage("r","8-bit ramp",8,4,1); newImage("g","8-bit ramp",8,4,1); run("Merge Channels...", "c1=r c2=g create");',
    'print(getTitle()+" "+isOpen("r"));', 'newImage("r","8-bit ramp",8,4,1); newImage("g","8-bit ramp",8,4,1); run("Merge Channels...", "c1=r c2=g create keep");',
    'print(getTitle()+" "+isOpen("r"));'), ['Composite 0', 'Composite 1']);
});

// ─────────────────────────────── robustness ───────────────────────────────

await test('run("Repeat Command") never reaches a command refused to macros (a file of the PC)', async () => {
  const t = await fresh();
  try {
    await t.runCommand('fileSaveTiff', {});
    await until(() => t.saved.length === 1, 'the operator\'s save');
    const r = await t.runMacro('run("Repeat Command"); print("done");');
    assert.equal(r.ok, false);
    assert.match(String(r.error && r.error.message), /not available yet/);
    assert.equal(t.saved.length, 1, 'no second file saved by the macro');
    assert.deepEqual(Array.from(t.macroLog()), []);
  } finally { t.close(); }
});

await test('a page method that reports its error (rename to a blank title) fails the request at once, with no modal box', async () => {
  const t = await fresh();
  try {
    const asks0 = t.script.asks.length;
    const t0 = Date.now();
    const r = await t.runMacro('rename(" ");\nprint("after");');
    assert.equal(r.ok, false);
    assert.ok(Date.now() - t0 < 5000, 'no request timeout');
    assert.equal(t.script.asks.length, asks0, 'no error box');
    assert.deepEqual(Array.from(t.macroLog()), []);
  } finally { t.close(); }
});

await test('print() in a loop is linear: 60 000 lines well under the old quadratic cost, the Log capped and exact', async () => {
  const t = await fresh();
  try {
    const t0 = Date.now();
    const r = await t.runMacro('for (i = 0; i < 60000; i++) print(i); s = getInfo("log"); print(lengthOf(s));');
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.ok(Date.now() - t0 < 8000, 'printed in ' + (Date.now() - t0) + ' ms');
    const log = Array.from(t.macroLog());
    assert.equal(log.length, 60001);
    let n = 0; for (let i = 0; i < 60000; i++) n += String(i).length + 1;
    assert.equal(log[60000], String(n), 'getInfo("log") holds every line');
  } finally { t.close(); }
});

await test('the ROI Manager list goes to the worker once per change, not with every reply', async () => {
  const t = await fresh();
  try {
    const a = t.IJApp.apiFor('macro');
    const docId = t.activeId();
    const list = [];
    for (let i = 0; i < 50; i++) list.push({ name: 'r' + i, docId, roi: { type: 'rect', x: i % 10, y: 0, w: 2, h: 2 } });
    a.roiManager.set(list);
    // every reply's mirror, as the page posts it to the worker
    const m0 = t.log.msgs.length;
    const r = await t.runMacro(lines('n = roiManager("count");', 'for (i = 0; i < n; i++) { roiManager("select", i); run("Measure"); }',
      'roiManager("add"); print(roiManager("count") + " " + nResults);'));
    const replies = t.log.msgs.slice(m0).filter((m) => m && m.cmd === 'macro.reply').map((m) => m.args);
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.deepEqual(Array.from(t.macroLog()), ['51 50']);
    assert.ok(replies.length >= 50, replies.length + ' replies');
    const withList = replies.filter((m) => m.mirror && m.mirror.roiManager && Array.isArray(m.mirror.roiManager.list));
    // the first reply after the run started, and the one after roiManager("add") changed the list
    assert.ok(withList.length <= 3, withList.length + ' of ' + replies.length + ' replies carried the list');
    assert.ok(replies.some((m) => m.mirror && m.mirror.roiManager && m.mirror.roiManager.same === true));
  } finally { t.close(); }
});

// ─────────────────────────────── integration ───────────────────────────────

await test('a macro does not start while the operator\'s own step runs; that step keeps its progress line', async () => {
  const fiji = fs.readFileSync(path.join(DIR, 'ij-proc-fiji.js'), 'utf8') +
    "\nIJOpRegistry.defineCommand('doc.fiji.slow', { pkg: 'fiji', long: true, handler: () => new Promise((r) => setTimeout(() => r({ ok: 1 }), 800)) });\n";
  const pageFiji = fs.readFileSync(path.join(DIR, 'ij-proc-fiji.js'), 'utf8') + "\nIJOpRegistry.defineCommand('doc.fiji.slow', { pkg: 'fiji', long: true, handler: () => ({}) });\n";
  const t = await fresh({ workerSources: { 'ij-proc-fiji.js': fiji }, pageSources: { 'ij-proc-fiji.js': pageFiji } });
  try {
    const fapi = t.api('fiji');
    const macRun = t.page.__IJApp.COMMANDS.find((c) => c.id === 'macRun');
    const slow = fapi.call('doc.fiji.slow', {});
    await until(() => fapi.state().busy === true, 'the operator step');
    assert.equal(macRun.enabled({ busy: true, doc: fapi.state().doc }), false, 'Plugins › Macros › Run… is off while a step runs');
    await assert.rejects(t.runMacro('print("x");'), (e) => e && e.code === 'IJ_MACRO_STEP_BUSY');
    const sh = t.shells[0];
    assert.notEqual(sh.progress[sh.progress.length - 1], null, 'the step\'s progress line is still shown');
    await slow;
  } finally { t.close(); }
});

await test('setForegroundColor stores ImageJ\'s colour name, so Edit › Options › Colors keeps it', async () => {
  const t = await fresh();
  try {
    const r = await t.runMacro('setForegroundColor(255, 0, 0); setBackgroundColor(1, 2, 3);');
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const s = t.api('macro').settings;
    assert.equal(s.get('colors.foreground'), 'red');
    assert.equal(s.get('colors.background'), '#010203');
  } finally { t.close(); }
});

console.log('test_ij_macro_review: ' + passed + ' passed');
process.exit(0);
