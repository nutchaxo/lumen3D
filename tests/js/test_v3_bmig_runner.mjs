// "Data updates" queue, web 1.59 (js/pages/admin/migration-runner.js), SPEC §13.5:
//   • serverCapability: per-migration report (`server.migrations[id]`) wins over the global one;
//   • chooseExecutor: the operator's available pick, else the faster benchmarked available one,
//     else the browser, else the server, null when neither can run the migration;
//   • ONE dataset chain m002 → m003 → m004 with mixed executors (browser, server, browser):
//     each step runs on its own executor, in order; m004 runs in level waves — `plan` names the
//     units runnable now, the runner re-plans after each wave, no unit of level k+1 is sent
//     before level k is complete; progress carries step/steps/chain and etaChain;
//   • without `runnable`, a unit the server refuses as `unit_blocked` (409) is deferred, not failed,
//     and lands in a later wave;
//   • a step no executor can run fails with `no_executor` after the earlier steps finished;
//   • WorkerPool: the handler's `slotsPerWorker` lowers the units in flight of that migration
//     only; `probe` asks the worker once per migration;
//   • runSpeedtest: both executors race for the window at the same time, the browser through
//     the pool's slots, the server in bounded calls; a side that fails keeps the other running;
//     speedtestScores gives blocks/s × 10, the winner and the ratio;
//   • Runner.executorFor receives the dataset (the tab picks the executor per dataset).
//
// Run: node tests/js/test_v3_bmig_runner.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './harness.mjs';

const M = await import(pathToFileURL(path.join(ROOT, 'js/pages/admin/migration-runner.js')).href);
const { Runner, buildQueue, serverCapability, chooseExecutor, runBrowserUnits, WorkerPool, runSpeedtest, speedtestScores } = M;

const REG = [
  { id: 'm002-planes', from: 1, to: 2, types: ['3d', 'live'] },
  { id: 'm003-layer-mips', from: 2, to: 3, types: ['3d', 'live'] },
  { id: 'm004-bricks-v3', from: 3, to: 4, types: ['3d', 'live'] },
];
const until = async (fn) => { for (let i = 0; i < 4000 && !fn(); i++) await new Promise((r) => setTimeout(r, 1)); assert.ok(fn(), 'condition reached'); };

// ── 1. capabilities ──
{
  const server = { available: true, reasons: [], migrations: { 'm004-bricks-v3': { available: false, reasons: ['no_webp_encode'] } } };
  assert.deepEqual(serverCapability(server, 'm004-bricks-v3'), { available: false, reasons: ['no_webp_encode'] });
  assert.deepEqual(serverCapability(server, 'm003-layer-mips'), { available: true, reasons: [] }, 'global fallback');
  assert.deepEqual(serverCapability({ available: false, reasons: ['low_memory'] }, 'm002-planes'), { available: false, reasons: ['low_memory'] });
  assert.deepEqual(serverCapability(null, 'x'), { available: false, reasons: [] });

  const on = { available: true }, off = { available: false };
  assert.equal(chooseExecutor({ choice: 'server', caps: { browser: on, server: on } }), 'server', 'operator pick');
  assert.equal(chooseExecutor({ choice: 'server', caps: { browser: on, server: off } }), 'browser', 'unavailable pick falls back');
  assert.equal(chooseExecutor({ caps: { browser: on, server: on }, bench: { browser: { secondsPerUnit: 2 }, server: { secondsPerUnit: 0.5 } } }), 'server', 'faster benchmarked');
  assert.equal(chooseExecutor({ caps: { browser: on, server: on }, bench: { browser: { secondsPerUnit: 0.4 }, server: { secondsPerUnit: 0.5 } } }), 'browser');
  assert.equal(chooseExecutor({ caps: { browser: on, server: on }, bench: { server: { secondsPerUnit: 0.1 } } }), 'browser', 'one bench only: no comparison');
  assert.equal(chooseExecutor({ caps: { browser: null, server: on } }), 'browser', 'not probed yet = assumed able');
  assert.equal(chooseExecutor({ caps: { browser: off, server: on } }), 'server');
  assert.equal(chooseExecutor({ choice: 'browser', caps: { browser: off, server: off } }), null, 'nothing can run it');
}

// ── fake server with level-ordered m004 ──
function fakeServer(spec) {
  // spec: `${ds}|${mig}` → array of levels, e.g. [4, 2, 1] = 4 units of level 0, 2 of level 1…
  const journals = new Map();
  const calls = [];
  const puts = [];
  const j = (d, m) => {
    const k = `${d}|${m}`;
    if (!journals.has(k)) {
      const levels = spec[k] || [3];
      const keys = [];
      levels.forEach((n, lv) => { for (let i = 0; i < n; i++) keys.push({ key: `t0.k${lv}.c0.z0.y0.x${i}`, lv }); });
      journals.set(k, { keys, done: new Set(), finalized: false, leveled: m === 'm004-bricks-v3' });
    }
    return journals.get(k);
  };
  const lowest = (jj) => {
    const left = jj.keys.filter((u) => !jj.done.has(u.key));
    return left.length ? Math.min(...left.map((u) => u.lv)) : null;
  };
  const ok = (data) => ({ ok: true, status: 200, data });
  const api = {
    calls, puts, journals,
    giveRunnable: true,
    async plan(d, m) {
      calls.push(['plan', d, m]);
      const jj = j(d, m);
      const pending = jj.keys.filter((u) => !jj.done.has(u.key));
      const out = { total: jj.keys.length, empty: 0, done: jj.done.size, units: pending.map((u) => u.key) };
      if (api.reverse) out.units.reverse();
      if (jj.leveled && api.giveRunnable) { const lv = lowest(jj); out.runnable = pending.filter((u) => u.lv === lv).map((u) => u.key); }
      return ok(out);
    },
    put(d, m, unit, executor) {
      const jj = j(d, m);
      const u = jj.keys.find((x) => x.key === unit);
      if (jj.leveled && u.lv !== lowest(jj)) return { refused: 'unit_blocked' };   // the server's 409 code
      puts.push(`${executor}:${m}:${unit}`);
      jj.done.add(unit);
      return { done: jj.done.size, total: jj.keys.length };
    },
    async unitRun(d, m) {
      calls.push(['unit_run', d, m]);
      const jj = j(d, m);
      const lv = lowest(jj);
      const todo = jj.keys.filter((u) => !jj.done.has(u.key) && (!jj.leveled || u.lv === lv)).slice(0, 2);
      todo.forEach((u) => { puts.push(`server:${m}:${u.key}`); jj.done.add(u.key); });
      return ok({ processed: todo.map((u) => u.key), done: jj.done.size, total: jj.keys.length, seconds: 1, bytesRead: 10 });
    },
    async finalize(d, m) {
      calls.push(['finalize', d, m]);
      const jj = j(d, m);
      if (jj.done.size !== jj.keys.length) return { ok: false, status: 409, data: { error: 'incomplete' } };
      jj.finalized = true;
      return ok({ ok: true, complete: true, formatVersion: REG.find((r) => r.id === m).to });
    },
    async cancel() { return ok({ ok: true }); },
  };
  return api;
}

function fakePool(api, capacity = 3) {
  return {
    ran: [], capacity,
    async prepare() {},
    async runUnit(d, m, unit) {
      await new Promise((r) => setTimeout(r, 1));
      this.ran.push(`${m}:${unit}`);
      const r = api.put(d, m, unit, 'browser');
      if (r.refused) return { type: 'unit_failed', key: unit, error: 'not runnable yet', code: r.refused, status: 409, fatal: true };
      return { type: 'unit_done', key: unit, ...r, bytesIn: 10, bytesOut: 5 };
    },
    abortAll() {}, refreshCsrf() {}, terminate() {},
  };
}

// ── 2. one chain, mixed executors, m004 in level waves ──
{
  const api = fakeServer({ '3d/a|m002-planes': [3], '3d/a|m003-layer-mips': [5], '3d/a|m004-bricks-v3': [6, 3, 1] });
  const pool = fakePool(api);
  const events = [];
  const exec = { 'm002-planes': 'browser', 'm003-layer-mips': 'server', 'm004-bricks-v3': 'browser' };
  const r = new Runner({
    api, pool: () => pool, datasetBase: () => 'http://h/', onEvent: (e) => events.push(e),
    executorFor: (mid) => exec[mid],
    estimateStep: (ds, mid) => ({ 'm003-layer-mips': 30, 'm004-bricks-v3': 100 })[mid] ?? null,
    // A clock that always moves: the rate must not depend on two units landing in one millisecond.
    now: (() => { let t = 0; return () => (t += 0.01); })(),
  });
  const ds = { id: '3d/a', type: '3d', formatVersion: 1, pending: ['m004-bricks-v3', 'm002-planes', 'm003-layer-mips'] };
  r.enqueue(buildQueue([ds], REG));
  await until(() => r.state === 'idle');
  for (const jj of api.journals.values()) assert.ok(jj.finalized);
  // executors per step
  const byMig = (m) => api.puts.filter((p) => p.includes(`:${m}:`)).map((p) => p.split(':')[0]);
  assert.deepEqual([...new Set(byMig('m002-planes'))], ['browser']);
  assert.deepEqual([...new Set(byMig('m003-layer-mips'))], ['server']);
  assert.deepEqual([...new Set(byMig('m004-bricks-v3'))], ['browser']);
  // strict chain order
  const order = api.calls.filter((c) => c[0] === 'finalize').map((c) => c[2]);
  assert.deepEqual(order, ['m002-planes', 'm003-layer-mips', 'm004-bricks-v3']);
  // level order of m004: every k0 before any k1, every k1 before k2; nothing refused
  const lv = api.puts.filter((p) => p.includes('m004')).map((p) => +/\.k(\d)\./.exec(p)[1]);
  assert.deepEqual(lv, [0, 0, 0, 0, 0, 0, 1, 1, 1, 2]);
  assert.equal(pool.ran.filter((s) => s.startsWith('m004')).length, 10, 'no unit sent before its level was runnable');
  assert.equal(api.calls.filter((c) => c[0] === 'plan' && c[2] === 'm004-bricks-v3').length, 3, 'a plan per wave (the last wave ends the job)');
  // progress: step, steps, chain, etaChain
  const prog = events.filter((e) => e.type === 'progress');
  const first = prog.find((e) => e.migration === 'm002-planes');
  assert.deepEqual([first.step, first.steps, first.chain], [1, 3, ['m002-planes', 'm003-layer-mips', 'm004-bricks-v3']]);
  assert.equal(prog.find((e) => e.migration === 'm003-layer-mips').step, 2);
  assert.equal(prog.find((e) => e.migration === 'm004-bricks-v3').step, 3);
  const withEta = prog.filter((e) => e.migration === 'm002-planes' && e.eta !== null);
  assert.ok(withEta.length, 'a rate after a few units');
  for (const e of withEta) assert.equal(e.etaChain, e.eta + 130, 'this step + later steps');
  const last = prog.filter((e) => e.migration === 'm004-bricks-v3' && e.eta !== null);
  for (const e of last) assert.equal(e.etaChain, e.eta, 'last step: nothing after it');
  const done = events.filter((e) => e.type === 'job_done');
  assert.deepEqual(done.map((e) => [e.migration, e.executor, e.formatVersion]), [['m002-planes', 'browser', 2], ['m003-layer-mips', 'server', 3], ['m004-bricks-v3', 'browser', 4]]);
}

// ── 2b. a later step without an estimate: the chain ETA is unknown, never 0 s ──
{
  const api = fakeServer({ '3d/a|m003-layer-mips': [8], '3d/a|m004-bricks-v3': [1] });
  const events = [];
  const r = new Runner({ api, pool: () => fakePool(api, 1), datasetBase: () => 'http://h/', onEvent: (e) => events.push(e), estimateStep: () => null });
  r.enqueue(buildQueue([{ id: '3d/a', type: '3d', formatVersion: 2 }], REG));
  await until(() => r.state === 'idle');
  const p = events.filter((e) => e.type === 'progress' && e.migration === 'm003-layer-mips' && e.eta !== null);
  assert.ok(p.length);
  for (const e of p) assert.equal(e.etaChain, null);
}

// ── 3. no `runnable` from the server: refused units are deferred to the next wave ──
{
  const api = fakeServer({ '3d/a|m004-bricks-v3': [3, 2, 1] });
  api.giveRunnable = false;
  api.reverse = true;              // the highest level listed first
  const pool = fakePool(api, 6);   // every unit in flight at once: the higher levels get refused
  const events = [];
  const r = new Runner({ api, pool: () => pool, datasetBase: () => 'http://h/', onEvent: (e) => events.push(e) });
  r.enqueue([{ dataset: '3d/a', migration: 'm004-bricks-v3' }]);
  await until(() => r.state === 'idle');
  assert.equal(events.filter((e) => e.type === 'job_failed').length, 0, events.find((e) => e.type === 'job_failed')?.error);
  assert.ok(api.journals.get('3d/a|m004-bricks-v3').finalized);
  const lv = api.puts.map((p) => +/\.k(\d)\./.exec(p)[1]);
  assert.deepEqual(lv, [0, 0, 0, 1, 1, 2]);
  assert.ok(pool.ran.length > 6, 'some units were refused then sent again');
}

// ── 3b. unit_timeout (a unit that killed the server's request twice) is final at once ──
{
  const api = fakeServer({ '3d/a|m003-layer-mips': [4] });
  api.unitRun = async (d, m) => { api.calls.push(['unit_run', d, m]); return { ok: false, status: 500, data: { error: 'unit_timeout', detail: 't0.l0.c0.y0.x0' } }; };
  const events = [];
  const r = new Runner({ api, pool: () => fakePool(api), datasetBase: () => 'http://h/', onEvent: (e) => events.push(e), executorFor: () => 'server' });
  r.backoffMs = [1, 1, 1, 1, 1, 1];
  r.enqueue([{ dataset: '3d/a', migration: 'm003-layer-mips' }]);
  await until(() => r.state === 'idle');
  assert.equal(api.calls.filter((c) => c[0] === 'unit_run').length, 1, 'not retried: the answer would not change');
  const f = events.find((e) => e.type === 'job_failed');
  assert.ok(f, 'the job fails');
  assert.equal(f.code, 'unit_timeout');
  assert.equal(f.migration, 'm003-layer-mips');
  // A plain 500 (the request died) is still retried.
  const api2 = fakeServer({ '3d/a|m003-layer-mips': [2] });
  const real = api2.unitRun;
  let n = 0;
  api2.unitRun = async (d, m) => (++n === 1 ? { ok: false, status: 500, data: null } : real(d, m));
  const r2 = new Runner({ api: api2, pool: () => fakePool(api2), datasetBase: () => 'http://h/', onEvent: () => {}, executorFor: () => 'server' });
  r2.backoffMs = [1, 1, 1, 1, 1, 1];
  r2.enqueue([{ dataset: '3d/a', migration: 'm003-layer-mips' }]);
  await until(() => r2.state === 'idle');
  assert.ok(api2.journals.get('3d/a|m003-layer-mips').finalized, 'a transient 500 is retried');
}

// ── 3c. a slow host stores a unit in octants: more octants stored is progress ──
{
  const api = fakeServer({ '3d/a|m003-layer-mips': [1] });
  const real = api.unitRun;
  let calls = 0;
  // Three calls each store more octants of the one unit, the fourth finishes it.
  api.unitRun = async (d, m) => {
    calls++;
    if (calls <= 3) {
      const j = api.journals.get('3d/a|m003-layer-mips');
      return { ok: true, status: 200, data: { processed: [], done: j ? j.done.size : 0, total: 1, partial: [{ unit: 't0.l0.c0.y0.x0', parts: calls * 2, of: 8 }] } };
    }
    return real(d, m);
  };
  const events = [];
  const r = new Runner({ api, pool: () => fakePool(api), datasetBase: () => 'http://h/', onEvent: (e) => events.push(e), executorFor: () => 'server' });
  r.backoffMs = [1, 1, 1, 1, 1, 1];
  r.enqueue([{ dataset: '3d/a', migration: 'm003-layer-mips' }]);
  await until(() => r.state === 'idle');
  assert.ok(!events.some((e) => e.type === 'job_failed'), 'partial progress is not no_progress');
  assert.ok(api.journals.get('3d/a|m003-layer-mips').finalized, 'the job completes');
}

// ── 4. a step nothing can run ──
{
  const api = fakeServer({ '3d/a|m003-layer-mips': [2] });
  const events = [];
  const r = new Runner({
    api, pool: () => fakePool(api), datasetBase: () => 'http://h/', onEvent: (e) => events.push(e),
    executorFor: (mid) => (mid === 'm004-bricks-v3' ? null : 'browser'),
  });
  r.enqueue(buildQueue([{ id: '3d/a', type: '3d', formatVersion: 2 }], REG));
  await until(() => r.state === 'idle');
  assert.ok(api.journals.get('3d/a|m003-layer-mips').finalized, 'the step before ran');
  const f = events.find((e) => e.type === 'job_failed');
  assert.equal(f.migration, 'm004-bricks-v3');
  assert.equal(f.code, 'no_executor');
  assert.ok(!api.calls.some((c) => c[2] === 'm004-bricks-v3'), 'no job created for it');
}

// ── 5. legacy single executor still drives every step (executors map > executor) ──
{
  const api = fakeServer({ '3d/a|m003-layer-mips': [2], '3d/a|m004-bricks-v3': [2, 1] });
  const pool = fakePool(api);
  const r = new Runner({ api, pool: () => pool, datasetBase: () => 'http://h/', onEvent: () => {} });
  r.executor = 'server';
  r.executors['m004-bricks-v3'] = 'browser';
  r.enqueue(buildQueue([{ id: '3d/a', type: '3d', formatVersion: 2 }], REG));
  await until(() => r.state === 'idle');
  assert.deepEqual([...new Set(api.puts.map((p) => p.split(':').slice(0, 2).join(':')))], ['server:m003-layer-mips', 'browser:m004-bricks-v3']);
}

// ── 6. WorkerPool: slot hints per migration, probe once ──
{
  let probes = 0;
  const inflight = new Map();
  let peak = {};
  const spawn = () => {
    const w = {
      onmessage: null, onerror: null,
      postMessage(msg) {
        setTimeout(() => {
          if (msg.type === 'probe') { probes++; w.onmessage({ data: { type: 'probed', reqId: msg.reqId, ok: true, available: msg.migration !== 'm004-bricks-v3', reasons: msg.migration === 'm004-bricks-v3' ? ['no_webp_lossless_encode'] : [] } }); }
          else if (msg.type === 'prepare') w.onmessage({ data: { type: 'prepared', reqId: msg.reqId, ok: true, slotsPerWorker: msg.migration === 'm004-bricks-v3' ? 1 : null } });
          else if (msg.type === 'list') w.onmessage({ data: { type: 'listed', reqId: msg.reqId, ok: true, units: msg.opts && msg.opts.sample ? [{ key: 'k0a' }, { key: 'k0b', empty: true }] : [{ key: 'k0a' }, { key: 'k1' }] } });
          else if (msg.type === 'run') {
            const n = (inflight.get(msg.migration) || 0) + 1;
            inflight.set(msg.migration, n);
            peak[msg.migration] = Math.max(peak[msg.migration] || 0, n);
            setTimeout(() => { inflight.set(msg.migration, inflight.get(msg.migration) - 1); w.onmessage({ data: { type: 'unit_done', reqId: msg.reqId, key: msg.unit, bytesIn: 1, bytesOut: 1, seconds: 0.001 } }); }, 3);
          }
        }, 1);
      },
      terminate() {},
    };
    return w;
  };
  const pool = new WorkerPool({ spawn, workers: 2, slots: 2, endpoint: 'x', csrf: () => null });
  const keys = Array.from({ length: 12 }, (_, i) => `u${i}`);
  await pool.prepare('3d/a', 'm003-layer-mips', 'http://h/');
  await runBrowserUnits({ pool, dataset: '3d/a', migration: 'm003-layer-mips', keys, ctl: { stop: () => false, onUnit() {} } });
  await pool.prepare('3d/a', 'm004-bricks-v3', 'http://h/');
  assert.equal(pool.capacityFor('m004-bricks-v3'), 2);
  assert.equal(pool.capacityFor('m003-layer-mips'), 4);
  await runBrowserUnits({ pool, dataset: '3d/a', migration: 'm004-bricks-v3', keys, ctl: { stop: () => false, onUnit() {} } });
  assert.equal(peak['m003-layer-mips'], 4);
  assert.equal(peak['m004-bricks-v3'], 2, 'one unit per worker for a heavy handler');
  assert.deepEqual(await pool.probe('m003-layer-mips'), { available: true, reasons: [] });
  assert.deepEqual(await pool.probe('m004-bricks-v3'), { available: false, reasons: ['no_webp_lossless_encode'] });
  await pool.probe('m004-bricks-v3');
  assert.equal(probes, 2, 'probed once per migration');
  pool.terminate();
}

// ── one pool for every lane: network state aggregated, aborts scoped to a dataset ──
{
  const workers = [];
  const spawn = () => {
    const w = { posted: [], postMessage(m) { this.posted.push(m); }, terminate() {} };
    workers.push(w);
    return w;
  };
  const net = [];
  const pool = new WorkerPool({ spawn, workers: 2, slots: 2, endpoint: 'x', csrf: () => null, onNet: (o) => net.push(o) });
  pool._ensure();
  const [a, b] = pool.workers;
  a.w.onmessage({ data: { type: 'net', online: false } });
  b.w.onmessage({ data: { type: 'net', online: false } });
  a.w.onmessage({ data: { type: 'net', online: true } });
  assert.deepEqual(net, [false], 'still offline while one worker waits');
  b.w.onmessage({ data: { type: 'net', online: true } });
  assert.deepEqual(net, [false, true], 'online once no worker waits');
  b.w.onmessage({ data: { type: 'net', online: false } });
  pool.terminate();
  assert.deepEqual(net, [false, true, false, true], 'terminating clears a pending offline state');

  const pool2 = new WorkerPool({ spawn, workers: 1, slots: 4, endpoint: 'x', csrf: () => null });
  pool2._ensure();
  const w = pool2.workers[0].w;
  pool2.runUnit('3d/a', 'm002-planes', 'u1');
  pool2.runUnit('3d/b', 'm002-planes', 'u2');
  await new Promise((r) => setTimeout(r, 5));
  const runs = w.posted.filter((m) => m.type === 'run');
  w.posted.length = 0;
  pool2.abortAll('3d/b');
  assert.deepEqual(w.posted, [{ type: 'abort', reqId: runs.find((m) => m.dataset === '3d/b').reqId }], 'only the unit of that dataset is aborted');
  w.posted.length = 0;
  pool2.abortAll();
  assert.deepEqual(w.posted, [{ type: 'abort' }], 'no dataset: every unit');
  pool2.terminate();
}

// ── speed test ──
{
  // A fake clock: every block / call advances it, so the window closes deterministically.
  let clock = 0;
  const now = () => clock;
  let inFlight = 0, peak = 0;
  const pool = {
    capacity: 3,
    dead: false,
    async speedtestBlock(url) {
      assert.equal(url, 'http://h/js/migrations/speedtest-brick.webp');
      if (this.dead) return { ok: false, aborted: true };
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      clock += 0.05;
      inFlight--;
      return this.dead ? { ok: false, aborted: true } : { ok: true, bytesIn: 100, bytesOut: 150 };
    },
    terminate() { this.dead = true; },
  };
  const calls = [];
  const api = {
    async speedtest(maxSeconds) {
      calls.push(maxSeconds);
      assert.ok(maxSeconds > 0 && maxSeconds <= 1, 'bounded server calls');
      await new Promise((r) => setTimeout(r, 1));
      return { ok: true, status: 200, data: { ok: true, blocks: 4, bytesRead: 400, bytesWritten: 600, seconds: maxSeconds } };
    },
  };
  const ticks = [];
  const res = await runSpeedtest({ pool, api, sampleUrl: 'http://h/js/migrations/speedtest-brick.webp', seconds: 5, now, onTick: (s) => ticks.push(s.elapsed) });
  assert.equal(peak, 3, 'the browser runs as many blocks at once as the pool has slots');
  assert.ok(pool.dead, 'the pool is released when the window closes');
  assert.ok(res.browser.blocks > 0 && !res.browser.error);
  assert.equal(res.browser.bytesIn, 100 * res.browser.blocks);
  assert.ok(calls.length >= 1 && res.server.blocks === 4 * calls.length && !res.server.error);
  assert.ok(ticks.length > 0, 'progress is reported');
  const sc = speedtestScores(res);
  assert.equal(sc.browser, Math.round((10 * res.browser.blocks) / 5));
  assert.equal(sc.server, Math.round((10 * res.server.blocks) / 5));

  // The server refuses (no WebP decode): the browser still finishes its window.
  clock = 0;
  const pool2 = { ...pool, dead: false, speedtestBlock: pool.speedtestBlock, terminate() { this.dead = true; } };
  const bad = { async speedtest() { return { ok: false, status: 409, data: { error: 'server_unavailable', detail: 'no_webp_decode' } }; } };
  const res2 = await runSpeedtest({ pool: pool2, api: bad, sampleUrl: 'http://h/js/migrations/speedtest-brick.webp', seconds: 5, now });
  assert.equal(res2.server.code, 'server_unavailable');
  assert.equal(res2.server.detail, 'no_webp_decode');
  assert.ok(res2.browser.blocks > 0, 'the browser side is not stopped by the server failing');
  const sc2 = speedtestScores(res2);
  assert.equal(sc2.server, null);
  assert.equal(sc2.winner, 'browser');

  assert.deepEqual(speedtestScores({ seconds: 5, browser: { blocks: 10 }, server: { blocks: 35 } }), { browser: 20, server: 70, winner: 'server', ratio: 3.5 });
  assert.deepEqual(speedtestScores({ seconds: 5, browser: { blocks: 10 }, server: { blocks: 10 } }), { browser: 20, server: 20, winner: null, ratio: null });
  assert.equal(speedtestScores({ seconds: 5, browser: { blocks: 0, error: 'x' }, server: { blocks: 0, error: 'y' } }).winner, null);
}

// ── executorFor gets the dataset ──
{
  const seen = [];
  const api = {
    plan: async () => ({ ok: true, status: 200, data: { total: 0, done: 0, units: [] } }),
    finalize: async () => ({ ok: true, status: 200, data: { ok: true, formatVersion: 2 } }),
  };
  const r = new Runner({ api, pool: () => null, datasetBase: () => 'http://h/', onEvent: () => {},
    executorFor: (mid, ds) => { seen.push([mid, ds]); return 'server'; } });
  r.enqueue([{ dataset: '3d/x', migration: 'm002-planes' }]);
  await until(() => r.state === 'idle');
  assert.deepEqual(seen, [['m002-planes', '3d/x']]);
}

console.log('migration runner (formats 3/4): OK');
