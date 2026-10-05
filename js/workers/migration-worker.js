/* ============================================================
   Lumen3D — dataset migration worker (browser executor, SPEC §6-A)
   ============================================================
   Executes work units of a dataset migration off the main thread: range-reads the
   unit's source bytes, hands them to the migration's handler module (decode, re-cut,
   encode) and POSTs the result to /api/migrations.php?action=unit_put.

   Generic: nothing here knows a migration. The handler is a classic script under
   js/migrations/<id>.js that registers itself on `self.LumenMigrationHandlers[id]`
   with { prepare, listUnits, planUnitWork, runUnit } (see js/migrations/m002-planes.js).

   Concurrency is owned by the page: it never posts more `run` messages than the slots
   it gave this worker, so the worker holds at most that many units in memory.

   Messages in:
     config  { endpoint, csrf }
     prepare { reqId, migration, dataset, datasetBase }  → prepared { reqId, ok, error?, trees? }
     list    { reqId, migration, dataset }                → listed   { reqId, units:[{key, empty}] }
     run     { reqId, migration, dataset, unit, dry }     → unit_done { reqId, key, done, total, bytesIn,
                                                              bytesOut, tiles, seconds } | unit_failed
                                                              { reqId, key, error, status, fatal }
     abort   { reqId? }   abort one unit, or every unit in flight
   Messages out, besides the replies: net { online: bool } while a request waits for the link.
   ============================================================ */

'use strict';

const _V = (() => { try { return new URL(self.location.href).search; } catch (_) { return ''; } })();
importScripts('../core/plane-codec.js' + _V);

let _endpoint = '';
let _csrf = null;
const _states = new Map();      // `${migration}|${dataset}` → handler state
const _inflight = new Map();    // reqId → AbortController
const _loaded = new Set();

const MAX_ATTEMPTS = 6;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30000;
const RETRYABLE_STATUS = new Set([408, 423, 425, 429, 500, 502, 503, 504]);
// A request that keeps dying while the probe right after it gets an answer is not an outage:
// the request itself fails (a proxy cutting bodies, a server closing before reading them).
// Each such failure costs one of these, so a unit cannot loop forever on it.
const MAX_NET_FAILS = 8;

function post(msg) { self.postMessage(msg); }

function backoffMs(attempt) {
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(abortError()); return; }
    const id = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(id); reject(abortError()); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError() { return Object.assign(new Error('aborted'), { name: 'AbortError' }); }

function httpError(status, code, message) {
  return Object.assign(new Error(message || code || ('HTTP ' + status)), {
    status, code: code || null,
    fatal: !RETRYABLE_STATUS.has(status),
  });
}

// The link being down costs time, never attempts: wait for `online` or for any HTTP
// answer to a cheap probe, with a growing delay, as long as the unit is not aborted.
let _offline = false;
async function waitForLink(signal) {
  if (!_offline) { _offline = true; post({ type: 'net', online: false }); }
  let delay = 2000;
  for (;;) {
    let onOnline = null;
    try {
      await Promise.race([
        sleep(delay, signal),
        new Promise((r) => { onOnline = r; self.addEventListener('online', r, { once: true }); }),
      ]);
    } finally {
      // A long outage loops here many times: never leave one listener per turn behind.
      if (onOnline) self.removeEventListener('online', onOnline);
    }
    if (signal && signal.aborted) throw abortError();
    try {
      await fetch(`${_endpoint}?action=ping&t=${Date.now()}`, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal });
      break;   // any answer, even a 4xx, means the link is back
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      delay = Math.min(15000, Math.round(delay * 1.6));
    }
  }
  if (_offline) { _offline = false; post({ type: 'net', online: true }); }
}

/** `attemptFn()` resolves a value or throws; network failures wait, server failures back off. */
async function withRetries(attemptFn, signal) {
  let attempt = 0;
  let netFails = 0;
  for (;;) {
    if (signal && signal.aborted) throw abortError();
    try {
      return await attemptFn();
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      if (err && err.status === undefined) {   // no HTTP answer: the request never made it
        if (++netFails >= MAX_NET_FAILS) {
          throw Object.assign(new Error('request keeps failing: ' + (err.message || err)), { status: 0, code: 'request_failed', fatal: false });
        }
        await waitForLink(signal);
        continue;
      }
      attempt++;
      if (err.fatal || attempt >= MAX_ATTEMPTS) throw err;
      await sleep(backoffMs(attempt), signal);
    }
  }
}

async function fetchJson(url) {
  return withRetries(async () => {
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-cache' });
    if (!res.ok) throw httpError(res.status, null, `HTTP ${res.status} for ${url}`);
    try { return await res.json(); } catch (_) { throw httpError(422, 'bad_json', 'invalid JSON at ' + url); }
  }, null);
}

async function fetchRange(url, start, end, signal) {
  return withRetries(async () => {
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` }, credentials: 'same-origin', signal });
    if (res.status !== 206 && res.status !== 200) throw httpError(res.status, null, `HTTP ${res.status} for ${url}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    // A 200 is the whole pack (a host that ignores Range): keep only the asked bytes.
    const out = res.status === 200 ? buf.subarray(start, end) : buf;
    if (out.length !== end - start) throw httpError(502, 'short_read', `short read ${out.length}/${end - start} at ${url}`);
    return out;
  }, signal);
}

async function putUnit(migration, dataset, unit, body, dry, signal) {
  const q = new URLSearchParams({ action: 'unit_put', dataset, migration, unit, dry: dry ? '1' : '0' });
  return withRetries(async () => {
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (_csrf) headers['X-CSRF-Token'] = _csrf;
    const res = await fetch(`${_endpoint}?${q}`, { method: 'POST', headers, body, credentials: 'same-origin', signal });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok || !data || data.ok === false) {
      const err = httpError(res.ok ? 500 : res.status, data && data.error, (data && (data.message || data.error)) || `HTTP ${res.status}`);
      if (data && data.detail) err.detail = String(data.detail);
      throw err;
    }
    return data;
  }, signal);
}

function handlerFor(migration) {
  if (!/^m\d{3}-[a-z0-9-]+$/.test(String(migration))) throw new Error('bad migration id');
  if (!_loaded.has(migration)) {
    importScripts(`../migrations/${migration}.js${_V}`);
    _loaded.add(migration);
  }
  const h = self.LumenMigrationHandlers && self.LumenMigrationHandlers[migration];
  if (!h) throw new Error('no browser handler for ' + migration);
  return h;
}

async function onPrepare(msg) {
  try {
    const h = handlerFor(msg.migration);
    const state = await h.prepare({ datasetBase: msg.datasetBase, fetchJson });
    _states.set(`${msg.migration}|${msg.dataset}`, state);
    post({ type: 'prepared', reqId: msg.reqId, ok: true, trees: state.trees ? state.trees.length : null });
  } catch (err) {
    post({ type: 'prepared', reqId: msg.reqId, ok: false, error: String(err && err.message || err) });
  }
}

function stateOf(msg) {
  const s = _states.get(`${msg.migration}|${msg.dataset}`);
  if (!s) throw new Error('dataset not prepared');
  return s;
}

function onList(msg) {
  try {
    const units = handlerFor(msg.migration).listUnits(stateOf(msg));
    post({ type: 'listed', reqId: msg.reqId, ok: true, units });
  } catch (err) {
    post({ type: 'listed', reqId: msg.reqId, ok: false, error: String(err && err.message || err) });
  }
}

async function onRun(msg) {
  const ac = new AbortController();
  _inflight.set(msg.reqId, ac);
  const t0 = performance.now();
  try {
    const h = handlerFor(msg.migration);
    const state = stateOf(msg);
    const work = h.planUnitWork(msg.unit, state);
    const io = { fetchRange: (url, s, e) => fetchRange(url, s, e, ac.signal), signal: ac.signal };
    const res = await h.runUnit(work, state, io);
    const reply = await putUnit(msg.migration, msg.dataset, msg.unit, res.body, !!msg.dry, ac.signal);
    post({
      type: 'unit_done', reqId: msg.reqId, key: msg.unit,
      done: reply.done, total: reply.total,
      bytesIn: res.bytesIn, bytesOut: res.body.length, tiles: res.tiles,
      seconds: (performance.now() - t0) / 1000,
    });
  } catch (err) {
    post({
      type: 'unit_failed', reqId: msg.reqId, key: msg.unit,
      error: String(err && err.message || err),
      code: err && err.code || (err && err.name === 'AbortError' ? 'aborted' : null),
      status: err && err.status || 0,
      fatal: !!(err && err.fatal),
      aborted: !!(err && err.name === 'AbortError'),
    });
  } finally {
    _inflight.delete(msg.reqId);
  }
}

self.onmessage = (e) => {
  const msg = e.data || {};
  switch (msg.type) {
    case 'config':
      if (msg.endpoint) _endpoint = msg.endpoint;
      if (msg.csrf !== undefined) _csrf = msg.csrf;
      break;
    case 'prepare': onPrepare(msg); break;
    case 'list': onList(msg); break;
    case 'run': onRun(msg); break;
    case 'abort':
      if (msg.reqId !== undefined && msg.reqId !== null) _inflight.get(msg.reqId)?.abort();
      else for (const ac of _inflight.values()) ac.abort();
      break;
    case 'forget':
      _states.delete(`${msg.migration}|${msg.dataset}`);
      break;
    default: break;
  }
};
