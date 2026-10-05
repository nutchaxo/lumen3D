// The import worker must survive a network outage instead of failing every file
// after ~9 s, must time a dead connection out, and must be able to cancel what is
// on the wire. Runs the REAL js/workers/upload-worker.js in a vm with a virtual
// clock and a scripted fetch.
//
// Run: node tests/js/test_admin_upload_worker.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const src = readFileSync(path.join(ROOT, 'js/workers/upload-worker.js'), 'utf8');

function makeWorker({ fetchImpl, subtle = true }) {
  // ── virtual clock ──
  let now = 0, nextId = 1;
  const timers = new Map();
  const setTimeoutV = (fn, ms) => { const id = nextId++; timers.set(id, { at: now + (ms || 0), fn }); return id; };
  const clearTimeoutV = (id) => { timers.delete(id); };
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      await flush();
      let next = null;
      for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next.t.at)) next = { id, t };
      if (!next) break;
      timers.delete(next.id);
      now = Math.max(now, next.t.at);
      next.t.fn();
    }
    now = end;
    await flush();
  }
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

  const posted = [];
  const listeners = {};
  const self = {
    postMessage: (m) => posted.push(m),
    addEventListener: (ev, fn) => { (listeners[ev] ||= []).push(fn); },
    crypto: subtle ? { subtle: { digest: async () => new Uint8Array(32).buffer } } : {},
  };
  class AC {
    constructor() { this.signal = { aborted: false, _l: [] }; }
    abort() { this.signal.aborted = true; this.signal._l.forEach((f) => f()); }
  }
  const ctx = vm.createContext({
    self, console, setTimeout: setTimeoutV, clearTimeout: clearTimeoutV, Date: { now: () => now },
    AbortController: AC, TextEncoder, Uint8Array, Object, Math, Array, JSON, Promise, Map, Set,
    encodeURIComponent, String, Number, Error, fetch: (url, init) => fetchImpl(url, init),
    crypto: self.crypto,
  });
  vm.runInContext(src, ctx, { filename: 'upload-worker.js' });
  const send = (msg) => self.onmessage({ data: msg });
  const fire = (ev) => (listeners[ev] || []).forEach((f) => f());
  return { send, advance, posted, fire, flush };
}

const file = (size) => ({ slice: () => ({ arrayBuffer: async () => new ArrayBuffer(size) }) });
const job = (over = {}) => ({ ds: '3d/a', path: 'metadata.json', file: file(10), size: 10, chunkSize: 1 << 23, tier: 0, order: 0, ...over });
const ok = (body = {}) => ({ status: 200, ok: true, json: async () => body });
const types = (w) => w.posted.map((m) => m.type);

// ── 1. A network outage costs time, never files ────────────────
{
  let up = false; let chunkPosts = 0;
  const w = makeWorker({
    fetchImpl: async (url, init) => {
      if (String(url).includes('action=chunk')) {
        chunkPosts++;
        if (!up) throw new TypeError('Failed to fetch');
        return ok({ ok: true });
      }
      if (String(url).includes('action=ping')) { if (!up) throw new TypeError('down'); return { status: 400, ok: false, json: async () => ({}) }; }
      return ok({ ok: true, state: 'staged' });
    },
  });
  w.send({ type: 'config', endpoint: 'http://h/api/upload.php', csrf: 't', parallel: 2 });
  w.send({ type: 'enqueue', jobs: [job(), job({ path: 'b.bin' })] });
  await w.advance(1000);
  assert.ok(types(w).includes('network'), 'the outage is announced');
  assert.equal(w.posted.find((m) => m.type === 'network').online, false);
  // Five minutes of dead link — far beyond the old ~9 s retry budget.
  await w.advance(5 * 60 * 1000);
  assert.ok(!types(w).includes('file-error'), 'no file fails during an outage');
  assert.ok(!types(w).includes('idle'), 'a waiting transfer is not announced as finished');
  up = true;
  await w.advance(30000);   // the probe finds the server again
  assert.ok(w.posted.some((m) => m.type === 'network' && m.online === true), 'the link coming back is announced');
  assert.equal(types(w).filter((x) => x === 'file-done').length, 2, 'both files complete once the link is back');
  assert.ok(types(w).includes('idle'));
  assert.ok(chunkPosts >= 2);
}

// ── 2. The browser's own `online` event cuts the wait short ────
{
  let up = false;
  const w = makeWorker({
    fetchImpl: async (url) => {
      if (String(url).includes('action=chunk')) { if (!up) throw new TypeError('x'); return ok({}); }
      if (String(url).includes('action=ping')) throw new TypeError('still down');
      return ok({ state: 'staged' });
    },
  });
  w.send({ type: 'config', endpoint: 'http://h/api/upload.php', parallel: 1 });
  w.send({ type: 'enqueue', jobs: [job()] });
  await w.advance(500);
  assert.ok(types(w).includes('network'));
  up = true;
  w.fire('online');
  await w.advance(100);
  assert.ok(types(w).includes('file-done'), 'online event resumes without waiting for the probe');
}

// ── 3. A server-side failure spends attempts, backs off, then fails ─
{
  let calls = 0;
  const w = makeWorker({
    fetchImpl: async (url) => {
      if (String(url).includes('action=chunk')) { calls++; return { status: 503, ok: false, json: async () => ({}) }; }
      return ok({});
    },
  });
  w.send({ type: 'config', endpoint: 'http://h/api/upload.php', parallel: 1 });
  w.send({ type: 'enqueue', jobs: [job()] });
  await w.advance(10 * 60 * 1000);
  assert.equal(calls, 6, 'MAX_ATTEMPTS attempts, then the file is failed');
  assert.ok(types(w).includes('file-error'));
}

// ── 4. 429 / 408 are retried, a plain 4xx is not ───────────────
{
  const seq = [429, 408, 200];
  let i = 0;
  const w = makeWorker({
    fetchImpl: async (url) => {
      if (!String(url).includes('action=chunk')) return ok({ state: 'staged' });
      const s = seq[i++];
      return s === 200 ? ok({}) : { status: s, ok: false, json: async () => ({}) };
    },
  });
  w.send({ type: 'config', endpoint: 'http://h/api/upload.php', parallel: 1 });
  w.send({ type: 'enqueue', jobs: [job()] });
  await w.advance(60000);
  assert.ok(types(w).includes('file-done'), 'throttling answers are retried');

  const w2 = makeWorker({
    fetchImpl: async (url) => String(url).includes('action=chunk')
      ? { status: 403, ok: false, json: async () => ({ error: 'not_allowed' }) } : ok({}),
  });
  w2.send({ type: 'config', endpoint: 'http://h/api/upload.php', parallel: 1 });
  w2.send({ type: 'enqueue', jobs: [job()] });
  await w2.advance(1000);
  assert.equal(w2.posted.find((m) => m.type === 'file-error').reason, 'not_allowed', 'a contract violation fails at once');
}

// ── 5. A request with no answer is timed out; abort cancels what is on the wire ─
{
  const signals = [];
  const w = makeWorker({
    fetchImpl: (url, init) => new Promise((_res, rej) => {
      if (!String(url).includes('action=chunk')) { _res(ok({})); return; }
      signals.push(init.signal);
      init.signal._l.push(() => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  w.send({ type: 'config', endpoint: 'http://h/api/upload.php', parallel: 1 });
  w.send({ type: 'enqueue', jobs: [job()] });
  await w.advance(30000);
  assert.equal(signals.length, 1, 'one request on the wire');
  assert.equal(signals[0].aborted, false, 'still waiting within the timeout');
  await w.advance(40000);                       // past 60 s
  assert.equal(signals[0].aborted, true, 'a request with no answer is aborted by the per-request timeout');
  assert.ok(types(w).includes('network'), 'and treated as a network failure, not a failed file');
  assert.ok(!types(w).includes('file-error'));

  // abort (cancel-all) cancels the in-flight request too.
  const sig2 = [];
  const w2 = makeWorker({
    fetchImpl: (url, init) => new Promise((_res, rej) => {
      if (!String(url).includes('action=chunk')) { _res(ok({})); return; }
      sig2.push(init.signal);
      init.signal._l.push(() => rej(new Error('aborted')));
    }),
  });
  w2.send({ type: 'config', endpoint: 'http://h/api/upload.php', parallel: 1 });
  w2.send({ type: 'enqueue', jobs: [job()] });
  await w2.advance(1000);
  w2.send({ type: 'abort' });
  await w2.advance(10);
  assert.equal(sig2[0].aborted, true, 'cancel-all aborts the chunk on the wire');
  await w2.advance(120000);
  assert.ok(!types(w2).includes('file-error') && !types(w2).includes('network'), 'a cancelled request is not retried');
}

// ── 6. Pause, then a new drop: abort leaves the worker runnable ─
{
  const w = makeWorker({ fetchImpl: async (url) => (String(url).includes('action=chunk') ? ok({}) : ok({ state: 'staged' })) });
  w.send({ type: 'config', endpoint: 'http://h/api/upload.php', parallel: 1 });
  w.send({ type: 'pause' });
  w.send({ type: 'enqueue', jobs: [job()] });
  await w.advance(100);
  assert.ok(!types(w).includes('file-done'), 'paused: nothing is sent');
  w.send({ type: 'abort' });
  w.send({ type: 'enqueue', jobs: [job()] });
  await w.advance(100);
  assert.ok(types(w).includes('file-done'), 'after cancel-all a new import is not stuck paused');
}

// ── 7. No SubtleCrypto: one fatal, not one error per file ──────
{
  const w = makeWorker({ fetchImpl: async () => ok({}), subtle: false });
  w.send({ type: 'config', endpoint: 'http://h/api/upload.php' });
  w.send({ type: 'enqueue', jobs: [job(), job({ path: 'b' }), job({ path: 'c' })] });
  await w.advance(100);
  const fatal = w.posted.filter((m) => m.type === 'fatal');
  assert.equal(fatal.length, 1);
  assert.equal(fatal[0].reason, 'insecure_context');
  assert.ok(!types(w).includes('file-error'));
}

// ── 8. A transient read error is retried before the file fails ─
{
  let reads = 0;
  const flaky = { slice: () => ({ arrayBuffer: async () => { if (++reads < 3) throw new Error('EIO'); return new ArrayBuffer(10); } }) };
  const w = makeWorker({ fetchImpl: async (url) => (String(url).includes('action=chunk') ? ok({}) : ok({ state: 'staged' })) });
  w.send({ type: 'config', endpoint: 'http://h/api/upload.php', parallel: 1 });
  w.send({ type: 'enqueue', jobs: [job({ file: flaky })] });
  await w.advance(10000);
  assert.ok(types(w).includes('file-done'), 'two read errors then success: the file goes through');
  assert.equal(reads, 3);
}

// ── 9. A request that dies while the server answers probes is not an endless loop ─
{
  let chunks = 0;
  const w = makeWorker({
    fetchImpl: async (url) => {
      if (String(url).includes('action=chunk')) { chunks++; throw new TypeError('connection reset'); }
      if (String(url).includes('action=ping')) return ok({ ok: true });
      return ok({ state: 'staged' });
    },
  });
  w.send({ type: 'config', endpoint: 'http://h/api/upload.php', parallel: 1 });
  w.send({ type: 'enqueue', jobs: [job()] });
  await w.advance(60 * 60 * 1000);
  const fe = w.posted.filter((m) => m.type === 'file-error');
  assert.equal(fe.length, 1, 'the chunk is failed after a bounded number of resends');
  assert.equal(fe[0].reason, 'network');
  assert.ok(chunks >= 2 && chunks <= 12, `bounded resends (${chunks})`);
  assert.ok(types(w).includes('idle'), 'the transfer ends instead of spinning');
}

// ── 10. file_done answering 401 ends the transfer (session gone) ─
{
  const w = makeWorker({
    fetchImpl: async (url) => (String(url).includes('action=chunk') ? ok({})
      : { status: 401, ok: false, json: async () => ({}) }),
  });
  w.send({ type: 'config', endpoint: 'http://h/api/upload.php', parallel: 1 });
  w.send({ type: 'enqueue', jobs: [job()] });
  await w.advance(1000);
  assert.equal(w.posted.filter((m) => m.type === 'fatal' && m.reason === 'unauthorized').length, 1);
  assert.ok(!types(w).includes('file-error'), 'not reported as one more failed file');
}

// ── 11. A probe still out when the import is cancelled reports nothing ─
{
  let releaseProbe;
  const w = makeWorker({
    fetchImpl: (url) => {
      if (String(url).includes('action=chunk')) return Promise.reject(new TypeError('down'));
      if (String(url).includes('action=ping')) return new Promise((r) => { releaseProbe = () => r({ status: 401, ok: false, json: async () => ({}) }); });
      return Promise.resolve(ok({}));
    },
  });
  w.send({ type: 'config', endpoint: 'http://h/api/upload.php', parallel: 1 });
  w.send({ type: 'enqueue', jobs: [job()] });
  await w.advance(2500);                       // outage + first probe on the wire
  assert.ok(typeof releaseProbe === 'function');
  w.send({ type: 'abort' });
  releaseProbe();
  await w.advance(100);
  assert.ok(!types(w).includes('fatal'), 'a cancelled transfer does not announce an expired session');
}

console.log('admin upload worker (outage · backoff · timeout · abort · insecure context · read retry): OK');
