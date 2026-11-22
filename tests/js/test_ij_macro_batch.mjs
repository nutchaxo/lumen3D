// Batch-mode images of a macro (DOCS/studio-advanced/macros/INTEGRATION.md §2.2, §2.6): an image born while the run's batch mode is on
// is hidden and EPHEMERAL — never a session entry, baseline, journal entry or snapshot, before or after the run — until doc.persist
// (api.macro.showImages) makes it an ordinary image; the page closes the ephemeral leftovers when the run ends (Interpreter.finishUp),
// and the active image falls back to a shown one.
//
// Run: node tests/js/test_ij_macro_batch.mjs
import assert from 'node:assert/strict';
import { boot, until, J } from './ij_harness.mjs';
import { FAKE_SOURCES, startRun, engineStep } from './ij_macro_plumbing_fakes.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (err) { console.error('FAIL ' + name); throw err; }
}

/** Every stored record of a document, in every session of the storage. */
async function storedOf(t, docId) {
  const out = [];
  for (const s of await t.store.shared.list()) {
    const got = await t.store.shared.load(s.key);
    if (got && got.docs && got.docs[docId]) out.push({ key: s.key, rec: got.docs[docId] });
  }
  return out;
}

await test('engine: batch images are hidden + ephemeral and never stored; doc.persist during the run stores the image at the end; batch off makes ordinary images again', async () => {
  const t = await boot(FAKE_SOURCES);
  const w = await t.spawn();
  const run = t.engine('macro.run', { runId: 'b1', mirror: {} }, w);
  await until(() => t.log.events.some((e) => e.event === 'ext:macro.ack' && e.runId === 'b1'), 'open');
  await engineStep(t, w, 'b1', 1, { op: 'batch', on: true });
  const a = (await engineStep(t, w, 'b1', 2, { op: 'create', w: 8, h: 8, fill: 1, name: 'eph' })).out;
  assert.equal(a.hidden, true);
  assert.equal(a.ephemeral, true, 'info.ephemeral');
  await engineStep(t, w, 'b1', 3, { op: 'commit', docId: a.docId, value: 5 });
  const b = (await engineStep(t, w, 'b1', 4, { op: 'create', w: 8, h: 8, fill: 2, name: 'shown' })).out;
  const persisted = await t.engine('doc.persist', { docId: b.docId }, w);
  assert.deepEqual([persisted.info.ephemeral, persisted.info.hidden], [false, false], 'doc.persist');
  await engineStep(t, w, 'b1', 5, { op: 'batch', on: false });
  const c = (await engineStep(t, w, 'b1', 6, { op: 'create', w: 8, h: 8, fill: 3, name: 'plain' })).out;
  assert.deepEqual([c.ephemeral, c.hidden], [false, false], 'batch off: an ordinary image');
  const fl = await t.engine('flush', {}, w);
  assert.equal(fl.ok, true, 'an ephemeral image is never "unsafe"');
  await w.engine.whenIdle();
  for (const d of [a, b, c]) assert.equal((await storedOf(t, d.docId)).length, 0, d.name + ': nothing stored during the run');
  await engineStep(t, w, 'b1', 7, { op: 'end' });
  const res = await run;
  assert.equal(res.ok, true);
  await t.engine('flush', {}, w);
  await w.engine.whenIdle();
  assert.equal((await storedOf(t, a.docId)).length, 0, 'the ephemeral image: no session entry, baseline, journal or snapshot after the run either');
  const sb = await storedOf(t, b.docId), sc = await storedOf(t, c.docId);
  assert.equal(sb.length, 1, 'the persisted image is stored at the end');
  assert.ok(sb[0].rec.baseline, 'with its baseline');
  assert.ok(sc.length === 1 && sc[0].rec.baseline, 'the ordinary one too');
  // the ephemeral image after the run: still nothing; doc.persist now writes it at once
  await t.engine('doc.run', { docId: a.docId, op: 'invert', params: {}, roi: null, channel: 0 }, w);
  await t.engine('flush', {}, w);
  await w.engine.whenIdle();
  assert.equal((await storedOf(t, a.docId)).length, 0, 'an edit after the run does not store it');
  await t.engine('doc.persist', { docId: a.docId }, w);
  await t.engine('flush', {}, w);
  await w.engine.whenIdle();
  const sa = await storedOf(t, a.docId);
  assert.ok(sa.length === 1 && sa[0].rec.baseline, 'persisted after the run: stored like any image');
  t.close();
});

await test('page: a batch image has no view and no menu entry, the mirror shows it; showImages makes it a shown, persistent image; the leftovers are closed at the end and the active image falls back to a shown one', async () => {
  const t = await boot(FAKE_SOURCES);
  const sh = await t.open();
  const api = t.api('macro');
  const shown0 = t.activeId();
  const run = await startRun(t);
  await run.step({ op: 'batch', on: true });
  const a = (await run.step({ op: 'create', w: 5, h: 5, fill: 1, name: 'left' })).out.docId;
  const b = (await run.step({ op: 'create', w: 5, h: 5, fill: 2, name: 'keep' })).out.docId;
  await api.macro.adopt(a);
  await api.macro.adopt(b);
  assert.equal(t.view(a), null, 'no view');
  assert.ok(!t.api(null).state().docs.some((d) => d.docId === a), 'no menu entry / no choice for the operator');
  const m = api.macro.mirror();
  const ma = m.images.find((i) => i.docId === a);
  assert.deepEqual([ma.hidden, ma.ephemeral, ma.title], [true, true, 'left'], 'the mirror lists the batch image');
  // the macro selects a hidden image: the page's active image without any layout change
  const adds0 = sh.lay.adds.length;
  await api.macro.selectImage(a);
  assert.equal(api.macro.mirror().current, a);
  assert.equal(sh.lay.adds.length, adds0, 'no view was made');
  await api.macro.showImages([b]);
  assert.ok(t.view(b), 'shown');
  const ib = await t.engine('doc.info', { docId: b });
  assert.deepEqual([ib.ephemeral, ib.hidden], [false, false], 'persistent now');
  await api.macro.selectImage(a);
  const res = await run.end();
  assert.equal(res.ok, true);
  const list = (await t.docs()).map((d) => d.docId);
  assert.ok(!list.includes(a), 'the leftover batch image was closed in the engine');
  assert.ok(list.includes(b) && list.includes(shown0), 'the shown ones stay');
  assert.ok(!t.api(null).state().docs.some((d) => d.docId === a));
  const active = t.api(null).state().doc;
  assert.ok(active && active.docId !== a && !active.hidden, 'the active image is a shown one again');
  assert.equal(t.errors.length, 0, 'no error box');
  t.close();
});

await test('page: an ephemeral image the page never adopted (E.createDoc without image.adopt) is closed too; one closed during the run leaves the run', async () => {
  const t = await boot(FAKE_SOURCES);
  await t.open();
  const api = t.api('macro');
  const run = await startRun(t);
  await run.step({ op: 'batch', on: true });
  const x = (await run.step({ op: 'create', w: 3, h: 3, name: 'orphan' })).out.docId;
  const y = (await run.step({ op: 'create', w: 3, h: 3, name: 'closed' })).out.docId;
  await api.macro.adopt(y);
  const closed = await api.macro.closeImages([y]);
  assert.deepEqual(J(closed), [y]);
  await run.step({ op: 'commit', docId: t.activeId(), value: 4 });
  const res = await run.end();
  assert.equal(res.ok, true, 'the end of the run does not trip over the closed image');
  const list = (await t.docs()).map((d) => d.docId);
  assert.ok(!list.includes(x) && !list.includes(y), 'neither is left in the engine');
  t.close();
});

console.log(`test_ij_macro_batch: ${passed} passed`);
