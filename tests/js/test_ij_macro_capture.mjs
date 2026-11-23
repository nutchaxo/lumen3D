// Schema and key consistency of the dialog captures (tests/fixtures/ij-macro/ij-dialogs.json, fiji-macro-keys.json), written by
// tools/ij_fixtures/macro/DialogKeys.java. The keys come from the jar itself; this test recomputes them from the labels with a JS port
// of Macro.trimKey + GenericDialog.saveLabel's duplicate rule (and with IJMacroOptions.keyOf when ij-macro-cmds.js exists) and checks the
// recorded option strings only use keys of their dialog. SKIP when a fixture is absent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'tests', 'fixtures', 'ij-macro');
const KINDS = new Set(['GenericDialog', 'NonBlockingGenericDialog', 'YesNoCancelDialog', 'other']);
const COMP = {
  numeric: ['label', 'key', 'value', 'decimals'], slider: ['label', 'key', 'value', 'min', 'max'], string: ['label', 'key', 'value'], textarea: ['key', 'value'],
  checkbox: ['label', 'key', 'state'], choice: ['label', 'key', 'items', 'selected'], radio: ['label', 'key', 'items', 'selected'], message: ['text'], other: ['label', 'key']
};
const ROIS = new Set([null, 'rect', 'oval', 'line', 'point', 'polygon']);

const trimKey = (label) => {
  let k = label;
  let i = k.indexOf(' '); if (i > -1) k = k.slice(0, i);
  i = k.indexOf(':'); if (i > -1) k = k.slice(0, i);
  return k.toLowerCase();
};

// GenericDialog.saveLabel over the registered components of one dialog, in order
function keyOfLocal(labels) {
  const used = new Set(), out = [];
  for (const raw of labels) {
    let key = raw.length ? trimKey(raw.trim()) : raw;
    if (key.length && used.has(key)) {
      key += '_0';
      for (let n = 1; used.has(key); n++) key = key.slice(0, key.lastIndexOf('_')) + '_' + n;
    }
    used.add(key); out.push(key);
  }
  return out;
}

function optionKeys(opts) {            // key=word / key=[a b] / bare word, as Macro.getValue and GenericDialog.isMatch read them
  const out = [];
  let i = 0;
  while (i < opts.length) {
    while (opts[i] === ' ') i++;
    let j = i;
    while (j < opts.length && opts[j] !== ' ' && opts[j] !== '=') j++;
    const key = opts.slice(i, j);
    if (opts[j] === '=') {
      j++;
      if (opts[j] === '[') { const e = opts.indexOf(']', j); j = e < 0 ? opts.length : e + 1; }
      else while (j < opts.length && opts[j] !== ' ') j++;
    }
    if (key) out.push(key);
    i = j;
  }
  return out;
}

function loadIJMacroOptions() {
  const f = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio', 'ij-macro-cmds.js');
  if (!fs.existsSync(f)) return null;
  const ctx = { console };
  ctx.self = ctx.window = ctx.globalThis = ctx;
  try { vm.runInNewContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f }); } catch (e) { return null; }
  return ctx.IJMacroOptions || (ctx.IJMacroCmds && ctx.IJMacroCmds.IJMacroOptions) || null;
}

function checkDocument(name, doc, fiji) {
  assert.equal(typeof doc.imagej, 'string', name + ': imagej');
  if (fiji) assert.equal(typeof doc.fiji, 'string', name + ': fiji');
  assert.equal(doc.locale, 'ROOT', name + ': locale');
  assert.equal(doc.generator, 'tools/ij_fixtures/macro/DialogKeys.java');
  assert.ok(doc.commands && typeof doc.commands === 'object', name + ': commands');
  assert.ok(Array.isArray(doc.unrecognized), name + ': unrecognized');
  const IJO = loadIJMacroOptions();
  const stats = { commands: 0, dialogs: 0, noDialog: 0, skipped: 0, keys: 0 };
  for (const [cmd, e] of Object.entries(doc.commands)) {
    const at = name + ' / ' + JSON.stringify(cmd);
    stats.commands++;
    assert.equal(typeof e.class, 'string', at + ': class');
    assert.ok(e.menuPath === null || typeof e.menuPath === 'string', at + ': menuPath');
    const forms = ['dialogs', 'noDialog', 'skipped'].filter((k) => e[k] !== undefined);
    assert.equal(forms.length, 1, at + ': exactly one of dialogs / noDialog / skipped, got ' + forms);
    if (e.skipped !== undefined) { assert.ok(typeof e.skipped === 'string' && e.skipped, at + ': skipped reason'); stats.skipped++; continue; }
    const inp = e.input;
    assert.ok(inp && [8, 16, 24, 32].includes(inp.bitDepth), at + ': input.bitDepth');
    assert.ok(inp.dims && ['c', 'z', 't'].every((k) => Number.isInteger(inp.dims[k]) && inp.dims[k] >= 1), at + ': input.dims');
    assert.ok(ROIS.has(inp.roi), at + ': input.roi');
    assert.ok(typeof inp.binary === 'boolean' && typeof inp.composite === 'boolean' && Number.isInteger(inp.others), at + ': input flags');
    if (e.noDialog !== undefined) { assert.equal(e.noDialog, true, at); stats.noDialog++; continue; }
    assert.ok(Array.isArray(e.dialogs) && e.dialogs.length, at + ': dialogs');
    const generic = e.dialogs.filter((d) => d.kind !== 'YesNoCancelDialog').length;
    for (const [di, d] of e.dialogs.entries()) {
      const dat = at + ' dialog ' + di;
      stats.dialogs++;
      assert.ok(KINDS.has(d.kind), dat + ': kind ' + d.kind);
      assert.equal(typeof d.title, 'string', dat + ': title');
      assert.equal(typeof d.smartRecording, 'boolean', dat + ': smartRecording');
      assert.equal(typeof d.processStack, 'boolean', dat + ': processStack');
      assert.ok(d.recorded === null || typeof d.recorded === 'string', dat + ': recorded');
      assert.ok(Array.isArray(d.components), dat + ': components');
      const registered = [];
      for (const c of d.components) {
        assert.ok(COMP[c.t], dat + ': component type ' + c.t);
        for (const f of COMP[c.t]) assert.ok(f in c, dat + ': ' + c.t + ' lacks ' + f);
        if (c.t === 'numeric' || c.t === 'slider' || c.t === 'string') assert.equal(typeof c.value, 'string', dat + ': value text');
        if (c.t === 'numeric') assert.ok(Number.isInteger(c.decimals) && c.decimals >= 0, dat + ': decimals');
        if (c.t === 'slider') assert.ok(typeof c.min === 'number' && typeof c.max === 'number' && c.min <= c.max, dat + ': slider range');
        if (c.t === 'checkbox') assert.equal(typeof c.state, 'boolean', dat + ': state');
        if (c.t === 'choice' || c.t === 'radio') {
          assert.ok(Array.isArray(c.items) && c.items.length, dat + ': items of ' + c.label);
          assert.ok(c.items.includes(c.selected), dat + ': selected item of ' + c.label + ' is among its items');
        }
        if (c.t !== 'message') assert.ok(c.key === null || typeof c.key === 'string', dat + ': key type');
        if (typeof c.key === 'string' && c.t !== 'message' && c.t !== 'textarea') registered.push(c);
      }
      // keys: unique, equal to the keys the labels give (an underscore in the original label is shown as a space, so the key keeps more of it)
      const seen = new Set();
      for (const c of registered) { if (c.key !== '') assert.ok(!seen.has(c.key), dat + ': duplicate key ' + c.key); seen.add(c.key); stats.keys++; }
      if (!e.scijava) {
        const used = new Set();
        for (const c of registered) {
          let key = c.label.length ? trimKey(c.label.trim()) : c.label;
          if (key.length && used.has(key)) { key += '_0'; for (let n = 1; used.has(key); n++) key = key.slice(0, key.lastIndexOf('_')) + '_' + n; }
          const free = c.underscored || (c.t === 'radio' && c.label === '');
          if (!free) assert.equal(c.key, key, dat + ': key of label ' + JSON.stringify(c.label));
          else if (c.underscored) assert.notEqual(c.key, key, dat + ': a component flagged underscored has a key the label does not give');
          used.add(c.key);
        }
        if (IJO && IJO.keyOf && !registered.some((c) => c.underscored || (c.t === 'radio' && c.label === ''))) {
          assert.deepEqual(Array.from(IJO.keyOf(registered.map((c) => c.label))), registered.map((c) => c.key), dat + ': IJMacroOptions.keyOf agrees with the capture');
        }
      }
      // the recorded option string only names keys of this dialog (single-dialog runs record the whole command)
      if (d.recorded && generic === 1) {
        const keys = new Set(d.components.filter((c) => typeof c.key === 'string').map((c) => c.key));
        for (const k of optionKeys(d.recorded)) assert.ok(keys.has(k), dat + ': recorded key ' + JSON.stringify(k) + ' is a key of the dialog (' + d.recorded + ')');
      }
    }
  }
  return stats;
}

let ran = 0;
for (const [file, fiji] of [['ij-dialogs.json', false], ['fiji-macro-keys.json', true]]) {
  const f = path.join(DIR, file);
  if (!fs.existsSync(f)) { console.log('SKIP ' + file + ' absent (tools/ij_fixtures/macro/run_dialogkeys.sh)'); continue; }
  const stats = checkDocument(file, JSON.parse(fs.readFileSync(f, 'utf8')), fiji);
  console.log(file + ': ' + JSON.stringify(stats));
  ran++;
}
if (ran) console.log('ok');
