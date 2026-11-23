// Process › Batch › Macro… in the worker runtime (ij-proc-macro.js runBatch): BatchProcessor.processFolder / run() (Test) of ImageJ
// 1.54p through the virtual file system. Contract: DOCS/studio-advanced/macros/EXTRAS.md §8, §10.
//   • every case of tests/fixtures/ij-macro/batch-golden.json (BatchGolden.java on the jar), twice: as the operator's batch (macro.run with
//     `batch`) and as run("Macro... ", options) inside a macro with the stored folders — the Log (paths as vpaths), ImageJ's boxes, the
//     files written (names; TIFF and text pixels read back), the images processed, the error of the image that stopped it, what is stored;
//   • the list filtered and sorted as ImageJ does, skipped names, "i=<n>;" counted over the images opened, a new interpreter per image
//     in batch mode, the output image choice, setOption("SaveBatchOutput"), Test (the input image shown, nothing saved);
//   • progress events, a cancel between images, no ephemeral leftover.
// The page is the scripted page of ij_macro_rt_support.mjs; its run() knows the few commands the golden macros use (the real commands
// are tested with the page in their own suites).
//
// Run: node tests/js/test_ij_macro_batch_run.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT } from './harness.mjs';
import { xrt, withExtras, diskTree, FIX, standIn } from './ij_macro_worker_extras_support.mjs';
import { TEXTS } from './ij_macro_rt_support.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (err) { console.error('FAIL ' + name); throw err; }
}
const sha = (u8) => createHash('sha256').update(u8).digest('hex');
const J = (x) => JSON.parse(JSON.stringify(x));
if (standIn()) console.log('note: ij-macro-lang.js has no L3–L5 yet (EXTRAS.md §3): the runs use the contract stand-in of ij_macro_worker_extras_support.mjs');

// EXTRAS.md §13, English
const BTEXTS = Object.assign({}, TEXTS, {
  'dlg.mac.batch.errTitle': 'Batch Processor', 'dlg.mac.batch.noInput': 'Please choose an input folder',
  'dlg.mac.batch.badInput': 'Input does not exist or is not a folder\n \n{path}', 'dlg.mac.batch.badOutput': 'Output does not exist or is not a folder\n \n{path}',
  'dlg.mac.batch.noCode': 'There is no macro code in the text area', 'err.macInstallExt': 'File name must end with ".txt" or ".ijm" .'
});

/** Macro.getValue(options, key, null) for the run() options of the golden macros. */
function optValue(options, key) {
  const s = ' ' + (options || '');
  const i = s.indexOf(' ' + key + '=');
  if (i < 0) return null;
  let j = i + key.length + 2;
  if (s.charAt(j) === '[') { const e = s.indexOf(']', j + 1); return e < 0 ? s.substring(j + 1) : s.substring(j + 1, e); }
  const e = s.indexOf(' ', j);
  return e < 0 ? s.substring(j) : s.substring(j, e);
}

async function boot() {
  const t = withExtras(await xrt({ rt: { packages: ['multi', 'geom', 'roi', 'ana', 'io', 'edit', 'stk', 'filters'] } }));
  const page = t.page;
  page.conversions = [];
  page.prefs = { input: '', output: '', format: 'TIFF', macro: '' };
  page.answers['batch.prefs'] = () => Object.assign({}, page.prefs);
  page.answers.run = async (a) => {
    const id = a.current;
    const num = (k) => { const v = optValue(a.options, k); if (v === null) return NaN; const vv = a.vars && a.vars[v]; return vv ? (vv.n !== undefined ? vv.n : Number(vv.s)) : Number(v); };
    const roi = page.selections[id] || null;
    const done = (cur) => ({ status: 'ok', current: cur === undefined ? id : cur, created: [], closed: [] });
    switch (a.name) {
      case 'Invert': await t.ok('doc.run', { docId: id, op: 'invert', params: {}, roi, channel: null }); return done();
      case 'Add...': await t.ok('doc.run', { docId: id, op: 'math', params: { op: 'add', value: num('value') }, roi, channel: null }); return done();
      case 'Square': await t.ok('doc.run', { docId: id, op: 'math2', params: { op: 'sqr' }, roi, channel: null }); return done();
      case 'Crop': await t.ok('doc.run', { docId: id, op: 'crop', params: {}, roi, channel: null }); delete page.selections[id]; return done();
      case 'Canvas Size...': await t.ok('doc.run', { docId: id, op: 'canvasSize', params: { width: num('width'), height: num('height'), position: 'center' }, roi: null, channel: null }); return done();
      case 'Duplicate...': {
        const r = await t.ok('doc.duplicate', { docId: id, name: optValue(a.options, 'title') || 'dup' });
        if (!page.images.some((x) => x.docId === r.docId)) {
          const info = await t.ok('doc.info', { docId: r.docId });
          const inf = info.info || info;
          page.images.push({ docId: r.docId, id: page.nextId--, title: inf.name, hidden: !!inf.hidden, changes: false });
        }
        page.current = r.docId;
        return done(r.docId);
      }
      case '8-bit': case '8-bit Color': page.conversions.push([a.name, a.options, id]); return done();
      case 'Macro... ': {
        const values = {};
        // as the page's fileRequest names them: the field ids of the batchMacro extra (format, add, filter, code)
        for (const [k, id] of [['output_format', 'format'], ['add', 'add'], ['file', 'filter'], ['text1', 'code']]) { const v = optValue(a.options, k); if (v !== null) values[id] = v; }
        return { status: 'file', file: { op: 'batchMacro', values }, current: id, created: [], closed: [] };
      }
      default: return { status: 'unrecognized', text: 'Unrecognized command: "' + a.name + '"', current: id, created: [], closed: [] };
    }
  };
  return t;
}

function grantFolders(t, gc, o = {}) {
  const inDisk = t.disk(diskTree(gc.input));
  const outDisk = t.disk({});
  t.grants.length = 0;
  t.grant('Data', inDisk, { mode: 'allow' });
  t.grant('Out', outDisk, { mode: 'allow' });
  void o;
  return { inDisk, outDisk };
}
/** ImageJ's Log of a golden case with the machine path of its input folder written as the vpath /Data/. */
function mapLog(gc, lines) {
  const prefix = path.join(ROOT, 'tests', 'fixtures', 'ij-macro', gc.input).replace(/\\/g, '/') + '/';
  // the golden writes its machine folders as <input>/ and <output>/ (older captures: the absolute path)
  return lines.map((l) => l.split(prefix).join('/Data/').split('<input>/').join('/Data/').split('<output>/').join('/Out/'));
}
/** The Log lines of a run's print() strings, by the Log's own rules (IJ.log + TextPanel: the Clear command, a newline splits a line). */
const logOf = (t, r) => J(t.W.IJMacroProto.log.apply([], r.log));
/* A text file whose only line holds words is a NaN row for ImageJ's TextReader (its "header" crop keeps the row); the Studio's text image
 * reader (IJTextIo.parseTextImage, not this suite's file) refuses it as "header only", so the batch logs it as no image. */
const TEXT_HEADER_ONLY = { 'index-values': { name: 'notes.txt', index: 2 } };
function expectedLog(name, gc) {
  const want = mapLog(gc, gc.log);
  const k = TEXT_HEADER_ONLY[name];
  if (!k) return want;
  return want.map((l) => (l === 'i=' + k.index + ' ' + k.name ? 'openImage() and openUsingBioFormats() returned null: /Data/' + k.name : l));
}
function pixelsSha(t, name, bytes) {
  if (/\.tiff?$/.test(name)) {
    return Promise.resolve(t.W.IJTiff.read(bytes, name)).then((im) => {
      const parts = [];
      for (let pi = 0; pi < (im.nZ || 1) * (im.nT || 1); pi++) for (const ch of im.channels) { const p = ch.planes ? ch.planes[pi] : ch.data; parts.push(new Uint8Array(p.buffer, p.byteOffset, p.byteLength)); }
      const h = createHash('sha256');
      for (const p of parts) h.update(p);
      return h.digest('hex');
    });
  }
  if (/\.txt$/.test(name)) {
    const im = t.W.IJTextIo.parseTextImage(new TextDecoder().decode(bytes));
    const f = im.data instanceof Float32Array ? im.data : Float32Array.from(im.data);
    return Promise.resolve(sha(new Uint8Array(f.buffer, f.byteOffset, f.byteLength)));
  }
  return Promise.resolve(null);
}

const G = (() => { const p = path.join(FIX, 'batch-golden.json'); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; })();

async function checkOutputs(t, gc, outDisk, what) {
  const want = Object.keys(gc.outputs || {}).sort();
  const got = Array.from(outDisk.files.keys()).sort();
  assert.deepEqual(got, want, what + ': files written');
  for (const name of want) {
    const px = gc.outputs[name].pixels;
    if (!px) continue;
    // the 8-bit conversion of "8-bit TIFF" is a page command (tested with the page): its pixels are not this suite's
    if (gc.options.output_format === '8-bit TIFF' && px.bitDepth === 8) continue;
    const s = await pixelsSha(t, name, outDisk.bytes(name));
    if (s !== null) assert.equal(s, px.sha256, what + ': pixels of ' + name);
  }
}

if (!G) console.log('SKIP batch-golden.json absent: the golden sweep (CAPTURE writes it)');
else {
  await test('every batch-golden.json case as the operator\'s batch (macro.run with batch): Log, boxes, files, pixels, images processed, error', async () => {
    let n = 0;
    for (const [name, gc] of Object.entries(G.cases)) {
      const t = await boot();
      try {
        const { outDisk } = grantFolders(t, gc);
        const code = gc.options.code !== null && gc.options.code !== undefined ? gc.options.code : gc.storedMacro;
        const format = gc.options.output_format || 'PNG';
        const input = gc.mode === 'badInput' ? '/Data/missing/' : '/Data/';
        const output = gc.output ? (gc.mode === 'badOutput' ? '/Out/missing/' : '/Out/') : '';
        const d0 = t.page.dialogs.length;
        const r = await t.runFX(code, { batch: { input, output, format, filter: gc.options.file || '', test: gc.mode === 'test' } }, { texts: BTEXTS });
        assert.ok(r.result, name + ': macro.run answered ' + JSON.stringify(r.error));
        // a runMacro case's Log is the calling macro's (the second test runs it)
        assert.deepEqual(logOf(t, r), gc.mode === 'runMacro' ? [] : expectedLog(name, gc), name + ': Log ' + JSON.stringify(r.result.error));
        const boxes = t.page.dialogs.slice(d0).filter((x) => x[0] === 'dialog.message').map((x) => ({ title: x[1].title, text: x[1].text }));
        const wantBoxes = gc.dialogs.map((x) => ({ title: x.title, text: x.text.replace(/\n \n.*\/missing\/$/, '\n \n' + (gc.mode === 'badInput' ? input : output)) }));
        assert.deepEqual(boxes, wantBoxes, name + ': boxes');
        if (gc.error) {
          assert.ok(r.result.error, name + ': the image\'s error is the run\'s');
          assert.equal(r.result.error.message, gc.error.message, name + ': error message');
          assert.equal(r.result.error.line, gc.error.line, name + ': error line');
          assert.equal(r.result.error.dialogText, gc.error.dialog, name + ': Macro Error text');
        } else assert.equal(r.result.error, null, name + ': no error ' + JSON.stringify(r.result.error));
        const b = r.result.batch;
        assert.ok(b, name + ': result.batch');
        if (gc.processed.from === 'log' || gc.processed.from === 'none') assert.deepEqual(J(b.processed), gc.processed.names.filter((x) => !(TEXT_HEADER_ONLY[name] && TEXT_HEADER_ONLY[name].name === x)), name + ': processed');
        if (gc.mode === 'test') {
          assert.ok(b.testDocId !== null, name + ': the test image is shown');
          const im = t.page.images.find((x) => x.docId === b.testDocId);
          assert.ok(im && !im.hidden && im.title === gc.testImage.title, name + ': test image ' + JSON.stringify(im));
          const d = t.eng.inspectDoc(b.testDocId);
          const p = d.channels[0].planes[0];
          assert.equal(sha(new Uint8Array(p.buffer, p.byteOffset, p.byteLength)), gc.testImage.sha256, name + ': test image pixels');
          assert.equal(outDisk.files.size, 0, name + ': Test saves nothing');
        } else await checkOutputs(t, gc, outDisk, name);
        // ImageJ closes every image of the batch (openImagesAfter), the Studio drops its ephemeral documents
        // the shown test image becomes an ordinary image through the page's image.show (doc.persist), which this scripted page does not model
        const left = t.page.images.filter((x) => x.docId !== b.testDocId && (x.hidden || (t.eng.inspectDoc(x.docId) && t.eng.inspectDoc(x.docId).ephemeral)));
        assert.deepEqual(left.map((x) => x.title), [], name + ': no ephemeral leftover');
        assert.deepEqual(t.page.images.filter((x) => !x.hidden).map((x) => x.title), gc.openImagesAfter || [], name + ': images open after');
        if (gc.options.output_format === '8-bit TIFF') {
          const want = gc.files.map((f) => (f.kind === 'rgb' ? '8-bit Color|number=256' : '8-bit|'));
          assert.deepEqual(t.page.conversions.map((c) => c[0] + '|' + c[1]), want, name + ': the INPUT images converted first');
        }
        n++;
      } finally { t.close(); }
    }
    assert.ok(n >= 8, 'at least 8 cases (' + n + ')');
  });

  await test('the macro-mode cases as run("Macro... ", options) inside a macro: stored folders, ImageJ\'s abort after a box, errors shown and the macro goes on', async () => {
    for (const [name, gc] of Object.entries(G.cases)) {
      if (!gc.optionString && !gc.macro) continue;
      const t = await boot();
      try {
        const { outDisk } = grantFolders(t, gc);
        t.page.prefs = { input: gc.mode === 'badInput' ? '/Data/missing/' : '/Data/', output: gc.output ? (gc.mode === 'badOutput' ? '/Out/missing/' : '/Out/') : '',
          format: gc.options.output_format === null ? 'PNG' : 'TIFF', macro: gc.storedMacro || '' };
        const src = gc.macro || 'run("Macro... ", "' + gc.optionString.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '");';
        const d0 = t.page.dialogs.length;
        const r = await t.runFX(src, null, { texts: BTEXTS });
        assert.ok(r.result, name + ': macro.run answered');
        const boxes = t.page.dialogs.slice(d0).filter((x) => x[0] === 'dialog.message').map((x) => x[1].title + ': ' + x[1].text.split('\n')[0]);
        assert.deepEqual(boxes, gc.dialogs.map((x) => x.title + ': ' + x.text.split('\n')[0]), name + ': boxes');
        if (gc.thrown) assert.equal(r.result.aborted, true, name + ': the macro is aborted after the box (IJ.error in a macro)');
        const shown = t.page.dialogs.slice(d0).filter((x) => x[0] === 'error.show').map((x) => x[1].text);
        if (gc.error) {
          assert.deepEqual(shown, [gc.error.dialog], name + ': the image\'s Macro Error window');
          assert.equal(r.result.error, null, name + ': the calling macro goes on');
        } else assert.deepEqual(shown, [], name + ': no error window');
        assert.deepEqual(logOf(t, r), expectedLog(name, gc), name + ': Log');
        await checkOutputs(t, gc, outDisk, name + ' (nested)');
        if (!gc.thrown && gc.storedAfter) {
          const last = t.batchSaves[t.batchSaves.length - 1];
          assert.ok(last, name + ': batch.save written');
          assert.equal(last.format, gc.storedAfter['batch.format'], name + ': stored format');
          assert.ok(!('macro' in last), name + ': macro mode stores no BatchMacro.ijm of its own (ImageJ saves the text area, not the options)');
        }
      } finally { t.close(); }
    }
  });
}

await test('progress events with the file name, at most one per 100 ms plus the last; a cancel between images stops the batch', async () => {
  const t = await boot();
  try {
    const tree = {};
    const one = await (async () => {
      const id = await t.open({ name: 'p', width: 4, height: 3, bitDepth: 8, channels: [{ data: new Uint8Array(12).fill(9) }] });
      const r = await t.ok('doc.exportTiff', { docId: id });
      await t.ok('doc.close', { docId: id, discard: true });
      t.page.images = t.page.images.filter((x) => x.docId !== id);
      t.page.current = null;
      return r.bytes;
    })();
    for (const k of ['a', 'b', 'c', 'd']) tree[k + '.tif'] = one;
    t.grant('Data', t.disk(tree), { mode: 'allow' });
    t.grant('Out', t.disk({}), { mode: 'allow' });
    const r = await t.runFX('print(i);', { batch: { input: '/Data/', output: '', format: 'TIFF', filter: '', test: false } }, { texts: BTEXTS });
    assert.deepEqual(logOf(t, r), ['0', '1', '2', '3']);
    const ev = t.batchEvents.filter((e) => e.runId === r.runId);
    assert.ok(ev.length >= 1 && ev[ev.length - 1].index === 3 && ev[ev.length - 1].total === 4 && ev[ev.length - 1].name === 'd.tif', JSON.stringify(ev));
    // a cancel while the second image's macro waits: the batch stops, nothing after it runs
    let cancel = null;
    const p = t.runFX('print("start " + i); if (i == 1) wait(5000); print("end " + i);', { batch: { input: '/Data/', output: '/Out/', format: 'TIFF', filter: '', test: false } },
      { texts: BTEXTS, onStart: (h) => { cancel = h.cancel; } });
    for (let k = 0; k < 200 && !t.page.log.includes('start 1'); k++) await new Promise((res) => setTimeout(res, 10));
    await cancel();
    const r2 = await p;
    assert.equal(r2.result.aborted, true, 'aborted');
    assert.deepEqual(logOf(t, r2), ['start 0', 'end 0', 'start 1']);
    assert.deepEqual(J(r2.result.batch.saved), ['/Out/a.tif'], 'the file saved before the cancel stays');
    assert.equal(r2.result.batch.stoppedAt, 'b.tif');
    // an aborted run cannot ask the page anything more: what is left is ephemeral, which the page closes when the run ends
    assert.ok(t.page.images.filter((x) => x.hidden).every((x) => t.eng.inspectDoc(x.docId).ephemeral), 'only ephemeral leftovers');
  } finally { t.close(); }
});

await test('setOption("SaveBatchOutput", false) skips one image and is reset to true for the next; i counts only the images opened', async () => {
  const t = await boot();
  try {
    const id = await t.open({ name: 'p', width: 4, height: 3, bitDepth: 8, channels: [{ data: new Uint8Array(12).fill(3) }] });
    const tif = (await t.ok('doc.exportTiff', { docId: id })).bytes;
    await t.ok('doc.close', { docId: id, discard: true });
    t.page.images = []; t.page.current = null;
    const out = t.disk({});
    t.grant('Data', t.disk({ '.x.tif': tif, 'a.tif': tif, 'b.bin': new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 'c.tif': tif, 'd.tif': tif, 'sub/': {} }), { mode: 'allow' });
    t.grant('Out', out, { mode: 'allow' });
    const r = await t.runFX('if (i == 1) setOption("SaveBatchOutput", false); print(i + " " + getTitle());', { batch: { input: '/Data', output: '/Out', format: 'TIFF', filter: '', test: false } }, { texts: BTEXTS });
    assert.deepEqual(logOf(t, r), ['0 a.tif', 'Opener: Unsupported format or file not found:', '/Data/b.bin', 'openImage() and openUsingBioFormats() returned null: /Data/b.bin', '1 c.tif', '2 d.tif']);
    assert.deepEqual(Array.from(out.files.keys()).sort(), ['a.tif', 'd.tif']);
    assert.deepEqual(J(r.result.batch.skipped), ['.x.tif', 'b.bin', 'sub']);
  } finally { t.close(); }
});

console.log(passed + ' tests passed');
