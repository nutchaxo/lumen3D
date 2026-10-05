// "Data updates" queue (js/pages/admin/migration-runner.js), SPEC §2, §6, §9:
//   • migrationChain: a dataset two versions behind gets m002 then a (simulated) m003, in
//     registry order whatever order the server lists them; types gate; repair re-runs the
//     producer of the current version; a job left by an earlier session runs first;
//   • buildQueue: datasets one after another, each one's migrations in order;
//   • Runner over a fake server journal: plan → units → finalize per migration, in order,
//     every unit done exactly once; pause mid-job then resume (from the journal, as after a
//     reload: a fresh Runner) finishes the remaining units only; an executor switch while
//     paused continues the same journal with server `unit_run`; a fatal unit failure fails
//     that dataset (its later migrations dropped) and the queue moves on; a 401 pauses.
//
// Run: node tests/js/test_mig_client_queue.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './harness.mjs';

const M = await import(pathToFileURL(path.join(ROOT, 'js/pages/admin/migration-runner.js')).href);
const { migrationChain, buildQueue, Runner, Meter, sampleEvenly, remainingUnits, runBrowserUnits } = M;

const REG = [
  { id: 'm002-planes', from: 1, to: 2, types: ['3d', 'live'] },
  { id: 'm003-future', from: 2, to: 3, types: ['3d', 'live'] },
];

// ── chains ──
assert.deepEqual(migrationChain({ type: '3d', formatVersion: 1 }, REG), ['m002-planes', 'm003-future']);
assert.deepEqual(migrationChain({ type: '3d' }, REG), ['m002-planes', 'm003-future'], 'absent version = 1');
assert.deepEqual(migrationChain({ type: '3d', formatVersion: 2 }, REG), ['m003-future']);
assert.deepEqual(migrationChain({ type: '3d', formatVersion: 3 }, REG), []);
assert.deepEqual(migrationChain({ type: '2d', formatVersion: 1 }, REG), [], '2d has no migration');
assert.deepEqual(migrationChain({ type: 'live', pending: ['m003-future', 'm002-planes'] }, REG), ['m002-planes', 'm003-future'], 'server list re-sorted');
assert.deepEqual(migrationChain({ type: '3d', formatVersion: 3, pending: [], repair: true }, REG), ['m003-future'], 'repair');
assert.deepEqual(migrationChain({ type: '3d', pending: ['m002-planes', 'm003-future'], job: { migration: 'm003-future' } }, REG), ['m003-future', 'm002-planes'], 'job first');

const DATASETS = [
  { id: '3d/a', type: '3d', formatVersion: 1, pending: ['m002-planes', 'm003-future'] },
  { id: '2d/p', type: '2d', formatVersion: 1, pending: [] },
  { id: '3d/b', type: '3d', formatVersion: 2, pending: ['m003-future'] },
  { id: 'live/c', type: 'live', formatVersion: 3, pending: [] },
];
assert.deepEqual(buildQueue(DATASETS, REG).map((q) => `${q.dataset}:${q.migration}`),
  ['3d/a:m002-planes', '3d/a:m003-future', '3d/b:m003-future']);
assert.deepEqual(buildQueue(DATASETS, REG, ['3d/b']).map((q) => q.dataset), ['3d/b']);

// ── fake server ──
function fakeServer(unitsPer) {
  const journals = new Map();   // `${ds}|${mig}` → { keys, done:Set, finalized }
  const calls = [];
  const key = (d, m) => `${d}|${m}`;
  const j = (d, m) => {
    if (!journals.has(key(d, m))) {
      const n = unitsPer[key(d, m)] ?? 5;
      journals.set(key(d, m), { keys: Array.from({ length: n }, (_, i) => `t0.z0.c0.y0.x${i}`), done: new Set(), puts: 0 });
    }
    return journals.get(key(d, m));
  };
  const ok = (data) => ({ ok: true, status: 200, data });
  const api = {
    calls, journals,
    unauthorized: false,
    async plan(d, m) {
      calls.push(['plan', d, m]);
      if (api.unauthorized) return { ok: false, status: 401, data: null };
      const jj = j(d, m);
      return ok({ total: jj.keys.length, empty: 0, done: jj.done.size, units: jj.keys.filter((k) => !jj.done.has(k)) });
    },
    put(d, m, unit) { const jj = j(d, m); jj.puts++; jj.done.add(unit); return { done: jj.done.size, total: jj.keys.length }; },
    async unitRun(d, m) {
      calls.push(['unit_run', d, m]);
      const jj = j(d, m);
      const todo = jj.keys.filter((k) => !jj.done.has(k)).slice(0, 2);
      todo.forEach((k) => jj.done.add(k));
      return ok({ processed: todo, done: jj.done.size, total: jj.keys.length, seconds: 1, bytesRead: 100 * todo.length });
    },
    async finalize(d, m) {
      calls.push(['finalize', d, m]);
      const jj = j(d, m);
      if (jj.done.size !== jj.keys.length) return { ok: false, status: 409, data: { error: 'incomplete' } };
      if (api.assemblySteps) {
        jj.asm = (jj.asm || 0) + 1;
        if (jj.asm < api.assemblySteps) return ok({ ok: true, complete: false, assembly: { planes: api.assemblySteps, written: jj.asm } });
      }
      jj.finalized = true;
      return ok({ ok: true, formatVersion: REG.find((r) => r.id === m).to });
    },
    async cancel(d, m) { calls.push(['cancel', d, m]); journals.delete(key(d, m)); return ok({ ok: true }); },
  };
  return api;
}

function fakePool(api, opts = {}) {
  const ran = [];
  return {
    ran, capacity: opts.capacity || 3, prepared: [],
    async prepare(d, m, base) { this.prepared.push([d, m, base]); },
    async runUnit(d, m, unit) {
      await new Promise((r) => setTimeout(r, 1));
      ran.push(`${d}|${m}|${unit}`);
      if (opts.fail && opts.fail(d, m, unit)) return { type: 'unit_failed', key: unit, error: 'boom', fatal: true, status: 422 };
      opts.onRun?.(d, m, unit);
      const r = api.put(d, m, unit);
      return { type: 'unit_done', key: unit, ...r, bytesIn: 1000, bytesOut: 400, seconds: 0.01 };
    },
    abortAll() {}, refreshCsrf() {}, terminate() {},
  };
}

function makeRunner(api, pool, events) {
  return new Runner({ api, pool: () => pool, datasetBase: (id) => `http://h/DATA_WEB/${id}/`, onEvent: (e) => events.push(e) });
}
const until = async (fn) => { for (let i = 0; i < 2000 && !fn(); i++) await new Promise((r) => setTimeout(r, 1)); assert.ok(fn(), 'condition reached'); };

// 1. A dataset two versions behind, then another dataset: strict order.
{
  const api = fakeServer({ '3d/a|m002-planes': 4, '3d/a|m003-future': 3, '3d/b|m003-future': 2 });
  const pool = fakePool(api);
  const events = [];
  const r = makeRunner(api, pool, events);
  r.enqueue(buildQueue(DATASETS, REG));
  await until(() => r.state === 'idle');
  assert.deepEqual(api.calls.filter((c) => c[0] !== 'unit_run').map((c) => c.join(' ')), [
    'plan 3d/a m002-planes', 'finalize 3d/a m002-planes',
    'plan 3d/a m003-future', 'finalize 3d/a m003-future',
    'plan 3d/b m003-future', 'finalize 3d/b m003-future',
  ]);
  // every unit of a migration ran before the next migration started
  const order = pool.ran.map((s) => s.split('|').slice(0, 2).join('|'));
  assert.deepEqual([...new Set(order)], ['3d/a|m002-planes', '3d/a|m003-future', '3d/b|m003-future']);
  for (const jj of api.journals.values()) { assert.equal(jj.puts, jj.keys.length, 'each unit exactly once'); assert.ok(jj.finalized); }
  const done = events.filter((e) => e.type === 'job_done');
  assert.deepEqual(done.map((e) => [e.dataset, e.migration, e.formatVersion]), [['3d/a', 'm002-planes', 2], ['3d/a', 'm003-future', 3], ['3d/b', 'm003-future', 3]]);
  assert.equal(done[0].bytesIn, 4000);
  assert.deepEqual(pool.prepared[0], ['3d/a', 'm002-planes', 'http://h/DATA_WEB/3d/a/']);
  const last = events.filter((e) => e.type === 'progress' && e.dataset === '3d/a' && e.migration === 'm002-planes').pop();
  assert.equal(last.done, 4); assert.equal(last.total, 4);
}

// 2. Pause mid-job, then resume from the server journal in a NEW runner (a reload).
{
  const api = fakeServer({ '3d/a|m002-planes': 20 });
  let r;
  const pool = fakePool(api, { capacity: 2, onRun: () => { if (api.journals.get('3d/a|m002-planes').done.size === 6) r.pause('test'); } });
  const events = [];
  r = makeRunner(api, pool, events);
  r.enqueue([{ dataset: '3d/a', migration: 'm002-planes' }]);
  await until(() => r.state === 'paused');
  const jj = api.journals.get('3d/a|m002-planes');
  assert.ok(jj.done.size >= 7 && jj.done.size <= 8, `in-flight units finish on pause (${jj.done.size})`);
  assert.ok(!jj.finalized);
  assert.equal(r.reason, 'test');

  // after a reload the status lists the job: the chain resumes with it
  const ds = { id: '3d/a', type: '3d', formatVersion: 1, pending: ['m002-planes', 'm003-future'], job: { migration: 'm002-planes', done: jj.done.size, total: 20, state: 'running' } };
  assert.equal(remainingUnits(ds), 20 - jj.done.size);
  const pool2 = fakePool(api, { capacity: 3 });
  const r2 = makeRunner(api, pool2, []);
  r2.enqueue(buildQueue([ds], REG));
  await until(() => r2.state === 'idle');
  assert.equal(pool2.ran.filter((s) => s.includes('m002')).length, 20 - ds.job.done, 'only the pending units run');
  assert.equal(jj.puts, 20, 'no unit redone after the resume');
  assert.ok(jj.finalized);
  assert.ok(api.journals.get('3d/a|m003-future').finalized, 'then the next migration');
}

// 3. Executor switch while paused: the same journal finishes on the server.
{
  const api = fakeServer({ '3d/a|m002-planes': 9 });
  let r;
  const pool = fakePool(api, { capacity: 1, onRun: () => { if (api.journals.get('3d/a|m002-planes').done.size === 2) r.pause(); } });
  r = makeRunner(api, pool, []);
  r.enqueue([{ dataset: '3d/a', migration: 'm002-planes' }]);
  await until(() => r.state === 'paused');
  r.executor = 'server';
  r.resume();
  await until(() => r.state === 'idle');
  const jj = api.journals.get('3d/a|m002-planes');
  assert.ok(jj.finalized);
  assert.equal(pool.ran.length, 3);
  assert.ok(api.calls.filter((c) => c[0] === 'unit_run').length >= 3);
}

// 4. A fatal unit failure fails that dataset; its next migration is dropped; the queue goes on.
{
  const api = fakeServer({ '3d/a|m002-planes': 5, '3d/b|m003-future': 2 });
  const pool = fakePool(api, { fail: (d, m, u) => d === '3d/a' && u.endsWith('x3') });
  const events = [];
  const r = makeRunner(api, pool, events);
  r.enqueue(buildQueue(DATASETS, REG));
  await until(() => r.state === 'idle');
  const failed = events.filter((e) => e.type === 'job_failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].dataset, '3d/a');
  assert.ok(!api.calls.some((c) => c[2] === 'm003-future' && c[1] === '3d/a'), 'later migration of the failed dataset dropped');
  assert.ok(api.journals.get('3d/b|m003-future').finalized, 'the queue moved on');
}

// 4b. finalize assembles in bounded steps: called until complete, progress carries the assembly.
{
  const api = fakeServer({ '3d/a|m002-planes': 2 });
  api.assemblySteps = 3;
  const events = [];
  const r = makeRunner(api, fakePool(api), events);
  r.enqueue([{ dataset: '3d/a', migration: 'm002-planes' }]);
  await until(() => r.state === 'idle');
  assert.equal(api.calls.filter((c) => c[0] === 'finalize').length, 3);
  assert.deepEqual(events.filter((e) => e.type === 'progress' && e.assembly).map((e) => e.assembly.written), [1, 2]);
  assert.equal(events.filter((e) => e.type === 'job_done').length, 1);
}

// 5. Session expired: paused with the reason, queue kept.
{
  const api = fakeServer({});
  api.unauthorized = true;
  const r = makeRunner(api, fakePool(api), []);
  r.enqueue([{ dataset: '3d/a', migration: 'm002-planes' }]);
  await until(() => r.state === 'paused');
  assert.equal(r.reason, 'unauthorized');
  assert.equal(r.queue.length, 1);
}

// 6. Cancel the current job: journal deleted, the dataset's chain dropped.
{
  const api = fakeServer({ '3d/a|m002-planes': 50 });
  let r;
  const pool = fakePool(api, { capacity: 1 });
  r = makeRunner(api, pool, []);
  r.enqueue(buildQueue(DATASETS, REG));
  await until(() => pool.ran.length >= 2);
  await r.cancelCurrent();
  assert.ok(api.calls.some((c) => c.join(' ') === 'cancel 3d/a m002-planes'));
  assert.ok(!r.queue.some((q) => q.dataset === '3d/a'));
  assert.equal(r.state, 'paused', 'remaining datasets wait for an explicit resume');
}

// 7. runBrowserUnits retries a non-fatal failure, then gives up.
{
  let n = 0;
  const pool = { capacity: 2, async runUnit(d, m, u) { n++; return u === 'bad' ? { type: 'unit_failed', key: u, error: 'x', fatal: false } : { type: 'unit_done', key: u }; } };
  const ok = [];
  await assert.rejects(runBrowserUnits({ pool, dataset: 'd', migration: 'm', keys: ['a', 'bad', 'b'], ctl: { stop: () => false, onUnit: (r) => ok.push(r.key) } }), /x/);
  assert.equal(n, 2 + 3, 'bad tried 3 times (1 + 2 requeues)');
  assert.deepEqual(ok.sort(), ['a', 'b']);
}

// 8. Meter / sampling.
{
  const m = new Meter(60);
  m.add(0, 0); m.add(10, 5); m.add(20, 5);
  assert.equal(m.rate(), 0.5);
  assert.equal(m.eta(10), 20);
  assert.deepEqual(sampleEvenly([1, 2, 3, 4, 5, 6, 7, 8, 9], 3), [1, 5, 9]);
  assert.deepEqual(sampleEvenly([1, 2], 4), [1, 2]);
}

// 9. WorkerPool: a crashed worker's units are retried on a replacement that is prepared first;
//    a terminated pool answers instead of waiting forever.
{
  const { WorkerPool } = M;
  const spawned = [];
  let crashOnce = true;
  const spawn = () => {
    const w = {
      prepared: new Set(), terminated: false, onmessage: null, onerror: null,
      postMessage(msg) {
        setTimeout(() => {
          if (w.terminated) return;
          if (msg.type === 'prepare') { w.prepared.add(msg.dataset); w.onmessage({ data: { type: 'prepared', reqId: msg.reqId, ok: true } }); }
          else if (msg.type === 'run') {
            if (crashOnce && msg.unit === 'u2') { crashOnce = false; w.onerror({ message: 'OOM' }); return; }
            if (!w.prepared.has(msg.dataset)) { w.onmessage({ data: { type: 'unit_failed', reqId: msg.reqId, key: msg.unit, error: 'dataset not prepared', fatal: false } }); return; }
            w.onmessage({ data: { type: 'unit_done', reqId: msg.reqId, key: msg.unit } });
          }
        }, 1);
      },
      terminate() { w.terminated = true; },
    };
    spawned.push(w);
    return w;
  };
  const pool = new WorkerPool({ spawn, workers: 2, slots: 1, endpoint: 'x', csrf: () => null });
  await pool.prepare('3d/a', 'm002-planes', 'http://h/');
  const ok = [];
  await runBrowserUnits({ pool, dataset: '3d/a', migration: 'm002-planes', keys: ['u1', 'u2', 'u3', 'u4'], ctl: { stop: () => false, onUnit: (r) => ok.push(r.key) } });
  assert.deepEqual(ok.sort(), ['u1', 'u2', 'u3', 'u4'], 'the crashed unit ran again');
  assert.equal(spawned.length, 3, 'one replacement worker');
  assert.ok(spawned[2].prepared.has('3d/a'), 'the replacement read the dataset before its first unit');
  pool.terminate();
  const r = await pool.runUnit('3d/a', 'm002-planes', 'u9');
  assert.equal(r.aborted, true, 'a terminated pool answers at once');
  assert.equal(spawned.length, 3, 'and spawns nothing');
}

// 10. Transient API failures: bounded retries, an outage pauses (journal intact), an engine
//     error is not retried, a stalled assembly and units that never land stop the job.
{
  const mk = (api, events) => new Runner({ api, pool: () => fakePool(api), datasetBase: () => 'http://h/', onEvent: (e) => events.push(e), backoffMs: [1] });
  // 10a. a 502 without engine code twice, then fine → the job finishes.
  {
    const api = fakeServer({ '3d/a|m002-planes': 3 });
    const real = api.finalize.bind(api);
    let n = 0;
    api.finalize = async (d, m) => (++n <= 2 ? { ok: false, status: 502, data: null } : real(d, m));
    const events = [];
    const r = mk(api, events);
    r.enqueue([{ dataset: '3d/a', migration: 'm002-planes' }]);
    await until(() => r.state === 'idle');
    assert.equal(events.filter((e) => e.type === 'job_done').length, 1);
  }
  // 10b. the link never comes back: paused 'offline', the queue is kept, no job_failed.
  {
    const api = fakeServer({ '3d/a|m002-planes': 3 });
    let calls = 0;
    api.plan = async () => { calls++; return { ok: false, status: 0, data: null }; };
    const events = [];
    const r = mk(api, events);
    r.enqueue([{ dataset: '3d/a', migration: 'm002-planes' }]);
    await until(() => r.state === 'paused');
    assert.equal(r.reason, 'offline');
    assert.equal(r.queue.length, 1);
    assert.equal(calls, 7, 'bounded attempts');
    assert.ok(events.some((e) => e.type === 'net' && e.online === false));
    assert.equal(events.filter((e) => e.type === 'job_failed').length, 0);
  }
  // 10c. a 4xx verdict fails at once; a 5xx that persists fails after the bounded retries.
  for (const [status, code, expected] of [[409, 'source_changed', 1], [500, 'assembly_invalid', 7]]) {
    const api = fakeServer({ '3d/a|m002-planes': 3 });
    let calls = 0;
    api.finalize = async () => { calls++; return { ok: false, status, data: { error: code } }; };
    const events = [];
    const r = mk(api, events);
    r.enqueue([{ dataset: '3d/a', migration: 'm002-planes' }]);
    await until(() => r.state === 'idle');
    assert.equal(calls, expected, `${status} attempts`);
    assert.equal(events.find((e) => e.type === 'job_failed').code, code);
  }
  // 10d. finalize keeps answering complete:false without writing a plane.
  {
    const api = fakeServer({ '3d/a|m002-planes': 1 });
    let calls = 0;
    api.finalize = async () => { calls++; return { ok: true, status: 200, data: { ok: true, complete: false, assembly: { planes: 10, written: 4 } } }; };
    const events = [];
    const r = mk(api, events);
    r.enqueue([{ dataset: '3d/a', migration: 'm002-planes' }]);
    await until(() => r.state === 'idle');
    assert.equal(events.find((e) => e.type === 'job_failed').code, 'no_progress');
    assert.ok(calls <= 7, `stall detected (${calls} calls)`);
  }
  // 10e. units acknowledged but never recorded by the server: a bounded number of passes.
  {
    const api = fakeServer({ '3d/a|m002-planes': 2 });
    api.put = (d, m) => ({ done: 0, total: 2 });   // the server forgets every unit
    const events = [];
    const r = mk(api, events);
    r.enqueue([{ dataset: '3d/a', migration: 'm002-planes' }]);
    await until(() => r.state === 'idle');
    assert.equal(events.find((e) => e.type === 'job_failed').code, 'incomplete');
    assert.equal(api.calls.filter((c) => c[0] === 'plan').length, 6, 'three passes, each re-planned');
  }
}

console.log('migration queue: OK');
