/* ============================================================
   Lumen3D — dataset import transfer worker
   ============================================================
   Owns the ENTIRE byte path of an import: reading file slices, hashing them and
   POSTing them. Nothing about a transfer touches the main thread (Rule 1.2), so
   the operator can keep editing a dataset, switch admin tabs, scrub a preview
   and drive the 3D viewer at full frame rate while gigabytes stream out.

   Why the work lives here rather than in the manager:
     * reading an 8 MiB slice (`Blob.arrayBuffer`) and SHA-256'ing it is tens of
       milliseconds of solid CPU — on the main thread that is a dropped frame per
       chunk, i.e. a permanently janky panel for the whole upload;
     * keeping fetch() here too means the chunk buffer is never transferred back
       and forth across the worker boundary, so each chunk is read exactly once
       and copied zero extra times.

   Concurrency model: a fixed pool of `parallel` slots pulls from one priority
   queue. Slots are per-CHUNK, not per-file, so a single 22 GB original still
   saturates the link, and a burst of tiny pack files never leaves slots idle.
   Chunks may therefore land out of order — the server writes each at its exact
   offset and tracks a received-bitmap, so that is by design, not tolerated.
   ============================================================ */

'use strict';

// ── Configuration pushed from the manager ──────────────────────────────────────
// The endpoint is ABSOLUTE, resolved by the manager against document.baseURI. It
// has to be: a relative URL here would resolve against THIS SCRIPT's location
// (/js/workers/), turning every chunk POST into /js/workers/api/upload.php.
let _endpoint = '/api/upload.php';
let _csrf = null;
let _parallel = 4;
let _paused = false;
let _stopped = false;

// Queue of pending chunk jobs, ordered by (tier, dataset order, file order, index).
let _queue = [];
// path key -> { ds, path, file, size, chunkSize, total, remaining, digests, failed }
const _files = new Map();
let _active = 0;
// Jobs sleeping between retry attempts. They are in neither _queue nor _active,
// so without counting them the pump would see an empty board and announce `idle`
// mid-backoff — reporting a transfer as finished while a chunk is still pending.
let _retrying = 0;
const _timers = new Set();          // backoff timers, cleared on abort
const _inflight = new Set();        // AbortControllers of requests on the wire

// Retries. A transient network blip or a 5xx must not lose a whole multi-hour
// transfer, and a re-sent chunk is idempotent server-side (same bytes, same
// offset), so retrying is always safe.
//   * a SERVER-side failure (5xx, throttling, checksum) spends one of MAX_ATTEMPTS
//     and backs off exponentially (1 s doubling to 30 s, +/-25 % jitter);
//   * a NETWORK-side failure (the request never got an answer, or timed out) does
//     not spend anything: the whole pump goes into a waiting state until the link
//     is back (the browser's `online` event, or a probe that gets any HTTP answer),
//     so a minutes-long outage costs time, never files.
const MAX_ATTEMPTS = 6;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30000;
const PROBE_MAX_MS = 15000;
const RETRYABLE_STATUS = new Set([408, 423, 425, 429]);
const READ_RETRIES = 2;
// A chunk whose request dies while the probe right after it gets an answer is not
// suffering an outage: the request itself is what fails (a proxy cutting large
// bodies, a link too slow for the timeout). Each outage costs a chunk at most one
// of these, so the cap only ends that endless resend-and-die loop.
const MAX_NET_FAILS = 12;
let _netDown = false;
let _probeTimer = null;
let _probeDelay = 2000;

// A request that gets no answer in this long is treated as a dead connection.
// 8 MiB at a floor of 50 KB/s is ~2.7 min; never less than a minute.
function requestTimeoutMs(bytes) { return Math.max(60000, Math.ceil((bytes || 0) / 50000) * 1000); }
function backoffMs(attempt) {
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.75 + Math.random() * 0.5));
}
function later(fn, ms) {
  const id = setTimeout(() => { _timers.delete(id); fn(); }, ms);
  _timers.add(id);
  return id;
}

// Progress is coalesced: one message per animation-frame-ish interval instead of
// one per chunk, so a fast link cannot flood the main thread with postMessage.
// Bytes are accumulated PER DATASET as well as globally — the import view shows a
// bar per dataset, and a single global counter cannot drive those.
const PROGRESS_INTERVAL_MS = 180;
let _progressTimer = null;
let _sentSinceTick = 0;
let _perDsSinceTick = new Map();
let _totalSent = 0;

function fileKey(ds, path) { return `${ds}\u0000${path}`; }

function post(msg) { self.postMessage(msg); }

// ── Message plumbing ───────────────────────────────────────────────────────────

self.onmessage = (e) => {
  const msg = e.data || {};
  switch (msg.type) {
    case 'config':
      _endpoint = msg.endpoint || _endpoint;
      _csrf = msg.csrf ?? _csrf;
      _parallel = Math.max(1, Math.min(8, msg.parallel || _parallel));
      break;
    case 'enqueue':
      enqueue(msg.jobs || []);
      break;
    case 'pause':
      _paused = true;
      break;
    case 'resume':
      _paused = false;
      pump();
      break;
    case 'abort':
      _stopped = true;
      _paused = false;           // a later import starts running, not frozen
      _queue = [];
      _files.clear();
      cancelPending();
      break;
    case 'drop':
      // Remove every pending chunk of one dataset (the operator discarded it).
      _queue = _queue.filter((j) => j.ds !== msg.ds);
      for (const [k, f] of _files) if (f.ds === msg.ds) _files.delete(k);
      for (const c of _inflight) if (c.__ds === msg.ds) c.abort();
      break;
    default:
      break;
  }
};

/**
 * Register files and expand them into per-chunk jobs.
 *
 * `missing` comes from the server's plan: on a resume it holds ONLY the chunk
 * indices that never arrived, so re-dropping a folder after a failure re-sends
 * the gap and nothing else.
 */
/** Abort every request on the wire and every backoff timer (cancel-all). */
function cancelPending() {
  for (const c of _inflight) { try { c.abort(); } catch (_) { /* already settled */ } }
  _inflight.clear();
  for (const id of _timers) clearTimeout(id);
  _timers.clear();
  _retrying = 0;
  clearTimeout(_probeTimer); _probeTimer = null;
  _netDown = false;
}

function enqueue(jobs) {
  if (!(self.crypto && self.crypto.subtle)) {
    // No SubtleCrypto outside a secure context: every file would fail one by one.
    post({ type: 'fatal', reason: 'insecure_context' });
    return;
  }
  _stopped = false;
  jobs.forEach((job) => {
    const key = fileKey(job.ds, job.path);
    const existing = _files.get(key);
    // A file already in flight is left alone — but a FAILED one has to be
    // re-registered, or re-dropping the folder to retry it would be a silent
    // no-op and the operator could never recover from a file that exhausted its
    // attempts. This is the whole point of the resume contract.
    if (existing && !existing.failed) return;
    if (existing) _files.delete(key);
    const chunkSize = job.chunkSize || 8388608;
    const chunkCount = job.size > 0 ? Math.ceil(job.size / chunkSize) : 0;
    const missing = Array.isArray(job.missing) && job.missing.length
      ? job.missing.slice()
      : Array.from({ length: chunkCount }, (_, i) => i);

    const entry = {
      ds: job.ds, path: job.path, file: job.file, size: job.size,
      fileId: Number.isInteger(job.fileId) ? job.fileId : null,
      chunkSize, chunkCount, remaining: missing.length,
      // The digest-of-digests root can only be computed when THIS session sent
      // every chunk; after a resume the earlier digests are gone. The server
      // treats the root as optional precisely for that case — each chunk was
      // already verified individually on arrival.
      digests: new Array(chunkCount).fill(null),
      complete: missing.length === 0,
      failed: false,
    };
    _files.set(key, entry);

    if (!missing.length) { finishFile(key); return; }
    missing.forEach((index) => {
      _queue.push({ ds: job.ds, path: job.path, key, index, tier: job.tier ?? 9,
                    order: job.order ?? 0, attempts: 0 });
    });
  });
  // Coarse data first: the tier ordering is what makes a dataset openable and
  // editable long before the full-resolution levels have landed.
  _queue.sort((a, b) => (a.tier - b.tier) || (a.order - b.order) || (a.index - b.index));
  pump();
}

// ── Pump ───────────────────────────────────────────────────────────────────────

function pump() {
  if (_paused || _stopped || _netDown) return;
  while (_active < _parallel && _queue.length) {
    const job = _queue.shift();
    const entry = _files.get(job.key);
    if (!entry || entry.failed) continue;
    _active++;
    sendChunk(job, entry)
      .catch(() => { /* handled inside */ })
      .finally(() => { _active--; pump(); });
  }
  if (!_active && !_queue.length && !_retrying && !_netDown) {
    flushProgress();
    post({ type: 'idle' });
  }
}

async function sendChunk(job, entry) {
  if (_stopped || _paused) { _queue.unshift(job); return; }

  const start = job.index * entry.chunkSize;
  const end = Math.min(start + entry.chunkSize, entry.size);

  let buffer;
  for (let attempt = 0; ; attempt++) {
    try {
      buffer = await entry.file.slice(start, end).arrayBuffer();
      break;
    } catch (err) {
      // A read error can be transient (a NAS share hiccup). A File handle that
      // went stale — the folder was moved or deleted mid-run — keeps failing, and
      // then the operator has to re-drop it.
      if (attempt >= READ_RETRIES || _stopped) {
        failFile(job.key, 'file_unreadable', String(err && err.message || err));
        return;
      }
      await new Promise((r) => later(r, 500 * 3 ** attempt));
      if (_stopped || entry.failed) return;
    }
  }

  // crypto.subtle is unavailable outside a secure context (plain http:// on a
  // non-localhost host). Surface that as a real error on the file instead of
  // letting the rejection vanish into pump()'s catch, which would look like a
  // transfer that finished instantly having sent nothing.
  let digest;
  try {
    digest = await sha256Hex(buffer);
  } catch (err) {
    failFile(job.key, 'hash_unavailable', String(err && err.message || err));
    return;
  }

  const url = `${_endpoint}?action=chunk&ds=${encodeURIComponent(job.ds)}`
            + `&path=${encodeURIComponent(job.path)}&index=${job.index}&sha256=${digest}`
            + (entry.fileId !== null ? `&fid=${entry.fileId}` : '');

  let res;
  const ctl = new AbortController();
  ctl.__ds = job.ds;
  _inflight.add(ctl);
  const timeout = setTimeout(() => ctl.abort(), requestTimeoutMs(buffer.byteLength));
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        ...(_csrf ? { 'X-CSRF-Token': _csrf } : {}),
      },
      body: buffer,
      signal: ctl.signal,
    });
  } catch (err) {
    // Cancelled on purpose (cancel-all / dataset dropped): nothing to retry.
    if (_stopped || !_files.get(job.key)) return;
    networkDown(job, String(err && err.message || err));
    return;
  } finally {
    clearTimeout(timeout);
    _inflight.delete(ctl);
  }

  if (res.status === 401) { failAll('unauthorized'); return; }
  if (res.status === 507) {
    // The server's disk (or the account's quota) is full: every further chunk would
    // fail the same way. Terminal for the whole transfer, never retried.
    let payload = {};
    try { payload = await res.json(); } catch (_) { /* non-JSON */ }
    failAll('insufficient_disk', { neededBytes: payload.neededBytes ?? null, freeBytes: payload.freeBytes ?? null });
    return;
  }
  if (res.status === 413) {
    // A PHP host whose post_max_size is below our chunk size discards the body
    // silently. Surface it so the manager can renegotiate and re-plan smaller —
    // retrying the same size would loop forever.
    let payload = {};
    try { payload = await res.json(); } catch (_) { /* non-JSON */ }
    post({ type: 'chunk-too-large', ds: job.ds, path: job.path,
           maxChunkSize: payload.maxChunkSize || null });
    failFile(job.key, 'chunk_too_large', '');
    return;
  }
  if (!res.ok) {
    let payload = {};
    try { payload = await res.json(); } catch (_) { /* non-JSON */ }
    // A 4xx that is not a checksum problem is a contract violation (the path is
    // not allowed, the plan is gone). Retrying cannot fix it.
    const retryable = res.status >= 500 || RETRYABLE_STATUS.has(res.status) || payload.error === 'checksum_mismatch';
    if (retryable) retryOrFail(job, entry, payload.error || `http_${res.status}`, '');
    else failFile(job.key, payload.error || `http_${res.status}`, '');
    return;
  }

  entry.digests[job.index] = digest;
  entry.remaining--;
  const written = end - start;
  _sentSinceTick += written;
  _totalSent += written;
  _perDsSinceTick.set(job.ds, (_perDsSinceTick.get(job.ds) || 0) + written);
  scheduleProgress();

  // The file may have failed and been re-registered by a retry (a NEW entry under
  // the same key) while this chunk was on the wire: closing then would ask the
  // server to finish a file the new run has barely started.
  if (entry.remaining <= 0 && _files.get(job.key) === entry && !entry.failed) await finishFile(job.key);
}

function retryOrFail(job, entry, reason, detail) {
  job.attempts++;
  if (job.attempts >= MAX_ATTEMPTS) { failFile(job.key, reason, detail); return; }
  _retrying++;
  later(() => {
    _retrying--;
    const still = _files.get(job.key);
    if (!_stopped && still && !still.failed) _queue.unshift(job);
    pump();
  }, backoffMs(job.attempts));
}

/**
 * The request got no answer (refused, reset, timed out): the link, not the file,
 * is the problem. The chunk goes back to the head of the queue untouched and the
 * pump waits for the network — either the browser's `online` event or a probe
 * that receives any HTTP response at all.
 */
function networkDown(job, detail) {
  const still = _files.get(job.key);
  job.netFails = (job.netFails || 0) + 1;
  if (job.netFails >= MAX_NET_FAILS) { failFile(job.key, 'network', detail); return; }
  if (still && !still.failed) _queue.unshift(job);
  if (_netDown) return;
  _netDown = true;
  _probeDelay = 2000;
  post({ type: 'network', online: false, detail });
  scheduleProbe();
}

function scheduleProbe() {
  clearTimeout(_probeTimer);
  _probeTimer = setTimeout(probe, _probeDelay);
}

async function probe() {
  _probeTimer = null;
  if (!_netDown || _stopped) return;
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), 8000);
  try {
    // action=ping answers 200 to a signed-in admin. Any HTTP status proves the
    // server is reachable; a 401 also says the session ended during the outage,
    // which resuming could only turn into a 401 per chunk. Only a transport failure
    // keeps us waiting.
    const res = await fetch(`${_endpoint}?action=ping`, { method: 'GET', cache: 'no-store',
                                                        credentials: 'same-origin', signal: ctl.signal });
    // Cancelled (or already resumed by the `online` event) while the probe was out.
    if (!_netDown || _stopped) return;
    if (res.status === 401) { _netDown = false; clearTimeout(_probeTimer); _probeTimer = null; failAll('unauthorized'); return; }
    networkUp();
  } catch (_) {
    _probeDelay = Math.min(PROBE_MAX_MS, Math.round(_probeDelay * 1.7));
    scheduleProbe();
  } finally {
    clearTimeout(timeout);
  }
}

function networkUp() {
  if (!_netDown) return;
  _netDown = false;
  clearTimeout(_probeTimer); _probeTimer = null;
  post({ type: 'network', online: true });
  pump();
}

// The browser knows before a probe does: leaving the network cuts the wait short.
self.addEventListener('online', () => { if (_netDown) networkUp(); });
self.addEventListener('offline', () => {
  if (_netDown || !_active) return;
  // In-flight requests will fail on their own; announce the state now.
  _netDown = true; _probeDelay = 2000;
  post({ type: 'network', online: false, detail: 'offline' });
  scheduleProbe();
});

function failFile(key, reason, detail) {
  const entry = _files.get(key);
  if (!entry || entry.failed) return;
  entry.failed = true;
  _queue = _queue.filter((j) => j.key !== key);
  post({ type: 'file-error', ds: entry.ds, path: entry.path, reason, detail });
}

function failAll(reason, detail) {
  _stopped = true;
  _queue = [];
  // Clear the registry too: after re-authenticating, the operator re-drops the
  // folder and every file must be eligible again (see the guard in enqueue).
  _files.clear();
  // Requests still on the wire and backoff timers would otherwise keep firing.
  cancelPending();
  post({ type: 'fatal', reason, ...(detail || {}) });
}

/** Close a file server-side: proves every chunk is present and the size matches. */
async function finishFile(key) {
  const entry = _files.get(key);
  if (!entry) return;
  const root = entry.digests.every(Boolean) ? await digestRoot(entry.digests) : null;

  let res;
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    ctl.__ds = entry.ds;
    _inflight.add(ctl);
    const timeout = setTimeout(() => ctl.abort(), 60000);
    try {
      res = await fetch(`${_endpoint}?action=file_done&ds=${encodeURIComponent(entry.ds)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(_csrf ? { 'X-CSRF-Token': _csrf } : {}) },
        body: JSON.stringify({ path: entry.path, root }),
        signal: ctl.signal,
      });
      break;
    } catch (err) {
      if (_stopped || !_files.get(key)) return;
      // Closing a file is idempotent: ride out a short outage before giving up.
      if (attempt >= MAX_ATTEMPTS - 1) { failFile(key, 'network', String(err && err.message || err)); return; }
      await new Promise((r) => later(r, backoffMs(attempt + 1)));
      if (_stopped || !_files.get(key)) return;
    } finally {
      clearTimeout(timeout);
      _inflight.delete(ctl);
    }
  }
  if (res.status === 401) { failAll('unauthorized'); return; }
  let payload = {};
  try { payload = await res.json(); } catch (_) { /* non-JSON */ }

  if (!res.ok) {
    // `incomplete` / `size_mismatch` mean the server disagrees about what landed.
    // The manager re-plans that dataset, which returns a fresh missing list.
    failFile(key, payload.error || `http_${res.status}`, JSON.stringify(payload.missing || ''));
    return;
  }
  _files.delete(key);
  flushProgress();
  post({ type: 'file-done', ds: entry.ds, path: entry.path, size: entry.size,
         state: payload.state || null });
}

// ── Hashing ────────────────────────────────────────────────────────────────────

async function sha256Hex(buffer) {
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  const bytes = new Uint8Array(hash);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/**
 * SHA-256 over the ordered concatenation of the per-chunk digests.
 *
 * Browsers expose no incremental whole-file hash, and re-reading a multi-gigabyte
 * file purely to hash it would double the I/O of the entire import. This root
 * proves the same property the server needs — every chunk verified, in the right
 * order, none missing — for the cost of hashing a few kilobytes.
 */
async function digestRoot(digests) {
  const joined = new TextEncoder().encode(digests.join(''));
  return sha256Hex(joined);
}

// ── Progress coalescing ────────────────────────────────────────────────────────

function scheduleProgress() {
  if (_progressTimer) return;
  _progressTimer = setTimeout(flushProgress, PROGRESS_INTERVAL_MS);
}

function flushProgress() {
  if (_progressTimer) { clearTimeout(_progressTimer); _progressTimer = null; }
  if (!_sentSinceTick) return;
  post({
    type: 'progress',
    bytes: _sentSinceTick,
    totalSent: _totalSent,
    perDataset: Object.fromEntries(_perDsSinceTick),
    at: Date.now(),
  });
  _sentSinceTick = 0;
  _perDsSinceTick = new Map();
}
