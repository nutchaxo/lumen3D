/* ============================================================
   Advanced Studio — ij-layout.js
   The workspace: where the image views sit (tabs, splits, floating windows,
   the dock tray), and the one WebGL context that draws every view.

   Classic script, no ESM. Globals:
     IJLayoutPure   the layout data model, pure and testable in Node
     IJRenderSched  the pure part of the renderer: tile request ordering, pinned
                    coarse levels, the shared byte budget
     IJRenderer     ONE offscreen WebGL2 context for the whole app (tiles keyed
                    docId|c|L|tx|ty, one LRU, one inflight cap)
     IJView         ONE per open document: a 2D canvas that receives a blit of the
                    renderer, an overlay canvas, the view transform, annotations
     IJLayout       the workspace DOM: groups with tab strips, dividers, floating
                    image windows, the dock tray, drag and drop of tabs

   Data model (JSON, `IJLayoutPure`):
     layout = { v: 1, root: Node|null, floating: [{ docId, x, y, w, h }],
                minimized: [{ docId, from: groupId|null, near?: docId, side? }], active: docId|null,
                maximized: groupId|null, seq: n }
     Node   = { type:'split', id:'s<n>', dir:'row'|'col', sizes:[fractions, sum 1], children:[Node >= 2] }
            | { type:'group', id:'g<n>', tabs:[docId >= 1], current: docId }
   `floating` is in z-order (last on top). Every function returns a NEW layout and
   normalises it.

   CSS classes (ij-style.css): ij-workspace ij-split(.is-row .is-col) ij-divider
   ij-group ij-tabs ij-tab(.is-active .is-dirty .is-dragging) ij-tab-btn ij-dropzone
   (.is-left .is-right .is-top .is-bottom .is-center) ij-dock ij-dock-chip ij-view
   (.is-active) ij-view-window ij-resize-grip ij-panel-ext
   ============================================================ */

/* ============================================================
   IJLayoutPure
   ============================================================ */
const IJLayoutPure = (() => {
  'use strict';

  const MIN_W = 160, MIN_H = 120;
  const SIDES = ['left', 'right', 'top', 'bottom'];

  /** Smallest fraction a pane may take of an extent in px: 160 px wide, 120 px tall. */
  function minFraction(extentPx, dir = 'row') {
    const e = Number(extentPx);
    if (!(e > 0)) return 0;
    return Math.min(0.5, (dir === 'col' ? MIN_H : MIN_W) / e);
  }

  const clone = (x) => JSON.parse(JSON.stringify(x));
  // the engine's document ids are strings (tests use integers): both are ids
  const isId = (v) => (typeof v === 'string' && v.length > 0) || Number.isInteger(v);

  function empty() { return { v: 1, root: null, floating: [], minimized: [], active: null, maximized: null, seq: 0 }; }

  // ---- tree helpers ---------------------------------------------------------------------------
  function walk(node, fn) {
    if (!node) return;
    fn(node);
    if (node.type === 'split') for (const c of node.children) walk(c, fn);
  }
  function groups(L) { const out = []; walk(L.root, (n) => { if (n.type === 'group') out.push(n); }); return out; }
  function findNode(L, id) { let r = null; walk(L.root, (n) => { if (n.id === id) r = n; }); return r; }
  function groupOf(L, docId) { return groups(L).find((g) => g.tabs.includes(docId)) || null; }
  function parentOf(L, id) {
    let r = null;
    walk(L.root, (n) => { if (n.type === 'split' && n.children.some((c) => c.id === id)) r = n; });
    return r;
  }
  const isFloating = (L, docId) => L.floating.some((f) => f.docId === docId);
  const isMinimized = (L, docId) => L.minimized.some((m) => m.docId === docId);
  function has(L, docId) { return !!groupOf(L, docId) || isFloating(L, docId) || isMinimized(L, docId); }

  /** Every docId: the tabs depth first, then the floating windows, then the minimised. */
  function order(L) {
    const out = [];
    for (const g of groups(L)) for (const d of g.tabs) out.push(d);
    for (const f of L.floating) out.push(f.docId);
    for (const m of L.minimized) out.push(m.docId);
    return out;
  }

  /** The next tab of its group, else the previous one, else the next view in order(); null when alone. */
  function neighbour(L, docId) {
    const g = groupOf(L, docId);
    if (g && g.tabs.length > 1) {
      const i = g.tabs.indexOf(docId);
      return g.tabs[i + 1 !== g.tabs.length ? i + 1 : i - 1];
    }
    const all = order(L);
    const i = all.indexOf(docId);
    if (all.length <= 1) return null;
    const visible = all.filter((d) => d === docId || !isMinimized(L, d));
    const list = visible.length > 1 ? visible : all;
    const k = list.indexOf(docId);
    return list[(k + 1) % list.length];
  }

  // ---- normalisation ----------------------------------------------------------------------------
  function clampSizes(sizes, m) {
    const n = sizes.length;
    if (!(m > 0)) return sizes;
    if (m * n >= 1) return sizes.map(() => 1 / n);
    let s = sizes.slice();
    for (let pass = 0; pass < n + 1; pass++) {
      const low = s.map((v) => v < m - 1e-9);
      if (!low.some(Boolean)) break;
      const fixed = low.reduce((a, b, i) => a + (b ? m : 0), 0);
      const rest = s.reduce((a, v, i) => a + (low[i] ? 0 : v), 0);
      const room = 1 - fixed;
      s = s.map((v, i) => (low[i] ? m : (rest > 0 ? v * room / rest : room / (n - low.filter(Boolean).length))));
    }
    return s;
  }

  function normNode(node, ext) {
    if (!node) return null;
    if (node.type === 'group') {
      node.tabs = node.tabs.filter(isId).filter((d, i, a) => a.indexOf(d) === i);
      if (!node.tabs.length) return null;
      if (!node.tabs.includes(node.current)) node.current = node.tabs[0];
      return node;
    }
    const kids = [];
    node.children.forEach((c, i) => {
      const w = Number.isFinite(node.sizes[i]) && node.sizes[i] > 0 ? node.sizes[i] : 0;
      kids.push({ c, w: w || 1 / node.children.length });
    });
    const total = kids.reduce((a, k) => a + k.w, 0) || 1;
    const out = [];
    for (const k of kids) {
      const cext = ext ? (node.dir === 'row' ? { w: ext.w * k.w / total, h: ext.h } : { w: ext.w, h: ext.h * k.w / total }) : null;
      const c = normNode(k.c, cext);
      if (c) out.push({ c, w: k.w / total });
    }
    if (!out.length) return null;
    if (out.length === 1) return out[0].c;
    // a child split of the same direction is merged into its parent
    const flatKids = [], flatSizes = [];
    for (const { c, w } of out) {
      if (c.type === 'split' && c.dir === node.dir) {
        c.children.forEach((cc, i) => { flatKids.push(cc); flatSizes.push(w * c.sizes[i]); });
      } else { flatKids.push(c); flatSizes.push(w); }
    }
    const sum = flatSizes.reduce((a, b) => a + b, 0) || 1;
    let sizes2 = flatSizes.map((v) => v / sum);
    if (ext) sizes2 = clampSizes(sizes2, minFraction(node.dir === 'row' ? ext.w : ext.h, node.dir));
    const s2 = sizes2.reduce((a, b) => a + b, 0) || 1;
    return { type: 'split', id: node.id, dir: node.dir, sizes: sizes2.map((v) => v / s2), children: flatKids };
  }

  /** Collapses one-child splits, drops empty groups, merges same-direction splits, renormalises the
   *  fractions (clamped to the pixel minimum when `extentPx` {w,h} is given), repairs active / maximized. */
  function normalize(L, extentPx = null) {
    const out = clone(L);
    out.root = normNode(out.root, extentPx && extentPx.w > 0 && extentPx.h > 0 ? extentPx : null);
    const seen = new Set(order(out));
    out.floating = out.floating.filter((f, i, a) => seen.has(f.docId) && a.findIndex((g) => g.docId === f.docId) === i);
    out.minimized = out.minimized.filter((m, i, a) => seen.has(m.docId) && a.findIndex((g) => g.docId === m.docId) === i
      && !groupOf(out, m.docId) && !isFloating(out, m.docId));
    out.floating = out.floating.filter((f) => !groupOf(out, f.docId));
    if (out.maximized && !(findNode(out, out.maximized) && findNode(out, out.maximized).type === 'group')) out.maximized = null;
    if (out.active !== null && !has(out, out.active)) out.active = null;
    if (out.active === null) {
      const vis = order(out).filter((d) => !isMinimized(out, d));
      out.active = vis.length ? vis[0] : null;
    }
    let seq = out.seq || 0;
    walk(out.root, (n) => { const k = Number(String(n.id).slice(1)); if (k > seq) seq = k; });
    out.seq = seq;
    return out;
  }

  function nextId(L, prefix) { L.seq = (L.seq || 0) + 1; return prefix + L.seq; }

  /** Removes the doc from wherever it is, without normalising (internal). */
  function detach(L, docId) {
    const g = groupOf(L, docId);
    if (g) {
      const i = g.tabs.indexOf(docId);
      g.tabs.splice(i, 1);
      if (g.current === docId) g.current = g.tabs[i < g.tabs.length ? i : g.tabs.length - 1];
    }
    L.floating = L.floating.filter((f) => f.docId !== docId);
    L.minimized = L.minimized.filter((m) => m.docId !== docId);
  }

  // ---- operations ---------------------------------------------------------------------------------
  function activate(L, docId) {
    if (!has(L, docId)) return clone(L);
    if (isMinimized(L, docId)) return restore(L, docId);
    const out = clone(L);
    const g = groupOf(out, docId);
    if (g) g.current = docId;
    const fi = out.floating.findIndex((f) => f.docId === docId);
    if (fi >= 0) out.floating.push(out.floating.splice(fi, 1)[0]);
    out.active = docId;
    return normalize(out);
  }

  /** Adds the doc as the current tab of `groupId` (default: the group of the active doc, else the first). */
  function addTab(L, docId, groupId = null) {
    const out = clone(L);
    detach(out, docId);
    let g = groupId ? findNode(out, groupId) : null;
    if (!g || g.type !== 'group') {
      g = out.active !== null ? groupOf(out, out.active) : null;
      if (!g) g = groups(out)[0] || null;
    }
    if (!g) {
      g = { type: 'group', id: nextId(out, 'g'), tabs: [docId], current: docId };
      out.root = g;
    } else {
      g.tabs.push(docId); g.current = docId;
    }
    out.active = docId;
    return normalize(out);
  }

  function makeSplitAround(out, target, side, newNode) {
    const dir = side === 'left' || side === 'right' ? 'row' : 'col';
    const first = side === 'left' || side === 'top';
    const sp = { type: 'split', id: nextId(out, 's'), dir, sizes: [0.5, 0.5], children: first ? [newNode, target] : [target, newNode] };
    const par = parentOf(out, target.id);
    if (!par) { out.root = sp; return; }
    const i = par.children.indexOf(target);
    par.children[i] = sp;
  }

  /** The doc gets a pane of its own on `side` of the group. */
  function split(L, groupId, side, docId) {
    if (!SIDES.includes(side)) return clone(L);
    const probe = clone(L);
    const tg0 = findNode(probe, groupId);
    if (!tg0 || tg0.type !== 'group') return clone(L);
    if (tg0.tabs.length === 1 && tg0.tabs[0] === docId) return clone(L);
    const out = clone(L);
    detach(out, docId);
    const target = findNode(out, groupId);
    const g = { type: 'group', id: nextId(out, 'g'), tabs: [docId], current: docId };
    makeSplitAround(out, target, side, g);
    out.active = docId;
    return normalize(out);
  }

  /**
   * [source, ...docIds] in a grid that replaces the source's pane. cols x rows maximises the per-pane
   * fit scale min(paneW / imgW, paneH / imgH) of an image of `aspect` (w / h) in `extentPx` {w, h};
   * ties go to fewer rows. The grid is a col split of row splits, the last row shorter. The source's
   * other tabs stay in the source's pane; every new doc gets one pane.
   */
  function gridDims(n, aspect = 1, extentPx = { w: 1000, h: 700 }) {
    const W = extentPx && extentPx.w > 0 ? extentPx.w : 1000, H = extentPx && extentPx.h > 0 ? extentPx.h : 700;
    const a = aspect > 0 ? aspect : 1;
    let best = null;
    for (let rows = 1; rows <= n; rows++) {
      const cols = Math.ceil(n / rows);
      if ((rows - 1) * cols >= n) continue; // an empty row
      const s = Math.min(W / cols / a, H / rows);
      if (!best || s > best.s * (1 + 1e-9)) best = { rows, cols, s };
    }
    return best;
  }

  function buildGrid(out, groupsList, dims) {
    const rows = [];
    for (let r = 0; r < dims.rows; r++) {
      const cells = groupsList.slice(r * dims.cols, (r + 1) * dims.cols);
      if (!cells.length) break;
      rows.push(cells.length === 1 ? cells[0] : { type: 'split', id: nextId(out, 's'), dir: 'row', sizes: cells.map(() => 1 / cells.length), children: cells });
    }
    return rows.length === 1 ? rows[0] : { type: 'split', id: nextId(out, 's'), dir: 'col', sizes: rows.map(() => 1 / rows.length), children: rows };
  }

  function gridWithSource(L, sourceDocId, docIds, { aspect = 1, extentPx = null } = {}) {
    let out = clone(L);
    if (!has(out, sourceDocId)) out = addTab(out, sourceDocId);
    const ids = docIds.filter((d) => d !== sourceDocId);
    if (isFloating(out, sourceDocId) || isMinimized(out, sourceDocId)) out = dock(out, sourceDocId, null, 'center');
    out = clone(out);
    for (const d of ids) detach(out, d);
    const srcGroup = groupOf(out, sourceDocId);
    if (!srcGroup) return normalize(out);
    const newGroups = ids.map((d) => ({ type: 'group', id: nextId(out, 'g'), tabs: [d], current: d }));
    const dims = gridDims(1 + ids.length, aspect, extentPx);
    const grid = buildGrid(out, [srcGroup, ...newGroups], dims);
    const par = parentOf(out, srcGroup.id);
    if (!par) out.root = grid;
    else par.children[par.children.indexOf(srcGroup)] = grid;
    out.active = sourceDocId;
    return normalize(out, extentPx);
  }

  function remove(L, docId) {
    if (!has(L, docId)) return clone(L);
    const out = clone(L);
    const wasActive = out.active === docId;
    const next = wasActive ? neighbour(L, docId) : out.active;
    detach(out, docId);
    out.active = next === docId ? null : next;
    if (out.active !== null && !has(out, out.active)) out.active = null;
    return normalize(out);
  }

  /** Moves the doc into group `targetGroupId`: 'center' joins as a tab, an edge splits the group. */
  function move(L, docId, targetGroupId, zone) {
    const tg = findNode(L, targetGroupId);
    if (!tg || tg.type !== 'group' || !has(L, docId)) return clone(L);
    if (zone === 'center') {
      if (tg.tabs.includes(docId)) return activate(L, docId);
      return addTab(L, docId, targetGroupId);
    }
    return split(L, targetGroupId, zone, docId);
  }

  function resize(L, splitId, i, deltaFr, minFr = 0.05) {
    const out = clone(L);
    const sp = findNode(out, splitId);
    if (!sp || sp.type !== 'split' || i < 0 || i + 1 >= sp.sizes.length) return out;
    const total = sp.sizes[i] + sp.sizes[i + 1];
    const m = Math.min(minFr, total / 2);
    const a = Math.min(total - m, Math.max(m, sp.sizes[i] + deltaFr));
    sp.sizes[i] = a; sp.sizes[i + 1] = total - a;
    return out;
  }
  function equalize(L, splitId) {
    const out = clone(L);
    const sp = findNode(out, splitId);
    if (sp && sp.type === 'split') sp.sizes = sp.children.map(() => 1 / sp.children.length);
    return out;
  }

  function float(L, docId, rect) {
    if (!has(L, docId)) return clone(L);
    const out = clone(L);
    const old = out.floating.find((f) => f.docId === docId);
    const r = rect || old || { x: 40, y: 40, w: 480, h: 360 };
    detach(out, docId);
    out.floating.push({ docId, x: Math.round(r.x), y: Math.round(r.y), w: Math.max(MIN_W, Math.round(r.w)), h: Math.max(MIN_H, Math.round(r.h)) });
    out.active = docId;
    return normalize(out);
  }

  /** A floating (or minimised) doc joins a group; no target = the active group, an empty workspace = a new root. */
  function dock(L, docId, targetGroupId, zone = 'center') {
    if (!has(L, docId)) return clone(L);
    const g = targetGroupId ? findNode(L, targetGroupId) : null;
    if (!g || g.type !== 'group') return addTab(L, docId);
    return move(L, docId, g.id, zone || 'center');
  }

  function minimize(L, docId) {
    if (!has(L, docId) || isMinimized(L, docId)) return clone(L);
    const out = clone(L);
    const g = groupOf(out, docId);
    const from = g ? g.id : null;
    // A lone tab's group disappears with it: remember a doc of the adjacent pane and the side the
    // minimised pane sat on, so restore() can split it back into the same place.
    let near = null, side = null;
    if (g && g.tabs.length === 1) {
      const par = parentOf(out, g.id);
      if (par) {
        const i = par.children.indexOf(g);
        const leafDoc = (n, last) => { const gs = []; walk(n, (x) => { if (x.type === 'group' && x.tabs.length) gs.push(x); }); const t = last ? gs[gs.length - 1] : gs[0]; return t ? (t.current || t.tabs[0]) : null; };
        if (i > 0) { near = leafDoc(par.children[i - 1], true); side = par.dir === 'row' ? 'right' : 'bottom'; }
        else if (par.children.length > 1) { near = leafDoc(par.children[1], false); side = par.dir === 'row' ? 'left' : 'top'; }
      }
    }
    const next = out.active === docId ? neighbour(L, docId) : out.active;
    detach(out, docId);
    out.minimized.push(near != null ? { docId, from, near, side } : { docId, from });
    out.active = next && next !== docId && !isMinimized(out, next) ? next : null;
    return normalize(out);
  }

  function restore(L, docId) {
    const m = L.minimized.find((x) => x.docId === docId);
    if (!m) return clone(L);
    const out = clone(L);
    out.minimized = out.minimized.filter((x) => x.docId !== docId);
    const g = m.from ? findNode(out, m.from) : null;
    if (g && g.type === 'group') return addTab(out, docId, g.id);
    const ng = m.near != null && SIDES.includes(m.side) ? groupOf(out, m.near) : null;
    if (ng) return split(out, ng.id, m.side, docId);
    return addTab(out, docId, null);
  }

  /** Every doc of `docIds` (non-minimised, non-hidden ones: the caller filters) in ONE grid; floating and minimised ones are docked. */
  function tile(L, docIds, { aspect = 4 / 3, extentPx = null } = {}) {
    const ids = docIds.filter((d) => has(L, d));
    if (!ids.length) return clone(L);
    const out = clone(L);
    for (const d of ids) detach(out, d);
    const rest = groups(out).flatMap((g) => g.tabs);
    const keep = out;
    const gs = ids.map((d) => ({ type: 'group', id: nextId(keep, 'g'), tabs: [d], current: d }));
    const dims = gridDims(ids.length, aspect, extentPx);
    keep.root = buildGrid(keep, gs, dims);
    for (const d of rest) if (!gs[0].tabs.includes(d)) gs[0].tabs.push(d);
    keep.maximized = null;
    keep.active = ids.includes(L.active) ? L.active : ids[0];
    return normalize(keep, extentPx);
  }

  function cascade(L, rect = { x: 24, y: 24, w: 900, h: 600 }) {
    const out = clone(L);
    const ids = order(L).filter((d) => !isMinimized(L, d));
    const w = Math.max(MIN_W + 80, Math.round(rect.w * 0.6)), h = Math.max(MIN_H + 80, Math.round(rect.h * 0.6));
    for (const d of ids) detach(out, d);
    out.root = null;
    out.floating = ids.map((docId, i) => ({ docId, x: Math.round(rect.x + (i * 28) % Math.max(28, rect.w - w)), y: Math.round(rect.y + (i * 28) % Math.max(28, rect.h - h)), w, h }));
    out.maximized = null;
    if (out.active === null || !ids.includes(out.active)) out.active = ids.length ? ids[ids.length - 1] : null;
    return normalize(out);
  }

  /** Next tab of the active group, else the next view in order(). */
  function putBehind(L) {
    if (L.active === null) return clone(L);
    const g = groupOf(L, L.active);
    if (g && g.tabs.length > 1) return activate(L, g.tabs[(g.tabs.indexOf(L.active) + 1) % g.tabs.length]);
    const vis = order(L).filter((d) => !isMinimized(L, d));
    if (vis.length < 2) return clone(L);
    let out = clone(L);
    if (isFloating(out, L.active)) { const f = out.floating.findIndex((x) => x.docId === L.active); out.floating.unshift(out.floating.splice(f, 1)[0]); }
    return activate(out, vis[(vis.indexOf(L.active) + 1) % vis.length]);
  }

  function maximize(L, groupId) {
    const out = clone(L);
    const g = groupId ? findNode(out, groupId) : null;
    out.maximized = g && g.type === 'group' ? g.id : null;
    return out;
  }

  /** 25 % edges, centre otherwise; null outside the rect. rect = { x, y, w, h }. */
  function dropZoneAt(rect, x, y) {
    if (!rect || !(rect.w > 0) || !(rect.h > 0)) return null;
    const fx = (x - rect.x) / rect.w, fy = (y - rect.y) / rect.h;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
    const d = [['left', fx], ['right', 1 - fx], ['top', fy], ['bottom', 1 - fy]].filter(([, v]) => v < 0.25);
    if (!d.length) return 'center';
    d.sort((a, b) => a[1] - b[1]);
    return d[0][0];
  }

  function serialize(L) { return clone(L); }

  /** Never throws: unknown ids are dropped, known docs missing from the data become tabs of the first group. */
  function validate(json, knownDocIds) {
    const known = new Set((knownDocIds || []).filter(isId));
    const seen = new Set();
    const L = empty();
    const take = (d) => { if (isId(d) && known.has(d) && !seen.has(d)) { seen.add(d); return true; } return false; };
    const num = (v, dflt) => (Number.isFinite(v) ? v : dflt);
    const readNode = (n, depth) => {
      if (!n || typeof n !== 'object' || depth > 24) return null;
      if (n.type === 'group') {
        const tabs = Array.isArray(n.tabs) ? n.tabs.filter(take) : [];
        if (!tabs.length) return null;
        return { type: 'group', id: typeof n.id === 'string' ? n.id : 'g0', tabs, current: tabs.includes(n.current) ? n.current : tabs[0] };
      }
      if (n.type === 'split' && Array.isArray(n.children)) {
        const kids = [], sizes = [];
        n.children.forEach((c, i) => { const r = readNode(c, depth + 1); if (r) { kids.push(r); sizes.push(num(Array.isArray(n.sizes) ? n.sizes[i] : 0, 0)); } });
        if (!kids.length) return null;
        return { type: 'split', id: typeof n.id === 'string' ? n.id : 's0', dir: n.dir === 'col' ? 'col' : 'row', sizes, children: kids };
      }
      return null;
    };
    try {
      const src = json && typeof json === 'object' ? json : {};
      L.root = readNode(src.root, 0);
      if (Array.isArray(src.floating)) for (const f of src.floating) if (f && take(f.docId)) L.floating.push({ docId: f.docId, x: Math.round(num(f.x, 40)), y: Math.round(num(f.y, 40)), w: Math.max(MIN_W, Math.round(num(f.w, 480))), h: Math.max(MIN_H, Math.round(num(f.h, 360))) });
      if (Array.isArray(src.minimized)) for (const m of src.minimized) if (m && take(m.docId)) L.minimized.push(Object.assign({ docId: m.docId, from: typeof m.from === 'string' ? m.from : null }, isId(m.near) && SIDES.includes(m.side) ? { near: m.near, side: m.side } : {}));
      L.active = isId(src.active) && seen.has(src.active) ? src.active : null;
      L.maximized = typeof src.maximized === 'string' ? src.maximized : null;
      L.seq = Math.max(0, Math.floor(num(src.seq, 0)));
      // ids are repaired to be unique
      const ids = new Set();
      walk(L.root, (n) => { if (ids.has(n.id) || !/^[sg]\d+$/.test(n.id)) { L.seq++; n.id = (n.type === 'group' ? 'g' : 's') + L.seq; } ids.add(n.id); });
    } catch (e) { return normalize(addMissing(empty(), knownDocIds || [])); }
    return normalize(addMissing(normalize(L), knownDocIds || []));
  }
  function addMissing(L, ids) {
    let out = L;
    for (const d of ids) if (isId(d) && !has(out, d)) {
      const gs = groups(out);
      out = gs.length ? (() => { const o = clone(out); const g = groups(o)[0]; g.tabs.push(d); return o; })() : addTab(out, d);
    }
    return out;
  }

  return {
    MIN_W, MIN_H, minFraction, empty, normalize, addTab, split, gridWithSource, gridDims, remove, move, resize, equalize,
    float, dock, minimize, restore, tile, cascade, putBehind, activate, maximize, order, neighbour, dropZoneAt,
    serialize, validate, groups, groupOf, findNode, parentOf, has, isFloating, isMinimized
  };
})();

/* ============================================================
   IJRenderSched — the pure scheduler of the shared renderer
   ============================================================ */
const IJRenderSched = (() => {
  'use strict';

  /**
   * Tile requests of one frame, from every visible view. `want` takes
   *   { key, docId, rank, area, kind } with rank 0 = the active view, 1 = another visible view,
   *   2 = prefetch, and area = visible area of the view in px² (bigger first inside a rank).
   * `take(inflight)` returns the requests to start so that at most `cap` (default 10) run.
   */
  function createQueue({ cap = 10 } = {}) {
    let list = [];
    const keys = new Set();
    return {
      beginFrame() { list = []; keys.clear(); },
      want(req) { if (!req || keys.has(req.key)) return false; keys.add(req.key); list.push({ ...req, seq: list.length }); return true; },
      take(inflight, isBusy = () => false) {
        const room = Math.max(0, cap - inflight);
        if (!room) return [];
        const order = list.slice().sort((a, b) => (a.rank - b.rank) || ((b.area || 0) - (a.area || 0)) || (a.seq - b.seq));
        const out = [];
        for (const r of order) {
          if (out.length >= room) break;
          if (isBusy(r.key)) continue;
          out.push(r);
        }
        const got = new Set(out.map((r) => r.key));
        list = list.filter((r) => !got.has(r.key));
        for (const k of got) keys.delete(k);
        return out;
      },
      get size() { return list.length; },
      pending: () => list.slice()
    };
  }

  /** Whether the coarsest level of a doc may be pinned: pinned bytes stay within a quarter of the budget. */
  function canPin(pinnedBytes, bytes, budget) { return pinnedBytes + bytes <= budget / 4; }

  /**
   * One byte budget for all views. `docs` = [{ docId, pinnedKeys:[...] }]. Returns the keys to evict, oldest
   * first, skipping keys in `protect` (used by the frame being drawn) and the pinned coarse levels, until
   * `total` fits `budget`. `entries` is the LRU in recency order: [{ key, bytes, pinned }].
   */
  function planEviction(entries, total, budget, protect = null) {
    const out = [];
    let t = total;
    for (const e of entries) {
      if (t <= budget) break;
      if (e.pinned || (protect && protect.has(e.key))) continue;
      out.push(e.key); t -= e.bytes;
    }
    return out;
  }

  /** The request cap of the shared renderer, and the tile cache of the worker for n visible views. */
  const MAX_INFLIGHT = 10;
  function workerTileCacheBytes(visibleViews, budgetBytes) {
    const MiB = 1024 * 1024;
    return Math.min(512 * MiB, Math.floor((budgetBytes || 512 * MiB) / 2), 64 * MiB * (1 + Math.max(0, visibleViews | 0)));
  }

  return { createQueue, canPin, planEviction, MAX_INFLIGHT, workerTileCacheBytes };
})();

/* ============================================================
   IJRenderer — ONE WebGL2 context for every view
   ============================================================ */
const IJRenderer = (() => {
  'use strict';
  const P = IJViewPure;
  const S = IJRenderSched;
  const MiB = 1024 * 1024;
  const OVERLAY_MODES = { red: 1, bw: 2, overunder: 3 };

  const VERT = `#version 300 es
in vec2 aPos;
uniform vec4 uDest;
uniform vec3 uView;
uniform vec2 uSize;
uniform float uFlipY;
out vec2 vImg;
void main() {
  vec2 img = mix(uDest.xy, uDest.zw, aPos);
  vec2 s = img * uView.x + uView.yz;
  vec2 clip = vec2(s.x / uSize.x * 2.0 - 1.0, 1.0 - s.y / uSize.y * 2.0);
  clip.y *= uFlipY;
  vImg = img;
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

  // Display maths (ImageJ): 8-bit  idx = floor((v-min)*256/(max-min+1));
  //                          16-bit idx = floor((v-min)*256/(max-min+1)+0.5);
  //                          32-bit idx = floor((v-min)/(max-min)*255+0.5); all clamped to 0..255,
  // then the LUT (Invert LUT = 255-idx). The threshold overlays compare the RAW value.
  // uInterp (Edit > Options > Appearance, "Interpolate zoomed images"): the four nearest raw
  // texels are blended BEFORE the LUT (ImageJ blends the rendered colours: a documented deviation).
  const FRAG = (isInt) => `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;
#define INT ${isInt ? 1 : 0}
#if INT
uniform usampler2D uTex;
#define FETCH(tc) float(texelFetch(uTex, tc, 0).r)
#else
uniform sampler2D uTex;
#define FETCH(tc) texelFetch(uTex, tc, 0).r
#endif
uniform sampler2D uLut;
uniform vec2 uSrcOrigin;
uniform float uSrcScale;
uniform ivec2 uTexSize;
uniform float uMin;
uniform float uMax;
uniform int uInvert;
uniform int uBits;
uniform int uOverlay;
uniform int uInterp;
uniform vec2 uThr;
uniform vec4 uHole;
uniform int uHasHole;
in vec2 vImg;
out vec4 outColor;
void main() {
  if (uHasHole == 1 && vImg.x >= uHole.x && vImg.y >= uHole.y && vImg.x < uHole.z && vImg.y < uHole.w) discard;
  vec2 p = (vImg - uSrcOrigin) / uSrcScale;
  ivec2 mx = uTexSize - ivec2(1);
  ivec2 tc = clamp(ivec2(floor(p)), ivec2(0), mx);
  float v = FETCH(tc);
  if (uInterp == 1 && uOverlay == 0 && v == v) {
    vec2 q = p - 0.5;
    ivec2 i0 = ivec2(floor(q));
    vec2 f = q - vec2(i0);
    float a = FETCH(clamp(i0, ivec2(0), mx));
    float b = FETCH(clamp(i0 + ivec2(1, 0), ivec2(0), mx));
    float c = FETCH(clamp(i0 + ivec2(0, 1), ivec2(0), mx));
    float d = FETCH(clamp(i0 + ivec2(1, 1), ivec2(0), mx));
    if (a == a && b == b && c == c && d == d) v = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  if (uOverlay != 0 && v != v) discard;
  if (uOverlay == 1) {
    if (v < uThr.x || v > uThr.y) discard;
    outColor = vec4(1.0, 0.0, 0.0, 1.0);
    return;
  }
  if (uOverlay == 2) {
    float inside = (v >= uThr.x && v <= uThr.y) ? 0.0 : 1.0;
    outColor = vec4(vec3(inside), 1.0);
    return;
  }
  if (uOverlay == 3) {
    if (v < uThr.x) { outColor = vec4(0.0, 0.0, 1.0, 1.0); return; }
    if (v > uThr.y) { outColor = vec4(0.0, 1.0, 0.0, 1.0); return; }
  }
  if (v != v) v = uMin;
  float idx;
  if (uBits == 8) idx = floor((v - uMin) * 256.0 / (uMax - uMin + 1.0));
  else if (uBits == 16) idx = floor((v - uMin) * 256.0 / (uMax - uMin + 1.0) + 0.5);
  else idx = floor((v - uMin) / max(uMax - uMin, 1e-30) * 255.0 + 0.5);
  idx = clamp(idx, 0.0, 255.0);
  if (uInvert == 1) idx = 255.0 - idx;
  outColor = vec4(texelFetch(uLut, ivec2(int(idx), 0), 0).rgb, 1.0);
}`;

  const UNIFORMS = ['uDest', 'uView', 'uSize', 'uFlipY', 'uTex', 'uLut', 'uSrcOrigin', 'uSrcScale', 'uTexSize',
    'uMin', 'uMax', 'uInvert', 'uBits', 'uOverlay', 'uInterp', 'uThr', 'uHole', 'uHasHole'];

  function err(code, message) { const e = new Error(message || code); e.code = code; return e; }

  /**
   * IJRenderer.create(options)
   *   options.document          the owning document (default: the global one)
   *   options.onContextLost()   options.onContextRestored()
   *   options.onTileError(err)  a provider rejection (the tile is retried later)
   *   options.getLut(name) -> Uint8Array(768) | null
   *   options.background        [r,g,b] 0..1 around the image
   *   options.SVRManager        the platform budget source (default: the global when present)
   * Views (IJView) call attach/detach/requestFrame; the renderer calls view._paint(renderer) for every dirty
   * visible view, the active one first, in ONE rAF, and the view blits the shared canvas in the same task.
   */
  function create(options = {}) {
    const opts = options || {};
    const doc = opts.document || document;
    const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
    const raf = (fn) => (win && win.requestAnimationFrame ? win.requestAnimationFrame(fn) : setTimeout(fn, 16));
    const caf = (id) => (win && win.cancelAnimationFrame ? win.cancelAnimationFrame(id) : clearTimeout(id));
    const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const background = opts.background || [0.17, 0.17, 0.19];

    const glCanvas = doc.createElement('canvas');
    glCanvas.width = 16; glCanvas.height = 16;
    glCanvas.className = 'ij-gl-canvas';
    let gl = null, lost = false, destroyed = false;
    let programs = null, vao = null, quadBuf = null, currentProg = null;
    const luts = new Map();
    const lutIds = new WeakMap();
    let lutCounter = 0, rampLut = null;
    const cleanups = [];
    const listen = (el, ev, fn) => { el.addEventListener(ev, fn); cleanups.push(() => el.removeEventListener(ev, fn)); };

    const docsState = new Map();     // docId -> { provider, nCh, maxLevel, chGen:[], info }
    const tiles = new Map();         // key -> { tex, bytes, float, bits, w, h, docId, c, level, tx, ty, stale }
    const lru = P.createLru();
    const inflight = new Map();      // key -> generation
    const queue = S.createQueue({ cap: S.MAX_INFLIGHT });
    const failedUntil = new Map();
    const failCount = new Map();
    const pinned = new Map();        // key -> bytes
    let pinnedBytes = 0;
    const frameUsed = new Set();
    let budgetCap = 256 * MiB;
    const views = new Set();
    const dirty = new Set();
    let rafId = 0;
    let cw = 16, ch = 16;

    const keyOf = (d, c, L, tx, ty) => `${d}|${c}|${L}|${tx}|${ty}`;
    const docOfKey = (key) => key.slice(0, key.indexOf('|'));

    // ---- GL ---------------------------------------------------------------------------------------------
    function buildProgram(isInt) {
      const compile = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
          const log = gl.getShaderInfoLog(sh);
          gl.deleteShader(sh);
          console.error('IJRenderer shader:', log);
          throw err('IJ_GL_SHADER', 'shader compile failed');
        }
        return sh;
      };
      const vs = compile(gl.VERTEX_SHADER, VERT), fs = compile(gl.FRAGMENT_SHADER, FRAG(isInt));
      const prog = gl.createProgram();
      gl.attachShader(prog, vs); gl.attachShader(prog, fs);
      gl.bindAttribLocation(prog, 0, 'aPos');
      gl.linkProgram(prog);
      gl.deleteShader(vs); gl.deleteShader(fs);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error('IJRenderer link:', gl.getProgramInfoLog(prog));
        gl.deleteProgram(prog);
        throw err('IJ_GL_SHADER', 'program link failed');
      }
      const u = {};
      for (const n of UNIFORMS) u[n] = gl.getUniformLocation(prog, n);
      gl.useProgram(prog);
      gl.uniform1i(u.uTex, 0);
      gl.uniform1i(u.uLut, 1);
      return { prog, u };
    }

    function initGL() {
      gl = glCanvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
      if (!gl) throw err('IJ_NO_WEBGL2', 'WebGL2 unavailable');
      programs = { int: buildProgram(true), float: buildProgram(false) };
      quadBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      currentProg = null;
    }

    // ---- LUTs (cached by name; custom tables registered through IJLuts.register are looked up by name) ----
    function ramp() {
      if (!rampLut) {
        rampLut = new Uint8Array(768);
        for (let i = 0; i < 256; i++) { rampLut[i * 3] = i; rampLut[i * 3 + 1] = i; rampLut[i * 3 + 2] = i; }
      }
      return rampLut;
    }
    function lutBytes(spec) {
      try {
        if (spec && typeof spec === 'object' && spec.length === 768) return spec;
        if (typeof spec === 'string') {
          const viaOpt = opts.getLut ? opts.getLut(spec) : null;
          if (viaOpt && viaOpt.length === 768) return viaOpt;
          if (typeof IJLuts !== 'undefined') {
            const b = spec.charAt(0) === '#' ? IJLuts.fromColor(spec) : IJLuts.get(spec);
            if (b && b.length === 768) return b;
          }
        }
      } catch (e) { console.error('IJRenderer LUT', e); }
      return null;
    }
    const fallbackLuts = new Set();
    function lutTexture(spec) {
      let key;
      if (spec && typeof spec === 'object') {
        if (!lutIds.has(spec)) lutIds.set(spec, ++lutCounter);
        key = 'a:' + lutIds.get(spec);
      } else key = 'n:' + String(spec || 'Grays');
      let tex = luts.get(key);
      if (tex && fallbackLuts.has(key)) {
        // drawn as a grey ramp because nobody knew the name: the table may have been registered since
        if (!lutBytes(spec)) return tex;
        gl.deleteTexture(tex); luts.delete(key); fallbackLuts.delete(key); tex = undefined;
      }
      if (tex) return tex;
      const found = lutBytes(spec);
      const bytes = found || ramp();
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGB8, 256, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGB, gl.UNSIGNED_BYTE, bytes);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      luts.set(key, tex);
      if (!found) fallbackLuts.add(key);
      return tex;
    }
    /** A LUT registered again under the same name must be uploaded again. */
    function dropLut(name) {
      const key = 'n:' + String(name);
      const t = luts.get(key);
      if (t && gl && !lost) gl.deleteTexture(t);
      luts.delete(key); fallbackLuts.delete(key);
      for (const v of views) v._dirty();
    }

    // ---- budget / tiles ------------------------------------------------------------------------------------
    function budgetBytes() {
      let platformBudget = null, live = 0;
      const SV = opts.SVRManager || (typeof SVRManager !== 'undefined' ? SVRManager : null);
      if (SV && gl) {
        try { platformBudget = SV.vramBudget({ getContext: () => gl }); live = SV.liveAtlasBytes(); } catch (e) { platformBudget = null; }
      }
      return P.tileBudgetBytes({ cap: budgetCap, platformBudget, liveBytes: live });
    }
    function deleteTile(key) {
      const t = tiles.get(key);
      if (!t) return;
      tiles.delete(key);
      lru.remove(key);
      if (pinned.has(key)) { pinnedBytes -= pinned.get(key); pinned.delete(key); }
      if (gl && !lost && t.tex) gl.deleteTexture(t.tex);
    }
    function evictToBudget() {
      const entries = lru.keys().map((k) => ({ key: k, bytes: tiles.get(k) ? tiles.get(k).bytes : 0, pinned: pinned.has(k) }));
      for (const key of S.planEviction(entries, lru.total, budgetBytes(), frameUsed)) deleteTile(key);
    }
    const docState = (docId) => docsState.get(docId) || null;

    function formatFor(bits) {
      if (bits === 8) return { internal: gl.R8UI, format: gl.RED_INTEGER, type: gl.UNSIGNED_BYTE, bpp: 1, float: false };
      if (bits === 16) return { internal: gl.R16UI, format: gl.RED_INTEGER, type: gl.UNSIGNED_SHORT, bpp: 2, float: false };
      return { internal: gl.R32F, format: gl.RED, type: gl.FLOAT, bpp: 4, float: true };
    }
    function typed(bits, data) {
      if (bits === 8) return data instanceof Uint8Array ? data : new Uint8Array(data);
      if (bits === 16) return data instanceof Uint16Array ? data : new Uint16Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
      return data instanceof Float32Array ? data : new Float32Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
    }
    /** Uploads a w x h single-channel image; throws IJ_TILE_UPLOAD on a size mismatch or GPU OOM. */
    function uploadTexture(bits, w, h, data) {
      if (!gl || lost) throw err('IJ_CONTEXT_LOST');
      const f = formatFor(bits);
      const arr = typed(bits, data);
      if (arr.length < w * h) throw err('IJ_TILE_UPLOAD', 'tile data shorter than its size');
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texStorage2D(gl.TEXTURE_2D, 1, f.internal, w, h);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, f.format, f.type, arr);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const e = gl.getError();
      if (e !== gl.NO_ERROR) {
        gl.deleteTexture(tex);
        const x = err('IJ_TILE_UPLOAD', 'GL error ' + e);
        x.oom = e === gl.OUT_OF_MEMORY;
        throw x;
      }
      return { tex, float: f.float, bytes: w * h * f.bpp };
    }
    function deleteTexture(tex) { if (gl && !lost && tex) gl.deleteTexture(tex); }

    // ---- tile requests --------------------------------------------------------------------------------------
    function markFailed(key) {
      const n = (failCount.get(key) || 0) + 1;
      failCount.set(key, n);
      failedUntil.set(key, n > 4 ? Infinity : nowMs() + 1000 * 2 ** n);
    }
    /** rank 0 = the active view, 1 = another visible view, 2 = prefetch; area = visible px² of the view. */
    let curRec = null;
    function wanted(req) {
      if (inflight.has(req.key)) return false;
      const have = tiles.get(req.key);
      if (have && !have.stale) return false;
      const until = failedUntil.get(req.key);
      return !(until && until > nowMs());
    }
    function want(docId, c, L, tx, ty, rank, area) {
      const req = { key: keyOf(docId, c, L, tx, ty), docId, c, L, tx, ty, rank, area };
      if (curRec) curRec.push(req);
      if (wanted(req)) queue.want(req);
    }
    function pump() {
      if (destroyed) return;
      for (const r of queue.take(inflight.size, (k) => inflight.has(k))) startLoad(r);
    }
    function dirtyDoc(docId) { for (const v of views) if (v.docId === docId) v._dirty(); }
    function startLoad({ key, docId, c, L, tx, ty }) {
      const st = docState(docId);
      if (!st || !st.provider) return;
      const gen = st.chGen[c];
      inflight.set(key, gen);
      let p;
      try { p = Promise.resolve(st.provider(c, L, tx, ty)); } catch (e) { p = Promise.reject(e); }
      p.then((tile) => {
        if (inflight.get(key) === gen) inflight.delete(key);
        const cur = docState(docId);
        if (destroyed || lost || !cur || cur.chGen[c] !== gen || !tile || !gl) { pump(); return; }
        try {
          const up = uploadTexture(tile.bitDepth, tile.width, tile.height, tile.data);
          const old = tiles.get(key);
          if (old && old.tex) gl.deleteTexture(old.tex);
          tiles.set(key, { tex: up.tex, bytes: up.bytes, float: up.float, bits: tile.bitDepth, w: tile.width, h: tile.height, docId, c, level: L, tx, ty, stale: false });
          const pin = L === cur.maxLevel && !pinned.has(key) && S.canPin(pinnedBytes, up.bytes, budgetBytes());
          if (pin) { pinned.set(key, up.bytes); pinnedBytes += up.bytes; }
          lru.add(key, up.bytes, pinned.has(key));
          evictToBudget();
        } catch (e) {
          markFailed(key);
          if (e && e.oom) { budgetCap = Math.max(32 * MiB, Math.floor(lru.total / 2)); evictToBudget(); }
          if (opts.onTileError) { try { opts.onTileError(e); } catch (x) { /* controller error */ } }
          else console.error('IJRenderer tile upload', e);
        }
        dirtyDoc(docId);
        pump();
      }).catch((e) => {
        if (inflight.get(key) === gen) inflight.delete(key);
        markFailed(key);
        if (!destroyed) {
          if (opts.onTileError) { try { opts.onTileError(e); } catch (x) { /* controller error */ } }
          else console.error('IJRenderer tile', e);
          const n = failCount.get(key) || 1;
          if (n <= 4) setTimeout(() => { if (!destroyed) dirtyDoc(docId); }, 1000 * 2 ** n + 100);
        }
        pump();
      });
    }

    // ---- document API ------------------------------------------------------------------------------------------
    function setDoc(docId, info, nCh) {
      let st = docsState.get(docId);
      if (!st) { st = { provider: null, nCh: 0, maxLevel: 0, chGen: [], info: null }; docsState.set(docId, st); }
      st.info = info; st.nCh = nCh;
      st.maxLevel = info ? P.maxLevelFor(info.width, info.height) : 0;
      st.chGen = new Array(nCh).fill(0).map(() => ++lutCounter);
      return st;
    }
    function setProvider(docId, fn) {
      let st = docsState.get(docId);
      if (!st) st = setDoc(docId, null, 0);
      st.provider = typeof fn === 'function' ? fn : null;
      dirtyDoc(docId);
    }
    function dropDocTiles(docId) {
      for (const key of Array.from(tiles.keys())) if (tiles.get(key).docId === docId) deleteTile(key);
      for (const key of Array.from(inflight.keys())) if (docOfKey(key) === String(docId)) inflight.delete(key);
      for (const m of [failedUntil, failCount]) for (const key of Array.from(m.keys())) if (docOfKey(key) === String(docId)) m.delete(key);
    }
    /** Closes a doc: its tiles, provider and state go. */
    function dropDoc(docId) { dropDocTiles(docId); docsState.delete(docId); }
    /** Drops what is shown for `channels` (all when null): resident tiles keep drawing until the fresh ones arrive. */
    function invalidate(docId, channels) {
      const st = docState(docId);
      if (!st) return;
      const list = Array.isArray(channels) ? channels : Array.from({ length: st.nCh }, (_, i) => i);
      for (const c of list) {
        if (c < 0 || c >= st.nCh) continue;
        st.chGen[c] = ++lutCounter;
        for (const t of tiles.values()) if (t.docId === docId && t.c === c) t.stale = true;
        const pre = docId + '|' + c + '|';
        for (const key of Array.from(inflight.keys())) if (key.startsWith(pre)) inflight.delete(key);
        for (const m of [failedUntil, failCount]) for (const key of Array.from(m.keys())) if (key.startsWith(pre)) m.delete(key);
      }
      dirtyDoc(docId);
    }

    // ---- drawing -----------------------------------------------------------------------------------------------------
    function bindProgram(entry) { if (currentProg !== entry) { gl.useProgram(entry.prog); currentProg = entry; } }

    /** src = { tex, w, h, float, bits, origin:[x,y], scale } */
    function drawTexture(entry, target, src, rect, d, overlayMode, hole, bits, thr, interp) {
      bindProgram(entry);
      const u = entry.u;
      gl.uniform4f(u.uDest, rect.x0, rect.y0, rect.x1, rect.y1);
      gl.uniform3f(u.uView, target.zoom, target.ox, target.oy);
      gl.uniform2f(u.uSize, target.w, target.h);
      gl.uniform1f(u.uFlipY, target.flip || 1);
      gl.uniform2f(u.uSrcOrigin, src.origin[0], src.origin[1]);
      gl.uniform1f(u.uSrcScale, src.scale);
      gl.uniform2i(u.uTexSize, src.w, src.h);
      gl.uniform1f(u.uMin, Number.isFinite(d.min) ? d.min : 0);
      gl.uniform1f(u.uMax, Number.isFinite(d.max) ? d.max : (bits === 8 ? 255 : 65535));
      gl.uniform1i(u.uInvert, d.invert ? 1 : 0);
      gl.uniform1i(u.uBits, bits);
      gl.uniform1i(u.uOverlay, overlayMode);
      gl.uniform1i(u.uInterp, interp && target.zoom > 1 ? 1 : 0);
      if (overlayMode && thr) gl.uniform2f(u.uThr, thr.lower, thr.upper);
      if (hole) { gl.uniform4f(u.uHole, hole.x0, hole.y0, hole.x1, hole.y1); gl.uniform1i(u.uHasHole, 1); }
      else gl.uniform1i(u.uHasHole, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    function lutSpecFor(dstate, c) {
      if (dstate.mode === 'gray') return 'Grays';
      const d = dstate.channels[c] || {};
      return d.lut || 'Grays';
    }
    function channelsToDraw(dstate, nCh) {
      if (!nCh) return [];
      if (dstate.mode === 'composite') {
        const out = [];
        for (let c = 0; c < nCh; c++) if (dstate.visible[c] !== false) out.push(c);
        return out;
      }
      return [Math.min(nCh - 1, Math.max(0, dstate.active | 0))];
    }
    function paintChannel(info, dstate, interp, thr, c, target, level, list, getTile, overlayMode, hole) {
      const d = dstate.channels[c] || {};
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, lutTexture(lutSpecFor(dstate, c)));
      let drawn = 0, missing = 0;
      for (const { tx, ty } of list) {
        const src = getTile(c, level, tx, ty);
        if (!src) { missing++; continue; }
        const rect = P.tileImageRect(level, tx, ty, info.width, info.height);
        drawTexture(src.float ? programs.float : programs.int, target, src, rect, d, overlayMode, hole, src.bits, thr, interp);
        drawn++;
      }
      return { drawn, missing };
    }

    /**
     * Draws one view into the bottom-left of the shared canvas and returns { level, fallback }.
     * v = { docId, info, dstate, view:{zoom,ox,oy}, size:{w,h,dpr}, thr, preview, interp, rank, area }
     */
    function draw(v) {
      const stats = { level: 0, fallback: false };
      if (!gl || lost) return stats;
      const { info, dstate, view, size } = v;
      const st = docState(v.docId);
      curRec = v.record || null;
      if (curRec) curRec.length = 0;
      const pw = Math.max(1, Math.round(size.w * size.dpr)), ph = Math.max(1, Math.round(size.h * size.dpr));
      const target = { zoom: view.zoom * size.dpr, ox: view.ox * size.dpr, oy: view.oy * size.dpr, w: pw, h: ph, flip: 1 };
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, pw, ph);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, 0, pw, ph);
      gl.disable(gl.BLEND);
      gl.clearColor(background[0], background[1], background[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (info && st && size.w > 0) {
        const L = P.levelForZoom(view.zoom, st.maxLevel);
        stats.level = L;
        const sx0 = Math.max(0, Math.floor(target.ox)), sy0 = Math.max(0, Math.floor(target.oy));
        const sx1 = Math.min(pw, Math.ceil(target.ox + info.width * target.zoom));
        const sy1 = Math.min(ph, Math.ceil(target.oy + info.height * target.zoom));
        if (sx1 > sx0 && sy1 > sy0) {
          gl.scissor(sx0, ph - sy1, sx1 - sx0, sy1 - sy0);
          gl.clearColor(0, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.scissor(0, 0, pw, ph);
        }
        gl.bindVertexArray(vao);
        const list = P.visibleTiles(view, size.w, size.h, info.width, info.height, L);
        const chans = channelsToDraw(dstate, st.nCh);
        const fromTile = (t, tx, ty, LL) => ({ tex: t.tex, w: t.w, h: t.h, float: t.float, bits: t.bits, origin: [tx * P.TILE * 2 ** LL, ty * P.TILE * 2 ** LL], scale: 2 ** LL });
        const interactive = (c, LL, tx, ty) => {
          const key = keyOf(v.docId, c, LL, tx, ty);
          const t = tiles.get(key);
          if (t) {
            lru.touch(key); frameUsed.add(key);
            if (t.stale) want(v.docId, c, LL, tx, ty, v.rank, v.area);
            return fromTile(t, tx, ty, LL);
          }
          want(v.docId, c, LL, tx, ty, v.rank, v.area);
          stats.fallback = true;
          for (let L2 = LL + 1; L2 <= st.maxLevel; L2++) {
            const p = P.parentTile(LL, tx, ty, L2);
            const k2 = keyOf(v.docId, c, L2, p.tx, p.ty);
            const t2 = tiles.get(k2);
            if (t2) { lru.touch(k2); frameUsed.add(k2); return fromTile(t2, p.tx, p.ty, L2); }
            want(v.docId, c, L2, p.tx, p.ty, v.rank, v.area);
          }
          return null;
        };
        const prev = v.preview;
        const holeOf = (c) => {
          if (!prev || !prev.tex[c]) return null;
          const s = 2 ** prev.level;
          return { x0: prev.x0 * s, y0: prev.y0 * s, x1: Math.min(info.width, (prev.x0 + prev.w) * s), y1: Math.min(info.height, (prev.y0 + prev.h) * s) };
        };
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ONE);
        for (const c of chans) {
          want(v.docId, c, st.maxLevel, 0, 0, v.rank, v.area);
          const hole = holeOf(c);
          paintChannel(info, dstate, v.interp, v.thr, c, target, L, list, interactive, 0, hole);
          if (hole) {
            const p = prev.tex[c];
            const src = { tex: p.tex, w: p.w, h: p.h, float: p.float, bits: prev.bits, origin: [prev.x0 * 2 ** prev.level, prev.y0 * 2 ** prev.level], scale: 2 ** prev.level };
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, lutTexture(lutSpecFor(dstate, c)));
            drawTexture(p.float ? programs.float : programs.int, target, src, hole, dstate.channels[c] || {}, 0, null, prev.bits, v.thr, v.interp);
          }
        }
        if (v.thr && v.thr.channel < st.nCh) {
          gl.disable(gl.BLEND);
          paintChannel(info, dstate, v.interp, v.thr, v.thr.channel, target, L, list, interactive, OVERLAY_MODES[v.thr.mode] || 1, null);
        }
        gl.disable(gl.BLEND);
      }
      gl.disable(gl.SCISSOR_TEST);
      curRec = null;
      return stats;
    }

    /** The canvas holds the largest view in device px; it only grows. */
    function ensureSize(w, h) {
      const nw = Math.max(cw, Math.max(16, w)), nh = Math.max(ch, Math.max(16, h));
      if (nw === cw && nh === ch) return;
      cw = nw; ch = nh;
      glCanvas.width = cw; glCanvas.height = ch;
    }

    // ---- frame loop --------------------------------------------------------------------------------------------------
    function attach(view) { views.add(view); }
    function detach(view) { views.delete(view); dirty.delete(view); }
    function requestFrame(view) {
      if (destroyed) return;
      if (view) dirty.add(view);
      if (!rafId) rafId = raf(frame);
    }
    function frame() {
      rafId = 0;
      if (destroyed || !gl || lost) return;
      frameUsed.clear();
      queue.beginFrame();
      for (const v of views) if (v._visible() && !dirty.has(v)) for (const w of v._wants()) if (wanted(w)) queue.want(w);
      const list = Array.from(dirty).filter((v) => v._visible());
      dirty.clear();
      list.sort((a, b) => (b.isActive ? 1 : 0) - (a.isActive ? 1 : 0) || b.area() - a.area());
      for (const v of list) v._paint(api);
      evictToBudget();
      pump();
    }

    /** One full frame now (what a capture, a test or a hidden page without rAF needs): `view` is repainted, the others as usual. */
    function renderNow(view) {
      if (view) dirty.add(view);
      if (rafId) { caf(rafId); rafId = 0; }
      frame();
    }

    // ---- export -------------------------------------------------------------------------------------------------------
    /**
     * The doc rendered at `scale` (output px per image px) into a 2D canvas, LUTs applied, in offscreen tiles
     * of <= 4096 px. Rejects IJ_NO_IMAGE | IJ_EXPORT_TOO_LARGE | IJ_CANCELLED | IJ_CONTEXT_LOST.
     * state = { docId, info, dstate, interp }
     */
    async function renderToCanvas(state, { scale = 1, signal = null, onProgress = null } = {}) {
      const { info, dstate, docId } = state;
      const st = docState(docId);
      if (!info || !gl || lost || !st) throw err('IJ_NO_IMAGE');
      const W = Math.max(1, Math.round(info.width * scale)), H = Math.max(1, Math.round(info.height * scale));
      if (W > 32767 || H > 32767 || W * H > 268435456) throw err('IJ_EXPORT_TOO_LARGE');
      if (!st.provider) throw err('IJ_NO_PROVIDER');
      const out = doc.createElement('canvas');
      out.width = W; out.height = H;
      const o2 = out.getContext('2d');
      const L = P.levelForZoom(scale, st.maxLevel);
      const chans = channelsToDraw(dstate, st.nCh);
      const TW = Math.min(W, 4096), TH = Math.min(H, 4096);
      const nTiles = Math.ceil(W / 4096) * Math.ceil(H / 4096);
      let doneTiles = 0;
      const fbTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, fbTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, TW, TH);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fbTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const pixels = new Uint8Array(TW * TH * 4);
      const temps = [];
      const cleanup = () => {
        for (const t of temps.splice(0)) if (gl && !lost) gl.deleteTexture(t);
        if (gl && !lost) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fbo); gl.deleteTexture(fbTex); }
        dirtyDoc(docId);
      };
      try {
        for (let oy = 0; oy < H; oy += 4096) {
          for (let ox = 0; ox < W; ox += 4096) {
            if (signal && signal.aborted) throw err('IJ_CANCELLED');
            const tw = Math.min(4096, W - ox), th = Math.min(4096, H - oy);
            const v = { zoom: scale, ox: -ox, oy: -oy };
            const list = P.visibleTiles(v, tw, th, info.width, info.height, L);
            // Resident tiles are read in ONE synchronous pass after the last await of the band: the shared LRU
            // and a stale reload (other views, the rAF loop) cannot free a texture between the lookup and the draw.
            const fetched = new Map();
            let have = null;
            for (let attempt = 0; have === null; attempt++) {
              if (attempt > 4) throw err('IJ_CONTEXT_LOST');
              const missing = [];
              const got = new Map();
              for (const c of chans) {
                for (const { tx, ty } of list) {
                  const lk = `${c}|${L}|${tx}|${ty}`;
                  const res = tiles.get(keyOf(docId, c, L, tx, ty));
                  if (res && !res.stale && res.tex) { got.set(lk, { tex: res.tex, w: res.w, h: res.h, float: res.float, bits: res.bits, origin: [tx * P.TILE * 2 ** L, ty * P.TILE * 2 ** L], scale: 2 ** L }); continue; }
                  const f = fetched.get(lk);
                  if (f) { got.set(lk, f); continue; }
                  missing.push({ c, tx, ty, lk });
                }
              }
              if (!missing.length) { have = got; break; }
              for (const m of missing) {
                const tile = await st.provider(m.c, L, m.tx, m.ty);
                if (destroyed || lost || !gl) throw err('IJ_CONTEXT_LOST');
                if (signal && signal.aborted) throw err('IJ_CANCELLED');
                const up = uploadTexture(tile.bitDepth, tile.width, tile.height, tile.data);
                temps.push(up.tex);
                fetched.set(m.lk, { tex: up.tex, w: tile.width, h: tile.height, float: up.float, bits: tile.bitDepth, origin: [m.tx * P.TILE * 2 ** L, m.ty * P.TILE * 2 ** L], scale: 2 ** L });
              }
            }
            if (destroyed || lost || !gl) throw err('IJ_CONTEXT_LOST');
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.viewport(0, 0, TW, TH);
            gl.disable(gl.SCISSOR_TEST);
            gl.clearColor(0, 0, 0, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.bindVertexArray(vao);
            gl.enable(gl.BLEND);
            gl.blendEquation(gl.FUNC_ADD);
            gl.blendFunc(gl.ONE, gl.ONE);
            const target = { zoom: scale, ox: -ox, oy: -oy, w: TW, h: TH, flip: -1 };
            for (const c of chans) paintChannel(info, dstate, !!state.interp, null, c, target, L, list, (cc, LL, tx, ty) => have.get(`${cc}|${LL}|${tx}|${ty}`) || null, 0, null);
            gl.disable(gl.BLEND);
            gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            const img = o2.createImageData(tw, th);
            img.data.set(pixels.subarray(0, tw * th * 4));
            for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
            o2.putImageData(img, ox, oy);
            for (const t of temps.splice(0)) gl.deleteTexture(t);
            doneTiles++;
            if (onProgress) onProgress(doneTiles / nTiles);
          }
        }
      } finally { cleanup(); }
      return out;
    }

    // ---- lifecycle ------------------------------------------------------------------------------------------------------
    function destroyGL() {
      if (!gl) return;
      if (!lost) {
        for (const t of tiles.values()) if (t.tex) gl.deleteTexture(t.tex);
        for (const t of luts.values()) gl.deleteTexture(t);
        if (programs) { gl.deleteProgram(programs.int.prog); gl.deleteProgram(programs.float.prog); }
        if (quadBuf) gl.deleteBuffer(quadBuf);
        if (vao) gl.deleteVertexArray(vao);
      }
      fallbackLuts.clear(); tiles.clear(); luts.clear(); lru.clear(); pinned.clear(); pinnedBytes = 0;
      programs = null; quadBuf = null; vao = null;
    }
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (rafId) caf(rafId);
      for (const fn of cleanups.splice(0)) fn();
      destroyGL();
      inflight.clear(); failedUntil.clear(); failCount.clear(); docsState.clear(); views.clear(); dirty.clear();
      try {
        const ext = gl && !lost ? gl.getExtension('WEBGL_lose_context') : null;
        if (ext) ext.loseContext();
      } catch (e) { /* already gone */ }
      gl = null;
    }
    listen(glCanvas, 'webglcontextlost', (e) => {
      e.preventDefault();
      lost = true;
      tiles.clear(); lru.clear(); luts.clear(); pinned.clear(); pinnedBytes = 0; inflight.clear();
      for (const st of docsState.values()) st.chGen = st.chGen.map(() => ++lutCounter);
      for (const v of views) v._contextLost();
      if (opts.onContextLost) { try { opts.onContextLost(); } catch (x) { console.error('IJRenderer onContextLost', x); } }
    });
    listen(glCanvas, 'webglcontextrestored', () => {
      try {
        lost = false;
        initGL();
        for (const v of views) v._contextRestored();
        if (opts.onContextRestored) opts.onContextRestored();
      } catch (e) { console.error('IJRenderer restore', e); }
    });
    initGL();

    const api = {
      canvas: glCanvas,
      attach, detach, requestFrame, renderNow, ensureSize, draw, uploadTexture, deleteTexture,
      setDoc, setProvider, dropDoc, dropTiles: dropDocTiles, invalidate, dropLut, renderToCanvas, destroy,
      isLost: () => lost,
      getStats: () => ({ residentTiles: tiles.size, residentBytes: lru.total, budgetBytes: budgetBytes(), pinnedBytes, inflight: inflight.size, queued: queue.size }),
      getDocStats: (docId) => {
        let n = 0, b = 0;
        for (const t of tiles.values()) if (t.docId === docId) { n++; b += t.bytes; }
        return { residentTiles: n, residentBytes: b, inflight: Array.from(inflight.keys()).filter((k) => docOfKey(k) === String(docId)).length };
      },
      residentKeys: () => Array.from(tiles.keys()),
      channelsToDraw
    };
    return api;
  }

  return { create, OVERLAY_MODES };
})();

/* ============================================================
   IJView — one per open document
   ============================================================ */
const IJView = (() => {
  'use strict';
  const P = IJViewPure;
  const MAX_ANNOTATIONS_DRAWN = 10000;

  /**
   * IJView.create(renderer, host, options) -> view
   *   options.docId  options.onViewChange(payload)  options.selectionColor
   * `host` is the element the view fills: it receives the image canvas (2D, a blit of the shared GL canvas)
   * and the overlay canvas. API (superset of the old IJDisplay): setImage, setDisplayState / setDisplay,
   * invalidate, setPreview, setThresholdOverlay, setOverlay (transient, dialog-owned), setAnnotations
   * (persistent), setRois, setDraft, zoomAt, setZoom, fit, view100, zoomToRect, pan, getView, setView,
   * onViewChange, setCursorMark, visibleRect, focus, setInterpolate, setVisible, destroy.
   */
  function create(renderer, host, options = {}) {
    const opts = options || {};
    const doc = host.ownerDocument || document;
    const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
    const docId = opts.docId;

    const canvas = doc.createElement('canvas');
    canvas.className = 'ij-view-canvas';
    const overlay = doc.createElement('canvas');
    overlay.className = 'ij-overlay-canvas';
    for (const c of [canvas, overlay]) {
      c.style.position = 'absolute'; c.style.left = '0'; c.style.top = '0';
      c.style.width = '100%'; c.style.height = '100%'; c.style.display = 'block';
    }
    overlay.style.pointerEvents = 'none';
    try {
      if (win && win.getComputedStyle && win.getComputedStyle(host).position === 'static') host.style.position = 'relative';
    } catch (e) { /* detached host */ }
    host.style.overflow = 'hidden';
    host.appendChild(canvas);
    host.appendChild(overlay);
    const c2d = canvas.getContext('2d');
    const octx = overlay.getContext('2d');

    let info = null, nCh = 0;
    let dstate = { mode: 'composite', active: 0, channels: [], visible: [] };
    let thr = null;
    let preview = null;
    let rois = { active: null, all: [], showAll: false, handles: true };
    let draft = null;
    let overlayItems = null;
    let annotations = { visible: true, items: [] };
    let cursorMark = null;
    let view = { zoom: 1, ox: 0, oy: 0 };
    let size = { w: 0, h: 0, dpr: 1 };
    let fitMode = true, pendingFit = false, sized = false;
    let visible = true, destroyed = false, isActive = false;
    let interp = false;
    let lastStats = { level: 0, fallback: false };
    let lastNotified = '';
    let selectionColor = opts.selectionColor || '#ffff00';
    const listeners = [];
    const wantsOut = [];
    let resizeObserver = null, winResize = null;
    let lost = false;

    const self = {
      docId, element: host, canvas, overlayCanvas: overlay,
      get isActive() { return isActive; },
      set isActive(v) { isActive = !!v; self._dirty(); },
      area: () => size.w * size.h,
      _visible: () => visible && !destroyed && size.w > 0 && size.h > 0,
      _wants: () => wantsOut,
      _dirty() { if (!destroyed) renderer.requestFrame(self); },
      _contextLost() { lost = true; dropPreviewTex(); },
      _contextRestored() { lost = false; self._dirty(); }
    };

    // ---- size / transform ------------------------------------------------------------------------------
    function measure() {
      const dpr = Math.max(1, Math.min(3, (win && win.devicePixelRatio) || 1));
      return { w: Math.max(0, Math.round(host.clientWidth || 0)), h: Math.max(0, Math.round(host.clientHeight || 0)), dpr };
    }
    function applySize() {
      if (destroyed) return;
      const m = measure();
      if (m.w === size.w && m.h === size.h && m.dpr === size.dpr) return;
      const prev = size;
      size = m;
      const pw = Math.max(1, Math.round(m.w * m.dpr)), ph = Math.max(1, Math.round(m.h * m.dpr));
      canvas.width = pw; canvas.height = ph; overlay.width = pw; overlay.height = ph;
      // A pane that was hidden (another tab, minimised) has size 0: showing it again keeps its zoom and pan.
      const first = !sized && m.w > 0 && m.h > 0;
      if (first) sized = true;
      if (info && m.w > 0 && m.h > 0) {
        if (pendingFit || fitMode || first) { doFit(); pendingFit = false; }
        else {
          const dx = prev.w > 0 ? (m.w - prev.w) / 2 : 0, dy = prev.h > 0 ? (m.h - prev.h) / 2 : 0;
          view = P.clampPan({ zoom: view.zoom, ox: view.ox + dx, oy: view.oy + dy }, m.w, m.h, info.width, info.height);
        }
      }
      self._dirty();
    }
    function doFit(snap = false) {
      if (!info || size.w <= 0 || size.h <= 0) { pendingFit = true; return; }
      view = P.fitView(size.w, size.h, info.width, info.height, { snap });
      fitMode = true;
    }
    /** `how`: true/false = leave/keep the fit mode (legacy), or { source: 'sync' } for a view set by Synchronize Windows,
     *  whose own (clamped) result is then reported with `user: false` so it is not relayed back. */
    function setView(v, how = true) {
      if (!info) return;
      view = P.clampPan({ zoom: P.clampZoom(v.zoom), ox: v.ox, oy: v.oy }, size.w, size.h, info.width, info.height);
      const sync = !!(how && typeof how === 'object' && how.source === 'sync');
      if (sync) lastProgrammatic = viewKey(view);
      if (how !== false) fitMode = false;
      self._dirty();
    }

    // ---- GPU preview -------------------------------------------------------------------------------------
    function dropPreviewTex() {
      if (preview) for (const p of Object.values(preview.tex)) renderer.deleteTexture(p.tex);
      preview = null;
    }
    function setPreview(region) {
      dropPreviewTex();
      if (region && info && !renderer.isLost()) {
        const tex = {};
        try {
          for (const [k, data] of Object.entries(region.channels || {})) {
            const up = renderer.uploadTexture(region.bitDepth, region.w, region.h, data);
            tex[k] = { tex: up.tex, float: up.float, w: region.w, h: region.h };
          }
          preview = { level: region.level | 0, x0: region.x0, y0: region.y0, w: region.w, h: region.h, bits: region.bitDepth, tex };
        } catch (e) {
          for (const p of Object.values(tex)) renderer.deleteTexture(p.tex);
          console.error('IJView preview', e);
        }
      }
      self._dirty();
    }

    // ---- public API ---------------------------------------------------------------------------------------
    function setImage(imgInfo) {
      dropPreviewTex();
      const prev = info, prevN = nCh;
      draft = null;
      rois = { active: null, all: [], showAll: false, handles: true };
      info = imgInfo ? { docId: imgInfo.docId, width: imgInfo.width, height: imgInfo.height, bitDepth: imgInfo.bitDepth, calibration: imgInfo.calibration || null } : null;
      nCh = imgInfo && imgInfo.channels ? imgInfo.channels.length : 0;
      // Switching tabs never gets here (the view keeps its tiles); a refresh of the same geometry keeps the
      // resident tiles drawing until fresh ones arrive, another geometry drops them.
      const same = !!(prev && info && prev.width === info.width && prev.height === info.height && prev.bitDepth === info.bitDepth && prevN === nCh);
      if (!same) { thr = null; overlayItems = null; cursorMark = null; }
      if (prev && !same) renderer.dropTiles(docId);
      renderer.setDoc(docId, info, nCh);
      if (same) renderer.invalidate(docId, null);
      if (info) {
        const chs = imgInfo.channels.map((ch) => ({ ...(ch.display || {}), min: ch.display ? ch.display.min : 0, max: ch.display ? ch.display.max : (info.bitDepth === 8 ? 255 : 65535) }));
        const disp = imgInfo.display || {};
        dstate = { mode: disp.mode || 'composite', active: disp.active || 0, channels: chs, visible: disp.visible ? disp.visible.slice() : chs.map(() => true) };
        if (!same) { fitMode = true; doFit(); }
      } else dstate = { mode: 'composite', active: 0, channels: [], visible: [] };
      self._dirty();
    }
    /** Same document, new description (name / calibration): the tiles and the view stay. */
    function updateInfo(imgInfo) {
      if (!imgInfo || !info) return;
      info.calibration = imgInfo.calibration || null;
    }
    function setDisplayState(state) {
      if (!state) return;
      if (state.mode) dstate.mode = state.mode;
      if (Number.isInteger(state.active)) dstate.active = state.active;
      if (Array.isArray(state.visible)) dstate.visible = state.visible.slice();
      if (Array.isArray(state.channels)) state.channels.forEach((d, i) => { dstate.channels[i] = { ...(dstate.channels[i] || {}), ...d }; });
      if (Number.isInteger(state.channel)) {
        const { channel, ...rest } = state;
        dstate.channels[channel] = { ...(dstate.channels[channel] || {}), ...rest };
        delete dstate.channels[channel].channel;
      }
      self._dirty();
    }
    function setThresholdOverlay(t) {
      thr = t && Number.isInteger(t.channel) ? { channel: t.channel, lower: t.lower, upper: t.upper, mode: t.mode || 'red' } : null;
      self._dirty();
    }
    function setRois(r) { rois = { ...rois, ...(r || {}) }; if (!Array.isArray(rois.all)) rois.all = []; self._dirty(); }
    function setDraft(d) { draft = d || null; self._dirty(); }
    function setOverlay(items) { overlayItems = Array.isArray(items) && items.length ? items.slice(0, 64) : null; self._dirty(); }
    /** Persistent annotations (image coordinates), drawn above the image and below the active selection. */
    function setAnnotations(items, vis = true) {
      annotations = { visible: vis !== false, items: Array.isArray(items) ? items : [] };
      self._dirty();
    }
    function setCursorMark(x, y) { cursorMark = x === null || x === undefined || !Number.isFinite(x) ? null : { x, y }; self._dirty(); }
    function setInterpolate(b) { interp = !!b; self._dirty(); }
    function setSelectionColor(c) { if (typeof c === 'string' && c) { selectionColor = c; self._dirty(); } }
    function setVisible(v) { const was = visible; visible = !!v; if (visible && !was) { applySize(); self._dirty(); } }
    function zoomAt(sx, sy, dir) {
      if (!info) return;
      const nz = P.nextZoom(view.zoom, dir);
      if (nz === view.zoom) return;
      setView(P.zoomAround(view, sx, sy, nz));
    }
    function setZoom(z, sx = size.w / 2, sy = size.h / 2) { if (info) setView(P.zoomAround(view, sx, sy, P.clampZoom(z))); }
    function fit() { if (!info) return; doFit(); view = P.clampPan(view, size.w, size.h, info.width, info.height); self._dirty(); }
    function view100() { setZoom(1); }
    function zoomToRect(rect) { if (info && rect && size.w > 0) setView(P.viewForRect(rect, size.w, size.h)); }
    function pan(dx, dy) { if (info) setView({ zoom: view.zoom, ox: view.ox + dx, oy: view.oy + dy }); }
    function setCursor(c) { host.style.cursor = c || ''; }
    function getView() {
      const st = info ? P.maxLevelFor(info.width, info.height) : 0;
      return { ...view, level: lastStats.level, maxLevel: st, width: info ? info.width : 0, height: info ? info.height : 0, viewportWidth: size.w, viewportHeight: size.h };
    }
    /** The part of the image on screen, in image px, clipped to the image. */
    function visibleRect() {
      if (!info) return { x0: 0, y0: 0, x1: 0, y1: 0 };
      const z = view.zoom || 1;
      const cl = (v, a, b) => Math.min(b, Math.max(a, v));
      return { x0: cl(-view.ox / z, 0, info.width), y0: cl(-view.oy / z, 0, info.height), x1: cl((size.w - view.ox) / z, 0, info.width), y1: cl((size.h - view.oy) / z, 0, info.height) };
    }
    function onViewChange(fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; }
    function invalidate(channels) { renderer.invalidate(docId, channels === undefined ? null : channels); }
    function focus() { try { host.focus({ preventScroll: true }); } catch (e) { /* detached */ } }

    const viewKey = (v) => `${v.zoom}|${v.ox}|${v.oy}`;
    let lastProgrammatic = null, lastViewKey = null;
    function notify() {
      const st = renderer.getDocStats(docId);
      const loading = !!info && (lastStats.fallback || st.inflight > 0);
      // `user`: the view itself moved and not because Synchronize Windows put it there (a change of the loading
      // state or of the level alone is not a view change)
      const vk = viewKey(view), moved = vk !== lastViewKey;
      lastViewKey = vk;
      const user = moved && vk !== lastProgrammatic;
      if (moved && user) lastProgrammatic = null;
      const payload = { docId, zoom: view.zoom, ox: view.ox, oy: view.oy, level: lastStats.level, loading, user, width: info ? info.width : 0, height: info ? info.height : 0 };
      const k = `${payload.zoom}|${payload.ox}|${payload.oy}|${payload.level}|${loading}|${payload.width}x${payload.height}`;
      if (k === lastNotified) return;
      lastNotified = k;
      for (const fn of listeners.slice()) { try { fn(payload); } catch (e) { console.error('IJView onViewChange', e); } }
      if (opts.onViewChange) { try { opts.onViewChange(payload); } catch (e) { console.error('IJView onViewChange', e); } }
    }

    // ---- painting (called by the renderer in its frame) ---------------------------------------------------------
    self._paint = (r) => {
      if (destroyed || !visible || size.w <= 0 || size.h <= 0) return;
      const pw = canvas.width, ph = canvas.height;
      r.ensureSize(pw, ph);
      lastStats = r.draw({ docId, info, dstate, view, size, thr, preview, interp, rank: isActive ? 0 : 1, area: size.w * size.h, record: wantsOut });
      // same task as the GL draw: the drawing buffer is not preserved
      try { c2d.drawImage(r.canvas, 0, r.canvas.height - ph, pw, ph, 0, 0, pw, ph); } catch (e) { /* context lost between draw and blit */ }
      drawOverlay();
      notify();
    };

    // ---- overlay ---------------------------------------------------------------------------------------------------
    function drawTransient(X, Y, z) {
      if (!overlayItems) return;
      for (const it of overlayItems) {
        if (!it || typeof it !== 'object') continue;
        const color = typeof it.color === 'string' ? it.color : '#00ffff';
        octx.strokeStyle = color; octx.fillStyle = color; octx.lineWidth = 1; octx.lineJoin = 'round';
        if (it.kind === 'points' && it.pts) {
          const n = Math.min(it.pts.length >> 1, 200000);
          for (let i = 0; i < n; i++) {
            const sx = X(it.pts[2 * i]), sy = Y(it.pts[2 * i + 1]);
            if (sx < -4 || sy < -4 || sx > size.w + 4 || sy > size.h + 4) continue;
            octx.fillRect(sx - 1.5, sy - 1.5, 3, 3);
          }
        } else if (it.kind === 'polyline' && it.pts && it.pts.length >= 4) {
          octx.beginPath();
          for (let i = 0; i + 1 < it.pts.length; i += 2) (i ? octx.lineTo(X(it.pts[i]), Y(it.pts[i + 1])) : octx.moveTo(X(it.pts[i]), Y(it.pts[i + 1])));
          if (it.closed) octx.closePath();
          octx.stroke();
        } else if (it.kind === 'grid' && Array.isArray(it.lines)) {
          octx.beginPath();
          for (const l of it.lines.slice(0, 4096)) { octx.moveTo(X(l[0]), Y(l[1])); octx.lineTo(X(l[2]), Y(l[3])); }
          octx.stroke();
        } else if (it.kind === 'rect' && Number.isFinite(it.x)) octx.strokeRect(X(it.x), Y(it.y), it.w * z, it.h * z);
      }
    }

    function roiPath(roi, X, Y, z) {
      octx.beginPath();
      switch (roi.type) {
        case 'rect': octx.rect(X(roi.x), Y(roi.y), roi.w * z, roi.h * z); return true;
        case 'oval': octx.ellipse(X(roi.x + roi.w / 2), Y(roi.y + roi.h / 2), Math.max(0, roi.w * z / 2), Math.max(0, roi.h * z / 2), 0, 0, Math.PI * 2); return true;
        case 'polygon': case 'freehand': {
          const pts = roi.points || [];
          pts.forEach(([x, y], i) => (i ? octx.lineTo(X(x), Y(y)) : octx.moveTo(X(x), Y(y))));
          if (pts.length > 2) octx.closePath();
          return true;
        }
        case 'line': octx.moveTo(X(roi.x1), Y(roi.y1)); octx.lineTo(X(roi.x2), Y(roi.y2)); return false;
        case 'polyline': case 'angle': {
          const pts = roi.points || [];
          pts.forEach(([x, y], i) => (i ? octx.lineTo(X(x), Y(y)) : octx.moveTo(X(x), Y(y))));
          return false;
        }
        default: return false;
      }
    }
    function haloStroke(color, width) {
      octx.lineJoin = 'round';
      octx.lineWidth = width + 2; octx.strokeStyle = 'rgba(0,0,0,0.55)'; octx.stroke();
      octx.lineWidth = width; octx.strokeStyle = color; octx.stroke();
    }
    /** style = { stroke?, width?, fill? } of an entry of the ROI list / an annotation; absent = the selection colour. */
    function drawRoi(roi, color, label, X, Y, z, style) {
      if (!roi) return;
      const st = style || {};
      const col = st.stroke || color;
      const w = st.width > 0 ? st.width * z : 1.25;
      if (roi.type === 'point') {
        for (const [x, y] of roi.points || []) {
          const sx = X(x), sy = Y(y);
          octx.beginPath(); octx.moveTo(sx - 5, sy); octx.lineTo(sx + 5, sy); octx.moveTo(sx, sy - 5); octx.lineTo(sx, sy + 5);
          haloStroke(col, 1);
          octx.beginPath(); octx.arc(sx, sy, 2.5, 0, Math.PI * 2); octx.fillStyle = col; octx.fill();
        }
      } else if (roi.type === 'mask') {
        const runs = roi.rle || [];
        if (runs.length && runs.length <= 20000 && roi.w > 0) {
          octx.fillStyle = st.fill || 'rgba(255,255,0,0.28)';
          let pos = 0, on = false;
          for (const run of runs) {
            if (on) {
              let p = pos, rem = run;
              while (rem > 0) {
                const row = Math.floor(p / roi.w), c = p % roi.w, len = Math.min(rem, roi.w - c);
                octx.fillRect(X(roi.x + c), Y(roi.y + row), len * z, z);
                p += len; rem -= len;
              }
            }
            pos += run; on = !on;
          }
        }
        octx.beginPath(); octx.setLineDash([4, 3]); octx.rect(X(roi.x), Y(roi.y), roi.w * z, roi.h * z); haloStroke(col, 1); octx.setLineDash([]);
      } else {
        if (roi.type === 'line' && roi.width > 1) {
          octx.beginPath(); octx.moveTo(X(roi.x1), Y(roi.y1)); octx.lineTo(X(roi.x2), Y(roi.y2));
          octx.lineCap = 'butt'; octx.lineWidth = roi.width * z; octx.strokeStyle = 'rgba(255,255,0,0.25)'; octx.stroke();
        }
        const closed = roiPath(roi, X, Y, z);
        if (closed && st.fill) { octx.fillStyle = st.fill; octx.fill(); }
        haloStroke(col, w);
      }
      if (label) {
        const b = P.roiBounds(roi);
        if (b) {
          octx.font = '11px sans-serif'; octx.textBaseline = 'top'; octx.fillStyle = 'rgba(0,0,0,0.6)';
          octx.fillText(label, X(b.x) + 3, Y(b.y) + 3);
          octx.fillStyle = col; octx.fillText(label, X(b.x) + 2, Y(b.y) + 2);
        }
      }
    }

    function drawAnnotations(X, Y, z) {
      if (!annotations.visible) return;
      const items = annotations.items;
      const n = Math.min(items.length, MAX_ANNOTATIONS_DRAWN);
      for (let i = 0; i < n; i++) {
        const it = items[i];
        if (!it || typeof it !== 'object') continue;
        octx.save();
        try {
          if (it.kind === 'roi' && it.roi) {
            drawRoi(it.roi, selectionColor, null, X, Y, z, { stroke: it.stroke, width: it.width, fill: it.fill });
          } else if (it.kind === 'text' && typeof it.text === 'string') {
            const px = Math.max(1, (it.size || 12) * z);
            octx.font = `${it.bold ? 'bold ' : ''}${px}px ${it.serif ? 'serif' : 'sans-serif'}`;
            octx.textBaseline = 'top'; octx.textAlign = it.align || 'left';
            const x = X(it.x), y = Y(it.y);
            if (it.background) {
              const tw = octx.measureText(it.text).width;
              const left = it.align === 'center' ? x - tw / 2 : it.align === 'right' ? x - tw : x;
              octx.fillStyle = it.background; octx.fillRect(left - 2, y - 1, tw + 4, px + 2);
            }
            octx.fillStyle = it.color || '#ffffff';
            octx.fillText(it.text, x, y);
          } else if (it.kind === 'shapes') {
            octx.strokeStyle = it.stroke || selectionColor; octx.fillStyle = it.stroke || selectionColor;
            octx.lineWidth = it.width > 0 ? it.width * z : 1;
            if (it.lines && it.lines.length >= 4) {
              octx.beginPath();
              for (let k = 0; k + 3 < it.lines.length; k += 4) { octx.moveTo(X(it.lines[k]), Y(it.lines[k + 1])); octx.lineTo(X(it.lines[k + 2]), Y(it.lines[k + 3])); }
              octx.stroke();
            }
            if (it.circles && it.circles.length >= 3) {
              octx.beginPath();
              for (let k = 0; k + 2 < it.circles.length; k += 3) { octx.moveTo(X(it.circles[k]) + it.circles[k + 2] * z, Y(it.circles[k + 1])); octx.arc(X(it.circles[k]), Y(it.circles[k + 1]), Math.max(0, it.circles[k + 2] * z), 0, Math.PI * 2); }
              octx.stroke();
            }
            if (it.points && it.points.length >= 2) for (let k = 0; k + 1 < it.points.length; k += 2) octx.fillRect(X(it.points[k]) - 1.5, Y(it.points[k + 1]) - 1.5, 3, 3);
          } else if (it.kind === 'rect' && Number.isFinite(it.x)) {
            octx.fillStyle = it.fill || 'rgba(255,255,0,0.3)';
            octx.fillRect(X(it.x), Y(it.y), it.w * z, it.h * z);
          } else if (it.kind === 'marker' && Number.isFinite(it.x)) {
            const sx = X(it.x), sy = Y(it.y), col = it.color || '#ff0000';
            octx.strokeStyle = col; octx.fillStyle = col; octx.lineWidth = 1.5;
            octx.beginPath(); octx.moveTo(sx - 5, sy); octx.lineTo(sx + 5, sy); octx.moveTo(sx, sy - 5); octx.lineTo(sx, sy + 5); octx.stroke();
            octx.beginPath(); octx.arc(sx, sy, 3, 0, Math.PI * 2); octx.fill();
            if (it.label) { octx.font = '10px sans-serif'; octx.textBaseline = 'bottom'; octx.fillText(String(it.type), sx + 5, sy - 3); }
          }
        } catch (e) { /* one bad item never stops the others */ }
        octx.restore();
      }
    }

    function drawOverlay() {
      if (!octx) return;
      const dpr = size.dpr;
      octx.setTransform(1, 0, 0, 1, 0, 0);
      octx.clearRect(0, 0, overlay.width, overlay.height);
      if (!info) return;
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const z = view.zoom;
      const X = (x) => x * z + view.ox, Y = (y) => y * z + view.oy;
      if (rois.showAll) {
        rois.all.forEach((it, i) => {
          const roi = it && it.roi ? it.roi : it;
          drawRoi(roi, '#00ffff', String(it && it.label != null ? it.label : i + 1), X, Y, z, it && it.roi ? { stroke: it.stroke, width: it.width, fill: it.fill } : null);
        });
      }
      drawAnnotations(X, Y, z);
      if (rois.active) {
        drawRoi(rois.active, selectionColor, null, X, Y, z, null);
        if (rois.handles) {
          for (const h of P.roiHandles(rois.active)) {
            const sx = X(h.x), sy = Y(h.y);
            octx.fillStyle = '#ffffff'; octx.strokeStyle = '#000000'; octx.lineWidth = 1;
            octx.fillRect(sx - 3, sy - 3, 6, 6); octx.strokeRect(sx - 3.5, sy - 3.5, 7, 7);
          }
        }
      }
      drawTransient(X, Y, z);
      if (draft) {
        const pts = draft.points || [];
        octx.beginPath();
        pts.forEach(([x, y], i) => (i ? octx.lineTo(X(x), Y(y)) : octx.moveTo(X(x), Y(y))));
        if (draft.rubber && pts.length) octx.lineTo(X(draft.rubber[0]), Y(draft.rubber[1]));
        haloStroke('#ffff00', 1.25);
        for (const [x, y] of pts) { octx.fillStyle = '#ffffff'; octx.fillRect(X(x) - 2.5, Y(y) - 2.5, 5, 5); }
      }
      if (cursorMark) {
        const sx = X(cursorMark.x), sy = Y(cursorMark.y);
        octx.beginPath(); octx.moveTo(sx - 8, sy); octx.lineTo(sx + 8, sy); octx.moveTo(sx, sy - 8); octx.lineTo(sx, sy + 8);
        haloStroke('#00ffff', 1);
      }
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (resizeObserver) resizeObserver.disconnect();
      if (winResize && win) win.removeEventListener('resize', winResize);
      dropPreviewTex();
      renderer.detach(self);
      renderer.dropDoc(docId);
      listeners.length = 0;
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    Object.assign(self, {
      setImage, updateInfo, setDisplayState, setDisplay: setDisplayState, invalidate, setPreview, setThresholdOverlay, setOverlay,
      setAnnotations, setRois, setDraft, zoomAt, setZoom, fit, view100, zoomToRect, pan, setCursor, getView, setView, onViewChange,
      setCursorMark, visibleRect, focus, setInterpolate, setSelectionColor, setVisible, destroy, resize: applySize, redraw: () => self._dirty(),
      setTileProvider: (fn) => renderer.setProvider(docId, fn),
      screenToImage: (x, y) => P.screenToImage(view, x, y),
      imageToScreen: (x, y) => P.imageToScreen(view, x, y),
      getInfo: () => info,
      getDisplayState: () => dstate,
      getAnnotations: () => annotations,
      renderToCanvas: (o) => renderer.renderToCanvas({ docId, info, dstate, interp }, o),
      renderNow: () => { if (self._visible()) renderer.renderNow(self); },
      getStats: () => ({ ...renderer.getDocStats(docId), level: lastStats.level, loading: !!info && (lastStats.fallback || renderer.getDocStats(docId).inflight > 0) })
    });

    renderer.attach(self);
    if (typeof ResizeObserver !== 'undefined') { resizeObserver = new ResizeObserver(() => applySize()); resizeObserver.observe(host); }
    else if (win) { win.addEventListener('resize', applySize); winResize = applySize; }
    applySize();
    return self;
  }

  return { create };
})();

/* ============================================================
   IJLayout — the workspace DOM
   ============================================================ */
const IJLayout = (() => {
  'use strict';
  const LP = IJLayoutPure;
  /** z-index bands: nothing leaves its band (a raise renormalises it). */
  const Z = { image: [10, 29], tool: [30, 49], menu: 60, dialog: 80 };
  const DRAG_THRESHOLD = 5;

  /**
   * IJLayout.create(root, options) -> layout
   *   options.t(key, fallback)
   *   options.makePane(docId) -> { el, view }     the pane element holds the view's stage; created on add
   *   options.destroyPane(docId, pane)
   *   options.onActivate(docId)  options.onClose(docId)  options.onChange(kind)
   * kind of onChange: 'add' | 'remove' | 'activate' | 'arrange' | 'float' | 'dock' | 'minimize' | 'restore' |
   *   'resize' | 'restore-from' | 'clear' | 'tabinfo'
   */
  function create(root, options = {}) {
    const opts = options || {};
    const doc = root.ownerDocument || document;
    const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const t = (key, fb) => { try { const v = opts.t ? opts.t(key, fb) : fb; return typeof v === 'string' && v && v !== key ? v : fb; } catch (e) { return fb; } };

    let L = LP.empty();
    const panes = new Map();       // docId -> { el, view }
    const info = new Map();        // docId -> { name, zoomPct, dirty, hidden }
    const changeFns = [], activateFns = [], closeFns = [];
    if (opts.onChange) changeFns.push(opts.onChange);
    if (opts.onActivate) activateFns.push(opts.onActivate);
    if (opts.onClose) closeFns.push(opts.onClose);
    let destroyed = false;
    let drag = null;
    let dropEl = null;
    const cleanups = [];

    const ws = el('div', 'ij-workspace');
    ws.style.position = 'relative'; ws.style.flex = '1 1 auto'; ws.style.minHeight = '0'; ws.style.display = 'flex'; ws.style.flexDirection = 'column';
    const treeEl = el('div', 'ij-layout-root');
    treeEl.style.flex = '1 1 auto'; treeEl.style.minHeight = '0'; treeEl.style.position = 'relative'; treeEl.style.display = 'flex';
    const floatLayer = el('div', 'ij-float-layer');
    floatLayer.style.position = 'absolute'; floatLayer.style.left = '0'; floatLayer.style.top = '0'; floatLayer.style.right = '0'; floatLayer.style.bottom = '0'; floatLayer.style.pointerEvents = 'none';
    const dock = el('div', 'ij-dock');
    dock.hidden = true;
    dock.setAttribute('aria-label', t('view.dock', 'Minimised images'));
    ws.append(treeEl, floatLayer, dock);
    root.appendChild(ws);

    function extent() { return { w: ws.clientWidth || 0, h: Math.max(0, (ws.clientHeight || 0) - (dock.hidden ? 0 : dock.offsetHeight || 0)) }; }
    const emit = (kind) => { for (const fn of changeFns.slice()) { try { fn(kind); } catch (e) { console.error('IJLayout onChange', e); } } };
    const tabInfo = (docId) => info.get(docId) || { name: String(docId), zoomPct: '', dirty: false, hidden: false };

    function set(next, kind) {
      const before = L.active;
      L = next;
      render();
      emit(kind);
      if (L.active !== before && L.active !== null) { for (const fn of activateFns.slice()) { try { fn(L.active); } catch (e) { console.error('IJLayout onActivate', e); } } }
    }

    /** True when only `active` and the stacking order of the floating windows differ: the DOM can stay as it is. */
    function sameShape(a, b) {
      if (JSON.stringify(a.root) !== JSON.stringify(b.root) || a.maximized !== b.maximized) return false;
      if (JSON.stringify(a.minimized) !== JSON.stringify(b.minimized) || a.floating.length !== b.floating.length) return false;
      return a.floating.every((f) => { const g = b.floating.find((x) => x.docId === f.docId); return g && g.x === f.x && g.y === f.y && g.w === f.w && g.h === f.h; });
    }
    /** An activation that keeps the tree: no pane leaves the DOM, so a pointer capture or the focus taken by the
     *  stage in the same gesture survives. */
    function quickActivate(next) {
      const before = L.active;
      L = next;
      for (const [d, p] of panes) { p.el.classList.toggle('is-active', L.active === d); p.view.isActive = L.active === d; }
      for (const w of floatLayer.children) {
        const i = L.floating.findIndex((f) => String(f.docId) === w.dataset.docId);
        if (i >= 0) w.style.zIndex = String(Math.min(Z.image[0] + i, Z.image[1]));
      }
      emit('activate');
      if (L.active !== before && L.active !== null) { for (const fn of activateFns.slice()) { try { fn(L.active); } catch (e) { console.error('IJLayout onActivate', e); } } }
    }

    function ensurePane(docId) {
      let p = panes.get(docId);
      if (!p) { p = opts.makePane(docId); panes.set(docId, p); }
      return p;
    }

    // ---- rendering ----------------------------------------------------------------------------------------------
    function makeTab(docId, { inFloat = false, groupId = null } = {}) {
      const inf = tabInfo(docId);
      const tab = el('div', 'ij-tab');
      tab.setAttribute('role', 'tab');
      tab.dataset.docId = String(docId);
      tab.tabIndex = 0;
      if (inf.dirty) tab.classList.add('is-dirty');
      const name = el('span', 'ij-tab-name', inf.name || '');
      const zoom = el('span', 'ij-tab-zoom', inf.zoomPct ? ` ${inf.zoomPct}%` : '');
      const dirtyMark = el('span', 'ij-tab-dirty', inf.dirty ? '*' : '');
      tab.append(name, dirtyMark, zoom);
      const btn = (cls, label, text, fn) => {
        const b = el('button', 'ij-tab-btn ' + cls, text);
        b.type = 'button'; b.title = label; b.setAttribute('aria-label', label);
        b.addEventListener('pointerdown', (e) => e.stopPropagation());
        b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        tab.appendChild(b);
      };
      btn('ij-tab-min', t('view.tabMinimize', 'Minimise'), '–', () => api.minimize(docId));
      if (inFloat) btn('ij-tab-dock', t('view.tabDock', 'Dock'), '⇥', () => api.dock(docId));
      else btn('ij-tab-pop', t('view.tabPopOut', 'Pop out'), '⧉', () => api.float(docId));
      btn('ij-tab-close', t('view.tabClose', 'Close'), '×', () => requestClose(docId));
      tab.addEventListener('click', () => api.activate(docId));
      tab.addEventListener('dblclick', (e) => { e.preventDefault(); if (groupId) api.toggleMaximize(groupId); });
      tab.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); api.activate(docId); return; }
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const g = LP.groupOf(L, docId);
        if (!g) return;
        const i = g.tabs.indexOf(docId), n = g.tabs.length;
        const next = g.tabs[(i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n];
        e.preventDefault(); api.activate(next);
        const nt = ws.querySelector('.ij-tab[data-doc-id="' + next + '"]');
        if (nt) nt.focus();
      });
      tab.addEventListener('pointerdown', (e) => beginDrag(e, docId, tab, inFloat ? 'float' : 'tab'));
      return tab;
    }

    function paneShell(docId, shown) {
      const p = ensurePane(docId);
      p.el.classList.add('ij-view');
      p.el.classList.toggle('is-active', L.active === docId);
      p.view.setVisible(shown);
      return p;
    }

    function renderNode(node) {
      if (node.type === 'group') {
        const g = el('div', 'ij-group');
        g.dataset.groupId = node.id;
        g.style.display = 'flex'; g.style.flexDirection = 'column'; g.style.minWidth = '0'; g.style.minHeight = '0'; g.style.flex = '1 1 0';
        const strip = el('div', 'ij-tabs');
        strip.setAttribute('role', 'tablist');
        for (const d of node.tabs) {
          if (tabInfo(d).hidden) continue;
          const tab = makeTab(d, { groupId: node.id });
          const on = d === node.current;
          tab.classList.toggle('is-active', on);
          tab.setAttribute('aria-selected', on ? 'true' : 'false');
          strip.appendChild(tab);
        }
        const body = el('div', 'ij-group-body');
        body.style.flex = '1 1 auto'; body.style.minHeight = '0'; body.style.position = 'relative'; body.style.display = 'flex'; body.style.flexDirection = 'column';
        for (const d of node.tabs) { if (d !== node.current) { const p = panes.get(d); if (p) p.view.setVisible(false); } }
        const cur = paneShell(node.current, true);
        cur.el.style.flex = '1 1 auto'; cur.el.style.minHeight = '0';
        body.appendChild(cur.el);
        g.append(strip, body);
        g.addEventListener('pointerdown', () => { if (L.active !== node.current) api.activate(node.current); });
        return g;
      }
      const sp = el('div', 'ij-split ' + (node.dir === 'row' ? 'is-row' : 'is-col'));
      sp.dataset.splitId = node.id;
      sp.style.display = 'flex'; sp.style.flexDirection = node.dir === 'row' ? 'row' : 'column'; sp.style.flex = '1 1 0'; sp.style.minWidth = '0'; sp.style.minHeight = '0';
      node.children.forEach((c, i) => {
        const child = renderNode(c);
        child.style.flex = `${node.sizes[i]} 1 0`;
        child.style.minWidth = '0'; child.style.minHeight = '0';
        sp.appendChild(child);
        if (i + 1 < node.children.length) sp.appendChild(makeDivider(node, i, sp));
      });
      return sp;
    }

    function makeDivider(node, i, spEl) {
      const dv = el('div', 'ij-divider ' + (node.dir === 'row' ? 'is-row' : 'is-col'));
      dv.setAttribute('role', 'separator');
      dv.setAttribute('aria-orientation', node.dir === 'row' ? 'vertical' : 'horizontal');
      dv.style.flex = '0 0 auto';
      dv.style.cursor = node.dir === 'row' ? 'ew-resize' : 'ns-resize';
      let start = null;
      dv.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const total = node.dir === 'row' ? spEl.clientWidth : spEl.clientHeight;
        start = { x: e.clientX, y: e.clientY, total: Math.max(1, total), base: L };
        try { dv.setPointerCapture(e.pointerId); } catch (x) { /* synthetic */ }
      });
      dv.addEventListener('pointermove', (e) => {
        if (!start) return;
        const dpx = node.dir === 'row' ? e.clientX - start.x : e.clientY - start.y;
        const ext = extent();
        const minFr = LP.minFraction(node.dir === 'row' ? start.total : start.total, node.dir);
        L = LP.resize(start.base, node.id, i, dpx / start.total, minFr);
        applySizes();
        void ext;
      });
      const end = () => { if (start) { start = null; emit('resize'); } };
      dv.addEventListener('pointerup', end); dv.addEventListener('pointercancel', end);
      dv.addEventListener('dblclick', () => set(LP.equalize(L, node.id), 'resize'));
      return dv;
    }
    function applySizes() {
      for (const spEl of treeEl.querySelectorAll('.ij-split')) {
        const n = LP.findNode(L, spEl.dataset.splitId);
        if (!n || n.type !== 'split') continue;
        let k = 0;
        for (const c of Array.from(spEl.children)) { if (c.classList.contains('ij-divider')) continue; c.style.flex = `${n.sizes[k++]} 1 0`; }
      }
    }

    function renderFloating() {
      floatLayer.textContent = '';
      L.floating.forEach((f, i) => {
        const w = el('div', 'ij-view-window');
        w.dataset.docId = String(f.docId);
        w.dataset.windowId = 'view-' + f.docId;
        w.style.position = 'absolute'; w.style.left = f.x + 'px'; w.style.top = f.y + 'px'; w.style.width = f.w + 'px'; w.style.height = f.h + 'px';
        w.style.zIndex = String(Math.min(Z.image[0] + i, Z.image[1]));
        w.style.pointerEvents = 'auto'; w.style.display = 'flex'; w.style.flexDirection = 'column';
        const strip = el('div', 'ij-tabs');
        strip.setAttribute('role', 'tablist');
        const tab = makeTab(f.docId, { inFloat: true });
        tab.classList.add('is-active'); tab.setAttribute('aria-selected', 'true');
        strip.appendChild(tab);
        const p = paneShell(f.docId, true);
        p.el.style.flex = '1 1 auto'; p.el.style.minHeight = '0';
        const grip = el('div', 'ij-resize-grip');
        grip.setAttribute('aria-hidden', 'true');
        grip.style.position = 'absolute'; grip.style.right = '0'; grip.style.bottom = '0'; grip.style.cursor = 'nwse-resize';
        let rs = null;
        grip.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); api.activate(f.docId); rs = { x: e.clientX, y: e.clientY, w: f.w, h: f.h }; try { grip.setPointerCapture(e.pointerId); } catch (x) { /* synthetic */ } });
        grip.addEventListener('pointermove', (e) => {
          if (!rs) return;
          const nw = Math.max(LP.MIN_W, Math.round(rs.w + e.clientX - rs.x)), nh = Math.max(LP.MIN_H, Math.round(rs.h + e.clientY - rs.y));
          w.style.width = nw + 'px'; w.style.height = nh + 'px';
          const fl = L.floating.find((x) => x.docId === f.docId);
          if (fl) { fl.w = nw; fl.h = nh; }
        });
        const endRs = () => { if (rs) { rs = null; emit('float'); } };
        grip.addEventListener('pointerup', endRs); grip.addEventListener('pointercancel', endRs);
        w.addEventListener('pointerdown', () => { if (L.active !== f.docId) api.activate(f.docId); });
        w.append(strip, p.el, grip);
        floatLayer.appendChild(w);
      });
    }

    function renderDock() {
      dock.textContent = '';
      dock.hidden = !L.minimized.length;
      for (const m of L.minimized) {
        const chip = el('button', 'ij-dock-chip', tabInfo(m.docId).name || String(m.docId));
        chip.type = 'button'; chip.dataset.docId = String(m.docId);
        chip.title = t('view.dockRestore', 'Restore');
        chip.addEventListener('click', () => { if (!drag) api.restore(m.docId); });
        chip.addEventListener('pointerdown', (e) => beginDrag(e, m.docId, chip, 'chip'));
        dock.appendChild(chip);
        const p = panes.get(m.docId);
        if (p) p.view.setVisible(false);
      }
    }

    function render() {
      if (destroyed) return;
      // panes are re-parented, never destroyed: take them out of the DOM first
      for (const p of panes.values()) if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
      treeEl.textContent = '';
      if (L.root) {
        if (L.maximized) {
          const g = LP.findNode(L, L.maximized);
          treeEl.appendChild(renderNode(g || L.root));
          for (const grp of LP.groups(L)) if (!g || grp.id !== g.id) for (const d of grp.tabs) { const p = panes.get(d); if (p) p.view.setVisible(false); }
        } else treeEl.appendChild(renderNode(L.root));
      }
      renderFloating();
      renderDock();
      for (const [d, p] of panes) { p.el.classList.toggle('is-active', L.active === d); p.view.isActive = L.active === d; }
      for (const p of panes.values()) if (p.view.resize && p.el.parentNode) p.view.resize();
    }

    // ---- drag and drop of tabs / chips / floating windows -------------------------------------------------------------
    function beginDrag(e, docId, source, kind) {
      if (e.button !== 0 || destroyed) return;
      drag = { docId, kind, x0: e.clientX, y0: e.clientY, started: false, ghost: null, target: null, srcEl: source, id: e.pointerId, offX: 0, offY: 0 };
      const onMove = (ev) => moveDrag(ev);
      const onUp = (ev) => { finish(ev, false); };
      const onKey = (ev) => { if (ev.key === 'Escape' && drag) { ev.preventDefault(); finish(null, true); } };
      const onSel = (ev) => { if (drag && drag.started) ev.preventDefault(); };
      const cleanup = () => { doc.removeEventListener('pointermove', onMove, true); doc.removeEventListener('pointerup', onUp, true); doc.removeEventListener('pointercancel', onUp, true); doc.removeEventListener('keydown', onKey, true); doc.removeEventListener('selectstart', onSel, true); try { if (source.releasePointerCapture && e.pointerId !== undefined) source.releasePointerCapture(e.pointerId); } catch (x) { /* released */ } };
      drag.cleanup = cleanup;
      try { if (source.setPointerCapture && e.pointerId !== undefined) source.setPointerCapture(e.pointerId); } catch (x) { /* synthetic */ }
      doc.addEventListener('selectstart', onSel, true);
      doc.addEventListener('pointermove', onMove, true); doc.addEventListener('pointerup', onUp, true); doc.addEventListener('pointercancel', onUp, true); doc.addEventListener('keydown', onKey, true);
    }
    function targetAt(x, y) {
      const top = doc.elementFromPoint ? doc.elementFromPoint(x, y) : null;
      if (!top) return null;
      const d = top.closest ? top.closest('.ij-dock') : null;
      if (d && ws.contains(d)) return { kind: 'dock' };
      const g = top.closest ? top.closest('.ij-group') : null;
      if (g && ws.contains(g)) {
        const rc = g.getBoundingClientRect();
        const zone = LP.dropZoneAt({ x: rc.left, y: rc.top, w: rc.width, h: rc.height }, x, y);
        return zone ? { kind: 'group', groupId: g.dataset.groupId, zone, rect: rc } : null;
      }
      return { kind: 'free' };
    }
    function moveDrag(ev) {
      if (!drag) return;
      // the button was released outside the window: no pointerup reached us
      if (drag.started && ev.buttons === 0) { finish(null, true); return; }
      if (!drag.started) {
        if (Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) < DRAG_THRESHOLD) return;
        drag.started = true;
        drag.srcEl.classList.add('is-dragging');
        const ghost = el('div', 'ij-tab ij-tab-ghost', tabInfo(drag.docId).name || '');
        ghost.style.position = 'fixed'; ghost.style.pointerEvents = 'none'; ghost.style.zIndex = String(Z.menu);
        ws.appendChild(ghost);
        drag.ghost = ghost;
      }
      if (ev.preventDefault) ev.preventDefault();
      drag.ghost.style.left = (ev.clientX + 8) + 'px'; drag.ghost.style.top = (ev.clientY + 8) + 'px';
      const tg = targetAt(ev.clientX, ev.clientY);
      drag.target = tg;
      showDropZone(tg);
    }
    function showDropZone(tg) {
      if (!dropEl) { dropEl = el('div', 'ij-dropzone'); dropEl.style.position = 'fixed'; dropEl.style.pointerEvents = 'none'; dropEl.style.zIndex = String(Z.menu - 1); ws.appendChild(dropEl); }
      if (!tg || tg.kind !== 'group') { dropEl.hidden = true; return; }
      dropEl.hidden = false;
      const rc = tg.rect, z = tg.zone;
      const r = { left: rc.left, top: rc.top, width: rc.width, height: rc.height };
      if (z === 'left') r.width = rc.width / 2;
      else if (z === 'right') { r.left = rc.left + rc.width / 2; r.width = rc.width / 2; }
      else if (z === 'top') r.height = rc.height / 2;
      else if (z === 'bottom') { r.top = rc.top + rc.height / 2; r.height = rc.height / 2; }
      dropEl.className = 'ij-dropzone is-' + z;
      dropEl.style.left = r.left + 'px'; dropEl.style.top = r.top + 'px'; dropEl.style.width = r.width + 'px'; dropEl.style.height = r.height + 'px';
    }
    function finish(ev, cancelled) {
      const d = drag;
      if (!d) return;
      drag = null;
      d.cleanup();
      d.srcEl.classList.remove('is-dragging');
      if (d.ghost && d.ghost.parentNode) d.ghost.parentNode.removeChild(d.ghost);
      if (dropEl) { if (dropEl.parentNode) dropEl.parentNode.removeChild(dropEl); dropEl = null; }
      if (!d.started || cancelled) return;
      const tg = ev ? targetAt(ev.clientX, ev.clientY) : d.target;
      if (!tg) return;
      if (tg.kind === 'dock') { if (!LP.isMinimized(L, d.docId)) api.minimize(d.docId); return; }
      if (tg.kind === 'group') {
        const g = LP.findNode(L, tg.groupId);
        if (g && !(g.tabs.length === 1 && g.tabs[0] === d.docId)) set(LP.move(L, d.docId, tg.groupId, tg.zone), LP.isFloating(L, d.docId) || LP.isMinimized(L, d.docId) ? 'dock' : 'arrange');
        return;
      }
      // outside every group: a floating window at the pointer
      const wr = ws.getBoundingClientRect();
      const x = ev ? ev.clientX : d.x0, y = ev ? ev.clientY : d.y0;
      const cur = L.floating.find((f) => f.docId === d.docId);
      set(LP.float(L, d.docId, { x: Math.max(0, Math.min(Math.max(0, wr.width - 140), x - wr.left - 40)), y: Math.max(0, Math.min(Math.max(0, wr.height - 80), y - wr.top - 12)), w: cur ? cur.w : Math.max(320, Math.round(wr.width * 0.5)), h: cur ? cur.h : Math.max(240, Math.round(wr.height * 0.5)) }), 'float');
    }

    function requestClose(docId) {
      if (!closeFns.length) { api.remove(docId); return; }
      for (const fn of closeFns.slice()) { try { fn(docId); } catch (e) { console.error('IJLayout onClose', e); } }
    }

    // ---- public API ---------------------------------------------------------------------------------------------
    function floatRect() {
      const e = extent();
      const n = L.floating.length;
      return { x: 40 + (n * 28) % 200, y: 40 + (n * 28) % 160, w: Math.max(320, Math.round(e.w * 0.5)), h: Math.max(240, Math.round(e.h * 0.5)) };
    }
    const api = {
      el: ws,
      get layout() { return L; },
      /**
       * Adds `docId` (and, for 'gridWithSource', every doc of opts.docIds that is not yet there).
       * placement: 'tab' (default: the active group) | 'splitRight' | 'gridWithSource' | 'float'
       */
      add(docId, o = {}) {
        if (destroyed) return;
        const placement = o.placement || 'tab';
        const ids = placement === 'gridWithSource' ? Array.from(new Set([docId, ...(o.docIds || [])])) : [docId];
        const fresh = ids.filter((d) => !LP.has(L, d));
        if (!fresh.length) { api.activate(docId); return; }
        for (const d of fresh) ensurePane(d);
        let next = L;
        const anchor = o.anchor !== undefined && o.anchor !== null && LP.has(L, o.anchor) ? o.anchor : L.active;
        if (placement === 'gridWithSource' && anchor !== null && anchor !== undefined) {
          for (const d of fresh) next = LP.addTab(next, d, null);
          const inf = o.aspect ? o.aspect : (() => { const p = panes.get(anchor); const i = p && p.view.getInfo ? p.view.getInfo() : null; return i ? i.width / Math.max(1, i.height) : 1; })();
          next = LP.gridWithSource(next, anchor, fresh, { aspect: inf, extentPx: extent() });
        } else if (placement === 'splitRight' && anchor !== null && anchor !== undefined && LP.groupOf(L, anchor)) {
          next = LP.split(next, LP.groupOf(next, anchor).id, 'right', docId);
        } else if (placement === 'float') {
          next = LP.float(LP.addTab(next, docId), docId, floatRect());
        } else {
          const ag = anchor !== null && anchor !== undefined ? LP.groupOf(L, anchor) : null;
          next = LP.addTab(next, docId, ag ? ag.id : null);
        }
        next = LP.activate(next, docId);
        set(next, 'add');
      },
      remove(docId) {
        if (!LP.has(L, docId) && !panes.has(docId)) return;
        const next = LP.remove(L, docId);
        const p = panes.get(docId);
        panes.delete(docId); info.delete(docId);
        if (p && p.el.parentNode) p.el.parentNode.removeChild(p.el);
        if (opts.destroyPane) { try { opts.destroyPane(docId, p); } catch (e) { console.error('IJLayout destroyPane', e); } }
        set(next, 'remove');
      },
      activate(docId) {
        if (!LP.has(L, docId)) return;
        const min = LP.isMinimized(L, docId);
        if (!min && L.active === docId && (!LP.groupOf(L, docId) || LP.groupOf(L, docId).current === docId)) return;
        const next = LP.activate(L, docId);
        if (!min && sameShape(L, next)) { quickActivate(next); return; }
        set(next, min ? 'restore' : 'activate');
      },
      view: (docId) => (panes.get(docId) ? panes.get(docId).view : null),
      views: () => Array.from(panes.values()).map((p) => p.view),
      has: (docId) => LP.has(L, docId),
      active: () => L.active,
      order: () => LP.order(L),
      neighbour: (docId) => LP.neighbour(L, docId),
      isMinimized: (docId) => LP.isMinimized(L, docId),
      tile() { set(LP.tile(L, LP.order(L).filter((d) => !tabInfo(d).hidden), { aspect: 4 / 3, extentPx: extent() }), 'arrange'); },
      cascade() { const e = extent(); set(LP.cascade(L, { x: 24, y: 24, w: Math.max(400, e.w - 48), h: Math.max(300, e.h - 48) }), 'arrange'); },
      showAll() {
        let next = L;
        for (const m of L.minimized.slice()) next = LP.restore(next, m.docId);
        // floating windows are raised in their current order: re-pushed, so they end above the tabbed panes' windows
        next = Object.assign({}, next, { floating: next.floating.map((f) => Object.assign({}, f)) });
        set(next, 'restore');
      },
      putBehind() { set(LP.putBehind(L), 'activate'); },
      minimize(docId) { set(LP.minimize(L, docId), 'minimize'); },
      restore(docId) { set(LP.restore(L, docId), 'restore'); },
      float(docId, rect) { set(LP.float(L, docId, rect || floatRect()), 'float'); },
      dock(docId, groupId, zone) { set(LP.dock(L, docId, groupId || null, zone || 'center'), 'dock'); },
      maximize(groupId) { set(LP.maximize(L, groupId), 'arrange'); },
      toggleMaximize(groupId) { set(LP.maximize(L, L.maximized === groupId ? null : groupId), 'arrange'); },
      serialize: () => LP.serialize(L),
      /** Applies a stored layout to the docs that exist now; unknown ids are dropped, missing ones become tabs. */
      restoreFrom(json, knownIds) {
        for (const d of knownIds) ensurePane(d);
        set(LP.validate(json, knownIds), 'restore-from');
      },
      clear() {
        for (const [d, p] of Array.from(panes)) {
          if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
          if (opts.destroyPane) { try { opts.destroyPane(d, p); } catch (e) { console.error('IJLayout destroyPane', e); } }
        }
        panes.clear(); info.clear();
        L = LP.empty();
        render();
        emit('clear');
      },
      setTabInfo(docId, o = {}) {
        const cur = Object.assign({ name: '', zoomPct: '', dirty: false, hidden: false }, info.get(docId) || {}, o);
        const same = info.get(docId) && Object.keys(cur).every((k) => info.get(docId)[k] === cur[k]);
        info.set(docId, cur);
        if (same) return;
        // cheap path: update the tab text in place
        const tab = ws.querySelector('.ij-tab[data-doc-id="' + docId + '"]');
        if (tab && o.hidden === undefined) {
          const n = tab.querySelector('.ij-tab-name'), z = tab.querySelector('.ij-tab-zoom'), dm = tab.querySelector('.ij-tab-dirty');
          if (n) n.textContent = cur.name || '';
          if (z) z.textContent = cur.zoomPct ? ` ${cur.zoomPct}%` : '';
          if (dm) dm.textContent = cur.dirty ? '*' : '';
          tab.classList.toggle('is-dirty', !!cur.dirty);
          const chip = dock.querySelector('.ij-dock-chip[data-doc-id="' + docId + '"]');
          if (chip) chip.textContent = cur.name || String(docId);
        } else render();
        emit('tabinfo');
      },
      onChange(fn) { changeFns.push(fn); return () => { const i = changeFns.indexOf(fn); if (i >= 0) changeFns.splice(i, 1); }; },
      onActivate(fn) { activateFns.push(fn); return () => { const i = activateFns.indexOf(fn); if (i >= 0) activateFns.splice(i, 1); }; },
      onClose(fn) { closeFns.push(fn); return () => { const i = closeFns.indexOf(fn); if (i >= 0) closeFns.splice(i, 1); }; },
      extent,
      refresh: render,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        if (drag) finish(null, true);
        for (const fn of cleanups.splice(0)) fn();
        for (const [d, p] of panes) if (opts.destroyPane) { try { opts.destroyPane(d, p); } catch (e) { /* gone */ } }
        panes.clear();
        if (ws.parentNode) ws.parentNode.removeChild(ws);
      }
    };
    return api;
  }

  return { create, Z };
})();
