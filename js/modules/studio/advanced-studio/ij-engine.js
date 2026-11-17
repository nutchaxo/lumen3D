/*
 * ij-engine.js — worker-side engine of the Advanced Studio (ImageJ-style image editing).
 *
 * Classic script, no DOM: loaded by ij-worker.js (importScripts of verified blob URLs)
 * and by the Node tests under a fake `self`. It owns every full-precision buffer:
 * documents, undo/redo, the tile pyramid the display draws from, and the journal +
 * snapshot store that keeps the operator's work across a crash or a closed tab.
 * The pure image maths lives in ij-core.js (IJImage, IJOps, IJRoi, IJProject, IJTiff)
 * and ij-analysis.js (IJThreshold, IJBinary, IJParticles, IJFilters); this file only
 * orchestrates them and never re-implements an ImageJ formula, except the two
 * documented ones below (32-bit Invert over the whole-channel range, tile pyramid
 * levels, which are repeated IJOps.downsample2).
 *
 * Protocol (PLAN §3.5): request { id, cmd, args } → { id, ok:true, result } |
 * { id, ok:false, error:{ code, message, details? } }; events { event, … }.
 *
 * Conventions
 *   - A channel's `data` array is IMMUTABLE once published: an operation builds a new
 *     array and swaps the reference at commit. That makes the undo record a plain
 *     reference (full-image ops) or a cropped copy (ROI ops), makes a cancel trivially
 *     atomic, lets a snapshot be handed to storage lazily, and lets reads (pixel,
 *     tile, stats) be served between two slices of a running operation.
 *   - Every long operation runs in bands of rows, a slice lasting ~50 ms, and yields
 *     through a MessageChannel between slices (never setTimeout: no 4 ms clamp).
 *   - Errors carry a `code` (IJ_*); the page maps codes to sentences, the message is
 *     for the console only.
 *
 * Memory model: budget = masters + undo/redo + tile cache + baseline kept in RAM +
 * projection accumulators + transfer copies in flight. An operation that cannot fit,
 * after dropping the tile cache and the oldest undo steps, is refused BEFORE it runs
 * (IJ_OVER_BUDGET). Stored sessions are never evicted silently.
 *
 * Crash recovery: baseline (the loaded image) written once; every committed
 * operation appends a journal entry (op + resolved params + roi); a snapshot of the
 * changed channels is written when idle (3 s) or on `flush`, and deletes the journal
 * entries it covers. Recovery = snapshot (or baseline) + replay of later entries (the
 * operations are deterministic). Undo/redo of a step whose effect a snapshot already
 * contains cannot be replayed from the journal, so it forces a fresh snapshot.
 */
const IJEngine = (() => {
  'use strict';

  const MiB = 1048576;
  const GiB = 1073741824;
  const TILE = 1024;
  const TILE_CACHE_BYTES = 128 * MiB;
  const SLICE_MS = 50;
  const IDLE_MS = 3000;
  const MAX_UNDO = 100;
  const MAX_BAND_PIXELS = 4 * 1048576;
  const ROOT = (typeof globalThis !== 'undefined') ? globalThis : self;

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  function ijError(code, message, details) {
    const e = new Error(message || code);
    e.code = code;
    if (details) e.details = details;
    return e;
  }

  function dep(name) {
    const m = ROOT[name];
    if (!m) throw ijError('IJ_MODULE_MISSING', 'module ' + name + ' is not loaded');
    return m;
  }

  function now() {
    return (typeof performance !== 'undefined' && performance && performance.now) ? performance.now() : Date.now();
  }

  function ctorFor(bitDepth) {
    if (bitDepth === 8) return Uint8Array;
    if (bitDepth === 16) return Uint16Array;
    if (bitDepth === 32) return Float32Array;
    throw ijError('IJ_BAD_ARGS', 'bit depth ' + bitDepth);
  }

  function plainClone(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }

  function cloneValue(v) {
    if (v === null || typeof v !== 'object') return v;
    if (ArrayBuffer.isView(v)) return v.slice();
    if (Array.isArray(v)) return v.map(cloneValue);
    const o = {};
    for (const k of Object.keys(v)) o[k] = cloneValue(v[k]);
    return o;
  }

  function isInt(n) { return typeof n === 'number' && Number.isInteger(n); }

  // Copy of the rectangle (x, y, w, h) of a W-wide image, same typed-array kind.
  function copyRect(src, W, x, y, w, h) {
    const out = new src.constructor(w * h);
    if (w === W) {
      out.set(src.subarray(y * W, (y + h) * W));
      return out;
    }
    for (let r = 0; r < h; r++) {
      const o = (y + r) * W + x;
      out.set(src.subarray(o, o + w), r * w);
    }
    return out;
  }

  function pasteRect(dst, W, x, y, w, h, patch) {
    for (let r = 0; r < h; r++) dst.set(patch.subarray(r * w, (r + 1) * w), (y + r) * W + x);
  }

  // A core module answers with a channel image or a bare typed array.
  function unwrap(res, n) {
    const d = (res && !ArrayBuffer.isView(res) && res.data) ? res.data : res;
    if (!d || !ArrayBuffer.isView(d) || d.length !== n) throw ijError('IJ_BAD_RESULT', 'unexpected result of a core module');
    return d;
  }

  function chImg(w, h, bd, data) { return { width: w, height: h, bitDepth: bd, data }; }

  function defaultBudget(nav) {
    const dm = nav && Number(nav.deviceMemory);
    if (!(dm > 0)) return GiB;
    return Math.min(2 * GiB, Math.max(512 * MiB, Math.floor(dm * GiB / 4)));
  }

  function levelDims(w, h, level) {
    for (let i = 0; i < level; i++) { w = Math.ceil(w / 2); h = Math.ceil(h / 2); }
    return { w, h };
  }

  function levelCount(w, h) {
    let n = 1;
    while (Math.max(w, h) > TILE) { w = Math.ceil(w / 2); h = Math.ceil(h / 2); n++; }
    return n;
  }

  // Cooperative yield: a MessageChannel round trip (no timer clamp). The port is only
  // kept referenced while a yield is pending so an idle engine never holds a Node
  // process open.
  function makeYielder() {
    if (typeof MessageChannel === 'undefined') return { run: () => new Promise((r) => setTimeout(r, 0)), close() {} };
    const ch = new MessageChannel();
    const waiting = [];
    ch.port1.onmessage = () => {
      const r = waiting.shift();
      if (!waiting.length && ch.port1.unref) ch.port1.unref();
      if (r) r();
    };
    if (ch.port1.unref) ch.port1.unref();
    return {
      run() {
        return new Promise((r) => {
          waiting.push(r);
          if (ch.port1.ref) ch.port1.ref();
          ch.port2.postMessage(0);
        });
      },
      close() { try { ch.port1.close(); ch.port2.close(); } catch (e) { /* closed */ } }
    };
  }

  // ---------------------------------------------------------------------------
  // Storage — one interface, an in-memory and an IndexedDB implementation.
  //
  //   putSnapshot(key, rec)   rec.kind 'baseline' | 'snapshot', rec.docId. A 'snapshot'
  //                           also deletes the journal entries of that doc with
  //                           seq <= rec.journalSeq (same transaction).
  //   putJournal(key, entry)  entry { docId, seq, kind, … }
  //   putMeta(key, patch)     shallow-merged into the session's meta
  //   list()                  [{ key, datasetId, savedAt, meta, docCount }]
  //   load(key, what?)        { key, datasetId, savedAt, meta, docs: { [docId]:
  //                           { baseline, snapshot, journal[] } } } | null;
  //                           what = { docId?, parts?: ['baseline','snapshot','journal'] }
  //   discard(key, what?)     what.docId = just that document; none left = session gone
  //   estimate()              { usage, quota }
  // ---------------------------------------------------------------------------

  function createMemoryStorage() {
    const sessions = new Map();
    function sess(key, create, datasetId) {
      let s = sessions.get(key);
      if (!s && create) {
        s = { key, datasetId: null, savedAt: 0, meta: {}, docs: new Map() };
        sessions.set(key, s);
      }
      if (s) {
        s.savedAt = Date.now();
        if (datasetId && !s.datasetId) s.datasetId = datasetId;
      }
      return s;
    }
    function docRec(s, id) {
      let d = s.docs.get(id);
      if (!d) { d = { baseline: null, snapshot: null, journal: [] }; s.docs.set(id, d); }
      return d;
    }
    return {
      kind: 'memory',
      async putSnapshot(key, snap) {
        const rec = cloneValue(snap);
        const s = sess(key, true, snap.provenance && snap.provenance.datasetId);
        const d = docRec(s, snap.docId);
        if (snap.kind === 'baseline') d.baseline = rec;
        else {
          d.snapshot = rec;
          d.journal = d.journal.filter((e) => e.seq > snap.journalSeq);
        }
      },
      // A journal entry or a meta patch never creates a session: only a stored document does,
      // so a session that lists is always one that can be restored. A journal entry for a
      // session that is gone fails, which leaves the document unprotected until its next snapshot.
      async putJournal(key, entry) {
        const s = sess(key, false);
        if (!s) throw ijError('IJ_STORAGE_FAILED', 'no such session');
        docRec(s, entry.docId).journal.push(cloneValue(entry));
      },
      async putMeta(key, patch) {
        const s = sess(key, false, patch && patch.datasetId);
        if (!s) return;
        s.meta = Object.assign({}, s.meta, cloneValue(patch));
      },
      async list() {
        return [...sessions.values()].map((s) => {
          const docIds = [...s.docs].filter(([, d]) => d.baseline || d.snapshot).map(([id]) => id);
          return { key: s.key, datasetId: s.datasetId, savedAt: s.savedAt, meta: cloneValue(s.meta), docCount: docIds.length, docIds };
        });
      },
      async load(key, what) {
        const s = sessions.get(key);
        if (!s) return null;
        const parts = (what && what.parts) || ['baseline', 'snapshot', 'journal'];
        const docs = {};
        for (const [id, d] of s.docs) {
          if (what && what.docId && what.docId !== id) continue;
          docs[id] = {
            baseline: parts.includes('baseline') ? cloneValue(d.baseline) : null,
            snapshot: parts.includes('snapshot') ? cloneValue(d.snapshot) : null,
            journal: parts.includes('journal') ? cloneValue(d.journal) : []
          };
        }
        return { key: s.key, datasetId: s.datasetId, savedAt: s.savedAt, meta: cloneValue(s.meta), docs };
      },
      async discard(key, what) {
        const s = sessions.get(key);
        if (!s) return;
        if (what && what.docId) {
          s.docs.delete(what.docId);
          if (s.meta && s.meta.docs) delete s.meta.docs[what.docId];
          if (s.meta && s.meta.display) delete s.meta.display[what.docId];
          if (![...s.docs.values()].some((d) => d.baseline || d.snapshot)) sessions.delete(key);
        } else sessions.delete(key);
      },
      async estimate() {
        let usage = 0;
        const count = (v) => {
          if (!v || typeof v !== 'object') return;
          if (ArrayBuffer.isView(v)) { usage += v.byteLength; return; }
          for (const k of Object.keys(v)) count(v[k]);
        };
        for (const s of sessions.values()) for (const d of s.docs.values()) { count(d.baseline); count(d.snapshot); count(d.journal); }
        return { usage, quota: null };
      }
    };
  }

  function createIndexedDbStorage(idb) {
    let dbp = null;
    function open() {
      if (!dbp) {
        dbp = new Promise((resolve, reject) => {
          const req = idb.open('lumen3d-ij', 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            db.createObjectStore('sessions', { keyPath: 'key' });
            db.createObjectStore('docs');
            db.createObjectStore('journal');
          };
          req.onsuccess = () => {
            const db = req.result;
            // The browser may close the connection (storage cleared, another tab upgrading):
            // forget it so the next transaction opens a new one instead of failing forever.
            db.onclose = () => { if (dbp && dbp.db === db) dbp = null; };
            db.onversionchange = () => { try { db.close(); } catch (e) { /* closed */ } if (dbp && dbp.db === db) dbp = null; };
            resolve(db);
          };
          req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
          req.onblocked = () => reject(ijError('IJ_STORAGE_BLOCKED', 'indexedDB blocked'));
        });
        const mine = dbp;
        dbp.then((db) => { mine.db = db; }, () => { if (dbp === mine) dbp = null; });
      }
      return dbp;
    }
    // Runs `work(tx, out)` in one transaction; resolves with out.v when it commits.
    function run(stores, mode, work) {
      return open().then((db) => new Promise((resolve, reject) => {
        const out = { v: undefined };
        let tx;
        try { tx = db.transaction(stores, mode); } catch (e) { dbp = null; reject(e); return; }
        tx.oncomplete = () => resolve(out.v);
        // A failed request bubbles here while tx.error is still null: the cause (a quota
        // refusal in particular) is the error of the request that raised the event.
        tx.onerror = (ev) => reject((ev && ev.target && ev.target.error) || tx.error || new Error('transaction failed'));
        tx.onabort = () => reject(out.err || tx.error || new Error('transaction aborted'));
        try { work(tx, out); } catch (e) { try { tx.abort(); } catch (e2) { /* done */ } reject(e); }
      }));
    }
    // create = a stored document makes the session; otherwise the session must already exist
    // (a meta patch is dropped, a journal entry fails through onMissing).
    function touchSession(store, key, datasetId, patch, create, onMissing) {
      const g = store.get(key);
      g.onsuccess = () => {
        if (!g.result && !create) { if (onMissing) onMissing(); return; }
        const cur = g.result || { key, datasetId: null, savedAt: 0, meta: {} };
        cur.savedAt = Date.now();
        if (datasetId && !cur.datasetId) cur.datasetId = datasetId;
        if (patch) cur.meta = Object.assign({}, cur.meta, patch);
        store.put(cur);
      };
    }
    const range = (lo, hi) => ROOT.IDBKeyRange.bound(lo, hi);
    // Chromium refuses an IndexedDB value whose serialized size exceeds ~133 MB (measured:
    // "max=133169152 bytes"), which one 5735² 16-bit image with three channels already does.
    // A Blob is stored out of line (no such limit), so channel pixels go in as Blobs and come
    // back as typed arrays of the same type and length.
    const TYPED = { Uint8Array, Uint16Array, Float32Array };
    function toStored(snap) {
      return Object.assign({}, snap, {
        channels: snap.channels.map((c) => (c.data
          ? Object.assign({}, c, { data: null, blob: new ROOT.Blob([c.data]), dataType: c.data.constructor.name, length: c.data.length })
          : c))
      });
    }
    async function fromStored(rec) {
      if (!rec || !Array.isArray(rec.channels)) return rec;
      for (const c of rec.channels) {
        if (!c.blob) continue;
        const T = TYPED[c.dataType];
        if (!T) throw ijError('IJ_STORAGE_FAILED', 'stored channel of unknown type ' + c.dataType);
        const data = new T(await c.blob.arrayBuffer());
        if (data.length !== c.length) throw ijError('IJ_STORAGE_FAILED', 'stored channel truncated');
        c.data = data;
        delete c.blob;
      }
      return rec;
    }
    const api = {
      kind: 'indexeddb',
      putSnapshot(key, snap) {
        const stored = toStored(snap);
        return run(['sessions', 'docs', 'journal'], 'readwrite', (tx) => {
          tx.objectStore('docs').put(stored, [key, snap.docId, snap.kind]);
          if (snap.kind === 'snapshot') {
            tx.objectStore('journal').delete(range([key, snap.docId, 0], [key, snap.docId, snap.journalSeq]));
          }
          touchSession(tx.objectStore('sessions'), key, snap.provenance && snap.provenance.datasetId, null, true);
        });
      },
      putJournal(key, entry) {
        return run(['sessions', 'journal'], 'readwrite', (tx, out) => {
          tx.objectStore('journal').put(entry, [key, entry.docId, entry.seq]);
          touchSession(tx.objectStore('sessions'), key, null, null, false, () => {
            out.err = ijError('IJ_STORAGE_FAILED', 'no such session');
            tx.abort();
          });
        });
      },
      putMeta(key, patch) {
        return run(['sessions'], 'readwrite', (tx) => {
          touchSession(tx.objectStore('sessions'), key, patch && patch.datasetId, patch, false);
        });
      },
      // Every row says which documents are really stored (docs records [key, docId, kind]),
      // so a session without a restorable document is never offered.
      list() {
        return run(['sessions', 'docs'], 'readonly', (tx, out) => {
          const r = tx.objectStore('sessions').getAll();
          r.onsuccess = () => {
            const rows = r.result.map((s) => ({ key: s.key, datasetId: s.datasetId, savedAt: s.savedAt, meta: s.meta || {}, docCount: 0, docIds: [] }));
            out.v = rows;
            for (const row of rows) {
              const k = tx.objectStore('docs').getAllKeys(range([row.key], [row.key, []]));
              k.onsuccess = () => {
                const ids = new Set();
                for (const key of k.result) ids.add(key[1]);
                row.docIds = [...ids];
                row.docCount = ids.size;
              };
            }
          };
        });
      },
      async load(key, what) {
        const v = await api.loadRaw(key, what);
        if (v) for (const id of Object.keys(v.docs)) { await fromStored(v.docs[id].baseline); await fromStored(v.docs[id].snapshot); }
        return v;
      },
      loadRaw(key, what) {
        const parts = (what && what.parts) || ['baseline', 'snapshot', 'journal'];
        return run(['sessions', 'docs', 'journal'], 'readonly', (tx, out) => {
          const sg = tx.objectStore('sessions').get(key);
          const dr = what && what.docId
            ? range([key, what.docId], [key, what.docId, []])
            : range([key], [key, []]);
          const docsReq = parts.includes('baseline') || parts.includes('snapshot') ? tx.objectStore('docs').getAll(dr) : null;
          const jReq = parts.includes('journal') ? tx.objectStore('journal').getAll(dr) : null;
          // run() resolves on tx.oncomplete with out.v: never replace that handler here.
          const done = () => {
            const s = sg.result;
            if (!s) { out.v = null; return; }
            const docs = {};
            const slot = (id) => docs[id] || (docs[id] = { baseline: null, snapshot: null, journal: [] });
            if (docsReq) for (const r of docsReq.result) if (parts.includes(r.kind)) slot(r.docId)[r.kind] = r;
            if (jReq) for (const e of jReq.result) slot(e.docId).journal.push(e);
            for (const id of Object.keys(docs)) docs[id].journal.sort((a, b) => a.seq - b.seq);
            out.v = { key: s.key, datasetId: s.datasetId, savedAt: s.savedAt, meta: s.meta || {}, docs };
          };
          // Every request of a transaction completes before it commits; assemble on the last.
          let pending = 1 + (docsReq ? 1 : 0) + (jReq ? 1 : 0);
          const tick = () => { if (--pending === 0) done(); };
          sg.onsuccess = tick;
          if (docsReq) docsReq.onsuccess = tick;
          if (jReq) jReq.onsuccess = tick;
        });
      },
      discard(key, what) {
        return run(['sessions', 'docs', 'journal'], 'readwrite', (tx) => {
          const sessions = tx.objectStore('sessions');
          if (what && what.docId) {
            tx.objectStore('docs').delete(range([key, what.docId], [key, what.docId, []]));
            tx.objectStore('journal').delete(range([key, what.docId], [key, what.docId, []]));
            const g = sessions.get(key);
            g.onsuccess = () => {
              const s = g.result;
              if (!s) return;
              if (s.meta && s.meta.docs) delete s.meta.docs[what.docId];
              if (s.meta && s.meta.display) delete s.meta.display[what.docId];
              const left = tx.objectStore('docs').count(range([key], [key, []]));
              left.onsuccess = () => { if (left.result === 0) sessions.delete(key); else sessions.put(s); };
            };
          } else {
            tx.objectStore('docs').delete(range([key], [key, []]));
            tx.objectStore('journal').delete(range([key], [key, []]));
            sessions.delete(key);
          }
        });
      },
      async estimate() {
        const nav = ROOT.navigator;
        if (nav && nav.storage && nav.storage.estimate) {
          const e = await nav.storage.estimate();
          return { usage: e.usage || 0, quota: e.quota || null };
        }
        return { usage: 0, quota: null };
      }
    };
    return api;
  }

  function storageErrorCode(err) {
    const n = err && (err.name || err.code);
    if (n === 'QuotaExceededError' || n === 'IJ_STORAGE_QUOTA') return 'IJ_STORAGE_QUOTA';
    return 'IJ_STORAGE_FAILED';
  }

  // ---------------------------------------------------------------------------
  // The engine
  // ---------------------------------------------------------------------------

  function createEngine(self, opts) {
    const budgetBytes = opts.budgetBytes > 0 ? opts.budgetBytes : defaultBudget(self && self.navigator);
    const sliceMs = opts.sliceMs > 0 ? opts.sliceMs : SLICE_MS;
    const idleMs = opts.idleMs >= 0 ? opts.idleMs : IDLE_MS;
    // First band size (pixels) and whether it adapts to the measured speed; tests pin both.
    const bandPixels = opts.bandPixels > 0 ? opts.bandPixels : 262144;
    const adaptive = opts.adaptive !== false;
    const docs = new Map();
    const tasks = new Map();
    const projects = new Map();
    const sessions = new Map();
    const latestPreview = new Map();
    const tiles = { map: new Map(), bytes: 0 };
    const yielder = makeYielder();
    let transientBytes = 0;
    let idCounter = 0;
    // Retry of a failed storage write: 3 s, then 10 s, then every 30 s while anything is unprotected.
    const retryDelays = Array.isArray(opts.retryMs) ? opts.retryMs : [3000, 10000, 30000];
    let retryTimer = null;
    let retryCount = 0;
    let idleTimer = null;
    let disposed = false;
    let activeSessionKey = null;
    let queue = Promise.resolve();
    let storage = null;
    let storageOn = false;

    // ---- messaging ---------------------------------------------------------

    function post(msg, transfer) {
      if (disposed) return;
      if (transfer && transfer.length) self.postMessage(msg, transfer);
      else self.postMessage(msg);
    }

    function emitBudget() {
      post({ event: 'budget', usedBytes: usedBytes(), budgetBytes });
    }

    function emitStorageError(code, docId) {
      post({ event: 'storageError', code, docId: docId || null });
    }

    // ---- storage queue ------------------------------------------------------

    function setupStorage() {
      const want = opts.storage === undefined ? 'indexeddb' : opts.storage;
      if (want && typeof want === 'object') { storage = want; storageOn = true; return; }
      if (want === 'memory') { storage = createMemoryStorage(); storageOn = true; return; }
      if (want === 'indexeddb' && ROOT.indexedDB && ROOT.IDBKeyRange) {
        storage = createIndexedDbStorage(ROOT.indexedDB);
        storageOn = true;
        return;
      }
      storage = null;
      storageOn = false;
    }

    // Serial queue: a journal entry can never overtake the snapshot it follows.
    function enqueue(job, doc) {
      const p = queue.then(job).then(() => true, (err) => {
        const code = storageErrorCode(err);
        if (doc) {
          doc.protected = false; doc.dirty = true;
          // Whatever was being written is not in storage: a later snapshot may only vouch for
          // the document once it covers this revision.
          doc.unjournaledRev = doc.rev;
        }
        console.error('[IJEngine] storage write failed', err);
        emitStorageError(code, doc ? doc.id : null);
        if (doc) scheduleRetry();
        return false;
      });
      queue = p;
      return p;
    }

    // A write that failed is tried again with a back-off (a quota or IndexedDB error is often
    // transient: another tab freed space, the connection was reopened). Nothing else would
    // re-arm the idle timer once the operator stops editing.
    function scheduleRetry() {
      if (!storageOn || disposed || retryTimer) return;
      const delay = retryDelays[Math.min(retryCount, retryDelays.length - 1)];
      retryCount++;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        let again = false;
        for (const d of docs.values()) {
          if (!d.baselineStored && d.pendingBaseline) { storeBaseline(d); again = true; }
          if (d.dirty || !d.protected) { snapshotNow(d); again = true; }
        }
        if (!again) retryCount = 0;
      }, delay);
      if (retryTimer && retryTimer.unref) retryTimer.unref();
    }

    // ---- budget -------------------------------------------------------------

    function usedBytes() {
      const seen = new Set();
      let total = 0;
      const add = (a) => { if (a && !seen.has(a)) { seen.add(a); total += a.byteLength; } };
      const addRec = (r) => {
        if (r.patches) for (const p of r.patches) add(p.data);
        if (r.full) for (const c of r.full.channels) add(c.data);
      };
      for (const d of docs.values()) {
        for (const c of d.channels) add(c.data);
        for (const r of d.undo) addRec(r);
        for (const r of d.redo) addRec(r);
        if (d.baselineData) for (const a of d.baselineData) add(a);
      }
      for (const t of tiles.map.values()) add(t.img.data);
      for (const p of projects.values()) total += p.estimate;
      return total + transientBytes;
    }

    function recBytes(r) {
      let n = 0;
      if (r.patches) for (const p of r.patches) n += p.data.byteLength;
      if (r.full) for (const c of r.full.channels) n += c.data.byteLength;
      return n;
    }

    function dropTiles() {
      tiles.map.clear();
      tiles.bytes = 0;
    }

    function purgeTiles(docId) {
      for (const [k, t] of tiles.map) {
        if (t.docId === docId) { tiles.map.delete(k); tiles.bytes -= t.img.data.byteLength; }
      }
    }

    // Free `extra` bytes of headroom: tile cache first, then the oldest undo/redo
    // steps of any document. Refuses (IJ_OVER_BUDGET) without touching anything when
    // even that would not be enough.
    function reclaimableBytes() {
      let reclaimable = tiles.bytes;
      for (const d of docs.values()) {
        for (const r of d.undo) reclaimable += r.bytes;
        for (const r of d.redo) reclaimable += r.bytes;
      }
      return reclaimable;
    }

    // Would `extra` bytes fit once the tile cache and every undo step were given up? (No side effect.)
    function couldFit(extra) {
      return usedBytes() - reclaimableBytes() + extra <= budgetBytes;
    }

    // Room for something that is not worth an undo step (a TIFF export): only the tile cache
    // gives way, everything else refuses.
    function ensureRoomNoEvict(extra) {
      if (usedBytes() + extra <= budgetBytes) return;
      dropTiles();
      if (usedBytes() + extra > budgetBytes) {
        throw ijError('IJ_OVER_BUDGET', 'not enough memory for this operation', { needBytes: extra, usedBytes: usedBytes(), budgetBytes });
      }
    }

    function ensureRoom(extra) {
      if (usedBytes() + extra <= budgetBytes) return;
      const reclaimable = reclaimableBytes();
      const used = usedBytes();
      if (used - reclaimable + extra > budgetBytes) {
        throw ijError('IJ_OVER_BUDGET', 'not enough memory for this operation', { needBytes: extra, usedBytes: used, budgetBytes });
      }
      dropTiles();
      while (usedBytes() + extra > budgetBytes) {
        let best = null;
        for (const d of docs.values()) {
          for (const stack of [d.undo, d.redo]) {
            if (stack.length && (!best || stack[0].at < best.stack[0].at)) best = { stack, doc: d };
          }
        }
        if (!best) break;
        best.stack.shift();
      }
      if (usedBytes() + extra > budgetBytes) {
        throw ijError('IJ_OVER_BUDGET', 'not enough memory for this operation', { needBytes: extra, usedBytes: usedBytes(), budgetBytes });
      }
    }

    // ---- tasks (cancel + slicing) -----------------------------------------------

    function makeTask(id) {
      const t = {
        id,
        cancelled: false,
        lastYield: now(),
        check() { if (t.cancelled) throw ijError('IJ_CANCELLED', 'cancelled'); },
        async tick(fraction, stepKey, detail) {
          t.check();
          if (now() - t.lastYield >= sliceMs) {
            if (id != null) post({ event: 'progress', id, fraction, stepKey, detail: detail || null });
            await yielder.run();
            t.lastYield = now();
            t.check();
          }
        }
      };
      return t;
    }

    // ---- display defaults -------------------------------------------------------

    function dataRange(data) {
      const IJImage = ROOT.IJImage;
      if (IJImage && IJImage.dataRange) return IJImage.dataRange(data);
      let min = Infinity, max = -Infinity;
      for (let i = 0; i < data.length; i++) { const v = data[i]; if (v === v) { if (v < min) min = v; if (v > max) max = v; } }
      return min > max ? { min: 0, max: 0 } : { min, max };
    }

    function defaultDisplay(ch, bd) {
      let d = null;
      try { d = dep('IJImage').defaultDisplay(ch, bd); } catch (e) { d = null; }
      if (!d || !(d.max >= d.min)) {
        d = bd === 8 ? { min: 0, max: 255 } : dataRange(ch.data);
      }
      return { min: d.min, max: d.max, lut: d.lut == null ? null : d.lut, invert: !!d.invert };
    }

    function makeChannel(name, color, data, bd, display) {
      const ch = { name: name || '', color: color || '#ffffff', data };
      if (display) ch.display = Object.assign({}, display);
      else {
        ch.display = defaultDisplay(ch, bd);
        // A new channel shows in its own colour, as IJImage.create does.
        try { ch.display.lut = dep('IJLuts').forColor(ch.color); } catch (e) { /* keeps the default LUT */ }
      }
      return ch;
    }

    function newId() {
      idCounter++;
      return 'd' + Date.now().toString(36).slice(-5) + Math.floor(Math.random() * 1679616).toString(36) + idCounter.toString(36);
    }

    // ---- sessions and documents ----------------------------------------------------

    function sessionOf(key, datasetId) {
      let s = sessions.get(key);
      if (!s) {
        s = { key, datasetId: datasetId || null, docs: {}, display: {}, ui: null, metaQueued: false };
        sessions.set(key, s);
      }
      if (datasetId && !s.datasetId) s.datasetId = datasetId;
      return s;
    }

    function displayStateOf(doc) {
      return {
        mode: doc.mode, active: doc.active, visible: doc.visible.slice(),
        channels: doc.channels.map((c) => ({ min: c.display.min, max: c.display.max, lut: c.display.lut, invert: c.display.invert }))
      };
    }

    function markMeta(doc) {
      if (!storageOn) return;
      const s = sessions.get(doc.sessionKey);
      if (!s) return;
      s.docs[doc.id] = { name: doc.name, rev: doc.rev, saved: doc.savedRev === doc.rev };
      s.display[doc.id] = displayStateOf(doc);
      if (s.metaQueued) return;
      s.metaQueued = true;
      enqueue(async () => {
        s.metaQueued = false;
        await storage.putMeta(s.key, { datasetId: s.datasetId, docs: plainClone(s.docs), display: plainClone(s.display) });
      }, null);
    }

    function buildDoc(p) {
      const n = p.channels.length;
      return {
        id: p.id, sessionKey: p.sessionKey, name: p.name, width: p.width, height: p.height, bitDepth: p.bitDepth,
        channels: p.channels, calibration: p.calibration, provenance: p.provenance || {},
        rev: p.rev || 0, savedRev: p.savedRev == null ? -1 : p.savedRev,
        mode: (p.display && p.display.mode) || (n > 1 ? 'composite' : 'gray'),
        active: (p.display && p.display.active) || 0,
        visible: (p.display && p.display.visible) || new Array(n).fill(true),
        undo: [], redo: [], chain: Promise.resolve(),
        baselineSet: new WeakSet(), baselineData: null, baselineShape: null, baselineStored: false,
        journalSeq: p.journalSeq || 0, snapshotRev: 0, dirty: false, protected: storageOn,
        unjournaledRev: -1, pendingBaseline: null,
        rangeCache: null
      };
    }

    function sessionKeyFor(provenance, id) {
      return (provenance && provenance.sessionKey) || ('local:' + id);
    }

    function registerDoc(doc, o) {
      docs.set(doc.id, doc);
      const s = sessionOf(doc.sessionKey, doc.provenance && doc.provenance.datasetId);
      activeSessionKey = doc.sessionKey;
      if (o && o.baseline) writeBaseline(doc);
      markMeta(doc);
      scheduleIdle();
      return s;
    }

    function recordOf(doc, kind) {
      const same = kind === 'snapshot' && doc.baselineStored && doc.baselineShape &&
        doc.baselineShape.w === doc.width && doc.baselineShape.h === doc.height && doc.baselineShape.bd === doc.bitDepth;
      return {
        kind, docId: doc.id, rev: doc.rev, journalSeq: doc.journalSeq, savedRev: doc.savedRev,
        name: doc.name, width: doc.width, height: doc.height, bitDepth: doc.bitDepth,
        calibration: plainClone(doc.calibration), provenance: plainClone(doc.provenance),
        display: displayStateOf(doc),
        channels: doc.channels.map((c) => ({
          name: c.name, color: c.color, display: Object.assign({}, c.display),
          sameAsBaseline: !!(same && doc.baselineSet.has(c.data)),
          data: (same && doc.baselineSet.has(c.data)) ? null : c.data
        }))
      };
    }

    function recDataBytes(rec) {
      let n = 0;
      for (const c of rec.channels) if (c.data) n += c.data.byteLength;
      return n;
    }

    function writeBaseline(doc) {
      doc.baselineSet = new WeakSet(doc.channels.map((c) => c.data));
      doc.baselineShape = { w: doc.width, h: doc.height, bd: doc.bitDepth };
      doc.baselineData = doc.channels.map((c) => c.data);
      doc.baselineDisplays = doc.channels.map((c) => Object.assign({}, c.display));
      doc.baselineCal = plainClone(doc.calibration);
      doc.baselineStored = false;
      if (!storageOn) { doc.protected = false; return; }
      // Built once: a failed write is retried with this very record (the loaded image), never
      // with a baseline rebuilt from a later state.
      const rec = recordOf(doc, 'baseline');
      doc.pendingBaseline = { rec, bytes: recDataBytes(rec) };
      storeBaseline(doc);
    }

    function storeBaseline(doc) {
      const pb = doc.pendingBaseline;
      if (!pb || !storageOn) return;
      enqueue(async () => {
        if (doc.baselineStored) return;
        transientBytes += pb.bytes;
        try { await storage.putSnapshot(doc.sessionKey, pb.rec); } finally { transientBytes -= pb.bytes; }
        doc.baselineStored = true;
        doc.baselineData = null;
        doc.pendingBaseline = null;
        doc.protected = true;
        post({ event: 'saved', at: Date.now(), docId: doc.id });
        // The session now exists: its meta (document list, display state) can be written.
        if (docs.has(doc.id)) markMeta(doc);
      }, doc);
    }

    // Capture NOW (arrays are immutable, so the references stay valid), write later.
    // `force`: the document has just left `docs` (doc.close keeps it for later) but its last
    // state still has to be written.
    function snapshotNow(doc, force) {
      if (!storageOn || (!force && !docs.has(doc.id))) return queue;
      const rec = recordOf(doc, 'snapshot');
      const bytes = recDataBytes(rec);
      doc.snapshotRev = doc.rev;
      doc.dirty = false;
      for (const r of doc.undo) r.replayable = false;
      for (const r of doc.redo) r.replayable = false;
      return enqueue(async () => {
        transientBytes += bytes;
        try { await storage.putSnapshot(doc.sessionKey, rec); } finally { transientBytes -= bytes; }
        // Stored state + journal restores the document only when no commit after the snapshot
        // went unjournaled (a journal write that failed while the doc was unprotected).
        if (rec.rev >= doc.unjournaledRev) doc.protected = true;
        else { doc.dirty = true; scheduleIdle(); }
        post({ event: 'saved', at: Date.now(), docId: doc.id });
      }, doc);
    }

    function scheduleIdle() {
      if (!storageOn || disposed) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        for (const d of docs.values()) if (d.dirty) snapshotNow(d);
      }, idleMs);
    }

    function flushAll() {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      for (const d of docs.values()) {
        if (!d.baselineStored && d.pendingBaseline) storeBaseline(d);
        if (d.dirty || !d.protected) snapshotNow(d);
      }
      return queue;
    }

    // Documents the stored state cannot restore as they are now (after a flush: the ones whose
    // write failed). Used to tell the page that "keep for later" did not keep anything.
    function unsafeDocs() {
      return [...docs.values()].filter((d) => d.dirty || !d.protected || (d.pendingBaseline && !d.baselineStored)).map((d) => d.id);
    }

    function noteCommit(doc, entry) {
      doc.dirty = true;
      doc.journalSeq++;
      if (entry && storageOn && doc.protected) {
        entry.docId = doc.id;
        entry.seq = doc.journalSeq;
        entry.at = Date.now();
        entry.rev = doc.rev;
        enqueue(async () => {
          if (!doc.protected) { doc.unjournaledRev = Math.max(doc.unjournaledRev, entry.rev); return; }
          await storage.putJournal(doc.sessionKey, entry);
        }, doc);
      } else if (storageOn) {
        doc.unjournaledRev = doc.rev;
      }
      markMeta(doc);
      scheduleIdle();
    }

    function infoOf(doc) {
      let bytes = 0;
      for (const c of doc.channels) bytes += c.data.byteLength;
      return {
        docId: doc.id, name: doc.name, width: doc.width, height: doc.height, bitDepth: doc.bitDepth, rev: doc.rev,
        channels: doc.channels.map((c) => ({ name: c.name, color: c.color, display: Object.assign({}, c.display) })),
        calibration: doc.calibration, provenance: doc.provenance,
        mode: doc.mode, active: doc.active, visible: doc.visible.slice(),
        undoDepth: doc.undo.length, redoDepth: doc.redo.length,
        bytes, levels: levelCount(doc.width, doc.height), tileSize: TILE,
        unsaved: doc.savedRev !== doc.rev, protected: !!(storageOn && doc.protected),
        loading: false, memory: { usedBytes: usedBytes(), budgetBytes }
      };
    }

    function getDoc(id) {
      const d = docs.get(id);
      if (!d) throw ijError('IJ_NO_DOC', 'no such document');
      return d;
    }

    function getChannel(doc, c) {
      if (!isInt(c) || c < 0 || c >= doc.channels.length) throw ijError('IJ_BAD_ARGS', 'channel');
      return doc.channels[c];
    }

    function channelImage(doc, c) {
      return chImg(doc.width, doc.height, doc.bitDepth, getChannel(doc, c).data);
    }

    // ---- ROI -----------------------------------------------------------------------

    // Mask box clipped to the image; null for "whole image" (no ROI / line / point).
    function roiMask(roi, W, H) {
      if (!roi) return null;
      const IJRoi = dep('IJRoi');
      IJRoi.validate(roi);
      if (!IJRoi.isArea(roi)) return null;
      const box = IJRoi.mask(roi, W, H);
      return clipBox(box, W, H);
    }

    function clipBox(box, W, H) {
      const x0 = Math.max(0, box.x), y0 = Math.max(0, box.y);
      const x1 = Math.min(W, box.x + box.w), y1 = Math.min(H, box.y + box.h);
      if (!(x1 > x0) || !(y1 > y0)) throw ijError('IJ_EMPTY_ROI', 'the selection is outside the image');
      if (x0 === box.x && y0 === box.y && x1 === box.x + box.w && y1 === box.y + box.h) return box;
      const w = x1 - x0, h = y1 - y0;
      const data = new Uint8Array(w * h);
      for (let r = 0; r < h; r++) {
        const o = (y0 + r - box.y) * box.w + (x0 - box.x);
        data.set(box.data.subarray(o, o + w), r * w);
      }
      return { x: x0, y: y0, w, h, data };
    }

    function boundsOf(maskBox, W, H) {
      return maskBox ? { x: maskBox.x, y: maskBox.y, w: maskBox.w, h: maskBox.h } : { x: 0, y: 0, w: W, h: H };
    }

    // ---- pixel operations -----------------------------------------------------------
    //
    // A pixel operation maps one channel to a new channel of the same size; only the
    // pixels of the selection (or, for Clear Outside, the pixels outside it) change.
    // `prepare` returns { fn(src) or region(full, rect), apron: {x,y} } — fn works on a
    // crop that already carries `apron` extra pixels, region reads the full channel.

    function rangeOf(doc, c) {
      const key = doc.rev + ':' + c;
      if (!doc.rangeCache || doc.rangeCache.key !== key) {
        doc.rangeCache = { key, r: dataRange(doc.channels[c].data) };
      }
      return doc.rangeCache.r;
    }

    function needNumber(v, what) {
      if (typeof v !== 'number' || !isFinite(v)) throw ijError('IJ_BAD_ARGS', what);
      return v;
    }

    function calOf(doc) {
      const c = doc.calibration || {};
      return { pw: c.pixelWidth > 0 ? c.pixelWidth : 1, ph: c.pixelHeight > 0 ? c.pixelHeight : 1 };
    }

    const PIXEL_OPS = {
      invert: {
        prepare(doc, c) {
          if (doc.bitDepth === 32) {
            // ImageJ inverts a float image about the data range: v' = max + min - v.
            const r = rangeOf(doc, c);
            const s = r.max + r.min;
            return { apron: { x: 0, y: 0 }, fn(src) { const d = src.data, o = new Float32Array(d.length); for (let i = 0; i < d.length; i++) o[i] = s - d[i]; return o; } };
          }
          return { apron: { x: 0, y: 0 }, fn: (src) => dep('IJOps').invert(src) };
        }
      },
      math: {
        prepare(doc, c, p) {
          if (typeof p.op !== 'string') throw ijError('IJ_BAD_ARGS', 'math op');
          if (p.op !== 'abs') needNumber(p.value, 'math value');
          return { apron: { x: 0, y: 0 }, fn: (src) => dep('IJOps').math(src, p.op, p.value, null) };
        }
      },
      fill: {
        prepare(doc, c, p) { needNumber(p.value, 'fill value'); return { apron: { x: 0, y: 0 }, fn: (src) => dep('IJOps').fill(src, null, p.value) }; }
      },
      clear: {
        prepare(doc, c, p) { needNumber(p.value, 'clear value'); return { apron: { x: 0, y: 0 }, fn: (src) => dep('IJOps').clear(src, null, p.value) }; }
      },
      clearOutside: {
        outside: true, needsRoi: true,
        prepare(doc, c, p) { needNumber(p.value, 'clear value'); return { apron: { x: 0, y: 0 }, fn: (src) => dep('IJOps').fill(src, null, p.value) }; }
      },
      applyLut: {
        display: true,
        prepare(doc, c, p) {
          const r = p.ranges && p.ranges[c];
          if (!r) throw ijError('IJ_BAD_ARGS', 'applyLut range');
          return { apron: { x: 0, y: 0 }, fn: (src) => dep('IJOps').applyLut(src, r.min, r.max) };
        }
      },
      gaussian: {
        scalable: true,
        prepare(doc, c, p, o) {
          const IJFilters = dep('IJFilters');
          const sigma = needNumber(p.sigma, 'sigma');
          if (!(sigma > 0)) throw ijError('IJ_BAD_ARGS', 'sigma');
          const cal = calOf(doc);
          const s = (o && o.scale) || 1;
          const sx = (p.scaled ? sigma / cal.pw : sigma) / s;
          const sy = (p.scaled ? sigma / cal.ph : sigma) / s;
          const accuracy = doc.bitDepth === 8 ? 0.002 : 0.0002;
          return {
            apron: { x: IJFilters.gaussianApron(sx, accuracy, doc.bitDepth), y: IJFilters.gaussianApron(sy, accuracy, doc.bitDepth) },
            region: (full, r) => IJFilters.gaussian(full, sx, sy, { accuracy, region: { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h } })
          };
        }
      },
      rank: {
        scalable: true,
        prepare(doc, c, p, o) {
          const IJFilters = dep('IJFilters');
          const type = String(p.type || '').toLowerCase();
          if (!['median', 'mean', 'min', 'max'].includes(type)) throw ijError('IJ_BAD_ARGS', 'rank type');
          const s = (o && o.scale) || 1;
          const radius = needNumber(p.radius, 'radius') / s;
          if (!(radius >= 0)) throw ijError('IJ_BAD_ARGS', 'radius');
          return {
            apron: { x: IJFilters.rankApron(radius), y: IJFilters.rankApron(radius) },
            region: (full, r) => IJFilters.rank(full, radius, type, { region: { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h } })
          };
        }
      },
      binary: {
        prepare(doc, c, p) {
          if (doc.bitDepth !== 8) throw ijError('IJ_NOT_BINARY', 'binary operations need an 8-bit mask');
          const IJBinary = dep('IJBinary');
          const op = p.op;
          if (!['erode', 'dilate', 'open', 'close', 'fillHoles', 'outline'].includes(op)) throw ijError('IJ_BAD_ARGS', 'binary op');
          const o = { iterations: p.iterations > 0 ? Math.floor(p.iterations) : 1, count: p.count > 0 ? Math.floor(p.count) : 1 };
          // Rows a result pixel depends on: erode/dilate 1 per iteration, open/close
          // twice that, outline 1. fillHoles is a global flood fill: one whole band.
          const reach = op === 'fillHoles' ? 0 : (op === 'open' || op === 'close' ? 2 * o.iterations : (op === 'outline' ? 1 : o.iterations));
          return { whole: op === 'fillHoles', apron: { x: reach, y: reach }, fn: (src) => IJBinary[op](src, o) };
        }
      },
      flipH: { whole: true, prepare() { return { whole: true, apron: { x: 0, y: 0 }, fn: (src) => dep('IJOps').flipH(src) }; } },
      flipV: { whole: true, prepare() { return { whole: true, apron: { x: 0, y: 0 }, fn: (src) => dep('IJOps').flipV(src) }; } }
    };

    // One channel through one pixel operation, in bands. Returns the new array.
    //   old     the channel as it is
    //   reg     bounds {x,y,w,h} of what may change
    //   mask    mask box or null; outside = modify the pixels NOT in the mask
    //   prog    (fraction in this channel) → overall fraction callback
    async function pixelPass(task, W, H, bd, old, prep, mask, reg, outside, prog, stepKey) {
      const out = old.slice();
      const ax = prep.apron ? prep.apron.x : 0, ay = prep.apron ? prep.apron.y : 0;
      const full = prep.region ? chImg(W, H, bd, old) : null;
      const yEnd = reg.y + reg.h;
      let rows = prep.whole ? reg.h : Math.max(1, Math.min(reg.h, Math.floor(bandPixels / Math.max(1, reg.w))));
      const maxRows = Math.max(1, Math.floor(MAX_BAND_PIXELS / Math.max(1, reg.w + 2 * ax)));
      let y = reg.y;
      while (y < yEnd) {
        const t0 = now();
        const y1 = Math.min(yEnd, y + rows);
        let res, rx, ry, rw;
        if (prep.region) {
          const rect = { x: reg.x, y, w: reg.w, h: y1 - y };
          const r = prep.region(full, rect);
          rx = reg.x; ry = y; rw = rect.w;
          res = unwrap(r, rect.w * rect.h);
        } else {
          const sx = Math.max(0, reg.x - ax), sx1 = Math.min(W, reg.x + reg.w + ax);
          const sy = Math.max(0, y - ay), sy1 = Math.min(H, y1 + ay);
          const sw = sx1 - sx, sh = sy1 - sy;
          const src = chImg(sw, sh, bd, copyRect(old, W, sx, sy, sw, sh));
          res = unwrap(prep.fn(src), sw * sh);
          rx = sx; ry = sy; rw = sw;
        }
        for (let yy = y; yy < y1; yy++) {
          const ro = (yy - ry) * rw - rx;
          const oo = yy * W;
          if (!mask) {
            out.set(res.subarray(ro + reg.x, ro + reg.x + reg.w), oo + reg.x);
            continue;
          }
          const inRow = yy >= mask.y && yy < mask.y + mask.h;
          const mo = inRow ? (yy - mask.y) * mask.w - mask.x : 0;
          const xEnd = reg.x + reg.w;
          for (let x = reg.x; x < xEnd; x++) {
            const inside = inRow && x >= mask.x && x < mask.x + mask.w && mask.data[mo + x] !== 0;
            if (inside !== outside) out[oo + x] = res[ro + x];
          }
        }
        y = y1;
        await task.tick(prog((y - reg.y) / reg.h), stepKey);
        if (!prep.whole && adaptive) {
          const dt = now() - t0;
          const f = dt > 0 ? (sliceMs / 2) / dt : 2;
          rows = Math.max(1, Math.min(maxRows, Math.floor(rows * Math.min(2, Math.max(0.25, f)))));
        }
      }
      return out;
    }

    // ---- run: operations that edit the document ---------------------------------------

    const SIZE_OPS = ['crop', 'rotate90', 'convert'];
    const NEWDOC_OPS = ['toMask', 'cropToNew'];

    function channelList(doc, channel) {
      if (channel === 'all' || channel == null) return doc.channels.map((c, i) => i);
      getChannel(doc, channel);
      return [channel];
    }

    // Fill in what an op reads from state that is not journaled (display ranges), so
    // replaying the entry gives the same pixels.
    function resolveParams(doc, op, params, chans) {
      const p = Object.assign({}, params || {});
      if (op === 'applyLut') {
        p.ranges = Object.assign({}, p.ranges);
        for (const c of chans) {
          if (!p.ranges[c]) {
            const d = doc.channels[c].display;
            p.ranges[c] = { min: p.min != null ? p.min : d.min, max: p.max != null ? p.max : d.max };
          }
        }
      } else if (op === 'convert') {
        p.ranges = Object.assign({}, p.ranges);
        doc.channels.forEach((ch, c) => {
          if (!p.ranges[c]) p.ranges[c] = { min: ch.display.min, max: ch.display.max };
        });
      }
      return p;
    }

    function newRecord(doc, op) {
      return { op, at: Date.now(), replayable: true, bytes: 0, patches: null, full: null, display: null };
    }

    // Push the undo record of a committed change; the redo stack is dead.
    function pushUndo(doc, rec) {
      rec.bytes = recBytes(rec);
      doc.undo.push(rec);
      while (doc.undo.length > MAX_UNDO) doc.undo.shift();
      doc.redo.length = 0;
    }

    function fullState(doc) {
      return {
        width: doc.width, height: doc.height, bitDepth: doc.bitDepth, calibration: plainClone(doc.calibration),
        channels: doc.channels.map((c) => ({ data: c.data, display: Object.assign({}, c.display) }))
      };
    }

    async function executeRun(doc, args, task, replay) {
      const op = args.op;
      const roi = args.roi || null;
      const W = doc.width, H = doc.height, bd = doc.bitDepth;
      if (NEWDOC_OPS.includes(op)) return runNewDoc(doc, args, task, replay);
      if (SIZE_OPS.includes(op)) return runSize(doc, args, task, replay);
      const spec = PIXEL_OPS[op];
      if (!spec) throw ijError('IJ_UNKNOWN_OP', 'unknown operation');
      const chans = channelList(doc, args.channel);
      const params = resolveParams(doc, op, args.params, chans);
      let mask = roiMask(roi, W, H);
      if (spec.needsRoi && !mask) throw ijError('IJ_NEEDS_ROI', 'this operation needs an area selection');
      const outside = !!spec.outside;
      const reg = outside ? { x: 0, y: 0, w: W, h: H } : boundsOf(mask, W, H);
      const fullReg = reg.x === 0 && reg.y === 0 && reg.w === W && reg.h === H;
      const chBytes = W * H * (bd / 8);
      const patchBytes = fullReg ? 0 : reg.w * reg.h * (bd / 8);
      const preps = chans.map((c) => spec.prepare(doc, c, params, null));
      const need = chans.length * (chBytes + patchBytes);
      ensureRoom(need);
      // Reserved while the operation runs, so an operation on another document sees the
      // headroom this one is about to take; released at commit (the new arrays are counted then).
      transientBytes += need;
      const outs = [];
      try {
        for (let i = 0; i < chans.length; i++) {
          const base = i / chans.length, span = 1 / chans.length;
          const out = await pixelPass(task, W, H, bd, doc.channels[chans[i]].data, preps[i], mask, reg, outside,
            (f) => base + span * f, 'op.' + op);
          outs.push(out);
        }
        task.check();
      } finally { transientBytes -= need; }
      // Commit (synchronous: nothing can interleave from here on).
      const rec = newRecord(doc, op);
      rec.patches = chans.map((c) => ({
        c, rect: Object.assign({}, reg),
        data: fullReg ? doc.channels[c].data : copyRect(doc.channels[c].data, W, reg.x, reg.y, reg.w, reg.h)
      }));
      if (spec.display) {
        rec.display = {};
        for (const c of chans) rec.display[c] = Object.assign({}, doc.channels[c].display);
      }
      chans.forEach((c, i) => {
        const ch = doc.channels[c];
        ch.data = outs[i];
        if (spec.display) ch.display = defaultDisplay(ch, bd);
      });
      pushUndo(doc, rec);
      doc.rev++;
      purgeTiles(doc.id);
      if (!replay) noteCommit(doc, { kind: 'run', op, params, roi, channel: args.channel == null ? 'all' : args.channel });
      else doc.journalSeq++;
      return { changed: { channels: chans, sizeChanged: false }, newDocIds: [] };
    }

    async function runSize(doc, args, task, replay) {
      const op = args.op;
      const W = doc.width, H = doc.height, bd = doc.bitDepth;
      const IJOps = dep('IJOps');
      const all = doc.channels.map((c, i) => i);
      const params = resolveParams(doc, op, args.params, all);
      let newW = W, newH = H, newBd = bd;
      let cropBox = null;
      if (op === 'crop') {
        cropBox = cropRect(doc, params, args.roi);
        newW = cropBox.w; newH = cropBox.h;
      } else if (op === 'rotate90') {
        newW = H; newH = W;
      } else if (op === 'convert') {
        newBd = params.bitDepth;
        if (![8, 16, 32].includes(newBd)) throw ijError('IJ_BAD_ARGS', 'bitDepth');
        if (newBd === bd) return { changed: { channels: [], sizeChanged: false }, newDocIds: [], noop: true };
      }
      const need = all.length * newW * newH * (newBd / 8);
      ensureRoom(need);
      transientBytes += need;
      const outs = [];
      try {
        for (let i = 0; i < all.length; i++) {
          const ch = doc.channels[i];
          let data;
          if (op === 'crop') {
            data = copyRect(ch.data, W, cropBox.x, cropBox.y, cropBox.w, cropBox.h);
          } else if (op === 'rotate90') {
            data = unwrap(IJOps.rotate90(chImg(W, H, bd, ch.data), params.dir), W * H);
          } else {
            const r = params.ranges[i];
            data = unwrap(IJOps.convert(chImg(W, H, bd, ch.data), newBd, { min: r.min, max: r.max, scale: params.scale !== false }), W * H);
          }
          outs.push(data);
          await task.tick((i + 1) / all.length, 'op.' + op);
        }
        task.check();
      } finally { transientBytes -= need; }
      const rec = newRecord(doc, op);
      rec.full = fullState(doc);
      pushUndo(doc, rec);
      doc.width = newW; doc.height = newH; doc.bitDepth = newBd;
      if (op === 'rotate90' && doc.calibration) {
        const cal = Object.assign({}, doc.calibration);
        const t = cal.pixelWidth; cal.pixelWidth = cal.pixelHeight; cal.pixelHeight = t;
        doc.calibration = cal;
      }
      if (op === 'crop') {
        const pv = Object.assign({}, doc.provenance);
        const o = pv.cropOrigin || { x: 0, y: 0 };
        pv.cropOrigin = { x: o.x + cropBox.x, y: o.y + cropBox.y };
        doc.provenance = pv;
      }
      doc.channels.forEach((ch, i) => {
        ch.data = outs[i];
        if (op === 'convert') ch.display = defaultDisplay(ch, newBd);
      });
      doc.rev++;
      purgeTiles(doc.id);
      if (!replay) noteCommit(doc, { kind: 'run', op, params, roi: args.roi || null, channel: 'all' });
      else doc.journalSeq++;
      return { changed: { channels: all, sizeChanged: true }, newDocIds: [] };
    }

    function cropRect(doc, params, roi) {
      let r;
      if (params && params.w > 0 && params.h > 0) r = { x: params.x | 0, y: params.y | 0, w: params.w | 0, h: params.h | 0 };
      else if (roi) {
        const IJRoi = dep('IJRoi');
        IJRoi.validate(roi);
        r = IJRoi.bounds(roi);
      } else throw ijError('IJ_NEEDS_ROI', 'crop needs a rectangle');
      const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
      const x1 = Math.min(doc.width, Math.ceil(r.x + r.w)), y1 = Math.min(doc.height, Math.ceil(r.y + r.h));
      if (!(x1 > x0) || !(y1 > y0)) throw ijError('IJ_EMPTY_ROI', 'the selection is outside the image');
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }

    async function runNewDoc(doc, args, task, replay) {
      const op = args.op;
      const W = doc.width, H = doc.height, bd = doc.bitDepth;
      let channels, name, nbd = bd, nw, nh, provenance = Object.assign({}, doc.provenance);
      if (op === 'toMask') {
        const c = isInt(args.channel) ? args.channel : (doc.active || 0);
        const p = args.params || {};
        needNumber(p.lower, 'lower'); needNumber(p.upper, 'upper');
        ensureRoom(W * H);
        const mask = dep('IJThreshold').toMask(channelImage(doc, c), p.lower, p.upper);
        channels = [makeChannel(doc.channels[c].name, '#ffffff', unwrap(mask, W * H), 8)];
        nbd = 8; nw = W; nh = H; name = doc.name.replace(/\.[A-Za-z0-9]+$/, '') + '-mask';
      } else {
        const box = cropRect(doc, args.params, args.roi);
        const sel = (args.params && Array.isArray(args.params.channels)) ? args.params.channels : doc.channels.map((c, i) => i);
        ensureRoom(sel.length * box.w * box.h * (bd / 8));
        channels = sel.map((c) => {
          const src = getChannel(doc, c);
          return makeChannel(src.name, src.color, copyRect(src.data, W, box.x, box.y, box.w, box.h), bd, src.display);
        });
        nw = box.w; nh = box.h; name = (args.params && args.params.name) || (doc.name + '-crop');
        const o = provenance.cropOrigin || { x: 0, y: 0 };
        provenance.cropOrigin = { x: o.x + box.x, y: o.y + box.y };
      }
      task.check();
      const nd = buildDoc({
        id: newId(), sessionKey: doc.sessionKey, name, width: nw, height: nh, bitDepth: nbd, channels,
        calibration: plainClone(doc.calibration), provenance
      });
      registerDoc(nd, { baseline: true });
      return { changed: { channels: [], sizeChanged: false }, newDocIds: [nd.id], newInfos: [infoOf(nd)] };
    }

    // ---- undo / redo / revert ------------------------------------------------------------

    // Apply a record to the document and return the inverse record (swap semantics).
    function swapRecord(doc, rec) {
      const inv = { op: rec.op, at: Date.now(), replayable: rec.replayable, patches: null, full: null, display: null, bytes: 0 };
      if (rec.patches) {
        const W = doc.width, H = doc.height;
        inv.patches = [];
        for (const p of rec.patches) {
          const ch = doc.channels[p.c];
          const cur = ch.data;
          const isFull = p.rect.w === W && p.rect.h === H;
          let curPatch, next;
          if (isFull) { curPatch = cur; next = p.data; }
          else {
            curPatch = copyRect(cur, W, p.rect.x, p.rect.y, p.rect.w, p.rect.h);
            next = cur.slice();
            pasteRect(next, W, p.rect.x, p.rect.y, p.rect.w, p.rect.h, p.data);
          }
          ch.data = next;
          inv.patches.push({ c: p.c, rect: p.rect, data: curPatch });
        }
        if (rec.display) {
          inv.display = {};
          for (const c of Object.keys(rec.display)) {
            inv.display[c] = Object.assign({}, doc.channels[c].display);
            doc.channels[c].display = Object.assign({}, rec.display[c]);
          }
        }
      } else {
        inv.full = fullState(doc);
        const f = rec.full;
        doc.width = f.width; doc.height = f.height; doc.bitDepth = f.bitDepth;
        doc.calibration = f.calibration;
        doc.channels.forEach((ch, i) => { ch.data = f.channels[i].data; ch.display = Object.assign({}, f.channels[i].display); });
      }
      inv.bytes = recBytes(inv);
      return inv;
    }

    function swapCost(doc, rec) {
      if (!rec.patches) return 0;
      let n = 0;
      for (const p of rec.patches) {
        if (!(p.rect.w === doc.width && p.rect.h === doc.height)) n += doc.channels[p.c].data.byteLength + p.data.byteLength;
      }
      return n;
    }

    function changedOf(rec, beforeSize, doc) {
      const sizeChanged = !!rec.full;
      const channels = sizeChanged ? doc.channels.map((c, i) => i) : rec.patches.map((p) => p.c);
      return { channels, sizeChanged };
    }

    async function doUndoRedo(doc, which, replay) {
      const from = which === 'undo' ? doc.undo : doc.redo;
      const to = which === 'undo' ? doc.redo : doc.undo;
      if (!from.length) throw ijError('IJ_NOTHING_TO_UNDO', 'nothing to ' + which);
      // Out of the stack while room is made, so the step being applied is never the one evicted.
      const top = from.pop();
      try { ensureRoom(swapCost(doc, top) + top.bytes); } catch (e) { from.push(top); throw e; }
      const inv = swapRecord(doc, top);
      to.push(inv);
      doc.rev++;
      purgeTiles(doc.id);
      const changed = changedOf(top, null, doc);
      if (replay) { doc.journalSeq++; return changed; }
      if (top.replayable && storageOn && doc.protected) noteCommit(doc, { kind: which });
      else {
        noteCommit(doc, null);
        if (storageOn) snapshotNow(doc);
      }
      return changed;
    }

    async function loadBaseline(doc) {
      if (doc.baselineData && doc.baselineShape) {
        const s = doc.baselineShape;
        return { width: s.w, height: s.h, bitDepth: s.bd, arrays: doc.baselineData, rec: null };
      }
      if (!storageOn) throw ijError('IJ_NO_BASELINE', 'no baseline to revert to');
      await queue;
      const got = await storage.load(doc.sessionKey, { docId: doc.id, parts: ['baseline'] });
      const b = got && got.docs[doc.id] && got.docs[doc.id].baseline;
      if (!b) throw ijError('IJ_NO_BASELINE', 'no baseline to revert to');
      return { width: b.width, height: b.height, bitDepth: b.bitDepth, arrays: b.channels.map((c) => c.data), rec: b };
    }

    async function doRevert(doc) {
      const b = await loadBaseline(doc);
      const bytes = b.rec ? b.arrays.reduce((n, a) => n + a.byteLength, 0) : 0;
      ensureRoom(bytes);
      const cal = b.rec ? plainClone(b.rec.calibration) : plainClone(doc.baselineCal);
      const synthetic = {
        op: 'revert', replayable: false,
        full: {
          width: b.width, height: b.height, bitDepth: b.bitDepth, calibration: cal,
          channels: b.arrays.map((a, i) => ({
            data: a,
            display: b.rec ? Object.assign({}, b.rec.channels[i].display) : Object.assign({}, doc.baselineDisplays[i])
          }))
        }
      };
      if (!b.rec && b.arrays.every((a, i) => a === doc.channels[i].data)) {
        return { changed: { channels: [], sizeChanged: false }, noop: true };
      }
      const inv = swapRecord(doc, synthetic);
      inv.replayable = false;
      for (const a of b.arrays) doc.baselineSet.add(a);
      doc.undo.push(inv);
      doc.redo.length = 0;
      doc.rev++;
      purgeTiles(doc.id);
      noteCommit(doc, null);
      if (storageOn) snapshotNow(doc);
      return { changed: { channels: doc.channels.map((c, i) => i), sizeChanged: true } };
    }

    // ---- tile pyramid --------------------------------------------------------------------------

    function levelImage(doc, c, level) {
      if (level === 0) return chImg(doc.width, doc.height, doc.bitDepth, doc.channels[c].data);
      const key = doc.id + ':' + c + ':' + doc.rev + ':' + level;
      const hit = tiles.map.get(key);
      if (hit) { tiles.map.delete(key); tiles.map.set(key, hit); return hit.img; }
      const prev = levelImage(doc, c, level - 1);
      const dims = levelDims(doc.width, doc.height, level);
      const img = chImg(dims.w, dims.h, doc.bitDepth, unwrap(dep('IJOps').downsample2(prev), dims.w * dims.h));
      const bytes = img.data.byteLength;
      if (usedBytes() + bytes <= budgetBytes) {
        tiles.map.set(key, { docId: doc.id, img });
        tiles.bytes += bytes;
        while (tiles.bytes > TILE_CACHE_BYTES && tiles.map.size > 1) {
          const first = tiles.map.keys().next().value;
          const t = tiles.map.get(first);
          tiles.map.delete(first);
          tiles.bytes -= t.img.data.byteLength;
        }
      }
      return img;
    }

    // ---- statistics ------------------------------------------------------------------------------

    function lineStats(doc, c, roi) {
      const IJOps = dep('IJOps'), IJRoi = dep('IJRoi');
      const cal = calOf(doc);
      const prof = IJOps.profile(channelImage(doc, c), roi, roi.width > 0 ? roi.width : 1);
      const v = prof.values;
      const n = v.length;
      let sum = 0, min = Infinity, max = -Infinity;
      for (let i = 0; i < n; i++) { sum += v[i]; if (v[i] < min) min = v[i]; if (v[i] > max) max = v[i]; }
      const mean = n ? sum / n : NaN;
      let ss = 0;
      for (let i = 0; i < n; i++) ss += (v[i] - mean) * (v[i] - mean);
      const sorted = Array.from(v).sort((a, b) => a - b);
      const median = n ? (n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : NaN;
      const dx = (roi.x2 - roi.x1) * cal.pw, dy = (roi.y2 - roi.y1) * cal.ph;
      const length = Math.sqrt(dx * dx + dy * dy);
      return {
        n, mean, min, max, median, stdDev: n > 1 ? Math.sqrt(ss / (n - 1)) : 0,
        length, angle: IJRoi.lineAngle(roi), area: length * (roi.width > 0 ? roi.width : 1) * cal.pw, intDen: sum
      };
    }

    function measureRow(doc, c, roi, keys) {
      const IJOps = dep('IJOps'), IJRoi = dep('IJRoi');
      const cal = calOf(doc);
      let row;
      if (roi && roi.type === 'line') {
        row = lineStats(doc, c, roi);
        row.bx = Math.min(roi.x1, roi.x2) * cal.pw; row.by = Math.min(roi.y1, roi.y2) * cal.ph;
        row.bw = Math.abs(roi.x2 - roi.x1) * cal.pw; row.bh = Math.abs(roi.y2 - roi.y1) * cal.ph;
      } else if (roi && roi.type === 'point') {
        IJRoi.validate(roi);
        const pts = roi.points;
        const x = Math.floor(pts[0][0]), y = Math.floor(pts[0][1]);
        if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) throw ijError('IJ_EMPTY_ROI', 'point outside the image');
        const v = doc.channels[c].data[y * doc.width + x];
        // ImageJ prints a point's X / Y: the Centroid and Center of Mass columns of its row.
        const px = pts[0][0] * cal.pw, py = pts[0][1] * cal.ph;
        row = {
          n: 1, mean: v, min: v, max: v, median: v, mode: v, stdDev: 0, area: 0, intDen: 0, rawIntDen: v,
          x: px, y: py, xCentroid: px, yCentroid: py, xCenterOfMass: px, yCenterOfMass: py
        };
      } else {
        const mask = roiMask(roi, doc.width, doc.height);
        row = Object.assign({}, IJOps.statistics(channelImage(doc, c), mask, { calibration: doc.calibration }));
        const b = boundsOf(mask, doc.width, doc.height);
        row.bx = b.x * cal.pw; row.by = b.y * cal.ph; row.bw = b.w * cal.pw; row.bh = b.h * cal.ph;
        if (roi && IJRoi.isArea(roi)) row.perim = IJRoi.perimeter(roi) * cal.pw;
      }
      if (Array.isArray(keys) && keys.length) {
        const out = {};
        for (const k of keys) if (k in row) out[k] = row[k];
        return out;
      }
      return row;
    }

    // ---- commands ----------------------------------------------------------------------------------

    function lockDoc(doc, fn) {
      const p = doc.chain.then(fn);
      doc.chain = p.then(() => undefined, () => undefined);
      return p;
    }

    function finishMutation() { emitBudget(); }

    function addDocFromImage(img, provenance, sessionKey) {
      const id = newId();
      const bd = img.bitDepth;
      const chans = img.channels.map((c) => makeChannel(c.name, c.color, c.data, bd, c.display));
      const doc = buildDoc({
        id, sessionKey: sessionKey || sessionKeyFor(provenance, id), name: img.name || 'image',
        width: img.width, height: img.height, bitDepth: bd, channels: chans,
        calibration: plainClone(img.calibration) || { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' }, provenance
      });
      registerDoc(doc, { baseline: true });
      return doc;
    }

    const handlers = {};

    handlers['doc.create'] = (a) => {
      for (const k of ['width', 'height']) if (!isInt(a[k]) || a[k] < 1) throw ijError('IJ_BAD_ARGS', k);
      const Ctor = ctorFor(a.bitDepth);
      if (!Array.isArray(a.channels) || !a.channels.length) throw ijError('IJ_BAD_ARGS', 'channels');
      ensureRoom(a.width * a.height * a.channels.length * (a.bitDepth / 8));
      const id = newId();
      const provenance = a.provenance || {};
      const chans = a.channels.map((c) => makeChannel(c.name, c.color, new Ctor(a.width * a.height), a.bitDepth));
      const doc = buildDoc({
        id, sessionKey: sessionKeyFor(provenance, id), name: a.name || 'image', width: a.width, height: a.height,
        bitDepth: a.bitDepth, channels: chans, calibration: plainClone(a.calibration) || { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' }, provenance
      });
      registerDoc(doc, { baseline: true });
      finishMutation();
      return { docId: id, info: infoOf(doc) };
    };

    // Output images + the accumulators of one band (the streaming peak), from the projector itself.
    // `bandRows` is the band the caller streams with (a median / sd accumulator is P * depth
    // for P = bandRows * width pixels, so the band decides the peak, not the image).
    function projectEstimate(a, bandRows) {
      const e = dep('IJProject').estimateBytes({
        method: a.method, width: a.width, height: a.height, depth: a.depth, channels: a.channels.length, bandRows
      });
      if (!(e > 0)) throw ijError('IJ_BAD_ARGS', 'projection size');
      return e;
    }

    // The largest band (halving from the one asked for, never below MIN_BAND_ROWS) whose
    // projection fits the budget; the caller streams with the band it is told.
    const MIN_BAND_ROWS = 8;
    function fitProjectBand(a) {
      let rows = isInt(a.bandRows) && a.bandRows > 0 ? a.bandRows : 64;
      rows = Math.min(rows, a.height);
      let e = projectEstimate(a, rows);
      while (rows > MIN_BAND_ROWS && !couldFit(e)) {
        rows = Math.max(MIN_BAND_ROWS, rows >> 1);
        e = projectEstimate(a, rows);
      }
      return { rows, estimate: e };
    }

    handlers['doc.project.begin'] = (a) => {
      const IJProject = dep('IJProject');
      for (const k of ['width', 'height', 'depth']) if (!isInt(a[k]) || a[k] < 1) throw ijError('IJ_BAD_ARGS', k);
      if (!Array.isArray(a.channels) || !a.channels.length) throw ijError('IJ_BAD_ARGS', 'channels');
      const docId = a.docId || newId();
      const fit = fitProjectBand(a);
      const estimate = fit.estimate;
      if (projects.has(docId)) projects.delete(docId);
      ensureRoom(estimate);
      const projector = IJProject.create({
        method: a.method, width: a.width, height: a.height, depth: a.depth, channels: a.channels.length
      });
      projects.set(docId, { projector, meta: plainClone({ name: a.name, method: a.method, width: a.width, height: a.height, depth: a.depth, channels: a.channels, calibration: a.calibration, provenance: a.provenance }), estimate, fraction: 0 });
      finishMutation();
      return { docId, outputBitDepth: projector.outputBitDepth, estimateBytes: estimate, bandRows: fit.rows };
    };

    handlers['doc.project.add'] = (a) => {
      const pr = projects.get(a.docId);
      if (!pr) throw ijError('IJ_NO_PROJECT', 'no projection in progress');
      pr.projector.addBlock({ channel: a.channel, y0: a.y0, rows: a.rows, z0: a.z0, depth: a.depth, data: a.data });
      pr.fraction = pr.projector.progress();
      return { fraction: pr.fraction };
    };

    handlers['doc.project.finish'] = (a) => {
      const pr = projects.get(a.docId);
      if (!pr) throw ijError('IJ_NO_PROJECT', 'no projection in progress');
      const outs = pr.projector.finish();
      projects.delete(a.docId);
      const m = pr.meta;
      const bd = outs[0].bitDepth;
      const chans = outs.map((o, i) => makeChannel(m.channels[i] && m.channels[i].name, m.channels[i] && m.channels[i].color, o.data, bd));
      const existing = docs.get(a.docId);
      const provenance = m.provenance || {};
      const doc = buildDoc({
        id: a.docId, sessionKey: existing ? existing.sessionKey : sessionKeyFor(provenance, a.docId),
        name: m.name || 'image', width: m.width, height: m.height, bitDepth: bd, channels: chans,
        calibration: m.calibration || { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' }, provenance
      });
      if (existing) {
        purgeTiles(existing.id);
        if (storageOn) enqueue(() => storage.discard(existing.sessionKey, { docId: existing.id }), null);
      }
      registerDoc(doc, { baseline: true });
      post({ event: 'invalidate', docId: doc.id, channels: chans.map((c, i) => i), sizeChanged: true });
      finishMutation();
      return { info: infoOf(doc) };
    };

    handlers['doc.open'] = (a) => {
      if (!a.bytes || !a.bytes.byteLength) throw ijError('IJ_BAD_ARGS', 'bytes');
      ensureRoom(a.bytes.byteLength * 2);
      const img = dep('IJTiff').read(a.bytes, typeof a.name === 'string' && a.name ? a.name : undefined);
      const doc = addDocFromImage(img, Object.assign({ opened: true }, a.provenance || {}), a.sessionKey);
      // A file just read from disk is what is on disk: nothing is unsaved until it is edited.
      doc.savedRev = doc.rev;
      markMeta(doc);
      finishMutation();
      return { docId: doc.id, info: infoOf(doc) };
    };

    handlers['doc.info'] = (a) => {
      const pr = projects.get(a.docId);
      if (pr && !docs.has(a.docId)) {
        const m = pr.meta;
        return { docId: a.docId, name: m.name, width: m.width, height: m.height, loading: true, fraction: pr.fraction, channels: m.channels, calibration: m.calibration, provenance: m.provenance };
      }
      return infoOf(getDoc(a.docId));
    };

    handlers['doc.list'] = () => ({ docs: [...docs.values()].map(infoOf) });

    handlers['doc.close'] = (a) => {
      const pr = projects.get(a.docId);
      if (pr && !docs.has(a.docId)) { projects.delete(a.docId); finishMutation(); return {}; }
      const doc = getDoc(a.docId);
      return lockDoc(doc, async () => {
        const clean = doc.savedRev === doc.rev;
        const s = sessions.get(doc.sessionKey);
        let ok = true;
        if (storageOn && (clean || a.discard)) {
          docs.delete(doc.id);
          if (s) { delete s.docs[doc.id]; delete s.display[doc.id]; }
          await queue;
          await enqueue(() => storage.discard(doc.sessionKey, { docId: doc.id }), null);
        } else if (storageOn) {
          // Keep for later: the stored state must be the last one. The document is still in
          // `docs` here: a snapshot of a document that has left it is skipped.
          if (doc.dirty || !doc.protected) ok = (await snapshotNow(doc, true)) !== false;
          await queue;
          // A failed write keeps the document in the engine: its retry timer is what still
          // tries to store it, and the caller (ok:false) can offer Save as TIFF instead.
          if (ok) docs.delete(doc.id);
        } else docs.delete(doc.id);
        purgeTiles(doc.id);
        latestPreview.delete(doc.id);
        if (activeSessionKey === doc.sessionKey && ![...docs.values()].some((d) => d.sessionKey === doc.sessionKey)) {
          const other = [...docs.values()].pop();
          activeSessionKey = other ? other.sessionKey : null;
        }
        finishMutation();
        return { ok, kept: !!(storageOn && !clean && !a.discard) };
      });
    };

    handlers['doc.setDisplay'] = (a) => {
      const doc = getDoc(a.docId);
      if (a.channel != null) {
        const ch = getChannel(doc, a.channel);
        const d = Object.assign({}, ch.display);
        if (a.min != null) d.min = needNumber(a.min, 'min');
        if (a.max != null) d.max = needNumber(a.max, 'max');
        if (a.lut !== undefined) d.lut = a.lut;
        if (a.invert != null) d.invert = !!a.invert;
        ch.display = d;
      }
      if (a.mode != null) {
        if (!['composite', 'color', 'gray'].includes(a.mode)) throw ijError('IJ_BAD_ARGS', 'mode');
        doc.mode = a.mode;
      }
      if (a.active != null) { getChannel(doc, a.active); doc.active = a.active; }
      if (a.visible != null) {
        if (!Array.isArray(a.visible) || a.visible.length !== doc.channels.length) throw ijError('IJ_BAD_ARGS', 'visible');
        doc.visible = a.visible.map(Boolean);
      }
      markMeta(doc);
      scheduleIdle();
      return { info: infoOf(doc) };
    };

    handlers['doc.run'] = (a, ctx) => {
      const doc = getDoc(a.docId);
      return lockDoc(doc, async () => {
        ctx.task.check();
        const before = doc.rev;
        const r = await executeRun(doc, a, ctx.task, false);
        if (r.newDocIds && r.newDocIds.length) { finishMutation(); return { rev: doc.rev, info: infoOf(doc), changed: r.changed, newDocIds: r.newDocIds, newInfos: r.newInfos }; }
        if (doc.rev !== before) {
          post({ event: 'invalidate', docId: doc.id, channels: r.changed.channels, sizeChanged: r.changed.sizeChanged });
        }
        finishMutation();
        return { rev: doc.rev, info: infoOf(doc), changed: r.changed, newDocIds: [] };
      });
    };

    handlers['doc.duplicate'] = (a) => {
      const doc = getDoc(a.docId);
      return lockDoc(doc, async () => duplicateDoc(doc, a));
    };

    function duplicateDoc(doc, a) {
      const W = doc.width, H = doc.height;
      const sel = Array.isArray(a.channels) ? a.channels : doc.channels.map((c, i) => i);
      let box = { x: 0, y: 0, w: W, h: H };
      if (a.roi) {
        const IJRoi = dep('IJRoi');
        IJRoi.validate(a.roi);
        if (IJRoi.isArea(a.roi)) box = cropRect(doc, null, a.roi);
      }
      ensureRoom(sel.length * box.w * box.h * (doc.bitDepth / 8));
      const chans = sel.map((c) => {
        const src = getChannel(doc, c);
        const data = (box.w === W && box.h === H) ? src.data.slice() : copyRect(src.data, W, box.x, box.y, box.w, box.h);
        return makeChannel(src.name, src.color, data, doc.bitDepth, src.display);
      });
      const provenance = Object.assign({}, doc.provenance);
      const o = provenance.cropOrigin || { x: 0, y: 0 };
      provenance.cropOrigin = { x: o.x + box.x, y: o.y + box.y };
      const nd = buildDoc({
        id: newId(), sessionKey: doc.sessionKey, name: a.name || (doc.name + '-1'), width: box.w, height: box.h,
        bitDepth: doc.bitDepth, channels: chans, calibration: plainClone(doc.calibration), provenance
      });
      registerDoc(nd, { baseline: true });
      finishMutation();
      return { docId: nd.id, info: infoOf(nd) };
    }

    handlers['doc.undo'] = (a) => {
      const doc = getDoc(a.docId);
      return lockDoc(doc, async () => {
        const changed = await doUndoRedo(doc, 'undo', false);
        post({ event: 'invalidate', docId: doc.id, channels: changed.channels, sizeChanged: changed.sizeChanged });
        finishMutation();
        return { rev: doc.rev, info: infoOf(doc), changed };
      });
    };

    handlers['doc.redo'] = (a) => {
      const doc = getDoc(a.docId);
      return lockDoc(doc, async () => {
        const changed = await doUndoRedo(doc, 'redo', false);
        post({ event: 'invalidate', docId: doc.id, channels: changed.channels, sizeChanged: changed.sizeChanged });
        finishMutation();
        return { rev: doc.rev, info: infoOf(doc), changed };
      });
    };

    handlers['doc.revert'] = (a) => {
      const doc = getDoc(a.docId);
      return lockDoc(doc, async () => {
        const r = await doRevert(doc);
        if (!r.noop) post({ event: 'invalidate', docId: doc.id, channels: r.changed.channels, sizeChanged: r.changed.sizeChanged });
        finishMutation();
        return { rev: doc.rev, info: infoOf(doc), changed: r.changed };
      });
    };

    // Reads of a document's pixels go through the document's queue, behind any operation
    // already accepted for it: the operation swaps the channel arrays only at its commit, so a
    // read that overtook it would answer from the pixels it is about to replace. Display reads
    // (doc.tile, doc.pixel, doc.preview) stay outside the queue on purpose: they must answer
    // between two slices of a running operation, and 'invalidate' tells the page to redraw.
    handlers['doc.stats'] = (a) => {
      const doc = getDoc(a.docId);
      return lockDoc(doc, async () => {
        const c = isInt(a.channel) ? a.channel : doc.active;
        getChannel(doc, c);
        return { row: measureRow(doc, c, a.roi || null, a.measurements) };
      });
    };

    handlers['doc.histogram'] = (a) => {
      const doc = getDoc(a.docId);
      return lockDoc(doc, async () => {
        const c = isInt(a.channel) ? a.channel : doc.active;
        const mask = roiMask(a.roi || null, doc.width, doc.height);
        const o = { bins: a.bins > 0 ? a.bins : 256 };
        if (a.min != null) o.min = a.min;
        if (a.max != null) o.max = a.max;
        return dep('IJOps').histogram(channelImage(doc, c), mask, o);
      });
    };

    handlers['doc.profile'] = (a) => {
      const doc = getDoc(a.docId);
      return lockDoc(doc, async () => {
        const c = isInt(a.channel) ? a.channel : doc.active;
        const line = a.line;
        if (!line || line.type !== 'line') throw ijError('IJ_BAD_ROI', 'a straight line is needed');
        const cal = calOf(doc);
        const prof = dep('IJOps').profile(channelImage(doc, c), line, line.width > 0 ? line.width : 1);
        return { values: prof.values, stepUm: prof.step * (cal.pw + cal.ph) / 2 };
      });
    };

    handlers['doc.threshold'] = (a) => {
      const doc = getDoc(a.docId);
      return lockDoc(doc, async () => {
        const c = isInt(a.channel) ? a.channel : doc.active;
        const mask = roiMask(a.roi || null, doc.width, doc.height);
        const o = { dark: !!a.dark, maskBox: mask };
        if (doc.bitDepth !== 8) {
          const r = rangeOf(doc, c);
          o.min = r.min; o.max = r.max;
        }
        const r = dep('IJThreshold').levels(channelImage(doc, c), a.method || 'Default', o);
        return { lower: r.lower, upper: r.upper, level: r.level, min: r.min, max: r.max };
      });
    };

    // Image measurements of one particle: the Set Measurements columns (Mean, Min, Max, IntDen...)
    // of the analysed channel over the particle's own outline, which is a traced polygon
    // (ImageJ perimeter rules). The particle's own area / perimeter / circularity are kept.
    const PARTICLE_OWN = new Set(['area', 'perimeter', 'circularity', 'n', 'xCentroid', 'yCentroid']);
    // Without "Include holes" ImageJ measures only the particle's own pixels: the filled
    // outline limited to the foreground (ParticleAnalyzer measures with the threshold as a
    // LIMIT), so a hole inside the outline never enters Mean / Min / IntDen.
    function particleImageStats(doc, c, outline, includeHoles) {
      const IJOps = dep('IJOps'), IJRoi = dep('IJRoi');
      const box = IJRoi.mask({ type: 'polygon', points: outline, traced: true }, doc.width, doc.height);
      if (!includeHoles && box && box.data) {
        const src = doc.channels[c].data, w = doc.width;
        for (let yy = 0; yy < box.h; yy++) {
          for (let xx = 0; xx < box.w; xx++) {
            const k = yy * box.w + xx;
            if (box.data[k] && src[(box.y + yy) * w + box.x + xx] === 0) box.data[k] = 0;
          }
        }
      }
      const st = IJOps.statistics(channelImage(doc, c), box, { calibration: doc.calibration });
      const out = {};
      for (const k of Object.keys(st)) if (!PARTICLE_OWN.has(k)) out[k] = st[k];
      return out;
    }

    handlers['doc.particles'] = (a, ctx) => {
      const doc = getDoc(a.docId);
      return lockDoc(doc, async () => {
        const c = isInt(a.channel) ? a.channel : doc.active;
        if (doc.bitDepth !== 8) throw ijError('IJ_NOT_BINARY', 'particle analysis needs an 8-bit mask');
        const o = Object.assign({}, a.opts || {});
        const cal = calOf(doc);
        if (o.unit === 'um2') {
          const px = cal.pw * cal.ph;
          if (o.minSize != null) o.minSize = o.minSize / px;
          if (o.maxSize != null) o.maxSize = o.maxSize / px;
        }
        o.calibration = doc.calibration;
        o.maskBox = o.roi ? roiMask(o.roi, doc.width, doc.height) : null;
        delete o.roi; delete o.unit;
        await ctx.task.tick(0, 'op.particles');
        const r = dep('IJParticles').analyze(doc.channels[c].data, doc.width, doc.height, o);
        const measure = a.measureImage !== false;
        const rows = [];
        for (let i = 0; i < r.particles.length; i++) {
          const p = r.particles[i];
          const row = {
            n: i + 1, area: p.area, areaPx: p.areaPx, perimeter: p.perimeter, circularity: p.circularity,
            bx: p.bx, by: p.by, bw: p.bw, bh: p.bh, xCentroid: p.xCentroid, yCentroid: p.yCentroid
          };
          if (measure && p.outline && p.outline.length >= 3) Object.assign(row, particleImageStats(doc, c, p.outline, !!o.includeHoles));
          rows.push(row);
          if ((i & 63) === 63) await ctx.task.tick(0.1 + 0.9 * (i + 1) / r.particles.length, 'op.particles');
        }
        return {
          rows,
          outlines: r.particles.map((p) => p.outline),
          summary: { count: r.count, totalArea: r.totalArea, averageSize: r.averageSize, areaFraction: r.areaFraction, percentArea: r.percentArea }
        };
      });
    };

    handlers['doc.pixel'] = (a) => {
      const doc = getDoc(a.docId);
      const x = Math.floor(a.x), y = Math.floor(a.y);
      if (!(x >= 0 && y >= 0 && x < doc.width && y < doc.height)) return { values: [] };
      const i = y * doc.width + x;
      return { values: doc.channels.map((c) => c.data[i]) };
    };

    handlers['doc.tile'] = (a, ctx) => {
      const doc = getDoc(a.docId);
      const c = getChannel(doc, a.channel) && a.channel;
      const level = a.level | 0;
      if (level < 0 || level >= levelCount(doc.width, doc.height)) throw ijError('IJ_BAD_TILE', 'level');
      const d = levelDims(doc.width, doc.height, level);
      const tx = a.tx | 0, ty = a.ty | 0;
      const x = tx * TILE, y = ty * TILE;
      if (tx < 0 || ty < 0 || x >= d.w || y >= d.h) throw ijError('IJ_BAD_TILE', 'tile');
      const w = Math.min(TILE, d.w - x), h = Math.min(TILE, d.h - y);
      const img = levelImage(doc, c, level);
      // A tile is a few MiB: never worth an undo step, so only the cache gives way.
      if (usedBytes() + w * h * (doc.bitDepth / 8) > budgetBytes) dropTiles();
      const data = copyRect(img.data, d.w, x, y, w, h);
      ctx.transfer.push(data.buffer);
      return { width: w, height: h, bitDepth: doc.bitDepth, data };
    };

    // The answer carries the revision the bytes were written from: the page hands it back to
    // doc.markSaved, so an edit committed between the export and the end of the file write is
    // never recorded as saved.
    handlers['doc.exportTiff'] = (a, ctx) => {
      const doc = getDoc(a.docId);
      return lockDoc(doc, async () => {
        let n = 0;
        for (const c of doc.channels) n += c.data.byteLength;
        ensureRoomNoEvict(n + 65536);
        transientBytes += n + 65536;
        ctx.release = () => { transientBytes -= n + 65536; };
        let bytes = dep('IJTiff').write(doc);
        if (bytes.byteOffset !== 0 || bytes.buffer.byteLength !== bytes.byteLength) bytes = bytes.slice();
        ctx.transfer.push(bytes.buffer);
        return { bytes, rev: doc.rev };
      });
    };

    handlers['doc.markSaved'] = (a) => {
      const doc = getDoc(a.docId);
      return lockDoc(doc, async () => {
        const rev = isInt(a.rev) && a.rev >= 0 ? Math.min(a.rev, doc.rev) : doc.rev;
        doc.savedRev = rev;
        markMeta(doc);
        return { savedRev: rev, unsaved: doc.savedRev !== doc.rev };
      });
    };

    handlers['session.list'] = async (a) => {
      if (!storageOn) return { sessions: [] };
      await queue;
      const rows = await storage.list();
      const out = [];
      for (const r of rows) {
        if (a.datasetId && r.datasetId !== a.datasetId) continue;
        const dm = (r.meta && r.meta.docs) || {};
        // What can be restored is what is stored: a document the meta lists without a stored
        // record is not offered, and a session with none is not a session.
        const ids = Array.isArray(r.docIds) ? r.docIds : Object.keys(dm);
        if (!ids.length) continue;
        out.push({
          key: r.key, datasetId: r.datasetId, savedAt: r.savedAt, docs: ids.length,
          unsaved: ids.some((i) => !dm[i] || !dm[i].saved), names: ids.map((i) => (dm[i] && dm[i].name) || '')
        });
      }
      out.sort((x, y) => y.savedAt - x.savedAt);
      return { sessions: out };
    };

    // Discards the STORED session. A document of that session that is open in the engine is
    // never stripped of its stored baseline (its next snapshot would reference a baseline that
    // is gone and the document could no longer be restored): those documents are left as they
    // are and named in `kept`. Closing them with doc.close { discard: true } is how an open
    // document's stored state is dropped.
    handlers['session.discard'] = async (a) => {
      if (!storageOn) return { kept: [] };
      await queue;
      const live = [...docs.values()].filter((d) => d.sessionKey === a.key);
      if (!live.length) {
        await storage.discard(a.key);
        sessions.delete(a.key);
        return { kept: [] };
      }
      const rows = await storage.list();
      const row = rows.find((r) => r.key === a.key);
      const open = new Set(live.map((d) => d.id));
      for (const id of (row && row.docIds) || []) if (!open.has(id)) await storage.discard(a.key, { docId: id });
      const s = sessions.get(a.key);
      if (s) for (const id of Object.keys(s.docs)) if (!open.has(id)) { delete s.docs[id]; delete s.display[id]; }
      return { kept: [...open] };
    };

    handlers['session.putMeta'] = async (a) => {
      const key = a.key || activeSessionKey;
      if (!key || !storageOn) return {};
      const s = sessions.get(key);
      if (s) s.ui = { results: a.results, rois: a.rois, measurements: a.measurements, windows: a.windows };
      // Storage only updates a session that already holds a document (no ghost session).
      await enqueue(() => storage.putMeta(key, { ui: { results: a.results, rois: a.rois, measurements: a.measurements, windows: a.windows } }), null);
      return {};
    };

    handlers['session.restore'] = async (a, ctx) => {
      if (!storageOn) throw ijError('IJ_NO_SESSION', 'storage is not available');
      await queue;
      const rows = await storage.list();
      const row = rows.find((r) => r.key === a.key);
      if (!row) throw ijError('IJ_NO_SESSION', 'no such session');
      // One document at a time (a baseline + a snapshot of a large image is hundreds of MB
      // decoded); a storage that cannot list its documents is read whole.
      const perDoc = Array.isArray(row.docIds);
      const whole = perDoc ? null : await storage.load(a.key);
      const docIds = perDoc ? row.docIds : Object.keys(whole ? whole.docs : {});
      const datasetId = row.datasetId;
      const ids = [], warnings = [], registered = [];
      const dm = (row.meta && row.meta.display) || {};
      try {
        for (const docId of docIds) {
          if (docs.has(docId)) { ids.push(docId); continue; }
          let loaded = null;
          if (perDoc) loaded = await storage.load(a.key, { docId });
          const rec = (perDoc ? (loaded && loaded.docs[docId]) : whole.docs[docId]) || { baseline: null, snapshot: null, journal: [] };
          const base = rec.baseline, snap = rec.snapshot;
          const src = snap || base;
          if (!src) { warnings.push({ docId, code: 'IJ_NO_BASELINE' }); continue; }
          let missing = false;
          const arrays = src.channels.map((c, i) => {
            const d = c.data || (base && base.channels[i] && base.channels[i].data);
            if (!d) missing = true;
            return d;
          });
          if (missing) { warnings.push({ docId, code: 'IJ_NO_BASELINE' }); continue; }
          const loadedBytes = arrays.reduce((n, d) => n + d.byteLength, 0);
          // The decoded records are in memory while the document is built: counted until then.
          transientBytes += loadedBytes;
          let doc;
          try {
            ensureRoom(loadedBytes);
            const chans = src.channels.map((c, i) => makeChannel(c.name, c.color, arrays[i], src.bitDepth, c.display));
            doc = buildDoc({
              id: docId, sessionKey: a.key, name: src.name, width: src.width, height: src.height, bitDepth: src.bitDepth,
              channels: chans, calibration: src.calibration, provenance: src.provenance, rev: src.rev,
              savedRev: src.savedRev == null ? -1 : src.savedRev, display: src.display, journalSeq: src.journalSeq || 0
            });
          } finally { transientBytes -= loadedBytes; }
          if (base) {
            doc.baselineSet = new WeakSet(base.channels.map((c) => c.data));
            doc.baselineShape = { w: base.width, h: base.height, bd: base.bitDepth };
            doc.baselineStored = true;
          }
          const entries = (rec.journal || []).filter((e) => e.seq > doc.journalSeq).sort((x, y) => x.seq - y.seq);
          const replayTask = makeTask(null);
          for (const e of entries) {
            // The journal is only a faithful history while it is contiguous: a hole means an
            // entry was never written, and what follows would be applied to the wrong state.
            if (e.seq !== doc.journalSeq + 1) {
              warnings.push({ docId, code: 'IJ_REPLAY_STOPPED', seq: e.seq, reason: 'gap' });
              break;
            }
            try {
              if (e.kind === 'run') await executeRun(doc, e, replayTask, true);
              else if (e.kind === 'undo' || e.kind === 'redo') await doUndoRedo(doc, e.kind, true);
              doc.journalSeq = e.seq;
            } catch (err) {
              console.error('[IJEngine] journal replay stopped', err);
              warnings.push({ docId, code: 'IJ_REPLAY_STOPPED', seq: e.seq });
              break;
            }
          }
          if (dm[docId]) {
            const ds = dm[docId];
            if (ds.mode) doc.mode = ds.mode;
            if (isInt(ds.active)) doc.active = ds.active;
            if (Array.isArray(ds.visible) && ds.visible.length === doc.channels.length) doc.visible = ds.visible;
            if (Array.isArray(ds.channels)) ds.channels.forEach((d, i) => { if (doc.channels[i] && d) doc.channels[i].display = Object.assign({}, doc.channels[i].display, d); });
          }
          doc.snapshotRev = doc.rev;
          if (!doc.baselineStored) writeBaseline(doc);
          docs.set(docId, doc);
          registered.push(docId);
          const s = sessionOf(a.key, datasetId);
          activeSessionKey = a.key;
          s.docs[docId] = { name: doc.name, rev: doc.rev, saved: doc.savedRev === doc.rev };
          ids.push(docId);
          // A replay that stopped early leaves the document at an earlier state than the stored
          // journal describes. The sequence number moves past every stored entry, so a later
          // commit can never collide with one that was not applied; the next snapshot of the
          // document (scheduled below) then replaces that journal with the state the operator
          // was told about (the warning above).
          if (warnings.some((w) => w.docId === docId && w.code === 'IJ_REPLAY_STOPPED') && entries.length) {
            doc.journalSeq = Math.max(doc.journalSeq, entries[entries.length - 1].seq);
          }
          doc.dirty = entries.length > 0;
          if (doc.dirty) scheduleIdle();
          post({ event: 'invalidate', docId, channels: doc.channels.map((c, i) => i), sizeChanged: true });
          await ctx.task.tick(ids.length / Math.max(1, docIds.length), 'session.restore');
        }
      } catch (err) {
        // All or nothing for the page: documents this call registered are not left behind unknown.
        for (const id of registered) { docs.delete(id); purgeTiles(id); }
        throw err;
      }
      finishMutation();
      return { docIds: ids, meta: (row.meta && row.meta.ui) || null, warnings };
    };

    // Liveness probe for the page's watchdog: answered at once.
    handlers['ping'] = () => ({ at: Date.now() });

    handlers['cancel'] = (a) => {
      const t = tasks.get(a.targetId);
      if (t) t.cancelled = true;
      return {};
    };

    // ok:false = something could not be stored (`unsafe` lists the documents): the page must not
    // present "keep for later" as done.
    handlers['flush'] = async () => {
      await flushAll();
      const unsafe = storageOn ? unsafeDocs() : [...docs.keys()];
      return { ok: unsafe.length === 0, unsafe, protected: storageOn };
    };

    // doc.preview: the answer is an event, the request is acknowledged when done.
    const previewRun = async (a, ctx) => {
      const doc = getDoc(a.docId);
      latestPreview.set(doc.id, a.seq);
      const superseded = () => latestPreview.get(doc.id) !== a.seq;
      const spec = PIXEL_OPS[a.op];
      if (!spec || a.op === 'flipH' || a.op === 'flipV') throw ijError('IJ_PREVIEW_UNSUPPORTED', 'no preview for this operation');
      const W = doc.width, H = doc.height, bd = doc.bitDepth;
      const vx0 = Math.max(0, Math.floor(a.x0)), vy0 = Math.max(0, Math.floor(a.y0));
      const vx1 = Math.min(W, Math.ceil(a.x1)), vy1 = Math.min(H, Math.ceil(a.y1));
      if (!(vx1 > vx0) || !(vy1 > vy0)) throw ijError('IJ_BAD_ARGS', 'region');
      let level = Math.max(0, a.level | 0);
      if (!spec.scalable) level = 0;
      const chans = channelList(doc, a.channel);
      const params = resolveParams(doc, a.op, a.params, chans);
      // Keep the working region within 6 Mpx at the level it is computed at.
      while (level < 12 && ((vx1 - vx0) >> level) * ((vy1 - vy0) >> level) > 6e6) {
        if (!spec.scalable) throw ijError('IJ_PREVIEW_TOO_LARGE', 'preview region too large');
        level++;
      }
      const s = 1 << level;
      const full0 = roiMask(a.roi || null, W, H);
      const result = { event: 'preview', seq: a.seq, docId: doc.id, level, channels: {}, bitDepth: bd };
      const transfer = [];
      let outBox = null;
      for (let i = 0; i < chans.length; i++) {
        const c = chans[i];
        const prep = spec.prepare(doc, c, params, { scale: s });
        const ax = prep.apron ? prep.apron.x : 0, ay = prep.apron ? prep.apron.y : 0;
        // Work region at level coordinates, aligned to the 2^level grid so it matches the tiles.
        const lx0 = Math.floor(vx0 / s), ly0 = Math.floor(vy0 / s);
        const lx1 = Math.ceil(vx1 / s), ly1 = Math.ceil(vy1 / s);
        const lvl = levelDims(W, H, level);
        const wx0 = Math.max(0, lx0 - ax), wy0 = Math.max(0, ly0 - ay);
        const wx1 = Math.min(lvl.w, lx1 + ax), wy1 = Math.min(lvl.h, ly1 + ay);
        const ww = wx1 - wx0, wh = wy1 - wy0;
        if (ww * wh > 12e6) throw ijError('IJ_PREVIEW_TOO_LARGE', 'preview region too large');
        let work;
        if (level === 0) work = copyRect(doc.channels[c].data, W, wx0, wy0, ww, wh);
        else {
          // level-L pixels [wx0,wx1) × [wy0,wy1) = downsample2 applied L times to the aligned level-0 block.
          let img = chImg(Math.min(W, wx1 * s) - wx0 * s, Math.min(H, wy1 * s) - wy0 * s, bd,
            copyRect(doc.channels[c].data, W, wx0 * s, wy0 * s, Math.min(W, wx1 * s) - wx0 * s, Math.min(H, wy1 * s) - wy0 * s));
          for (let l = 0; l < level; l++) {
            const nw = Math.ceil(img.width / 2), nh = Math.ceil(img.height / 2);
            img = chImg(nw, nh, bd, unwrap(dep('IJOps').downsample2(img), nw * nh));
          }
          work = img.data;
          if (img.width !== ww || img.height !== wh) throw ijError('IJ_INTERNAL', 'preview geometry');
        }
        // ROI mask in work coordinates.
        let mask = null;
        if (full0) {
          const mx0 = Math.max(wx0, Math.floor(full0.x / s)), my0 = Math.max(wy0, Math.floor(full0.y / s));
          const mx1 = Math.min(wx1, Math.ceil((full0.x + full0.w) / s)), my1 = Math.min(wy1, Math.ceil((full0.y + full0.h) / s));
          if (mx1 > mx0 && my1 > my0) {
            const mw = mx1 - mx0, mh = my1 - my0;
            const md = new Uint8Array(mw * mh);
            for (let r = 0; r < mh; r++) {
              const sy = Math.min(H - 1, (my0 + r) * s + (s >> 1));
              for (let q = 0; q < mw; q++) {
                const sxx = Math.min(W - 1, (mx0 + q) * s + (s >> 1));
                const ix = sxx - full0.x, iy = sy - full0.y;
                if (ix >= 0 && iy >= 0 && ix < full0.w && iy < full0.h) md[r * mw + q] = full0.data[iy * full0.w + ix];
              }
            }
            mask = { x: mx0 - wx0, y: my0 - wy0, w: mw, h: mh, data: md };
          } else mask = { x: 0, y: 0, w: 1, h: 1, data: new Uint8Array(1) };
        }
        const reg = { x: lx0 - wx0, y: ly0 - wy0, w: Math.min(lx1, wx1) - lx0, h: Math.min(ly1, wy1) - ly0 };
        const pmask = mask;
        let rreg = reg;
        if (mask && !spec.outside) {
          const x0 = Math.max(reg.x, mask.x), y0 = Math.max(reg.y, mask.y);
          const x1 = Math.min(reg.x + reg.w, mask.x + mask.w), y1 = Math.min(reg.y + reg.h, mask.y + mask.h);
          rreg = x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
        }
        let out = work;
        if (rreg) {
          const t = { tick: async (f, k) => { if (superseded()) throw ijError('IJ_SUPERSEDED', 'superseded'); await ctx.task.tick(f, k); }, check: () => ctx.task.check() };
          out = await pixelPass(t, ww, wh, bd, work, prep, pmask, rreg, !!spec.outside, (f) => (i + f) / chans.length, 'preview.' + a.op);
        }
        if (superseded()) throw ijError('IJ_SUPERSEDED', 'superseded');
        const rect = { x: reg.x, y: reg.y, w: reg.w, h: reg.h };
        const data = copyRect(out, ww, rect.x, rect.y, rect.w, rect.h);
        result.channels[c] = data;
        transfer.push(data.buffer);
        outBox = { x0: lx0, y0: ly0, w: rect.w, h: rect.h };
      }
      result.x0 = outBox.x0; result.y0 = outBox.y0; result.w = outBox.w; result.h = outBox.h;
      post(result, transfer);
      return { seq: a.seq };
    };

    handlers['doc.preview'] = async (a, ctx) => {
      try { return await previewRun(a, ctx); } catch (err) {
        if (err && err.code === 'IJ_SUPERSEDED') return { seq: a.seq, dropped: true };
        throw err;
      }
    };

    // ---- dispatch -----------------------------------------------------------------------------------

    async function onMessage(msg) {
      if (!msg || typeof msg !== 'object' || msg.init || !msg.cmd) return;
      const id = msg.id;
      const task = makeTask(id);
      if (id != null) tasks.set(id, task);
      const ctx = { id, task, transfer: [], release: null };
      try {
        const h = handlers[msg.cmd];
        if (!h) throw ijError('IJ_UNKNOWN_CMD', 'unknown command');
        const result = await h(msg.args || {}, ctx);
        post({ id, ok: true, result }, ctx.transfer);
      } catch (err) {
        const code = (err && err.code) || 'IJ_INTERNAL';
        if (code === 'IJ_INTERNAL' || !String(code).startsWith('IJ_')) console.error('[IJEngine] ' + msg.cmd + ' failed', err);
        post({ id, ok: false, error: { code: String(code), message: String(err && err.message || code), details: err && err.details || null } });
      } finally {
        if (ctx.release) ctx.release();
        if (id != null) tasks.delete(id);
      }
    }

    function dispose() {
      disposed = true;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      yielder.close();
    }

    // ---- start ----------------------------------------------------------------------------------------

    setupStorage();
    if (typeof self.addEventListener === 'function') self.addEventListener('message', (ev) => { onMessage(ev.data); });
    else self.onmessage = (ev) => { onMessage(ev.data); };
    post({ event: 'ready', protected: storageOn, budgetBytes });
    if (!storageOn && opts.storage !== 'none') emitStorageError('IJ_STORAGE_UNAVAILABLE', null);
    emitBudget();

    return {
      dispose,
      flush: flushAll,
      whenIdle: () => queue,
      usedBytes,
      budgetBytes,
      handle: onMessage
    };
  }

  function start(self, options) {
    return createEngine(self, options || {});
  }

  const api = { start, defaultBudget, createMemoryStorage, createIndexedDbStorage, TILE };
  try { ROOT.IJEngine = api; } catch (e) { /* frozen global */ }
  return api;
})();
