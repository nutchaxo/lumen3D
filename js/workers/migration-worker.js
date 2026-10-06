/* ============================================================
   Lumen3D — dataset migration worker (browser executor, SPEC §6-A)
   ============================================================
   Executes work units of a dataset migration off the main thread: range-reads the
   unit's source bytes, hands them to the migration's handler module (decode, re-cut,
   encode) and POSTs the result to /api/migrations.php?action=unit_put.

   Generic: nothing here knows a migration. The handler is a classic script under
   js/migrations/<id>.js that registers itself on `self.LumenMigrationHandlers[id]`:
     prepare(ctx)                → state     ctx = { datasetBase, fetchJson(url), fetchText(url) }
     listUnits(state, opts)      → [{ key, empty, level? }]   (may be async; opts.sample = for a benchmark)
     planUnitWork(key, state)    → work      (may be async)
     runUnit(work, state, io)    → { body: Uint8Array unit blob, bytesIn, tiles }
                                   io = { fetchRange(url, start, end), fetchStored(req) → [{bz, by, bx, bytes}], signal }
     probe()                     → { available, reasons:[codes] }   optional: can THIS browser run it
     requires: [ids]             optional: handlers whose code this one reuses (imported after it)
     slotsPerWorker: n           optional: units one worker may hold at once (memory bound)
   (see js/migrations/m002-planes.js, m003-layer-mips.js, m004-bricks-v3.js).

   Concurrency is owned by the page: it never posts more `run` messages than the slots
   it gave this worker, so the worker holds at most that many units in memory.

   Messages in:
     config  { endpoint, csrf }
     probe   { reqId, migration }                         → probed   { reqId, ok, available, reasons }
     prepare { reqId, migration, dataset, datasetBase }  → prepared { reqId, ok, error?, trees?, slotsPerWorker? }
     list    { reqId, migration, dataset, opts? }         → listed   { reqId, units:[{key, empty}] }
     run     { reqId, migration, dataset, unit, dry }     → unit_done { reqId, key, done, total, bytesIn,
                                                              bytesOut, tiles, seconds } | unit_failed
                                                              { reqId, key, error, status, fatal }
     speedtest { reqId, sampleUrl }                       → speedtest_done { reqId, ok, bytesIn, bytesOut,
                                                              seconds, error?, code? }
                                                              one block of the executors' speed test
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
// Units waiting for the link: `offline` when the first one starts waiting, `online` when the
// last one leaves — on success AND on abort, or a unit paused mid-wait would leave the page
// announcing a lost connection while every later request goes through.
let _waiting = 0;
async function waitForLink(signal) {
  if (_waiting++ === 0) post({ type: 'net', online: false });
  try {
    await _waitForLink(signal);
  } finally {
    if (--_waiting === 0) post({ type: 'net', online: true });
  }
}

async function _waitForLink(signal) {
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

async function fetchText(url) {
  return withRetries(async () => {
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-cache' });
    if (!res.ok) throw httpError(res.status, null, `HTTP ${res.status} for ${url}`);
    return res.text();
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

const STORE_PARALLEL = 8;

/** One stored output of this job (GET action=store_get); null when the server holds none. */
async function storeGet(migration, dataset, key, signal) {
  const q = new URLSearchParams({ action: 'store_get', dataset, migration, brick: key });
  return withRetries(async () => {
    const res = await fetch(`${_endpoint}?${q}`, { credentials: 'same-origin', cache: 'no-store', signal });
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    // 404 `absent` = a brick dropped by ESS (its interior is zero): the reader treats it as zeros.
    if (res.status === 404 && data && data.error === 'absent') return null;
    const err = httpError(res.status, data && data.error, (data && (data.message || data.error)) || `HTTP ${res.status}`);
    if (data && data.detail) err.detail = String(data.detail);
    throw err;
  }, signal);
}

/**
 * Outputs this job already produced and the server holds, for a migration whose later units
 * read earlier ones (m004: level k+1 from level k). req = { t, level, channel, bricks:
 * [[bz, by, bx]…] }; answered as the list [{ bz, by, bx, bytes }] of the bricks that exist
 * (an absent one is all zeros), in request order. A list, not one concatenated blob: a level-k
 * unit reads up to 10³ stored bricks, and a copy of all of them would double the unit's peak.
 */
async function fetchStored(migration, dataset, req, signal) {
  const list = Array.isArray(req.bricks) ? req.bricks : [];
  const found = new Array(list.length).fill(null);
  let next = 0;
  let failed = false;
  const lane = async () => {
    while (next < list.length && !failed) {
      const i = next++;
      const [bz, by, bx] = list[i];
      try {
        found[i] = await storeGet(migration, dataset, `t${req.t}.k${req.level}.c${req.channel}.z${bz}.y${by}.x${bx}`, signal);
      } catch (err) { failed = true; throw err; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(STORE_PARALLEL, list.length)) }, lane));
  const out = [];
  list.forEach(([bz, by, bx], i) => { if (found[i]) out.push({ bz, by, bx, bytes: found[i] }); });
  return out;
}

const ID_RE = /^m\d{3}-[a-z0-9-]+$/;

function _import(migration) {
  if (!ID_RE.test(String(migration))) throw new Error('bad migration id');
  if (!_loaded.has(migration)) {
    importScripts(`../migrations/${migration}.js${_V}`);
    _loaded.add(migration);
  }
  const h = self.LumenMigrationHandlers && self.LumenMigrationHandlers[migration];
  if (!h) throw new Error('no browser handler for ' + migration);
  return h;
}

function handlerFor(migration) {
  const h = _import(migration);
  for (const dep of Array.isArray(h.requires) ? h.requires : []) _import(dep);
  return h;
}

async function onProbe(msg) {
  try {
    const h = handlerFor(msg.migration);
    const r = typeof h.probe === 'function' ? await h.probe() : { available: true, reasons: [] };
    post({ type: 'probed', reqId: msg.reqId, ok: true, available: !!(r && r.available), reasons: (r && r.reasons) || [] });
  } catch (err) {
    post({ type: 'probed', reqId: msg.reqId, ok: false, available: false, reasons: ['no_handler'], error: String(err && err.message || err) });
  }
}

async function onPrepare(msg) {
  try {
    const h = handlerFor(msg.migration);
    const state = await h.prepare({ datasetBase: msg.datasetBase, fetchJson, fetchText });
    _states.set(`${msg.migration}|${msg.dataset}`, state);
    post({
      type: 'prepared', reqId: msg.reqId, ok: true, trees: state.trees ? state.trees.length : null,
      slotsPerWorker: Number.isInteger(h.slotsPerWorker) && h.slotsPerWorker > 0 ? h.slotsPerWorker : null,
    });
  } catch (err) {
    post({ type: 'prepared', reqId: msg.reqId, ok: false, error: String(err && err.message || err) });
  }
}

function stateOf(msg) {
  const s = _states.get(`${msg.migration}|${msg.dataset}`);
  if (!s) throw new Error('dataset not prepared');
  return s;
}

async function onList(msg) {
  try {
    const units = await handlerFor(msg.migration).listUnits(stateOf(msg), msg.opts || {});
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
    const work = await h.planUnitWork(msg.unit, state);
    const io = {
      fetchRange: (url, s, e) => fetchRange(url, s, e, ac.signal),
      fetchStored: (req) => fetchStored(msg.migration, msg.dataset, req, ac.signal),
      signal: ac.signal,
    };
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

// One block of the executors' speed test (dataset_migrations.speedtest is the server's side):
// download the synthetic test brick, decode its lossless-WebP mosaic, encode the 64³ voxels as
// one 512² png-gray8 tile and upload it to a sink that drops it — the work a browser unit does
// for each brick, transfers included. No retry: a failure ends the browser's run of the test.
const SPEEDTEST_DECODER = 'm002-planes';
const SPEEDTEST_TREE = { encoding: 'webp-lossless', packing: { mode: 'grid', cols: 8 } };
let _speedSeq = 0;

async function onSpeedtest(msg) {
  const ac = new AbortController();
  _inflight.set(msg.reqId, ac);
  const t0 = performance.now();
  try {
    const decodeBrick = handlerFor(SPEEDTEST_DECODER)._internals.decodeBrick;
    const sep = msg.sampleUrl.includes('?') ? '&' : '?';
    const res = await fetch(`${msg.sampleUrl}${sep}st=${Date.now()}-${++_speedSeq}`, { credentials: 'same-origin', cache: 'no-store', signal: ac.signal });
    if (!res.ok) throw httpError(res.status, 'speedtest_sample_missing', `HTTP ${res.status} for the test brick`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const voxels = await decodeBrick(bytes, SPEEDTEST_TREE, 0);
    const png = await PlaneCodec.encodePngGray(512, 512, voxels);
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (_csrf) headers['X-CSRF-Token'] = _csrf;
    const put = await fetch(`${_endpoint}?action=speedtest_put`, { method: 'POST', headers, body: png, credentials: 'same-origin', signal: ac.signal });
    let data = null;
    try { data = await put.json(); } catch (_) { data = null; }
    if (!put.ok || !data || data.ok === false) throw httpError(put.status, data && data.error, `HTTP ${put.status} for the test upload`);
    post({ type: 'speedtest_done', reqId: msg.reqId, ok: true, bytesIn: bytes.length, bytesOut: png.length, seconds: (performance.now() - t0) / 1000 });
  } catch (err) {
    post({
      type: 'speedtest_done', reqId: msg.reqId, ok: false,
      error: String(err && err.message || err),
      code: err && err.code || (typeof CompressionStream === 'undefined' ? 'no_compression_stream' : null),
      status: err && err.status || 0,
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
    case 'probe': onProbe(msg); break;
    case 'prepare': onPrepare(msg); break;
    case 'list': onList(msg); break;
    case 'run': onRun(msg); break;
    case 'speedtest': onSpeedtest(msg); break;
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
