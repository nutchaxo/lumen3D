// Page side of the macro extras (DOCS/studio-advanced/macros/EXTRAS.md, phase M7 + M8): the 'command' / 'action' / 'opened' events and
// their emission rules (operator only, Repeat Command, nested commands, a macro's own commands), IJMacroOptions.recordTokens / foldTokens and
// the build-level `recorded` sweep against ImageJ's capture (§4.6), the new commands / menus / panels / tables, Install (rows, keys that
// never collide with the frozen table, boxes, persistence, Remove), the startup order, Edit › Options › Startup…, the Batch Process window,
// Process › Math › Macro…, the #@ dialog before a run (persisted values, Cancel = no run, the Outputs window) and the lang keys of §13.
//
// Run: node tests/js/test_ij_macro_extras_page.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { boot, until, sleep, DIR, MACRO_FILES } from './ij_harness.mjs';
import { ROOT } from './harness.mjs';

for (const f of MACRO_FILES) {
  if (!fs.existsSync(path.join(DIR, f))) { console.log('SKIP test_ij_macro_extras_page: ' + f + ' is absent'); process.exit(0); }
}

let passed = 0;
const skipped = [];
async function test(name, fn) {
  try { const r = await fn(); if (r === 'skip') { skipped.push(name); console.log('  SKIP ' + name); } else { passed++; console.log('  ok  ' + name); } } catch (err) { console.error('FAIL ' + name); throw err; }
}
const J = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
// values from the page / worker contexts carry their own Array / Object prototypes: compared as plain data
const deq = (a, b, m) => (m === undefined ? assert.deepEqual(J(a), J(b)) : assert.deepEqual(J(a), J(b), m));
const page = (t) => vm.runInContext('IJMacroPage', t.page);
const LANGS = ['en', 'fr', 'es', 'nl'];
const LANG = Object.fromEntries(LANGS.map((c) => [c, JSON.parse(fs.readFileSync(path.join(DIR, 'lang', c + '.json'), 'utf8'))]));
const lookup = (d, k) => k.split('.').reduce((o, s) => (o && typeof o === 'object' ? o[s] : undefined), d);
const EN = (k, p) => String(lookup(LANG.en, k)).replace(/\{(\w+)\}/g, (m, n) => (p && p[n] !== undefined ? p[n] : m));
// L3 of EXTRAS.md §3 (prepared programs): without it an installed entry cannot run, the parts that run one say SKIP
const LANG_SRC = fs.readFileSync(path.join(DIR, 'ij-macro-lang.js'), 'utf8');
const HAS_L3 = /\bprepare\s*[:(]/.test(LANG_SRC) && /pixelProgram/.test(LANG_SRC);
const HAS_L5 = /readVars/.test(LANG_SRC);

async function fresh(o) {
  const t = await boot(Object.assign({ channels: 1, immediateMessages: true }, o || {}));
  const events = { command: [], action: [], opened: [] };
  const a = t.api('macro');
  for (const k of Object.keys(events)) a.on(k, (ev) => events[k].push(J(ev)));
  await t.open();
  assert.ok(!t.failedPackages().has('macro'), 'package macro loads in the worker');
  t.events = events;
  t.ends = () => events.command.filter((e) => e.phase === 'end');
  return t;
}
const reset = (t) => { for (const k of Object.keys(t.events)) t.events[k].length = 0; };

// ═════════════════════════════ tables (pure) ═════════════════════════════
const appSrc = fs.readFileSync(path.join(DIR, 'ij-app.js'), 'utf8');
const plugin = JSON.parse(fs.readFileSync(path.join(DIR, 'plugin.json'), 'utf8'));

await test('plugin.json 1.6.0: ij-macro-params.js and ij-macro-rec.js right after ij-macro-cmds.js; ij-macro-math.js is worker only', () => {
  assert.equal(plugin.version, '1.6.0');
  const s = plugin.scripts;
  const i = s.indexOf('ij-macro-cmds.js');
  deq(s.slice(i, i + 4), ['ij-macro-cmds.js', 'ij-macro-params.js', 'ij-macro-rec.js', 'ij-view.js']);
  assert.ok(!s.includes('ij-macro-math.js') && !s.includes('ij-macro-lang.js'), 'worker-only files are not page scripts');
  assert.ok(/macro: Object\.freeze\(\['ij-macro-lang\.js', 'ij-macro-vfs\.js', 'ij-macro-params\.js', 'ij-macro-math\.js'\]\)/.test(appSrc), 'PACKAGE_PRE.macro, the language first');
});

const ctxCmds = vm.createContext({ console });
ctxCmds.self = ctxCmds;
vm.runInContext(fs.readFileSync(path.join(DIR, 'ij-macro-cmds.js'), 'utf8'), ctxCmds);
const O = ctxCmds.IJMacroOptions, C = ctxCmds.IJMacroCmds;

await test('MACRO_COMMANDS: the extras commands, classes and names (EXTRAS.md §4.3)', () => {
  const T = C.MACRO_COMMANDS;
  const want = { mathMacro: ['Macro...', 'A'], batchMacro: ['Macro... ', 'F'], macInstall: ['Install...', 'F'], macStartup: ['Startup Macros...', 'E'],
    macRecord: ['Record...', 'E'], optStartup: ['Startup...', 'E'], macRemoveInstalled: ['Remove Installed Macros', 'E'] };
  for (const [id, [name, cls]] of Object.entries(want)) { assert.equal(T[id].name, name, id); assert.equal(T[id].cls, cls, id); }
  assert.equal(C.resolve('Macro...').id, 'mathMacro');
  assert.equal(C.resolve('Macro... ').entry.file.op, 'batchMacro');
  assert.equal(C.resolve('Install...').entry.file.op, 'install');
  assert.equal(C.resolve('Record...').refuse.params.reasonKey, 'err.macReasonRecorder');
  // ImageMath.getMacro: "v=…" options without code= are the code
  assert.equal(T.mathMacro.dialogs[0].rewrite('v=v+1 '), 'code=v=v+1 ');
  assert.equal(T.mathMacro.dialogs[0].rewrite('code=[v=1] '), 'code=[v=1] ');
  // FileSpec kind 'none' + extra type 'text' (BatchProcessor in macro mode)
  const r = C.fileRequest(T.batchMacro.file, O.normalize('output_format=PNG text1=[run("Invert");]'), { vars: {} });
  assert.equal(r.pathText, null);
  deq(J(r.values), { format: 'PNG', add: null, filter: '', code: 'run("Invert");' });
  const r2 = C.fileRequest(T.batchMacro.file, O.normalize('output_format=GIFX'), { vars: {} });
  assert.ok(/is not a valid choice for "output_format"/.test(r2.error));
  assert.equal(C.fileRequest(T.macInstall.file, O.normalize('install=/Macros/a.ijm'), {}).pathText, '/Macros/a.ijm');
});

await test('recordTokens / foldTokens: GenericDialog + Recorder.recordOption rules (EXTRAS.md §4.6)', () => {
  const fold = (vals, de, fields) => O.foldTokens(O.recordTokens(vals, de, { fields }));
  // Duplicate with its defaults (smart recording): " "
  assert.equal(fold({ title: 'a-1', ignore: false }, { keys: { title: 'title', ignore: 'ignore' }, smart: true },
    [{ type: 'string', id: 'title', value: 'a-1' }, { type: 'check', id: 'ignore', value: false }]), ' ');
  assert.equal(fold({ title: 'b c', ignore: true }, { keys: { title: 'title', ignore: 'ignore' }, smart: true },
    [{ type: 'string', id: 'title', value: 'a-1' }, { type: 'check', id: 'ignore', value: false }]), 'title=[b c] ignore');
  // numbers: IJ.d2s(v, decimals) then ".0" / ".00" trimmed; HALF_EVEN; an empty string is []
  assert.equal(fold({ sigma: 2 }, { keys: { sigma: 'sigma' } }, [{ type: 'number', id: 'sigma', value: 2, decimals: 2 }]), 'sigma=2');
  // a value the operator typed is recorded as typed; an untouched field as ImageJ's text of its default (the plugin's digits)
  assert.equal(fold({ s: 0.125 }, { keys: { s: 's' } }, [{ type: 'number', id: 's', value: 1, decimals: 2 }]), 's=0.125');
  assert.equal(fold({ s: 1.25 }, { keys: { s: 'value' }, decimals: { s: (o) => (Number.isInteger(o) ? 0 : 3) } }, [{ type: 'number', id: 's', value: 1.25 }]), 'value=1.250');
  assert.equal(fold({ s: 25 }, { keys: { s: 'value' }, decimals: { s: (o) => (Number.isInteger(o) ? 0 : 3) } }, [{ type: 'number', id: 's', value: 25 }]), 'value=25');
  assert.equal(fold({ s: 0 }, { keys: { s: 'starting' }, decimals: { s: 'text' } }, [{ type: 'number', id: 's', value: 0, decimals: 3 }]), 'starting=0');
  // smart recording of one field (Scaler's title): the default is not written
  assert.equal(fold({ t: 'a-1', c: true }, { keys: { t: 'title', c: 'create' }, smartFields: ['t'] }, [{ type: 'string', id: 't', value: 'a-1' }, { type: 'check', id: 'c', value: true }]), 'create');
  assert.equal(fold({ s: 2.5 }, { keys: { s: 's' } }, [{ type: 'number', id: 's', value: 1, decimals: 1 }]), 's=2.5');
  assert.equal(fold({ n: '' }, { keys: { n: 'name' } }, [{ type: 'string', id: 'n', value: 'x' }]), 'name=[]');
  // a false check first leaves ImageJ's " ", the next option is appended after one more space (Recorder.recordOption)
  assert.equal(fold({ a: false, b: 3 }, { keys: { a: 'a', b: 'b' } }, [{ type: 'check', id: 'a', value: false }, { type: 'number', id: 'b', value: 3, decimals: 0 }]), '  b=3');
  assert.equal(O.foldTokens([{ t: 'flag', key: 'stack' }], ' '), 'stack');
  assert.equal(O.foldTokens([{ t: 'blank' }], 'x=1'), 'x=1');
  // text areas: text1 / text2, an empty text gives "text1="
  assert.equal(fold({ c: '', d: 'a\nb' }, { keys: { c: 'x', d: 'y' } }, [{ type: 'textarea', id: 'c', value: '' }, { type: 'textarea', id: 'd', value: '' }]), 'text1= text2=a\\nb');
  // choice: smart default → nothing; Merge Channels' *None* → nothing
  assert.equal(fold({ m: 'otsu' }, { keys: { m: 'method' }, items: { m: { Otsu: 'otsu' } }, smart: true }, [{ type: 'choice', id: 'm', value: 'otsu', options: ['otsu'] }]), null);
  assert.equal(fold({ c1: 'none' }, { ij: 'Merge Channels...#0', keys: { c1: 'c1' }, items: { c1: { '*None*': 'none' } } }, [{ type: 'choice', id: 'c1', value: 'none', options: ['none'] }]), null);
  // the "all channels" check is ImageJ's stack word; recordOrder overrides the component order
  assert.equal(fold({ all: true, v: 1 }, { keys: { v: 'value' } }, [{ type: 'check', id: 'all', value: false }, { type: 'number', id: 'v', value: 1, decimals: 0 }]), 'stack value=1');
  assert.equal(fold({ a: 1, b: 2 }, { keys: { a: 'a', b: 'b' }, recordOrder: ['b', 'a'] }, [{ type: 'number', id: 'a', value: 0, decimals: 0 }, { type: 'number', id: 'b', value: 0, decimals: 0 }]), 'b=2 a=1');
  // IJ.d2s from the jar: DecimalFormat keeps the sign of a negative that rounds to zero; HALF_EVEN on the exact binary value; HALF_UP at 0 places
  assert.equal(O.d2s(-0.0001, 2), '-0.00');
  assert.equal(O.d2s(0.065, 2), '0.07');
  assert.equal(O.d2s(0.075, 2), '0.07');
  assert.equal(O.d2s(66.105, 2), '66.11');
  assert.equal(O.d2s(2.5, 0), '3');
  assert.equal(O.d2s(NaN, 2), 'NaN');
});

// ═════════════════════════════ the page ═════════════════════════════
const t = await fresh();
const api = t.api('edit');
const firstDoc = t.activeId();

await test("'opened' once per mount with fresh: true, after the worker's packages", async () => {
  await until(() => t.events.opened.length > 0, 'opened');
  assert.equal(t.events.opened.length, 1);
  assert.equal(t.events.opened[0].fresh, true);
  assert.equal(typeof t.events.opened[0].mountSeq, 'number');
  // an empty startup set and an empty RunAtStartup run nothing: no lane, nothing logged
  assert.equal(t.api('macro').macro.running(), null);
  deq(t.macroLog(), []);
});

await test('commands, menus and panels of the extras (EXTRAS.md §4.3, §4.4)', () => {
  const want = { macInstall: [['Plugins', 'Macros'], 10], macStartup: [['Plugins', 'Macros'], 40], macRecord: [['Plugins', 'Macros'], 60], macRemoveInstalled: [['Plugins', 'Macros'], 70],
    optStartup: [['Edit', 'Options'], 170], batchMacro: [['Process', 'Batch'], 30], mathMacro: [['Process', 'Math'], 190] };
  for (const [id, [menu, order]] of Object.entries(want)) {
    const c = t.IJApp.COMMANDS.find((x) => x.id === id);
    assert.ok(c, id); deq(c.menu, menu, id); assert.equal(c.order, order, id); assert.equal(c.pkg, 'macro', id);
  }
  assert.equal(t.IJApp.COMMANDS.find((x) => x.id === 'macRecord').shortcut, 'u', 'IJ_Props Record...[u]');
  assert.equal(t.IJApp.COMMANDS.find((x) => x.id === 'macInstall').gesture, true, 'the picker opens in the click');
  assert.equal(t.IJApp.GROUP_META['Process/Batch'].order, 95);
  assert.equal(t.isEnabled('macRemoveInstalled'), false, 'nothing installed yet');
  assert.equal(t.isEnabled('mathMacro'), true);
});

await test("'command': an operator command emits start then end with its dialog steps; the payload is read-only data", async () => {
  reset(t);
  await t.runCommand('editInvert');
  const [s, e] = t.events.command;
  assert.equal(s.phase, 'start'); assert.equal(e.phase, 'end'); assert.equal(s.seq, e.seq);
  deq([e.id, e.name, e.cls, e.source, e.duringMacro, e.status], ['editInvert', 'Invert', 'A', 'menu', false, 'ok']);
  deq(e.steps, []);
  assert.equal(e.before.docId, firstDoc); assert.equal(e.after.docId, firstDoc);
  assert.equal(e.before.bitDepth, 8);
  deq(e.created, []); deq(e.closed, []);
  for (const k of ['fg', 'bg', 'sel', 'blackBackground', 'title', 'nSlices', 'nC', 'roi']) assert.ok(k in e.before, 'Ctx.' + k);

  reset(t);
  await t.runCommand('filterGaussian', { sigma: 3 });
  const g = t.ends()[0];
  assert.equal(g.name, 'Gaussian Blur...');
  assert.equal(g.steps.length, 1);
  const st = g.steps[0];
  assert.equal(st.kind, 'dialog'); assert.equal(st.index, 0);
  assert.equal(st.values.sigma, 3);
  assert.ok(st.entry && st.entry.keys.sigma === 'sigma', 'the DialogEntry the Recorder folds with');
  assert.ok(st.fields.some((f) => f.id === 'sigma' && typeof f.label === 'string' && f.label.length > 0));
  assert.ok(!st.fields.some((f) => Object.values(f).some((v) => typeof v === 'function')), 'no functions in a FieldSnap');
  assert.equal(O.foldTokens(O.recordTokens(st.values, st.entry, { fields: st.fields })), 'sigma=3');

  reset(t);
  await t.runCommand('filterGaussian', null);
  assert.equal(t.ends()[0].status, 'cancelled');
  assert.equal(t.ends()[0].steps[0].values, null);
});

await test("'command': Repeat Command emits the repeated command (source 'repeat') and nothing for itself; a command list outside any command is 'finder'", async () => {
  reset(t);
  await t.runCommand('filterGaussian', { sigma: 2 });
  reset(t);
  t.script.dialogs.push({});
  await t.runCommand('procRepeatCommand');
  const ends = t.ends();
  assert.equal(ends.length, 1);
  assert.equal(ends[0].id, 'filterGaussian'); assert.equal(ends[0].source, 'repeat');
  assert.ok(!t.events.command.some((e) => e.id === 'procRepeatCommand'));
  // a command list outside any command (Find Commands' Run): the operator's choice, source 'finder'; the command itself still gets 'api'
  reset(t);
  await t.api('ana').runCommand('editInvert');
  deq(t.ends().map((e) => [e.id, e.source]), [['editInvert', 'finder']]);
});

await test("'command': a macro's own run() commands never emit, nor its selections", async () => {
  reset(t);
  const r = await t.runMacro('run("Invert"); makeRectangle(1, 2, 3, 4); run("Select None");');
  assert.equal(r.ok, true, JSON.stringify(r.error));
  deq(t.events.command, []);
  deq(t.events.action, []);
});

await test("'action': selections, wand, activation, tool, line width — operator paths only", async () => {
  reset(t);
  t.toolRoi({ type: 'rect', x: 2, y: 3, w: 10, h: 8 }, { tool: 'rect', action: 'draw' });
  let a = t.events.action.pop();
  deq([a.kind, a.action, a.tool, a.duringMacro], ['roi', 'draw', 'rect', false]);
  deq(a.roi, { type: 'rect', x: 2, y: 3, w: 10, h: 8 });
  assert.equal(a.ctx.docId, firstDoc);
  t.toolRoi({ type: 'rect', x: 4, y: 3, w: 10, h: 8 }, { tool: 'rect', action: 'move' });
  assert.equal(t.events.action.pop().action, 'move');
  // api.setRoi (a package, a macro write op) is not the operator's
  api.setRoi({ type: 'oval', x: 1, y: 1, w: 5, h: 5 });
  assert.equal(t.events.action.length, 0);
  t.chooseTool('oval');
  a = t.events.action.pop();
  deq([a.kind, a.tool], ['tool', 'oval']);
  api.setTool('rect');
  assert.equal(t.events.action.length, 0, 'api.setTool is not the toolbar');
  await t.lineWidth(5);
  a = t.events.action.pop();
  deq([a.kind, a.width], ['lineWidth', 5]);
  await t.wandClick(5, 5);
  a = t.events.action.pop();
  assert.ok(a, 'the wand click is an action');
  assert.equal(a.kind, 'roi'); assert.equal(a.tool, 'wand'); assert.equal(a.wand.x, 5); assert.equal(a.wand.connectivity, 8); assert.equal(a.combine, null);
  // activation: a duplicate, then the operator clicks the first image's tab
  await t.runCommand('imageDuplicate', {});
  const dup = t.activeId();
  assert.notEqual(dup, firstDoc);
  reset(t);
  t.activate(firstDoc);
  a = t.events.action.pop();
  deq([a.kind, a.docId], ['activate', firstDoc]);
  assert.equal(typeof a.title, 'string');
  // the Window menu row of an image activates it too
  reset(t);
  const name = (await t.docs()).find((d) => d.docId === dup).name;
  t.shell.opts.onMenuOpen('Window');
  const row = t.shell.opts.commands.find((c) => c.dynamic && c.id === 'winImg' + dup);
  assert.ok(row, 'Window row of ' + name);
  await t.shell.opts.onCommand(row, { source: 'menu' });
  a = t.events.action.find((x) => x.kind === 'activate');
  assert.ok(a && a.docId === dup);
  assert.ok(!t.events.command.length, 'a Window row is a dynamic row: no command event');
  t.activate(firstDoc);
});

await test("'action': tool windows — Threshold, B&C, ROI Manager, Channels; a tool window's Window row is 'window'", async () => {
  reset(t);
  await t.thresholdAction('method', { method: 'Otsu' });
  let a = t.events.action.filter((x) => x.kind === 'threshold').pop();
  assert.ok(a, 'threshold action');
  assert.equal(a.op, 'method'); assert.equal(a.method, 'Otsu');
  assert.equal(typeof a.lower, 'number'); assert.equal(a.bitDepth, 8);
  reset(t);
  await t.thresholdAction('reset');
  assert.equal(t.events.action.pop().op, 'reset');
  await t.thresholdAction('set', { lower: 10, upper: 100 });
  a = t.events.action.pop();
  deq([a.op, a.lower, a.upper], ['set', 10, 100]);
  reset(t);
  await t.bcAction('reset');
  a = t.events.action.pop();
  assert.equal(a.kind, 'bc'); assert.equal(a.op, 'reset');
  await t.bcAction('set', { min: 5, max: 50 });
  a = t.events.action.pop();
  deq([a.op, a.min, a.max], ['set', 5, 50]);
  reset(t);
  api.setRoi({ type: 'rect', x: 2, y: 2, w: 6, h: 6 });
  await t.rmAction('Add');
  a = t.events.action.pop();
  deq([a.kind, a.op, a.indices, a.count], ['rm', 'Add', [0], 1]);
  await t.rmAction('Select', { index: 0 });
  a = t.events.action.filter((x) => x.op === 'Select').pop();
  deq(a.indices, [0]);
  await t.rmAction('Deselect');
  assert.equal(t.events.action.pop().op, 'Deselect');
  await t.rmAction('Show All', { on: true });
  assert.equal(t.events.action.pop().op, 'Show All');
  await t.rmAction('Show All', { on: false });
  assert.equal(t.events.action.pop().op, 'Show None');
  // Edit › Selection › Add to Manager (the `t` key) records the same Add, inside an operator command
  reset(t);
  await t.runCommand('editAddToManager');
  assert.equal(t.events.action.filter((x) => x.op === 'Add').length, 1);
  // Window menu: a tool window → 'window' with ImageJ's title
  reset(t);
  await t.windowMenu(EN('cmd.toolsRoiManager'));
  a = t.events.action.pop();
  deq([a.kind, a.title], ['window', 'ROI Manager']);
});

await test("'action': Channels tool controls on a two-channel image (mode, active channels, channel)", async () => {
  const t2 = await fresh({ channels: 2 });
  reset(t2);
  await t2.channelsAction('mode', { mode: 'color' });
  let a = t2.events.action.pop();
  deq([a.kind, a.op, a.mode], ['channels', 'mode', 'color']);
  await t2.channelsAction('mode', { mode: 'composite' });
  a = t2.events.action.pop();
  deq([a.op, a.mode, a.projection], ['mode', 'composite', 'Sum']);
  await t2.channelsAction('active', { channel: 2, on: false });
  a = t2.events.action.pop();
  deq([a.op, a.active], ['active', '10']);
  await t2.channelsAction('channel', { channel: 2 });
  a = t2.events.action.pop();
  deq([a.op, a.channel], ['channel', 2]);
  t2.close();
});

await test('Threshold › Apply: the threshold action, then a Convert to Mask command pair (source threshold)', async () => {
  reset(t);
  await t.thresholdAction('apply');
  await until(() => t.ends().some((e) => e.id === 'binMask'), 'binMask pair');
  const ai = t.events.action.findIndex((x) => x.kind === 'threshold' && x.op === 'apply');
  assert.ok(ai >= 0);
  const e = t.ends().find((x) => x.id === 'binMask');
  assert.equal(e.source, 'threshold'); assert.equal(e.name, 'Convert to Mask');
  assert.equal(e.created.length, 1, 'the mask is a new image');
  t.activate(firstDoc);
});

// ═════════════════════════════ Recorder window ═════════════════════════════
await test('Recorder: Plugins › Macros › Record… opens the tool window and records what the operator does', async () => {
  reset(t);
  const R = t.recorder();
  await R.open();
  const w = t.shell.windows.floats.get('macroRecorder');
  assert.ok(w, 'the Recorder window');
  assert.equal(w.spec.title, EN('dlg.mac.rec.title'));
  await t.runCommand('editInvert');
  assert.ok(/run\("Invert"\);/.test(R.text()), 'recorded: ' + JSON.stringify(R.text()));
  // a macro's own command is never recorded
  await t.runMacro('run("Invert");');
  assert.equal((R.text().match(/run\("Invert"\);/g) || []).length, 1);
  // Create: the Macro Editor takes the text (the editor held nothing)
  page(t)._internals.state().editorText = '';
  await R.create();
  assert.equal(page(t)._internals.state().editorText, R.text());
  assert.ok(t.shell.windows.floats.get('macroEditor'), 'the Macro Editor opens');
  R.close();
  assert.equal(t.shell.windows.floats.get('macroRecorder'), undefined);
  // closing drops the listeners: commands no longer reach the model
  const before = R.text();
  // the Macro Editor's Files section reads the workspace changes once at opening (a short busy state)
  await until(() => t.isEnabled('editInvert'), 'idle again');
  await t.runCommand('editInvert');
  assert.equal(R.text(), before);
});

// ═════════════════════════════ #@ parameters ═════════════════════════════
await test('#@: one dialog before the run, injected values, persisted, Cancel = no run, refusals before the run', async () => {
  const X = t.extras();
  page(t)._internals.reset();
  t.script.dialogs.push({ p0: 5, p1: 'b' });
  let r = await X.runMacroText('#@ Integer (min=1, max=10, value=3) n\n#@ String (choices={"a","b"}) s\nprint(n + s);', { name: 'Macro', identity: 'test.ijm' });
  assert.ok(r && r.ok, JSON.stringify(r && r.error));
  deq(t.macroLog(), ['5b']);
  const spec = t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
  assert.equal(spec.fields.find((f) => f.id === 'p0').value, 3);
  // the second run is pre-filled with the persisted values
  page(t)._internals.reset();
  t.script.dialogs.push({});
  r = await X.runMacroText('#@ Integer (min=1, max=10, value=3) n\n#@ String (choices={"a","b"}) s\nprint(n + s);', { name: 'Macro', identity: 'test.ijm' });
  deq(t.macroLog(), ['5b']);
  // Cancel: nothing runs
  page(t)._internals.reset();
  t.script.dialogs.push(null);
  r = await X.runMacroText('#@ Integer n\nprint("ran");', { name: 'Macro', identity: 'c.ijm' });
  assert.equal(r, null);
  deq(t.macroLog(), []);
  // an error on line 3 reports line 3 (the #@ lines keep their numbers)
  page(t)._internals.reset();
  t.script.dialogs.push({});
  r = await X.runMacroText('#@ Integer (value=1) n\n#@ Integer (value=2) m\nprint(n + undefinedVariable);', { name: 'Macro', identity: 'e.ijm' });
  assert.equal(r.error.line, 3);
  // a service: refused before the run, naming the parameter
  const n0 = t.log.dialogSpecs.length;
  r = await X.runMacroText('#@ UIService ui\nprint("ran");', { name: 'Macro', identity: 's.ijm' });
  assert.equal(r, null);
  const box = t.log.dialogSpecs.slice(n0).pop();
  assert.equal(box.title, EN('dlg.mac.params.title'));
  assert.ok(box.fields.some((f) => /ui/.test(f.label)), 'the refusal names ui');
});

await test('#@output: the Outputs window after the run', async () => {
  const X = t.extras();
  page(t)._internals.reset();
  const r = await X.runMacroText('#@output String greeting\ngreeting = "hi";', { name: 'Macro', identity: 'o.ijm' });
  assert.ok(r && r.ok, 'run: ' + JSON.stringify(r && { error: r.error, aborted: r.aborted, exited: r.exited }));
  await until(() => t.shell.windows.floats.get('macroOutputs'), 'Outputs window');
  // the value needs L5 of EXTRAS.md §3 (readVars) in the language: without it the row is there, empty
  deq(J(X.state().outputs), [{ name: 'greeting', value: HAS_L5 ? 'hi' : '' }]);
  return HAS_L5 ? undefined : 'skip';
});

// ═════════════════════════════ Install / Startup ═════════════════════════════
await test('Install: rows under Plugins › Macros, a key the frozen table holds is dropped with ImageJ\'s box, tools skipped, persisted, Remove', async () => {
  const X = t.extras();
  page(t)._internals.reset();
  const n0 = t.log.dialogSpecs.length;
  const set = await X.install('macro "Hello [h]" { print("hi"); }\nmacro "AutoRun" { print("auto"); }\nmacro "-" {}\nmacro "Hi [F9]" { print("f9"); }\n'
    + 'macro "Tool-1 Tool - C000T4b12A" {}\n', { fileName: 'set.ijm' });
  const rows = X.installed();
  deq(rows.map((r) => r.label), ['Hello [h]', 'Hi [F9]']);
  assert.equal(rows[0].shortcut, null, 'h is Histogram');
  assert.equal(rows[1].shortcut, 'F9');
  const row = t.shell.opts.commands.find((c) => c.id === rows[1].id);
  assert.ok(row && row.dynamic && row.menu.join('/') === 'Plugins/Macros');
  deq(row.shortcut, ['F9']);
  const box = t.log.dialogSpecs.slice(n0).find((s) => s.title === EN('dlg.mac.install.title'));
  assert.ok(box && box.fields.some((f) => f.label === EN('dlg.mac.install.keyInUse')), 'the "already in use" box');
  assert.ok(box.fields.some((f) => /Hello \[h\]/.test(f.label)));
  assert.ok(t.log.status.some((s) => s === EN('dlg.mac.install.toolsSkipped', { n: 1 })), 'tool notice');
  assert.equal(set.plan.autoRun !== null, true);
  const stored = await X.macroRecord('installed');
  assert.equal(stored.name, 'set.ijm'); assert.equal(stored.origin, 'editor');
  assert.equal(t.isEnabled('macRemoveInstalled'), true);
  deq(t.api('macro').macro.shortcutUse('h'), { taken: true, by: 'analyzeHistogram', reserved: false });
  assert.equal(t.api('macro').macro.shortcutUse('F5').reserved, true);
  if (HAS_L3) {
    await until(() => t.macroLog().includes('auto'), 'AutoRun');
    page(t)._internals.reset();
    await t.runInstalled('Hello [h]');
    deq(t.macroLog(), ['hi']);
    page(t)._internals.reset();
    const r = await t.runMacro('run("Hello [h]");');
    assert.ok(r.ok, JSON.stringify(r.error));
    deq(t.macroLog(), ['hi']);
  }
  await t.runCommand('macRemoveInstalled');
  deq(X.installed(), []);
  assert.equal(await X.macroRecord('installed'), null);
  assert.ok(!t.shell.opts.commands.some((c) => /^macInst[0-9]/.test(c.id)));
  return HAS_L3 ? undefined : 'skip';
});

await test('Install…: a file not ending .txt / .ijm gets ImageJ\'s box; a non-UTF-8 file is refused', async () => {
  const X = t.extras();
  const n0 = t.log.dialogSpecs.length;
  const f = { name: 'a.js', arrayBuffer: async () => new TextEncoder().encode('macro "x" {}').buffer };
  assert.equal(await X.installFromFile(f), null);
  const box = t.log.dialogSpecs.slice(n0).pop();
  assert.equal(box.fields[0].label, EN('err.macInstallExt'));
  assert.throws(() => X.decodeMacroBytes(new Uint8Array([0xff, 0xfe, 0x41])), (e) => e.code === 'IJ_MACRO_INSTALL');
  assert.equal(X.decodeMacroBytes(new TextEncoder().encode('a\r\nb\rc')), 'a\nb\nc\n');
});

await test('Startup: RunAtStartup then the startup set\'s AutoRun; a failing step shows the Macro Error window and the next steps run', async () => {
  if (!HAS_L3) return 'skip';
  const X = t.extras();
  page(t)._internals.reset();
  await t.startup({ startupMacros: 'macro "AutoRun" { print("A"); }\n', runAtStartup: 'print("R");' });
  deq(t.macroLog(), ['R', 'A']);
  page(t)._internals.reset();
  await t.startup({ startupMacros: 'macro "AutoRun" { print("A"); }\n', runAtStartup: 'print(undefinedThing);' });
  deq(t.macroLog(), ['A']);
  assert.ok(page(t)._internals.state().lastError, 'the Macro Error window has the error');
  await X.put('macros', { id: 'startup', source: '', at: 0 });
  await X.settingWrite('startup.code', '');
  return undefined;
});

await test('Edit › Options › Startup…: the code runs first and is kept only without an error; Add code appends at the end', async () => {
  const X = t.extras();
  page(t)._internals.reset();
  await X.settingWrite('startup.code', '');
  t.script.dialogs.push({ text1: 'print("S");' });
  await t.runCommand('optStartup');
  deq(t.macroLog(), ['S']);
  assert.equal(await X.settingRead('startup.code'), 'print("S");');
  page(t)._internals.reset();
  t.script.dialogs.push({ text1: 'print(nope);' });
  await t.runCommand('optStartup');
  assert.equal(await X.settingRead('startup.code'), 'print("S");', 'an error keeps the old code');
  // the dialog: message, text1, the Add code choice with the items that mean something in the Studio
  const spec = t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
  deq(spec.fields.map((f) => f.id), ['note', 'text1', 'add']);
  deq(spec.fields[2].options.map((o) => o.value), ['select', 'black', 'dir', 'overlay']);
  const sets = [];
  spec.onChange({ text1: 'a', add: 'black' }, (o) => sets.push(o), 'add');
  deq(sets, [{ text1: 'a\nsetOption("BlackBackground", true);\n', add: 'select' }]);
  await X.settingWrite('startup.code', '');
});

// ═════════════════════════════ Batch Process ═════════════════════════════
await test('Batch Process window: formats (no writer → disabled, with the reason), ImageJ\'s snippets, validation texts', async () => {
  const X = t.extras();
  await t.runCommand('batchMacro');
  const w = t.shell.windows.floats.get('batchProcess');
  assert.ok(w); assert.equal(w.spec.title, EN('dlg.mac.batch.title'));
  const panel = page(t)._internals.extras.state().panels.batch.values().next().value;
  const s = panel._state();
  const opts = s.formatEl.children.map((o) => [o.value, !!o.disabled]);
  deq(opts, [['TIFF', false], ['8-bit TIFF', false], ['JPEG', false], ['GIF', true], ['PNG', false], ['PGM', true], ['BMP', true], ['FITS', true],
    ['Text Image', false], ['ZIP', false], ['Raw', false]]);
  // ImageJ's items that run in the Studio: Label and Timestamp draw with drawString, which macros do not have here
  deq(s.addEl.children.map((o) => o.value), C.BATCH_SNIPPETS.filter((x) => x !== 'Label' && x !== 'Timestamp'));
  const box = async (v, key, params) => {
    const n0 = t.log.dialogSpecs.length;
    assert.equal(await X.batch(v, false), null);
    const b = t.log.dialogSpecs.slice(n0).pop();
    assert.equal(b.title, EN('dlg.mac.batch.errTitle'));
    assert.equal(b.fields.map((f) => f.label).join('\n'), EN(key, params).replace(/^\n|(?<=\n)$/g, '').split('\n').map((l) => (l === '' ? ' ' : l)).join('\n'));
  };
  await box({ input: '', output: '', format: 'TIFF', filter: '', code: 'x=1;' }, 'dlg.mac.batch.noInput');
  await box({ input: '/Nope/in', output: '', format: 'TIFF', filter: '', code: 'x=1;' }, 'dlg.mac.batch.badInput', { path: '/Nope/in/' });
  await box({ input: '/tmp/in/', output: '/Nope', format: 'TIFF', filter: '', code: 'x=1;' }, 'dlg.mac.batch.badOutput', { path: '/Nope/' });
  await box({ input: '/tmp/in/', output: '', format: 'TIFF', filter: '', code: '' }, 'dlg.mac.batch.noCode');
  w.close();
});

await test('Batch snippets run in the Studio on an 8-bit image (each through the macro runtime, no error)', async () => {
  const X = t.extras();
  for (const [name, code] of Object.entries(X.BATCH_SNIPPET_CODE)) {
    page(t)._internals.reset();
    const r = await t.runMacro('newImage("s", "8-bit ramp", 64, 48, 1);\ni=0;\n' + code + '\nclose("*");');
    assert.ok(r.ok, name + ': ' + JSON.stringify(r.error));
  }
});

// ═════════════════════════════ Process › Math › Macro ═════════════════════════════
await test('Process › Math › Macro…: the dialog, the op macroMath with the final code, the code stored for next time', async () => {
  // the op needs L4 of EXTRAS.md §3 (IJMacro.pixelProgram)
  if (!HAS_L3) return 'skip';
  const X = t.extras();
  const t3 = await fresh();
  await t3.runMacro('newImage("m", "8-bit ramp", 32, 16, 1);');
  const id = t3.activeId();
  const before = await t3.pixels(id);
  await t3.runCommand('mathMacro', { code: 'v*2' });
  const spec = t3.log.dialogSpecs[t3.log.dialogSpecs.length - 1];
  assert.equal(spec.title, EN('dlg.mac.math.title'));
  assert.equal(spec.fields[0].value, 'v=v+50*sin(d/10)', 'ImageMath\'s default code');
  const after = await t3.pixels(id);
  for (let i = 0; i < before.length; i++) assert.equal(after[i], Math.min(255, before[i] * 2), 'pixel ' + i);
  assert.equal(await t3.extras().settingRead('math.macro'), 'v=v*2');
  t3.close();
  void X;
});

// ═════════════════════════════ the build-level `recorded` sweep (EXTRAS.md §4.6, binding) ═════════════════════════════
// Every command of ij-dialogs.json whose (single) GenericDialog has `recorded` and that the Studio implements: the Studio's dialog, answered with
// ImageJ's defaults (the captured components mapped through the table), folds to ImageJ's recorded option string. The input is the capture's:
// an uncalibrated 8-bit image with a rectangle.
const NOT_RECORDED_ALIKE = {
  'Appearance...': 'the Studio dialog has only "Interpolate"; ImageJ\'s also records menu, gui and 16-bit',
  'Image...': 'File › New › Image makes one plane: no slices field (MACRO_COMMANDS note)',
  'Input/Output...': 'the Studio dialog has no JPEG / GIF quality nor "use_file" fields',
  'Misc...': 'the Studio dialog has only "Divide by zero"; ImageJ\'s also records "run" (Run single instance listener)',
  'Plots...': 'the Studio dialog has no width / height / font / draw_ticks fields',
  'Properties...': 'the Studio shows "Unit of length" always; ImageJ\'s dialog only in its legacy form, so it records no unit=',
  'Scale Bar...': 'Recorder.saveCommand strips Scale Bar\'s default options (Recorder.java:617-635): REC\'s line, not the dialog fold',
  'Size...': 'the Studio shows no Depth field for a single plane; ImageJ\'s Resizer records depth=1 anyway'
};
await test('recorded sweep: the Studio dialogs answered with ImageJ\'s defaults fold to ImageJ\'s recorded strings', async () => {
  const IJF = path.join(ROOT, 'tests', 'fixtures', 'ij-macro', 'ij-dialogs.json');
  if (!fs.existsSync(IJF)) { console.log('SKIP recorded sweep: ij-dialogs.json is absent'); return 'skip'; }
  const IJD = JSON.parse(fs.readFileSync(IJF, 'utf8'));
  const ts = await boot({ channels: 1, immediateMessages: true, firePreview: false });
  await ts.open();
  const PC = vm.runInContext('IJMacroCmds', ts.page), PO = vm.runInContext('IJMacroOptions', ts.page);
  const eapi = ts.api('edit');
  const W = 64, H = 48, px = new Uint8Array(W * H);
  for (let i = 0; i < px.length; i++) px[i] = (i * 7) % 251;
  const base = await eapi.addDoc({ name: 'capture', width: W, height: H, bitDepth: 8, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' }, channels: [{ name: 'C1', data: px }] }, { placement: 'tab' });
  const closeOthers = async () => { for (const d of await ts.docs()) if (d.docId !== base) { ts.script.nextAsk = 'discard'; try { await eapi.closeDoc(d.docId); } catch (_) { /* gone */ } ts.script.nextAsk = null; } };
  const optVal = (o) => (o && typeof o === 'object' ? o.value : o);
  const optLab = (o) => (o && typeof o === 'object' ? String(o.label !== undefined ? o.label : o.value) : String(o));
  let same = 0;
  const bad = [];
  for (const [name, cap] of Object.entries(IJD.commands)) {
    const dlgs = (cap.dialogs || []).filter((d) => d.kind === 'GenericDialog' || d.kind === 'NonBlockingGenericDialog');
    const d = dlgs[0];
    if (!d || typeof d.recorded !== 'string' || dlgs.length !== 1) continue;
    const r = PC.resolve(name);
    if (!r || !r.id || !r.entry || r.entry.file || r.entry.cls === 'E' || r.entry.cls === 'F') continue;
    const c = ts.cmd(r.id);
    if (!c) continue;
    await closeOthers();
    ts.shell.clickTab(base);
    eapi.setRoi({ type: 'rect', x: 5, y: 6, w: 20, h: 15 }, { docId: base });
    let enabled = false;
    try { enabled = !!c.enabled(ts.shell.opts.getState()); } catch (_) { enabled = false; }
    if (!enabled) continue;
    const specs = [];
    ts.script.dialogs.length = 0;
    for (let k = 0; k < 6; k++) ts.script.dialogs.push((spec) => { specs.push(spec); return null; });
    try { await Promise.race([ts.shell.opts.onCommand(c, { source: 'menu' }), sleep(8000)]); } catch (_) { /* the cancel */ }
    ts.script.dialogs.length = 0;
    ts.failures.length = 0;
    if (!specs.length) continue;
    const fields = (specs[0].fields || []).filter(Boolean);
    const de = PC.pickDialog(r.entry, 0, fields);
    const comps = (d.components || []).filter((x) => typeof x.key === 'string');
    const vals = {}, offeredFields = [];
    for (const f of fields) {
      if (f.type === 'message' || !de) { offeredFields.push(f); continue; }
      const key = Object.prototype.hasOwnProperty.call(de.keys, f.id) ? de.keys[f.id] : (f.id === 'all' ? 'stack' : null);
      const comp = key ? comps.find((x) => x.key === key) : null;
      let v = f.value;
      if (comp) {
        if (comp.t === 'numeric' || comp.t === 'slider') v = Number(comp.value);
        else if (comp.t === 'string' || comp.t === 'textarea') v = comp.value;
        else if (comp.t === 'checkbox') v = !!comp.state;
        else if (comp.t === 'choice' || comp.t === 'radio') {
          const map = de.items && de.items[f.id];
          if (map && Object.prototype.hasOwnProperty.call(map, comp.selected) && map[comp.selected] !== null) v = map[comp.selected];
          else { const o = (f.options || []).find((x) => optLab(x) === comp.selected || String(optVal(x)) === comp.selected); if (o) v = optVal(o); }
        }
      }
      vals[f.id] = v;
      offeredFields.push(Object.assign({}, f, { value: v }));
    }
    const got = de ? PO.foldTokens(PO.recordTokens(vals, de, { fields: offeredFields })) : '(no DialogEntry)';
    if (got === d.recorded) { same++; assert.ok(!NOT_RECORDED_ALIKE[name], name + ' now folds like ImageJ: drop it from the exception list'); }
    else if (!NOT_RECORDED_ALIKE[name]) bad.push(name + ': Studio ' + JSON.stringify(got) + ' vs ImageJ ' + JSON.stringify(d.recorded));
  }
  ts.close();
  assert.deepEqual(bad, [], bad.join('\n'));
  assert.ok(same >= 50, 'commands folded like ImageJ: ' + same);
  console.log('    recorded sweep: ' + same + ' commands fold to ImageJ\'s string, ' + Object.keys(NOT_RECORDED_ALIKE).length + ' listed with their reason');
});

// ═════════════════════════════ lang §13 ═════════════════════════════
await test('lang keys of EXTRAS.md §13 in the four languages, same keys, same {tokens}', () => {
  const keys = ['menu.Batch', 'cmd.macInstall', 'cmd.macStartup', 'cmd.macRecord', 'cmd.macRemoveInstalled', 'cmd.optStartup', 'cmd.batchMacro', 'cmd.mathMacro', 'op.macBatch', 'op.mathMacro',
    ...['title', 'record', 'modeMacro', 'name', 'create', 'run', 'help', 'helpText', 'createEmpty', 'runHint', 'replaceEditor', 'replace'].map((k) => 'dlg.mac.rec.' + k),
    ...['title', 'keyInUse', 'keysInUse', 'keysReserved', 'toolsSkipped', 'popupSkipped', 'installed', 'installedOne'].map((k) => 'dlg.mac.install.' + k),
    'dlg.mac.editor.install', ...['title', 'note', 'save', 'revert'].map((k) => 'dlg.mac.startup.' + k),
    ...['title', 'note', 'add', 'itemSelect', 'itemBlack', 'itemDir', 'itemOverlay'].map((k) => 'dlg.mac.startupCode.' + k),
    ...['title', 'input', 'output', 'format', 'addCode', 'filter', 'test', 'open', 'save', 'process', 'formatNo', 'errTitle', 'noInput', 'badInput', 'badOutput', 'noCode', 'tooLarge', 'progress',
      'snippetSelect', 'snippetAddBorder', 'snippetToRgb', 'snippetCrop', 'snippetGaussian', 'snippetInvert', 'snippetLabel', 'snippetTimestamp', 'snippetMaxDim', 'snippetMeasure',
      'snippetPrintIndex', 'snippetResize', 'snippetScale', 'snippetFileInfo', 'snippetUnsharp'].map((k) => 'dlg.mac.batch.' + k),
    'dlg.mac.math.title', 'dlg.mac.math.code', 'dlg.mac.math.help', 'dlg.mac.params.title', 'dlg.mac.outputs.title', 'dlg.mac.outputs.name', 'dlg.mac.outputs.value',
    ...['macInstallExt', 'macMathHost', 'macMathFailed', 'macParamService', 'macParamType', 'macParamPassword', 'macParamNoImage', 'macParamSyntax', 'macReasonStartup', 'macReasonRecorder',
      'macReasonInstalled', 'macInstallFailed'].map((k) => 'err.' + k), 'warn.macNotStored'];
  const tokens = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');
  for (const k of keys) {
    for (const c of LANGS) assert.equal(typeof lookup(LANG[c], k), 'string', c + ': ' + k);
    for (const c of LANGS) assert.equal(tokens(lookup(LANG[c], k)), tokens(lookup(LANG.en, k)), c + ': tokens of ' + k);
  }
  const binding = { 'dlg.mac.rec.title': 'Recorder', 'err.macInstallExt': 'File name must end with ".txt" or ".ijm" .', 'dlg.mac.batch.progress': '{n}/{total}: {name}',
    'dlg.mac.math.title': 'Expression Evaluator', 'dlg.mac.batch.errTitle': 'Batch Processor', 'dlg.mac.batch.noCode': 'There is no macro code in the text area',
    'dlg.mac.batch.badInput': 'Input does not exist or is not a folder\n \n{path}', 'cmd.batchMacro': 'Macro...', 'menu.Batch': 'Batch' };
  for (const [k, v] of Object.entries(binding)) assert.equal(lookup(LANG.en, k), v, k);
});

t.close();
void ROOT; void sleep;
console.log('test_ij_macro_extras_page: ' + passed + ' passed' + (skipped.length ? ', SKIP ' + skipped.length + ' (EXTRAS.md §3 L3-L5 not in ij-macro-lang.js yet: ' + skipped.join('; ') + ')' : ''));
process.exit(0);
