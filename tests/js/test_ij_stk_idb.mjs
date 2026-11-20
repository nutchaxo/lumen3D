// Persistence of stacks in the worker engine (js/modules/studio/advanced-studio/ij-engine.js, createIndexedDbStorage), run under
// Node against the same in-test fake IndexedDB as test_ij_engine_idb.mjs (Chromium's value cap, Blobs out of line, key order,
// transactions that commit when their requests are done):
//   • a stack is stored plane by plane — each plane its own Blob — so a record far over the cap goes through;
//   • baseline + journal replay of planes runs, a snapshot of a stack, snapshot planes that are references to the baseline
//     (baseIndex = c * NP + pi, also after a reorder), revert to the stored stack, the position (display.pos), keep / discard;
//   • 32-bit and RGB stacks;
//   • LEGACY: a stored baseline / snapshot / journal / meta written before stacks (flat channel records with data / baseIndex, entries
//     with neither `pos` nor `planes`, a display signature without dimensions) restores as a 1 x 1 stack and replays unchanged.
//
// Run: node tests/js/test_ij_stk_idb.mjs
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
function boot(fake, files = ['ij-core.js', 'ij-analysis.js', 'ij-engine.js']) {
  const sandbox = {
    console, setTimeout, clearTimeout, MessageChannel, performance, TextEncoder, TextDecoder, Blob,
    indexedDB: fake.idb, IDBKeyRange: FakeKeyRange
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const f of files) {
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


// ── test operations ────────────────────────────────────────────────────────────────────────────────────────────
const noApron = { x: 0, y: 0 };
const addFn = (v) => (src) => { const mx = src.bitDepth === 8 ? 255 : src.bitDepth === 16 ? 65535 : Infinity; const o = new src.data.constructor(src.data.length); for (let i = 0; i < o.length; i++) o[i] = Math.min(mx, src.data[i] + v); return o; };
function defineOps(sb) {
  const R = sb.IJOpRegistry;
  R.define('tAddByPos', { kind: 'pixel', version: 1, prepare: (view, c) => ({ apron: noApron, fn: addFn(1 + view.z + 4 * view.t + 16 * c) }) });
  R.define('tAdd', { kind: 'pixel', version: 1, prepare: (view, c, p) => ({ apron: noApron, fn: addFn(p.value) }) });
  R.define('tReverseZ', {
    kind: 'size', version: 1, stack: 'whole',
    async run(view) {
      const nZ = view.nZ, nT = view.nT;
      const channels = view.channels.map((ch) => {
        const planes = [];
        for (let t = 0; t < nT; t++) for (let z = nZ - 1; z >= 0; z--) planes.push(ch.planes[t * nZ + z]);
        return { name: ch.name, color: ch.color, planes };
      });
      return { width: view.width, height: view.height, bitDepth: view.bitDepth, nZ, nT, channels };
    }
  });
}

function mkImage(o) {
  const W = o.W, H = o.H, bd = o.bd, nC = o.nC, nZ = o.nZ, nT = o.nT;
  const Ctor = bd === 8 ? Uint8Array : bd === 16 ? Uint16Array : Float32Array;
  const channels = [];
  for (let c = 0; c < nC; c++) {
    const planes = [];
    for (let t = 0; t < nT; t++) for (let z = 0; z < nZ; z++) {
      const a = new Ctor(W * H);
      for (let i = 0; i < a.length; i++) a[i] = bd === 32 ? (c * 10 + z + t * 0.5 + (i % 13) * 0.25) : (c * 1000 + z * 100 + t * 30 + (i % 17));
      planes.push(a);
    }
    channels.push({ name: 'C' + (c + 1), color: ['#ffffff', '#00ff00', '#ff0000'][c % 3], planes });
  }
  return { name: o.name || 'stk', width: W, height: H, bitDepth: bd, nZ, nT, hyperstack: nZ > 1 && nT > 1, channels, calibration: { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'um' } };
}
async function planesOf(cl, id, nC, nZ, nT) {
  const o = {};
  for (let t = 0; t < nT; t++) for (let z = 0; z < nZ; z++) for (let c = 0; c < nC; c++) {
    o[`${c}.${z}.${t}`] = A((await cl.ok('doc.tile', { docId: id, channel: c, level: 0, tx: 0, ty: 0, pos: { z, t } })).data);
  }
  return o;
}

// ── 1. a stack goes to IndexedDB plane by plane (each its own Blob), whatever the cap, and comes back ─────────────
{
  const nC = 2, nZ = 3, nT = 2, W = 64, H = 48;
  // one plane = 6 KiB (16-bit); the record of the stack is 144 KiB, far over the 20 KiB cap as plain arrays
  const f = makeFakeIdb({ maxValueBytes: 20 * 1024 });
  const sb = boot(f); defineOps(sb);
  const key = 'ds1|stk|idb';
  const a = client(sb);
  const id = (await a.ok('doc.import', { image: mkImage({ W, H, bd: 16, nC, nZ, nT }), sessionKey: key })).docId;
  await a.ok('doc.setPosition', { docId: id, z: 2, t: 1, c: 1 });
  await a.ok('doc.run', { docId: id, op: 'tAddByPos', params: {}, channel: 'all', planes: 'all' });
  await a.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 9 }, channel: 0, planes: { z: [1, 2], t: [1, 1] } });
  await a.eng.whenIdle();
  assert.equal(a.events('storageError').length, 0, 'a 144 KiB stack over a 20 KiB cap is stored: one Blob per plane');
  assert.ok(f.stats.maxPutBytes < 4096, 'no plane bytes inside a stored value: ' + f.stats.maxPutBytes);
  const want = await planesOf(a, id, nC, nZ, nT);
  // the session meta stamps the position
  const row = (await a.ok('session.list', {})).sessions[0];
  assert.equal(row.docs, 1);
  a.eng.dispose();
  // (a) baseline + journal on a new engine (a reload)
  const b = client(sb);
  const res = await b.ok('session.restore', { key });
  assert.deepEqual(P(res.docIds), [id]); assert.equal(res.warnings.length, 0, JSON.stringify(res.warnings));
  assert.deepEqual(await planesOf(b, id, nC, nZ, nT), want, 'baseline + journal of a stack');
  const bi = await b.ok('doc.info', { docId: id });
  assert.deepEqual(P([bi.nC, bi.nZ, bi.nT, bi.nSlices, bi.z, bi.t, bi.active, bi.hyperstack]), [2, 3, 2, 12, 2, 1, 1, true], 'the position (display.pos) comes back');
  // (b) a snapshot: untouched planes are references to the baseline (c * NP + pi), the others stored in full
  await b.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 3 }, channel: 1, planes: [4] });
  assert.equal((await b.ok('flush', {})).ok, true);
  const st = sb.IJEngine.createIndexedDbStorage(f.idb);
  const snap = (await st.load(key)).docs[id].snapshot;
  assert.ok(snap && snap.nZ === 3 && snap.nT === 2 && snap.rgb === false && snap.hyperstack === true);
  const NP = 6;
  assert.ok(snap.channels.every((c) => Array.isArray(c.planes) && c.planes.length === NP && c.data === undefined), 'a stack stores `planes` per channel');
  // every plane was changed by the first run (tAddByPos adds >= 1 everywhere): none is a baseline reference but the arrays are Blob-decoded typed arrays
  assert.ok(snap.channels.every((c) => c.planes.every((p) => p.data && p.data.constructor.name === 'Uint16Array' && p.data.length === W * H)));
  const want2 = await planesOf(b, id, nC, nZ, nT);
  b.eng.dispose();
  const c2 = client(sb);
  await c2.ok('session.restore', { key });
  assert.deepEqual(await planesOf(c2, id, nC, nZ, nT), want2, 'snapshot of a stack');
  // (c) a reversal keeps the arrays: after a snapshot the planes are references to the baseline with the right flat index
  await c2.ok('doc.run', { docId: id, op: 'tReverseZ', params: {}, channel: 'all' });
  await c2.ok('doc.revert', { docId: id });                 // back to the loaded images: every plane IS a baseline array
  assert.equal((await c2.ok('flush', {})).ok, true);
  const snap2 = (await st.load(key)).docs[id].snapshot;
  for (let c = 0; c < nC; c++) for (let pi = 0; pi < NP; pi++) {
    const p = snap2.channels[c].planes[pi];
    assert.ok(p.sameAsBaseline === true && p.baseIndex === c * NP + pi && !p.data, `plane c${c} pi${pi} refers to baseline ${c * NP + pi}`);
  }
  await c2.ok('doc.run', { docId: id, op: 'tReverseZ', params: {}, channel: 'all' });
  assert.equal((await c2.ok('flush', {})).ok, true);
  const snap3 = (await st.load(key)).docs[id].snapshot;
  for (let c = 0; c < nC; c++) for (let t = 0; t < nT; t++) for (let z = 0; z < nZ; z++) {
    const p = snap3.channels[c].planes[t * nZ + z];
    assert.ok(p.sameAsBaseline === true && p.baseIndex === c * NP + t * nZ + (nZ - 1 - z), `reversed plane c${c} t${t} z${z} → baseline ${c * NP + t * nZ + (nZ - 1 - z)} (got ${p.baseIndex})`);
  }
  const want3 = await planesOf(c2, id, nC, nZ, nT);
  c2.eng.dispose();
  const d2 = client(sb);
  await d2.ok('session.restore', { key });
  assert.deepEqual(await planesOf(d2, id, nC, nZ, nT), want3, 'a snapshot made only of baseline references restores the reordered planes');
  // revert after the restore reads the stored stack baseline back (dimensions included)
  await d2.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 2 }, channel: 'all', planes: 'all' });
  const rv = await d2.ok('doc.revert', { docId: id });
  assert.deepEqual(P([rv.info.nZ, rv.info.nT, rv.info.nSlices]), [3, 2, 12]);
  assert.deepEqual(await planesOf(d2, id, nC, nZ, nT), await planesOf(d2, id, nC, nZ, nT));
  const orig = mkImage({ W, H, bd: 16, nC, nZ, nT });
  for (let t = 0; t < nT; t++) for (let z = 0; z < nZ; z++) for (let c = 0; c < nC; c++) {
    assert.deepEqual((await planesOf(d2, id, nC, nZ, nT))[`${c}.${z}.${t}`], A(orig.channels[c].planes[t * nZ + z]), `reverted plane c${c} z${z} t${t}`);
  }
  // keep-for-later / discard of a stack document
  assert.equal((await d2.ok('doc.close', { docId: id })).kept, true);
  assert.equal((await d2.ok('session.list', {})).sessions.length, 1);
  await d2.ok('session.discard', { key });
  await d2.eng.whenIdle();
  assert.equal(f.rows('docs').length, 0); assert.equal(f.rows('journal').length, 0);
  d2.eng.dispose();
  console.log('IndexedDB: a stack as one Blob per plane, baseline + journal, snapshot, baseline references c*NP+pi, revert: OK');
}

// ── 2. 32-bit and an RGB stack round trip ─────────────────────────────────────────────────────────────────────────
{
  const f = makeFakeIdb({ maxValueBytes: 8 * 1024 });
  const sb = boot(f); defineOps(sb);
  const key = 'ds1|stk|f32rgb';
  const a = client(sb);
  const id = (await a.ok('doc.import', { image: mkImage({ W: 32, H: 16, bd: 32, nC: 1, nZ: 4, nT: 1, name: 'f32' }), sessionKey: key })).docId;
  await a.ok('doc.run', { docId: id, op: 'tAdd', params: { value: 0.5 }, channel: 0, planes: [1, 3] });
  assert.equal((await a.ok('flush', {})).ok, true);
  const want = await planesOf(a, id, 1, 4, 1);
  const rgbImg = mkImage({ W: 8, H: 8, bd: 8, nC: 3, nZ: 2, nT: 1, name: 'rgb' });
  rgbImg.rgb = true; rgbImg.channels.forEach((c, i) => { c.name = ['Red', 'Green', 'Blue'][i]; });
  const rid = (await a.ok('doc.import', { image: rgbImg, sessionKey: key })).docId;
  await a.ok('doc.run', { docId: rid, op: 'tAdd', params: { value: 5 }, channel: 0, planes: 'all' });
  const wantRgb = await planesOf(a, rid, 3, 2, 1);
  await a.eng.whenIdle();
  assert.equal(a.events('storageError').length, 0);
  a.eng.dispose();
  const b = client(sb);
  const res = await b.ok('session.restore', { key });
  assert.equal(res.warnings.length, 0, JSON.stringify(res.warnings)); assert.equal(res.docIds.length, 2);
  assert.deepEqual(await planesOf(b, id, 1, 4, 1), want);
  assert.equal((await b.ok('doc.tile', { docId: id, channel: 0, level: 0, tx: 0, ty: 0, pos: { z: 1, t: 0 } })).data.constructor.name, 'Float32Array');
  const ri = await b.ok('doc.info', { docId: rid });
  assert.deepEqual(P([ri.rgb, ri.nC, ri.bitDepthIJ, ri.nSlices, ri.mode]), [true, 1, 24, 2, 'composite']);
  assert.deepEqual(await planesOf(b, rid, 3, 2, 1), wantRgb, 'an RGB stack is restored (journal replay on RGB)');
  b.eng.dispose();
  console.log('IndexedDB: 32-bit stack, RGB stack: OK');
}

// ── 3. LEGACY records and journal entries (written before stacks) restore as 1 x 1 stacks ────────────────────────────
{
  const f = makeFakeIdb();
  const sb = boot(f); defineOps(sb);
  const st = sb.IJEngine.createIndexedDbStorage(f.idb);
  const key = 'ds1|legacy|0';
  const W = 5, H = 3;
  const px0 = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15);
  const px1 = Uint8Array.of(20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34);
  const chan = (name, color, extra) => Object.assign({ name, color, display: { min: 0, max: 255, lut: null, invert: false } }, extra);
  // the record of the first versions: no nZ / nT / z / t / labels / hyperstack / rgb, channels hold `data`
  const head = (kind, extra) => Object.assign({ kind, docId: 'dLeg', rev: 0, journalSeq: 0, savedRev: -1, layoutRev: 0, name: 'old', width: W, height: H, bitDepth: 8, hidden: false,
    calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' }, provenance: { datasetId: 'ds1', sessionKey: key } }, extra);
  await st.putSnapshot(key, head('baseline', { display: { sig: '2|A\u0001B|0', mode: 'composite', active: 0, visible: [true, true], channels: [] },
    channels: [chan('A', '#ffffff', { sameAsBaseline: false, data: px0.slice() }), chan('B', '#00ff00', { sameAsBaseline: false, data: px1.slice() })] }));
  // a snapshot where channel B IS the baseline's array (a reference by baseIndex) and channel A was edited
  const edited = Uint8Array.from(px0, (v) => v + 100);
  await st.putSnapshot(key, head('snapshot', { rev: 1, journalSeq: 1, display: { sig: '2|A\u0001B|0', mode: 'composite', active: 1, visible: [true, false], channels: [] },
    channels: [chan('A', '#ffffff', { sameAsBaseline: false, data: edited }), chan('B', '#00ff00', { sameAsBaseline: true, baseIndex: 1, data: null })] }));
  // a journal entry of the first versions (no pos, no planes) after the snapshot
  await st.putJournal(key, { docId: 'dLeg', seq: 2, kind: 'run', op: 'tAdd', version: 1, params: { value: 5 }, roi: null, channel: 'all', maskRule: 2, at: Date.now(), rev: 2 });
  // the meta of the first versions: the display stamped with the old signature (no dimensions in it)
  await st.putMeta(key, { datasetId: 'ds1', docs: { dLeg: { name: 'old', rev: 2, saved: false } },
    display: { dLeg: { sig: '2|A\u0001B|0', mode: 'composite', active: 1, visible: [true, false], channels: [{ min: 3, max: 77, lut: null, invert: false }, { min: 0, max: 255, lut: null, invert: false }] } } });
  const a = client(sb);
  const list = await a.ok('session.list', { datasetId: 'ds1' });
  assert.equal(list.sessions.length, 1); assert.equal(list.sessions[0].docs, 1);
  const res = await a.ok('session.restore', { key });
  assert.deepEqual(P(res.docIds), ['dLeg']); assert.equal(res.warnings.length, 0, JSON.stringify(res.warnings));
  const info = await a.ok('doc.info', { docId: 'dLeg' });
  assert.deepEqual(P([info.nC, info.nZ, info.nT, info.nSlices, info.z, info.t, info.hyperstack, info.rgb, info.bitDepthIJ, info.label, info.channels.length]), [2, 1, 1, 2, 0, 0, false, false, 8, null, 2], 'a legacy record restores as a 1 x 1 stack');
  assert.deepEqual(A((await a.ok('doc.tile', { docId: 'dLeg', channel: 0, level: 0, tx: 0, ty: 0 })).data), A(edited.map((v) => v + 5)), 'snapshot (edited A) + the legacy journal entry replayed on the only plane');
  assert.deepEqual(A((await a.ok('doc.tile', { docId: 'dLeg', channel: 1, level: 0, tx: 0, ty: 0 })).data), A(px1.map((v) => v + 5)), 'channel B came from the baseline by baseIndex');
  assert.deepEqual(P([info.active, info.visible]), [1, [true, false]], 'the legacy display stamp still matches (signature of a 1 x 1 document is unchanged)');
  assert.equal(info.channels[0].display.min, 3); assert.equal(info.channels[0].display.max, 77);
  // revert reads the legacy baseline
  const rv = await a.ok('doc.revert', { docId: 'dLeg' });
  assert.deepEqual(P([rv.info.nZ, rv.info.nT]), [1, 1]);
  assert.deepEqual(A((await a.ok('doc.tile', { docId: 'dLeg', channel: 0, level: 0, tx: 0, ty: 0 })).data), A(px0));
  // the document is writable as a stack from here: a new snapshot has the new fields and restores again
  await a.ok('doc.run', { docId: 'dLeg', op: 'tAdd', params: { value: 1 }, channel: 'all' });
  assert.equal((await a.ok('flush', {})).ok, true);
  const snap = (await st.load(key)).docs.dLeg.snapshot;
  assert.deepEqual(P([snap.nZ, snap.nT, snap.rgb, snap.hyperstack, snap.z, snap.t]), [1, 1, false, false, 0, 0]);
  assert.ok(snap.channels.every((c) => c.data && c.planes === undefined), 'a single-plane document keeps the flat channel record');
  const want = A((await a.ok('doc.tile', { docId: 'dLeg', channel: 0, level: 0, tx: 0, ty: 0 })).data);
  a.eng.dispose();
  const b = client(sb);
  await b.ok('session.restore', { key });
  assert.deepEqual(A((await b.ok('doc.tile', { docId: 'dLeg', channel: 0, level: 0, tx: 0, ty: 0 })).data), want);
  b.eng.dispose();

  // a legacy session whose journal alone holds an undo / redo and a run: replay is unchanged on a 1 x 1 document
  const key2 = 'ds1|legacy|1';
  await st.putSnapshot(key2, head('baseline', { docId: 'dL2', provenance: { datasetId: 'ds1', sessionKey: key2 }, display: { sig: '1|A|0', mode: 'gray', active: 0, visible: [true], channels: [] }, channels: [chan('A', '#ffffff', { sameAsBaseline: false, data: px0.slice() })] }));
  const j = (seq, extra) => st.putJournal(key2, Object.assign({ docId: 'dL2', seq, at: Date.now(), rev: seq }, extra));
  await j(1, { kind: 'run', op: 'tAdd', version: 1, params: { value: 7 }, roi: null, channel: 'all', maskRule: 2 });
  await j(2, { kind: 'run', op: 'tAdd', version: 1, params: { value: 2 }, roi: null, channel: 0, maskRule: 2 });
  await j(3, { kind: 'undo' });
  const c3 = client(sb);
  const r2 = await c3.ok('session.restore', { key: key2 });
  assert.equal(r2.warnings.length, 0, JSON.stringify(r2.warnings));
  assert.deepEqual(A((await c3.ok('doc.tile', { docId: 'dL2', channel: 0, level: 0, tx: 0, ty: 0 })).data), A(px0.map((v) => v + 7)), 'run, run, undo of a legacy journal');
  assert.equal((await c3.ok('doc.info', { docId: 'dL2' })).undoDepth, 1); assert.equal((await c3.ok('doc.info', { docId: 'dL2' })).redoDepth, 1);
  c3.eng.dispose();
  console.log('IndexedDB: legacy records, snapshots (baseIndex) and journal entries restore as 1 x 1 stacks: OK');
}

// ── replay of whole-stack ops: they act on the channel the request named and render through the display it carried ─────────
{
  const STK = ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-engine.js', 'ij-proc-stk.js'];
  // (a) Delete Slice > channel on C3: the journal keeps channel 2; the engine's active channel (display state) is not journaled
  {
    const f = makeFakeIdb();
    const sb = boot(f, STK);
    const key = 'ds1|stk|active';
    const a = client(sb);
    const id = (await a.ok('doc.import', { image: mkImage({ W: 8, H: 4, bd: 8, nC: 3, nZ: 2, nT: 1 }), sessionKey: key })).docId;
    await a.eng.whenIdle();
    // the engine still thinks C1 is active (the page's display patch has not landed): the request's channel decides
    await a.ok('doc.run', { docId: id, op: 'stkDeleteSlice', params: { delete: 'channel' }, channel: 2 });
    const live = await planesOf(a, id, 2, 2, 1);
    assert.deepEqual([live['0.0.0'][0], live['1.0.0'][0]], [mkImage({ W: 8, H: 4, bd: 8, nC: 3, nZ: 2, nT: 1 }).channels[0].planes[0][0], mkImage({ W: 8, H: 4, bd: 8, nC: 3, nZ: 2, nT: 1 }).channels[1].planes[0][0]], 'C3 deleted, C1 and C2 kept');
    await a.ok('doc.setPosition', { docId: id, c: 0 });
    await a.eng.whenIdle();
    a.eng.dispose();
    const b = client(sb);
    const res = await b.ok('session.restore', { key });
    assert.equal(res.warnings.length, 0, JSON.stringify(res.warnings));
    assert.deepEqual(await planesOf(b, id, 2, 2, 1), live, 'the replay deletes the same channel');
    b.eng.dispose();
  }
  // (b) RGB Color in place after a B&C change: the display ranges travel in the journaled params
  {
    const f = makeFakeIdb();
    const sb = boot(f, STK);
    const key = 'ds1|stk|disp';
    const a = client(sb);
    const id = (await a.ok('doc.import', { image: mkImage({ W: 8, H: 4, bd: 16, nC: 2, nZ: 2, nT: 1 }), sessionKey: key })).docId;
    await a.eng.whenIdle();
    await a.ok('doc.setDisplay', { docId: id, channel: 0, min: 0, max: 50 });
    await a.ok('doc.setDisplay', { docId: id, channel: 1, min: 1000, max: 1010 });
    await a.ok('doc.run', { docId: id, op: 'stkRgbColorInPlace', params: { slices: true, frames: true }, channel: 0 });
    const live = await planesOf(a, id, 3, 2, 1);
    await a.eng.whenIdle();
    a.eng.dispose();
    const b = client(sb);
    const res = await b.ok('session.restore', { key });
    assert.equal(res.warnings.length, 0, JSON.stringify(res.warnings));
    assert.deepEqual(await planesOf(b, id, 3, 2, 1), live, 'the replay renders through the display the operator saw');
    b.eng.dispose();
  }
  console.log('replay of whole-stack ops (requested channel, journaled display): OK');
}

console.log('ij stk idb: OK');
