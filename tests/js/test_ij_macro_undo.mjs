// One macro run = ONE undo step per image it changed (DOCS/studio-advanced/macros/INTEGRATION.md §2.6, §2.7): the engine holds every
// image open at E.macroGroup.begin (and every image born during the run): no undo record, journal entry or snapshot of its own; Undo /
// Redo refuse IJ_MACRO_GROUP meanwhile; end pushes one step back to the saved state (applied like Revert's, the selection kept); memory
// pressure gives a saved state up last (that image: no undo for the run); a crash mid-run restores the pre-run state from storage.
//
// Run: node tests/js/test_ij_macro_undo.mjs
import assert from 'node:assert/strict';
import { boot, until, J } from './ij_harness.mjs';
import { FAKE_SOURCES, startRun, engineStep } from './ij_macro_plumbing_fakes.mjs';

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
const arr = (a) => Array.from(a);

await test('page: Invert (page command) + a worker commit + a worker op on one image, a second image changed, a third untouched, a born one → one undo step each where it changed; Undo restores, Redo re-does', async () => {
  const t = await boot(FAKE_SOURCES);
  await t.open();
  const api = t.api('macro');
  const a = t.activeId();
  const b = await t.api(null).addDoc({ name: 'b', width: 6, height: 4, bitDepth: 8, channels: [{ data: new Uint8Array(24).fill(10), name: 'B' }] });
  const c = await t.api(null).addDoc({ name: 'c', width: 6, height: 4, bitDepth: 8, channels: [{ data: new Uint8Array(24).fill(20), name: 'C' }] });
  await t.api(null).setPosition({ c: 0 }, { docId: a });
  await t.api(null).setPosition({}, { docId: a });
  t.api(null).setRoi({ type: 'rect', x: 1, y: 1, w: 5, h: 5 }, { docId: a });
  const info0 = { a: await t.engine('doc.info', { docId: a }), b: await t.engine('doc.info', { docId: b }), c: await t.engine('doc.info', { docId: c }) };
  const px0 = { a0: arr(await t.pixels(a, 0)), a1: arr(await t.pixels(a, 1)), b: arr(await t.pixels(b, 0)) };
  const run = await startRun(t);
  assert.deepEqual(J(run.first.begun).sort(), [a, b, c].sort(), 'every open image is held');
  // a step of the page inside the run (the Invert command on a): no undo record of its own
  const inv = await api.macro.runCommand('Invert', 'x', { current: a });
  assert.equal(inv.status, 'ok');
  assert.equal((await t.engine('doc.info', { docId: a })).undoDepth, info0.a.undoDepth, 'no step pushed during the run');
  await reject(t.engine('doc.undo', { docId: a }), 'IJ_MACRO_GROUP', 'Undo during the run');
  await reject(t.engine('doc.redo', { docId: a }), 'IJ_MACRO_GROUP', 'Redo during the run');
  await run.step({ op: 'commit', docId: a, c: 1 });
  await run.step({ op: 'runOp', docId: a, name: 'invert', params: {}, o: { channel: 0 } });
  await run.step({ op: 'commit', docId: b, value: 77 });
  const born = await run.step({ op: 'create', w: 3, h: 3, fill: 5, name: 'born' });
  const bornId = born.out.docId;
  assert.equal(born.out.hidden, false, 'not in batch mode: an ordinary image');
  const res = await run.end();
  assert.deepEqual(J(res.undo.dropped), []);
  assert.ok(res.undo.changed.includes(a) && res.undo.changed.includes(b) && !res.undo.changed.includes(c), 'changed: a and b');
  const after = { a: await t.engine('doc.info', { docId: a }), b: await t.engine('doc.info', { docId: b }), c: await t.engine('doc.info', { docId: c }), n: await t.engine('doc.info', { docId: bornId }) };
  assert.equal(after.a.undoDepth, info0.a.undoDepth + 1, 'ONE step for a (three changes)');
  assert.equal(after.b.undoDepth, info0.b.undoDepth + 1, 'one for b');
  assert.equal(after.c.undoDepth, info0.c.undoDepth, 'none for the untouched c');
  assert.equal(after.n.undoDepth, 0, 'none for the image born in the run');
  const pxRun = { a0: arr(await t.pixels(a, 0)), a1: arr(await t.pixels(a, 1)), b: arr(await t.pixels(b, 0)) };
  // channel 0: inverted inside the selection by the command, then everywhere by the worker op = the original inside, inverted outside
  const W = info0.a.width;
  assert.equal(pxRun.a0[2 * W + 2], px0.a0[2 * W + 2], 'inside the selection: inverted twice');
  assert.equal(pxRun.a0[0], 255 - px0.a0[0], 'outside: inverted once');
  assert.notDeepEqual(pxRun.a1, px0.a1);
  assert.deepEqual(pxRun.b, new Array(24).fill(77));
  // the page knows the new undo depth (lane end re-read the changed images)
  assert.equal(t.api(null).state().docs.find((d) => d.docId === a).undoDepth, info0.a.undoDepth + 1);
  // Undo restores everything the run did to a, in one step
  const u = await t.engine('doc.undo', { docId: a });
  assert.equal(u.changed.sizeChanged, true, 'applied as a full record');
  assert.equal(u.changed.sameGeometry, true, 'the pixel grid did not move: the page keeps selection, overlays and view');
  assert.deepEqual(arr(await t.pixels(a, 0)), px0.a0);
  assert.deepEqual(arr(await t.pixels(a, 1)), px0.a1, 'Undo restores the pre-run bytes');
  const r = await t.engine('doc.redo', { docId: a });
  assert.equal(r.changed.sameGeometry, true);
  assert.deepEqual(arr(await t.pixels(a, 1)), pxRun.a1, 'Redo restores the result');
  assert.deepEqual(arr(await t.pixels(a, 0)), pxRun.a0);
  const ub = await t.engine('doc.undo', { docId: b });
  assert.equal(ub.changed.sameGeometry, true);
  assert.deepEqual(arr(await t.pixels(b, 0)), px0.b, 'b back too');
  t.close();
});

await test('page Undo command after a run: one Undo restores the image, the selection survives (sameGeometry), Redo re-does', async () => {
  const t = await boot(FAKE_SOURCES);
  await t.open();
  const api = t.api('macro');
  const a = t.activeId();
  t.api(null).setRoi({ type: 'rect', x: 2, y: 2, w: 4, h: 3 }, { docId: a });
  const px0 = arr(await t.pixels(a, 1));
  const run = await startRun(t);
  await run.step({ op: 'commit', docId: a, c: 1 });
  await run.step({ op: 'commit', docId: a, c: 1, value: 3 });
  await run.end();
  assert.deepEqual(arr(await t.pixels(a, 1)), new Array(px0.length).fill(3));
  await t.runCommand('editUndo');
  assert.deepEqual(arr(await t.pixels(a, 1)), px0, 'one Undo, the original bytes');
  assert.deepEqual(J(t.api(null).state().roi), { type: 'rect', x: 2, y: 2, w: 4, h: 3 }, 'the selection survived the undo');
  await t.runCommand('editRedo');
  assert.deepEqual(arr(await t.pixels(a, 1)), new Array(px0.length).fill(3), 'Redo');
  void api;
  t.close();
});

await test('memory: a saved pre-run state counts against the budget and is given up last (after every undo step); that image gets no undo for the run (dropped)', async () => {
  const t = await boot(Object.assign({}, FAKE_SOURCES, { budgetBytes: 512 * 1024 }));
  const w = await t.spawn();
  const d = await t.engine('doc.create', { name: 'big', width: 256, height: 256, bitDepth: 8, channels: [{ name: 'A', color: '#fff' }] }, w);
  await t.flush();
  await w.engine.whenIdle();
  // an older undo step of the image, given up before the saved state
  await t.engine('doc.run', { docId: d.docId, op: 'invert', params: {}, roi: null, channel: 0 }, w);
  await t.flush();
  await w.engine.whenIdle();
  const used0 = w.engine.usedBytes();
  const run = t.engine('macro.run', { runId: 'm1', mirror: {} }, w);
  await until(() => t.log.events.some((e) => e.event === 'ext:macro.ack' && e.runId === 'm1'), 'open');
  await engineStep(t, w, 'm1', 1, { op: 'commit', docId: d.docId, value: 9 });
  assert.ok(w.engine.usedBytes() >= used0 + 65536 - 1, 'the saved plane is still counted');
  // room for 420 KiB: tiles, then the old undo step, then the saved state
  const big = await engineStep(t, w, 'm1', 2, { op: 'reserve', bytes: 420 * 1024 });
  assert.equal(big.error, undefined, 'the reservation fitted: ' + big.error);
  assert.equal(w.engine.inspectDoc(d.docId).undo.length, 0, 'the old undo step went first');
  await engineStep(t, w, 'm1', 3, { op: 'end' });
  const res = await run;
  assert.deepEqual(J(res.undo.dropped), [d.docId], 'the run reports the image whose undo was given up');
  const info = await t.engine('doc.info', { docId: d.docId }, w);
  assert.equal(info.undoDepth, 0, 'no undo step for the run');
  t.close();
});

await test('deferred journal: nothing of a held image is stored during the run; a crash mid-run restores the pre-run state; after a normal end the snapshot holds the result', async () => {
  const t = await boot(FAKE_SOURCES);
  const w = await t.spawn();
  const d = await t.engine('doc.create', { name: 'kept', width: 16, height: 8, bitDepth: 8, channels: [{ name: 'A', color: '#fff' }] }, w);
  await t.engine('doc.run', { docId: d.docId, op: 'invert', params: {}, roi: null, channel: 0 }, w);
  await t.flush();
  await w.engine.whenIdle();
  const key = (await t.store.shared.list())[0].key;
  const stored0 = (await t.store.shared.load(key)).docs[d.docId];
  const journal0 = (stored0.journal || []).length;
  const snapRev0 = stored0.snapshot ? stored0.snapshot.rev : -1;
  const pre = arr(await t.pixels(d.docId, 0));
  const run = t.engine('macro.run', { runId: 'c1', mirror: {} }, w);
  run.catch(() => {});
  await until(() => t.log.events.some((e) => e.event === 'ext:macro.ack' && e.runId === 'c1'), 'open');
  await engineStep(t, w, 'c1', 1, { op: 'commit', docId: d.docId, value: 42 });
  await engineStep(t, w, 'c1', 2, { op: 'runOp', docId: d.docId, name: 'invert', params: {}, o: { channel: 0 } });
  await t.engine('doc.rename', { docId: d.docId, name: 'renamed' }, w);
  await t.engine('doc.setDisplay', { docId: d.docId, channel: 0, min: 1, max: 9 }, w);
  const fl = await t.engine('flush', {}, w);
  assert.equal(fl.ok, true, 'a held image is not "unsafe": its stored state is the pre-run one');
  await w.engine.whenIdle();
  const stored1 = (await t.store.shared.load(key)).docs[d.docId];
  assert.equal((stored1.journal || []).length, journal0, 'no journal entry during the run');
  assert.equal(stored1.snapshot ? stored1.snapshot.rev : -1, snapRev0, 'no snapshot during the run');
  // crash: the worker dies mid-run, a new page restores from storage
  const t2 = await t.reload({ flush: false });
  const w2 = await t2.spawn();
  const rs = await t2.engine('session.restore', { key }, w2);
  assert.equal(rs.warnings.length, 0, JSON.stringify(rs.warnings));
  assert.deepEqual(arr(await t2.pixels(d.docId, 0)), pre, 'the pre-run pixels');
  // a normal end: one snapshot with the result
  const run2 = t2.engine('macro.run', { runId: 'c2', mirror: {} }, w2);
  await until(() => t2.log.events.some((e) => e.event === 'ext:macro.ack' && e.runId === 'c2'), 'open 2');
  await engineStep(t2, w2, 'c2', 1, { op: 'commit', docId: d.docId, value: 7 });
  await engineStep(t2, w2, 'c2', 2, { op: 'end' });
  await run2;
  await t2.flush();
  await w2.engine.whenIdle();
  const t3 = await t2.reload({ flush: false });
  const w3 = await t3.spawn();
  await t3.engine('session.restore', { key }, w3);
  assert.deepEqual(arr(await t3.pixels(d.docId, 0)), new Array(128).fill(7), 'the end of the run stored its result');
  t3.close();
});

await test('E.done(): a run that forgets to end its group gets it ended when the request ends; end() is idempotent', async () => {
  const t = await boot(FAKE_SOURCES);
  const w = await t.spawn();
  const d = await t.engine('doc.create', { name: 'x', width: 4, height: 4, bitDepth: 8, channels: [{ name: 'A', color: '#fff' }] }, w);
  const run = t.engine('macro.run', { runId: 'f1', mirror: {}, skipEnd: true }, w);
  await until(() => t.log.events.some((e) => e.event === 'ext:macro.ack' && e.runId === 'f1'), 'open');
  await engineStep(t, w, 'f1', 1, { op: 'commit', docId: d.docId, value: 1 });
  await engineStep(t, w, 'f1', 2, { op: 'end' });
  await run;
  await until(() => !w.engine.inspectDoc(d.docId).macroHold, 'the group was ended for it');
  assert.equal((await t.engine('doc.info', { docId: d.docId }, w)).undoDepth, 1, 'its one undo step');
  await t.engine('doc.undo', { docId: d.docId }, w);
  // a second run can open a group again
  const run2 = t.engine('macro.run', { runId: 'f2', mirror: {} }, w);
  await until(() => t.log.events.some((e) => e.event === 'ext:macro.ack' && e.runId === 'f2'), 'open 2');
  await engineStep(t, w, 'f2', 1, { op: 'commit', docId: d.docId, value: 2 });
  const twice = await engineStep(t, w, 'f2', 2, { op: 'endTwice' });
  assert.equal(twice.out.same, true, "a second end() answers the first one's result");
  assert.deepEqual(J(twice.out.first.changed), [d.docId]);
  await engineStep(t, w, 'f2', 3, { op: 'end' });
  const res2 = await run2;
  assert.deepEqual(J(res2.undo.changed), [d.docId], "the run's own end() after it: the same answer again");
  assert.equal((await t.engine('doc.info', { docId: d.docId }, w)).undoDepth, 1, 'still ONE step');
  t.close();
});

console.log(`test_ij_macro_undo: ${passed} passed`);
