// Page side of the Advanced Studio macros (ij-cmds-macro.js, INTEGRATION.md §7, §9.1): the registration (menus, panels, errors), the
// Macro Editor (keys, persistence, error line, Run selection), the Macro Error window, Plugins › Macros › Run…, the macro preferences
// merge (CALL-WHITELIST §6) and the lang keys of §9.1 in the four languages.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadMacroPage, lang, LANGS, lookup, tr, sleep, until, byClass, buttonByText, DIR } from './ij_macro_page_fakes.mjs';

if (!fs.existsSync(path.join(DIR, 'ij-cmds-macro.js'))) { console.log('SKIP ij-cmds-macro.js is absent'); process.exit(0); }

const J = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const deq = (a, b, m) => (m === undefined ? assert.deepEqual(J(a), J(b)) : assert.deepEqual(J(a), J(b), m));
const done = (o) => Object.assign({ ok: true, aborted: false, exited: false, error: null, prefsWrites: {}, changedDocs: [], undo: { changed: [], dropped: [] } }, o || {});

// ── registration ──
{
  const t = loadMacroPage();
  const s = t.spec;
  assert.equal(s.pkg, 'macro');
  const byId = Object.fromEntries(s.commands.map((c) => [c.id, c]));
  // + the commands of the macro extras (EXTRAS.md §4.3), checked by test_ij_macro_extras_page.mjs
  deq(Object.keys(byId).sort(), ['batchMacro', 'macEdit', 'macInstall', 'macRecord', 'macRemoveInstalled', 'macRun', 'macStartup', 'mathMacro', 'optStartup', 'windowLog']);
  deq(byId.macRun.menu, ['Plugins', 'Macros']); assert.equal(byId.macRun.order, 20);
  deq(byId.macEdit.menu, ['Plugins', 'Macros']); assert.equal(byId.macEdit.order, 30);
  deq(byId.windowLog.menu, ['Window']); assert.equal(byId.windowLog.order, 52);
  for (const c of s.commands.filter((x) => ['macEdit', 'macRun', 'windowLog'].includes(x.id))) {
    assert.equal(c.enabled({ busy: false, doc: null }), true, c.id + ' is enabled without an image');
    assert.equal(c.labelKey, undefined, c.id + ' uses its cmd.<id> label');
    assert.equal(c.shortcut, undefined, c.id + ': Ctrl+R is the browser reload, no shortcut (PLAN D12)');
  }
  deq(Object.keys(s.panels).sort(), ['batchProcess', 'macroEditor', 'macroError', 'macroLog', 'macroOutputs', 'macroRecorder', 'macroStartup', 'macroText']);
  const titles = { macroEditor: 'dlg.mac.editorTitle', macroLog: 'dlg.mac.logTitle', macroError: 'dlg.mac.errorTitle', macroText: 'dlg.mac.textTitle' };
  for (const id of Object.keys(titles)) { assert.equal(s.panels[id].titleKey, titles[id]); assert.equal(s.panels[id].persist, true, id + ' persists'); }
  deq(s.errors, { IJ_MACRO_BUSY: 'err.macBusy', IJ_MACRO_STEP_BUSY: 'err.macStepBusy', IJ_MACRO_GROUP: 'err.macUndoDuringRun',
    IJ_MACRO_VFS_QUOTA: 'err.macZipQuota', IJ_MACRO_VFS_BUSY: 'err.macWorkspaceBusy', IJ_MACRO_VFS_NO_STORAGE: 'err.macNoStorageUi', IJ_MACRO_FILE_DIRECT: 'err.macFileDirect',
    IJ_MACRO_MATH: 'err.macMathFailed', IJ_MACRO_INSTALL: 'err.macInstallFailed' });
  assert.equal(typeof t.page.run, 'function'); assert.equal(typeof t.page.abort, 'function'); assert.equal(typeof t.page.logLines, 'function');
}

// the file stays inert when package macro is not one of the worker's packages (an older ij-app.js)
{
  const t = loadMacroPage({ packageNames: ['bg', 'stk'] });
  assert.equal(t.page, undefined);
  assert.equal(t.spec, null);
}

// ── lang keys of §9.1: all four languages, same keys, same {tokens} ──
{
  const KEYS = ['menu.Macros', 'cmd.macRun', 'cmd.macEdit', 'cmd.windowLog', 'op.macRun',
    ...['editorTitle', 'logTitle', 'errorTitle', 'textTitle', 'runTitle', 'runPrompt', 'run', 'runSelection', 'abort', 'clear', 'copy', 'showLine', 'running',
      'finished', 'aborted', 'line', 'linesDropped', 'empty', 'notPersisted', 'invalidValue', 'leaveTitle', 'leaveMessage', 'leaveStop'].map((k) => 'dlg.mac.' + k),
    ...['macBusy', 'macUndoDuringRun', 'macNetwork', 'macBioFormats', 'macExec', 'macEvalScript', 'macExtensions', 'macDebug', 'macCallRefused',
      'macPadLimit', 'macPrefsQuota', 'mac16bitRange', 'macPageTimeout', 'macRefused', 'macReasonLibrary', 'macReasonHost', 'macReasonRecover', 'macReasonUndo',
      'macDisabled', 'macNotInBrowser', 'macArrow', 'macClipboard'].map((k) => 'err.' + k),
    'warn.macUndoDropped'];
  // the binding English texts of §9.1
  const EN = {
    'menu.Macros': 'Macros', 'cmd.macRun': 'Run...', 'cmd.macEdit': 'Edit...', 'cmd.windowLog': 'Log', 'op.macRun': 'Running macro',
    'dlg.mac.line': 'Line {n}', 'dlg.mac.linesDropped': '… {n} lines dropped', 'dlg.mac.invalidValue': '{title}: {message} ({key})',
    'err.macBusy': 'A macro is already running.', 'err.macNetwork': 'Macros cannot use the network.', 'err.macExec': 'exec() is not available in the browser.',
    'err.macPageTimeout': 'The page did not answer ({method}).', 'err.macRefused': '{command} is not available to macros: {reason}',
    'err.macCallRefused': 'call() is not available in the browser for "{target}".\nOnly a few ImageJ calls are emulated: ij.Prefs.get/set, ij.IJ.freeMemory/currentMemory/maxMemory/pad, RoiManager.getName, ThresholdAdjuster.setMode, ImageWindow.setNextLocation, ImagePlus.setDefault16bitRange.',
    'warn.macUndoDropped': 'Undo is not available for the macro\'s changes to {title}: not enough memory.'
  };
  const tokens = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');
  for (const k of KEYS) {
    for (const code of LANGS) assert.equal(typeof lookup(lang[code], k), 'string', code + ': ' + k);
    for (const code of LANGS) assert.equal(tokens(lookup(lang[code], k)), tokens(lookup(lang.en, k)), code + ': tokens of ' + k);
  }
  for (const k of Object.keys(EN)) assert.equal(lookup(lang.en, k), EN[k], 'binding English text of ' + k);
  // retired by FILES.md §12.3
  for (const code of LANGS) assert.equal(lookup(lang[code], 'err.macFileLater'), undefined, code + ': err.macFileLater is retired');
  const macKeys = (code) => Object.keys(lang[code].dlg.mac).sort().join(',');
  for (const code of LANGS) assert.equal(macKeys(code), macKeys('en'), code + ': dlg.mac has the same keys');
  // every lang key literal of the page file exists in the four languages
  const src = fs.readFileSync(path.join(DIR, 'ij-cmds-macro.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const used = new Set();
  for (const m of src.matchAll(/'((?:cmd|op|menu|err|warn|dlg)\.[A-Za-z0-9_.]*[A-Za-z0-9_])'/g)) used.add(m[1]);
  assert.ok(used.size > 20, 'literal keys found');
  for (const k of used) for (const code of LANGS) assert.equal(typeof lookup(lang[code], k), 'string', code + ': key ' + k + ' read by ij-cmds-macro.js');
  // CSS: only .ij-mac-* rules were added for the macro windows, and the classes the file uses are styled
  const css = fs.readFileSync(path.join(DIR, 'ij-style.css'), 'utf8');
  for (const m of src.matchAll(/ij-mac-[a-z-]+/g)) assert.ok(css.includes('.' + m[0]), 'ij-style.css styles .' + m[0]);
  // security rules of §8 in this file
  const code = src.split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
  for (const bad of [/\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/, /EventSource/, /importScripts/, /new\s+Worker/, /window\.open/, /\blocation\b/, /E\.fetch/, /\beval\s*\(/, /new\s+Function/, /WebAssembly/, /innerHTML/, /ctx\.studio/, /library/i]) {
    assert.ok(!bad.test(code), 'ij-cmds-macro.js must not contain ' + bad);
  }
  assert.ok(!/\.(textContent|innerText)\s*=\s*[^;]*\.message/.test(code), 'err.message never goes to the DOM');
}

// ── pure helpers ──
{
  const t = loadMacroPage();
  const P = t.page._internals;
  deq(P.lineRange('a\nbc\n\nd', 2), { start: 2, end: 4 });
  deq(P.lineRange('a\nbc\n\nd', 3), { start: 5, end: 5 });
  deq(P.lineRange('a\nbc\n\nd', 4), { start: 6, end: 7 });
  assert.equal(P.lineRange('a', 2), null);
  assert.equal(P.lineOfOffset('a\nbc\nd', 0), 1);
  assert.equal(P.lineOfOffset('a\nbc\nd', 3), 2);
  assert.equal(P.lineOfOffset('a\nbc\nd', 5), 3);
  // Run selection: the selection; nothing selected = the caret's line
  deq({ ...P.runSlice('x=1;\ny=2;\nprint(y);', 5, 19) }, { source: 'y=2;\nprint(y);', lineOffset: 1 });
  deq({ ...P.runSlice('x=1;\ny=2;\nprint(y);', 7, 7) }, { source: 'y=2;', lineOffset: 1 });
  deq({ ...P.runSlice('x=1;\ny=2;', 19, 5) }, { source: 'y=2;', lineOffset: 1 });
  // the editor keys (PLAN D12)
  assert.equal(P.editorAction({ key: 'Enter', ctrlKey: true }), 'run');
  assert.equal(P.editorAction({ key: 'Enter', metaKey: true }), 'run');
  assert.equal(P.editorAction({ key: 'Enter', ctrlKey: true, shiftKey: true }), 'runSelection');
  assert.equal(P.editorAction({ key: 'Escape' }), 'abort');
  assert.equal(P.editorAction({ key: 'Enter' }), null);
  assert.equal(P.editorAction({ key: 'r', ctrlKey: true }), null, 'Ctrl+R stays the browser reload');
  assert.equal(P.editorAction({ key: 'Enter', ctrlKey: true, altKey: true }), null);
  // persistence limit: 60 000 characters and a JSON the settings accept
  assert.equal(P.persistable('x'.repeat(60000)), true);
  assert.equal(P.persistable('x'.repeat(60001)), false);
  assert.equal(P.persistable('\n'.repeat(40000)), false, 'escaped JSON over 64 KiB');
  // the Macro Error text: ImageJ's verbatim, an internal failure translated
  const d1 = P.errorDisplay({ message: 'Undefined variable', line: 3, dialogText: 'Undefined variable in line 3\n \nprint ( <x> ) ;', silent: false }, tr);
  assert.equal(d1.text, 'Undefined variable in line 3\n \nprint ( <x> ) ;');
  assert.equal(d1.line, 3);
  const d2 = P.errorDisplay({ message: 'Internal error: Cannot read properties of undefined (reading \'secret\')', line: 2, dialogText: null }, tr);
  assert.ok(!/secret|Cannot read/.test(d2.text), 'a JS exception text never reaches the window');
  assert.equal(d2.text, tr('err.unknown') + '\n' + tr('dlg.mac.line', { n: 2 }));
  // prefs: only { v: 1, prefs } with string values is read; a merge adds this run's keys
  deq({ ...P.parsePrefs(JSON.stringify({ v: 1, prefs: { a: '1', b: 2 } })) }, { a: '1' });
  deq({ ...P.parsePrefs('{bad') }, {});
  deq({ ...P.parsePrefs(JSON.stringify({ v: 2, prefs: { a: '1' } })) }, {});
  deq({ ...P.mergePrefs({ a: '1', c: 'x' }, { a: '2', b: '' }) }, { a: '2', c: 'x', b: '' });
  // a multi-line message becomes one row per line (ij-view writes a message row with textContent)
  const mf = P.messageFields('a\n\nb', 'm');
  deq(mf.map((f) => f.label), ['a', ' ', 'b']);
  assert.equal(new Set(mf.map((f) => f.id)).size, 3);
  assert.equal(P.fnvHex(new Uint8Array([1, 2, 3])), P.fnvHex([1, 2, 3]));
}

// ── the Macro Editor ──
{
  const t = loadMacroPage({ settings: { 'mac.editorText': 'print("saved");' } });
  await t.api.openPanel('macroEditor', { focus: true });
  const w = t.panel('macroEditor');
  const st = w.inst._state();
  assert.equal(st.ta.value, 'print("saved");', 'the editor starts from mac.editorText');
  assert.ok(st.ta.focused > 0, 'the text has the focus');
  assert.equal(st.ta.getAttribute('aria-label'), tr('dlg.mac.editorTitle'));
  assert.equal(st.abortBtn.disabled, true, 'Abort is disabled while nothing runs');
  assert.equal(byClass(w.el, 'ij-mac-gutter-line').length, 1);

  // typing: kept in the setting after a short delay; the gutter follows the lines
  st.ta.value = 'x = 1;\ny = ;\nprint(x);';
  st.ta.dispatch('input');
  assert.equal(byClass(w.el, 'ij-mac-gutter-line').length, 3);
  await until(() => t.settings.get('mac.editorText') === 'x = 1;\ny = ;\nprint(x);', 'persisted');

  // Ctrl+Enter runs the whole text
  const ev = st.ta.dispatch('keydown', { key: 'Enter', ctrlKey: true });
  assert.ok(ev.defaultPrevented && ev.propagationStopped, 'Ctrl+Enter is the editor\'s key');
  await until(() => t.lane, 'run started');
  const a1 = t.startArgs();
  assert.equal(a1.source, 'x = 1;\ny = ;\nprint(x);');
  assert.equal(a1.name, 'Macro');
  deq({ ...a1.options }, { fastPath: true, syncLoops: false, syncRecursion: false });
  assert.ok(/^r\d+$/.test(a1.runId));
  deq(Object.keys(a1.texts).sort(), ['err.macCallRefused', 'err.macExec', 'err.macPageTimeout'], 'texts = IJMacroProto.TEXT_KEYS');
  assert.equal(a1.texts['err.macExec'], tr('err.macExec'));
  assert.equal(st.runBtn.disabled, true); assert.equal(st.abortBtn.disabled, false);
  assert.equal(st.status.textContent, tr('dlg.mac.running'));
  // a second run while one runs: refused with the sentence, nothing started
  st.ta.dispatch('keydown', { key: 'Enter', ctrlKey: true });
  deq(t.log.toasts.pop(), ['err.macBusy', undefined]);
  assert.equal(t.log.calls.filter((c) => c[0] === 'macro.start').length, 1);
  // Escape aborts
  const esc = st.ta.dispatch('keydown', { key: 'Escape' });
  assert.ok(esc.defaultPrevented, 'Escape is taken while a macro runs');
  assert.ok(t.log.calls.some((c) => c[0] === 'macro.abort'));
  // the run ends on an error at line 2: Macro Error window, the line marked in the editor
  t.finish(done({ ok: false, error: { message: 'Number or numeric function expected', line: 2, lineText: 'y = <;>', excerpt: 'y = <;>', calledFrom: [], silent: false,
    dialogText: 'Number or numeric function expected in line 2\n \ny = <;>' } }));
  await until(() => t.panel('macroError'), 'Macro Error window opened');
  const ew = t.panel('macroError').inst._state();
  assert.equal(ew.pre.textContent, 'Number or numeric function expected in line 2\n \ny = <;>', 'ImageJ\'s text verbatim');
  assert.equal(ew.line.textContent, tr('dlg.mac.line', { n: 2 }));
  assert.equal(ew.show.hidden, false);
  const marked = byClass(w.el, 'ij-mac-err');
  assert.equal(marked.length, 1); assert.equal(marked[0].textContent, '2');
  assert.equal(st.status.textContent, tr('dlg.mac.line', { n: 2 }) + ': Number or numeric function expected');
  assert.ok(String(st.status.className).includes('ij-mac-status-err'));
  assert.equal(st.runBtn.disabled, false);
  // Show in editor: the editor gets the focus with line 2 selected
  st.ta.lastSelection = null;
  ew.show.click();
  await until(() => st.ta.lastSelection, 'line selected');
  deq(st.ta.lastSelection, [7, 12]);
  // listeners of the run are gone
  assert.equal(t.listenerCount('ext:macro.rpc'), 0); assert.equal(t.listenerCount('ext:macro.log'), 0);

  // Ctrl+Shift+Enter runs the selection; an error line is counted from the editor's first line
  st.ta.selectionStart = 7; st.ta.selectionEnd = 23;
  st.ta.dispatch('keydown', { key: 'Enter', ctrlKey: true, shiftKey: true });
  await until(() => t.lane, 'selection run');
  assert.equal(t.startArgs().source, 'y = ;\nprint(x);');
  t.finish(done({ ok: false, error: { message: 'Undefined variable', line: 2, dialogText: 'Undefined variable in line 2\n \nprint ( <x> ) ;', silent: false } }));
  await sleep(10);
  assert.equal(t.ctx.IJMacroPage._internals.state().lastError.editorLine, 3, 'snippet line 2 = editor line 3');
  assert.equal(byClass(w.el, 'ij-mac-err')[0].textContent, '3');

  // a run that ends normally / aborted
  st.runBtn.click();
  await until(() => t.lane, 'button run');
  assert.equal(byClass(w.el, 'ij-mac-err').length, 0, 'a new run from the editor clears the mark');
  t.finish(done());
  await until(() => st.status.textContent === tr('dlg.mac.finished'), 'finished');
  st.runBtn.click();
  await until(() => t.lane, 'button run 2');
  st.abortBtn.click();
  t.finish(done({ ok: false, aborted: true }));
  await until(() => st.status.textContent === tr('dlg.mac.aborted'), 'aborted');
  // a silent error (ImageJ shows no window) opens nothing
  t.api.closePanel('macroError');
  st.runBtn.click();
  await until(() => t.lane, 'button run 3');
  t.finish(done({ ok: false, error: { message: 'x', line: 9, dialogText: null, silent: true } }));
  await sleep(20);
  assert.equal(t.panel('macroError'), null, 'no window for a silent error');

  // an empty editor runs nothing
  st.ta.value = '   \n';
  st.ta.dispatch('input');
  st.ta.dispatch('keydown', { key: 'Enter', ctrlKey: true });
  deq(t.log.toasts.pop(), ['dlg.mac.empty', undefined]);
  assert.equal(t.lane, null);

  // a text too long for the setting: the notice shows, the old text is not left behind
  st.ta.value = 'x'.repeat(60001);
  st.ta.dispatch('input');
  await until(() => st.note.hidden === false, 'notPersisted shown');
  assert.equal(t.settings.get('mac.editorText'), '');
  st.ta.value = 'print(1);';
  st.ta.dispatch('input');
  await until(() => st.note.hidden === true && t.settings.get('mac.editorText') === 'print(1);', 'kept again');
  // Escape with nothing running is left to the window (not taken)
  const esc2 = st.ta.dispatch('keydown', { key: 'Escape' });
  assert.equal(esc2.defaultPrevented, false);
  // closing the editor flushes a pending write
  st.ta.value = 'print(2);';
  st.ta.dispatch('input');
  t.api.closePanel('macroEditor');
  assert.equal(t.settings.get('mac.editorText'), 'print(2);');
}

// ── Plugins › Macros › Run… / Edit…, Window › Log ──
{
  const answers = [];
  const t = loadMacroPage({ settings: { 'mac.editorText': 'print("ed");' }, dialog: (spec) => answers.shift()(spec) });
  const cmd = (id) => t.spec.commands.find((c) => c.id === id);
  answers.push((spec) => {
    assert.equal(spec.title, tr('dlg.mac.runTitle'));
    assert.equal(spec.okLabel, tr('dlg.mac.run'));
    assert.equal(spec.fields.length, 1);
    assert.equal(spec.fields[0].type, 'textarea'); assert.equal(spec.fields[0].labelKey, 'dlg.mac.runPrompt'); assert.equal(spec.fields[0].value, 'print("ed");');
    return { code: 'print(41+1);' };
  });
  const p = cmd('macRun').run(t.api, { source: 'menu' });
  await until(() => t.lane, 'Run… started a run');
  assert.equal(t.startArgs().source, 'print(41+1);');
  t.finish(done({ ok: false, error: { message: 'E', line: 1, dialogText: 'E in line 1\n \n<print>', silent: false } }));
  await p;
  assert.equal(t.ctx.IJMacroPage._internals.state().lastError.editorLine, null, 'a text other than the editor\'s: no line to show in the editor');
  await until(() => t.panel('macroError'), 'error window');
  assert.equal(t.panel('macroError').inst._state().show.hidden, true);
  // the same text as the editor: the line is the editor's
  answers.push((spec) => ({ code: spec.fields[0].value }));
  const p2 = cmd('macRun').run(t.api, { source: 'menu' });
  await until(() => t.lane, 'run 2');
  t.finish(done({ ok: false, error: { message: 'E', line: 1, dialogText: 'E in line 1', silent: false } }));
  await p2;
  assert.equal(t.ctx.IJMacroPage._internals.state().lastError.editorLine, 1);
  // cancelled / empty
  answers.push(() => null);
  await cmd('macRun').run(t.api, {});
  answers.push(() => ({ code: '  ' }));
  await cmd('macRun').run(t.api, {});
  deq(t.log.toasts.pop(), ['dlg.mac.empty', undefined]);
  assert.equal(t.log.calls.filter((c) => c[0] === 'macro.start').length, 2);
  // a run refused because one is running: the rejection reaches the app (which reports err.macBusy)
  answers.push(() => ({ code: 'a=1;' }));
  const p3 = cmd('macRun').run(t.api, {});
  await until(() => t.lane, 'run 3');
  answers.push(() => ({ code: 'b=1;' }));
  await assert.rejects(cmd('macRun').run(t.api, {}), (e) => e.code === 'IJ_MACRO_BUSY');
  t.finish(done());
  await p3;
  // Edit… and Log open their panels
  await cmd('macEdit').run(t.api, {});
  assert.ok(t.panel('macroEditor'));
  await cmd('windowLog').run(t.api, {});
  assert.ok(t.panel('macroLog'));
}

// ── IJMacroPage.run (tests and the lead), undo-dropped warning, package missing ──
{
  const t = loadMacroPage();
  const p = t.page.run('print(1);', { name: 'Test', arg: 'x y' });
  await until(() => t.lane, 'run');
  const a = t.startArgs();
  assert.equal(a.name, 'Test'); assert.equal(a.arg, 'x y'); deq(Array.from(a.log), []);
  t.finish(done({ undo: { changed: [1, 2], dropped: [2, 7] } }));
  const r = await p;
  assert.equal(r.ok, true);
  deq(t.log.toasts.map((x) => [x[0], x[1].title]), [['warn.macUndoDropped', 'b'], ['warn.macUndoDropped', '7']]);
  // a crash rejects the run; the listeners go, nothing is left running
  const p2 = t.page.run('while(true){}');
  await until(() => t.lane, 'run 2');
  t.finish(null, Object.assign(new Error('crash'), { code: 'IJ_WORKER_CRASHED' }));
  await assert.rejects(p2, (e) => e.code === 'IJ_WORKER_CRASHED');
  assert.equal(t.listenerCount('ext:macro.rpc'), 0);
  // abort() without a run is a no-op
  t.page.abort();
  assert.ok(!t.log.calls.some((c) => c[0] === 'macro.abort'));

  const t2 = loadMacroPage({ noMacro: true });
  await assert.rejects(t2.page.run('print(1);'), (e) => e.code === 'IJ_MODULE_MISSING');
}

// ── macro preferences (CALL-WHITELIST §6) ──
{
  const store = new Map([['lumen3d.studio.macroPrefs', JSON.stringify({ v: 1, prefs: { 'my.a': '1', 'my.b': '2' } })]]);
  const t = loadMacroPage({ localStore: store });
  const p = t.page.run('call("ij.Prefs.set", "my.b", "3");');
  await until(() => t.lane, 'run');
  deq({ ...t.startArgs().prefs }, { 'my.a': '1', 'my.b': '2' }, 'the snapshot goes to the worker');
  // another tab writes a key meanwhile: it is kept
  store.set('lumen3d.studio.macroPrefs', JSON.stringify({ v: 1, prefs: { 'my.a': '1', 'my.b': '2', 'other.c': 'x' } }));
  t.finish(done({ prefsWrites: { 'my.b': '3', 'my.d': '' } }));
  await p;
  deq(JSON.parse(store.get('lumen3d.studio.macroPrefs')), { v: 1, prefs: { 'my.a': '1', 'my.b': '3', 'other.c': 'x', 'my.d': '' } });
  // an abort or an error merges the run's keys the same way
  const p2 = t.page.run('x');
  await until(() => t.lane, 'run 2');
  t.finish(done({ ok: false, aborted: true, prefsWrites: { 'my.e': 'E' } }));
  await p2;
  assert.equal(JSON.parse(store.get('lumen3d.studio.macroPrefs')).prefs['my.e'], 'E');
  // an invalid entry = empty map
  store.set('lumen3d.studio.macroPrefs', '{nope');
  const p3 = t.page.run('x');
  await until(() => t.lane, 'run 3');
  deq({ ...t.startArgs().prefs }, {});
  t.finish(done());
  await p3;
}
{
  // a blocked store: an in-memory map for the page session, never a throw
  const errs = [];
  const quiet = Object.assign(Object.create(console), { error: (...a) => errs.push(a) });
  const t = loadMacroPage({ storageBlocked: true, console: quiet });
  const p = t.page.run('x');
  await until(() => t.lane, 'run');
  deq({ ...t.startArgs().prefs }, {});
  t.finish(done({ prefsWrites: { 'k.a': 'v' } }));
  await p;
  const p2 = t.page.run('y');
  await until(() => t.lane, 'run 2');
  deq({ ...t.startArgs().prefs }, { 'k.a': 'v' }, 'kept in memory');
  t.finish(done());
  await p2;
}

// ── internal interpreter failure: logged, the window shows the platform sentence ──
{
  const errs = [];
  const quiet = Object.assign(Object.create(console), { error: (...a) => errs.push(a.map(String).join(' ')) });
  const t = loadMacroPage({ console: quiet });
  const p = t.page.run('x');
  await until(() => t.lane, 'run');
  t.finish(done({ ok: false, error: { message: 'Internal error: boom at secret.js:1', line: 4, dialogText: null, silent: false } }));
  await p;
  await until(() => t.panel('macroError'), 'window');
  const txt = t.panel('macroError').inst._state().pre.textContent;
  assert.ok(!txt.includes('boom'), 'no technical text in the window');
  assert.ok(txt.startsWith(tr('err.unknown')));
  assert.ok(errs.some((e) => e.includes('boom')), 'the technical text is logged');
}

// ── the Macro Error / text windows reopened after a reload with nothing to show close again ──
{
  const t = loadMacroPage();
  await t.api.openPanel('macroError');
  await t.api.openPanel('macroText');
  await sleep(10);
  assert.equal(t.panel('macroError'), null);
  assert.equal(t.panel('macroText'), null);
}

console.log('test_ij_macro_page: ok');
