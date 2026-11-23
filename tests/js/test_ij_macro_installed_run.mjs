// Installed macro sets in the worker runtime (ij-proc-macro.js): macro.run with `entry` (MacroInstaller + MacroRunner of ImageJ 1.54p),
// run("<installed name>") nested in a run, readVars / returnValue (Fiji outputs), and #@ in a macro file run by runMacro().
// Contract: DOCS/studio-advanced/macros/EXTRAS.md §3 (L3, L5), §6.5, §7, §10.1, §10.5.
//   • start -1 runs the set's top-level `var` statements once; an entry (start null) runs its block; `var` values persist between the
//     runs of one set; a new text (hash) is prepared afresh; two sets (startup, installed) keep their own globals; an anonymous set runs whole;
//     a name that is not the entry's at that rank is an internal error;
//   • nested: the entry runs inside the calling run (same Log, one undo step); its error shows the Macro Error window and the calling macro
//     goes on (MacroRunner.run catches it); its exit() ends the entry only;
//   • a startup order driven by a stand-in page (StartupMacros installed with its AutoRun deferred, RunAtStartup, the installed set,
//     then the AutoRun);
//   • readVars after a normal end, an error and exit(); returnValue.
//
// Run: node tests/js/test_ij_macro_installed_run.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { xrt, withExtras, standIn, DIR } from './ij_macro_worker_extras_support.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (err) { console.error('FAIL ' + name); throw err; }
}
const J = (x) => JSON.parse(JSON.stringify(x));
if (standIn()) console.log('note: ij-macro-lang.js has no L3–L5 yet (EXTRAS.md §3): the runs use the contract stand-in of ij_macro_worker_extras_support.mjs');

/* FNV-1a 32 of a text, in hex (the page's fnvHex) */
function fnvHex(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}
const entry = (set, source, name, index, start) => ({ entry: { kind: 'installed', set, hash: fnvHex(source), source, name, index, start: start === undefined ? null : start } });
const logOf = (t, r) => J(t.W.IJMacroProto.log.apply([], r.log));

async function boot() {
  const t = withExtras(await xrt());
  t.installed = new Map();   // name → installed descriptor (what IJMacroPage.installedEntry answers)
  t.page.answers.run = (a) => {
    const inst = t.installed.get(a.name);
    if (inst) return { status: 'installed', text: '', installed: inst, current: t.page.current, created: [], closed: [] };
    return { status: 'unrecognized', text: 'Unrecognized command: "' + a.name + '"', current: t.page.current, created: [], closed: [] };
  };
  return t;
}

const SET = 'var n = 0;\nvar label = "count";\nmacro "Count [c]" { n++; print(label + " " + n); }\nmacro "-" {}\nmacro "Hello" { print("hello " + n); }\n' +
  'macro "Quit" { print("q1"); exit; print("q2"); }\nmacro "Bad" { x = undefinedVariable; }\nmacro "Paint" { setPixel(0, 0, getPixel(0, 0) + 10); }\n';

await test('start -1 prepares the globals once; entries run their block; var values persist between runs; a new text restarts them', async () => {
  const t = await boot();
  try {
    let r = await t.runX('', entry('installed', SET, '', 0, -1));
    assert.equal(r.result.error, null, JSON.stringify(r.result.error));
    assert.deepEqual(logOf(t, r), [], 'start -1 runs only the var statements');
    r = await t.runX('', entry('installed', SET, 'Count [c]', 0));
    assert.deepEqual(logOf(t, r), ['count 1']);
    r = await t.runX('', entry('installed', SET, 'Count [c]', 0));
    assert.deepEqual(logOf(t, r), ['count 2'], 'the set\'s globals persist (ImageJ keeps one Program per installed set)');
    r = await t.runX('', entry('installed', SET, 'Hello', 2));
    assert.deepEqual(logOf(t, r), ['hello 2'], 'the entry at rank 2 ("-" is rank 1)');
    const SET2 = SET + '\n// edited\n';
    r = await t.runX('', entry('installed', SET2, 'Count [c]', 0));
    assert.deepEqual(logOf(t, r), ['count 1'], 'another hash: prepared afresh, the var values restart');
    // the startup set keeps its own program and globals beside the installed one
    r = await t.runX('', entry('startup', SET, 'Count [c]', 0));
    assert.deepEqual(logOf(t, r), ['count 1']);
    r = await t.runX('', entry('installed', SET2, 'Count [c]', 0));
    assert.deepEqual(logOf(t, r), ['count 2']);
    // the page and the language disagree on the entry at that rank: an internal error, nothing runs
    r = await t.runX('', entry('installed', SET2, 'Hello', 0));
    assert.ok(r.error && r.error.code === 'IJ_INTERNAL', JSON.stringify(r.error));
    // an anonymous set (a file without macro blocks) runs whole: entry start null with no macro, or start 0
    const ANON = 'var k = 5;\nprint("anon " + k);\n';
    r = await t.runX('', entry('installed', ANON, 'anon', 0));
    assert.deepEqual(logOf(t, r), ['anon 5']);
    r = await t.runX('', entry('installed', ANON, 'anon', 0, 0));
    assert.deepEqual(logOf(t, r), ['anon 5']);
    // a malformed entry is refused before anything runs
    r = await t.runX('', { entry: { kind: 'installed', set: 'other', hash: 'zz', source: '', name: '' } });
    assert.ok(r.error && r.error.code === 'IJ_BAD_ARGS');
  } finally { t.close(); }
});

await test('run("<installed name>") runs the entry inside the run: same Log, globals shared, exit ends the entry, its error shows a window and the macro goes on', async () => {
  const t = await boot();
  try {
    const h = fnvHex(SET);
    const names = ['Count [c]', '-', 'Hello', 'Quit', 'Bad', 'Paint'];
    names.forEach((nm, i) => t.installed.set(nm, { set: 'installed', hash: h, source: SET, name: nm, index: i }));
    await t.runX('', entry('installed', SET, '', 0, -1));
    let r = await t.run('run("Count [c]"); run("Count [c]"); run("Hello"); print("after");');
    assert.equal(r.result.error, null, JSON.stringify(r.result.error));
    assert.deepEqual(logOf(t, r), ['count 1', 'count 2', 'hello 2', 'after']);
    r = await t.run('run("Quit"); print("after quit");');
    assert.deepEqual(logOf(t, r), ['q1', 'after quit'], 'exit() ends the entry only');
    const d0 = t.page.dialogs.length;
    r = await t.run('run("Bad"); print("after bad");');
    assert.equal(r.result.error, null, 'MacroRunner.run catches the entry\'s error: the calling macro goes on');
    assert.deepEqual(logOf(t, r), ['after bad']);
    const shown = t.page.dialogs.slice(d0).filter((x) => x[0] === 'error.show').map((x) => x[1].text);
    assert.equal(shown.length, 1, 'one Macro Error window');
    assert.ok(/^Undefined variable in line 7\n/.test(shown[0]), shown[0]);
  } finally { t.close(); }
});

await test('one run = one undo step, the nested entries included', async () => {
  const t = await boot();
  try {
    const id = await t.open({ name: 'img', width: 4, height: 3, bitDepth: 8, channels: [{ data: new Uint8Array(12).fill(1) }] });
    const h = fnvHex(SET);
    t.installed.set('Paint', { set: 'installed', hash: h, source: SET, name: 'Paint', index: 5 });
    const u0 = t.eng.inspectDoc(id).undo.length;
    const r = await t.run('setPixel(1, 0, 50); run("Paint"); run("Paint"); setPixel(2, 0, 60);');
    assert.equal(r.result.error, null, JSON.stringify(r.result.error));
    assert.deepEqual(t.pixels(id).slice(0, 3), [21, 50, 60]);
    assert.equal(t.eng.inspectDoc(id).undo.length, u0 + 1, 'one undo step');
    const r2 = await t.runX('', entry('installed', SET, 'Paint', 5));
    assert.equal(r2.result.error, null);
    assert.equal(t.pixels(id)[0], 31);
    assert.equal(t.eng.inspectDoc(id).undo.length, u0 + 2, 'an entry run on its own is one more step');
  } finally { t.close(); }
});

await test('startup order (stand-in page): StartupMacros installed + globals, RunAtStartup, the installed set, then the deferred AutoRun', async () => {
  const t = await boot();
  try {
    const STARTUP = 'var s = 0;\nmacro "AutoRun" { s++; print("A" + s); }\nmacro "Show" { print("S" + s); }\n';
    const INSTALLED = 'var s = 100;\nmacro "Show" { print("I" + s); }\n';
    const log = [];
    const step = async (src, extra) => { const r = await t.runX(src, extra); assert.equal(r.result.error, null, JSON.stringify(r.result.error)); log.push(...logOf(t, r)); };
    await step('', entry('startup', STARTUP, '', 0, -1));
    await step('print("R");', null);
    await step('', entry('installed', INSTALLED, '', 0, -1));
    await step('', entry('startup', STARTUP, 'AutoRun', 0));
    await step('', entry('startup', STARTUP, 'Show', 1));
    await step('', entry('installed', INSTALLED, 'Show', 0));
    assert.deepEqual(log, ['R', 'A1', 'S1', 'I100'], 'each set keeps its own globals; the AutoRun ran after RunAtStartup');
    // a failing RunAtStartup is that step's error; the next steps still run
    const bad = await t.runX('x = nope;', null);
    assert.ok(bad.result.error && bad.result.error.message === 'Undefined variable');
    const after = await t.runX('', entry('startup', STARTUP, 'AutoRun', 0));
    assert.deepEqual(logOf(t, after), ['A2']);
  } finally { t.close(); }
});

await test('readVars after a normal end, an error and exit(); returnValue', async () => {
  const t = await boot();
  try {
    let r = await t.runX('a = 3; s = "x"; arr = newArray(1, "b"); f = 0.5;', { readVars: ['a', 's', 'arr', 'f', 'nope', 'bad name'] });
    assert.equal(r.result.error, null);
    assert.deepEqual(J(r.result.vars), { a: { n: 3 }, s: { s: 'x' }, arr: { a: [1, 'b'] }, f: { n: 0.5 }, nope: null });
    r = await t.runX('a = 7; b = c;', { readVars: ['a'] });
    assert.ok(r.result.error);
    assert.deepEqual(J(r.result.vars), { a: { n: 7 } }, 'read after an error');
    r = await t.runX('greeting = "hi"; exit; greeting = "no";', { readVars: ['greeting'] });
    assert.equal(r.result.exited, true);
    assert.deepEqual(J(r.result.vars), { greeting: { s: 'hi' } }, 'read after exit()');
    r = await t.run('print(1);');
    assert.deepEqual(J(r.result.vars), {}, 'no readVars: {}');
    assert.equal(r.result.returnValue, null);
    r = await t.run('return "done";');
    assert.equal(r.result.returnValue, 'done');
  } finally { t.close(); }
});

await test('#@ lines of a macro file run by runMacro() are not processed: the child stops on line 1, the caller goes on (golden params nested-runmacro, EXTRAS.md P5)', async () => {
  const G = JSON.parse(fs.readFileSync(path.join(DIR, '..', '..', '..', '..', 'tests', 'fixtures', 'ij-macro', 'params-golden.json'), 'utf8')).cases['nested-runmacro'];
  const t = await boot();
  try {
    t.grant('Data', t.disk({ 'child.ijm': G.files['child.ijm'] }), { mode: 'allow' });
    const d0 = t.page.dialogs.length;
    const r = await t.runF(G.source.split('{DIR}').join('/Data/'));
    assert.equal(r.result.error, null, 'the caller continues: ' + JSON.stringify(r.result.error));
    assert.deepEqual(logOf(t, r), G.runs[0].log);
    const shown = t.page.dialogs.slice(d0).filter((x) => x[0] === 'error.show').map((x) => x[1].text);
    // headless Fiji logs the window's text after "Macro Error: ", the title of the window the Studio shows
    assert.deepEqual(shown, [G.runs[0].error.text.replace(/^Macro Error: /, '')], 'the child\'s Macro Error window');
  } finally { t.close(); }
});

await test('run("Install...", "install=<vpath>") reads the set through the folders granted to macros and hands it to the page (install.set)', async () => {
  const t = await boot();
  try {
    const sets = [];
    t.page.answers['install.set'] = (a) => { sets.push(a); return { count: 1, keysInUse: [] }; };
    const run0 = t.page.answers.run;
    t.page.answers.run = (a) => {
      if (a.name === 'Install...') {
        const m = /install=(\S+)/.exec(a.options || '');
        return { status: 'file', file: { op: 'install', pathText: m ? m[1] : null }, current: t.page.current, created: [], closed: [] };
      }
      return run0(a);
    };
    t.grant('Data', t.disk({ 'set.ijm': 'macro "Hi" {\r\n print("hi");\r\n}', 'notes.md': 'x' }), { mode: 'allow' });
    let r = await t.runF('run("Install...", "install=/Data/set.ijm"); print("after");', { texts: { 'err.macInstallExt': 'File name must end with ".txt" or ".ijm" .' } });
    assert.equal(r.result.error, null, JSON.stringify(r.result.error));
    assert.deepEqual(J(sets), [{ name: 'set.ijm', path: '/Data/set.ijm', source:'macro "Hi" {\n print("hi");\n}\n' }], 'MacroInstaller.open: every line + "\\n"');
    assert.deepEqual(logOf(t, r), ['after']);
    const d0 = t.page.dialogs.length;
    r = await t.runF('run("Install...", "install=/Data/notes.md"); print("after");', { texts: { 'err.macInstallExt': 'File name must end with ".txt" or ".ijm" .' } });
    assert.equal(r.result.error, null, 'MacroInstaller.showDialog: a message, the macro goes on');
    const box = t.page.dialogs.slice(d0).filter((x) => x[0] === 'dialog.message').map((x) => [x[1].title, x[1].text]);
    assert.deepEqual(box, [['Macro Installer', 'File name must end with ".txt" or ".ijm" .']]);
    assert.equal(sets.length, 1, 'nothing installed');
  } finally { t.close(); }
});

console.log(passed + ' tests passed');
