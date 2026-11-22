// The stack built-ins of the Advanced Studio macros (js/modules/studio/advanced-studio/ij-proc-macro.js) on the REAL engine documents
// (DOCS/studio-advanced/stacks/API.md): what they print is locked by tests/js/test_ij_macro_pixels.mjs (ImageJ goldens, groups stacks/*);
// this test checks what they DO to the engine and the page:
//   • setSlice / Stack.setPosition move the engine position (a `position` event), clamped as ImagePlus.setPosition, 0 = keep;
//   • a write on a slice of a stack, of an RGB stack (three colour planes), lands in that plane only, committed through the run;
//   • newImage stacks and hyperstacks: dimensions, display mode and channel colours of a composite, ImageJ's fills on every slice, the
//     batch-mode image hidden, "label" refused (ImageJ draws text into the pixels);
//   • setMetadata("Label") writes the engine's slice label (an undo step of the run), getMetadata reads it back;
//   • Stack.setXUnit / setFrameInterval / setVoxelSize go through the package's calibration op; Stack.setDimensions / swap are refused.
//
// Run: node tests/js/test_ij_macro_stacks.mjs
import assert from 'node:assert/strict';
import { rt, okRun } from './ij_macro_rt_support.mjs';

const J = (x) => JSON.parse(JSON.stringify(x));
const t = await rt();
const doc = (id) => t.eng.inspectDoc(id);

// ---- position
{
  const r = await t.run('newImage("s", "8-bit black", 8, 8, 2, 3, 4); Stack.setPosition(2, 3, 4); id = getImageID(); print(id);');
  okRun(r, 'position');
  const id = t.page.current;
  let d = doc(id);
  assert.deepEqual([d.active, d.z, d.t], [1, 2, 3], 'the engine position (0-based)');
  assert.ok(t.log.some((m) => m.event === 'position' && m.docId === id), 'a position event for the page view');
  await t.run('Stack.setPosition(0, 99, -1);');
  d = doc(id);
  assert.deepEqual([d.active, d.z, d.t], [1, 2, 3], '0 / negative keep the current value, a value past the end is the last');
  await t.run('setSlice(1);');
  d = doc(id);
  assert.deepEqual([d.active, d.z, d.t], [0, 0, 0]);
  assert.equal(d.nZ, 3); assert.equal(d.nT, 4); assert.equal(d.channels.length, 2);
  assert.equal(d.mode, 'color', 'IJ.createImage: COLOR mode unless the type says composite / grayscale');
  assert.deepEqual(J(d.channels.map((c) => c.color)), ['#ff0000', '#00ff00']);
  assert.equal(d.hyperstack, true);
}

// ---- writes on a stack plane / an RGB stack plane
{
  let r = await t.run('newImage("z", "8-bit black", 4, 4, 3); setSlice(2); setPixel(1, 1, 200); setSlice(3); setPixel(2, 2, 100);');
  okRun(r, 'stack write');
  const id = t.page.current;
  assert.equal(t.pixels(id, 0, 0)[5], 0);
  assert.equal(t.pixels(id, 0, 1)[5], 200);
  assert.equal(t.pixels(id, 0, 2)[10], 100);
  r = await t.run('newImage("c", "RGB black", 4, 4, 2); setSlice(2); setPixel(3, 0, 0x102030);');
  okRun(r, 'rgb write');
  const c = t.page.current;
  const d = doc(c);
  assert.equal(d.rgb, true);
  assert.deepEqual([t.pixels(c, 0, 1)[3], t.pixels(c, 1, 1)[3], t.pixels(c, 2, 1)[3]], [0x10, 0x20, 0x30], 'the three colour planes of slice 2');
  assert.deepEqual([t.pixels(c, 0, 0)[3], t.pixels(c, 1, 0)[3], t.pixels(c, 2, 0)[3]], [0, 0, 0], 'slice 1 untouched');
  assert.ok(r.result.changedDocs.indexOf(c) >= 0);
}

// ---- newImage
{
  let r = await t.run('newImage("comp", "16-bit composite-mode ramp", 8, 2, 3, 2, 1);');
  okRun(r, 'composite');
  let d = doc(t.page.current);
  assert.equal(d.mode, 'composite');
  assert.equal(d.bitDepth, 16);
  assert.deepEqual(J(d.channels.map((c) => c.display.lut)), ['#ff0000', '#00ff00', '#0000ff'], 'the composite channel LUTs');
  for (let pi = 0; pi < 2; pi++) assert.equal(t.pixels(t.page.current, 2, pi)[1], Math.floor(65536 / 8 + 0.5), 'every slice ramps');
  r = await t.run('newImage("g", "8-bit grayscale-mode", 4, 4, 2, 1, 1);');
  assert.equal(doc(t.page.current).mode, 'gray');
  r = await t.run('newImage("l", "8-bit label", 4, 4, 2, 2, 1);');
  assert.equal(r.result.error.message, 'newImage("8-bit labelramp") is not available in the browser.'.replace('labelramp', 'label'));
  r = await t.run('newImage("x", "8-bit", 0, 4, 1);');
  assert.equal(r.result.error.message, 'Width or height < 1');
  r = await t.run('setBatchMode(true); newImage("hidden", "8-bit white", 4, 4, 1); print(is("batch mode")); print(getPixel(0,0));');
  assert.deepEqual(okRun(r, 'batch'), ['1', '255']);
  const hid = t.page.images.find((im) => im.title === 'hidden');
  assert.ok(hid && hid.hidden, 'a batch-mode image is hidden');
  assert.equal(doc(hid.docId).hidden, true);
  // 16-bit / 32-bit white = zeros under an inverting LUT (NewImage: "if (fill==FILL_WHITE) ip.invertLut()")
  r = await t.run('newImage("w16", "16-bit white", 4, 4, 1);');
  d = doc(t.page.current);
  assert.equal(d.channels[0].display.invert, true);
  assert.equal(t.pixels(t.page.current)[0], 0);
}

// ---- labels and calibration
{
  let r = await t.run('newImage("lab", "8-bit black", 4, 4, 3); setSlice(2); setMetadata("Label", "two"); print(getMetadata("Label")); setSlice(1); print("[" + getMetadata("Label") + "]");');
  assert.deepEqual(okRun(r, 'labels'), ['two', '[]']);
  const id = t.page.current;
  assert.equal(doc(id).labels[1], 'two', 'the engine label of slice 2');
  r = await t.run('setVoxelSize(0.5, 0.25, 2, "um"); Stack.setFrameInterval(3); Stack.setTUnit("min"); getVoxelSize(w, h, d, u); print(w+" "+h+" "+d+" "+u); print(Stack.getFrameInterval());');
  assert.deepEqual(okRun(r, 'calibration'), ['0.5 0.25 2 µm', '3']);
  const cal = doc(id).calibration;
  assert.equal(cal.pixelWidth, 0.5); assert.equal(cal.pixelHeight, 0.25); assert.equal(cal.pixelDepth, 2);
  assert.equal(cal.unit, 'µm'); assert.equal(cal.frameInterval, 3); assert.equal(cal.timeUnit, 'min');
  assert.ok(r.result.changedDocs.indexOf(id) >= 0);
  r = await t.run('Stack.setDimensions(1, 3, 1);');
  assert.equal(r.result.error.message, 'Stack.setDimensions is not available in the browser.');
  r = await t.run('newImage("one", "8-bit black", 4, 4, 1); Stack.setDisplayMode("color");');
  assert.equal(r.result.error.message, 'Stack required');
  r = await t.run('newImage("rgb", "RGB black", 4, 4, 2); print(getSliceNumber()); setSlice(2); print(getSliceNumber()); Stack.getPosition(c, z, t); print(c+" "+z+" "+t);');
  assert.deepEqual(okRun(r, 'rgb position'), ['1', '2', '1 2 1']);
}
t.close();
console.log('test_ij_macro_stacks: ok');
