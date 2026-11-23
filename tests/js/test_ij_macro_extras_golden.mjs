// Schema of the four goldens of the Recorder / #@ parameters / Process > Math > Macro / Process > Batch > Macro phase, recorded from the
// real ij-1.54p.jar and Fiji by tools/ij_fixtures/macro/run_extras.sh (contract DOCS/studio-advanced/macros/EXTRAS.md section 14):
// required fields and types, case counts, every referenced data file present with its sha256. SKIP per absent golden file.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ij-macro');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const isStr = (v) => typeof v === 'string';
const isNullOrStr = (v) => v === null || typeof v === 'string';
const isInt = (v) => Number.isInteger(v);
const load = (name) => {
  const p = join(ROOT, name);
  if (!existsSync(p)) { console.log('SKIP ' + name + ' absent (tools/ij_fixtures/macro/run_extras.sh)'); return null; }
  return JSON.parse(readFileSync(p, 'utf8'));
};
const checkError = (e, where) => {
  if (e === null) return;
  assert.equal(typeof e, 'object', where + ': error is an object or null');
  assert.ok(isStr(e.message), where + ': error.message');
  assert.ok(isInt(e.line), where + ': error.line');
};
let checked = 0;

// ── recorder-golden.json
const R = load('recorder-golden.json');
if (R) {
  assert.equal(R.imagej, '1.54p');
  assert.ok(isStr(R.generator));
  const ids = Object.keys(R.cases);
  assert.ok(ids.length >= 30, 'recorder: at least 30 cases, got ' + ids.length);
  const ACTIONS = new Set(['tool', 'wand', 'command', 'activate', 'window', 'chooseTool', 'lineWidth', 'threshold', 'bc', 'rm', 'channels', 'macroWait']);
  for (const id of ids) {
    const c = R.cases[id];
    const w = 'recorder ' + id;
    assert.ok(c.source === 'jar' || c.source === 'Recorder.java', w + ': source');
    if (c.source === 'Recorder.java') assert.ok(isStr(c.why), w + ': a format-only case says why');
    assert.ok(c.setup && Array.isArray(c.setup.images) && c.setup.images.length >= 1, w + ': setup.images');
    for (const im of c.setup.images) {
      assert.ok(isStr(im.title) && [8, 16, 24, 32].includes(im.bitDepth) && isInt(im.width) && isInt(im.height), w + ': image');
      assert.ok(isInt(im.c) && isInt(im.z) && isInt(im.t) && isStr(im.fill), w + ': image dims / fill');
    }
    assert.ok(isStr(c.setup.current), w + ': setup.current');
    // setup.prep: what the driver did before the Recorder text was cleared (its lines are not part of the case)
    const PREP = new Set([...ACTIONS, 'wandOptions', 'setRoi', 'calibrate', 'openWindow', 'rmAddRois']);
    for (const a of c.setup.prep || []) assert.ok(PREP.has(a.do), w + ': prep action ' + a.do);
    assert.ok(Array.isArray(c.actions) && c.actions.length >= 1, w + ': actions');
    for (const a of c.actions) assert.ok(ACTIONS.has(a.do), w + ': action ' + a.do);
    assert.ok(isStr(c.text), w + ': text');
    assert.ok(Array.isArray(c.lines) && c.lines.every(isStr), w + ': lines');
    assert.equal(c.lines.join('\n') + (c.text.endsWith('\n') ? '\n' : ''), c.text, w + ': lines = text split at newlines');
    assert.ok(isStr(c.driven) && c.driven.length > 0, w + ': driven');
    assert.equal(c.driverError, undefined, w + ': the driver completed the case');
    const f = join(ROOT, 'recorder', id + '.ijm');
    assert.ok(existsSync(f), w + ': recorder/' + id + '.ijm');
    assert.equal(readFileSync(f, 'utf8'), c.text, w + ': the .ijm file holds the text');
    checked++;
  }
}

// ── params-golden.json
const P = load('params-golden.json');
if (P) {
  assert.equal(P.fiji.ij, '1.54p');
  assert.ok(isStr(P.fiji.imagej) && isStr(P.fiji['imagej-legacy']) && isStr(P.fiji['scijava-common']));
  const ids = Object.keys(P.cases);
  assert.ok(ids.length >= 30, 'params: at least 30 cases, got ' + ids.length);
  const VIS = new Set(['NORMAL', 'MESSAGE', 'INVISIBLE', 'TRANSIENT']);
  for (const id of ids) {
    const c = P.cases[id];
    const w = 'params ' + id;
    assert.ok(isStr(c.source), w + ': source');
    const f = join(ROOT, 'params', id + '.ijm');
    assert.ok(existsSync(f), w + ': params/' + id + '.ijm');
    assert.equal(readFileSync(f, 'utf8'), c.source, w + ': the .ijm file holds the source');
    for (const name of Object.keys(c.files || {})) {
      const g = join(ROOT, 'params', id + '.' + name);
      assert.ok(existsSync(g) && readFileSync(g, 'utf8') === c.files[name], w + ': extra file ' + name);
    }
    assert.ok(c.parsed && isNullOrStr(c.parsed.error), w + ': parsed.error');
    assert.ok(Array.isArray(c.parsed.inputs) && Array.isArray(c.parsed.outputs) && Array.isArray(c.parsed.warnings), w + ': parsed lists');
    for (const it of c.parsed.inputs) {
      assert.ok(isStr(it.name) && isStr(it.type), w + ': input name / type');
      for (const k of ['label', 'description', 'style', 'min', 'max', 'stepSize', 'value', 'callback', 'declared', 'widgetLabel']) assert.ok(isNullOrStr(it[k]), w + ': input.' + k);
      assert.ok(it.choices === null || (Array.isArray(it.choices) && it.choices.every(isStr)), w + ': input.choices');
      assert.ok(typeof it.persist === 'boolean' && typeof it.required === 'boolean' && typeof it.autoFill === 'boolean', w + ': input flags');
      assert.ok(VIS.has(it.visibility), w + ': input.visibility');
      assert.ok(it.ioType === 'INPUT' || it.ioType === 'BOTH', w + ': input.ioType');
      assert.ok(isInt(it.columns), w + ': input.columns');
    }
    for (const o of c.parsed.outputs) assert.ok(isStr(o.name) && isStr(o.type), w + ': output');
    assert.ok(Array.isArray(c.runs) && c.runs.length >= 1, w + ': runs');
    for (const r of c.runs) {
      assert.equal(typeof r.inputs, 'object', w + ': run.inputs');
      for (const v of Object.values(r.inputs)) assert.ok('value' in v && isStr(v.javaType), w + ': run input value / javaType');
      assert.ok(Array.isArray(r.log) && r.log.every(isStr), w + ': run.log');
      assert.ok(r.outputs === null || typeof r.outputs === 'object', w + ': run.outputs');
      checkError(r.error, w);
      if (r.error) assert.ok(isStr(r.error.excerpt), w + ': error.excerpt');
    }
    assert.ok(c.program === null || (Array.isArray(c.program) && c.program.every((l) => /^\d+: /.test(l))), w + ': program');
    checked++;
  }
}

// ── math-golden.json
const M = load('math-golden.json');
if (M) {
  assert.equal(M.imagej, '1.54p');
  const ids = Object.keys(M.cases);
  const compared = ids.filter((id) => !M.cases[id].timingOnly);
  assert.ok(compared.length >= 15, 'math: at least 15 compared cases, got ' + compared.length);
  for (const id of ids) {
    const c = M.cases[id];
    const w = 'math ' + id;
    const im = c.image;
    assert.ok([8, 16, 24, 32].includes(im.bitDepth) && isInt(im.width) && isInt(im.height) && isInt(im.slices) && isInt(im.currentSlice), w + ': image');
    assert.ok(im.roi === null || ((im.roi.type === 'rect' || im.roi.type === 'oval') && isInt(im.roi.x) && isInt(im.roi.width)), w + ': roi');
    assert.ok(isStr(c.options), w + ': options');
    assert.ok(Array.isArray(c.log) && c.log.every(isStr), w + ': log');
    checkError(c.error, w);
    if (c.timingOnly) { assert.ok(isInt(c.jarMs), w + ': jarMs'); continue; }
    const per = im.width * im.height * im.slices * (im.bitDepth === 8 ? 1 : im.bitDepth === 16 ? 2 : im.bitDepth === 24 ? 3 : 4);
    for (const [file, digest] of [[c.input, c.inputSha256], [c.data, c.sha256]]) {
      const p = join(ROOT, 'math', file);
      assert.ok(existsSync(p), w + ': math/' + file);
      const b = readFileSync(p);
      assert.equal(b.length, per, w + ': ' + file + ' size = the planes');
      assert.equal(sha(b), digest, w + ': ' + file + ' sha256');
    }
    assert.equal(c.changed, c.inputSha256 !== c.sha256, w + ': changed flag');
    checked++;
  }
}

// ── batch-golden.json
const B = load('batch-golden.json');
if (B) {
  assert.equal(B.imagej, '1.54p');
  const ids = Object.keys(B.cases);
  assert.ok(ids.length >= 8, 'batch: at least 8 cases, got ' + ids.length);
  assert.ok(existsSync(join(ROOT, B.timeStamp)), 'batch: ' + B.timeStamp);
  for (const id of ids) {
    const c = B.cases[id];
    const w = 'batch ' + id;
    assert.equal(c.input, 'batch/' + id + '/in', w + ': input');
    const inDir = join(ROOT, c.input);
    assert.ok(existsSync(inDir) && statSync(inDir).isDirectory(), w + ': input folder');
    for (const f of c.files) {
      assert.ok(isStr(f.name) && isStr(f.kind), w + ': file entry');
      const p = join(inDir, f.name);
      assert.ok(existsSync(p), w + ': input file ' + f.name);
      assert.equal(statSync(p).isDirectory(), f.kind === 'dir', w + ': ' + f.name + ' kind');
    }
    assert.ok(c.options && 'output_format' in c.options && 'file' in c.options && 'code' in c.options, w + ': options');
    assert.equal(typeof c.output, 'boolean', w + ': output');
    assert.ok(Array.isArray(c.log) && c.log.every(isStr), w + ': log');
    checkError(c.error, w);
    assert.ok(c.processed && Array.isArray(c.processed.names) && ['log', 'outputs', 'none'].includes(c.processed.from), w + ': processed');
    for (const [rel, o] of Object.entries(c.outputs)) {
      const p = join(ROOT, 'batch', id, 'out', rel);
      assert.ok(existsSync(p), w + ': output ' + rel);
      const b = readFileSync(p);
      assert.equal(b.length, o.size, w + ': ' + rel + ' size');
      assert.equal(sha(b), o.sha256, w + ': ' + rel + ' sha256');
      if (o.pixels) assert.ok(isInt(o.pixels.width) && isInt(o.pixels.height) && [8, 16, 24, 32].includes(o.pixels.bitDepth) && isStr(o.pixels.sha256), w + ': ' + rel + ' pixels');
    }
    assert.ok(!JSON.stringify(c).match(/[A-Za-z]:[\\/](Users|Coding)|AppData/), w + ': no machine path left in the golden');
    checked++;
  }
}

console.log('ij-macro extras goldens: ' + checked + ' cases checked');
