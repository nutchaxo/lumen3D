/* ============================================================
   Advanced Studio — ij-view.js
   Display (tiled WebGL2), windows (dialogs / floating tools) and shell
   (menu bar, tool bar, title bar, status bar, pointer handling).

   Classic script, no ESM. Page only (needs the DOM). Globals:
     IJViewPure  pure helpers (zoom ladder, transforms, tile maths, LRU, menu model,
                 value parsing, ROI geometry, formatting) — testable in Node
     IJDisplay   tiled WebGL2 renderer
     IJWindows   dialogs, floating windows, confirm
     IJShell     ImageJ chrome + pointer handling

   Text: every string goes through t(key, fallback) supplied by the controller; a `t`
   that returns the key itself (missing translation) falls back to the English text.
   Keys used here (plugin lang, namespace-free):
     view.menu.<Name>        top-level and group names (File, Edit, Image, Process,
                             Analyze, Window, Help, Stacks, Adjust, Color, ...)
     view.tool.rect|oval|polygon|freehand|line|point|zoom|hand
     view.ok  view.cancel  view.preview  view.previewBadge  view.channel
     view.cancelOp  view.close  view.invalid.nan|range|integer
     view.menubar  view.toolbar  view.statusbar  view.stage  view.progress

   CSS classes (styles written by W6 in ij-style.css). `[hidden]` is used for every
   show/hide: the stylesheet needs `.ij-shell [hidden], .ij-dialog-backdrop [hidden]
   { display: none !important }`. A state class is added next to the base class.
     shell        ij-shell  ij-menubar  ij-menu-title(.is-open .is-active)
                  ij-menu-panel  ij-submenu  ij-menu-item(.is-active .is-disabled
                  .has-children)  ij-menu-label  ij-menu-shortcut  ij-menu-arrow
                  ij-menu-sep  ij-toolbar  ij-tool(.is-active)  ij-tool-sep
                  ij-tool-icon  ij-image-window  ij-titlebar  ij-title-name
                  ij-title-zoom  ij-title-badge  ij-subtitle  ij-stage
                  ij-gl-canvas  ij-overlay-canvas  ij-channel-bar
                  ij-channel-label  ij-channel-slider  ij-statusbar
                  ij-status-pos  ij-status-text  ij-progress  ij-progress-fill
                  ij-progress-label  ij-cancel  ij-warning
     windows      ij-dialog-backdrop  ij-dialog  ij-dialog-title  ij-dialog-body
                  ij-dialog-message  ij-dialog-buttons  ij-field  ij-field-label
                  ij-field-control  ij-field-units  ij-field-value  ij-invalid
                  ij-btn  ij-btn--primary  ij-btn--danger  ij-window
                  ij-window-title  ij-window-close  ij-window-content
                  (+ .is-dragging on a window or dialog while its title is dragged)
   Dialogs and floating windows are positioned with inline left/top (absolute inside
   the root, which must be a positioned box: the shell root is).
   ============================================================ */

/* ============================================================
   Pure helpers
   ============================================================ */
const IJViewPure = (() => {
  'use strict';

  const TILE = 1024;
  const MiB = 1024 * 1024;

  /** ImageJ's magnification ladder, 3.1 % .. 3200 % (ImageJ's 1/72 and 1/48 steps are
   *  left out, the plan stops at 3.1 %). */
  const ZOOM_LADDER = [1 / 32, 1 / 24, 1 / 16, 1 / 12, 1 / 8, 1 / 6, 1 / 4, 1 / 3, 1 / 2, 3 / 4,
    1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
  const MIN_ZOOM = ZOOM_LADDER[0];
  const MAX_ZOOM = ZOOM_LADDER[ZOOM_LADDER.length - 1];

  /** Next ladder zoom above (dir > 0) or below (dir < 0) `z`. */
  function nextZoom(z, dir) {
    const eps = 1e-9;
    if (dir > 0) {
      for (const l of ZOOM_LADDER) if (l > z * (1 + eps)) return l;
      return MAX_ZOOM;
    }
    for (let i = ZOOM_LADDER.length - 1; i >= 0; i--) if (ZOOM_LADDER[i] < z * (1 - eps)) return ZOOM_LADDER[i];
    return MIN_ZOOM;
  }

  /** Largest ladder zoom that is <= z (the smallest one when z is below the ladder). */
  function snapZoomDown(z) {
    let best = MIN_ZOOM;
    for (const l of ZOOM_LADDER) if (l <= z * (1 + 1e-9)) best = l;
    return best;
  }

  function clampZoom(z) { return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)); }

  // --- Pyramid geometry. Level L halves the dimensions L times with ceil (the engine's
  // downsample2 replicates odd edges), tiles are TILE x TILE texels of that level.
  function levelDims(w, h, level) {
    let lw = w, lh = h;
    for (let i = 0; i < level; i++) { lw = Math.ceil(lw / 2); lh = Math.ceil(lh / 2); }
    return { w: Math.max(1, lw), h: Math.max(1, lh) };
  }

  /** Smallest level whose whole image fits in one tile. */
  function maxLevelFor(w, h, tile = TILE) {
    let level = 0, d = { w, h };
    while ((d.w > tile || d.h > tile) && level < 24) { level++; d = levelDims(w, h, level); }
    return level;
  }

  /** Level shown at `zoom` (CSS px per image px): max(0, floor(log2(1/zoom))). */
  function levelForZoom(zoom, maxLevel = 24) {
    if (!(zoom > 0)) return Math.max(0, maxLevel);
    const l = Math.floor(Math.log2(1 / zoom) + 1e-9);
    return Math.min(Math.max(0, maxLevel), Math.max(0, l));
  }

  function tileGrid(w, h, level, tile = TILE) {
    const d = levelDims(w, h, level);
    return { cols: Math.ceil(d.w / tile), rows: Math.ceil(d.h / tile), w: d.w, h: d.h };
  }

  /** Texel size of tile (tx, ty) of a level (edge tiles are smaller). */
  function tileTexels(level, tx, ty, w, h, tile = TILE) {
    const d = levelDims(w, h, level);
    return { w: Math.max(0, Math.min(tile, d.w - tx * tile)), h: Math.max(0, Math.min(tile, d.h - ty * tile)) };
  }

  /** Image-space rectangle covered by a tile, clipped to the image. */
  function tileImageRect(level, tx, ty, w, h, tile = TILE) {
    const s = 2 ** level;
    return {
      x0: tx * tile * s, y0: ty * tile * s,
      x1: Math.min(w, (tx + 1) * tile * s), y1: Math.min(h, (ty + 1) * tile * s)
    };
  }

  // --- View transform: screen = image * zoom + origin (CSS px).
  function screenToImage(view, sx, sy) { return { x: (sx - view.ox) / view.zoom, y: (sy - view.oy) / view.zoom }; }
  function imageToScreen(view, ix, iy) { return { x: ix * view.zoom + view.ox, y: iy * view.zoom + view.oy }; }

  /** The view with zoom `z` that keeps the image point under screen (sx, sy) fixed. */
  function zoomAround(view, sx, sy, z) {
    const ix = (sx - view.ox) / view.zoom, iy = (sy - view.oy) / view.zoom;
    return { zoom: z, ox: sx - ix * z, oy: sy - iy * z };
  }

  /** An image smaller than the viewport stays centred; a larger one cannot leave the
   *  viewport (no empty band beyond an edge). */
  function clampPan(view, vw, vh, w, h) {
    const iw = w * view.zoom, ih = h * view.zoom;
    const ox = iw <= vw ? (vw - iw) / 2 : Math.min(0, Math.max(vw - iw, view.ox));
    const oy = ih <= vh ? (vh - ih) / 2 : Math.min(0, Math.max(vh - ih, view.oy));
    return { zoom: view.zoom, ox, oy };
  }

  /** The view showing the whole image centred, never above 100 % (ImageJ opens a small
   *  image at 100 %); `snap` takes the ladder step below instead of the exact fit. */
  function fitView(vw, vh, w, h, { snap = false, max = 1 } = {}) {
    let z = Math.min(vw / Math.max(1, w), vh / Math.max(1, h), max);
    if (!(z > 0)) z = 1;
    z = snap ? snapZoomDown(z) : Math.max(MIN_ZOOM, z);
    return { zoom: z, ox: (vw - w * z) / 2, oy: (vh - h * z) / 2 };
  }

  /** ImageJ "To Selection": the largest ladder zoom showing the rectangle, centred. */
  function viewForRect(rect, vw, vh) {
    const rw = Math.max(1, rect.w), rh = Math.max(1, rect.h);
    const z = snapZoomDown(Math.min(vw / rw, vh / rh));
    return { zoom: z, ox: vw / 2 - (rect.x + rw / 2) * z, oy: vh / 2 - (rect.y + rh / 2) * z };
  }

  /** Tiles of `level` intersecting the viewport, nearest the centre first. */
  function visibleTiles(view, vw, vh, w, h, level, tile = TILE) {
    const s = 2 ** level, span = tile * s;
    const ix0 = Math.max(0, (0 - view.ox) / view.zoom), ix1 = Math.min(w, (vw - view.ox) / view.zoom);
    const iy0 = Math.max(0, (0 - view.oy) / view.zoom), iy1 = Math.min(h, (vh - view.oy) / view.zoom);
    if (!(ix1 > ix0) || !(iy1 > iy0)) return [];
    const g = tileGrid(w, h, level, tile);
    const tx0 = Math.floor(ix0 / span), tx1 = Math.min(g.cols - 1, Math.floor((ix1 - 1e-9) / span));
    const ty0 = Math.floor(iy0 / span), ty1 = Math.min(g.rows - 1, Math.floor((iy1 - 1e-9) / span));
    const cx = (ix0 + ix1) / 2 / span - 0.5, cy = (iy0 + iy1) / 2 / span - 0.5;
    const out = [];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) out.push({ tx, ty, d: (tx - cx) ** 2 + (ty - cy) ** 2 });
    out.sort((a, b) => a.d - b.d);
    return out.map(({ tx, ty }) => ({ tx, ty }));
  }

  /** The tile of a coarser level covering tile (tx, ty) of `level`. */
  function parentTile(level, tx, ty, coarserLevel) {
    const k = coarserLevel - level;
    return { tx: tx >> k, ty: ty >> k };
  }

  // --- LRU accounting of resident tiles (bytes). Insertion order = recency.
  function createLru() {
    const m = new Map();
    let total = 0;
    function remove(key) {
      const e = m.get(key);
      if (!e) return false;
      total -= e.bytes;
      m.delete(key);
      return true;
    }
    function add(key, bytes, pinned = false) {
      remove(key);
      m.set(key, { bytes, pinned });
      total += bytes;
    }
    function touch(key) {
      const e = m.get(key);
      if (!e) return false;
      m.delete(key);
      m.set(key, e);
      return true;
    }
    /** Keys to drop, oldest first, until the total fits `budget`. Pinned entries and
     *  keys of `protect` (a Set) stay. The returned keys are already removed. */
    function evict(budget, protect = null) {
      const out = [];
      let t = total;
      for (const [k, e] of m) {
        if (t <= budget) break;
        if (e.pinned || (protect && protect.has(k))) continue;
        out.push(k);
        t -= e.bytes;
      }
      for (const k of out) remove(k);
      return out;
    }
    return {
      add, touch, remove, evict,
      has: (k) => m.has(k),
      clear() { m.clear(); total = 0; },
      get total() { return total; },
      get size() { return m.size; },
      keys: () => Array.from(m.keys())
    };
  }

  /** VRAM the tile cache may take: 256 MiB, and what the platform budget leaves once the
   *  live volume atlases are paid (never below 32 MiB). */
  function tileBudgetBytes({ cap = 256 * MiB, platformBudget = null, liveBytes = 0, floor = 32 * MiB } = {}) {
    if (Number.isFinite(platformBudget)) return Math.min(cap, Math.max(floor, platformBudget - (liveBytes || 0)));
    return cap;
  }

  /** Accumulates wheel deltas; returns { steps, acc } with steps = zoom ladder steps
   *  (positive = zoom in). One mouse notch (|deltaY| >= 100) is one step. */
  function wheelSteps(acc, deltaY, deltaMode = 0) {
    const d = deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * 400 : deltaY;
    let a = acc + d;
    let steps = 0;
    const unit = 60;
    while (a <= -unit) { steps++; a += unit; }
    while (a >= unit) { steps--; a -= unit; }
    return { steps, acc: Math.abs(a) < 1e-6 ? 0 : a };
  }

  // --- Shortcuts
  const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

  /** Normalised shortcut string of a keyboard event: 'm', 'Shift+C', 'Ctrl+Z',
   *  'Ctrl+Shift+Z', '+', 'Escape'. Letters: lowercase alone, upper with a modifier. */
  function shortcutFromEvent(e) {
    let k = e.key;
    if (!k || MODIFIER_KEYS.has(k)) return null;
    if (k === '=') k = '+';
    if (k === ' ') k = 'Space';
    const ctrl = !!(e.ctrlKey || e.metaKey), alt = !!e.altKey, shift = !!e.shiftKey;
    if (k.length === 1 && /[a-z]/i.test(k)) {
      const L = k.toUpperCase();
      const mods = (ctrl ? 'Ctrl+' : '') + (alt ? 'Alt+' : '') + (shift ? 'Shift+' : '');
      return mods ? mods + L : L.toLowerCase();
    }
    // a symbol already carries its Shift; a named key (Escape, Delete, F1...) does not
    const named = k.length > 1;
    return (ctrl ? 'Ctrl+' : '') + (alt ? 'Alt+' : '') + (named && shift ? 'Shift+' : '') + k;
  }

  /** 'ctrl+shift+z' -> 'Ctrl+Shift+Z'; 'M' -> 'm'; 'Ctrl++' keeps the '+' key. */
  function normalizeShortcut(s) {
    if (typeof s !== 'string' || !s) return null;
    let key, mods;
    if (s === '+') { key = '+'; mods = []; }
    else if (s.endsWith('++')) { key = '+'; mods = s.slice(0, -2).split('+').filter(Boolean); }
    else { const parts = s.split('+'); key = parts.pop(); mods = parts; }
    const has = (n) => mods.some((m) => m.toLowerCase() === n);
    const ctrl = has('ctrl') || has('cmd') || has('meta'), alt = has('alt'), shift = has('shift');
    if (key.length === 1 && /[a-z]/i.test(key)) {
      const L = key.toUpperCase();
      return (ctrl || alt || shift) ? (ctrl ? 'Ctrl+' : '') + (alt ? 'Alt+' : '') + (shift ? 'Shift+' : '') + L : L.toLowerCase();
    }
    if (key.toLowerCase() === 'space') key = 'Space';
    else if (key.toLowerCase() === 'esc' || key.toLowerCase() === 'escape') key = 'Escape';
    return (ctrl ? 'Ctrl+' : '') + (alt ? 'Alt+' : '') + (key.length > 1 && shift ? 'Shift+' : '') + key;
  }

  /** What the menu shows right-aligned: a plain letter in capitals, else as written. */
  function shortcutLabel(s) {
    const n = normalizeShortcut(s);
    if (!n) return '';
    return n.length === 1 && /[a-z]/.test(n) ? n.toUpperCase() : n;
  }

  // --- Menu tree + keyboard model
  const TOP_ORDER = ['File', 'Edit', 'Image', 'Process', 'Analyze', 'Window', 'Help'];

  /**
   * Menu tree from the command registry.
   * command = { id, menu: ['Image','Adjust'], label?, labelKey?, shortcut?, enabled?(state),
   *             separatorBefore? }  — an entry { separator: true, menu } adds a separator.
   * Returns [{ name, label, items }] with items = { type:'item', id, label, shortcut,
   * disabled, command } | { type:'group', name, label, children, disabled } |
   * { type:'separator' }, tops in ImageJ order (File, Edit, Image, Process, Analyze,
   * Window, Help) then any other in first-appearance order. Empty tops are dropped.
   */
  function buildMenuTree(commands, { t = (k, f) => f ?? k, state = null } = {}) {
    const tops = new Map();
    const tr = (key, fb) => { const v = t(key, fb); return typeof v === 'string' && v && v !== key ? v : fb; };
    const groupFor = (list, name) => {
      let g = list.find((i) => i.type === 'group' && i.name === name);
      if (!g) { g = { type: 'group', name, label: tr('view.menu.' + name, name), children: [], disabled: false }; list.push(g); }
      return g;
    };
    for (const c of commands || []) {
      if (!c || !Array.isArray(c.menu) || !c.menu.length) continue;
      const [topName, ...rest] = c.menu;
      if (!tops.has(topName)) tops.set(topName, { name: topName, label: tr('view.menu.' + topName, topName), items: [] });
      let list = tops.get(topName).items;
      for (const g of rest) list = groupFor(list, g).children;
      if (c.separator) {
        if (list.length && list[list.length - 1].type !== 'separator') list.push({ type: 'separator' });
        continue;
      }
      if (c.separatorBefore && list.length && list[list.length - 1].type !== 'separator') list.push({ type: 'separator' });
      let disabled = false;
      if (typeof c.enabled === 'function') { try { disabled = !c.enabled(state); } catch (e) { disabled = true; } }
      const label = c.label || (c.labelKey ? tr(c.labelKey, c.labelKey) : c.id);
      const sc = Array.isArray(c.shortcut) ? c.shortcut[0] : c.shortcut;
      list.push({ type: 'item', id: c.id, label, shortcut: sc ? shortcutLabel(sc) : '', disabled, command: c });
    }
    const markDisabled = (items) => {
      for (const it of items) if (it.type === 'group') {
        markDisabled(it.children);
        it.disabled = it.children.every((c) => c.type === 'separator' || c.disabled);
      }
    };
    const out = [];
    const order = [...TOP_ORDER, ...Array.from(tops.keys()).filter((n) => !TOP_ORDER.includes(n))];
    for (const n of order) {
      const top = tops.get(n);
      if (!top) continue;
      // trim leading / trailing / doubled separators left by disabled-free construction
      const clean = (items) => {
        const r = [];
        for (const it of items) {
          if (it.type === 'separator' && (!r.length || r[r.length - 1].type === 'separator')) continue;
          if (it.type === 'group') it.children = clean(it.children);
          r.push(it);
        }
        while (r.length && r[r.length - 1].type === 'separator') r.pop();
        return r;
      };
      top.items = clean(top.items);
      markDisabled(top.items);
      if (top.items.length) out.push(top);
    }
    return out;
  }

  function _selectable(it) { return it && it.type !== 'separator' && !it.disabled; }
  /** Index of the next selectable item from `from` stepping `step`, wrapping; -1 if none. */
  function nextSelectable(list, from, step) {
    const n = list.length;
    if (!n) return -1;
    let i = from;
    for (let k = 0; k < n; k++) {
      i = ((i + step) % n + n) % n;
      if (_selectable(list[i])) return i;
    }
    return -1;
  }
  function firstSelectable(list) {
    for (let i = 0; i < list.length; i++) if (_selectable(list[i])) return i;
    return -1;
  }
  function lastSelectable(list) {
    for (let i = list.length - 1; i >= 0; i--) if (_selectable(list[i])) return i;
    return -1;
  }
  /** The item list shown at `depth` (1 = the top's own items) for a stack. */
  function menuListAt(tree, stack, depth) {
    let list = tree[stack[0]] ? tree[stack[0]].items : [];
    for (let d = 1; d < depth; d++) {
      const it = list[stack[d]];
      if (!it || !it.children) return [];
      list = it.children;
    }
    return list;
  }

  /**
   * Keyboard model of the menu bar. state = { open, stack }: stack[0] = the top menu,
   * stack[k] = the highlighted index in the list shown at depth k (-1 = none).
   * Returns { state, activate } — activate is the item to run (the menu is then closed).
   */
  function menuKey(tree, state, key) {
    const st = { open: !!state.open, stack: state.stack.slice() };
    const n = tree.length;
    if (!n) return { state: st, activate: null };
    const top = st.stack[0];
    const openTop = (i) => {
      const items = tree[i].items;
      return { open: true, stack: [i, firstSelectable(items)] };
    };
    if (!st.open) {
      switch (key) {
        case 'ArrowRight': st.stack = [(top + 1) % n]; break;
        case 'ArrowLeft': st.stack = [(top - 1 + n) % n]; break;
        case 'Home': st.stack = [0]; break;
        case 'End': st.stack = [n - 1]; break;
        case 'ArrowDown': case 'Enter': case ' ': case 'ArrowUp': return { state: openTop(top), activate: null };
        default: break;
      }
      return { state: st, activate: null };
    }
    const depth = st.stack.length - 1;
    const list = menuListAt(tree, st.stack, depth);
    const cur = st.stack[st.stack.length - 1];
    const setCur = (i) => { st.stack[st.stack.length - 1] = i; };
    switch (key) {
      case 'ArrowDown': setCur(cur < 0 ? firstSelectable(list) : nextSelectable(list, cur, 1)); break;
      case 'ArrowUp': setCur(cur < 0 ? lastSelectable(list) : nextSelectable(list, cur, -1)); break;
      case 'Home': setCur(firstSelectable(list)); break;
      case 'End': setCur(lastSelectable(list)); break;
      case 'ArrowRight': {
        const it = list[cur];
        if (it && it.type === 'group' && !it.disabled) {
          st.stack.push(firstSelectable(it.children));
        } else {
          return { state: openTop((top + 1) % n), activate: null };
        }
        break;
      }
      case 'ArrowLeft':
        if (depth > 1) st.stack.pop();
        else return { state: openTop((top - 1 + n) % n), activate: null };
        break;
      case 'Enter': case ' ': {
        const it = list[cur];
        if (!it || it.type === 'separator' || it.disabled) break;
        if (it.type === 'group') { st.stack.push(firstSelectable(it.children)); break; }
        return { state: { open: false, stack: [top] }, activate: it };
      }
      case 'Escape':
        if (depth > 1) st.stack.pop();
        else return { state: { open: false, stack: [top] }, activate: null };
        break;
      default: break;
    }
    return { state: st, activate: null };
  }

  // --- Dialog value parsing
  /** Parses a number typed in a dialog ('1,5' and '1.5' both accepted). */
  function parseNumber(text, { min = -Infinity, max = Infinity, integer = false } = {}) {
    const s = String(text ?? '').trim().replace(',', '.');
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return { ok: false, code: 'nan' };
    const value = Number(s);
    if (!Number.isFinite(value)) return { ok: false, code: 'nan' };
    if (integer && !Number.isInteger(value)) return { ok: false, code: 'integer' };
    if (value < min || value > max) return { ok: false, code: 'range' };
    return { ok: true, value };
  }

  function formatNumber(v, decimals) {
    if (!Number.isFinite(v)) return String(v);
    if (Number.isInteger(decimals)) return v.toFixed(decimals);
    return String(Number(v.toPrecision(10)));
  }

  /** Values of a dialog: raw = { [id]: string | boolean } as read from the controls. */
  function collectFields(fields, raw) {
    const values = {}, errors = {};
    for (const f of fields) {
      if (f.type === 'message') continue;
      const r = raw[f.id];
      if (f.type === 'number' || f.type === 'slider') {
        const p = parseNumber(r, { min: f.min, max: f.max, integer: !!f.integer });
        if (p.ok) values[f.id] = p.value; else errors[f.id] = p.code;
      } else if (f.type === 'check') {
        values[f.id] = !!r;
      } else if (f.type === 'choice') {
        const opts = (f.options || []).map((o) => (typeof o === 'object' ? o.value : o));
        const hit = opts.find((o) => String(o) === String(r));
        if (hit === undefined) errors[f.id] = 'choice'; else values[f.id] = hit;
      } else {
        values[f.id] = String(r ?? '');
      }
    }
    return { ok: Object.keys(errors).length === 0, values, errors };
  }

  /** Keeps at least `margin` px of a window (w x h) inside a root of rw x rh; the title bar
   *  (top edge) never leaves the root. */
  function clampWindowPos(x, y, w, h, rw, rh, margin = 24) {
    return {
      x: Math.min(Math.max(margin - w, x), Math.max(margin - w, rw - margin)),
      y: Math.min(Math.max(0, y), Math.max(0, rh - margin))
    };
  }

  // --- ROI geometry (image px; pixel (i,j) covers [i,i+1) x [j,j+1))
  const _f = Math.floor;

  function roiBounds(roi) {
    if (!roi) return null;
    switch (roi.type) {
      case 'rect': case 'oval': case 'mask': return { x: roi.x, y: roi.y, w: roi.w, h: roi.h };
      case 'line': {
        const x = Math.min(roi.x1, roi.x2), y = Math.min(roi.y1, roi.y2);
        return { x, y, w: Math.abs(roi.x2 - roi.x1), h: Math.abs(roi.y2 - roi.y1) };
      }
      case 'polygon': case 'freehand': case 'point': {
        const pts = roi.points || [];
        if (!pts.length) return null;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
      default: return null;
    }
  }

  function translateRoi(roi, dx, dy) {
    const r = { ...roi };
    if ('x' in r) { r.x += dx; r.y += dy; }
    if ('x1' in r) { r.x1 += dx; r.y1 += dy; r.x2 += dx; r.y2 += dy; }
    if (Array.isArray(r.points)) r.points = r.points.map(([x, y]) => [x + dx, y + dy]);
    return r;
  }

  function isAreaRoi(roi) { return !!roi && ['rect', 'oval', 'polygon', 'freehand', 'mask'].includes(roi.type); }

  /** Rectangle / oval from a drag. Corners are pixel locations (floor), the size is
   *  their difference, as in ImageJ. shift = square / circle, alt = from the centre. */
  function roiFromDrag(type, p0, p1, { shift = false, alt = false } = {}) {
    const x0 = _f(p0.x), y0 = _f(p0.y);
    let x1 = _f(p1.x), y1 = _f(p1.y);
    let dx = x1 - x0, dy = y1 - y0;
    if (shift) {
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      dx = (dx < 0 ? -m : m); dy = (dy < 0 ? -m : m);
      x1 = x0 + dx; y1 = y0 + dy;
    }
    if (alt) return { type, x: x0 - Math.abs(dx), y: y0 - Math.abs(dy), w: Math.abs(dx) * 2, h: Math.abs(dy) * 2 };
    return { type, x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  }

  /** A line between two pixel CENTRES; shift constrains the angle to multiples of 45 deg. */
  function lineFromDrag(p0, p1, { shift = false, width = 1 } = {}) {
    const ax = _f(p0.x) + 0.5, ay = _f(p0.y) + 0.5;
    let bx = _f(p1.x) + 0.5, by = _f(p1.y) + 0.5;
    if (shift) {
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      bx = ax + Math.round(Math.cos(ang) * len * 1e6) / 1e6; by = ay + Math.round(Math.sin(ang) * len * 1e6) / 1e6;
      bx = _f(bx + 0.5) + 0.5 - 0.5; by = _f(by + 0.5) + 0.5 - 0.5;
    }
    return { type: 'line', x1: ax, y1: ay, x2: bx, y2: by, width };
  }

  const _RECT_HANDLES = [['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0], ['e', 1, 0.5], ['se', 1, 1], ['s', 0.5, 1], ['sw', 0, 1], ['w', 0, 0.5]];

  /** Handles of an editable ROI: [{ id, x, y }]. Freehand / mask have none. */
  function roiHandles(roi) {
    if (!roi) return [];
    if (roi.type === 'rect' || roi.type === 'oval') {
      return _RECT_HANDLES.map(([id, fx, fy]) => ({ id, x: roi.x + roi.w * fx, y: roi.y + roi.h * fy }));
    }
    if (roi.type === 'line') return [{ id: 'p1', x: roi.x1, y: roi.y1 }, { id: 'p2', x: roi.x2, y: roi.y2 }];
    if (roi.type === 'polygon' || roi.type === 'point') {
      const pts = roi.points || [];
      if (pts.length > 400) return [];
      return pts.map(([x, y], i) => ({ id: 'v' + i, x, y }));
    }
    return [];
  }

  /** The handle within `tol` image px of (x, y), nearest first; null if none. */
  function handleAt(roi, x, y, tol) {
    let best = null, bd = tol * tol;
    for (const h of roiHandles(roi)) {
      const d = (h.x - x) ** 2 + (h.y - y) ** 2;
      if (d <= bd) { bd = d; best = h; }
    }
    return best;
  }

  /** Does (x, y) lie on / in the ROI (tolerance in image px for thin shapes)? */
  function hitRoi(roi, x, y, tol = 0) {
    if (!roi) return false;
    switch (roi.type) {
      case 'rect': case 'mask':
        return x >= roi.x - tol && x <= roi.x + roi.w + tol && y >= roi.y - tol && y <= roi.y + roi.h + tol;
      case 'oval': {
        const a = roi.w / 2 + tol, b = roi.h / 2 + tol;
        if (a <= 0 || b <= 0) return false;
        return ((x - roi.x - roi.w / 2) / a) ** 2 + ((y - roi.y - roi.h / 2) / b) ** 2 <= 1;
      }
      case 'polygon': case 'freehand': {
        const pts = roi.points || [];
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, yi] = pts[i], [xj, yj] = pts[j];
          if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
      }
      case 'line': {
        const dx = roi.x2 - roi.x1, dy = roi.y2 - roi.y1, l2 = dx * dx + dy * dy;
        let t = l2 ? ((x - roi.x1) * dx + (y - roi.y1) * dy) / l2 : 0;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(x - (roi.x1 + t * dx), y - (roi.y1 + t * dy)) <= tol + (roi.width || 1) / 2;
      }
      case 'point':
        return (roi.points || []).some(([px, py]) => Math.hypot(px - x, py - y) <= tol);
      default: return false;
    }
  }

  /** The ROI after dragging handle `id` to (px, py). */
  function moveHandle(roi, id, px, py, { shift = false } = {}) {
    if (roi.type === 'rect' || roi.type === 'oval') {
      let x0 = roi.x, y0 = roi.y, x1 = roi.x + roi.w, y1 = roi.y + roi.h;
      const X = _f(px), Y = _f(py);
      if (id.includes('w')) x0 = X; else if (id.includes('e')) x1 = X;
      if (id.includes('n')) y0 = Y; else if (id.includes('s')) y1 = Y;
      if (shift && id.length === 2) {
        const m = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
        if (id.includes('w')) x0 = x1 - (x1 >= x0 ? m : -m); else x1 = x0 + (x1 >= x0 ? m : -m);
        if (id.includes('n')) y0 = y1 - (y1 >= y0 ? m : -m); else y1 = y0 + (y1 >= y0 ? m : -m);
      }
      return { ...roi, x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
    }
    if (roi.type === 'line') {
      const fixed = id === 'p1' ? { x: roi.x2, y: roi.y2 } : { x: roi.x1, y: roi.y1 };
      const moved = lineFromDrag({ x: fixed.x - 0.5, y: fixed.y - 0.5 }, { x: px, y: py }, { shift, width: roi.width });
      return id === 'p1'
        ? { ...roi, x1: moved.x2, y1: moved.y2 }
        : { ...roi, x2: moved.x2, y2: moved.y2 };
    }
    if (roi.type === 'polygon' || roi.type === 'point') {
      const i = Number(id.slice(1));
      const pts = roi.points.map((p) => p.slice());
      if (pts[i]) pts[i] = roi.type === 'point' ? [_f(px) + 0.5, _f(py) + 0.5] : [Math.round(px), Math.round(py)];
      return { ...roi, points: pts };
    }
    return roi;
  }

  /** The cursor for a handle id. */
  function handleCursor(id) {
    switch (id) {
      case 'n': case 's': return 'ns-resize';
      case 'e': case 'w': return 'ew-resize';
      case 'nw': case 'se': return 'nwse-resize';
      case 'ne': case 'sw': return 'nesw-resize';
      default: return 'crosshair';
    }
  }

  // --- Formatting
  function formatZoomPct(zoom) {
    const p = zoom * 100;
    if (p >= 100) return String(Math.round(p));
    return String(Math.round(p * 10) / 10);
  }

  function formatSize(bytes) {
    if (bytes < 1024) return Math.round(bytes) + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + 'K';
    if (bytes < 1024 * MiB) { const m = bytes / MiB; return (m < 10 ? m.toFixed(1) : String(Math.round(m))) + 'MB'; }
    return (bytes / (1024 * MiB)).toFixed(2) + 'GB';
  }

  function _fmtCal(v) { return String(Number(v.toPrecision(4))); }

  /** ImageJ's second line: '5735x5735 pixels; 8-bit; 94MB' (calibrated: '1.2x1.2 µm (512x512); ...'). */
  function formatSubtitle(info) {
    if (!info) return '';
    const channels = info.channels ? (Array.isArray(info.channels) ? info.channels.length : info.channels) : 1;
    const bytes = info.width * info.height * (info.bitDepth / 8) * channels;
    const cal = info.calibration;
    const dim = cal && cal.unit && cal.pixelWidth > 0 && cal.pixelHeight > 0
      ? `${_fmtCal(info.width * cal.pixelWidth)}×${_fmtCal(info.height * cal.pixelHeight)} ${cal.unit} (${info.width}×${info.height})`
      : `${info.width}×${info.height} pixels`;
    return `${dim}; ${info.bitDepth}-bit; ${formatSize(bytes)}`;
  }

  function _fmtValue(v, bitDepth) {
    if (v === null || v === undefined) return '';
    if (bitDepth === 32) return Number.isFinite(v) ? String(Number(Number(v).toPrecision(6))) : String(v);
    return String(Math.round(v));
  }

  /** 'x=123, y=45 (12.3, 4.5 µm), value=12,45,0' */
  function formatStatus({ x, y, calibration, values, bitDepth, labels = {} }) {
    let s = `${labels.x || 'x'}=${x}, ${labels.y || 'y'}=${y}`;
    if (calibration && calibration.unit && calibration.pixelWidth > 0 && (calibration.pixelWidth !== 1 || calibration.pixelHeight !== 1)) {
      s += ` (${_fmtCal(x * calibration.pixelWidth)}, ${_fmtCal(y * calibration.pixelHeight)} ${calibration.unit})`;
    }
    if (Array.isArray(values) && values.length) s += `, ${labels.value || 'value'}=${values.map((v) => _fmtValue(v, bitDepth)).join(',')}`;
    return s;
  }

  /** What the status bar shows while a selection is drawn. */
  function describeRoi(roi, calibration) {
    if (!roi) return '';
    const cal = calibration && calibration.unit && calibration.pixelWidth > 0 ? calibration : null;
    switch (roi.type) {
      case 'rect': case 'oval': case 'mask':
        return `x=${_f(roi.x)}, y=${_f(roi.y)}, w=${_f(roi.w)}, h=${_f(roi.h)}`;
      case 'line': {
        const dx = roi.x2 - roi.x1, dy = roi.y2 - roi.y1;
        const len = Math.hypot(dx * (cal ? cal.pixelWidth : 1), dy * (cal ? cal.pixelHeight : 1));
        let ang = (Math.atan2(-dy, dx) * 180) / Math.PI;
        if (ang < 0) ang += 360;
        return `angle=${_fmtCal(Math.round(ang * 100) / 100)}, length=${_fmtCal(len)}${cal ? ' ' + cal.unit : ''}`;
      }
      case 'polygon': case 'freehand': case 'point': {
        const b = roiBounds(roi);
        return `n=${(roi.points || []).length}` + (b ? `, x=${_f(b.x)}, y=${_f(b.y)}, w=${_f(b.w)}, h=${_f(b.h)}` : '');
      }
      default: return '';
    }
  }

  return {
    TILE, ZOOM_LADDER, MIN_ZOOM, MAX_ZOOM,
    nextZoom, snapZoomDown, clampZoom,
    levelDims, maxLevelFor, levelForZoom, tileGrid, tileTexels, tileImageRect,
    screenToImage, imageToScreen, zoomAround, clampPan, fitView, viewForRect,
    visibleTiles, parentTile, createLru, tileBudgetBytes, wheelSteps,
    shortcutFromEvent, normalizeShortcut, shortcutLabel,
    TOP_ORDER, buildMenuTree, menuKey, menuListAt, nextSelectable, firstSelectable, lastSelectable,
    parseNumber, formatNumber, collectFields, clampWindowPos,
    roiBounds, translateRoi, isAreaRoi, roiFromDrag, lineFromDrag, roiHandles, handleAt, hitRoi, moveHandle, handleCursor,
    formatZoomPct, formatSize, formatSubtitle, formatStatus, describeRoi
  };
})();

/* ============================================================
   IJDisplay — tiled WebGL2 renderer
   ============================================================ */
const IJDisplay = (() => {
  'use strict';
  const P = IJViewPure;
  const MiB = 1024 * 1024;
  const MAX_INFLIGHT = 6;
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
uniform vec2 uThr;
uniform vec4 uHole;
uniform int uHasHole;
in vec2 vImg;
out vec4 outColor;
void main() {
  if (uHasHole == 1 && vImg.x >= uHole.x && vImg.y >= uHole.y && vImg.x < uHole.z && vImg.y < uHole.w) discard;
  ivec2 tc = clamp(ivec2(floor((vImg - uSrcOrigin) / uSrcScale)), ivec2(0), uTexSize - ivec2(1));
  float v = FETCH(tc);
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
    'uMin', 'uMax', 'uInvert', 'uBits', 'uOverlay', 'uThr', 'uHole', 'uHasHole'];

  function err(code, message) { const e = new Error(message || code); e.code = code; return e; }

  /**
   * IJDisplay.create(host, options)
   *   options.onViewChange({ zoom, ox, oy, level, loading, width, height })
   *   options.onTileError(err)   a provider rejection (the tile is retried later)
   *   options.getLut(name) -> Uint8Array(768) | null   (default: IJLuts when present)
   *   options.background  [r,g,b] 0..1 around the image
   *   options.SVRManager  the platform budget source (default: the global when present)
   */
  function create(host, options = {}) {
    const opts = options || {};
    const doc = host.ownerDocument || document;
    const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
    const raf = (fn) => (win && win.requestAnimationFrame ? win.requestAnimationFrame(fn) : setTimeout(fn, 16));
    const caf = (id) => (win && win.cancelAnimationFrame ? win.cancelAnimationFrame(id) : clearTimeout(id));
    const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const background = opts.background || [0.17, 0.17, 0.19];

    const glCanvas = doc.createElement('canvas');
    glCanvas.className = 'ij-gl-canvas';
    const overlay = doc.createElement('canvas');
    overlay.className = 'ij-overlay-canvas';
    for (const c of [glCanvas, overlay]) {
      c.style.position = 'absolute'; c.style.left = '0'; c.style.top = '0';
      c.style.width = '100%'; c.style.height = '100%'; c.style.display = 'block';
    }
    overlay.style.pointerEvents = 'none';
    try {
      if (win && win.getComputedStyle && win.getComputedStyle(host).position === 'static') host.style.position = 'relative';
    } catch (e) { /* detached host */ }
    host.style.overflow = 'hidden';
    host.appendChild(glCanvas);
    host.appendChild(overlay);
    const octx = overlay.getContext('2d');

    const cleanups = [];
    const listen = (el, ev, fn, o) => { el.addEventListener(ev, fn, o); cleanups.push(() => el.removeEventListener(ev, fn, o)); };

    // ---- GL state ------------------------------------------------------
    let gl = null, lost = false, destroyed = false;
    let programs = null, vao = null, quadBuf = null, currentProg = null;
    const luts = new Map();
    const lutIds = new WeakMap();
    let lutCounter = 0;
    let rampLut = null;

    function buildProgram(isInt) {
      const compile = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
          const log = gl.getShaderInfoLog(sh);
          gl.deleteShader(sh);
          console.error('IJDisplay shader:', log);
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
        console.error('IJDisplay link:', gl.getProgramInfoLog(prog));
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

    // ---- LUTs -------------------------------------------------------------
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
      } catch (e) { console.error('IJDisplay LUT', e); }
      return ramp();
    }
    function lutTexture(spec) {
      let key;
      if (spec && typeof spec === 'object') {
        if (!lutIds.has(spec)) lutIds.set(spec, ++lutCounter);
        key = 'a:' + lutIds.get(spec);
      } else key = 'n:' + String(spec || 'Grays');
      let tex = luts.get(key);
      if (tex) return tex;
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGB8, 256, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGB, gl.UNSIGNED_BYTE, lutBytes(spec));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      luts.set(key, tex);
      return tex;
    }
    function dropLuts() {
      if (gl && !lost) for (const t of luts.values()) gl.deleteTexture(t);
      luts.clear();
    }

    // ---- Image / display state ------------------------------------------------
    let info = null, nCh = 0, maxLevel = 0;
    let dstate = { mode: 'composite', active: 0, channels: [], visible: [] };
    let provider = null;
    const tiles = new Map();          // key -> { tex, bytes, float, bits, w, h, c, level, tx, ty, stale }
    const lru = P.createLru();
    const inflight = new Map();       // key -> generation
    let wanted = [];
    const failedUntil = new Map();
    const failCount = new Map();
    let chGen = [];
    let thr = null;
    let preview = null;               // { level, x0, y0, w, h, bits, tex: {c: {tex,float,w,h}} }
    let rois = { active: null, all: [], showAll: false, handles: true };
    let draft = null;
    let view = { zoom: 1, ox: 0, oy: 0 };
    let size = { w: 0, h: 0, dpr: 1 };
    let fitMode = true;
    let pendingFit = false;
    let rafId = 0, needRender = false;
    let budgetCap = 256 * MiB;
    let lastLoading = false, lastNotified = '';
    let lastStats = { level: 0, fallback: false };
    const frameUsed = new Set();

    const keyOf = (c, L, tx, ty) => `${c}|${L}|${tx}|${ty}`;

    function budgetBytes() {
      let platformBudget = null, live = 0;
      const S = opts.SVRManager || (typeof SVRManager !== 'undefined' ? SVRManager : null);
      if (S && gl) {
        try {
          platformBudget = S.vramBudget({ getContext: () => gl });
          live = S.liveAtlasBytes();
        } catch (e) { platformBudget = null; }
      }
      return P.tileBudgetBytes({ cap: budgetCap, platformBudget, liveBytes: live });
    }

    function deleteTile(key) {
      const t = tiles.get(key);
      if (!t) return;
      tiles.delete(key);
      lru.remove(key);
      if (gl && !lost && t.tex) gl.deleteTexture(t.tex);
    }
    function dropAllTiles() {
      for (const key of Array.from(tiles.keys())) deleteTile(key);
      lru.clear();
      inflight.clear();
      failedUntil.clear();
      failCount.clear();
      wanted = [];
    }
    function dropPreview() {
      if (preview && gl && !lost) for (const p of Object.values(preview.tex)) gl.deleteTexture(p.tex);
      preview = null;
    }

    // ---- Textures ----------------------------------------------------------------
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

    function evictToBudget() {
      const budget = budgetBytes();
      for (const key of lru.evict(budget, frameUsed)) {
        const t = tiles.get(key);
        if (t) { tiles.delete(key); if (gl && !lost && t.tex) gl.deleteTexture(t.tex); }
      }
    }

    // ---- Tile requests -------------------------------------------------------------
    function want(c, L, tx, ty) {
      const key = keyOf(c, L, tx, ty);
      if (inflight.has(key)) return;
      const have = tiles.get(key);
      if (have && !have.stale) return;
      const until = failedUntil.get(key);
      if (until && until > nowMs()) return;
      if (wanted.some((w) => w.key === key)) return;
      wanted.push({ key, c, L, tx, ty });
    }

    function pump() {
      while (provider && inflight.size < MAX_INFLIGHT && wanted.length) {
        const w = wanted.shift();
        if (inflight.has(w.key)) continue;
        startLoad(w);
      }
    }

    /** Retry after 2 s, 4 s, 8 s, 16 s; then the tile stays empty until invalidated. */
    function markFailed(key) {
      const n = (failCount.get(key) || 0) + 1;
      failCount.set(key, n);
      failedUntil.set(key, n > 4 ? Infinity : nowMs() + 1000 * 2 ** n);
    }

    function startLoad({ key, c, L, tx, ty }) {
      const gen = chGen[c];
      inflight.set(key, gen);
      let p;
      try { p = Promise.resolve(provider(c, L, tx, ty)); } catch (e) { p = Promise.reject(e); }
      p.then((tile) => {
        if (inflight.get(key) === gen) inflight.delete(key);
        if (destroyed || lost || chGen[c] !== gen || !tile || !gl) { pump(); return; }
        try {
          const up = uploadTexture(tile.bitDepth, tile.width, tile.height, tile.data);
          const old = tiles.get(key);
          if (old && old.tex) gl.deleteTexture(old.tex);
          tiles.set(key, { tex: up.tex, bytes: up.bytes, float: up.float, bits: tile.bitDepth, w: tile.width, h: tile.height, c, level: L, tx, ty, stale: false });
          lru.add(key, up.bytes, L === maxLevel);
          evictToBudget();
        } catch (e) {
          markFailed(key);
          if (e && e.oom) { budgetCap = Math.max(32 * MiB, Math.floor(lru.total / 2)); evictToBudget(); }
          if (opts.onTileError) { try { opts.onTileError(e); } catch (x) { /* controller error */ } }
          else console.error('IJDisplay tile upload', e);
        }
        requestRender();
      }).catch((e) => {
        if (inflight.get(key) === gen) inflight.delete(key);
        markFailed(key);
        if (!destroyed) {
          if (opts.onTileError) { try { opts.onTileError(e); } catch (x) { /* controller error */ } }
          else console.error('IJDisplay tile', e);
          const n = failCount.get(key) || 1;
          if (n <= 4) setTimeout(() => { if (!destroyed) requestRender(); }, 1000 * 2 ** n + 100);
        }
        pump();
      });
    }

    // ---- Drawing ----------------------------------------------------------------------
    function bindProgram(entry) {
      if (currentProg !== entry) { gl.useProgram(entry.prog); currentProg = entry; }
    }

    function channelsToDraw() {
      if (!info) return [];
      if (dstate.mode === 'composite') {
        const out = [];
        for (let c = 0; c < nCh; c++) if (dstate.visible[c] !== false) out.push(c);
        return out;
      }
      return nCh ? [Math.min(nCh - 1, Math.max(0, dstate.active | 0))] : [];
    }

    function lutSpecFor(c) {
      if (dstate.mode === 'gray') return 'Grays';
      const d = dstate.channels[c] || {};
      return d.lut || 'Grays';
    }

    /** Draws one channel: for every tile of `level` in `list` the resident texture, else a
     *  coarser resident one (when `fallbackOk`), into `target` (device px). Returns
     *  { drawn, missing }. */
    function paintChannel(c, target, level, list, getTile, overlayMode, hole) {
      const d = dstate.channels[c] || {};
      const lutTex = lutTexture(lutSpecFor(c));
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, lutTex);
      let drawn = 0, missing = 0;
      for (const { tx, ty } of list) {
        const src = getTile(c, level, tx, ty);
        if (!src) { missing++; continue; }
        const rect = P.tileImageRect(level, tx, ty, info.width, info.height);
        drawTexture(src.float ? programs.float : programs.int, target, src, rect, d, overlayMode, hole, src.bits);
        drawn++;
      }
      return { drawn, missing };
    }

    /** src = { tex, w, h, float, bits, origin:[x,y], scale } */
    function drawTexture(entry, target, src, rect, d, overlayMode, hole, bits) {
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
      if (overlayMode && thr) gl.uniform2f(u.uThr, thr.lower, thr.upper);
      if (hole) { gl.uniform4f(u.uHole, hole.x0, hole.y0, hole.x1, hole.y1); gl.uniform1i(u.uHasHole, 1); }
      else gl.uniform1i(u.uHasHole, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    /** Interactive tile lookup: the tile itself (refreshed when stale) or the nearest
     *  coarser resident one; registers what is still needed. */
    function interactiveTile(c, L, tx, ty) {
      const key = keyOf(c, L, tx, ty);
      const t = tiles.get(key);
      if (t) {
        lru.touch(key); frameUsed.add(key);
        if (t.stale) want(c, L, tx, ty);
        return { tex: t.tex, w: t.w, h: t.h, float: t.float, bits: t.bits, origin: [tx * P.TILE * 2 ** L, ty * P.TILE * 2 ** L], scale: 2 ** L };
      }
      want(c, L, tx, ty);
      lastStats.fallback = true;
      for (let L2 = L + 1; L2 <= maxLevel; L2++) {
        const p = P.parentTile(L, tx, ty, L2);
        const k2 = keyOf(c, L2, p.tx, p.ty);
        const t2 = tiles.get(k2);
        if (t2) {
          lru.touch(k2); frameUsed.add(k2);
          return { tex: t2.tex, w: t2.w, h: t2.h, float: t2.float, bits: t2.bits, origin: [p.tx * P.TILE * 2 ** L2, p.ty * P.TILE * 2 ** L2], scale: 2 ** L2 };
        }
        want(c, L2, p.tx, p.ty);
      }
      return null;
    }

    function previewHole(c) {
      if (!preview || !preview.tex[c]) return null;
      const s = 2 ** preview.level;
      return { x0: preview.x0 * s, y0: preview.y0 * s, x1: Math.min(info.width, (preview.x0 + preview.w) * s), y1: Math.min(info.height, (preview.y0 + preview.h) * s) };
    }

    function paintPreview(c, target) {
      const hole = previewHole(c);
      if (!hole) return;
      const p = preview.tex[c];
      const d = dstate.channels[c] || {};
      const src = { tex: p.tex, w: p.w, h: p.h, float: p.float, bits: preview.bits, origin: [preview.x0 * 2 ** preview.level, preview.y0 * 2 ** preview.level], scale: 2 ** preview.level };
      drawTexture(p.float ? programs.float : programs.int, target, src, hole, d, 0, null, preview.bits);
    }

    function render() {
      rafId = 0;
      if (destroyed) return;
      needRender = false;
      if (!gl || lost) return;
      const dpr = size.dpr;
      const target = { zoom: view.zoom * dpr, ox: view.ox * dpr, oy: view.oy * dpr, w: glCanvas.width, h: glCanvas.height, flip: 1 };
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, glCanvas.width, glCanvas.height);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.BLEND);
      gl.clearColor(background[0], background[1], background[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      frameUsed.clear();
      wanted = [];
      lastStats = { level: 0, fallback: false };
      if (info && size.w > 0) {
        const L = P.levelForZoom(view.zoom, maxLevel);
        lastStats.level = L;
        // black image area (additive composition starts from black)
        const sx0 = Math.max(0, Math.floor(target.ox)), sy0 = Math.max(0, Math.floor(target.oy));
        const sx1 = Math.min(target.w, Math.ceil(target.ox + info.width * target.zoom));
        const sy1 = Math.min(target.h, Math.ceil(target.oy + info.height * target.zoom));
        if (sx1 > sx0 && sy1 > sy0) {
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(sx0, target.h - sy1, sx1 - sx0, sy1 - sy0);
          gl.clearColor(0, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.disable(gl.SCISSOR_TEST);
        }
        gl.bindVertexArray(vao);
        const list = P.visibleTiles(view, size.w, size.h, info.width, info.height, L);
        const chans = channelsToDraw();
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ONE);
        for (const c of chans) {
          want(c, maxLevel, 0, 0);
          paintChannel(c, target, L, list, interactiveTile, 0, previewHole(c));
          paintPreview(c, target);
        }
        if (thr && thr.channel < nCh) {
          gl.disable(gl.BLEND);
          paintChannel(thr.channel, target, L, list, interactiveTile, OVERLAY_MODES[thr.mode] || 1, null);
        }
        gl.disable(gl.BLEND);
        evictToBudget();
        pump();
      }
      drawOverlay();
      notify();
    }

    function requestRender() {
      if (destroyed) return;
      needRender = true;
      if (!rafId) rafId = raf(render);
    }

    function curLoading() { return !!info && (lastStats.fallback || inflight.size > 0 || wanted.length > 0); }

    function notify() {
      const loading = curLoading();
      const payload = { zoom: view.zoom, ox: view.ox, oy: view.oy, level: lastStats.level, loading, width: info ? info.width : 0, height: info ? info.height : 0 };
      const k = `${payload.zoom}|${payload.ox}|${payload.oy}|${payload.level}|${loading}|${payload.width}x${payload.height}`;
      if (k === lastNotified) return;
      lastNotified = k;
      lastLoading = loading;
      if (opts.onViewChange) { try { opts.onViewChange(payload); } catch (e) { console.error('IJDisplay onViewChange', e); } }
    }

    // ---- ROI overlay ----------------------------------------------------------------------
    function drawOverlay() {
      if (!octx) return;
      const dpr = size.dpr;
      octx.setTransform(1, 0, 0, 1, 0, 0);
      octx.clearRect(0, 0, overlay.width, overlay.height);
      if (!info) return;
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const z = view.zoom;
      const X = (x) => x * z + view.ox, Y = (y) => y * z + view.oy;

      const path = (roi) => {
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
          default: return false;
        }
      };
      const stroke = (color, width) => {
        octx.lineJoin = 'round';
        octx.lineWidth = width + 2; octx.strokeStyle = 'rgba(0,0,0,0.55)'; octx.stroke();
        octx.lineWidth = width; octx.strokeStyle = color; octx.stroke();
      };
      const drawRoi = (roi, color, label) => {
        if (!roi) return;
        if (roi.type === 'point') {
          for (const [x, y] of roi.points || []) {
            const sx = X(x), sy = Y(y);
            octx.beginPath(); octx.moveTo(sx - 5, sy); octx.lineTo(sx + 5, sy); octx.moveTo(sx, sy - 5); octx.lineTo(sx, sy + 5);
            stroke(color, 1);
            octx.beginPath(); octx.arc(sx, sy, 2.5, 0, Math.PI * 2); octx.fillStyle = color; octx.fill();
          }
        } else if (roi.type === 'mask') {
          const runs = roi.rle || [];
          if (runs.length && runs.length <= 20000 && roi.w > 0) {
            octx.fillStyle = 'rgba(255,255,0,0.28)';
            let pos = 0, on = false;
            for (const run of runs) {
              if (on) {
                let p = pos, rem = run;
                while (rem > 0) {
                  const row = Math.floor(p / roi.w), col = p % roi.w, len = Math.min(rem, roi.w - col);
                  octx.fillRect(X(roi.x + col), Y(roi.y + row), len * z, z);
                  p += len; rem -= len;
                }
              }
              pos += run; on = !on;
            }
          }
          octx.beginPath(); octx.setLineDash([4, 3]); octx.rect(X(roi.x), Y(roi.y), roi.w * z, roi.h * z); stroke(color, 1); octx.setLineDash([]);
        } else {
          if (roi.type === 'line' && roi.width > 1) {
            octx.beginPath(); octx.moveTo(X(roi.x1), Y(roi.y1)); octx.lineTo(X(roi.x2), Y(roi.y2));
            octx.lineCap = 'butt'; octx.lineWidth = roi.width * z; octx.strokeStyle = 'rgba(255,255,0,0.25)'; octx.stroke();
          }
          path(roi);
          stroke(color, 1.25);
        }
        if (label) {
          const b = P.roiBounds(roi);
          if (b) {
            octx.font = '11px sans-serif'; octx.textBaseline = 'top'; octx.fillStyle = 'rgba(0,0,0,0.6)';
            octx.fillText(label, X(b.x) + 3, Y(b.y) + 3);
            octx.fillStyle = color; octx.fillText(label, X(b.x) + 2, Y(b.y) + 2);
          }
        }
      };

      if (rois.showAll) {
        rois.all.forEach((it, i) => {
          const roi = it && it.roi ? it.roi : it;
          drawRoi(roi, '#00ffff', String(it && it.label != null ? it.label : i + 1));
        });
      }
      if (rois.active) {
        drawRoi(rois.active, '#ffff00', null);
        if (rois.handles) {
          for (const h of P.roiHandles(rois.active)) {
            const sx = X(h.x), sy = Y(h.y);
            octx.fillStyle = '#ffffff'; octx.strokeStyle = '#000000'; octx.lineWidth = 1;
            octx.fillRect(sx - 3, sy - 3, 6, 6); octx.strokeRect(sx - 3.5, sy - 3.5, 7, 7);
          }
        }
      }
      if (draft) {
        const pts = draft.points || [];
        octx.beginPath();
        pts.forEach(([x, y], i) => (i ? octx.lineTo(X(x), Y(y)) : octx.moveTo(X(x), Y(y))));
        if (draft.rubber && pts.length) octx.lineTo(X(draft.rubber[0]), Y(draft.rubber[1]));
        stroke('#ffff00', 1.25);
        for (const [x, y] of pts) {
          octx.fillStyle = '#ffffff'; octx.fillRect(X(x) - 2.5, Y(y) - 2.5, 5, 5);
        }
      }
    }

    // ---- Size / view ----------------------------------------------------------------------
    function measure() {
      const dpr = Math.max(1, Math.min(3, (win && win.devicePixelRatio) || 1));
      const w = Math.max(0, Math.round(host.clientWidth || 0)), h = Math.max(0, Math.round(host.clientHeight || 0));
      return { w, h, dpr };
    }

    function applySize() {
      const m = measure();
      if (m.w === size.w && m.h === size.h && m.dpr === size.dpr) return;
      const prev = size;
      size = m;
      const pw = Math.max(1, Math.round(m.w * m.dpr)), ph = Math.max(1, Math.round(m.h * m.dpr));
      glCanvas.width = pw; glCanvas.height = ph;
      overlay.width = pw; overlay.height = ph;
      if (info && m.w > 0 && m.h > 0) {
        if (pendingFit || fitMode || prev.w === 0) { doFit(); pendingFit = false; }
        else {
          view = P.clampPan({ zoom: view.zoom, ox: view.ox + (m.w - prev.w) / 2, oy: view.oy + (m.h - prev.h) / 2 }, m.w, m.h, info.width, info.height);
        }
      }
      requestRender();
    }

    function doFit(snap = false) {
      if (!info || size.w <= 0 || size.h <= 0) { pendingFit = true; return; }
      view = P.fitView(size.w, size.h, info.width, info.height, { snap });
      fitMode = true;
    }

    function setView(v, user = true) {
      if (!info) return;
      view = P.clampPan({ zoom: P.clampZoom(v.zoom), ox: v.ox, oy: v.oy }, size.w, size.h, info.width, info.height);
      if (user) fitMode = false;
      requestRender();
    }

    // ---- Public API --------------------------------------------------------------------------
    function setImage(imgInfo) {
      dropAllTiles();
      dropPreview();
      thr = null; draft = null; rois = { active: null, all: [], showAll: false, handles: true };
      info = imgInfo ? { docId: imgInfo.docId, width: imgInfo.width, height: imgInfo.height, bitDepth: imgInfo.bitDepth, calibration: imgInfo.calibration || null } : null;
      nCh = imgInfo && imgInfo.channels ? imgInfo.channels.length : 0;
      chGen = new Array(nCh).fill(0).map(() => ++lutCounter);
      if (info) {
        maxLevel = P.maxLevelFor(info.width, info.height);
        const chs = imgInfo.channels.map((ch) => ({ ...(ch.display || {}), min: ch.display ? ch.display.min : 0, max: ch.display ? ch.display.max : (info.bitDepth === 8 ? 255 : 65535) }));
        const disp = imgInfo.display || {};
        dstate = { mode: disp.mode || 'composite', active: disp.active || 0, channels: chs, visible: disp.visible ? disp.visible.slice() : chs.map(() => true) };
        fitMode = true;
        doFit();
      } else {
        dstate = { mode: 'composite', active: 0, channels: [], visible: [] };
      }
      requestRender();
    }

    function setTileProvider(fn) { provider = typeof fn === 'function' ? fn : null; wanted = []; requestRender(); }

    /** Drops what is shown for `channels` (all when omitted): resident tiles keep drawing
     *  until the fresh ones arrive (no flash). */
    function invalidate(channels) {
      const list = Array.isArray(channels) ? channels : Array.from({ length: nCh }, (_, i) => i);
      for (const c of list) {
        if (c < 0 || c >= nCh) continue;
        chGen[c] = ++lutCounter;
        for (const [key, t] of tiles) if (t.c === c) t.stale = true;
        for (const key of Array.from(inflight.keys())) if (key.startsWith(c + '|')) inflight.delete(key);
        for (const key of Array.from(failedUntil.keys())) if (key.startsWith(c + '|')) { failedUntil.delete(key); failCount.delete(key); }
      }
      requestRender();
    }

    /** state: { mode, active, visible:[bool], channels:[{min,max,lut,invert}] } or one channel
     *  { channel, min?, max?, lut?, invert? }; uniforms only, one draw. */
    function setDisplay(state) {
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
      requestRender();
    }

    function setThresholdOverlay(t) {
      thr = t && Number.isInteger(t.channel) ? { channel: t.channel, lower: t.lower, upper: t.upper, mode: t.mode || 'red' } : null;
      requestRender();
    }

    /** region = { level, x0, y0, w, h, bitDepth, channels: { [c]: typed array } } in level
     *  pixels, or null. The pixels replace the displayed ones inside the region. */
    function setPreview(region) {
      dropPreview();
      if (region && gl && !lost && info) {
        const tex = {};
        try {
          for (const [k, data] of Object.entries(region.channels || {})) {
            const up = uploadTexture(region.bitDepth, region.w, region.h, data);
            tex[k] = { tex: up.tex, float: up.float, w: region.w, h: region.h };
          }
          preview = { level: region.level | 0, x0: region.x0, y0: region.y0, w: region.w, h: region.h, bits: region.bitDepth, tex };
        } catch (e) {
          for (const p of Object.values(tex)) gl.deleteTexture(p.tex);
          console.error('IJDisplay preview', e);
        }
      }
      requestRender();
    }

    /** rois = { active, all: [roi | { roi, label }], showAll, handles } (any key optional) */
    function setRois(r) {
      rois = { ...rois, ...(r || {}) };
      if (!Array.isArray(rois.all)) rois.all = [];
      requestRender();
    }
    /** An unfinished polygon: { points, rubber:[x,y] } or null. */
    function setDraft(d) { draft = d || null; requestRender(); }

    function zoomAt(sx, sy, dir) {
      if (!info) return;
      const nz = P.nextZoom(view.zoom, dir);
      if (nz === view.zoom) return;
      setView(P.zoomAround(view, sx, sy, nz));
    }
    function setZoom(z, sx = size.w / 2, sy = size.h / 2) { if (info) setView(P.zoomAround(view, sx, sy, P.clampZoom(z))); }
    function fit() { if (!info) return; doFit(); view = P.clampPan(view, size.w, size.h, info.width, info.height); requestRender(); }
    function view100() { setZoom(1); }
    function zoomToRect(rect) { if (info && rect && size.w > 0) setView(P.viewForRect(rect, size.w, size.h)); }
    function pan(dx, dy) { if (info) setView({ zoom: view.zoom, ox: view.ox + dx, oy: view.oy + dy }); }
    function setCursor(c) { host.style.cursor = c || ''; }

    function destroyGL() {
      if (!gl) return;
      if (!lost) {
        for (const t of tiles.values()) if (t.tex) gl.deleteTexture(t.tex);
        for (const t of luts.values()) gl.deleteTexture(t);
        if (preview) for (const p of Object.values(preview.tex)) gl.deleteTexture(p.tex);
        if (programs) { gl.deleteProgram(programs.int.prog); gl.deleteProgram(programs.float.prog); }
        if (quadBuf) gl.deleteBuffer(quadBuf);
        if (vao) gl.deleteVertexArray(vao);
      }
      tiles.clear(); luts.clear(); lru.clear(); preview = null;
      programs = null; quadBuf = null; vao = null;
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (rafId) caf(rafId);
      for (const fn of cleanups.splice(0)) fn();
      if (resizeObserver) resizeObserver.disconnect();
      destroyGL();
      inflight.clear(); wanted = []; failedUntil.clear(); provider = null;
      try {
        const ext = gl && !lost ? gl.getExtension('WEBGL_lose_context') : null;
        if (ext) ext.loseContext();
      } catch (e) { /* already gone */ }
      gl = null;
      if (glCanvas.parentNode) glCanvas.parentNode.removeChild(glCanvas);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    // ---- Export ---------------------------------------------------------------------------------
    /**
     * The image rendered at `scale` (output px per image px) into a 2D canvas, LUTs applied,
     * in offscreen tiles of <= 4096 px. Tiles come from the resident cache or the provider.
     * Rejects with IJ_NO_IMAGE | IJ_EXPORT_TOO_LARGE | IJ_CANCELLED | IJ_CONTEXT_LOST.
     */
    async function renderToCanvas({ scale = 1, signal = null, onProgress = null } = {}) {
      if (!info || !gl || lost) throw err('IJ_NO_IMAGE');
      const W = Math.max(1, Math.round(info.width * scale)), H = Math.max(1, Math.round(info.height * scale));
      if (W > 32767 || H > 32767 || W * H > 268435456) throw err('IJ_EXPORT_TOO_LARGE');
      if (!provider) throw err('IJ_NO_PROVIDER');
      const out = doc.createElement('canvas');
      out.width = W; out.height = H;
      const o2 = out.getContext('2d');
      const L = P.levelForZoom(scale, maxLevel);
      const chans = channelsToDraw();
      const TW = Math.min(W, 4096), TH = Math.min(H, 4096);
      const nTilesX = Math.ceil(W / 4096), nTilesY = Math.ceil(H / 4096);
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
        requestRender();
      };
      try {
        for (let oy = 0; oy < H; oy += 4096) {
          for (let ox = 0; ox < W; ox += 4096) {
            if (signal && signal.aborted) throw err('IJ_CANCELLED');
            const tw = Math.min(4096, W - ox), th = Math.min(4096, H - oy);
            const v = { zoom: scale, ox: -ox, oy: -oy };
            const list = P.visibleTiles(v, tw, th, info.width, info.height, L);
            // gather the source tiles (resident or fetched), channel by channel
            const have = new Map();
            for (const c of chans) {
              for (const { tx, ty } of list) {
                const key = keyOf(c, L, tx, ty);
                const res = tiles.get(key);
                if (res && !res.stale) { have.set(key, { tex: res.tex, w: res.w, h: res.h, float: res.float, bits: res.bits, origin: [tx * P.TILE * 2 ** L, ty * P.TILE * 2 ** L], scale: 2 ** L }); continue; }
                const tile = await provider(c, L, tx, ty);
                if (destroyed || lost || !gl) throw err('IJ_CONTEXT_LOST');
                if (signal && signal.aborted) throw err('IJ_CANCELLED');
                const up = uploadTexture(tile.bitDepth, tile.width, tile.height, tile.data);
                temps.push(up.tex);
                have.set(key, { tex: up.tex, w: tile.width, h: tile.height, float: up.float, bits: tile.bitDepth, origin: [tx * P.TILE * 2 ** L, ty * P.TILE * 2 ** L], scale: 2 ** L });
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
            for (const c of chans) paintChannel(c, target, L, list, (cc, LL, tx, ty) => have.get(keyOf(cc, LL, tx, ty)) || null, 0, null);
            gl.disable(gl.BLEND);
            gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            const img = o2.createImageData(tw, th);
            // readPixels packs the tw x th region tightly (PACK_ROW_LENGTH 0)
            img.data.set(pixels.subarray(0, tw * th * 4));
            for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
            o2.putImageData(img, ox, oy);
            for (const t of temps.splice(0)) gl.deleteTexture(t);
            doneTiles++;
            if (onProgress) onProgress(doneTiles / (nTilesX * nTilesY));
          }
        }
      } finally {
        cleanup();
      }
      return out;
    }

    // ---- Lifecycle ------------------------------------------------------------------------------
    listen(glCanvas, 'webglcontextlost', (e) => {
      e.preventDefault();
      lost = true;
      tiles.clear(); lru.clear(); luts.clear(); preview = null; inflight.clear(); wanted = [];
      for (let c = 0; c < nCh; c++) chGen[c] = ++lutCounter;
    });
    listen(glCanvas, 'webglcontextrestored', () => {
      try {
        lost = false;
        initGL();
        requestRender();
      } catch (e) { console.error('IJDisplay restore', e); }
    });

    let resizeObserver = null;
    initGL();
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => applySize());
      resizeObserver.observe(host);
    } else if (win) listen(win, 'resize', applySize);
    applySize();

    return {
      element: host, glCanvas, overlayCanvas: overlay,
      setImage, setTileProvider, invalidate, setDisplay, setThresholdOverlay, setPreview, setRois, setDraft,
      zoomAt, setZoom, fit, view100, zoomToRect, pan, setCursor,
      screenToImage: (x, y) => P.screenToImage(view, x, y),
      imageToScreen: (x, y) => P.imageToScreen(view, x, y),
      getView: () => ({ ...view, level: lastStats.level, maxLevel, width: info ? info.width : 0, height: info ? info.height : 0, viewportWidth: size.w, viewportHeight: size.h }),
      getStats: () => ({ residentTiles: tiles.size, residentBytes: lru.total, budgetBytes: budgetBytes(), level: lastStats.level, loading: curLoading(), inflight: inflight.size }),
      resize: applySize, redraw: requestRender, renderNow: render,
      renderToCanvas, destroy
    };
  }

  return { create, OVERLAY_MODES };
})();

/* ============================================================
   IJWindows — dialogs, floating windows, confirm
   ============================================================ */
const IJWindows = (() => {
  'use strict';
  const P = IJViewPure;
  let uid = 0;

  const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function storageGet(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } }
  function storageSet(key, v) { try { window.localStorage.setItem(key, v); } catch (e) { /* private mode */ } }

  /**
   * IJWindows.create({ root, t, Dialog }) -> { dialog, floating, confirm, hasModal, closeAll, destroy }
   * The module itself also exposes dialog / floating / confirm on a default instance
   * configured with IJWindows.configure({ root, t }).
   */
  function create(config = {}) {
    let root = config.root || null;
    const t = (key, fb) => {
      try { const v = config.t ? config.t(key, fb) : fb; return typeof v === 'string' && v && v !== key ? v : fb; } catch (e) { return fb; }
    };
    const doc = () => (root && root.ownerDocument) || document;
    const floatingMap = new Map();
    const modalStack = [];
    let zTop = 20;
    let cascade = 0;
    let destroyed = false;

    function rootBox() {
      const r = root || doc().body;
      const view = doc().defaultView || {};
      return { w: r.clientWidth || view.innerWidth || 800, h: r.clientHeight || view.innerHeight || 600 };
    }
    function mountPoint() { return root || doc().body; }

    function makeDraggable(el, handle, onEnd) {
      let drag = null;
      const down = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        if (e.target && e.target.closest && e.target.closest('button, input, select')) return;
        const rb = mountPoint().getBoundingClientRect();
        drag = { dx: e.clientX - (el.offsetLeft + rb.left), dy: e.clientY - (el.offsetTop + rb.top), rb };
        el.classList.add('is-dragging');
        try { handle.setPointerCapture(e.pointerId); } catch (x) { /* synthetic event */ }
        e.preventDefault();
      };
      const move = (e) => {
        if (!drag) return;
        const box = rootBox();
        const p = P.clampWindowPos(e.clientX - drag.rb.left - drag.dx, e.clientY - drag.rb.top - drag.dy, el.offsetWidth, el.offsetHeight, box.w, box.h);
        el.style.left = Math.round(p.x) + 'px';
        el.style.top = Math.round(p.y) + 'px';
      };
      const up = (e) => {
        if (!drag) return;
        drag = null;
        el.classList.remove('is-dragging');
        try { handle.releasePointerCapture(e.pointerId); } catch (x) { /* none */ }
        if (onEnd) onEnd({ x: el.offsetLeft, y: el.offsetTop });
      };
      handle.addEventListener('pointerdown', down);
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
      return () => {
        handle.removeEventListener('pointerdown', down);
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
      };
    }

    function newBackdrop() {
      const b = doc().createElement('div');
      b.className = 'ij-dialog-backdrop';
      b.style.position = 'absolute'; b.style.left = '0'; b.style.top = '0'; b.style.right = '0'; b.style.bottom = '0'; b.style.zIndex = '80';
      return b;
    }

    function button(label, cls, onClick) {
      const b = doc().createElement('button');
      b.type = 'button';
      b.className = 'ij-btn' + (cls ? ' ' + cls : '');
      b.textContent = label;
      b.addEventListener('click', onClick);
      return b;
    }

    function trapTab(container, e) {
      const items = Array.from(container.querySelectorAll(FOCUSABLE)).filter((n) => !n.hidden && !n.closest('[hidden]'));
      if (!items.length) { e.preventDefault(); container.focus(); return; }
      const first = items[0], last = items[items.length - 1], active = doc().activeElement;
      if (e.shiftKey && (active === first || !container.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !container.contains(active))) { e.preventDefault(); first.focus(); }
    }

    // ---- GenericDialog ----------------------------------------------------------------------
    /**
     * dialog({ title | titleKey, fields, preview?: { onChange(values|null) }, okLabel, cancelLabel })
     * field = { type:'number'|'choice'|'check'|'slider'|'string'|'message', id, label | labelKey,
     *   value, min, max, step, integer, decimals, units, options:[value | {value,label}] }
     * -> Promise<values | null>. preview.onChange gets the values (valid, debounced) while
     * the Preview box is ticked and null when it is unticked / the dialog closes.
     */
    function dialog(spec = {}) {
      if (destroyed) return Promise.resolve(null);
      const d = doc();
      const fields = spec.fields || [];
      const title = spec.titleKey ? t(spec.titleKey, spec.title || spec.titleKey) : (spec.title || '');
      const id = 'ij-dlg-' + (++uid);
      const previous = d.activeElement;

      const backdrop = newBackdrop();
      const box = d.createElement('div');
      box.className = 'ij-dialog';
      box.style.position = 'absolute';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-labelledby', id + '-title');
      box.tabIndex = -1;
      const head = d.createElement('div');
      head.className = 'ij-dialog-title';
      head.id = id + '-title';
      head.textContent = title;
      const body = d.createElement('div');
      body.className = 'ij-dialog-body';

      const controls = {};
      const fieldEls = {};
      fields.forEach((f, i) => {
        const fid = `${id}-f${i}`;
        const row = d.createElement('div');
        row.className = 'ij-field ij-field--' + f.type;
        if (f.type === 'message') {
          const p = d.createElement('p');
          p.className = 'ij-dialog-message';
          p.textContent = f.labelKey ? t(f.labelKey, f.label || '') : (f.label || f.value || '');
          row.appendChild(p);
          body.appendChild(row);
          return;
        }
        const labelText = f.labelKey ? t(f.labelKey, f.label || f.labelKey) : (f.label || '');
        const label = d.createElement('label');
        label.className = 'ij-field-label';
        label.htmlFor = fid;
        label.textContent = labelText;
        const wrap = d.createElement('span');
        wrap.className = 'ij-field-control';
        let ctrl;
        if (f.type === 'number' || f.type === 'string') {
          ctrl = d.createElement('input');
          ctrl.type = 'text';
          if (f.type === 'number') ctrl.inputMode = 'decimal';
          ctrl.value = f.type === 'number' ? P.formatNumber(Number(f.value), f.decimals) : String(f.value ?? '');
          ctrl.autocomplete = 'off';
          if (f.type === 'number') {
            ctrl.addEventListener('keydown', (e) => {
              if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
              const p = P.parseNumber(ctrl.value, {});
              if (!p.ok) return;
              const step = (f.step || (f.integer ? 1 : 0.1)) * (e.key === 'ArrowUp' ? 1 : -1);
              let v = p.value + step;
              if (Number.isFinite(f.min)) v = Math.max(f.min, v);
              if (Number.isFinite(f.max)) v = Math.min(f.max, v);
              ctrl.value = P.formatNumber(Math.round(v * 1e9) / 1e9, f.decimals);
              e.preventDefault();
              ctrl.dispatchEvent(new Event('input', { bubbles: true }));
            });
          }
        } else if (f.type === 'slider') {
          ctrl = d.createElement('input');
          ctrl.type = 'range';
          ctrl.min = String(f.min ?? 0); ctrl.max = String(f.max ?? 100); ctrl.step = String(f.step ?? 1);
          ctrl.value = String(f.value ?? f.min ?? 0);
        } else if (f.type === 'choice') {
          ctrl = d.createElement('select');
          for (const o of f.options || []) {
            const opt = d.createElement('option');
            const value = typeof o === 'object' ? o.value : o;
            opt.value = String(value);
            opt.textContent = typeof o === 'object' ? (o.labelKey ? t(o.labelKey, o.label || String(value)) : (o.label ?? String(value))) : String(o);
            ctrl.appendChild(opt);
          }
          ctrl.value = String(f.value ?? '');
        } else if (f.type === 'check') {
          ctrl = d.createElement('input');
          ctrl.type = 'checkbox';
          ctrl.checked = !!f.value;
        } else {
          return;
        }
        ctrl.id = fid;
        ctrl.name = f.id;
        controls[f.id] = ctrl;
        fieldEls[f.id] = row;
        wrap.appendChild(ctrl);
        if (f.type === 'slider') {
          const out = d.createElement('output');
          out.className = 'ij-field-value';
          out.htmlFor = fid;
          out.textContent = ctrl.value;
          ctrl.addEventListener('input', () => { out.textContent = ctrl.value; });
          wrap.appendChild(out);
        }
        if (f.units) {
          const u = d.createElement('span');
          u.className = 'ij-field-units';
          u.textContent = f.unitsKey ? t(f.unitsKey, f.units) : f.units;
          wrap.appendChild(u);
        }
        if (f.type === 'check') { row.appendChild(wrap); row.appendChild(label); }
        else { row.appendChild(label); row.appendChild(wrap); }
        body.appendChild(row);
      });

      let previewBox = null;
      if (spec.preview && typeof spec.preview.onChange === 'function') {
        const row = d.createElement('div');
        row.className = 'ij-field ij-field--check ij-field--preview';
        const pid = id + '-preview';
        previewBox = d.createElement('input');
        previewBox.type = 'checkbox'; previewBox.id = pid;
        const lab = d.createElement('label');
        lab.className = 'ij-field-label'; lab.htmlFor = pid; lab.textContent = t('view.preview', 'Preview');
        const wrap = d.createElement('span'); wrap.className = 'ij-field-control'; wrap.appendChild(previewBox);
        row.appendChild(wrap); row.appendChild(lab);
        body.appendChild(row);
      }

      const buttons = d.createElement('div');
      buttons.className = 'ij-dialog-buttons';
      const okBtn = button(spec.okLabel || t('view.ok', 'OK'), 'ij-btn--primary', () => commit());
      const cancelBtn = button(spec.cancelLabel || t('view.cancel', 'Cancel'), '', () => finish(null));
      buttons.appendChild(cancelBtn);
      buttons.appendChild(okBtn);

      box.appendChild(head); box.appendChild(body); box.appendChild(buttons);
      backdrop.appendChild(box);

      const readRaw = () => {
        const raw = {};
        for (const f of fields) {
          const c = controls[f.id];
          if (!c) continue;
          raw[f.id] = f.type === 'check' ? c.checked : c.value;
        }
        return raw;
      };
      const validate = () => {
        const r = P.collectFields(fields, readRaw());
        for (const f of fields) {
          const c = controls[f.id];
          if (!c) continue;
          const bad = !!r.errors[f.id];
          c.classList.toggle('ij-invalid', bad);
          if (bad) { c.setAttribute('aria-invalid', 'true'); c.title = t('view.invalid.' + r.errors[f.id], r.errors[f.id]); }
          else { c.removeAttribute('aria-invalid'); c.removeAttribute('title'); }
        }
        return r;
      };

      let previewTimer = 0, closed = false, resolveFn;
      const firePreview = () => {
        if (!previewBox || !previewBox.checked) return;
        const r = P.collectFields(fields, readRaw());
        if (r.ok) spec.preview.onChange(r.values);
      };
      const schedulePreview = () => {
        if (!previewBox) return;
        clearTimeout(previewTimer);
        previewTimer = setTimeout(firePreview, 100);
      };
      const onInput = () => { validate(); schedulePreview(); };
      body.addEventListener('input', onInput);
      body.addEventListener('change', onInput);
      if (previewBox) {
        previewBox.addEventListener('change', () => {
          if (previewBox.checked) firePreview();
          else spec.preview.onChange(null);
        });
      }

      function commit() {
        const r = validate();
        if (!r.ok) {
          const firstBad = fields.find((f) => r.errors[f.id]);
          if (firstBad && controls[firstBad.id]) controls[firstBad.id].focus();
          return;
        }
        finish(r.values);
      }

      function finish(values) {
        if (closed) return;
        closed = true;
        clearTimeout(previewTimer);
        d.removeEventListener('keydown', onKey, true);
        const idx = modalStack.indexOf(handle);
        if (idx >= 0) modalStack.splice(idx, 1);
        cleanupDrag();
        if (previewBox && spec.preview) { try { spec.preview.onChange(null); } catch (e) { console.error('IJWindows preview', e); } }
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        if (previous && previous.focus && d.contains(previous)) { try { previous.focus(); } catch (e) { /* gone */ } }
        resolveFn(values);
      }

      function onKey(e) {
        if (modalStack[modalStack.length - 1] !== handle) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); return; }
        if (e.key === 'Tab') { e.stopPropagation(); trapTab(box, e); return; }
        if (e.key === 'Enter') {
          const tgt = e.target;
          if (tgt && tgt.tagName === 'BUTTON') return; // a focused button keeps its own Enter
          if (tgt && tgt.tagName === 'TEXTAREA') return;
          e.preventDefault(); e.stopPropagation(); commit();
          return;
        }
        // keys typed in the dialog never reach the image shortcuts
        e.stopPropagation();
      }

      const handle = { close: () => finish(null) };
      modalStack.push(handle);
      mountPoint().appendChild(backdrop);
      const rb = rootBox();
      box.style.left = Math.max(8, Math.round((rb.w - box.offsetWidth) / 2)) + 'px';
      box.style.top = Math.max(8, Math.round(rb.h * 0.12)) + 'px';
      const cleanupDrag = makeDraggable(box, head, null);
      d.addEventListener('keydown', onKey, true);
      const firstCtrl = fields.map((f) => controls[f.id]).find(Boolean);
      (firstCtrl || okBtn).focus();
      if (firstCtrl && firstCtrl.select && firstCtrl.type === 'text') firstCtrl.select();
      return new Promise((resolve) => { resolveFn = resolve; });
    }

    // ---- Confirm ---------------------------------------------------------------------------------
    /** confirm({ title, message, options:[{id,label,variant}], dismissId }) -> Promise<id|null> */
    function confirm(spec = {}) {
      if (typeof Dialog !== 'undefined' && Dialog && typeof Dialog.ask === 'function') return Dialog.ask(spec);
      const d = doc();
      const options = (spec.options || []).filter((o) => o && o.id);
      if (!options.length) return Promise.resolve(null);
      return new Promise((resolve) => {
        const previous = d.activeElement;
        const backdrop = newBackdrop();
        const box = d.createElement('div');
        box.className = 'ij-dialog';
        box.style.position = 'absolute';
        box.setAttribute('role', 'alertdialog');
        box.setAttribute('aria-modal', 'true');
        box.tabIndex = -1;
        const head = d.createElement('div'); head.className = 'ij-dialog-title'; head.textContent = spec.title || '';
        const body = d.createElement('div'); body.className = 'ij-dialog-body';
        const p = d.createElement('p'); p.className = 'ij-dialog-message'; p.textContent = spec.message || ''; body.appendChild(p);
        const btns = d.createElement('div'); btns.className = 'ij-dialog-buttons';
        const handle = { close: () => done(spec.dismissId ?? null) };
        let finished = false;
        const done = (id) => {
          if (finished) return;
          finished = true;
          d.removeEventListener('keydown', onKey, true);
          const i = modalStack.indexOf(handle); if (i >= 0) modalStack.splice(i, 1);
          if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
          if (previous && previous.focus) { try { previous.focus(); } catch (e) { /* gone */ } }
          resolve(id);
        };
        const onKey = (e) => {
          if (modalStack[modalStack.length - 1] !== handle) return;
          if (e.key === 'Escape' && spec.dismissId !== undefined) { e.preventDefault(); e.stopPropagation(); done(spec.dismissId); }
          else if (e.key === 'Tab') { e.stopPropagation(); trapTab(box, e); }
          else e.stopPropagation();
        };
        options.forEach((o, i) => btns.appendChild(button(o.label, i === 0 ? 'ij-btn--primary' : (o.variant === 'danger' ? 'ij-btn--danger' : ''), () => done(o.id))));
        box.appendChild(head); box.appendChild(body); box.appendChild(btns); backdrop.appendChild(box);
        modalStack.push(handle);
        mountPoint().appendChild(backdrop);
        const rb = rootBox();
        box.style.left = Math.max(8, Math.round((rb.w - box.offsetWidth) / 2)) + 'px';
        box.style.top = Math.max(8, Math.round(rb.h * 0.2)) + 'px';
        d.addEventListener('keydown', onKey, true);
        btns.querySelector('button').focus();
      });
    }

    // ---- Floating windows -------------------------------------------------------------------------
    /**
     * floating({ id, title | titleKey, content: HTMLElement, onClose, x?, y?, width? })
     * -> { id, el, setTitle(s), focus(), close(), move(x, y), isOpen() }.
     * Opening an id that is already open raises it. Its position is remembered in
     * localStorage 'lumen3d.ij.win.<id>'.
     */
    function floating(spec = {}) {
      const existing = floatingMap.get(spec.id);
      if (existing) { existing.focus(); return existing; }
      const d = doc();
      const el = d.createElement('div');
      el.className = 'ij-window';
      el.setAttribute('role', 'dialog');
      el.dataset.windowId = spec.id;
      el.tabIndex = -1;
      const bar = d.createElement('div');
      bar.className = 'ij-window-title';
      const titleEl = d.createElement('span');
      titleEl.textContent = spec.titleKey ? t(spec.titleKey, spec.title || spec.titleKey) : (spec.title || '');
      const closeBtn = d.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'ij-window-close';
      closeBtn.setAttribute('aria-label', t('view.close', 'Close'));
      closeBtn.textContent = '×';
      bar.appendChild(titleEl); bar.appendChild(closeBtn);
      const content = d.createElement('div');
      content.className = 'ij-window-content';
      if (spec.content) content.appendChild(spec.content);
      el.appendChild(bar); el.appendChild(content);
      if (spec.width) el.style.width = spec.width + 'px';
      el.style.position = 'absolute';
      mountPoint().appendChild(el);

      let pos = null;
      const saved = storageGet('lumen3d.ij.win.' + spec.id);
      if (saved) { try { const o = JSON.parse(saved); if (Number.isFinite(o.x) && Number.isFinite(o.y)) pos = o; } catch (e) { /* ignore */ } }
      if (!pos) {
        pos = Number.isFinite(spec.x) && Number.isFinite(spec.y) ? { x: spec.x, y: spec.y } : { x: 48 + (cascade % 8) * 28, y: 72 + (cascade % 8) * 28 };
        cascade++;
      }
      const box = rootBox();
      const cp = P.clampWindowPos(pos.x, pos.y, el.offsetWidth, el.offsetHeight, box.w, box.h);
      el.style.left = Math.round(cp.x) + 'px';
      el.style.top = Math.round(cp.y) + 'px';
      el.style.zIndex = String(++zTop);

      const cleanupDrag = makeDraggable(el, bar, (p) => storageSet('lumen3d.ij.win.' + spec.id, JSON.stringify(p)));
      const raise = () => { el.style.zIndex = String(++zTop); };
      el.addEventListener('pointerdown', raise);
      let open = true;
      const win = {
        id: spec.id, el, content,
        setTitle(s) { titleEl.textContent = s; },
        focus() { raise(); try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ } },
        move(x, y) {
          const b = rootBox();
          const p = P.clampWindowPos(x, y, el.offsetWidth, el.offsetHeight, b.w, b.h);
          el.style.left = Math.round(p.x) + 'px'; el.style.top = Math.round(p.y) + 'px';
        },
        isOpen: () => open,
        close() {
          if (!open) return;
          open = false;
          floatingMap.delete(spec.id);
          cleanupDrag();
          el.removeEventListener('pointerdown', raise);
          closeBtn.removeEventListener('click', win.close);
          el.removeEventListener('keydown', onWinKey);
          if (el.parentNode) el.parentNode.removeChild(el);
          if (spec.onClose) { try { spec.onClose(); } catch (e) { console.error('IJWindows onClose', e); } }
        }
      };
      const onWinKey = (e) => {
        if (e.key === 'Escape' && e.target && e.target.closest && !e.target.closest('input, select, textarea')) { e.stopPropagation(); win.close(); }
      };
      closeBtn.addEventListener('click', win.close);
      el.addEventListener('keydown', onWinKey);
      floatingMap.set(spec.id, win);
      return win;
    }

    function closeAll() {
      for (const h of modalStack.slice()) h.close();
      for (const w of Array.from(floatingMap.values())) w.close();
    }
    function destroy() { closeAll(); destroyed = true; root = null; }

    return {
      dialog, floating, confirm,
      hasModal: () => modalStack.length > 0,
      get: (id) => floatingMap.get(id) || null,
      setRoot(r) { root = r; },
      closeAll, destroy
    };
  }

  let defaultInstance = null;
  function inst() { if (!defaultInstance) defaultInstance = create({}); return defaultInstance; }

  return {
    create,
    configure(config) { if (defaultInstance) defaultInstance.destroy(); defaultInstance = create(config || {}); return defaultInstance; },
    dialog: (s) => inst().dialog(s),
    floating: (s) => inst().floating(s),
    confirm: (s) => inst().confirm(s),
    hasModal: () => inst().hasModal(),
    closeAll: () => inst().closeAll()
  };
})();

/* ============================================================
   IJShell — ImageJ chrome and pointer handling
   ============================================================ */
const IJShell = (() => {
  'use strict';
  const P = IJViewPure;
  const SVGNS = 'http://www.w3.org/2000/svg';

  const DEFAULT_TOOLS = [
    { id: 'rect' }, { id: 'oval' }, { id: 'polygon' }, { id: 'freehand' }, { id: 'line' }, { id: 'point' },
    { separator: true },
    { id: 'zoom' }, { id: 'hand' }
  ];
  const TOOL_FALLBACK = { rect: 'Rectangle', oval: 'Oval', polygon: 'Polygon', freehand: 'Freehand', line: 'Straight line', point: 'Point', zoom: 'Magnifying glass', hand: 'Scrolling hand' };
  const ROI_TOOLS = new Set(['rect', 'oval', 'polygon', 'freehand', 'line', 'point']);
  const ICONS = {
    rect: '<rect x="3.5" y="5.5" width="13" height="9"/>',
    oval: '<ellipse cx="10" cy="10" rx="7" ry="5"/>',
    polygon: '<path d="M4 14.5L6.5 5l8 1.5 2 7z"/>',
    freehand: '<path d="M3 13c2-7 4 3 6-2s3-5 5-1 2 3 3 2"/>',
    line: '<path d="M3.5 16L16.5 4"/>',
    point: '<circle cx="10" cy="10" r="2"/><path d="M10 3v4M10 13v4M3 10h4M13 10h4"/>',
    zoom: '<circle cx="8.5" cy="8.5" r="4.5"/><path d="M12 12l5 5"/>',
    hand: '<path d="M6.5 10.5V5.5a1 1 0 012 0V9V4a1 1 0 012 0v5V5a1 1 0 012 0v5V7a1 1 0 012 0v5.5a5 5 0 01-5 5h-1.5a4 4 0 01-3-1.5L3.5 12.5a1 1 0 011.5-1.3z"/>'
  };

  function svgIcon(doc, id) {
    const svg = doc.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('width', '18'); svg.setAttribute('height', '18');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.4'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('ij-tool-icon');
    // static, in-file markup only (never user text)
    svg.innerHTML = ICONS[id] || '<circle cx="10" cy="10" r="5"/>';
    return svg;
  }

  function isTypingTarget(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName;
    if (tag === 'INPUT') return !['range', 'checkbox', 'radio', 'button', 'submit'].includes((el.type || 'text').toLowerCase());
    return tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
  }

  /**
   * IJShell.create(root, options) -> shell
   * options:
   *   t(key, fallback)
   *   commands            the command registry (see IJViewPure.buildMenuTree)
   *   getState()          app state handed to command.enabled(state)
   *   tools               [{ id, labelKey?, label? } | { separator: true }] (default: ImageJ's set)
   *   onCommand(cmd, { source: 'menu' | 'key' })
   *   onTool(id)  onToolOptions(id)  (double-click on line / point)
   *   onRoi(roi | null, { final, source: 'draw' | 'move' | 'resize' | 'nudge' | 'clear' })
   *   onChannel(index)    onCancel()
   *   readPixel(x, y) -> Promise<number[]>   coalesced, <= 1 in flight
   *   isActive()          false while the shell is hidden (shortcuts ignored)
   *   display             options for IJDisplay.create (onTileError, getLut, SVRManager, ...)
   * shell: { el, stage, display, windows, setImage, clearImage, setDisplayState, setTool, getTool,
   *   setActiveRoi, getActiveRoi, setRois, setStatus, setProgress, setWarning, setLineWidth,
   *   refreshMenus, closeMenus, setTitle, destroy }
   */
  function create(root, options = {}) {
    const opts = options || {};
    const doc = root.ownerDocument || document;
    const t = (key, fb) => {
      try { const v = opts.t ? opts.t(key, fb) : fb; return typeof v === 'string' && v && v !== key ? v : fb; } catch (e) { return fb; }
    };
    const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const cleanups = [];
    const listen = (target, ev, fn, o) => { target.addEventListener(ev, fn, o); cleanups.push(() => target.removeEventListener(ev, fn, o)); };
    let destroyed = false;

    const shell = el('div', 'ij-shell');
    shell.style.position = 'relative'; shell.style.display = 'flex'; shell.style.flexDirection = 'column'; shell.style.width = '100%'; shell.style.height = '100%'; shell.style.minHeight = '0';
    root.appendChild(shell);

    // ---- DOM ---------------------------------------------------------------------------------------
    const menubar = el('div', 'ij-menubar');
    menubar.setAttribute('role', 'menubar');
    menubar.setAttribute('aria-label', t('view.menubar', 'Menu bar'));
    const toolbar = el('div', 'ij-toolbar');
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', t('view.toolbar', 'Tools'));
    const imageWin = el('div', 'ij-image-window');
    imageWin.style.flex = '1 1 auto'; imageWin.style.minHeight = '0'; imageWin.style.display = 'flex'; imageWin.style.flexDirection = 'column';
    const titlebar = el('div', 'ij-titlebar');
    const titleName = el('span', 'ij-title-name');
    const titleZoom = el('span', 'ij-title-zoom');
    const titleBadge = el('span', 'ij-title-badge', t('view.previewBadge', 'preview'));
    titleBadge.hidden = true;
    titlebar.append(titleName, titleZoom, titleBadge);
    const subtitle = el('div', 'ij-subtitle');
    const stage = el('div', 'ij-stage');
    stage.tabIndex = 0;
    stage.style.flex = '1 1 auto'; stage.style.minHeight = '0'; stage.style.position = 'relative';
    stage.setAttribute('aria-label', t('view.stage', 'Image'));
    const channelBar = el('div', 'ij-channel-bar');
    channelBar.hidden = true;
    const channelLabel = el('span', 'ij-channel-label');
    const channelSlider = el('input', 'ij-channel-slider');
    channelSlider.type = 'range'; channelSlider.min = '1'; channelSlider.max = '1'; channelSlider.step = '1'; channelSlider.value = '1';
    channelSlider.setAttribute('aria-label', t('view.channel', 'Channel'));
    channelBar.append(channelLabel, channelSlider);
    imageWin.append(titlebar, subtitle, stage, channelBar);
    const statusbar = el('div', 'ij-statusbar');
    statusbar.setAttribute('role', 'status');
    statusbar.setAttribute('aria-label', t('view.statusbar', 'Status'));
    const statusPos = el('span', 'ij-status-pos');
    const statusText = el('span', 'ij-status-text');
    const progress = el('div', 'ij-progress');
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-label', t('view.progress', 'Progress'));
    progress.hidden = true;
    const progressFill = el('div', 'ij-progress-fill');
    progress.appendChild(progressFill);
    const progressLabel = el('span', 'ij-progress-label');
    progressLabel.hidden = true;
    const cancelBtn = el('button', 'ij-cancel', t('view.cancelOp', 'Cancel'));
    cancelBtn.type = 'button'; cancelBtn.hidden = true;
    const warning = el('span', 'ij-warning');
    warning.hidden = true;
    statusbar.append(statusPos, statusText, progress, progressLabel, cancelBtn, warning);
    shell.append(menubar, toolbar, imageWin, statusbar);

    const windows = IJWindows.create({ root: shell, t: opts.t });

    // ---- Display ------------------------------------------------------------------------------------
    let info = null;
    let loadingNow = false;
    const display = IJDisplay.create(stage, {
      ...(opts.display || {}),
      onViewChange: (v) => {
        updateTitle(v);
        if (opts.display && opts.display.onViewChange) opts.display.onViewChange(v);
      }
    });

    function updateTitle(v) {
      const z = v || display.getView();
      titleZoom.textContent = info ? ` (${P.formatZoomPct(z.zoom)}%)` : '';
      loadingNow = !!(v && v.loading);
      titleBadge.hidden = !(info && loadingNow);
    }

    // ---- Tools ---------------------------------------------------------------------------------------
    let tool = 'rect';
    const toolButtons = new Map();
    let lineWidth = 1;
    for (const td of (opts.tools || DEFAULT_TOOLS)) {
      if (td.separator) { toolbar.appendChild(el('span', 'ij-tool-sep')); continue; }
      const b = el('button', 'ij-tool');
      b.type = 'button';
      b.dataset.tool = td.id;
      const label = td.labelKey ? t(td.labelKey, td.label || TOOL_FALLBACK[td.id] || td.id) : t('view.tool.' + td.id, td.label || TOOL_FALLBACK[td.id] || td.id);
      b.title = label; b.setAttribute('aria-label', label); b.setAttribute('aria-pressed', 'false');
      b.appendChild(svgIcon(doc, td.id));
      listen(b, 'click', () => setTool(td.id, true));
      listen(b, 'dblclick', () => {
        if (td.id === 'zoom') display.view100();
        else if ((td.id === 'line' || td.id === 'point') && opts.onToolOptions) opts.onToolOptions(td.id);
      });
      toolbar.appendChild(b);
      toolButtons.set(td.id, b);
    }
    function setTool(id, notify) {
      if (!toolButtons.has(id)) return;
      if (tool !== id) cancelPolygon();
      tool = id;
      for (const [k, b] of toolButtons) {
        b.classList.toggle('is-active', k === id);
        b.setAttribute('aria-pressed', k === id ? 'true' : 'false');
      }
      stageCursor();
      if (notify && opts.onTool) opts.onTool(id);
    }

    // ---- Menus ----------------------------------------------------------------------------------------
    let tree = [];
    let menuState = { open: false, stack: [0] };
    const titleButtons = [];
    let panelsEl = null;
    let armed = false; // a click opened a menu: hovering another title switches

    function buildTree() {
      tree = P.buildMenuTree(opts.commands || [], { t, state: opts.getState ? opts.getState() : null });
    }

    function renderTitles() {
      menubar.textContent = '';
      titleButtons.length = 0;
      tree.forEach((top, i) => {
        const b = el('button', 'ij-menu-title', top.label);
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.setAttribute('aria-haspopup', 'true');
        b.setAttribute('aria-expanded', 'false');
        b.tabIndex = i === (menuState.stack[0] || 0) ? 0 : -1;
        listen(b, 'click', (e) => {
          e.preventDefault();
          if (menuState.open && menuState.stack[0] === i) { closeMenus(); return; }
          menuState = { open: true, stack: [i, P.firstSelectable(tree[i].items)] };
          armed = true;
          renderMenus();
          b.focus();
        });
        listen(b, 'pointerenter', () => {
          if (armed && menuState.open && menuState.stack[0] !== i) {
            menuState = { open: true, stack: [i, P.firstSelectable(tree[i].items)] };
            renderMenus();
          }
        });
        menubar.appendChild(b);
        titleButtons.push(b);
      });
    }

    function renderMenus() {
      if (panelsEl && panelsEl.parentNode) panelsEl.parentNode.removeChild(panelsEl);
      panelsEl = null;
      titleButtons.forEach((b, i) => {
        const on = menuState.open && menuState.stack[0] === i;
        b.classList.toggle('is-open', on);
        b.classList.toggle('is-active', on || (!menuState.open && menuState.stack[0] === i && doc.activeElement === b));
        b.setAttribute('aria-expanded', on ? 'true' : 'false');
        b.tabIndex = i === menuState.stack[0] ? 0 : -1;
      });
      if (!menuState.open || !tree[menuState.stack[0]]) return;
      panelsEl = el('div', 'ij-menu-layer');
      panelsEl.style.position = 'absolute'; panelsEl.style.left = '0'; panelsEl.style.top = '0'; panelsEl.style.zIndex = '60';
      shell.appendChild(panelsEl);
      const btn = titleButtons[menuState.stack[0]];
      const rb = shell.getBoundingClientRect();
      const bb = btn.getBoundingClientRect();
      let list = tree[menuState.stack[0]].items;
      let x = bb.left - rb.left, y = bb.bottom - rb.top;
      const depth = menuState.stack.length - 1;
      for (let d = 1; d <= depth; d++) {
        const panel = el('div', d === 1 ? 'ij-menu-panel' : 'ij-menu-panel ij-submenu');
        panel.setAttribute('role', 'menu');
        panel.style.position = 'absolute'; panel.style.left = Math.round(x) + 'px'; panel.style.top = Math.round(y) + 'px';
        let anchorEl = null;
        const sel = menuState.stack[d];
        list.forEach((it, idx) => {
          if (it.type === 'separator') { const s = el('div', 'ij-menu-sep'); s.setAttribute('role', 'separator'); panel.appendChild(s); return; }
          const row = el('div', 'ij-menu-item');
          row.setAttribute('role', 'menuitem');
          row.appendChild(el('span', 'ij-menu-label', it.label));
          if (it.type === 'item' && it.shortcut) row.appendChild(el('span', 'ij-menu-shortcut', it.shortcut));
          if (it.type === 'group') { row.classList.add('has-children'); row.setAttribute('aria-haspopup', 'true'); row.appendChild(el('span', 'ij-menu-arrow', '▸')); }
          if (it.disabled) { row.classList.add('is-disabled'); row.setAttribute('aria-disabled', 'true'); }
          if (idx === sel) { row.classList.add('is-active'); anchorEl = row; }
          row.addEventListener('pointerenter', () => {
            const next = menuState.stack.slice(0, d + 1);
            next[d] = idx;
            if (it.type === 'group' && !it.disabled) next.push(-1);
            if (next.join() !== menuState.stack.join()) { menuState = { open: true, stack: next }; renderMenus(); }
          });
          row.addEventListener('click', (e) => {
            e.stopPropagation();
            if (it.disabled) return;
            if (it.type === 'group') { menuState = { open: true, stack: [...menuState.stack.slice(0, d + 1).map((v, k) => (k === d ? idx : v)), P.firstSelectable(it.children)] }; renderMenus(); return; }
            runCommand(it.command, 'menu');
          });
          panel.appendChild(row);
        });
        panelsEl.appendChild(panel);
        // submenu: to the right of the highlighted parent row
        const nextItem = list[menuState.stack[d]];
        const pw = panel.offsetWidth;
        if (nextItem && nextItem.type === 'group' && d < depth && anchorEl) {
          x = x + pw - 2; y = y + anchorEl.offsetTop;
          list = nextItem.children;
        } else if (nextItem && nextItem.type === 'group') {
          // group highlighted but its panel is not open: nothing deeper
          break;
        } else break;
      }
    }

    function closeMenus() {
      menuState = { open: false, stack: [menuState.stack[0] || 0] };
      armed = false;
      renderMenus();
    }

    function runCommand(cmd, source) {
      closeMenus();
      stage.focus({ preventScroll: true });
      if (opts.onCommand) opts.onCommand(cmd, { source });
    }

    listen(menubar, 'keydown', (e) => {
      if (!tree.length) return;
      const k = e.key;
      if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Escape', 'Home', 'End'].includes(k)) return;
      e.preventDefault(); e.stopPropagation();
      const r = P.menuKey(tree, menuState, k);
      menuState = r.state;
      if (r.activate) { runCommand(r.activate.command, 'key'); return; }
      if (!menuState.open && k === 'Escape') { stage.focus({ preventScroll: true }); }
      renderMenus();
      const b = titleButtons[menuState.stack[0]];
      if (b) b.focus();
    });
    listen(doc, 'pointerdown', (e) => {
      if (!menuState.open) return;
      if (menubar.contains(e.target) || (panelsEl && panelsEl.contains(e.target))) return;
      closeMenus();
    }, true);

    function refreshMenus() {
      buildTree();
      if (menuState.stack[0] >= tree.length) menuState = { open: false, stack: [0] };
      renderTitles();
      renderMenus();
    }
    refreshMenus();

    // ---- Image / title / channels ---------------------------------------------------------------------------
    function setImage(imgInfo) {
      info = imgInfo || null;
      if (!info) { clearImage(); return; }
      titleName.textContent = info.name || '';
      subtitle.textContent = P.formatSubtitle(info);
      const n = info.channels ? info.channels.length : 1;
      channelSlider.max = String(Math.max(1, n));
      const active = Math.min(n - 1, Math.max(0, (info.display && info.display.active) || 0));
      channelSlider.value = String(active + 1);
      channelBar.hidden = n < 2;
      channelLabel.textContent = `c: ${active + 1}/${n}`;
      display.setImage(info);
      updateTitle(display.getView());
      statusPos.textContent = '';
    }
    function clearImage() {
      info = null;
      titleName.textContent = ''; titleZoom.textContent = ''; subtitle.textContent = '';
      titleBadge.hidden = true; channelBar.hidden = true;
      display.setImage(null);
      activeRoi = null; polyDraft = null;
    }
    function setTitle(name) { if (info) info.name = name; titleName.textContent = name || ''; }
    function setDisplayState(state) {
      display.setDisplay(state);
      if (state && Number.isInteger(state.active) && info) {
        const n = info.channels.length;
        channelSlider.value = String(state.active + 1);
        channelLabel.textContent = `c: ${state.active + 1}/${n}`;
      }
    }
    listen(channelSlider, 'input', () => {
      const idx = Number(channelSlider.value) - 1;
      channelLabel.textContent = `c: ${idx + 1}/${channelSlider.max}`;
      display.setDisplay({ active: idx });
      if (opts.onChannel) opts.onChannel(idx);
    });

    // ---- Status bar -------------------------------------------------------------------------------------------
    function setStatus(text) { statusText.textContent = text || ''; }
    function setProgress(p) {
      if (!p) { progress.hidden = true; progressLabel.hidden = true; cancelBtn.hidden = true; progressFill.style.width = '0'; progress.removeAttribute('aria-valuenow'); return; }
      progress.hidden = false;
      if (Number.isFinite(p.fraction)) {
        const pct = Math.round(Math.min(1, Math.max(0, p.fraction)) * 100);
        progressFill.style.width = pct + '%';
        progress.setAttribute('aria-valuenow', String(pct));
        progress.classList.remove('is-indeterminate');
      } else {
        progress.classList.add('is-indeterminate');
        progress.removeAttribute('aria-valuenow');
      }
      progressLabel.hidden = !p.label;
      progressLabel.textContent = p.label || '';
      cancelBtn.hidden = !p.cancellable;
    }
    function setWarning(text) { warning.hidden = !text; warning.textContent = text || ''; }
    listen(cancelBtn, 'click', () => { if (opts.onCancel) opts.onCancel(); });

    // ---- Pixel read-out (<= 1 request in flight) ------------------------------------------------------------------------
    let pxPending = null, pxBusy = false;
    function showPos(ix, iy, values) {
      if (!info) { statusPos.textContent = ''; return; }
      statusPos.textContent = P.formatStatus({ x: ix, y: iy, calibration: info.calibration, values, bitDepth: info.bitDepth });
    }
    async function pxFlush() {
      if (pxBusy) return;
      pxBusy = true;
      try {
        while (pxPending && !destroyed) {
          const q = pxPending; pxPending = null;
          let values = null;
          try { values = opts.readPixel ? await opts.readPixel(q.x, q.y) : null; } catch (e) { values = null; }
          if (destroyed) break;
          if (!pxPending) showPos(q.x, q.y, values);
        }
      } finally { pxBusy = false; }
    }
    function readout(ix, iy) {
      if (!info) return;
      const x = Math.floor(ix), y = Math.floor(iy);
      if (x < 0 || y < 0 || x >= info.width || y >= info.height) { statusPos.textContent = ''; pxPending = null; return; }
      if (!opts.readPixel) { showPos(x, y, null); return; }
      pxPending = { x, y };
      pxFlush();
    }

    // ---- ROI interaction ------------------------------------------------------------------------------------------------
    let activeRoi = null;
    let polyDraft = null;       // { points:[[x,y]], rubber }
    let drag = null;
    let spaceDown = false;
    let wheelAcc = 0;
    let hoverCursor = '';
    let rois = { all: [], showAll: false };

    function pushRois() { display.setRois({ active: activeRoi, all: rois.all, showAll: rois.showAll, handles: true }); }
    function emitRoi(roi, final, source) { if (opts.onRoi) opts.onRoi(roi, { final, source }); }
    function commitRoi(roi, source, final = true) {
      activeRoi = roi;
      pushRois();
      if (roi) setStatus(P.describeRoi(roi, info && info.calibration));
      emitRoi(roi, final, source);
    }
    function cancelPolygon() { if (polyDraft) { polyDraft = null; display.setDraft(null); } }

    function stagePoint(e) {
      const r = stage.getBoundingClientRect();
      return { sx: e.clientX - r.left, sy: e.clientY - r.top };
    }
    function tolImg() { return 6 / Math.max(display.getView().zoom, 1e-6); }

    function stageCursor() {
      let c = 'default';
      if (tool === 'hand' || spaceDown) c = drag && drag.kind === 'pan' ? 'grabbing' : 'grab';
      else if (tool === 'zoom') c = 'zoom-in';
      else if (ROI_TOOLS.has(tool)) c = 'crosshair';
      display.setCursor(hoverCursor || c);
    }

    function finishPolygon(close) {
      if (!polyDraft) return;
      const pts = polyDraft.points;
      polyDraft = null;
      display.setDraft(null);
      if (close && pts.length >= 3) commitRoi({ type: 'polygon', points: pts }, 'draw');
      else if (pts.length === 2 && !close) commitRoi({ type: 'line', x1: pts[0][0], y1: pts[0][1], x2: pts[1][0], y2: pts[1][1], width: 1 }, 'draw');
      else commitRoi(null, 'clear');
    }

    function onPointerDown(e) {
      if (!info) return;
      stage.focus({ preventScroll: true });
      const { sx, sy } = stagePoint(e);
      const p = display.screenToImage(sx, sy);
      const panning = e.button === 1 || spaceDown || tool === 'hand';
      if (panning && (e.button === 0 || e.button === 1)) {
        drag = { kind: 'pan', lx: e.clientX, ly: e.clientY, id: e.pointerId };
        stage.setPointerCapture(e.pointerId);
        stageCursor(); e.preventDefault();
        return;
      }
      if (tool === 'zoom') {
        if (e.button === 2 || e.altKey) { display.zoomAt(sx, sy, -1); return; }
        if (e.button !== 0) return;
        drag = { kind: 'zoomrect', sx, sy, cx: sx, cy: sy, id: e.pointerId };
        stage.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button !== 0 || !ROI_TOOLS.has(tool)) return;

      const tol = tolImg();
      // polygon in progress: add a vertex (close on the first one / double click)
      if (tool === 'polygon' && polyDraft) {
        const pt = [Math.round(p.x), Math.round(p.y)];
        const first = polyDraft.points[0];
        const near = first && Math.hypot((first[0] - pt[0]) * display.getView().zoom, (first[1] - pt[1]) * display.getView().zoom) < 8;
        if (near && polyDraft.points.length >= 3) { finishPolygon(true); return; }
        if (e.detail >= 2 && polyDraft.points.length >= 3) { finishPolygon(true); return; }
        polyDraft.points.push(pt);
        display.setDraft({ points: polyDraft.points, rubber: [p.x, p.y] });
        return;
      }
      // handles and move of the existing selection
      if (activeRoi) {
        const h = P.handleAt(activeRoi, p.x, p.y, tol);
        if (h) {
          drag = { kind: 'resize', handle: h.id, start: activeRoi, id: e.pointerId };
          stage.setPointerCapture(e.pointerId);
          return;
        }
        if (!(tool === 'point' && !e.shiftKey) && P.hitRoi(activeRoi, p.x, p.y, activeRoi.type === 'line' ? tol : 0)) {
          drag = { kind: 'move', start: activeRoi, p0: p, moved: false, id: e.pointerId };
          stage.setPointerCapture(e.pointerId);
          return;
        }
      }
      // a new selection
      if (tool === 'point') {
        const pt = [Math.floor(p.x) + 0.5, Math.floor(p.y) + 0.5];
        const pts = e.shiftKey && activeRoi && activeRoi.type === 'point' ? activeRoi.points.concat([pt]) : [pt];
        commitRoi({ type: 'point', points: pts }, 'draw');
        return;
      }
      if (tool === 'polygon') {
        polyDraft = { points: [[Math.round(p.x), Math.round(p.y)]], rubber: null };
        activeRoi = null; pushRois();
        display.setDraft({ points: polyDraft.points, rubber: [p.x, p.y] });
        emitRoi(null, false, 'clear');
        return;
      }
      activeRoi = null;
      drag = { kind: 'draw', tool, p0: p, pts: tool === 'freehand' ? [[Math.floor(p.x), Math.floor(p.y)]] : null, id: e.pointerId };
      stage.setPointerCapture(e.pointerId);
      if (activeRoi === null) { pushRois(); }
    }

    function onPointerMove(e) {
      if (!info) return;
      const { sx, sy } = stagePoint(e);
      const p = display.screenToImage(sx, sy);
      readout(p.x, p.y);
      if (drag) {
        switch (drag.kind) {
          case 'pan':
            display.pan(e.clientX - drag.lx, e.clientY - drag.ly);
            drag.lx = e.clientX; drag.ly = e.clientY;
            break;
          case 'zoomrect': drag.cx = sx; drag.cy = sy; {
            const a = display.screenToImage(drag.sx, drag.sy);
            display.setRois({ active: { type: 'rect', x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(p.x - a.x), h: Math.abs(p.y - a.y) }, handles: false });
          } break;
          case 'draw': {
            let roi;
            if (drag.tool === 'rect' || drag.tool === 'oval') roi = P.roiFromDrag(drag.tool, drag.p0, p, { shift: e.shiftKey, alt: e.altKey });
            else if (drag.tool === 'line') roi = P.lineFromDrag(drag.p0, p, { shift: e.shiftKey, width: lineWidth });
            else {
              const last = drag.pts[drag.pts.length - 1];
              const pt = [Math.floor(p.x), Math.floor(p.y)];
              if (pt[0] !== last[0] || pt[1] !== last[1]) drag.pts.push(pt);
              roi = { type: 'freehand', points: drag.pts };
            }
            activeRoi = roi; drag.roi = roi;
            display.setRois({ active: roi, handles: false });
            setStatus(P.describeRoi(roi, info.calibration));
            emitRoi(roi, false, 'draw');
          } break;
          case 'move': {
            const dx = Math.round(p.x - drag.p0.x), dy = Math.round(p.y - drag.p0.y);
            if (dx || dy) drag.moved = true;
            const roi = P.translateRoi(drag.start, dx, dy);
            activeRoi = roi; drag.roi = roi;
            display.setRois({ active: roi, handles: false });
            setStatus(P.describeRoi(roi, info.calibration));
            emitRoi(roi, false, 'move');
          } break;
          case 'resize': {
            const roi = P.moveHandle(drag.start, drag.handle, p.x, p.y, { shift: e.shiftKey });
            activeRoi = roi; drag.roi = roi;
            display.setRois({ active: roi, handles: false });
            setStatus(P.describeRoi(roi, info.calibration));
            emitRoi(roi, false, 'resize');
          } break;
          default: break;
        }
        return;
      }
      if (polyDraft) display.setDraft({ points: polyDraft.points, rubber: [p.x, p.y] });
      // hover cursor over the selection
      let c = '';
      if (activeRoi && ROI_TOOLS.has(tool) && !spaceDown) {
        const h = P.handleAt(activeRoi, p.x, p.y, tolImg());
        if (h) c = P.handleCursor(h.id);
        else if (P.hitRoi(activeRoi, p.x, p.y, 0)) c = 'move';
      }
      if (c !== hoverCursor) { hoverCursor = c; stageCursor(); }
    }

    function endDrag(e, cancelled) {
      if (!drag) return;
      const d = drag;
      drag = null;
      try { stage.releasePointerCapture(d.id); } catch (x) { /* already released */ }
      switch (d.kind) {
        case 'pan': stageCursor(); break;
        case 'zoomrect': {
          display.setRois({ active: activeRoi, handles: true });
          if (cancelled) break;
          const { sx, sy } = e ? stagePoint(e) : { sx: d.cx, sy: d.cy };
          if (Math.hypot(sx - d.sx, sy - d.sy) < 4) display.zoomAt(d.sx, d.sy, 1);
          else {
            const a = display.screenToImage(d.sx, d.sy), b = display.screenToImage(sx, sy);
            display.zoomToRect({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });
          }
        } break;
        case 'draw': {
          let roi = d.roi || null;
          if (cancelled) roi = null;
          else if (roi && (roi.type === 'rect' || roi.type === 'oval') && (roi.w < 1 || roi.h < 1)) roi = null;
          else if (roi && roi.type === 'line' && roi.x1 === roi.x2 && roi.y1 === roi.y2) roi = null;
          else if (roi && roi.type === 'freehand' && roi.points.length < 3) roi = null;
          commitRoi(roi, roi ? 'draw' : 'clear');
          if (!roi) setStatus('');
        } break;
        case 'move': case 'resize': {
          const roi = d.roi || d.start;
          if (cancelled) commitRoi(d.start, d.kind);
          else commitRoi(roi, d.kind);
        } break;
        default: break;
      }
    }

    listen(stage, 'pointerdown', onPointerDown);
    listen(stage, 'pointermove', onPointerMove);
    listen(stage, 'pointerup', (e) => endDrag(e, false));
    listen(stage, 'pointercancel', (e) => endDrag(e, true));
    listen(stage, 'pointerleave', () => { if (!drag) statusPos.textContent = ''; pxPending = null; });
    listen(stage, 'contextmenu', (e) => { if (tool === 'zoom') e.preventDefault(); });
    listen(stage, 'dblclick', (e) => {
      if (tool === 'polygon' && polyDraft && polyDraft.points.length >= 3) { e.preventDefault(); finishPolygon(true); }
    });
    listen(stage, 'wheel', (e) => {
      if (!info) return;
      e.preventDefault();
      const r = P.wheelSteps(wheelAcc, e.deltaY, e.deltaMode);
      wheelAcc = r.acc;
      const { sx, sy } = stagePoint(e);
      for (let i = 0; i < Math.abs(r.steps); i++) display.zoomAt(sx, sy, r.steps > 0 ? 1 : -1);
    }, { passive: false });

    // ---- Keyboard ---------------------------------------------------------------------------------------------------------
    const shortcutMap = new Map();
    function indexShortcuts() {
      shortcutMap.clear();
      for (const c of opts.commands || []) {
        const list = Array.isArray(c.shortcut) ? c.shortcut : (c.shortcut ? [c.shortcut] : []);
        for (const s of list) { const n = P.normalizeShortcut(s); if (n && !shortcutMap.has(n)) shortcutMap.set(n, c); }
      }
    }
    indexShortcuts();

    function onKeyDown(e) {
      if (destroyed || e.defaultPrevented) return;
      if (opts.isActive && !opts.isActive()) return;
      if (windows.hasModal()) return;
      if (isTypingTarget(e.target)) return;
      if (menuState.open && menubar.contains(e.target)) return;
      if (e.key === ' ' && (e.target === stage || e.target === doc.body)) {
        if (!spaceDown) { spaceDown = true; stageCursor(); }
        e.preventDefault();
        return;
      }
      if (polyDraft) {
        if (e.key === 'Enter') { e.preventDefault(); finishPolygon(true); return; }
        if (e.key === 'Escape') { e.preventDefault(); cancelPolygon(); commitRoi(null, 'clear'); return; }
        if (e.key === 'Backspace') {
          e.preventDefault();
          polyDraft.points.pop();
          if (!polyDraft.points.length) { cancelPolygon(); return; }
          display.setDraft({ points: polyDraft.points, rubber: null });
          return;
        }
      }
      if (drag && e.key === 'Escape') { e.preventDefault(); endDrag(null, true); return; }
      if (e.key === 'Escape' && !progress.hidden && !cancelBtn.hidden) { e.preventDefault(); if (opts.onCancel) opts.onCancel(); return; }
      if (activeRoi && stage.contains(e.target) && e.key.startsWith('Arrow') && !e.ctrlKey && !e.metaKey) {
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        if (dx || dy) { e.preventDefault(); commitRoi(P.translateRoi(activeRoi, dx, dy), 'nudge'); return; }
      }
      const sc = P.shortcutFromEvent(e);
      if (!sc) return;
      const cmd = shortcutMap.get(sc);
      if (!cmd) return;
      let enabled = true;
      if (typeof cmd.enabled === 'function') { try { enabled = !!cmd.enabled(opts.getState ? opts.getState() : null); } catch (x) { enabled = false; } }
      e.preventDefault();
      if (enabled && opts.onCommand) { closeMenus(); opts.onCommand(cmd, { source: 'key' }); }
    }
    function onKeyUp(e) {
      if (e.key === ' ' && spaceDown) { spaceDown = false; stageCursor(); }
    }
    listen(doc, 'keydown', onKeyDown);
    listen(doc, 'keyup', onKeyUp);
    listen(stage, 'blur', () => { if (spaceDown) { spaceDown = false; stageCursor(); } });

    setTool('rect', false);

    // ---- Public API --------------------------------------------------------------------------------------------------------------
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const fn of cleanups.splice(0)) fn();
      windows.destroy();
      display.destroy();
      pxPending = null;
      if (shell.parentNode) shell.parentNode.removeChild(shell);
    }

    return {
      el: shell, stage, display, windows, menubar, statusBar: statusbar,
      setImage, clearImage, setTitle, setDisplayState,
      setTool: (id) => setTool(id, false), getTool: () => tool,
      setActiveRoi(roi) { activeRoi = roi || null; cancelPolygon(); pushRois(); setStatus(roi ? P.describeRoi(roi, info && info.calibration) : ''); },
      getActiveRoi: () => activeRoi,
      setRois(r) { rois = { all: (r && r.all) || [], showAll: !!(r && r.showAll) }; pushRois(); },
      setLineWidth(w) { lineWidth = Math.max(1, Number(w) || 1); },
      setStatus, setProgress, setWarning,
      refreshMenus: () => { indexShortcuts(); refreshMenus(); },
      closeMenus,
      destroy
    };
  }

  return { create, DEFAULT_TOOLS };
})();
