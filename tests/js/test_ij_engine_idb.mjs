// IndexedDB storage of the Advanced Studio engine (ij-engine.js createIndexedDbStorage), run under
// Node against a minimal in-test fake IndexedDB that behaves the way the browser's does where it
// matters to the engine:
//   • a value whose serialized size exceeds Chromium's 133169152 bytes is refused (DataError) unless
//     the big arrays are Blobs, which are stored out of line (cap scaled down in the engine scenarios);
//   • keys compare as IndexedDB does (number < string < array, arrays element by element, a shorter
//     prefix first) so the [key] .. [key, []] ranges select exactly one session;
//   • a transaction completes only when its requests are done (oncomplete), a failed request bubbles
//     to tx.onerror while tx.error is still null, then the transaction aborts and ROLLS BACK;
//   • a closed connection (browser closing it, a version change) throws InvalidStateError on use.
// Scenarios: the recovery tests of test_ij_engine.mjs run on this storage (baseline + journal,
// snapshot, restore after a reload, discard by document), a large Blob channel round trip for the
// three array types, the oncomplete regression (restore must resolve), the real cap refusing a
// plain value, list() reporting stored documents, no ghost session from putMeta / putJournal,
// quota errors classified from the request error, and a connection that was closed.
//
// Run: node tests/js/test_ij_engine_idb.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const CHROMIUM_CAP = 133169152;
const A = (x) => Array.from(x);
const P = (x) => JSON.parse(JSON.stringify(x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + what)), ms))]);

// ── fake IndexedDB ──────────────────────────────────────────────────────────────────────────────────
function domErr(name, message) { const e = new Error(message || name); e.name = name; return e; }

function rank(v) { return typeof v === 'number' ? 1 : typeof v === 'string' ? 3 : Array.isArray(v) ? 5 : 9; }
function cmp(a, b) {
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 5) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) { const c = cmp(a[i], b[i]); if (c) return c; }
    return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
class FakeRange {
  constructor(lo, hi) { this.lo = lo; this.hi = hi; }
  has(k) { return cmp(k, this.lo) >= 0 && cmp(k, this.hi) <= 0; }
}
const FakeKeyRange = { bound: (lo, hi) => new FakeRange(lo, hi) };

function sizeOf(v) {
  if (v === null || typeof v !== 'object') return typeof v === 'string' ? v.length : 0;
  if (typeof Blob !== 'undefined' && v instanceof Blob) return 0;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  let n = 0;
  for (const k of Object.keys(v)) n += sizeOf(v[k]);
  return n;
}
function clone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (typeof Blob !== 'undefined' && v instanceof Blob) return v;
  if (ArrayBuffer.isView(v)) return v.slice();
  if (Array.isArray(v)) return v.map(clone);
  const o = {};
  for (const k of Object.keys(v)) o[k] = clone(v[k]);
  return o;
}

function makeFakeIdb(opts = {}) {
  const cap = opts.maxValueBytes == null ? CHROMIUM_CAP : opts.maxValueBytes;
  const dbs = new Map();               // name -> { version, data: Map(store -> [{k, v}]), keyPaths: Map }
  const connections = new Set();
  const failures = [];
  let chain = Promise.resolve();
  const stats = { maxPutBytes: 0, blobPuts: 0 };

  class Req { constructor() { this.result = undefined; this.error = null; this.onsuccess = null; this.onerror = null; } }

  class Store {
    constructor(tx, name) { this.tx = tx; this.name = name; }
    _rows() { return this.tx.db.data.get(this.name); }
    _add(run) { const req = new Req(); this.tx._enqueue(req, run); return req; }
    _selector(q) { return q instanceof FakeRange ? (k) => q.has(k) : (k) => cmp(k, q) === 0; }
    put(value, key) {
      if (this.tx.mode !== 'readwrite') throw domErr('ReadOnlyError');
      const size = sizeOf(value);
      stats.maxPutBytes = Math.max(stats.maxPutBytes, size);
      if (size > cap) throw domErr('DataError', 'The serialized value is too large (size=' + size + ' bytes, max=' + cap + ' bytes).');
      const kp = this.tx.db.keyPaths.get(this.name);
      const k = kp ? value[kp] : key;
      const v = clone(value);
      const name = this.name;
      return this._add(() => {
        const i = failures.findIndex((f) => f.op === 'put' && f.store === name);
        if (i >= 0) throw domErr(failures.splice(i, 1)[0].name);
        const rows = this._rows();
        const at = rows.findIndex((r) => cmp(r.k, k) >= 0);
        if (at >= 0 && cmp(rows[at].k, k) === 0) rows[at] = { k, v };
        else if (at >= 0) rows.splice(at, 0, { k, v });
        else rows.push({ k, v });
        return k;
      });
    }
    get(q) {
      const sel = this._selector(q);
      return this._add(() => { const r = this._rows().find((x) => sel(x.k)); return r ? clone(r.v) : undefined; });
    }
    getAll(q) {
      const sel = q ? this._selector(q) : () => true;
      return this._add(() => this._rows().filter((x) => sel(x.k)).map((x) => clone(x.v)));
    }
    getAllKeys(q) {
      const sel = q ? this._selector(q) : () => true;
      return this._add(() => this._rows().filter((x) => sel(x.k)).map((x) => clone(x.k)));
    }
    count(q) {
      const sel = q ? this._selector(q) : () => true;
      return this._add(() => this._rows().filter((x) => sel(x.k)).length);
    }
    delete(q) {
      if (this.tx.mode !== 'readwrite') throw domErr('ReadOnlyError');
      const sel = this._selector(q);
      return this._add(() => {
        const rows = this._rows();
        for (let i = rows.length - 1; i >= 0; i--) if (sel(rows[i].k)) rows.splice(i, 1);
        return undefined;
      });
    }
  }

  class Tx {
    constructor(db, names, mode) {
      this.db = db; this.mode = mode; this.names = names;
      this.queue = []; this.error = null; this.aborted = false; this.done = false;
      this.oncomplete = null; this.onerror = null; this.onabort = null;
      const prev = chain;
      chain = new Promise((r) => { this._fin = r; });
      prev.then(() => setTimeout(() => this._start(), 0));
    }
    objectStore(name) {
      if (!this.names.includes(name)) throw domErr('NotFoundError');
      return new Store(this, name);
    }
    _enqueue(req, run) { this.queue.push({ req, run }); }
    _start() {
      if (this.mode === 'readwrite') this.backup = new Map([...this.db.data].map(([n, rows]) => [n, rows.slice()]));
      this._pump();
    }
    async _pump() {
      while (!this.aborted) {
        const item = this.queue.shift();
        if (!item) break;
        await new Promise((r) => setImmediate(r));
        if (this.aborted) break;
        let ok = true, res;
        try { res = item.run(); } catch (e) { ok = false; item.req.error = e; }
        try {
          if (ok) { item.req.result = res; if (item.req.onsuccess) item.req.onsuccess({ target: item.req }); }
          else {
            if (item.req.onerror) item.req.onerror({ target: item.req });
            // bubbles to the transaction while tx.error is still null (the trap the engine maps around)
            if (this.onerror) this.onerror({ target: item.req });
            this.abort(item.req.error);
          }
        } catch (e) { this.abort(e); }
      }
      if (!this.aborted) { this.done = true; if (this.oncomplete) this.oncomplete({}); this._fin(); }
    }
    abort(err) {
      if (this.done || this.aborted) return;
      this.aborted = true;
      this.error = err || null;
      this.queue.length = 0;
      if (this.backup) for (const [n, rows] of this.backup) this.db.data.set(n, rows);
      setTimeout(() => { if (this.onabort) this.onabort({ target: this }); this._fin(); }, 0);
    }
  }

  class Db {
    constructor(rec) { this.rec = rec; this.data = rec.data; this.keyPaths = rec.keyPaths; this.closed = false; this.onclose = null; this.onversionchange = null; }
    createObjectStore(name, o) { this.data.set(name, []); this.keyPaths.set(name, o && o.keyPath); return {}; }
    transaction(names, mode) {
      if (this.closed) throw domErr('InvalidStateError', 'The database connection is closing.');
      return new Tx(this, Array.isArray(names) ? names : [names], mode || 'readonly');
    }
    close() { this.closed = true; connections.delete(this); }
  }

  const idb = {
    open(name, version) {
      const req = new Req();
      req.onupgradeneeded = null; req.onblocked = null;
      setTimeout(() => {
        let rec = dbs.get(name);
        const fresh = !rec;
        if (!rec) { rec = { version, data: new Map(), keyPaths: new Map() }; dbs.set(name, rec); }
        const db = new Db(rec);
        connections.add(db);
        req.result = db;
        if (fresh && req.onupgradeneeded) req.onupgradeneeded({ target: req });
        if (req.onsuccess) req.onsuccess({ target: req });
      }, 0);
      return req;
    }
  };

  return {
    idb,
    stats,
    failNext(op, store, name) { failures.push({ op, store, name }); },
    // The browser closes every connection (storage cleared, profile eviction).
    closeAll() { for (const db of [...connections]) { db.closed = true; connections.delete(db); if (db.onclose) db.onclose({}); } },
    // Another tab upgrades the database: the page is told and must close.
    versionChange() { for (const db of [...connections]) if (db.onversionchange) db.onversionchange({}); },
    rows(storeName) { const rec = dbs.get('lumen3d-ij'); return rec ? rec.data.get(storeName).map((r) => r.k) : []; }
  };
}

// ── engine in its own vm realm over a fake IndexedDB ────────────────────────────────────────────────────
function boot(fake) {
  const sandbox = {
    console, setTimeout, clearTimeout, MessageChannel, performance, TextEncoder, TextDecoder, Blob,
    indexedDB: fake.idb, IDBKeyRange: FakeKeyRange
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-engine.js']) {
    vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sandbox, { filename: f });
  }
  return sandbox;
}

function client(sandbox, opts = {}) {
  const log = [];
  const waiters = new Map();
  let n = 0;
  const fakeSelf = {
    navigator: {}, onmessage: null,
    postMessage(m) {
      log.push(m);
      if (m.id !== undefined && 'ok' in m) { const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m); } }
    }
  };
  const eng = sandbox.IJEngine.start(fakeSelf, Object.assign({ storage: 'indexeddb', idleMs: 3600000, retryMs: [3600000], bandPixels: 1 << 20 }, opts));
  const c = {
    log, eng,
    call(cmd, args) { return new Promise((res) => { const id = ++n; waiters.set(id, res); fakeSelf.onmessage({ data: { id, cmd, args } }); }); },
    async ok(cmd, args) {
      const m = await within(c.call(cmd, args), 5000, cmd);
      assert.ok(m.ok, `${cmd} failed: ${m.error && m.error.code}`);
      return m.result;
    },
    events(name) { return log.filter((m) => m.event === name); },
    async makeDoc(W, H, chans, o = {}) {
      const method = o.method || 'max';
      const begin = await c.ok('doc.project.begin', {
        docId: o.docId, name: o.name || 'img', method, width: W, height: H, depth: 1,
        channels: chans.map((_, i) => ({ name: 'C' + (i + 1), color: ['#ffffff', '#00ff00', '#ff0000'][i] || '#ffffff' })),
        calibration: { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'um' },
        provenance: { datasetId: 'ds1', sessionKey: o.sessionKey }
      });
      for (let i = 0; i < chans.length; i++) {
        await c.ok('doc.project.add', { docId: begin.docId, channel: i, y0: 0, rows: H, z0: 0, depth: 1, data: Uint8Array.from(chans[i]) });
      }
      const fin = await c.ok('doc.project.finish', { docId: begin.docId });
      return { id: begin.docId, info: fin.info };
    },
    async tile(id, ch = 0) {
      const t = await c.ok('doc.tile', { docId: id, channel: ch, level: 0, tx: 0, ty: 0 });
      return t.data;
    }
  };
  return c;
}

function pattern(W, H, seed) {
  let s = seed >>> 0;
  const d = new Uint8Array(W * H);
  for (let i = 0; i < d.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; d[i] = (s >>> 24) ^ ((i * 7) & 255); }
  return d;
}

const origError = console.error;
const quiet = () => { console.error = () => {}; };
const loud = () => { console.error = origError; };

// ── 1. the fake enforces what it claims ────────────────────────────────────────────────────────────────────
{
  const f = makeFakeIdb();
  const sb = boot(f);
  const st = sb.IJEngine.createIndexedDbStorage(f.idb);
  // Chromium's real cap: one plain typed array above it is refused, whatever else the record holds
  const huge = new Uint8Array(CHROMIUM_CAP + 1);
  const plain = { kind: 'baseline', docId: 'd1', channels: [{ name: 'a', data: huge }] };
  // the engine's own writer turns the channel into a Blob, so the same record is accepted
  await st.putSnapshot('k|1', plain);
  assert.ok(f.stats.maxPutBytes < 1024, 'the stored value holds no channel bytes (out of line): ' + f.stats.maxPutBytes);
  const back = await within(st.load('k|1'), 5000, 'load of a Blob channel');
  assert.equal(back.docs.d1.baseline.channels[0].data.length, CHROMIUM_CAP + 1);
  assert.equal(back.docs.d1.baseline.channels[0].data.constructor.name, 'Uint8Array');
  // and the raw fake does refuse the plain value (the failure the Blob path exists to avoid)
  const raw = f.idb.open('probe', 1);
  const db = await new Promise((res) => { raw.onupgradeneeded = () => raw.result.createObjectStore('s'); raw.onsuccess = () => res(raw.result); });
  const tx = db.transaction(['s'], 'readwrite');
  assert.throws(() => tx.objectStore('s').put({ data: huge }, 1), (e) => e.name === 'DataError' && /max=133169152/.test(e.message));
  console.log('fake IndexedDB: cap, Blob out of line, load resolves: OK');
}

// ── 2. recovery scenarios on IndexedDB (a record bigger than the cap goes through as Blobs) ────────────────
{
  const W = 512, H = 256;
  const imgs = [pattern(W, H, 1), pattern(W, H, 2), pattern(W, H, 3)];
  const f = makeFakeIdb({ maxValueBytes: 200 * 1024 });       // 3 × 128 KiB channels > cap as plain arrays
  const sb = boot(f);
  const key = 'ds1|fig|0|z|0|0|max';

  // (a) baseline + journal only, then a reload
  const a = client(sb);
  const { id } = await a.makeDoc(W, H, imgs, { sessionKey: key });
  await a.ok('doc.run', { docId: id, op: 'invert', params: {}, roi: null, channel: 'all' });
  await a.ok('doc.run', { docId: id, op: 'math', params: { op: 'add', value: 7 }, roi: null, channel: 1 });
  await a.eng.whenIdle();
  assert.equal(a.events('storageError').length, 0, 'a record of 384 KiB over a 200 KiB cap is stored (Blobs): no storage error');
  const want = [A(await a.tile(id, 0)), A(await a.tile(id, 1)), A(await a.tile(id, 2))];
  a.eng.dispose();
  const b = client(sb);
  const list = await b.ok('session.list', { datasetId: 'ds1' });
  assert.equal(list.sessions.length, 1); assert.equal(list.sessions[0].docs, 1); assert.equal(list.sessions[0].unsaved, true);
  const res = await b.ok('session.restore', { key });                // regression: restore must resolve (oncomplete kept)
  assert.deepEqual(P(res.docIds), [id]); assert.equal(res.warnings.length, 0);
  assert.deepEqual([A(await b.tile(id, 0)), A(await b.tile(id, 1)), A(await b.tile(id, 2))], want, 'baseline + journal replay');

  // (b) 16-bit, then a flush (snapshot of Uint16 channels), then a reload
  await b.ok('doc.run', { docId: id, op: 'convert', params: { bitDepth: 16 }, roi: null, channel: 'all' });
  await b.ok('doc.run', { docId: id, op: 'gaussian', params: { sigma: 1.2 }, roi: null, channel: 'all' });
  assert.equal((await b.ok('flush', {})).ok, true);
  const want16 = [A(await b.tile(id, 0)), A(await b.tile(id, 1))];
  assert.equal((await b.tile(id, 0)).constructor.name, 'Uint16Array');
  b.eng.dispose();
  const c = client(sb);
  await c.ok('session.restore', { key });
  assert.equal((await c.ok('doc.info', { docId: id })).bitDepth, 16);
  assert.deepEqual([A(await c.tile(id, 0)), A(await c.tile(id, 1))], want16, 'Uint16 snapshot round trip');

  // (c) 32-bit snapshot (Float32 channels)
  await c.ok('doc.run', { docId: id, op: 'convert', params: { bitDepth: 32 }, roi: null, channel: 'all' });
  await c.ok('doc.run', { docId: id, op: 'math', params: { op: 'multiply', value: 1.37 }, roi: null, channel: 0 });
  assert.equal((await c.ok('flush', {})).ok, true);
  const want32 = A(await c.tile(id, 0));
  assert.equal((await c.tile(id, 0)).constructor.name, 'Float32Array');
  c.eng.dispose();
  const d = client(sb);
  await d.ok('session.restore', { key });
  assert.deepEqual(A(await d.tile(id, 0)), want32, 'Float32 snapshot round trip');
  assert.equal(d.events('storageError').length, 0);

  // (d) keep for later / save + close / discard by document, with the session count following
  assert.equal((await d.ok('doc.close', { docId: id })).kept, true);
  assert.equal((await d.ok('session.list', {})).sessions.length, 1, 'closed unsaved: kept for later');
  await d.ok('session.restore', { key });
  await d.ok('doc.markSaved', { docId: id });
  await d.ok('doc.close', { docId: id });
  await d.eng.whenIdle();
  assert.equal((await d.ok('session.list', {})).sessions.length, 0, 'saved + closed: nothing left');
  assert.equal(f.rows('docs').length, 0, 'no stored record is left behind'); assert.equal(f.rows('journal').length, 0);
  d.eng.dispose();
  console.log('IndexedDB recovery: baseline + journal, Uint16 / Float32 Blob snapshots, keep / save / discard: OK');
}

// ── 3. several sessions and documents: ranges, docCount, discard by document, open document protected ─────────
{
  const f = makeFakeIdb();
  const sb = boot(f);
  const img = pattern(64, 48, 9);
  const a = client(sb);
  const k1 = 'fig|1', k10 = 'fig|10', k1x = 'fig|1x';
  const d1 = await a.makeDoc(64, 48, [img], { sessionKey: k1 });
  const d1b = await a.ok('doc.duplicate', { docId: d1.id, name: 'copy' });
  const d10 = await a.makeDoc(64, 48, [img], { sessionKey: k10 });
  const d1x = await a.makeDoc(64, 48, [img], { sessionKey: k1x });
  await a.eng.whenIdle();
  const rows = (await a.ok('session.list', {})).sessions;
  assert.deepEqual(P(rows.map((r) => [r.key, r.docs])).sort(), [[k1, 2], [k10, 1], [k1x, 1]].sort(), 'real document counts, ranges do not bleed between keys');
  // restoring one key brings back only its own documents
  a.eng.dispose();
  const b = client(sb);
  const res = await b.ok('session.restore', { key: k1 });
  assert.deepEqual(P(res.docIds).sort(), [d1.id, d1b.docId].sort());
  assert.equal((await b.ok('doc.list', {})).docs.length, 2);
  // an open document is not stripped by session.discard; closing it with discard drops one document only
  const kept = await b.ok('session.discard', { key: k1 });
  assert.deepEqual(P(kept.kept).sort(), [d1.id, d1b.docId].sort());
  assert.equal((await b.ok('session.list', {})).sessions.length, 3);
  await b.ok('doc.close', { docId: d1b.docId, discard: true });
  await b.eng.whenIdle();
  const after = (await b.ok('session.list', {})).sessions.find((r) => r.key === k1);
  assert.equal(after.docs, 1, 'discarding one document keeps the other');
  await b.ok('doc.close', { docId: d1.id, discard: true });
  await b.eng.whenIdle();
  assert.ok(!(await b.ok('session.list', {})).sessions.some((r) => r.key === k1), 'the last document gone = session gone');
  // a session nobody has open goes whole
  await b.ok('session.discard', { key: k10 });
  assert.deepEqual(P((await b.ok('session.list', {})).sessions.map((r) => r.key)), [k1x]);
  b.eng.dispose();
  void d10; void d1x;
  console.log('IndexedDB sessions: key ranges, docCount, discard by document: OK');
}

// ── 4. no ghost session; a journal entry for a missing session fails and leaves nothing ───────────────────────
{
  const f = makeFakeIdb();
  const sb = boot(f);
  const st = sb.IJEngine.createIndexedDbStorage(f.idb);
  await st.putMeta('nobody', { docs: { x: { name: 'x', saved: false } } });
  assert.deepEqual(P(await st.list()), [], 'putMeta does not create a session');
  await assert.rejects(() => st.putJournal('nobody', { docId: 'x', seq: 1, kind: 'run' }), (e) => e.code === 'IJ_STORAGE_FAILED');
  assert.equal(f.rows('journal').length, 0, 'the refused journal entry was rolled back');
  assert.deepEqual(P(await st.list()), []);
  // a stored document makes the session, and putMeta then updates it
  await st.putSnapshot('real', { kind: 'baseline', docId: 'dA', channels: [{ name: 'a', data: Uint8Array.of(1, 2, 3) }], provenance: { datasetId: 'ds' } });
  await st.putMeta('real', { docs: { dA: { name: 'A', saved: true } } });
  const l = await st.list();
  assert.equal(l.length, 1); assert.deepEqual(P(l[0].docIds), ['dA']); assert.equal(l[0].docCount, 1);
  assert.equal(l[0].meta.docs.dA.name, 'A');
  // typed arrays round trip with their type, NaN / Infinity included
  const f32 = Float32Array.of(1.5, -0, Infinity, -Infinity, 3.25);
  await st.putSnapshot('real', { kind: 'snapshot', docId: 'dB', journalSeq: 0, channels: [{ name: 'f', data: f32 }, { name: 'u', data: Uint16Array.of(0, 65535, 300) }, { name: 'n', data: null, sameAsBaseline: true }] });
  const got = await st.load('real');
  const sn = got.docs.dB.snapshot;
  assert.deepEqual(A(sn.channels[0].data), A(f32)); assert.equal(sn.channels[0].data.constructor.name, 'Float32Array');
  assert.deepEqual(A(sn.channels[1].data), [0, 65535, 300]); assert.equal(sn.channels[1].data.constructor.name, 'Uint16Array');
  assert.equal(sn.channels[2].data, null);
  console.log('IndexedDB ghost sessions, typed array round trip: OK');
}

// ── 5. error classification, a closed connection, a version change ────────────────────────────────────────────
{
  const f = makeFakeIdb();
  const sb = boot(f);
  const img = pattern(64, 48, 4);
  quiet();
  const a = client(sb);
  const { id } = await a.makeDoc(64, 48, [img], { sessionKey: 'ds1|err|0' });
  await a.eng.whenIdle();
  assert.equal((await a.ok('doc.info', { docId: id })).protected, true);
  // a quota refusal raised on a REQUEST (tx.error still null when tx.onerror runs) is a quota error
  await a.ok('doc.run', { docId: id, op: 'invert', params: {}, roi: null, channel: 0 });
  f.failNext('put', 'docs', 'QuotaExceededError');
  await a.ok('flush', {});
  const ev = a.events('storageError');
  assert.ok(ev.length >= 1 && ev[ev.length - 1].code === 'IJ_STORAGE_QUOTA', 'quota classified from the request error: ' + JSON.stringify(ev));
  assert.equal((await a.ok('doc.info', { docId: id })).protected, false);
  assert.equal((await a.ok('flush', {})).ok, true, 'the next flush stores the document again');
  assert.equal((await a.ok('doc.info', { docId: id })).protected, true);
  // the browser closes the connection: the next write reopens instead of failing for ever
  f.closeAll();
  await a.ok('doc.run', { docId: id, op: 'invert', params: {}, roi: null, channel: 0 });
  assert.equal((await a.ok('flush', {})).ok, true, 'a write after the connection was closed');
  f.versionChange();
  await a.ok('doc.run', { docId: id, op: 'invert', params: {}, roi: null, channel: 0 });
  assert.equal((await a.ok('flush', {})).ok, true, 'a write after a version change');
  a.eng.dispose();
  loud();
  // all of it survived: a fresh engine restores the last state
  const b = client(sb);
  await b.ok('session.restore', { key: 'ds1|err|0' });
  assert.deepEqual(A(await b.tile(id, 0)), A(img).map((v) => 255 - v).map((v) => 255 - v).map((v) => 255 - v), 'three inversions');
  b.eng.dispose();
  console.log('IndexedDB errors: quota from the request error, closed connection, version change: OK');
}

console.log('ij engine IndexedDB: OK');
process.exit(0);
