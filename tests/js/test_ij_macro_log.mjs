// The Log of the macro page (ij-cmds-macro.js, INTEGRATION.md §3.4, PLAN §11.2): the ext:macro.log batches of a run go through
// IJMacroProto.log.apply (the worker applies the same function to its copy, which answers getInfo("log")), the Log window opens on the
// first line, closes on \\Close, keeps the cap marker as a translated line, and its lines seed the next run. With the real
// ij-proc-macro.js on disk, the ImageJ magic (\\Clear, \\Update:, \\Update<n>:, \\Close) and the 100 000-line cap are checked through the
// page against the pure function the worker uses.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadMacroPage, tr, sleep, until, DIR } from './ij_macro_page_fakes.mjs';

if (!fs.existsSync(path.join(DIR, 'ij-cmds-macro.js'))) { console.log('SKIP ij-cmds-macro.js is absent'); process.exit(0); }

const J = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const deq = (a, b, m) => (m === undefined ? assert.deepEqual(J(a), J(b)) : assert.deepEqual(J(a), J(b), m));
const done = (o) => Object.assign({ ok: true, aborted: false, exited: false, error: null, prefsWrites: {}, changedDocs: [], undo: { changed: [], dropped: [] } }, o || {});

async function logRun(t, batches) {
  const run = t.page.run('m');
  await until(() => t.lane, 'run');
  const runId = t.lane.runId;
  for (const lines of batches) t.emit('ext:macro.log', { event: 'ext:macro.log', runId, lines });
  t.finish(done());
  await run;
  await sleep(150);
}

// ── page plumbing (stand-in IJMacroProto) ──
{
  const t = loadMacroPage();
  assert.equal(t.panel('macroLog'), null);
  await logRun(t, [['a', 'b'], ['c']]);
  deq(t.page.logLines(), ['a', 'b', 'c']);
  const w = t.panel('macroLog');
  assert.ok(w, 'the first line opens the Log window');
  assert.equal(w.inst._state().pre.textContent, 'a\nb\nc');
  // the next run starts from these lines (getInfo("log"), \\Update of a line printed before)
  const run = t.page.run('m');
  await until(() => t.lane, 'run');
  deq(t.startArgs().log, ['a', 'b', 'c']);
  // another run's lines are not ours
  t.emit('ext:macro.log', { runId: 'r999', lines: ['intruder'] });
  t.emit('ext:macro.log', { runId: t.lane.runId, lines: ['\\Update:C'] });
  t.finish(done());
  await run;
  await sleep(150);
  deq(t.page.logLines(), ['a', 'b', 'C']);
  assert.equal(t.panel('macroLog').inst._state().pre.textContent, 'a\nb\nC');
  // Clear / Copy buttons
  const btns = t.panel('macroLog').el.children[0].children[0].children;
  btns[1].click();
  await until(() => t.log.calls.some((c) => c[0] === 'copyText'), 'copied');
  assert.equal(t.log.calls.filter((c) => c[0] === 'copyText').pop()[1], 'a\nb\nC');
  btns[0].click();
  deq(t.page.logLines(), []);
  assert.equal(t.panel('macroLog').inst._state().pre.textContent, '');
  // \\Close closes the window; \\Clear alone does not open it
  await logRun(t, [['x'], ['\\Close']]);
  assert.equal(t.panel('macroLog'), null, '\\Close closes the Log');
  await logRun(t, [['\\Clear']]);
  assert.equal(t.panel('macroLog'), null, '\\Clear does not open the Log');
  // closing the window drops its lines (ImageJ's Log goes with its window)
  await logRun(t, [['kept?']]);
  assert.ok(t.panel('macroLog'));
  t.api.closePanel('macroLog');
  deq(t.page.logLines(), []);
}

// a copy refused by the browser: the platform sentence, not the browser's text
{
  const errs = [];
  const quiet = Object.assign(Object.create(console), { error: (...a) => errs.push(a) });
  const t = loadMacroPage({ copyFails: true, console: quiet });
  await logRun(t, [['z']]);
  t.panel('macroLog').el.children[0].children[0].children[1].click();
  await until(() => t.log.toasts.length, 'toast');
  deq(t.log.toasts.pop(), ['err.macClipboard', undefined]);
}

// the cap marker is a translated line
{
  const proto = {
    TEXT_KEYS: [], RPC_METHODS: {}, WRITE_OPS: [],
    log: { MAX_LINES: 3, apply(lines, raw) { let out = lines.filter((l) => typeof l === 'string').concat(raw); let dropped = lines[0] && lines[0].dropped ? lines[0].dropped : 0; if (out.length > 3) { dropped += out.length - 3; out = out.slice(-3); } return dropped ? [{ dropped }].concat(out) : out; } }
  };
  const t = loadMacroPage({ proto });
  await logRun(t, [['1', '2', '3', '4', '5']]);
  deq(t.page.logLines(), [tr('dlg.mac.linesDropped', { n: 2 }), '3', '4', '5']);
  assert.equal(t.panel('macroLog').inst._state().pre.textContent.split('\n')[0], tr('dlg.mac.linesDropped', { n: 2 }));
}

// ── parity with the real IJMacroProto.log (ij-proc-macro.js) ──
{
  const file = path.join(DIR, 'ij-proc-macro.js');
  let proto = null;
  if (fs.existsSync(file)) {
    const ctx = vm.createContext({ console, setTimeout, clearTimeout, TextEncoder, TextDecoder });
    try {
      for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-proc-macro.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
      proto = vm.runInContext('typeof IJMacroProto !== "undefined" ? IJMacroProto : null', ctx);
    } catch (_) { proto = null; }
  }
  if (!proto || !proto.log || typeof proto.log.apply !== 'function') console.log('SKIP Log parity: IJMacroProto.log of ij-proc-macro.js is not available');
  else {
    const t = loadMacroPage({ proto });
    // e2e item 7: print("a"); print("\\Update:b"); print("c"); print("\\Clear"); print("d");
    await logRun(t, [['a', '\\Update:b'], ['c', '\\Clear', 'd']]);
    deq(t.page.logLines(), ['d']);
    deq(proto.log.apply([], ['a', '\\Update:b', 'c', '\\Clear', 'd']), ['d'], 'the worker copy agrees');
    // \\Update<n>: replaces line n (0-based in ImageJ's TextPanel.setLine)
    t.api.closePanel('macroLog');
    const seq = ['l0', 'l1', 'l2', '\\Update1:L1', '\\Update:last'];
    await logRun(t, [seq]);
    deq(t.page.logLines(), proto.log.apply([], seq).map(String));
    // batches split anywhere give the same Log as one batch
    t.api.closePanel('macroLog');
    const many = Array.from({ length: 40 }, (_, i) => (i % 7 === 3 ? '\\Update:u' + i : i % 11 === 5 ? '\\Update2:v' + i : 'p' + i));
    await logRun(t, [many.slice(0, 13), many.slice(13, 14), many.slice(14)]);
    deq(t.page.logLines(), proto.log.apply([], many).map((l) => (l && typeof l === 'object' ? tr('dlg.mac.linesDropped', { n: l.dropped }) : String(l))));
    // the cap: 100 000 lines, then the drop marker first
    assert.equal(proto.log.MAX_LINES, 100000);
    t.api.closePanel('macroLog');
    const big = Array.from({ length: 100005 }, (_, i) => 'n' + i);
    await logRun(t, [big]);
    const lines = t.page.logLines();
    assert.ok(lines.length <= 100001, 'capped');
    assert.equal(lines[lines.length - 1], 'n100004');
    assert.equal(lines[0], tr('dlg.mac.linesDropped', { n: 100005 - (lines.length - 1) }));
  }
}

console.log('test_ij_macro_log: ok');
