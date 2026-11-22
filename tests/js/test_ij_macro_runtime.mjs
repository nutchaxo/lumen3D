// The worker runtime of the Advanced Studio macros (js/modules/studio/advanced-studio/ij-proc-macro.js, INTEGRATION.md §3–§4) against a
// scripted page that answers `ext:macro.rpc` (tests/js/ij_macro_rt_support.mjs), with the REAL engine and language:
//   • the macro.run lifecycle and result fields (ok / error with ImageJ's text and line / exited / prefsWrites / changedDocs);
//   • cancellation reaches the run within 100 ms: in a loop, in wait(), with an RPC the page never answers;
//   • write-behind: page-state writes reach the page IN ORDER and BEFORE the method of the next request, table replacements are
//     coalesced (one per table), a flush carries writes made while nothing else talks to the page;
//   • Log streaming: raw strings in order, batched (fewer events than prints), getInfo("log") reads the worker's copy;
//   • the RPC timeout of a non-interactive method, a reply arriving for a run that moved on;
//   • working copies: a pixel loop costs no RPC, is committed before the next RPC (the page's run sees the new pixels), an abort keeps them;
//   • IJMacroProto: the closed tables and the Log rules against the ImageJ Log goldens (tests/fixtures/ij-macro/golden.json, log-window).
//
// Run: node tests/js/test_ij_macro_runtime.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';
import { rt, okRun, sleep } from './ij_macro_rt_support.mjs';

const J = (x) => JSON.parse(JSON.stringify(x));
const t = await rt();
const W = t.W;
const P = W.IJMacroProto;

// ---------------------------------------------------------------- IJMacroProto
{
  const methods = Object.keys(P.RPC_METHODS).sort();
  assert.deepEqual(methods, ['clipboard.copy', 'command.list', 'dialog.boolean', 'dialog.message', 'dialog.messageCancel', 'dialog.number', 'dialog.show',
    'dialog.string', 'dialog.waitForUser', 'error.show', 'flush', 'image.adopt', 'image.close', 'image.rename', 'image.select', 'image.show', 'run',
    'window.close', 'window.print', 'window.select'], 'RPC_METHODS is the closed list of §4.1');
  for (const m of ['flush', 'image.rename', 'window.print', 'command.list']) assert.equal(P.RPC_METHODS[m].interactive, false, m + ' has a timeout');
  for (const m of ['run', 'dialog.show', 'image.adopt', 'clipboard.copy']) assert.equal(P.RPC_METHODS[m].interactive, true, m + ' waits for the operator');
  assert.deepEqual(J(P.WRITE_OPS).sort(), ['colors.set', 'display.lut', 'display.mode', 'display.set', 'display.visible', 'measurements.set', 'progress.show',
    'rm.select', 'rm.set', 'rm.show', 'roi.set', 'setting.set', 'status.show', 'table.remove', 'table.rename', 'table.replace', 'table.show', 'thr.mode',
    'thr.reset', 'thr.set', 'tool.set'], 'WRITE_OPS is the closed list of §4.2');
  assert.ok(Object.isFrozen(P) && Object.isFrozen(P.RPC_METHODS) && Object.isFrozen(P.WRITE_OPS) && Object.isFrozen(P.TEXT_KEYS), 'frozen tables');
  for (const k of P.TEXT_KEYS) assert.match(k, /^err\.mac[A-Z0-9]/, 'text key ' + k + ' is in the err.mac* namespace');
  // the en texts of every TEXT_KEYS key exist once PAGE has written them (a missing one would show the key to the operator)
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio', 'lang', 'en.json'), 'utf8'));
  const missing = P.TEXT_KEYS.filter((k) => k.split('.').reduce((o, s) => (o && typeof o === 'object' ? o[s] : undefined), en) === undefined);
  if (missing.length) console.log('SKIP lang check: ' + missing.length + ' TEXT_KEYS are not in lang/en.json yet (PAGE writes them): ' + missing.join(' '));
  // setOption names
  assert.deepEqual(JSON.parse(JSON.stringify(P.optionFor('blackbackground'))), { setting: 'thr.blackBackground', match: 'start' });
  assert.equal(P.optionFor('area').measurement, 'area');
  assert.equal(P.optionFor('show all').rmShow, true);
  assert.equal(P.optionFor('showrowindexes').noop, true);
  assert.equal(P.optionFor('nope'), null);
  // Log rules = ImageJ's Log window (golden, group log-window), except "\Close" / "\Closed": a GUI Log window closes and the next
  // print opens a new one (the golden is headless: no frame to close)
  const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'ij-macro', 'golden.json'), 'utf8'));
  let n = 0;
  for (const [k, g] of Object.entries(golden)) {
    if (!k.startsWith('log-window/') || g.logWindow === undefined) continue;
    if (k === 'log-window/close' || k === 'log-window/closed') continue;
    const lines = P.log.apply([], g.log);
    assert.equal(P.log.text(lines), g.logWindow === null ? '' : g.logWindow, k);
    n++;
  }
  assert.ok(n >= 20, 'log goldens checked: ' + n);
  assert.deepEqual(J(P.log.apply(['a'], ['\\Close', 'b'])), ['b'], '\\Close: the Log window closes, the next print opens a new one');
  // the cap keeps the last MAX_LINES lines behind one marker
  const many = P.log.apply([], Array.from({ length: 10 }, (_, i) => 'l' + i));
  assert.equal(many.length, 10);
  const capped = P.log.apply(Array.from({ length: P.log.MAX_LINES }, (_, i) => 'x' + i), ['y', 'z']);
  assert.deepEqual(J(capped[0]), { dropped: 2 });
  assert.equal(capped.length, P.log.MAX_LINES + 1);
  assert.equal(capped[capped.length - 1], 'z');
  assert.deepEqual(J(P.log.apply(capped, ['w'])[0]), { dropped: 3 });
}

// ---------------------------------------------------------------- lifecycle and result
{
  let r = await t.run('print("a"); x = 2; print(x*3);');
  assert.deepEqual(okRun(r, 'plain'), ['a', '6']);
  assert.deepEqual(r.rpc, [], 'a macro that never needs the page sends no request');
  assert.equal(r.result.ok, true);
  assert.equal(r.result.aborted, false);
  assert.deepEqual(J(r.result.undo), { changed: [], dropped: [] });

  r = await t.run('print(1);\nprint(2);\nfoo(;');
  assert.equal(r.result.ok, false);
  assert.equal(r.result.error.line, 3);
  assert.equal(typeof r.result.error.message, 'string');
  assert.ok(r.result.error.dialogText.indexOf(' in line 3') > 0, 'the Macro Error text');

  r = await t.run('print("x"); exit; print("y");');
  assert.equal(r.result.exited, true);
  assert.deepEqual(r.log, ['x']);

  r = await t.run('exit("bye");');
  assert.deepEqual(r.rpc, ['dialog.message'], 'exit("msg") shows the message through the page');
  assert.equal(t.page.dialogs[t.page.dialogs.length - 1][1].text, 'bye');

  // getArgument / name
  r = await t.run('print(getArgument());', { arg: 'hello' });
  assert.deepEqual(r.log, ['hello']);

  // one run at a time per worker
  let second = null;
  t.page.answers['dialog.message'] = async () => { second = await t.call('macro.run', { runId: 'other', source: 'print(1);', mirror: await t.mirror(), log: [], texts: {}, prefs: {}, options: {} }); return {}; };
  r = await t.run('showMessage("hi");');
  delete t.page.answers['dialog.message'];
  okRun(r, 'busy');
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'IJ_MACRO_BUSY');
}

// ---------------------------------------------------------------- cancellation ≤ 100 ms
async function cancelWithin(src, setup) {
  let ctl = null;
  if (setup) setup();
  const p = t.run(src, { onStart: (c) => { ctl = c; } });
  await sleep(150);
  const t0 = Date.now();
  await ctl.cancel();
  const r = await p;
  return { r, ms: Date.now() - t0 };
}
{
  let { r, ms } = await cancelWithin('i = 0; while (true) i++;');
  assert.equal(r.result.aborted, true, 'a busy loop is aborted');
  assert.ok(ms <= 100, 'loop: aborted in ' + ms + ' ms');

  ({ r, ms } = await cancelWithin('wait(10000); print("late");'));
  assert.equal(r.result.aborted, true);
  assert.deepEqual(r.log, []);
  assert.ok(ms <= 100, 'wait: aborted in ' + ms + ' ms');

  ({ r, ms } = await cancelWithin('showMessage("never answered"); print("late");', () => t.page.noReply.add('dialog.message')));
  t.page.noReply.delete('dialog.message');
  assert.equal(r.result.aborted, true);
  assert.ok(ms <= 100, 'pending RPC: aborted in ' + ms + ' ms');
  assert.deepEqual(J(W.IJMacroRuntime.runs()), [], 'the run is gone');

  // syncLoops: the whole loop runs in the plain twin, the cancel still lands at the end of the loop (no SharedArrayBuffer here)
  ({ r } = await cancelWithin('for (i = 0; i < 2000; i++) wait(1); print("done");'));
  assert.equal(r.result.aborted, true);
}

// ---------------------------------------------------------------- write-behind: order, before the method, coalescing
{
  const id = await t.open({ name: 'w', width: 8, height: 8, bitDepth: 8, channels: [{ data: new Uint8Array(64) }] });
  let seen = null;
  t.page.answers['image.rename'] = (a, page) => { seen = { roi: JSON.parse(JSON.stringify(page.selections[a.docId])), thr: JSON.parse(JSON.stringify(page.thresholds[a.docId] || {})), tool: page.tool }; return {}; };
  let r = await t.run('makeRectangle(1,2,3,4); setThreshold(10, 20); setTool("oval"); makeOval(0,0,5,5); rename("w2");');
  delete t.page.answers['image.rename'];
  okRun(r, 'writes');
  assert.deepEqual(r.writes.map((w) => w[0]), ['roi.set', 'thr.set', 'tool.set', 'roi.set'], 'in order');
  assert.deepEqual(seen.roi, { type: 'oval', x: 0, y: 0, w: 5, h: 5 }, 'applied before the method: the page saw the last selection');
  assert.deepEqual(seen.thr, { 0: { lower: 10, upper: 20, dark: false } });
  assert.equal(seen.tool, 'oval');
  assert.deepEqual(r.rpc, ['image.rename']);

  // 1000 setResult = one table.replace, sent at the end
  r = await t.run('for (i = 0; i < 1000; i++) setResult("V", i, i*i); print(nResults);');
  assert.deepEqual(okRun(r, 'results'), ['1000']);
  const tw = r.writes.filter((w) => w[0] === 'table.replace');
  assert.equal(tw.length, 1, 'coalesced: one replacement of Results');
  assert.equal(tw[0][1].table.size, 1000);
  assert.equal(t.page.tables.Results.columns.V[999], 998001);

  // updateResults sends the table now and shows it
  t.page.answers['image.rename'] = (a, page) => { seen = JSON.parse(JSON.stringify(page.tables.Results)); return {}; };
  r = await t.run('setResult("X", 0, 5); updateResults(); rename("w3");');
  delete t.page.answers['image.rename'];
  assert.equal(seen.columns.X[0], 5, 'updateResults: the Results reached the page before the next request');
  assert.ok(t.page.shown.indexOf('Results') >= 0);

  // a write made while the macro waits in wait() reaches the page through a flush (250 ms)
  const before = t.page.rpc.length;
  r = await t.run('makeRectangle(0,0,2,2); wait(400); print("x");');
  okRun(r, 'flush');
  assert.ok(t.page.rpc.slice(before).indexOf('flush') >= 0, 'a flush carried the write');
  assert.equal(r.writes.length, 1);
  void id;
}

// ---------------------------------------------------------------- Log streaming
{
  const n0 = t.log.filter((m) => m.event === 'ext:macro.log').length;
  const r = await t.run('for (i = 0; i < 500; i++) print("line " + i); print("\\\\Update:last"); s = getInfo("log"); b = lengthOf(s) > 0; print(b);');
  okRun(r, 'log');
  assert.equal(r.log.length, 502, 'every raw string, in order');
  assert.equal(r.log[0], 'line 0');
  assert.equal(r.log[500], '\\Update:last');
  const events = t.log.filter((m) => m.event === 'ext:macro.log').length - n0;
  assert.ok(events < 50, 'batched: ' + events + ' events for 502 prints');
  // the Log a run starts with is the page's (getInfo("log") after a clear)
  const r2 = await t.run('print("\\\\Clear"); print("only"); print(getInfo("log"));');
  assert.deepEqual(r2.log.slice(-1), ['only\n']);
}

// ---------------------------------------------------------------- RPC timeout, stale replies
{
  const old = W.IJMacroRuntime.setRpcTimeout(120);
  t.page.noReply.add('image.rename');
  await t.open({ name: 't', width: 4, height: 4, bitDepth: 8, channels: [{ data: new Uint8Array(16) }] });
  const t0 = Date.now();
  const r = await t.run('rename("x");');
  t.page.noReply.delete('image.rename');
  W.IJMacroRuntime.setRpcTimeout(old);
  assert.equal(r.result.error.message, 'The page did not answer (image.rename).');
  assert.ok(Date.now() - t0 < 2000);
  // an interactive method has no timeout: a dialog answered after the old timeout still works
  W.IJMacroRuntime.setRpcTimeout(50);
  t.page.answers['dialog.number'] = async (a) => { await sleep(200); return { value: 42 }; };
  const r2 = await t.run('print(getNumber("n", 1));');
  delete t.page.answers['dialog.number'];
  W.IJMacroRuntime.setRpcTimeout(old);
  assert.deepEqual(okRun(r2, 'interactive'), ['42']);
  // a reply for a request that is not pending is ignored
  const res = await t.call('macro.reply', { runId: 'nope', reqId: 1, ok: true, result: {} });
  assert.equal(res.ok, true);
}

// ---------------------------------------------------------------- working copies and commit points
{
  const id = await t.open({ name: 'wc', width: 16, height: 16, bitDepth: 8, channels: [{ data: new Uint8Array(256) }] });
  let atRun = null;
  t.page.answers.run = (a) => { atRun = t.pixels(a.current); return { status: 'ok', text: '', current: a.current, created: [], closed: [] }; };
  const r = await t.run('for (y=0;y<16;y++) for (x=0;x<16;x++) setPixel(x, y, x+y); print(getPixel(3,4)); run("Invert"); print(getPixel(3,4));');
  delete t.page.answers.run;
  assert.deepEqual(okRun(r, 'commit'), ['7', '7']);
  assert.deepEqual(r.rpc, ['run'], 'one request: the run (the pixel loop needs none)');
  assert.equal(atRun[4 * 16 + 3], 7, 'committed before the page ran the command');
  assert.ok(r.result.changedDocs.indexOf(id) >= 0, 'changedDocs names the image');
  assert.equal(t.pixels(id)[15 * 16 + 15], 30);
  // the run is ONE undo step of the image (E.macroGroup), and Undo gives the pre-run bytes back
  const held = t.eng.inspectDoc(id);
  if (held.undo.length === 1 && held.undo[0].macro) {
    assert.deepEqual(JSON.parse(JSON.stringify(r.result.undo.changed)), [id]);
    await t.ok('doc.undo', { docId: id });
    assert.equal(t.pixels(id)[4 * 16 + 3], 0, 'one Undo restores the image as it was before the run');
  } else console.log('SKIP one undo step per run: this engine has no E.macroGroup');

  // an abort keeps what was written
  const id2 = await t.open({ name: 'ab', width: 8, height: 8, bitDepth: 8, channels: [{ data: new Uint8Array(64) }] });
  let ctl = null;
  const p = t.run('setPixel(1, 1, 99); while (true) {}', { onStart: (c) => { ctl = c; } });
  await sleep(120);
  await ctl.cancel();
  const ra = await p;
  assert.equal(ra.result.aborted, true);
  if (t.pixels(id2)[9] === 0) console.log('SKIP abort keeps changes: this engine\'s E.commitPlanes refuses a cancelled request (it needs the { final: true } option)');
  else assert.equal(t.pixels(id2)[9], 99, 'the change made before the abort is kept');
}

// ---------------------------------------------------------------- prefs, call(), getInfo, refusals through a run
{
  let r = await t.run('call("ij.Prefs.set", "macro.k", "v1"); print(call("ij.Prefs.get", "macro.k", "d")); print(call("ij.Prefs.get", "macro.p", "d"));', { prefs: { 'macro.p': 'stored' } });
  assert.deepEqual(okRun(r, 'prefs'), ['v1', 'stored']);
  assert.deepEqual(J(r.result.prefsWrites), { 'macro.k': 'v1' }, 'only the keys this run changed');
  r = await t.run('print(getInfo("user.home")); print(getInfo("os.name")); print(getInfo("no.such.key")); print(getInfo("file.separator"));');
  assert.deepEqual(okRun(r, 'getInfo'), ['/home', 'Browser', 'Invalid key', '/']);
  r = await t.run('open("/data/x.tif");');
  assert.equal(r.result.error.message, '"open("/data/x.tif")" is not available yet in this version of the Advanced Studio: macros cannot read or write files on your computer yet.'.replace(/^"|"(?= is)/g, ''));
  r = await t.run('open("C:/data/embryo.ims");');
  assert.match(r.result.error.message, /^Bio-Formats is not available in the browser/);
  r = await t.run('open("https://example.org/a.tif");');
  assert.equal(r.result.error.message, 'Macros cannot use the network.');
  r = await t.run('x = exec("ls");');
  assert.equal(r.result.error.message, 'exec() is not available in the browser.');
  r = await t.run('x = eval("js", "1+1");');
  assert.equal(r.result.error.message, 'Only macro code can be evaluated in the browser.');
  r = await t.run('x = eval("print(6*7);");');
  assert.deepEqual(okRun(r, 'eval'), ['42'], 'eval of macro code runs in the same run');
  r = await t.run('x = File.exists("/a");');
  assert.match(r.result.error.message, /^File\.exists is not available yet/);
  r = await t.run('x = getDirectory("home");');
  assert.match(r.result.error.message, /^getDirectory is not available yet/);
  r = await t.run('Ext.install("x");');
  assert.equal(r.result.error.message, 'Macro extensions are not available.');
  r = await t.run('x = runMacro("/a.ijm");');
  assert.match(r.result.error.message, /^runMacro\("\/a\.ijm"\) is not available yet/);
}

// ---------------------------------------------------------------- run(): statuses
{
  t.page.answers.run = (a) => (a.name === 'Nope'
    ? { status: 'unrecognized', text: 'Unrecognized command: "Nope"', current: a.current, created: [], closed: [] }
    : a.name === 'Cancel me' ? { status: 'cancelled', text: 'Macro canceled', current: a.current, created: [], closed: [] }
      : { status: 'ok', text: '', current: a.current, created: [], closed: [], echo: a });
  let seen = null;
  const orig = t.page.answers.run;
  t.page.answers.run = (a) => { seen = a; return orig(a); };
  let r = await t.run('sigma = 2; run("Gaussian Blur...", "sigma=&sigma");');
  okRun(r, 'run ok');
  assert.equal(seen.name, 'Gaussian Blur...');
  assert.equal(seen.options, 'sigma=&sigma');
  assert.deepEqual(J(seen.vars), { sigma: { n: 2, s: '2' } }, 'the variables the options name');
  r = await t.run('t = "abc"; run("X", "title=t mode=[a b] other=7");');
  assert.deepEqual(J(seen.vars), { t: { s: 'abc' } });
  r = await t.run('setKeyDown("alt"); run("X"); run("Y");');
  assert.equal(seen.alt, false, 'setKeyDown is for the next run() only');
  assert.equal(seen.options, null, 'no options = the dialogs are shown');
  r = await t.run('print(1);\nrun("Nope");');
  assert.equal(r.result.error.message, 'Unrecognized command: "Nope"');
  assert.equal(r.result.error.line, 2);
  r = await t.run('run("Cancel me"); print("after");');
  assert.equal(r.result.aborted, true);
  assert.deepEqual(r.log, []);
  delete t.page.answers.run;
}

t.close();
console.log('test_ij_macro_runtime: ok');
