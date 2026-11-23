// Stacks and RGB, the menu commands of the sweep through the real page (tests/js/ij_harness.mjs): the questions ImageJ asks of a stack and what they do.
//   Histogram            "Include all N images?" -> the stack histogram (Yes) or the current plane (No / Cancel);
//   Analyze Particles    "Process all N images?" after the dialog -> one set of rows per slice with `Label` title:slice label and the Slice column,
//                        the "Show:" image a stack, one Summary row per slice;
//   Convert to Mask      the "Convert Stack to Binary" dialog (fields of ImageJ, the values reach the operation), Threshold window Apply;
//   Duplicate...         "Duplicate stack" + "Range:" of a stack, "Duplicate hyperstack" + Channels / Slices / Frames of a hyperstack;
//   Size / Scale / Bin   Depth / Time, Z Scale / Depth / Process entire stack, Z shrink factor;
//   Image Calculator     "Process all N images?", a stack of another length refused, the result keeps the dimensions of image 1.
//
// Run: node tests/js/test_ij_stk_sweep_cmds.mjs
import assert from 'node:assert/strict';
import { boot, until, sleep } from './ij_harness.mjs';
import { fixture, toStackImage, fixturePlanes } from './ij_sweep_lib.mjs';

let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL ' + name); throw e; } }
const deq = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m);
const walk = (el, fn) => { fn(el); for (const c of el.children || []) walk(c, fn); };
const texts = (el, tag) => { const out = []; walk(el, (e) => { if (e.tagName === tag) out.push(e); }); return out; };
const resultsRows = (t) => texts(t.panel('results'), 'TR').map((tr) => (tr.children || []).map((c) => c.textContent));

async function fresh() {
  const t = await boot({ channels: 1 });
  const create = t.page.document.createElement;
  t.page.document.createElement = (tag) => {
    const e = create(tag);
    let v = '';
    Object.defineProperty(e, 'textContent', { get: () => v, set: (x) => { v = x; if (x === '') e.replaceChildren(); }, configurable: true });
    return e;
  };
  await t.open();
  return t;
}
async function addStack(t, S, name) {
  const key = (await t.store.shared.list())[0].key;
  const id = await t.api(null).addDoc(toStackImage(S, name), { sessionKey: key });
  await until(() => t.activeId() === id, 'the stack is on screen');
  return id;
}
async function activate(t, docId) {
  const c = t.shell.opts.commands.find((x) => x.id === 'winImg' + docId);
  assert.ok(c, 'window menu entry of ' + docId);
  await c.run();
  await until(() => t.activeId() === docId, 'image ' + docId + ' on screen');
}
const lastSpec = (t) => t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
const sentOf = (t, cmd) => t.log.msgs.filter((m) => m.cmd === cmd);
const askTitles = (t) => t.script.asks.map((a) => a.title + ' | ' + a.message);

// ═════════════ Histogram ═════════════
await test('Histogram on a stack asks "Include all N images?": Yes reads every slice (StackStatistics), No the plane on screen, Cancel nothing', async () => {
  const t = await fresh();
  const f = fixture('stackproc', 'histogram_all_slices');
  const S = f.cases[0].input;
  await addStack(t, S, 'h8');
  t.script.asks.length = 0;
  await t.runCommand('analyzeHistogram');                         // the default answer is the primary button: Yes
  assert.ok(askTitles(t).includes('Histogram | Include all 4 images?'), JSON.stringify(askTitles(t)));
  const stack = sentOf(t, 'doc.stackHistogram').pop();
  assert.ok(stack, 'the stack histogram was asked');
  assert.equal(stack.args.planes, 'all');
  t.script.nextAsk = 'current';
  const before = sentOf(t, 'doc.histogram').length;
  await t.runCommand('analyzeHistogram');
  assert.equal(sentOf(t, 'doc.histogram').length, before + 1, 'No: the plane on screen');
  assert.equal(sentOf(t, 'doc.stackHistogram').length, 1, 'no second stack histogram');
  t.script.nextAsk = 'cancel';
  const n1 = sentOf(t, 'doc.histogram').length, n2 = sentOf(t, 'doc.stackHistogram').length;
  await t.runCommand('analyzeHistogram');
  assert.equal(sentOf(t, 'doc.histogram').length, n1); assert.equal(sentOf(t, 'doc.stackHistogram').length, n2, 'Cancel: nothing is read');
  // the answer of the engine is the one of ImageJ
  const r = await t.engine('doc.stackHistogram', { docId: t.activeId(), roi: null, channel: 0, bins: 256, planes: 'all' });
  assert.equal(r.stats.mean, f.cases[0].stackMean);
  t.close();
});

// ═════════════ Analyze Particles ═════════════
await test('Analyze Particles on a stack: Process all N images?, rows of every slice with Label title:slice and the Slice column, one Summary row per slice, the masks as a stack', async () => {
  const t = await fresh();
  const f = fixture('stackproc', 'analyze_particles_stack');
  const S = f.input;
  await addStack(t, S, 'bin');
  await t.runCommand('analyzeSetMeasurements', { area: true, mean: true, centroid: true, rect: true, shape: true, stackPos: true, labels: true, decimals: 3 });
  t.script.asks.length = 0;
  await t.runCommand('analyzeParticles', { size: '0-Infinity', circularity: '0.00-1.00', show: 'nothing', display: true, clear: true });
  assert.ok(askTitles(t).includes('Process Stack? | Process all 3 images?'), JSON.stringify(askTitles(t)));
  await until(() => t.shell.windows.floats.has('results'), 'the Results window');
  await sleep(150);
  const rows = resultsRows(t);
  const head = rows[0];
  assert.ok(head.includes('Slice') && head.includes('Label') && head.includes('Area'), 'columns ' + head.join(','));
  const cs = f.cases[0];
  assert.equal(rows.length - 1, cs.table.rows.length, 'one row per particle of every slice');
  const col = (name) => head.indexOf(name), ref = (name) => cs.table.headings.indexOf(name);
  for (let i = 0; i < cs.table.rows.length; i++) {
    const got = rows[i + 1], exp = cs.table.rows[i];
    assert.equal(got[col('Label')], exp[ref('Label')], 'Label of row ' + i);     // "bin:p1"
    assert.equal(Number(got[col('Slice')]), exp[ref('Slice')], 'Slice of row ' + i);
    assert.equal(Number(got[col('Area')]), exp[ref('Area')], 'Area of row ' + i);
    assert.equal(Number(got[col('BX')]), exp[ref('BX')], 'BX of row ' + i);
  }
  // No: only the plane on screen; the Slice column says which one
  t.script.nextAsk = 'current';
  await t.runCommand('analyzeParticles', { size: '0-Infinity', circularity: '0.00-1.00', show: 'nothing', display: true, clear: true });
  await sleep(150);
  const rows1 = resultsRows(t);
  assert.equal(rows1.length - 1, f.cases.find((c) => c.table && !/stack/.test(c.options)).table.rows.length, 'the slice on screen: its particles only');
  // a Summary row per slice
  await t.runCommand('analyzeParticles', { size: '0-Infinity', circularity: '0.00-1.00', show: 'nothing', display: true, clear: true, summarize: true });
  await until(() => t.shell.windows.floats.has('summary'), 'the Summary window');
  await sleep(150);
  const sum = texts(t.panel('summary'), 'TR').map((tr) => (tr.children || []).map((c) => c.textContent));
  assert.equal(sum.length - 1, 3, 'one row per slice: ' + JSON.stringify(sum.map((r) => r[0])));
  deq(sum.slice(1).map((r) => r[0]), ['p1', 'p2', 'p3'], JSON.stringify(sum));
  // "Masks": one stack of drawings
  const ndocs = (await t.docs()).length;
  await t.runCommand('analyzeParticles', { size: '0-Infinity', circularity: '0.00-1.00', show: 'masks', display: true, clear: true });
  await sleep(200);
  const docs = await t.docs();
  assert.equal(docs.length, ndocs + 1, 'the Masks image');
  const mask = docs[docs.length - 1];
  assert.equal(mask.nZ, 3, 'a stack with one drawing per slice'); assert.equal(mask.name, 'Mask of bin');
  t.close();
});

// ═════════════ Convert to Mask ═════════════
await test('Convert to Mask on a stack: the "Convert Stack to Binary" dialog of ImageJ, in place or a new stack; Cancel leaves it as it is', async () => {
  const t = await fresh();
  const f = fixture('convert', 'to_binary_stack_u8_black');
  const S = f.input;
  const id = await addStack(t, S, 's8');
  await t.runCommand('binMask', null);                              // cancelled: the dialog is read
  const spec = lastSpec(t);
  assert.equal(spec.title, 'Convert Stack to Binary');
  deq(spec.fields.map((x) => x.id), ['method', 'background', 'calculate', 'only', 'black', 'list', 'create']);
  assert.equal(spec.fields[0].value, 'Default'); assert.equal(spec.fields[1].value, 'Default');
  deq(spec.fields.slice(2).map((x) => x.value), [false, false, true, false, false], 'Calculate, Only, Black background, List thresholds, Create new stack');
  assert.ok(sentOf(t, 'doc.run').every((m) => m.args.op !== 'stackToMask'), 'cancelled: nothing runs');
  // Calculate threshold for each image, Black background → in place
  await t.runCommand('binMask', { method: 'Default', background: 'Default', calculate: true, only: false, black: true, list: false, create: false });
  const run = sentOf(t, 'doc.run').filter((m) => m.args.op === 'stackToMask').pop();
  assert.ok(run, 'the in-place operation ran'); assert.equal(run.args.params.calculate, true); assert.equal(run.args.params.method, 'Default');
  const cs = f.cases[0];
  const got = [];
  for (let z = 0; z < 4; z++) got.push(Array.from((await t.engine('doc.tile', { docId: id, channel: 0, level: 0, tx: 0, ty: 0, pos: { z, t: 0 } })).data));
  const exp = fixturePlanes(cs.self);
  for (let z = 0; z < 4; z++) assert.deepEqual(got[z], Array.from(exp[z]), 'slice ' + (z + 1));
  // Create new stack: a MASK_ image, the source untouched
  const id2 = await addStack(t, S, 's8b');
  await t.runCommand('binMask', { calculate: true, black: true, create: true });
  const docs = await t.docs();
  assert.ok(docs.some((d) => d.name === 'MASK_s8b' && d.nZ === 4 && d.bitDepth === 8), 'MASK_s8b: ' + JSON.stringify(docs.map((d) => d.name)));
  assert.ok(id2 !== undefined);
  t.close();
});

// ═════════════ Duplicate ═════════════
await test('Duplicate... of a stack: Title, Duplicate stack (off), Range (1-N); of a hyperstack: Duplicate hyperstack, Channels / Slices / Frames', async () => {
  const t = await fresh();
  const f = fixture('stackproc', 'gaussian_u8_all_slices');
  const S = f.input;                                                // 4 slices
  const stkId = await addStack(t, S, 'stk');
  await t.runCommand('imageDuplicate', null);
  let spec = lastSpec(t);
  deq(spec.fields.map((x) => x.id), ['title', 'stack', 'range']);
  assert.equal(spec.fields[1].value, false); assert.equal(spec.fields[2].value, '1-4');
  // unticked = the slice on screen
  await t.runCommand('imageDuplicate', { title: 'one', stack: false });
  await activate(t, stkId);
  let docs = await t.docs();
  const one = docs.find((d) => d.name === 'one');
  assert.ok(one && one.nZ === 1 && one.nT === 1, 'one slice');
  // ticked, a range
  await t.runCommand('imageDuplicate', { title: 'part', stack: true, range: '2-3' });
  await activate(t, stkId);
  docs = await t.docs();
  const part = docs.find((d) => d.name === 'part');
  assert.ok(part && part.nZ === 2, 'slices 2-3: ' + (part && part.nZ));
  const pix = Array.from((await t.engine('doc.tile', { docId: part.docId, channel: 0, level: 0, tx: 0, ty: 0, pos: { z: 0, t: 0 } })).data);
  assert.deepEqual(pix, Array.from(fixturePlanes(S)[1]), 'the first slice of the copy is slice 2');
  // a hyperstack: 2 channels, 3 slices, 2 frames
  const h = fixture('stackproc', 'gaussian_hyperstack_composite').input;
  const hypId = await addStack(t, h, 'hyp');
  await t.runCommand('imageDuplicate', null);
  spec = lastSpec(t);
  deq(spec.fields.map((x) => x.id), ['title', 'stack', 'channels', 'slices', 'frames']);
  deq(spec.fields.slice(2).map((x) => x.value), ['1-2', '1-3', '1-2']);
  await t.runCommand('imageDuplicate', { title: 'hcopy', stack: true, channels: '2', slices: '1-2', frames: '2' });
  await activate(t, hypId);
  docs = await t.docs();
  const hc = docs.find((d) => d.name === 'hcopy');
  assert.ok(hc && hc.channels.length === 1 && hc.nZ === 2 && hc.nT === 1, 'c2, z1-2, t2: ' + JSON.stringify(hc && [hc.channels.length, hc.nZ, hc.nT]));
  await t.runCommand('imageDuplicate', { title: 'hnow', stack: false });
  docs = await t.docs();
  const hn = docs.find((d) => d.name === 'hnow');
  assert.ok(hn && hn.nZ === 1 && hn.nT === 1, 'the plane on screen (every channel of a composite)');
  t.close();
});

// ═════════════ Size / Scale / Bin ═════════════
await test('Size... of a stack has Depth, a hyperstack Depth (slices) and Time (frames); a new depth opens a new image, X / Y stay in place', async () => {
  const t = await fresh();
  const S = fixture('stackproc', 'size_stack_depth').input;       // 4 slices, 16-bit, 30x18
  const id = await addStack(t, S, 's16');
  await t.runCommand('adjustSize', null);
  const spec = lastSpec(t);
  deq(spec.fields.map((x) => x.id), ['width', 'height', 'depth', 'constrain', 'average', 'interpolation']);
  assert.equal(spec.fields[2].value, 4);
  const n0 = (await t.docs()).length;
  await t.runCommand('adjustSize', { width: 37, height: 23, depth: 8, constrain: false, average: true, interpolation: 'bilinear' });
  await sleep(100);
  const docs = await t.docs();
  assert.equal(docs.length, n0 + 1, 'the depth-scaled stack is a new image');
  const orig = docs.find((d) => d.docId === id);
  assert.equal(orig.width, 37); assert.equal(orig.nZ, 4, 'the original keeps its slices, resized in X and Y');
  assert.equal(docs[docs.length - 1].nZ, 8);
  const hy = fixture('stackproc', 'size_hyperstack').input;
  await addStack(t, hy, 'hyp');
  await t.runCommand('adjustSize', null);
  deq(lastSpec(t).fields.map((x) => x.id), ['width', 'height', 'depth', 'time', 'constrain', 'average', 'interpolation']);
  t.close();
});

await test('Scale... of a stack: Z Scale, Depth, Process entire stack; Bin... of a stack: Z shrink factor', async () => {
  const t = await fresh();
  const S = fixture('stackproc', 'scale_stack').input;
  await addStack(t, S, 'sc');
  await t.runCommand('imageScale', null);
  deq(lastSpec(t).fields.map((x) => x.id), ['xscale', 'yscale', 'zscale', 'width', 'height', 'depth', 'interpolation', 'average', 'process', 'newWindow', 'title']);
  const n0 = (await t.docs()).length;
  await t.runCommand('imageScale', { xscale: 0.5, yscale: 0.5, zscale: 2, interpolation: 'bilinear', average: true, process: true, newWindow: true, title: 'out' });
  await sleep(100);
  let docs = await t.docs();
  const out = docs.find((d) => d.name === 'out');
  assert.ok(out && out.nZ === 8 && out.width === 15, 'scaled stack: ' + JSON.stringify(out && [out.width, out.height, out.nZ]));
  await t.runCommand('imageScale', { xscale: 0.5, yscale: 0.5, zscale: 1, interpolation: 'bilinear', average: true, process: false, newWindow: true, title: 'one' });
  await sleep(100);
  docs = await t.docs();
  assert.equal(docs.find((d) => d.name === 'one').nZ, 1, 'Process entire stack off: the plane on screen');
  assert.equal(docs.length, n0 + 2);
  // Bin
  const b = fixture('stackproc', 'bin_stack').input;
  const id = await addStack(t, b, 'bn');
  await t.runCommand('transformBin', null);
  deq(lastSpec(t).fields.filter((x) => x.type !== 'message').map((x) => x.id), ['xshrink', 'yshrink', 'zshrink', 'method']);
  await t.runCommand('transformBin', { xshrink: 2, yshrink: 2, zshrink: 2, method: 'average' });
  const info = (await t.docs()).find((d) => d.docId === id);
  assert.equal(info.nZ, 2); assert.equal(info.width, 18);
  t.close();
});

// ═════════════ Image Calculator ═════════════
await test('Image Calculator on a stack asks "Process all N images?"; the result keeps the stack; another depth is refused with ImageJ\'s sentence', async () => {
  const t = await fresh();
  const f = fixture('stackproc', 'calc_stack_x_stack_u8');
  const [s2, s1] = f.inputs || [f.input, f.input2];
  const id1 = await addStack(t, s1, 's1');
  const id2 = await addStack(t, s2, 's2');
  t.script.asks.length = 0;
  await t.runCommand('procImageCalculator', { image1: id1, op: 'add', image2: id2, float32: false });
  assert.ok(askTitles(t).some((x) => /^Process Stack\? \| Process all 4 images\?$/.test(x)), JSON.stringify(askTitles(t)));
  let docs = await t.docs();
  const res = docs[docs.length - 1];
  assert.equal(res.name, 'Result of s1'); assert.equal(res.nZ, 4, 'a stack');
  const cs = f.cases.find((c) => /operation=Add image2=s2 create stack$/.test(c.options));
  const exp = fixturePlanes(cs.created[0]);
  for (let z = 0; z < 4; z++) assert.deepEqual(Array.from((await t.engine('doc.tile', { docId: res.docId, channel: 0, level: 0, tx: 0, ty: 0, pos: { z, t: 0 } })).data), Array.from(exp[z]), 'slice ' + (z + 1));
  // No: the slice on screen of each, one plane
  t.script.nextAsk = 'current';
  await t.runCommand('procImageCalculator', { image1: id1, op: 'add', image2: id2 });
  docs = await t.docs();
  assert.equal(docs[docs.length - 1].nZ, 1, 'one plane');
  // another depth
  const d = fixture('stackproc', 'calc_stack_different_depths');
  const [t2, t1] = d.inputs;
  const a = await addStack(t, t1, 'd1'), b = await addStack(t, t2, 'd2');
  const errs = await t.runCommand('procImageCalculator', { image1: a, op: 'add', image2: b }, { expectError: true });
  assert.match(errs[0].message, /stacks with the same number of slices/);
  t.close();
});

console.log('ij stk sweep cmds: ' + passed + ' groups passed');
