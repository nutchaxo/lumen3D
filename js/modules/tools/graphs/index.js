/* Graphs — index.js
 *
 * Live graphs of the dataset on screen. The user picks what goes on X and on Y
 * from the variables of the data the page holds; the plot follows every choice.
 *
 * MODEL. The data of a dataset is described as TABLES of rows and columns — a row
 * is one thing observed, a column one variable of it:
 *   voxels   (3d, live)  one row per voxel of a coarse level: x y z (µm and % of the
 *                        extent) and the intensity of every channel, read LOSSLESS
 *                        through ctx.data (never from the compressed display);
 *   pixels   (2d)        one row per pixel of the photograph: x y, R G B, luminance,
 *                        saturation, blue excess (B − R);
 *   cells    (live+tracking)  one row per tracked cell: lifetime, path, speed, …;
 *   obs      (live+tracking)  one row per cell and frame: t, x y z, speed, age,
 *                        distance from start, neighbours;
 *   msd      (live+tracking)  one row per cell and time lag: mean squared displacement;
 *   frames   (live)      one row per timepoint: the signal level of the acquisition.
 * A graph is a QUERY over one table: X (binned when continuous, one bar per
 * category otherwise), one or several Y variables, an aggregation of Y inside each
 * bin (mean, median, SD, min, max, sum, percentile, count, signal volume, share of
 * voxels above a threshold), an optional grouping variable (one series per
 * category) and a normalisation. Two numeric variables can also be drawn as a
 * density map (co-localisation, Pearson / Manders) or as raw points.
 *
 * CONTEXTS. On a page the plugin draws a panel over the canvas. In a Compare panel
 * it only ANSWERS the host (REQUEST_GRAPH_DATA / GRAPH_DATA): each panel scans its
 * own dataset. In the Compare host ('compare' context) it draws one drawer that
 * asks every panel for the same query and overlays the results, one colour per
 * dataset.
 *
 * Plotly (3.5 MB) is fetched from the platform's vendor folder the first time a
 * plot is drawn, with the integrity digest the platform pins for it.
 */
(function () {
  'use strict';

  // ════════════════════════════════════════════════════════════════════
  // Constants
  // ════════════════════════════════════════════════════════════════════

  const ALL = '__all';                    // X token: one bin, a summary value per series
  const INT = '@int';                     // token: every channel-like variable of the table
  const AGGS = ['mean', 'median', 'min', 'max', 'std', 'p95', 'sum', 'count', 'measure', 'fraction'];
  const NEEDS_Y = new Set(['mean', 'median', 'min', 'max', 'std', 'p95', 'sum', 'fraction']);
  const COUNT_FAMILY = new Set(['count', 'measure', 'fraction']);
  const ROW_BUDGET = 6e6;                 // voxels read for the voxel table
  const CHANNEL_BUDGET = 18e6;            // voxels × channels
  const POINT_BUDGET = 20000;             // raw points drawn
  const MAX_SERIES = 24;
  const MAX_BINS = 400;
  const PIXEL_BUDGET = 2e6;

  // The platform's categorical palette (dataviz skill, validated), in its fixed
  // order: a colour follows the entity it was given to, never its rank.
  const PALETTE = {
    light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
    dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']
  };
  const DASHES = ['solid', 'dash', 'dot', 'dashdot'];
  const SYMBOLS = ['circle', 'square', 'diamond', 'triangle-up'];
  const SURFACE = { light: '#fcfcfb', dark: '#1a1a19' };
  const PLOTLY_SRC = 'js/vendor/plotly.min.js';
  const PLOTLY_SRI = 'sha384-Hl48Kq2HifOWdXEjMsKo6qxqvRLTYqIGbvlENBmkHAxZKIGCXv43H6W1jA671RzC';

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const slug = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');

  function gerr(code, message) {
    return Object.assign(new Error(message || code), { code });
  }

  // ════════════════════════════════════════════════════════════════════
  // Colour helpers (contrast of an entity's own colour against the surface)
  // ════════════════════════════════════════════════════════════════════

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(rgb) {
    return '#' + rgb.map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
  }
  function luminance(rgb) {
    const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  }
  function contrast(a, b) {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  /** A channel colour such as #00FF00 vanishes on a white page: pull it toward black
   *  (light page) or white (dark page) until it holds 3:1 against the surface. */
  function readable(hex, dark) {
    const rgb = hexToRgb(hex);
    if (!rgb) return null;
    const bg = hexToRgb(dark ? SURFACE.dark : SURFACE.light);
    const target = dark ? [255, 255, 255] : [0, 0, 0];
    let cur = rgb;
    for (let k = 0; k < 20 && contrast(cur, bg) < 3; k++) {
      cur = cur.map((v, i) => v + (target[i] - v) * 0.12);
    }
    return rgbToHex(cur);
  }
  function withAlpha(hex, a) {
    const rgb = hexToRgb(hex);
    return rgb ? `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})` : hex;
  }

  // ════════════════════════════════════════════════════════════════════
  // Engine — pure: tables in, plain results out
  // ════════════════════════════════════════════════════════════════════
  //
  // table = { id, n, cols: { varId: TypedArray }, lazy: { varId: () => TypedArray },
  //           vars: [{ id, label, unit, kind: 'num'|'cat', dom?: [lo, hi], step?, bins?,
  //                    intensity?, ch?, color?, cats?: { names, colors } }],
  //           measureUnit, unitSize }
  // A categorical column holds the index of the category (negative / NaN = none).

  const Engine = (() => {
    function varOf(table, id) { return table.vars.find(v => v.id === id) || null; }

    function colOf(table, id) {
      let c = table.cols[id];
      if (!c && table.lazy && typeof table.lazy[id] === 'function') {
        c = table.cols[id] = table.lazy[id]();
      }
      return c || null;
    }

    function minMax(col) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < col.length; i++) {
        const v = col[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      return lo <= hi ? [lo, hi] : [0, 1];
    }

    function intensityIds(table) { return table.vars.filter(v => v.ch).map(v => v.id); }

    /** Expand the @int / @int[k] tokens and drop what the table does not have. */
    function expandIds(table, ids) {
      const ints = intensityIds(table);
      const out = [];
      for (const id of ids || []) {
        if (id === INT) { out.push(...ints); continue; }
        const m = /^@int\[(\d+)\]$/.exec(id);
        if (m) { if (ints[+m[1]]) out.push(ints[+m[1]]); continue; }
        if (varOf(table, id)) out.push(id);
      }
      return [...new Set(out)];
    }

    /** The spec the engine will run: defaults filled in, unknown variables dropped,
     *  combinations that mean nothing turned into the nearest one that does. */
    function normalizeSpec(table, spec = {}) {
      const s = Object.assign({
        x: null, y: [], agg: 'mean', group: null, bins: 0, threshold: 0, signalOnly: false,
        band: false, normalize: 'none', yScale: 'linear', xScale: 'linear', xDomain: null, only: null
      }, spec);
      const nums = table.vars.filter(v => v.kind === 'num');
      s.y = Array.isArray(s.y) ? s.y : (s.y ? [s.y] : []);
      s.y = expandIds(table, s.y).filter(id => varOf(table, id).kind === 'num');
      s.threshold = clamp(Number(s.threshold) || 0, 0, 254);
      s.bins = Number.isFinite(+s.bins) && +s.bins >= 2 ? Math.min(MAX_BINS, Math.round(+s.bins)) : 0;
      if (s.agg !== 'points' && s.agg !== 'density' && !AGGS.includes(s.agg)) s.agg = 'mean';

      if (s.x === INT && !intensityIds(table).length) s.x = null;
      if (s.x === INT) {
        if (!COUNT_FAMILY.has(s.agg) || s.agg === 'fraction') s.agg = 'count';
        s.y = [];
      } else {
        const m = /^@int\[(\d+)\]$/.exec(s.x || '');
        if (m) s.x = intensityIds(table)[+m[1]] || null;
        if (s.x !== ALL && !(s.x && varOf(table, s.x))) s.x = table.defaults?.x || (nums[0] && nums[0].id) || null;
      }
      if (!s.x) throw gerr('NO_VARIABLE', 'the table has no variable to plot');

      const xv = s.x === ALL || s.x === INT ? null : varOf(table, s.x);
      if (s.agg === 'density' || s.agg === 'points') {
        if (!xv || xv.kind !== 'num') { s.agg = 'mean'; }
        else {
          s.y = s.y.filter(id => id !== s.x).slice(0, s.agg === 'density' ? 1 : 3);
          if (!s.y.length) {
            const alt = (table.defaults?.y || []).concat(nums.map(v => v.id)).find(id => id !== s.x && varOf(table, id)?.kind === 'num');
            if (alt) s.y = [alt]; else s.agg = 'mean';
          }
        }
      }
      if (NEEDS_Y.has(s.agg) && !s.y.length) {
        const dy = expandIds(table, table.defaults?.y || []).filter(id => id !== s.x);
        s.y = dy.length ? dy : nums.filter(v => v.id !== s.x).slice(0, 1).map(v => v.id);
        if (!s.y.length) throw gerr('NO_VARIABLE', 'no variable to aggregate');
      }
      if (s.group) {
        const gv = varOf(table, s.group);
        if (!gv || gv.kind !== 'cat' || s.group === s.x) s.group = null;
      }
      if (!['none', 'max', 'sum', 'first'].includes(s.normalize)) s.normalize = 'none';
      s.yScale = s.yScale === 'log' ? 'log' : 'linear';
      s.xScale = s.xScale === 'log' ? 'log' : 'linear';
      return s;
    }

    /** Bin index of every row for X. */
    function makeBins(table, xid, spec) {
      if (xid === ALL) return { nb: 1, idx: null, centers: [''], cat: true, labels: [''], w: 1, lo: 0 };
      const xv = varOf(table, xid);
      const col = colOf(table, xid);
      if (!col) throw gerr('NO_VARIABLE', `no column ${xid}`);
      const n = table.n;
      if (xv.kind === 'cat') {
        const names = xv.cats.names;
        const nb = names.length;
        const idx = new Int32Array(n);
        for (let i = 0; i < n; i++) { const v = col[i]; idx[i] = v >= 0 && v < nb ? v | 0 : -1; }
        return { nb, idx, centers: names.slice(), cat: true, labels: names.slice(), w: 1, lo: 0, colors: xv.cats.colors || null };
      }
      let [lo, hi] = spec.xDomain || xv.dom || minMax(col);
      if (!(hi > lo)) hi = lo + 1;
      let nb, w, round = false;
      const step = xv.step > 0 ? xv.step : 0;
      if (step && (hi - lo) / step + 1 <= MAX_BINS) { nb = Math.round((hi - lo) / step) + 1; w = step; round = true; }
      else { nb = clamp(spec.bins || xv.bins || 64, 2, MAX_BINS); w = (hi - lo) / nb; }
      if (spec.bins && round && spec.bins < nb) { nb = spec.bins; w = (hi - lo) / nb; round = false; }
      const idx = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        const v = col[i];
        let b;
        if (round) b = Math.round((v - lo) / w);
        else { b = Math.floor((v - lo) / w); if (v === hi) b = nb - 1; }
        idx[i] = b >= 0 && b < nb ? b : -1;      // NaN fails both tests
      }
      const centers = new Array(nb);
      for (let b = 0; b < nb; b++) centers[b] = round ? lo + b * w : lo + (b + 0.5) * w;
      return { nb, idx, centers, cat: false, labels: null, w, lo, round };
    }

    function accumulate(n, idx, nb, gcol, G, ycol, useThr, thr) {
      const K = G * nb;
      const tot = new Float64Array(K), cnt = new Float64Array(K), sum = new Float64Array(K), sum2 = new Float64Array(K);
      const mn = new Float64Array(K).fill(Infinity), mx = new Float64Array(K).fill(-Infinity);
      for (let i = 0; i < n; i++) {
        const b = idx ? idx[i] : 0;
        if (b < 0) continue;
        let g = 0;
        if (gcol) { g = gcol[i]; if (!(g >= 0 && g < G)) continue; g |= 0; }
        const k = g * nb + b;
        tot[k]++;
        if (ycol) {
          const y = ycol[i];
          if (y !== y) continue;
          if (useThr && !(y > thr)) continue;
          cnt[k]++; sum[k] += y; sum2[k] += y * y;
          if (y < mn[k]) mn[k] = y;
          if (y > mx[k]) mx[k] = y;
        } else cnt[k]++;
      }
      return { tot, cnt, sum, sum2, mn, mx };
    }

    /** Nearest-rank quantile (sorted[floor(q·(c−1))]) per bin and group. */
    function quantile(n, idx, nb, gcol, G, ycol, q, cnt, useThr, thr) {
      const K = G * nb;
      const out = new Float64Array(K).fill(NaN);
      const walk = (fn) => {
        for (let i = 0; i < n; i++) {
          const b = idx ? idx[i] : 0;
          if (b < 0) continue;
          let g = 0;
          if (gcol) { g = gcol[i]; if (!(g >= 0 && g < G)) continue; g |= 0; }
          const y = ycol[i];
          if (y !== y || (useThr && !(y > thr))) continue;
          fn(g * nb + b, y);
        }
      };
      if (ycol instanceof Uint8Array || ycol instanceof Uint8ClampedArray) {
        const hist = new Uint32Array(K * 256);
        walk((k, y) => { hist[k * 256 + y]++; });
        for (let k = 0; k < K; k++) {
          const c = cnt[k];
          if (!c) continue;
          const rank = Math.floor(q * (c - 1));
          let acc = 0;
          for (let v = 0; v < 256; v++) { acc += hist[k * 256 + v]; if (acc > rank) { out[k] = v; break; } }
        }
        return out;
      }
      const off = new Float64Array(K + 1);
      for (let k = 0; k < K; k++) off[k + 1] = off[k] + cnt[k];
      const vals = new Float32Array(off[K]);
      const cur = off.slice(0, K);
      walk((k, y) => { vals[cur[k]++] = y; });
      for (let k = 0; k < K; k++) {
        const c = cnt[k];
        if (!c) continue;
        const seg = vals.subarray(off[k], off[k + 1]);
        seg.sort();
        out[k] = seg[Math.floor(q * (c - 1))];
      }
      return out;
    }

    function seriesColor(table, yv, gv, g) {
      if (gv) return gv.cats.colors?.[g] || null;
      return yv?.color || null;
    }

    /** → [normalised values, divisor] (divisor 1 when nothing was applied). */
    function normalizeSeries(y, mode) {
      if (mode === 'none') return [y, 1];
      let base = NaN;
      if (mode === 'max') { base = -Infinity; for (const v of y) if (v !== null && v > base) base = v; }
      else if (mode === 'sum') { base = 0; for (const v of y) if (v !== null) base += v; }
      else if (mode === 'first') { base = NaN; for (const v of y) if (v !== null && v !== 0) { base = v; break; } }
      if (!(base > 0) && !(base < 0)) return [y, 1];
      return [y.map(v => (v === null ? null : v / base)), base];
    }

    function computeXY(table, s) {
      const n = table.n;
      const allInts = intensityIds(table);
      const keep = Array.isArray(s.only) ? allInts.filter(id => s.only.includes(id)) : [];
      const xids = s.x === INT ? (keep.length ? keep : allInts) : [s.x];
      const gv = s.group ? varOf(table, s.group) : null;
      const gcol = gv ? colOf(table, gv.id) : null;
      const G = gv ? gv.cats.names.length : 1;
      const series = [];
      const notes = [];
      let first = null;

      const yList = s.x === INT ? [null] : (s.y.length ? s.y : [null]);
      for (const xid of xids) {
        const bins = makeBins(table, xid, s);
        if (!first) first = { bins, xv: xid === ALL ? null : varOf(table, xid) };
        const xv = xid === ALL ? null : varOf(table, xid);
        for (const yid of yList) {
          const yv = yid ? varOf(table, yid) : null;
          const ycol = yid ? colOf(table, yid) : null;
          const useThr = Boolean(yv && yv.intensity && (COUNT_FAMILY.has(s.agg) || s.signalOnly));
          const acc = accumulate(n, bins.idx, bins.nb, gcol, G, ycol, useThr, s.threshold);
          let q = null;
          if (s.agg === 'median' || s.agg === 'p95') {
            q = quantile(n, bins.idx, bins.nb, gcol, G, ycol, s.agg === 'median' ? 0.5 : 0.95, acc.cnt, useThr, s.threshold);
          }
          for (let g = 0; g < G; g++) {
            const y = new Array(bins.nb), sd = new Array(bins.nb), cn = new Array(bins.nb);
            let groupRows = 0;
            for (let b = 0; b < bins.nb; b++) {
              const k = g * bins.nb + b;
              const c = acc.cnt[k];
              cn[b] = c;
              let v = null;
              switch (s.agg) {
                case 'count': v = c; break;
                case 'measure': v = c * (table.unitSize || 1); break;
                case 'fraction': v = acc.tot[k] ? (c / acc.tot[k]) * 100 : null; break;
                case 'sum': v = c ? acc.sum[k] : null; break;
                case 'min': v = c ? acc.mn[k] : null; break;
                case 'max': v = c ? acc.mx[k] : null; break;
                case 'mean': v = c ? acc.sum[k] / c : null; break;
                case 'std': v = c ? Math.sqrt(Math.max(0, acc.sum2[k] / c - (acc.sum[k] / c) ** 2)) : null; break;
                case 'median': case 'p95': v = c ? q[k] : null; break;
                default: v = null;
              }
              groupRows += acc.tot[k];
              y[b] = v;
              sd[b] = s.agg === 'mean' && c ? Math.sqrt(Math.max(0, acc.sum2[k] / c - (acc.sum[k] / c) ** 2)) : null;
            }
            if (G > 1 && !groupRows) continue;
            if (series.length >= MAX_SERIES) { notes.push('series-capped'); continue; }
            const parts = [];
            // With one Y the axis title already names it: the legend only says which group.
            if (s.x === INT) parts.push(xv.label);
            else if (yv && (!gv || s.y.length > 1)) parts.push(yv.label);
            if (gv) parts.push(gv.cats.names[g]);
            const [normed, base] = normalizeSeries(y, s.normalize);
            series.push({
              label: parts.join(' · ') || (COUNT_FAMILY.has(s.agg) ? '' : (yv?.label || '')),
              color: (s.x === INT ? xv.color : seriesColor(table, yv, gv, g)) || null,
              varId: s.x === INT ? xid : yid,
              group: gv ? gv.cats.names[g] : null,
              x: bins.cat ? bins.labels.slice() : bins.centers.slice(),
              y: normed,
              sd: s.band && s.agg === 'mean' ? sd.map(v => (v === null ? null : v / base)) : null,
              n: cn
            });
          }
        }
      }
      const xv0 = first.xv;
      return {
        kind: first.bins.cat ? 'bar' : 'xy',
        x: xv0 ? { id: s.x === INT ? INT : xv0.id, label: s.x === INT ? null : xv0.label, unit: xv0.unit || '', cat: first.bins.cat } : { id: ALL, label: null, unit: '', cat: true },
        y: yAxisInfo(table, s, s.x === INT ? null : (s.y.length === 1 ? varOf(table, s.y[0]) : null)),
        series, notes
      };
    }

    function yAxisInfo(table, s, yv) {
      const unit = s.agg === 'measure' ? (table.measureUnit || '')
        : s.agg === 'fraction' ? '%'
        : s.agg === 'count' ? ''
        : (s.normalize !== 'none' ? '' : (yv?.unit || ''));
      return { agg: s.agg, normalize: s.normalize, unit, label: yv ? yv.label : null, many: s.y.length > 1, intensity: s.y.length > 0 && s.y.every(id => varOf(table, id).intensity) };
    }

    function computePoints(table, s) {
      const xv = varOf(table, s.x);
      const xcol = colOf(table, s.x);
      const gv = s.group ? varOf(table, s.group) : null;
      const gcol = gv ? colOf(table, gv.id) : null;
      const stride = Math.max(1, Math.ceil(table.n / POINT_BUDGET));
      const series = [];
      for (const yid of s.y) {
        const yv = varOf(table, yid);
        const ycol = colOf(table, yid);
        const G = gv ? gv.cats.names.length : 1;
        const bucket = Array.from({ length: G }, () => ({ x: [], y: [] }));
        for (let i = 0; i < table.n; i += stride) {
          const a = xcol[i], b = ycol[i];
          if (a !== a || b !== b) continue;
          let g = 0;
          if (gcol) { g = gcol[i]; if (!(g >= 0 && g < G)) continue; g |= 0; }
          bucket[g].x.push(a); bucket[g].y.push(b);
        }
        bucket.forEach((bk, g) => {
          if (!bk.x.length) return;
          series.push({
            label: [(!gv || s.y.length > 1) ? yv.label : null, gv ? gv.cats.names[g] : null].filter(Boolean).join(' · '),
            color: gv ? (gv.cats.colors?.[g] || null) : (yv.color || null),
            varId: yid, group: gv ? gv.cats.names[g] : null, x: bk.x, y: bk.y, sd: null, n: null
          });
        });
      }
      return {
        kind: 'points',
        x: { id: xv.id, label: xv.label, unit: xv.unit || '', cat: false },
        y: { agg: 'points', label: s.y.length === 1 ? varOf(table, s.y[0]).label : null, unit: s.y.length === 1 ? (varOf(table, s.y[0]).unit || '') : '', many: s.y.length > 1 },
        series, notes: stride > 1 ? ['subsampled'] : [], stride
      };
    }

    function computeDensity(table, s) {
      const xv = varOf(table, s.x), yv = varOf(table, s.y[0]);
      const xc = colOf(table, xv.id), yc = colOf(table, yv.id);
      const n = table.n;
      const nb = clamp(s.bins || 64, 8, 128);
      const [xl, xh0] = s.xDomain || xv.dom || minMax(xc);
      const [yl, yh0] = yv.dom || minMax(yc);
      const xh = xh0 > xl ? xh0 : xl + 1, yh = yh0 > yl ? yh0 : yl + 1;
      const wx = (xh - xl) / nb, wy = (yh - yl) / nb;
      const z = new Float64Array(nb * nb);
      const both = Boolean(xv.intensity && yv.intensity);
      const thr = s.threshold;
      let m = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
      let mx = 0, my = 0, sxIn = 0, syIn = 0, sxT = 0, syT = 0;
      for (let i = 0; i < n; i++) {
        const a = xc[i], b = yc[i];
        if (a !== a || b !== b) continue;
        let bx = Math.floor((a - xl) / wx), by = Math.floor((b - yl) / wy);
        if (a === xh) bx = nb - 1;
        if (b === yh) by = nb - 1;
        if (bx >= 0 && bx < nb && by >= 0 && by < nb) z[by * nb + bx]++;
        // Pearson over the voxels where either channel carries signal: the shared
        // background would otherwise dominate the correlation.
        if (both && !(a > thr || b > thr)) continue;
        m++; sx += a; sy += b; sxx += a * a; syy += b * b; sxy += a * b;
        if (both) {
          sxT += a; syT += b;
          if (b > thr) sxIn += a;
          if (a > thr) syIn += b;
        }
      }
      let pearson = null;
      if (m > 2) {
        const vx = sxx - sx * sx / m, vy = syy - sy * sy / m;
        if (vx > 0 && vy > 0) pearson = (sxy - sx * sy / m) / Math.sqrt(vx * vy);
      }
      const rows = Array.from({ length: nb }, (_, r) => Array.from(z.subarray(r * nb, (r + 1) * nb)));
      return {
        kind: 'heat',
        x: { id: xv.id, label: xv.label, unit: xv.unit || '', cat: false },
        y: { agg: 'density', label: yv.label, unit: yv.unit || '' },
        heat: {
          x: Array.from({ length: nb }, (_, i) => xl + (i + 0.5) * wx),
          y: Array.from({ length: nb }, (_, i) => yl + (i + 0.5) * wy),
          z: rows,
          xLabel: xv.label, yLabel: yv.label, xUnit: xv.unit || '', yUnit: yv.unit || '',
          stats: { n: m, pearson, m1: both && sxT > 0 ? sxIn / sxT : null, m2: both && syT > 0 ? syIn / syT : null, both }
        },
        series: [], notes: []
      };
    }

    function compute(table, spec) {
      const s = normalizeSpec(table, spec);
      if (!table.n) throw gerr('NO_DATA', 'the table is empty');
      let result;
      if (s.agg === 'density') result = computeDensity(table, s);
      else if (s.agg === 'points') result = computePoints(table, s);
      else result = computeXY(table, s);
      result.spec = s;
      result.table = table.id;
      result.measureUnit = table.measureUnit || '';
      return result;
    }

    function csvCell(v) {
      if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return '';
      const s = String(v);
      return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }

    /** The plotted numbers, long format: one row per point of a series (per cell of a map). */
    function toCsv(result) {
      const lines = [];
      if (result.heats || result.heat) {
        lines.push(['dataset', 'x', 'y', 'count'].join(','));
        for (const h of result.heats || [{ ds: null, ...result.heat }]) {
          h.z.forEach((row, r) => row.forEach((c, i) => {
            if (c) lines.push([csvCell(h.ds?.name || ''), csvCell(h.x[i]), csvCell(h.y[r]), csvCell(c)].join(','));
          }));
        }
        return lines.join('\n') + '\n';
      }
      lines.push(['dataset', 'series', result.x?.label || 'x', 'y', 'sd', 'n'].join(','));
      for (const s of result.series) {
        s.x.forEach((x, i) => lines.push([
          csvCell(s.ds?.name || ''), csvCell(s.label), csvCell(x), csvCell(s.y[i]),
          csvCell(s.sd ? s.sd[i] : null), csvCell(s.n ? s.n[i] : null)
        ].join(',')));
      }
      return lines.join('\n') + '\n';
    }

    return { varOf, colOf, normalizeSpec, makeBins, compute, toCsv, intensityIds, expandIds, ALL, INT };
  })();

  /** The channel variables a comparison can line up: those every dataset has (all of
   *  them when no channel is shared). `tb.total` / `v.haveCount` come from the host. */
  function commonChannels(tb) {
    const ints = tb.vars.filter(v => v.ch);
    if (!(tb.total > 1)) return ints.map(v => v.id);
    const common = ints.filter(v => v.haveCount === tb.total).map(v => v.id);
    return common.length ? common : ints.map(v => v.id);
  }

  /** Names of datasets that differ in one token (…-E8-Em3-… / …-E8-Em6-…): keep what differs. */
  function shortNames(names) {
    if (names.length < 2) return names.slice();
    const toks = names.map(n => String(n).split('-'));
    let pre = 0;
    while (toks.every(t => t.length > pre + 1 && t[pre] === toks[0][pre])) pre++;
    let suf = 0;
    while (toks.every(t => t.length - suf > pre + 1 && t[t.length - 1 - suf] === toks[0][toks[0].length - 1 - suf])) suf++;
    const out = toks.map(t => t.slice(pre, t.length - suf).join('-'));
    return out.every(Boolean) && new Set(out).size === out.length ? out : names.slice();
  }

  // ════════════════════════════════════════════════════════════════════
  // Plot — a result (one dataset or several) as Plotly traces
  // ════════════════════════════════════════════════════════════════════

  function axisTitle(label, unit) {
    return unit ? `${label} (${unit})` : label;
  }

  function yTitle(result, t) {
    const y = result.y || {};
    const unit = y.unit || '';
    let base;
    if (y.agg === 'count') base = t('y_count');
    else if (y.agg === 'measure') base = t('y_measure', { what: result.measureUnit === 'µm²' || result.measureUnit === 'px²' ? t('area') : t('volume') });
    else if (y.agg === 'fraction') base = t('y_fraction');
    else if (y.agg === 'points' || y.agg === 'density') base = y.label || '';
    else if (y.agg === 'mean') base = y.label && !y.many ? y.label : (y.intensity ? t('var_intensity') : t('agg_mean'));
    else base = t(`agg_${y.agg}`) + (y.label && !y.many ? ` · ${y.label}` : (y.intensity ? ` · ${t('var_intensity')}` : ''));
    if (y.normalize && y.normalize !== 'none') base += ` (${t(`norm_${y.normalize}`)})`;
    base = base.charAt(0).toUpperCase() + base.slice(1);
    return axisTitle(base, unit);
  }

  /** Plotly { data, layout } for a result. `o`: { dark, t, text, grid, colorBy,
   *  multi, cursorX, cursorLabel, spec }. Pure: no DOM, no Plotly. */
  function buildPlot(result, o) {
    const t = o.t;
    const dark = Boolean(o.dark);
    const pal = dark ? PALETTE.dark : PALETTE.light;
    const spec = result.spec || o.spec || {};
    const layout = {
      margin: { t: 14, l: 58, r: 16, b: 46 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { color: o.text || (dark ? '#c3c2b7' : '#52514e'), size: 11 },
      showlegend: false,
      hovermode: 'closest',
      autosize: true
    };
    const grid = o.grid || (dark ? '#2f2f2d' : '#e3e2dd');
    const data = [];

    if (result.kind === 'heat') {
      const heats = result.heats || [{ ...result.heat, ds: null }];
      const N = heats.length;
      const rows = N > 2 ? 2 : 1;
      const cols = Math.ceil(N / rows);
      const gap = 0.06;
      layout.annotations = [];
      heats.forEach((h, i) => {
        const r = Math.floor(i / cols), c = i % cols;
        const ax = i === 0 ? '' : String(i + 1);
        const xd = [c / cols + (c ? gap / 2 : 0), (c + 1) / cols - (c < cols - 1 ? gap / 2 : 0)];
        const yd = [1 - (r + 1) / rows + (r < rows - 1 ? gap / 2 : 0), 1 - r / rows - (r ? gap / 2 : 0) - (N > 1 ? 0.07 : 0)];
        const logZ = spec.yScale === 'log';
        data.push({
          type: 'heatmap', x: h.x, y: h.y,
          z: logZ ? h.z.map(row => row.map(v => Math.log10(1 + v))) : h.z,
          customdata: h.z, xaxis: 'x' + ax, yaxis: 'y' + ax,
          colorscale: dark ? [[0, '#1a1a19'], [0.35, '#1f4f8f'], [1, '#8ec0ff']] : [[0, '#f4f7fc'], [0.35, '#9cc2f0'], [1, '#0b3a8a']],
          showscale: i === N - 1,
          colorbar: i === N - 1 ? { title: { text: logZ ? 'log₁₀(1+n)' : 'n', side: 'right' }, thickness: 10, len: 0.8 } : undefined,
          hovertemplate: `${h.xLabel}: %{x:.3g}<br>${h.yLabel}: %{y:.3g}<br>n = %{customdata}<extra></extra>`
        });
        layout['xaxis' + ax] = { domain: xd, anchor: 'y' + ax, title: { text: axisTitle(h.xLabel, h.xUnit), standoff: 6 }, gridcolor: grid, zeroline: false };
        layout['yaxis' + ax] = { domain: yd, anchor: 'x' + ax, title: { text: axisTitle(h.yLabel, h.yUnit), standoff: 6 }, gridcolor: grid, zeroline: false };
        const st = h.stats;
        const bits = [];
        if (h.ds) bits.push(`<b>${escapeHtml(h.ds.name)}</b>`);
        if (st && st.pearson !== null && st.pearson !== undefined) bits.push(`r = ${st.pearson.toFixed(3)}`);
        if (st && st.both && st.m1 !== null) bits.push(`M1 = ${st.m1.toFixed(2)}, M2 = ${st.m2 === null ? '–' : st.m2.toFixed(2)}`);
        if (bits.length) {
          layout.annotations.push({
            xref: 'paper', yref: 'paper', x: xd[0], y: yd[1] + (N > 1 ? 0.045 : 0.0), xanchor: 'left', yanchor: 'bottom',
            text: bits.join(' · '), showarrow: false, font: { size: 11, color: layout.font.color }
          });
        }
      });
      layout.margin.t = N > 1 ? 24 : 26;
      return { data, layout };
    }

    const series = result.series;
    const multi = Boolean(o.multi);
    const colorBy = multi ? (o.colorBy || 'dataset') : 'series';
    const colorOf = (s, i) => {
      if (multi && colorBy === 'dataset' && s.ds) return pal[s.ds.slot % pal.length];
      const own = s.color ? readable(s.color, dark) : null;
      return own || pal[i % pal.length];
    };
    const dashOf = (s) => {
      if (!multi) return 'solid';
      if (colorBy === 'dataset') return DASHES[(s.ds?.local || 0) % DASHES.length];
      return DASHES[(s.ds?.slot || 0) % DASHES.length];
    };
    const symOf = (s) => SYMBOLS[((multi ? (colorBy === 'dataset' ? s.ds?.local : s.ds?.slot) : 0) || 0) % SYMBOLS.length];

    const logY = spec.yScale === 'log';
    const logX = spec.xScale === 'log' && result.kind !== 'bar';
    const pos = (v) => (logY ? (v !== null && v > 0 ? v : null) : v);

    series.forEach((s, i) => {
      const color = colorOf(s, i);
      const name = s.label || (result.y?.label || '');
      const y = s.y.map(pos);
      if (result.kind === 'bar') {
        data.push({
          type: 'bar', name, x: s.x, y, marker: { color, line: { color: dark ? SURFACE.dark : SURFACE.light, width: 2 } },
          error_y: s.sd ? { type: 'data', array: s.sd.map(v => v || 0), visible: true, color: layout.font.color, thickness: 1, width: 3 } : undefined,
          hovertemplate: `${escapeHtml(name)}<br>%{x}: %{y:.4g}<extra></extra>`
        });
        return;
      }
      if (result.kind === 'points') {
        data.push({
          type: s.x.length > 4000 ? 'scattergl' : 'scatter', mode: 'markers', name,
          x: logX ? s.x.map(v => (v > 0 ? v : null)) : s.x, y,
          marker: { color, size: 5, opacity: 0.55, symbol: symOf(s) },
          hovertemplate: `${escapeHtml(name)}<br>%{x:.4g}, %{y:.4g}<extra></extra>`
        });
        return;
      }
      const dash = dashOf(s);
      if (s.sd) {
        const hi = s.y.map((v, k) => (v === null || s.sd[k] === null ? null : pos(v + s.sd[k])));
        const lo = s.y.map((v, k) => (v === null || s.sd[k] === null ? null : pos(v - s.sd[k])));
        data.push({ type: 'scatter', mode: 'lines', x: s.x, y: hi, line: { width: 0 }, hoverinfo: 'skip', showlegend: false, legendgroup: name });
        data.push({ type: 'scatter', mode: 'lines', x: s.x, y: lo, line: { width: 0 }, fill: 'tonexty', fillcolor: withAlpha(color, 0.16), hoverinfo: 'skip', showlegend: false, legendgroup: name });
      }
      const dense = s.x.length > 60;
      data.push({
        type: 'scatter', mode: dense ? 'lines' : 'lines+markers', name, legendgroup: name,
        x: logX ? s.x.map(v => (v > 0 ? v : null)) : s.x, y, connectgaps: false,
        line: { color, width: 2, dash },
        marker: { color, size: 7, symbol: symOf(s), line: { color: dark ? SURFACE.dark : SURFACE.light, width: 2 } },
        hovertemplate: `${escapeHtml(name)}<br>%{x:.4g}: %{y:.4g}<extra></extra>`
      });
    });

    const visible = data.filter(d => d.showlegend !== false && d.hoverinfo !== 'skip').length;
    layout.showlegend = visible > 1;
    layout.legend = { orientation: 'h', y: -0.28, x: 0, font: { size: 11 } };
    layout.hovermode = result.kind === 'xy' ? 'x unified' : 'closest';
    if (result.kind === 'bar') layout.barmode = 'group';
    const xl = result.x?.id === INT ? t('var_intensity') : (result.x?.label ? axisTitle(result.x.label, result.x.unit) : '');
    layout.xaxis = {
      title: { text: xl, standoff: 6 }, gridcolor: grid, zeroline: false, type: result.kind === 'bar' ? 'category' : (logX ? 'log' : 'linear'),
      showticklabels: !(result.x?.id === ALL)
    };
    layout.yaxis = { title: { text: yTitle(result, t), standoff: 6 }, gridcolor: grid, zeroline: false, type: logY ? 'log' : 'linear', rangemode: logY ? undefined : 'tozero' };
    if (result.y?.agg === 'mean' || result.y?.agg === 'median' || result.y?.agg === 'min' || result.y?.agg === 'max') layout.yaxis.rangemode = 'normal';
    if (result.kind === 'points') layout.yaxis.rangemode = 'normal';
    if (isNum(o.cursorX) && result.kind === 'xy') {
      layout.shapes = [{ type: 'line', xref: 'x', yref: 'paper', x0: o.cursorX, x1: o.cursorX, y0: 0, y1: 1, line: { color: layout.font.color, width: 1, dash: 'dot' } }];
      layout.annotations = [{ xref: 'x', yref: 'paper', x: o.cursorX, y: 1, text: o.cursorLabel || '', showarrow: false, yanchor: 'bottom', font: { size: 10, color: layout.font.color } }];
      layout.margin.t = 26;
    }
    return { data, layout };
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ════════════════════════════════════════════════════════════════════
  // Sources — what each kind of page can tabulate
  // ════════════════════════════════════════════════════════════════════
  //
  // A source has a cheap `schema` (the variables, known from the metadata alone, so
  // the pickers appear at once) and an async `build` (the data, which may read the
  // volume). `key()` names the state the table depends on; a new key rebuilds it.

  function dtOf(meta) {
    const v = Number(meta?.timeline?.intervalMinutes);
    return v > 0 ? { dt: v, unit: 'min' } : { dt: 1, unit: 'frame' };
  }

  function channelVars(meta, t, n, opts = {}) {
    const used = new Set();
    const list = Array.isArray(meta?.channels) && meta.channels.length ? meta.channels : Array.from({ length: n }, (_, i) => ({ name: `Ch ${i + 1}` }));
    return Array.from({ length: n }, (_, c) => {
      const ch = list[c] || {};
      const name = ch.name || `Ch ${c + 1}`;
      let id = (opts.prefix || 'ch_') + (slug(name) || String(c));
      while (used.has(id)) id += c;
      used.add(id);
      return { id, label: name, unit: '', kind: 'num', dom: [0, 255], step: 1, bins: 64, intensity: true, ch: true, color: ch.color || null, channelIndex: c };
    });
  }

  function positionVars(t, units) {
    const mk = (axis, k) => ({ id: axis, label: t(`var_${axis}`), unit: units, kind: 'num', pos: true, axis: k });
    const pc = (axis, k) => ({ id: axis + 'r', label: t(`var_${axis}r`), unit: '', kind: 'num', dom: [0, 100], bins: 50, pos: true, axis: k, rel: true });
    return [mk('x', 0), mk('y', 1), mk('z', 2), pc('x', 0), pc('y', 1), pc('z', 2)];
  }

  const Sources = {
    voxels: {
      id: 'voxels',
      applies: (ctx, meta) => meta.type !== '2d' && Boolean(ctx.data),
      schema(ctx, t) {
        const meta = ctx.dataset.getMeta();
        const C = Math.max(1, meta.dimensions?.c || meta.channels?.length || 1);
        const vars = [...positionVars(t, 'µm'), ...channelVars(meta, t, C)];
        const ints = vars.filter(v => v.ch).map(v => v.id);
        return {
          id: 'voxels', label: t('table_voxels'), vars, measureUnit: 'µm³',
          defaults: { x: 'zr', y: [INT], agg: 'mean' },
          presets: [
            { id: 'zProfile', spec: { x: 'zr', y: [INT], agg: 'mean', bins: 50 } },
            { id: 'zSignal', spec: { x: 'zr', y: [INT], agg: 'measure', bins: 50 } },
            { id: 'xProfile', spec: { x: 'xr', y: [INT], agg: 'mean', bins: 50 } },
            { id: 'yProfile', spec: { x: 'yr', y: [INT], agg: 'mean', bins: 50 } },
            { id: 'hist', spec: { x: INT, agg: 'count', yScale: 'log' } },
            { id: 'summaryMean', spec: { x: ALL, y: [INT], agg: 'mean', band: true } },
            { id: 'summarySignal', spec: { x: ALL, y: [INT], agg: 'measure' } },
            ints.length > 1 ? { id: 'coloc', spec: { x: '@int[0]', y: ['@int[1]'], agg: 'density', yScale: 'log' } } : null
          ].filter(Boolean)
        };
      },
      key(ctx) {
        const base = typeof BrickLoader !== 'undefined' && BrickLoader.getBasePath ? BrickLoader.getBasePath() : '';
        return `${ctx.dataset.getId()}|${base}`;
      },
      async build(ctx, schema, opts) {
        const D = ctx.data;
        let info;
        try { info = D.info(); } catch (err) { throw gerr('NOT_READY', 'no volume mounted'); }
        const C = info.channels;
        const levels = D.levels();
        let pick = levels[levels.length - 1];
        for (const L of levels) {
          const n = L.dims.x * L.dims.y * L.dims.z;
          if (n <= ROW_BUDGET && n * C <= CHANNEL_BUDGET) { pick = L; break; }
        }
        const { x: dx, y: dy, z: dz } = pick.dims;
        const vs = pick.voxelSize;
        let reg;
        try {
          reg = await D.readRegion({ x0: 0, x1: dx, y0: 0, y1: dy, z0: 0, z1: dz }, Array.from({ length: C }, (_, i) => i), { level: pick.level, signal: opts && opts.signal });
        } catch (err) {
          if (err && err.name === 'AbortError') throw err;
          throw gerr(err && err.code === 'NO_DATASET' ? 'NOT_READY' : 'READ_FAILED', 'volume read failed');
        }
        const n = dx * dy * dz;
        const vars = schema.vars.map(v => ({ ...v }));
        const cols = {};
        vars.forEach(v => { if (v.ch) cols[v.id] = reg.data[v.channelIndex]; });
        const axisFill = (k, scale) => () => {
          const a = new Float32Array(n);
          let i = 0;
          for (let z = 0; z < dz; z++) for (let y = 0; y < dy; y++) for (let x = 0; x < dx; x++) {
            a[i++] = ((k === 0 ? x : k === 1 ? y : z) + 0.5) * scale(k);
          }
          return a;
        };
        const dimOf = [dx, dy, dz];
        const sizeOf = [vs.x, vs.y, vs.z];
        const lazy = {};
        vars.forEach(v => {
          if (!v.pos) return;
          const k = v.axis;
          if (v.rel) lazy[v.id] = axisFill(k, () => 100 / dimOf[k]);
          else {
            lazy[v.id] = axisFill(k, () => sizeOf[k]);
            v.dom = [0.5 * sizeOf[k], (dimOf[k] - 0.5) * sizeOf[k]];
            if (dimOf[k] <= MAX_BINS) v.step = sizeOf[k];
          }
          if (v.rel && dimOf[k] <= MAX_BINS) v.step = 100 / dimOf[k];
          if (v.rel) v.dom = [50 / dimOf[k], 100 - 50 / dimOf[k]];
        });
        return {
          id: 'voxels', n, cols, lazy, vars, defaults: schema.defaults, measureUnit: 'µm³', unitSize: vs.x * vs.y * vs.z,
          info: { level: pick.level, dims: pick.dims, voxelSize: vs }
        };
      }
    },

    pixels: {
      id: 'pixels',
      applies: (ctx, meta) => meta.type === '2d' && Boolean(meta.image?.native) && Boolean(ctx.dataset?.fileUrl),
      schema(ctx, t) {
        const meta = ctx.dataset.getMeta();
        const cal = Number(meta?.pixelSizeUm?.x) > 0;
        const unit = cal ? 'µm' : 'px';
        const ch = (id, label, color) => ({ id, label, unit: '', kind: 'num', dom: [0, 255], step: 1, bins: 64, intensity: true, ch: true, color });
        const vars = [
          { id: 'x', label: t('var_x'), unit, kind: 'num', pos: true, axis: 0 },
          { id: 'y', label: t('var_y'), unit, kind: 'num', pos: true, axis: 1 },
          { id: 'xr', label: t('var_xr'), unit: '', kind: 'num', dom: [0, 100], bins: 50, pos: true, axis: 0, rel: true },
          { id: 'yr', label: t('var_yr'), unit: '', kind: 'num', dom: [0, 100], bins: 50, pos: true, axis: 1, rel: true },
          ch('R', t('var_R'), '#e34948'), ch('G', t('var_G'), '#008300'), ch('B', t('var_B'), '#2a78d6'),
          { id: 'L', label: t('var_L'), unit: '', kind: 'num', dom: [0, 255], step: 1, bins: 64, intensity: true, color: null },
          { id: 'S', label: t('var_S'), unit: '%', kind: 'num', dom: [0, 100], bins: 50, color: null },
          { id: 'blue', label: t('var_blue'), unit: '', kind: 'num', dom: [-255, 255], bins: 64, color: null }
        ];
        return {
          id: 'pixels', label: t('table_pixels'), vars, measureUnit: cal ? 'µm²' : 'px²',
          defaults: { x: 'xr', y: [INT], agg: 'mean' },
          presets: [
            { id: 'rgbHist', spec: { x: INT, agg: 'count' } },
            { id: 'lumHist', spec: { x: 'L', agg: 'count' } },
            { id: 'blueHist', spec: { x: 'blue', agg: 'count', yScale: 'log' } },
            { id: 'xColour', spec: { x: 'xr', y: [INT], agg: 'mean', bins: 50 } },
            { id: 'yColour', spec: { x: 'yr', y: [INT], agg: 'mean', bins: 50 } },
            { id: 'summaryMean', spec: { x: ALL, y: [INT], agg: 'mean', band: true } },
            { id: 'colocRB', spec: { x: 'R', y: ['B'], agg: 'density', yScale: 'log' } }
          ]
        };
      },
      key(ctx) { return ctx.dataset.getId(); },
      async build(ctx, schema) {
        // The photograph's own file, not what the viewer draws: display adjustments,
        // stain isolation and rotation must not change a measurement.
        const meta0 = ctx.dataset.getMeta();
        let bitmap;
        try {
          const resp = await fetch(ctx.dataset.fileUrl({ path: ctx.dataset.getId() }, meta0.image.native));
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          bitmap = await createImageBitmap(await resp.blob());
        } catch (err) {
          console.error('[graphs] photograph unreadable:', err);
          throw gerr('READ_FAILED', 'photograph unreadable');
        }
        const W = bitmap.width, H = bitmap.height;
        const s = Math.min(1, Math.sqrt(PIXEL_BUDGET / (W * H)));
        const w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const g = cv.getContext('2d', { willReadFrequently: true });
        g.imageSmoothingEnabled = true;
        g.drawImage(bitmap, 0, 0, w, h);
        if (bitmap.close) bitmap.close();
        const px = g.getImageData(0, 0, w, h).data;
        const n = w * h;
        const R = new Uint8Array(n), G = new Uint8Array(n), B = new Uint8Array(n), L = new Uint8Array(n), S = new Uint8Array(n);
        const blue = new Int16Array(n);
        for (let i = 0, p = 0; i < n; i++, p += 4) {
          const r = px[p], gg = px[p + 1], b = px[p + 2];
          R[i] = r; G[i] = gg; B[i] = b;
          L[i] = Math.round(0.2126 * r + 0.7152 * gg + 0.0722 * b);      // Rec. 709 luma
          const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
          S[i] = mx ? Math.round(((mx - mn) / mx) * 100) : 0;
          blue[i] = b - r;                                              // X-gal reads blue: B − R is the stain's excess over the tissue's yellow
        }
        const meta = ctx.dataset.getMeta();
        const px0 = Number(meta?.pixelSizeUm?.x) > 0 ? Number(meta.pixelSizeUm.x) : 1;
        const py0 = Number(meta?.pixelSizeUm?.y) > 0 ? Number(meta.pixelSizeUm.y) : px0;
        const sx = (W / w) * px0, sy = (H / h) * py0;
        const vars = schema.vars.map(v => ({ ...v }));
        const lazy = {};
        const fill = (k, scale) => () => {
          const a = new Float32Array(n);
          let i = 0;
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[i++] = ((k === 0 ? x : y) + 0.5) * scale;
          return a;
        };
        vars.forEach(v => {
          if (!v.pos) return;
          const dim = v.axis === 0 ? w : h, size = v.axis === 0 ? sx : sy;
          if (v.rel) { lazy[v.id] = fill(v.axis, 100 / dim); v.dom = [50 / dim, 100 - 50 / dim]; }
          else { lazy[v.id] = fill(v.axis, size); v.dom = [0.5 * size, (dim - 0.5) * size]; }
        });
        return {
          id: 'pixels', n, cols: { R, G, B, L, S, blue }, lazy, vars, defaults: schema.defaults, measureUnit: schema.measureUnit, unitSize: sx * sy,
          info: { dims: { x: w, y: h }, scale: s }
        };
      }
    },

    frames: {
      id: 'frames',
      applies: (ctx, meta) => meta.type === 'live' && Boolean(meta.intensityNormalization?.signalLevels),
      schema(ctx, t) {
        const meta = ctx.dataset.getMeta();
        const { unit } = dtOf(meta);
        const C = Math.max(1, meta.dimensions?.c || meta.channels?.length || 1);
        const chans = channelVars(meta, t, C, { prefix: '' });
        const vars = [{ id: 't', label: t('var_t'), unit, kind: 'num', step: 0, time: true }];
        chans.forEach(c => {
          vars.push({ id: 'sig_' + c.id, label: t('var_signal', { ch: c.label }), unit: '', kind: 'num', color: c.color, ci: c.channelIndex });
          vars.push({ id: 'rel_' + c.id, label: t('var_signalRel', { ch: c.label }), unit: '%', kind: 'num', color: c.color, ci: c.channelIndex, rel0: true });
        });
        return {
          id: 'frames', label: t('table_frames'), vars, measureUnit: '',
          defaults: { x: 't', y: [vars[2] ? vars[2].id : vars[1].id], agg: 'mean' },
          presets: [
            { id: 'bleach', spec: { x: 't', y: vars.filter(v => v.rel0).map(v => v.id), agg: 'mean' } },
            { id: 'signalTime', spec: { x: 't', y: vars.filter(v => v.id.startsWith('sig_')).map(v => v.id), agg: 'mean' } }
          ]
        };
      },
      key(ctx) { return ctx.dataset.getId(); },
      async build(ctx, schema) {
        const meta = ctx.dataset.getMeta();
        const { dt } = dtOf(meta);
        const levels = meta.intensityNormalization.signalLevels || {};
        const T = Math.max(1, Number(meta.dimensions?.t) || 1);
        const vars = schema.vars.map(v => ({ ...v }));
        const cols = { t: new Float32Array(T) };
        for (let f = 0; f < T; f++) cols.t[f] = f * dt;
        vars.forEach(v => {
          if (v.ci === undefined) return;
          const a = new Float32Array(T).fill(NaN);
          for (let f = 0; f < T; f++) {
            const val = levels[`t${String(f).padStart(3, '0')}_c${v.ci}`];
            if (Number.isFinite(val)) a[f] = val;
          }
          if (v.rel0) {
            const base = a.find(x => Number.isFinite(x) && x > 0);
            for (let f = 0; f < T; f++) a[f] = base ? (a[f] / base) * 100 : NaN;
          }
          cols[v.id] = a;
        });
        vars[0].step = dt;
        vars[0].dom = [0, (T - 1) * dt];
        return { id: 'frames', n: T, cols, vars, defaults: schema.defaults, measureUnit: '', unitSize: 1 };
      }
    }
  };

  // — Cell tracking: three tables from the same pass over the packed tracks —

  const trackingMemo = { key: null, value: null };

  function trackingKey(ctx) {
    const T = ctx.tracking;
    const data = T.getData();
    return { data, stab: T.isStabilized(), id: ctx.dataset.getId() };
  }

  function buildTracking(ctx, t) {
    const T = ctx.tracking;
    const k = trackingKey(ctx);
    const memo = trackingMemo.key;
    if (memo && memo.data === k.data && memo.stab === k.stab && memo.id === k.id && trackingMemo.t === t) return trackingMemo.value;
    const data = k.data;
    if (!data) throw gerr('NOT_READY', 'tracking not loaded');
    const meta = ctx.dataset.getMeta();
    const { dt, unit } = dtOf(meta);
    const F = data.frameCount;
    let rowsMax = 0;
    for (let c = 0; c < data.cellTotal; c++) if (data.firstFrame[c] >= 0) rowsMax += Math.max(0, data.lastFrame[c] - data.firstFrame[c] + 1);
    const cell = new Uint32Array(rowsMax), frame = new Uint16Array(rowsMax);
    const tt = new Float32Array(rowsMax), X = new Float32Array(rowsMax), Y = new Float32Array(rowsMax), Z = new Float32Array(rowsMax);
    const speed = new Float32Array(rowsMax).fill(NaN), age = new Float32Array(rowsMax), disp = new Float32Array(rowsMax), pathCum = new Float32Array(rowsMax);
    const reg = new Int16Array(rowsMax);
    const NC = data.cellTotal;
    const rowStart = new Uint32Array(NC + 1);
    const c_first = new Float32Array(NC).fill(NaN), c_last = new Float32Array(NC).fill(NaN), c_life = new Float32Array(NC).fill(NaN);
    const c_path = new Float32Array(NC).fill(NaN), c_disp = new Float32Array(NC).fill(NaN), c_str = new Float32Array(NC).fill(NaN);
    const c_mean = new Float32Array(NC).fill(NaN), c_max = new Float32Array(NC).fill(NaN);
    const c_x = new Float32Array(NC).fill(NaN), c_y = new Float32Array(NC).fill(NaN), c_z = new Float32Array(NC).fill(NaN);
    const c_reg = new Int16Array(NC), c_mit = new Uint8Array(NC), c_fus = new Uint8Array(NC), c_dau = new Uint16Array(NC), c_div = new Float32Array(NC).fill(NaN);

    const um = [0, 0, 0];
    let r = 0;
    for (let c = 0; c < NC; c++) {
      rowStart[c] = r;
      c_reg[c] = data.regionIdx[c];
      c_mit[c] = data.flags[c] & 1 ? 1 : 0;
      c_fus[c] = data.flags[c] & 2 ? 1 : 0;
      c_dau[c] = data.daughterStart[c + 1] - data.daughterStart[c];
      if (data.firstFrame[c] < 0) continue;
      let prevF = -2, px = 0, py = 0, pz = 0, ox = 0, oy = 0, oz = 0, path = 0, steps = 0, vmax = 0, sx = 0, sy = 0, sz = 0, cnt = 0, firstRow = -1, lastRow = -1;
      for (let f = data.firstFrame[c]; f <= data.lastFrame[c]; f++) {
        if (!T.positionUm(c, f, {}, um)) { prevF = -2; continue; }
        const x = um[0], y = um[1], z = um[2];
        cell[r] = c; frame[r] = f; tt[r] = f * dt; X[r] = x; Y[r] = y; Z[r] = z; reg[r] = data.regionIdx[c];
        age[r] = (f - data.firstFrame[c]) * dt;
        if (cnt === 0) { ox = x; oy = y; oz = z; firstRow = r; }
        if (prevF === f - 1) {
          const d = Math.hypot(x - px, y - py, z - pz);
          const v = d / dt;
          speed[r] = v; path += d; steps++;
          if (v > vmax) vmax = v;
        }
        pathCum[r] = path;
        disp[r] = Math.hypot(x - ox, y - oy, z - oz);
        px = x; py = y; pz = z; prevF = f; sx += x; sy += y; sz += z; cnt++; lastRow = r;
        r++;
      }
      if (cnt) {
        c_first[c] = data.firstFrame[c] * dt; c_last[c] = data.lastFrame[c] * dt;
        c_life[c] = (data.lastFrame[c] - data.firstFrame[c] + 1) * dt;
        c_path[c] = path; c_disp[c] = disp[lastRow];
        c_str[c] = path > 0 ? disp[lastRow] / path : NaN;
        c_mean[c] = steps ? path / (steps * dt) : NaN;
        c_max[c] = steps ? vmax : NaN;
        c_x[c] = sx / cnt; c_y[c] = sy / cnt; c_z[c] = sz / cnt;
      }
      if (c_mit[c]) {
        let when = -1;
        for (let q = data.daughterStart[c]; q < data.daughterStart[c + 1]; q++) {
          const d = data.daughterIdx[q];
          if (data.firstFrame[d] >= 0 && (when < 0 || data.firstFrame[d] < when)) when = data.firstFrame[d];
        }
        if (when < 0) when = data.lastFrame[c];
        if (when >= 0) c_div[c] = when * dt;
      }
      void firstRow;
    }
    rowStart[NC] = r;
    const N = r;
    const trim = (a) => a.subarray(0, N);
    const cats = {
      region: { names: Array.from(data.regionNames), colors: Array.from(data.regionColors) },
      yesno: { names: [t('no'), t('yes')], colors: null }
    };
    const value = {
      N, NC, F, dt, unit, data, cats, rowStart,
      obs: {
        cols: { t: trim(tt), frame: trim(frame), x: trim(X), y: trim(Y), z: trim(Z), speed: trim(speed), age: trim(age), disp: trim(disp), path: trim(pathCum), region: trim(reg), cell: trim(cell) }
      },
      cells: {
        cols: { firstT: c_first, lastT: c_last, lifetime: c_life, path: c_path, disp: c_disp, straight: c_str, meanSpeed: c_mean, maxSpeed: c_max, x: c_x, y: c_y, z: c_z, region: c_reg, mitosis: c_mit, fusion: c_fus, daughters: c_dau, divT: c_div }
      }
    };
    trackingMemo.key = k; trackingMemo.t = t; trackingMemo.value = value;
    return value;
  }

  function neighbourColumn(ctx, tr) {
    const radius = ctx.tracking.getOptions().neighborThresholdUm;
    const r2 = radius * radius, size = Math.max(radius, 1e-6);
    const { N, F } = tr;
    const { frame, x, y, z } = tr.obs.cols;
    const out = new Float32Array(N).fill(NaN);
    const byFrame = Array.from({ length: F }, () => []);
    for (let i = 0; i < N; i++) byFrame[frame[i]].push(i);
    const key = (a, b, c) => (a * 73856093) ^ (b * 19349663) ^ (c * 83492791);
    for (let f = 0; f < F; f++) {
      const rows = byFrame[f];
      const buckets = new Map();
      for (const i of rows) {
        const kk = key(Math.floor(x[i] / size), Math.floor(y[i] / size), Math.floor(z[i] / size));
        const b = buckets.get(kk);
        if (b) b.push(i); else buckets.set(kk, [i]);
      }
      for (const i of rows) {
        const cx = Math.floor(x[i] / size), cy = Math.floor(y[i] / size), cz = Math.floor(z[i] / size);
        let count = 0;
        for (let a = cx - 1; a <= cx + 1; a++) for (let b = cy - 1; b <= cy + 1; b++) for (let c = cz - 1; c <= cz + 1; c++) {
          const bk = buckets.get(key(a, b, c));
          if (!bk) continue;
          for (const j of bk) {
            if (j === i) continue;
            const dx = x[i] - x[j], dy = y[i] - y[j], dz = z[i] - z[j];
            if (dx * dx + dy * dy + dz * dz <= r2) count++;
          }
        }
        out[i] = count;
      }
    }
    return out;
  }

  /** Time-averaged mean squared displacement of every cell for every lag it covers. */
  function msdRows(tr) {
    const { NC, F, dt, rowStart } = tr;
    const { frame, x, y, z, region } = tr.obs.cols;
    let maxLag = Math.max(1, Math.min(F - 1, Math.floor(F / 2)));
    const OPS = 6e7;
    let ops = 0;
    for (let c = 0; c < NC; c++) ops += (rowStart[c + 1] - rowStart[c]) * maxLag;
    if (ops > OPS) maxLag = Math.max(1, Math.floor(maxLag * OPS / ops));
    const cap = NC * maxLag;
    const lag = new Float32Array(cap), msd = new Float32Array(cap), reg = new Int16Array(cap), cl = new Uint32Array(cap);
    let n = 0;
    for (let c = 0; c < NC; c++) {
      const a = rowStart[c], b = rowStart[c + 1];
      if (b - a < 2) continue;
      const f0 = frame[a], len = frame[b - 1] - f0 + 1;
      const dense = new Int32Array(len).fill(-1);
      for (let i = a; i < b; i++) dense[frame[i] - f0] = i;
      for (let L = 1; L <= maxLag && L < len; L++) {
        let sum = 0, cnt = 0;
        for (let k = 0; k + L < len; k++) {
          const i = dense[k], j = dense[k + L];
          if (i < 0 || j < 0) continue;
          const dx = x[j] - x[i], dy = y[j] - y[i], dz = z[j] - z[i];
          sum += dx * dx + dy * dy + dz * dz; cnt++;
        }
        if (!cnt) continue;
        lag[n] = L * dt; msd[n] = sum / cnt; reg[n] = region[a]; cl[n] = c; n++;
      }
    }
    return { n, lag: lag.subarray(0, n), msd: msd.subarray(0, n), region: reg.subarray(0, n), cell: cl.subarray(0, n) };
  }

  function trackingSchemas(ctx, t) {
    const meta = ctx.dataset.getMeta();
    const { unit } = dtOf(meta);
    const speedUnit = `µm/${unit}`;
    const regionNames = (meta.tracking?.regions || []).map(r => r.name);
    const regionCats = { names: regionNames, colors: (meta.tracking?.regions || []).map(r => r.color) };
    const yesno = { names: [t('no'), t('yes')], colors: null };
    const pos = (id, label) => ({ id, label, unit: 'µm', kind: 'num' });
    const num = (id, label, u, extra) => ({ id, label, unit: u || '', kind: 'num', ...extra });
    const cat = (id, label, cats) => ({ id, label, unit: '', kind: 'cat', cats });
    const tvar = { id: 't', label: t('var_t'), unit, kind: 'num', step: dtOf(meta).dt, time: true };
    return [
      {
        id: 'obs', label: t('table_obs'), measureUnit: '',
        vars: [tvar, num('age', t('var_age'), unit), pos('x', t('var_x')), pos('y', t('var_y')), pos('z', t('var_z')),
          num('speed', t('var_speed'), speedUnit), num('disp', t('var_disp'), 'µm'), num('path', t('var_path'), 'µm'),
          num('neighbors', t('var_neighbors'), '', { lazyCost: true }), cat('region', t('var_region'), regionCats)],
        defaults: { x: 't', y: ['speed'], agg: 'mean', group: 'region' },
        presets: [
          { id: 'population', spec: { x: 't', agg: 'count', group: 'region' } },
          { id: 'speedTime', spec: { x: 't', y: ['speed'], agg: 'mean', group: 'region' } },
          { id: 'speedHist', spec: { x: 'speed', agg: 'count', group: 'region', normalize: 'sum' } },
          { id: 'neighborsTime', spec: { x: 't', y: ['neighbors'], agg: 'mean', group: 'region' } },
          { id: 'dispAge', spec: { x: 'age', y: ['disp'], agg: 'mean', group: 'region', band: true } },
          { id: 'speedDepth', spec: { x: 'z', y: ['speed'], agg: 'mean', band: true } },
          { id: 'xyPlane', spec: { x: 'x', y: ['y'], agg: 'points', group: 'region' } }
        ]
      },
      {
        id: 'cells', label: t('table_cells'), measureUnit: '',
        vars: [num('lifetime', t('var_lifetime'), unit), num('firstT', t('var_firstT'), unit), num('lastT', t('var_lastT'), unit),
          num('path', t('var_path'), 'µm'), num('disp', t('var_dispEnd'), 'µm'), num('straight', t('var_straight'), ''),
          num('meanSpeed', t('var_meanSpeed'), speedUnit), num('maxSpeed', t('var_maxSpeed'), speedUnit),
          pos('x', t('var_cx')), pos('y', t('var_cy')), pos('z', t('var_cz')),
          num('divT', t('var_divT'), unit, { step: dtOf(meta).dt }), num('daughters', t('var_daughters'), ''),
          cat('region', t('var_region'), regionCats), cat('mitosis', t('var_mitosis'), yesno), cat('fusion', t('var_fusion'), yesno)],
        defaults: { x: 'region', y: ['meanSpeed'], agg: 'mean' },
        presets: [
          { id: 'cellsPerRegion', spec: { x: 'region', agg: 'count' } },
          { id: 'speedRegion', spec: { x: 'region', y: ['meanSpeed'], agg: 'mean', band: true } },
          { id: 'lifetimeHist', spec: { x: 'lifetime', agg: 'count', group: 'region' } },
          { id: 'divisions', spec: { x: 'divT', agg: 'count', group: 'region' } },
          { id: 'speedStraight', spec: { x: 'meanSpeed', y: ['straight'], agg: 'points', group: 'region' } },
          { id: 'mitosisSpeed', spec: { x: 'mitosis', y: ['meanSpeed'], agg: 'mean', band: true } }
        ]
      },
      {
        id: 'msd', label: t('table_msd'), measureUnit: '',
        vars: [num('lag', t('var_lag'), unit, { step: dtOf(meta).dt, time: true }), num('msd', t('var_msd'), 'µm²'), cat('region', t('var_region'), regionCats)],
        defaults: { x: 'lag', y: ['msd'], agg: 'mean', group: 'region' },
        presets: [
          { id: 'msdLag', spec: { x: 'lag', y: ['msd'], agg: 'mean', group: 'region' } },
          { id: 'msdLog', spec: { x: 'lag', y: ['msd'], agg: 'mean', group: 'region', xScale: 'log', yScale: 'log' } }
        ]
      }
    ];
  }

  const TrackingSources = {
    applies: (ctx, meta) => meta.type === 'live' && Boolean(ctx.tracking && ctx.tracking.isAvailable()),
    key(ctx, id) {
      const T = ctx.tracking;
      const extra = id === 'obs' ? `|${T.getOptions().neighborThresholdUm}` : '';
      return `${ctx.dataset.getId()}|${T.isStabilized()}|${T.isLoaded()}${extra}`;
    },
    async build(ctx, schema, t) {
      const T = ctx.tracking;
      if (T.whenLoaded) await T.whenLoaded();
      const tr = buildTracking(ctx, t);
      const vars = schema.vars.map(v => ({ ...v }));
      if (schema.id === 'obs') {
        const cols = { ...tr.obs.cols };
        const lazy = { neighbors: () => neighbourColumn(ctx, tr) };
        vars.forEach(v => {
          if (v.id === 'region') v.cats = tr.cats.region;
          if (v.id === 't') { v.dom = [0, (tr.F - 1) * tr.dt]; v.step = tr.dt; }
        });
        return { id: 'obs', n: tr.N, cols, lazy, vars, defaults: schema.defaults, measureUnit: '', unitSize: 1 };
      }
      if (schema.id === 'cells') {
        vars.forEach(v => {
          if (v.id === 'region') v.cats = tr.cats.region;
          if (v.id === 'mitosis' || v.id === 'fusion') v.cats = tr.cats.yesno;
          if (v.id === 'divT') v.dom = [0, (tr.F - 1) * tr.dt];
        });
        return { id: 'cells', n: tr.NC, cols: { ...tr.cells.cols }, vars, defaults: schema.defaults, measureUnit: '', unitSize: 1 };
      }
      const m = msdRows(tr);
      vars.forEach(v => { if (v.id === 'region') v.cats = tr.cats.region; if (v.id === 'lag') { let hi = tr.dt * 2; for (let i = 0; i < m.n; i++) if (m.lag[i] > hi) hi = m.lag[i]; v.dom = [tr.dt, hi]; } });
      return { id: 'msd', n: m.n, cols: { lag: m.lag, msd: m.msd, region: m.region }, vars, defaults: schema.defaults, measureUnit: '', unitSize: 1 };
    }
  };

  /** Every table this page can offer, cheapest first, as schemas (no data read). */
  function allSchemas(ctx, t) {
    const meta = ctx.dataset.getMeta() || {};
    const out = [];
    const add = (source, src) => {
      const sc = source.schema(ctx, t);
      sc.source = src;
      out.push(sc);
    };
    if (Sources.voxels.applies(ctx, meta)) add(Sources.voxels, Sources.voxels);
    if (Sources.pixels.applies(ctx, meta)) add(Sources.pixels, Sources.pixels);
    if (Sources.frames.applies(ctx, meta)) add(Sources.frames, Sources.frames);
    if (TrackingSources.applies(ctx, meta)) trackingSchemas(ctx, t).forEach(sc => { sc.source = TrackingSources; out.push(sc); });
    return out;
  }

  // ════════════════════════════════════════════════════════════════════
  // Data provider — tables of THIS page, cached, with the queries on them
  // ════════════════════════════════════════════════════════════════════

  function createProvider(ctx, t) {
    const cache = new Map();            // key -> { key, promise, table }
    let schemasMemo = null;
    const schemas = () => (schemasMemo || (schemasMemo = allSchemas(ctx, t)));

    function describe() {
      const meta = ctx.dataset.getMeta() || {};
      return {
        datasetId: ctx.dataset.getId(), name: meta.name || ctx.dataset.getId(), type: meta.type || null,
        tables: schemas().map(sc => ({
          id: sc.id, label: sc.label, measureUnit: sc.measureUnit || '', defaults: sc.defaults,
          presets: sc.presets || [],
          vars: sc.vars.map(v => ({ id: v.id, label: v.label, unit: v.unit || '', kind: v.kind, intensity: Boolean(v.intensity), ch: Boolean(v.ch), color: v.color || null, cats: v.cats || null, rel: Boolean(v.rel), time: Boolean(v.time), lazyCost: Boolean(v.lazyCost) }))
        })),
        cursor: cursorMinutes()
      };
    }

    function cursorMinutes() {
      const meta = ctx.dataset.getMeta() || {};
      if (meta.type !== 'live') return null;
      const { dt } = dtOf(meta);
      let f = null;
      try { f = ctx._state && ctx._state.currentTimepoint; } catch (_) { f = null; }
      return Number.isFinite(f) ? { value: f * dt, frame: f } : null;
    }

    async function table(id, opts = {}) {
      const sc = schemas().find(s => s.id === id);
      if (!sc) throw gerr('NO_TABLE', `no table ${id}`);
      const key = sc.source === TrackingSources ? TrackingSources.key(ctx, id) : sc.source.key(ctx);
      const slot = cache.get(id);
      if (slot && slot.key === key && !opts.force) return slot.promise;
      const promise = (sc.source === TrackingSources ? TrackingSources.build(ctx, sc, t) : sc.source.build(ctx, sc, opts))
        .catch(err => { if (cache.get(id)?.promise === promise) cache.delete(id); throw err; });
      cache.set(id, { key, promise });
      return promise;
    }

    async function compute(tableId, spec, opts = {}) {
      const tb = await table(tableId, opts);
      return Object.assign(Engine.compute(tb, spec), { info: tb.info || null });
    }

    function stale(id) {
      const sc = schemas().find(s => s.id === id);
      if (!sc) return false;
      const slot = cache.get(id);
      if (!slot) return false;
      const key = sc.source === TrackingSources ? TrackingSources.key(ctx, id) : sc.source.key(ctx);
      return slot.key !== key;
    }

    return { describe, table, compute, stale, cursorMinutes, reset: () => { cache.clear(); schemasMemo = null; trackingMemo.key = null; } };
  }

  // ════════════════════════════════════════════════════════════════════
  // UI — one panel for a page, one drawer for Compare
  // ════════════════════════════════════════════════════════════════════
  //
  // host = { t, multi, describe() → { tables: [...] } (the union across datasets in
  //          Compare), compute(tableId, spec) → Promise<result>, cursor(), datasets()?,
  //          onNotes? }

  let plotlyPromise = null;
  function ensurePlotly() {
    if (window.Plotly) return Promise.resolve(window.Plotly);
    if (plotlyPromise) return plotlyPromise;
    plotlyPromise = new Promise((resolve, reject) => {
      // Plotly writes its CSS into <style id="plotly.js-style-global"> at load; under
      // the nonce-locked CSP that element has to be created by the registry first.
      if (typeof PluginRegistry !== 'undefined' && PluginRegistry.ensureNoncedStyle) PluginRegistry.ensureNoncedStyle('plotly.js-style-global');
      const script = document.createElement('script');
      script.src = PLOTLY_SRC;
      script.integrity = PLOTLY_SRI;
      script.crossOrigin = 'anonymous';
      script.onload = () => (window.Plotly ? resolve(window.Plotly) : reject(new Error('Plotly did not define itself')));
      script.onerror = () => reject(new Error('Plotly failed to load'));
      document.head.appendChild(script);
    }).catch(err => { plotlyPromise = null; throw err; });
    return plotlyPromise;
  }

  function cssVar(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (_) { return fallback; }
  }

  function isDark() {
    try { if (typeof Theme !== 'undefined' && Theme.isDark) return Boolean(Theme.isDark()); } catch (_) { /* fall through */ }
    return document.documentElement.getAttribute('data-theme') === 'dark';
  }

  const FIELD = 'display:flex;flex-direction:column;gap:2px;min-width:0;font-size:11px;color:var(--text-secondary)';
  const CONTROL = 'width:100%;min-width:0;padding:4px 6px;font-size:12px;border:1px solid var(--border-subtle);border-radius:var(--radius-sm,4px);background:var(--bg-surface,transparent);color:var(--text-primary)';

  function createUI(root, host) {
    const t = host.t;
    const st = {
      table: null, preset: null,
      spec: { x: null, y: [], agg: 'mean', group: null, bins: 0, threshold: 0, signalOnly: false, band: false, normalize: 'none', yScale: 'linear', xScale: 'linear' },
      colorBy: 'dataset'
    };
    let desc = { tables: [] };
    let seq = 0, timer = null, last = null, gd = null, destroyed = false;
    const el = (sel) => root.querySelector(sel);

    const tableOf = (id) => desc.tables.find(x => x.id === id) || null;
    const varOf = (tb, id) => (tb ? tb.vars.find(v => v.id === id) : null) || null;

    function opt(value, label, sel) { return `<option value="${escapeHtml(value)}"${sel ? ' selected' : ''}>${escapeHtml(label)}</option>`; }

    function aggOptions(tb) {
      const s = st.spec;
      const xInt = s.x === INT;
      const list = xInt ? ['count', 'measure'] : AGGS.slice();
      const xv = varOf(tb, s.x);
      const out = list.map(a => ({ v: a, l: t(`agg_${a}`) }));
      if (!xInt && xv && xv.kind === 'num') { out.push({ v: 'points', l: t('agg_points') }); out.push({ v: 'density', l: t('agg_density') }); }
      return out;
    }

    function renderControls() {
      const tb = tableOf(st.table);
      const box = el('[data-g="controls"]');
      if (!box) return;
      if (!tb) { box.innerHTML = `<div class="text-xs text-muted">${escapeHtml(t('noTables'))}</div>`; return; }
      const s = st.spec;
      const nums = tb.vars.filter(v => v.kind === 'num');
      const cats = tb.vars.filter(v => v.kind === 'cat' && v.id !== s.x);
      const ints = tb.vars.filter(v => v.ch);
      const isHeat = s.agg === 'density', isPts = s.agg === 'points';
      const yIsOptional = s.agg === 'count' || s.agg === 'measure';
      const xOpts = [
        ...(ints.length ? [{ v: INT, l: t('x_allChannels') }] : []),
        { v: ALL, l: t('x_summary') },
        ...tb.vars.map(v => ({ v: v.id, l: axisTitle(v.label, v.unit) }))
      ];
      const showThr = tb.vars.some(v => v.intensity) && (COUNT_FAMILY.has(s.agg) || isHeat || s.signalOnly);
      const showSig = !isHeat && !isPts && !COUNT_FAMILY.has(s.agg) && tb.vars.some(v => v.intensity) && s.x !== INT;
      const presets = (tb.presets || []);
      box.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;align-items:end">
          <label style="${FIELD}"><span>${escapeHtml(t('data'))}</span>
            <select style="${CONTROL}" data-g="table">${desc.tables.map(x => opt(x.id, x.label, x.id === st.table)).join('')}</select></label>
          <label style="${FIELD}"><span>${escapeHtml(t('preset'))}</span>
            <select style="${CONTROL}" data-g="preset">${opt('', t('presetCustom'), !st.preset)}${presets.map(p => opt(p.id, t(`preset_${p.id}`), st.preset === p.id)).join('')}</select></label>
          <label style="${FIELD}"><span>${escapeHtml(t('xAxis'))}</span>
            <select style="${CONTROL}" data-g="x">${xOpts.map(o => opt(o.v, o.l, o.v === s.x)).join('')}</select></label>
          <label style="${FIELD}"><span>${escapeHtml(t('agg'))}</span>
            <select style="${CONTROL}" data-g="agg">${aggOptions(tb).map(o => opt(o.v, o.l, o.v === s.agg)).join('')}</select></label>
          ${cats.length ? `<label style="${FIELD}"><span>${escapeHtml(t('group'))}</span>
            <select style="${CONTROL}" data-g="group">${opt('', t('groupNone'), !s.group)}${cats.map(v => opt(v.id, v.label, v.id === s.group)).join('')}</select></label>` : ''}
          ${isHeat || s.x === INT ? '' : `<label style="${FIELD}"><span>${escapeHtml(t('normalize'))}</span>
            <select style="${CONTROL}" data-g="normalize" ${isPts ? 'disabled' : ''}>${['none', 'max', 'sum', 'first'].map(n => opt(n, t(`norm_${n}`), n === s.normalize)).join('')}</select></label>`}
          <label style="${FIELD}"><span>${escapeHtml(t('bins'))}</span>
            <input style="${CONTROL}" type="number" min="2" max="${MAX_BINS}" step="1" placeholder="${escapeHtml(t('auto'))}" value="${s.bins || ''}" data-g="bins"></label>
          <label style="${FIELD}"><span>${escapeHtml(t('yScale'))} / ${escapeHtml(t('xScale'))}</span>
            <span style="display:flex;gap:4px"><select style="${CONTROL}" data-g="yScale" aria-label="${escapeHtml(t('yScale'))}">${opt('linear', t('linear'), s.yScale === 'linear')}${opt('log', t('log'), s.yScale === 'log')}</select>
            ${isHeat || s.x === ALL || s.x === INT || varOf(tb, s.x)?.kind === 'cat' ? '' : `<select style="${CONTROL}" data-g="xScale" aria-label="${escapeHtml(t('xScale'))}">${opt('linear', t('linear'), s.xScale === 'linear')}${opt('log', t('log'), s.xScale === 'log')}</select>`}</span></label>
          ${host.multi ? `<label style="${FIELD}"><span>${escapeHtml(t('colorBy'))}</span>
            <select style="${CONTROL}" data-g="colorBy">${opt('dataset', t('colorDataset'), st.colorBy === 'dataset')}${opt('series', t('colorSeries'), st.colorBy === 'series')}</select></label>` : ''}
        </div>
        ${s.x === INT ? '' : `<div style="margin-top:8px"><div style="font-size:11px;color:var(--text-secondary);margin-bottom:3px">${escapeHtml(isHeat ? t('yOne') : yIsOptional ? t('yOptional') : t('yAxis'))}</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px" data-g="ychips">${nums.map(v => {
            const on = s.y.includes(v.id) || (s.y.includes(INT) && commonChannels(tb).includes(v.id));
            const partial = tb.total > 1 && v.haveCount !== undefined && v.haveCount < tb.total ? ` (${v.haveCount}/${tb.total})` : '';
            return `<button type="button" class="btn btn-outline btn-sm${on ? ' active' : ''}" data-y="${escapeHtml(v.id)}" aria-pressed="${on}" style="${on ? 'font-weight:600' : ''}">${v.color ? `<span aria-hidden="true" style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;background:${escapeHtml(readable(v.color, isDark()) || v.color)}"></span>` : ''}${escapeHtml(v.label + partial)}</button>`;
          }).join('')}</div></div>`}
        <div style="display:flex;flex-wrap:wrap;gap:14px;margin-top:8px;align-items:center;font-size:12px">
          ${showThr ? `<label style="display:flex;align-items:center;gap:6px"><span>${escapeHtml(t('threshold'))}</span><input type="range" min="0" max="254" step="1" value="${s.threshold}" data-g="threshold" style="width:120px"><output data-g="thrOut">${s.threshold}</output></label>` : ''}
          ${showSig ? `<label style="display:flex;align-items:center;gap:6px"><input type="checkbox" data-g="signalOnly" ${s.signalOnly ? 'checked' : ''}>${escapeHtml(t('signalOnly'))}</label>` : ''}
          ${s.agg === 'mean' && !isHeat ? `<label style="display:flex;align-items:center;gap:6px"><input type="checkbox" data-g="band" ${s.band ? 'checked' : ''}>${escapeHtml(t('band'))}</label>` : ''}
        </div>`;
    }

    function setStatus(msg, kind) {
      const e = el('[data-g="status"]');
      if (!e) return;
      e.textContent = msg || '';
      e.style.color = kind === 'error' ? 'var(--color-danger, #e34948)' : 'var(--text-secondary)';
    }

    function setNotes(list) {
      const e = el('[data-g="notes"]');
      if (!e) return;
      e.innerHTML = (list || []).map(n => `<div>${escapeHtml(n)}</div>`).join('');
    }

    function applyPreset(id) {
      const tb = tableOf(st.table);
      const p = tb && (tb.presets || []).find(x => x.id === id);
      if (!p) return;
      st.preset = id;
      const spec = JSON.parse(JSON.stringify(p.spec));
      // "@int[k]" = the k-th channel every dataset has: the pickers show a real variable.
      const nth = (tok) => { const m = /^@int\[(\d+)\]$/.exec(tok); return m ? (commonChannels(tb)[+m[1]] || tok) : tok; };
      spec.x = nth(spec.x);
      spec.y = (spec.y || []).map(nth);
      st.spec = Object.assign({ x: null, y: [], agg: 'mean', group: null, bins: 0, threshold: st.spec.threshold, signalOnly: false, band: false, normalize: 'none', yScale: 'linear', xScale: 'linear' }, spec);
    }

    function chooseTable(id) {
      st.table = id;
      const tb = tableOf(id);
      st.preset = null;
      if (tb && tb.presets && tb.presets.length) applyPreset(tb.presets[0].id);
      else if (tb) st.spec = Object.assign(st.spec, { x: tb.defaults?.x || null, y: tb.defaults?.y || [], agg: tb.defaults?.agg || 'mean', group: tb.defaults?.group || null });
    }

    function schedule(delay = 90) {
      clearTimeout(timer);
      timer = setTimeout(draw, delay);
    }

    function friendly(err) {
      const code = err && err.code;
      if (code === 'NOT_READY') return t('err_notReady');
      if (code === 'NO_DATA' || code === 'NO_VARIABLE') return t('err_noData');
      if (code === 'COMPARE_TIMEOUT') return t('err_timeout');
      return t('err_generic');
    }

    async function draw() {
      if (destroyed) return;
      const tb = tableOf(st.table);
      const target = el('[data-g="plot"]');
      if (!tb || !target) return;
      const mine = ++seq;
      setStatus(t('computing'));
      let result;
      try {
        result = await host.compute(st.table, st.spec);
      } catch (err) {
        if (mine !== seq || destroyed) return;
        if (!(err && err.name === 'AbortError')) console.error('[graphs] query failed:', err);
        setStatus(friendly(err), 'error');
        setNotes([]);
        return;
      }
      if (mine !== seq || destroyed) return;
      let Plotly;
      try { Plotly = await ensurePlotly(); } catch (err) {
        console.error('[graphs] Plotly unavailable:', err);
        setStatus(t('err_plotly'), 'error');
        return;
      }
      if (mine !== seq || destroyed) return;
      last = result;
      const empty = result.kind === 'heat' ? !(result.heats || [result.heat]).some(h => h && h.z.some(r => r.some(Boolean)))
        : !result.series.length;
      const cur = host.cursor ? host.cursor() : null;
      const isT = result.x && (result.x.id === 't');
      const plot = buildPlot(result, {
        dark: isDark(), t, multi: host.multi && (result.datasets || 0) > 1, colorBy: st.colorBy,
        text: cssVar('--text-secondary', undefined), grid: cssVar('--border-subtle', undefined),
        cursorX: isT && cur ? cur.value : null,
        cursorLabel: cur ? t('cursorNow') : '', spec: result.spec
      });
      try {
        await Plotly.react(target, plot.data, plot.layout, { displayModeBar: false, responsive: true });
      } catch (err) {
        console.error('[graphs] plot failed:', err);
        setStatus(t('err_plotly'), 'error');
        return;
      }
      gd = target;
      setStatus(empty ? t('err_noData') : (result.statusText || ''));
      const notes = (result.notes || []).map(n => t(`note_${n}`, { n: result.stride || '' })).filter(x => x && !x.startsWith('note_'));
      (result.extraNotes || []).forEach(n => notes.push(n));
      setNotes(notes);
    }

    function onChange(e) {
      const g = e.target.getAttribute && e.target.getAttribute('data-g');
      if (!g) return;
      const s = st.spec;
      const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      let structural = false;
      switch (g) {
        case 'table': chooseTable(v); structural = true; break;
        case 'preset': if (v) applyPreset(v); else st.preset = null; structural = true; break;
        case 'x': s.x = v; st.preset = null; structural = true; break;
        case 'agg': s.agg = v; st.preset = null; structural = true; break;
        case 'group': s.group = v || null; st.preset = null; break;
        case 'normalize': s.normalize = v; st.preset = null; break;
        case 'bins': s.bins = Number(v) >= 2 ? Number(v) : 0; break;
        case 'yScale': s.yScale = v; break;
        case 'xScale': s.xScale = v; break;
        case 'threshold': s.threshold = Number(v); { const o = el('[data-g="thrOut"]'); if (o) o.textContent = String(v); } break;
        case 'signalOnly': s.signalOnly = Boolean(v); break;
        case 'band': s.band = Boolean(v); break;
        case 'colorBy': st.colorBy = v; break;
        default: return;
      }
      if (structural) renderControls();
      schedule(g === 'threshold' ? 140 : 60);
    }

    function onClick(e) {
      const chip = e.target.closest && e.target.closest('[data-y]');
      if (chip) {
        const id = chip.getAttribute('data-y');
        const tb = tableOf(st.table);
        let y = st.spec.y.flatMap(k => (k === INT ? commonChannels(tb) : [k]));
        if (st.spec.agg === 'density') y = [id];
        else y = y.includes(id) ? y.filter(k => k !== id) : [...y, id];
        st.spec.y = y;
        st.preset = null;
        renderControls();
        schedule();
        return;
      }
      const act = e.target.closest && e.target.closest('[data-g-act]');
      if (!act) return;
      const a = act.getAttribute('data-g-act');
      if (a === 'refresh') { host.invalidate && host.invalidate(); schedule(0); }
      else if (a === 'csv') exportCsv();
      else if (a === 'png') exportPng();
    }

    function stamp() { return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'); }

    function download(blob, name) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    function exportCsv() {
      if (!last) return;
      download(new Blob([Engine.toCsv(last)], { type: 'text/csv;charset=utf-8' }), `graph-${st.table}-${stamp()}.csv`);
    }

    async function exportPng() {
      if (!gd || !window.Plotly) return;
      try {
        const url = await Plotly.toImage(gd, { format: 'png', width: 1600, height: 900, scale: 2 });
        const blob = await (await fetch(url)).blob();
        download(blob, `graph-${st.table}-${stamp()}.png`);
      } catch (err) { console.error('[graphs] PNG export failed:', err); setStatus(t('err_generic'), 'error'); }
    }

    root.addEventListener('change', onChange);
    root.addEventListener('input', (e) => { if (e.target.getAttribute && e.target.getAttribute('data-g') === 'threshold') onChange(e); });
    root.addEventListener('click', onClick);

    return {
      /** Re-read what the host offers and redraw. */
      refreshDescription() {
        desc = host.describe();
        if (!tableOf(st.table)) chooseTable(desc.tables[0] ? desc.tables[0].id : null);
        renderControls();
        schedule(0);
      },
      redraw: () => schedule(0),
      relabel() { renderControls(); schedule(0); },
      getState: () => JSON.parse(JSON.stringify({ table: st.table, spec: st.spec, colorBy: st.colorBy, preset: st.preset })),
      setState(s) {
        if (!s || typeof s !== 'object') return;
        if (s.table && tableOf(s.table)) st.table = s.table;
        if (s.spec && typeof s.spec === 'object') st.spec = Object.assign(st.spec, s.spec);
        if (s.colorBy === 'series' || s.colorBy === 'dataset') st.colorBy = s.colorBy;
        st.preset = s.preset || null;
        renderControls();
        schedule(0);
      },
      getPlot: () => gd,
      getLast: () => last,
      getTable: () => st.table,
      setStatus,
      resize() { if (gd && window.Plotly) { try { Plotly.Plots.resize(gd); } catch (_) { /* detached */ } } },
      destroy() {
        destroyed = true;
        clearTimeout(timer);
        root.removeEventListener('change', onChange);
        root.removeEventListener('click', onClick);
        if (gd && window.Plotly) { try { Plotly.purge(gd); } catch (_) { /* nothing to purge */ } }
        gd = null;
      }
    };
  }

  function panelHtml(t, withClose) {
    const btn = (act, icon, key) => `<button type="button" class="btn btn-icon btn-ghost" data-g-act="${act}" title="${escapeHtml(t(key))}" aria-label="${escapeHtml(t(key))}"><i data-lucide="${icon}"></i></button>`;
    return `
      <div class="scientific-panel-header">
        <strong class="flex items-center gap-2"><i data-lucide="line-chart" class="w-4 h-4"></i> <span data-g="title">${escapeHtml(t('panelTitle'))}</span></strong>
        <div class="flex items-center gap-2">
          ${btn('refresh', 'refresh-cw', 'refresh')}${btn('csv', 'file-spreadsheet', 'exportCsv')}${btn('png', 'image', 'exportPng')}
          ${withClose ? `<button type="button" class="btn btn-icon btn-ghost" data-g-close aria-label="${escapeHtml(t('close'))}"><i data-lucide="x"></i></button>` : ''}
        </div>
      </div>
      <div class="graphs-body">
        <div data-g="controls"></div>
        <div data-g="status" class="text-xs" role="status" aria-live="polite" style="min-height:16px;margin-top:6px"></div>
        <div data-g="plot" class="graphs-plot"></div>
        <div data-g="notes" class="text-xs text-muted"></div>
      </div>`;
  }

  // ════════════════════════════════════════════════════════════════════
  // Panel protocol (Compare host ⇄ the page in a panel)
  // ════════════════════════════════════════════════════════════════════

  function plainResult(r) {
    // Structured-clone safe, free of the engine's typed arrays.
    return JSON.parse(JSON.stringify(r, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v)));
  }

  // ════════════════════════════════════════════════════════════════════
  // Plugin
  // ════════════════════════════════════════════════════════════════════

  const plugin = {
    Engine, buildPlot, mergeResults, shortNames, commonChannels, Sources, TrackingSources, trackingSchemas, buildTracking, msdRows, neighbourColumn, allSchemas, createProvider, readable, PALETTE,
    _ctx: null, _t: null, _provider: null, _ui: null, _panel: null, _open: false, _mode: 'page',
    _unsubs: [], _pollTimer: null, _lastKey: null, _msgHandler: null, _host: null,

    _tr(key, params) { return this._ctx.i18n.t(key, params); },

    init(ctx) {
      this._ctx = ctx;
      const t = (k, p) => ctx.i18n.t(k, p);
      this._t = t;
      if (ctx.context === 'compare') { this._mode = 'compare'; return this._initHost(ctx); }
      this._provider = createProvider(ctx, t);
      if (ctx.iframe && ctx.iframe.isIframe && ctx.iframe.isIframe()) { this._mode = 'panel'; this._bindPanel(ctx); return this; }
      this._mode = 'page';
      if (!ctx.ui || !ctx.ui.addCanvasPanel) return this;
      this._panel = ctx.ui.addCanvasPanel({
        id: 'graphs', className: 'graphs-panel', html: panelHtml(t, true),
        bind: (root) => {
          root.querySelector('[data-g-close]')?.addEventListener('click', () => this._setOpen(false));
          this._ui = createUI(root, {
            t, multi: false,
            describe: () => this._provider.describe(),
            compute: (table, spec) => this._provider.compute(table, spec, { signal: undefined }).then(r => Object.assign(r, { datasets: 1, statusText: this._statusText(r) })),
            cursor: () => this._provider.cursorMinutes(),
            invalidate: () => this._provider.reset()
          });
        }
      });
      return this;
    },

    /** Called by the registry on a language switch (page and Compare host alike). */
    onLanguageChange() {
      if (this._mode === 'compare') this._host?.relabel();
      else this._relabel();
    },

    _statusText(r) {
      const info = r.info;
      if (!info) return '';
      if (info.voxelSize) {
        const v = info.voxelSize;
        return this._t('scanInfo', { x: info.dims.x, y: info.dims.y, z: info.dims.z, size: [v.x, v.y, v.z].map(a => (+a).toFixed(a < 10 ? 2 : 1)).join(' × ') });
      }
      if (info.scale !== undefined && info.scale < 1) return this._t('pixelInfo', { x: info.dims.x, y: info.dims.y });
      return '';
    },

    _relabel() {
      if (!this._panel) return;
      this._provider.reset();
      const body = this._panel.root;
      const keep = this._ui ? this._ui.getState() : null;
      body.innerHTML = panelHtml(this._t, true);
      body.querySelector('[data-g-close]')?.addEventListener('click', () => this._setOpen(false));
      if (window.lucide) lucide.createIcons({ nodes: [body] });
      // The listeners sit on the root, which survives; only the markup changed.
      if (this._open) { this._ui.refreshDescription(); if (keep) this._ui.setState(keep); }
    },

    _setOpen(on) {
      this._open = Boolean(on);
      this._panel?.toggle(this._open);
      if (typeof PluginRegistry !== 'undefined') PluginRegistry.syncToolbarButton('graphs', { active: this._open });
      clearInterval(this._pollTimer);
      this._pollTimer = null;
      if (this._open) {
        this._ui?.refreshDescription();
        // A timelapse: the volume on screen changes with the timepoint; follow it.
        this._pollTimer = setInterval(() => this._follow(), 800);
      }
      this._ctx.ui.scheduleResize?.();
    },

    _follow() {
      if (!this._open || !this._ui) return;
      const tb = this._ui.getTable();
      if (!tb || !this._provider.stale(tb)) return;
      this._ui.redraw();
    },

    activate() {
      this._setOpen(!this._open);
      return { active: this._open };
    },

    deactivate() { this._setOpen(false); },

    getState() {
      if (this._mode === 'compare') return { open: this._open, ui: this._host ? this._host.ui.getState() : null };
      return { open: this._open, ui: this._ui ? this._ui.getState() : null };
    },

    setState(s) {
      if (!s || typeof s !== 'object') return;
      if (this._mode === 'page') {
        this._setOpen(Boolean(s.open));
        if (s.ui && this._ui) this._ui.setState(s.ui);
      } else if (this._mode === 'compare' && this._host) {
        this._host.setOpen(Boolean(s.open));
        if (s.ui) this._host.ui.setState(s.ui);
      }
    },

    reset() { if (this._mode === 'page') this._setOpen(false); },

    /** The plot on screen, for the Download Center's graph exports. */
    getGraph() { return this._open && this._ui ? this._ui.getPlot() : null; },

    dispose() {
      clearInterval(this._pollTimer);
      this._unsubs.forEach(fn => { try { fn(); } catch (_) { /* gone */ } });
      this._unsubs = [];
      if (this._msgHandler) window.removeEventListener('message', this._msgHandler);
      this._msgHandler = null;
      this._ui?.destroy();
      this._ui = null;
      this._panel?.remove();
      this._panel = null;
      this._host?.dispose();
      this._host = null;
      this._provider?.reset();
      this._open = false;
    },

    // — A panel of Compare: answer the host —

    _bindPanel(ctx) {
      const index = ctx.iframe.panelIndex();
      const reply = (msg) => {
        try { window.parent.postMessage({ ...msg, sourceIndex: index }, Utils.trustedTargetOrigin()); } catch (_) { /* host gone */ }
      };
      this._msgHandler = (e) => {
        if (e.source !== window.parent || window.parent === window) return;
        if (typeof Utils !== 'undefined' && Utils.isTrustedMessageOrigin && !Utils.isTrustedMessageOrigin(e)) return;
        const d = e.data;
        if (!d || d.type !== 'REQUEST_GRAPH_DATA' || typeof d.requestId !== 'string') return;
        if (d.sourceIndex !== undefined && d.sourceIndex !== null && String(d.sourceIndex) === String(index)) return;
        const requestId = d.requestId;
        const fail = (err) => reply({ type: 'GRAPH_DATA', requestId, ok: false, error: String(err && err.code || 'GRAPH_FAILED'), code: err && err.code || 'GRAPH_FAILED' });
        try {
          if (d.op === 'describe') {
            reply({ type: 'GRAPH_DATA', requestId, ok: true, description: plainResult(this._provider.describe()) });
          } else if (d.op === 'compute') {
            this._provider.compute(String(d.table), d.spec && typeof d.spec === 'object' ? d.spec : {}).then(
              (r) => reply({ type: 'GRAPH_DATA', requestId, ok: true, result: plainResult(r), statusText: this._statusText(r) }),
              fail
            );
          } else fail({ code: 'BAD_REQUEST' });
        } catch (err) { fail(err); }
      };
      window.addEventListener('message', this._msgHandler);
    },

    // — The Compare page —

    _initHost(ctx) {
      const t = this._t;
      const slots = new Map();               // panel index -> palette slot (kept while the panel lives)
      const descriptions = new Map();        // panel index -> its description
      const slotOf = (index) => {
        if (slots.has(index)) return slots.get(index);
        const used = new Set(slots.values());
        let n = 0;
        while (used.has(n)) n++;
        slots.set(index, n);
        return n;
      };
      const live = () => ctx.panels.list().filter(p => p.ready && !p.failed);

      const fetchDescriptions = async () => {
        const ps = live();
        for (const k of [...descriptions.keys()]) if (!ps.some(p => p.index === k)) { descriptions.delete(k); slots.delete(k); }
        await Promise.all(ps.map(async (p) => {
          const known = descriptions.get(p.index);
          if (known && known.id === p.id) return;
          try {
            const a = await ctx.panels.request(p.index, 'REQUEST_GRAPH_DATA', { op: 'describe' }, { timeoutMs: 8000 });
            descriptions.set(p.index, { ...a.description, id: p.id });
          } catch (err) { /* keep what this panel last said: a slow answer must not empty the pickers */ }
        }));
      };

      /** Union of the panels' tables and variables, by id. A channel's id is its
       *  name, so the same marker lines up across datasets. */
      const union = () => {
        const tables = new Map();
        for (const [index, d] of descriptions) {
          for (const tb of d.tables) {
            let u = tables.get(tb.id);
            if (!u) { u = { id: tb.id, label: tb.label, measureUnit: tb.measureUnit, defaults: tb.defaults, presets: [], vars: [], total: 0 }; tables.set(tb.id, u); }
            u.total++;
            for (const p of tb.presets || []) if (!u.presets.some(x => x.id === p.id)) u.presets.push(p);
            for (const v of tb.vars) {
              let uv = u.vars.find(x => x.id === v.id);
              if (!uv) { uv = { ...v, haveCount: 0 }; u.vars.push(uv); }
              uv.haveCount++;
            }
          }
          void index;
        }
        return { tables: [...tables.values()] };
      };

      const hostApi = {
        t, multi: true,
        describe: union,
        cursor: () => null,
        invalidate: () => descriptions.clear(),
        compute: async (tableId, spec) => {
          await fetchDescriptions();
          const ps = live().filter(p => descriptions.get(p.index)?.tables.some(tb => tb.id === tableId));
          if (!ps.length) throw gerr('NOT_READY', 'no panel offers this table');
          // Channels are lined up by name: a bare "every channel" means the ones all datasets have.
          const tb = union().tables.find(x => x.id === tableId);
          const common = tb ? commonChannels(tb) : [];
          const sent = { ...spec, y: (spec.y || []).flatMap(id => (id === INT ? common : [id])), only: spec.x === INT ? common : null };
          const settled = await Promise.allSettled(ps.map(p =>
            ctx.panels.request(p.index, 'REQUEST_GRAPH_DATA', { op: 'compute', table: tableId, spec: sent }, { timeoutMs: 180000 })));
          const results = [];
          const missing = live().filter(p => !ps.some(q => q.index === p.index)).map(p => p.name);
          settled.forEach((r, i) => {
            if (r.status === 'fulfilled' && r.value.ok) results.push({ p: ps[i], res: r.value.result });
            else missing.push(ps[i].name);
          });
          if (!results.length) throw gerr(settled.find(r => r.status === 'rejected')?.reason?.code || 'NO_DATA', 'no panel could answer');
          return mergeResults(results, missing, slotOf, t);
        }
      };

      const drawer = ctx.ui.addDrawer({
        id: 'graphs', title: t('title'), icon: 'line-chart', html: panelHtml(t, false),
        onToggle: (open) => { this._open = open; if (open) ui.refreshDescription(); },
        onResize: () => ui.resize()
      });
      if (!drawer) return this;
      const ui = createUI(drawer.el, hostApi);
      const refresh = ui.refreshDescription;
      // The pickers are drawn from what the panels say they hold: ask before drawing.
      ui.refreshDescription = async () => { await fetchDescriptions(); refresh(); };
      // Panels come and go in bursts while datasets load: settle before asking again.
      let panelsTimer = null;
      const offPanels = ctx.panels.onChange(() => {
        if (!this._open) return;
        clearTimeout(panelsTimer);
        panelsTimer = setTimeout(() => ui.refreshDescription(), 400);
      });
      this._host = {
        ui,
        setOpen: (on) => (on ? drawer.open() : drawer.close()),
        relabel: () => {
          const keep = ui.getState();
          drawer.setTitle(t('title'));
          drawer.el.innerHTML = panelHtml(t, false);
          if (window.lucide) lucide.createIcons({ nodes: [drawer.el] });
          if (this._open) { ui.refreshDescription().then(() => ui.setState(keep)); }
        },
        dispose: () => { clearTimeout(panelsTimer); offPanels?.(); ui.destroy(); drawer.remove(); }
      };
      return this;
    }
  };

  /** One result per panel in, one overlay out: series tagged with their dataset. */
  function mergeResults(items, missing, slotOf, t) {
    const first = items[0].res;
    const short = shortNames(items.map(i => i.p.name));
    items.forEach((i, k) => { i.p = { ...i.p, full: i.p.name, name: short[k] }; });
    const out = {
      kind: first.kind, x: first.x, y: first.y, spec: first.spec, table: first.table, measureUnit: first.measureUnit,
      series: [], notes: [], datasets: items.length, extraNotes: []
    };
    const withLocal = (res) => res.series.length;
    items.forEach(({ p, res }) => {
      const ds = { index: p.index, name: p.name, slot: slotOf(p.index), local: 0 };
      if (res.kind === 'heat') {
        out.heats = out.heats || [];
        out.heats.push({ ...res.heat, ds });
        return;
      }
      res.series.forEach((s, i) => {
        const one = withLocal(res) === 1;
        out.series.push({ ...s, ds: { ...ds, local: i }, label: one ? p.name : `${p.name} · ${s.label}` });
      });
      (res.notes || []).forEach(n => { if (!out.notes.includes(n)) out.notes.push(n); });
    });
    if (first.kind === 'heat') out.kind = 'heat';
    if (missing.length) out.extraNotes.push(t('note_missing', { names: shortNames(missing).join(', ') }));
    if (out.x && out.x.unit === 'µm' && out.kind !== 'bar') out.extraNotes.push(t('note_rangesDiffer'));
    out.statusText = t('comparing', { n: items.length });
    return out;
  }

  PluginRegistry.implement('graphs', plugin);
})();
