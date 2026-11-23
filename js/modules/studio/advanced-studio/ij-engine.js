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
 * Added in wave 3 (PLAN-wave3 §2.6): worker commands of a package (IJOpRegistry.defineCommand; an unknown `cmd` is
 * dispatched to it with `E`, see commandContext), engine.configure { tileCacheBytes }, engine.registerLut,
 * engine.putBlob / engine.dropBlob and doc.import; typed-array params of 64 KiB or more are journaled ONCE per
 * document as a { blobRef, kind } marker (the roiRef mechanism generalised) and a params value { blobRef } is resolved
 * against the blob store before validation; session.putMeta keeps layout, annotations, sync, luts and ext besides the
 * Results / ROI list (each validated by type and size, what does not fit is dropped and named in the answer).
 *
 * Stacks, hyperstacks and the RGB type (DOCS/studio-advanced/stacks/API.md): a document is nZ × nT planes per channel
 * (`channels[c].planes[t * nZ + z]`, every array immutable) and `channels[c].data` is always the plane of the current position
 * (doc.z, doc.t; setPlane / syncData keep it so). A request names the plane it acts on with `pos` and, for a pixel op, the set
 * of planes with `planes` ('current' | 'all' | { z:[a,b], t:[a,b] } | [pi…]); the registry specs say what an op is (`stack`:
 * 'ask' | 'plane' | 'all' | 'whole' | 'each', `rgb`: 'each' | 'gray' | 'whole' | false). A 24-bit RGB document is three 8-bit
 * channels (Red, Green, Blue; nC = 1 for the page). A single-plane document behaves, and is stored and journaled, exactly as before
 * stacks existed; records and journal entries written before them restore as 1 × 1 stacks.
 *
 * Macro runs (DOCS/studio-advanced/macros/INTEGRATION.md §2.6, §2.7): a worker command opens a run with E.macroGroup.begin; every
 * image open then, or born during the run, is HELD until E.macroGroup.end — its steps push no undo record and write no journal entry
 * or snapshot (a crash restores the pre-run state), Undo / Redo refuse IJ_MACRO_GROUP, and the end pushes ONE undo step per image
 * that changed, back to the state saved at begin (a saved state is the last thing memory pressure gives up: that image then has no
 * undo for the run). In batch mode (E.macroGroup.setBatch) an image born is hidden and EPHEMERAL: never a session entry, baseline,
 * journal entry or snapshot, until doc.persist makes it an ordinary image.
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
  const TILE_CACHE_BYTES = 128 * MiB;   // the default; engine.configure { tileCacheBytes } moves it
  const SLICE_MS = 50;
  const IDLE_MS = 3000;
  const MAX_UNDO = 100;
  const MAX_BAND_PIXELS = 4 * 1048576;
  // typed arrays a blob may hold (a params value of another kind is journaled inline, as before)
  const BLOB_KINDS = { Uint8Array, Uint8ClampedArray, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array };
  const BLOB_JOURNAL_BYTES = 65536;     // a typed-array param this size or more is stored once per document
  const BLOB_MAX_BYTES = 64 * MiB;      // one blob (the clipboard cap)
  const META_TOTAL_BYTES = 4 * MiB;     // session.putMeta: the whole ui record
  const META_ANNOT_ITEMS = 10000;       // annotations of one document
  const META_EXT_BYTES = 256 * 1024;    // one package's sessionData
  const META_KEYS = ['results', 'rois', 'measurements', 'windows', 'layout', 'annotations', 'sync', 'luts', 'ext', 'workspace'];
  // the keys of the sessions open together in one workspace (a figure's images and the ones opened from the library beside them)
  const META_WORKSPACE_MAX = 64, META_WORKSPACE_KEY_CHARS = 1024;
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

  // A channel owns its stack: `planes[pi]` (pi = t * nZ + z) are IMMUTABLE arrays and `data` is always the plane of the
  // document's current position (setPlane / syncData keep it so). `planes` given = a stack channel, else one plane.
  function makeChannel(name, color, data, bd, display, planes) {
    const ch = { name: name || '', color: color || '#ffffff', data, planes: planes ? planes.slice() : [data] };
    if (display) ch.display = Object.assign({}, display);
    else {
      ch.display = defaultDisplay(ch, bd);
      // A new channel shows in its own colour, as IJImage.create does.
      try { ch.display.lut = dep('IJLuts').forColor(ch.color); } catch (e) { /* keeps the default LUT */ }
    }
    return ch;
  }

  // ---- stacks (DOCS/studio-advanced/stacks/API.md §2) --------------------------------------------------------
  function planeCountOf(doc) { return doc.nZ * doc.nT; }
  function curPi(doc) { return doc.t * doc.nZ + doc.z; }
  // channels[c].data === channels[c].planes[t*nZ+z], always: called after anything that moved the position or rebuilt a channel.
  function syncData(doc) {
    const pi = curPi(doc);
    for (const c of doc.channels) c.data = c.planes[pi];
  }
  // Swap ONE plane of one channel (the arrays themselves are never written into).
  function setPlane(doc, c, pi, arr) {
    const ch = doc.channels[c];
    ch.planes[pi] = arr;
    if (pi === curPi(doc)) ch.data = arr;
  }
  // The plane index a request position names ({ z, t }; absent = the current one); IJ_BAD_ARGS when out of range.
  function posToPi(doc, pos) {
    if (pos === undefined || pos === null) return curPi(doc);
    if (typeof pos !== 'object') throw ijError('IJ_BAD_ARGS', 'pos');
    const z = pos.z === undefined || pos.z === null ? doc.z : pos.z;
    const t = pos.t === undefined || pos.t === null ? doc.t : pos.t;
    if (!isInt(z) || z < 0 || z >= doc.nZ || !isInt(t) || t < 0 || t >= doc.nT) throw ijError('IJ_BAD_ARGS', 'pos');
    return t * doc.nZ + z;
  }
  function piToPos(doc, pi) { const z = pi % doc.nZ; return { z, t: (pi - z) / doc.nZ }; }
  // The (z,t) set of a request: 'current' | 'all' | { z:[z0,z1], t:[t0,t1] } (inclusive; a missing axis = all of it) | an explicit
  // [pi…] (a replayed journal entry) → ascending list of plane indices.
  function planeSet(doc, planes, pos) {
    const NP = planeCountOf(doc);
    if (planes === undefined || planes === null || planes === 'current') return [posToPi(doc, pos)];
    if (planes === 'all') { const all = []; for (let i = 0; i < NP; i++) all.push(i); return all; }
    if (Array.isArray(planes)) {
      if (!planes.length || planes.some((p) => !isInt(p) || p < 0 || p >= NP)) throw ijError('IJ_BAD_ARGS', 'planes');
      return Array.from(new Set(planes)).sort((a, b) => a - b);
    }
    if (typeof planes === 'object') {
      const rng = (r, n) => {
        if (r === undefined || r === null) return [0, n - 1];
        if (!Array.isArray(r) || r.length !== 2 || !isInt(r[0]) || !isInt(r[1]) || r[0] < 0 || r[1] < r[0] || r[1] >= n) throw ijError('IJ_BAD_ARGS', 'planes range');
        return r;
      };
      const zr = rng(planes.z, doc.nZ), tr = rng(planes.t, doc.nT);
      const out = [];
      for (let t = tr[0]; t <= tr[1]; t++) for (let z = zr[0]; z <= zr[1]; z++) out.push(t * doc.nZ + z);
      return out;
    }
    throw ijError('IJ_BAD_ARGS', 'planes');
  }
  // The ImageJ stack index (1-based) of the plane at pi for the active channel.
  function stackDims(doc) { return { nC: doc.rgb ? 1 : doc.channels.length, nZ: doc.nZ, nT: doc.nT }; }
  function labelCount(doc) { const d = stackDims(doc); return d.nC * d.nZ * d.nT; }
  function labelOf(doc, c, pi) {
    if (!doc.labels) return null;
    const p = piToPos(doc, pi);
    const n = dep('IJStack').stackIndex(stackDims(doc), doc.rgb ? 0 : c, p.z, p.t) - 1;
    const v = doc.labels[n];
    return typeof v === 'string' && v !== '' ? v : null;
  }
  // `changed.planes` (which planes an edit touched: [pi…] or 'all') is only reported for a document that has more than one: a
  // single-plane document's answer is what it always was (an absent `planes` means "all of them").
  function planesField(doc, v) { return planeCountOf(doc) > 1 ? { planes: v } : {}; }
  // The bytes of every plane of every channel (info.bytes; the budget dedupes by array identity itself).
  function planeBytes(doc) {
    let bytes = 0;
    for (const c of doc.channels) for (const a of c.planes) bytes += a.byteLength;
    return bytes;
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
  // `pi` = the plane the op acts on (default: the document's current one). Every channel carries `data` (that plane) AND
  // `planes` (a frozen copy of the list of every plane — read-only like `data`); the view says where it stands (z, t).
  // `active` = the channel the request named (its `channel`, which the journal keeps): it wins over doc.active, which is
  // display state — never journaled, and lagging the page through the setDisplay coalescer.
  function makeView(doc, pi, active) {
    const p = pi === undefined || pi === null ? curPi(doc) : pi;
    const channels = doc.channels.map((c) => Object.freeze({
      data: c.planes[p], planes: Object.freeze(c.planes.slice()), name: c.name, color: c.color, display: Object.freeze(Object.assign({}, c.display))
    }));
    const z = p % doc.nZ;
    return Object.freeze({
      id: doc.id, name: doc.name, width: doc.width, height: doc.height, bitDepth: doc.bitDepth,
      calibration: doc.calibration ? Object.freeze(Object.assign({}, doc.calibration)) : doc.calibration,
      provenance: doc.provenance ? Object.freeze(Object.assign({}, doc.provenance)) : doc.provenance,
      channels: Object.freeze(channels), active: Number.isInteger(active) && active >= 0 && active < doc.channels.length ? active : doc.active, mode: doc.mode,
      nC: doc.rgb ? 1 : doc.channels.length, nZ: doc.nZ, nT: doc.nT, z, t: (p - z) / doc.nZ,
      hyperstack: !!doc.hyperstack, rgb: !!doc.rgb, labels: doc.labels ? Object.freeze(doc.labels.slice()) : null,
      visible: Array.isArray(doc.visible) ? Object.freeze(doc.visible.slice()) : null
    });
  }

  // The luminance of an RGB document's plane (IJStack.grayPlane, ImageJ's TypeConverter.convertRGBToByte). One entry is kept per
  // document, keyed on its revision, the plane and the weighting, so a measure + a histogram + a preview read one conversion.
  function grayPlaneOf(doc, pi, weighted) {
    const key = doc.rev + ':' + pi + ':' + (weighted ? 1 : 0);
    if (doc.grayCache && doc.grayCache.key === key) return doc.grayCache.data;
    const ch = doc.channels;
    const data = dep('IJStack').grayPlane(ch[0].planes[pi], ch[1].planes[pi], ch[2].planes[pi], !!weighted);
    doc.grayCache = { key, data };
    return data;
  }
  // The same luminance as ColorProcessor.getPixelValue gives it, UNROUNDED: (float)(r*rw + g*gw + b*bw) with the weights of the Conversions option
  // (1/3 each, or 0.299 / 0.587 / 0.114). ColorStatistics.calculateMoments (Skewness, Kurtosis of an RGB measurement) reads these floats.
  function grayLumOf(doc, pi, weighted) {
    const key = doc.rev + ':' + pi + ':' + (weighted ? 1 : 0);
    if (doc.lumCache && doc.lumCache.key === key) return doc.lumCache.data;
    const ch = doc.channels, R = ch[0].planes[pi], G = ch[1].planes[pi], B = ch[2].planes[pi];
    const rw = weighted ? 0.299 : 1 / 3, gw = weighted ? 0.587 : 1 / 3, bw = weighted ? 0.114 : 1 / 3;
    const data = new Float32Array(R.length);
    for (let i = 0; i < data.length; i++) data[i] = R[i] * rw + G[i] * gw + B[i] * bw;
    doc.lumCache = { key, data };
    return data;
  }
  // What a compute / newdoc op with `rgb: 'gray'` (and every measurement) sees on an RGB document: ONE 8-bit grey channel. With
  // `whole` the channel's `planes` hold the luminance of every plane (not cached, built here), else only the plane at `pi`.
  function makeGrayView(doc, pi, weighted, whole) {
    const p = pi === undefined || pi === null ? curPi(doc) : pi;
    const data = grayPlaneOf(doc, p, weighted);
    let planes = [data];
    if (whole) {
      const S = dep('IJStack'), ch = doc.channels;
      planes = [];
      for (let i = 0; i < planeCountOf(doc); i++) planes.push(i === p ? data : S.grayPlane(ch[0].planes[i], ch[1].planes[i], ch[2].planes[i], !!weighted));
    }
    const z = p % doc.nZ;
    return Object.freeze({
      id: doc.id, name: doc.name, width: doc.width, height: doc.height, bitDepth: 8,
      calibration: doc.calibration ? Object.freeze(Object.assign({}, doc.calibration)) : doc.calibration,
      provenance: doc.provenance ? Object.freeze(Object.assign({}, doc.provenance)) : doc.provenance,
      channels: Object.freeze([Object.freeze({ data, planes: Object.freeze(planes), name: 'Gray', color: '#ffffff', display: Object.freeze({ min: 0, max: 255, lut: null, invert: false }) })]),
      active: 0, mode: 'gray',
      nC: 1, nZ: doc.nZ, nT: doc.nT, z, t: (p - z) / doc.nZ, hyperstack: !!doc.hyperstack, rgb: false, labels: doc.labels ? Object.freeze(doc.labels.slice()) : null
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
      kind: 'pixel', version: 1, stack: 'ask', rgb: 'each',
      // A 32-bit image inverts about its DISPLAY range (FloatProcessor.invert reads getMin()/getMax()); the range is not journaled,
      // so it is copied into the params (a replay gives the same pixels).
      resolve(view, params, chans) {
        if (view.bitDepth !== 32) return null;
        const p = Object.assign({}, params);
        p.ranges = Object.assign({}, p.ranges);
        for (const c of chans) {
          const d = view.channels[c].display;
          if (!p.ranges[c] && d && Number.isFinite(d.min) && Number.isFinite(d.max)) p.ranges[c] = { min: d.min, max: d.max };
        }
        return p;
      },
      prepare(view, c, p, ctx) {
        if (view.bitDepth === 32) {
          // FloatProcessor.process(INVERT): v2 = max2 - (v1 - min2), every step a float; the data range only when no display range is set.
          const r = (p.ranges && p.ranges[c]) || ctx.range(c);
          return { apron: noApron(), fn: (src) => dep('IJOps').invert(src, { min: r.min, max: r.max }).data };
        }
        return { apron: noApron(), fn: (src) => dep('IJOps').invert(src, { fullRange: p.fullRange === true }) };
      }
    });
    def('math', {
      kind: 'pixel', version: 1, stack: 'ask', rgb: 'each',
      prepare(view, c, p) {
        if (typeof p.op !== 'string') throw ijError('IJ_BAD_ARGS', 'math op');
        if (p.op !== 'abs') needNumber(p.value, 'math value');
        return { apron: noApron(), fn: (src) => dep('IJOps').math(src, p.op, p.value, null) };
      }
    });
    def('fill', {
      kind: 'pixel', version: 1, stack: 'ask', rgb: 'each',
      prepare(view, c, p) { needNumber(p.value, 'fill value'); return { apron: noApron(), fn: (src) => dep('IJOps').fill(src, null, p.value) }; }
    });
    def('clear', {
      kind: 'pixel', version: 1, stack: 'ask', rgb: 'each',
      prepare(view, c, p) { needNumber(p.value, 'clear value'); return { apron: noApron(), fn: (src) => dep('IJOps').clear(src, null, p.value) }; }
    });
    def('clearOutside', {
      kind: 'pixel', version: 1, stack: 'ask', rgb: 'each', outside: true, needsRoi: true,
      prepare(view, c, p) { needNumber(p.value, 'clear value'); return { apron: noApron(), fn: (src) => dep('IJOps').fill(src, null, p.value) }; }
    });
    def('applyLut', {
      kind: 'pixel', version: 1, stack: 'ask', rgb: 'each', display: true,
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
      kind: 'pixel', version: 1, stack: 'ask', rgb: 'each', preview: 'reduced',
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
      kind: 'pixel', version: 1, stack: 'ask', rgb: 'each', preview: 'reduced',
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
      kind: 'pixel', version: 1, stack: 'ask', rgb: false,
      prepare(view, c, p) {
        if (view.bitDepth !== 8) throw ijError('IJ_NOT_BINARY', 'binary operations need an 8-bit mask');
        const IJBinary = dep('IJBinary');
        const op = p.op;
        if (!['erode', 'dilate', 'open', 'close', 'fillHoles', 'outline'].includes(op)) throw ijError('IJ_BAD_ARGS', 'binary op');
        const o = { iterations: p.iterations > 0 ? Math.floor(p.iterations) : 1, count: p.count > 0 ? Math.floor(p.count) : 1 };
        // Binary Options (version 1, additive): `padEdges` = "Pad edges when eroding" (Prefs.padEdges), `foreground` = the object
        // value, 255 or 0 (Binary.run: "foreground = blackBackground ? 255 : 0; if (ip.isInvertedLut()) foreground = 255 − foreground"),
        // one number or one per channel. Absent = the v1 behaviour (255 objects, outside = background).
        if (p.padEdges !== undefined && typeof p.padEdges !== 'boolean') throw ijError('IJ_BAD_ARGS', 'padEdges');
        if (p.padEdges === true) o.padEdges = true;
        const fgOf = Array.isArray(p.foreground) ? p.foreground[c] : p.foreground;
        if (fgOf !== undefined && fgOf !== 255 && fgOf !== 0) throw ijError('IJ_BAD_ARGS', 'foreground');
        if (fgOf === 0) o.foreground = 0;
        if (o.iterations > 100 || o.count > 8) throw ijError('IJ_BAD_ARGS', 'iterations / count');
        // Rows a result pixel depends on: erode/dilate 1 per iteration, open/close
        // twice that, outline 1. fillHoles is a global flood fill: one whole band.
        const reach = op === 'fillHoles' ? 0 : (op === 'open' || op === 'close' ? 2 * o.iterations : (op === 'outline' ? 1 : o.iterations));
        return { whole: op === 'fillHoles', apron: { x: reach, y: reach }, fn: (src) => IJBinary[op](src, o) };
      }
    });
    def('flipH', { kind: 'pixel', version: 1, stack: 'ask', rgb: 'each', preview: false, prepare() { return { whole: true, apron: noApron(), fn: (src) => dep('IJOps').flipH(src) }; } });
    def('flipV', { kind: 'pixel', version: 1, stack: 'ask', rgb: 'each', preview: false, prepare() { return { whole: true, apron: noApron(), fn: (src) => dep('IJOps').flipV(src) }; } });

    // ---- size operations: the document gets new arrays, possibly another shape
    def('crop', {
      kind: 'size', version: 1, stack: 'all', rgb: 'each',
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
      kind: 'size', version: 1, stack: 'all', rgb: 'each',
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
      kind: 'size', version: 1, stack: 'all', rgb: false,
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
      kind: 'newdoc', version: 1, stack: 'plane', rgb: 'gray',
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
      kind: 'newdoc', version: 1, stack: 'plane', rgb: 'each',
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
      if (!d) { d = { baseline: null, snapshot: null, journal: [], rois: {}, blobs: {} }; s.docs.set(id, d); }
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
          // The engine writes a large selection (and a large typed-array param) again, after a snapshot, with the
          // first entry that needs it.
          d.rois = {};
          d.blobs = {};
        }
      },
      // A journal entry or a meta patch never creates a session: only a stored document does,
      // so a session that lists is always one that can be restored. A journal entry for a
      // session that is gone fails, which leaves the document unprotected until its next snapshot.
      async putJournal(key, entry, roiBody, blobBodies) {
        const s = sess(key, false);
        if (!s) throw ijError('IJ_STORAGE_FAILED', 'no such session');
        const d = docRec(s, entry.docId);
        d.journal.push(cloneValue(entry));
        if (roiBody) d.rois[roiBody.hash] = cloneValue(roiBody.roi);
        if (blobBodies) for (const b of blobBodies) d.blobs[b.hash] = { kind: b.kind, data: b.data.slice() };
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
            rois: parts.includes('journal') ? cloneValue(d.rois) : {},
            blobs: parts.includes('journal') ? cloneValue(d.blobs) : {}
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
        for (const s of sessions.values()) for (const d of s.docs.values()) { count(d.baseline); count(d.snapshot); count(d.journal); count(d.rois); count(d.blobs); }
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
    // One array → its out-of-line form, and back. A record of a stack holds `planes: [{ data } | { sameAsBaseline, baseIndex }]` per
    // channel, each plane its own Blob (a plane is the unit that stays far below the limit); a single-plane record keeps the
    // flat `{ data, blob, dataType, length }` channel of the first versions.
    const blobOf = (o) => (o && o.data
      ? Object.assign({}, o, { data: null, blob: new ROOT.Blob([o.data]), dataType: o.data.constructor.name, length: o.data.length })
      : o);
    async function unblob(c) {
      if (!c || !c.blob) return;
      const T = TYPED[c.dataType];
      if (!T) throw ijError('IJ_STORAGE_FAILED', 'stored channel of unknown type ' + c.dataType);
      const data = new T(await c.blob.arrayBuffer());
      if (data.length !== c.length) throw ijError('IJ_STORAGE_FAILED', 'stored channel truncated');
      c.data = data;
      delete c.blob;
    }
    function toStored(snap) {
      return Object.assign({}, snap, {
        channels: snap.channels.map((c) => {
          const o = blobOf(c);
          return Array.isArray(c.planes) ? Object.assign({}, o, { planes: c.planes.map(blobOf) }) : o;
        })
      });
    }
    async function fromStored(rec) {
      if (!rec || !Array.isArray(rec.channels)) return rec;
      for (const c of rec.channels) {
        await unblob(c);
        if (Array.isArray(c.planes)) for (const p of c.planes) await unblob(p);
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
            // and the typed-array params of those entries ('blob:<hash>' keys, stored as Blobs)
            tx.objectStore('journal').delete(range([key, snap.docId, 'blob:'], [key, snap.docId, 'blob:\uffff']));
          }
          touchSession(tx.objectStore('sessions'), key, snap.provenance && snap.provenance.datasetId, null, true);
        });
      },
      putJournal(key, entry, roiBody, blobBodies) {
        return run(['sessions', 'journal'], 'readwrite', (tx, out) => {
          tx.objectStore('journal').put(entry, [key, entry.docId, entry.seq]);
          if (roiBody) tx.objectStore('journal').put({ kind: 'roi', docId: entry.docId, hash: roiBody.hash, roi: roiBody.roi }, [key, entry.docId, 'roi:' + roiBody.hash]);
          // a Blob is stored out of line (the same reason as the channel pixels, see toStored)
          if (blobBodies) for (const b of blobBodies) {
            tx.objectStore('journal').put({ kind: 'blob', docId: entry.docId, hash: b.hash, bkind: b.kind, length: b.data.length, blob: new ROOT.Blob([b.data]) }, [key, entry.docId, 'blob:' + b.hash]);
          }
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
        if (v) for (const id of Object.keys(v.docs)) {
          await fromStored(v.docs[id].baseline); await fromStored(v.docs[id].snapshot);
          const bl = v.docs[id].blobs || {};
          for (const hash of Object.keys(bl)) {
            const rec = bl[hash];
            const T = BLOB_KINDS[rec.bkind];
            if (!T || !rec.blob) { delete bl[hash]; continue; }
            const data = new T(await rec.blob.arrayBuffer());
            if (data.length !== rec.length) delete bl[hash]; else bl[hash] = { kind: rec.bkind, data };
          }
        }
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
            const slot = (id) => docs[id] || (docs[id] = { baseline: null, snapshot: null, journal: [], rois: {}, blobs: {} });
            if (docsReq) for (const r of docsReq.result) if (parts.includes(r.kind)) slot(r.docId)[r.kind] = r;
            if (jReq) for (const e of jReq.result) {
              if (e.kind === 'roi') slot(e.docId).rois[e.hash] = e.roi;
              else if (e.kind === 'blob') slot(e.docId).blobs[e.hash] = e;   // decoded by load()
              else slot(e.docId).journal.push(e);
            }
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
    // The tile cache budget (engine.configure moves it) and the blob store (engine.putBlob / typed-array params).
    let tileCacheBytes = opts.tileCacheBytes > 0 ? opts.tileCacheBytes : TILE_CACHE_BYTES;
    const blobs = new Map();          // ref → { ref, kind, data, bytes, docs:Set<docId>, at }
    const blobRefOf = new WeakMap();  // typed array → ref, for the arrays the store holds (no re-hash at commit)
    // The macro run in progress (E.macroGroup, DOCS/studio-advanced/macros/INTEGRATION.md §2.6): one undo step per image it changes.
    // docs: docId → { pre: fullState | null (dropped for memory), born, dropped, rev0 }. lastMacroRun answers a repeated end().
    let macroRun = null;
    let lastMacroRun = null;

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
          doc.roiWritten = new Set(); doc.blobWritten = new Set();
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
        if (r.full) for (const c of r.full.channels) addChannel(c);
        if (r.group) for (const g of r.group) addRec(g);
      };
      const addChannel = (c) => { if (c.planes) for (const a of c.planes) add(a); else add(c.data); };
      for (const d of budgetDocs()) {
        for (const c of d.channels) addChannel(c);
        for (const r of d.undo) addRec(r);
        for (const r of d.redo) addRec(r);
        if (d.baselineData) for (const a of d.baselineData) add(a);
        if (d.grayCache) add(d.grayCache.data);
      }
      for (const t of tiles.map.values()) add(t.img.data);
      for (const b of blobs.values()) add(b.data);
      // the state a macro run restores on undo: the arrays the documents no longer hold stay in memory until the run ends
      if (macroRun) for (const e of macroRun.docs.values()) if (e.pre) for (const c of e.pre.channels) addChannel(c);
      for (const p of projects.values()) total += p.estimate;
      return total + transientBytes;
    }

    function recBytes(r) {
      let n = 0;
      if (r.patches) for (const p of r.patches) n += p.data.byteLength;
      if (r.full) for (const c of r.full.channels) { if (c.planes) for (const a of c.planes) n += a.byteLength; else n += c.data.byteLength; }
      if (r.group) for (const g of r.group) n += recBytes(g);
      return n;
    }

    function dropTiles() {
      tiles.map.clear();
      tiles.bytes = 0;
      // the luminance of an RGB plane is a cache too
      for (const d of budgetDocs()) d.grayCache = null;
    }

    // The blobs no document has used yet (nothing refers to them): given up when memory is short. A blob a preview refers to is
    // pinned (a floating paste is still on screen): only engine.dropBlob gives that one up.
    function dropUnusedBlobs() {
      for (const [ref, b] of Array.from(blobs)) if (!b.docs.size && !b.pinned) { blobs.delete(ref); }
    }

    // The cached pyramid levels of a document (of the planes `pis` only when given). A cached level is only ever served for the
    // plane array it was built from (an array is immutable), so a stale entry can never answer; this gives the memory back.
    function purgeTiles(docId, pis) {
      for (const [k, t] of tiles.map) {
        if (t.docId === docId && (!pis || pis === 'all' || pis.indexOf(t.pi) >= 0)) { tiles.map.delete(k); tiles.bytes -= t.img.data.byteLength; }
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
        for (const c of d.channels) for (const a of c.planes) seen.add(a);
        if (d.baselineData) for (const a of d.baselineData) seen.add(a);
      }
      let reclaimable = tiles.bytes;
      const add = (a) => { if (a && !seen.has(a)) { seen.add(a); reclaimable += a.byteLength; } };
      // a blob no document has used yet (a preview's clipboard, a cancelled paste) is given up like a cached tile
      for (const b of blobs.values()) if (!b.docs.size && !b.pinned) add(b.data);
      for (const d of budgetDocs()) if (d.grayCache) add(d.grayCache.data);
      const addRec = (r) => {
        if (r.patches) for (const p of r.patches) add(p.data);
        if (r.full) for (const c of r.full.channels) { if (c.planes) for (const a of c.planes) add(a); else add(c.data); }
        if (r.group) for (const g of r.group) addRec(g);
      };
      for (const d of budgetDocs()) {
        for (const r of d.undo) addRec(r);
        for (const r of d.redo) addRec(r);
      }
      if (macroRun) for (const e of macroRun.docs.values()) if (e.pre) for (const c of e.pre.channels) for (const a of c.planes) add(a);
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
      dropUnusedBlobs();
      while (usedBytes() + extra > budgetBytes) {
        let best = null;
        for (const d of budgetDocs()) {
          for (const stack of [d.undo, d.redo]) {
            if (stack.length && (!best || stack[0].at < best.stack[0].at)) best = { stack, doc: d };
          }
        }
        if (!best) {
          // last resort before refusing: the saved state of a macro run, the one that frees most first (its image gets no undo for the run)
          if (!dropMacroPre()) break;
          continue;
        }
        best.stack.shift();
      }
      if (usedBytes() + extra > budgetBytes) {
        throw ijError('IJ_OVER_BUDGET', 'not enough memory for this operation', { needBytes: extra, usedBytes: usedBytes(), budgetBytes });
      }
    }

    // Gives up the saved pre-run state that frees the most memory (they were all taken at the same moment); false when none is left.
    function dropMacroPre() {
      if (!macroRun) return false;
      const live = new Set();
      for (const d of budgetDocs()) {
        for (const c of d.channels) for (const a of c.planes) live.add(a);
        if (d.baselineData) for (const a of d.baselineData) live.add(a);
        for (const st of [d.undo, d.redo]) for (const r of st) for (const a of recArrays(r)) live.add(a);
      }
      let best = null, bestBytes = -1;
      for (const e of macroRun.docs.values()) {
        if (!e.pre) continue;
        let n = 0;
        const seen = new Set();
        for (const c of e.pre.channels) for (const a of c.planes) if (!live.has(a) && !seen.has(a)) { seen.add(a); n += a.byteLength; }
        if (n > bestBytes) { best = e; bestBytes = n; }
      }
      if (!best) return false;
      best.pre = null;
      best.dropped = true;
      return true;
    }
    function recArrays(r) {
      const out = [];
      if (r.patches) for (const p of r.patches) out.push(p.data);
      if (r.full) for (const c of r.full.channels) { if (c.planes) for (const a of c.planes) out.push(a); else out.push(c.data); }
      if (r.group) for (const g of r.group) for (const a of recArrays(g)) out.push(a);
      return out;
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
    // A stack's dimensions belong to the layout (a display stamped for 3 planes means nothing on 5); a single-plane document
    // keeps the signature of the first versions, so the sessions stored before stacks still match.
    function channelSig(doc) {
      return doc.channels.length + '|' + doc.channels.map((c) => c.name).join('\u0001') + '|' + (doc.layoutRev || 0) +
        (planeCountOf(doc) > 1 ? '|' + doc.nZ + 'x' + doc.nT : '');
    }

    function displayStateOf(doc) {
      const st = {
        sig: channelSig(doc),
        mode: doc.mode, active: doc.active, visible: doc.visible.slice(),
        channels: doc.channels.map((c) => ({ min: c.display.min, max: c.display.max, lut: c.display.lut, invert: c.display.invert }))
      };
      if (planeCountOf(doc) > 1) st.pos = { z: doc.z, t: doc.t };
      return st;
    }

    function markMeta(doc) {
      // a document a macro run holds writes its meta when the run ends; a batch image of a run never has a session entry
      if (!storageOn || doc.held || doc.macroHold || doc.ephemeral) return;
      const s = sessions.get(doc.sessionKey);
      if (!s) return;
      s.docs[doc.id] = { name: doc.name, rev: doc.rev, saved: doc.savedRev === doc.rev };
      if (doc.hidden) s.docs[doc.id].hidden = true;
      s.display[doc.id] = displayStateOf(doc);
      if (s.metaQueued) return;
      s.metaQueued = true;
      enqueue(async () => {
        s.metaQueued = false;
        await storage.putMeta(s.key, { datasetId: s.datasetId, docs: plainClone(s.docs), display: plainClone(s.display) });
      }, null);
    }

    // p.channels[c] = { name, color, display, data, planes? } — a channel without `planes` is one plane (nZ = nT = 1). The
    // planes of every channel are checked here (the one place a document is born), and `data` follows the position.
    function buildDoc(p) {
      const n = p.channels.length;
      const nZ = p.nZ === undefined ? 1 : p.nZ, nT = p.nT === undefined ? 1 : p.nT;
      if (!isInt(nZ) || nZ < 1 || !isInt(nT) || nT < 1) throw ijError('IJ_BAD_ARGS', 'stack dimensions');
      const NP = nZ * nT;
      for (const c of p.channels) {
        if (!Array.isArray(c.planes)) c.planes = [c.data];
        if (c.planes.length !== NP) throw ijError('IJ_BAD_ARGS', 'planes of a channel');
      }
      if (p.rgb && (n !== 3 || p.bitDepth !== 8)) throw ijError('IJ_BAD_ARGS', 'rgb image');
      const z = isInt(p.z) ? Math.min(nZ - 1, Math.max(0, p.z)) : 0, t = isInt(p.t) ? Math.min(nT - 1, Math.max(0, p.t)) : 0;
      const doc = {
        id: p.id, sessionKey: p.sessionKey, name: p.name, width: p.width, height: p.height, bitDepth: p.bitDepth,
        channels: p.channels, calibration: p.calibration, provenance: p.provenance || {},
        nZ, nT, z, t, labels: Array.isArray(p.labels) ? p.labels.slice() : null, hyperstack: !!p.hyperstack, rgb: !!p.rgb,
        rev: p.rev || 0, savedRev: p.savedRev == null ? -1 : p.savedRev,
        mode: p.rgb ? 'composite' : ((p.display && p.display.mode) || (n > 1 ? 'composite' : 'gray')),
        active: (p.display && p.display.active) || 0,
        visible: p.rgb ? new Array(3).fill(true) : ((p.display && p.display.visible) || new Array(n).fill(true)),
        undo: [], redo: [], chain: Promise.resolve(), grayCache: null, groupDepth: 0, groupRecs: null,
        baselineIndex: new WeakMap(), baselineData: null, baselineShape: null, baselineMeta: null, baselineProvenance: null, baselineStored: false,
        layoutRev: p.layoutRev || 0, roiWritten: new Set(), blobWritten: new Set(), hidden: !!p.hidden,
        journalSeq: p.journalSeq || 0, snapshotRev: 0, dirty: false, protected: storageOn,
        unjournaledRev: -1, pendingBaseline: null,
        rangeCache: null
      };
      if (doc.labels && doc.labels.length !== labelCount(doc)) doc.labels = null;
      syncData(doc);
      // born during a macro run: held like the images the run started with (no undo of its own, written when the run ends);
      // in batch mode a hidden, ephemeral image that the page closes at the end unless the macro shows it
      if (macroRun && !macroRun.closing && !p.restore) {
        doc.macroHold = true;
        if (macroRun.batch) { doc.hidden = true; doc.ephemeral = true; }
        macroRun.docs.set(doc.id, { pre: null, born: true, dropped: false, rev0: doc.rev });
      }
      return doc;
    }

    function sessionKeyFor(provenance, id) {
      return (provenance && provenance.sessionKey) || ('local:' + id);
    }

    function registerDoc(doc, o) {
      docs.set(doc.id, doc);
      const s = sessionOf(doc.sessionKey, doc.provenance && doc.provenance.datasetId);
      activeSessionKey = doc.sessionKey;
      if (o && o.baseline && !doc.macroHold) writeBaseline(doc);
      markMeta(doc);
      scheduleIdle();
      return s;
    }

    function recordOf(doc, kind) {
      const same = kind === 'snapshot' && doc.baselineStored && doc.baselineShape &&
        doc.baselineShape.w === doc.width && doc.baselineShape.h === doc.height && doc.baselineShape.bd === doc.bitDepth;
      const NP = planeCountOf(doc);
      return {
        kind, docId: doc.id, rev: doc.rev, journalSeq: doc.journalSeq, savedRev: doc.savedRev, layoutRev: doc.layoutRev,
        name: doc.name, width: doc.width, height: doc.height, bitDepth: doc.bitDepth, hidden: !!doc.hidden,
        nZ: doc.nZ, nT: doc.nT, z: doc.z, t: doc.t, labels: doc.labels ? doc.labels.slice() : null, hyperstack: !!doc.hyperstack, rgb: !!doc.rgb,
        calibration: plainClone(doc.calibration), provenance: plainClone(doc.provenance),
        display: displayStateOf(doc),
        // A channel that still IS one of the baseline's arrays is stored as a reference to that
        // baseline channel (baseIndex) — never by its own index: an Arrange / reorder keeps the
        // arrays but moves them. The baseline's arrays are numbered c * NP + pi (writeBaseline). A single-plane document keeps
        // the flat channel record of the first versions; a stack stores one entry per plane.
        channels: doc.channels.map((c) => {
          if (NP > 1) {
            return {
              name: c.name, color: c.color, display: Object.assign({}, c.display),
              planes: c.planes.map((a) => {
                const k = same ? doc.baselineIndex.get(a) : undefined;
                return k !== undefined ? { sameAsBaseline: true, baseIndex: k } : { data: a };
              })
            };
          }
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
      for (const c of rec.channels) {
        if (c.data) n += c.data.byteLength;
        if (c.planes) for (const p of c.planes) if (p.data) n += p.data.byteLength;
      }
      return n;
    }

    function writeBaseline(doc) {
      if (doc.ephemeral) return;
      // The baseline's arrays are numbered c * NP + pi (NP = nZ * nT): the flat list `baselineData`, and the index a stored record's
      // `baseIndex` points at.
      const NP = planeCountOf(doc);
      doc.baselineIndex = new WeakMap();
      doc.channels.forEach((c, i) => c.planes.forEach((a, pi) => doc.baselineIndex.set(a, i * NP + pi)));
      doc.baselineMeta = doc.channels.map((c) => ({ name: c.name, color: c.color }));
      doc.baselineProvenance = plainClone(doc.provenance);
      doc.baselineShape = { w: doc.width, h: doc.height, bd: doc.bitDepth, nZ: doc.nZ, nT: doc.nT, rgb: !!doc.rgb, hyperstack: !!doc.hyperstack, labels: doc.labels ? doc.labels.slice() : null };
      doc.baselineData = [];
      for (const c of doc.channels) for (const a of c.planes) doc.baselineData.push(a);
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
      // held by a macro run: the stored state stays the pre-run one until the run ends (a crash restores that); a batch image never is
      if (doc.macroHold || doc.ephemeral) return queue;
      const rec = recordOf(doc, 'snapshot');
      const bytes = recDataBytes(rec);
      // The snapshot drops the stored selections of the entries it covers: the entries committed
      // from now on write the bodies they need again.
      doc.roiWritten = new Set(); doc.blobWritten = new Set();
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
      // a batch image of a macro is never stored; one a run holds is stored as it was before the run until the run ends
      return [...docs.values()].filter((d) => !d.ephemeral && !d.macroHold && (d.dirty || !d.protected || (d.pendingBaseline && !d.baselineStored))).map((d) => d.id);
    }

    const ROI_REF_BYTES = 65536;

    // ---- blobs: typed arrays the params of an op may carry (PLAN-wave3 §2.6) ----------------------------

    // Two independent 32-bit lanes over the bytes (a word at a time when aligned) + the kind + the size: a stored body
    // is shared by every entry with the same reference, so a collision would replay the wrong bytes silently.
    function hashBlob(arr, kind) {
      const n = arr.byteLength;
      const u8 = new Uint8Array(arr.buffer, arr.byteOffset, n);
      let h = 0x811c9dc5, g = 0x9e3779b9;
      for (let k = 0; k < kind.length; k++) { const c = kind.charCodeAt(k); h = Math.imul(h ^ c, 0x01000193) >>> 0; g = Math.imul(g ^ c, 0x5bd1e995) >>> 0; }
      let i = 0;
      if ((u8.byteOffset & 3) === 0) {
        const w = new Uint32Array(u8.buffer, u8.byteOffset, n >> 2);
        for (; i < w.length; i++) { const x = w[i]; h = Math.imul(h ^ x, 0x01000193) >>> 0; g = Math.imul(g ^ x, 0x5bd1e995); g = (g ^ (g >>> 15)) >>> 0; }
        i <<= 2;
      }
      for (; i < n; i++) { const b = u8[i]; h = Math.imul(h ^ b, 0x01000193) >>> 0; g = Math.imul(g ^ b, 0x5bd1e995); g = (g ^ (g >>> 15)) >>> 0; }
      return (h >>> 0).toString(16).padStart(8, '0') + (g >>> 0).toString(16).padStart(8, '0') + '-' + n;
    }

    function blobRefFor(arr) {
      let ref = blobRefOf.get(arr);
      if (!ref) { ref = hashBlob(arr, arr.constructor.name); blobRefOf.set(arr, ref); }
      return ref;
    }

    const isBlobArray = (v) => ArrayBuffer.isView(v) && !(v instanceof DataView) && !!BLOB_KINDS[v.constructor.name];

    // `v` with every { blobRef } marker replaced by the typed array `lookup(ref)` returns (copy on write: untouched
    // branches are returned as they are, typed arrays are never walked into).
    function resolveBlobs(v, lookup, depth) {
      if (v === null || typeof v !== 'object' || ArrayBuffer.isView(v)) return v;
      const d = depth || 0;
      if (d > 8) return v;
      if (Array.isArray(v)) {
        if (v.length > 64 && typeof v[0] !== 'object') return v;
        let out = null;
        for (let i = 0; i < v.length; i++) {
          const r = resolveBlobs(v[i], lookup, d + 1);
          if (r !== v[i]) { if (!out) out = v.slice(); out[i] = r; }
        }
        return out || v;
      }
      if (typeof v.blobRef === 'string' && Object.keys(v).every((k) => k === 'blobRef' || k === 'kind' || k === 'bytes')) {
        const got = lookup(v.blobRef);
        if (!got) throw ijError('IJ_NO_BLOB', 'stored data missing');
        return got;
      }
      let out = null;
      for (const k of Object.keys(v)) {
        const r = resolveBlobs(v[k], lookup, d + 1);
        if (r !== v[k]) { if (!out) out = Object.assign({}, v); out[k] = r; }
      }
      return out || v;
    }

    // The params of a journal entry with every large typed array replaced by a marker, and the bodies not stored yet.
    function journalBlobs(doc, params) {
      const bodies = [];
      const walk = (v, depth) => {
        if (v === null || typeof v !== 'object') return v;
        if (ArrayBuffer.isView(v)) {
          if (!isBlobArray(v) || v.byteLength < BLOB_JOURNAL_BYTES) return v;
          const ref = blobRefFor(v);
          if (!doc.blobWritten.has(ref)) { doc.blobWritten.add(ref); bodies.push({ hash: ref, kind: v.constructor.name, data: v }); }
          return { blobRef: ref, kind: v.constructor.name };
        }
        if (depth > 8) return v;
        if (Array.isArray(v)) {
          if (v.length > 64 && typeof v[0] !== 'object') return v;
          let out = null;
          for (let i = 0; i < v.length; i++) { const r = walk(v[i], depth + 1); if (r !== v[i]) { if (!out) out = v.slice(); out[i] = r; } }
          return out || v;
        }
        let out = null;
        for (const k of Object.keys(v)) { const r = walk(v[k], depth + 1); if (r !== v[k]) { if (!out) out = Object.assign({}, v); out[k] = r; } }
        return out || v;
      };
      return { params: walk(params, 0), bodies };
    }

    // A { blobRef } of the live store: the array, and the document now holds it (it stays while the document lives).
    // `pin` (a preview: no document) keeps the blob out of the memory reclaim until engine.unpinBlobs / dropBlob.
    function liveBlob(doc, pin) {
      return (ref) => {
        const b = blobs.get(ref);
        if (!b) return null;
        if (doc) { b.docs.add(doc.id); b.used = true; } else if (pin) b.pinned = true;
        return b.data;
      };
    }

    function forgetBlobsOf(docId) {
      for (const [ref, b] of Array.from(blobs)) { b.docs.delete(docId); if (!b.docs.size && b.used) blobs.delete(ref); }
    }

    function noteCommit(doc, entry) {
      doc.dirty = true;
      // a macro run's changes are stored as ONE snapshot when it ends; a batch image of a run never is
      if (doc.macroHold || doc.ephemeral) return;
      doc.journalSeq++;
      if (entry && entry.kind === 'run' && entry.maskRule == null) entry.maskRule = 2;
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
        // A typed-array param of 64 KiB or more (a paste, a burn-in mask) is stored once per document under its hash.
        let blobBodies = null;
        if (entry.params && typeof entry.params === 'object') {
          const jb = journalBlobs(doc, entry.params);
          if (jb.params !== entry.params) entry.params = jb.params;
          if (jb.bodies.length) blobBodies = jb.bodies;
        }
        enqueue(async () => {
          if (!doc.protected) { doc.unjournaledRev = Math.max(doc.unjournaledRev, entry.rev); doc.roiWritten = new Set(); doc.blobWritten = new Set(); return; }
          await storage.putJournal(doc.sessionKey, entry, body, blobBodies);
        }, doc);
      } else if (storageOn) {
        doc.unjournaledRev = doc.rev;
      }
      markMeta(doc);
      scheduleIdle();
    }

    function infoOf(doc) {
      const bytes = planeBytes(doc);
      const dims = stackDims(doc);
      return {
        docId: doc.id, name: doc.name, width: doc.width, height: doc.height, bitDepth: doc.bitDepth, rev: doc.rev,
        // stacks (API.md §4): `bitDepth` stays the storage depth (8 for RGB); `bitDepthIJ` is ImageJ's type (24 for RGB)
        nC: dims.nC, nZ: doc.nZ, nT: doc.nT, z: doc.z, t: doc.t, nSlices: dims.nC * dims.nZ * dims.nT,
        stackIndex: dep('IJStack').stackIndex(dims, doc.rgb ? 0 : doc.active, doc.z, doc.t),
        hyperstack: !!doc.hyperstack, rgb: !!doc.rgb, label: labelOf(doc, doc.active, curPi(doc)), bitDepthIJ: doc.rgb ? 24 : doc.bitDepth,
        channels: doc.channels.map((c) => ({ name: c.name, color: c.color, display: Object.assign({}, c.display) })),
        calibration: doc.calibration, provenance: doc.provenance,
        // the file an image was opened from / saved to by a macro (FILES.md §10.2: virtual strings only)
        file: fileOf(doc),
        mode: doc.mode, active: doc.active, visible: doc.visible.slice(),
        undoDepth: doc.undo.length, redoDepth: doc.redo.length, layoutRev: doc.layoutRev, hidden: !!doc.hidden, ephemeral: !!doc.ephemeral,
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

    function fileOf(doc) {
      const f = doc.provenance && doc.provenance.file;
      return f && typeof f === 'object' && typeof f.dir === 'string' && typeof f.name === 'string'
        ? { dir: f.dir, name: f.name, format: typeof f.format === 'string' ? f.format : null } : null;
    }

    // ── file codecs of the macro file commands (FILES.md §10.2): decode a file's bytes into a stack image, encode a document ──
    const PICTURE_MAX_PIXELS = 268435456;
    const FILE_FORMATS = ['tiff', 'png', 'jpeg', 'gif', 'bmp', 'text', 'zip', 'raw'];
    const asBytes = (b) => (ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : (b && typeof b.byteLength === 'number' ? new Uint8Array(b) : null));
    /** Opener.openTiff(path, n): the n-th image of the file (1-based, ImageJ's stack order: channels fastest, then slices, then frames) alone. */
    function tiffPlane(img, n) {
      const rgb = img.rgb === true;
      const nC = rgb ? 1 : img.channels.length;
      const lists = img.channels.map((c) => (Array.isArray(c.planes) ? c.planes : [c.data]));
      const nP = lists[0].length;
      const count = nC * nP;
      if (!isInt(n) || n < 1 || n > count) throw ijError('IJ_IO_PLANE', 'N out of 1-' + count + ' range', { count, ijText: 'N out of 1-' + count + ' range' });
      const k = n - 1;
      const c = rgb ? 0 : k % nC, pi = rgb ? k : Math.floor(k / nC);
      const pick = (j) => { const ch = img.channels[j]; const o = { data: lists[j][pi], name: ch.name, color: ch.color }; if (ch.display) o.display = Object.assign({}, ch.display); return o; };
      const channels = rgb ? img.channels.map((ch, j) => pick(j)) : [pick(c)];
      const out = { name: img.name, width: img.width, height: img.height, bitDepth: img.bitDepth, calibration: img.calibration, channels };
      if (rgb) out.rgb = true;
      return out;
    }
    /** A picture the browser decodes (PNG / JPEG / GIF / BMP) read in bands of about 1 Mpx through an OffscreenCanvas: grey (every pixel
     *  R = G = B) → one 8-bit channel, colour → a 24-bit RGB image (Opener: convertGrayJpegTo8Bits; IJFileKinds.imageFromRgba's layout). */
    async function decodePicture(bytes, name, check) {
      const cib = ROOT.createImageBitmap, OC = ROOT.OffscreenCanvas;
      if (typeof cib !== 'function' || typeof OC !== 'function') throw ijError('IJ_IO_DECODE', 'no picture decoder');
      let bmp;
      try { bmp = await cib(new Blob([bytes])); } catch (_) { throw ijError('IJ_IO_DECODE', 'picture'); }
      try {
        const w = bmp.width, h = bmp.height;
        if (!(w > 0 && h > 0) || w * h > PICTURE_MAX_PIXELS) throw ijError('IJ_PICTURE_TOO_LARGE', 'picture');
        ensureRoom(w * h * 3);
        const n = w * h, bandH = Math.max(1, Math.min(h, Math.floor(1048576 / w)));
        let g;
        try { g = new OC(w, bandH).getContext('2d', { willReadFrequently: true }); } catch (_) { throw ijError('IJ_PICTURE_TOO_LARGE', 'picture'); }
        if (!g) throw ijError('IJ_IO_DECODE', 'picture');
        const R = new Uint8Array(n), G = new Uint8Array(n), B = new Uint8Array(n);
        let gray = true;
        for (let y0 = 0; y0 < h; y0 += bandH) {
          if (check) check();
          const bh = Math.min(bandH, h - y0);
          g.clearRect(0, 0, w, bandH);
          g.drawImage(bmp, 0, y0, w, bh, 0, 0, w, bh);
          const px = g.getImageData(0, 0, w, bh).data;
          const o = y0 * w;
          for (let i = 0, m = w * bh; i < m; i++) {
            const r = px[i * 4], gg = px[i * 4 + 1], b = px[i * 4 + 2];
            R[o + i] = r; G[o + i] = gg; B[o + i] = b;
            if (r !== gg || gg !== b) gray = false;
          }
        }
        const calibration = { pixelWidth: 1, pixelHeight: 1, unit: 'px' };
        if (gray) return { name, width: w, height: h, bitDepth: 8, calibration, channels: [{ data: R, name: 'C1', color: '#ffffff', display: { min: 0, max: 255, lut: 'Grays', invert: false } }] };
        return { name, width: w, height: h, bitDepth: 8, calibration, rgb: true,
          channels: [[R, 'Red', '#ff0000'], [G, 'Green', '#00ff00'], [B, 'Blue', '#0000ff']].map(([data, lut, color]) => ({ data, name: lut, color, display: { min: 0, max: 255, lut, invert: false } })) };
      } finally { if (bmp && bmp.close) bmp.close(); }
    }
    /** decodeImage(bytes, { name, kind: 'tiff' | 'picture' | 'text', plane }) → stack image (not yet a document). */
    async function decodeImage(input, o, check) {
      const opt = o || {};
      const bytes = asBytes(input);
      if (!bytes || !bytes.byteLength) throw ijError('IJ_BAD_ARGS', 'bytes');
      const name = typeof opt.name === 'string' && opt.name ? opt.name : undefined;
      let img;
      if (opt.kind === 'tiff') {
        ensureRoom(bytes.byteLength * 2);
        const Local = ROOT.IJLocalTiff;
        let compressed = false;
        try { compressed = !!(Local && Local.needsDecoder(bytes)); } catch (_) { compressed = false; }
        img = compressed ? await Local.read(bytes, name, { check: check || (() => {}) }) : dep('IJTiff').read(bytes, name);
        if (opt.plane !== undefined && opt.plane !== null) img = tiffPlane(img, opt.plane);
      } else if (opt.kind === 'picture') {
        const P = ROOT.IJPng;
        // a 16-bit PNG is inflated here: the room for its pixels and its inflated rows is taken before the inflation starts
        const im16 = P && typeof P.decode16 === 'function' ? await P.decode16(bytes, { room: ensureRoom }) : null;
        img = im16 ? Object.assign(im16, { name }) : await decodePicture(bytes, name, check);
      } else if (opt.kind === 'text') {
        const T = dep('IJTextIo');
        const t = T.parseTextImage(bytes);
        const r = T.floatRange(t.data);
        img = { name: name || 'Untitled', width: t.width, height: t.height, bitDepth: 32, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'px' },
          channels: [{ data: t.data, name: 'C1', color: '#ffffff', display: { min: r.min, max: r.max, lut: 'Grays', invert: false } }] };
      } else throw ijError('IJ_BAD_ARGS', 'kind');
      ensureRoom(imageBytes(img));
      return img;
    }

    /** The picture of one plane as ImageJ's getBufferedImage hands it to a writer (PNG_Writer, JpegWriter): a composite = the RGB of its
     *  display (CompositeImage), an RGB image its three planes, a single channel its 8-bit levels through the colour model — an 8-bit image's
     *  display range is baked into the table (ByteProcessor.setMinAndMax), a 16 / 32-bit one is scaled by create8BitImage first. `png16`: a
     *  16-bit image of the default grey LUT stays 16-bit (PNG_Writer.write16gs). → { kind: 'gray8' | 'gray16' | 'palette' | 'rgb', … }. */
    function displayedPicture(doc, pi, png16) {
      const W = doc.width, H = doc.height;
      const R = dep('IJStkRender');
      if (doc.rgb) return { kind: 'rgb', width: W, height: H, planes: doc.channels.map((ch) => ch.planes[pi]) };
      if (doc.channels.length > 1) {
        const list = [];
        const mode = doc.mode;
        if (mode === 'composite') {
          doc.channels.forEach((ch, c) => { if (doc.visible[c] !== false) list.push(R.renderChannel(ch.planes[pi], doc.bitDepth, ch.display, W, H)); });
        } else {
          const ch = doc.channels[Math.min(doc.active, doc.channels.length - 1)];
          const d = mode === 'gray' ? Object.assign({}, ch.display, { lut: 'Grays', invert: false }) : ch.display;
          list.push(R.renderChannel(ch.planes[pi], doc.bitDepth, d, W, H));
        }
        return { kind: 'rgb', width: W, height: H, planes: R.renderComposite(list, W, H) };
      }
      const ch = doc.channels[0];
      const d = ch.display || {};
      const plane = ch.planes[pi];
      const greyLut = (d.lut === undefined || d.lut === null || d.lut === 'Grays') && !d.invert;
      if (png16 && doc.bitDepth === 16 && greyLut) return { kind: 'gray16', width: W, height: H, data: plane };
      let table = R.baseTable(d), data;
      if (doc.bitDepth === 8) { table = R.bakeRange(table, d.min, d.max); data = plane; } else data = R.toByte(plane, doc.bitDepth, d);
      let identity = true;
      for (let i = 0; i < 256 && identity; i++) if (table[i * 3] !== i || table[i * 3 + 1] !== i || table[i * 3 + 2] !== i) identity = false;
      return identity ? { kind: 'gray8', width: W, height: H, data } : { kind: 'palette', width: W, height: H, data, palette: table };
    }
    function pictureRgb(pic) {
      if (pic.kind === 'rgb') return pic.planes;
      const n = pic.width * pic.height, r = new Uint8Array(n), g = new Uint8Array(n), b = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const v = pic.data[i];
        if (pic.kind === 'palette') { const k = v * 3; r[i] = pic.palette[k]; g[i] = pic.palette[k + 1]; b[i] = pic.palette[k + 2]; } else { r[i] = v; g[i] = v; b[i] = v; }
      }
      return [r, g, b];
    }
    /** JpegWriter on the browser's encoder: the displayed picture as RGBA through an OffscreenCanvas, quality 0..100. */
    async function encodeJpeg(pic, quality) {
      const OC = ROOT.OffscreenCanvas;
      if (typeof OC !== 'function' || typeof OC.prototype.convertToBlob !== 'function') throw ijError('IJ_IO_ENCODE', 'no JPEG encoder');
      const W = pic.width, H = pic.height;
      const cv = new OC(W, H);
      const g = cv.getContext('2d');
      if (!g) throw ijError('IJ_IO_ENCODE', 'no JPEG encoder');
      const [r, gg, b] = pictureRgb(pic);
      const im = g.createImageData(W, H);
      const px = im.data;
      for (let i = 0, n = W * H; i < n; i++) { px[i * 4] = r[i]; px[i * 4 + 1] = gg[i]; px[i * 4 + 2] = b[i]; px[i * 4 + 3] = 255; }
      g.putImageData(im, 0, 0);
      const q = Number.isFinite(quality) ? Math.max(0, Math.min(100, Math.round(quality))) : 85;
      let blob;
      try { blob = await cv.convertToBlob({ type: 'image/jpeg', quality: q / 100 }); } catch (_) { throw ijError('IJ_IO_ENCODE', 'jpeg'); }
      if (!blob || blob.type !== 'image/jpeg') throw ijError('IJ_IO_ENCODE', 'jpeg');
      return new Uint8Array(await blob.arrayBuffer());
    }
    /** FileSaver.saveAsRaw / ImageWriter: every plane in ImageJ's stack order (channels fastest, then slices, then frames), big-endian
     *  16-bit, big-endian IEEE 32-bit float, an RGB pixel as its three bytes R, G, B. */
    function encodeRaw(doc) {
      const W = doc.width, H = doc.height, n = W * H, NP = doc.nZ * doc.nT;
      const bpp = doc.rgb ? 3 : doc.bitDepth / 8;
      const lists = doc.rgb ? [null] : doc.channels;
      const out = new Uint8Array(n * bpp * lists.length * NP);
      const dv = new DataView(out.buffer);
      let at = 0;
      for (let pi = 0; pi < NP; pi++) {
        if (doc.rgb) {
          const [r, g, b] = doc.channels.map((ch) => ch.planes[pi]);
          for (let i = 0; i < n; i++) { out[at++] = r[i]; out[at++] = g[i]; out[at++] = b[i]; }
          continue;
        }
        for (const ch of doc.channels) {
          const a = ch.planes[pi];
          if (doc.bitDepth === 8) { out.set(a, at); at += n; } else if (doc.bitDepth === 16) { for (let i = 0; i < n; i++) { dv.setUint16(at, a[i], false); at += 2; } } else { for (let i = 0; i < n; i++) { dv.setFloat32(at, a[i], false); at += 4; } }
        }
      }
      return out;
    }
    /** encodeImage(doc, { format, quality, entryName, pos }) → { bytes, rev } (FILES.md §10.2). */
    function encodeImage(doc, o, ctx) {
      const opt = o || {};
      const format = opt.format;
      if (['tiff', 'png', 'jpeg', 'zip', 'raw'].indexOf(format) < 0) throw ijError('IJ_BAD_ARGS', 'format');
      return lockDoc(doc, async () => {
        const n = planeBytes(doc);
        const extra = n * (format === 'zip' ? 2 : 1) + 65536;
        ensureRoomNoEvict(extra);
        transientBytes += extra;
        try {
          const rev = doc.rev;
          let bytes;
          if (format === 'tiff' || format === 'zip') {
            bytes = dep('IJTiff').write(doc);
            if (format === 'zip') {
              // FileSaver.saveAsZip: one entry named after the title, ".zip" cut, ".tif" added
              let entry = typeof opt.entryName === 'string' && opt.entryName ? opt.entryName : doc.name;
              if (!(typeof opt.entryName === 'string' && opt.entryName)) {
                if (/\.zip$/.test(entry)) entry = entry.substring(0, entry.length - 4);
                if (!/\.tif$/.test(entry)) entry += '.tif';
              }
              bytes = dep('IJRoiCodec').zipStore([{ name: entry, bytes }]);
            }
          } else if (format === 'raw') bytes = encodeRaw(doc);
          else {
            const pi = posToPi(doc, opt.pos);
            const pic = displayedPicture(doc, pi, format === 'png');
            if (format === 'png') bytes = await dep('IJPng').encode(pic);
            else bytes = await encodeJpeg(pic, opt.quality);
          }
          if (ctx) ctx.task.check();
          if (bytes.byteOffset !== 0 || bytes.buffer.byteLength !== bytes.byteLength) bytes = bytes.slice();
          return { bytes, rev };
        } finally { transientBytes -= extra; }
      });
    }
    /** markSaved(doc, { rev, file }): the revision a file holds is what is saved; `file` = FileOrigin (virtual) becomes provenance.file. */
    function markSavedFile(doc, o) {
      const opt = o || {};
      return lockDoc(doc, async () => {
        const rev = isInt(opt.rev) && opt.rev >= 0 ? Math.min(opt.rev, doc.rev) : doc.rev;
        doc.savedRev = rev;
        if (opt.file !== undefined) {
          const f = checkFileOrigin(opt.file);
          const pv = Object.assign({}, doc.provenance || {});
          if (f) pv.file = f; else delete pv.file;
          doc.provenance = pv;
        }
        markMeta(doc);
        return infoOf(doc);
      });
    }
    /** A FileOrigin as the engine keeps it: virtual strings only, never a handle or a machine path. null clears. */
    function checkFileOrigin(f) {
      if (f === null) return null;
      if (!f || typeof f !== 'object' || typeof f.dir !== 'string' || typeof f.name !== 'string' || !f.name || f.dir.charAt(0) !== '/' || f.dir.slice(-1) !== '/') throw ijError('IJ_BAD_ARGS', 'file');
      if (f.format !== undefined && f.format !== null && FILE_FORMATS.indexOf(f.format) < 0) throw ijError('IJ_BAD_ARGS', 'file format');
      const out = { dir: f.dir, name: f.name };
      for (const k of ['rootId', 'root', 'rel']) if (typeof f[k] === 'string') out[k] = f[k];
      if (typeof f.format === 'string') out.format = f.format;
      return out;
    }

    function getChannel(doc, c) {
      if (!isInt(c) || c < 0 || c >= doc.channels.length) throw ijError('IJ_BAD_ARGS', 'channel');
      return doc.channels[c];
    }

    // `pi` = a plane other than the current one (a request's `pos`).
    function channelImage(doc, c, pi) {
      const ch = getChannel(doc, c);
      const img = chImg(doc.width, doc.height, doc.bitDepth, pi === undefined || pi === null ? ch.data : ch.planes[pi]);
      if (ch.lum && (pi === undefined || pi === null)) img.lum = ch.lum; // the luminance of an RGB read, unrounded (measureArea: Skewness / Kurtosis)
      return img;
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

    function rangeOf(doc, c, pi) {
      const p = pi === undefined || pi === null ? curPi(doc) : pi;
      const key = doc.rev + ':' + c + ':' + p;
      if (!doc.rangeCache || doc.rangeCache.key !== key) {
        doc.rangeCache = { key, r: dataRange(doc.channels[c].planes[p]) };
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
      // a plugin filter without DOES_RGB (spec.rgb === false) does not open an RGB image
      if (doc.rgb && spec.rgb === false) throw ijError('IJ_BAD_TYPE', 'this operation does not support RGB images');
    }

    function channelList(doc, channel) {
      if (channel === 'all' || channel == null) return doc.channels.map((c, i) => i);
      getChannel(doc, channel);
      return [channel];
    }

    function pixelChannels(doc, spec, channel) {
      // the three colour planes of an RGB image are one image: a ColorProcessor filter runs on the three (rgb 'each' / 'whole')
      if (doc.rgb) return doc.channels.map((c, i) => i);
      if (spec.channels === 'all') return doc.channels.map((c, i) => i);
      if (spec.channels === 'one') { const c = isInt(channel) ? channel : doc.active; getChannel(doc, c); return [c]; }
      return channelList(doc, channel);
    }

    // What validate / scratchBytes are told: the primary document's shape, the region a pixel op touches
    // and `docs` = the shape of the other documents the request names (Image Calculator, Merge, Coloc).
    function infoFor(doc, chans, reg, others, roi) {
      return {
        width: doc.width, height: doc.height, bitDepth: doc.bitDepth, channels: chans.length, region: reg || null, roi: roi || null,
        nZ: doc.nZ, nT: doc.nT, rgb: !!doc.rgb,
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
    // `commit` false (a preview, doc.compute, a size estimate): a blob it resolves is not held by the document,
    // so a cancelled paste can still give its clipboard up. `pin` (a preview only) keeps the blob out of the memory reclaim while the
    // preview is on screen; engine.unpinBlobs (the page cancelled its preview) or engine.dropBlob ends it.
    // The view an op's `resolve` / `run` is given at plane `pi`: the document itself, or — a spec with rgb 'gray' on an RGB
    // document — its luminance (weighted by params.rgbWeighted, resolved below so the journal and a replay agree).
    function viewFor(doc, spec, pi, params, whole, active) {
      if (doc.rgb && spec.rgb === 'gray') return makeGrayView(doc, pi, !!(params && params.rgbWeighted), !!whole);
      return makeView(doc, pi, active);
    }

    // viewFor for a run: the luminance of EVERY plane of an RGB stack (a `whole` op with rgb 'gray') is a copy of the stack, so its bytes
    // are reserved (and the budget checked) before it is built and given back by `release()` once the op has run.
    function runView(doc, spec, pi, params, whole, active) {
      if (!(whole && doc.rgb && spec.rgb === 'gray')) return { view: viewFor(doc, spec, pi, params, whole, active), release() {} };
      const bytes = planeCountOf(doc) * doc.width * doc.height;
      ensureRoom(bytes);
      transientBytes += bytes;
      let view;
      try { view = viewFor(doc, spec, pi, params, true); } catch (e) { transientBytes -= bytes; throw e; }
      let freed = false;
      return { view, release() { if (!freed) { freed = true; transientBytes -= bytes; } } };
    }

    function resolvedParams(doc, spec, args, chans, replay, others, commit = true, pin = false) {
      let params = resolveBlobs(Object.assign({}, args.params || {}), liveBlob(commit ? doc : null, pin));
      if (doc.rgb && spec.rgb === 'gray') params.rgbWeighted = !!params.rgbWeighted;
      if (spec.validate) spec.validate(params, infoFor(doc, chans, null, others));
      if (spec.resolve && !replay) { const r = spec.resolve(viewFor(doc, spec, posToPi(doc, args.pos), params, false, args.channel), params, chans); if (r) params = r; }
      return params;
    }

    function newRecord(doc, op) {
      return { op, at: Date.now(), replayable: true, bytes: 0, patches: null, full: null, display: null, calOnly: false };
    }

    // Push the undo record of a committed change; the redo stack is dead.
    function pushUndo(doc, rec) {
      // a macro run makes ONE step of its own per image when it ends: the record of each step inside it is let go
      if (doc.macroHold) { doc.redo.length = 0; return; }
      rec.bytes = recBytes(rec);
      doc.undo.push(rec);
      // inside doc.undoGroup.begin / end the steps are collected and folded into ONE composite record at `end`
      if (doc.groupRecs) doc.groupRecs.push(rec);
      else while (doc.undo.length > MAX_UNDO) doc.undo.shift();
      doc.redo.length = 0;
    }

    // Everything a size-kind step changes (arrays are kept by reference; the plane LISTS are copied, setPlane writes into them).
    function fullState(doc) {
      return {
        width: doc.width, height: doc.height, bitDepth: doc.bitDepth, calibration: plainClone(doc.calibration),
        name: doc.name, provenance: plainClone(doc.provenance), mode: doc.mode, active: doc.active, visible: doc.visible.slice(),
        nZ: doc.nZ, nT: doc.nT, z: doc.z, t: doc.t, labels: doc.labels ? doc.labels.slice() : null, hyperstack: !!doc.hyperstack, rgb: !!doc.rgb,
        channels: doc.channels.map((c) => ({ data: c.data, planes: c.planes.slice(), display: Object.assign({}, c.display), name: c.name, color: c.color }))
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

    // The shape of a stack image (API.md §3: a size / newdoc result, doc.import, E.createDoc): checks every plane of every channel
    // and answers { nZ, nT, NP, lists, bytes }. A channel is `{ data }` (one plane) or `{ planes: [...] }`; without nZ / nT the
    // planes make a z-stack (nZ = their number). `code` is the error the caller wants (IJ_BAD_RESULT / IJ_BAD_ARGS).
    function stackShape(r, code, what) {
      const bad = (m) => ijError(code, m + ' of ' + what);
      const Ctor = ctorFor(r.bitDepth);
      const lists = r.channels.map((c) => (c && Array.isArray(c.planes) ? c.planes : [c && c.data]));
      const L = lists[0].length;
      let nZ = r.nZ, nT = r.nT;
      if (nZ === undefined && nT === undefined) { nZ = L; nT = 1; }
      else if (nZ === undefined) nZ = L / nT;
      else if (nT === undefined) nT = L / nZ;
      if (!isInt(nZ) || nZ < 1 || !isInt(nT) || nT < 1 || nZ * nT !== L) throw bad('stack dimensions');
      let bytes = 0;
      for (const list of lists) {
        if (list.length !== L) throw bad('planes');
        for (const a of list) {
          if (!ArrayBuffer.isView(a) || a.constructor.name !== Ctor.name || a.length !== r.width * r.height) throw bad('channel');
          bytes += a.byteLength;
        }
      }
      if (r.rgb === true && (r.channels.length !== 3 || r.bitDepth !== 8)) throw bad('rgb image');
      return { nZ, nT, NP: L, lists, bytes };
    }

    function checkOutput(r, what) {
      if (!r || !isInt(r.width) || r.width < 1 || !isInt(r.height) || r.height < 1 || ![8, 16, 32].includes(r.bitDepth) ||
        !Array.isArray(r.channels) || !r.channels.length) throw ijError('IJ_BAD_RESULT', 'result of ' + what);
      return stackShape(r, 'IJ_BAD_RESULT', what);
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
      for (const d of list) for (const c of d.channels) for (const a of c.planes) arrays.push(a);
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
      // the plane the op acts on (a request's `pos`, else the current one); `planes` / `planeImage` reach any other
      const pi0 = o && o.pi !== undefined && o.pi !== null ? o.pi : (primary ? curPi(primary) : 0);
      return {
        channel: o && o.channel !== undefined ? o.channel : null,
        region: (o && o.region) || null,
        pos: primary ? Object.freeze(piToPos(primary, pi0)) : null,
        planes(c) { return getChannel(primary, c).planes.slice(); },
        planeImage(c, z, t) {
          const ch = getChannel(primary, c);
          if (!isInt(z) || z < 0 || z >= primary.nZ || !isInt(t) || t < 0 || t >= primary.nT) throw ijError('IJ_BAD_ARGS', 'plane');
          return chImg(primary.width, primary.height, primary.bitDepth, ch.planes[t * primary.nZ + z]);
        },
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
        channelImage: (c) => channelImage(primary, c, pi0),
        readDoc(id, pos) {
          if (!ids.has(id)) throw ijError('IJ_BAD_ARGS', 'document not listed in docIds');
          const d = docs.get(id);
          if (!d) throw ijError('IJ_NO_DOC', 'no such document');
          // the plane the page shows for that document (`posOf` of the request) unless the caller names one
          const named = pos !== undefined && pos !== null ? pos : (o && o.posOf ? o.posOf[id] : undefined);
          return makeView(d, posToPi(d, named));
        },
        range: (c) => rangeOf(primary, c, pi0),
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
      // Selection masks follow ImageJ's PolygonFiller since 1.1.0 (`maskRule: 2` on the entry); a journal entry written
      // before that replays a polygon / freehand / wide-line selection with the fill rule it was recorded with.
      if (replay && args.roi && args.maskRule !== 2) args = Object.assign({}, args, { roi: Object.assign({}, args.roi, { fillRule: 1 }) });
      if (spec.kind === 'newdoc') return runNewDoc(doc, spec, args, task, extraDocs || []);
      if (spec.kind === 'size') return runSize(doc, spec, args, task, replay);
      return runPixel(doc, spec, args, task, replay);
    }

    // Does the baseline kept in RAM (`baselineData`, until its storage write ends) still reference this array?
    function retainedByBaseline(doc, arr) { return !!(doc.baselineData && doc.baselineIndex.has(arr)); }

    async function runPixel(doc, spec, args, task, replay) {
      const op = args.op;
      const roi = args.roi || null;
      const W = doc.width, H = doc.height, bd = doc.bitDepth;
      const plan = planPixel(doc, spec, args);
      const { chans, passMask, outside, reg, fullReg } = plan;
      // The (z,t) planes this request processes (DOES_STACKS): resolved to an explicit list, which is what the journal keeps.
      const pi0 = posToPi(doc, args.pos);
      const pis = planeSet(doc, args.planes, args.pos);
      if (spec.stack === 'plane' && pis.length > 1) throw ijError('IJ_BAD_ARGS', 'this operation does not process a stack');
      const nPl = pis.length, nCh = chans.length, total = nPl * nCh;
      const params = resolvedParams(doc, spec, args, chans, replay);
      // ctx.check() / ctx.tick(f, stepKey?) are for a whole-image op: f in [0,1] is the progress of the
      // fn / region call in progress; the engine maps it into the band, the channel and the plane and yields.
      const prepPlane = (pi, k) => {
        const view = makeView(doc, pi);
        const gates = chans.map(() => ({ lo: 0, hi: 1 }));
        const preps = chans.map((c, i) => {
          const gate = gates[i], idx = k * nCh + i;
          return spec.prepare(view, c, params, {
            scale: 1, range: (cc) => rangeOf(doc, cc, pi), dep,
            check: () => task.check(),
            tick: (f, key) => task.tick((idx + gate.lo + (gate.hi - gate.lo) * Math.min(1, Math.max(0, Number(f) || 0))) / total, key || ('op.' + op))
          });
        });
        return { gates, preps };
      };
      // The first plane is prepared before anything is reserved (a bad parameter fails here, as it always did); the others
      // when their turn comes, so the closures of a long stack are never all alive at once.
      const first = prepPlane(pis[0], 0);
      const noUndo = !!args.noUndo;
      // spec.display: true resets the display range of every changed channel; '16/32' only on a 16 / 32-bit image
      const resetsDisplay = spec.display === true || (spec.display === '16/32' && bd !== 8);
      const n = pixelNeed(doc, spec, plan, params);
      // new arrays + patch copies of EVERY plane stay until the commit (undo path); the scratch of the algorithm is per call
      const perPlane = nCh * (plan.chBytes + plan.patchBytes);
      const need = noUndo ? n.oneChannel : perPlane * nPl + Math.max(0, n.need - perPlane);
      ensureRoom(need);
      // Reserved while the operation runs, so an operation on another document sees the
      // headroom this one is about to take; released at commit (the new arrays are counted then).
      transientBytes += need;
      const outs = [];
      let swapped = false;
      const swappedChans = [], swappedPis = [];
      const guard = guardInputs([doc], op);
      const swapPlane = (c, pi, out) => {
        const ch = doc.channels[c];
        setPlane(doc, c, pi, out);
        // A step that resets the display range (resetMinAndMax) keeps the channel's lookup table and its
        // inverted flag: only min and max come from the new data (of the plane on show).
        if (resetsDisplay && pi === curPi(doc)) {
          const d = defaultDisplay(ch, bd), old = ch.display || {};
          ch.display = { min: d.min, max: d.max, lut: old.lut != null ? old.lut : d.lut, invert: old.invert != null ? !!old.invert : d.invert };
        }
      };
      try {
        for (let k = 0; k < nPl; k++) {
          const pi = pis[k];
          const st = k === 0 ? first : prepPlane(pi, k);
          const row = [];
          for (let i = 0; i < nCh; i++) {
            const base = (k * nCh + i) / total, span = 1 / total;
            const out = await pixelPass(task, W, H, bd, doc.channels[chans[i]].planes[pi], st.preps[i], passMask, reg, outside,
              (f) => base + span * f, 'op.' + op, st.gates[i]);
            if (noUndo) {
              // No undo step: each plane replaces its old array at once, which is what lets the
              // step fit. A cancel after the first one leaves the planes already processed changed.
              task.check();
              // The plane being replaced stays in memory while the baseline still holds it (storage unavailable, or its write not finished):
              // the new array is then EXTRA bytes that the one-plane reservation does not cover, so every such swap is checked on its own —
              // BEFORE the history goes, so a refusal at the first plane leaves the document and its undo steps as they were.
              if (retainedByBaseline(doc, doc.channels[chans[i]].planes[pi])) ensureRoom(out.byteLength);
              if (!swapped) { swapped = true; doc.undo.length = 0; doc.redo.length = 0; }
              swapPlane(chans[i], pi, out);
              if (swappedChans.indexOf(chans[i]) < 0) swappedChans.push(chans[i]);
              if (swappedPis.indexOf(pi) < 0) swappedPis.push(pi);
            } else row.push(out);
          }
          if (!noUndo) outs.push(row);
        }
        guard();
        task.check();
      } catch (err) {
        if (swapped) {
          doc.rev++; purgeTiles(doc.id, swappedPis); noteCommit(doc, null); if (storageOn) snapshotNow(doc);
          // The planes already swapped changed for good and the undo history is gone: the page is told
          // (an invalidate now, the document's info with the error) instead of keeping the old pixels.
          post({ event: 'invalidate', docId: doc.id, channels: swappedChans.slice(), sizeChanged: false, planes: swappedPis.slice() });
          err.details = Object.assign({}, err.details, { info: infoOf(doc), changed: Object.assign({ channels: swappedChans.slice(), sizeChanged: false }, planesField(doc, swappedPis.slice())) });
        }
        throw err;
      } finally { transientBytes -= need; }
      // Commit (synchronous: nothing can interleave from here on).
      // The channel a replay must see: a `one`-channel op journals the channel it ran on (the active one
      // may differ at replay time), the others what the request said ('all' when it said nothing).
      const entry = { kind: 'run', op, version: spec.version, params, roi,
        channel: spec.channels === 'one' ? chans[0] : (args.channel == null ? 'all' : args.channel) };
      // a stack's entry names the plane the request stood on and the explicit planes it processed (a single-plane document's
      // entry is what it always was; an entry without them replays on plane 0)
      if (planeCountOf(doc) > 1) { entry.pos = piToPos(doc, pi0); entry.planes = pis.slice(); }
      if (noUndo) {
        entry.noUndo = true;
        doc.rev++;
        purgeTiles(doc.id, pis);
        if (!replay) { noteCommit(doc, entry); if (storageOn) snapshotNow(doc); } else doc.journalSeq++;
        return { changed: Object.assign({ channels: chans, sizeChanged: false }, planesField(doc, pis.slice())), newDocIds: [] };
      }
      const rec = newRecord(doc, op);
      rec.patches = [];
      for (let k = 0; k < nPl; k++) {
        for (let i = 0; i < nCh; i++) {
          const c = chans[i], pi = pis[k], cur = doc.channels[c].planes[pi];
          rec.patches.push({ c, pi, rect: Object.assign({}, reg), data: fullReg ? cur : copyRect(cur, W, reg.x, reg.y, reg.w, reg.h) });
        }
      }
      if (resetsDisplay) {
        rec.display = {};
        for (const c of chans) rec.display[c] = Object.assign({}, doc.channels[c].display);
      }
      for (let k = 0; k < nPl; k++) for (let i = 0; i < nCh; i++) swapPlane(chans[i], pis[k], outs[k][i]);
      pushUndo(doc, rec);
      doc.rev++;
      purgeTiles(doc.id, pis);
      if (!replay) noteCommit(doc, entry);
      else doc.journalSeq++;
      return { changed: Object.assign({ channels: chans, sizeChanged: false }, planesField(doc, pis.slice())), newDocIds: [] };
    }

    // The arrays of a stack image the document does not already hold (what an assembled result adds to the memory).
    function newArrayBytes(doc, lists) {
      const held = new Set();
      for (const c of doc.channels) for (const a of c.planes) held.add(a);
      const seen = new Set();
      let n = 0;
      for (const list of lists) for (const a of list) if (!held.has(a) && !seen.has(a)) { seen.add(a); n += a.byteLength; }
      return n;
    }

    // The channels of a size step's result: one that omits name / colour / display keeps those of the old channel
    // holding the very same array (an Arrange moves arrays), else of the old channel at its index. A display is only kept
    // while the bit depth is unchanged (B&C of a 16-bit range means nothing on 8 bits). `atPi` = the plane `data` shows.
    // `rgb`: the result is an RGB document — a channel without a display of its own shows in its colour (Red / Green / Blue), as a new one does.
    function channelsOfResult(old, res, lists, oldByData, bd, atPi, rgb) {
      return res.channels.map((c, i) => {
        const list = lists[i];
        let hit = null;
        for (const a of list) { const h = oldByData.get(a); if (h) { hit = h; break; } }
        const prev = hit || old[i];
        const ch = {
          name: c.name !== undefined ? c.name : ((prev && prev.name) || ''), color: c.color !== undefined ? c.color : ((prev && prev.color) || '#ffffff'),
          data: list[atPi], planes: list.slice()
        };
        if (c.display) ch.display = Object.assign({}, c.display);
        else if (prev && hit === prev && res.bitDepth === bd) ch.display = Object.assign({}, prev.display);
        else {
          ch.display = defaultDisplay(ch, res.bitDepth);
          if (rgb) { try { ch.display.lut = dep('IJLuts').forColor(ch.color); } catch (e) { /* keeps the default LUT */ } }
        }
        return ch;
      });
    }

    async function runSize(doc, spec, args, task, replay) {
      const op = args.op;
      checkBitDepth(spec, doc);
      const all = doc.channels.map((c, i) => i);
      const params = resolvedParams(doc, spec, args, all, replay);
      const NP = planeCountOf(doc), pi0 = posToPi(doc, args.pos), whole = spec.stack === 'whole';
      // 'all': the op runs once per (z,t), on that plane's view, and the engine assembles the stack; 'whole': one run, every plane in the view.
      const runs = whole ? [pi0] : Array.from({ length: NP }, (_, i) => i);
      const results = [];
      const guard = guardInputs([doc]);
      let heldOut = 0;
      try {
        for (let k = 0; k < runs.length; k++) {
          const io = makeIo(task, [doc], { channel: args.channel, pi: runs[k], posOf: args.posOf, span: runs.length > 1 ? { k, n: runs.length } : null,
            scratch: scratchOf(spec, infoFor(doc, all, null, [], args.roi), params) });
          let r;
          try { r = await spec.run(makeView(doc, runs[k], args.channel), params, args.roi || null, io); } finally { io.done(); }
          task.check();
          results.push(r || null);
          // the results built so far are memory the next run must see taken (they join the document only at the commit)
          if (r && runs.length > 1) {
            const lists = r.channels && Array.isArray(r.channels) ? r.channels.map((c) => [c && c.data].filter((a) => ArrayBuffer.isView(a))) : [];
            const b = newArrayBytes(doc, lists);
            transientBytes += b; heldOut += b;
          }
        }
        guard();
        task.check();
        const missing = results.filter((r) => !r).length;
        if (missing === results.length) return { changed: { channels: [], sizeChanged: false }, newDocIds: [], noop: true };
        if (missing) throw ijError('IJ_SIZE_MISMATCH', 'the planes of the stack do not give the same result');
        return commitSize(doc, spec, args, params, results, whole ? 0 : pi0, whole, replay, pi0);
      } finally { transientBytes -= heldOut; }
    }

    // Commit of a size step: `results[k]` is the result of the run on plane k ('all') or the one stack image ('whole'); `mi` = the
    // result whose metadata (names, colours, display, document fields) is taken.
    function commitSize(doc, spec, args, params, results, mi, whole, replay, pi0) {
      const op = args.op;
      const W = doc.width, H = doc.height, bd = doc.bitDepth;
      const NP = planeCountOf(doc);
      const reqPos = NP > 1 ? piToPos(doc, pi0) : null;
      const res = results[mi];
      const shapes = results.map((r) => checkOutput(r, op));
      let nZ, nT, lists;
      if (whole) { nZ = shapes[0].nZ; nT = shapes[0].nT; lists = shapes[0].lists; }
      else {
        for (let k = 0; k < results.length; k++) {
          const r = results[k];
          if (shapes[k].NP !== 1 || r.width !== res.width || r.height !== res.height || r.bitDepth !== res.bitDepth ||
            r.channels.length !== res.channels.length) throw ijError('IJ_SIZE_MISMATCH', 'the planes of the stack do not give the same result');
        }
        nZ = doc.nZ; nT = doc.nT;
        lists = res.channels.map((c, j) => results.map((r) => r.channels[j].data));
      }
      const old = doc.channels;
      const oldVisible = doc.visible.slice(), oldActive = doc.active;
      const sameDims = nZ === doc.nZ && nT === doc.nT;
      // Same shape and the very same arrays: only metadata (calibration, names) changed — the page
      // keeps its selection and its view.
      const calOnly = res.width === W && res.height === H && res.bitDepth === bd && res.channels.length === old.length && sameDims &&
        lists.every((list, j) => list.every((a, k) => a === old[j].planes[k]));
      const rec = newRecord(doc, op);
      rec.full = fullState(doc);
      rec.calOnly = calOnly;
      // Undo gives the old name back only when THIS step renamed the document (a later Rename is not undoable).
      rec.nameChanged = res.name !== undefined && String(res.name) !== doc.name;
      pushUndo(doc, rec);
      const oldByData = new Map();
      for (const c of old) for (const a of c.planes) if (!oldByData.has(a)) oldByData.set(a, c);
      doc.width = res.width; doc.height = res.height; doc.bitDepth = res.bitDepth;
      doc.nZ = nZ; doc.nT = nT;
      doc.z = Math.min(doc.z, nZ - 1); doc.t = Math.min(doc.t, nT - 1);
      if (res.calibration !== undefined) doc.calibration = plainClone(res.calibration);
      if (res.name !== undefined) doc.name = String(res.name);
      if (res.provenance !== undefined) doc.provenance = plainClone(res.provenance);
      // An RGB document stays one while its result is still three 8-bit channels (a ColorProcessor filter), unless the step says.
      const rgbOut = res.rgb !== undefined ? !!res.rgb : (rec.full.rgb && res.channels.length === 3 && res.bitDepth === 8);
      doc.channels = channelsOfResult(old, res, lists, oldByData, bd, curPi(doc), rgbOut);
      doc.rgb = rgbOut;
      doc.hyperstack = res.hyperstack !== undefined ? !!res.hyperstack : (sameDims ? !!doc.hyperstack : (nZ > 1 && nT > 1));
      const labelsOk = (l) => Array.isArray(l) && l.length === labelCount(doc);
      // a whole-stack result may drop the labels (labels: null) or bring its own; every other step keeps the current ones
      doc.labels = whole && res.labels === null ? null : (whole && labelsOk(res.labels) ? res.labels.slice() : (labelsOk(doc.labels) ? doc.labels : null));
      remapDisplay(doc, old, oldVisible, oldActive);
      // the display mode a stack-shaping step asks for (Stack to Hyperstack / Hyperstack to Stack keep a multichannel image composite, colour or grey)
      if (doc.channels.length > 1 && (res.mode === 'composite' || res.mode === 'color' || res.mode === 'gray')) doc.mode = res.mode;
      if (doc.rgb) { doc.visible = [true, true, true]; doc.mode = 'composite'; }
      if (Array.isArray(res.visible) && res.visible.length === doc.channels.length) doc.visible = res.visible.map(Boolean);
      if (isInt(res.active) && res.active >= 0 && res.active < doc.channels.length) doc.active = res.active;
      doc.rev++;
      doc.layoutRev = doc.rev;
      purgeTiles(doc.id);
      // The journal records what `io.channel` was live, so a replay hands the op the same one; a stack's entry also the
      // position the request stood on (the view of a 'whole' op, io.pos).
      if (!replay) {
        const entry = { kind: 'run', op, version: spec.version, params, roi: args.roi || null, channel: args.channel === undefined ? null : args.channel };
        if (reqPos) entry.pos = reqPos;
        noteCommit(doc, entry);
      } else doc.journalSeq++;
      const changed = calOnly
        ? Object.assign({ channels: [], sizeChanged: false, calibration: true }, planesField(doc, []))
        : Object.assign({
          channels: doc.channels.map((c, i) => i), sizeChanged: true,
          sameGeometry: sameDims && res.width === W && res.height === H && res.bitDepth === bd && lists.every((l) => l.every((a) => oldByData.has(a)))
        }, planesField(doc, 'all'));
      return { changed, newDocIds: [] };
    }

    async function runNewDoc(doc, spec, args, task, extraDocs) {
      checkBitDepth(spec, doc);
      const all = doc.channels.map((c, i) => i);
      const params = resolvedParams(doc, spec, args, all, false, extraDocs);
      const list = [doc].concat(extraDocs);
      const NP = planeCountOf(doc), pi0 = posToPi(doc, args.pos);
      // 'each' runs on every plane unless the request says `planes: 'current'` (ImageJ's "Process entire stack" left unticked / answered No)
      const each = spec.stack === 'each' && args.planes !== 'current', whole = spec.stack === 'whole', gray = doc.rgb && spec.rgb === 'gray';
      const runs = each ? Array.from({ length: NP }, (_, i) => i) : [pi0];
      const guard = guardInputs(list);
      const perRun = [];
      const created = [];
      let heldOut = 0;
      try {
        for (let k = 0; k < runs.length; k++) {
          const io = makeIo(task, list, { channel: gray ? 0 : args.channel, pi: runs[k], posOf: args.posOf, span: runs.length > 1 ? { k, n: runs.length } : null,
            scratch: scratchOf(spec, infoFor(doc, all, null, extraDocs, args.roi), params) });
          let res;
          let rv = null;
          try { rv = runView(doc, spec, runs[k], params, whole, gray ? undefined : args.channel); res = await spec.run(rv.view, params, args.roi || null, io); } finally { io.done(); if (rv) rv.release(); }
          guard();
          task.check();
          if (!Array.isArray(res) || !res.length) throw ijError('IJ_BAD_RESULT', 'result of ' + args.op);
          const shapes = res.map((r) => checkOutput(r, args.op));
          perRun.push({ res, shapes });
          if (runs.length > 1) {
            const b = res.reduce((sum, r, o) => sum + newArrayBytes(doc, shapes[o].lists), 0);
            transientBytes += b; heldOut += b;
          }
        }
        // 'each': one new stack document per output index, its planes the o-th outputs of the runs
        let outs;
        if (each && runs.length > 1) {
          const m = perRun[0].res.length;
          outs = [];
          const mi = runs.indexOf(pi0);
          for (let o = 0; o < m; o++) {
            const ref = perRun[mi].res[o];
            for (const pr of perRun) {
              const r = pr.res[o];
              if (pr.res.length !== m || !r || pr.shapes[o].NP !== 1 || r.width !== ref.width || r.height !== ref.height || r.bitDepth !== ref.bitDepth ||
                r.channels.length !== ref.channels.length) throw ijError('IJ_SIZE_MISMATCH', 'the planes of the stack do not give the same result');
            }
            outs.push(Object.assign({}, ref, {
              nZ: doc.nZ, nT: doc.nT,
              channels: ref.channels.map((c, j) => Object.assign({}, c, { data: undefined, planes: perRun.map((pr) => pr.res[o].channels[j].data) }))
            }));
          }
        } else outs = perRun[0].res;
        for (const r of outs) {
          const sh = checkOutput(r, args.op);
          const channels = r.channels.map((c, j) => makeChannel(c.name, c.color, sh.lists[j][0], r.bitDepth, c.display, sh.lists[j]));
          const rgb = r.rgb !== undefined ? !!r.rgb : (doc.rgb && spec.rgb === 'each' && r.channels.length === 3 && r.bitDepth === 8);
          const sameShape = each && sh.NP === NP;
          const nd = buildDoc({
            id: newId(), sessionKey: doc.sessionKey, name: r.name || (doc.name + '-1'), width: r.width, height: r.height, bitDepth: r.bitDepth, channels,
            nZ: sh.nZ, nT: sh.nT, rgb, labels: Array.isArray(r.labels) ? r.labels : (sameShape ? doc.labels : null),
            hyperstack: r.hyperstack !== undefined ? !!r.hyperstack : (sameShape ? doc.hyperstack : (sh.nZ > 1 && sh.nT > 1)),
            z: sameShape ? doc.z : 0, t: sameShape ? doc.t : 0,
            display: r.mode === 'composite' || r.mode === 'color' || r.mode === 'gray' ? { mode: r.mode, active: isInt(r.active) ? r.active : 0 } : undefined,
            calibration: plainClone(r.calibration !== undefined ? r.calibration : doc.calibration),
            provenance: r.provenance !== undefined ? plainClone(r.provenance) : Object.assign({}, doc.provenance)
          });
          registerDoc(nd, { baseline: true });
          created.push(nd);
        }
      } finally { transientBytes -= heldOut; }
      return { changed: { channels: [], sizeChanged: false }, newDocIds: created.map((d) => d.id), newInfos: created.map(infoOf) };
    }

    // ---- undo / redo / revert ------------------------------------------------------------

    // Apply a record to the document and return the inverse record (swap semantics).
    function swapRecord(doc, rec) {
      if (rec.group) {
        // A composite step (doc.undoGroup): its records were pushed in the order they happened, so they are undone in the reverse
        // order; the inverse lists the inverses in the order they were produced, so applying IT in reverse re-does them in
        // the original order.
        const invs = [];
        for (let i = rec.group.length - 1; i >= 0; i--) invs.push(swapRecord(doc, rec.group[i]));
        const g = { op: rec.op, at: Date.now(), replayable: false, patches: null, full: null, display: null, bytes: 0, calOnly: false, group: invs };
        if (rec.labelKey !== undefined) g.labelKey = rec.labelKey;
        g.bytes = recBytes(g);
        return g;
      }
      const inv = { op: rec.op, at: Date.now(), replayable: rec.replayable, patches: null, full: null, display: null, bytes: 0, calOnly: !!rec.calOnly };
      if (rec.labelStep) inv.labelStep = true;
      if (rec.macro) { inv.macro = true; inv.labelKey = rec.labelKey; }
      if (rec.patches) {
        const W = doc.width, H = doc.height;
        inv.patches = [];
        for (const p of rec.patches) {
          const ch = doc.channels[p.c];
          // a patch without `pi` was made on the only plane there was (a single-plane record of the first versions)
          const pi = p.pi === undefined ? curPi(doc) : p.pi;
          const cur = ch.planes[pi];
          const isFull = p.rect.w === W && p.rect.h === H;
          let curPatch, next;
          if (isFull) { curPatch = cur; next = p.data; }
          else {
            curPatch = copyRect(cur, W, p.rect.x, p.rect.y, p.rect.w, p.rect.h);
            next = cur.slice();
            pasteRect(next, W, p.rect.x, p.rect.y, p.rect.w, p.rect.h, p.data);
          }
          setPlane(doc, p.c, pi, next);
          inv.patches.push({ c: p.c, pi, rect: p.rect, data: curPatch });
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
        // The stack the step started from (a record of the first versions has one plane); the position is not part of an edit,
        // it only has to stay inside the restored dimensions.
        doc.nZ = f.nZ === undefined ? 1 : f.nZ; doc.nT = f.nT === undefined ? 1 : f.nT;
        doc.z = Math.min(doc.z, doc.nZ - 1); doc.t = Math.min(doc.t, doc.nT - 1);
        doc.labels = Array.isArray(f.labels) ? f.labels.slice() : null;
        doc.hyperstack = !!f.hyperstack; doc.rgb = !!f.rgb;
        // A Rename is not an undo step: the name comes back only when the step itself renamed the document.
        if (f.name !== undefined && rec.nameChanged) { doc.name = f.name; inv.nameChanged = true; }
        if (f.provenance !== undefined) doc.provenance = f.provenance;
        // The channel list is REBUILT: a step may have dropped, added or reordered channels. A channel whose
        // array is one the document holds now keeps its CURRENT display (a Set Scale undone must not undo the
        // brightness the operator set since); the arrays an undo brings back carry the display they had.
        const curByData = new Map();
        for (const c of old) for (const a of c.planes) if (!curByData.has(a)) curByData.set(a, c);
        doc.channels = f.channels.map((c, i) => {
          const planes = Array.isArray(c.planes) ? c.planes.slice() : [c.data];
          let cur = null;
          for (const a of planes) { const h = curByData.get(a); if (h) { cur = h; break; } }
          return {
            name: c.name !== undefined ? c.name : ((old[i] && old[i].name) || ''),
            color: c.color !== undefined ? c.color : ((old[i] && old[i].color) || '#ffffff'),
            data: planes[0], planes, display: Object.assign({}, cur && f.bitDepth === bdBefore ? cur.display : c.display)
          };
        });
        syncData(doc);
        remapDisplay(doc, old, oldVisible, oldActive, f);
        if (doc.rgb) { doc.visible = [true, true, true]; doc.mode = 'composite'; }
      }
      inv.bytes = recBytes(inv);
      return inv;
    }

    function swapCost(doc, rec) {
      if (rec.group) return rec.group.reduce((n, g) => n + swapCost(doc, g), 0);
      if (!rec.patches) return 0;
      let n = 0;
      for (const p of rec.patches) {
        if (!(p.rect.w === doc.width && p.rect.h === doc.height)) n += doc.channels[p.c].planes[p.pi === undefined ? curPi(doc) : p.pi].byteLength + p.data.byteLength;
      }
      return n;
    }

    // Every channel of `now` holds only arrays that `before` also held: the channels were only reordered or dropped.
    function sameArrays(before, now) {
      if (!Array.isArray(before)) return false;
      const set = new Set();
      for (const c of before) for (const a of (c.planes || [c.data])) set.add(a);
      return now.every((c) => c.planes.every((a) => set.has(a)));
    }

    function changedOf(rec, beforeSize, doc) {
      if (rec.group) {
        const parts = rec.group.map((g) => changedOf(g, null, doc));
        if (parts.some((p) => p.sizeChanged)) return Object.assign({ channels: doc.channels.map((c, i) => i), sizeChanged: true, sameGeometry: false }, planesField(doc, 'all'));
        const channels = new Set(), planes = new Set();
        let calibration = false, labels = false;
        for (const p of parts) {
          if (p.labels) labels = true;
          for (const c of p.channels) channels.add(c);
          if (p.planes === 'all') for (let i = 0; i < planeCountOf(doc); i++) planes.add(i); else for (const q of p.planes || []) planes.add(q);
          if (p.calibration) calibration = true;
        }
        const out = Object.assign({ channels: Array.from(channels).sort((a, b) => a - b), sizeChanged: false }, planesField(doc, Array.from(planes).sort((a, b) => a - b)));
        if (calibration) out.calibration = true;
        if (labels) out.labels = true;
        return out;
      }
      if (rec.full) {
        if (rec.calOnly) return Object.assign({ channels: [], sizeChanged: false, calibration: true }, planesField(doc, []), rec.labelStep ? { labels: true } : {});
        // `sameGeometry`: the width, height and bit depth did not move and every array is one the document already held (an Arrange reordered the channels): the page
        // refreshes its channel layout but keeps the selection and the view.
        const f = beforeSize && beforeSize.full;
        // the step of a macro run that left the pixel grid as it was (a filter, a pixel loop): the selection, the overlays and the view stay
        const sameGrid = !!(f && f.width === doc.width && f.height === doc.height && f.bitDepth === doc.bitDepth && f.nZ === doc.nZ && f.nT === doc.nT);
        return Object.assign({
          channels: doc.channels.map((c, i) => i), sizeChanged: true,
          sameGeometry: sameGrid && (rec.macro === true ? f.channels.length === doc.channels.length : sameArrays(f.channels, doc.channels))
        }, planesField(doc, 'all'));
      }
      const channels = [], planes = [];
      for (const p of rec.patches) {
        if (channels.indexOf(p.c) < 0) channels.push(p.c);
        const pi = p.pi === undefined ? curPi(doc) : p.pi;
        if (planes.indexOf(pi) < 0) planes.push(pi);
      }
      return Object.assign({ channels, sizeChanged: false }, planesField(doc, planes));
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
      if (top.full || (top.group && top.group.some((g) => g.full))) doc.layoutRev = doc.rev;
      purgeTiles(doc.id);
      const changed = changedOf(top, inv, doc);
      if (replay) { doc.journalSeq++; return changed; }
      if (top.replayable && storageOn && doc.protected) noteCommit(doc, { kind: which });
      else {
        noteCommit(doc, null);
        if (storageOn) snapshotNow(doc);
      }
      return changed;
    }

    // The baseline as a flat list of arrays (numbered c * NP + pi, as a stored record's `baseIndex`) + its shape.
    async function loadBaseline(doc) {
      if (doc.baselineData && doc.baselineShape) {
        const s = doc.baselineShape;
        return { width: s.w, height: s.h, bitDepth: s.bd, arrays: doc.baselineData, rec: null, stack: { nZ: s.nZ || 1, nT: s.nT || 1, rgb: !!s.rgb, hyperstack: !!s.hyperstack, labels: s.labels || null } };
      }
      if (!storageOn) throw ijError('IJ_NO_BASELINE', 'no baseline to revert to');
      await queue;
      const got = await storage.load(doc.sessionKey, { docId: doc.id, parts: ['baseline'] });
      const b = got && got.docs[doc.id] && got.docs[doc.id].baseline;
      if (!b) throw ijError('IJ_NO_BASELINE', 'no baseline to revert to');
      return { width: b.width, height: b.height, bitDepth: b.bitDepth, arrays: flatBaseline(b), rec: b, stack: { nZ: b.nZ || 1, nT: b.nT || 1, rgb: !!b.rgb, hyperstack: !!b.hyperstack, labels: b.labels || null } };
    }

    // The arrays of a stored baseline record, flat (legacy single-plane channels have `data`, a stack's `planes[].data`).
    function flatBaseline(b) {
      const out = [];
      for (const c of b.channels) {
        if (Array.isArray(c.planes)) for (const p of c.planes) out.push(p.data);
        else out.push(c.data);
      }
      return out;
    }

    async function doRevert(doc) {
      const b = await loadBaseline(doc);
      const bytes = b.rec ? b.arrays.reduce((n, a) => n + a.byteLength, 0) : 0;
      ensureRoom(bytes);
      const NPb = b.stack.nZ * b.stack.nT;
      const nCh = b.arrays.length / NPb;
      const cal = b.rec ? plainClone(b.rec.calibration) : plainClone(doc.baselineCal);
      const metaOf = (i) => (b.rec ? { name: b.rec.channels[i].name, color: b.rec.channels[i].color } : (doc.baselineMeta && doc.baselineMeta[i]) || {});
      const synthetic = {
        op: 'revert', replayable: false,
        full: {
          width: b.width, height: b.height, bitDepth: b.bitDepth, calibration: cal,
          provenance: b.rec ? plainClone(b.rec.provenance) : plainClone(doc.baselineProvenance),
          nZ: b.stack.nZ, nT: b.stack.nT, labels: b.stack.labels ? b.stack.labels.slice() : null, hyperstack: b.stack.hyperstack, rgb: b.stack.rgb,
          channels: Array.from({ length: nCh }, (_, i) => {
            const planes = b.arrays.slice(i * NPb, (i + 1) * NPb);
            return Object.assign({
              data: planes[0], planes,
              display: b.rec ? Object.assign({}, b.rec.channels[i].display) : Object.assign({}, doc.baselineDisplays[i])
            }, metaOf(i));
          })
        }
      };
      const curFlat = [];
      for (const c of doc.channels) for (const a of c.planes) curFlat.push(a);
      if (!b.rec && NPb === planeCountOf(doc) && nCh === doc.channels.length && b.arrays.every((a, i) => a === curFlat[i])) {
        return { changed: { channels: [], sizeChanged: false }, noop: true };
      }
      const inv = swapRecord(doc, synthetic);
      inv.replayable = false;
      b.arrays.forEach((a, i) => doc.baselineIndex.set(a, i));
      // inside a macro run the run's own step covers the revert too
      if (!doc.macroHold) doc.undo.push(inv);
      doc.redo.length = 0;
      doc.rev++;
      doc.layoutRev = doc.rev;
      purgeTiles(doc.id);
      noteCommit(doc, null);
      if (storageOn) snapshotNow(doc);
      return { changed: Object.assign({ channels: doc.channels.map((c, i) => i), sizeChanged: true }, planesField(doc, 'all')) };
    }

    // ---- tile pyramid --------------------------------------------------------------------------

    // A level is cached per (document, channel, plane, level) and only served for the very array it was built from: planes are
    // immutable, so the array IS the version — an edit of another plane, or a calibration-only step, keeps the others valid.
    function levelImage(doc, c, level, pi) {
      const p = pi === undefined || pi === null ? curPi(doc) : pi;
      const src = doc.channels[c].planes[p];
      if (level === 0) return chImg(doc.width, doc.height, doc.bitDepth, src);
      const key = doc.id + ':' + c + ':' + p + ':' + level;
      const hit = tiles.map.get(key);
      if (hit && hit.src === src) { tiles.map.delete(key); tiles.map.set(key, hit); return hit.img; }
      if (hit) { tiles.map.delete(key); tiles.bytes -= hit.img.data.byteLength; }
      const prev = levelImage(doc, c, level - 1, p);
      const dims = levelDims(doc.width, doc.height, level);
      const img = chImg(dims.w, dims.h, doc.bitDepth, unwrap(dep('IJOps').downsample2(prev), dims.w * dims.h));
      const bytes = img.data.byteLength;
      if (usedBytes() + bytes <= budgetBytes) {
        tiles.map.set(key, { docId: doc.id, pi: p, src, img });
        tiles.bytes += bytes;
        while (tiles.bytes > tileCacheBytes && tiles.map.size > 1) {
          const first = tiles.map.keys().next().value;
          const t = tiles.map.get(first);
          tiles.map.delete(first);
          tiles.bytes -= t.img.data.byteLength;
        }
      }
      return img;
    }

    // ---- statistics ------------------------------------------------------------------------------

    // owner: P6 (wave 2) — measureRow, particleImageStats and the doc.stats / doc.particles /
    // doc.profile handlers are the measurement code; no other package edits this file. The maths is in
    // ij-proc-roi.js (IJRoiTools, Analyzer.saveResults / measureLength / measurePoint / measureAngle of ImageJ 1.54p);
    // when that package did not load, the basic statistics of the pixels below are still answered.
    const BASE_KEYS = ['area', 'mean', 'stdDev', 'mode', 'min', 'max', 'xCentroid', 'yCentroid', 'xCenterOfMass', 'yCenterOfMass',
      'intDen', 'rawIntDen', 'median', 'skewness', 'kurtosis'];

    // The document as a read (measure, histogram, profile, threshold, particles) sees it at the plane of the request's `pos`: a
    // shallow shim whose channels' `data` is that plane (nothing is copied) and whose position is that plane, so every reader of
    // `doc.channels[c].data` / `curPi(doc)` agrees. An RGB document reads as its luminance (ImageJ measures the brightness;
    // `rgbWeighted` = Edit > Options > Conversions > Weighted RGB conversions): ONE 8-bit channel, `gray: true`.
    function readDoc(doc, a) {
      const pi = posToPi(doc, a && a.pos);
      // `readOf`: where the read stands in the real document (the plane, and its stack size) — what a "Redirect to" image of the same
      // size needs (ImageJ Analyzer.getRedirectImageOrStack sets the redirect to the measured slice).
      const readOf = { pi, nSlices: planeCountOf(doc) * (doc.rgb ? 1 : doc.channels.length), planes: planeCountOf(doc), posOf: (a && a.posOf) || null };
      if (doc.rgb) {
        const data = grayPlaneOf(doc, pi, !!(a && a.rgbWeighted));
        const ch = { name: 'Gray', color: '#ffffff', data, planes: [data], display: { min: 0, max: 255, lut: null, invert: false }, lum: grayLumOf(doc, pi, !!(a && a.rgbWeighted)) };
        return Object.assign({}, doc, { bitDepth: 8, channels: [ch], nZ: 1, nT: 1, z: 0, t: 0, active: 0, visible: [true], mode: 'gray', rgb: false, gray: true, labels: null, rangeCache: null, readOf });
      }
      // ALWAYS a shim with the plane frozen (even at the current plane): a doc.setPosition that lands while a read is suspended at an
      // await swaps `channels[c].data` of the live document, and the read must keep the plane it was asked for.
      const z = pi % doc.nZ;
      return Object.assign({}, doc, { z, t: (pi - z) / doc.nZ, rangeCache: null, readOf,
        channels: doc.channels.map((c) => Object.assign({}, c, { data: c.planes[pi], planes: c.planes.slice() })) });
    }
    // The channel a read asks for (a gray shim has only channel 0).
    function readChannel(doc, a) { return isInt(a.channel) ? (doc.gray ? 0 : a.channel) : doc.active; }

    // The pixels a measurement reads: the image itself or the "Redirect to" image (same size, ImageJ: "Redirect image
    // is not the same size as the current image").
    // `read` = the request's `posOf` ({ docId: {z,t} }) and the plane of the measured read (doc.readOf). A redirect of the SAME stack size
    // is read at the measured plane (Analyzer.getRedirectImageOrStack: "redirect.setSlice(imp.getCurrentSlice())"); another redirect at
    // the plane the page shows for it (`posOf`), else at its current one.
    function redirectPlane(doc, src, redirect) {
      const r = doc.readOf;
      const srcSlices = planeCountOf(src) * (src.rgb ? 1 : src.channels.length);
      if (r && srcSlices > 1 && srcSlices === r.nSlices && planeCountOf(src) === r.planes) return r.pi;
      const p = r && r.posOf ? r.posOf[redirect.docId] : null;
      return p ? posToPi(src, p) : curPi(src);
    }
    function measureSource(doc, c, redirect) {
      if (!redirect || redirect.docId === undefined || redirect.docId === null) return { img: channelImage(doc, c), doc };
      const src = getDoc(redirect.docId);
      if (src.width !== doc.width || src.height !== doc.height) throw ijError('IJ_ROI_REDIRECT_SIZE', 'redirect image size');
      const rc = isInt(redirect.channel) ? redirect.channel : 0;
      return { img: channelImage(src, rc, redirectPlane(doc, src, redirect)), doc: src };
    }
    function finiteNum(v) { return typeof v === 'number' && isFinite(v); }

    // → [row]; one row, except a multi-point selection (one row per point). `keys` are the short keys of IJRoiTools.
    // opts.invertY (Set Measurements › Invert Y coordinates): the Y of the centroid / centre of mass / bounding rectangle / point as
    // Calibration.getY(y, imageHeight) gives it (IJAna.invertY, ij-proc-ana.js).
    function measureRows(doc, c, roi, keys, opts) {
      const rows = measureRowsRaw(doc, c, roi, keys, opts);
      if (opts && opts.invertY) {
        // never silently dropped: without the module the rows would carry the wrong Y
        if (!ROOT.IJAna) throw ijError('IJ_MODULE_MISSING', 'module IJAna is not loaded');
        const cl = calOf(doc); for (const r of rows) ROOT.IJAna.invertY(r, doc.height, cl.ph);
      }
      return rows;
    }
    function measureRowsRaw(doc, c, roi, keys, opts) {
      const IJOps = dep('IJOps'), IJRoi = dep('IJRoi');
      const o = opts || {};
      const want = Array.isArray(keys) && keys.length ? keys : BASE_KEYS;
      const src = measureSource(doc, c, o.redirect);
      const T = ROOT.IJRoiTools;
      if (roi) IJRoi.validate(roi);
      if (!T) {
        const cl = calOf(doc);
        if (roi && (roi.type === 'line' || roi.type === 'polyline')) {
          const len = IJRoi.lineLength(roi, doc.calibration);
          return [roi.type === 'line' ? { length: len, angle: IJRoi.lineAngle(roi) } : { length: len }];
        }
        if (roi && roi.type === 'point') {
          // the basic row: the pixel under the first point, X / Y = the point as drawn (pixel centre) in calibrated units
          const x = Math.floor(roi.points[0][0]), y = Math.floor(roi.points[0][1]);
          if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) throw ijError('IJ_EMPTY_ROI', 'point outside the image');
          const v = src.img.data[y * doc.width + x], px = roi.points[0][0] * cl.pw, py = roi.points[0][1] * cl.ph;
          return [{ n: 1, mean: v, min: v, max: v, median: v, mode: v, stdDev: 0, area: 0, intDen: 0, rawIntDen: v, xCentroid: px, yCentroid: py, xCenterOfMass: px, yCenterOfMass: py }];
        }
        if (roi && !IJRoi.isArea(roi)) throw ijError('IJ_MODULE_MISSING', 'module IJRoiTools is not loaded');
        const mask = roiMask(roi, doc.width, doc.height);
        const row = Object.assign({}, IJOps.statistics(src.img, mask, { calibration: doc.calibration }));
        const b = boundsOf(mask, doc.width, doc.height);
        row.bx = b.x * cl.pw; row.by = b.y * cl.ph; row.bw = b.w * cl.pw; row.bh = b.h * cl.ph;
        if (roi && IJRoi.isArea(roi)) row.perim = IJRoi.perimeter(roi) * cl.pw;
        if (Array.isArray(keys) && keys.length) { const out = {}; for (const k of keys) if (k in row) out[k] = row[k]; return [out]; }
        return [row];
      }
      const thr = o.thr && finiteNum(o.thr.lower) && finiteNum(o.thr.upper) ? { lower: o.thr.lower, upper: o.thr.upper } : null;
      // ImageJ Analyzer.getRedirectStats: "ImageStatistics stats = redirectImp.getStatistics(...)" with redirectImp's
      // calibration (and its threshold, which the page sends): the measured image brings its own.
      const a = { img: src.img, roi: roi || null, cal: src.doc.calibration, keys: want, thr, limit: !!o.limit };
      if (roi && roi.type === 'point') return T.measurePoints(a);
      if (roi && roi.type === 'angle') return [T.measureAngle(a)];
      if (roi && (roi.type === 'line' || roi.type === 'polyline')) return [T.measureLine(a)];
      return [T.measureArea(a)];
    }

    // The document a "Redirect to" names, or null; it must be locked together with the measured one.
    function redirectDoc(redirect, doc) {
      if (!redirect || redirect.docId === undefined || redirect.docId === null) return null;
      const src = getDoc(redirect.docId);
      if (src.width !== doc.width || src.height !== doc.height) throw ijError('IJ_ROI_REDIRECT_SIZE', 'redirect image size');
      return src;
    }

    function measureRow(doc, c, roi, keys, opts) { return measureRows(doc, c, roi, keys, opts)[0]; }

    // Image measurements of one particle: the Set Measurements columns (Mean, Min, Max, IntDen...)
    // of the analysed channel over the particle's own outline, which is a traced polygon
    // (ImageJ perimeter rules). The particle's own area / perimeter / circularity are kept.
    const PARTICLE_OWN = new Set(['area', 'perimeter', 'circularity', 'n', 'xCentroid', 'yCentroid']);
    // Without "Include holes" ImageJ measures only the particle's own pixels: the filled
    // outline limited to the foreground (ParticleAnalyzer measures with the threshold as a
    // LIMIT), so a hole inside the outline never enters Mean / Min / IntDen.
    // owner: P6 (wave 2)
    function particleImageStats(doc, c, outline, includeHoles, keys, redirect, ownMask, thr) {
      const IJOps = dep('IJOps'), IJRoi = dep('IJRoi');
      const roi = { type: 'polygon', points: outline, traced: true };
      const T = ROOT.IJRoiTools;
      const out = {};
      if (redirect && T) {
        // ParticleAnalyzer: "ImageProcessor ip2 = redirectIP!=null?redirectIP:ip;" and "redirectImp.getCalibration()": the
        // particle's pixels are measured in the redirect image; without "Include holes" the particle's own mask (the
        // analysed image's foreground inside the outline) decides which pixels count, not a value range of the redirect.
        let r2 = roi;
        if (!includeHoles && ownMask) r2 = ownMask;
        else if (!includeHoles) {
          const m = IJRoi.mask(roi, doc.width, doc.height);
          if (m && m.data && m.w > 0 && m.h > 0) {
            const sub = new Uint8Array(m.w * m.h), own = doc.channels[c].data;
            for (let yy = 0; yy < m.h; yy++) for (let xx = 0; xx < m.w; xx++) {
              const k = yy * m.w + xx;
              if (m.data[k] && own[(m.y + yy) * doc.width + m.x + xx] !== 0) sub[k] = 1;
            }
            r2 = { type: 'mask', x: m.x, y: m.y, w: m.w, h: m.h, rle: Uint32Array.from(IJRoi.rleEncode(sub)) };
          }
        }
        const row = T.measureArea({ img: redirect.img, roi: r2, cal: redirect.doc.calibration, keys: Array.isArray(keys) && keys.length ? keys.filter((k) => !PARTICLE_OWN.has(k)) : BASE_KEYS.filter((k) => !PARTICLE_OWN.has(k)), thr: null, limit: false });
        for (const k of Object.keys(row)) out[k] = row[k];
        return out;
      }
      if (T && Array.isArray(keys) && keys.length) {
        // the columns Set Measurements ticked, computed as Analyze > Measure computes them on the particle's outline
        const row = T.measureArea({ img: channelImage(doc, c), roi, cal: doc.calibration, keys: keys.filter((k) => !PARTICLE_OWN.has(k)),
          thr: includeHoles ? null : (thr || { lower: 1, upper: 255 }), limit: !includeHoles });
        for (const k of Object.keys(row)) out[k] = row[k];
        if (!includeHoles) {
          // ParticleAnalyzer measures the particle's own mask ("ff.particleAnalyzerFill(x, y, level1, level2, ip2.getMask(), r)": the holes are
          // outside it): the ellipse, the shape ratios, the solidity and the area fraction read that mask, every pixel of which is foreground
          // ("%Area" of a particle is 100). The perimeter and the Feret diameters are those of the traced outline, which `roi` above is.
          if (ownMask) {
            const OUTLINE_KEYS = new Set(['perim', 'circularity', 'feret', 'feretX', 'feretY', 'feretAngle', 'minFeret']);
            const mk = keys.filter((k) => !PARTICLE_OWN.has(k) && !OUTLINE_KEYS.has(k));
            if (mk.length) { const r2 = T.measureArea({ img: channelImage(doc, c), roi: ownMask, cal: doc.calibration, keys: mk, thr: null, limit: false }); for (const k of mk) if (k in r2) out[k] = r2[k]; }
          }
          if (out.areaFraction !== undefined) out.areaFraction = 100;
        }
        return out;
      }
      const box = IJRoi.mask(roi, doc.width, doc.height);
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
      for (const k of Object.keys(st)) if (!PARTICLE_OWN.has(k)) out[k] = st[k];
      return out;
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

    // A stack image (API.md §3) becomes a document: `data` alone = one plane, `planes` = the (z,t) list of a channel (pi = t*nZ + z).
    function addDocFromImage(img, provenance, sessionKey, hidden) {
      const id = newId();
      const bd = img.bitDepth;
      const sh = stackShape(img, 'IJ_BAD_ARGS', 'image');
      const chans = img.channels.map((c, j) => makeChannel(c.name, c.color, sh.lists[j][0], bd, sanitizeDisplay(c.display), sh.lists[j]));
      const doc = buildDoc({
        id, sessionKey: sessionKey || sessionKeyFor(provenance, id), name: img.name || 'image',
        width: img.width, height: img.height, bitDepth: bd, channels: chans,
        nZ: sh.nZ, nT: sh.nT, rgb: img.rgb === true, hyperstack: img.hyperstack === true, labels: Array.isArray(img.labels) ? img.labels : null,
        // a TIFF's `mode=`; the channels shown (an image handed over with some channels switched off)
        display: (() => {
          const d = {};
          if (img.mode === 'composite' || img.mode === 'color' || img.mode === 'gray') d.mode = img.mode;
          if (!img.rgb && Array.isArray(img.visible) && img.visible.length === chans.length) d.visible = img.visible.map((v) => v !== false);
          return Object.keys(d).length ? d : undefined;
        })(),
        calibration: plainClone(img.calibration) || { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' }, provenance, hidden: !!hidden
      });
      registerDoc(doc, { baseline: true });
      return doc;
    }

    // The bytes of the arrays of an image or a stack image (a request not yet checked: only what is there is counted).
    function imageBytes(img) {
      let n = 0;
      for (const c of (img && img.channels) || []) {
        if (c && Array.isArray(c.planes)) { for (const a of c.planes) if (a && a.byteLength) n += a.byteLength; }
        else if (c && c.data && c.data.byteLength) n += c.data.byteLength;
      }
      return n;
    }

    // The image of doc.import / E.createDoc: checked as a request (IJ_BAD_ARGS), never trusted.
    function checkImageArgs(img) {
      if (!img || typeof img !== 'object' || !isInt(img.width) || img.width < 1 || !isInt(img.height) || img.height < 1 ||
        ![8, 16, 32].includes(img.bitDepth) || !Array.isArray(img.channels) || !img.channels.length || img.channels.length > 64) throw ijError('IJ_BAD_ARGS', 'image');
      for (const c of img.channels) {
        if (!c || typeof c !== 'object') throw ijError('IJ_BAD_ARGS', 'image channel');
        if (c.name !== undefined && c.name !== null && (typeof c.name !== 'string' || c.name.length > 255)) throw ijError('IJ_BAD_ARGS', 'channel name');
        if (c.color !== undefined && c.color !== null && !(typeof c.color === 'string' && /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(c.color))) throw ijError('IJ_BAD_ARGS', 'channel color');
      }
      // every plane of every channel: of the bit depth, width * height long (a stack image: API.md §3)
      const sh = stackShape(img, 'IJ_BAD_ARGS', 'image');
      const bytes = sh.bytes;
      if (img.hyperstack !== undefined && typeof img.hyperstack !== 'boolean') throw ijError('IJ_BAD_ARGS', 'hyperstack');
      if (img.rgb !== undefined && typeof img.rgb !== 'boolean') throw ijError('IJ_BAD_ARGS', 'rgb');
      if (img.labels !== undefined && img.labels !== null) {
        const nC = img.rgb === true ? 1 : img.channels.length;
        if (!Array.isArray(img.labels) || img.labels.length !== nC * sh.nZ * sh.nT ||
          img.labels.some((l) => l !== null && (typeof l !== 'string' || l.length > 4096))) throw ijError('IJ_BAD_ARGS', 'labels');
      }
      const cal = img.calibration;
      if (cal !== undefined && cal !== null) {
        if (typeof cal !== 'object' || !(cal.pixelWidth > 0) || !isFinite(cal.pixelWidth) || !(cal.pixelHeight > 0) || !isFinite(cal.pixelHeight) ||
          (cal.unit !== undefined && (typeof cal.unit !== 'string' || cal.unit.length > 64))) throw ijError('IJ_BAD_ARGS', 'calibration');
      }
      return bytes;
    }
    // A display the channel may carry: finite min < max and a look-up table that resolves; anything else is the default.
    function sanitizeDisplay(d) {
      if (!d || typeof d !== 'object' || !isFinite(d.min) || !isFinite(d.max) || typeof d.min !== 'number' || typeof d.max !== 'number' || !(d.min < d.max)) return null;
      const lut = d.lut === undefined || d.lut === null ? null : d.lut;
      if (lut !== null) {
        if (typeof lut !== 'string' && !(lut instanceof Uint8Array)) return null;
        try { const t = dep('IJLuts').get(lut); if (!t || t.length !== 768) return null; } catch (e) { return null; }
      }
      return Object.assign({}, d, { lut });
    }

    const handlers = {};

    // One new plane of NewImage's fill: 'black' (zeros), 'white' (8-bit 255; 16 / 32-bit stay zero and show on an INVERTED lookup
    // table, as NewImage.createShortImage / createFloatImage do) or 'ramp' (the horizontal ramp of NewImage: floor(x*256/w) on 8 bits,
    // floor(x*65536/w + 0.5) on 16, x/w on 32).
    function fillPlane(Ctor, bd, W, H, fill) {
      const out = new Ctor(W * H);
      if (fill === 'white' && bd === 8) out.fill(255);
      else if (fill === 'ramp') {
        const row = new Ctor(W);
        for (let x = 0; x < W; x++) row[x] = bd === 8 ? Math.floor(x * 256.0 / W) : (bd === 16 ? Math.floor(x * 65536.0 / W + 0.5) : x / W);
        for (let y = 0; y < H; y++) out.set(row, y * W);
      }
      return out;
    }

    // doc.create { width, height, bitDepth, channels: [{ name, color }], nZ?, nT?, hyperstack?, rgb?, fill? ('black' | 'white' | 'ramp') }.
    // rgb: true makes the 24-bit RGB type (8-bit, three channels named Red / Green / Blue whatever `channels` says).
    handlers['doc.create'] = (a) => {
      for (const k of ['width', 'height']) if (!isInt(a[k]) || a[k] < 1) throw ijError('IJ_BAD_ARGS', k);
      const Ctor = ctorFor(a.bitDepth);
      const rgb = a.rgb === true;
      const nZ = a.nZ === undefined || a.nZ === null ? 1 : a.nZ, nT = a.nT === undefined || a.nT === null ? 1 : a.nT;
      if (!isInt(nZ) || nZ < 1 || !isInt(nT) || nT < 1) throw ijError('IJ_BAD_ARGS', 'stack dimensions');
      if (a.fill !== undefined && a.fill !== null && !['black', 'white', 'ramp'].includes(a.fill)) throw ijError('IJ_BAD_ARGS', 'fill');
      if (rgb && a.bitDepth !== 8) throw ijError('IJ_BAD_ARGS', 'rgb image');
      const specs = rgb
        ? [{ name: 'Red', color: '#ff0000' }, { name: 'Green', color: '#00ff00' }, { name: 'Blue', color: '#0000ff' }]
        : a.channels;
      if (!Array.isArray(specs) || !specs.length) throw ijError('IJ_BAD_ARGS', 'channels');
      const NP = nZ * nT;
      ensureRoom(a.width * a.height * specs.length * NP * (a.bitDepth / 8));
      const id = newId();
      const provenance = a.provenance || {};
      const fill = a.fill || null;
      // an image made with a fill shows as ImageJ's New Image shows it: the full range of its type (white = inverted table)
      const shown = fill ? { min: 0, max: a.bitDepth === 8 ? 255 : (a.bitDepth === 16 ? 65535 : 1), lut: null, invert: fill === 'white' && a.bitDepth !== 8 } : null;
      const chans = specs.map((c) => {
        const planes = [];
        for (let i = 0; i < NP; i++) planes.push(fillPlane(Ctor, a.bitDepth, a.width, a.height, fill));
        const ch = makeChannel(c.name, c.color, planes[0], a.bitDepth, shown ? Object.assign({}, shown, { lut: undefined }) : undefined, planes);
        if (shown) { try { ch.display.lut = dep('IJLuts').forColor(ch.color); } catch (e) { ch.display.lut = null; } }
        return ch;
      });
      const doc = buildDoc({
        id, sessionKey: sessionKeyFor(provenance, id), name: a.name || 'image', width: a.width, height: a.height,
        bitDepth: a.bitDepth, channels: chans, nZ, nT, rgb, hyperstack: a.hyperstack === true,
        calibration: plainClone(a.calibration) || { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' }, provenance
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
        method: a.method, width: a.width, height: a.height, depth: a.depth, channels: a.channels.length, bandRows, inputBitDepth: a.inputBitDepth
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
        method: a.method, width: a.width, height: a.height, depth: a.depth, channels: a.channels.length, inputBitDepth: a.inputBitDepth
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

    handlers['doc.open'] = async (a, ctx) => {
      if (!a.bytes || !a.bytes.byteLength) throw ijError('IJ_BAD_ARGS', 'bytes');
      ensureRoom(a.bytes.byteLength * 2);
      const name = typeof a.name === 'string' && a.name ? a.name : undefined;
      // A deflate / predictor TIFF (the Download Center writes them) is decoded HERE, strip by strip, never on the page.
      const Local = ROOT.IJLocalTiff;
      let compressed = false;
      try { compressed = !!(Local && Local.needsDecoder(a.bytes)); } catch (_) { compressed = false; }   // a file neither reader takes: IJTiff says why
      let img;
      if (compressed) {
        img = await Local.read(a.bytes, name, { check: () => ctx.task.check() });
        ensureRoom(imageBytes(img));
      } else img = dep('IJTiff').read(a.bytes, name);
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
        // closing is never deferred by a macro run (ImageJ closes at once): the image leaves the run, a batch image is never kept
        if (macroRun) macroRun.docs.delete(doc.id);
        doc.macroHold = false;
        if (doc.ephemeral) a = Object.assign({}, a, { discard: true });
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
        if (!docs.has(doc.id)) forgetBlobsOf(doc.id);
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

    // One op request (doc.run, E.runOp): behind the queues of every document it names. `a.pos` / `a.planes` pick the plane(s)
    // (API.md §3); the page is told which planes changed (`invalidate.planes`: [pi…] or 'all').
    function runRequest(a, task) {
      const doc = getDoc(a.docId);
      const extraIds = Array.isArray(a.docIds) ? a.docIds.filter((id) => id !== a.docId) : [];
      const extra = extraIds.map(getDoc);
      return lockDocs([doc].concat(extra), async () => {
        task.check();
        // A queued doc.close may have removed one of them while this request waited.
        const live = getDoc(a.docId);
        const others = extraIds.map(getDoc);
        const before = live.rev;
        const r = await executeRun(live, a, task, false, others);
        if (r.newDocIds && r.newDocIds.length) {
          // a request that did not come from the page (E.runOp: a macro, a package's worker command) announces the documents it made,
          // so the page adopts them; doc.run's own answer already carries them to the page
          if (a.announce === true && Array.isArray(r.newInfos)) for (const info of r.newInfos) post({ event: 'docCreated', docId: info.docId, info, source: live.id });
          finishMutation(); return { rev: live.rev, info: infoOf(live), changed: r.changed, newDocIds: r.newDocIds, newInfos: r.newInfos }; }
        if (live.rev !== before) {
          post({ event: 'invalidate', docId: live.id, channels: r.changed.channels, sizeChanged: r.changed.sizeChanged, sameGeometry: !!r.changed.sameGeometry, calibration: !!r.changed.calibration, labels: !!r.changed.labels, planes: r.changed.planes === undefined ? 'all' : r.changed.planes });
        }
        finishMutation();
        return { rev: live.rev, info: infoOf(live), changed: r.changed, newDocIds: [] };
      });
    }

    handlers['doc.run'] = (a, ctx) => runRequest(a, ctx.task);

    // doc.compute { docId, docIds?, op, params, roi, channel, region? } → the op's JSON-able result.
    // Locks every named document, so it runs after any operation already accepted for them.
    handlers['doc.compute'] = (a, ctx) => {
      const spec = specOf(a.op, ['compute']);
      if (a.docId === null || a.docId === undefined) {
        // a compute op that declares `docless` runs with no document (view = null): Curve Fitting
        if (spec.docless !== true) throw ijError('IJ_BAD_ARGS', 'this operation needs a document');
        return lockDocs([], async () => {
          ctx.task.check();
          const params = resolveBlobs(Object.assign({}, a.params || {}), liveBlob(null, false));
          const none = { width: 0, height: 0, bitDepth: 0, channels: 0, region: null, roi: null, docs: [] };
          if (spec.validate) spec.validate(params, none);
          const io = makeIo(ctx.task, [], { channel: null, region: null, transfer: ctx.transfer, scratch: scratchOf(spec, none, params) });
          try { return await spec.run(null, params, null, io); } finally { io.done(); }
        });
      }
      const ids = [a.docId].concat(Array.isArray(a.docIds) ? a.docIds : []).filter((v, i, arr) => arr.indexOf(v) === i);
      const list = ids.map(getDoc);
      return lockDocs(list, async () => {
        const live = ids.map(getDoc);
        const doc = live[0];
        ctx.task.check();
        checkBitDepth(spec, doc);
        const chans = isInt(a.channel) ? [a.channel] : [];
        const others = live.slice(1);
        const params = resolvedParams(doc, spec, { params: a.params, pos: a.pos }, chans, false, others, false);
        // the plane the op reads (`pos`); with rgb 'gray' an RGB document is seen as its luminance, one channel (index 0)
        const pi = posToPi(doc, a.pos), whole = spec.stack === 'whole';
        const io = makeIo(ctx.task, live, { channel: doc.rgb && spec.rgb === 'gray' ? 0 : a.channel, region: a.region, transfer: ctx.transfer, pi, posOf: a.posOf,
          scratch: scratchOf(spec, infoFor(doc, doc.channels.map((c, i) => i), null, others, a.roi), params) });
        const guard = guardInputs(live, a.op);
        let out;
        let rv = null;
        try { rv = runView(doc, spec, pi, params, whole, a.channel); out = await spec.run(rv.view, params, a.roi || null, io); } finally { io.done(); if (rv) rv.release(); }
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
        const params = resolvedParams(doc, spec, a, plan.chans, false, undefined, false);
        const n = pixelNeed(doc, spec, plan, params);
        // the new arrays and patches of every plane of `planes` stay until the commit; the algorithm's scratch is per call
        const nPl = planeSet(doc, a.planes, a.pos).length;
        if (spec.stack === 'plane' && nPl > 1) throw ijError('IJ_BAD_ARGS', 'this operation does not process a stack');
        const perPlane = plan.chans.length * (plan.chBytes + plan.patchBytes);
        need = perPlane * nPl + Math.max(0, n.need - perPlane); one = n.oneChannel;
        // without undo each plane replaces its array at once, but one the baseline still holds in RAM is not freed by that: the new
        // arrays of the processed planes then add up (the run re-checks the budget per plane and fails cleanly when it runs out)
        if (doc.baselineData) {
          for (const pi of planeSet(doc, a.planes, a.pos)) for (const c of plan.chans) {
            const old = doc.channels[c].planes[pi];
            if (retainedByBaseline(doc, old)) one += old.byteLength;
          }
        }
      } else {
        const others = (Array.isArray(a.docIds) ? a.docIds : []).filter((id) => id !== a.docId).map(getDoc);
        const all = doc.channels.map((c, i) => i);
        const params = resolvedParams(doc, spec, a, all, false, others, false);
        need = scratchOf(spec, infoFor(doc, all, null, others, a.roi), params);
        one = need;
        // an op run once per plane keeps every result until the commit: one more plane of the document's size per further plane
        if ((spec.kind === 'size' && spec.stack === 'all') || (spec.kind === 'newdoc' && spec.stack === 'each')) {
          const extra = (planeCountOf(doc) - 1) * all.length * doc.width * doc.height * (doc.bitDepth / 8);
          need += extra;
        }
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

    // doc.duplicate { docId, channels?, roi?, name?, range?: { c: [c0, c1], z: [z0, z1], t: [t0, t1] } } — the ranges are 0-based and
    // inclusive (a missing axis = all of it); `channels` (a list) wins over range.c. The whole stack by default, as
    // Image > Duplicate with "Duplicate stack" ticked; the plane on show stays on show when it is in the range.
    function duplicateDoc(doc, a) {
      const W = doc.width, H = doc.height;
      const rg = a.range && typeof a.range === 'object' ? a.range : {};
      const rng = (r, n, what) => {
        if (r === undefined || r === null) return [0, n - 1];
        if (!Array.isArray(r) || r.length !== 2 || !isInt(r[0]) || !isInt(r[1]) || r[0] < 0 || r[1] < r[0] || r[1] >= n) throw ijError('IJ_BAD_ARGS', 'range ' + what);
        return r;
      };
      const cr = rng(rg.c, doc.channels.length, 'c'), zr = rng(rg.z, doc.nZ, 'z'), tr = rng(rg.t, doc.nT, 't');
      const sel = Array.isArray(a.channels) ? a.channels : Array.from({ length: cr[1] - cr[0] + 1 }, (_, i) => cr[0] + i);
      let box = { x: 0, y: 0, w: W, h: H };
      if (a.roi) {
        const IJRoi = dep('IJRoi');
        IJRoi.validate(a.roi);
        if (IJRoi.isArea(a.roi)) box = cropRect(doc, null, a.roi);
      }
      const nZ = zr[1] - zr[0] + 1, nT = tr[1] - tr[0] + 1;
      ensureRoom(sel.length * nZ * nT * box.w * box.h * (doc.bitDepth / 8));
      const whole = box.w === W && box.h === H;
      const chans = sel.map((c) => {
        const src = getChannel(doc, c);
        const planes = [];
        for (let t = tr[0]; t <= tr[1]; t++) for (let z = zr[0]; z <= zr[1]; z++) {
          const pl = src.planes[t * doc.nZ + z];
          planes.push(whole ? pl.slice() : copyRect(pl, W, box.x, box.y, box.w, box.h));
        }
        return makeChannel(src.name, src.color, planes[0], doc.bitDepth, src.display, planes);
      });
      // RGB stays RGB when its three colour channels all come along, in order
      const rgb = doc.rgb && sel.length === 3 && sel[0] === 0 && sel[1] === 1 && sel[2] === 2;
      // the labels of the planes kept (stack order: t, then z, then channel)
      let labels = null;
      if (doc.labels) {
        const S = dep('IJStack'), od = stackDims(doc);
        labels = [];
        for (let t = tr[0]; t <= tr[1]; t++) for (let z = zr[0]; z <= zr[1]; z++) {
          if (rgb || doc.rgb) labels.push(doc.labels[S.stackIndex(od, 0, z, t) - 1] === undefined ? null : doc.labels[S.stackIndex(od, 0, z, t) - 1]);
          else for (const c of sel) { const l = doc.labels[S.stackIndex(od, c, z, t) - 1]; labels.push(l === undefined ? null : l); }
        }
        if (doc.rgb && !rgb) labels = null;
      }
      const provenance = Object.assign({}, doc.provenance);
      const o = provenance.cropOrigin || { x: 0, y: 0 };
      provenance.cropOrigin = { x: o.x + box.x, y: o.y + box.y };
      const nd = buildDoc({
        id: newId(), sessionKey: doc.sessionKey, name: a.name || (doc.name + '-1'), width: box.w, height: box.h,
        bitDepth: doc.bitDepth, channels: chans, calibration: plainClone(doc.calibration), provenance,
        nZ, nT, rgb, labels, hyperstack: doc.hyperstack,
        z: Math.min(nZ - 1, Math.max(0, doc.z - zr[0])), t: Math.min(nT - 1, Math.max(0, doc.t - tr[0]))
      });
      registerDoc(nd, { baseline: true });
      finishMutation();
      return { docId: nd.id, info: infoOf(nd) };
    }

    handlers['doc.undo'] = (a) => {
      const doc = getDoc(a.docId);
      return lockDoc(doc, async () => {
        if (doc.macroHold) throw ijError('IJ_MACRO_GROUP', 'a macro run is one undo step: no undo while it runs');
        const changed = await doUndoRedo(doc, 'undo', false);
        post({ event: 'invalidate', docId: doc.id, channels: changed.channels, sizeChanged: changed.sizeChanged, sameGeometry: !!changed.sameGeometry, calibration: !!changed.calibration, labels: !!changed.labels, planes: changed.planes === undefined ? 'all' : changed.planes });
        finishMutation();
        return { rev: doc.rev, info: infoOf(doc), changed };
      });
    };

    handlers['doc.redo'] = (a) => {
      const doc = getDoc(a.docId);
      return lockDoc(doc, async () => {
        if (doc.macroHold) throw ijError('IJ_MACRO_GROUP', 'a macro run is one undo step: no undo while it runs');
        const changed = await doUndoRedo(doc, 'redo', false);
        post({ event: 'invalidate', docId: doc.id, channels: changed.channels, sizeChanged: changed.sizeChanged, sameGeometry: !!changed.sameGeometry, calibration: !!changed.calibration, labels: !!changed.labels, planes: changed.planes === undefined ? 'all' : changed.planes });
        finishMutation();
        return { rev: doc.rev, info: infoOf(doc), changed };
      });
    };

    handlers['doc.revert'] = (a) => {
      const doc = getDoc(a.docId);
      return lockDoc(doc, async () => {
        const r = await doRevert(doc);
        if (!r.noop) post({ event: 'invalidate', docId: doc.id, channels: r.changed.channels, sizeChanged: r.changed.sizeChanged, labels: true, planes: r.changed.planes === undefined ? 'all' : r.changed.planes });
        finishMutation();
        return { rev: doc.rev, info: infoOf(doc), changed: r.changed };
      });
    };

    // ---- stack position, slice labels, composite undo steps (API.md §3, §6) -------------------------------------------

    // Move the document's position: { z?, t?, c? } (0-based, clamped; `c` is the active channel). Not an edit: no undo step, no
    // journal entry, the position travels with the session meta (display.pos). Returns the position now in force.
    function applyPosition(doc, p) {
      const S = dep('IJStack');
      const want = {
        c: p && typeof p.c === 'number' ? p.c : doc.active,
        z: p && typeof p.z === 'number' ? p.z : doc.z,
        t: p && typeof p.t === 'number' ? p.t : doc.t
      };
      const q = S.clampPos({ nC: doc.channels.length, nZ: doc.nZ, nT: doc.nT }, want);
      doc.z = q.z; doc.t = q.t;
      doc.active = q.c;
      syncData(doc);
      markMeta(doc);
      scheduleIdle();
      return { c: doc.active, z: doc.z, t: doc.t };
    }

    handlers['doc.setPosition'] = (a) => {
      const doc = getDoc(a.docId);
      applyPosition(doc, a);
      return { info: infoOf(doc) };
    };

    handlers['doc.labels'] = (a) => {
      const doc = getDoc(a.docId);
      return { labels: doc.labels ? doc.labels.slice() : null };
    };

    // The label step: the slice label `n` (ImageJ's 1-based stack index) becomes `label` (null / '' = none). A size-kind record
    // that only changes metadata (calOnly), journaled as { kind: 'label' } so a replay gives the same labels.
    function commitLabel(doc, n, label, replay) {
      const N = labelCount(doc);
      if (!isInt(n) || n < 1 || n > N) throw ijError('IJ_BAD_ARGS', 'slice');
      const text = label === null || label === undefined || label === '' ? null : String(label);
      if (text !== null && text.length > 4096) throw ijError('IJ_BAD_ARGS', 'label');
      const rec = newRecord(doc, 'setLabel');
      rec.full = fullState(doc);
      rec.calOnly = true;
      rec.labelStep = true;
      pushUndo(doc, rec);
      const labels = doc.labels ? doc.labels.slice() : new Array(N).fill(null);
      labels[n - 1] = text;
      doc.labels = labels.some((l) => l !== null) ? labels : null;
      doc.rev++;
      if (!replay) noteCommit(doc, { kind: 'label', n, label: text });
      else doc.journalSeq++;
    }

    handlers['doc.setLabel'] = (a) => {
      const doc = getDoc(a.docId);
      return lockDoc(doc, async () => {
        commitLabel(doc, a.n, a.label, false);
        post({ event: 'invalidate', docId: doc.id, channels: [], sizeChanged: false, calibration: true, labels: true, planes: [] });
        finishMutation();
        return { rev: doc.rev, info: infoOf(doc) };
      });
    };

    // doc.undoGroup.begin / end { docId, labelKey? }: every step pushed in between is folded into ONE composite record (undo and
    // redo apply them all). A composite is never replayed from the journal (its undo forces a snapshot), and begin / end nest.
    handlers['doc.undoGroup.begin'] = (a) => {
      const doc = getDoc(a.docId);
      return lockDoc(doc, async () => {
        if (!doc.groupDepth) doc.groupRecs = [];
        doc.groupDepth++;
        return { depth: doc.groupDepth };
      });
    };

    handlers['doc.undoGroup.end'] = (a) => {
      const doc = getDoc(a.docId);
      return lockDoc(doc, async () => {
        if (!doc.groupDepth) throw ijError('IJ_BAD_ARGS', 'no open group');
        doc.groupDepth--;
        if (doc.groupDepth) return { depth: doc.groupDepth, steps: 0 };
        const present = doc.groupRecs.filter((r) => doc.undo.indexOf(r) >= 0);
        doc.groupRecs = null;
        if (present.length > 1) {
          for (const r of present) doc.undo.splice(doc.undo.lastIndexOf(r), 1);
          const g = { op: typeof a.labelKey === 'string' && a.labelKey ? a.labelKey : 'group', at: Date.now(), replayable: false, patches: null, full: null, display: null, bytes: 0, calOnly: false, group: present };
          if (typeof a.labelKey === 'string') g.labelKey = a.labelKey;
          g.bytes = recBytes(g);
          doc.undo.push(g);
        }
        while (doc.undo.length > MAX_UNDO) doc.undo.shift();
        return { depth: 0, steps: present.length };
      });
    };

    // ---- macro runs (E.macroGroup; DOCS/studio-advanced/macros/INTEGRATION.md §2.6) ----------------------------------------------
    // begin keeps the state of every open image (references: arrays are immutable, the plane lists copied) and HOLDS the image: the
    // steps of the run push no undo record and write no journal entry, so a crash restores the stored pre-run state. end gives each held
    // image that changed ONE undo step back to that state (applied like Revert's record), then one snapshot.
    function macroBegin(runId, labelKey) {
      if (macroRun) throw ijError('IJ_MACRO_BUSY', 'a macro run is already open');
      if (typeof runId !== 'string' || !runId) throw ijError('IJ_BAD_ARGS', 'runId');
      const run = { runId, labelKey: typeof labelKey === 'string' && labelKey ? labelKey : 'macro', batch: false, closing: false, docs: new Map(), ending: null };
      for (const d of docs.values()) {
        run.docs.set(d.id, { pre: fullState(d), born: false, dropped: false, rev0: d.rev });
        d.macroHold = true;
      }
      macroRun = run;
      return { docs: Array.from(run.docs.keys()) };
    }
    function macroSetBatch(runId, on) {
      if (!macroRun || macroRun.runId !== runId || macroRun.closing) throw ijError('IJ_BAD_ARGS', 'no such macro run');
      macroRun.batch = !!on;
    }
    function macroEnd(runId) {
      if (lastMacroRun && lastMacroRun.runId === runId && lastMacroRun.ending) return lastMacroRun.ending;
      const run = macroRun;
      if (!run || run.runId !== runId) return Promise.resolve({ changed: [], dropped: [] });
      if (run.ending) return run.ending;
      run.closing = true;
      run.ending = (async () => {
        const changed = [], dropped = [];
        try {
          for (const [id, e] of Array.from(run.docs)) {
            const doc0 = docs.get(id);
            if (!doc0) continue;
            await lockDoc(doc0, async () => {
              const doc = docs.get(id);
              if (!doc || !run.docs.has(id)) return;   // closed while the run waited for it
              doc.macroHold = false;
              const moved = doc.rev !== e.rev0;
              if (moved) changed.push(id);
              if (moved && e.dropped) {
                // no undo for the run's changes: the older steps would be applied to a state they were not made from
                dropped.push(id);
                doc.undo.length = 0; doc.redo.length = 0;
              }
              if (moved && e.pre && !e.born) {
                const rec = { op: run.labelKey, labelKey: run.labelKey, at: Date.now(), replayable: false, full: e.pre, patches: null, display: null, calOnly: false, macro: true, bytes: 0 };
                rec.bytes = recBytes(rec);
                doc.undo.push(rec);
                while (doc.undo.length > MAX_UNDO) doc.undo.shift();
                doc.redo.length = 0;
              }
              e.pre = null;
              if (doc.ephemeral) return;
              if (e.born) writeBaseline(doc);
              else if (moved) snapshotNow(doc, true);
              // the meta the run held back (display, position, a shown batch image)
              markMeta(doc);
            });
          }
        } finally {
          for (const id of run.docs.keys()) { const d = docs.get(id); if (d) d.macroHold = false; }
          for (const e of run.docs.values()) e.pre = null;
          if (macroRun === run) macroRun = null;
          lastMacroRun = run;
          finishMutation();
        }
        return { changed, dropped };
      })();
      return run.ending;
    }

    // doc.persist { docId } → { info }: a batch image of a macro the macro shows becomes an ordinary one (a view, a session entry, a baseline);
    // while the run still holds it, its baseline is written when the run ends.
    handlers['doc.persist'] = (a) => {
      const doc = getDoc(a.docId);
      const was = !!doc.ephemeral;
      doc.ephemeral = false;
      doc.hidden = false;
      if (!doc.macroHold) {
        if (was) writeBaseline(doc);
        markMeta(doc);
        scheduleIdle();
      }
      return { info: infoOf(doc) };
    };

    // Reads of a document's pixels go through the document's queue, behind any operation
    // already accepted for it: the operation swaps the channel arrays only at its commit, so a
    // read that overtook it would answer from the pixels it is about to replace. Display reads
    // (doc.tile, doc.pixel, doc.preview) stay outside the queue on purpose: they must answer
    // between two slices of a running operation, and 'invalidate' tells the page to redraw.
    // owner: P6 (wave 2)
    // doc.stats { docId, roi, channel, measurements: [short key], redirect?: { docId, channel }, threshold?: { lower, upper },
    //   limit? } → { row, rows } (rows = one per point of a multi-point selection)
    handlers['doc.stats'] = (a) => {
      const doc = getDoc(a.docId);
      const red = redirectDoc(a.redirect, doc);
      return lockDocs(red && red !== doc ? [doc, red] : [doc], async () => {
        const doc = readDoc(getDoc(a.docId), a);
        const c = readChannel(doc, a);
        getChannel(doc, c);
        // memory: the selection's mask, the threshold-limited mask and the ellipse / hull buffers are box-sized byte
        // arrays (+ the traced vertices of a mask) — declared against the budget before they exist
        let need = 65536;
        if (a.roi && a.roi.type !== 'point' && a.roi.type !== 'angle') {
          const b = dep('IJRoi').bounds(a.roi);
          need += Math.min(Math.max(0, b.w), doc.width) * Math.min(Math.max(0, b.h), doc.height) * 4;
        } else if (!a.roi) need += doc.width * doc.height * 3;
        ensureRoomNoEvict(need);
        transientBytes += need;
        try {
          // raw (IJ.getValue "<column> raw"): measured with imp.setCalibration(null), the planes and everything else unchanged
          const mdoc = a.raw === true ? Object.assign(Object.create(doc), { calibration: { pixelWidth: 1, pixelHeight: 1, pixelDepth: 1, unit: 'pixel' } }) : doc;
          const rows = measureRows(mdoc, c, a.roi || null, a.measurements, { redirect: a.redirect, thr: a.threshold, limit: a.limit, invertY: a.invertY === true });
          return { row: rows[0], rows };
        } finally { transientBytes -= need; }
      });
    };

    handlers['doc.histogram'] = (a) => {
      const doc = getDoc(a.docId);
      return lockDoc(doc, async () => {
        const doc = readDoc(getDoc(a.docId), a);
        const c = readChannel(doc, a);
        const mask = roiMask(a.roi || null, doc.width, doc.height);
        const o = { bins: a.bins > 0 ? a.bins : 256 };
        if (a.min != null) o.min = a.min;
        if (a.max != null) o.max = a.max;
        const img = channelImage(doc, c);
        const res = dep('IJOps').histogram(img, mask, o);
        // the numbers of ImageJ's histogram window for the same bins / range (ShortStatistics, FloatStatistics, ByteStatistics)
        if (a.stats !== false && ROOT.IJAna) res.stats = ROOT.IJAna.histogramStats(img, mask, { bins: doc.bitDepth === 8 ? 256 : o.bins, histMin: a.min || 0, histMax: a.max || 0 });
        return res;
      });
    };

    // owner: P6 (wave 2), P-ana (wave 3)
    // doc.profile { docId, line (or roi), channel, vertical?, interpolate? } → { values, stepUm }: a straight line (any width), a
    // segmented line or a rectangle (ProfilePlot.getProfile: the column average, the row average with `vertical`). `interpolate` is
    // PlotWindow.interpolate (default true). The step is ImageJ's xInc: the pixel width, or the calibrated over the pixel length of a
    // straight line when the pixels are not square; the pixel height of a vertical rectangle profile.
    handlers['doc.profile'] = (a) => {
      const doc = getDoc(a.docId);
      return lockDoc(doc, async () => {
        const doc = readDoc(getDoc(a.docId), a);
        const c = readChannel(doc, a);
        const line = a.line || a.roi;
        if (!line || (line.type !== 'line' && line.type !== 'polyline' && line.type !== 'rect')) throw ijError('IJ_BAD_ROI', 'a line or a rectangle selection is needed');
        dep('IJRoi').validate(line);
        if (ROOT.IJAna) {
          const r = ROOT.IJAna.profile(channelImage(doc, c), line, { interpolate: a.interpolate !== false, vertical: a.vertical === true, calibration: doc.calibration });
          return { values: r.values, stepUm: r.step };
        }
        if (line.type === 'rect') throw ijError('IJ_MODULE_MISSING', 'module IJAna is not loaded');
        const T = ROOT.IJRoiTools;
        const cal = calOf(doc);
        if (!T) {
          // package P6 not loaded: the straight line of width W as the core samples it
          if (line.type !== 'line') throw ijError('IJ_MODULE_MISSING', 'module IJRoiTools is not loaded');
          const prof = dep('IJOps').profile(channelImage(doc, c), line, line.width > 0 ? line.width : 1);
          return { values: prof.values, stepUm: prof.step * (cal.pw + cal.ph) / 2 };
        }
        const values = T.profile(channelImage(doc, c), line);
        let step = cal.pw;
        if (line.type === 'line' && cal.pw !== cal.ph) {
          const dx = line.x2 - line.x1, dy = line.y2 - line.y1, pixelLength = Math.sqrt(dx * dx + dy * dy);
          if (pixelLength > 0) step = Math.sqrt((dx * cal.pw) ** 2 + (dy * cal.ph) ** 2) / pixelLength;
        }
        return { values, stepUm: step };
      });
    };

    handlers['doc.threshold'] = (a) => {
      const doc = getDoc(a.docId);
      return lockDoc(doc, async () => {
        const doc = readDoc(getDoc(a.docId), a);
        const c = readChannel(doc, a);
        const mask = roiMask(a.roi || null, doc.width, doc.height);
        const o = { dark: !!a.dark, maskBox: mask };
        // The Threshold window's "16-bit histogram" box (ThresholdAdjuster.java:232, :621): the full 65 536-bin histogram of a
        // 16-bit channel, trimmed to its first / last non-empty bin by AutoThresholder.getThreshold. Other depths ignore it.
        if (a.histogram16 === true && doc.bitDepth === 16) o.histogram16 = true;
        if (a.invertedLut === true) o.invertedLut = true;
        if (a.ignoreBlack === true) o.ignoreBlack = true;
        if (a.ignoreWhite === true) o.ignoreWhite = true;
        if (doc.bitDepth !== 8 && !o.histogram16) {
          const r = rangeOf(doc, c);
          o.min = r.min; o.max = r.max;
        }
        const r = dep('IJThreshold').levels(channelImage(doc, c), a.method || 'Default', o);
        return { lower: r.lower, upper: r.upper, level: r.level, min: r.min, max: r.max, ijLower: r.ijLower, ijUpper: r.ijUpper, histogram16: r.histogram16 };
      });
    };

    // owner: P6 (wave 2), P-ana (wave 3)
    // doc.particles { docId, channel, opts, keys, redirect, measureImage?, invertY?, composite? } → { rows, outlines, summary }. A row also carries
    // xStart / yStart (ParticleAnalyzer "Record starts": the first pixel met in raster order); with `composite` (Composite ROIs, only without
    // Include holes) a particle whose outline encloses holes carries `maskRoi`, its own pixels as a mask selection.
    handlers['doc.particles'] = (a, ctx) => {
      const doc = getDoc(a.docId);
      const red = redirectDoc(a.redirect, doc);
      return lockDocs(red && red !== doc ? [doc, red] : [doc], async () => {
        const doc = readDoc(getDoc(a.docId), a);
        const c = readChannel(doc, a);
        const redirectSrc = a.redirect && a.redirect.docId !== undefined && a.redirect.docId !== null ? measureSource(doc, c, a.redirect) : null;
        if (doc.bitDepth !== 8) throw ijError('IJ_NOT_BINARY', 'particle analysis needs an 8-bit mask');
        const o = Object.assign({}, a.opts || {});
        const IJP = dep('IJParticles');
        // The pixels analysed (ParticleAnalyzer.setThresholdLevels): the threshold range of the image when one is set, else the 255 pixels of a
        // binary image — "A thresholded image or 8-bit binary image is required." for anything else. `requireBinary` is the page's flag; a caller
        // without it keeps the historical rule "every non-zero pixel is foreground".
        const src8 = doc.channels[c].data;
        let analysed = src8, thr = null;
        const hasThr = a.threshold && isFinite(a.threshold.lower) && isFinite(a.threshold.upper);
        if (hasThr) { thr = { lower: a.threshold.lower, upper: a.threshold.upper }; }
        else if (a.requireBinary === true) {
          for (let i = 0; i < src8.length; i++) if (src8[i] !== 0 && src8[i] !== 255) throw ijError('IJ_PARTICLES_THRESHOLD', 'a thresholded image or 8-bit binary image is required');
        }
        // the peak of the whole analysis: working copy, pixel list + flood-fill stack, thresholded mask, the selection's box, the per-particle masks
        const peak = IJP.scratchBytes(doc.width, doc.height, { roi: !!o.roi }) + (thr ? doc.width * doc.height : 0) + 2 * doc.width * doc.height;
        ensureRoom(peak);
        transientBytes += peak;
        ctx.release = () => { transientBytes -= peak; };
        if (thr) {
          analysed = new Uint8Array(src8.length);
          for (let i = 0; i < src8.length; i++) { const v = src8[i]; if (v >= thr.lower && v <= thr.upper) analysed[i] = 1; }
        }
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
        // ParticleAnalyzer: "if (compositeRois && floodFill && mask!=null) { … new ThresholdToSelection().convert(mask) … roi = roi2; }" — the holes of a
        // particle stay holes of its selection
        const composite = a.composite === true && !o.includeHoles;
        const maskRois = [], ownMasks = [];
        const T0 = ROOT.IJRoiTools;
        let lastMask = null;
        const maskOf = (rec, pix, np, rect) => {
          const bw = rect.w, bh = rect.h, bx = rect.x, by = rect.y;
          const sub = new Uint8Array(bw * bh);
          for (let k = 0; k < np; k++) { const px = pix[k], x = px % doc.width, y = (px - x) / doc.width; sub[(y - by) * bw + (x - bx)] = 1; }
          return { type: 'mask', x: bx, y: by, w: bw, h: bh, rle: Uint32Array.from(dep('IJRoi').rleEncode(sub)) };
        };
        if (composite && T0 && T0.maskPerimeter) {
          // Composite ROIs: the perimeter (so Circ. and the circularity filter) is the length of the selection ThresholdToSelection builds from the
          // particle's mask — ParticleAnalyzer.java:915-927 ("roi = roi2" precedes "double perimeter = roi.getLength()")
          o.perimeterOf = (outline, pix, np, rect, pw, ph) => {
            lastMask = maskOf(null, pix, np, rect);
            return T0.maskPerimeter(lastMask, pw, ph);
          };
        }
        if (!o.includeHoles) {
          // without Include holes a particle is its 8-connected component only: its pixels, as a mask selection of its bounding box, are what
          // ParticleAnalyzer measures ("ff.particleAnalyzerFill") and what Composite ROIs keep as the selection
          const IJRoi = dep('IJRoi');
          o.sink = (rec, pix, np, index) => {
            const m = lastMask || maskOf(rec, pix, np, { x: rec.bx, y: rec.by, w: rec.bw, h: rec.bh });
            lastMask = null;
            ownMasks[index - 1] = m;
            if (composite && rec.bw * rec.bh > np) {
              const filled = IJRoi.mask({ type: 'polygon', points: rec.outline }, doc.width, doc.height);
              let fc = 0;
              for (let k = 0; k < filled.data.length; k++) if (filled.data[k]) fc++;
              if (fc > np) maskRois[index - 1] = m;
            }
          };
        }
        // cancel and progress: the scan hands control back every 16384 pixels
        const r = await IJP.analyzeAsync(analysed, doc.width, doc.height, o, (f) => ctx.task.tick(0.1 * f, 'op.particles'));
        const measure = a.measureImage !== false;
        if (a.invertY === true && !ROOT.IJAna) throw ijError('IJ_MODULE_MISSING', 'module IJAna is not loaded');
        const invY = a.invertY === true && ROOT.IJAna;
        const calY = calOf(doc).ph;
        const rows = [];
        for (let i = 0; i < r.particles.length; i++) {
          const p = r.particles[i];
          const row = {
            n: i + 1, area: p.area, areaPx: p.areaPx, perimeter: p.perimeter, circularity: p.circularity,
            bx: p.bx, by: p.by, bw: p.bw, bh: p.bh, xCentroid: p.xCentroid, yCentroid: p.yCentroid, xStart: p.xStart, yStart: p.yStart
          };
          if (measure && p.outline && p.outline.length >= 3) {
            const st = particleImageStats(doc, c, p.outline, !!o.includeHoles, a.keys, redirectSrc, ownMasks[i], thr);
            // Composite ROIs: Perim. is the length of the particle's selection, which analyze() already measured
            if (composite && o.perimeterOf && Array.isArray(a.keys) && a.keys.indexOf('perim') >= 0 && !redirectSrc) st.perim = p.perimeter;
            if (invY) ROOT.IJAna.invertY(st, doc.height, calY);
            Object.assign(row, st);
          }
          if (invY) ROOT.IJAna.invertY(row, doc.height, calY, ['yCentroid']);
          if (maskRois[i]) row.maskRoi = maskRois[i];
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
      // the value of every channel at the plane of `pos` (an RGB image: its three colour values)
      const pi = posToPi(doc, a.pos);
      return { values: doc.channels.map((c) => c.planes[pi][i]) };
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
      const img = levelImage(doc, c, level, posToPi(doc, a.pos));
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
        const n = planeBytes(doc);
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

    // ---- session meta (the UI state stored beside the documents) ----------------------------------------------------
    // What the page may keep: the Results table, the ROI list, the measurement set, the open tool windows, the layout of
    // the workspace, the persistent annotations of every document, the Synchronize Windows state, the look-up tables an
    // extension registered and each package's own session data. Every key is checked by type and size; what is wrong or
    // too large is dropped and named in the answer ({ dropped: [{ key, code, docId? }] }), the rest is stored.
    const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v);
    const jsonBytes = (v) => { try { return JSON.stringify(v).length; } catch (e) { return Infinity; } };
    function validateMeta(a) {
      const ui = {}, dropped = [];
      const bad = (key, code, docId) => dropped.push(docId === undefined ? { key, code } : { key, code, docId });
      for (const key of META_KEYS) {
        const v = a[key];
        if (v === undefined) continue;
        switch (key) {
          case 'results': case 'rois': case 'measurements':
            if (Array.isArray(v)) ui[key] = v; else bad(key, 'IJ_BAD_ARGS');
            break;
          case 'windows':
            // the ids of the open tool windows (an array); an older page stored an object of window boxes
            if (Array.isArray(v) || isPlain(v)) ui[key] = v; else bad(key, 'IJ_BAD_ARGS');
            break;
          case 'layout': case 'sync':
            if (v === null) ui[key] = null; else if (isPlain(v)) ui[key] = v; else bad(key, 'IJ_BAD_ARGS');
            break;
          case 'workspace':
            if (Array.isArray(v) && v.length <= META_WORKSPACE_MAX && v.every((k) => typeof k === 'string' && k.length > 0 && k.length <= META_WORKSPACE_KEY_CHARS)) ui[key] = v.slice();
            else bad(key, 'IJ_BAD_ARGS');
            break;
          case 'annotations': {
            if (!isPlain(v)) { bad(key, 'IJ_BAD_ARGS'); break; }
            const out = {};
            for (const id of Object.keys(v)) {
              const rec = v[id];
              if (!isPlain(rec) || !Array.isArray(rec.items)) { bad(key, 'IJ_BAD_ARGS', id); continue; }
              if (rec.items.length > META_ANNOT_ITEMS) { bad(key, 'IJ_LAY_META_TOO_LARGE', id); continue; }
              out[id] = { visible: rec.visible !== false, items: rec.items };
            }
            ui[key] = out;
            break;
          }
          case 'luts': {
            if (!isPlain(v)) { bad(key, 'IJ_BAD_ARGS'); break; }
            const out = {};
            for (const name of Object.keys(v)) {
              const t = v[name];
              if (Array.isArray(t) && t.length === 768 && t.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) out[name] = t; else bad(key, 'IJ_BAD_ARGS', name);
            }
            ui[key] = out;
            break;
          }
          case 'ext': {
            if (!isPlain(v)) { bad(key, 'IJ_BAD_ARGS'); break; }
            const out = {};
            for (const pkg of Object.keys(v)) { if (jsonBytes(v[pkg]) > META_EXT_BYTES) bad(key, 'IJ_LAY_META_TOO_LARGE', pkg); else out[pkg] = v[pkg]; }
            ui[key] = out;
            break;
          }
          default: break;
        }
      }
      // the whole record stays under META_TOTAL_BYTES: the annotations give way first, then the packages' data
      let total = 0;
      const sizes = {};
      for (const k of Object.keys(ui)) { sizes[k] = jsonBytes(ui[k]); total += sizes[k]; }
      for (const k of ['annotations', 'ext', 'luts', 'results']) {
        if (total <= META_TOTAL_BYTES) break;
        if (ui[k] === undefined) continue;
        total -= sizes[k]; delete ui[k]; bad(k, 'IJ_LAY_META_TOO_LARGE');
      }
      return { ui, dropped };
    }

    handlers['session.putMeta'] = async (a) => {
      const key = a.key || activeSessionKey;
      if (!key || !storageOn) return {};
      const checked = validateMeta(a);
      const s = sessions.get(key);
      if (s) s.ui = checked.ui;
      // Storage only updates a session that already holds a document (no ghost session).
      await enqueue(() => storage.putMeta(key, { ui: checked.ui }), null);
      return checked.dropped.length ? { dropped: checked.dropped } : {};
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
          // The record of a stack holds `planes: [{ data } | { sameAsBaseline, baseIndex }]` per channel; a record made before
          // stacks (or of a single-plane document) holds the channel's own `data` / `baseIndex`: it restores as a 1 x 1 stack.
          // The baseline's arrays are numbered c * NP + pi of the BASELINE (flatBaseline).
          const nZs = src.nZ > 0 ? src.nZ : 1, nTs = src.nT > 0 ? src.nT : 1;
          const baseFlat = base ? flatBaseline(base) : null;
          const lists = src.channels.map((c, i) => {
            // A channel that was the baseline's array points at it by baseIndex (never by its own
            // index: a reorder keeps the arrays but moves them); old records carry no baseIndex.
            if (Array.isArray(c.planes)) {
              if (c.planes.length !== nZs * nTs) { missing = true; return []; }
              return c.planes.map((q) => {
                const d = q.data || (baseFlat && q.baseIndex !== undefined && q.baseIndex !== null ? baseFlat[q.baseIndex] : null);
                if (!d) missing = true;
                return d;
              });
            }
            const bi = c.baseIndex !== undefined && c.baseIndex !== null ? c.baseIndex : i;
            const d = c.data || (baseFlat && baseFlat[bi]);
            if (!d) missing = true;
            return [d];
          });
          if (missing || nZs * nTs !== lists[0].length) { warnings.push({ docId, code: 'IJ_NO_BASELINE' }); continue; }
          const arrays = [];
          for (const l of lists) for (const d of l) arrays.push(d);
          const loadedBytes = arrays.reduce((n, d) => n + d.byteLength, 0);
          // The decoded records are in memory while the document is built: counted until then.
          transientBytes += loadedBytes;
          let doc;
          try {
            ensureRoom(loadedBytes);
            const at = (src.t > 0 ? Math.min(src.t, nTs - 1) : 0) * nZs + (src.z > 0 ? Math.min(src.z, nZs - 1) : 0);
            const chans = src.channels.map((c, i) => makeChannel(c.name, c.color, lists[i][at], src.bitDepth, c.display, lists[i]));
            doc = buildDoc({
              id: docId, sessionKey: a.key, name: src.name, width: src.width, height: src.height, bitDepth: src.bitDepth,
              nZ: nZs, nT: nTs, z: src.z, t: src.t, labels: src.labels, hyperstack: !!src.hyperstack, rgb: !!src.rgb,
              channels: chans, calibration: src.calibration, provenance: src.provenance, rev: src.rev,
              savedRev: src.savedRev == null ? -1 : src.savedRev, display: src.display, journalSeq: src.journalSeq || 0,
              layoutRev: src.layoutRev || 0, hidden: !!src.hidden, restore: true
            });
          } finally { transientBytes -= loadedBytes; }
          if (base) {
            doc.baselineIndex = new WeakMap();
            baseFlat.forEach((d, k) => doc.baselineIndex.set(d, k));
            doc.baselineMeta = base.channels.map((c) => ({ name: c.name, color: c.color }));
            doc.baselineProvenance = plainClone(base.provenance);
            doc.baselineShape = { w: base.width, h: base.height, bd: base.bitDepth, nZ: base.nZ || 1, nT: base.nT || 1, rgb: !!base.rgb, hyperstack: !!base.hyperstack, labels: base.labels || null };
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
              // typed-array params were journaled once, under their hash
              if (e.params && typeof e.params === 'object') {
                const stored = rec.blobs || {};
                e = Object.assign({}, e, { params: resolveBlobs(e.params, (ref) => (stored[ref] ? stored[ref].data : null)) });
              }
              if (e.kind === 'run') await executeRun(doc, e, replayTask, true);
              else if (e.kind === 'undo' || e.kind === 'redo') await doUndoRedo(doc, e.kind, true);
              else if (e.kind === 'label') commitLabel(doc, e.n, e.label, true);
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
            // the position the operator was looking at (a stack's meta carries it; the layout signature has already vouched for the dimensions)
            if (ds.pos && isInt(ds.pos.z) && isInt(ds.pos.t) && ds.pos.z >= 0 && ds.pos.z < doc.nZ && ds.pos.t >= 0 && ds.pos.t < doc.nT) { doc.z = ds.pos.z; doc.t = ds.pos.t; }
          }
          syncData(doc);
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
          post({ event: 'invalidate', docId, channels: doc.channels.map((c, i) => i), sizeChanged: true, planes: 'all' });
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

    // doc.import { image: { name, width, height, bitDepth, calibration, channels: [{ data, name, color, display? }] },
    //              provenance?, sessionKey?, hidden? } -> { docId, info }.
    // A document the page built itself (the library, a pasted image): the arrays were transferred, the baseline is stored
    // like any loaded image (so the session restores it), provenance.imported marks it. `hidden` = kept in the session,
    // no view and no menu entry on the page (info.hidden).
    handlers['doc.import'] = (a) => {
      const img = a.image;
      const bytes = checkImageArgs(img);
      ensureRoom(bytes);
      const provenance = Object.assign({ imported: true }, a.provenance && typeof a.provenance === 'object' ? a.provenance : {});
      const doc = addDocFromImage(img, provenance, typeof a.sessionKey === 'string' && a.sessionKey ? a.sessionKey : undefined, !!a.hidden);
      doc.savedRev = -1;
      markMeta(doc);
      finishMutation();
      return { docId: doc.id, info: infoOf(doc) };
    };

    // engine.configure { tileCacheBytes }: the page tells the worker how much pyramid cache the visible views justify.
    handlers['engine.configure'] = (a) => {
      if (a.tileCacheBytes !== undefined) {
        if (typeof a.tileCacheBytes !== 'number' || !isFinite(a.tileCacheBytes) || a.tileCacheBytes < MiB) throw ijError('IJ_BAD_ARGS', 'tileCacheBytes');
        tileCacheBytes = Math.min(2 * GiB, Math.floor(a.tileCacheBytes));
        while (tiles.bytes > tileCacheBytes && tiles.map.size > 0) {
          const first = tiles.map.keys().next().value;
          const t = tiles.map.get(first);
          tiles.map.delete(first);
          tiles.bytes -= t.img.data.byteLength;
        }
      }
      return { tileCacheBytes };
    };

    // engine.registerLut { name, table: Uint8Array(768) }: a table an extension named (IJLuts.register), so a channel's
    // display.lut may name it here too (the TIFF export reads it).
    handlers['engine.registerLut'] = (a) => {
      const IJLuts = dep('IJLuts');
      if (typeof IJLuts.register !== 'function') throw ijError('IJ_MODULE_MISSING', 'look-up table registry');
      const table = ArrayBuffer.isView(a.table) && a.table.constructor.name === 'Uint8Array' ? a.table : (Array.isArray(a.table) ? Uint8Array.from(a.table) : null);
      if (!table) throw ijError('IJ_BAD_ARGS', 'table');
      try { IJLuts.register(a.name, table); } catch (err) { throw ijError('IJ_BAD_ARGS', 'lut'); }
      return { name: a.name };
    };

    // engine.ops {} -> [{ name, kind, stack, rgb }]: every registered operation (builtin and packages) with the fields the page decides
    // with (Process Stack? is asked for a pixel op of `stack: 'ask'`, an RGB document refuses `rgb: false`), so the page keeps no list of its own.
    handlers['engine.ops'] = () => {
      const reg = ROOT.IJOpRegistry;
      const out = [];
      for (const name of reg.list()) { const sp = reg.get(name); out.push({ name, kind: sp.kind, stack: sp.stack, rgb: sp.rgb }); }
      return out;
    };

    // engine.putBlob { data: TypedArray } -> { blobRef, kind, bytes }: bytes the page will refer to by { blobRef } in the
    // params of a preview or a run (a clipboard sent once, not with each preview). Counted against the budget; one
    // 64 MiB at most; the same bytes twice are one blob.
    handlers['engine.putBlob'] = (a) => {
      const d = a.data;
      if (!isBlobArray(d)) throw ijError('IJ_BAD_ARGS', 'blob');
      if (d.byteLength > BLOB_MAX_BYTES) throw ijError('IJ_TOO_LARGE', 'blob too large');
      const kind = d.constructor.name;
      const ref = blobRefFor(d);
      if (!blobs.has(ref)) {
        ensureRoom(d.byteLength);
        blobs.set(ref, { ref, kind, data: d, bytes: d.byteLength, docs: new Set(), used: false, at: Date.now() });
        finishMutation();
      }
      return { blobRef: ref, kind, bytes: d.byteLength };
    };

    // engine.dropBlob { blobRef }: a blob the page will not use any more (a cancelled paste, even one a preview pinned); one a step already uses stays.
    handlers['engine.dropBlob'] = (a) => {
      const b = blobs.get(a.blobRef);
      let dropped = false;
      if (b && !b.docs.size) { blobs.delete(a.blobRef); dropped = true; finishMutation(); }
      return { dropped };
    };

    // engine.unpinBlobs: the page's preview is over (cancelled, or a paste committed / escaped): its blobs are reclaimable again.
    handlers['engine.unpinBlobs'] = () => {
      for (const b of blobs.values()) b.pinned = false;
      return { ok: true };
    };

    // The `E` a package's worker command (IJOpRegistry.defineCommand) receives: the engine's own services, scoped to one
    // request. What it reserved and did not release is given back when the request ends.
    // The engine reads E.request may run in-process for a worker command (same arguments and result as the page's request).
    const E_REQUESTS = ['doc.info', 'doc.stats', 'doc.histogram', 'doc.profile', 'doc.threshold', 'doc.compute', 'doc.labels', 'doc.setLabel'];
    function commandContext(ctx) {
      let reserved = 0;
      let openGroup = null;   // the macro run this request opened and has not ended (ended for it when the request ends)
      const E = {
        budgetBytes,
        // what would fit once the tile cache and every undo step were given up (no side effect): a macro's file read checks it first
        freeBytes: () => Math.max(0, budgetBytes - (usedBytes() - reclaimableBytes())),
        ijError,
        check: () => ctx.task.check(),
        tick: (f, stepKey, detail) => ctx.task.tick(f, stepKey, detail),
        reserve(n) {
          if (!(n >= 0)) throw ijError('IJ_BAD_ARGS', 'reserve');
          ensureRoom(n); transientBytes += n; reserved += n;
        },
        release(n) {
          const k = Math.min(Math.max(0, Number(n) || 0), reserved);
          transientBytes -= k; reserved -= k;
        },
        // A document the handler built: arrays it reserved become the document's own (the reservation shrinks by their size).
        // o.clean: an image read from a file is what is on disk (nothing unsaved until it is edited); o.provenance.file = its FileOrigin.
        createDoc(image, o) {
          const opt = o || {};
          const bytes = checkImageArgs(image);
          const covered = Math.min(bytes, reserved);
          if (bytes > covered) ensureRoom(bytes - covered);
          const provenance = Object.assign({}, opt.provenance && typeof opt.provenance === 'object' ? opt.provenance : {});
          if (provenance.file !== undefined) { const f = checkFileOrigin(provenance.file); if (f) provenance.file = f; else delete provenance.file; }
          const doc = addDocFromImage(image, provenance, typeof opt.sessionKey === 'string' && opt.sessionKey ? opt.sessionKey : undefined, !!opt.hidden);
          doc.savedRev = opt.clean === true ? doc.rev : -1;
          markMeta(doc);
          E.release(bytes);
          finishMutation();
          return infoOf(doc);
        },
        // the frozen view of a document at `pos` ({ z, t }, default the current plane; API.md §6)
        readDoc: (docId, pos) => { const d = getDoc(docId); return makeView(d, posToPi(d, pos)); },
        // ---- files of a macro (FILES.md §10.2): a file's bytes → a stack image for createDoc, a document → a file's bytes
        decodeImage: (bytes, o) => decodeImage(bytes, o, () => ctx.task.check()),
        encodeImage: (docId, o) => encodeImage(getDoc(docId), o, ctx),
        markSaved: (docId, o) => markSavedFile(getDoc(docId), o),
        // ---- stacks: the dimensions, the position (a move posts the `position` event so the page's view follows), the live planes
        dims(docId) {
          const d = getDoc(docId);
          const sd = stackDims(d);
          return { width: d.width, height: d.height, nC: sd.nC, nZ: d.nZ, nT: d.nT, bitDepth: d.bitDepth, bitDepthIJ: d.rgb ? 24 : d.bitDepth, rgb: !!d.rgb, hyperstack: !!d.hyperstack };
        },
        getPosition(docId) { const d = getDoc(docId); return { c: d.active, z: d.z, t: d.t }; },
        setPosition(docId, pos) {
          const d = getDoc(docId);
          const before = { c: d.active, z: d.z, t: d.t };
          const now = applyPosition(d, pos || {});
          if (now.c !== before.c || now.z !== before.z || now.t !== before.t) post({ event: 'position', docId: d.id, c: now.c, z: now.z, t: now.t });
          return now;
        },
        // the live immutable arrays: never write into them
        plane(docId, c, z, t) {
          const d = getDoc(docId);
          const ch = getChannel(d, c);
          if (!isInt(z) || z < 0 || z >= d.nZ || !isInt(t) || t < 0 || t >= d.nT) throw ijError('IJ_BAD_ARGS', 'plane');
          return ch.planes[t * d.nZ + z];
        },
        planes(docId, c) { return getChannel(getDoc(docId), c).planes.slice(); },
        // ImageJ's slice label of the 1-based stack index `n` (null when none)
        getLabel(docId, n) {
          const d = getDoc(docId);
          if (!isInt(n) || n < 1 || n > labelCount(d)) throw ijError('IJ_BAD_ARGS', 'slice');
          const v = d.labels ? d.labels[n - 1] : null;
          return typeof v === 'string' && v !== '' ? v : null;
        },
        labels(docId) { const d = getDoc(docId); return d.labels ? d.labels.slice() : null; },
        // Run a registered op on a document through the ordinary doc.run path (locks the document itself: never call it while
        // holding lockDocs on the same one). o = { pos, planes, channel, roi, noUndo, docIds }.
        runOp(docId, op, params, o) {
          const opt = o || {};
          return runRequest({ docId, op, params, pos: opt.pos, posOf: opt.posOf, planes: opt.planes, channel: opt.channel, roi: opt.roi, noUndo: opt.noUndo, docIds: opt.docIds, announce: true }, ctx.task)
            .then((r) => ({ changed: r.changed, newDocIds: r.newDocIds, newInfos: r.newInfos || [] }));
        },
        // ONE undo step replacing the planes `list` = [{ c, z, t, data }] (the macro working copy publishes through it). The arrays
        // become the document's own (reserve() them first and they are not counted twice); the record is not replayable, so the
        // step forces a snapshot, exactly like a noUndo run. `o.labelKey` names the step; `o.final` skips the cancellation check.
        commitPlanes(docId, list, o) {
          const doc0 = getDoc(docId);
          return lockDocs([doc0], async () => {
            const doc = getDoc(docId);
            // o.final: the end-of-run publish of a macro, which an abort must not lose (ImageJ keeps what an aborted macro wrote)
            if (!(o && o.final === true)) ctx.task.check();
            if (!Array.isArray(list) || !list.length) throw ijError('IJ_BAD_ARGS', 'planes');
            const Ctor = ctorFor(doc.bitDepth);
            const seen = new Set(), items = [];
            let bytes = 0;
            const held = new Set();
            for (const ch of doc.channels) for (const q of ch.planes) held.add(q);
            for (const it of list) {
              if (!it || !isInt(it.c) || it.c < 0 || it.c >= doc.channels.length || !isInt(it.z) || it.z < 0 || it.z >= doc.nZ ||
                !isInt(it.t) || it.t < 0 || it.t >= doc.nT || !ArrayBuffer.isView(it.data) || it.data.constructor.name !== Ctor.name ||
                it.data.length !== doc.width * doc.height) throw ijError('IJ_BAD_ARGS', 'plane');
              const pi = it.t * doc.nZ + it.z, key = it.c + ':' + pi;
              if (seen.has(key)) throw ijError('IJ_BAD_ARGS', 'plane listed twice');
              seen.add(key);
              items.push({ c: it.c, pi, data: it.data });
              if (!held.has(it.data)) { held.add(it.data); bytes += it.data.byteLength; }
            }
            const covered = Math.min(bytes, reserved);
            if (bytes > covered) ensureRoom(bytes - covered);
            const rec = newRecord(doc, (o && typeof o.labelKey === 'string' && o.labelKey) || 'commitPlanes');
            rec.replayable = false;
            rec.patches = items.map((it) => ({ c: it.c, pi: it.pi, rect: { x: 0, y: 0, w: doc.width, h: doc.height }, data: doc.channels[it.c].planes[it.pi] }));
            for (const it of items) setPlane(doc, it.c, it.pi, it.data);
            E.release(bytes);
            pushUndo(doc, rec);
            const pis = Array.from(new Set(items.map((it) => it.pi))).sort((x, y) => x - y);
            const chs = Array.from(new Set(items.map((it) => it.c))).sort((x, y) => x - y);
            doc.rev++;
            purgeTiles(doc.id, pis);
            noteCommit(doc, null);
            if (storageOn) snapshotNow(doc);
            post({ event: 'invalidate', docId: doc.id, channels: chs, sizeChanged: false, planes: pis });
            finishMutation();
            return { changed: { channels: chs, sizeChanged: false, planes: pis } };
          });
        },
        lockDocs: (ids, fn) => lockDocs((ids || []).map(getDoc), fn),
        fetch(...args) {
          const f = ROOT.fetch;
          if (typeof f !== 'function') throw ijError('IJ_BAD_ARGS', 'fetch is not available');
          return f.apply(ROOT, args);
        },
        // Events a package posts to its page code: the name is prefixed `ext:` so a package cannot speak as the engine.
        postEvent(ev) {
          if (!ev || typeof ev.event !== 'string' || !/^[A-Za-z][A-Za-z0-9.]*$/.test(ev.event)) throw ijError('IJ_BAD_ARGS', 'event');
          post(Object.assign({}, ev, { event: 'ext:' + ev.event }));
        },
        transfer: (buf) => { ctx.transfer.push(buf); },
        // ---- the macro run lane (DOCS/studio-advanced/macros/INTEGRATION.md §2.7)
        macroGroup: Object.freeze({
          begin(o) {
            const r = macroBegin(o && o.runId, o && o.labelKey);
            openGroup = o.runId;
            return r;
          },
          setBatch(runId, on) { macroSetBatch(runId, on); },
          end(runId) {
            if (openGroup === runId) openGroup = null;
            return macroEnd(runId);
          }
        }),
        // fn() runs synchronously when a `cancel` request targets this request (a pending wait can reject at once)
        onCancel(fn) {
          if (typeof fn !== 'function') throw ijError('IJ_BAD_ARGS', 'onCancel');
          ctx.task.onCancel = fn;
        },
        // the bytes of the planes of every open document (undo steps, caches and saved states excluded)
        pixelBytes() {
          const seen = new Set();
          let n = 0;
          for (const d of docs.values()) for (const c of d.channels) for (const a of c.planes) if (!seen.has(a)) { seen.add(a); n += a.byteLength; }
          return n;
        },
        request(cmd, args) {
          if (E_REQUESTS.indexOf(cmd) < 0) return Promise.reject(ijError('IJ_BAD_ARGS', 'E.request: ' + String(cmd)));
          const sub = { id: null, task: ctx.task, transfer: [], release: null };
          return Promise.resolve()
            .then(() => handlers[cmd](args && typeof args === 'object' ? args : {}, sub))
            .finally(() => { if (sub.release) sub.release(); });
        },
        done() {
          if (reserved) { transientBytes -= reserved; reserved = 0; }
          if (openGroup !== null) {
            const id = openGroup;
            openGroup = null;
            macroEnd(id).catch((err) => console.error('[IJEngine] macro run end', err));
          }
        }
      };
      return E;
    }

    // Liveness probe for the page's watchdog: answered at once.
    handlers['ping'] = () => ({ at: Date.now() });

    handlers['cancel'] = (a) => {
      const t = tasks.get(a.targetId);
      if (t) {
        t.cancelled = true;
        if (typeof t.onCancel === 'function') { try { t.onCancel(); } catch (err) { console.error('[IJEngine] cancel hook', err); } }
      }
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
      const params = resolvedParams(doc, spec, a, chans, false, undefined, false, true);
      const pPi = posToPi(doc, a.pos);
      const view = makeView(doc, pPi);
      const gates = chans.map(() => ({ lo: 0, hi: 1 }));
      const prepareAt = (lv) => chans.map((c, i) => spec.prepare(view, c, params, {
        scale: 1 << lv, range: (cc) => rangeOf(doc, cc, pPi), dep,
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
      // a stack's preview names the plane it was computed on: the page drops one that arrives after the view moved
      if (planeCountOf(doc) > 1) result.pi = posToPi(doc, a.pos);
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
        if (level === 0) work = copyRect(doc.channels[c].planes[pPi], W, wx0, wy0, ww, wh);
        else {
          // level-L pixels [wx0,wx1) × [wy0,wy1) = downsample2 applied L times to the aligned level-0 block.
          let img = chImg(Math.min(W, wx1 * s) - wx0 * s, Math.min(H, wy1 * s) - wy0 * s, bd,
            copyRect(doc.channels[c].planes[pPi], W, wx0 * s, wy0 * s, Math.min(W, wx1 * s) - wx0 * s, Math.min(H, wy1 * s) - wy0 * s));
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
      let E = null;
      try {
        let h = handlers[msg.cmd];
        if (!h) {
          // not one of ours: a worker command a package registered (a built-in handler of the same name always wins)
          const reg = ROOT.IJOpRegistry;
          const c = reg && typeof reg.getCommand === 'function' && typeof msg.cmd === 'string' ? reg.getCommand(msg.cmd) : null;
          if (c) { E = commandContext(ctx); h = (args) => c.handler(args, E); }
          else if (reg && typeof reg.isWithdrawnCommand === 'function' && reg.isWithdrawnCommand(msg.cmd)) throw ijError('IJ_MODULE_MISSING', 'the package of this command did not load');
          else throw ijError('IJ_UNKNOWN_CMD', 'unknown command');
        }
        const result = await h(msg.args || {}, ctx);
        post({ id, ok: true, result }, ctx.transfer);
      } catch (err) {
        const code = (err && err.code) || 'IJ_INTERNAL';
        if (code === 'IJ_INTERNAL' || !String(code).startsWith('IJ_')) console.error('[IJEngine] ' + msg.cmd + ' failed', err);
        post({ id, ok: false, error: { code: String(code), message: String(err && err.message || code), details: err && err.details || null } });
      } finally {
        if (E) E.done();
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
    {
      // a package command named like a built-in handler would never be reached: withdrawn at start, loudly
      const reg = ROOT.IJOpRegistry;
      if (reg && typeof reg.listCommands === 'function') {
        for (const name of reg.listCommands()) if (handlers[name]) { console.error('[IJEngine] worker command ' + name + ' shadows a built-in handler: withdrawn'); reg.unregisterCommand(name); }
      }
    }
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
      handle: onMessage,
      // test aid: the live document record (the tests check `channels[c].data === planes[t * nZ + z]` and the undo stacks)
      inspectDoc: (id) => docs.get(id) || null
    };
  }

  function start(self, options) {
    return createEngine(self, options || {});
  }

  const api = { start, defaultBudget, createMemoryStorage, createIndexedDbStorage, TILE };
  try { ROOT.IJEngine = api; } catch (e) { /* frozen global */ }
  return api;
})();
