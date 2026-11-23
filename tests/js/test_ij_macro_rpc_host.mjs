// The RPC host of the macro page (ij-cmds-macro.js, INTEGRATION.md §3.2, §4.1, §4.2): every RPC method and every write op has exactly
// one handler, each handler does what the contract says against a fake worker side (ext:macro.rpc events in, macro.reply out), writes
// are applied in order before the method, requests are served one at a time, nothing is answered once the lane is gone, and a failure
// never sends the exception's text. When ij-proc-macro.js (RUNTIME) is on disk its IJMacroProto lists must equal the page's; when the
// harness boots package macro for real, one request round trip runs through the real app too.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadMacroPage, tr, sleep, until, DIR } from './ij_macro_page_fakes.mjs';

if (!fs.existsSync(path.join(DIR, 'ij-cmds-macro.js'))) { console.log('SKIP ij-cmds-macro.js is absent'); process.exit(0); }

const J = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const deq = (a, b, m) => (m === undefined ? assert.deepEqual(J(a), J(b)) : assert.deepEqual(J(a), J(b), m));
const done = (o) => Object.assign({ ok: true, aborted: false, exited: false, error: null, prefsWrites: {}, changedDocs: [], undo: { changed: [], dropped: [] } }, o || {});
const CONTRACT_RPC = ['run', 'dialog.show', 'dialog.message', 'dialog.messageCancel', 'dialog.waitForUser', 'dialog.number', 'dialog.string', 'dialog.boolean',
  'error.show', 'image.select', 'image.close', 'image.show', 'image.adopt', 'window.select', 'window.close', 'clipboard.copy', 'flush', 'image.rename',
  'window.print', 'command.list',
  // FILES.md §5.4
  'vfs.pick', 'vfs.confirm', 'vfs.regrant', 'text.open', 'window.text',
  // EXTRAS.md §10.2
  'batch.prefs', 'install.set'];
const FILES_RPC = ['vfs.pick', 'vfs.confirm', 'vfs.regrant', 'text.open', 'window.text'];
const CONTRACT_WRITES = ['roi.set', 'display.set', 'display.lut', 'display.mode', 'display.visible', 'thr.set', 'thr.reset', 'thr.mode', 'table.replace',
  'table.remove', 'table.rename', 'table.show', 'rm.set', 'rm.select', 'rm.show', 'setting.set', 'measurements.set', 'colors.set', 'tool.set', 'status.show',
  'progress.show',
  // EXTRAS.md §10.3
  'batch.save'];

// ── one handler per method / op, the closed lists of the contract ──
{
  const t = loadMacroPage();
  const P = t.page._internals;
  deq(Object.keys(P.RPC).sort(), CONTRACT_RPC.slice().sort(), 'RPC handlers = §4.1');
  deq(Object.keys(P.WRITES).sort(), CONTRACT_WRITES.slice().sort(), 'write handlers = §4.2');
  for (const m of CONTRACT_RPC) assert.equal(typeof P.RPC[m], 'function', m);
  for (const w of CONTRACT_WRITES) assert.equal(typeof P.WRITES[w], 'function', w);
}

// ── the lists of IJMacroProto (RUNTIME) equal the page's, when ij-proc-macro.js exists ──
{
  const file = path.join(DIR, 'ij-proc-macro.js');
  if (!fs.existsSync(file)) console.log('SKIP IJMacroProto cross-check: ij-proc-macro.js is absent');
  else {
    const ctx = vm.createContext({ console, setTimeout, clearTimeout, TextEncoder, TextDecoder });
    let proto = null;
    try {
      for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-proc-macro.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
      proto = vm.runInContext('typeof IJMacroProto !== "undefined" ? IJMacroProto : null', ctx);
    } catch (err) { console.log('SKIP IJMacroProto cross-check: ij-proc-macro.js does not load on its own yet (' + (err && err.code ? err.code : 'error') + ')'); }
    if (proto) {
      // RUNTIME adds the M6 methods in parallel with this file: until they are on disk the M5 list is compared alone
      const hasFiles = FILES_RPC.some((m) => Object.prototype.hasOwnProperty.call(proto.RPC_METHODS, m));
      const expected = hasFiles ? CONTRACT_RPC : CONTRACT_RPC.filter((m) => FILES_RPC.indexOf(m) < 0);
      if (!hasFiles) console.log('SKIP IJMacroProto cross-check of the FILES.md §5.4 methods: ij-proc-macro.js does not define them yet');
      deq(Object.keys(proto.RPC_METHODS).sort(), expected.slice().sort(), 'IJMacroProto.RPC_METHODS = the page handlers');
      deq(proto.WRITE_OPS.slice().sort(), CONTRACT_WRITES.slice().sort(), 'IJMacroProto.WRITE_OPS = the page handlers');
      for (const m of expected) assert.equal(typeof proto.RPC_METHODS[m].interactive, 'boolean', m + '.interactive');
      if (hasFiles) {
        for (const m of ['vfs.pick', 'vfs.confirm', 'vfs.regrant']) assert.equal(proto.RPC_METHODS[m].interactive, true, m + ' is interactive');
        for (const m of ['text.open', 'window.text']) assert.equal(proto.RPC_METHODS[m].interactive, false, m + ' is not interactive');
      }
      // every text key the worker needs is a lang key of the four languages (the page sends them translated)
      const { lang, lookup, LANGS } = await import('./ij_macro_page_fakes.mjs');
      for (const k of proto.TEXT_KEYS) for (const code of LANGS) assert.equal(typeof lookup(lang[code], k), 'string', code + ': TEXT_KEYS ' + k);
    }
  }
}

// ── every method against the fake worker side ──
{
  const dialogs = [];
  const logged = [];
  const quiet = Object.assign(Object.create(console), { error: (...a) => logged.push(a.map(String).join(' ')) });
  const t = loadMacroPage({ console: quiet, dialog: (spec) => { const f = dialogs.shift(); return f ? f(spec) : {}; } });
  const run = t.page.run('macro', { name: 'M' });
  await until(() => t.lane, 'run');
  const sig = t.lane.ctrl.signal;

  // run → api.macro.runCommand, the CmdResult unchanged
  let r = await t.rpc('run', { name: 'Gaussian Blur...', options: 'sigma=2', vars: { s: { n: 2, s: '2' } }, current: 1, alt: true, shift: false });
  assert.equal(r.ok, true);
  deq(r.result, { status: 'ok', text: '', current: 1, created: [], closed: [] });
  const rc = t.log.calls.filter((c) => c[0] === 'macro.runCommand').pop();
  deq(rc.slice(1), ['Gaussian Blur...', 'sigma=2', { current: 1, vars: { s: { n: 2, s: '2' } }, alt: true, shift: false, rgbWeights: null }]);
  assert.ok(r.mirror && r.mirror.seq > 0, 'a successful reply carries a fresh mirror');
  // null options = show the dialogs
  await t.rpc('run', { name: 'Invert', options: null, current: null });
  deq(t.log.calls.filter((c) => c[0] === 'macro.runCommand').pop().slice(1), ['Invert', null, { current: null, vars: {}, alt: false, shift: false, rgbWeights: null }]);

  // dialog.show: DlgField → view fields, the lane's signal in the spec, values of the non-message fields
  dialogs.push((spec) => {
    assert.equal(spec.title, 'My Dialog'); assert.equal(spec.okLabel, tr('dlg.ok')); assert.equal(spec.signal, sig);
    const ids = spec.fields.map((f) => f.id);
    assert.ok(ids.includes('f0') && ids.includes('f1') && ids.includes('f2') && ids.includes('f3') && ids.includes('f5') && ids.includes('f6') && ids.includes('f7'));
    const msg = spec.fields.filter((f) => f.type === 'message');
    deq(msg.map((f) => f.label), ['Line one', 'Line two']);
    const num = spec.fields.find((f) => f.id === 'f0');
    deq({ type: num.type, label: num.label, value: num.value, decimals: num.decimals }, { type: 'number', label: 'Sigma:', value: 2, decimals: 3 });
    const ch = spec.fields.find((f) => f.id === 'f2');
    deq(ch.options, [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'b' }]);
    assert.equal(spec.fields.find((f) => f.id === 'f6').type, 'doc');
    assert.equal(spec.fields.find((f) => f.id === 'f3').label, ' ', 'an empty ImageJ label still has a label');
    return { f0: 3.5, f1: true, f2: 'b', f3: 'txt', f5: 7, f6: 2, f7: 'long\ntext' };
  });
  r = await t.rpc('dialog.show', { title: 'My Dialog', cancel: true, fields: [
    { id: 'f0', type: 'number', label: 'Sigma:', value: 2, decimals: 3 }, { id: 'f1', type: 'check', label: 'Stack', value: false },
    { id: 'f2', type: 'choice', label: 'Kind:', value: 'a', options: [{ value: 'a', label: 'Alpha' }, { value: 'b' }] },
    { id: 'f3', type: 'string', label: '', value: 'x' }, { id: 'f4', type: 'message', label: 'Line one\nLine two' },
    { id: 'f5', type: 'slider', label: 'N', value: 5, min: 0, max: 10, step: 1 }, { id: 'f6', type: 'doc', label: 'Image:', value: 1, options: [{ value: 1, label: 'a' }, { value: 2, label: 'b' }] },
    { id: 'f7', type: 'textarea', label: 'T', value: '' }] });
  deq(r.result, { values: { f0: 3.5, f1: true, f2: 'b', f3: 'txt', f5: 7, f6: 2, f7: 'long\ntext' } });
  dialogs.push((spec) => { assert.equal(spec.noCancel, true, 'Dialog without Cancel'); return null; });
  r = await t.rpc('dialog.show', { title: 'D', cancel: false, fields: [{ id: 'f0', type: 'check', label: 'x', value: true }] });
  deq(r.result, { cancelled: true });
  // a field type outside the schema is a worker-side bug: the request fails with a sentence, not the exception
  r = await t.rpc('dialog.show', { title: 'D', fields: [{ id: 'f0', type: 'colour', label: 'x' }] });
  assert.equal(r.ok, false); assert.equal(r.error.text, tr('err.unknown')); assert.equal(r.mirror, undefined);
  assert.ok(logged.some((l) => l.includes('dialog field type colour')), 'the technical cause is logged');

  // messages
  dialogs.push((spec) => { assert.equal(spec.title, 'Title'); deq(spec.fields.map((f) => f.label), ['Hello', 'World']); assert.equal(spec.signal, sig); return {}; });
  deq((await t.rpc('dialog.message', { title: 'Title', text: 'Hello\nWorld' })).result, {});
  dialogs.push(() => null);
  deq((await t.rpc('dialog.message', { title: 'T', text: 'x' })).result, {}, 'a closed message box is OK');
  dialogs.push(() => ({}));
  deq((await t.rpc('dialog.messageCancel', { title: 'T', text: 'x' })).result, { ok: true });
  dialogs.push(() => null);
  deq((await t.rpc('dialog.messageCancel', { title: 'T', text: 'x' })).result, { ok: false });
  // waitForUser: non-modal, the lane paused while it is open
  dialogs.push((spec) => { assert.equal(spec.nonModal, true); assert.equal(t.lane.paused, 1, 'paused while open'); return {}; });
  deq((await t.rpc('dialog.waitForUser', { title: 'Action Required', text: 'Click OK' })).result, { ok: true });
  assert.equal(t.lane.paused, 0, 'resumed');
  dialogs.push(() => null);
  deq((await t.rpc('dialog.waitForUser', { title: 'A', text: 'b' })).result, { ok: false });
  assert.equal(t.lane.paused, 0);
  // getNumber / getString
  dialogs.push((spec) => { const f = spec.fields[0]; deq({ type: f.type, label: f.label, value: f.value, decimals: f.decimals }, { type: 'number', label: 'Size:', value: 5, decimals: 0 }); return { value: 9 }; });
  deq((await t.rpc('dialog.number', { title: 'M', prompt: 'Size:', value: 5 })).result, { value: 9 });
  dialogs.push((spec) => { assert.equal(spec.fields[0].decimals, 2, 'Functions.getNumber: 2 decimals for a non-integer default'); return null; });
  deq((await t.rpc('dialog.number', { title: 'M', prompt: 'p', value: 0.5 })).result, { cancelled: true });
  dialogs.push((spec) => { assert.equal(spec.fields[0].type, 'string'); assert.equal(spec.fields[0].value, 'abc'); return { value: 'xyz' }; });
  deq((await t.rpc('dialog.string', { title: 'M', prompt: 'Name:', value: 'abc' })).result, { value: 'xyz' });
  dialogs.push(() => null);
  deq((await t.rpc('dialog.string', { title: 'M', prompt: 'p', value: '' })).result, { cancelled: true });
  // getBoolean without the platform Dialog: a radio Yes / No
  dialogs.push((spec) => { const f = spec.fields.find((x) => x.id === 'answer'); deq(f.options.map((o) => o.label), ['Oui', 'Non']); return { answer: 'no' }; });
  deq((await t.rpc('dialog.boolean', { title: 'M', message: 'Sure?', yes: '  Oui  ', no: 'Non' })).result, { value: false });
  // error.show: the Macro Error title, ImageJ's text verbatim
  dialogs.push((spec) => { assert.equal(spec.title, tr('dlg.mac.errorTitle')); deq(spec.fields.map((f) => f.label), ['Undefined variable in line 1', ' ', '<x>']); return {}; });
  deq((await t.rpc('error.show', { text: 'Undefined variable in line 1\n\n<x>' })).result, {});

  // images
  deq((await t.rpc('image.select', { docId: 2 })).result, { current: 2 });
  deq(t.log.calls.filter((c) => c[0] === 'macro.selectImage').pop().slice(1), [2]);
  deq((await t.rpc('image.close', { docIds: [1, 2] })).result, { closed: [1, 2] });
  deq((await t.rpc('image.show', { docIds: [3] })).result, {});
  deq(t.log.calls.filter((c) => c[0] === 'macro.showImages').pop().slice(1), [[3]]);
  deq((await t.rpc('image.adopt', { docId: 5 })).result, { id: -5 });
  deq((await t.rpc('image.rename', { docId: 1, title: 'new' })).result, {});
  deq(t.log.calls.filter((c) => c[0] === 'rename').pop().slice(1), [1, 'new']);

  // windows
  deq((await t.rpc('window.select', { title: 'Results' })).result, { found: true });
  deq(t.log.calls.filter((c) => c[0] === 'openTool').pop().slice(1), ['results']);
  deq((await t.rpc('window.select', { title: 'ROI Manager' })).result, { found: true });
  deq(t.log.calls.filter((c) => c[0] === 'openTool').pop().slice(1), ['roiManager']);
  deq((await t.rpc('window.select', { title: 'Log' })).result, { found: true });
  assert.ok(t.panel('macroLog'));
  deq((await t.rpc('window.select', { title: 'Nope' })).result, { found: false });
  t.tables.set('Counts', { name: 'Counts', size: 0, headings: [], columns: {}, labels: null, rev: 1 });
  deq((await t.rpc('window.select', { title: 'Counts' })).result, { found: true });
  deq(t.log.calls.filter((c) => c[0] === 'tables.show').pop().slice(1), ['Counts']);
  // print("[Title]", …) makes a text window with one tab per title
  deq((await t.rpc('window.print', { title: 'Notes', text: 'first' })).result, {});
  await t.rpc('window.print', { title: 'Notes', text: 'second' });
  await t.rpc('window.print', { title: 'Other', text: 'x' });
  await until(() => t.panel('macroText'), 'text window');
  await sleep(150);
  const tw = t.panel('macroText').inst._state();
  deq(tw.tabs.children.map((b) => b.textContent), ['Notes', 'Other']);
  assert.equal(tw.pre.textContent, 'x', 'the last printed title is shown');
  tw.tabs.children[0].click();
  assert.equal(t.panel('macroText').inst._state().pre.textContent, 'first\nsecond');
  deq((await t.rpc('window.select', { title: 'Notes' })).result, { found: true });
  deq((await t.rpc('window.close', { title: 'Other' })).result, { closed: true });
  await sleep(150);
  deq(t.panel('macroText').inst._state().tabs.children.map((b) => b.textContent), ['Notes']);
  // close("Results") = Clear Results; close("Log") empties the Log
  deq((await t.rpc('window.close', { title: 'Results' })).result, { closed: true });
  const cleared = t.log.calls.filter((c) => c[0] === 'results.replace').pop()[1];
  deq({ name: cleared.name, size: cleared.size, headings: cleared.headings }, { name: 'Results', size: 0, headings: [] });
  deq((await t.rpc('window.close', { title: 'Counts' })).result, { closed: true });
  assert.equal(t.tables.has('Counts'), false);
  deq((await t.rpc('window.close', { title: 'Log' })).result, { closed: true });
  assert.equal(t.panel('macroLog'), null);
  deq((await t.rpc('window.close', { title: 'Missing' })).result, { closed: false });

  // clipboard: ok, or ok:false (no click in the stack) — never the browser's message
  deq((await t.rpc('clipboard.copy', { text: 'abc' })).result, { ok: true });
  deq(t.log.calls.filter((c) => c[0] === 'copyText').pop().slice(1), ['abc']);

  // command.list: the macro names of the commands that exist here, with their package
  deq((await t.rpc('command.list', {})).result, { commands: [['Gaussian Blur...', 'filters'], ['Invert', 'core']] });

  // flush = writes only
  deq((await t.rpc('flush', {})).result, {});

  // an unknown method: the sentence of err.macNotInBrowser
  r = await t.rpc('fetch.url', {});
  assert.equal(r.ok, false); assert.equal(r.error.text, tr('err.macNotInBrowser', { name: 'fetch.url' }));

  t.finish(done());
  await run;
}

// ── write ops: each one's page action, in order, before the method ──
{
  const t = loadMacroPage();
  const run = t.page.run('m');
  await until(() => t.lane, 'run');
  const lut = Array.from({ length: 768 }, (_, i) => i % 256);
  const roi = { type: 'rect', x: 1, y: 2, w: 3, h: 4 };
  const table = { name: 'Results', size: 1, headings: ['X'], columns: { X: [5] }, labels: null, rev: 3 };
  const named = { name: 'T1', size: 0, headings: [], columns: {}, labels: null, rev: 1 };
  const writes = [
    ['roi.set', { docId: 1, roi }], ['roi.set', { docId: 2, roi: null }],
    ['display.set', { docId: 1, c: 0, min: 10, max: 200 }],
    ['display.lut', { docId: 1, c: 1, name: 'Fire' }], ['display.lut', { docId: 1, c: 0, table: lut }],
    ['display.mode', { docId: 1, mode: 'composite' }], ['display.visible', { docId: 1, visible: [true, 0] }],
    ['thr.set', { docId: 1, c: 0, lower: 10, upper: 100, dark: false }], ['thr.reset', { docId: 1, c: 0 }], ['thr.mode', { mode: 'bw' }],
    ['table.replace', { name: 'Results', table }], ['table.replace', { name: 'T1', table: named }],
    ['table.show', { name: 'T1' }], ['table.show', { name: 'Results' }],
    ['rm.set', { list: [{ name: 'a', docId: 1, roi }] }], ['rm.select', { indices: [0] }], ['rm.show', { showAll: true, labels: false }],
    ['setting.set', { key: 'thr.blackBackground', value: true }], ['measurements.set', { groups: ['area'], decimals: 4 }],
    ['colors.set', { foreground: [255, 0, 0] }], ['tool.set', { id: 'rect' }], ['status.show', { text: 'hi' }], ['progress.show', { fraction: 0.5 }],
    ['progress.show', { fraction: null }]
  ];
  const before = t.log.calls.length;
  const r = await t.rpc('image.select', { docId: 1 }, writes);
  assert.equal(r.ok, true);
  const calls = t.log.calls.slice(before).map((c) => c[0]).filter((c) => c !== 'call');
  const lutName = 'macro-' + t.page._internals.fnvHex(Uint8Array.from(lut));
  deq(t.log.calls.slice(before).filter((c) => c[0] === 'registerLut').map((c) => c[1]), [lutName]);
  deq(calls, ['setRoi', 'setRoi', 'setDisplay', 'setDisplay', 'registerLut', 'setDisplay', 'setDisplayMode', 'setVisible', 'thresholds.set', 'thresholds.reset', 'thresholdMode',
    'results.replace', 'tables.replace', 'tables.show', 'openTool', 'roiManager.set', 'roiManager.select', 'roiManagerShow', 'macro.settings.set', 'measurements.set',
    'colors.set', 'setTool', 'macro.status', 'macro.progress', 'macro.progress', 'macro.selectImage'], 'writes in order, then the method');
  const get = (name) => t.log.calls.slice(before).filter((c) => c[0] === name).map((c) => J(c.slice(1)));
  deq(get('setRoi'), [[roi, { docId: 1 }], [null, { docId: 2 }]]);
  deq(get('setDisplay'), [[1, 0, { min: 10, max: 200 }], [1, 1, { lut: 'Fire' }], [1, 0, { lut: lutName }]]);
  deq(get('setVisible'), [[1, [true, false]]]);
  deq(get('thresholds.set'), [[1, 0, { lower: 10, upper: 100, dark: false }]]);
  deq(get('thresholdMode'), [['bw']]);
  deq(get('tables.replace'), [['T1', named]]);
  deq(get('openTool'), [['results']]);
  deq(get('roiManagerShow'), [[{ showAll: true, labels: false }]]);
  deq(get('macro.settings.set'), [['thr.blackBackground', true]]);
  deq(get('measurements.set'), [[{ groups: ['area'], decimals: 4 }]]);
  deq(get('colors.set'), [[{ foreground: [255, 0, 0] }]]);
  deq(get('setTool'), [['rect']]);
  deq(get('macro.status'), [['hi']]);
  deq(get('macro.progress'), [[0.5], [null]]);

  // table.remove / table.rename, the Results endpoints handled here
  t.tables.set('A', { name: 'A', size: 2, headings: ['v'], columns: { v: [1, 2] }, labels: null, rev: 1 });
  const b2 = t.log.calls.length;
  await t.rpc('flush', {}, [['table.rename', { from: 'A', to: 'B' }], ['table.rename', { from: 'B', to: 'Results' }], ['table.rename', { from: 'Results', to: 'C' }],
    ['table.remove', { name: 'C' }], ['table.remove', { name: 'Results' }]]);
  deq(t.log.calls.slice(b2).map((c) => c[0]).filter((c) => c !== 'call'), ['tables.rename', 'results.replace', 'tables.remove', 'tables.replace', 'results.replace', 'tables.remove', 'results.replace']);
  const renamed = t.log.calls.slice(b2).filter((c) => c[0] === 'results.replace')[0][1];
  assert.equal(renamed.name, 'Results'); deq(renamed.columns, { v: [1, 2] });
  assert.equal(t.log.calls.slice(b2).filter((c) => c[0] === 'tables.replace')[0][1], 'C');

  // a write that fails is logged and the next ones still run; an op outside the list fails the request
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => errs.push(a);
  try {
    const t2 = loadMacroPage();
    t2.api.setDisplay = async () => { throw Object.assign(new Error('closed image'), { code: 'IJ_NO_DOC' }); };
    const run2 = t2.page.run('m');
    await until(() => t2.lane, 'run');
    const b3 = t2.log.calls.length;
    const r2 = await t2.rpc('flush', {}, [['display.set', { docId: 9, c: 0, min: 0, max: 1 }], ['status.show', { text: 'after' }]]);
    assert.equal(r2.ok, true);
    deq(t2.log.calls.slice(b3).filter((c) => c[0] === 'macro.status').map((c) => c[1]), ['after']);
    assert.ok(errs.length >= 1, 'the failed write is logged');
    const r3 = await t2.rpc('flush', {}, [['net.fetch', { url: 'x' }], ['status.show', { text: 'never' }]]);
    assert.equal(r3.ok, false); assert.equal(r3.error.text, tr('err.macNotInBrowser', { name: 'net.fetch' }));
    assert.ok(!t2.log.calls.some((c) => c[0] === 'macro.status' && c[1] === 'never'), 'nothing after an unknown op');
    t2.finish(done());
    await run2;
  } finally { console.error = origErr; }

  t.finish(done());
  await run;
}

// ── one request at a time, in arrival order; dropped once the lane is gone ──
{
  let release;
  const t = loadMacroPage({ dialog: () => new Promise((r) => { release = r; }) });
  const run = t.page.run('m');
  await until(() => t.lane, 'run');
  const runId = t.lane.runId;
  t.emit('ext:macro.rpc', { runId, reqId: 1, method: 'dialog.message', args: { title: 'a', text: 'b' }, writes: [] });
  t.emit('ext:macro.rpc', { runId, reqId: 2, method: 'image.rename', args: { docId: 1, title: 'z' }, writes: [['status.show', { text: 'w2' }]] });
  await sleep(20);
  assert.equal(t.log.replies.length, 0, 'the second request waits for the first');
  assert.ok(!t.log.calls.some((c) => c[0] === 'macro.status'), 'its writes too');
  release({});
  await until(() => t.log.replies.length === 2, 'both replies');
  deq(t.log.replies.map((x) => x.reqId), [1, 2]);
  // another run's requests are not ours
  t.emit('ext:macro.rpc', { runId: 'r999', reqId: 3, method: 'flush', args: {}, writes: [] });
  await sleep(10);
  assert.equal(t.log.replies.length, 2);
  // a request pending when the run ends gets no reply
  t.emit('ext:macro.rpc', { runId, reqId: 4, method: 'dialog.message', args: { title: 'a', text: 'b' }, writes: [] });
  await until(() => release && t.log.dialogs.length === 2, 'second dialog open');
  const sig = t.lane.ctrl.signal;
  t.finish(done({ ok: false, aborted: true }));
  assert.equal(sig.aborted, true, 'the dialogs the run opened get the abort');
  release(null);
  await run;
  await sleep(10);
  assert.equal(t.log.replies.length, 2, 'no reply for a run that is gone');
  // events after the run: nobody listens
  assert.equal(t.listenerCount('ext:macro.rpc'), 0);
}

// ── dialog.boolean through the platform Dialog (Yes / No / Cancel), closed by an abort ──
{
  const asks = [];
  const Dialog = { ask: (cfg) => new Promise((resolve) => { asks.push({ cfg, resolve }); }), close: (id) => { const a = asks[asks.length - 1]; if (a) a.resolve(id); } };
  const t = loadMacroPage({ Dialog });
  const run = t.page.run('m');
  await until(() => t.lane, 'run');
  const pr = t.rpc('dialog.boolean', { title: 'Q', message: 'Go?', yes: '  Yes  ', no: '  No  ' });
  await until(() => asks.length === 1, 'asked');
  deq(asks[0].cfg.options.map((o) => [o.id, o.label]), [['yes', 'Yes'], ['no', 'No'], ['cancel', tr('dlg.cancel')]]);
  assert.equal(asks[0].cfg.dismissId, 'cancel');
  assert.equal(asks[0].cfg.message, 'Go?');
  asks[0].resolve('yes');
  deq((await pr).result, { value: true });
  const pr2 = t.rpc('dialog.boolean', { title: 'Q', message: 'Go?' });
  await until(() => asks.length === 2, 'asked 2');
  deq(asks[1].cfg.options.slice(0, 2).map((o) => o.label), [tr('dlg.yes'), tr('dlg.no')], 'default button labels');
  asks[1].resolve('cancel');
  deq((await pr2).result, { cancelled: true });
  // an abort closes the box (its request is then dropped)
  t.emit('ext:macro.rpc', { runId: t.lane.runId, reqId: 99, method: 'dialog.boolean', args: { title: 'Q', message: 'm' }, writes: [] });
  await until(() => asks.length === 3, 'asked 3');
  let settled = null;
  asks[2].resolve = ((orig) => (v) => { settled = v; orig(v); })(asks[2].resolve);
  t.macro.abort();
  assert.equal(settled, 'cancel', 'Dialog.close on abort');
  t.finish(done({ ok: false, aborted: true }));
  await run;
}

// ── a failing method: the platform sentence, never the exception's text; a coded error keeps its sentence ──
{
  const errs = [];
  const quiet = Object.assign(Object.create(console), { error: (...a) => errs.push(a) });
  const t = loadMacroPage({ console: quiet, copyFails: true });
  t.macro.selectImage = async () => { throw new Error('Cannot read properties of undefined (reading \'secret\')'); };
  t.macro.adopt = async () => { throw Object.assign(new Error('busy inside'), { code: 'IJ_MACRO_BUSY' }); };
  const run = t.page.run('m');
  await until(() => t.lane, 'run');
  let r = await t.rpc('image.select', { docId: 1 });
  assert.equal(r.ok, false); assert.equal(r.error.text, tr('err.unknown'));
  assert.ok(!JSON.stringify(r).includes('secret'));
  r = await t.rpc('image.adopt', { docId: 1 });
  assert.equal(r.error.text, tr('err.macBusy'));
  deq((await t.rpc('clipboard.copy', { text: 'x' })).result, { ok: false });
  assert.ok(errs.length >= 3);
  t.finish(done());
  await run;
}

// ── the real app (PLUMBING's api.macro, lane, passive macro.reply) with a scripted worker side standing in for ij-proc-macro.js ──
// The stand-in posts a Log batch and three requests (writes included), then returns what the page answered, so the round trip
// page ↔ worker is checked through the real ij-app.js / ij-engine.js / ij-worker.js.
const WORKER_STUB = `(function (root) {
  'use strict';
  const R = root.IJOpRegistry;
  const pending = new Map();
  root.IJMacroProto = { TEXT_KEYS: ['err.macPageTimeout'], RPC_METHODS: {}, WRITE_OPS: [], log: { MAX_LINES: 100000, apply: (lines, raw) => lines.concat(raw) } };
  R.defineCommand('macro.reply', { pkg: 'macro', passive: true, handler(a) { const f = pending.get(a.reqId); if (f) { pending.delete(a.reqId); f(a); } return {}; } });
  R.defineCommand('macro.run', { pkg: 'macro', long: true, async handler(a, E) {
    let n = 0;
    const rpc = (method, args, writes) => new Promise((resolve) => { const reqId = ++n; pending.set(reqId, resolve); E.postEvent({ event: 'macro.rpc', runId: a.runId, reqId, method, args, writes: writes || [] }); });
    E.postEvent({ event: 'macro.log', runId: a.runId, lines: ['hello', 'world'] });
    const r1 = await rpc('window.print', { title: 'Notes', text: 'x' }, [['status.show', { text: 'from the macro' }]]);
    const r2 = await rpc('image.rename', { docId: a.mirror.current, title: 'renamed by macro' });
    const r3 = await rpc('no.such', {});
    return { ok: true, aborted: false, exited: false, error: null, prefsWrites: { 'stub.k': 'v' }, changedDocs: [], undo: { changed: [], dropped: [] },
      echo: { r1, r2, r3, texts: a.texts, prefs: a.prefs, log: a.log, hasMirror: !!(a.mirror && Array.isArray(a.mirror.images)) } };
  } });
})(typeof self !== 'undefined' ? self : globalThis);`;
{
  let boot = null;
  try { ({ boot } = await import('./ij_harness.mjs')); } catch (_) { boot = null; }
  const probe = boot ? await boot({ channels: 2 }) : null;
  const supported = probe && Array.isArray(probe.IJApp.PACKAGE_NAMES) && probe.IJApp.PACKAGE_NAMES.includes('macro') && probe.page.IJMacroPage && typeof probe.runMacro === 'function';
  if (probe) probe.close();
  if (!supported) console.log('SKIP harness round trip: package macro is not booted by the harness yet');
  else {
    const store = new Map([['lumen3d.studio.macroPrefs', JSON.stringify({ v: 1, prefs: { 'stub.old': '1' } })]]);
    const t = await boot({ channels: 2, localStore: store, pageSources: { 'ij-proc-macro.js': WORKER_STUB }, workerSources: { 'ij-proc-macro.js': WORKER_STUB } });
    await t.open();
    assert.ok(!t.failedPackages().has('macro'), 'the stand-in package loads');
    const a = t.IJApp.apiFor('macro');
    assert.ok(a.macro, 'api.macro');
    const docId = t.activeId();
    const res = await t.runMacro('print("x");', { name: 'H' });
    assert.equal(res.ok, true);
    const e = res.echo;
    assert.equal(e.hasMirror, true, 'the run carries the mirror');
    assert.equal(e.texts['err.macPageTimeout'], t.ctx.i18n.t('err.macPageTimeout'), 'texts translated by the page');
    deq(e.prefs, { 'stub.old': '1' });
    assert.equal(e.r1.ok, true); deq(e.r1.result, {}); assert.ok(e.r1.mirror && Array.isArray(e.r1.mirror.images), 'a reply carries the mirror');
    assert.equal(e.r2.ok, true);
    assert.equal(e.r3.ok, false); assert.equal(e.r3.error.text, t.ctx.i18n.t('err.macNotInBrowser', { name: 'no.such' }));
    assert.ok(t.log.status.includes('from the macro'), 'the write ran before the request');
    const doc = (await t.docs()).find((d) => d.docId === docId);
    assert.equal(doc && doc.name, 'renamed by macro');
    deq(t.macroLog(), ['hello', 'world']);
    assert.ok(t.panel('macroLog'), 'the Log window opened');
    assert.ok(t.panel('macroText'), 'the text window opened');
    deq(JSON.parse(store.get('lumen3d.studio.macroPrefs')).prefs, { 'stub.old': '1', 'stub.k': 'v' });
    assert.equal(a.macro.running(), null, 'the lane is gone');
    // the editor opens in the real app and the Log seeds the next run
    assert.equal(await t.openPanel('macroEditor'), true);
    const res2 = await t.runMacro('x');
    deq(res2.echo.log, ['hello', 'world']);
    t.close();
  }
}

console.log('test_ij_macro_rpc_host: ok');
