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
 * Operations (PLAN-wave2 §2.1): every `doc.run` / `doc.preview` / `doc.compute` operation is a
 * spec in IJOpRegistry (ij-core.js). The v1 operations are defined here, at module load, outside
 * createEngine; the packages add theirs in ij-proc-<pkg>.js. An op reads a FROZEN view of the
 * document (makeView) and NEVER writes into its arrays; the engine commits what it returns.
 * Commands added in wave 2: doc.compute, doc.estimate, doc.rename; `doc.run` takes `noUndo`. The spec fields, the
 * view, `ctx` (pixel) and `io` (size / newdoc / compute) are listed in the IJOpRegistry header of ij-core.js and
 * in DOCS/studio-advanced/PLAN-wave2.md §2; the rules the engine enforces on top:
 *   - `resolve` runs when a request is accepted, never on a replay; `scratchBytes` is reserved before `run`;
 *   - a size op that returns a channel without `display` keeps the display of the old channel holding the same
 *     array (same bit depth), else the default; names / colours follow the same rule;
 *   - undoing a size step restores the name only when that step renamed the document, and the display of a channel
 *     whose array the document still holds is left as it is;
 *   - a restore whose replay stops on something a later start could cure (unknown op, version, budget) HOLDS the
 *     stored session: nothing is written over its journal, the page is told (`storageError` IJ_REPLAY_HELD);
 *   - option `verifyInputs` (tests): the engine hashes the arrays an op was given and fails an op that wrote in them.
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
  // Replay stops that a later start could cure: the stored journal is kept as it is (doc.held).
  const REPLAY_HOLD_CODES = new Set(['IJ_UNKNOWN_OP', 'IJ_VERSION_MISMATCH', 'IJ_MODULE_MISSING', 'IJ_OVER_BUDGET', 'IJ_NOTHING_TO_UNDO']);
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
  // Display defaults, frozen document views, the built-in operations
  // ---------------------------------------------------------------------------

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

  function needNumber(v, what) {
    if (typeof v !== 'number' || !isFinite(v)) throw ijError('IJ_BAD_ARGS', what);
    return v;
  }

  // Pixel size of a document or of its frozen view.
  function calOf(doc) {
    const c = doc.calibration || {};
    return { pw: c.pixelWidth > 0 ? c.pixelWidth : 1, ph: c.pixelHeight > 0 ? c.pixelHeight : 1 };
  }

  function cropRect(view, params, roi) {
    let r;
    if (params && params.w > 0 && params.h > 0) r = { x: params.x | 0, y: params.y | 0, w: params.w | 0, h: params.h | 0 };
    else if (roi) {
      const IJRoi = dep('IJRoi');
      IJRoi.validate(roi);
      r = IJRoi.bounds(roi);
    } else throw ijError('IJ_NEEDS_ROI', 'crop needs a rectangle');
    const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(view.width, Math.ceil(r.x + r.w)), y1 = Math.min(view.height, Math.ceil(r.y + r.h));
    if (!(x1 > x0) || !(y1 > y0)) throw ijError('IJ_EMPTY_ROI', 'the selection is outside the image');
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // The document as an operation sees it (PLAN-wave2 §2.1): the arrays are the live ones, so an op
  // must NEVER write into them. Only the wrappers are frozen (a typed array cannot be).
  function makeView(doc) {
    const channels = doc.channels.map((c) => Object.freeze({ data: c.data, name: c.name, color: c.color, display: Object.freeze(Object.assign({}, c.display)) }));
    return Object.freeze({
      id: doc.id, name: doc.name, width: doc.width, height: doc.height, bitDepth: doc.bitDepth,
      calibration: doc.calibration ? Object.freeze(Object.assign({}, doc.calibration)) : doc.calibration,
      provenance: doc.provenance ? Object.freeze(Object.assign({}, doc.provenance)) : doc.provenance,
      channels: Object.freeze(channels), active: doc.active
    });
  }

  // The v1 operations, in the registry. `prepare` returns { apron, fn(src) | region(full, rect), whole? };
  // ctx = { scale, range(c) } (the whole-channel data range, cached per revision).
  function defineBuiltinOps() {
    const reg = ROOT.IJOpRegistry;
    if (!reg) return;
    // Tests load this file into one context more than once: the first definition stays.
    const def = (name, spec) => { if (!reg.get(name)) reg.define(name, spec); };
    const noApron = () => ({ x: 0, y: 0 });

    def('invert', {
      kind: 'pixel', version: 1,
      prepare(view, c, p, ctx) {
        if (view.bitDepth === 32) {
          // ImageJ inverts a float image about the data range: v' = max + min - v.
          const r = ctx.range(c);
          const s = r.max + r.min;
          return { apron: noApron(), fn(src) { const d = src.data, o = new Float32Array(d.length); for (let i = 0; i < d.length; i++) o[i] = s - d[i]; return o; } };
        }
        return { apron: noApron(), fn: (src) => dep('IJOps').invert(src) };
      }
    });
    def('math', {
      kind: 'pixel', version: 1,
      prepare(view, c, p) {
        if (typeof p.op !== 'string') throw ijError('IJ_BAD_ARGS', 'math op');
        if (p.op !== 'abs') needNumber(p.value, 'math value');
        return { apron: noApron(), fn: (src) => dep('IJOps').math(src, p.op, p.value, null) };
      }
    });
    def('fill', {
      kind: 'pixel', version: 1,
      prepare(view, c, p) { needNumber(p.value, 'fill value'); return { apron: noApron(), fn: (src) => dep('IJOps').fill(src, null, p.value) }; }
    });
    def('clear', {
      kind: 'pixel', version: 1,
      prepare(view, c, p) { needNumber(p.value, 'clear value'); return { apron: noApron(), fn: (src) => dep('IJOps').clear(src, null, p.value) }; }
    });
    def('clearOutside', {
      kind: 'pixel', version: 1, outside: true, needsRoi: true,
      prepare(view, c, p) { needNumber(p.value, 'clear value'); return { apron: noApron(), fn: (src) => dep('IJOps').fill(src, null, p.value) }; }
    });
    def('applyLut', {
      kind: 'pixel', version: 1, display: true,
      // The display range is not journaled: copy it into the params so a replay gives the same pixels.
      resolve(view, params, chans) {
        const p = Object.assign({}, params);
        p.ranges = Object.assign({}, p.ranges);
        for (const c of chans) {
          if (!p.ranges[c]) {
            const d = view.channels[c].display;
            p.ranges[c] = { min: p.min != null ? p.min : d.min, max: p.max != null ? p.max : d.max };
          }
        }
        return p;
      },
      prepare(view, c, p) {
        const r = p.ranges && p.ranges[c];
        if (!r) throw ijError('IJ_BAD_ARGS', 'applyLut range');
        return { apron: noApron(), fn: (src) => dep('IJOps').applyLut(src, r.min, r.max) };
      }
    });
    def('gaussian', {
      kind: 'pixel', version: 1, preview: 'reduced',
      prepare(view, c, p, o) {
        const IJFilters = dep('IJFilters');
        const sigma = needNumber(p.sigma, 'sigma');
        if (!(sigma > 0)) throw ijError('IJ_BAD_ARGS', 'sigma');
        const cal = calOf(view);
        const s = (o && o.scale) || 1;
        const sx = (p.scaled ? sigma / cal.pw : sigma) / s;
        const sy = (p.scaled ? sigma / cal.ph : sigma) / s;
        const accuracy = view.bitDepth === 8 ? 0.002 : 0.0002;
        return {
          apron: { x: IJFilters.gaussianApron(sx, accuracy, view.bitDepth), y: IJFilters.gaussianApron(sy, accuracy, view.bitDepth) },
          region: (full, r) => IJFilters.gaussian(full, sx, sy, { accuracy, region: { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h } })
        };
      }
    });
    def('rank', {
      kind: 'pixel', version: 1, preview: 'reduced',
      prepare(view, c, p, o) {
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
    });
    def('binary', {
      kind: 'pixel', version: 1,
      prepare(view, c, p) {
        if (view.bitDepth !== 8) throw ijError('IJ_NOT_BINARY', 'binary operations need an 8-bit mask');
        const IJBinary = dep('IJBinary');
        const op = p.op;
        if (!['erode', 'dilate', 'open', 'close', 'fillHoles', 'outline'].includes(op)) throw ijError('IJ_BAD_ARGS', 'binary op');
        const o = { iterations: p.iterations > 0 ? Math.floor(p.iterations) : 1, count: p.count > 0 ? Math.floor(p.count) : 1 };
        // Rows a result pixel depends on: erode/dilate 1 per iteration, open/close
        // twice that, outline 1. fillHoles is a global flood fill: one whole band.
        const reach = op === 'fillHoles' ? 0 : (op === 'open' || op === 'close' ? 2 * o.iterations : (op === 'outline' ? 1 : o.iterations));
        return { whole: op === 'fillHoles', apron: { x: reach, y: reach }, fn: (src) => IJBinary[op](src, o) };
      }
    });
    def('flipH', { kind: 'pixel', version: 1, preview: false, prepare() { return { whole: true, apron: noApron(), fn: (src) => dep('IJOps').flipH(src) }; } });
    def('flipV', { kind: 'pixel', version: 1, preview: false, prepare() { return { whole: true, apron: noApron(), fn: (src) => dep('IJOps').flipV(src) }; } });

    // ---- size operations: the document gets new arrays, possibly another shape
    def('crop', {
      kind: 'size', version: 1,
      scratchBytes: (info, params) => { const b = cropRect(info, params, info.roi); return b.w * b.h * info.channels * (info.bitDepth / 8); },
      async run(view, params, roi, io) {
        const W = view.width, bd = view.bitDepth;
        const box = cropRect(view, params, roi);
        const n = view.channels.length;
        io.reserve(n * box.w * box.h * (bd / 8));
        const channels = [];
        for (let i = 0; i < n; i++) {
          const ch = view.channels[i];
          channels.push({ data: copyRect(ch.data, W, box.x, box.y, box.w, box.h), name: ch.name, color: ch.color, display: Object.assign({}, ch.display) });
          await io.tick((i + 1) / n, 'op.crop');
        }
        io.check();
        const pv = Object.assign({}, view.provenance);
        const o = pv.cropOrigin || { x: 0, y: 0 };
        pv.cropOrigin = { x: o.x + box.x, y: o.y + box.y };
        return { width: box.w, height: box.h, bitDepth: bd, channels, provenance: pv };
      }
    });
    def('rotate90', {
      kind: 'size', version: 1,
      scratchBytes: (info) => info.width * info.height * info.channels * (info.bitDepth / 8),
      async run(view, params, roi, io) {
        const W = view.width, H = view.height, bd = view.bitDepth;
        const n = view.channels.length;
        io.reserve(n * W * H * (bd / 8));
        const channels = [];
        for (let i = 0; i < n; i++) {
          const ch = view.channels[i];
          channels.push({ data: unwrap(dep('IJOps').rotate90(chImg(W, H, bd, ch.data), params.dir), W * H), name: ch.name, color: ch.color, display: Object.assign({}, ch.display) });
          await io.tick((i + 1) / n, 'op.rotate90');
        }
        io.check();
        const out = { width: H, height: W, bitDepth: bd, channels };
        if (view.calibration) {
          const cal = Object.assign({}, view.calibration);
          const t = cal.pixelWidth; cal.pixelWidth = cal.pixelHeight; cal.pixelHeight = t;
          out.calibration = cal;
        }
        return out;
      }
    });
    def('convert', {
      kind: 'size', version: 1,
      resolve(view, params) {
        const p = Object.assign({}, params);
        p.ranges = Object.assign({}, p.ranges);
        view.channels.forEach((ch, c) => { if (!p.ranges[c]) p.ranges[c] = { min: ch.display.min, max: ch.display.max }; });
        return p;
      },
      scratchBytes: (info, params) => info.width * info.height * info.channels * ((params && params.bitDepth ? params.bitDepth : 32) / 8),
      async run(view, params, roi, io) {
        const W = view.width, H = view.height, bd = view.bitDepth;
        const newBd = params.bitDepth;
        if (![8, 16, 32].includes(newBd)) throw ijError('IJ_BAD_ARGS', 'bitDepth');
        if (newBd === bd) return null;
        const n = view.channels.length;
        io.reserve(n * W * H * (newBd / 8));
        const channels = [];
        for (let i = 0; i < n; i++) {
          const ch = view.channels[i];
          const r = params.ranges[i];
          const data = unwrap(dep('IJOps').convert(chImg(W, H, bd, ch.data), newBd, { min: r.min, max: r.max, scale: params.scale !== false }), W * H);
          channels.push({ data, name: ch.name, color: ch.color });
          await io.tick((i + 1) / n, 'op.convert');
        }
        io.check();
        return { width: W, height: H, bitDepth: newBd, channels };
      }
    });

    // ---- new-document operations
    def('toMask', {
      kind: 'newdoc', version: 1,
      scratchBytes: (info) => info.width * info.height,
      async run(view, params, roi, io) {
        const W = view.width, H = view.height;
        const c = isInt(io.channel) ? io.channel : (view.active || 0);
        if (!isInt(c) || c < 0 || c >= view.channels.length) throw ijError('IJ_BAD_ARGS', 'channel');
        needNumber(params.lower, 'lower'); needNumber(params.upper, 'upper');
        io.reserve(W * H);
        const mask = dep('IJThreshold').toMask(chImg(W, H, view.bitDepth, view.channels[c].data), params.lower, params.upper);
        io.check();
        return [{
          name: view.name.replace(/\.[A-Za-z0-9]+$/, '') + '-mask', width: W, height: H, bitDepth: 8,
          channels: [{ name: view.channels[c].name, color: '#ffffff', data: unwrap(mask, W * H) }]
        }];
      }
    });
    def('cropToNew', {
      kind: 'newdoc', version: 1,
      scratchBytes: (info, params) => { const b = cropRect(info, params, info.roi); return b.w * b.h * info.channels * (info.bitDepth / 8); },
      async run(view, params, roi, io) {
        const W = view.width, bd = view.bitDepth;
        const box = cropRect(view, params, roi);
        const sel = (params && Array.isArray(params.channels)) ? params.channels : view.channels.map((c, i) => i);
        for (const c of sel) if (!isInt(c) || c < 0 || c >= view.channels.length) throw ijError('IJ_BAD_ARGS', 'channel');
        io.reserve(sel.length * box.w * box.h * (bd / 8));
        const channels = sel.map((c) => {
          const src = view.channels[c];
          return { name: src.name, color: src.color, data: copyRect(src.data, W, box.x, box.y, box.w, box.h), display: Object.assign({}, src.display) };
        });
        io.check();
        const provenance = Object.assign({}, view.provenance);
        const o = provenance.cropOrigin || { x: 0, y: 0 };
        provenance.cropOrigin = { x: o.x + box.x, y: o.y + box.y };
        return [{ name: (params && params.name) || (view.name + '-crop'), width: box.w, height: box.h, bitDepth: bd, channels, provenance }];
      }
    });
  }
  defineBuiltinOps();

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
      if (!d) { d = { baseline: null, snapshot: null, journal: [], rois: {} }; s.docs.set(id, d); }
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
          // The engine writes a large selection again, after a snapshot, with the first entry that needs it.
          d.rois = {};
        }
      },
      // A journal entry or a meta patch never creates a session: only a stored document does,
      // so a session that lists is always one that can be restored. A journal entry for a
      // session that is gone fails, which leaves the document unprotected until its next snapshot.
      async putJournal(key, entry, roiBody) {
        const s = sess(key, false);
        if (!s) throw ijError('IJ_STORAGE_FAILED', 'no such session');
        const d = docRec(s, entry.docId);
        d.journal.push(cloneValue(entry));
        if (roiBody) d.rois[roiBody.hash] = cloneValue(roiBody.roi);
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
            journal: parts.includes('journal') ? cloneValue(d.journal) : [],
            rois: parts.includes('journal') ? cloneValue(d.rois) : {}
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
        for (const s of sessions.values()) for (const d of s.docs.values()) { count(d.baseline); count(d.snapshot); count(d.journal); count(d.rois); }
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
            // large selections of the entries just covered (stored under 'roi:<hash>' keys)
            tx.objectStore('journal').delete(range([key, snap.docId, 'roi:'], [key, snap.docId, 'roi:\uffff']));
          }
          touchSession(tx.objectStore('sessions'), key, snap.provenance && snap.provenance.datasetId, null, true);
        });
      },
      putJournal(key, entry, roiBody) {
        return run(['sessions', 'journal'], 'readwrite', (tx, out) => {
          tx.objectStore('journal').put(entry, [key, entry.docId, entry.seq]);
          if (roiBody) tx.objectStore('journal').put({ kind: 'roi', docId: entry.docId, hash: roiBody.hash, roi: roiBody.roi }, [key, entry.docId, 'roi:' + roiBody.hash]);
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
            const slot = (id) => docs[id] || (docs[id] = { baseline: null, snapshot: null, journal: [], rois: {} });
            if (docsReq) for (const r of docsReq.result) if (parts.includes(r.kind)) slot(r.docId)[r.kind] = r;
            if (jReq) for (const e of jReq.result) { if (e.kind === 'roi') slot(e.docId).rois[e.hash] = e.roi; else slot(e.docId).journal.push(e); }
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
          doc.roiWritten = new Set();
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

    // The documents the budget counts: the registered ones and the one a session restore is replaying
    // (not registered until the replay ends, but its arrays and undo steps are already in memory).
    const replaying = new Set();
    function budgetDocs() { return replaying.size ? Array.from(docs.values()).concat(Array.from(replaying)) : docs.values(); }

    function usedBytes() {
      const seen = new Set();
      let total = 0;
      const add = (a) => { if (a && !seen.has(a)) { seen.add(a); total += a.byteLength; } };
      const addRec = (r) => {
        if (r.patches) for (const p of r.patches) add(p.data);
        if (r.full) for (const c of r.full.channels) add(c.data);
      };
      for (const d of budgetDocs()) {
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
    // Only what dropping the tile cache and every undo / redo step would really FREE: an array an undo
    // step shares with a live channel (a calibration-only step, an Arrange) or with the baseline kept in
    // RAM stays in memory, and an array two steps share is freed once.
    function reclaimableBytes() {
      const seen = new Set();
      for (const d of budgetDocs()) {
        for (const c of d.channels) seen.add(c.data);
        if (d.baselineData) for (const a of d.baselineData) seen.add(a);
      }
      let reclaimable = tiles.bytes;
      const add = (a) => { if (a && !seen.has(a)) { seen.add(a); reclaimable += a.byteLength; } };
      const addRec = (r) => {
        if (r.patches) for (const p of r.patches) add(p.data);
        if (r.full) for (const c of r.full.channels) add(c.data);
      };
      for (const d of budgetDocs()) {
        for (const r of d.undo) addRec(r);
        for (const r of d.redo) addRec(r);
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
        for (const d of budgetDocs()) {
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

    // What the channel layout of a document is: the session meta stamps its display with it and the
    // restore applies that display only when the layout it finds is the one the display was made for
    // (a journaled Arrange whose meta write never happened would otherwise shift every LUT).
    function channelSig(doc) {
      return doc.channels.length + '|' + doc.channels.map((c) => c.name).join('\u0001') + '|' + (doc.layoutRev || 0);
    }

    function displayStateOf(doc) {
      return {
        sig: channelSig(doc),
        mode: doc.mode, active: doc.active, visible: doc.visible.slice(),
        channels: doc.channels.map((c) => ({ min: c.display.min, max: c.display.max, lut: c.display.lut, invert: c.display.invert }))
      };
    }

    function markMeta(doc) {
      if (!storageOn || doc.held) return;
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
        baselineIndex: new WeakMap(), baselineData: null, baselineShape: null, baselineMeta: null, baselineProvenance: null, baselineStored: false,
        layoutRev: p.layoutRev || 0, roiWritten: new Set(),
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
        kind, docId: doc.id, rev: doc.rev, journalSeq: doc.journalSeq, savedRev: doc.savedRev, layoutRev: doc.layoutRev,
        name: doc.name, width: doc.width, height: doc.height, bitDepth: doc.bitDepth,
        calibration: plainClone(doc.calibration), provenance: plainClone(doc.provenance),
        display: displayStateOf(doc),
        // A channel that still IS one of the baseline's arrays is stored as a reference to that
        // baseline channel (baseIndex) — never by its own index: an Arrange / reorder keeps the
        // arrays but moves them.
        channels: doc.channels.map((c) => {
          const bi = same ? doc.baselineIndex.get(c.data) : undefined;
          const isBase = bi !== undefined;
          return {
            name: c.name, color: c.color, display: Object.assign({}, c.display),
            sameAsBaseline: isBase, baseIndex: isBase ? bi : undefined,
            data: isBase ? null : c.data
          };
        })
      };
    }

    function recDataBytes(rec) {
      let n = 0;
      for (const c of rec.channels) if (c.data) n += c.data.byteLength;
      return n;
    }

    function writeBaseline(doc) {
      doc.baselineIndex = new WeakMap();
      doc.channels.forEach((c, i) => doc.baselineIndex.set(c.data, i));
      doc.baselineMeta = doc.channels.map((c) => ({ name: c.name, color: c.color }));
      doc.baselineProvenance = plainClone(doc.provenance);
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
      // A held document (its stored session could not be replayed) never overwrites that session; a caller
      // that waits for the answer (doc.close "keep for later") is told nothing was kept.
      if (doc.held) return Promise.resolve(false);
      if (!storageOn || (!force && !docs.has(doc.id))) return queue;
      const rec = recordOf(doc, 'snapshot');
      const bytes = recDataBytes(rec);
      // The snapshot drops the stored selections of the entries it covers: the entries committed
      // from now on write the bodies they need again.
      doc.roiWritten = new Set();
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

    const ROI_REF_BYTES = 65536;

    function noteCommit(doc, entry) {
      doc.dirty = true;
      doc.journalSeq++;
      if (entry && storageOn && doc.protected) {
        entry.docId = doc.id;
        entry.seq = doc.journalSeq;
        entry.at = Date.now();
        entry.rev = doc.rev;
        // A large selection is stored once per document, under its hash, beside the entries.
        let body = null;
        const IJRoi = ROOT.IJRoi;
        if (entry.roi && IJRoi && IJRoi.byteSize(entry.roi) > ROI_REF_BYTES) {
          const ref = IJRoi.hash(entry.roi);
          if (!doc.roiWritten.has(ref)) { doc.roiWritten.add(ref); body = { hash: ref, roi: entry.roi }; }
          entry.roiRef = ref;
          entry.roi = null;
        }
        enqueue(async () => {
          if (!doc.protected) { doc.unjournaledRev = Math.max(doc.unjournaledRev, entry.rev); doc.roiWritten = new Set(); return; }
          await storage.putJournal(doc.sessionKey, entry, body);
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
        undoDepth: doc.undo.length, redoDepth: doc.redo.length, layoutRev: doc.layoutRev,
        bytes, levels: levelCount(doc.width, doc.height), tileSize: TILE,
        unsaved: doc.savedRev !== doc.rev || !!doc.held, protected: !!(storageOn && doc.protected),
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

    // One channel through one pixel operation, in bands. Returns the new array.
    //   old     the channel as it is
    //   reg     bounds {x,y,w,h} of what may change
    //   mask    mask box or null; outside = modify the pixels NOT in the mask
    //   prog    (fraction in this channel) → overall fraction callback
    // `gate` ({ lo, hi }, optional) is told which share of the channel the current band is, so the
    // `ctx.tick(f)` a whole-image op calls inside its fn / region maps into the right part of the bar.
    async function pixelPass(task, W, H, bd, old, prep, mask, reg, outside, prog, stepKey, gate) {
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
        if (gate) { gate.lo = (y - reg.y) / reg.h; gate.hi = (y1 - reg.y) / reg.h; }
        let res, rx, ry, rw;
        if (prep.region) {
          const rect = { x: reg.x, y, w: reg.w, h: y1 - y };
          const r = await prep.region(full, rect);
          rx = reg.x; ry = y; rw = rect.w;
          res = unwrap(r, rect.w * rect.h);
        } else {
          const sx = Math.max(0, reg.x - ax), sx1 = Math.min(W, reg.x + reg.w + ax);
          const sy = Math.max(0, y - ay), sy1 = Math.min(H, y1 + ay);
          const sw = sx1 - sx, sh = sy1 - sy;
          const src = chImg(sw, sh, bd, copyRect(old, W, sx, sy, sw, sh));
          res = unwrap(await prep.fn(src), sw * sh);
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
    //
    // kind 'pixel'  one array per channel replaced, undo = patches (cropped to the selection) or the old array
    // kind 'size'   the document gets new arrays / shape / channel list; undo = the whole previous state
    // kind 'newdoc' new documents appear (not journaled: each registers its own baseline)
    // kind 'compute' read-only (doc.compute)

    function specOf(op, kinds) {
      const reg = ROOT.IJOpRegistry;
      const spec = reg && typeof op === 'string' ? reg.get(op) : null;
      if (!spec) throw ijError('IJ_UNKNOWN_OP', 'unknown operation');
      if (kinds && !kinds.includes(spec.kind)) throw ijError('IJ_BAD_ARGS', 'operation kind');
      return spec;
    }

    function checkBitDepth(spec, doc) {
      if (!spec.bitDepths.includes(doc.bitDepth)) throw ijError('IJ_BAD_TYPE', 'this operation does not support ' + doc.bitDepth + '-bit images');
    }

    function channelList(doc, channel) {
      if (channel === 'all' || channel == null) return doc.channels.map((c, i) => i);
      getChannel(doc, channel);
      return [channel];
    }

    function pixelChannels(doc, spec, channel) {
      if (spec.channels === 'all') return doc.channels.map((c, i) => i);
      if (spec.channels === 'one') { const c = isInt(channel) ? channel : doc.active; getChannel(doc, c); return [c]; }
      return channelList(doc, channel);
    }

    // What validate / scratchBytes are told: the primary document's shape, the region a pixel op touches
    // and `docs` = the shape of the other documents the request names (Image Calculator, Merge, Coloc).
    function infoFor(doc, chans, reg, others, roi) {
      return {
        width: doc.width, height: doc.height, bitDepth: doc.bitDepth, channels: chans.length, region: reg || null, roi: roi || null,
        docs: (others || []).map((d) => ({ width: d.width, height: d.height, bitDepth: d.bitDepth, channels: d.channels.length }))
      };
    }

    // The scratch an op declares, 0 when it declares none. Pixel op: bytes BESIDE the new arrays and the undo
    // patch the engine already counts. Size / newdoc / compute op: the op's whole peak, its output included.
    function scratchOf(spec, info, params) {
      return spec.scratchBytes ? Math.max(0, Number(spec.scratchBytes(info, params)) || 0) : 0;
    }

    // Validate + resolve the params of a request. `resolve` copies the state that is not journaled
    // (display range, threshold) into the params BEFORE the entry is journaled, so a replay gives
    // the same pixels.
    // A replayed entry already holds its resolved params, and the state `resolve` reads (display range,
    // threshold) is not the state of the moment the entry was written: resolve is NOT called on a replay
    // (it must still be idempotent — fill what is missing — because a page may send resolved params).
    function resolvedParams(doc, spec, args, chans, replay, others) {
      let params = Object.assign({}, args.params || {});
      if (spec.validate) spec.validate(params, infoFor(doc, chans, null, others));
      if (spec.resolve && !replay) { const r = spec.resolve(makeView(doc), params, chans); if (r) params = r; }
      return params;
    }

    function newRecord(doc, op) {
      return { op, at: Date.now(), replayable: true, bytes: 0, patches: null, full: null, display: null, calOnly: false };
    }

    // Push the undo record of a committed change; the redo stack is dead.
    function pushUndo(doc, rec) {
      rec.bytes = recBytes(rec);
      doc.undo.push(rec);
      while (doc.undo.length > MAX_UNDO) doc.undo.shift();
      doc.redo.length = 0;
    }

    // Everything a size-kind step changes (arrays are kept by reference).
    function fullState(doc) {
      return {
        width: doc.width, height: doc.height, bitDepth: doc.bitDepth, calibration: plainClone(doc.calibration),
        name: doc.name, provenance: plainClone(doc.provenance), mode: doc.mode, active: doc.active, visible: doc.visible.slice(),
        channels: doc.channels.map((c) => ({ data: c.data, display: Object.assign({}, c.display), name: c.name, color: c.color }))
      };
    }

    // After the channel list changed: visibility, the active channel and the mode follow the channels
    // BY NAME (an Arrange moves a channel, its visibility moves with it). `old` is the previous list,
    // `vis` / `act` the previous values. A channel the previous list did not have (an undo brings a
    // dropped one back) takes what `rec` — the state being restored — says about it, else it is shown.
    function remapDisplay(doc, old, vis, act, rec) {
      const n = doc.channels.length;
      const used = new Set();
      const from = doc.channels.map((c) => {
        for (let j = 0; j < old.length; j++) if (!used.has(j) && old[j].name === c.name) { used.add(j); return j; }
        return -1;
      });
      const recIndex = (name) => (rec && Array.isArray(rec.channels) ? rec.channels.findIndex((c) => c.name === name) : -1);
      doc.visible = from.map((j, i) => {
        if (j >= 0 && vis[j] !== undefined) return !!vis[j];
        const k = recIndex(doc.channels[i].name);
        return k >= 0 && rec.visible && rec.visible[k] !== undefined ? !!rec.visible[k] : true;
      });
      let a = from.indexOf(act);
      if (a < 0 && rec && Number.isInteger(rec.active) && rec.channels && rec.channels[rec.active]) a = doc.channels.findIndex((c) => c.name === rec.channels[rec.active].name);
      doc.active = a >= 0 ? a : Math.max(0, Math.min(n - 1, act | 0));
      if (n === 1) doc.mode = 'gray';
      else if (doc.mode === 'gray' && old.length === 1) doc.mode = 'composite';
    }

    function checkOutput(r, what) {
      if (!r || !isInt(r.width) || r.width < 1 || !isInt(r.height) || r.height < 1 || ![8, 16, 32].includes(r.bitDepth) ||
        !Array.isArray(r.channels) || !r.channels.length) throw ijError('IJ_BAD_RESULT', 'result of ' + what);
      const Ctor = ctorFor(r.bitDepth);
      for (const c of r.channels) {
        if (!c || !ArrayBuffer.isView(c.data) || c.data.constructor.name !== Ctor.name || c.data.length !== r.width * r.height) throw ijError('IJ_BAD_RESULT', 'channel of ' + what);
      }
    }

    // Test aid (engine option verifyInputs): an op must never write into the arrays it reads. The engine
    // hashes them before the op and compares afterwards; a changed array is an IJ_INTERNAL failure.
    const verifyInputs = opts.verifyInputs === true;
    function hashArray(a) {
      const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
      let h = 0x811c9dc5;
      for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; }
      return h;
    }
    function guardInputs(list, what) {
      if (!verifyInputs) return () => {};
      const arrays = [];
      for (const d of list) for (const c of d.channels) arrays.push(c.data);
      const before = arrays.map(hashArray);
      return () => {
        for (let i = 0; i < arrays.length; i++) {
          if (hashArray(arrays[i]) !== before[i]) throw ijError('IJ_INTERNAL', (what || 'operation') + ' wrote into an input array');
        }
      };
    }

    // The `io` an operation receives (PLAN-wave2 §2.1). `docList[0]` is the primary document; the
    // others were named in the request (`docIds`) and are locked with it.
    // `o.scratch` = what the op declared (scratchBytes): reserved HERE, before `run`, so a step that does
    // not fit is refused (IJ_OVER_BUDGET) without ever starting and two concurrent steps on two documents
    // see each other's peak. `io.reserve(n)` counts against that declaration first (declaring AND
    // reserving the same bytes is safe); only what exceeds it is reserved on top. `done()` gives it all back.
    function makeIo(task, docList, o) {
      const ids = new Set(docList.map((d) => d.id));
      const primary = docList[0];
      const declared = Math.max(0, (o && o.scratch) || 0);
      if (declared) { ensureRoom(declared); transientBytes += declared; }
      let held = declared, used = 0;
      return {
        channel: o && o.channel !== undefined ? o.channel : null,
        region: (o && o.region) || null,
        docIds: docList.map((d) => d.id),
        tick: (f, stepKey, detail) => task.tick(f, stepKey, detail),
        check: () => task.check(),
        reserve(bytes) {
          if (!(bytes >= 0)) throw ijError('IJ_BAD_ARGS', 'reserve');
          const need = used + bytes;
          if (need > held) { const extra = need - held; ensureRoom(extra); transientBytes += extra; held = need; }
          used = need;
        },
        release(bytes) {
          used = Math.max(0, used - Math.max(0, bytes || 0));
          const keep = Math.max(declared, used);
          if (keep < held) { transientBytes -= held - keep; held = keep; }
        },
        dep,
        channelImage: (c) => channelImage(primary, c),
        readDoc(id) {
          if (!ids.has(id)) throw ijError('IJ_BAD_ARGS', 'document not listed in docIds');
          const d = docs.get(id);
          if (!d) throw ijError('IJ_NO_DOC', 'no such document');
          return makeView(d);
        },
        range: (c) => rangeOf(primary, c),
        roiMask: (roi) => roiMask(roi, primary.width, primary.height),
        transfer: (buf) => { if (o && o.transfer) o.transfer.push(buf); },
        done() { if (held) { transientBytes -= held; held = 0; used = 0; } }
      };
    }

    // What a pixel op touches: the channels, the selection as the op sees it, the region that may change.
    function planPixel(doc, spec, args) {
      const W = doc.width, H = doc.height, bd = doc.bitDepth;
      checkBitDepth(spec, doc);
      const chans = pixelChannels(doc, spec, args.channel);
      let mask = roiMask(args.roi || null, W, H);
      if (spec.needsRoi && !mask) throw ijError('IJ_NEEDS_ROI', 'this operation needs an area selection');
      if (spec.roi === 'ignore') mask = null;
      const passMask = spec.roi === 'bounds' ? null : mask;
      const outside = !!spec.outside;
      const reg = outside ? { x: 0, y: 0, w: W, h: H } : boundsOf(mask, W, H);
      const fullReg = reg.x === 0 && reg.y === 0 && reg.w === W && reg.h === H;
      const chBytes = W * H * (bd / 8);
      const patchBytes = fullReg ? 0 : reg.w * reg.h * (bd / 8);
      return { chans, mask, passMask, outside, reg, fullReg, chBytes, patchBytes };
    }

    // Bytes of one run: the new arrays, the patch copy of an undo step on a partial region, and
    // what the algorithm allocates besides (scratchBytes). `oneChannel` = what a run needs when
    // each channel is committed as soon as it is computed (noUndo).
    function pixelNeed(doc, spec, plan, params) {
      const scratch = spec.scratchBytes ? Math.max(0, Number(spec.scratchBytes(infoFor(doc, plan.chans, plan.reg), params)) || 0) : 0;
      return {
        need: plan.chans.length * (plan.chBytes + plan.patchBytes) + scratch,
        oneChannel: plan.chBytes + plan.patchBytes + scratch
      };
    }

    async function executeRun(doc, args, task, replay, extraDocs) {
      const spec = specOf(args.op);
      if (spec.kind === 'compute') throw ijError('IJ_BAD_ARGS', 'a compute operation runs through doc.compute');
      // An entry written under another version of the operation cannot be replayed faithfully.
      if (replay && (args.version || 1) !== spec.version) throw ijError('IJ_VERSION_MISMATCH', 'operation version changed');
      if (spec.kind === 'newdoc') return runNewDoc(doc, spec, args, task, extraDocs || []);
      if (spec.kind === 'size') return runSize(doc, spec, args, task, replay);
      return runPixel(doc, spec, args, task, replay);
    }

    async function runPixel(doc, spec, args, task, replay) {
      const op = args.op;
      const roi = args.roi || null;
      const W = doc.width, H = doc.height, bd = doc.bitDepth;
      const plan = planPixel(doc, spec, args);
      const { chans, passMask, outside, reg, fullReg } = plan;
      const params = resolvedParams(doc, spec, args, chans, replay);
      const view = makeView(doc);
      // ctx.check() / ctx.tick(f, stepKey?) are for a whole-image op: f in [0,1] is the progress of the
      // fn / region call in progress; the engine maps it into the band and the channel and yields.
      const gates = chans.map(() => ({ lo: 0, hi: 1 }));
      const preps = chans.map((c, i) => {
        const gate = gates[i], base = i / chans.length, span = 1 / chans.length;
        return spec.prepare(view, c, params, {
          scale: 1, range: (cc) => rangeOf(doc, cc), dep,
          check: () => task.check(),
          tick: (f, key) => task.tick(base + span * (gate.lo + (gate.hi - gate.lo) * Math.min(1, Math.max(0, Number(f) || 0))), key || ('op.' + op))
        });
      });
      const noUndo = !!args.noUndo;
      const n = pixelNeed(doc, spec, plan, params);
      const need = noUndo ? n.oneChannel : n.need;
      ensureRoom(need);
      // Reserved while the operation runs, so an operation on another document sees the
      // headroom this one is about to take; released at commit (the new arrays are counted then).
      transientBytes += need;
      const outs = [];
      let swapped = false;
      const swappedChans = [];
      const guard = guardInputs([doc], op);
      const swapChannel = (c, out) => {
        const ch = doc.channels[c];
        ch.data = out;
        if (spec.display) ch.display = defaultDisplay(ch, bd);
      };
      try {
        for (let i = 0; i < chans.length; i++) {
          const base = i / chans.length, span = 1 / chans.length;
          const out = await pixelPass(task, W, H, bd, doc.channels[chans[i]].data, preps[i], passMask, reg, outside,
            (f) => base + span * f, 'op.' + op, gates[i]);
          if (noUndo) {
            // No undo step: each channel replaces its old array at once, which is what lets the
            // step fit. A cancel after the first one leaves the channels already processed changed.
            task.check();
            if (!swapped) { swapped = true; doc.undo.length = 0; doc.redo.length = 0; }
            swapChannel(chans[i], out);
            swappedChans.push(chans[i]);
          } else outs.push(out);
        }
        guard();
        task.check();
      } catch (err) {
        if (swapped) {
          doc.rev++; purgeTiles(doc.id); noteCommit(doc, null); if (storageOn) snapshotNow(doc);
          // The channels already swapped changed for good and the undo history is gone: the page is told
          // (an invalidate now, the document's info with the error) instead of keeping the old pixels.
          post({ event: 'invalidate', docId: doc.id, channels: swappedChans.slice(), sizeChanged: false });
          err.details = Object.assign({}, err.details, { info: infoOf(doc), changed: { channels: swappedChans.slice(), sizeChanged: false } });
        }
        throw err;
      } finally { transientBytes -= need; }
      // Commit (synchronous: nothing can interleave from here on).
      // The channel a replay must see: a `one`-channel op journals the channel it ran on (the active one
      // may differ at replay time), the others what the request said ('all' when it said nothing).
      const entry = { kind: 'run', op, version: spec.version, params, roi,
        channel: spec.channels === 'one' ? chans[0] : (args.channel == null ? 'all' : args.channel) };
      if (noUndo) {
        entry.noUndo = true;
        doc.rev++;
        purgeTiles(doc.id);
        if (!replay) { noteCommit(doc, entry); if (storageOn) snapshotNow(doc); } else doc.journalSeq++;
        return { changed: { channels: chans, sizeChanged: false }, newDocIds: [] };
      }
      const rec = newRecord(doc, op);
      rec.patches = chans.map((c) => ({
        c, rect: Object.assign({}, reg),
        data: fullReg ? doc.channels[c].data : copyRect(doc.channels[c].data, W, reg.x, reg.y, reg.w, reg.h)
      }));
      if (spec.display) {
        rec.display = {};
        for (const c of chans) rec.display[c] = Object.assign({}, doc.channels[c].display);
      }
      chans.forEach((c, i) => swapChannel(c, outs[i]));
      pushUndo(doc, rec);
      doc.rev++;
      purgeTiles(doc.id);
      if (!replay) noteCommit(doc, entry);
      else doc.journalSeq++;
      return { changed: { channels: chans, sizeChanged: false }, newDocIds: [] };
    }

    async function runSize(doc, spec, args, task, replay) {
      const op = args.op;
      checkBitDepth(spec, doc);
      const W = doc.width, H = doc.height, bd = doc.bitDepth;
      const all = doc.channels.map((c, i) => i);
      const params = resolvedParams(doc, spec, args, all, replay);
      const io = makeIo(task, [doc], { channel: args.channel, scratch: scratchOf(spec, infoFor(doc, all, null, [], args.roi), params) });
      let res;
      const guard = guardInputs([doc]);
      try { res = await spec.run(makeView(doc), params, args.roi || null, io); } finally { io.done(); }
      guard();
      task.check();
      if (!res) return { changed: { channels: [], sizeChanged: false }, newDocIds: [], noop: true };
      checkOutput(res, op);
      const old = doc.channels;
      const oldVisible = doc.visible.slice(), oldActive = doc.active;
      // Same shape and the very same arrays: only metadata (calibration, names) changed — the page
      // keeps its selection and its view.
      const calOnly = res.width === W && res.height === H && res.bitDepth === bd && res.channels.length === old.length &&
        res.channels.every((c, i) => c.data === old[i].data);
      const rec = newRecord(doc, op);
      rec.full = fullState(doc);
      rec.calOnly = calOnly;
      // Undo gives the old name back only when THIS step renamed the document (a later Rename is not undoable).
      rec.nameChanged = res.name !== undefined && String(res.name) !== doc.name;
      pushUndo(doc, rec);
      doc.width = res.width; doc.height = res.height; doc.bitDepth = res.bitDepth;
      if (res.calibration !== undefined) doc.calibration = plainClone(res.calibration);
      if (res.name !== undefined) doc.name = String(res.name);
      if (res.provenance !== undefined) doc.provenance = plainClone(res.provenance);
      // A result channel that omits name / colour / display keeps those of the old channel holding the very
      // same array (an Arrange moves arrays), else of the old channel at its index. A display is only kept
      // while the bit depth is unchanged (B&C of a 16-bit range means nothing on 8 bits).
      const oldByData = new Map(old.map((c) => [c.data, c]));
      doc.channels = res.channels.map((c, i) => {
        const prev = oldByData.get(c.data) || old[i];
        const ch = { name: c.name !== undefined ? c.name : ((prev && prev.name) || ''), color: c.color !== undefined ? c.color : ((prev && prev.color) || '#ffffff'), data: c.data };
        if (c.display) ch.display = Object.assign({}, c.display);
        else if (prev && oldByData.get(c.data) === prev && res.bitDepth === bd) ch.display = Object.assign({}, prev.display);
        else ch.display = defaultDisplay(ch, res.bitDepth);
        return ch;
      });
      remapDisplay(doc, old, oldVisible, oldActive);
      if (Array.isArray(res.visible) && res.visible.length === doc.channels.length) doc.visible = res.visible.map(Boolean);
      if (isInt(res.active) && res.active >= 0 && res.active < doc.channels.length) doc.active = res.active;
      doc.rev++;
      doc.layoutRev = doc.rev;
      purgeTiles(doc.id);
      // The journal records what `io.channel` was live, so a replay hands the op the same one.
      if (!replay) noteCommit(doc, { kind: 'run', op, version: spec.version, params, roi: args.roi || null, channel: args.channel === undefined ? null : args.channel });
      else doc.journalSeq++;
      const changed = calOnly
        ? { channels: [], sizeChanged: false, calibration: true }
        : { channels: doc.channels.map((c, i) => i), sizeChanged: true };
      return { changed, newDocIds: [] };
    }

    async function runNewDoc(doc, spec, args, task, extraDocs) {
      checkBitDepth(spec, doc);
      const all = doc.channels.map((c, i) => i);
      const params = resolvedParams(doc, spec, args, all, false, extraDocs);
      const list = [doc].concat(extraDocs);
      const io = makeIo(task, list, { channel: args.channel, scratch: scratchOf(spec, infoFor(doc, all, null, extraDocs, args.roi), params) });
      let res;
      const guard = guardInputs(list);
      try { res = await spec.run(makeView(doc), params, args.roi || null, io); } finally { io.done(); }
      guard();
      task.check();
      if (!Array.isArray(res) || !res.length) throw ijError('IJ_BAD_RESULT', 'result of ' + args.op);
      for (const r of res) checkOutput(r, args.op);
      const created = [];
      for (const r of res) {
        const channels = r.channels.map((c) => makeChannel(c.name, c.color, c.data, r.bitDepth, c.display));
        const nd = buildDoc({
          id: newId(), sessionKey: doc.sessionKey, name: r.name || (doc.name + '-1'), width: r.width, height: r.height, bitDepth: r.bitDepth, channels,
          calibration: plainClone(r.calibration !== undefined ? r.calibration : doc.calibration),
          provenance: r.provenance !== undefined ? plainClone(r.provenance) : Object.assign({}, doc.provenance)
        });
        registerDoc(nd, { baseline: true });
        created.push(nd);
      }
      return { changed: { channels: [], sizeChanged: false }, newDocIds: created.map((d) => d.id), newInfos: created.map(infoOf) };
    }

    // ---- undo / redo / revert ------------------------------------------------------------

    // Apply a record to the document and return the inverse record (swap semantics).
    function swapRecord(doc, rec) {
      const inv = { op: rec.op, at: Date.now(), replayable: rec.replayable, patches: null, full: null, display: null, bytes: 0, calOnly: !!rec.calOnly };
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
        const old = doc.channels;
        const oldVisible = doc.visible.slice(), oldActive = doc.active;
        const bdBefore = doc.bitDepth;
        doc.width = f.width; doc.height = f.height; doc.bitDepth = f.bitDepth;
        doc.calibration = f.calibration;
        // A Rename is not an undo step: the name comes back only when the step itself renamed the document.
        if (f.name !== undefined && rec.nameChanged) { doc.name = f.name; inv.nameChanged = true; }
        if (f.provenance !== undefined) doc.provenance = f.provenance;
        // The channel list is REBUILT: a step may have dropped, added or reordered channels. A channel whose
        // array is one the document holds now keeps its CURRENT display (a Set Scale undone must not undo the
        // brightness the operator set since); the arrays an undo brings back carry the display they had.
        const curByData = new Map(old.map((c) => [c.data, c]));
        doc.channels = f.channels.map((c, i) => {
          const cur = curByData.get(c.data);
          return {
            name: c.name !== undefined ? c.name : ((old[i] && old[i].name) || ''),
            color: c.color !== undefined ? c.color : ((old[i] && old[i].color) || '#ffffff'),
            data: c.data, display: Object.assign({}, cur && f.bitDepth === bdBefore ? cur.display : c.display)
          };
        });
        remapDisplay(doc, old, oldVisible, oldActive, f);
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
      if (rec.full) {
        if (rec.calOnly) return { channels: [], sizeChanged: false, calibration: true };
        return { channels: doc.channels.map((c, i) => i), sizeChanged: true };
      }
      return { channels: rec.patches.map((p) => p.c), sizeChanged: false };
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
      if (top.full) doc.layoutRev = doc.rev;
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
      const metaOf = (i) => (b.rec ? { name: b.rec.channels[i].name, color: b.rec.channels[i].color } : (doc.baselineMeta && doc.baselineMeta[i]) || {});
      const synthetic = {
        op: 'revert', replayable: false,
        full: {
          width: b.width, height: b.height, bitDepth: b.bitDepth, calibration: cal,
          provenance: b.rec ? plainClone(b.rec.provenance) : plainClone(doc.baselineProvenance),
          channels: b.arrays.map((a, i) => Object.assign({
            data: a,
            display: b.rec ? Object.assign({}, b.rec.channels[i].display) : Object.assign({}, doc.baselineDisplays[i])
          }, metaOf(i)))
        }
      };
      if (!b.rec && b.arrays.length === doc.channels.length && b.arrays.every((a, i) => a === doc.channels[i].data)) {
        return { changed: { channels: [], sizeChanged: false }, noop: true };
      }
      const inv = swapRecord(doc, synthetic);
      inv.replayable = false;
      b.arrays.forEach((a, i) => doc.baselineIndex.set(a, i));
      doc.undo.push(inv);
      doc.redo.length = 0;
      doc.rev++;
      doc.layoutRev = doc.rev;
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

    // owner: P6 (wave 2) — measureRow, lineStats, particleImageStats and the doc.stats / doc.particles /
    // doc.profile handlers are the measurement code; no other package edits this file.
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

    // owner: P6 (wave 2)
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

    // One promise chain per document. `fn` starts once every named document's chain has settled and
    // every one of them queues behind it (append-only chains cannot deadlock, whatever the order the
    // callers name their documents in). Inside `fn` the caller re-reads each id from `docs`: a
    // doc.close queued earlier may have removed it (IJ_NO_DOC).
    function lockDocs(list, fn) {
      const p = Promise.all(list.map((d) => d.chain)).then(fn);
      const settled = p.then(() => undefined, () => undefined);
      for (const d of list) d.chain = settled;
      return p;
    }
    function lockDoc(doc, fn) { return lockDocs([doc], fn); }

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
        const clean = doc.savedRev === doc.rev && !doc.held;
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
      const extraIds = Array.isArray(a.docIds) ? a.docIds.filter((id) => id !== a.docId) : [];
      const extra = extraIds.map(getDoc);
      return lockDocs([doc].concat(extra), async () => {
        ctx.task.check();
        // A queued doc.close may have removed one of them while this request waited.
        const live = getDoc(a.docId);
        const others = extraIds.map(getDoc);
        const before = live.rev;
        const r = await executeRun(live, a, ctx.task, false, others);
        if (r.newDocIds && r.newDocIds.length) { finishMutation(); return { rev: live.rev, info: infoOf(live), changed: r.changed, newDocIds: r.newDocIds, newInfos: r.newInfos }; }
        if (live.rev !== before) {
          post({ event: 'invalidate', docId: live.id, channels: r.changed.channels, sizeChanged: r.changed.sizeChanged, calibration: !!r.changed.calibration });
        }
        finishMutation();
        return { rev: live.rev, info: infoOf(live), changed: r.changed, newDocIds: [] };
      });
    };

    // doc.compute { docId, docIds?, op, params, roi, channel, region? } → the op's JSON-able result.
    // Locks every named document, so it runs after any operation already accepted for them.
    handlers['doc.compute'] = (a, ctx) => {
      const spec = specOf(a.op, ['compute']);
      const ids = [a.docId].concat(Array.isArray(a.docIds) ? a.docIds : []).filter((v, i, arr) => arr.indexOf(v) === i);
      const list = ids.map(getDoc);
      return lockDocs(list, async () => {
        const live = ids.map(getDoc);
        const doc = live[0];
        ctx.task.check();
        checkBitDepth(spec, doc);
        const chans = isInt(a.channel) ? [a.channel] : [];
        const others = live.slice(1);
        const params = resolvedParams(doc, spec, { params: a.params }, chans, false, others);
        const io = makeIo(ctx.task, live, { channel: a.channel, region: a.region, transfer: ctx.transfer,
          scratch: scratchOf(spec, infoFor(doc, doc.channels.map((c, i) => i), null, others, a.roi), params) });
        const guard = guardInputs(live, a.op);
        let out;
        try { out = await spec.run(makeView(doc), params, a.roi || null, io); } finally { io.done(); }
        guard();
        return out;
      });
    };

    // doc.estimate { docId, op, params, roi?, channel? } → { needBytes, fits, fitsWithoutUndo, usedBytes, budgetBytes }.
    // A size / newdoc / compute op reports what its scratchBytes says (which includes its output).
    handlers['doc.estimate'] = (a) => {
      const doc = getDoc(a.docId);
      const spec = specOf(a.op);
      checkBitDepth(spec, doc);
      let need, one;
      if (spec.kind === 'pixel') {
        const plan = planPixel(doc, spec, a);
        const params = resolvedParams(doc, spec, a, plan.chans);
        const n = pixelNeed(doc, spec, plan, params);
        need = n.need; one = n.oneChannel;
      } else {
        const others = (Array.isArray(a.docIds) ? a.docIds : []).filter((id) => id !== a.docId).map(getDoc);
        const all = doc.channels.map((c, i) => i);
        const params = resolvedParams(doc, spec, a, all, false, others);
        need = scratchOf(spec, infoFor(doc, all, null, others, a.roi), params);
        one = need;
      }
      return { needBytes: need, fits: couldFit(need), fitsWithoutUndo: couldFit(one), usedBytes: usedBytes(), budgetBytes };
    };

    // Renaming is not an edit: no undo step, no journal entry; the name travels with the next snapshot and the meta.
    handlers['doc.rename'] = (a) => {
      const doc = getDoc(a.docId);
      const name = typeof a.name === 'string' ? a.name.trim() : '';
      if (!name) throw ijError('IJ_BAD_ARGS', 'name');
      doc.name = name;
      doc.dirty = true;
      markMeta(doc);
      scheduleIdle();
      return { info: infoOf(doc) };
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
    // owner: P6 (wave 2)
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

    // owner: P6 (wave 2)
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
    // owner: P6 (wave 2)
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

    // owner: P6 (wave 2)
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
      // The meta is written whole (docs + display of every document the session knows): seed it with what
      // is stored, so the first document restored does not wipe the display stamp of the ones still to come.
      const s0 = sessionOf(a.key, datasetId);
      const storedDocs = (row.meta && row.meta.docs) || {};
      for (const id of Object.keys(dm)) if (!s0.display[id]) s0.display[id] = dm[id];
      for (const id of Object.keys(storedDocs)) if (!s0.docs[id]) s0.docs[id] = storedDocs[id];
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
            // A channel that was the baseline's array points at it by baseIndex (never by its own
            // index: a reorder keeps the arrays but moves them); old records carry no baseIndex.
            const bi = c.baseIndex !== undefined && c.baseIndex !== null ? c.baseIndex : i;
            const d = c.data || (base && base.channels[bi] && base.channels[bi].data);
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
              savedRev: src.savedRev == null ? -1 : src.savedRev, display: src.display, journalSeq: src.journalSeq || 0,
              layoutRev: src.layoutRev || 0
            });
          } finally { transientBytes -= loadedBytes; }
          if (base) {
            doc.baselineIndex = new WeakMap();
            base.channels.forEach((c, i) => doc.baselineIndex.set(c.data, i));
            doc.baselineMeta = base.channels.map((c) => ({ name: c.name, color: c.color }));
            doc.baselineProvenance = plainClone(base.provenance);
            doc.baselineShape = { w: base.width, h: base.height, bd: base.bitDepth };
            doc.baselineStored = true;
          }
          const entries = (rec.journal || []).filter((e) => e.seq > doc.journalSeq).sort((x, y) => x.seq - y.seq);
          const replayTask = makeTask(null);
          let held = false;
          replaying.add(doc);
          try {
          for (let e of entries) {
            // The journal is only a faithful history while it is contiguous: a hole means an
            // entry was never written, and what follows would be applied to the wrong state.
            if (e.seq !== doc.journalSeq + 1) {
              warnings.push({ docId, code: 'IJ_REPLAY_STOPPED', seq: e.seq, reason: 'gap' });
              break;
            }
            try {
              // A large selection was journaled once, under its hash.
              if (e.roiRef) {
                const body = rec.rois && rec.rois[e.roiRef];
                if (!body) throw ijError('IJ_NO_ROI', 'stored selection missing');
                e = Object.assign({}, e, { roi: body });
              }
              if (e.kind === 'run') await executeRun(doc, e, replayTask, true);
              else if (e.kind === 'undo' || e.kind === 'redo') await doUndoRedo(doc, e.kind, true);
              doc.journalSeq = e.seq;
            } catch (err) {
              console.error('[IJEngine] journal replay stopped', err);
              // A stop another start could cure (a package that failed to load, an op whose version changed,
              // too small a budget) HOLDS the stored session: nothing is written over its journal.
              held = REPLAY_HOLD_CODES.has(err && err.code);
              warnings.push({ docId, code: 'IJ_REPLAY_STOPPED', seq: e.seq, cause: String((err && err.code) || ''), held });
              break;
            }
          }
          } finally { replaying.delete(doc); }
          // The display state of the session meta belongs to the channel layout it was stamped with.
          if (dm[docId] && (dm[docId].sig === undefined || dm[docId].sig === channelSig(doc))) {
            const ds = dm[docId];
            if (ds.mode) doc.mode = ds.mode;
            if (isInt(ds.active)) doc.active = ds.active;
            if (Array.isArray(ds.visible) && ds.visible.length === doc.channels.length) doc.visible = ds.visible;
            if (Array.isArray(ds.channels)) ds.channels.forEach((d, i) => { if (doc.channels[i] && d) doc.channels[i].display = Object.assign({}, doc.channels[i].display, d); });
          }
          doc.snapshotRev = doc.rev;
          if (held) {
            // Held: the stored baseline, snapshot and journal stay exactly as they are (a later start that
            // can replay them restores everything); what the operator does meanwhile is unprotected, and
            // the page says so.
            doc.held = true; doc.protected = false; doc.dirty = false;
            emitStorageError('IJ_REPLAY_HELD', docId);
          } else if (!doc.baselineStored) writeBaseline(doc);
          docs.set(docId, doc);
          registered.push(docId);
          activeSessionKey = a.key;
          ids.push(docId);
          // A replay that stopped early (and cannot be retried) leaves the document at an earlier state than
          // the stored journal describes. The sequence number moves past every stored entry, so a later
          // commit can never collide with one that was not applied; the snapshot that follows (scheduled
          // after the loop, once the warning is on its way to the page) replaces that journal with the state
          // the operator was told about.
          if (!held && warnings.some((w) => w.docId === docId && w.code === 'IJ_REPLAY_STOPPED') && entries.length) {
            doc.journalSeq = Math.max(doc.journalSeq, entries[entries.length - 1].seq);
          }
          if (!held) doc.dirty = entries.length > 0;
          markMeta(doc);
          post({ event: 'invalidate', docId, channels: doc.channels.map((c, i) => i), sizeChanged: true });
          await ctx.task.tick(ids.length / Math.max(1, docIds.length), 'session.restore');
        }
      } catch (err) {
        // All or nothing for the page: documents this call registered are not left behind unknown.
        for (const id of registered) { docs.delete(id); purgeTiles(id); }
        throw err;
      }
      // The idle snapshot starts only now: a restore of several documents can outlast its 3 s, and the
      // warning of a stopped replay must be on its way to the page before the snapshot replaces the journal.
      if (registered.some((id) => docs.get(id) && docs.get(id).dirty)) scheduleIdle();
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
      const spec = ROOT.IJOpRegistry && typeof a.op === 'string' ? ROOT.IJOpRegistry.get(a.op) : null;
      if (!spec || spec.kind !== 'pixel' || spec.preview === false) throw ijError('IJ_PREVIEW_UNSUPPORTED', 'no preview for this operation');
      checkBitDepth(spec, doc);
      const scalable = spec.preview === 'reduced';
      const W = doc.width, H = doc.height, bd = doc.bitDepth;
      const vx0 = Math.max(0, Math.floor(a.x0)), vy0 = Math.max(0, Math.floor(a.y0));
      const vx1 = Math.min(W, Math.ceil(a.x1)), vy1 = Math.min(H, Math.ceil(a.y1));
      if (!(vx1 > vx0) || !(vy1 > vy0)) throw ijError('IJ_BAD_ARGS', 'region');
      let level = Math.max(0, a.level | 0);
      if (!scalable) level = 0;
      const chans = pixelChannels(doc, spec, a.channel);
      const params = resolvedParams(doc, spec, a, chans);
      const view = makeView(doc);
      const gates = chans.map(() => ({ lo: 0, hi: 1 }));
      const prepareAt = (lv) => chans.map((c, i) => spec.prepare(view, c, params, {
        scale: 1 << lv, range: (cc) => rangeOf(doc, cc), dep,
        check: () => ctx.task.check(),
        tick: async (f, key) => {
          if (superseded()) throw ijError('IJ_SUPERSEDED', 'superseded');
          await ctx.task.tick((i + gates[i].lo + (gates[i].hi - gates[i].lo) * Math.min(1, Math.max(0, Number(f) || 0))) / chans.length, key || ('preview.' + a.op));
        }
      }));
      // The lowest level whose visible region is ≤ 6 Mpx AND whose work window (the region plus the op's apron,
      // which can be far larger than the view: Rotate's is the whole diagonal) is ≤ 12 Mpx. A scalable op
      // climbs until both fit — zoomed in or not; a region op that does not fit asks the operator to zoom in.
      let preps;
      for (;;) {
        const sc = 1 << level;
        preps = prepareAt(level);
        const visible = ((vx1 - vx0) >> level) * ((vy1 - vy0) >> level);
        const lvl = levelDims(W, H, level);
        let window = 0;
        for (const prep of preps) {
          const ax = prep.apron ? prep.apron.x : 0, ay = prep.apron ? prep.apron.y : 0;
          const ww = Math.min(lvl.w, Math.ceil(vx1 / sc) + ax) - Math.max(0, Math.floor(vx0 / sc) - ax);
          const wh = Math.min(lvl.h, Math.ceil(vy1 / sc) + ay) - Math.max(0, Math.floor(vy0 / sc) - ay);
          window = Math.max(window, ww * wh);
        }
        if (visible <= 6e6 && window <= 12e6) break;
        if (!scalable || level >= 12) throw ijError('IJ_PREVIEW_TOO_LARGE', 'preview region too large');
        level++;
      }
      const s = 1 << level;
      const full0 = spec.roi === 'ignore' ? null : roiMask(a.roi || null, W, H);
      const result = { event: 'preview', seq: a.seq, docId: doc.id, level, channels: {}, bitDepth: bd };
      const transfer = [];
      let outBox = null;
      for (let i = 0; i < chans.length; i++) {
        const c = chans[i];
        const prep = preps[i];
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
        const pmask = spec.roi === 'bounds' ? null : mask;
        let rreg = reg;
        if (mask && !spec.outside) {
          const x0 = Math.max(reg.x, mask.x), y0 = Math.max(reg.y, mask.y);
          const x1 = Math.min(reg.x + reg.w, mask.x + mask.w), y1 = Math.min(reg.y + reg.h, mask.y + mask.h);
          rreg = x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
        }
        let out = work;
        if (rreg) {
          const t = { tick: async (f, k) => { if (superseded()) throw ijError('IJ_SUPERSEDED', 'superseded'); await ctx.task.tick(f, k); }, check: () => ctx.task.check() };
          out = await pixelPass(t, ww, wh, bd, work, prep, pmask, rreg, !!spec.outside, (f) => (i + f) / chans.length, 'preview.' + a.op, gates[i]);
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
