// IJMacroCmds.headlessAnswer (ij-macro-cmds.js): a Studio dialog answered from a macro's options string the way GenericDialog's macro
// mode answers an ImageJ dialog (INTEGRATION.md §5.3). Vectors: duplicate keys, absent checkbox, &var and bare variables, brackets,
// hex, the choice and numeric error texts, doc / channel / all → stack, titles choices, visibleIf, onChange (explicit keys win),
// validate, refused dialog variants, the per-field ijKey fallback.
import assert from 'node:assert/strict';
import { loadCmds, IJViewPure, tr, hasKey } from './ij_macro_cmds_support.mjs';

const L = loadCmds();
if (!L) { console.log('SKIP ij-macro-cmds.js absent'); process.exit(0); }
const { IJMacroOptions: O, IJMacroCmds: C } = L;
const J = (x) => JSON.parse(JSON.stringify(x));
const run = (spec, opts, entry, extra) => C.headlessAnswer(spec, O.normalize(opts), Object.assign({ commandId: 'x', entry, dialogIndex: 0, vars: {}, pure: IJViewPure, tr }, extra || {}));
const E = (keys, more, title) => ({ name: 'Test...', cls: 'A', dialogs: [Object.assign({ ij: null, title: title || 'Test', keys }, more || {})] });
const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r.error)); return J(r.values); };

for (const k of ['dlg.mac.invalidValue', 'err.macRefused', 'err.macReasonLibrary', 'view.invalid.range', 'view.invalid.integer', 'view.invalid.nan', 'view.invalid.choice']) {
  if (!hasKey(k)) console.log('NOTE lang key ' + k + ' is not in lang/en.json yet: the texts below print the key');
}

// ── numbers
const num = { title: 'Gaussian Blur…', fields: [{ type: 'number', id: 'sigma', label: 'Sigma', value: 2, min: 0, max: 100 }, { type: 'check', id: 'all', label: 'All', value: true }] };
const eG = E({ sigma: 'sigma', all: 'stack' }, null, 'Gaussian Blur...');
assert.deepEqual(ok(run(num, 'sigma=3.5', eG)), { sigma: 3.5, all: false }, 'absent checkbox = false whatever its default');
assert.deepEqual(ok(run(num, 'sigma=[ 4 ] stack', eG)), { sigma: 4, all: true }, 'bracket form; stack ticks "all"');
assert.deepEqual(ok(run(num, 'title=[my stack] x=1', eG)), { sigma: 2, all: false }, 'absent number = default; a word inside brackets is no checkbox');
assert.deepEqual(ok(run(num, 'sigma=0x10', eG)), { sigma: 16, all: false }, 'hex');
assert.deepEqual(ok(run(num, 'Sigma=9', eG)), { sigma: 2, all: false }, 'keys are case-sensitive');
assert.deepEqual(ok(run(num, 'sigma=&s', eG, { vars: { s: { n: 7, s: '7' } } })), { sigma: 7, all: false }, '&var');
assert.deepEqual(ok(run(num, 'sigma=s', eG, { vars: { s: { n: 7, s: '7' } } })), { sigma: 7, all: false }, 'bare variable name (getVariable2)');
assert.deepEqual(ok(run(num, 'sigma=&t', eG, { vars: { t: { s: '2.5' } } })), { sigma: 2.5, all: false }, 'a string variable holding a number');
let r = run(num, 'sigma=abc', eG);
assert.equal(r.ok, false);
assert.equal(r.error.text, 'Numeric value expected in run() function\n \n\t Dialog box title: "Gaussian Blur..."\n\t Key: "sigma"\n\t Value or variable name: "abc"', 'GenericDialog\'s text, the DialogEntry title');
r = run(num, 'sigma=&nope', eG);
assert.equal(r.error.text.split('\n').pop(), '\t Value or variable name: "nope"', 'the & is stripped from the text');
r = run(num, 'sigma=200', eG);
assert.equal(r.ok, false, 'out of the field range');
assert.equal(r.error.text, tr('dlg.mac.invalidValue', { title: 'Gaussian Blur...', key: 'sigma', message: tr('view.invalid.range') }));
// an integer field takes ImageJ's (int) cast
const intSpec = { title: 'Bin', fields: [{ type: 'number', id: 'n', label: 'N', value: 2, integer: true, min: 1, max: 9 }] };
assert.deepEqual(ok(run(intSpec, 'x=2.9', E({ n: 'x' }))), { n: 2 });
// a null key keeps the default
assert.deepEqual(ok(run(num, 'sigma=5 stack', E({ sigma: null, all: 'stack' }))), { sigma: 2, all: true });

// ── duplicate keys (GenericDialog.saveLabel): the table names radius / radius_0
const dup = { title: 'D', fields: [{ type: 'number', id: 'a', label: 'Radius', value: 1 }, { type: 'number', id: 'b', label: 'Radius', value: 1 }] };
assert.deepEqual(ok(run(dup, 'radius=3 radius_0=4', E({ a: 'radius', b: 'radius_0' }))), { a: 3, b: 4 });
assert.deepEqual(ok(run(dup, 'radius_0=4 radius=3', E({ a: 'radius', b: 'radius_0' }))), { a: 3, b: 4 }, 'radius= is not found inside radius_0=');

// ── choices
const ch = { title: 'Bin…', fields: [{ type: 'choice', id: 'method', label: 'Bin method', value: 'average', options: [{ value: 'average', label: 'Average' }, { value: 'sum', label: 'Sum' }] }] };
const eB = E({ method: 'bin' }, { items: { method: { Average: 'average', Sum: 'sum' } } }, 'Image Shrink');
assert.deepEqual(ok(run(ch, 'bin=Sum', eB)), { method: 'sum' });
assert.deepEqual(ok(run(ch, 'bin=&m', eB, { vars: { m: { s: 'Sum' } } })), { method: 'sum' }, '&var (getChoiceVariable)');
assert.deepEqual(ok(run(ch, 'bin=m', eB, { vars: { m: { s: 'Sum' } } })), { method: 'sum' }, 'a bare string variable (getNextChoiceIndex)');
r = run(ch, 'bin=sum', eB);
assert.equal(r.error.text, '"sum" is not a valid choice for "bin"', 'ImageJ\'s text: items are case-sensitive, the label is the key');
r = run(ch, 'bin=[Average Intensity]', eB);
assert.equal(r.error.text, '"Average Intensity" is not a valid choice for "bin"');
// no items: the option value itself
assert.deepEqual(ok(run(ch, 'bin=sum', E({ method: 'bin' }))), { method: 'sum' });
// a numeric variable for a choice: an integral value prints without ".0"
const nch = { title: 'F', fields: [{ type: 'choice', id: 'f', label: 'Font', value: '12', options: ['12', '14'].map((x) => ({ value: x, label: x })) }] };
assert.deepEqual(ok(run(nch, 'font=&k', E({ f: 'font' }), { vars: { k: { n: 14, s: '14' } } })), { f: '14' });
// radio
const rad = { title: 'R', fields: [{ type: 'radio', id: 'w', label: 'Which', value: 'b', options: [{ value: 'b', label: 'Bright' }, { value: 'd', label: 'Dark' }] }] };
assert.deepEqual(ok(run(rad, 'which=Dark', E({ w: 'which' }, { items: { w: { Bright: 'b', Dark: 'd' } } }))), { w: 'd' });

// ── images and channels
const docs = [{ value: 'd1', label: 'blobs.gif' }, { value: 'd2', label: 'my image' }];
const calc = { title: 'Image Calculator', fields: [
  { type: 'doc', id: 'image1', label: 'Image1:', value: 'd1', options: docs },
  { type: 'channel', id: 'channel1', label: 'Channel', docField: 'image1', value: 0, optionsByDoc: { d1: [{ value: 0, label: '1: C1' }], d2: [{ value: 0, label: '1: C1' }, { value: 1, label: '2: C2' }] }, options: [{ value: 0, label: '1: C1' }] },
  { type: 'check', id: 'all', label: 'All channels', value: true }
] };
// no `all` key in the table: the "all channels" check still counts as covered and reads ImageJ's `stack`
const eC2 = E({ image1: 'image1', channel1: 'channel' });
assert.ok(C.pickDialog(eC2, 0, calc.fields), 'the all check needs no table key');
assert.equal(C.pickDialog(E({ image1: 'image1' }), 0, calc.fields), null, 'any other uncovered field: no DialogEntry');
assert.deepEqual(ok(run(calc, 'image1=[my image] channel=2 stack', eC2)), { image1: 'd2', channel1: 1, all: true }, 'image title, 1-based channel of THAT image, all → stack');
r = run(calc, 'image1=[my image] channel=2', eC2);
assert.deepEqual(J(r.unknown), [], 'all → stack is not unknown');
r = run(calc, 'image1=nope', eC2);
assert.equal(r.error.text, '"nope" is not a valid choice for "image1"');
r = run(calc, 'image1=[blobs.gif] channel=2', eC2);
assert.equal(r.error.text, '"2" is not a valid choice for "channel"', 'blobs.gif has one channel');
assert.deepEqual(ok(run(calc, 'image1=&t', eC2, { vars: { t: { s: 'my image' } } })), { image1: 'd2', channel1: 0, all: false });
// titles mode: image choices listed with fixed items
const merge = { title: 'Merge Channels', fields: [{ type: 'choice', id: 'c1', label: 'C1', value: 'none', options: [{ value: 'none', label: '*None*' }, { value: 'd1', label: 'blobs.gif' }] }] };
const eM = E({ c1: 'c1' }, { titles: ['c1'], items: { c1: { '*None*': 'none' } } });
assert.deepEqual(ok(run(merge, 'c1=blobs.gif', eM)), { c1: 'd1' });
assert.deepEqual(ok(run(merge, 'c1=*None*', eM)), { c1: 'none' });
assert.equal(run(merge, 'c1=d1', eM).ok, false, 'a docId is no title');

// ── strings and text areas
const str = { title: 'Rename', fields: [{ type: 'string', id: 'name', label: 'Title', value: 'blobs' }, { type: 'string', id: 'range', label: 'Range', value: '1-10' },
  { type: 'textarea', id: 'k', label: 'Kernel', value: '0' }] };
const eS = E({ name: 'title', range: 'range', k: 'text1' });
assert.deepEqual(ok(run(str, 'title=[new name] range=2-5 text1=[1 2\n3 4]', eS)), { name: 'new name', range: '2-5', k: '1 2\n3 4' });
assert.deepEqual(ok(run(str, 'title=&v', eS, { vars: { v: { s: 'from var' } } })), { name: 'from var', range: '1-10', k: '0' });
assert.deepEqual(ok(run(str, 'title=&n', eS, { vars: { n: { n: 5, s: '5' } } })), { name: '5.0', range: '1-10', k: '0' }, 'a numeric variable: Java\'s Double.toString');
assert.deepEqual(ok(run(str, 'range=r', eS, { vars: { r: { s: '3-4' } } })), { name: 'blobs', range: '3-4', k: '0' }, 'a default that starts with a digit expects a number: a bare name is a variable');
assert.deepEqual(ok(run(str, 'title=t', eS, { vars: { t: { s: 'T' } } })), { name: 'T', range: '1-10', k: '0' }, 'a value the key starts with is a variable (GenericDialog quirk)');
assert.deepEqual(ok(run(str, 'title=x', eS, { vars: { x: { s: 'X' } } })), { name: 'x', range: '1-10', k: '0' }, 'otherwise the text itself');
assert.deepEqual(ok(run(str, 'title=&gone', eS)), { name: 'gone', range: '1-10', k: '0' }, 'an unknown &var leaves the name');
assert.deepEqual(ok(run(str, 'title=', eS)), { name: '', range: '1-10', k: '0' });

// ── visibleIf: a hidden field keeps its initial value, an invalid hidden value is not checked
const vis = { title: 'V', fields: [{ type: 'check', id: 'manual', label: 'Manual', value: false }, { type: 'number', id: 't', label: 'T', value: 5, min: 0, max: 10, visibleIf: (v) => !!v.manual }] };
const eV = E({ manual: 'manual', t: 't' });
assert.deepEqual(ok(run(vis, 't=99', eV)), { manual: false, t: 5 });
assert.equal(run(vis, 'manual t=99', eV).ok, false, 'shown: its range is checked');
assert.deepEqual(ok(run(vis, 'manual t=7', eV)), { manual: true, t: 7 });

// ── onChange once, explicit keys win
const sc = { title: 'Scale', fields: [{ type: 'number', id: 'xs', label: 'X', value: 1 }, { type: 'number', id: 'w', label: 'W', value: 100 }],
  onChange(v, set, changed) { assert.equal(changed, null); set({ w: Math.round(100 * v.xs) }); } };
const eSc = E({ xs: 'x', w: 'width' });
assert.deepEqual(ok(run(sc, 'x=0.5', eSc)), { xs: 0.5, w: 50 }, 'the derived width follows');
assert.deepEqual(ok(run(sc, 'x=0.5 width=80', eSc)), { xs: 0.5, w: 80 }, 'an explicit width wins');

// ── validate
const val = { title: 'Merge', fields: [{ type: 'number', id: 'a', label: 'A', value: 1 }], validate: (v) => (v.a > 3 ? { a: 'view.invalid.range' } : null) };
r = run(val, 'a=5', E({ a: 'a' }, null, 'Merge Channels'));
assert.equal(r.error.text, tr('dlg.mac.invalidValue', { title: 'Merge Channels', key: 'a', message: tr('view.invalid.range') }));

// ── table selection, ijKey fallback, unknown fields, refused variants
const twoD = { name: 'Z Project...', cls: 'A', dialogs: [
  { ij: null, title: 'ZProjection', keys: { start: 'start', projection: 'projection' } },
  { ij: null, title: 'ZProjection', keys: { start: 'start', method: 'projection' }, refuse: 'err.macReasonLibrary' }] };
const zStack = { title: 'Z', fields: [{ type: 'number', id: 'start', label: 'S', value: 1 }, { type: 'choice', id: 'projection', label: 'P', value: 'avg', options: [{ value: 'avg', label: 'Average' }, { value: 'max', label: 'Max' }] }] };
const zFig = { title: 'Z', fields: [{ type: 'number', id: 'start', label: 'S', value: 1 }, { type: 'choice', id: 'method', label: 'P', value: 'avg', options: [{ value: 'avg', label: 'Average' }] }] };
assert.deepEqual(ok(run(zStack, 'start=2 projection=max', twoD)), { start: 2, projection: 'max' });
r = run(zFig, 'start=2', twoD);
assert.equal(r.ok, false);
assert.equal(r.error.text, tr('err.macRefused', { command: 'Z Project...', reason: tr('err.macReasonLibrary') }), 'the dialog that reads the site\'s dataset is refused');
const fb = { title: 'F', fields: [{ type: 'number', id: 'a', label: 'A', value: 1, ijKey: 'alpha' }, { type: 'number', id: 'b', label: 'B', value: 1 }] };
r = run(fb, 'alpha=3 b=4', { name: 'X', cls: 'A', dialogs: [] });
assert.deepEqual(J(r.values), { a: 3, b: 1 }, 'no DialogEntry: the field ijKey, else the default');
assert.deepEqual(J(r.unknown), ['b']);
// derive: Set Measurements' redirect
const sm = C.MACRO_COMMANDS.analyzeSetMeasurements;
const red = { title: 'Set Measurements', fields: [{ type: 'check', id: 'redirectOn', label: 'Redirect', value: true }, { type: 'doc', id: 'redirectDoc', label: 'Image', value: 'd1', options: docs }] };
const subset = { name: sm.name, cls: 'A', dialogs: [Object.assign({}, sm.dialogs[0], { keys: { redirectOn: null, redirectDoc: 'redirect' } })] };
assert.deepEqual(ok(run(red, 'redirect=None', subset)), { redirectOn: false, redirectDoc: 'd1' });
assert.deepEqual(ok(run(red, 'redirect=[my image]', subset)), { redirectOn: true, redirectDoc: 'd2' });
assert.deepEqual(ok(run(red, 'area', subset)), { redirectOn: true, redirectDoc: 'd1' }, 'absent: the current setting');

// ── never throws: a broken spec is a failed answer
r = C.headlessAnswer({ fields: [{ type: 'number', id: 'a', label: 'A', value: 1 }] }, 'a=1 ', { entry: E({ a: 'a' }), dialogIndex: 0, vars: {}, pure: null, tr });
assert.equal(r.ok, false);
assert.equal(typeof r.error.text, 'string');

// ── the real table: a few commands end to end
const G = C.MACRO_COMMANDS.filterGaussian;
const gSpec = { title: 'Gaussian Blur…', fields: [{ type: 'number', id: 'sigma', label: 'Sigma', value: 2, min: 0.01 }, { type: 'check', id: 'scaled', label: 'Scaled', value: false }, { type: 'check', id: 'all', label: 'All', value: false }] };
assert.deepEqual(ok(run(gSpec, 'sigma=2 scaled stack', G)), { sigma: 2, scaled: true, all: true });
const N = C.MACRO_COMMANDS.fileNewImage;
const nSpec = { title: 'New Image…', fields: [{ type: 'string', id: 'name', label: 'Name', value: 'Untitled' },
  { type: 'choice', id: 'type', label: 'Type', value: 8, options: [{ value: 8, label: '8-bit' }, { value: 16, label: '16-bit' }, { value: 32, label: '32-bit' }] },
  { type: 'choice', id: 'fill', label: 'Fill', value: 'black', options: ['white', 'black', 'ramp', 'noise'].map((x) => ({ value: x, label: x })) },
  { type: 'number', id: 'width', label: 'W', value: 512, integer: true, min: 1 }, { type: 'number', id: 'height', label: 'H', value: 512, integer: true, min: 1 }] };
assert.deepEqual(ok(run(nSpec, 'name=a type=16-bit fill=Ramp width=64 height=32 slices=1', N)), { name: 'a', type: 16, fill: 'ramp', width: 64, height: 32 });
assert.equal(run(nSpec, 'name=a type=RGB', N).error.text, '"RGB" is not a valid choice for "type"');

// IJ.setupDialog for a PlugInFilter (DialogEntry setup): a composite shown as composite does every channel unless "slice"; RGB is whole
assert.deepEqual(ok(run(gSpec, 'sigma=2', G, { composite: true })), { sigma: 2, scaled: false, all: true }, 'composite: all channels');
assert.deepEqual(ok(run(gSpec, 'sigma=2 slice', G, { composite: true })), { sigma: 2, scaled: false, all: false }, 'composite + slice: the current channel');
assert.deepEqual(ok(run(gSpec, 'sigma=2', G, { rgb: true })), { sigma: 2, scaled: false, all: true }, 'RGB: processed whole');
assert.deepEqual(ok(run(gSpec, 'sigma=2 title=xstack', G)), { sigma: 2, scaled: false, all: true }, 'setupDialog reads "stack " anywhere');
assert.deepEqual(ok(run(gSpec, 'sigma=2', G, { composite: false })), { sigma: 2, scaled: false, all: false });
const IC = C.MACRO_COMMANDS.procImageCalculator;
assert.ok(!IC.dialogs[0].setup, 'Image Calculator asks its own question: no setupDialog rule');

console.log('ok');
