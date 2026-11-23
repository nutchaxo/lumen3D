// IJMacroParams (js/modules/studio/advanced-studio/ij-macro-params.js): SciJava `#@` script parameters as Fiji handles them
// (DOCS/studio-advanced/macros/EXTRAS.md §6). Two sources of truth:
//   * vectors marked (Fiji) below were observed by running Fiji (ImageJ 2.18.0, imagej-legacy 3.0.0, scijava-common 2.101.0,
//     ij 1.54p) through its public API: ScriptInfo(context, "x.ijm", reader).inputs()/outputs() for the parsing, and
//     ScriptService.run(file, true, inputs) with the IJ1 macro engine for the injected text (its error excerpts and line
//     numbers; the Studio's interpreter prints excerpts in ImageJ's exact format, so they are compared verbatim);
//   * tests/fixtures/ij-macro/params-golden.json (tools/ij_fixtures/macro/ParamGolden.java) when it exists.
//
// Run: node tests/js/test_ij_macro_params.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadModule } from './harness.mjs';
import { loadViewModules } from './ij_harness.mjs';

const FILE = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio', 'ij-macro-params.js');
if (!fs.existsSync(FILE)) { console.log('SKIP ij-macro-params.js absent'); process.exit(0); }
const P = loadModule('js/modules/studio/advanced-studio/ij-macro-params.js', 'IJMacroParams');
const IJMacro = loadModule('js/modules/studio/advanced-studio/ij-macro-lang.js', 'IJMacro');
const { IJViewPure } = loadViewModules();
const J = (x) => JSON.parse(JSON.stringify(x));
const deq = (a, b, m) => assert.deepEqual(J(a), J(b), m || 'deepEqual');
let n = 0;
const ok = () => { n++; };
const run = async (src) => {
  const log = [];
  const r = await IJMacro.run(src, { onLog: (s) => log.push(s) });
  return { log, error: r.error ? J(r.error) : null };
};
const only = (src) => { const p = P.parse(src); assert.equal(p.items.length, 1, src); return p.items[0]; };
const pick = (it, keys) => Object.fromEntries(keys.map((k) => [k, it[k]]));

// ═══ recognition and stripping ═══
{
  const src = 'a = 1;\n#@ Integer n\n// @String legacy\n  #@ Integer indented\nx = 1; #@ Integer mid\n#@\nprint(n);';
  const p = P.parse(src);
  assert.equal(p.hasParams, true);
  deq(p.items.map((i) => i.name), ['n', 'legacy'], '(Fiji) column-0 #@ and the legacy comment form; an indented or mid-line #@ is code');
  deq(p.stripped.split('\n'), ['a = 1;', '', '', '  #@ Integer indented', 'x = 1; #@ Integer mid', '#@', 'print(n);'],
    '(Fiji) line numbers kept; only the lines read as parameters are blanked');
  deq(p.ignored.map((x) => x.line), [6], 'a bare #@ is an ignored parameter line, left in the text');
  assert.equal(P.parse('print(1);').hasParams, false);
  assert.equal(P.parse('print(1);').stripped, 'print(1);');
  assert.equal(P.parse('"@x";\n').hasParams, true, 'the legacy pattern ^[^\\w]*[^\\w#]@ also takes a line starting "@');
  ok();
}

// ═══ line grammar (Fiji) ═══
{
  const cases = [
    ['#@ Integer n', ['n', 'java.lang.Integer', 'INPUT']],
    ['#@Integer n', ['n', 'java.lang.Integer', 'INPUT']],
    ['#@ Integer (min=1, max=10, value=3) n', ['n', 'java.lang.Integer', 'INPUT']],
    ['#@ Integer n (min=1, max=10, value=3)', ['n', 'java.lang.Integer', 'INPUT']],
    ['#@ Integer (min=1)n', ['n', 'java.lang.Integer', 'INPUT']],
    ['#@ Integer(min=1) n', ['n', 'java.lang.Integer', 'INPUT']],
    ['#@  Integer   n', ['n', 'java.lang.Integer', 'INPUT']],
    ['#@ Integer\tn', ['n', 'java.lang.Integer', 'INPUT']],
    ['#@ Integer n extra', ['n', 'java.lang.Integer', 'INPUT']],
    ['#@ Integer n // trailing (min=1)', ['n', 'java.lang.Integer', 'INPUT']],
    ['#@ Integer n;', ['n;', 'java.lang.Integer', 'INPUT']],
    ['#@output String greeting', ['greeting', 'java.lang.String', 'OUTPUT']],
    ['#@ output String greeting', ['greeting', 'java.lang.String', 'OUTPUT']],
    ['#@output greeting', ['greeting', 'java.lang.Object', 'OUTPUT']],
    ['#@output String', ['String', 'java.lang.Object', 'OUTPUT']],
    ['#@both Integer b', ['b', 'java.lang.Integer', 'BOTH']],
    ['#@ both Integer b', ['b', 'java.lang.Integer', 'BOTH']],
    ['#@input Integer i', ['i', 'java.lang.Integer', 'INPUT']],
    ['// @String legacy', ['legacy', 'java.lang.String', 'INPUT']],
    ['// @Integer(min=1) n', ['n', 'java.lang.Integer', 'INPUT']],
    ['//@String s', ['s', 'java.lang.String', 'INPUT']],
    ['#@ String name-with-dash', ['name-with-dash', 'java.lang.String', 'INPUT']]
  ];
  for (const [src, [name, type, io]] of cases) {
    const it = only(src);
    deq([it.name, it.javaType, it.io], [name, type, io], src);
  }
  for (const src of ['#@ Integer(value=3)n', '#@ script(name="foo")', '#@ Integer', '#@ Foo bar', '#@ Integer (min=1 n', '#@ integer n', '#@outputs String g']) {
    const p = P.parse(src);
    assert.equal(p.items.length, 0, '(Fiji) "Ignoring invalid parameter": ' + src);
    assert.equal(p.ignored.length, 1, src);
    assert.equal(p.errors.length, 0, src);
  }
  for (const src of ['#@ Integer (min=1 max=2) n', '#@ String (label=a b) s', '#@ String (label=x-y) s', '#@ Integer (min=1) n (max=5)', '#@ String (label="a\\qb") s']) {
    const p = P.parse(src);
    assert.equal(p.errors.length, 1, '(Fiji) ScriptInfo throws, the script cannot run: ' + src);
    deq(J(P.check(p)), [{ key: 'err.macParamSyntax', params: { line: 1, text: src } }]);
  }
  const h = P.parse('#@script(name="foo", label="bar")\n#@ Integer n');
  deq(h.script, { name: 'foo', label: 'bar' });
  assert.equal(h.items.length, 1);
  ok();
}

// ═══ types (Fiji resolution) ═══
{
  const t = (decl) => { const r = P.resolveType(decl); return r ? [r.java, r.kind] : null; };
  deq(t('string'), ['java.lang.String', 'string'], '(Fiji) "string" is an alias');
  for (const d of ['integer', 'bool', 'str', 'number', 'file', 'color', 'Display', 'Roi', 'Window', 'List', 'Map', 'ImageProcessor']) assert.equal(t(d), null, d);
  deq(t('int'), ['int', 'number']);
  deq(t('boolean'), ['boolean', 'boolean']);
  deq(t('java.lang.Integer'), ['java.lang.Integer', 'number']);
  deq(t('java.io.File'), ['java.io.File', 'file']);
  deq(t('ColorRGB'), ['org.scijava.util.ColorRGB', 'color']);
  deq(t('ImagePlus'), ['ij.ImagePlus', 'image']);
  deq(t('Dataset'), ['net.imagej.Dataset', 'image']);
  deq(t('ImgPlus'), ['net.imagej.ImgPlus', 'unknown'], 'an ImgPlus reaches a macro as an object identity: no browser meaning');
  deq(t('UIService'), ['org.scijava.ui.UIService', 'service']);
  deq(t('LogService'), ['org.scijava.log.LogService', 'service']);
  deq(t('Context'), ['org.scijava.Context', 'service']);
  deq(t('CommandService'), ['org.scijava.command.CommandService', 'service']);
  deq(t('OpService'), ['net.imagej.ops.OpService', 'service']);
  deq(t('File[]'), ['[Ljava.io.File;', 'unknown']);
  deq(t('Character'), ['java.lang.Character', 'char'], '(Fiji) a Character is injected as a one-letter string');
  deq(t('char'), ['char', 'char']);
  deq(t('Date'), ['java.util.Date', 'unknown']);
  ok();
}

// ═══ attributes, defaults and conversions (Fiji) ═══
{
  const it = only('#@ Integer (min=1, max=10, value=3) n');
  deq(pick(it, ['min', 'max', 'stepSize', 'value', 'persist', 'required', 'visibility', 'autoFill', 'columns']), { min: 1, max: 10, stepSize: 1, value: 3, persist: true, required: true, visibility: 'NORMAL', autoFill: true, columns: 6 });
  deq(only('#@ Integer ( min = 1 , max = 2 ) n').max, 2);
  deq(only('#@ String (choices={"a","b"}) s').choices, ['a', 'b']);
  deq(only('#@ String (choices={a,b}) s').choices, ['a', 'b']);
  deq(only('#@ String (choices={"a b", "c,d"}, style="radioButtonHorizontal") s').choices, ['a b', 'c,d']);
  deq(only('#@ String (choices={"a",b, 3}) s').choices, ['a', 'b', '3']);
  deq(only('#@ String (choices="abc") s').choices, ['abc']);
  deq(only('#@ String (choices={"a"+"b", 1+1}) s').choices, ['ab', '2']);
  assert.equal(only('#@ String (value=\'single q\') s').value, 'single q');
  assert.equal(only('#@ String (value="a\\nb\\tc") s').value, 'a\nb\tc');
  assert.equal(only('#@ String (label=\'He said "hi"\') s').label, 'He said "hi"');
  assert.equal(only('#@ String (value=a=b) s').value, 'b');
  assert.equal(only('#@ String (value=null) s').value, 'null', 'a bare identifier is its own name');
  assert.equal(only('#@ String (value=3) s').value, '3');
  assert.equal(only('#@ String (value=3.0) t').value, '3.0');
  assert.equal(only('#@ String (label=5) s').label, '5');
  assert.equal(only('#@ String (label="a"+"b", value=1+2) s').label, 'ab');
  assert.equal(only('#@ String (label="a"+"b", value=1+2) s').value, '3');
  assert.equal(only('#@ String (value="") s').value, '');
  deq(pick(only('#@ Integer (max=2*5, min=-3, value=+4) n'), ['min', 'max', 'value']), { min: -3, max: 10, value: 4 });
  deq(pick(only('#@ Double (min=1e3, value=0x10) d'), ['min', 'value']), { min: 1000, value: 16 });
  assert.equal(only('#@ Integer (value=-(3)) n').value, -3);
  deq([3.5, -3.7, 2.5].map((v) => only('#@ Integer (value=' + v + ') a').value), [3, -3, 2], 'Integer from a double truncates');
  assert.equal(only('#@ Byte (value=300) d').value, 44, 'Byte narrowing');
  assert.equal(only('#@ Integer (value=abc) n').value, null, 'not convertible');
  deq(pick(only('#@ Integer (min=10, max=1, value=5) n'), ['min', 'max', 'value']), { min: 10, max: 1, value: 5 });
  assert.equal(only('#@ Integer (min=1, max=10, value=50) n').value, 50, 'a default out of range is kept');
  deq(['TRUE', 'yes', '"true"'].map((v) => only('#@ Boolean (value=' + v + ') b').value), [true, false, true]);
  assert.equal(only('#@ Boolean b').value, null);
  assert.equal(only('#@ Integer (persist="false") n').persist, false);
  assert.equal(only('#@ String (required=FALSE) s').required, false);
  assert.equal(only('#@ String (visibility=message) m').visibility, 'NORMAL', 'the enum name is case-sensitive');
  assert.equal(only('#@ String (visibility="MESSAGE") m').visibility, 'MESSAGE');
  deq(pick(only('#@ Integer (persist=false, required=false, autoFill=false, callback="cb", initializer="ini") n'), ['persist', 'required', 'autoFill', 'callback', 'initializer']),
    { persist: false, required: false, autoFill: false, callback: 'cb', initializer: 'ini' });
  deq(pick(only('#@ Integer (MIN=1, Label="x", STYLE="slider", Min=2) n'), ['min', 'label', 'style']), { min: 2, label: 'x', style: 'slider' }, 'keys are case-insensitive, the later one wins');
  assert.equal(only('#@ String (style="text area", rows=5, columns=20) t').columns, 20);
  assert.equal(only('#@ String (description="a: b", label="x,y") s').description, 'a: b');
  assert.equal(only('#@ String (min=1) s').min, '1');
  assert.equal(only('#@ Double d').stepSize, 1);
  assert.equal(only('#@ File (value="C:/x/y.txt") f').value, 'C:/x/y.txt');
  const colors = { rebeccapurple: '0,0,0', Red: '0,0,0', '#ff0000': '255,0,0', '#f00': '255,0,0', darkgrey: '169,169,169', transparent: '0,0,0',
    '1, 2, 3': '1,0,0', '300,0,0': '300,0,0', '1,2': '1,2,0', '1,2,3,4': '1,2,3', abc: '0,0,0', lightgoldenrodyellow: '250,250,210', red: '255,0,0' };
  for (const [v, c] of Object.entries(colors)) assert.equal(only('#@ ColorRGB (value="' + v + '") c').value, c, '(Fiji) ColorRGB ' + v);
  assert.equal(only('#@ ColorRGB (value="") c').value, null);
  const dup = P.parse('#@ Integer x\n#@ String x');
  assert.equal(dup.items.length, 2, '(Fiji) both declarations are items');
  deq(dup.inputs.map((i) => i.javaType), ['java.lang.String'], 'one input per name: the later declaration');
  ok();
}

// ═══ outputs (Fiji: the implicit `result` exists only without a declared output) ═══
{
  assert.equal(P.parse('#@ Integer n').implicitResult, true);
  assert.equal(P.parse('#@output String g').implicitResult, false);
  deq(P.outputs(P.parse('#@output String greeting\n#@output Integer k\n#@both Integer b\n#@output String bad-name\n#@ Integer in')), ['greeting', 'k', 'b']);
  const p = P.parse('#@output String g\n#@output Integer k\n#@output Double d\n#@output Float f\n#@output greeting\n#@output Boolean b');
  deq(['g', 'k', 'd', 'f', 'greeting', 'b'].map((nm, i) => P.formatOutput(p, nm, [{ s: 'hi' }, { n: 3 }, { n: 2.5 }, { n: 0.1 }, { n: 3 }, { n: 1 }][i])),
    ['hi', '3', '2.5', '0.1', '3.0', 'true'], '(Fiji) outputs = the declared type\'s toString');
  assert.equal(P.formatOutput(p, 'd', { n: 3 }), '3.0');
  assert.equal(P.formatOutput(p, 'g', null), '');
  assert.equal(P.formatOutput(p, 'g', { a: [1, 'x'] }), '0.0', '(Fiji) an array variable reads as 0: a String output of newArray() shows 0.0');
  ok();
}

// ═══ check ═══
{
  const p = P.parse('#@ UIService ui\n#@ LogService log\n#@ Context ctx\n#@ CommandService cs\n#@ ImgPlus c\n#@ File[] fs\n#@ String (style="password") pw\n#@ ImagePlus imp\n#@output Object out');
  deq(P.check(p), [
    { key: 'err.macParamService', params: { type: 'UIService', name: 'ui' } },
    { key: 'err.macParamService', params: { type: 'LogService', name: 'log' } },
    { key: 'err.macParamService', params: { type: 'Context', name: 'ctx' } },
    { key: 'err.macParamService', params: { type: 'CommandService', name: 'cs' } },
    { key: 'err.macParamType', params: { type: 'ImgPlus', name: 'c' } },
    { key: 'err.macParamType', params: { type: 'File[]', name: 'fs' } },
    { key: 'err.macParamPassword', params: { name: 'pw' } }]);
  deq(P.check(p, { images: [] }).slice(-1), [{ key: 'err.macParamNoImage', params: { type: 'ImagePlus', name: 'imp' } }]);
  deq(P.check(P.parse('#@ Integer n\n#@ String s\n#@ Foo bar')), [], 'an unknown type is ignored as Fiji does, not refused');
  ok();
}

// ═══ dialog ═══
{
  const src = ['#@ Integer (min=1, max=10, value=3) n', '#@ String (choices={"a","b"}) s', '#@ Boolean (value=true) flag',
    '#@ Double (style="format:0.000") d', '#@ Double (style="slider,format:#.00", min=0, max=1, stepSize=0.1) d2',
    '#@ Integer (style="scroll bar", min=0, max=9) sb', '#@ String (style="text area", rows=4) txt',
    '#@ String (choices={"x","y","z"}, style="radioButtonHorizontal") rh', '#@ String (style="radioButtonVertical", choices={"a","b"}) rv',
    '#@ File (style="directory") dir', '#@ File (style="save, extensions:png/tif") out', '#@ ColorRGB (value="red") col',
    '#@ ImagePlus imp', '#@ String (visibility=MESSAGE, value="Read me") msg', '#@ String (visibility=INVISIBLE, value="hid") inv',
    '#@ String (visibility=TRANSIENT, value="t0") tr', '#@ String (label="") emptyLab', '#@ Byte b', '#@ UIService ui', 'print(n);'].join('\n');
  const p = P.parse(src);
  const paths = [];
  const spec = P.dialogSpec(p, {
    title: 'My.ijm', persisted: { n: 7, s: 'zzz', flag: false, tr: 'persisted', b: 1.5, d: 'not a number' },
    images: [{ docId: 'd1', title: 'one.tif' }, { docId: 'd2', title: 'two.tif' }], current: 'd2',
    pathField: (f, label) => { paths.push([f.id, label, f.pathKind, f.mode, J(f.extensions)]); return Object.assign({}, f, { browse: () => Promise.resolve(null) }); }
  });
  assert.equal(spec.title, 'My.ijm');
  assert.equal(spec.needsDialog, true);
  const byName = Object.fromEntries(spec.fields.map((f) => [spec.names[f.id], f]));
  deq(pick(byName.n, ['type', 'label', 'value', 'integer', 'min', 'max', 'step', 'decimals']), { type: 'number', label: 'N', value: 7, integer: true, min: 1, max: 10, step: 1, decimals: 0 }, 'persisted value; widget label = Name');
  deq(pick(byName.s, ['type', 'value', 'options']), { type: 'choice', value: 'a', options: ['a', 'b'] }, 'a persisted value outside the choices is not used');
  deq(pick(byName.flag, ['type', 'value']), { type: 'check', value: false });
  deq(pick(byName.d, ['type', 'value', 'decimals']), { type: 'number', value: 0, decimals: 3 }, 'a stored value of another type is not used');
  deq(pick(byName.d2, ['type', 'min', 'max', 'step', 'value']), { type: 'slider', min: 0, max: 1, step: 0.1, value: 0 });
  deq(pick(byName.sb, ['type', 'min', 'max']), { type: 'slider', min: 0, max: 9 });
  deq(pick(byName.txt, ['type', 'rows', 'value']), { type: 'textarea', rows: 4, value: '' });
  deq(pick(byName.rh, ['type', 'columns', 'value']), { type: 'radio', columns: 3, value: 'x' });
  deq(pick(byName.rv, ['type', 'columns']), { type: 'radio', columns: 1 });
  deq(paths, [['p9', 'Dir', 'directory', 'directory', []], ['p10', 'Out', 'file', 'save', ['png', 'tif']]]);
  deq(pick(byName.col, ['type', 'value']), { type: 'string', value: '255,0,0' });
  deq(pick(byName.imp, ['type', 'value', 'options']), { type: 'doc', value: 'd2', options: [{ value: 'd1', label: 'one.tif' }, { value: 'd2', label: 'two.tif' }] }, 'autoFill = the current image');
  deq(pick(byName.msg, ['type', 'label']), { type: 'message', label: 'Read me' });
  assert.equal(byName.inv, undefined, 'INVISIBLE: no field');
  assert.equal(byName.ui, undefined);
  assert.equal(byName.tr.value, 'persisted', '(Fiji) a TRANSIENT input is kept like a NORMAL one');
  assert.equal(byName.emptyLab.label, 'EmptyLab', '(Fiji) an empty label = the capitalised name');
  deq(pick(byName.b, ['min', 'max', 'value']), { min: -128, max: 127, value: 0 }, 'Byte bounds; 1.5 is no Byte');
  deq(J(IJViewPure.fieldProblems(spec.fields)), [], 'a sound dialog spec');
  deq(P.persistable(p), ['n', 's', 'flag', 'd', 'd2', 'sb', 'txt', 'rh', 'rv', 'dir', 'out', 'col', 'tr', 'emptyLab', 'b']);
  const hdr = P.dialogSpec(P.parse('#@script(label="Nice title")\n#@ Integer n'), { title: 'f.ijm' });
  assert.equal(hdr.title, 'Nice title');
  assert.equal(P.dialogSpec(P.parse('#@ Integer n'), {}).title, 'Macro');
  assert.equal(P.dialogSpec(P.parse('#@ String (visibility=MESSAGE) m'), {}).needsDialog, false);
  assert.equal(P.dialogSpec(P.parse('#@ Integer (min=5) n'), {}).fields[0].value, 5, '(Fiji) Integer(min=5) starts at 5');

  // values back
  const vals = { p0: 4, p1: 'b', p2: true, p3: 1.25, p4: 0.5, p5: 3, p6: 'line1\nline2', p7: 'y', p8: 'b', p9: '/Data/in', p10: '/tmp/out.png',
    p11: '10, 20, 30', p12: 'd1', p15: 'typed', p16: 'e', p17: -5 };
  const r = P.valuesOf(p, vals);
  deq(r.problems, []);
  deq(r.values, { n: 4, s: 'b', flag: true, d: 1.25, d2: 0.5, sb: 3, txt: 'line1\nline2', rh: 'y', rv: 'b', dir: '/Data/in', out: '/tmp/out.png',
    col: '10,20,30', imp: 'd1', msg: 'Read me', inv: 'hid', tr: 'typed', emptyLab: 'e', b: -5 });
  const bad = P.valuesOf(p, Object.assign({}, vals, { p11: '300,0,0', p9: '', p16: '' }));
  deq(bad.problems, [{ name: 'dir', key: 'view.invalid.required' }, { name: 'col', key: 'view.invalid.color' }, { name: 'emptyLab', key: 'view.invalid.required' }]);
  deq(P.valuesOf(P.parse('#@ String (required=false) s'), { p0: '' }).values, { s: '' });
  deq(P.valuesOf(P.parse('#@ Float f'), { p0: 0.1 }).values, { f: Math.fround(0.1) });
  ok();
}

// ═══ persistence and headless values ═══
{
  assert.equal(P.persistId('n'), 'p:n', 'keyed by the input name alone (Fiji, golden persist-shared-name)');
  const p = P.parse('#@ Integer n\n#@ Integer (min=5) m\n#@ String s\n#@ String (value="d") sd\n#@ Boolean b\n#@ String (persist=false) np\n#@ String (visibility=TRANSIENT) tr\n#@ String (required=false) opt\n#@ File f\n#@ ColorRGB c');
  const h = P.headlessValues(p, { s: 'stored', np: 'no', tr: 'no', b: 3, c: 'blue' });
  deq(h, { n: 0, m: 5, s: 'stored', sd: 'd', tr: 'no', c: '0,0,255' }, '(Fiji) numbers start at 0 (in range), others need a stored value or a default');
  deq(P.missing(p, h), ['b', 'np', 'f'], '(Fiji) a required input without a value: the headless run does not start');
  ok();
}

// ═══ injection (Fiji's IJ1 macro engine) ═══
const inj = (src, values, ctx) => P.inject(P.parse(src), values, ctx);
{
  // exact text
  assert.equal(inj('#@ Integer (min=1, max=10, value=3) n\n#@ String (choices={"a","b"}) s\nprint(n + s);', { n: 5, s: 'b' }),
    'var s, n, ; initializeSciJavaParameters();\n\nprint(n + s);\n\nfunction initializeSciJavaParameters() {\n\n\ts = "b";\n\tn = 5;\n}\n');
  assert.equal(inj('print(1);', {}), 'print(1);', 'no parameter line: the text is untouched');
  // (Fiji) excerpts of an error on line 1: the prefix, its names in HashMap order, MESSAGE included, dashed names left out
  const line1 = async (decl, values, excerpt) => {
    const r = await run(inj('y = undefinedVar;\n' + decl, values));
    deq([r.error.message, r.error.line, r.error.excerpt], ['Undefined variable', 1, excerpt], decl);
  };
  await line1('#@ Integer a\n#@ Integer b\n', { a: 1, b: 2 }, 'var a , b , ; initializeSciJavaParameters ( ) ; y = <undefinedVar> ; ');
  await line1('#@ String name-with-dash\n#@ Integer ok\n', { ok: 5 }, 'var ok , ; initializeSciJavaParameters ( ) ; y = <undefinedVar> ; ');
  await line1('#@ Integer ok\n#@ String name-with-dash\n', { ok: 5 }, 'var ok , ; initializeSciJavaParameters ( ) ; y = <undefinedVar> ; ');
  await line1('#@ String name-with-dash\n', {}, 'var ; initializeSciJavaParameters ( ) ; y = <undefinedVar> ; ');
  await line1('#@ String (visibility=MESSAGE, value="hello") m\n#@ Integer ok\n', { ok: 5, m: 'hello' }, 'var ok , m , ; initializeSciJavaParameters ( ) ; y = <undefinedVar> ; ');
  await line1('#@output String g\n', {}, 'var ; initializeSciJavaParameters ( ) ; y = <undefinedVar> ; ');
  await line1('#@both Integer bb\n', { bb: 5 }, 'var bb , ; initializeSciJavaParameters ( ) ; y = <undefinedVar> ; ');
  // (Fiji) HashMap iteration order of the names, with a resize past 12
  deq(P.hashMapOrder('zeta alpha n sigma radius file_in threshold Aa BB ok m x1 y2 count name mode channel z w h'.split(' ')),
    'zeta sigma Aa BB file_in count channel h threshold m n mode alpha w name x1 y2 z radius ok'.split(' '));
  deq(P.hashMapOrder('inputDir outputDir suffix minSize maxSize doSave gaussSigma rollingBall useMask label q r s'.split(' ')),
    'doSave outputDir maxSize label suffix inputDir q r s useMask minSize gaussSigma rollingBall'.split(' '));
  deq(P.hashMapOrder(['Aa', 'BB', 'C#', 'f', 'fl']), ['Aa', 'BB', 'C#', 'f', 'fl']);
  // (Fiji) the appended function: the script read line by line, one more line, the header, one line, the assignments
  let r = await run(inj('#@ Double d\n#@ String s\n#@ Integer i\n#@ Boolean b\n#@ File f\n#@ Float fl\nx = (', { d: 3, s: 'q"r', i: 4, b: false, f: 'C:/a/b.tif', fl: 2.5 }));
  deq([r.error.message, r.error.line, r.error.excerpt], ['Number or numeric function expected', 9, '<function> initializeSciJavaParameters ( ) { ']);
  r = await run(inj('#@ Double d\nx = (\n', { d: 3 }));
  assert.equal(r.error.line, 4);
  r = await run(inj('#@ Integer n\r\nprint(n);\r\nx = (\r\n', { n: 2 }));
  deq([r.log, r.error.line], [['2'], 5], 'CR LF lines are read as lines');
  r = await run(inj('#@ Double a\n#@ Double d\nx = 1;\n', { a: Infinity, d: 0.5 }));
  deq([r.error.message, r.error.line, r.error.excerpt], ['Undefined variable', 7, 'a = <Infinity> ; ']);
  r = await run(inj('#@ Double a\n#@ Double d\nx = 1;\n', { d: Infinity, a: 0.5 }));
  deq([r.error.line, r.error.excerpt], [8, 'd = <Infinity> ; ']);
  r = await run(inj('#@ Double d\nprint(d);\n', { d: -Infinity }));
  deq([r.error.line, r.error.excerpt], [6, 'd = - <Infinity> ; ']);
  // (Fiji) values
  r = await run(inj('#@ String s\n#@ Integer n\n#@ Double d\n#@ Boolean b\n#@ File f\n#@ Float fl\n#@ Long lg\nprint("s=["+s+"]"); print(n); print(d); print(b); print(f); print(fl); print(lg);',
    { s: 'a"b\\c\nd\'e', n: 3, d: 3, b: true, f: 'C:\\x\\y z.txt', fl: 0.1, lg: 12345678901 }));
  deq(r.log, ['s=[a"b\\c\nd\'e]', '3', '3', '1', 'C:\\x\\y z.txt', '0.1', '1.2346E10']);
  assert.equal(r.error, null);
  r = await run(inj('#@ String s\nprint(lengthOf(s));', { s: 'a\tb' }));
  deq(r.log, ['3']);
  r = await run(inj('#@ String s\nprint(lengthOf(s));', { s: 'a\rb' }));
  deq(r.log, ['3'], '(Fiji) a CR in a value survives');
  r = await run(inj('#@ Double a\n#@ Double b\n#@ Double c\n#@ Integer i\nprint(a); print(b); print(c); print(i);', { a: 1e-10, b: 0.1, c: NaN, i: -4 }));
  deq(r.log, ['1.0000E-10', '0.1', 'NaN', '-4']);
  r = await run(inj('#@ ColorRGB c\nprint(c);', { c: '1,2,3' }));
  deq(r.log, ['1,2,3']);
  r = await run(inj('#@ String (visibility=MESSAGE, value="hello") m\nprint("m="+m);', P.valuesOf(P.parse('#@ String (visibility=MESSAGE, value="hello") m'), {}).values));
  deq(r.log, ['m=hello']);
  r = await run(inj('#@ String (visibility=INVISIBLE, value="hid") v\nprint("v="+v);', { v: 'hid' }));
  deq(r.log, ['v=hid']);
  r = await run(inj('#@ Integer n\nvar n = 5;\nprint("n="+n);\n', { n: 7 }));
  deq(r.log, ['n=5'], '(Fiji) the script\'s own var runs after the initialisation');
  r = await run(inj('#@ Double d\nprint(d);\nfunction initializeSciJavaParameters() { print("mine"); }\n', { d: 3 }));
  deq(r.log, ['3'], '(Fiji) the appended function wins over one of the script');
  r = await run(inj('#@ Integer n\n#@ String s\nz = nope;\n', { n: 1, s: 'q' }));
  deq([r.error.line, r.error.excerpt], [3, 'z = <nope> ; ']);
  r = await run(inj('#@ Integer n\nprint(n); x = (;\n', { n: 7 }));
  deq([r.log, r.error.message, r.error.line], [['7'], 'Number or numeric function expected', 2]);
  r = await run(inj('#@ String (required=false) s3\nprint("s3=["+s3+"]");', {}));
  deq(r.log, ['s3=[0]'], '(Fiji) an input without a value is declared, not assigned');
  r = await run(inj('#@ ImagePlus imp\nprint(imp);', { imp: 'd1' }, { imageIds: { imp: -3 } }));
  deq(r.log, ['-3']);
  ok();
}

// ═══ Java number text ═══
{
  const d = [[3, '3.0'], [0.1, '0.1'], [1e-10, '1.0E-10'], [1234567, '1234567.0'], [12345678, '1.2345678E7'], [0.001, '0.001'], [0.0001, '1.0E-4'],
    [-2.5, '-2.5'], [-0, '-0.0'], [NaN, 'NaN'], [Infinity, 'Infinity'], [1e21, '1.0E21'], [123456789012, '1.23456789012E11']];
  for (const [x, s] of d) assert.equal(P.javaDoubleString(x), s, 'Double.toString ' + x);
  for (const [x, s] of [[0.1, '0.1'], [2.5, '2.5'], [1 / 3, '0.33333334'], [1e10, '1.0E10'], [16777217, '1.6777216E7']]) assert.equal(P.javaFloatString(x), s, 'Float.toString ' + x);
  ok();
}

// ═══ goldens from Fiji (CAPTURE) ═══
const GOLD = path.join(ROOT, 'tests', 'fixtures', 'ij-macro', 'params-golden.json');
if (!fs.existsSync(GOLD)) console.log('SKIP params-golden.json absent (tools/ij_fixtures/macro/ParamGolden.java): CAPTURE goldens not checked');
else {
  const G = JSON.parse(fs.readFileSync(GOLD, 'utf8'));
  assert.equal(G.fiji['scijava-common'], '2.101.0');
  const javaOf = (it, k) => {
    const v = it[k];
    if (v === null || v === undefined) return null;
    // a stepSize the script gives is kept as a Double whatever the type (Fiji: Integer stepSize=5 → "5.0"); the default follows the type
    if (k === 'stepSize' && typeof v === 'number' && it.attrs.stepsize !== undefined) return P.javaDoubleString(v);
    if (it.kind === 'number' && typeof v === 'number') return it.integer || it.big ? String(v) : (it.float ? P.javaFloatString(v) : P.javaDoubleString(v));
    return String(v);
  };
  const FIELDS = { name: 'name', type: 'javaType', declared: 'declared', label: 'label', description: 'description', style: 'style', min: 'min', max: 'max',
    softMin: 'softMin', softMax: 'softMax', stepSize: 'stepSize', choices: 'choices', columns: 'columns', rows: 'rows', value: 'value', persist: 'persist',
    required: 'required', visibility: 'visibility', callback: 'callback', initializer: 'initializer', autoFill: 'autoFill', ioType: 'io' };
  /** The dump of ParamGolden: "<line>: <tokens>" per line holding tokens, numbers as Double.toString, strings re-escaped. */
  const ESC = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\t': '\\t', '\r': '\\r' };
  const esc = (t) => t.replace(/[\\"\u0000-\u001f]/g, (ch) => ESC[ch] || '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
  function dump(text, dropLine) {
    const c = IJMacro.compile(text);
    const lines = new Map();
    for (const t of c.tokens) {
      if (t.token === IJMacro.K.EOF || t.line === dropLine) continue;
      const sym = c.program.table[c.program.code[t.index] >> IJMacro.K.TOK_SHIFT];
      let s = t.text;
      if (t.token === IJMacro.K.NUMBER) s = P.javaDoubleString(sym.value);
      else if (t.token === IJMacro.K.STRING_CONSTANT) s = '"' + esc(sym.str) + '"';
      if (!lines.has(t.line)) lines.set(t.line, []);
      lines.get(t.line).push(s);
    }
    return [...lines.entries()].map(([l, ts]) => l + ': ' + ts.join(' '));
  }
  const inputValue = (it, v) => {
    if (!v || typeof v !== 'object') return v;
    if (it && it.kind === 'number' && typeof v.value === 'string' && !/^java.math./.test(v.javaType)) return Number(v.value);   // NaN, Infinity
    return v.value;
  };
  /** JSON has no -0: the dumped program says which input was -0.0. */
  const negZero = (c, values) => {
    for (const l of c.program || []) { const z = /^\d+: (\w+) = - 0\.0 ;$/.exec(l); if (z && values[z[1]] === 0) values[z[1]] = -0; }
  };
  let cases = 0, runs = 0, programs = 0, outs = 0;
  const canReadVars = (await IJMacro.run('x = 1;', { readVars: ['x'] })).vars !== undefined;
  for (const [id, c] of Object.entries(G.cases)) {
    const p = P.parse(c.source);
    const gp = c.parsed;
    if (gp.error) {
      assert.ok(p.errors.length > 0, id + ': Fiji could not read the script (' + gp.error + ')');
      assert.equal(P.check(p)[0].key, 'err.macParamSyntax', id);
      cases++;
      continue;
    }
    assert.equal(p.errors.length, 0, id + ': parse errors ' + JSON.stringify(J(p.errors)));
    assert.equal(p.ignored.length, gp.warnings.filter((w) => /Ignoring invalid parameter/.test(w)).length, id + ': ignored lines');
    const ins = p.items.filter((i) => i.io !== 'OUTPUT');
    assert.equal(ins.length, gp.inputs.length, id + ': input count');
    gp.inputs.forEach((g, k) => {
      const it = ins[k];
      for (const [gk, mk] of Object.entries(FIELDS)) {
        if (!(gk in g)) continue;
        if (gk === 'declared' && gp.inputs.filter((x) => x.name === g.name).length > 1) continue;   // the capture names a repeated input once
        let mine = mk === 'choices' ? (it.choices && it.choices.length ? it.choices : null)
          : ['min', 'max', 'softMin', 'softMax', 'stepSize', 'value'].indexOf(mk) >= 0 ? javaOf(it, mk) : it[mk];
        let gold = g[gk];
        if (typeof gold === 'number' || typeof gold === 'boolean') gold = String(gold);
        if (typeof mine === 'number' || typeof mine === 'boolean') mine = String(mine);
        deq(mine, gold, id + ' input ' + g.name + '.' + gk);
      }
      if ('widgetLabel' in g) assert.equal(P.widgetLabel(it), g.widgetLabel, id + ' ' + g.name + ' widget label');
    });
    const outsDecl = p.outputs.map((o) => ({ name: o.name, type: o.javaType }));
    if (p.implicitResult) outsDecl.push({ name: 'result', type: 'java.lang.Object' });
    deq(outsDecl, gp.outputs, id + ': outputs');
    if (gp.script && (gp.script.name || gp.script.label)) deq(p.script, { name: gp.script.name, label: gp.script.label }, id + ': #@script');

    // runs: Fiji's prefs are cleared per case and keyed by the input's name alone
    const refused = P.check(p).length > 0;
    const persisted = {};
    for (const r of c.runs || []) {
      if (r.thrown) { assert.ok(refused, id + ': Fiji throws, the Studio refuses before the run'); continue; }
      const pr = r.source ? P.parse(r.source) : p;
      if (pr.items.some((i) => i.kind === 'image' || i.kind === 'service' || i.kind === 'unknown')) continue;
      if (/\{DIR\}/.test(r.source || c.source)) continue;
      const values = P.headlessValues(pr, persisted);
      for (const it of pr.inputs) if (r.inputs && r.inputs[it.name]) values[it.name] = inputValue(it, r.inputs[it.name]);
      negZero(c, values);
      const miss = P.missing(pr, values);
      if (r.canceled) {
        assert.ok(miss.length > 0 && r.canceled.indexOf("'" + miss[0] + "'") === 0, id + ': canceled because ' + r.canceled + ' (mine: ' + miss + ')');
        continue;
      }
      deq(miss, [], id + ': nothing missing');
      for (const it of pr.inputs) if (it.persist && (it.visibility === 'NORMAL' || it.visibility === 'TRANSIENT') && values[it.name] !== undefined) persisted[it.name] = values[it.name];
      const log = [];
      const res = await IJMacro.run(P.inject(pr, values), { onLog: (x) => log.push(x), readVars: P.outputs(pr) });
      const lines = (a) => (a.length ? a.join('\n').split('\n') : []);   // the capture reads stdout line by line
      // java.io.File prints with the Windows separator on the capture machine; the Studio's paths are virtual and use '/'
      const sep = (a) => (pr.inputs.some((i) => i.kind === 'file') ? a.map((x) => x.replace(/\\/g, '/')) : a);
      deq(lines(log), sep(lines(r.log)), id + ': log');
      const err = res.error ? J(res.error) : null;
      // Fiji's script engine prefixes every macro; the Studio runs a macro without parameter lines as ImageJ does (same message
      // and line, an excerpt without the prefix)
      const fixPrefix = (x) => (pr.hasParams ? x : x.replace(/^var ; initializeSciJavaParameters \( \) ; /, ''));
      if (r.error) deq(err && [err.message, err.line, err.excerpt], [r.error.message, r.error.line, fixPrefix(r.error.excerpt)], id + ': error');
      else assert.equal(err, null, id + ': no error expected, got ' + JSON.stringify(err));
      if (canReadVars && r.outputs) {
        for (const [name, o] of Object.entries(r.outputs)) {
          if (name === 'result' && pr.implicitResult) continue;
          const v = res.vars ? res.vars[name] : null;
          assert.equal(v ? P.formatOutput(pr, name, J(v)) : null, o === null ? null : o.toString, id + ': output ' + name);
          outs++;
        }
      }
      runs++;
    }
    // the program the IJ1 engine ran (line structure, names, literals); the dump line and Fiji's saveInterpreter call left out
    const m = /the dump call sat on line (\d+)/.exec(c.programNote || '');
    if (c.program && m && !refused && p.hasParams && !/\{DIR\}/.test(c.source)) {
      const N = Number(m[1]);
      const lines = c.source.replace(/\r\n/g, '\n').split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      while (lines.length < N - 1) lines.push('');
      lines.splice(N - 1, 0, 'dumpHere();');
      const p2 = P.parse(lines.join('\n') + '\n');
      const r0 = (c.runs || [])[0] || { inputs: {} };
      const values = P.headlessValues(p2, {});
      for (const it of p2.inputs) if (r0.inputs && r0.inputs[it.name]) values[it.name] = inputValue(it, r0.inputs[it.name]);
      negZero(c, values);
      // the case image of ParamGolden: id -2, title img-<case>
      const imageIds = {}, imageTitles = {};
      for (const it of p2.inputs) if (it.kind === 'image') { values[it.name] = 'doc'; imageIds[it.name] = -2; imageTitles[it.name] = 'img-' + id; }
      let gold = c.program.filter((l) => l.indexOf('IJ1MacroEngine.saveInterpreter') < 0);
      if (p2.inputs.some((i) => i.kind === 'file')) gold = gold.map((l) => l.replace(/\\\\/g, '/'));
      deq(dump(P.inject(p2, values, { imageIds, imageTitles }), N), gold, id + ': program');
      programs++;
    }
    cases++;
  }
  console.log('  params-golden: ' + cases + ' cases, ' + runs + ' runs, ' + programs + ' programs' + (canReadVars ? ', ' + outs + ' outputs' : '') + ' compared');
  if (!canReadVars) console.log('  note: IJMacro.run has no readVars yet (EXTRAS.md L5): the golden outputs are not compared');
}

console.log('test_ij_macro_params: ' + n + ' groups passed');
