// Macro plumbing, loading side (DOCS/studio-advanced/macros/INTEGRATION.md §1, §2.1): the macro language is part of package `macro`
// (PACKAGE_PRE, loaded right before ij-proc-macro.js in the same try/catch), a broken language file withdraws the package and nothing
// else, and the `passive` worker commands only package `macro` may call — answered without a busy state.
//
// Run: node tests/js/test_ij_macro_plumbing.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, until, DIR } from './ij_harness.mjs';
import { FAKE_SOURCES, WORKER_MACRO, VFS_STANDIN } from './ij_macro_plumbing_fakes.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (err) { console.error('FAIL ' + name); throw err; }
}
const reject = async (p, code, what) => {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert.ok(err, what + ': it must reject');
  assert.equal(err.code, code, what + ': ' + (err && err.code));
  return err;
};
const throwsCode = (fn, code, what) => {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, what + ': it must throw');
  assert.equal(err.code, code, what + ': ' + (err && err.code));
};

await test('WORKER_SCRIPTS ends with ij-proc-macro.js; PACKAGE_PRE puts the language before it; workerInit gives the package its `pre` urls', async () => {
  const t = await boot(FAKE_SOURCES);
  const A = t.IJApp;
  assert.equal(A.WORKER_SCRIPTS[A.WORKER_SCRIPTS.length - 1], 'ij-proc-macro.js', 'the last worker script');
  assert.ok(A.PACKAGE_NAMES.includes('macro'), 'macro is a package');
  assert.deepEqual(Array.from(A.PACKAGE_PRE.macro), ['ij-macro-lang.js', 'ij-macro-vfs.js', 'ij-macro-params.js', 'ij-macro-math.js'], 'the language, its virtual file system (FILES.md §10.1), the #@ parser and the Math macro op (EXTRAS.md §2)');
  assert.ok(Object.isFrozen(A.PACKAGE_PRE), 'PACKAGE_PRE is frozen');
  const init = A.workerInit({ fileUrl: (f) => 'u:' + f });
  const mac = init.packages.find((p) => p.pkg === 'macro');
  assert.deepEqual(JSON.parse(JSON.stringify(mac)), { pkg: 'macro', url: 'u:ij-proc-macro.js', pre: ['u:ij-macro-lang.js', 'u:ij-macro-vfs.js', 'u:ij-macro-params.js', 'u:ij-macro-math.js'] });
  assert.ok(init.packages.filter((p) => p.pkg !== 'macro').every((p) => p.pre === undefined), 'no other package has a pre');
  assert.ok(!init.scripts.includes('u:ij-macro-lang.js'), 'the language is not a mandatory script');
  // the macro group of the menus and the settings prefix
  assert.deepEqual(JSON.parse(JSON.stringify(A.GROUP_META['Plugins/Macros'])), { order: 5 });
  // plugin.json loads the page files in the contract's order
  const pj = JSON.parse(fs.readFileSync(path.join(DIR, 'plugin.json'), 'utf8')).scripts;
  const at = (f) => pj.indexOf(f);
  assert.ok(at('ij-proc-stk.js') < at('ij-proc-macro.js') && at('ij-proc-macro.js') < at('ij-macro-cmds.js') && at('ij-macro-cmds.js') < at('ij-view.js'), 'ij-proc-macro.js, ij-macro-cmds.js before ij-view.js');
  assert.equal(pj[pj.length - 1], 'ij-cmds-macro.js', 'ij-cmds-macro.js last');
  assert.ok(!pj.includes('ij-macro-lang.js'), 'the language is never loaded on the page');
  t.close();
});

await test('the worker loads ij-macro-lang.js then ij-proc-macro.js: the language is there when the package runs', async () => {
  const probe = WORKER_MACRO + `\n;self.__sawLanguage = typeof IJMacro !== 'undefined' && typeof IJMacro.run === 'function';`;
  const t = await boot({ workerSources: { 'ij-proc-macro.js': probe, 'ij-macro-vfs.js': VFS_STANDIN }, pageSources: FAKE_SOURCES.pageSources });
  const w = await t.spawn();
  assert.equal(t.failedPackages().size, 0, 'no package failed');
  assert.equal(w.far.__sawLanguage, true, 'IJMacro was loaded before the package file');
  const order = [];
  t.close();
  // the order of importScripts: the language right before the package, in one call
  const t2 = await boot(Object.assign({}, FAKE_SOURCES));
  const w2 = new t2.page.Worker('asset/ij-worker.js');
  const real = w2.far.importScripts;
  w2.far.importScripts = (...urls) => { order.push(urls.map(String)); return real(...urls); };
  w2.onmessage = () => {};
  w2.postMessage({ init: Object.assign(t2.IJApp.workerInit(t2.ctx.plugin), { budgetBytes: 1 << 30 }) });
  await until(() => t2.log.events.some((e) => e.event === 'ready'), 'engine ready');
  assert.deepEqual(order[order.length - 1], ['blob:ij-macro-lang.js', 'blob:ij-macro-vfs.js', 'blob:ij-macro-params.js', 'blob:ij-macro-math.js', 'blob:ij-proc-macro.js'], 'one importScripts call: language, file system, #@ parser, Math op, then package');
  t2.close();
});

await test('a broken ij-macro-lang.js withdraws package macro alone: ij-proc-macro.js never runs, the engine and the other packages work, the page disables the macro commands', async () => {
  for (const broken of [{ workerSources: { 'ij-macro-lang.js': 'throw new Error("the language does not load");', 'ij-proc-macro.js': WORKER_MACRO, 'ij-macro-vfs.js': VFS_STANDIN } },
    { workerSources: { 'ij-proc-macro.js': WORKER_MACRO, 'ij-macro-vfs.js': VFS_STANDIN }, brokenPackages: ['ij-macro-lang.js'] }]) {
    const t = await boot(Object.assign({}, broken, { pageSources: FAKE_SOURCES.pageSources }));
    const sh = await t.open();
    await until(() => t.failedPackages().has('macro'), 'packageFailed macro');
    assert.deepEqual([...t.failedPackages()], ['macro'], 'only package macro failed');
    assert.notEqual(t.worker.far.__macroLoaded, true, 'ij-proc-macro.js never ran without its language');
    assert.equal(t.worker.far.IJOpRegistry.getCommand('macro.run'), null, 'no worker command of the package');
    // the engine works, so does another package (stk's ops)
    const docs = await t.docs();
    assert.equal(docs.length, 1, 'the engine runs');
    assert.ok(t.worker.far.IJOpRegistry.get('invert'), 'built-in ops are there');
    assert.ok(t.worker.far.IJOpRegistry.list().some((n) => t.worker.far.IJOpRegistry.get(n) && /stk/i.test(n)), 'the stk package loaded');
    await t.runCommand('editInvert');
    // the page: the macro commands are greyed and say why; api.call and api.macro.start answer IJ_MODULE_MISSING
    const mac = t.cmd('macRun');
    assert.equal(mac.enabled(sh.opts.getState()), false, 'Run... is disabled');
    const listed = sh.opts.commands.find((c) => c.id === 'macRun');
    assert.equal(listed.unavailable(), true, 'the menu marks it unavailable');
    const api = t.api('macro');
    await reject(api.call('macro.echo', { v: 1 }), 'IJ_MODULE_MISSING', 'api.call of a command of the failed package');
    await reject(api.macro.start({ runId: 'r1', source: 'x' }), 'IJ_MODULE_MISSING', 'macro.start');
    assert.equal(api.macro.running(), null, 'no lane was opened');
    t.close();
  }
});

await test('defineCommand: `passive` must be a boolean', async () => {
  const t = await boot(FAKE_SOURCES);
  const R = t.page.IJOpRegistry;
  throwsCode(() => R.defineCommand('doc.x.bad', { pkg: 'fiji', passive: 'yes', handler() {} }), 'IJ_BAD_ARGS', 'passive: a string');
  R.defineCommand('doc.x.ok', { pkg: 'fiji', passive: false, handler() {} });
  assert.equal(R.getCommand('macro.reply').passive, true, 'the stand-in reply is passive');
  t.close();
});

await test('api.call of a passive command: package macro only, no busy state, no progress, nothing re-read; a non-passive call keeps its busy state', async () => {
  const t = await boot(Object.assign({}, FAKE_SOURCES, {
    workerSources: { 'ij-proc-macro.js': WORKER_MACRO, 'ij-macro-vfs.js': VFS_STANDIN, 'ij-proc-fiji.js': `IJOpRegistry.defineCommand('doc.fiji.quiet', { pkg: 'fiji', passive: true, handler: () => ({ q: 1 }) });` },
    pageSources: Object.assign({}, FAKE_SOURCES.pageSources, { 'ij-proc-fiji.js': `IJOpRegistry.defineCommand('doc.fiji.quiet', { pkg: 'fiji', passive: true, handler: () => ({ q: 1 }) });` })
  }));
  const sh = await t.open();
  const api = t.api('macro');
  const p0 = sh.progress.length, m0 = sh.menuRefreshes;
  const r = await api.call('macro.reply', { runId: 'nobody', step: null });
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { queued: false }, 'answered by the worker');
  assert.equal(sh.progress.length, p0, 'no progress line');
  assert.equal(sh.menuRefreshes, m0, 'no busy state (the menus were not refreshed)');
  // another package may not call a passive command, even its own
  await reject(t.api('fiji').call('doc.fiji.quiet', {}), 'IJ_EXT_FORBIDDEN', 'a passive command of another package');
  // a non-passive macro command goes through busy(): a progress line appears and goes
  const p1 = sh.progress.length;
  const e = await api.call('macro.echo', { v: 7 });
  assert.equal(e.v, 7);
  assert.ok(sh.progress.length > p1, 'the ordinary call showed its progress');
  t.close();
});

await test('E.request / E.pixelBytes / E.onCancel / E.macroGroup are members of a worker command context; E.request refuses what is not on its list', async () => {
  const t = await boot(FAKE_SOURCES);
  const w = await t.spawn();
  const d = await t.engine('doc.create', { name: 'a', width: 8, height: 4, bitDepth: 8, channels: [{ name: 'A', color: '#fff' }, { name: 'B', color: '#f00' }] }, w);
  const run = t.engine('macro.run', { runId: 'e1', mirror: {} }, w);
  await until(() => t.log.events.some((x) => x.event === 'ext:macro.ack' && x.runId === 'e1' && x.n === 0), 'run open');
  const step = async (k, s) => { await t.engine('macro.reply', { runId: 'e1', step: s }, w); return until(() => t.log.events.find((x) => x.event === 'ext:macro.ack' && x.runId === 'e1' && x.n === k), 'step ' + k); };
  const info = await step(1, { op: 'request', cmd: 'doc.info', args: { docId: d.docId } });
  assert.equal(info.out.docId, d.docId, 'doc.info in-process');
  const stats = await step(2, { op: 'request', cmd: 'doc.stats', args: { docId: d.docId, roi: null, channel: 0, measurements: ['mean'] } });
  assert.ok(stats.out && stats.out.row, 'doc.stats answers like the page request');
  const bad = await step(3, { op: 'request', cmd: 'doc.close', args: { docId: d.docId } });
  assert.equal(bad.error, 'IJ_BAD_ARGS', 'doc.close is not on the list');
  const px = await step(4, { op: 'pixelBytes' });
  assert.equal(px.out, 8 * 4 * 2, 'the planes of every open document');
  const again = await step(5, { op: 'beginAgain' });
  assert.equal(again.error, 'IJ_MACRO_BUSY', 'one macro group at a time');
  await step(6, { op: 'end' });
  const res = await run;
  assert.equal(res.ok, true);
  t.close();
});

console.log(`test_ij_macro_plumbing: ${passed} passed`);
