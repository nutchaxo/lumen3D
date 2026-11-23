// call() in the Advanced Studio macros (js/modules/studio/advanced-studio/ij-proc-macro.js): the whitelist of
// DOCS/studio-advanced/macros/CALL-WHITELIST.md, its test vectors (§8) run through the REAL worker runtime with a scripted page.
// Values marked (IJ) in the document come from ij-1.54p.jar.
//
// Run: node tests/js/test_ij_macro_call.mjs
import assert from 'node:assert/strict';
import { rt, okRun } from './ij_macro_rt_support.mjs';

const J = (x) => JSON.parse(JSON.stringify(x));
const t = await rt();
const RT = t.W.IJMacroRuntime;
const CALL_REFUSED = (target) => 'call() is not available in the browser for "' + target + '".\nOnly a few ImageJ calls are emulated: ij.Prefs.get/set, ij.IJ.freeMemory/currentMemory/maxMemory/pad, RoiManager.getName, ThresholdAdjuster.setMode, ImageWindow.setNextLocation, ImagePlus.setDefault16bitRange.';

async function printed(src, o) { const r = await t.run(src, o); return okRun(r, src); }
async function failed(src, o) {
  const r = await t.run(src, o);
  assert.ok(r.result && r.result.error, src + ': an error was expected');
  return r.result.error.message;
}

// ---- the pure resolver: exact table, ImageJ's two passes, no property lookup
assert.equal(RT.resolveCall('freeMemory', []).error, "'classname.methodname' expected");
assert.equal(RT.resolveCall('java.lang.System.getProperty', ['user.home']).refused, true);
for (const bad of ['__proto__.x', 'constructor.constructor', 'toString.call', 'hasOwnProperty.x', 'IJ.pad', ' ij.IJ.pad', 'ij.IJ.pad ', 'IJ.PAD'])
  assert.equal(RT.resolveCall(bad, ['7', '3']).refused, true, bad + ' is refused');
assert.deepEqual(J(RT.resolveCall('ij.IJ.pad', ['7', '3']).javaArgs), [7, 3], 'pass 2: numbers become ints');
assert.deepEqual(J(RT.resolveCall('ij.IJ.pad', ['ab', '4']).javaArgs), ['ab', 4], 'pad(String,int)');
assert.equal(RT.resolveCall('ij.IJ.pad', ['7']).error, 'Could not find the method pad with 1 parameter(s) in class ij.IJ');
assert.equal(RT.freeMemoryText(3000000, 2147483648), '2929K of 2048MB (<1%)', 'vector 27');
assert.equal(RT.freeMemoryText(300 * 1048576, 2147483648), '300MB of 2048MB (14%)', 'vector 28');

// ---- §8 vectors through a run
assert.deepEqual(await printed('print(call("ij.IJ.pad","7","3"));'), ['007'], '1');
assert.deepEqual(await printed('print(call("ij.IJ.pad",7,3));'), ['007'], '2');
assert.deepEqual(await printed('print(call("ij.IJ.pad","7.9","3"));'), ['007'], '3');
assert.deepEqual(await printed('print(call("ij.IJ.pad","-5","4"));'), ['00-5'], '4');
assert.deepEqual(await printed('print(call("ij.IJ.pad","ab","4"));'), ['00ab'], '5');
assert.deepEqual(await printed('print(call("ij.IJ.pad",2.5e9,"4"));'), ['2147483647'], '6');
assert.deepEqual(await printed('print(call("ij.IJ.pad","1e3","6"));'), ['001000'], '7');
assert.deepEqual(await printed('print(call("ij.IJ.pad","x","-2"));'), ['x'], '8');
assert.deepEqual(await printed('print(call("ij.IJ.pad","NaN","5")); print(call("ij.IJ.pad","0x1F","5")); print(call("ij.IJ.pad","  ","3")); print(call("ij.IJ.pad","","3"));'),
  ['00NaN', '00x1F', '0  ', '000'], '9');
assert.deepEqual(await printed('print(call("ij.IJ.pad","Infinity","5")); print(call("ij.IJ.pad","-Infinity","3"));'), ['2147483647', '-2147483648'], '10');
assert.deepEqual(await printed('print(call("ij.IJ.pad",1/3,3)); print(call("ij.IJ.pad","-0.5","3")); print(call("ij.IJ.pad",".5","3")); print(call("ij.IJ.pad","5.","3")); print(call("ij.IJ.pad","7d","3")); print(call("ij.IJ.pad","+7","3")); print(call("ij.IJ.pad","7","3.9"));'),
  ['000', '000', '000', '005', '007', '007', '007'], '11');
assert.deepEqual(await printed('v=call("ij.IJ.pad","7","3"); print(v+1);'), ['0071'], '12');
assert.equal(await failed('print(call("ij.IJ.pad","7","2e10"));'), 'call(): ij.IJ.pad length is limited to 4096 in the browser', '13');
assert.equal(await failed('call("ij.IJ.pad","7");'), 'Could not find the method pad with 1 parameter(s) in class ij.IJ', '14');
assert.deepEqual(await printed('call("ij.Prefs.set","macro.k","v1"); print(call("ij.Prefs.get","macro.k","dflt"));'), ['v1'], '15');
assert.deepEqual(await printed('print(call("ij.Prefs.get","macro.none","dflt"));'), ['dflt'], '16');
assert.deepEqual(await printed('call("ij.Prefs.set","macro.n",12.5); print(call("ij.Prefs.get","macro.n","x")); call("ij.Prefs.set","macro.n",1/3); print(call("ij.Prefs.get","macro.n","x")); call("ij.Prefs.set","macro.n",7); print(call("ij.Prefs.get","macro.n","x"));'),
  ['12.5', '0.3333', '7'], '17');
assert.deepEqual(await printed('print(call("ij.Prefs.get","macro.zz",5));'), ['5'], '18');
assert.deepEqual(await printed('call("ij.Prefs.set","nodot","v"); print("after");'), ['java.lang.IllegalArgumentException: Key must have a prefix', 'after'], '19');
assert.deepEqual(await printed('call("ij.Prefs.set",".x","v"); call("ij.Prefs.set","","v"); call("ij.Prefs.set","x.","v"); print(call("ij.Prefs.get","x.","d"));'),
  ['java.lang.IllegalArgumentException: Key must have a prefix', 'java.lang.IllegalArgumentException: Key must have a prefix', 'v'], '19b');
assert.deepEqual(await printed('call("ij.Prefs.set","macro.e",""); print("["+call("ij.Prefs.get","macro.e","d")+"]");'), ['[]'], '20');
assert.equal(await failed('call("ij.Prefs.get","macro.k");'), 'Could not find the method get with 1 parameter(s) in class ij.Prefs', '21');
assert.equal(await failed('call("ij.Prefs.get","a.b","c","d");'), 'Could not find the method get with 3 parameter(s) in class ij.Prefs', '21b');
// 23: a host key is invisible, the snapshot is the macro namespace only
assert.deepEqual(await printed('print(call("ij.Prefs.get","options.ext","d"));', { prefs: { 'macro.a': '1' } }), ['d'], '23');
assert.deepEqual(await printed('print(call("ij.Prefs.get","macro.a","0"));', { prefs: { 'macro.a': '1' } }), ['1'], '22 (the page passes the stored prefs)');
// 24: quotas
{
  const prefs = {};
  for (let i = 0; i < 256; i++) prefs['macro.k' + i] = 'v';
  assert.equal(await failed('call("ij.Prefs.set","macro.extra","v");', { prefs }), 'call("ij.Prefs.set"): the browser keeps at most 256 macro preferences, 8 KB each, 64 KB in all', '24 keys');
  const r = await t.run('s = ""; for (i = 0; i < 8193; i++) s = s + "x"; call("ij.Prefs.set","macro.big",s);');
  assert.equal(r.result.error.message, 'call("ij.Prefs.set"): the browser keeps at most 256 macro preferences, 8 KB each, 64 KB in all', '24 value');
  assert.deepEqual(J(r.result.prefsWrites), {}, 'the stored entry is unchanged');
}
// 27-29: memory over the engine's accounting
{
  await t.open({ name: 'mem', width: 1000, height: 1000, bitDepth: 8, channels: [{ data: new Uint8Array(1000000) }, { data: new Uint8Array(1000000) }, { data: new Uint8Array(1000000) }] });
  const out = await printed('s = call("ij.IJ.freeMemory"); m = call("ij.IJ.maxMemory"); c = call("ij.IJ.currentMemory"); print(s); print(m); print(m+1); print(c);');
  assert.match(out[0], /^\d+(K|MB) of \d+MB \((<1|\d+)%\)$/, 'ImageJ\'s format');
  assert.match(out[1], /^\d+$/, 'a decimal string');
  assert.equal(out[2], out[1] + '1', 'a string: m+1 concatenates');
  assert.ok(Number(out[3]) >= 3000000, 'the pixels of the open images');
  assert.equal(Number(out[1]) % 1073741824, 0, 'a whole number of GiB');
  assert.equal(await failed('call("ij.IJ.freeMemory","x");'), 'Could not find the method freeMemory with 1 parameter(s) in class ij.IJ', '30');
}
assert.deepEqual(await printed('print("["+call("ij.plugin.frame.RoiManager.getName","3")+"]"); print(lengthOf(call("ij.plugin.frame.RoiManager.getName","3")));'), ['[null]', '4'], '31');
{
  t.page.roiManager.list = [{ name: 'a', docId: null, roi: { type: 'rect', x: 0, y: 0, w: 1, h: 1 } }, { name: 'b', docId: null, roi: { type: 'rect', x: 0, y: 0, w: 2, h: 2 } }];
  assert.deepEqual(await printed('print(call("ij.plugin.frame.RoiManager.getName",1)); print(call("ij.plugin.frame.RoiManager.getName","1.9")); print(call("ij.plugin.frame.RoiManager.getName","x")); print(call("ij.plugin.frame.RoiManager.getName",-1));'),
    ['b', 'b', 'null', 'null'], '32');
  t.page.roiManager.list = [];
}
{
  t.page.thresholdWindow = { docId: null, channel: 0, mode: 'red' };
  let r = await t.run('call("ij.plugin.frame.ThresholdAdjuster.setMode","B&W");');
  okRun(r, '33');
  assert.deepEqual(J(r.writes), [['thr.mode', { mode: 'bw' }]], '33: the display mode only');
  r = await t.run('call("ij.plugin.frame.ThresholdAdjuster.setMode","bogus"); call("ij.plugin.frame.ThresholdAdjuster.setMode","b&w");');
  assert.deepEqual(J(r.writes), [], '34: anything else does nothing');
  t.page.thresholdWindow = null;
  r = await t.run('call("ij.plugin.frame.ThresholdAdjuster.setMode","Red");');
  assert.deepEqual(J(r.writes), [], '34: the window is closed');
}
assert.deepEqual(await printed('call("ij.gui.ImageWindow.setNextLocation","10","20"); call("ij.gui.ImageWindow.setNextLocation",10.7,"1e12"); print("ok");'), ['ok'], '35');
assert.equal(await failed('call("ij.gui.ImageWindow.setNextLocation","a","b");'), 'Could not find the method setNextLocation with 2 parameter(s) in class ij.gui.ImageWindow', '36');
assert.deepEqual(await printed('call("ij.ImagePlus.setDefault16bitRange",0); call("ij.ImagePlus.setDefault16bitRange","13"); print("ok");'), ['ok'], '37');
assert.equal(await failed('call("ij.ImagePlus.setDefault16bitRange",12);'), 'call("ij.ImagePlus.setDefault16bitRange", 12) is not available in the browser: the 16-bit display range is automatic', '38');
assert.equal(await failed('call("ij.ImagePlus.setDefault16bitRange","12.9");'), 'call("ij.ImagePlus.setDefault16bitRange", 12) is not available in the browser: the 16-bit display range is automatic', '38b');
assert.deepEqual(await printed('s = ""+call("ij.Prefs.set","macro.q","1"); print(s); print(lengthOf(s));'), ['null', '4'], '39');
assert.deepEqual(await printed('r=call("ij.Prefs.set","macro.q","1"); print("A["+r+"]");'), ['A[0]'], '40');
assert.equal(await failed('call("freeMemory");'), "'classname.methodname' expected", '41');
assert.equal(await failed('call("java.lang.System.getProperty","user.home");'), CALL_REFUSED('java.lang.System.getProperty'), '42');
for (const tgt of ['IJ.pad', ' ij.IJ.pad', 'ij.IJ.pad ', 'IJ.PAD'])
  assert.equal(await failed('call("' + tgt + '","7","3");'), CALL_REFUSED(tgt), '43 ' + tgt);
for (const tgt of ['__proto__.x', 'constructor.constructor', 'toString.call', 'hasOwnProperty.x'])
  assert.equal(await failed('call("' + tgt + '","alert(1)");'), CALL_REFUSED(tgt), '44 ' + tgt);
for (const tgt of ['ij.plugin.frame.Recorder.recordString', 'ij.plugin.MacroInstaller.installFromJar', 'ij.IJ.wait'])
  assert.equal(await failed('call("' + tgt + '","x");'), CALL_REFUSED(tgt), '45 ' + tgt);
assert.deepEqual(await printed('x = eval("print(call(\'ij.IJ.pad\',\'7\',\'3\'));");'), ['007'], '46: the same table inside eval');
// the refused target is truncated to 200 characters
{
  const long = 'a.' + 'b'.repeat(300);
  const msg = await failed('call("' + long + '");');
  assert.equal(msg, CALL_REFUSED(long.substring(0, 200)));
}
// prefsWrites carries only this run's keys
{
  const r = await t.run('call("ij.Prefs.set","macro.one","1"); call("ij.Prefs.set","macro.two","2"); call("ij.Prefs.set","macro.one","3");', { prefs: { 'macro.keep': 'k' } });
  assert.deepEqual(J(r.result.prefsWrites), { 'macro.one': '3', 'macro.two': '2' });
}
t.close();
console.log('test_ij_macro_call: ok');
