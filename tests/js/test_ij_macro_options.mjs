// IJMacroOptions (ij-macro-cmds.js) against ImageJ 1.54p: goldens produced by the real jar (tests/fixtures/ij-macro/options-golden.json,
// tools/ij_fixtures/macro/OptionsProbe.java), the PLAN D8 probe vectors (duplicate keys, checkbox semantics) and the capture's dialogs.
import assert from 'node:assert/strict';
import { loadCmds, fixture, jnum, IJViewPure } from './ij_macro_cmds_support.mjs';

const L = loadCmds();
if (!L) { console.log('SKIP ij-macro-cmds.js absent'); process.exit(0); }
const O = L.IJMacroOptions;
const keyOf = (l) => Array.from(O.keyOf(l));
const same = (a, b, msg) => (Number.isNaN(b) ? assert.ok(Number.isNaN(a), msg) : assert.ok(Object.is(a, b), msg + ': ' + a + ' vs ' + b));

// ── semantics from the sources, whatever the fixtures
assert.equal(O.normalize(null), null);
assert.equal(O.normalize(undefined), null);
assert.equal(O.normalize(''), null, 'run("X", "") shows the dialog: Macro.setOptions("") removes the options');
assert.equal(O.normalize('sigma=2'), 'sigma=2 ');
assert.equal(O.trimKey('Sigma (Radius):'), 'sigma');
assert.deepEqual(keyOf(['Radius', 'Radius', 'Radius']), ['radius', 'radius_0', 'radius_1'], 'GenericDialog.saveLabel duplicate rule');
assert.deepEqual(keyOf(['Prune cycle method:', 'Prune ends']), ['prune', 'prune_0']);
assert.equal(O.getValue('Sigma=2 ', 'sigma', null), null, 'keys are case-sensitive in the options string');
assert.equal(O.getValue('dx=3 x=4 ', 'x', null), '4', 'a key preceded by a letter is not the key');
assert.equal(O.getValue('title=[a [b] c] ', 'title', null), 'a [b] c', 'nested brackets');
assert.equal(O.getValue('sigma=2', 'Sigma (Radius):', null), '2', 'the key argument is trimmed like a label');
assert.equal(O.isMatch('title=[my stack] ', 'stack'), false, 'not inside a bracketed literal');
assert.equal(O.isMatch('title=stack ', 'stack'), false, 'not right after =');
assert.equal(O.isMatch('sigma=2 stack ', 'stack'), true);
assert.equal(O.isMatch('sigma=2 stack', 'stack'), true, 'the normalised string ends with a space');
assert.equal(O.isMatch('', 'stack'), false);
assert.equal(O.hasWord('stack ', 'stack'), true);
assert.equal(O.hasWord('xstack ', 'stack'), true, 'hasWord is IJ.setupDialog\'s plain indexOf("stack ")');
assert.equal(O.hasWord('stacks ', 'stack'), false);
assert.equal(O.hasWord(null, 'stack'), false);
assert.equal(O.setupDialogStack('sigma=2 stack'), true);
assert.equal(O.setupDialogStack('sigma=2 slice'), false);

// ── goldens from the jar
const G = fixture('options-golden.json');
if (!G) console.log('SKIP options-golden.json absent (tools/ij_fixtures/macro/OptionsProbe.java): jar goldens not checked');
else {
  assert.equal(G.imagej, '1.54p');
  for (const [label, key] of G.trimKey) assert.equal(O.trimKey(label), key, 'trimKey ' + JSON.stringify(label));
  for (const [labels, keys] of G.keyOf) assert.deepEqual(keyOf(labels), keys, 'keyOf ' + JSON.stringify(labels));
  for (const [opts, key, v] of G.getValue) assert.equal(O.getValue(opts, key, '<default>'), v, 'getValue ' + JSON.stringify([opts, key]));
  // the jar's isMatch(s1, s2) takes s2 = key + ' ': the JS form takes the word
  for (const [opts, word, v] of G.isMatch) assert.equal(O.isMatch(opts, word.trim()), v, 'isMatch ' + JSON.stringify([opts, word]));
  for (const [opts, v] of G.normalize) assert.equal(O.normalize(opts), v, 'normalize ' + JSON.stringify(opts));
  for (const [s, v] of G.javaDouble) {
    const r = O.javaDouble(s);
    if (v === null) assert.equal(r, null, 'Double.valueOf ' + JSON.stringify(s) + ' throws');
    else same(r, jnum(v), 'Double.valueOf ' + JSON.stringify(s));
  }
  for (const [n, s] of G.javaToString) assert.equal(O.javaToString(jnum(n)), s, 'Double.toString ' + n);
  for (const [s, v] of G.parseHex) assert.equal(O.parseHex(s), v, 'parseHex ' + JSON.stringify(s));
  for (const [s, v] of G.fixString) assert.equal(O.fixString(s), v, 'Recorder.fixString ' + JSON.stringify(s));

  // GenericDialog in macro mode, through headlessAnswer: one field per vector, the jar's getNext* result
  const H = L.IJMacroCmds.headlessAnswer;
  const tr = (k, p) => k + JSON.stringify(p || {});
  let n = 0;
  for (const [opts, kind, label, dflt, res] of G.macroDialog) {
    const key = O.trimKey(label.trim()) || 'text1';
    let field;
    if (kind === 'N') field = { type: 'number', id: 'f', label, value: dflt };
    else if (kind === 'B') field = { type: 'check', id: 'f', label, value: dflt };
    else if (kind === 'C') field = { type: 'choice', id: 'f', label, value: dflt, options: ['Default', 'Huang', 'Try all'].map((x) => ({ value: x, label: x })) };
    else if (kind === 'S') field = { type: 'string', id: 'f', label, value: dflt };
    else if (kind === 'R') field = { type: 'radio', id: 'f', label, value: dflt, options: ['Bright', 'Dark'].map((x) => ({ value: x, label: x })) };
    else field = { type: 'textarea', id: 'f', label: 'Text', value: dflt };
    const entry = { name: 'Probe', cls: 'A', dialogs: [{ ij: null, title: 'Probe', keys: { f: key } }] };
    const r = H({ title: 'Probe', fields: [field] }, O.normalize(opts), { commandId: 'probe', entry, dialogIndex: 0, vars: {}, pure: IJViewPure, tr });
    const at = 'macro dialog ' + JSON.stringify([opts, kind]);
    if (res && typeof res === 'object' && res.error) {
      assert.equal(r.ok, false, at + ' is an error');
      assert.equal(r.error.text, res.error, at + ': ImageJ\'s text verbatim');
    } else if (kind === 'C' && res === 'huang') {
      // getNextChoice hands the plugin the text as typed: the Studio needs one of its options, so an item ImageJ's choice does not hold is an error
      assert.equal(r.ok, false, at);
      assert.equal(r.error.text, '"huang" is not a valid choice for "method"', at);
    } else if (kind === 'N' && (res === 'NaN' || res === 'Infinity')) {
      // the jar accepts them (Double.valueOf): the Studio's number field holds finite numbers only, its range check answers
      assert.equal(r.ok, false, at + ' is refused by the Studio field');
    } else {
      assert.equal(r.ok, true, at + ': ' + JSON.stringify(r.error));
      same(r.values.f, jnum(res), at);
    }
    n++;
  }
  console.log('jar goldens: ' + ['trimKey', 'keyOf', 'getValue', 'isMatch', 'normalize', 'javaDouble', 'javaToString', 'parseHex', 'fixString'].map((k) => k + ' ' + G[k].length).join(', ') + ', macroDialog ' + n);
}

// ── keyOf agrees with the capture (every dialog whose labels give its keys: no underscore shown as a space)
const caps = [['ij-dialogs.json', fixture('ij-dialogs.json')], ['fiji-macro-keys.json', fixture('fiji-macro-keys.json')]];
let dialogs = 0;
for (const [file, doc] of caps) {
  if (!doc) { console.log('SKIP ' + file + ' absent'); continue; }
  for (const [name, e] of Object.entries(doc.commands)) {
    if (!e.dialogs || e.scijava) continue;
    for (const d of e.dialogs) {
      const reg = d.components.filter((c) => typeof c.key === 'string' && c.t !== 'message' && c.t !== 'textarea');
      if (reg.some((c) => c.underscored || (c.t === 'radio' && c.label === ''))) continue;
      assert.deepEqual(keyOf(reg.map((c) => c.label)), reg.map((c) => c.key), file + ' ' + JSON.stringify(name) + ' / ' + d.title);
      // the recorded option string with defaults reads back the defaults through getValue / isMatch
      if (d.recorded && e.dialogs.filter((x) => x.kind !== 'YesNoCancelDialog').length === 1) {
        const opts = O.normalize(d.recorded);
        for (const c of reg) {
          if (c.t === 'checkbox') { if (opts.trim()) assert.equal(O.isMatch(opts, c.key), c.state, file + ' ' + name + ' checkbox ' + c.key); }
          else if (c.t === 'choice' || c.t === 'radio') { const v = O.getValue(opts, c.key, null); if (v !== null) assert.equal(v, c.selected, file + ' ' + name + ' ' + c.key); }
        }
      }
      dialogs++;
    }
  }
}

// ── build: the Recorder's text for Studio values
const spec = { fields: [
  { type: 'number', id: 'sigma', value: 2, decimals: 2 }, { type: 'check', id: 'scaled', value: false }, { type: 'check', id: 'all', value: false },
  { type: 'choice', id: 'method', value: 'avg', options: [{ value: 'avg', label: 'Average' }, { value: 'max', label: 'Max' }] },
  { type: 'string', id: 'title', value: 'a' }, { type: 'textarea', id: 'kernel', value: '' }, { type: 'message', id: 'm', label: 'x' }
] };
const de = { keys: { sigma: 'sigma', scaled: 'scaled', all: 'stack', method: 'projection', title: 'title', kernel: 'text1' }, items: { method: { 'Average Intensity': 'avg', 'Max Intensity': 'max' } } };
assert.equal(O.build({ sigma: 2, scaled: true, all: false, method: 'max', title: 'my image', kernel: '1 2\n3 4' }, de, spec),
  'sigma=2 scaled projection=[Max Intensity] title=[my image] text1=[1 2\\n3 4]');
assert.equal(O.build({ sigma: 2.5, scaled: false, all: true, method: 'avg', title: '', kernel: '' }, de, spec), 'sigma=2.50 stack projection=[Average Intensity] title=[] text1=[]');
assert.equal(O.build({ sigma: 2, method: 'avg', title: 'a' }, Object.assign({ smart: true }, de), spec), '', 'smart recording skips the defaults');

console.log('ok (' + dialogs + ' captured dialogs)');
