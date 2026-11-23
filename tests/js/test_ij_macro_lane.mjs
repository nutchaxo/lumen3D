// The macro lane of the page (DOCS/studio-advanced/macros/INTEGRATION.md §2.2 – §2.5): the menus are off while a macro runs and on
// again while it waits for the operator; a command it starts (api.macro.runCommand) runs with busy() re-entrant, its dialogs answered
// from the options (never shown, never previewed) or shown with the lane paused and closed by the run's end; asks that carry a macro
// answer take it; Process Stack? and the composite rule read `stack` / `slice`; every outcome is a status, never a modal.
// The other builders' files are stand-ins (tests/js/ij_macro_plumbing_fakes.mjs).
//
// Run: node tests/js/test_ij_macro_lane.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { boot, until, J } from './ij_harness.mjs';
import { FAKE_SOURCES, startRun } from './ij_macro_plumbing_fakes.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (err) { console.error('FAIL ' + name); throw err; }
}
const reject = async (p, code, what) => {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert.ok(err, what + ': it must reject');
  assert.equal(err.code, code, what + ': ' + (err && err.code));
};
const g = (t, name) => vm.runInContext('globalThis.' + name, t.page);
const tt = (t, key, p) => t.ctx.i18n.t(key, p);

async function start(more) {
  const t = await boot(Object.assign({}, FAKE_SOURCES, more || {}));
  const sh = await t.open();
  return { t, sh, api: t.api('macro'), id: t.activeId() };
}
/** A stack image (nZ planes of one or more channels) added through the page, shown and active. */
async function addStack(t, o) {
  const W = 8, H = 6, nZ = o.nZ || 3, nC = o.nC || 1;
  const channels = [];
  for (let c = 0; c < nC; c++) {
    const planes = [];
    for (let z = 0; z < nZ; z++) planes.push(new Uint8Array(W * H).map((_, i) => (i * 3 + z * 40 + c * 7) & 255));
    channels.push({ planes, name: 'C' + (c + 1), color: c ? '#00ff00' : '#ffffff' });
  }
  const id = await t.api(null).addDoc({ name: o.name || 'stk', width: W, height: H, bitDepth: 8, nZ, channels, mode: o.mode });
  return id;
}
const plane = async (t, docId, c, z) => (await t.engine('doc.tile', { docId, channel: c, level: 0, tx: 0, ty: 0, pos: { z, t: 0 } })).data.slice();

await test('the lane: menus off while a macro runs, on while it waits (pause/resume, idempotent); running(), signal(), the progress line; start refuses a second run', async () => {
  const { t, sh, api } = await start();
  assert.equal(sh.opts.getState().busy, false);
  assert.equal(api.macro.running(), null);
  assert.equal(api.macro.signal(), null);
  const run = await startRun(t, { runId: 'r1' });
  assert.deepEqual(J(api.macro.running()), { runId: 'r1', paused: false });
  assert.equal(sh.opts.getState().busy, true, 'snapshot().busy while the macro runs');
  assert.equal(t.isEnabled('editInvert'), false, 'a command is disabled');
  assert.equal(api.state().busy, false, 'state() of the api keeps the page\'s own busy (lane commands must not see themselves blocked)');
  const sig = api.macro.signal();
  assert.equal(sig.aborted, false);
  const prog = sh.progress[sh.progress.length - 1];
  assert.deepEqual(J(prog), { fraction: null, label: tt(t, 'op.macRun'), cancellable: true }, 'the run\'s own progress line');
  api.macro.progress(0.25);
  assert.equal(sh.progress[sh.progress.length - 1].fraction, 0.25, 'progress(fraction)');
  // the operator's menu click does nothing while the macro runs
  const before = (await t.pixels(t.activeId(), 0)).slice(0, 4);
  await sh.opts.onCommand(t.cmd('editInvert'), { source: 'menu' });
  assert.deepEqual((await t.pixels(t.activeId(), 0)).slice(0, 4), before, 'nothing ran');
  const resume = api.macro.pause();
  assert.deepEqual(J(api.macro.running()), { runId: 'r1', paused: true });
  assert.equal(sh.opts.getState().busy, false, 'the menus work while the macro waits for the operator');
  const r2 = api.macro.pause();
  r2(); r2();
  assert.equal(api.macro.running().paused, true, 'one resume() releases its own pause only, once');
  resume(); resume();
  assert.equal(api.macro.running().paused, false);
  assert.equal(sh.opts.getState().busy, true);
  await reject(api.macro.start({ runId: 'r2', source: 'y' }), 'IJ_MACRO_BUSY', 'a second run');
  // the run got the args of §3.1
  const a = run.first.args;
  assert.equal(a.name, 'Test');
  assert.deepEqual(J(a.options), { fastPath: true, syncLoops: false, syncRecursion: false });
  const res = await run.end();
  assert.equal(res.ok, true);
  assert.equal(api.macro.running(), null, 'the lane is gone');
  assert.equal(sig.aborted, true, 'its signal aborted at the end');
  assert.equal(sh.opts.getState().busy, false, 'the menus are back');
  assert.equal(sh.progress[sh.progress.length - 1], null, 'the progress line cleared');
  t.close();
});

await test('runCommand without a lane, unknown, refused (translated reason), disabled (own text / no image), failed (error / options text), and every answer is a status object', async () => {
  const { t, api } = await start();
  const none = await api.macro.runCommand('Invert', '', {});
  assert.equal(none.status, 'refused');
  assert.equal(none.text, tt(t, 'err.macBusy'));
  const run = await startRun(t);
  const asks0 = t.script.asks.length, specs0 = t.log.dialogSpecs.length;
  const nope = await api.macro.runCommand('Nope', null, {});
  assert.deepEqual(J(nope), { status: 'unrecognized', text: 'Unrecognized command: "Nope"', current: t.activeId(), created: [], closed: [] });
  const lib = await api.macro.runCommand('Open from Library...', '', {});
  assert.equal(lib.status, 'refused');
  assert.equal(lib.text, tt(t, 'err.macRefused', { command: 'Open from Library...', reason: tt(t, 'err.macReasonLibrary') }), 'the reason key is translated first');
  const later = await api.macro.runCommand('Open...', '', {});
  assert.equal(later.text, tt(t, 'err.macFileLater', { name: 'Open...' }));
  const next = await api.macro.runCommand('Next Image', '', {});
  assert.deepEqual([next.status, next.text], ['disabled', 'Next needs two images'], 'the entry\'s own ImageJ text');
  const fail = await api.macro.runCommand('Fail', '', {});
  assert.deepEqual([fail.status, fail.text], ['failed', tt(t, t.IJApp.ERROR_KEYS.IJ_BAD_ARGS)], 'a throw is a failed status with the translated sentence');
  const gone = await api.macro.runCommand('Gone', '', {});
  assert.deepEqual([gone.status, gone.text], ['failed', tt(t, t.IJApp.ERROR_KEYS.IJ_UNKNOWN_OP)], 'an error inside busy() is recorded, not shown');
  const bad = await api.macro.runCommand('Gaussian Blur...', 'sigma=bad', {});
  assert.deepEqual([bad.status, bad.text], ['failed', '"bad" is not a valid choice for "sigma"'], 'the options error text verbatim');
  assert.equal(t.script.asks.length, asks0, 'no ask, no error box');
  assert.equal(t.log.dialogSpecs.length, specs0, 'no dialog shown');
  assert.equal(t.errors.length, 0);
  await run.end();
  t.close();
});

await test('runCommand ok: dialogs answered headless (no dialog, no preview), source "macro", REPEAT untouched, &variables, created/closed/current, re-entrant busy', async () => {
  const { t, api, id } = await start();
  await t.runCommand('editInvert');     // the operator's last command
  assert.equal(t.api(null).lastCommand().id, 'editInvert');
  const run = await startRun(t);
  const specs0 = t.log.dialogSpecs.length, prev0 = t.log.previews.length;
  const gs = await api.macro.runCommand('Gaussian Blur...', 'sigma=2', { current: id });
  assert.deepEqual(J(gs), { status: 'ok', text: '', current: id, created: [], closed: [] });
  assert.equal(t.log.dialogSpecs.length, specs0, 'the dialog never reached the shell');
  assert.equal(t.log.previews.length, prev0, 'no preview ran');
  const h = g(t, '__headless');
  assert.equal(h[h.length - 1].commandId, 'filterGaussian');
  assert.equal(h[h.length - 1].dialogIndex, 0);
  const sent = t.log.msgs.filter((m) => m.cmd === 'doc.run' && m.args.op === 'gaussian');
  assert.equal(sent[sent.length - 1].args.params.sigma, 2, 'the op ran with the options\' sigma');
  const gv = await api.macro.runCommand('Gaussian Blur...', 'sigma=&s', { vars: { s: { n: 3, s: '3' } } });
  assert.equal(gv.status, 'ok');
  assert.equal(t.log.msgs.filter((m) => m.cmd === 'doc.run' && m.args.op === 'gaussian').pop().args.params.sigma, 3, 'a variable');
  assert.equal(t.api(null).lastCommand().id, 'editInvert', 'Repeat Command never remembers a macro command');
  const rn = await api.macro.runCommand('Run...', '', { alt: true });
  assert.equal(rn.status, 'ok');
  assert.deepEqual(J(g(t, '__mods')), { alt: true, shift: false, source: 'macro' });
  // a command that makes an image: created + current
  const dup = await api.macro.runCommand('Duplicate...', 'title=copy', {});
  assert.equal(dup.status, 'ok');
  assert.equal(dup.created.length, 1);
  assert.equal(dup.current, dup.created[0]);
  assert.equal(t.api(null).state().docs.find((d) => d.docId === dup.created[0]).name, 'copy');
  // two steps at once inside one command: both run (outside a macro the second would find the page busy)
  const tw = await api.macro.runCommand('Twice', '', {});
  assert.equal(tw.status, 'ok');
  assert.deepEqual(J(g(t, '__twice')), [true, true]);
  await run.end();
  await t.runCommand('zTwice');
  assert.deepEqual(J(g(t, '__twice')), [true, false], 'the operator\'s busy state still refuses a second step');
  t.close();
});

await test('interactive commands (options null): the operator answers with the lane paused; an abort closes the dialog through the signal and the status is cancelled', async () => {
  const { t, sh, api } = await start();
  const run = await startRun(t, { runId: 'ri' });
  let pausedSeen = null;
  t.script.dialogs.push((spec) => { pausedSeen = [api.macro.running().paused, sh.opts.getState().busy, !!spec.signal]; return { sigma: 1 }; });
  const ok = await api.macro.runCommand('Gaussian Blur...', null, {});
  assert.equal(ok.status, 'ok');
  assert.deepEqual(pausedSeen, [true, false, true], 'paused (menus on) while the dialog is open, with the run\'s signal');
  assert.equal(api.macro.running().paused, false, 'resumed after');
  // the operator cancels: the status is cancelled
  t.script.dialogs.push(null);
  const cancelled = await api.macro.runCommand('Gaussian Blur...', null, {});
  assert.deepEqual([cancelled.status, cancelled.text], ['cancelled', 'Macro canceled']);
  // a dialog left open: abort() ends the run (aborted), the dialog closes, the command answers cancelled
  t.script.dialogs.push(() => new Promise(() => {}));
  const pending = api.macro.runCommand('Gaussian Blur...', null, {});
  await until(() => api.macro.running() && api.macro.running().paused, 'the dialog is open');
  const t0 = Date.now();
  api.macro.abort();
  const res = await run.result;
  assert.equal(res.aborted, true, 'the run ended aborted');
  const st = await pending;
  assert.equal(st.status, 'cancelled', 'the dialog closed as cancelled');
  assert.ok(Date.now() - t0 < 1000, 'promptly');
  assert.equal(api.macro.running(), null);
  t.close();
});

await test('asks with a macro answer (Revert, 8-bit lossy, Histogram on a stack) take it silently; an ask without one is shown with the lane paused', async () => {
  const { t, api } = await start();
  await t.runCommand('editInvert');     // dirty: Revert is enabled
  const run = await startRun(t);
  const asks0 = t.script.asks.length;
  const rv = await api.macro.runCommand('Revert', '', {});
  assert.equal(rv.status, 'ok');
  assert.equal(t.script.asks.length, asks0, 'Revert? was answered by the macro');
  // 16-bit → 8-bit: the lossy question answered 'ok'
  const d16 = await t.api(null).addDoc({ name: 'sixteen', width: 4, height: 3, bitDepth: 16, channels: [{ data: new Uint16Array(12).fill(1000), name: 'A' }] });
  const cv = await api.macro.runCommand('8-bit', 'x', { current: d16 });
  assert.equal(cv.status, 'ok');
  assert.equal(t.script.asks.length, asks0, 'Convert? was answered by the macro');
  assert.equal((await t.engine('doc.info', { docId: d16 })).bitDepth, 8, 'converted');
  // Histogram on a stack: "Include all N images?" from the word `stack`
  const s = await addStack(t, { nZ: 3 });
  const n0 = t.log.msgs.filter((m) => m.cmd === 'doc.stackHistogram').length;
  const hs = await api.macro.runCommand('Histogram', 'stack', { current: s });
  assert.equal(hs.status, 'ok');
  assert.equal(t.log.msgs.filter((m) => m.cmd === 'doc.stackHistogram').length, n0 + 1, 'the whole stack');
  const hc = await api.macro.runCommand('Histogram', 'x', { current: s });
  assert.equal(hc.status, 'ok');
  assert.equal(t.log.msgs.filter((m) => m.cmd === 'doc.stackHistogram').length, n0 + 1, 'no `stack`: the current plane');
  assert.equal(t.script.asks.length, asks0, 'never asked');
  // an interactive Invert on a stack asks Process Stack? — shown to the operator, the lane paused meanwhile
  const realAsk = t.page.Dialog.ask;
  let seen = null;
  t.page.Dialog.ask = async (cfg) => { seen = api.macro.running().paused; return realAsk(cfg); };
  const iv = await api.macro.runCommand('Invert', null, { current: s });
  t.page.Dialog.ask = realAsk;
  assert.equal(iv.status, 'ok');
  assert.equal(seen, true, 'paused while the operator answers');
  await run.end();
  t.close();
});

await test('Process Stack? from the options: `stack` = every plane, its absence = the current one; a composite is whole unless `slice`', async () => {
  const { t, api } = await start();
  const s = await addStack(t, { nZ: 3 });
  const p0 = await Promise.all([0, 1, 2].map((z) => plane(t, s, 0, z)));
  const run = await startRun(t);
  const asks0 = t.script.asks.length;
  assert.equal((await api.macro.runCommand('Invert', 'stack', { current: s })).status, 'ok');
  const p1 = await Promise.all([0, 1, 2].map((z) => plane(t, s, 0, z)));
  for (let z = 0; z < 3; z++) assert.equal(p1[z][0], 255 - p0[z][0], 'plane ' + z + ' inverted');
  assert.equal((await api.macro.runCommand('Invert', 'x', { current: s })).status, 'ok');
  const p2 = await Promise.all([0, 1, 2].map((z) => plane(t, s, 0, z)));
  assert.equal(p2[0][0], p0[0][0], 'the current plane inverted back');
  assert.equal(p2[1][0], p1[1][0], 'the others untouched');
  // a two-channel composite stack: whole without `slice`, the plane on screen of the active channel with it
  const c = await addStack(t, { nZ: 2, nC: 2, name: 'comp', mode: 'composite' });
  const c0 = [await plane(t, c, 0, 0), await plane(t, c, 1, 1)];
  assert.equal((await api.macro.runCommand('Invert', 'x', { current: c })).status, 'ok');
  const c1 = [await plane(t, c, 0, 0), await plane(t, c, 1, 1)];
  assert.equal(c1[0][0], 255 - c0[0][0]); assert.equal(c1[1][0], 255 - c0[1][0], 'composite: every channel, every plane');
  assert.equal((await api.macro.runCommand('Invert', 'slice', { current: c })).status, 'ok');
  const c2 = [await plane(t, c, 0, 0), await plane(t, c, 1, 1)];
  assert.equal(c2[0][0], c0[0][0], 'slice: the active channel\'s current plane');
  assert.equal(c2[1][0], c1[1][0], 'another channel / plane untouched');
  assert.equal(t.script.asks.length, asks0, 'no Process Stack? question');
  await run.end();
  t.close();
});

await test('a failed package disables its commands for macros; with no image open a command says ImageJ\'s no-image text', async () => {
  const { t, api } = await start({ brokenPackages: ['ij-proc-seg.js'] });
  await until(() => t.failedPackages().has('seg'), 'seg failed');
  const run = await startRun(t);
  const seg = await api.macro.runCommand('Seg', '', {});
  assert.deepEqual([seg.status, seg.text], ['disabled', tt(t, 'warn.packageFailed', { pkg: 'seg' })]);
  // close every image through the macro api (no Save changes? question)
  const asks0 = t.script.asks.length;
  const ids = t.api(null).state().docs.map((d) => d.docId);
  const closed = await api.macro.closeImages(ids);
  assert.deepEqual(closed, ids);
  assert.equal(t.script.asks.length, asks0, 'closed without asking');
  const inv = await api.macro.runCommand('Invert', '', {});
  assert.deepEqual([inv.status, inv.text, inv.current], ['disabled', 'There are no images open', null]);
  await run.end();
  t.close();
});

await test('a headless doc field lists the batch images of the run (ImageJ ids for them), and they are gone at the end', async () => {
  const { t, api, id } = await start();
  const run = await startRun(t);
  await run.step({ op: 'batch', on: true });
  const made = await run.step({ op: 'create', w: 4, h: 4, fill: 9, name: 'batchy' });
  const docId = made.out.docId;
  assert.equal(made.out.hidden, true, 'born hidden in batch mode');
  const ijId = await api.macro.adopt(docId);
  assert.ok(ijId < 0, 'an ImageJ id');
  assert.equal(api.macro.docOf(ijId), docId);
  assert.equal(api.macro.ijId(docId), ijId, 'stable');
  const r = await api.macro.runCommand('Ask', 'n=5', {});
  assert.equal(r.status, 'ok');
  assert.equal(g(t, '__asked').n, 5);
  const h = g(t, '__headless');
  const docField = h[h.length - 1].fields.find((f) => f.id === 'img');
  assert.ok(docField.options.some((o) => o.value === docId), 'the hidden batch image is a choice during the run');
  assert.ok(docField.options.some((o) => o.value === id), 'so is the shown one');
  await run.end();
  assert.equal(t.api(null).state().docs.some((d) => d.docId === docId), false, 'gone at the end (nobody showed it)');
  t.close();
});

console.log(`test_ij_macro_lane: ${passed} passed`);
