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
     planUnitWork(key, state, io) → work     (may be async; io as below)
     runUnit(work, state, io)    → { body: Uint8Array unit blob, bytesIn, tiles }
                                   io = { fetchRange(url, start, end), fetchRanges([{url, start, end}]),
                                          fetchStored(req) → [{bz, by, bx, bytes}],
                                          readRels([{rel, start, end}]) → [Uint8Array]  (read_ranges by
                                            dataset-relative path, `@store/…` included),
                                          unitInputs() → the server's unit_inputs answer, signal }
     probe()                     → { available, reasons:[codes] }   optional: can THIS browser run it
     requires: [ids]             optional: handlers whose code this one reuses (imported after it)
     slotsPerWorker: n           optional: units one worker may hold at once (memory bound)
     batchUnits: n               optional: the handler takes n units per batch (run_batch): their
                                 inputs in one unit_inputs_many, the shared byte runs read once,
                                 their results in one unit_put_many (m005)
   (see js/migrations/m002-planes.js, m003-layer-mips.js, m004-bricks-v3.js).

   Concurrency is owned by the page: it never posts more `run` messages than the slots
   it gave this worker, so the worker holds at most that many units in memory.

   Messages in:
     config  { endpoint, csrf, governed }
     probe   { reqId, migration }                         → probed   { reqId, ok, available, reasons }
     prepare { reqId, migration, dataset, datasetBase }  → prepared { reqId, ok, error?, trees?, slotsPerWorker? }
     list    { reqId, migration, dataset, opts? }         → listed   { reqId, units:[{key, empty}] }
     run_batch { reqId, migration, dataset, units, dry }  → batch_done { reqId, results: [unit_done |
                                                              unit_failed without reqId] } | batch_unsupported
     run     { reqId, migration, dataset, unit, dry }     → unit_done { reqId, key, done, total, bytesIn,
                                                              bytesOut, tiles, seconds } | unit_failed
                                                              { reqId, key, error, status, fatal }
     speedtest { reqId, n }                               → speedtest_done { reqId, ok, blocks, bytesIn,
                                                              bytesOut, seconds, error?, code? }
                                                              one batch of the executors' speed test
     net_grant { id }     the page's governor lets request `id` start (see governed())
     abort   { reqId? }   abort one unit, or every unit in flight
   Messages out, besides the replies: net { online: bool } while a request waits for the link;
   net_acquire { id } / net_release { id, outcome } around every request when governed.
   ============================================================ */

'use strict';

const _V = (() => { try { return new URL(self.location.href).search; } catch (_) { return ''; } })();
importScripts('../core/plane-codec.js' + _V);

let _endpoint = '';
let _csrf = null;
// The largest body one request may carry on this host (status.server.maxUnitBody: the PHP
// host's post_max_size): a batch is flushed below it, a larger unit goes in pieces.
let _maxBody = 8 * 1024 * 1024;
const _states = new Map();      // `${migration}|${dataset}` → handler state
const _bases = new Map();       // `${migration}|${dataset}` → absolute URL of the published dataset
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

// Every request waits for its turn from the page's network governor (migration-runner.js
// NetGovernor, relayed by the pool): `net_acquire` → `net_grant`, then `net_release` with the
// outcome once the body has been read in full, so the page bounds the requests in flight and per
// second across every worker. A shared host's firewall bans an address that floods it.
let _governed = false;
let _turnSeq = 0;
const _turns = new Map();   // id → resolve

function netTurn() {
  if (!_governed) return Promise.resolve(null);
  const id = ++_turnSeq;
  return new Promise((resolve) => { _turns.set(id, () => resolve(id)); post({ type: 'net_acquire', id }); });
}

/** Runs `fn()` (one request, body included) in a governed turn; the outcome steers the governor. */
async function governed(fn) {
  const id = await netTurn();
  let outcome = 'ok';
  try {
    return await fn();
  } catch (err) {
    outcome = err && err.name === 'AbortError' ? 'cancel'
      : err && err.status === undefined ? 'fail'
        : err && (err.status === 429 || err.status === 503) ? 'throttled' : 'ok';
    throw err;
  } finally {
    if (id !== null) post({ type: 'net_release', id, outcome });
  }
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
      await governed(() => fetch(`${_endpoint}?action=ping&t=${Date.now()}`, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal }).then((r) => r.arrayBuffer()));
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
      return await governed(attemptFn);
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

// Stored bricks travel in batches (action store_get_many): a level-k+1 unit reads up to 10³ of
// them, and one request per brick is a flood a shared host's firewall bans the operator's
// address for. Two batches in flight per unit; every request also waits for the page's governor.
const STORE_BATCH = 128;
const STORE_PARALLEL = 2;
let _storeManyMissing = false;   // a server older than store_get_many: one brick per request

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

/** Up to STORE_BATCH stored bricks of one (t, level, channel): Uint8Array views (null = absent) in request order. */
async function storeGetMany(migration, dataset, req, part, signal) {
  const q = new URLSearchParams({
    action: 'store_get_many', dataset, migration, base: `t${req.t}.k${req.level}.c${req.channel}`,
    bricks: part.map(([bz, by, bx]) => `${bz}.${by}.${bx}`).join(','),
  });
  return withRetries(async () => {
    const res = await fetch(`${_endpoint}?${q}`, { credentials: 'same-origin', cache: 'no-store', signal });
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }
      const err = httpError(res.status, data && data.error, (data && (data.message || data.error)) || `HTTP ${res.status}`);
      if (data && data.detail) err.detail = String(data.detail);
      throw err;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const n = buf.length >= 4 ? view.getUint32(0, true) : -1;
    if (n !== part.length || buf.length < 4 + 4 * n) throw httpError(502, 'short_read', 'store_get_many: bad header');
    const out = new Array(n);
    let at = 4 + 4 * n;
    for (let i = 0; i < n; i++) {
      const len = view.getUint32(4 + 4 * i, true);
      if (at + len > buf.length) throw httpError(502, 'short_read', 'store_get_many: truncated');
      out[i] = len ? buf.subarray(at, at + len) : null;
      at += len;
    }
    return out;
  }, signal);
}

/**
 * Outputs this job already produced and the server holds, for a migration whose later units
 * read earlier ones (m004: level k+1 from level k). req = { t, level, channel, bricks:
 * [[bz, by, bx]…] }; answered as the list [{ bz, by, bx, bytes }] of the bricks that exist
 * (an absent one is all zeros), in request order. Each brick is a view of its batch's answer:
 * no second copy of what a unit reads.
 */
async function fetchStored(migration, dataset, req, signal) {
  const list = Array.isArray(req.bricks) ? req.bricks : [];
  const found = new Array(list.length).fill(null);
  if (_storeManyMissing) {
    for (let i = 0; i < list.length; i++) {
      const [bz, by, bx] = list[i];
      found[i] = await storeGet(migration, dataset, `t${req.t}.k${req.level}.c${req.channel}.z${bz}.y${by}.x${bx}`, signal);
    }
  } else {
    const parts = [];
    for (let i = 0; i < list.length; i += STORE_BATCH) parts.push(i);
    let next = 0;
    const lane = async () => {
      while (next < parts.length) {
        const from = parts[next++];
        let got;
        try {
          got = await storeGetMany(migration, dataset, req, list.slice(from, from + STORE_BATCH), signal);
        } catch (err) {
          if (unknownAction(err)) { _storeManyMissing = true; return; }
          throw err;
        }
        for (let j = 0; j < got.length; j++) found[from + j] = got[j];
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(STORE_PARALLEL, parts.length)) }, lane));
    if (_storeManyMissing) return fetchStored(migration, dataset, req, signal);
  }
  const out = [];
  list.forEach(([bz, by, bx], i) => { if (found[i]) out.push({ bz, by, bx, bytes: found[i] }); });
  return out;
}

// A unit's input byte runs travel in one request (action read_ranges): a layer projection reads
// one tile from each of 64 plane files, a planes or v3 unit dozens of pack runs, and one request
// per run was the bulk of the traffic a shared host's firewall banned the operator's address for.
const RANGES_BATCH = 512;
const RANGES_BATCH_BYTES = 16 * 1024 * 1024;
let _rangesMissing = false;   // a server older than read_ranges: one request per run

/** A server older than an action answers 400 `unknown_action` (PHP) or `Unknown action` (Python). */
function unknownAction(err) { return !!(err && err.status === 400 && /^unknown[ _]action$/i.test(String(err.code || ''))); }

/**
 * io.readRels([{ rel, start, end }]) → [Uint8Array], request order: runs named by their path
 * relative to the dataset (or `@store/…`, a file of the job's store), batched like
 * fetchRanges. A server without read_ranges cannot serve them.
 */
async function readRels(dataset, list, signal) {
  const out = new Array(list.length);
  for (let k = 0; k < list.length;) {
    let bytes = 0;
    let j = k;
    while (j < list.length && j - k < RANGES_BATCH && (j === k || bytes + list[j].end - list[j].start <= RANGES_BATCH_BYTES)) {
      bytes += list[j].end - list[j].start;
      j++;
    }
    const got = await readRanges(dataset, list.slice(k, j), signal);
    for (let n = 0; n < got.length; n++) out[k + n] = got[n];
    k = j;
  }
  return out;
}

/** POST unit_inputs: what the server says one unit reads and makes (m005-matrix, m006-q30). */
async function unitInputs(migration, dataset, unit, signal) {
  return withRetries(async () => {
    const headers = { 'Content-Type': 'application/json' };
    if (_csrf) headers['X-CSRF-Token'] = _csrf;
    const res = await fetch(`${_endpoint}?action=unit_inputs`, {
      method: 'POST', headers, credentials: 'same-origin', signal,
      body: JSON.stringify({ dataset, migration, unit }),
    });
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

/** POST unit_inputs_many: the inputs of several units in one answer ({ items }). */
async function unitInputsMany(migration, dataset, units, signal) {
  return withRetries(async () => {
    const headers = { 'Content-Type': 'application/json' };
    if (_csrf) headers['X-CSRF-Token'] = _csrf;
    const res = await fetch(`${_endpoint}?action=unit_inputs_many`, {
      method: 'POST', headers, credentials: 'same-origin', signal,
      body: JSON.stringify({ dataset, migration, units }),
    });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok || !data || data.ok === false || !Array.isArray(data.items)) {
      const err = httpError(res.ok ? 500 : res.status, data && data.error, (data && (data.message || data.error)) || `HTTP ${res.status}`);
      if (data && data.detail) err.detail = String(data.detail);
      throw err;
    }
    return data.items;
  }, signal);
}

/** POST unit_put_many: u32 n, n × { u16 key length, key, u32 body length, body }. */
async function putMany(migration, dataset, entries, signal) {
  const enc = new TextEncoder();
  let total = 4;
  const keys = entries.map((e) => enc.encode(e.key));
  entries.forEach((e, i) => { total += 6 + keys[i].length + e.body.length; });
  const body = new Uint8Array(total);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, entries.length, true);
  let o = 4;
  entries.forEach((e, i) => {
    dv.setUint16(o, keys[i].length, true); o += 2;
    body.set(keys[i], o); o += keys[i].length;
    dv.setUint32(o, e.body.length, true); o += 4;
    body.set(e.body, o); o += e.body.length;
  });
  const q = new URLSearchParams({ action: 'unit_put_many', dataset, migration });
  return withRetries(async () => {
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (_csrf) headers['X-CSRF-Token'] = _csrf;
    const res = await fetch(`${_endpoint}?${q}`, { method: 'POST', headers, body, credentials: 'same-origin', signal });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok || !data || data.ok === false || !Array.isArray(data.results)) {
      const err = httpError(res.ok ? 500 : res.status, data && data.error, (data && (data.message || data.error)) || `HTTP ${res.status}`);
      if (data && data.detail) err.detail = String(data.detail);
      throw err;
    }
    return data;
  }, signal);
}

/** Runs [{ rel, start, end }] of the dataset's packs in one request → Uint8Array views, request order. */
async function readRanges(dataset, part, signal) {
  return withRetries(async () => {
    const headers = { 'Content-Type': 'application/json' };
    if (_csrf) headers['X-CSRF-Token'] = _csrf;
    const res = await fetch(`${_endpoint}?action=read_ranges`, {
      method: 'POST', headers, credentials: 'same-origin', signal,
      body: JSON.stringify({ dataset, ranges: part.map((r) => [r.rel, r.start, r.end]) }),
    });
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }
      const err = httpError(res.status, data && data.error, (data && (data.message || data.error)) || `HTTP ${res.status}`);
      if (data && data.detail) err.detail = String(data.detail);
      throw err;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const n = buf.length >= 4 ? view.getUint32(0, true) : -1;
    if (n !== part.length || buf.length < 4 + 4 * n) throw httpError(502, 'short_read', 'read_ranges: bad header');
    const out = new Array(n);
    let at = 4 + 4 * n;
    for (let i = 0; i < n; i++) {
      const len = view.getUint32(4 + 4 * i, true);
      if (len !== part[i].end - part[i].start || at + len > buf.length) throw httpError(502, 'short_read', 'read_ranges: truncated');
      out[i] = buf.subarray(at, at + len);
      at += len;
    }
    return out;
  }, signal);
}

/**
 * io.fetchRanges([{ url, start, end }]) → [Uint8Array] in request order (end exclusive). Runs of
 * the dataset's own packs go to the server in batches; anything else, or a server without
 * read_ranges, is read one run per request.
 */
async function fetchRanges(dataset, base, list, signal) {
  const out = new Array(list.length);
  const batched = [];
  list.forEach((r, i) => {
    const bare = String(r.url).split('?')[0];
    const rel = !_rangesMissing && base && bare.startsWith(base) ? decodeURIComponent(bare.slice(base.length)) : null;
    if (rel && r.end - r.start <= RANGES_BATCH_BYTES) batched.push({ i, rel, start: r.start, end: r.end });
  });
  for (let k = 0; k < batched.length;) {
    let bytes = 0;
    let j = k;
    while (j < batched.length && j - k < RANGES_BATCH && (j === k || bytes + batched[j].end - batched[j].start <= RANGES_BATCH_BYTES)) {
      bytes += batched[j].end - batched[j].start;
      j++;
    }
    const part = batched.slice(k, j);
    let got;
    try {
      got = await readRanges(dataset, part, signal);
    } catch (err) {
      if (unknownAction(err)) { _rangesMissing = true; break; }
      throw err;
    }
    part.forEach((r, n) => { out[r.i] = got[n]; });
    k = j;
  }
  for (let i = 0; i < list.length; i++) {
    if (!out[i]) out[i] = await fetchRange(list[i].url, list[i].start, list[i].end, signal);
  }
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
    _bases.set(`${msg.migration}|${msg.dataset}`, msg.datasetBase);
    post({
      type: 'prepared', reqId: msg.reqId, ok: true, trees: state.trees ? state.trees.length : null,
      slotsPerWorker: Number.isInteger(h.slotsPerWorker) && h.slotsPerWorker > 0 ? h.slotsPerWorker : null,
      batchUnits: Number.isInteger(h.batchUnits) && h.batchUnits > 1 ? h.batchUnits : null,
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
    const io = {
      fetchRange: (url, s, e) => fetchRange(url, s, e, ac.signal),
      fetchRanges: (list) => fetchRanges(msg.dataset, _bases.get(`${msg.migration}|${msg.dataset}`), list, ac.signal),
      fetchStored: (req) => fetchStored(msg.migration, msg.dataset, req, ac.signal),
      readRels: (list) => readRels(msg.dataset, list, ac.signal),
      unitInputs: () => unitInputs(msg.migration, msg.dataset, msg.unit, ac.signal),
      signal: ac.signal,
    };
    const work = await h.planUnitWork(msg.unit, state, io);
    const res = await h.runUnit(work, state, io);
    // m005 results can outgrow the host's request limit: they go in pieces.
    const reply = !msg.dry && (msg.migration === 'm005-matrix' || msg.migration === 'm006-q30') && res.body.length + PIECE_MARGIN > _maxBody
      ? await putInPieces(msg.migration, msg.dataset, msg.unit, res.body, ac.signal)
      : await putUnit(msg.migration, msg.dataset, msg.unit, res.body, !!msg.dry, ac.signal);
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

// A batch: the byte runs every unit of it reads are fetched once (shared ones too: neighbouring
// units read the same plane tiles) up to BATCH_PREFETCH_BYTES, the units are computed one after
// the other, and their results leave in unit_put_many requests of at most BATCH_PUT_BYTES.
const BATCH_PREFETCH_BYTES = 48 * 1024 * 1024;
const BATCH_PUT_BYTES = 16 * 1024 * 1024;
const PIECE_MARGIN = 64 * 1024;

/** A unit result in pieces of at most the host's limit (unit_put_part); the last stores it. */
async function putInPieces(migration, dataset, key, body, signal) {
  const piece = Math.max(256 * 1024, _maxBody - PIECE_MARGIN);
  let reply = null;
  for (let off = 0; off < body.length; off += piece) {
    const part = body.subarray(off, Math.min(body.length, off + piece));
    const q = new URLSearchParams({ action: 'unit_put_part', dataset, migration, unit: key, offset: String(off), total: String(body.length) });
    reply = await withRetries(async () => {
      const headers = { 'Content-Type': 'application/octet-stream' };
      if (_csrf) headers['X-CSRF-Token'] = _csrf;
      const res = await fetch(`${_endpoint}?${q}`, { method: 'POST', headers, body: part, credentials: 'same-origin', signal });
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
  return reply;
}
const RUN_KEY = (r) => `${r.rel}|${r.start}|${r.end}`;

function failure(key, err) {
  return {
    type: 'unit_failed', key,
    error: String(err && err.message || err),
    code: err && err.code || (err && err.name === 'AbortError' ? 'aborted' : null),
    status: err && err.status || 0,
    fatal: !!(err && err.fatal),
    aborted: !!(err && err.name === 'AbortError'),
  };
}

async function onRunBatch(msg) {
  const ac = new AbortController();
  _inflight.set(msg.reqId, ac);
  const t0 = performance.now();
  const keys = msg.units || [];
  const results = new Map();
  try {
    const h = handlerFor(msg.migration);
    const state = stateOf(msg);
    let items;
    try {
      items = await unitInputsMany(msg.migration, msg.dataset, keys, ac.signal);
    } catch (err) {
      if (unknownAction(err)) { post({ type: 'batch_unsupported', reqId: msg.reqId }); return; }
      throw err;
    }
    const byKey = new Map(items.map((it) => [it.unit, it]));
    // The runs of the batch, each once, as far as the prefetch budget goes.
    const cache = new Map();
    const want = [];
    let bytes = 0;
    for (const it of items) {
      if (!it || it.ok === false || it.empty) continue;
      for (const r of [...(it.tiles || []), ...(it.bricks || [])]) {
        const k = RUN_KEY(r);
        if (cache.has(k)) continue;
        if (bytes + (r.end - r.start) > BATCH_PREFETCH_BYTES) continue;
        cache.set(k, null);
        want.push(r);
        bytes += r.end - r.start;
      }
    }
    let bytesIn = 0;
    if (want.length) {
      const got = await readRels(msg.dataset, want, ac.signal);
      want.forEach((r, i) => { cache.set(RUN_KEY(r), got[i]); bytesIn += got[i].length; });
    }
    const io = {
      fetchRange: (url, s, e) => fetchRange(url, s, e, ac.signal),
      fetchRanges: (list) => fetchRanges(msg.dataset, _bases.get(`${msg.migration}|${msg.dataset}`), list, ac.signal),
      fetchStored: (req) => fetchStored(msg.migration, msg.dataset, req, ac.signal),
      readRels: async (list) => {
        const missing = list.filter((r) => !cache.get(RUN_KEY(r)));
        if (missing.length) {
          const got = await readRels(msg.dataset, missing, ac.signal);
          missing.forEach((r, i) => { bytesIn += got[i].length; cache.set(RUN_KEY(r), got[i]); });
        }
        return list.map((r) => cache.get(RUN_KEY(r)));
      },
      signal: ac.signal,
    };
    let pending = [];
    let pendingBytes = 0;
    const flush = async () => {
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      pendingBytes = 0;
      if (msg.dry) {
        for (const e of batch) results.set(e.key, { type: 'unit_done', key: e.key, bytesIn: e.bytesIn, bytesOut: e.body.length, tiles: e.tiles });
        return;
      }
      // A result the host could not take in one request goes in pieces, alone.
      const limit = _maxBody - PIECE_MARGIN;
      for (const e of batch.filter((x) => x.body.length + 64 > limit)) {
        try {
          const r = await putInPieces(msg.migration, msg.dataset, e.key, e.body, ac.signal);
          results.set(e.key, { type: 'unit_done', key: e.key, done: r.done, total: r.total, bytesIn: e.bytesIn, bytesOut: e.body.length, tiles: e.tiles });
        } catch (err) {
          if (err && err.name === 'AbortError') throw err;
          results.set(e.key, failure(e.key, err));
        }
      }
      const fits = batch.filter((x) => x.body.length + 64 <= limit);
      if (!fits.length) return;
      const reply = await putMany(msg.migration, msg.dataset, fits, ac.signal);
      const byUnit = new Map(reply.results.map((r) => [r.unit, r]));
      for (const e of fits) {
        const r = byUnit.get(e.key);
        if (r && r.ok) {
          results.set(e.key, { type: 'unit_done', key: e.key, done: reply.done, total: reply.total, bytesIn: e.bytesIn, bytesOut: e.body.length, tiles: e.tiles });
        } else {
          const err = httpError(r ? r.status || 400 : 500, r && r.error, (r && (r.detail || r.error)) || 'not stored');
          results.set(e.key, failure(e.key, err));
        }
      }
    };
    for (const key of keys) {
      if (ac.signal.aborted) throw abortError();
      const inp = byKey.get(key);
      if (!inp) { results.set(key, failure(key, httpError(500, 'bad_unit_inputs', 'no inputs for ' + key))); continue; }
      if (inp.ok === false) { results.set(key, failure(key, httpError(inp.status || 400, inp.error, inp.detail || inp.error))); continue; }
      if (inp.empty) { results.set(key, failure(key, httpError(409, 'empty_unit', 'the server lists no work for ' + key))); continue; }
      const before = bytesIn;
      try {
        const res = await h.runUnit(inp, state, io);
        // Flush first when this result would take the batch past what one request may carry.
        if (pending.length && pendingBytes + res.body.length + 64 * (pending.length + 1) > Math.min(BATCH_PUT_BYTES, _maxBody - PIECE_MARGIN)) await flush();
        pending.push({ key, body: res.body, bytesIn: bytesIn - before, tiles: res.tiles });
        pendingBytes += res.body.length;
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        results.set(key, failure(key, err));
        continue;
      }
      if (pendingBytes >= Math.min(BATCH_PUT_BYTES, _maxBody - PIECE_MARGIN)) await flush();
    }
    await flush();
    const secs = (performance.now() - t0) / 1000;
    post({ type: 'batch_done', reqId: msg.reqId, seconds: secs, results: keys.map((k) => results.get(k) || failure(k, new Error('not run'))) });
  } catch (err) {
    post({ type: 'batch_done', reqId: msg.reqId, results: keys.map((k) => results.get(k) || failure(k, err)) });
  } finally {
    _inflight.delete(msg.reqId);
  }
}

// One batch of the executors' speed test (dataset_migrations.speedtest is the server's side):
// download `n` copies of the synthetic test brick in ONE request, decode each lossless-WebP
// mosaic, encode each 64³ brick as one 512² png-gray8 tile, and upload the tiles in ONE request
// to a sink that drops them — the work and the bytes a browser unit moves per brick, in two
// governed requests per batch. No retry: a failure ends the browser's run of the test.
const SPEEDTEST_DECODER = 'm002-planes';
const SPEEDTEST_TREE = { encoding: 'webp-lossless', packing: { mode: 'grid', cols: 8 } };

async function onSpeedtest(msg) {
  const ac = new AbortController();
  _inflight.set(msg.reqId, ac);
  const t0 = performance.now();
  const n = Math.max(1, Math.min(16, msg.n | 0 || 1));
  try {
    const decodeBrick = handlerFor(SPEEDTEST_DECODER)._internals.decodeBrick;
    const q = new URLSearchParams({ action: 'speedtest_sample', n: String(n), t: String(Date.now()) });
    const batch = await governed(async () => {
      const res = await fetch(`${_endpoint}?${q}`, { credentials: 'same-origin', cache: 'no-store', signal: ac.signal });
      if (!res.ok) throw httpError(res.status, 'speedtest_sample_missing', `HTTP ${res.status} for the test brick`);
      return new Uint8Array(await res.arrayBuffer());
    });
    if (!batch.length || batch.length % n) throw httpError(502, 'short_read', 'the test batch is truncated');
    const size = batch.length / n;
    const tiles = [];
    let outBytes = 0;
    for (let i = 0; i < n; i++) {
      const voxels = await decodeBrick(batch.subarray(i * size, (i + 1) * size), SPEEDTEST_TREE, 0);
      const png = await PlaneCodec.encodePngGray(512, 512, voxels);
      tiles.push(png);
      outBytes += png.length;
    }
    const body = new Uint8Array(outBytes);
    let at = 0;
    for (const p of tiles) { body.set(p, at); at += p.length; }
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (_csrf) headers['X-CSRF-Token'] = _csrf;
    await governed(async () => {
      const put = await fetch(`${_endpoint}?action=speedtest_put`, { method: 'POST', headers, body, credentials: 'same-origin', signal: ac.signal });
      let data = null;
      try { data = await put.json(); } catch (_) { data = null; }
      if (!put.ok || !data || data.ok === false) throw httpError(put.status, data && data.error, `HTTP ${put.status} for the test upload`);
    });
    post({ type: 'speedtest_done', reqId: msg.reqId, ok: true, blocks: n, bytesIn: batch.length, bytesOut: outBytes, seconds: (performance.now() - t0) / 1000 });
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
    case 'net_grant': {
      const go = _turns.get(msg.id);
      _turns.delete(msg.id);
      if (go) go();
      break;
    }
    case 'config':
      if (msg.governed !== undefined) _governed = !!msg.governed;
      if (msg.endpoint) _endpoint = msg.endpoint;
      if (msg.csrf !== undefined) _csrf = msg.csrf;
      if (Number(msg.maxBody) > 0) _maxBody = Math.max(1024 * 1024, Number(msg.maxBody));
      break;
    case 'probe': onProbe(msg); break;
    case 'prepare': onPrepare(msg); break;
    case 'list': onList(msg); break;
    case 'run': onRun(msg); break;
    case 'run_batch': onRunBatch(msg); break;
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
