/**
 * Admin SPA — dataset migration runner (DOCS/dataset-migrations/SPEC.md §6, §7, §9)
 * =================================================================================
 * The queue behind the "Data updates" tab, free of DOM so it is testable under node:
 *
 *   * migrationChain / buildQueue — which migrations a dataset needs and in what order
 *     (datasets one after another, each dataset's migrations in registry order);
 *   * Runner — plan → units (browser worker pool, or a loop of server `unit_run` calls)
 *     → finalize, with pause / resume / cancel / retry, and resume from the server journal
 *     after a reload (`plan` is idempotent and returns the units still pending). The executor
 *     is chosen PER MIGRATION, so one dataset's chain may run a step in this browser and the
 *     next on the server. A migration whose units depend on earlier ones (m004: level k+1 reads
 *     level k) runs in waves: `plan` names the units runnable now (`runnable`), the runner
 *     re-plans after each wave until none is left;
 *   * WorkerPool — the browser executor: N workers × S slots of js/workers/migration-worker.js
 *     (a handler may lower S: `slotsPerWorker`), plus the per-migration capability probe;
 *   * capabilities, executor choice, benchmarks and duration estimates.
 *
 * Nothing here is specific to a migration: the browser executor loads the handler module
 * named after the migration id inside the worker.
 */

'use strict';

export const API_MIGRATIONS = 'api/migrations.php';
const PLAN_PAGE = 5000;
const SERVER_SLICE_SECONDS = 20;
const UNIT_REQUEUE = 2;        // a non-fatal unit failure (after the worker's own retries) is tried again this often
// A JSON call answered by no one (status 0), a 5xx or a 429 is retried with a growing
// delay; after this many consecutive failures the job stops instead of looping forever.
const CALL_ATTEMPTS = 7;
const CALL_BACKOFF_MS = [2000, 4000, 8000, 15000, 30000, 30000];
// Bounds on loops that only end when the server says so.
const MAX_PASSES = 3;            // passes in a row over the pending units of one job without progress
const MAX_STALLED_ASSEMBLY = 5;  // finalize answers in a row without a new plane written
// Server error codes that no retry changes: `unit_timeout` = a unit that killed the request
// twice (the server executor cannot convert it within its time limit).
const DEFINITIVE_CODES = new Set(['unit_timeout']);

// ── Ordering ──────────────────────────────────────────────────────────────────

/**
 * The migrations `ds` needs, in application order. The server's `pending` list is the
 * authority when given (it knows the on-disk truth); it is re-sorted into the registry's
 * order. Without it the chain is walked from `formatVersion`: a migration applies only at
 * exactly its `from`. A dataset that is up to date but `repair` re-runs the migration that
 * produces its current version.
 */
export function migrationChain(ds, registry) {
  const reg = Array.isArray(registry) ? registry : [];
  const applies = (m) => !Array.isArray(m.types) || m.types.includes(ds.type);
  let chain;
  if (Array.isArray(ds.pending)) {
    const want = new Set(ds.pending);
    chain = reg.filter((m) => want.has(m.id)).map((m) => m.id);
    // An id the registry does not list (server newer than this page) still runs, last.
    for (const id of ds.pending) if (!chain.includes(id)) chain.push(id);
  } else {
    chain = [];
    let v = Number.isInteger(ds.formatVersion) ? ds.formatVersion : 1;
    for (const m of reg) {
      if (m.from === v && applies(m)) { chain.push(m.id); v = m.to; }
    }
  }
  if (!chain.length && ds.repair) {
    const v = Number.isInteger(ds.formatVersion) ? ds.formatVersion : 1;
    const producer = reg.filter((m) => m.to === v && applies(m)).pop();
    if (producer) chain.push(producer.id);
  }
  // A job left by an earlier session runs first: its migration is the dataset's current step.
  if (ds.job && ds.job.migration && chain.includes(ds.job.migration)) {
    chain = [ds.job.migration, ...chain.filter((id) => id !== ds.job.migration)];
  }
  return chain;
}

/** [{ dataset, migration }] for `ids` (every dataset with work when omitted), status order. */
export function buildQueue(datasets, registry, ids) {
  const want = ids ? new Set(ids) : null;
  const out = [];
  for (const ds of datasets || []) {
    if (want && !want.has(ds.id)) continue;
    for (const migration of migrationChain(ds, registry)) out.push({ dataset: ds.id, migration });
  }
  return out;
}

// ── Throughput / ETA ──────────────────────────────────────────────────────────

/** Units per second over a sliding window of completions (a pause does not count). */
export class Meter {
  constructor(windowSec = 60) { this.windowSec = windowSec; this.samples = []; }
  reset() { this.samples = []; }
  add(nowSec, units = 1) {
    this.samples.push([nowSec, units]);
    while (this.samples.length > 2 && nowSec - this.samples[0][0] > this.windowSec) this.samples.shift();
  }
  rate() {
    if (this.samples.length < 2) return 0;
    const span = this.samples[this.samples.length - 1][0] - this.samples[0][0];
    if (span <= 0) return 0;
    let n = 0;
    for (let i = 1; i < this.samples.length; i++) n += this.samples[i][1];
    return n / span;
  }
  eta(remaining) {
    const r = this.rate();
    return r > 0 ? remaining / r : null;
  }
}

/** Seconds to run `units` units at `secondsPerUnit`, or null when either is unknown. */
export function estimateSeconds(units, secondsPerUnit) {
  if (!(units >= 0) || !(secondsPerUnit > 0)) return null;
  return units * secondsPerUnit;
}

/** Units left to do for `ds`: the job's when one exists, else the status estimate. */
export function remainingUnits(ds) {
  if (ds.job && Number.isFinite(ds.job.total)) {
    return Math.max(0, ds.job.total - (ds.job.done || 0));
  }
  return Number(ds.estimate && ds.estimate.units) || 0;
}

/** `count` items spread evenly over `list` (deterministic, first and last included). */
export function sampleEvenly(list, count) {
  if (list.length <= count) return list.slice();
  const out = [];
  for (let i = 0; i < count; i++) out.push(list[Math.round(i * (list.length - 1) / Math.max(1, count - 1))]);
  return out;
}

// ── Capabilities and executor choice ──────────────────────────────────────────

/**
 * Can the server run `migration`? `status.server.migrations[id]` when the server reports it
 * per migration, else the global `status.server.available` / `reasons`.
 */
export function serverCapability(server, migration) {
  const s = server || {};
  const per = s.migrations && migration && s.migrations[migration];
  if (per && typeof per === 'object') return { available: !!per.available, reasons: Array.isArray(per.reasons) ? per.reasons : [] };
  return { available: !!s.available, reasons: Array.isArray(s.reasons) ? s.reasons : [] };
}

/**
 * The executor to use for a migration: the operator's choice when it is available, else the
 * faster benchmarked available one, else the browser, else the server; null when neither can
 * run it.
 *   caps  { browser: {available}|null (not probed yet = assumed available), server: {available} }
 *   bench { browser: {secondsPerUnit}|null, server: {secondsPerUnit}|null }
 */
export function chooseExecutor({ choice, caps, bench }) {
  const ok = (x) => (x === 'browser' ? !(caps && caps.browser && caps.browser.available === false)
    : !!(caps && caps.server && caps.server.available));
  if ((choice === 'browser' || choice === 'server') && ok(choice)) return choice;
  const spu = (x) => (bench && bench[x] && bench[x].secondsPerUnit > 0 ? bench[x].secondsPerUnit : null);
  const both = ['browser', 'server'].filter(ok);
  if (both.length === 2 && spu('browser') && spu('server')) return spu('server') < spu('browser') ? 'server' : 'browser';
  return both[0] || null;
}

// ── API ───────────────────────────────────────────────────────────────────────

/** Thin client over /api/migrations.php; `request(url, init)` → { ok, status, data }. */
export function createApi(request, base = API_MIGRATIONS) {
  const get = (action, params) => request(`${base}?${new URLSearchParams({ action, ...(params || {}) })}`, { method: 'GET' });
  const postJson = (action, body) => request(`${base}?action=${action}`, { method: 'POST', body: JSON.stringify(body || {}) });
  return {
    status: () => get('status'),
    async plan(dataset, migration) {
      // Paged: the journal of a large live dataset lists tens of thousands of keys.
      let offset = 0;
      let units = [];
      let head = null;
      for (;;) {
        const r = await request(`${base}?action=plan`, { method: 'POST', body: JSON.stringify({ dataset, migration, offset, limit: PLAN_PAGE }) });
        if (!r.ok || !r.data) return r;
        head = r.data;
        const page = Array.isArray(r.data.units) ? r.data.units : [];
        units = units.concat(page);
        if (page.length < PLAN_PAGE) break;
        offset += page.length;
      }
      return { ok: true, status: 200, data: { ...head, units } };
    },
    unitRun: (dataset, migration, dry = false) => postJson('unit_run', { dataset, migration, maxSeconds: SERVER_SLICE_SECONDS, dry: !!dry }),
    // Assembly is bounded in time too: an answer { complete: false, assembly } asks for another call.
    finalize: (dataset, migration) => postJson('finalize', { dataset, migration, maxSeconds: SERVER_SLICE_SECONDS }),
    cancel: (dataset, migration) => postJson('cancel', { dataset, migration }),
    bench: (dataset, units, migration) => postJson('bench', migration ? { dataset, migration, units } : { dataset, units }),
  };
}

function apiError(r, fallback) {
  const d = r && r.data;
  return Object.assign(new Error((d && (d.message || d.detail || d.error)) || fallback || `HTTP ${r ? r.status : 0}`), {
    status: r ? r.status : 0, code: (d && d.error) || null,
    // A disk refusal carries its sizes, not a detail string: say how much is missing.
    detail: (d && d.detail) || (d && d.neededBytes ? `${Math.ceil(d.neededBytes / 1048576)} MB / ${Math.floor((d.freeBytes || 0) / 1048576)} MB` : null),
  });
}

// ── Browser executor: worker pool ─────────────────────────────────────────────

export class WorkerPool {
  /**
   * @param {object} o
   * @param {() => Worker} o.spawn
   * @param {number} o.workers
   * @param {number} o.slots   units in flight per worker (each unit holds ≤ ~40 MiB)
   * @param {string} o.endpoint  absolute URL of api/migrations.php
   * @param {() => string|null} o.csrf
   * @param {(online: boolean) => void} [o.onNet]
   */
  constructor(o) {
    this.o = o;
    this.workers = [];
    this.seq = 0;
    this.pending = new Map();   // reqId → { resolve, reject, worker }
    this.waiters = [];
    this.bases = new Map();     // `${migration}|${dataset}` → datasetBase, to prepare a replacement worker
    this.hints = new Map();     // migration → slots per worker its handler asks for
    this.probes = new Map();    // migration → Promise<{ available, reasons }>
    this.dead = false;
  }

  get capacity() { return this.o.workers * this.o.slots; }

  slotsFor(migration) {
    const h = this.hints.get(migration);
    return h ? Math.max(1, Math.min(this.o.slots, h)) : this.o.slots;
  }

  /** Units in flight for `migration` (a handler holding more memory per unit asks for fewer). */
  capacityFor(migration) { return this.o.workers * this.slotsFor(migration); }

  /** Can this browser run `migration`? Asked once per pool, answered by the handler's probe. */
  probe(migration) {
    if (!this.probes.has(migration)) {
      this._ensure();
      const p = this._send(this.workers[0], { type: 'probe', migration })
        .then((r) => ({ available: !!(r && r.available), reasons: (r && r.reasons) || [] }));
      this.probes.set(migration, p);
    }
    return this.probes.get(migration);
  }

  _ensure() {
    while (this.workers.length < this.o.workers) {
      const w = this.o.spawn();
      const slot = { w, busy: 0, prepared: new Set() };
      w.onmessage = (e) => this._onMessage(slot, e.data || {});
      w.onerror = (e) => this._onCrash(slot, e);
      w.postMessage({ type: 'config', endpoint: this.o.endpoint, csrf: this.o.csrf() });
      this.workers.push(slot);
    }
  }

  _onMessage(slot, msg) {
    if (msg.type === 'net') { this.o.onNet?.(!!msg.online); return; }
    const p = this.pending.get(msg.reqId);
    if (!p) return;
    this.pending.delete(msg.reqId);
    if (p.unit) { slot.busy--; this._wake(); }
    p.resolve(msg);
  }

  _onCrash(slot, e) {
    // A dead worker fails its units (they are retried by the executor) and is replaced.
    const idx = this.workers.indexOf(slot);
    if (idx >= 0) this.workers.splice(idx, 1);
    try { slot.w.terminate(); } catch (_) { /* gone */ }
    for (const [id, p] of this.pending) {
      if (p.slot !== slot) continue;
      this.pending.delete(id);
      p.resolve(p.unit
        ? { type: 'unit_failed', key: p.unit, error: 'worker crashed: ' + (e && e.message || ''), fatal: false }
        : { ok: false, error: 'worker crashed' });
    }
    this._wake();
  }

  _wake() { const w = this.waiters.shift(); if (w) w(); }

  _send(slot, msg, unit) {
    const reqId = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(reqId, { resolve, slot, unit });
      slot.w.postMessage({ ...msg, reqId });
    });
  }

  refreshCsrf() { for (const s of this.workers) s.w.postMessage({ type: 'config', csrf: this.o.csrf() }); }

  async _prepareSlot(slot, dataset, migration, datasetBase) {
    const key = `${migration}|${dataset}`;
    const r = await this._send(slot, { type: 'prepare', migration, dataset, datasetBase });
    if (r && r.ok) slot.prepared.add(key);
    if (r && r.ok && Number.isInteger(r.slotsPerWorker) && r.slotsPerWorker > 0) this.hints.set(migration, r.slotsPerWorker);
    return r || { ok: false };
  }

  async prepare(dataset, migration, datasetBase) {
    this._ensure();
    const key = `${migration}|${dataset}`;
    this.bases.set(key, datasetBase);
    const todo = this.workers.filter((s) => !s.prepared.has(key));
    const replies = await Promise.all(todo.map((s) => this._prepareSlot(s, dataset, migration, datasetBase)));
    const bad = replies.find((r) => !r.ok);
    if (bad) throw Object.assign(new Error(bad.error || 'prepare failed'), { fatal: true, code: 'prepare_failed' });
  }

  async list(dataset, migration, opts) {
    this._ensure();
    const r = await this._send(this.workers[0], { type: 'list', migration, dataset, opts: opts || {} });
    if (!r.ok) throw new Error(r.error || 'list failed');
    return r.units;
  }

  /** Resolves the worker's unit_done / unit_failed message; waits for a free slot first. */
  async runUnit(dataset, migration, unit, dry) {
    for (;;) {
      if (this.dead) return { type: 'unit_failed', key: unit, error: 'terminated', aborted: true };
      // A worker that crashed was replaced: the replacement has not read the dataset yet.
      this._ensure();
      const slots = this.slotsFor(migration);
      const slot = this.workers.filter((s) => s.busy < slots).sort((a, b) => a.busy - b.busy)[0];
      if (slot) {
        slot.busy++;
        const key = `${migration}|${dataset}`;
        if (!slot.prepared.has(key) && this.bases.has(key)) {
          const r = await this._prepareSlot(slot, dataset, migration, this.bases.get(key));
          if (!r.ok) {
            slot.busy--;
            this._wake();
            return { type: 'unit_failed', key: unit, error: r.error || 'prepare failed', code: 'prepare_failed', fatal: true };
          }
        }
        return this._send(slot, { type: 'run', migration, dataset, unit, dry: !!dry }, unit);
      }
      await new Promise((r) => this.waiters.push(r));
    }
  }

  abortAll() { for (const s of this.workers) s.w.postMessage({ type: 'abort' }); }

  terminate() {
    this.dead = true;
    for (const s of this.workers) { try { s.w.terminate(); } catch (_) { /* gone */ } }
    this.workers = [];
    for (const p of this.pending.values()) p.resolve(p.unit ? { type: 'unit_failed', key: p.unit, error: 'terminated', aborted: true } : { ok: false, error: 'terminated' });
    this.pending.clear();
    while (this.waiters.length) this._wake();
  }
}

// The server refuses a unit whose inputs do not exist yet (its level's predecessor is not
// complete): not a failure, the unit comes back in a later wave.
const DEFER_CODES = new Set(['unit_blocked', 'not_runnable', 'level_pending']);

/**
 * Runs `keys` through `pool` with the migration's capacity in flight; stops early when
 * `ctl.stop()` says so. Resolves { left, deferred }.
 */
export async function runBrowserUnits({ pool, dataset, migration, keys, dry = false, ctl }) {
  const queue = keys.slice();
  const tries = new Map();
  const deferred = [];
  let fatal = null;
  const lane = async () => {
    while (queue.length && !fatal && !ctl.stop()) {
      const key = queue.shift();
      const r = await pool.runUnit(dataset, migration, key, dry);
      if (r.type === 'unit_done') { ctl.onUnit(r); continue; }
      if (r.aborted || ctl.stop()) { queue.unshift(key); return; }
      if (r.code && DEFER_CODES.has(r.code)) { deferred.push(key); continue; }
      const n = (tries.get(key) || 0) + 1;
      tries.set(key, n);
      if (r.fatal || n > UNIT_REQUEUE) {
        fatal = Object.assign(new Error(r.error || 'unit failed'), { status: r.status, code: r.code, unit: key });
        return;
      }
      queue.push(key);
    }
  };
  const cap = typeof pool.capacityFor === 'function' ? pool.capacityFor(migration) : pool.capacity;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(cap, keys.length)) }, lane));
  if (fatal) throw fatal;
  return { left: queue.length, deferred };
}

// ── Runner ────────────────────────────────────────────────────────────────────

/**
 * Drives the queue. Events (onEvent): { type: 'state' | 'progress' | 'job_done' | 'job_failed'
 * | 'log' | 'net', ... }. The executor of a job is `o.executorFor(migration)` when given, else
 * `executors[migration]`, else `executor` ('browser' | 'server'); it is read when a job starts
 * or resumes, so it may change while paused. null = nothing can run that migration: the job
 * fails with code `no_executor`.
 *
 * Progress events carry the dataset's chain: `step` (1-based), `steps`, `chain`, and
 * `etaChain` = this step's ETA + `o.estimateStep(dataset, migration)` of every later step
 * (null when one of them is unknown).
 *
 * @param {object} o
 * @param {object} o.api           createApi(...)
 * @param {() => WorkerPool} o.pool  lazily created browser pool
 * @param {(id: string) => string} o.datasetBase  absolute URL of the published dataset
 * @param {(e: object) => void} o.onEvent
 * @param {(migration: string) => string|null} [o.executorFor]
 * @param {(dataset: string, migration: string) => number|null} [o.estimateStep]  seconds
 * @param {() => number} [o.now]   seconds
 */
export class Runner {
  constructor(o) {
    this.o = o;
    this.now = o.now || (() => Date.now() / 1000);
    this.queue = [];          // [{ dataset, migration }]
    this.state = 'idle';      // idle | running | pausing | paused | failed
    this.executor = 'browser';
    this.executors = {};      // migration → 'browser' | 'server' (operator's choice)
    this.chains = new Map();  // dataset → [migration ids] in order, as enqueued
    this.current = null;      // { dataset, migration, done, total, bytesIn, bytesOut }
    this.meter = new Meter();
    this._stop = false;
    this._loop = null;
    this.reason = null;
    this.backoffMs = o.backoffMs || CALL_BACKOFF_MS;
  }

  _emit(e) { try { this.o.onEvent?.(e); } catch (err) { console.error(err); } }
  _setState(s, reason = null) { this.state = s; this.reason = reason; this._emit({ type: 'state', state: s, reason }); }

  /** Appends work; starts the loop unless paused. Items already queued are not duplicated. */
  enqueue(items) {
    for (const it of items) {
      if (!this.queue.some((q) => q.dataset === it.dataset && q.migration === it.migration)) this.queue.push(it);
      const chain = this.chains.get(it.dataset) || [];
      if (!chain.includes(it.migration)) chain.push(it.migration);
      this.chains.set(it.dataset, chain);
    }
    if (this.state === 'idle' || this.state === 'failed') this.start();
  }

  start() {
    if (this._loop) return this._loop;
    this._stop = false;
    // A re-login mints a new CSRF token: the workers must post with the current one.
    try { this._pool?.refreshCsrf(); } catch (_) { /* no pool yet */ }
    this._setState('running');
    this._loop = this._run().finally(() => { this._loop = null; });
    return this._loop;
  }

  /** Stops dispatching; units in flight finish (browser) or the current slice ends (server). */
  pause(reason = null) {
    if (this.state !== 'running') return;
    this._stop = true;
    this._setState('pausing', reason);
  }

  /** Pause now: units in flight are abandoned (their tiles may land; a retried unit is harmless). */
  pauseNow(reason = null) {
    this.pause(reason);
    try { this._pool?.abortAll(); } catch (_) { /* no pool */ }
  }

  resume() {
    if (this.state === 'paused' || this.state === 'failed') this.start();
  }

  /** Discards the current job on the server; resolves the cancel answer ({ ok } or null without a job). */
  async cancelCurrent() {
    const cur = this.current || this.queue[0];
    this.pauseNow('cancel');
    if (this._loop) await this._loop;
    if (!cur) return null;
    const res = await this.o.api.cancel(cur.dataset, cur.migration);
    // The other migrations of that dataset depend on this one: drop them as well.
    this.queue = this.queue.filter((q) => q.dataset !== cur.dataset);
    this.chains.delete(cur.dataset);
    this.current = null;
    this._emit({ type: 'log', level: 'info', dataset: cur.dataset, migration: cur.migration, code: 'cancelled' });
    this._setState(this.queue.length ? 'paused' : 'idle');
    return res;
  }

  executorFor(migration) {
    if (this.o.executorFor) return this.o.executorFor(migration);
    return this.executors[migration] || this.executor;
  }

  /** { step, steps, chain } of `dataset`'s migration `migration` (1-based step). */
  chainPosition(dataset, migration) {
    const chain = this.chains.get(dataset) || [migration];
    const i = chain.indexOf(migration);
    return { step: i >= 0 ? i + 1 : 1, steps: chain.length, chain: chain.slice() };
  }

  get pool() {
    if (!this._pool) this._pool = this.o.pool();
    return this._pool;
  }

  async _run() {
    while (this.queue.length) {
      if (this._stop) { this._setState('paused', this.reason); return; }
      const item = this.queue[0];
      let outcome;
      try {
        outcome = await this._runJob(item);
      } catch (err) {
        if (err && err.status === 401) { this._setState('paused', 'unauthorized'); return; }
        // The link stayed down through every retry: the journal is intact, wait for a resume.
        if (err && err.pause) { this._setState('paused', err.pause); return; }
        this.queue.shift();
        // The rest of this dataset's chain cannot run on a dataset whose step failed.
        this.queue = this.queue.filter((q) => q.dataset !== item.dataset);
        this.chains.delete(item.dataset);
        this.current = null;
        this._emit({ type: 'job_failed', dataset: item.dataset, migration: item.migration, error: String(err && err.message || err), code: err && err.code || null, detail: err && err.detail || null });
        continue;
      }
      if (outcome === 'paused') { this._setState('paused', this.reason); return; }
      this.queue.shift();
      this.current = null;
      if (!this.queue.some((q) => q.dataset === item.dataset)) this.chains.delete(item.dataset);
    }
    this._setState('idle');
  }

  _sleep(ms) {
    // Sliced so that a pause does not wait out a long back-off.
    return new Promise((resolve) => {
      const end = Date.now() + ms;
      const tick = () => (this._stop || Date.now() >= end ? resolve() : setTimeout(tick, Math.min(250, end - Date.now())));
      tick();
    });
  }

  /**
   * One API call with bounded retries of transient failures: no answer (status 0), 429, or
   * a 5xx (a proxy, a PHP fatal, a restart, a file still locked by an antivirus during a
   * swap). A 4xx is the job's verdict and is never retried.
   * Resolves the answer, or { stopped: true } when a pause arrives during a back-off.
   */
  async _call(fn) {
    let offline = false;
    for (let attempt = 1; ; attempt++) {
      const r = await fn();
      // A 5xx that names a definitive refusal (a unit the server cannot convert in time) is
      // not retried: the next call would only meet the same answer.
      const definitive = !!(r && r.data && typeof r.data.error === 'string' && DEFINITIVE_CODES.has(r.data.error));
      const transient = !r || r.status === 0 || r.status === 429 || (r.status >= 500 && !definitive);
      if (!transient || attempt >= CALL_ATTEMPTS) {
        if (offline) this._emit({ type: 'net', online: true });
        if (transient && (!r || r.status === 0)) {
          throw Object.assign(new Error('the server cannot be reached'), { status: 0, code: 'request_failed', pause: 'offline' });
        }
        return r;
      }
      if ((!r || r.status === 0) && !offline) { offline = true; this._emit({ type: 'net', online: false }); }
      await this._sleep(this.backoffMs[Math.min(attempt - 1, this.backoffMs.length - 1)]);
      if (this._stop) {
        if (offline) this._emit({ type: 'net', online: true });
        return { stopped: true };
      }
    }
  }

  async _runJob(item) {
    const { api } = this.o;
    const executor = this.executorFor(item.migration);
    if (executor !== 'browser' && executor !== 'server') {
      throw Object.assign(new Error('no executor can run ' + item.migration), { code: 'no_executor' });
    }
    let plan = await this._call(() => api.plan(item.dataset, item.migration));
    if (plan.stopped) return 'paused';
    if (!plan.ok || !plan.data) throw apiError(plan, 'plan failed');
    let p = plan.data;
    const cur = this.current = {
      dataset: item.dataset, migration: item.migration, executor,
      total: p.total || 0, done: p.done || 0, empty: p.empty || 0,
      bytesIn: 0, bytesOut: 0, startedAt: this.now(), ...this.chainPosition(item.dataset, item.migration),
    };
    this.meter.reset();
    this.meter.add(this.now(), 0);
    const later = () => {
      let sum = 0;
      for (const mid of cur.chain.slice(cur.step)) {
        const e = this.o.estimateStep ? this.o.estimateStep(item.dataset, mid) : null;
        if (typeof e !== 'number' || !(e >= 0)) return null;   // unknown (null >= 0 is true in JS)
        sum += e;
      }
      return sum;
    };
    const progress = () => {
      const eta = this.meter.eta(Math.max(0, cur.total - cur.done));
      const rest = later();
      this._emit({
        type: 'progress', ...cur, chain: cur.chain.slice(),
        rate: this.meter.rate(), eta, etaChain: eta !== null && rest !== null ? eta + rest : null,
      });
    };
    progress();

    // Waves: the units runnable now (every pending one unless the server names fewer), then a
    // re-plan. A wave that moves nothing forward counts toward MAX_PASSES.
    let idle = 0;
    for (;;) {
      if (cur.done >= cur.total) break;
      const pending = Array.isArray(p.units) ? p.units : [];
      const keys = Array.isArray(p.runnable) ? p.runnable : pending;
      if (!keys.length && !pending.length) break;
      const before = cur.done;
      if (executor === 'server') {
        await this._runServer(cur, progress);
      } else if (keys.length) {
        await this.pool.prepare(item.dataset, item.migration, this.o.datasetBase(item.dataset));
        await runBrowserUnits({
          pool: this.pool, dataset: item.dataset, migration: item.migration, keys,
          ctl: {
            stop: () => this._stop,
            onUnit: (r) => {
              cur.done = Number.isFinite(r.done) ? r.done : cur.done + 1;
              if (Number.isFinite(r.total)) cur.total = r.total;
              cur.bytesIn += r.bytesIn || 0;
              cur.bytesOut += r.bytesOut || 0;
              this.meter.add(this.now(), 1);
              progress();
            },
          },
        });
      }
      if (this._stop) return 'paused';
      if (cur.done >= cur.total) break;   // finalize checks the journal itself
      // The server's count is the truth (a unit acknowledged twice, a page boundary), and the
      // next wave is the server's to name.
      plan = await this._call(() => api.plan(item.dataset, item.migration));
      if (plan.stopped) return 'paused';
      if (!plan.ok || !plan.data) throw apiError(plan, 'plan failed');
      p = plan.data;
      const advanced = p.done > before;
      cur.done = p.done; cur.total = p.total;
      progress();
      if (cur.done >= cur.total) break;
      if (this._stop) return 'paused';
      idle = advanced ? 0 : idle + 1;
      // Units the server keeps listing without any landing are not going to land.
      if (idle >= MAX_PASSES) throw Object.assign(new Error('units still pending after ' + idle + ' passes'), { code: 'incomplete' });
    }
    cur.phase = 'finalizing';
    progress();
    let fin;
    let stalled = 0;
    for (;;) {
      fin = await this._call(() => api.finalize(item.dataset, item.migration));
      if (fin.stopped) return 'paused';
      if (!fin.ok || !fin.data || fin.data.ok === false) throw apiError(fin, 'finalize failed');
      if (fin.data.complete !== false) break;
      const a = fin.data.assembly || {};
      const written = Number(a.written) || 0;
      stalled = cur.assembly && written <= cur.assembly.written ? stalled + 1 : 0;
      if (stalled >= MAX_STALLED_ASSEMBLY) throw Object.assign(new Error('assembly makes no progress'), { code: 'no_progress' });
      cur.assembly = { planes: Number(a.planes) || 0, written };
      progress();
      // The assembled planes stay on the server: pausing here resumes the assembly later.
      if (this._stop) return 'paused';
    }
    cur.assembly = null;
    this._emit({
      type: 'job_done', dataset: item.dataset, migration: item.migration, executor,
      formatVersion: fin.data.formatVersion, seconds: this.now() - cur.startedAt,
      bytesIn: cur.bytesIn, bytesOut: cur.bytesOut, units: cur.total,
    });
    return 'done';
  }

  async _runServer(cur, progress) {
    // A host with a short time limit stores a unit in octants across several calls
    // (`partial: [{unit, parts, of}]`): more octants stored than last time is progress
    // too, or a slow host would be stopped with no_progress half-way through a unit.
    let lastParts = 0;
    while (!this._stop && cur.done < cur.total) {
      // Transient failures back off inside _call (bounded); the job state is on the server.
      const r = await this._call(() => this.o.api.unitRun(cur.dataset, cur.migration, false));
      if (r.stopped) return;
      if (!r.ok || !r.data) throw apiError(r, 'unit_run failed');
      const before = cur.done;
      cur.done = r.data.done; cur.total = r.data.total;
      cur.bytesIn += r.data.bytesRead || 0;
      cur.bytesOut += r.data.bytesWritten || 0;
      const n = Math.max(0, cur.done - before);
      if (n) this.meter.add(this.now(), n);
      const parts = (Array.isArray(r.data.partial) ? r.data.partial : [])
        .reduce((s, p) => s + (Number(p && p.parts) || 0), 0);
      const partsMoved = parts > lastParts;
      lastParts = parts;
      cur.partial = parts;
      progress();
      if (!n && !(r.data.processed || []).length && !partsMoved) {
        throw Object.assign(new Error('server made no progress'), { code: 'no_progress' });
      }
    }
  }

  destroy() {
    this._stop = true;
    this._pool?.terminate();
    this._pool = null;
  }
}

// ── Benchmarks ────────────────────────────────────────────────────────────────

/**
 * Browser: `n` non-empty sample units, real downloads + decode + encode + dry upload.
 * secondsPerUnit is the WALL time per unit at the pool's concurrency (what an update costs).
 */
export async function benchBrowser({ pool, dataset, migration, datasetBase, n = 4, now = () => performance.now() / 1000 }) {
  const cap = typeof pool.probe === 'function' ? await pool.probe(migration) : { available: true };
  if (!cap.available) {
    throw Object.assign(new Error('this browser cannot run ' + migration), { code: (cap.reasons && cap.reasons[0]) || 'unavailable' });
  }
  await pool.prepare(dataset, migration, datasetBase);
  // `sample`: the units whose inputs exist before any job (m004: level 0 only).
  const units = (await pool.list(dataset, migration, { sample: true })).filter((u) => !u.empty).map((u) => u.key);
  const sample = sampleEvenly(units, n);
  if (!sample.length) return { units: 0, secondsPerUnit: null, bytesIn: 0, bytesOut: 0 };
  let bytesIn = 0, bytesOut = 0, unitSeconds = 0;
  const t0 = now();
  await runBrowserUnits({
    pool, dataset, migration, keys: sample, dry: true,
    ctl: { stop: () => false, onUnit: (r) => { bytesIn += r.bytesIn || 0; bytesOut += r.bytesOut || 0; unitSeconds += r.seconds || 0; } },
  });
  const wall = now() - t0;
  return {
    migration, dataset, units: sample.length, seconds: wall, secondsPerUnit: wall / sample.length,
    unitSeconds: unitSeconds / sample.length, bytesIn, bytesOut, nonEmptyUnits: units.length,
  };
}

export async function benchServer({ api, dataset, migration, n = 4 }) {
  const r = await api.bench(dataset, Math.min(8, n), migration);
  if (!r.ok || !r.data) throw apiError(r, 'bench failed');
  const d = r.data;
  return {
    migration, dataset, units: d.units, seconds: d.seconds,
    secondsPerUnit: d.secondsPerUnit > 0 ? d.secondsPerUnit : (d.units > 0 ? d.seconds / d.units : null),
    bytesIn: d.bytesRead || 0, bytesOut: d.bytesWritten || 0, sample: d.sample || null,
  };
}
