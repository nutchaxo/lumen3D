// The file corpus of ImageJ 1.54p (FILES.md §15) run by the whole Advanced Studio: every case of tests/fixtures/ij-macro/files-golden.json
// (recorded by tools/ij_fixtures/macro/FileGolden.java) runs through the real page (Macro Editor, run() bridge, Studio commands), the real
// worker (engine, codecs, language, ij-macro-vfs.js, ij-proc-macro.js) and a fake user folder granted as /ijm-vfs-golden/ (File System
// Access, mode Allow, FILES.md §15.1), and is compared with the jar: the Log, the error (message + line), a quiet stop, the message boxes,
// the final tree of the folder (bytes, decoded pixels, ZIP entries) and the images left open.
//
// The inputs are the files of <case>/in/ as the jar wrote them (setup.ijm is the jar's recipe for them, never run here). Each case starts on
// a new mount (the Studio opened again: new dialog statics, FILES.md F13) with no image, an empty ROI Manager, Results and Log.
//
// What Node cannot run is listed as "browser-only" with its reason, never as a SKIP line (run_all.py --strict-skips would fail the
// file; the browser pass of FILES.md §18.15 compares those cases): decoding an 8-bit / RGB PNG, a JPEG,
// a GIF or a BMP (createImageBitmap), encoding a JPEG (OffscreenCanvas). Differences proven to be ImageJ artefacts are listed in
// EXCEPTIONS with the proof.
//
// Run: node tests/js/test_ij_macro_files_golden.mjs [filter]
process.env.TZ = 'UTC';
// a run that never settles empties the event loop and Node exits 0: count that as a failure
let finished = false;
process.on('exit', (code) => { if (!finished && code === 0) { console.error('FAIL: the test stopped before its end (a promise never settled)'); process.exitCode = 1; } });
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';
import { fileBoot, folder, pixelDigest, messageBoxes, sha } from './ij_macro_files_e2e_support.mjs';

const GOLDEN = process.env.IJ_FILES_GOLDEN || path.join(ROOT, 'tests', 'fixtures', 'ij-macro', 'files-golden.json');
const CORPUS = path.join(ROOT, 'tests', 'fixtures', 'ij-macro', 'files');
const ROOT_NAME = 'ijm-vfs-golden';
const VROOT = '/' + ROOT_NAME + '/';
if (!fs.existsSync(GOLDEN)) {
  console.log('SKIP test_ij_macro_files_golden: tests/fixtures/ij-macro/files-golden.json is absent (tools/ij_fixtures/macro/run_files.sh writes it)');
  finished = true;
  process.exit(0);
}
const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));

// ---------------------------------------------------------------- schema (FILES.md §15.3)
assert.equal(golden.imagej, '1.54p', 'recorded with ImageJ 1.54p');
assert.equal(golden.root, VROOT, 'the {ROOT} of the corpus');
assert.ok(golden.cases && typeof golden.cases === 'object', 'cases');
const PIX_KEYS = ['w', 'h', 'c', 'z', 't', 'bitDepth', 'sha256'];
for (const [name, c] of Object.entries(golden.cases)) {
  assert.ok(/^[a-z0-9-]+\/[a-z0-9-]+$/.test(name), 'case name ' + name);
  assert.ok(Array.isArray(c.log), name + ': log');
  assert.ok(c.error === null || (typeof c.error.message === 'string' && Number.isInteger(c.error.line)), name + ': error');
  assert.ok(c.dialogs === undefined || Array.isArray(c.dialogs), name + ': dialogs');
  assert.ok(Array.isArray(c.tree || []), name + ': tree');
  for (const e of c.tree || []) {
    assert.ok(typeof e.path === 'string' && ['bytes', 'pixels', 'zipEntries', 'dims', 'exists'].indexOf(e.cmp) >= 0, name + ': tree entry ' + JSON.stringify(e));
    if (e.cmp === 'pixels') assert.ok(e.pixels && PIX_KEYS.every((k) => e.pixels[k] !== undefined), name + ': pixels of ' + e.path);
  }
  for (const im of c.images || []) assert.ok(typeof im.title === 'string' && im.pixels && PIX_KEYS.every((k) => im.pixels[k] !== undefined), name + ': image');
  assert.ok(fs.existsSync(path.join(CORPUS, ...name.split('/'), 'macro.ijm')), name + ': macro.ijm in the corpus');
}

// ---------------------------------------------------------------- what Node cannot run, and proven ImageJ artefacts
const PICTURE_OPEN = /open\s*\([^)]*\.(png|jpe?g|gif|bmp)\b/i;
const JPEG_WRITE = /saveAs\s*\(\s*"(jpeg|jpg)"|run\s*\(\s*"Jpeg\.\.\."/i;
function skipReason(name, src) {
  if (PICTURE_OPEN.test(src) && name !== 'open/png-16') return 'decodes an 8-bit / RGB PNG, a JPEG, a GIF or a BMP (createImageBitmap, a browser API)';
  if (/run\s*\(\s*"(PNG|Gif|BMP)\.\.\." *,[^)]*\bopen=/i.test(src)) return 'decodes a picture (createImageBitmap, a browser API)';
  if (JPEG_WRITE.test(src)) return 'encodes a JPEG (OffscreenCanvas, a browser API)';
  return null;
}
// a tree entry whose bytes cannot be identical because the jar's encoder differs (FILES.md §15.3: `size` binds only for `bytes` entries)
const PICTURE_TREE = /\.(png|jpe?g|gif|bmp)$/i;
//
// Macro.abort() (IJ.java error(title, msg), RoiManager.error, Macro_Runner) throws only on a thread whose name ends with "Macro$"
// (ij/Macro.java abort(): `if (Thread.currentThread().getName().endsWith("Macro$")) throw new RuntimeException(MACRO_CANCELED)`), the
// name ImageJ gives every macro thread it starts; FileProbe runs the macro on its own main thread, so the jar went on after these
// dialogs. The Studio stops as ImageJ does in a real macro thread: the Log ends where the dialog came (`afterLog`), the run aborts quietly.
const abortsAfterDialog = (want, got) => {
  const at = want.dialogs && want.dialogs.length ? want.dialogs[want.dialogs.length - 1].afterLog : null;
  if (at === null || !got.aborted) return got.problems;
  const logOk = JSON.stringify(got.log) === JSON.stringify(want.log.slice(0, at).map(norm));
  return got.problems.filter((p) => !(p === 'the macro stopped quietly' || (logOk && p.startsWith('log '))));
};
// The Studio does not write GIF, AVI, BMP, PGM or FITS files (FILES.md F18; the formats this phase writes are tiff, png, jpeg, zip, raw,
// text image, text, results, selection, xy coordinates, lut): the jar writes them, the Studio stops with err.macSaveFormat at that line.
const refusesFormat = (want, got) => (got.error && /^(gif|avi|bmp|pgm|fits) files cannot be written in the browser\.$/.test(got.error.message) ? [] : got.problems);
// The File System Access API cannot set a file's modification time: File.copy into a folder written in place cannot keep the source's
// (Tools.copyFile does; FILES.md §4.4 FSA backend). Only that line of the Log may differ.
const copyKeepsNoMtime = (want, got) => got.problems.filter((p) => !(p.startsWith('log ') && JSON.stringify(got.log) === JSON.stringify(want.log.map(norm).map((l) => l.replace(/^mtime dst kept 1$/, 'mtime dst kept 0')))));
// FILES.md F15 (user decision): a File.open writer's text reaches its file at every tick, at File.close and at the end of the run, also
// after an error; ImageJ loses an unclosed PrintWriter's buffer (the jar's file stays empty). The Studio's file holds what was printed.
const NL = String.fromCharCode(10);
const writerFlushed = (expected) => (want, got) => got.problems.filter((p) => {
  const m = /^bytes of (\S+) \(/.exec(p);
  return !(m && expected[m[1]] !== undefined && got.text(m[1]) === expected[m[1]]);
});
// FileGolden turns CRLF into LF only in text files (TEXT_EXT); the jar on Windows ended print(f, …) lines of fresh.dat with the
// platform's "\r\n" (PrintWriter.println), while the platform a macro sees writes "\n" (FILES.md F5).
const windowsLineEnd = (want, got) => (got.text('fresh.dat') === 'fresh\n' ? got.problems.filter((p) => !/^(log \["created 6"\]|bytes of fresh\.dat)/.test(p)) : got.problems);
// The same Windows artefact in a length the macro printed: the jar's File.length counts one CR per line of a file its PrintWriter wrote.
const windowsLength = (rel, prefix) => (want, got) => {
  const text = got.text(rel);
  if (text === null) return got.problems;
  const n = text.split(NL).length - 1;
  const fixed = got.log.map((l) => (l === prefix + utf8Len(text) ? prefix + (utf8Len(text) + n) : l));
  return JSON.stringify(fixed) === JSON.stringify(want.log.map(norm)) ? got.problems.filter((p) => !p.startsWith('log ')) : got.problems;
};
const utf8Len = (t) => Buffer.byteLength(t, 'utf8');
const EXCEPTIONS = {
  'table/save-open': windowsLength('t.csv', 'saved '),
  'file/copy': copyKeepsNoMtime,
  'file/writer-error-open': writerFlushed({ 'w.txt': 'written before the error' + NL }), 'file/writer-twice': writerFlushed({ 'w1.txt': 'first' + NL }),
  'file/writer-new-other-suffix': windowsLineEnd,
  'open/missing': abortsAfterDialog, 'open/zip-other': abortsAfterDialog, 'macro/runmacro-missing': abortsAfterDialog, 'roi/open-missing': abortsAfterDialog,
  'save/avi': refusesFormat, 'save/bmp': refusesFormat, 'save/gif': refusesFormat,
  'runcmd/save-bmp': refusesFormat, 'runcmd/save-gif': refusesFormat, 'runcmd/save-pgm': refusesFormat, 'runcmd/save-fits': refusesFormat
};

// ---------------------------------------------------------------- helpers
const norm = (s) => String(s).replace(/\r\n/g, '\n');
function readTree(dir, rel, caseJson, out) {
  for (const n of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, n), r = rel ? rel + '/' + n : n;
    if (fs.statSync(p).isDirectory()) { out[r + '/'] = {}; readTree(p, r, caseJson, out); continue; }
    const mtime = caseJson.mtime && caseJson.mtime[r] !== undefined ? caseJson.mtime[r] : 1700000000000;
    out[r] = { bytes: new Uint8Array(fs.readFileSync(p)), mtime };
  }
  return out;
}

// ---------------------------------------------------------------- run
const filter = process.argv[2] || '';
const t = await fileBoot();
const W = t.worker.far;
// a decoded stack image keeps one plane in `data`, several in `planes` (pi = t·nZ + z)
const planeOf = (ch, pi) => (Array.isArray(ch.planes) ? ch.planes[pi] : ch.data);
function imageDigest(im) {
  const nZ = im.nZ || 1, nT = im.nT || 1;
  if (im.rgb) return { w: im.width, h: im.height, c: 1, z: nZ, t: nT, bitDepth: 24, sha256: pixelDigest(im.width, im.height, 1, nZ, nT, 24, (c, z, tt) => im.channels.map((ch) => planeOf(ch, tt * nZ + z))) };
  const nC = im.channels.length;
  return { w: im.width, h: im.height, c: nC, z: nZ, t: nT, bitDepth: im.bitDepth, sha256: pixelDigest(im.width, im.height, nC, nZ, nT, im.bitDepth, (c, z, tt) => planeOf(im.channels[c], tt * nZ + z)) };
}
const tiffDigest = async (bytes) => imageDigest(await W.IJTiff.read(bytes, 'x.tif'));
async function pngDigest(bytes) {
  const im = await W.IJPng.decode16(bytes);
  return im ? imageDigest(im) : null;
}
// FileGolden hashes text files with CRLF turned into LF (TEXT_EXT)
const TEXT_EXT = /\.(txt|csv|tsv|xls|ijm|java|html|htm|json|md|log)$/i;
const crlfToLf = (b) => {
  const out = [];
  for (let i = 0; i < b.length; i++) if (!(b[i] === 13 && b[i + 1] === 10)) out.push(b[i]);
  return Uint8Array.from(out);
};

let root = null;
let passed = 0, browserOnly = 0;
const failures = [];
const RESET = ['setBatchMode(false);', 'close("*");', 'roiManager("reset");', 'run("Clear Results");', 'list = getList("window.titles");',
  'for (i = 0; i < list.length; i++) if (list[i] != "Results" && list[i] != "Log" && list[i] != "ROI Manager") close(list[i]);',
  'print("\\\\Clear");'].join('\n');
for (const [name, want] of Object.entries(golden.cases)) {
  if (filter && name.indexOf(filter) < 0) continue;
  const dir = path.join(CORPUS, ...name.split('/'));
  const src = fs.readFileSync(path.join(dir, 'macro.ijm'), 'utf8');
  const why = skipReason(name, src);
  if (why) { console.log('browser-only ' + name + ': ' + why); browserOnly++; continue; }
  const caseJson = fs.existsSync(path.join(dir, 'case.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8')) : {};
  const tree = fs.existsSync(path.join(dir, 'in')) ? readTree(path.join(dir, 'in'), '', caseJson, {}) : {};
  const disk = folder(ROOT_NAME, tree);
  if (!root) root = await t.grantFolder(disk, { mode: 'allow' });
  else root.handle = disk.dir();
  assert.equal(root.name, ROOT_NAME, 'the folder is granted as /' + ROOT_NAME + '/');
  const pre = await t.runMacro(RESET);
  assert.equal(pre.ok, true, name + ': the reset macro ran ' + JSON.stringify(pre.error));
  t.newMount();
  const d0 = t.log.dialogSpecs.length, e0 = t.log.events.length;
  const r = await t.runMacro(src.split('{ROOT}').join(VROOT));
  const problems = [];
  const log = t.log.events.slice(e0).filter((m) => m.event === 'ext:macro.log').flatMap((m) => m.lines).map(norm);
  if (JSON.stringify(log) !== JSON.stringify(want.log.map(norm))) problems.push('log ' + JSON.stringify(log) + ' != ' + JSON.stringify(want.log));
  const err = r.error && !r.aborted && !r.exited ? r.error : null;
  if (want.error === null && err) problems.push('unexpected error ' + JSON.stringify(err.message) + ' line ' + err.line);
  if (want.error !== null) {
    if (!err) problems.push('missing error ' + JSON.stringify(want.error.message));
    else {
      if (norm(err.message) !== norm(want.error.message)) problems.push('error ' + JSON.stringify(err.message) + ' != ' + JSON.stringify(want.error.message));
      if (!want.error.silent && err.line !== want.error.line) problems.push('error line ' + err.line + ' != ' + want.error.line);
    }
  }
  if (want.exited && !(r.aborted || r.exited)) problems.push('the macro should have stopped quietly');
  if (!want.exited && want.error === null && (r.aborted || r.exited) && !/\bexit\b/.test(src)) problems.push('the macro stopped quietly');
  const boxes = messageBoxes(t, d0).map((b) => norm(b.text));
  const wantBoxes = (want.dialogs || []).map((b) => norm(b.text));
  if (JSON.stringify(boxes) !== JSON.stringify(wantBoxes)) problems.push('dialogs ' + JSON.stringify(boxes) + ' != ' + JSON.stringify(wantBoxes));
  // the final tree of the folder
  const mine = disk.tree();
  const myPaths = Object.keys(mine).sort();
  const wantPaths = (want.tree || []).map((e) => e.path).sort();
  if (JSON.stringify(myPaths) !== JSON.stringify(wantPaths)) problems.push('tree ' + JSON.stringify(myPaths) + ' != ' + JSON.stringify(wantPaths));
  for (const e of want.tree || []) {
    if (!mine[e.path] || e.cmp === 'exists' || e.cmp === 'dims') continue;
    const b = TEXT_EXT.test(e.path) ? crlfToLf(disk.bytes(e.path)) : disk.bytes(e.path);
    if (e.cmp === 'bytes' && sha(b) !== e.sha256) problems.push('bytes of ' + e.path + ' (' + b.length + ' vs ' + e.size + ')');
    if (e.cmp === 'pixels') {
      let px = null;
      try { px = /\.tiff?$/i.test(e.path) ? await tiffDigest(b) : /\.png$/i.test(e.path) && e.pixels.bitDepth === 16 ? await pngDigest(b) : undefined; } catch (_) { px = null; }
      if (px === undefined) continue;   // an 8-bit / RGB PNG, a GIF, a BMP: decoded by a browser API (§18.15)
      if (!px || px.sha256 !== e.pixels.sha256) problems.push('pixels of ' + e.path + ' ' + JSON.stringify(px) + ' != ' + JSON.stringify(e.pixels));
    }
    if (e.cmp === 'zipEntries') {
      let entries = null;
      try { entries = await W.IJRoiCodec.zipRead(b, { inflateRaw: W.IJRoiCodec.inflateRaw }); } catch (_) { entries = null; }
      const got = entries ? entries.map((x) => ({ name: x.name, sha256: sha(x.bytes), bytes: x.bytes })).sort((p, q) => (p.name < q.name ? -1 : p.name > q.name ? 1 : 0)) : null;
      const same = got && got.length === e.entries.length && await (async () => {
        for (let i = 0; i < got.length; i++) {
          const g = got[i], w = e.entries[i];
          if (g.name !== w.name) return false;
          if (g.sha256 === w.sha256) continue;
          // the TIFF encoders differ (FILES.md §15.3): the entry's pixels against the golden image of the same title
          const img = /\.tiff?$/i.test(g.name) && (want.images || []).find((im) => im.title === g.name);
          if (!img) return false;
          let px = null;
          try { px = await tiffDigest(g.bytes); } catch (_) { px = null; }
          if (!px || px.sha256 !== img.pixels.sha256) return false;
        }
        return true;
      })();
      if (!same) problems.push('zip entries of ' + e.path + ' ' + JSON.stringify(got && got.map((x) => ({ name: x.name, sha256: x.sha256 }))) + ' != ' + JSON.stringify(e.entries));
    }
  }
  void PICTURE_TREE;
  // the images left open
  const open = await t.openImages();
  const wantImages = want.images || [];
  if (open.length !== wantImages.length) problems.push('images ' + JSON.stringify(open.map((x) => x.title)) + ' != ' + JSON.stringify(wantImages.map((x) => x.title)));
  else wantImages.forEach((w, i) => {
    const g = open[i];
    if (g.title !== w.title) problems.push('image title ' + g.title + ' != ' + w.title);
    if (g.pixels.sha256 !== w.pixels.sha256) problems.push('image pixels of ' + w.title + ' ' + JSON.stringify(g.pixels) + ' != ' + JSON.stringify(w.pixels));
    const gd = (g.file && g.file.dir) || '', gn = (g.file && g.file.name) || '';
    if (w.dir !== undefined && gd !== w.dir) problems.push('image dir of ' + w.title + ' ' + JSON.stringify(gd) + ' != ' + JSON.stringify(w.dir));
    if (w.filename !== undefined && gn !== w.filename) problems.push('image filename of ' + w.title + ' ' + JSON.stringify(gn) + ' != ' + JSON.stringify(w.filename));
  });
  // Interpreter.finishUp drops every batch-mode image (imageTable = null) when a macro ends in batch mode; FileProbe records them
  // before finishUp, the Studio after the run: the images of such a macro are not compared.
  const endsInBatch = /setBatchMode\s*\(\s*true\s*\)/.test(src) && !/setBatchMode\s*\(\s*(false|"exit)/.test(src);
  const kept = endsInBatch ? problems.filter((p) => !/^image(s| title| pixels| dir| filename) /.test(p)) : problems;
  const ex = EXCEPTIONS[name];
  const left = ex ? ex(want, { problems: kept, log, aborted: !!(r.aborted || r.exited), error: err, text: (rel) => disk.text(rel) }) : kept;
  if (left.length) { failures.push(name + ':\n    ' + left.join('\n    ')); console.log('FAIL ' + name); } else { passed++; console.log('  ok  ' + name); }
}
assert.deepEqual(t.net, [], 'no network call while the corpus ran');
t.close();
if (failures.length) {
  console.error(failures.join('\n'));
  assert.fail(failures.length + ' golden case(s) differ from ImageJ 1.54p');
}
console.log('test_ij_macro_files_golden: ' + passed + ' passed, ' + browserOnly + ' browser-only');
finished = true;
