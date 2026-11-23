// Process › Math › Macro… (ImageJ 1.54p ImageMath "macro"): the registry op `macroMath` of ij-macro-math.js run by the REAL engine.
// Contract: DOCS/studio-advanced/macros/EXTRAS.md §9.
//   • every case of tests/fixtures/ij-macro/math-golden.json (MathGolden.java on the jar): 8 / 16-bit bytes equal, 32-bit within one
//     float32 ulp, RGB both ways (three runs per pixel / the packed int with getPixel), selections (rectangle, oval mask), stacks (the
//     planes ImageJ processes: every slice with "stack", the current one without), the Log of print(), ImageJ's error texts;
//   • the preview of a region equals the result there; the journal replays the step (a restore on a second engine); one undo step;
//   • a Studio built-in other than getPixel / getWidth / getHeight / bitDepth / nSlices / getSliceNumber stops the code with err.macMathHost;
//   • the time of 512 × 512 8-bit "v=v*2" and "v=v+50*sin(d/10)" (printed; only a hang fails: > 20 s).
//
// Run: node tests/js/test_ij_macro_math.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { engineContext, engineClient, mathGolden, goldenImage, goldenRoi, parseMathOptions, standIn, FIX } from './ij_macro_worker_extras_support.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (err) { console.error('FAIL ' + name); throw err; }
}
if (standIn()) console.log('note: ij-macro-lang.js has no IJMacro.pixelProgram yet (EXTRAS.md L4): the op runs on the contract stand-in of ij_macro_worker_extras_support.mjs');

const W = engineContext();
const HOST_TEXT = '{name}() cannot be used in Process › Math › Macro in the browser.';
W.IJMacroMath.setTexts({ 'err.macMathHost': HOST_TEXT });

function planesOf(c, id) {
  const d = c.doc(id);
  const out = [];
  for (let pi = 0; pi < d.nZ * d.nT; pi++) for (const ch of d.channels) out.push(ch.planes[pi]);
  return { d, out };
}
/* The document's planes in the golden layout (stack order; an RGB slice = its R, G, B planes). */
function bytesOf(c, id) {
  const { out } = planesOf(c, id);
  const parts = out.map((p) => new Uint8Array(p.buffer, p.byteOffset, p.byteLength));
  const n = parts.reduce((s, p) => s + p.length, 0);
  const all = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  return all;
}
function sameFloats(got, want, what) {
  const g = new Float32Array(got.buffer, got.byteOffset, got.byteLength / 4), w = new Float32Array(want.buffer, want.byteOffset, want.byteLength / 4);
  const gi = new Int32Array(g.buffer, g.byteOffset, g.length), wi = new Int32Array(w.buffer, w.byteOffset, w.length);
  assert.equal(g.length, w.length, what + ': length');
  for (let i = 0; i < g.length; i++) {
    if (g[i] !== g[i] && w[i] !== w[i]) continue;
    assert.ok(Math.abs(gi[i] - wi[i]) <= 1, what + ': value ' + i + ' ' + g[i] + ' vs ImageJ ' + w[i]);
  }
}
function sameBytes(got, want, what) {
  assert.equal(got.length, want.length, what + ': length');
  for (let i = 0; i < got.length; i++) if (got[i] !== want[i]) assert.fail(what + ': byte ' + i + ' = ' + got[i] + ', ImageJ ' + want[i]);
}
async function runCase(c, gc, extra = {}) {
  const img = goldenImage(gc, gc.input);
  const id = await c.open(img);
  const n = gc.image.slices || 1;
  const cur = (gc.image.currentSlice || 1) - 1;
  if (n > 1) await c.ok('doc.setPosition', { docId: id, z: cur, t: 0 });
  const o = parseMathOptions(gc.options);
  const lines = [];
  const old = W.IJMacroMath.setLogSink((s) => lines.push(s));
  let m;
  try {
    m = await c.call('doc.run', Object.assign({ docId: id, op: 'macroMath', params: { code: o.code }, roi: goldenRoi(gc.image.roi), channel: null,
      planes: o.stack ? 'all' : 'current', pos: { z: cur, t: 0 } }, extra));
  } finally { W.IJMacroMath.setLogSink(old); }
  return { id, m, lines, o };
}

const G = mathGolden();
if (!G) console.log('SKIP math-golden.json absent: the golden sweep (CAPTURE writes it)');
else {
  await test('every math-golden.json case through the real engine op: pixels, Log and errors equal ImageJ\'s', async () => {
    let n = 0;
    for (const [name, gc] of Object.entries(G.cases)) {
      if (gc.timingOnly) continue;
      const c = engineClient(W);
      try {
        const { id, m, lines } = await runCase(c, gc);
        if (gc.error) {
          assert.ok(!m.ok, name + ': the step fails');
          assert.equal(m.error.code, 'IJ_MACRO_MATH', name + ': code');
          const e = m.error.details && m.error.details.error;
          assert.ok(e, name + ': the interpreter error travels in details.error');
          assert.equal(e.message, gc.error.message, name + ': message');
          assert.equal(e.line, gc.error.line, name + ': line');
          if (gc.error.dialog) assert.equal(e.dialogText, gc.error.dialog, name + ': Macro Error text');
        } else assert.ok(m.ok, name + ': ' + JSON.stringify(m.error));
        assert.deepEqual(lines, gc.log, name + ': Log');
        const want = fs.readFileSync(path.join(FIX, 'math', gc.data));
        const got = bytesOf(c, id);
        if (gc.image.bitDepth === 32) sameFloats(got, new Uint8Array(want.buffer, want.byteOffset, want.byteLength), name);
        else sameBytes(got, new Uint8Array(want.buffer, want.byteOffset, want.byteLength), name);
        n++;
      } finally { c.dispose(); }
    }
    assert.ok(n >= 15, 'at least 15 compared cases (' + n + ')');
  });

  await test('the preview of a region shows the values of the step there (x, y, d, a relative to the whole plane)', async () => {
    for (const name of ['default-sin-d', 'rect-roi-xd', 'rgb-getpixel-packed', 'getpixel-32bit']) {
      const gc = G.cases[name];
      if (!gc) continue;
      const c = engineClient(W);
      try {
        const img = goldenImage(gc, gc.input);
        const id = await c.open(img);
        const o = parseMathOptions(gc.options);
        const Wd = gc.image.width, H = gc.image.height;
        const box = { x0: Math.floor(Wd / 3), y0: Math.floor(H / 4), x1: Wd - 2, y1: H - 1 };
        const roi = goldenRoi(gc.image.roi);
        const r = await c.ok('doc.preview', Object.assign({ docId: id, op: 'macroMath', params: { code: o.code }, seq: 7, level: 0, channel: null, roi, pos: { z: 0, t: 0 } }, box));
        assert.ok(!r.dropped, name + ': preview answered');
        const ev = c.log.find((x) => x.event === 'preview' && x.seq === 7);
        assert.ok(ev, name + ': preview event');
        await c.ok('doc.run', { docId: id, op: 'macroMath', params: { code: o.code }, roi, channel: null });
        const d = c.doc(id);
        for (const k of Object.keys(ev.channels)) {
          const plane = d.channels[k].planes[0], pv = ev.channels[k];
          for (let y = 0; y < ev.h; y++) for (let x = 0; x < ev.w; x++) {
            const a = pv[y * ev.w + x], b = plane[(ev.y0 + y) * Wd + ev.x0 + x];
            if (a !== b && !(a !== a && b !== b)) assert.fail(name + ': preview (' + (ev.x0 + x) + ',' + (ev.y0 + y) + ') ch ' + k + ' = ' + a + ', step ' + b);
          }
        }
      } finally { c.dispose(); }
    }
  });
}

await test('one undo step; the journal keeps { code } and a restore on a second engine replays it to the same pixels', async () => {
  const storage = W.IJEngine.createMemoryStorage();
  const key = 'ds1|math|replay';
  const a = engineClient(W, { storage });
  const N = 24 * 16;
  const planes = [0, 1].map((z) => { const p = new Uint8Array(N); for (let i = 0; i < N; i++) p[i] = (i * 7 + z * 50) & 255; return p; });
  const img = { name: 'r', width: 24, height: 16, bitDepth: 8, nZ: 2, nT: 1, calibration: { pixelWidth: 1, pixelHeight: 1, pixelDepth: 1, unit: 'pixel' },
    channels: [{ name: 'C1', color: '#ffffff', planes: planes.map((p) => p.slice()) }] };
  const id = await a.open(img, { sessionKey: key });
  const code = 'v=v*2+z+getPixel(x+1,y)%3';
  await a.ok('doc.run', { docId: id, op: 'macroMath', params: { code }, roi: { type: 'oval', x: 3, y: 2, w: 15, h: 11 }, channel: null, planes: 'all' });
  const live = a.doc(id).channels[0].planes.map((p) => Array.from(p));
  assert.notDeepEqual(live[0], Array.from(planes[0]), 'the step changed the pixels');
  assert.equal(a.doc(id).undo.length, 1, 'one undo step');
  await a.eng.whenIdle();
  const jr = (await storage.load(key)).docs[id].journal.filter((e) => e.kind === 'run');
  assert.equal(jr.length, 1);
  assert.equal(jr[0].op, 'macroMath');
  assert.deepEqual(JSON.parse(JSON.stringify(jr[0].params)), { code });
  a.dispose();
  const b = engineClient(W, { storage });
  await b.ok('session.restore', { key });
  assert.deepEqual(b.doc(id).channels[0].planes.map((p) => Array.from(p)), live, 'baseline + journal replay = the live result');
  await b.ok('doc.undo', { docId: id });
  assert.deepEqual(b.doc(id).channels[0].planes.map((p) => Array.from(p)), planes.map((p) => Array.from(p)), 'undo gives the planes back');
  b.dispose();
});

await test('getSliceNumber / nSlices / bitDepth / getWidth answer the temp image of one slice; other Studio built-ins stop with err.macMathHost', async () => {
  const c = engineClient(W);
  try {
    const N = 8 * 4;
    const planes = [0, 1, 2].map(() => new Uint8Array(N));
    const id = await c.open({ name: 's', width: 8, height: 4, bitDepth: 8, nZ: 3, nT: 1, calibration: { pixelWidth: 1, pixelHeight: 1, pixelDepth: 1, unit: 'pixel' },
      channels: [{ name: 'C1', color: '#ffffff', planes }] });
    await c.ok('doc.run', { docId: id, op: 'macroMath', params: { code: 'v=getSliceNumber()*100+nSlices()*10+bitDepth()/8+getWidth()-getHeight()' }, roi: null, channel: null, planes: 'all' });
    // ImageMath's temp image new ImagePlus("", ip): one slice, current slice 1, whatever plane of the stack is processed
    for (const p of c.doc(id).channels[0].planes) assert.equal(p[0], 100 + 10 + 1 + 4);
    for (const [code, name] of [['v=getTitle()', 'getTitle'], ['run("Invert"); v=1;', 'run'], ['v=nImages', 'nImages'], ['setPixel(0,0,1); v=1;', 'setPixel']]) {
      const m = await c.call('doc.run', { docId: id, op: 'macroMath', params: { code }, roi: null, channel: null });
      assert.ok(!m.ok, code + ' refused');
      assert.equal(m.error.code, 'IJ_MACRO_MATH');
      assert.ok(m.error.details && m.error.details.error && m.error.details.error.message.startsWith(HOST_TEXT.replace('{name}', name)), code + ': ' + JSON.stringify(m.error.details));
    }
    const bad = await c.call('doc.run', { docId: id, op: 'macroMath', params: { code: 'x'.repeat(65537) }, roi: null, channel: null });
    assert.equal(bad.error.code, 'IJ_BAD_ARGS', 'a code over 65 536 characters');
  } finally { c.dispose(); }
});

await test('timing: 512 x 512 8-bit "v=v*2" and "v=v+50*sin(d/10)" through the real engine op', async () => {
  for (const code of ['v=v*2', 'v=v+50*sin(d/10)']) {
    const c = engineClient(W);
    try {
      const Wd = 512, H = 512, p = new Uint8Array(Wd * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < Wd; x++) p[y * Wd + x] = (x * 5 + y * 3) & 255;
      const id = await c.open({ name: 'perf', width: Wd, height: H, bitDepth: 8, nZ: 1, nT: 1, calibration: { pixelWidth: 1, pixelHeight: 1, pixelDepth: 1, unit: 'pixel' },
        channels: [{ name: 'C1', color: '#ffffff', planes: [p] }] });
      const t0 = performance.now();
      await c.ok('doc.run', { docId: id, op: 'macroMath', params: { code }, roi: null, channel: null });
      const ms = performance.now() - t0;
      const jar = G && Object.values(G.cases).find((k) => k.timingOnly && k.options === 'code=' + code);
      console.log('macroMath ' + code + ': ' + ms.toFixed(0) + ' ms' + (jar ? ' (ImageJ ' + jar.jarMs + ' ms)' : '') + (standIn() ? ' [stand-in language]' : ''));
      assert.ok(ms < 20000, 'no hang');
    } finally { c.dispose(); }
  }
});

console.log(passed + ' tests passed');
