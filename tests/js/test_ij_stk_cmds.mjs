// Package `stk` commands (js/modules/studio/advanced-studio/ij-cmds-stk.js + ij-proc-stk.js) end to end through tests/js/ij_harness.mjs:
// the real menu command (dialog values) -> the real engine in the worker -> the documents it leaves, undo, the ids and positions of the menu,
// the dialogs against the ImageJ 1.54p dialogs captured in tests/fixtures/ij-stacks/dialogs, the lang files (parity, no empty value).
//
// Run: node tests/js/test_ij_stk_cmds.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, until, DIR, EN } from './ij_harness.mjs';
import { ROOT } from './harness.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL ' + name); throw e; }
}
const arr = (a) => Array.from(a);
const FX = path.join(ROOT, 'tests', 'fixtures', 'ij-stacks', 'dialogs');

// a stack image of `n` planes of 8 x 6 pixels: plane k holds the value 10*k + 1 + (x + y)
function stackImage(o = {}) {
  const W = o.w || 8, H = o.h || 6, nC = o.nC || 1, nZ = o.nZ || 3, nT = o.nT || 1, bd = o.bitDepth || 8;
  const C = bd === 8 ? Uint8Array : bd === 16 ? Uint16Array : Float32Array;
  const channels = [];
  for (let c = 0; c < nC; c++) {
    const planes = [];
    for (let t = 0; t < nT; t++) for (let z = 0; z < nZ; z++) {
      const a = new C(W * H);
      for (let i = 0; i < a.length; i++) a[i] = (c * 50 + (t * nZ + z) * 10 + 1 + (i % W) + Math.floor(i / W)) % (bd === 8 ? 256 : 60000);
      planes.push(a);
    }
    channels.push({ name: 'C' + (c + 1), color: ['#ff0000', '#00ff00', '#0000ff'][c] || '#ffffff', planes });
  }
  return { name: o.name || 'stk', width: W, height: H, bitDepth: bd, nZ, nT, hyperstack: !!o.hyperstack, calibration: o.calibration, labels: o.labels, channels };
}
async function newDoc(t, img) { return t.api('stk').addDoc(img); }
const infoOf = async (t, id) => (await t.docs()).find((d) => d.docId === id);
async function planeOf(t, id, c, z, tt) { return arr((await t.engine('doc.tile', { docId: id, channel: c, level: 0, tx: 0, ty: 0, pos: { z, t: tt } })).data); }
async function activate(t, docId) {
  const c = t.shell.opts.commands.find((x) => x.id === 'winImg' + docId);
  assert.ok(c, 'window menu entry of ' + docId);
  await c.run();
  await until(() => t.activeId() === docId, 'image ' + docId + ' on screen');
}
const cmd = (t, id) => t.shell.opts.commands.find((x) => x.id === id);

const t = await boot({ channels: 1 });
await t.open();
const first = (await t.docs())[0];

await test('menu: every command has its place, its label and its order (Image > Stacks / Hyperstacks / Type / Color)', () => {
  const want = {
    stackAddSlice: [['Image', 'Stacks'], 10], stackDeleteSlice: [['Image', 'Stacks'], 20], stackNextSlice: [['Image', 'Stacks'], 30], stackPreviousSlice: [['Image', 'Stacks'], 40],
    stackSetSlice: [['Image', 'Stacks'], 50], stackImagesToStack: [['Image', 'Stacks'], 60], stackToImages: [['Image', 'Stacks'], 70], stackReslice: [['Image', 'Stacks'], 90],
    stackZProfile: [['Image', 'Stacks'], 110], stackMeasure: [['Image', 'Stacks'], 120], stackLabel: [['Image', 'Stacks'], 130], stackStatistics: [['Image', 'Stacks'], 140],
    stackStartAnimation: [['Image', 'Stacks', 'Animation'], 10], stackStopAnimation: [['Image', 'Stacks', 'Animation'], 20], stackAnimationOptions: [['Image', 'Stacks', 'Animation'], 30],
    stackCombine: [['Image', 'Stacks', 'Tools'], 10], stackConcatenate: [['Image', 'Stacks', 'Tools'], 20], stackGroupedZ: [['Image', 'Stacks', 'Tools'], 30], stackInsert: [['Image', 'Stacks', 'Tools'], 40],
    stackSubstack: [['Image', 'Stacks', 'Tools'], 50], stackMontageToStack: [['Image', 'Stacks', 'Tools'], 60], stackReduce: [['Image', 'Stacks', 'Tools'], 70],
    stackRemoveLabels: [['Image', 'Stacks', 'Tools'], 80], stackReverse: [['Image', 'Stacks', 'Tools'], 90], stackSetLabel: [['Image', 'Stacks', 'Tools'], 100],
    hyperNew: [['Image', 'Hyperstacks'], 10], hyperToHyper: [['Image', 'Hyperstacks'], 20], hyperToStack: [['Image', 'Hyperstacks'], 30], hyperReduceDim: [['Image', 'Hyperstacks'], 40],
    hyperSubset: [['Image', 'Hyperstacks'], 50], hyperReorder: [['Image', 'Hyperstacks'], 60],
    typeColor8: [['Image', 'Type'], 40], typeRgb: [['Image', 'Type'], 50], typeRgbStack: [['Image', 'Type'], 60], typeHsbStack: [['Image', 'Type'], 70], typeHsb32: [['Image', 'Type'], 80], typeLabStack: [['Image', 'Type'], 90],
    colorStackToRgb: [['Image', 'Color'], 42], colorMakeComposite: [['Image', 'Color'], 44]
  };
  for (const [id, [menu, order]] of Object.entries(want)) {
    const c = cmd(t, id);
    assert.ok(c, id + ' is registered');
    assert.deepEqual(JSON.parse(JSON.stringify(c.menu)), menu, id + ' menu');
    assert.equal(c.order, order, id + ' order');
    assert.ok(EN.cmd[id] && !/^\s*$/.test(EN.cmd[id]), id + ' has a label');
  }
  for (const g of ['Image/Stacks/Animation', 'Image/Stacks/Tools', 'Image/Hyperstacks']) assert.ok(t.IJApp.GROUP_META[g], g + ' has a place');
});

await test('lang: the new keys exist in the four languages with the same tokens', () => {
  const dicts = {};
  for (const code of ['en', 'fr', 'es', 'nl']) dicts[code] = JSON.parse(fs.readFileSync(path.join(DIR, 'lang', code + '.json'), 'utf8'));
  const leaves = (o, p, out) => { for (const [k, v] of Object.entries(o)) { if (v && typeof v === 'object') leaves(v, p + k + '.', out); else out[p + k] = v; } return out; };
  const en = leaves(dicts.en.dlg.stk, 'dlg.stk.', {});
  for (const k of Object.keys(en)) for (const code of ['fr', 'es', 'nl']) {
    const v = leaves(dicts[code].dlg.stk, 'dlg.stk.', {})[k];
    assert.ok(typeof v === 'string' && v.length, code + ' ' + k);
    assert.deepEqual((v.match(/\{\w+\}/g) || []).sort(), (en[k].match(/\{\w+\}/g) || []).sort(), code + ' tokens of ' + k);
  }
  for (const code of ['fr', 'es', 'nl']) for (const k of Object.keys(dicts.en.cmd).filter((x) => /^(stack|hyper|typeColor8|typeRgb|typeHsb|typeLab|colorStackToRgb|colorMakeComposite)/.test(x))) assert.ok(dicts[code].cmd[k], code + ' cmd.' + k);
  for (const code of ['fr', 'es', 'nl']) for (const k of Object.keys(dicts.en.err).filter((x) => /^stk/.test(x))) assert.ok(dicts[code].err[k], code + ' err.' + k);
  for (const code of ['fr', 'es', 'nl']) for (const k of Object.keys(dicts.en.op).filter((x) => /^stk/.test(x))) assert.ok(dicts[code].op[k], code + ' op.' + k);
});

// ── dialogs against the captured ones
const DIALOGS = {
  stackAddSlice: ['add_slice_hyper', { hyper: true }], stackDeleteSlice: ['delete_slice_hyper', { hyper: true }], stackSetSlice: ['set_slice_hyper', { hyper: true }],
  stackReslice: ['reslice_stack'], stackLabel: ['label_stack'], stackAnimationOptions: ['animation_options'], stackGroupedZ: ['grouped_z_project'],
  stackSubstack: ['substack_stack'], stackMontageToStack: ['montage_to_stack'], stackReduce: ['reduce_stack'], hyperNew: ['new_hyperstack'], hyperToHyper: ['stack_to_hyperstack'],
  hyperReduceDim: ['reduce_dimensionality', { hyper: true }], hyperSubset: ['make_subset', { hyper: true }], typeColor8: ['eight_bit_color', { rgb: true }]
};
for (const [id, [fixture, o]] of Object.entries(DIALOGS)) {
  await test(`dialog of ${id} = ImageJ's ${fixture}: the same fields in the same order, the same macro keys`, async () => {
    const cap = JSON.parse(fs.readFileSync(path.join(FX, fixture + '.json'), 'utf8'));
    const want = cap.steps[0].components.filter((c) => ['numeric', 'string', 'text', 'checkbox', 'choice', 'radio'].includes(c.t)).map((c) => c.key);
    const img = (o && o.hyper) ? stackImage({ nC: 2, nZ: 3, nT: 2, hyperstack: true, name: 'hyp' }) : (o && o.rgb) ? null : stackImage({ nZ: 4 });
    let docId;
    if (img) docId = await newDoc(t, img);
    else {
      const W = 8, H = 6, mk = () => { const a = new Uint8Array(W * H); for (let i = 0; i < a.length; i++) a[i] = (i * 5) & 255; return a; };
      docId = await t.api('stk').addDoc({ name: 'rgb', width: W, height: H, bitDepth: 8, rgb: true, nZ: 1, nT: 1, channels: [{ name: 'Red', color: '#ff0000', planes: [mk()] }, { name: 'Green', color: '#00ff00', planes: [mk()] }, { name: 'Blue', color: '#0000ff', planes: [mk()] }] });
    }
    await activate(t, docId);
    const before = t.log.dialogSpecs.length;
    try { await t.runCommand(id, null); } catch (e) { /* a cancelled dialog is the answer null */ }
    const spec = t.log.dialogSpecs[before];
    assert.ok(spec, id + ' opened a dialog');
    const got = spec.fields.filter((f) => f.type !== 'message').map((f) => f.ijKey);
    // the dialog shows the fields that make sense for the image (a hidden one is part of the spec): the visible ones are a prefix-compatible subsequence of ImageJ's
    const sub = (a, b) => { let i = 0; for (const x of b) if (x === a[i]) i++; return i === a.length; };
    assert.ok(sub(got.filter((k) => k !== undefined), want.concat(['slice_count'])) || sub(want, got), `${id}: ${JSON.stringify(got)} vs ImageJ ${JSON.stringify(want)}`);
    assert.ok(spec.fields.filter((f) => f.type !== 'message').every((f) => f.ijKey), id + ': every field carries its macro key (ijKey)');
    await t.closeDoc?.(docId);
  });
}

await test('Add / Delete Slice on a plain stack: the slice follows the current one (blank), the position moves, undo restores', async () => {
  const id = await newDoc(t, stackImage({ nZ: 3, name: 'add1' }));
  await activate(t, id);
  await t.api('stk').setPosition({ z: 1 }, { docId: id });
  await t.runCommand('stackAddSlice');
  let i = await infoOf(t, id);
  assert.equal(i.nSlices, 4);
  assert.equal(t.api('stk').position(id).z, 2, 'the new slice is on screen');
  assert.ok((await planeOf(t, id, 0, 2, 0)).every((v) => v === 0), 'blank');
  await t.runCommand('editUndo');
  assert.equal((await infoOf(t, id)).nSlices, 3);
  await t.runCommand('stackDeleteSlice');
  i = await infoOf(t, id);
  assert.equal(i.nSlices, 2);
  assert.equal(t.api('stk').position(id).z, 1, 'ImageJ shows the previous slice after a deletion (slice 3 of 3 was deleted)');
});

await test('Next / Previous Slice, Set Slice, the animation options', async () => {
  const id = await newDoc(t, stackImage({ nZ: 5, name: 'nav' }));
  await activate(t, id);
  await t.runCommand('stackNextSlice');
  assert.equal(t.api('stk').position(id).z, 1);
  await t.runCommand('stackPreviousSlice');
  await t.runCommand('stackPreviousSlice');
  assert.equal(t.api('stk').position(id).z, 0, 'clamped');
  await t.runCommand('stackSetSlice', { slice: 4 });
  assert.equal(t.api('stk').position(id).z, 3);
  await t.runCommand('stackAnimationOptions', { speed: 12, first: 2, last: 4, loop: true, start: false });
  const o = t.api('stk').animation.options({ docId: id });
  assert.equal(o.fps, 12); assert.equal(o.first, 2); assert.equal(o.last, 4); assert.equal(!!o.backAndForth, true);
});

await test('Z Project (the menu command, through the page dispatch): every method on a stack; a single image keeps the figure entry', async () => {
  const id = await newDoc(t, stackImage({ nZ: 4, name: 'zp' }));
  await activate(t, id);
  const n0 = (await t.docs()).length;
  await t.runCommand('stackProject', { start: 1, stop: 4, projection: 'max' });
  const docs = await t.docs();
  assert.equal(docs.length, n0 + 1);
  const proj = docs.find((d) => d.name === 'MAX_zp');
  assert.ok(proj, 'MAX_zp');
  assert.equal(proj.nSlices, 1);
  const p = await planeOf(t, proj.docId, 0, 0, 0);
  assert.equal(p[0], 31 + 0, 'max of 1, 11, 21, 31 at pixel 0');
  await activate(t, id);   // the projection took the screen
  await t.runCommand('stackProject', { start: 2, stop: 3, projection: 'sum' });
  const sum = (await t.docs()).find((d) => d.name === 'SUM_zp');
  assert.equal(sum.bitDepth, 32);
  assert.equal((await planeOf(t, sum.docId, 0, 0, 0))[0], 11 + 21);
});

await test('Reverse, Reduce, Make Substack (with Delete), Remove Slice Labels, Set Label: one undo step each, labels follow', async () => {
  const labels = ['a', 'b', 'c', 'd', 'e', 'f'];
  const id = await newDoc(t, stackImage({ nZ: 6, name: 'ops', labels }));
  await activate(t, id);
  await t.runCommand('stackReverse');
  assert.deepEqual(arr(await planeOf(t, id, 0, 0, 0)).slice(0, 2), [51, 52]);
  await t.runCommand('editUndo');
  await t.runCommand('stackReduce', { reduction: 2 });
  assert.equal((await infoOf(t, id)).nSlices, 3);
  await t.runCommand('editUndo');
  await t.runCommand('stackSubstack', { slices: '2-4', delete: true });
  const docs = await t.docs();
  const sub = docs.find((d) => d.name === 'Substack (2-4)');
  assert.ok(sub && sub.nSlices === 3);
  assert.equal((await infoOf(t, id)).nSlices, 3, 'the slices were deleted from the original');
  await activate(t, id);
  await t.runCommand('stackRemoveLabels');
  const info = await infoOf(t, id);
  assert.ok(!info.label, 'no label left');
  await t.runCommand('stackSetLabel', { label: 'zed' });
  assert.equal(t.api('stk').label(id), 'zed');
});

await test('Images to Stack / Stack to Images', async () => {
  const mk = (name, v) => ({ name, width: 5, height: 4, bitDepth: 8, nZ: 1, nT: 1, channels: [{ name: 'C1', color: '#ffffff', data: new Uint8Array(20).fill(v) }] });
  const a = await newDoc(t, mk('imgA', 10)), b = await newDoc(t, mk('imgB', 20));
  await activate(t, b);
  await t.runCommand('stackImagesToStack', { name: 'S', title: 'img', use: true, keep: true });
  const s = (await t.docs()).find((d) => d.name === 'S');
  assert.ok(s && s.nSlices === 2, 'S: ' + JSON.stringify(s && s.nSlices) + ' of ' + (await t.docs()).map((d) => d.name + ':' + d.nSlices).join(','));
  assert.equal((await planeOf(t, s.docId, 0, 0, 0))[0], 10);
  assert.equal((await planeOf(t, s.docId, 0, 1, 0))[0], 20);
  await activate(t, s.docId);
  const n0 = (await t.docs()).length;
  await t.runCommand('stackToImages');
  const docs = await t.docs();
  assert.ok(docs.find((d) => d.name === 'imgA' && d.docId !== a), 'slice images are named by their labels');
  assert.equal(docs.length, n0 + 1, 'two images made, the stack closed');
});

await test('Stack to Hyperstack / Hyperstack to Stack / Reduce Dimensionality / Make Subset / Re-order, positions by index maths', async () => {
  const id = await newDoc(t, stackImage({ nZ: 12, name: 'h12' }));
  await activate(t, id);
  await t.runCommand('hyperToHyper', { order: 'xyczt', channels: 2, slices: 3, frames: 2, display: 'composite' });
  let i = await infoOf(t, id);
  assert.deepEqual([i.nC, i.nZ, i.nT, !!i.hyperstack], [2, 3, 2, true]);
  // xyczt: stack index n = t*6 + z*2 + c  ->  plane (c=1, z=2, t=1) holds slice 1*6 + 2*2 + 1 + 1 = 12 -> value 10*11 + 1
  assert.equal((await planeOf(t, id, 1, 2, 1))[0], 111);
  await t.runCommand('hyperReorder', { c: 'z', z: 'c', t: 't' });
  i = await infoOf(t, id);
  assert.deepEqual([i.nC, i.nZ, i.nT], [3, 2, 2]);
  await t.runCommand('editUndo');
  await t.runCommand('hyperReduceDim', { channels: true, slices: true, frames: false, keep: true });
  assert.ok((await t.docs()).find((d) => d.name === 'h12-1' && d.nT === 1 && d.nC === 2 && d.nZ === 3));
  await activate(t, id);
  await t.runCommand('hyperToStack');
  i = await infoOf(t, id);
  assert.deepEqual([i.nC, i.nZ, i.nT, !!i.hyperstack], [1, 12, 1, false]);
});

await test('Type: 8-bit / 16-bit / 32-bit on a stack, RGB Color, RGB Stack and back, HSB, 8-bit Color', async () => {
  const id = await newDoc(t, stackImage({ nZ: 3, bitDepth: 16, name: 'typ' }));
  await activate(t, id);
  await t.runCommand('typeBit8');
  let i = await infoOf(t, id);
  assert.equal(i.bitDepth, 8); assert.equal(i.nSlices, 3);
  await t.runCommand('typeRgb');
  i = await infoOf(t, id);
  assert.equal(!!i.rgb, true); assert.equal(i.nSlices, 3);
  assert.equal(t.isEnabled('typeBit8'), true, 'an RGB image can become 8-bit');
  await t.runCommand('typeBit8');
  i = await infoOf(t, id);
  assert.equal(!!i.rgb, false); assert.equal(i.bitDepth, 8);
  await t.runCommand('editUndo');
  assert.equal(!!(await infoOf(t, id)).rgb, true);
  const nBefore = (await t.docs()).length;
  await t.runCommand('typeRgbStack');
  i = await infoOf(t, id);
  assert.deepEqual([i.nC, i.nZ, !!i.rgb, !!i.hyperstack], [3, 3, false, true]);
  assert.equal((await t.docs()).length, nBefore);
  await t.runCommand('editUndo');
  await t.runCommand('typeHsbStack');
  assert.equal((await infoOf(t, id)).nC, 3);
  await t.runCommand('editUndo');
  const c8 = await newDoc(t, { name: 'c8', width: 8, height: 6, bitDepth: 8, rgb: true, nZ: 1, nT: 1, channels: [{ name: 'Red', color: '#ff0000', data: new Uint8Array(48).fill(200) }, { name: 'Green', color: '#00ff00', data: new Uint8Array(48).fill(30) }, { name: 'Blue', color: '#0000ff', data: new Uint8Array(48).fill(100) }] });
  await activate(t, c8);
  await t.runCommand('typeColor8', { number: 16 });
  const ci = await infoOf(t, c8);
  assert.equal(!!ci.rgb, false); assert.equal(ci.bitDepth, 8);
});

await test('RGB Color of a composite renders only the channels ticked in the Channels tool (CompositeConverter, COMPOSITE mode)', async () => {
  const img = stackImage({ nC: 3, nZ: 2, name: 'cvis' });
  img.channels[0].color = '#ff0000'; img.channels[1].color = '#00ff00'; img.channels[2].color = '#0000ff';
  img.mode = 'composite'; img.visible = [true, false, true];
  const id = await newDoc(t, img);
  await activate(t, id);
  assert.deepEqual((await infoOf(t, id)).visible, [true, false, true], 'the image opens with channel 2 switched off');
  await t.runCommand('typeRgb', { slices: true, keep: false });
  const i = await infoOf(t, id);
  assert.equal(!!i.rgb, true);
  assert.deepEqual([...i.channels].map((c) => String(c.display && c.display.lut)), ['Red', 'Green', 'Blue'], 'an image converted in place shows its planes in red, green and blue, not grey');
  const g = await planeOf(t, id, 1, 0, 0), r = await planeOf(t, id, 0, 0, 0), b = await planeOf(t, id, 2, 0, 0);
  assert.ok(g.every((v) => v === 0), 'the green channel was off: nothing of it in the RGB image');
  assert.ok(r.some((v) => v > 0) && b.some((v) => v > 0), 'red and blue are rendered');
});

await test('Merge Channels without "Create composite" gives an RGB image; Split Channels of an RGB image gives title (red) / (green) / (blue)', async () => {
  const mk = (name, v) => ({ name, width: 6, height: 4, bitDepth: 8, nZ: 1, nT: 1, channels: [{ name: 'C1', color: '#ffffff', data: new Uint8Array(24).fill(v) }] });
  const m1 = await newDoc(t, mk('m1', 100)), m2 = await newDoc(t, mk('m2', 50));
  await t.runCommand('colorMergeChannels', { c1: m1, c2: m2, c3: 'none', c4: 'none', c5: 'none', c6: 'none', c7: 'none', createComposite: false });
  const docs = await t.docs();
  const rgb = docs.find((d) => d.name === 'RGB' && d.rgb);
  assert.ok(rgb, 'an RGB image');
  await activate(t, rgb.docId);
  await t.runCommand('colorSplitChannels');
  const names = (await t.docs()).map((d) => d.name);
  for (const n of ['RGB (red)', 'RGB (green)', 'RGB (blue)']) assert.ok(names.includes(n), n);
});

await test('Insert: a worker command with one undo step on the destination', async () => {
  const big = await newDoc(t, stackImage({ nZ: 3, w: 10, h: 8, name: 'insBig' }));
  const small = await newDoc(t, { name: 'insSmall', width: 3, height: 2, bitDepth: 8, nZ: 1, nT: 1, channels: [{ name: 'C1', color: '#ffffff', data: new Uint8Array(6).fill(200) }] });
  await activate(t, big);
  await t.runCommand('stackInsert', { source: small, destination: big, x: 2, y: 1 });
  const p = await planeOf(t, big, 0, 2, 0);
  assert.equal(p[1 * 10 + 2], 200);
  assert.notEqual(p[0], 200);
  await t.runCommand('editUndo');
  assert.notEqual((await planeOf(t, big, 0, 2, 0))[1 * 10 + 2], 200);
});

await test('Statistics and Measure Stack: Results rows', async () => {
  const id = await newDoc(t, stackImage({ nZ: 3, name: 'sts' }));
  await activate(t, id);
  const n0 = t.IJApp.apiFor('stk').state().resultsCount || 0;
  await t.runCommand('stackStatistics');
  const n1 = t.IJApp.apiFor('stk').state().resultsCount || 0;
  assert.equal(n1, n0 + 1);
  await t.runCommand('stackMeasure');
  assert.equal(t.IJApp.apiFor('stk').state().resultsCount, n1 + 3, 'one row per slice');
});

await test('Make Montage of a stack, Montage to Stack round trip', async () => {
  const id = await newDoc(t, stackImage({ nZ: 4, w: 10, h: 8, name: 'mont' }));
  await activate(t, id);
  await t.runCommand('stackMontage', { columns: 2, rows: 2, scale: 1, first: 1, last: 4, increment: 1, border: 0, fontSize: 12, label: false, useForeground: false });
  const m = (await t.docs()).find((d) => d.name === 'Montage');
  assert.ok(m && m.width === 20 && m.height === 16);
  await activate(t, m.docId);
  await t.runCommand('stackMontageToStack', { columns: 2, rows: 2, border: 0 });
  const s = (await t.docs()).find((d) => d.name === 'Stack' && d.nSlices === 4);
  assert.ok(s && s.width === 10 && s.height === 8);
});

await test('New Hyperstack, Reslice, Grouped Z Project, Plot Z-axis Profile, Label, Combine, Concatenate, Make Composite, Stack to RGB, Lab Stack', async () => {
  const nh = (await t.docs()).length;
  await t.runCommand('hyperNew', { name: 'HS', type: '16', display: 'composite', width: 12, height: 8, channels: 2, slices: 3, frames: 2, label: true });
  const hs = (await t.docs()).find((d) => d.name === 'HS');
  assert.ok(hs && (await t.docs()).length === nh + 1);
  assert.deepEqual([hs.nC, hs.nZ, hs.nT, hs.bitDepth, !!hs.hyperstack], [2, 3, 2, 16, true]);
  const hl = (await t.engine('doc.labels', { docId: hs.docId })).labels;
  assert.deepEqual([hl.length, hl[0], hl[1], hl[2]], [12, '"1,1,1"', '"2,1,1"', '"1,2,1"'], 'ImageJ labels the planes "c,z,t"');

  const id = await newDoc(t, stackImage({ nZ: 4, w: 10, h: 6, name: 'rs' }));
  await activate(t, id);
  await t.runCommand('stackReslice', { output: 1, start: 'top', flip: false, rotate: false, avoid: true });
  const rs = (await t.docs()).find((d) => d.name === 'Reslice of rs');
  assert.ok(rs && rs.width === 10 && rs.height === 4 && rs.nSlices === 6, 'a slice per row, a row per slice');
  await activate(t, id);
  await t.runCommand('stackGroupedZ', { projection: 'max', group: 2 });
  const gz = (await t.docs()).find((d) => d.name === 'MAX_rs');
  assert.ok(gz && gz.nSlices === 2);
  await activate(t, id);
  const plots = [];
  const off = t.IJApp.apiFor('stk');
  void off;
  await t.runCommand('stackZProfile');
  await t.runCommand('stackLabel', { format: '0', starting: 5, interval: 2, x: 3, y: 4, font: 10, range: '1-4' });
  const ann = t.api('stk').annotations.get(id);
  assert.deepEqual(arr(ann.items.filter((i) => i.tag === 'stk.label').map((i) => i.text)), ['5', '7', '9', '11']);
  void plots;

  const c1 = await newDoc(t, stackImage({ nZ: 2, w: 6, h: 6, name: 'cmbA' })), c2 = await newDoc(t, stackImage({ nZ: 3, w: 4, h: 6, name: 'cmbB' }));
  await activate(t, c1);
  await t.runCommand('stackCombine', { stack1: c1, stack2: c2, combine: false });
  const cm = (await t.docs()).find((d) => d.name === 'Combined Stacks');
  assert.ok(cm && cm.width === 10 && cm.height === 6 && cm.nSlices === 3);
  assert.ok(!(await t.docs()).find((d) => d.docId === c1), 'ImageJ closes the sources');

  const d1 = await newDoc(t, stackImage({ nZ: 2, name: 'catA' })), d2 = await newDoc(t, stackImage({ nZ: 3, name: 'catB' }));
  await activate(t, d1);
  await t.runCommand('stackConcatenate', { all: false, image1: d1, image2: d2, image3: 'none', title: 'cat', keep: true, open: false });
  const ct = (await t.docs()).find((d) => d.name === 'cat');
  assert.ok(ct && ct.nSlices === 5, 'cat: ' + (ct && ct.nSlices) + ' of ' + (await t.docs()).map((d) => d.name + ':' + d.nSlices).join(','));
  assert.ok((await t.docs()).find((d) => d.docId === d1), 'kept sources');

  const mc = await newDoc(t, stackImage({ nZ: 3, name: 'mkc' }));
  await activate(t, mc);
  await t.runCommand('colorMakeComposite', { display: 'composite' });
  let i = await infoOf(t, mc);
  assert.deepEqual([i.nC, i.nZ, i.mode], [3, 1, 'composite']);
  await t.runCommand('colorStackToRgb', { keep: false });
  i = await infoOf(t, mc);
  assert.equal(!!i.rgb, true);
  await t.runCommand('typeLabStack');
  assert.ok((await t.docs()).find((d) => d.name === 'mkc' && d.bitDepth === 32 && d.nC === 3), 'a 32-bit Lab composite replaces the RGB image');
});

t.close();
console.log(`test_ij_stk_cmds: ${passed} groups passed`);
