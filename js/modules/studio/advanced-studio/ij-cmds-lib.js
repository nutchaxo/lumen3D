/* ij-cmds-lib.js — File › Open from Library… (package lib, wave 3): the panel that opens a dataset of the site as an image of the
 * Advanced view — a z projection of a z-stack (from the original TIFF of the server when there is one, else from the processed
 * volume) or an oblique plane, and, for a photograph (type 2d), its picture. Runs on the page only, before IJApp.mount.
 *
 * What it uses (PLAN-wave3 §3.1 / §4):
 *   ctx.studio.library   list() describe() openPlanes() openOblique() tiffIndex() preview() viewerUrl() release() — reached through
 *                        IJLibPage.attach(ctx), which ij-app.js calls at the start of enter() (the extension API of IJApp has no
 *                        member for the Studio facade; this handshake is the package's own).
 *   worker commands      doc.tiff.project · doc.zproj.begin|add|finish|abort · doc.oblique.begin|add|finish|abort (ij-proc-lib.js),
 *                        reached with api.call and taken in with api.adopt; every call of api.call is one busy step, so a page-driven
 *                        stream waits for the busy state to end between calls and the panel keeps its own progress and Cancel.
 *   IJLibSource          the pure rules (TIFF facts, µm mapping of the slices, names, session keys) of ij-proc-lib.js.
 * Settings (api.settings, prefix lib.): lib.method (the ZProjector method last used, shared with the Z Project dialog of the entry
 * flow; Average Intensity on first use, ZProjector.java:27 Prefs.get(METHOD_KEY, AVG_METHOD)), lib.source ('tiff' | 'processed',
 * the source last chosen), lib.badges ({ id: bool } the datasets known to hold an original TIFF).
 * No innerHTML: every text goes through textContent; an error never shows err.message (the app maps the code to a sentence).
 */
(function () {
  'use strict';
  if (typeof IJApp === 'undefined' || typeof IJApp.extend !== 'function') return;

  const g = typeof self !== 'undefined' ? self : globalThis;
  const MIB = 1048576;
  const METHOD_KEYS = { avg: 'dlg.lib.methodAvg', max: 'dlg.lib.methodMax', min: 'dlg.lib.methodMin', sum: 'dlg.lib.methodSum', sd: 'dlg.lib.methodSd', median: 'dlg.lib.methodMedian' };
  const TYPE_IDS = ['3d', '2d', 'live'];
  const PROJECTIONS = ['single', 'max', 'mean'];
  const PROJECTION_KEYS = { single: 'dlg.lib.projSingle', max: 'dlg.lib.projMax', mean: 'dlg.lib.projMean' };
  // The slice inspector's ranges (viewer.html: slicer-yaw / -pitch / -roll / -position / -slab)
  const RANGES = { yaw: [-180, 180], pitch: [-89, 89], roll: [-180, 180], slab: [1, 32] };
  const TIFF_MAX = 6;                                       // files of download/ that are indexed per dataset
  const PREVIEW_MS = 250;

  /* Library and TIFF-stream codes → plugin lang keys (extend({errors})); the codes of the worker commands are IJ_LIB_*. */
  const LIB_ERRORS = {
    LIBRARY_UNKNOWN: 'err.libUnknown', LIBRARY_BAD_MANIFEST: 'err.libBadManifest', LIBRARY_FORMAT_UNSUPPORTED: 'err.libFormat',
    LIBRARY_OBLIQUE_UNSUPPORTED: 'err.libOblique', LIBRARY_LEVEL_UNSUPPORTED: 'err.libLevel', LIBRARY_TIMEPOINT: 'err.libTimepoint',
    LIBRARY_SOURCE_LOST: 'err.libSourceLost', LIBRARY_RELEASED: 'err.libReleased', LIBRARY_TIFF_INDEX: 'err.libTiffIndex',
    LIBRARY_BAD_ARGS: 'err.libBadArgs', LIBRARY_PLANE_MISSES: 'err.libPlaneMisses',
    IJ_LIB_TIFF_UNSUPPORTED: 'err.libTiffUnsupported', IJ_LIB_TIFF_NO_RANGE: 'err.libTiffNoRange', IJ_LIB_TIFF_HTTP: 'err.libTiffHttp',
    IJ_LIB_TIFF_CORRUPT: 'err.libTiffCorrupt', IJ_LIB_TIFF_NO_INFLATE: 'err.libTiffNoInflate', IJ_LIB_BAD_ARGS: 'err.libBadArgs',
    IJ_LIB_NO_TOKEN: 'err.libLost', IJ_LIB_PHOTO: 'err.libPhoto'
  };
  // A refusal the viewer can serve: the panel offers the link to it (a new tab, the work in progress stays open)
  const NEEDS_VIEWER = new Set(['LIBRARY_FORMAT_UNSUPPORTED', 'LIBRARY_OBLIQUE_UNSUPPORTED', 'LIBRARY_LEVEL_UNSUPPORTED']);

  // ───────────────────────────── helpers ─────────────────────────────
  // a DOM node: h('div', { class, text, value, type, title, on: { click } }, [children])
  const PROPS = new Set(['value', 'checked', 'disabled', 'type', 'title', 'rows', 'cols', 'name', 'min', 'max', 'step', 'href', 'target', 'rel', 'src', 'alt', 'tabIndex', 'selected', 'draggable']);
  function h(tag, props, kids) {
    const el = document.createElement(tag);
    const p = props || {};
    for (const k of Object.keys(p)) {
      const v = p[k];
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'on') for (const ev of Object.keys(v)) el.addEventListener(ev, v[ev]);
      else if (PROPS.has(k)) el[k] = v;
      else el.setAttribute(k, String(v));
    }
    for (const c of kids || []) if (c) el.appendChild(c);
    return el;
  }
  // `children` is a getter-only property of a real Element (strict mode: assigning it throws): empty the node through the DOM
  const clear = (el) => { if (typeof el.replaceChildren === 'function') el.replaceChildren(); else { while (el.firstChild) el.removeChild(el.firstChild); el.textContent = ''; } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isAbort = (err) => !!err && (err.name === 'AbortError' || err.code === 'IJ_CANCELLED' || err.cancelled === true);
  const abortError = () => (typeof DOMException === 'function' ? new DOMException('aborted', 'AbortError') : Object.assign(new Error('aborted'), { name: 'AbortError' }));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d);
  const mb = (bytes) => (bytes >= 1024 * MIB ? (bytes / (1024 * MIB)).toFixed(2) + ' GB' : bytes >= 10 * MIB ? Math.round(bytes / MIB) + ' MB' : (bytes / MIB).toFixed(1) + ' MB');
  const um = (v) => (v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' µm';
  const bytesPerPixel = (bits) => (bits === 8 ? 1 : bits === 16 ? 2 : 4);
  const settingsGet = (api, k, d) => { try { const v = api.settings.get(k); return v === undefined || v === null ? d : v; } catch (_) { return d; } };
  const settingsSet = (api, k, v) => { try { api.settings.set(k, v); } catch (_) { /* prefs are a convenience */ } };

  // ───────────────────────────── the handshake with ij-app.js ─────────────────────────────
  const ATT = { ctx: null, budget: () => 0 };
  const library = () => { try { return (ATT.ctx && ATT.ctx.studio && ATT.ctx.studio.library) || null; } catch (_) { return null; } };
  let lastController = null;

  /* ── photographs ── */
  /* A photograph (image.webp) decoded on the page: createImageBitmap without colour conversion keeps the stored values. The RGBA bytes
   * go to the worker as they are (doc.photo.create splits R / G / B and tests for a grey picture there: CLAUDE.md §1.2, the main thread does
   * no per-pixel work). → { width, height, rgba: Uint8ClampedArray } */
  async function decodePhoto(url, signal) {
    const photoError = (cause) => Object.assign(new Error('photograph'), { code: 'IJ_LIB_PHOTO', cause });
    let blob;
    try {
      const resp = await fetch(url, { signal });
      if (!resp.ok) throw photoError(new Error('HTTP ' + resp.status));
      blob = await resp.blob();
    } catch (e) { if (isAbort(e) || (e && e.code === 'IJ_LIB_PHOTO')) throw e; throw photoError(e); }
    let bmp;
    try {
      try { bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none' }); } catch (_) { bmp = await createImageBitmap(blob); }
    } catch (e) { if (isAbort(e)) throw e; throw photoError(e); }
    try {
      const w = bmp.width, hgt = bmp.height;
      // read in bands of ~1 Mpx, yielding between them (never one full-size canvas: a browser limits a canvas's area), and refuse
      // a picture the page could not hold next to the worker's copy
      const budget = ATT.budget();
      if (!(w > 0 && hgt > 0)) throw photoError(null);
      if (w * hgt > 33554432 || (budget > 0 && 4 * w * hgt > budget)) throw Object.assign(new Error('photograph too large'), { code: 'IJ_TOO_LARGE' });
      const rgba = new Uint8ClampedArray(4 * w * hgt);
      const bandH = Math.max(1, Math.min(hgt, Math.floor(1048576 / w)));
      const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, bandH) : Object.assign(document.createElement('canvas'), { width: w, height: bandH });
      const c2 = canvas.getContext('2d', { willReadFrequently: true });
      if (!c2) throw photoError(null);
      try {
        for (let y0 = 0; y0 < hgt; y0 += bandH) {
          if (signal && signal.aborted) throw abortError();
          const bh = Math.min(bandH, hgt - y0);
          c2.clearRect(0, 0, w, bandH);
          c2.drawImage(bmp, 0, y0, w, bh, 0, 0, w, bh);
          rgba.set(c2.getImageData(0, 0, w, bh).data, 4 * w * y0);
          await sleep(0);
        }
      } catch (e) { if (isAbort(e)) throw e; throw photoError(e); }
      return { width: w, height: hgt, rgba };
    } finally { if (bmp && typeof bmp.close === 'function') bmp.close(); }
  }

  // ───────────────────────────── the panel's controller ─────────────────────────────
  /**
   * The state machine of the panel. `env` replaces what the browser gives (tests): { decodePhoto, delay(fn, ms) → cancel }.
   * Everything the operator does has a method here; the DOM only calls them.
   */
  function createController(api, env) {
    const E = Object.assign({ decodePhoto, delay: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } }, env || {});
    const tr = (key, params) => api.tr(key, params);
    const st = {
      query: '', types: [], items: [], cursor: 0, selected: null,
      desc: null, descState: 'idle', descCode: null,
      tiffs: [],                         // [{ file, url, sizeBytes, state: 'loading' | 'ok' | 'bad', facts, reason, index }]
      mode: 'z', first: 0, last: 0, asStack: false, method: String(settingsGet(api, 'lib.method', 'avg')), source: 'tiff', tiffFile: null, level: 0, timepoint: 0,
      spec: { yaw: 0, pitch: 0, roll: 0, depth: 0.5, thickness: 1, projection: 'single' },
      run: null, note: '', previewState: 'none',
      badges: {}
    };
    if (!IJLibSource.METHODS.includes(st.method)) st.method = 'avg';
    try { const b = settingsGet(api, 'lib.badges', {}); if (b && typeof b === 'object' && !Array.isArray(b)) st.badges = Object.assign({}, b); } catch (_) { /* none */ }
    const ctl = { st, el: null, refs: {}, disposed: false };
    let descSeq = 0, descAbort = null, previewAbort = null, cancelPreviewTimer = null;

    // ── the list ──
    const typeLabel = (type) => { try { if (typeof Utils !== 'undefined' && typeof Utils.datasetTypeLabel === 'function') return String(Utils.datasetTypeLabel(type)); } catch (_) { /* the id */ } return String(type); };
    function loadItems() {
      const lib = library();
      try { st.items = lib ? lib.list().slice().sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true })) : []; } catch (err) { console.error('[advanced-studio] library list', err); st.items = []; }
    }
    function visible() {
      const q = st.query.trim().toLowerCase();
      return st.items.filter((it) => {
        if (st.types.length && !st.types.includes(it.type)) return false;
        if (!q) return true;
        const hay = [it.name, it.id, it.stage, it.embryo, typeLabel(it.type)].filter((x) => x !== null && x !== undefined).join(' ').toLowerCase();
        return q.split(/\s+/).every((w) => hay.includes(w));
      });
    }
    function setQuery(q) { st.query = String(q || ''); st.cursor = 0; renderList(); }
    function toggleType(type) {
      const i = st.types.indexOf(type);
      if (i >= 0) st.types.splice(i, 1); else st.types.push(type);
      st.cursor = 0;
      renderList();
    }
    /** Keyboard navigation of the grid: the arrows move the cursor (no network), Enter / Space picks it. */
    function key(name) {
      const list = visible();
      if (!list.length) return false;
      const cols = Math.max(1, ctl.cols || 1);
      const at = clamp(st.cursor, 0, list.length - 1);
      let next = at;
      if (name === 'ArrowRight') next = at + 1;
      else if (name === 'ArrowLeft') next = at - 1;
      else if (name === 'ArrowDown') next = at + cols;
      else if (name === 'ArrowUp') next = at - cols;
      else if (name === 'Home') next = 0;
      else if (name === 'End') next = list.length - 1;
      else if (name === 'Enter' || name === ' ') { pick(list[at].id); return true; }
      else return false;
      st.cursor = clamp(next, 0, list.length - 1);
      renderList();
      focusCard(st.cursor);
      return true;
    }
    function focusCard(i) { const c = ctl.refs.cards && ctl.refs.cards[i]; if (c && typeof c.focus === 'function') c.focus(); }

    // ── describing a dataset ──
    const item = () => st.items.find((x) => x.id === st.selected) || null;
    function rememberBadge(id, has) {
      if (st.badges[id] === has) return;
      st.badges[id] = has;
      settingsSet(api, 'lib.badges', st.badges);
      renderList();                                  // the card of this dataset gains (or loses) its TIFF badge
    }
    function pick(id) {
      if (st.run) return Promise.resolve(false);
      if (st.selected === id && st.descState !== 'error') return Promise.resolve(true);
      st.selected = id;
      const it = item();
      st.timepoint = 0;
      st.note = ''; st.noteViewer = false; st.tiffChosen = false; st.sourceSet = false; st.keepRange = false;
      st.mode = it && it.type === '2d' ? 'photo' : 'z';
      renderList();
      return describeSelected();
    }

    async function describeSelected() {
      const lib = library();
      const id = st.selected;
      if (!lib || !id) return false;
      if (descAbort) descAbort.abort();
      const ac = new AbortController();
      descAbort = ac;
      const seq = ++descSeq;
      st.descState = 'loading'; st.desc = null; st.descCode = null; st.tiffs = [];
      renderDetail();
      try {
        const it = item();
        const opt = { signal: ac.signal };
        if (it && it.type === 'live') opt.timepoint = st.timepoint;
        const desc = await lib.describe(id, opt);
        if (seq !== descSeq) return false;
        st.desc = desc;
        st.descState = 'ready';
        st.tiffs = (desc.tiffs || []).slice(0, TIFF_MAX).map((t) => ({ file: t.file, url: t.url, sizeBytes: t.sizeBytes, state: 'loading', facts: null, reason: null, index: null }));
        rememberBadge(id, (desc.tiffs || []).length > 0);
        { const keep = st.keepRange; st.keepRange = false; applyDefaults(keep); }
        renderDetail();
        schedulePreview();
        await Promise.all(st.tiffs.map((t) => indexTiff(lib, id, t, seq, ac.signal)));
        return seq === descSeq;
      } catch (err) {
        if (seq !== descSeq || isAbort(err)) return false;
        console.error('[advanced-studio] library describe', err);
        st.descState = 'error'; st.descCode = (err && err.code) || null;
        renderDetail();
        return false;
      }
    }

    async function indexTiff(lib, id, t, seq, signal) {
      try {
        const index = await lib.tiffIndex(id, t.file, { signal });
        if (seq !== descSeq) return;
        t.index = index;
        const d = st.desc;
        const is2d = d.type === '2d';
        t.facts = IJLibSource.tiffFacts(index, {
          physicalUm: is2d ? null : d.physicalUm, dims: d.levels && d.levels[0] ? d.levels[0].dims : (d.photo ? { x: d.photo.width, y: d.photo.height, z: 1 } : null),
          live: d.type === 'live', timepoint: d.timepoint === undefined ? st.timepoint : d.timepoint, asChannels: is2d
        });
        t.state = t.facts.ok ? 'ok' : 'bad';
        t.reason = t.facts.ok ? null : t.facts.reason;
      } catch (err) {
        if (seq !== descSeq || isAbort(err)) return;
        console.error('[advanced-studio] library tiff index', err);
        t.state = 'bad'; t.reason = 'index'; t.code = err && err.code;
      }
      applyDefaults(true);
      renderDetail();
    }

    // ── defaults, derived values ──
    const usableTiffs = () => st.tiffs.filter((t) => t.state === 'ok');
    const tiffNow = () => usableTiffs().find((t) => t.file === st.tiffFile) || usableTiffs()[0] || null;
    const zLevels = () => (st.desc && st.desc.z && st.desc.z.available ? st.desc.z.levels || [] : []);
    const obliqueLevels = () => (st.desc && st.desc.oblique && st.desc.oblique.available ? st.desc.oblique.levels || [] : []);
    /** The slices of the level-0 stack the sliders span: the volume's, else (a dataset only the TIFF can serve) the TIFF's. */
    function depthOf() {
      const d = st.desc;
      if (d && d.levels && d.levels[0] && d.levels[0].dims.z > 0) return d.levels[0].dims.z;
      const t = tiffNow();
      return t ? t.facts.slices : 1;
    }
    /** "Stack" beside the projections: the slices of the range open as the slices of a z-stack (a single plane is no stack). */
    const isStack = () => st.mode === 'z' && st.asStack && st.last > st.first;
    // ZProjector's output depth for an 8-bit stack (doc.zproj.begin: inputBitDepth 8); one plane is no projection; a stack keeps the 8 bits
    const outBitsProcessed = (depth) => (isStack() ? 8 : IJProject.outputBitDepth(depth > 1 ? st.method : 'avg', depth, 8));
    function levelRows() {
      const d = st.desc;
      if (!d || !d.levels) return [];
      const keep = st.mode === 'oblique' ? obliqueLevels() : zLevels();
      const nCh = Math.max(1, (d.channels || []).length);
      const rows = d.levels.filter((l) => keep.includes(l.level)).map((l) => ({ level: l.level, width: l.width, height: l.height, indices: { length: l.dims.z } }));
      const depth = Math.max(1, Math.round(st.last - st.first + 1));
      const bits = st.mode === 'oblique' ? 8 : outBitsProcessed(depth);
      // a stack holds every plane of the range: a level fits when `depth` planes (and the undo step beside them) fit
      const stack = isStack();
      const planned = IJApp.planLevels({ channels: new Array(nCh).fill(null), levels: rows }, (ATT.budget() || Infinity) / (stack ? depth : 1), bits);     // no budget known: no limit
      return stack ? planned.map((r) => Object.assign({}, r, { bytes: r.bytes * depth, bytes8: r.bytes8 * depth, bytes32: r.bytes32 * depth })) : planned;
    }
    function applyDefaults(fromTiff) {
      const d = st.desc;
      if (!d) return;
      const nz = depthOf();
      if (!fromTiff) { st.first = 0; st.last = Math.max(0, nz - 1); }
      st.first = clamp(st.first, 0, nz - 1); st.last = clamp(st.last, st.first, nz - 1);
      const zOk = zLevels().length > 0 || usableTiffs().length > 0 || st.tiffs.some((t) => t.state === 'loading');
      if (d.type !== '2d') {
        if (st.mode === 'z' && !zOk && obliqueLevels().length) st.mode = 'oblique';
        if (st.mode === 'oblique' && !obliqueLevels().length && zOk) st.mode = 'z';
      }
      // the source: the remembered one when it is on offer, else the TIFF when there is one
      const remembered = settingsGet(api, 'lib.source', 'tiff');
      const tiffOn = usableTiffs().length > 0, procOn = d.type === '2d' ? !!d.photo : zLevels().length > 0;
      if (!fromTiff || !st.sourceSet) {
        if (remembered === 'processed' && procOn) st.source = 'processed';
        else if (tiffOn) st.source = 'tiff';
        else if (procOn) st.source = 'processed';
        else st.source = remembered === 'processed' ? 'processed' : 'tiff';
      }
      if (st.source === 'tiff' && !tiffOn && procOn && !st.tiffs.some((t) => t.state === 'loading')) st.source = 'processed';
      if (!st.tiffChosen || !usableTiffs().some((t) => t.file === st.tiffFile)) {      // the finest TIFF, until the operator picks one
        const best = usableTiffs().slice().sort((a, b) => b.facts.width * b.facts.height - a.facts.width * a.facts.height)[0];
        st.tiffFile = best ? best.file : null;
      }
      // the level: the finest one that fits the memory
      const rows = levelRows();
      if (!rows.some((r) => r.level === st.level && r.fits)) { const fit = rows.find((r) => r.fits); st.level = fit ? fit.level : (rows[0] ? rows[0].level : 0); }
    }

    // ── what the operator sets ──
    function setMode(mode) {
      if (st.run || (mode !== 'z' && mode !== 'oblique')) return;
      if (mode === 'oblique' && !obliqueLevels().length) return;
      st.mode = mode;
      applyDefaults(true);
      renderDetail();
      schedulePreview();
    }
    function setRange(first, last) {
      const nz = depthOf();
      st.first = clamp(Math.round(num(first, st.first)), 0, nz - 1);
      st.last = clamp(Math.round(num(last, st.last)), 0, nz - 1);
      if (st.last < st.first) { if (first !== undefined && first !== null && first !== st.first) st.last = st.first; else st.first = st.last; }
      applyDefaults(true);
      renderDerived();
      schedulePreview();
    }
    function setStack(on) {
      if (st.run) return;
      st.asStack = !!on;
      applyDefaults(true);
      renderDetail();
    }
    function setMethod(m) {
      if (!IJLibSource.METHODS.includes(m)) return;
      st.method = m;
      settingsSet(api, 'lib.method', m);
      applyDefaults(true);
      renderDetail();
    }
    function setSource(src) {
      if (st.run || (src !== 'tiff' && src !== 'processed')) return;
      st.source = src; st.sourceSet = true;
      settingsSet(api, 'lib.source', src);
      applyDefaults(true);
      renderDetail();
    }
    function setTiff(file) { if (usableTiffs().some((t) => t.file === file)) { st.tiffFile = file; st.tiffChosen = true; renderDetail(); } }
    function setLevel(level) { if (levelRows().some((r) => r.level === level && r.fits)) { st.level = level; renderDerived(); } }
    function setSpec(patch) {
      const s = st.spec;
      for (const k of ['yaw', 'pitch', 'roll']) if (patch[k] !== undefined) s[k] = clamp(Math.round(num(patch[k], s[k])), RANGES[k][0], RANGES[k][1]);
      if (patch.depth !== undefined) s.depth = clamp(num(patch.depth, s.depth), 0, 1);
      if (patch.thickness !== undefined) s.thickness = clamp(Math.round(num(patch.thickness, s.thickness)), RANGES.slab[0], RANGES.slab[1]);
      if (patch.projection !== undefined && PROJECTIONS.includes(patch.projection)) s.projection = patch.projection;
      renderDerived();
      schedulePreview();
    }
    function setTimepoint(n) {
      const it = item();
      if (!it || it.type !== 'live') return Promise.resolve(false);
      const max = Math.max(0, (it.timepoints || 1) - 1);
      st.timepoint = clamp(Math.round(num(n, 0)), 0, max);
      st.keepRange = true;                           // the same slices of the next timepoint
      return describeSelected();
    }

    // ── what Open would do ──
    /** Whether the TIFF read fits the engine's memory: the accumulators, the smallest band the handler falls back to (one strip of every
     *  page of the range) and its fetch window, as doc.tiff.project reserves them. No known budget = no limit. */
    function tiffFits(t, asPhoto) {
      const budget = ATT.budget();
      if (!budget) return true;
      const f = t.facts, p = f.plan;
      const r = asPhoto ? { jlo: 0, jhi: 0 } : tiffRangeFor(t);
      const depth = r.jhi - r.jlo + 1;
      const bandRows = Math.min(p.height, p.rowsPerStrip);
      let need;
      try {
        need = IJProject.estimateBytes({ method: asPhoto || depth < 2 ? 'avg' : st.method, width: p.width, height: p.height, depth, channels: f.names.length, bandRows, inputBitDepth: p.bitDepth })
          + 2 * bandRows * p.width * (p.bitDepth / 8) * (p.spp + 1) + 4 * MIB;
      } catch (_) { return true; }
      return need <= budget;
    }
    /** Bytes a stack read from a TIFF holds in memory: every plane of every channel at the TIFF's bit depth. */
    function tiffStackBytes(t) {
      const f = t.facts, r = tiffRangeFor(t);
      return (r.jhi - r.jlo + 1) * f.names.length * f.width * f.height * (f.bitDepth / 8);
    }
    const stackTooLarge = (bytes) => ({ ok: false, reason: 'dlg.lib.stackTooLarge', params: { size: mb(bytes), budget: mb(ATT.budget() || 0) } });
    function plan() {
      const d = st.desc;
      if (!d || st.descState !== 'ready') return { ok: false, reason: st.descState === 'loading' ? 'dlg.lib.describing' : 'dlg.lib.pickOne' };
      if (d.type === '2d') {
        if (st.source === 'tiff') { const t = tiffNow(); return t ? (tiffFits(t, true) ? { ok: true, kind: 'photoTiff' } : { ok: false, reason: 'dlg.lib.noLevelFits' }) : { ok: false, reason: 'dlg.lib.noTiff' }; }
        return d.photo ? { ok: true, kind: 'photoWebp' } : { ok: false, reason: 'dlg.lib.noPhoto' };
      }
      if (st.mode === 'oblique') {
        const lv = levelRows().find((r) => r.level === st.level);
        if (!obliqueLevels().length) return { ok: false, reason: 'dlg.lib.obliqueNo' };
        return lv && lv.fits ? { ok: true, kind: 'oblique' } : { ok: false, reason: 'dlg.lib.noLevelFits' };
      }
      if (st.source === 'tiff' && isStack()) {
        const t = tiffNow();
        if (!t) return { ok: false, reason: st.tiffs.some((x) => x.state === 'loading') ? 'dlg.lib.describing' : 'dlg.lib.noTiff' };
        const need = tiffStackBytes(t);
        return !ATT.budget() || need * 2 + 4 * MIB <= ATT.budget() ? { ok: true, kind: 'stackTiff' } : stackTooLarge(need);
      }
      if (st.source === 'tiff') { const t = tiffNow(); return t ? (tiffFits(t, false) ? { ok: true, kind: 'zTiff' } : { ok: false, reason: 'dlg.lib.noLevelFits' }) : { ok: false, reason: st.tiffs.some((x) => x.state === 'loading') ? 'dlg.lib.describing' : 'dlg.lib.noTiff' }; }
      if (!zLevels().length) return { ok: false, reason: 'dlg.lib.zNo' };
      const lv = levelRows().find((r) => r.level === st.level);
      if (isStack()) return lv && lv.fits ? { ok: true, kind: 'stackProcessed' } : (lv ? stackTooLarge(lv.bytes) : { ok: false, reason: 'dlg.lib.noLevelFits' });
      return lv && lv.fits ? { ok: true, kind: 'zProcessed' } : { ok: false, reason: 'dlg.lib.noLevelFits' };
    }
    /** The z range of the dataset's level 0 → the TIFF planes (µm mapping of PLAN-wave3 §4). */
    function tiffRangeFor(t) {
      return IJLibSource.tiffRangeOf(t.facts, depthOf(), st.first, st.last);
    }
    function resultLine() {
      const p = plan();
      if (!p.ok) return '';
      const d = st.desc;
      const nCh = Math.max(1, (d.channels || []).length);
      if (p.kind === 'zTiff' || p.kind === 'photoTiff') {
        const t = tiffNow(), f = t.facts;
        const r = p.kind === 'zTiff' ? tiffRangeFor(t) : { jlo: 0, jhi: 0 };
        const depth = r.jhi - r.jlo + 1;
        const bits = p.kind === 'photoTiff' ? f.bitDepth : IJProject.outputBitDepth(r.single ? 'avg' : st.method, depth, f.bitDepth);
        const read = IJLibSource.readBytes(f.plan, r.jlo, r.jhi, f.frame, f.names.map((_, i) => i));
        return tr('dlg.lib.resultTiff', { w: f.width, h: f.height, c: f.channels, bits, size: mb(f.width * f.height * f.channels * bytesPerPixel(bits)), planes: depth, read: mb(read) });
      }
      if (p.kind === 'stackTiff') {
        const t = tiffNow(), f = t.facts, r = tiffRangeFor(t);
        return tr('dlg.lib.resultStack', { w: f.width, h: f.height, c: f.channels, bits: f.bitDepth, planes: r.jhi - r.jlo + 1, size: mb(tiffStackBytes(t)) });
      }
      if (p.kind === 'stackProcessed') {
        const lv = levelRows().find((r) => r.level === st.level);
        return lv ? tr('dlg.lib.resultStack', { w: lv.width, h: lv.height, c: nCh, bits: 8, planes: st.last - st.first + 1, size: mb(lv.bytes) }) : '';
      }
      if (p.kind === 'photoWebp') return tr('dlg.lib.resultPhoto', { w: d.photo.width || '?', h: d.photo.height || '?' });
      const lv = levelRows().find((r) => r.level === st.level);
      if (!lv) return '';
      const bits = p.kind === 'oblique' ? 8 : outBitsProcessed(Math.max(1, st.last - st.first + 1));
      return tr('dlg.lib.resultProcessed', { w: lv.width, h: lv.height, c: nCh, bits, size: mb(lv.width * lv.height * nCh * bytesPerPixel(bits)) });
    }

    // ── running ──
    function setProgress(fraction, label) {
      if (!st.run) return;
      st.run.fraction = fraction; if (label !== undefined) st.run.label = label;
      renderRun();
    }
    /** One worker command: waits until nothing else is running (api.call is one busy step), null from api.call = refused or failed
     *  (already reported to the operator by the app). */
    async function work(signal, cmd, args, transfer, o) {
      while (api.state().busy) { if (signal.aborted) throw abortError(); await sleep(80); }
      if (signal.aborted) throw abortError();
      const res = await api.call(cmd, args, Object.assign({ transfer: transfer || [], labelKey: 'op.libWorking' }, o || {}));
      if (res === null || res === undefined) throw Object.assign(new Error('refused'), { code: 'IJ_LIB_REFUSED', reported: true });
      return res;
    }
    /** Frees a half-built accumulator of the worker: waits for the busy step to end first (api.call is refused while one runs). */
    async function dropToken(cmd, token) {
      for (let i = 0; i < 100 && api.state().busy; i++) await sleep(50);
      try { await api.call(cmd, { token }); } catch (_) { /* the worker evicts an old token itself */ }
    }
    async function guarded(kind, fn) {
      if (st.run) return false;
      const ac = new AbortController();
      st.run = { kind, ac, fraction: null, label: tr('dlg.lib.starting') };
      st.note = ''; st.noteExtra = ''; st.noteViewer = false;
      renderDetail();
      let ok = false;
      try { await fn(ac.signal); ok = true; st.note = tr('dlg.lib.opened'); } catch (err) {
        if (isAbort(err)) st.note = tr('dlg.lib.cancelled');
        else if (err && err.reported) st.note = tr('dlg.lib.notOpened');
        else {
          st.note = tr('dlg.lib.notOpened');
          st.noteViewer = !!err && (err.needsViewer === true || NEEDS_VIEWER.has(err.code));   // the viewer can serve it: a link beside the note
          await api.error(err);
        }
      } finally { st.run = null; if (!ctl.disposed) renderDetail(); }
      return ok;
    }
    function cancel() {
      if (!st.run) return false;
      st.run.ac.abort();
      return true;
    }
    const stampNow = () => Date.now().toString(36);
    function baseProvenance(input, extra) {
      const d = st.desc;
      return Object.assign({ source: 'library', input, datasetId: d.id, datasetName: d.name, treeKey: d.treeKey, timepoint: d.type === 'live' ? d.timepoint === undefined ? st.timepoint : d.timepoint : null }, extra);
    }
    const tpName = (name) => (st.desc.type === 'live' ? name + ' t' + st.timepoint : name);

    async function openZProcessed(signal) {
      const lib = library(), d = st.desc;
      const channels = d.channels || [];
      const method = st.method, first = st.first, last = st.last, level = st.level;
      const tp = d.type === 'live' ? st.timepoint : undefined;
      const sessionKey = IJLibSource.sessionKey({ datasetId: d.id, treeKey: d.treeKey, timepoint: d.type === 'live' ? st.timepoint : null, mode: 'z', first, last, level, method, input: 'processed', stamp: stampNow() });
      const provenance = baseProvenance('processed', { mode: 'z', level, first, last, method, sessionKey });
      const session = await lib.openPlanes(d.id, { axis: 'z', first, last, level, timepoint: tp, signal });
      let token = null, done = false;
      try {
        const depth = session.depth;
        const name = depth > 1
          ? IJLibSource.projectionTitle(method, tpName(tr('dlg.lib.nameZ', { dataset: d.name, a: first, b: last })))
          : tpName(tr('dlg.lib.nameZ1', { dataset: d.name, a: first }));
        const m = depth > 1 ? method : 'avg';
        const begin = await work(signal, 'doc.zproj.begin', { method: m, width: session.width, height: session.height, depth,
          channels: channels.map((c) => ({ name: c.name, color: c.color || undefined })), name, calibration: session.calibration, provenance, sessionKey, bandRows: session.bandRows });
        token = begin.token;
        const bandRows = Math.max(1, Math.min(session.bandRows, begin.bandRows || session.bandRows));
        const zChunk = Math.max(1, session.zChunk || 1);
        const chIdx = channels.map((c) => c.index);
        const total = Math.ceil(session.height / bandRows) * depth;
        let donePlanes = 0;
        for (let y0 = 0; y0 < session.height; y0 += bandRows) {
          const y1 = Math.min(session.height, y0 + bandRows);
          for (let z0 = 0; z0 < depth; z0 += zChunk) {
            const z1 = Math.min(depth, z0 + zChunk);
            if (signal.aborted) throw abortError();
            session.assertFrame();
            const blk = await session.readBlock({ y0, y1, z0, z1, channels: chIdx, signal });
            const data = blk.data.map((a) => (a.byteOffset === 0 && a.byteLength === a.buffer.byteLength ? a : a.slice()));
            await work(signal, 'doc.zproj.add', { token, y0, rows: blk.rows, z0, depth: z1 - z0, data }, data.map((a) => a.buffer), { long: true });
            donePlanes += z1 - z0;
            setProgress(donePlanes / total, tr('dlg.lib.progressZ', { pct: Math.round((100 * donePlanes) / total) }));
          }
        }
        const fin = await work(signal, 'doc.zproj.finish', { token });
        done = true; token = null;
        await api.adopt(fin.info, { placement: 'tab', provenance, sessionKey });
      } finally {
        if (token && !done) await dropToken('doc.zproj.abort', token);
        try { session.release(); } catch (_) { /* idempotent */ }
      }
    }

    /** "Stack" of the processed volume: the planes of the range streamed band by band into doc.stack.*, channels kept as channels. */
    async function openStackProcessed(signal) {
      const lib = library(), d = st.desc;
      const channels = d.channels || [];
      const first = st.first, last = st.last, level = st.level;
      const tp = d.type === 'live' ? st.timepoint : undefined;
      const sessionKey = IJLibSource.sessionKey({ datasetId: d.id, treeKey: d.treeKey, timepoint: d.type === 'live' ? st.timepoint : null, mode: 'z', first, last, level, method: 'stack', input: 'processed', stamp: stampNow() });
      const provenance = baseProvenance('processed', { mode: 'z', level, first, last, method: 'stack', sessionKey });
      const session = await lib.openPlanes(d.id, { axis: 'z', first, last, level, timepoint: tp, signal });
      let token = null, done = false;
      try {
        const depth = session.depth;
        const lv = (d.levels || []).find((l) => l.level === level);
        const calibration = Object.assign({}, session.calibration, lv && lv.voxelUm && lv.voxelUm.z > 0 ? { pixelDepth: lv.voxelUm.z } : {});
        const name = tpName(tr('dlg.lib.nameStack', { dataset: d.name, a: first, b: last }));
        const begin = await work(signal, 'doc.stack.begin', { width: session.width, height: session.height, depth,
          channels: channels.map((c) => ({ name: c.name, color: c.color || undefined })), name, calibration, provenance, sessionKey });
        token = begin.token;
        const bandRows = Math.max(1, session.bandRows);
        const zChunk = Math.max(1, session.zChunk || 1);
        const chIdx = channels.map((c) => c.index);
        const total = Math.ceil(session.height / bandRows) * depth;
        let donePlanes = 0;
        for (let y0 = 0; y0 < session.height; y0 += bandRows) {
          const y1 = Math.min(session.height, y0 + bandRows);
          for (let z0 = 0; z0 < depth; z0 += zChunk) {
            const z1 = Math.min(depth, z0 + zChunk);
            if (signal.aborted) throw abortError();
            session.assertFrame();
            const blk = await session.readBlock({ y0, y1, z0, z1, channels: chIdx, signal });
            const data = blk.data.map((a) => (a.byteOffset === 0 && a.byteLength === a.buffer.byteLength ? a : a.slice()));
            await work(signal, 'doc.stack.add', { token, y0, rows: blk.rows, z0, depth: z1 - z0, data }, data.map((a) => a.buffer), { long: true });
            donePlanes += z1 - z0;
            setProgress(donePlanes / total, tr('dlg.lib.progressZ', { pct: Math.round((100 * donePlanes) / total) }));
          }
        }
        const fin = await work(signal, 'doc.stack.finish', { token });
        done = true; token = null;
        await api.adopt(fin.info, { placement: 'tab', provenance, sessionKey });
      } finally {
        if (token && !done) await dropToken('doc.stack.abort', token);
        try { session.release(); } catch (_) { /* idempotent */ }
      }
    }

    /** "Stack" of an original TIFF: the TIFF planes covering the range, read in the worker (doc.tiff.stack: batched Range requests). */
    async function openStackTiff(signal) {
      const d = st.desc, t = tiffNow(), f = t.facts;
      const r = tiffRangeFor(t);
      const etag = t.index.size + '-' + t.index.mtime;
      const sessionKey = IJLibSource.sessionKey({ datasetId: d.id, treeKey: d.treeKey, timepoint: d.type === 'live' ? st.timepoint : null, mode: 'z',
        first: st.first, last: st.last, level: f.level, method: 'stack', input: 'tiff', stamp: stampNow() });
      const provenance = baseProvenance('tiff', { mode: 'z', level: f.level, first: st.first, last: st.last, method: 'stack', tiff: { file: t.file, etag }, sessionKey });
      const px = f.pixelUm;
      const zStep = f.vzT > 0 ? f.vzT : (f.plan.spacingUm > 0 ? f.plan.spacingUm : null);
      const calibration = px ? Object.assign({ pixelWidth: px.x, pixelHeight: px.y, unit: 'µm' }, zStep ? { pixelDepth: zStep } : {}) : { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' };
      const name = tpName(tr('dlg.lib.nameStack', { dataset: d.name, a: st.first, b: st.last }));
      const args = { url: t.index.url, index: t.index, asChannels: false, z0: r.jlo, z1: r.jhi, frame: f.frame,
        channels: f.names.map((n, i) => ({ c: i, name: n, color: f.colors[i] })), name, calibration, provenance, sessionKey };
      setProgress(null, tr('dlg.lib.progressTiff'));
      const off = api.on('ext:libTiffProgress', (ev) => { if (ev && ev.fraction >= 0) setProgress(ev.fraction, tr('dlg.lib.progressZ', { pct: Math.round(100 * ev.fraction) })); });
      let res;
      try { res = await work(signal, 'doc.tiff.stack', args, [], { labelKey: 'op.libTiff', long: true }); } finally { off(); }
      await api.adopt(res.info, { placement: 'tab', provenance, sessionKey });
    }

    async function openTiff(signal, asPhoto) {
      const d = st.desc, t = tiffNow(), f = t.facts;
      const r = asPhoto ? { jlo: 0, jhi: 0, single: true } : tiffRangeFor(t);
      const depth = r.jhi - r.jlo + 1;
      // a coarser TIFF can map the chosen slices onto one plane: that is a copy ('avg' of one plane), and the image is named after what ran
      const method = asPhoto || depth < 2 ? 'avg' : st.method;
      const etag = t.index.size + '-' + t.index.mtime;
      const stamp = stampNow();
      const sessionKey = IJLibSource.sessionKey({ datasetId: d.id, treeKey: d.treeKey, timepoint: d.type === 'live' ? st.timepoint : null, mode: asPhoto ? 'photo' : 'z',
        first: st.first, last: st.last, level: f.level, method, input: 'tiff', stamp });
      const provenance = baseProvenance('tiff', { mode: asPhoto ? 'photo' : 'z', level: f.level, first: st.first, last: st.last, method, tiff: { file: t.file, etag }, sessionKey });
      const px = f.pixelUm || (asPhoto && d.photo && d.photo.pixelSizeUm && d.photo.pixelSizeUm.x > 0 && d.photo.pixelSizeUm.y > 0 ? d.photo.pixelSizeUm : null);
      const calibration = px ? { pixelWidth: px.x, pixelHeight: px.y, unit: 'µm' } : { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' };
      const name = asPhoto ? d.name
        : depth > 1 ? IJLibSource.projectionTitle(method, tpName(tr('dlg.lib.nameZ', { dataset: d.name, a: st.first, b: st.last }))) : tpName(tr('dlg.lib.nameZ1', { dataset: d.name, a: st.first }));
      const args = { url: t.index.url, index: t.index, asChannels: !!asPhoto, z0: r.jlo, z1: r.jhi, frame: f.frame, method,
        channels: f.names.map((n, i) => ({ c: i, name: n, color: f.colors[i] })), name, calibration, provenance, sessionKey };
      setProgress(null, tr('dlg.lib.progressTiff'));
      // the worker posts the share of the pages read; the engine's own Cancel (status bar) is the way to stop it
      const off = api.on('ext:libTiffProgress', (ev) => { if (ev && ev.fraction >= 0) setProgress(ev.fraction, tr('dlg.lib.progressZ', { pct: Math.round(100 * ev.fraction) })); });
      let res;
      try { res = await work(signal, 'doc.tiff.project', args, [], { labelKey: 'op.libTiff', long: true }); } finally { off(); }
      // The document exists in the worker by now: when only the panel was closed meanwhile it is still adopted (nothing is left behind there)
      await api.adopt(res.info, { placement: 'tab', provenance, sessionKey });
    }

    async function openOblique(signal) {
      const lib = library(), d = st.desc;
      const tp = d.type === 'live' ? st.timepoint : undefined;
      const spec = Object.assign({}, st.spec);
      const level = st.level;
      const sessionKey = IJLibSource.sessionKey({ datasetId: d.id, treeKey: d.treeKey, timepoint: d.type === 'live' ? st.timepoint : null, mode: 'oblique', spec, level, method: spec.projection, input: 'processed', stamp: stampNow() });
      const provenance = baseProvenance('processed', { mode: 'oblique', level, spec, method: spec.projection, sessionKey });
      const ob = await lib.openOblique(d.id, { level, spec, timepoint: tp, signal });
      let token = null, done = false;
      try {
        const channels = (d.channels || []).map((c) => ({ index: c.index, name: c.name, color: c.color || undefined }));
        const name = tpName(tr('dlg.lib.nameOblique', { dataset: d.name, yaw: spec.yaw, pitch: spec.pitch, roll: spec.roll }));
        const calibration = { pixelWidth: ob.pixelUm.x, pixelHeight: ob.pixelUm.y, unit: 'µm' };
        const begin = await work(signal, 'doc.oblique.begin', { G: ob.geometry, channels, name, calibration, provenance, sessionKey });
        token = begin.token;
        let bricks = 0;
        for (let ci = 0; ci < channels.length; ci++) {
          const c = channels[ci].index;
          setProgress(ci / channels.length, tr('dlg.lib.progressOblique', { c: ci + 1, n: channels.length, bricks }));
          const tally = await ob.run({ channels: [c], signal, onBrick: async (b) => {
            const data = b.data.byteOffset === 0 && b.data.byteLength === b.data.buffer.byteLength ? b.data : b.data.slice();
            await work(signal, 'doc.oblique.add', { token, channel: b.channel, box: b.box, data }, [data.buffer], { long: true });
            bricks++;
          } });
          await work(signal, 'doc.oblique.add', { token, channel: c, done: true, failed: tally.failed.map((f) => ({ x0: f.x0, y0: f.y0, z0: f.z0, x1: f.x1, y1: f.y1, z1: f.z1 })) });
          setProgress((ci + 1) / channels.length, tr('dlg.lib.progressOblique', { c: Math.min(channels.length, ci + 2), n: channels.length, bricks }));
        }
        const fin = await work(signal, 'doc.oblique.finish', { token });
        done = true; token = null;
        await api.adopt(fin.info, { placement: 'tab', provenance, sessionKey });
        if (fin.missing > 0) { st.noteExtra = tr('warn.libMissing', { n: fin.missing }); api.toast('warn.libMissing', { n: fin.missing }); }
      } finally {
        if (token && !done) await dropToken('doc.oblique.abort', token);
        try { ob.release(); } catch (_) { /* idempotent */ }
      }
    }

    async function openPhotoWebp(signal) {
      const d = st.desc, ph = d.photo;
      const got = await E.decodePhoto(ph.imageUrl, signal);
      if (signal.aborted) throw abortError();
      const sessionKey = IJLibSource.sessionKey({ datasetId: d.id, treeKey: '', timepoint: null, mode: 'photo', first: 0, last: 0, level: '', method: '', input: 'processed', stamp: stampNow() });
      const provenance = baseProvenance('processed', { mode: 'photo', sessionKey });
      const px = ph.pixelSizeUm && ph.pixelSizeUm.x > 0 && ph.pixelSizeUm.y > 0 ? ph.pixelSizeUm : null;
      const calibration = px ? { pixelWidth: px.x, pixelHeight: px.y, unit: 'µm' } : { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' };
      setProgress(1, tr('dlg.lib.progressPhoto'));
      if (got.rgba) {
        // R, G, B (or one grey channel) are told apart in the worker
        const rgba = got.rgba.byteOffset === 0 && got.rgba.byteLength === got.rgba.buffer.byteLength ? got.rgba : got.rgba.slice();
        const res = await work(signal, 'doc.photo.create', { name: d.name, width: got.width, height: got.height, rgba, calibration, provenance, sessionKey }, [rgba.buffer]);
        await api.adopt(res.info, { placement: 'tab', provenance, sessionKey });
        return;
      }
      const rgb = got.channels.length === 3;                      // already split (a test stand-in for the decoder)
      const names = rgb ? ['R', 'G', 'B'] : ['Gray'], colors = rgb ? IJLibSource.IMAGEJ_COLORS.slice(0, 3) : ['#ffffff'];
      await api.addDoc({ name: d.name, width: got.width, height: got.height, bitDepth: 8, calibration,
        channels: got.channels.map((data, i) => ({ data, name: names[i], color: colors[i] })) }, { placement: 'tab', provenance, sessionKey });
    }

    /** Open: a new document as a tab; the panel stays open. */
    function open() {
      const p = plan();
      if (!p.ok || st.run) return Promise.resolve(false);
      settingsSet(api, 'lib.source', st.source);
      settingsSet(api, 'lib.method', st.method);
      switch (p.kind) {
        case 'zProcessed': return guarded('z', (s) => openZProcessed(s));
        case 'stackProcessed': return guarded('z', (s) => openStackProcessed(s));
        case 'stackTiff': return guarded('tiff', (s) => openStackTiff(s));
        case 'zTiff': return guarded('tiff', (s) => openTiff(s, false));
        case 'photoTiff': return guarded('tiff', (s) => openTiff(s, true));
        case 'photoWebp': return guarded('photo', (s) => openPhotoWebp(s));
        default: return guarded('oblique', (s) => openOblique(s));
      }
    }

    // ── the live preview of the plane (256 px, a dataset that is on screen) ──
    function schedulePreview() {
      if (cancelPreviewTimer) { cancelPreviewTimer(); cancelPreviewTimer = null; }
      if (previewAbort) { previewAbort.abort(); previewAbort = null; }
      const d = st.desc;
      const lib = library();
      if (!d || !lib || !d.mounted || d.type === '2d' || !lib.preview || st.run) { setPreview(null); return; }
      if (st.mode === 'oblique' ? !obliqueLevels().length : !zLevels().length) { setPreview(null); return; }
      cancelPreviewTimer = E.delay(async () => {
        cancelPreviewTimer = null;
        const ac = new AbortController();
        previewAbort = ac;
        try {
          const q = st.mode === 'oblique' ? { spec: Object.assign({}, st.spec) } : { z: st.first };
          const bmp = await lib.preview(d.id, q, { size: 256, timepoint: d.type === 'live' ? st.timepoint : undefined, signal: ac.signal });
          if (ac.signal.aborted || ctl.disposed) { if (bmp && typeof bmp.close === 'function') bmp.close(); return; }
          setPreview(bmp || null);
        } catch (err) { if (!isAbort(err)) console.error('[advanced-studio] library preview', err); setPreview(null); }
      }, PREVIEW_MS);
    }
    function setPreview(bmp) {
      st.previewState = bmp ? 'shown' : 'none';
      const cv = ctl.refs.preview;
      if (!cv) { if (bmp && typeof bmp.close === 'function') bmp.close(); return; }
      try {
        const c2 = cv.getContext('2d');
        if (bmp) { cv.width = bmp.width; cv.height = bmp.height; c2.drawImage(bmp, 0, 0); } else { c2.clearRect(0, 0, cv.width || 0, cv.height || 0); }
      } catch (_) { /* a canvas that cannot draw: no preview */ }
      cv.style.display = bmp ? '' : 'none';
      if (bmp && typeof bmp.close === 'function') bmp.close();
    }

    // ───────────────────────── DOM ─────────────────────────
    const tx = (key, params) => tr(key, params);
    const btn = (text, fn, cls) => h('button', { class: 'ij-btn' + (cls ? ' ' + cls : ''), type: 'button', text, on: { click: () => { Promise.resolve().then(fn).catch((err) => console.error('[advanced-studio] library', err)); } } });
    const field = (label, control) => h('div', { class: 'ij-field' }, [h('span', { class: 'ij-field-label', text: label }), h('div', { class: 'ij-field-control' }, control)]);
    const radio = (group, value, checked, label, onPick, disabled) => {
      const input = h('input', { type: 'radio', name: group, value, checked: !!checked, disabled: !!disabled, on: { change: () => onPick(value) } });
      return h('label', { class: 'ij-radio' }, [input, h('span', { text: label })]);
    };

    function renderList() {
      const r = ctl.refs;
      if (!r.cards) return;
      clear(r.grid);
      r.cards = [];
      const list = visible();
      st.cursor = clamp(st.cursor, 0, Math.max(0, list.length - 1));
      list.forEach((it, i) => {
        const bits = [];
        if (it.stage) bits.push(String(it.stage));
        bits.push(typeLabel(it.type));
        bits.push(tx('dlg.lib.formatN', { n: it.formatVersion }));
        if (Array.isArray(it.channels) && it.channels.length) bits.push(tx('dlg.lib.channelsN', { n: it.channels.length }));
        const badges = [];
        if (st.badges[it.id]) badges.push(h('span', { class: 'ij-badge', text: tx('dlg.lib.tiffBadge') }));
        if (it.mounted) badges.push(h('span', { class: 'ij-badge', text: tx('dlg.lib.onScreen') }));
        const card = h('button', { class: 'ij-card' + (it.id === st.selected ? ' is-selected' : ''), type: 'button', title: it.name, tabIndex: i === st.cursor ? 0 : -1,
          on: { click: () => { st.cursor = i; pick(it.id).catch(() => {}); } } },
        [h('img', { class: 'ij-thumb', src: it.thumbnail || '', alt: '', loading: 'lazy' }), h('strong', { text: it.name }), h('span', { class: 'ij-note', text: bits.join(' · ') }), badges.length ? h('span', { class: 'ij-row' }, badges) : null]);
        r.cards.push(card);
        r.grid.appendChild(card);
      });
      if (!list.length) r.grid.appendChild(h('p', { class: 'ij-note', text: tx(st.items.length ? 'dlg.lib.noMatch' : 'dlg.lib.noDatasets') }));
      // the columns of the grid (cards that share the first card's row), for the Up / Down arrows
      const top = r.cards.length && typeof r.cards[0].offsetTop === 'number' ? r.cards[0].offsetTop : null;
      ctl.cols = top === null ? 1 : Math.max(1, r.cards.filter((c) => c.offsetTop === top).length);
      r.count.textContent = tx('dlg.lib.count', { n: list.length, total: st.items.length });
      r.chips.forEach((c) => { c.el.className = 'ij-chip' + (st.types.includes(c.type) ? ' is-on' : ''); });
    }

    function renderDetail() {
      const r = ctl.refs;
      if (!r.detail) return;
      clear(r.detail);
      r.bindings = {};
      const d = st.desc;
      const D = r.detail;
      D.appendChild(h('p', { class: 'ij-note', text: tx('dlg.lib.help') }));
      if (!st.selected) { D.appendChild(h('p', { class: 'ij-banner', text: tx('dlg.lib.pickOne') })); return; }
      if (st.descState === 'loading') { D.appendChild(h('p', { class: 'ij-banner', text: tx('dlg.lib.describing') })); return; }
      if (st.descState === 'error') {
        D.appendChild(h('p', { class: 'ij-banner', text: tx(LIB_ERRORS[st.descCode] || 'err.unknown') }));
        D.appendChild(viewerLink(st.selected, NEEDS_VIEWER.has(st.descCode)));
        return;
      }
      if (!d) return;
      const busyRun = !!st.run;
      const locked = busyRun;
      D.appendChild(h('strong', { text: d.name }));
      D.appendChild(h('span', { class: 'ij-note', text: [typeLabel(d.type), tx('dlg.lib.formatN', { n: d.formatVersion }), d.physicalUm && d.physicalUm.x > 0 ? um(d.physicalUm.x) + ' × ' + um(d.physicalUm.y) + (d.physicalUm.z > 0 ? ' × ' + um(d.physicalUm.z) : '') : ''].filter(Boolean).join(' · ') }));
      if (d.type === 'live') {
        const it = item();
        const tpIn = h('input', { type: 'number', class: 'ij-search', min: 0, max: Math.max(0, (it && it.timepoints ? it.timepoints : 1) - 1), step: 1, value: st.timepoint, disabled: locked, on: { change: () => setTimepoint(tpIn.value) } });
        D.appendChild(field(tx('dlg.lib.timepoint'), [tpIn, h('span', { class: 'ij-field-units', text: '/ ' + (it && it.timepoints ? it.timepoints - 1 : 0) })]));
      }
      if (d.type !== '2d') {
        const obl = obliqueLevels().length > 0;
        const zUsable = zLevels().length > 0 || usableTiffs().length > 0 || st.tiffs.some((t) => t.state === 'loading');
        D.appendChild(h('div', { class: 'ij-radio-group' }, [
          radio('lib-mode', 'z', st.mode === 'z', tx('dlg.lib.modeZ'), setMode, locked || !zUsable),
          radio('lib-mode', 'oblique', st.mode === 'oblique', tx('dlg.lib.modeOblique'), setMode, locked || !obl)
        ]));
        if (!obl) D.appendChild(reasonLine(d.oblique && d.oblique.reasonCode, d.id));
        if (!zLevels().length && !usableTiffs().length && !st.tiffs.some((t) => t.state === 'loading')) D.appendChild(reasonLine(d.z && d.z.reasonCode, d.id));
        if (st.mode === 'z') renderZ(D, locked); else renderOblique(D, locked);
      } else {
        renderSource(D, locked);
      }
      renderPreviewBox(D);
      D.appendChild(h('p', { class: 'ij-note', text: resultLine() }));
      const p = plan();
      r.result = D.children[D.children.length - 1];
      const openBtn = btn(tx('dlg.lib.open'), open, 'ij-btn--primary');
      openBtn.disabled = !p.ok || busyRun;
      r.openBtn = openBtn;
      const row = h('div', { class: 'ij-row' }, [openBtn]);
      if (busyRun) {
        if (st.run.kind !== 'tiff') row.appendChild(btn(tx('dlg.lib.cancel'), cancel));      // the TIFF read is one worker request: only the status bar's Cancel reaches it
        const bar = h('div', { class: 'ij-progress' + (st.run.fraction === null ? ' is-indeterminate' : '') }, [h('div', { class: 'ij-progress-fill' })]);
        r.bar = bar.children[0];
        r.barBox = bar;
        r.barLabel = h('span', { class: 'ij-note', text: st.run.label });
        if (st.run.fraction !== null) r.bar.style.width = Math.round(st.run.fraction * 100) + '%';
        row.appendChild(bar);
        row.appendChild(r.barLabel);
        if (st.run.kind === 'tiff') D.appendChild(h('p', { class: 'ij-note', text: tx('dlg.lib.cancelStatus') }));
      }
      D.appendChild(row);
      if (!p.ok && !busyRun) D.appendChild(h('p', { class: 'ij-note', text: tx(p.reason, p.params) }));
      if (st.note) D.appendChild(h('p', { class: 'ij-note', role: 'status', text: st.note }));
      if (st.noteExtra) D.appendChild(h('p', { class: 'ij-note', role: 'status', text: st.noteExtra }));
      if (st.noteViewer) D.appendChild(viewerLink(st.selected, true));
    }

    function viewerLink(id, show) {
      if (!show) return h('span');
      const lib = library();
      let href = '';
      try { href = lib && lib.viewerUrl ? lib.viewerUrl(id) : ''; } catch (_) { href = ''; }
      return h('a', { class: 'ij-note', href, target: '_blank', rel: 'noopener', text: tx('dlg.lib.openViewer') });
    }
    function reasonLine(code, id) {
      if (!code) return h('span');
      return h('div', { class: 'ij-row' }, [h('span', { class: 'ij-note', text: tx(LIB_ERRORS[code] || 'err.unknown') }), viewerLink(id, NEEDS_VIEWER.has(code))]);
    }

    /* The Z-stack block: first / last, method, source, level */
    function renderZ(D, locked) {
      const nz = depthOf();
      const r = ctl.refs;
      const sl = (id, label, value) => {
        const range = h('input', { type: 'range', class: 'ij-slider', min: 0, max: Math.max(0, nz - 1), step: 1, value, disabled: locked,
          on: { input: () => (id === 'first' ? setRange(range.value, st.last) : setRange(st.first, range.value)) } });
        const readout = h('span', { class: 'ij-field-value', text: String(value) });
        r.bindings[id] = { range, readout };
        D.appendChild(field(label, [range, readout]));
      };
      sl('first', tx('dlg.lib.first'), st.first);
      sl('last', tx('dlg.lib.last'), st.last);
      r.zNote = h('p', { class: 'ij-note', text: zNoteText() });
      D.appendChild(r.zNote);
      const sel = h('select', { class: 'ij-search', disabled: locked || st.last === st.first, on: { change: () => (sel.value === 'stack' ? setStack(true) : (setStack(false), setMethod(sel.value))) } },
        IJLibSource.METHODS.map((m) => { const o = h('option', { text: tx(METHOD_KEYS[m]) }); o.value = m; o.selected = m === st.method && !st.asStack; return o; })
          .concat([(() => { const o = h('option', { text: tx('dlg.lib.methodStack') }); o.value = 'stack'; o.selected = st.asStack; return o; })()]));
      sel.value = st.asStack ? 'stack' : st.method;
      D.appendChild(field(tx('dlg.lib.method'), [sel]));
      renderSource(D, locked);
    }
    function zNoteText() {
      const d = st.desc;
      const vz = d.levels && d.levels[0] ? d.levels[0].voxelUm.z : null;
      if (st.last === st.first) return tx('dlg.lib.singlePlane', { z: st.first, um: vz ? um((st.first + 0.5) * vz) : '' });
      return tx('dlg.lib.rangeN', { n: st.last - st.first + 1, um: vz ? um((st.last - st.first + 1) * vz) : '' });
    }

    /* Source (z-stack and photograph): the original TIFF and the processed volume, side by side */
    function renderSource(D, locked) {
      const d = st.desc;
      const tiffs = st.tiffs;
      const group = 'lib-source';
      const photo = d.type === '2d';
      const rows = [];
      const t = tiffNow();
      const tiffOn = usableTiffs().length > 0;
      let tiffLabel;
      if (tiffOn) {
        const f = t.facts;
        const text = tx(f.level === null ? 'dlg.lib.srcTiffNoLevel' : 'dlg.lib.srcTiff', { bits: f.bitDepth, w: f.width, h: f.height, n: f.slices, size: t.sizeBytes ? mb(t.sizeBytes) : '?', level: f.level === null ? '?' : f.level });
        tiffLabel = text;
      } else if (tiffs.some((x) => x.state === 'loading')) tiffLabel = tx('dlg.lib.tiffLoading');
      else if (tiffs.length) tiffLabel = tx(tiffs.every((x) => x.reason === 'extent') ? 'err.libTiffExtent' : tiffs.every((x) => x.reason === 'frame') ? 'dlg.lib.tiffFrame' : 'err.libTiffUnusable');
      else tiffLabel = tx('dlg.lib.noTiff');
      rows.push(radio(group, 'tiff', st.source === 'tiff', tiffLabel, setSource, locked || !tiffOn));
      if (tiffOn && t.facts.coarser && d.levels && d.levels[0]) {
        rows.push(h('span', { class: 'ij-note', text: tx('dlg.lib.tiffCoarser', { w: t.facts.width, h: t.facts.height, W: d.levels[0].width, H: d.levels[0].height }) }));
      }
      let procLabel, procOn;
      if (photo) {
        procOn = !!d.photo;
        procLabel = tx('dlg.lib.srcPhoto', { w: d.photo && d.photo.width ? d.photo.width : '?', h: d.photo && d.photo.height ? d.photo.height : '?' });
      } else {
        const fine = levelRows().find((x) => x.fits) || levelRows()[0];
        procOn = zLevels().length > 0;
        procLabel = procOn && fine ? tx('dlg.lib.srcProcessed', { w: d.levels[0].width, h: d.levels[0].height }) : tx('dlg.lib.srcProcessedNo');
      }
      rows.push(radio(group, 'processed', st.source === 'processed', procLabel, setSource, locked || !procOn));
      D.appendChild(h('div', { class: 'ij-radio-group' }, rows));
      if (usableTiffs().length > 1) {
        const sel = h('select', { class: 'ij-search', disabled: locked, on: { change: () => setTiff(sel.value) } }, usableTiffs().map((x) => { const o = h('option', { text: x.file }); o.value = x.file; o.selected = x.file === (t && t.file); return o; }));
        sel.value = t ? t.file : '';
        D.appendChild(field(tx('dlg.lib.tiffFile'), [sel]));
      }
      if (!photo && st.source === 'processed') renderLevel(D, locked);
    }

    function renderLevel(D, locked) {
      const rows = levelRows();
      if (!rows.length) return;
      const sel = h('select', { class: 'ij-search', disabled: locked, on: { change: () => setLevel(Number(sel.value)) } }, rows.map((x) => {
        const o = h('option', { text: tx('dlg.lib.levelItem', { w: x.width, h: x.height, size: mb(x.bytes) }) + (x.fits ? '' : ' — ' + tx('dlg.lib.tooLarge')) });
        o.value = String(x.level); o.disabled = !x.fits; o.selected = x.level === st.level; return o;
      }));
      sel.value = String(st.level);
      D.appendChild(field(tx('dlg.lib.level'), [sel]));
    }

    function renderOblique(D, locked) {
      const r = ctl.refs;
      const s = st.spec;
      const sl = (id, label, lo, hi, step, value, fmt) => {
        const range = h('input', { type: 'range', class: 'ij-slider', min: lo, max: hi, step, value, disabled: locked, on: { input: () => setSpec({ [id]: Number(range.value) }) } });
        if (id === 'thickness') range.disabled = locked || s.projection === 'single';      // a single plane has no thickness (viewer.js reads it for max / mean only)
        const readout = h('span', { class: 'ij-field-value', text: fmt(value) });
        r.bindings[id] = { range, readout, fmt };
        D.appendChild(field(label, [range, readout]));
      };
      sl('yaw', tx('dlg.lib.yaw'), RANGES.yaw[0], RANGES.yaw[1], 1, s.yaw, (v) => v + '°');
      sl('pitch', tx('dlg.lib.pitch'), RANGES.pitch[0], RANGES.pitch[1], 1, s.pitch, (v) => v + '°');
      sl('roll', tx('dlg.lib.roll'), RANGES.roll[0], RANGES.roll[1], 1, s.roll, (v) => v + '°');
      sl('depth', tx('dlg.lib.depth'), 0, 1, 0.01, s.depth, (v) => Number(v).toFixed(2));
      sl('thickness', tx('dlg.lib.thickness'), RANGES.slab[0], RANGES.slab[1], 1, s.thickness, (v) => tx('dlg.lib.samples', { n: v }));
      const proj = h('select', { class: 'ij-search', disabled: locked, on: { change: () => setSpec({ projection: proj.value }) } }, PROJECTIONS.map((p) => { const o = h('option', { text: tx(PROJECTION_KEYS[p]) }); o.value = p; o.selected = p === s.projection; return o; }));
      proj.value = s.projection;
      D.appendChild(field(tx('dlg.lib.projection'), [proj]));
      renderLevel(D, locked);
    }
    // the preview canvas outlives the rebuilds of the detail (a TIFF index arriving must not blank the picture)
    function renderPreviewBox(D) {
      const d = st.desc;
      if (d && d.mounted && d.type !== '2d') D.appendChild(ctl.refs.preview);
    }

    // The values that change while a slider moves: updated in place (a rebuild would drop the slider under the pointer)
    function renderDerived() {
      const r = ctl.refs;
      if (!r.detail || !r.bindings) return;
      if (r.bindings.first) { r.bindings.first.readout.textContent = String(st.first); r.bindings.first.range.value = st.first; }
      if (r.bindings.last) { r.bindings.last.readout.textContent = String(st.last); r.bindings.last.range.value = st.last; }
      for (const k of ['yaw', 'pitch', 'roll', 'depth', 'thickness']) if (r.bindings[k]) { r.bindings[k].readout.textContent = r.bindings[k].fmt(st.spec[k]); r.bindings[k].range.value = st.spec[k]; }
      if (r.bindings.thickness) r.bindings.thickness.range.disabled = !!st.run || st.spec.projection === 'single';
      if (r.zNote) r.zNote.textContent = zNoteText();
      if (r.result) r.result.textContent = resultLine();
      if (r.openBtn) r.openBtn.disabled = !plan().ok || !!st.run;
    }
    function renderRun() {
      const r = ctl.refs;
      if (!st.run || !r.bar) return;
      r.barBox.className = 'ij-progress' + (st.run.fraction === null ? ' is-indeterminate' : '');
      if (st.run.fraction !== null) r.bar.style.width = Math.round(st.run.fraction * 100) + '%';
      if (r.barLabel) r.barLabel.textContent = st.run.label || '';
    }

    function mount(el) {
      ctl.el = el;
      const r = ctl.refs;
      r.search = h('input', { type: 'text', class: 'ij-search', placeholder: '', on: { input: () => setQuery(r.search.value) } });
      r.search.setAttribute('aria-label', tx('dlg.lib.search'));
      r.search.setAttribute('placeholder', tx('dlg.lib.search'));
      r.chips = TYPE_IDS.map((type) => ({ type, el: h('button', { class: 'ij-chip', type: 'button', text: typeLabel(type), on: { click: () => toggleType(type) } }) }));
      r.count = h('span', { class: 'ij-note', text: '' });
      r.grid = h('div', { class: 'ij-cards', role: 'listbox', on: { keydown: (e) => { if (key(e.key)) { if (e.preventDefault) e.preventDefault(); } } } });
      r.cards = [];
      r.detail = h('div', { class: 'ij-panel-ext' });
      r.preview = h('canvas', { class: 'ij-thumb', width: 256, height: 256 });
      r.preview.style.display = 'none';
      r.preview.style.maxWidth = '256px';
      const left = h('div', { class: 'ij-panel-ext' }, [r.search, h('div', { class: 'ij-chips' }, r.chips.map((c) => c.el)), r.count, r.grid]);
      el.style.display = 'grid';
      el.style.gridTemplateColumns = 'minmax(260px, 1fr) minmax(280px, 1fr)';
      el.style.alignItems = 'start';
      el.style.gap = '10px';
      el.style.overflow = 'auto';
      el.appendChild(left);
      el.appendChild(r.detail);
      loadItems();
      renderList();
      renderDetail();
    }

    function textContent(node) {
      const n = node || ctl.el;
      if (!n) return '';
      let out = n.textContent || '';
      for (const c of n.children || []) out += ' ' + textContent(c);
      return out;
    }
    function dispose() {
      ctl.disposed = true;
      descSeq++;
      if (descAbort) descAbort.abort();
      if (previewAbort) previewAbort.abort();
      if (cancelPreviewTimer) cancelPreviewTimer();
      if (st.run) st.run.ac.abort();
      const lib = library();
      try { if (lib && st.selected) lib.release(st.selected); } catch (_) { /* idempotent */ }
    }

    return Object.assign(ctl, { mount, dispose, loadItems, visible, setQuery, toggleType, key, pick, describeSelected, setMode, setRange, setMethod, setSource, setTiff, setLevel,
      setSpec, setTimepoint, setStack, isStack, plan, tiffRangeFor, levelRows, resultLine, open, cancel, text: textContent, refresh: () => { loadItems(); renderList(); } });
  }

  // ───────────────────────────── page API of the package ─────────────────────────────
  g.IJLibPage = {
    /** Called by ij-app.js at the start of enter(): the Studio facade of the page and the engine's memory budget. */
    attach(ctx, o) { ATT.ctx = ctx || null; ATT.budget = o && typeof o.budget === 'function' ? o.budget : () => 0; },
    available: () => !!library(),
    createController, decodePhoto, LIB_ERRORS,
    /** The controller of the panel that was built last (tests; the panel itself needs no global). */
    last: () => lastController
  };

  IJApp.extend({
    pkg: 'lib',
    commands: [
      { id: 'fileOpenLibrary', menu: ['File'], order: 12, enabled: (st) => !st.busy && g.IJLibPage.available(), run: (api) => api.openPanel('library') }
    ],
    errors: LIB_ERRORS,
    panels: {
      library: {
        titleKey: 'cmd.fileOpenLibrary', persist: true, defaultSize: { w: 860, h: 600 },
        build(el, papi) {
          const ctl = createController(papi);
          ctl.mount(el);
          lastController = ctl;
          return { dispose: () => { ctl.dispose(); if (lastController === ctl) lastController = null; } };
        }
      }
    },
    longCommands: ['doc.tiff.project', 'doc.zproj.add', 'doc.oblique.add']
  });
})();
