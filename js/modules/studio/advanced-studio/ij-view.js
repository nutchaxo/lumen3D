/* ============================================================
   Advanced Studio — ij-view.js
   Display (tiled WebGL2), windows (dialogs / floating tools) and shell
   (menu bar, tool bar, title bar, status bar, pointer handling).

   Classic script, no ESM. Page only (needs the DOM). Globals:
     IJViewPure  pure helpers (zoom ladder, transforms, tile maths, LRU, menu model,
                 value parsing, ROI geometry, formatting) — testable in Node
     (the tiled WebGL2 renderer, IJView and the workspace layout live in ij-layout.js)
     IJWindows   dialogs (field types: see IJViewPure.FIELD_TYPES), floating windows, confirm
     IJPlot      the generic plot window's drawing (draw, extent, niceTicks) and CSV text
     IJShell     ImageJ chrome + pointer handling

   Text: every string goes through t(key, fallback) supplied by the controller; a `t`
   that returns the key itself (missing translation) falls back to the English text.
   Keys used here (plugin lang, namespace-free):
     view.menu.<Name>        top-level and group names (File, Edit, Image, Process,
                             Analyze, Window, Help, Stacks, Adjust, Color, ...)
     view.tool.rect|oval|polygon|freehand|line|point|zoom|hand
     view.ok  view.cancel  view.preview  view.previewBadge  view.channel
     view.cancelOp  view.close  view.invalid.nan|range|integer
     view.menubar  view.toolbar  view.statusbar  view.stage  view.progress  view.unavailable

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
  const TOP_ORDER = ['File', 'Edit', 'Image', 'Process', 'Analyze', 'Plugins', 'Window', 'Help'];

  /**
   * Menu tree from the command registry.
   * command = { id, menu: ['Image','Adjust'], label?, labelKey?, shortcut?, enabled?(state),
   *             order?, separatorBefore?, unavailable?() }  — an entry { separator: true, menu } adds a
   *             separator.
   * Inside one (sub)menu the entries are sorted by `order` (a number; entries without one follow the
   * ordered ones, in the order they were registered). A submenu has no command of its own: its
   * position comes from `groups`, a table { 'Image/Zoom': { order, separatorBefore } } keyed by the
   * path of menu names. A command or a group with `separatorBefore` gets a separator above it.
   * An `unavailable()` command (its package failed to load) is disabled and says so in `title`.
   * Returns [{ name, label, items }] with items = { type:'item', id, label, shortcut,
   * disabled, title?, command } | { type:'group', name, label, children, disabled } |
   * { type:'separator' }, tops in ImageJ order (File, Edit, Image, Process, Analyze,
   * Window, Help) then any other in first-appearance order. Empty tops are dropped.
   */
  function buildMenuTree(commands, { t = (k, f) => f ?? k, state = null, groups = null } = {}) {
    const tops = new Map();
    const meta = groups || {};
    const tr = (key, fb) => { const v = t(key, fb); return typeof v === 'string' && v && v !== key ? v : fb; };
    const groupFor = (list, name, path) => {
      let g = list.find((i) => i.type === 'group' && i.name === name);
      if (!g) {
        const m = meta[path] || {};
        g = { type: 'group', name, label: tr('view.menu.' + name, name), children: [], disabled: false, path };
        if (typeof m.order === 'number') g.order = m.order;
        if (m.separatorBefore) { g.sepBefore = true; }
        list.push(g);
      }
      return g;
    };
    for (const c of commands || []) {
      if (!c || !Array.isArray(c.menu) || !c.menu.length) continue;
      const [topName, ...rest] = c.menu;
      if (!tops.has(topName)) tops.set(topName, { name: topName, label: tr('view.menu.' + topName, topName), items: [] });
      let list = tops.get(topName).items;
      let path = topName;
      for (const g of rest) { path += '/' + g; list = groupFor(list, g, path).children; }
      if (c.separator) {
        if (list.length && list[list.length - 1].type !== 'separator') list.push({ type: 'separator' });
        continue;
      }
      let disabled = false;
      if (typeof c.enabled === 'function') { try { disabled = !c.enabled(state); } catch (e) { disabled = true; } }
      let title;
      if (typeof c.unavailable === 'function') {
        let gone = false;
        try { gone = !!c.unavailable(); } catch (e) { gone = false; }
        if (gone) { disabled = true; title = t('view.unavailable', 'Unavailable'); }
      }
      const label = c.label || (c.labelKey ? tr(c.labelKey, c.labelKey) : c.id);
      const sc = Array.isArray(c.shortcut) ? c.shortcut[0] : c.shortcut;
      const item = { type: 'item', id: c.id, label, shortcut: sc ? shortcutLabel(sc) : '', disabled, command: c };
      if (title) item.title = title;
      if (typeof c.order === 'number') item.order = c.order;
      if (c.separatorBefore) item.sepBefore = true;
      list.push(item);
    }
    // Order inside every list: separators become a flag of the entry that follows them, the entries
    // are sorted (stable, unordered ones last), then the separators come back above the flagged ones.
    const arrange = (list) => {
      const flat = [];
      let sep = false;
      for (const it of list) {
        if (it.type === 'separator') { sep = true; continue; }
        if (sep) it.sepBefore = true;
        sep = false;
        flat.push(it);
      }
      flat.forEach((it, i) => { it._i = i; });
      flat.sort((a, b) => {
        const ao = typeof a.order === 'number' ? a.order : Infinity, bo = typeof b.order === 'number' ? b.order : Infinity;
        if (ao !== bo) return ao < bo ? -1 : 1;
        return a._i - b._i;
      });
      const out = [];
      for (const it of flat) {
        delete it._i;
        if (it.sepBefore && out.length) out.push({ type: 'separator' });
        delete it.sepBefore;
        if (it.type === 'group') { it.children = arrange(it.children); delete it.path; }
        out.push(it);
      }
      return out;
    };
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
      // trim leading / trailing / doubled separators
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
      top.items = clean(arrange(top.items));
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

  // --- Dialog field schema (PLAN-wave2 §2.5). The real list: a spec naming another type is refused.
  // The values a callback receives (enabledIf, visibleIf, validate, onChange, preview params) hold ONLY the
  // fields that parse: a field whose text is invalid (or hidden by visibleIf) is ABSENT, never NaN. validate and
  // onChange are called only when every field is valid; a derived field's set({ id: NaN }) is ignored.
  //   number    { min, max, step, integer, decimals, units | unitsKey }       value: number
  //   slider    { min, max, step }                                            value: number
  //   check     value: boolean
  //   choice    { options:[value | {value, label | labelKey}] }               value: the option's value
  //   radio     { options }  (same as choice, drawn as a group of radio buttons)
  //   string    value: string      textarea { rows, monospace }  value: string
  //   doc       { options:[{ value: docId, label }] }  an open document      value: the docId
  //   channel   { options | (docField: id of a sibling `doc` field + optionsByDoc: { [docId]: options }) }  value: the option's value
  //   message   { label | labelKey }  (text only, no value)
  // Every field: id, label | labelKey (a message too), optional value, enabledIf(values), visibleIf(values).
  // Dialog-level: validate(values) → { fieldId: errKey } | null; onChange(values, set); preview.
  const FIELD_TYPES = ['number', 'slider', 'check', 'choice', 'radio', 'string', 'textarea', 'doc', 'channel', 'message'];
  const CHOICE_LIKE = new Set(['choice', 'radio', 'doc', 'channel']);

  /** The problems of a dialog spec's field list ([] when sound): the stand-ins of the tests fail on any. */
  function fieldProblems(fields) {
    const out = [];
    if (!Array.isArray(fields)) return ['fields is not an array'];
    const ids = new Set();
    for (const f of fields) {
      if (!f || typeof f !== 'object') { out.push('field is not an object'); continue; }
      const id = f.id;
      if (typeof id !== 'string' || !id) out.push('field without id');
      else if (ids.has(id)) out.push('duplicate field id ' + id);
      else ids.add(id);
      if (FIELD_TYPES.indexOf(f.type) < 0) { out.push('unknown field type ' + f.type + ' (' + id + ')'); continue; }
      if (!f.label && !f.labelKey && !(f.type === 'message' && f.value)) out.push('field ' + id + ' has no label / labelKey');
      if ((f.type === 'number' || f.type === 'slider') && f.min !== undefined && f.max !== undefined && !(f.min <= f.max)) out.push('field ' + id + ' min > max');
      if (CHOICE_LIKE.has(f.type)) {
        const hasOpts = Array.isArray(f.options) && f.options.length > 0;
        const hasByDoc = f.type === 'channel' && f.optionsByDoc && typeof f.optionsByDoc === 'object' && typeof f.docField === 'string';
        if (!hasOpts && !hasByDoc) out.push('field ' + id + ' has no options');
        for (const o of (hasOpts ? f.options : [])) {
          if (o && typeof o === 'object' && (o.value === undefined || !(o.label !== undefined || o.labelKey))) out.push('option of ' + id + ' needs value and label | labelKey');
        }
      }
      for (const fn of ['enabledIf', 'visibleIf']) if (f[fn] !== undefined && typeof f[fn] !== 'function') out.push(id + '.' + fn + ' is not a function');
    }
    for (const f of fields) {
      if (f && f.type === 'channel' && f.docField !== undefined && !ids.has(f.docField)) out.push('channel field ' + f.id + ' names the missing doc field ' + f.docField);
    }
    return out;
  }

  /** Options of a choice-like field as they are now (a channel field follows its doc field). */
  function effectiveOptions(f, raw) {
    if (f.type === 'channel' && f.docField && f.optionsByDoc) {
      const o = f.optionsByDoc[String(raw[f.docField])];
      if (Array.isArray(o)) return o;
    }
    return f.options || [];
  }

  /**
   * Whether a DOM event of a dialog control must reach spec.onChange. A user change fires `input` then `change` on a
   * checkbox / radio / select, and `input` per keystroke then `change` on commit for text-like controls; a handler that
   * applies a toggle delta (Centered, Pixel units...) must run once per change. Discrete controls report on `change`
   * only; text-like ones on `input`, and on `change` only when the value differs from the last one reported.
   * `memo` is a Map/WeakMap element -> last reported value.
   */
  function dialogEventDecision(evType, el, memo) {
    if (!el) return false;
    const tag = String(el.tagName || '').toUpperCase(), type = String(el.type || '').toLowerCase();
    const discrete = tag === 'SELECT' || type === 'checkbox' || type === 'radio' || type === 'select-one' || type === 'select-multiple';
    if (discrete) return evType === 'change';
    if (evType === 'input') { memo.set(el, el.value); return true; }
    if (evType !== 'change') return false;
    if (memo.get(el) === el.value) return false;
    memo.set(el, el.value);
    return true;
  }

  /** Values of a dialog: raw = { [id]: string | boolean } as read from the controls.
   *  opts.hidden = ids of hidden fields: not validated, they keep their initial value. */
  function collectFields(fields, raw, opts) {
    const values = {}, errors = {};
    const hidden = (opts && opts.hidden) || null;
    for (const f of fields) {
      if (f.type === 'message') continue;
      if (hidden && hidden.has(f.id)) { if (f.value !== undefined) values[f.id] = f.value; continue; }
      const r = raw[f.id];
      if (f.type === 'number' || f.type === 'slider') {
        const p = parseNumber(r, { min: f.min, max: f.max, integer: !!f.integer });
        if (p.ok) values[f.id] = p.value; else errors[f.id] = p.code;
      } else if (f.type === 'check') {
        values[f.id] = !!r;
      } else if (CHOICE_LIKE.has(f.type)) {
        // A `disabled` option is a placeholder ("no open image"), never an answer: a doc field with no
        // document to pick must not commit an empty id.
        const opts2 = effectiveOptions(f, raw).filter((o) => !(o && typeof o === 'object' && o.disabled)).map((o) => (o && typeof o === 'object' ? o.value : o));
        const hit = opts2.find((o) => String(o) === String(r));
        if (hit === undefined || (hit === '' && (f.type === 'doc' || f.type === 'channel'))) errors[f.id] = 'choice'; else values[f.id] = hit;
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

  /** Arrow-key step of a number field: a finite positive `step` wins, anything else
   *  ('any', 0, undefined) falls back to 1 for integers and 0.1 otherwise. */
  function numberStep(f) {
    const s = Number(f && f.step);
    return Number.isFinite(s) && s > 0 ? s : (f && f.integer ? 1 : 0.1);
  }

  /** Left edge for a popup of width w anchored at x inside a root of width rw: shifted left to
   *  stay inside, never below 0. */
  function clampPopupX(x, w, rw) {
    return Math.max(0, Math.min(x, rw - w));
  }

  /** Top edge of a popup of height h anchored at y inside a root of height rh. */
  function clampPopupY(y, h, rh) {
    return Math.max(0, Math.min(y, rh - h));
  }

  /** Left edge of a submenu: right of its parent panel (parentX + parentW - 2) when it fits,
   *  else to the left of the parent. */
  function submenuX(parentX, parentW, w, rw) {
    const right = parentX + parentW - 2;
    if (right + w <= rw) return right;
    return Math.max(0, parentX - w + 2);
  }

  /** Left edge of a centred modal box of width w in a root of width rw. */
  function centreX(w, rw) { return Math.max(8, Math.round((rw - w) / 2)); }

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
      case 'polygon': case 'freehand': case 'point': case 'polyline': case 'angle': {
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
    if (roi.rle) r.rle = roi.rle.slice();
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

  /**
   * A line between integer image coordinates, as ImageJ's Line tool creates it without
   * sub-pixel resolution (offScreenX/Y floor the pointer): IJOps.profile samples
   * getInterpolatedValue at those raw coordinates (ImageProcessor.getLine), so a
   * horizontal, vertical or 45° line returns exactly the pixels it crosses.
   * Shift constrains the angle to multiples of 45°, endpoints rounded back to integers.
   */
  function lineFromDrag(p0, p1, { shift = false, width = 1 } = {}) {
    const ax = _f(p0.x), ay = _f(p0.y);
    let bx = _f(p1.x), by = _f(p1.y);
    if (shift) {
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      bx = Math.round(ax + Math.cos(ang) * len); by = Math.round(ay + Math.sin(ang) * len);
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
    if (roi.type === 'polygon' || roi.type === 'point' || roi.type === 'polyline' || roi.type === 'angle') {
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
      case 'polyline': case 'angle': {
        // a segmented line / the two arms of an angle: within a click's reach of any segment
        const pts = roi.points || [], reach = Math.max(tol, 0.75) + (roi.type === 'polyline' ? (roi.width || 1) / 2 : 0);
        for (let i = 1; i < pts.length; i++) {
          const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1], l2 = dx * dx + dy * dy;
          let t = l2 ? ((x - pts[i - 1][0]) * dx + (y - pts[i - 1][1]) * dy) / l2 : 0;
          t = Math.max(0, Math.min(1, t));
          if (Math.hypot(x - (pts[i - 1][0] + t * dx), y - (pts[i - 1][1] + t * dy)) <= reach) return true;
        }
        return false;
      }
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
      const moved = lineFromDrag({ x: fixed.x, y: fixed.y }, { x: px, y: py }, { shift, width: roi.width });
      return id === 'p1'
        ? { ...roi, x1: moved.x2, y1: moved.y2 }
        : { ...roi, x2: moved.x2, y2: moved.y2 };
    }
    if (roi.type === 'polygon' || roi.type === 'point' || roi.type === 'polyline' || roi.type === 'angle') {
      const i = Number(id.slice(1));
      const pts = roi.points.map((p) => p.slice());
      // a point is marked by its pixel centre, a segmented line / an angle by integer pixel-centre coordinates (as a line), a polygon by corners
      if (pts[i]) pts[i] = roi.type === 'point' ? [_f(px) + 0.5, _f(py) + 0.5] : (roi.type === 'polyline' || roi.type === 'angle') ? [_f(px), _f(py)] : [Math.round(px), Math.round(py)];
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

  // ---- ImageJ number formatting: ij.IJ.d2s, ij.util.Tools.getDecimalPlaces (ImageJ 1.54p, read with javap) ----
  /**
   * IJ.d2s(n, decimals) (ImageJ 1.54p, checked against the jar): java.text.DecimalFormat on the EXACT value of the double, HALF_UP with no decimals
   * (df[0]), HALF_EVEN with 1..9; a negative number that rounds to zero keeps its sign ('-0', '-0.00').
   */
  function d2s(n, decimals) {
    if (typeof n !== 'number' || Number.isNaN(n)) return 'NaN';
    if (!Number.isFinite(n)) return n > 0 ? 'Infinity' : '-Infinity';
    const d = Math.max(0, Math.min(9, decimals | 0));
    const parts = Math.abs(n).toFixed(Math.min(100, d + 30)).split('.');
    const keep = parts[1].slice(0, d), rest = parts[1].slice(d);
    const tie = rest.charAt(0) === '5' && /^0*$/.test(rest.slice(1));
    const odd = Number((parts[0] + keep).slice(-1)) % 2 === 1;
    const up = rest.charAt(0) > '5' || (rest.charAt(0) === '5' && !tie) || (tie && (d === 0 || odd));
    const digits = (BigInt(parts[0] + keep) + (up ? 1n : 0n)).toString().padStart(d + 1, '0');
    return (n < 0 ? '-' : '') + (d ? digits.slice(0, -d) + '.' + digits.slice(-d) : digits);
  }
  /** Tools.getDecimalPlaces(n): digits after the point, at most 4; 0 for an integer or NaN; -2 for a number Java prints with an exponent. */
  function decimalPlaces(n) {
    if (Number.isNaN(n) || n === Math.trunc(n)) return 0;
    const a = Math.abs(n);
    if (a < 1e-3 || a >= 1e7) return -2;
    const str = String(n), at = str.indexOf('.');
    return at < 0 ? 0 : Math.min(4, str.length - at - 1);
  }
  /** Tools.getDecimalPlaces(n1, n2). */
  function decimalPlaces2(n1, n2) {
    if (n1 === Math.trunc(n1) && n2 === Math.trunc(n2)) return 0;
    const a = decimalPlaces(n1), b = decimalPlaces(n2);
    if (a === 0) return b;
    if (b === 0) return a;
    if (a < 0 || b < 0) return a;
    return b > a ? b : a;
  }
  /** ImageWindow.d2s(double): d2s(n, min(2, getDecimalPlaces(n))). */
  function d2sAuto(n) { return d2s(n, Math.min(2, decimalPlaces(n))); }
  /** ImageWindow.getImageSize: '768K', '6.3MB', '75MB', '1.2GB' (a trailing '.0' is dropped). */
  function imageSizeText(bytes) {
    const k = bytes / 1024;
    let s, u;
    if (k < 1024) { s = d2s(k, 0); u = 'K'; }
    else if (k < 10000) { s = d2s(k / 1024, 1); u = 'MB'; }
    else if (k < 1048576) { s = d2s(Math.round(k / 1024), 0); u = 'MB'; }
    else { s = d2s(k / 1048576, 1); u = 'GB'; }
    if (s.endsWith('.0')) s = s.slice(0, -2);
    return s + u;
  }
  /** Calibration.getUnits(): the plural form ImageJ prints in the subtitle. */
  function pluralUnit(u) { return u === 'pixel' ? 'pixels' : u === 'micron' ? 'microns' : u === 'inch' ? 'inches' : u; }

  // ---- stacks: ij.gui.StackWindow, ij.plugin.Animator, ij.ImagePlus.convertIndexToPosition ----
  /** { nC, nZ, nT, n } of an image info; nC is 1 for an RGB image, a pre-stack info (no nZ / nT) is one plane. */
  function stackDimsOf(info) {
    const i = info || {};
    const ch = i.channels;
    const count = typeof i.nC === 'number' ? i.nC : (Array.isArray(ch) ? ch.length : (typeof ch === 'number' ? ch : 1));
    const nC = i.rgb ? 1 : Math.max(1, count | 0);
    const nZ = Math.max(1, (i.nZ | 0) || 1), nT = Math.max(1, (i.nT | 0) || 1);
    return { nC, nZ, nT, n: nC * nZ * nT };
  }
  /** ImageJ's type of an info: 24 for RGB, else the storage depth. */
  function ijBitDepth(info) {
    if (!info) return 0;
    if (typeof info.bitDepthIJ === 'number') return info.bitDepthIJ;
    return info.rgb ? 24 : info.bitDepth;
  }
  /** The channel an info shows (composite: the active one for the stack index). */
  function activeChannelOf(info) {
    if (!info || info.rgb) return 0;
    const a = info.display && Number.isInteger(info.display.active) ? info.display.active : (Number.isInteger(info.active) ? info.active : 0);
    return Math.max(0, Math.min(stackDimsOf(info).nC - 1, a));
  }
  /** ImagePlus.getStackIndex: n = t*nC*nZ + z*nC + c + 1 (1-based). */
  function stackIndexOf(d, c, z, t) { return t * d.nC * d.nZ + z * d.nC + c + 1; }
  /** ImagePlus.convertIndexToPosition: the inverse of stackIndexOf (0-based c, z, t). */
  function positionOfIndex(d, n) {
    const i = n - 1;
    return { c: i % d.nC, z: Math.floor(i / d.nC) % d.nZ, t: Math.floor(i / (d.nC * d.nZ)) };
  }
  /** A position clamped into the image: { c, z, t } (0-based; a missing or non-finite one is 0). */
  function clampPosition(info, pos) {
    const d = stackDimsOf(info), p = pos || {};
    const cl = (v, hi) => { const x = Number.isFinite(v) ? Math.floor(v) : 0; return x < 0 ? 0 : (x > hi ? hi : x); };
    return { c: cl(p.c, d.nC - 1), z: cl(p.z, d.nZ - 1), t: cl(p.t, d.nT - 1) };
  }
  /** ImagePlus.isHyperStack() || isComposite(): a hyperstack, or any image with more than one channel (a CompositeImage shows c / z / t). */
  function isDimensionAware(info) {
    return !!(info && info.hyperstack) || stackDimsOf(info).nC > 1;
  }
  /** ImageStack.getShortSliceLabel(n): up to the first newline, a 3-letter extension dropped, at most 60 characters; null = none. */
  function shortSliceLabel(label) {
    if (typeof label !== 'string') return null;
    let s = label;
    const nl = s.indexOf('\n');
    if (nl === 0) return null;
    if (nl > 0) s = s.slice(0, nl);
    const len = s.length;
    if (len > 4 && s.charAt(len - 4) === '.' && !/[0-9]/.test(s.charAt(len - 1))) s = s.slice(0, len - 4);
    if (s.length > 60) s = s.slice(0, 60);
    return s;
  }
  /**
   * ImageWindow.createSubtitle / StackWindow.createSubtitle (ImageJ 1.54p):
   *   plain stack   '5/25 (label); 512x512 pixels; 8-bit; 6.3MB'        one image   '512x512 pixels; 8-bit; 768K'
   *   hyperstack    'c:1/3 z:5/25 t:2/10 (label); 512x512 pixels; 16-bit; 75MB'
   * opts.label = the label of the current slice (stack.getSliceLabel), opts.running = an animation runs (only the position is shown).
   */
  function formatSubtitle(info, opts) {
    if (!info) return '';
    const o = opts || {};
    const d = stackDimsOf(info);
    const aware = isDimensionAware(info);
    const bd = ijBitDepth(info);
    const c = activeChannelOf(info);
    const z = Math.max(0, Math.min(d.nZ - 1, info.z | 0)), t = Math.max(0, Math.min(d.nT - 1, info.t | 0));
    let s = '';
    if (d.n > 1) {
      s = stackIndexOf(d, c, z, t) + '/' + d.n;
      let label = shortSliceLabel(o.label);
      if (label !== null && label.length > 0) {
        if (aware) label = label.replace(/;/g, ' ');
        s += ' (' + label + ')';
      }
      if (o.running) return aware ? hyperPrefix(d, c, z, t) : s;
      s += '; ';
    } else {
      let label = typeof o.label === 'string' ? o.label : '';
      if (label.length > 0) {
        const nl = label.indexOf('\n');
        if (nl > 0) label = label.slice(0, nl);
        const len = label.length;
        if (len > 4 && label.charAt(len - 4) === '.' && !/[0-9]/.test(label.charAt(len - 1))) label = label.slice(0, len - 4);
        if (label.length > 60) label = label.slice(0, 60) + '...';
        s = '"' + label + '"; ';
      }
    }
    const cal = info.calibration;
    const unit = cal && cal.unit ? cal.unit : 'pixel';
    const pw = cal && cal.pixelWidth > 0 ? cal.pixelWidth : 1, ph = cal && cal.pixelHeight > 0 ? cal.pixelHeight : 1, pd = cal && cal.pixelDepth > 0 ? cal.pixelDepth : 1;
    if (pw !== 1 || ph !== 1 || pd !== 1 || unit !== 'pixel') {
      const w = info.width * pw, h = info.height * ph;
      const digits = Math.min(2, decimalPlaces2(w, h));
      // the x and y units are the one unit of this plugin's calibration
      s += `${d2s(w, digits)}x${d2s(h, digits)} ${pluralUnit(unit)} (${info.width}x${info.height}); `;
    } else s += `${info.width}x${info.height} pixels; `;
    s += bd === 24 ? 'RGB' : bd + '-bit';
    if (!info.rgb && d.nC === 1 && info.channels && info.channels[0] && info.channels[0].display && info.channels[0].display.invert) s += ' (inverting LUT)';
    const bpp = bd === 8 ? 1 : bd === 16 ? 2 : 4;
    s += '; ' + imageSizeText(info.width * info.height * d.n * bpp);
    if (!(d.n > 1 && aware)) return s;
    // StackWindow: the prefix 'c:1/3 z:5/25 t:2/10', then what follows the label of the plain subtitle
    let pre = hyperPrefix(d, c, z, t);
    let sub = s;
    let at = sub.indexOf(';');
    if (at !== -1) {
      const p = sub.indexOf('(');
      if (p >= 0 && p < at && sub.length > p + 4 && sub.substring(p + 1, p + 4) !== 'ch:') { at = p; pre += ' '; }
      sub = sub.substring(at);
    } else sub = '';
    return pre + sub;
  }
  function hyperPrefix(d, c, z, t) {
    let s = '';
    if (d.nC > 1) { s += 'c:' + (c + 1) + '/' + d.nC; if (d.nZ > 1 || d.nT > 1) s += ' '; }
    if (d.nZ > 1) { s += 'z:' + (z + 1) + '/' + d.nZ; if (d.nT > 1) s += ' '; }
    if (d.nT > 1) s += 't:' + (t + 1) + '/' + d.nT;
    return s;
  }

  /**
   * The slider rows under a view (StackWindow): hyperstack (and a composite) c / z / t, one row per dimension > 1; any other
   * stack ONE slider over its planes (a composite plain stack: the channel row, then that slider). `animated` = the row the play
   * button belongs to (t when there are frames, else z; the single slider of a plain stack).
   * -> [{ dim: 'c'|'z'|'t'|'n', letter, max, value (1-based), animated }]
   */
  function stackRows(info, pos) {
    const d = stackDimsOf(info);
    if (d.n <= 1) return [];
    const p = clampPosition(info, pos || { c: activeChannelOf(info), z: info && info.z, t: info && info.t });
    const rows = [];
    if (isDimensionAware(info)) {
      if (d.nC > 1) rows.push({ dim: 'c', letter: 'c', max: d.nC, value: p.c + 1, animated: false });
      if (d.nZ > 1) rows.push({ dim: 'z', letter: 'z', max: d.nZ, value: p.z + 1, animated: d.nT === 1 });
      if (d.nT > 1) rows.push({ dim: 't', letter: 't', max: d.nT, value: p.t + 1, animated: true });
    } else {
      if (d.nC > 1) rows.push({ dim: 'c', letter: 'c', max: d.nC, value: p.c + 1, animated: false });
      rows.push({ dim: 'n', letter: d.nC > 1 ? 'z' : '', max: d.nZ * d.nT, value: p.t * d.nZ + p.z + 1, animated: true });
    }
    return rows;
  }
  /** The position after the slider of `row` moved to `value` (1-based). */
  function positionFromRow(info, pos, row, value) {
    const d = stackDimsOf(info);
    const cur = clampPosition(info, pos);
    const v = Math.max(1, Math.min(row.max, Math.floor(Number.isFinite(value) ? value : 1))) - 1;
    if (row.dim === 'c') return { c: v, z: cur.z, t: cur.t };
    if (row.dim === 'z') return { c: cur.c, z: v, t: cur.t };
    if (row.dim === 't') return { c: cur.c, z: cur.z, t: v };
    return { c: cur.c, z: v % d.nZ, t: Math.floor(v / d.nZ) };
  }
  /**
   * Animator.nextSlice / previousSlice: on a displayed hyperstack the channel moves first (unless Ctrl / Space / Alt is held and there
   * is another dimension), then the slices (Alt with frames: the frames), then the frames; any other stack moves its slice (Alt: ±10).
   * Never wraps. -> the new position, or null when nothing moves.
   */
  function stepPosition(info, pos, dir, mods) {
    const d = stackDimsOf(info);
    if (d.n <= 1) return null;
    const m = mods || {};
    const down = m.ctrl || m.space || m.alt;
    const cur = clampPosition(info, pos);
    const dlt = dir < 0 ? -1 : 1;
    const mv = (v, hi, step) => Math.max(0, Math.min(hi, v + dlt * step));
    let out;
    // The channel bar has an "all channels" position (display mode COMPOSITE): there the keys move the slice (frame when there is one
    // slice); the channel steps only while the bar stands on a single channel (display.mode 'color' | 'gray')
    const single = !(info && info.display && info.display.mode === 'composite');
    if (isDimensionAware(info) && d.nC > 1 && single && !((d.nZ > 1 || d.nT > 1) && down)) out = { c: mv(cur.c, d.nC - 1, 1), z: cur.z, t: cur.t };
    else if (isDimensionAware(info) && d.nZ > 1 && !(d.nT > 1 && m.alt)) out = { c: cur.c, z: mv(cur.z, d.nZ - 1, 1), t: cur.t };
    else if (isDimensionAware(info) && d.nT > 1) out = { c: cur.c, z: cur.z, t: mv(cur.t, d.nT - 1, 1) };
    else {
      const planes = d.nZ * d.nT, idx = mv(cur.t * d.nZ + cur.z, planes - 1, m.alt ? 10 : 1);
      out = { c: cur.c, z: idx % d.nZ, t: Math.floor(idx / d.nZ) };
    }
    return out.c === cur.c && out.z === cur.z && out.t === cur.t ? null : out;
  }
  /**
   * The wheel over a stack window moves one slice per notch (z, else t; a window that only has channels keeps zooming). A deliberate
   * deviation from StackWindow.mouseWheelMoved, which runs "Next Slice [>]" and so moves the channel first: with the channel bar the
   * wheel is the quick way through the slices and never changes the channel (the keys > < . , keep ImageJ's channel-first order).
   */
  function wheelPosition(info, pos, steps) {
    const d = stackDimsOf(info);
    if (d.nZ * d.nT <= 1 || !steps) return null;
    const cur = clampPosition(info, pos);
    const dim = isDimensionAware(info) ? (d.nZ > 1 ? 'z' : 't') : "n";
    const planes = d.nZ * d.nT;
    const mv = (v, hi) => Math.max(0, Math.min(hi, v + steps));
    let out;
    if (dim === 'c') out = { c: mv(cur.c, d.nC - 1), z: cur.z, t: cur.t };
    else if (dim === 'z') out = { c: cur.c, z: mv(cur.z, d.nZ - 1), t: cur.t };
    else if (dim === 't') out = { c: cur.c, z: cur.z, t: mv(cur.t, d.nT - 1) };
    else { const idx = mv(cur.t * d.nZ + cur.z, planes - 1); out = { c: cur.c, z: idx % d.nZ, t: Math.floor(idx / d.nZ) }; }
    return out.c === cur.c && out.z === cur.z && out.t === cur.t ? null : out;
  }
  /** The animated range and step of Animation Options (Calibration.fps default 7, first / last of the animated dimension, loop back and forth). */
  function animationPlan(info, opts) {
    const d = stackDimsOf(info);
    const rows = stackRows(info);
    const row = rows.find((r) => r.animated) || null;
    const o = opts || {};
    const max = row ? row.max : 1;
    const first = Math.max(1, Math.min(max, Math.floor(o.first > 0 ? o.first : 1)));
    const last = Math.max(first, Math.min(max, Math.floor(o.last > 0 ? o.last : max)));
    const fps = o.fps > 0 ? o.fps : 7;
    return { dim: row ? row.dim : null, row, first, last, fps, loop: o.loop !== false, backAndForth: !!o.backAndForth, n: d.n };
  }
  /** The next value (1-based) of an animation: [first, last], forward, or back and forth; `dir` is the direction it is going. */
  function animationNext(plan, value, dir) {
    if (plan.last <= plan.first) return { value: plan.first, dir: 1 };
    let v = value + dir;
    let d = dir;
    if (plan.backAndForth) {
      if (v > plan.last) { d = -1; v = plan.last - 1; }
      else if (v < plan.first) { d = 1; v = plan.first + 1; }
    } else if (v > plan.last) v = plan.first;
    else if (v < plan.first) v = plan.last;
    return { value: Math.max(plan.first, Math.min(plan.last, v)), dir: d };
  }
  /**
   * An ROI / overlay item position against the current one, as ImageJ ties a selection to a plane: `n` (Roi.getPosition, the 1-based
   * stack index of a plain stack) or { c, z, t } (Roi.setPosition(c, z, t), 1-based, 0 = any). Shown when every given field is the one on
   * screen (ImageCanvas.showAllROIs "associate with slices").
   */
  function positionMatches(roiPos, info, pos) {
    if (!roiPos) return true;
    const d = stackDimsOf(info);
    if (d.n <= 1) return true;
    const cur = clampPosition(info, pos);
    if (roiPos.n > 0 && roiPos.n !== stackIndexOf(d, cur.c, cur.z, cur.t)) return false;
    return (!roiPos.c || roiPos.c === cur.c + 1) && (!roiPos.z || roiPos.z === cur.z + 1) && (!roiPos.t || roiPos.t === cur.t + 1);
  }
  /**
   * The position a ROI added now takes, as Roi.setPosition(ImagePlus) (ImageJ 1.54p bytecode) does it: on a hyperstack or a composite
   * { c, z, t } (1-based) with c = 0 ("every channel") while the display mode is COMPOSITE, else the active channel, and z / t the
   * current slice / frame even when that dimension has one; any other stack { n } = the ImageJ stack index (Roi.setPosition(int), the
   * number the .roi header carries). `mode` = the display mode ('composite' | 'color' | 'gray'); null on a single image.
   */
  function roiPositionFor(info, pos, mode) {
    const d = stackDimsOf(info);
    if (d.n <= 1) return null;
    const cur = clampPosition(info, pos);
    if (isDimensionAware(info)) {
      const m = mode || (info && info.display && info.display.mode) || (info && info.mode) || 'composite';
      return { c: d.nC > 1 && m === 'composite' ? 0 : cur.c + 1, z: cur.z + 1, t: cur.t + 1 };
    }
    return { n: stackIndexOf(d, 0, cur.z, cur.t) };
  }
  /** A request coalescer: at most one `send(value)` in flight, the LAST value requested while it runs is sent next (last wins). */
  function createCoalescer(send) {
    let pending, has = false, busy = false, idle = null;
    async function pump() {
      if (busy) return;
      busy = true;
      try {
        while (has) {
          const v = pending; has = false; pending = undefined;
          try { await send(v); } catch (e) { console.error('IJ position', e); }
        }
      } finally {
        busy = false;
        if (idle) { const f = idle; idle = null; f(); }
      }
    }
    return {
      request(v) { pending = v; has = true; pump(); },
      /** resolves once nothing is pending or in flight */
      flush() { return busy || has ? new Promise((res) => { const prev = idle; idle = () => { if (prev) prev(); res(); }; }) : Promise.resolve(); },
      get busy() { return busy || has; }
    };
  }

  function _fmtValue(v, bitDepth) {
    if (v === null || v === undefined) return '';
    if (bitDepth === 32) return Number.isFinite(v) ? String(Number(Number(v).toPrecision(6))) : String(v);
    return String(Math.round(v));
  }

  /** 'x=123, y=45 (12.3, 4.5 µm), value=12,45,0' */
  function formatStatus({ x, y, z, calibration, values, bitDepth, labels = {} }) {
    let s = `${labels.x || 'x'}=${x}, ${labels.y || 'y'}=${y}`;
    if (calibration && calibration.unit && calibration.pixelWidth > 0 && (calibration.pixelWidth !== 1 || calibration.pixelHeight !== 1)) {
      s += ` (${_fmtCal(x * calibration.pixelWidth)}, ${_fmtCal(y * calibration.pixelHeight)} ${calibration.unit})`;
    }
    // ImagePlus.getLocationAsString: ', z=' + the slice (0-based) on a stack, the calibrated depth then the index in brackets
    if (Number.isInteger(z)) {
      const pd = calibration && calibration.pixelDepth > 0 ? calibration.pixelDepth : 1;
      const zc = (z - (calibration && Number.isFinite(calibration.zOrigin) ? calibration.zOrigin : 0)) * pd;
      s += calibration && calibration.unit && zc !== z ? `, ${labels.z || 'z'}=${d2sAuto(zc)} (${z})` : `, ${labels.z || 'z'}=${z}`;
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
      case 'angle': {
        // PolygonRoi.getAngleAsString: "degrees = Math.abs(180-Math.abs(angle1-angle2)); if (degrees>180.0) degrees = 360.0-degrees;"
        const q = roi.points || [];
        if (q.length === 3) {
          const pw = cal ? cal.pixelWidth : 1, ph = cal ? cal.pixelHeight : 1;
          const ang = (a, b) => (180.0 / Math.PI) * Math.atan2((a[1] - b[1]) * ph, (b[0] - a[0]) * pw);
          let deg = Math.abs(180 - Math.abs(ang(q[0], q[1]) - ang(q[1], q[2])));
          if (deg > 180) deg = 360 - deg;
          return `angle=${_fmtCal(Math.round(deg * 100) / 100)}`;
        }
        return `n=${q.length}`;
      }
      case 'polyline': {
        const q = roi.points || [];
        let len = 0;
        for (let i = 1; i < q.length; i++) len += Math.hypot((q[i][0] - q[i - 1][0]) * (cal ? cal.pixelWidth : 1), (q[i][1] - q[i - 1][1]) * (cal ? cal.pixelHeight : 1));
        return `n=${q.length}, length=${_fmtCal(len)}${cal ? ' ' + cal.unit : ''}`;
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
    parseNumber, formatNumber, collectFields, dialogEventDecision, clampWindowPos, FIELD_TYPES, fieldProblems, effectiveOptions,
    numberStep, clampPopupX, clampPopupY, submenuX, centreX,
    roiBounds, translateRoi, isAreaRoi, roiFromDrag, lineFromDrag, roiHandles, handleAt, hitRoi, moveHandle, handleCursor,
    formatZoomPct, formatSize, formatSubtitle, formatStatus, describeRoi,
    d2s, decimalPlaces, decimalPlaces2, imageSizeText, shortSliceLabel,
    stackDimsOf, ijBitDepth, stackIndexOf, positionOfIndex, clampPosition, isDimensionAware, stackRows, positionFromRow,
    stepPosition, wheelPosition, animationPlan, animationNext, positionMatches, roiPositionFor, createCoalescer
  };
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
    // z-index bands (never leave their band): image windows 10-29, tool windows 30-49, menus 60, dialogs 80
    const toolStack = [];
    const applyToolZ = () => { toolStack.forEach((w, i) => { w.el.style.zIndex = String(30 + Math.min(i, 19)); }); };
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
     * dialog({ title | titleKey, fields, preview?, validate?, onChange?, okLabel, cancelLabel, noCancel?, nonModal?, signal? })
     *   field   = { type, id, label | labelKey, value, enabledIf?, visibleIf?, ... } — the types and
     *             their options are listed above IJViewPure.FIELD_TYPES; a spec with an unknown type,
     *             a missing id / label or an option-less choice is REFUSED (rejects IJ_BAD_DIALOG).
     *   validate(values) → { fieldId: errKey } | null   cross-field check; the key is a lang key, the
     *             message shows under the fields and OK stays refused.
     *   onChange(values, set, changedId)   after every edit of the operator (changedId = the field he edited);
     *             set({ id: value }) updates the other fields (a derived field: pixels ↔ unit).
     *   preview = { onChange(values | null, ctl) }  adds a Preview box; values while it is ticked (valid,
     *             debounced), null when it is unticked or the dialog closes; ctl.note(text | null)
     *             shows a line under the box ("zoom in to preview").
     * A dialog with a preview (or nonModal: true) does not block the image behind it: it is draggable
     * and the operator can pan and zoom the image while previewing. -> Promise<values | null>.
     */
    function dialog(spec = {}) {
      if (destroyed) return Promise.resolve(null);
      // spec.signal (AbortSignal): the dialog closes as cancelled when it aborts (a macro run that ends takes its dialogs with it)
      const signal = spec.signal && typeof spec.signal.addEventListener === 'function' ? spec.signal : null;
      if (signal && signal.aborted) return Promise.resolve(null);
      const d = doc();
      const fields = spec.fields || [];
      const problems = P.fieldProblems(fields);
      if (problems.length) {
        console.error('IJWindows.dialog: refused spec', problems);
        return Promise.reject(Object.assign(new Error('bad dialog spec'), { code: 'IJ_BAD_DIALOG', details: problems }));
      }
      const nonModal = !!(spec.preview || spec.nonModal);
      const title = spec.titleKey ? t(spec.titleKey, spec.title || spec.titleKey) : (spec.title || '');
      const id = 'ij-dlg-' + (++uid);
      const previous = d.activeElement;

      const backdrop = newBackdrop();
      if (nonModal) { backdrop.style.pointerEvents = 'none'; backdrop.classList.add('ij-dialog-backdrop--clear'); }
      const box = d.createElement('div');
      box.className = 'ij-dialog';
      box.style.position = 'absolute';
      if (nonModal) box.style.pointerEvents = 'auto';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', nonModal ? 'false' : 'true');
      box.setAttribute('aria-labelledby', id + '-title');
      box.tabIndex = -1;
      const head = d.createElement('div');
      head.className = 'ij-dialog-title';
      head.id = id + '-title';
      head.textContent = title;
      const body = d.createElement('div');
      body.className = 'ij-dialog-body';

      const labelOf = (f) => (f.labelKey ? t(f.labelKey, f.label || f.labelKey) : (f.label || ''));
      const optValue = (o) => (o && typeof o === 'object' ? o.value : o);
      const optLabel = (o) => (o && typeof o === 'object' ? (o.labelKey ? t(o.labelKey, o.label || String(o.value)) : (o.label ?? String(o.value))) : String(o));
      const clear = (el) => { if (el.firstChild !== undefined) { while (el.firstChild) el.removeChild(el.firstChild); } else el.textContent = ''; };
      const fillSelect = (sel, options, value) => {
        clear(sel);
        for (const o of options) {
          const opt = d.createElement('option');
          opt.value = String(optValue(o));
          opt.textContent = optLabel(o);
          if (o && typeof o === 'object' && o.disabled) opt.disabled = true;
          sel.appendChild(opt);
        }
        sel.value = String(value ?? '');
      };
      const initialRaw = () => {
        const raw = {};
        for (const f of fields) if (f.type !== 'message') raw[f.id] = f.value;
        return raw;
      };

      const controls = {};   // id → the control (a radio group: its container)
      const radios = {};     // id → [radio inputs]
      const fieldEls = {};   // id → the row
      const outputs = {};    // id → the <output> of a slider
      fields.forEach((f, i) => {
        const fid = `${id}-f${i}`;
        const row = d.createElement('div');
        row.className = 'ij-field ij-field--' + f.type;
        fieldEls[f.id] = row;
        if (f.type === 'message') {
          const p = d.createElement('p');
          p.className = 'ij-dialog-message';
          p.textContent = labelOf(f) || String(f.value || '');
          row.appendChild(p);
          body.appendChild(row);
          return;
        }
        const label = d.createElement('label');
        label.className = 'ij-field-label';
        label.htmlFor = fid;
        label.textContent = labelOf(f);
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
              const step = P.numberStep(f) * (e.key === 'ArrowUp' ? 1 : -1);
              let v = p.value + step;
              if (Number.isFinite(f.min)) v = Math.max(f.min, v);
              if (Number.isFinite(f.max)) v = Math.min(f.max, v);
              ctrl.value = P.formatNumber(Math.round(v * 1e9) / 1e9, f.decimals);
              e.preventDefault();
              ctrl.dispatchEvent(new Event('input', { bubbles: true }));
            });
          }
        } else if (f.type === 'textarea') {
          ctrl = d.createElement('textarea');
          ctrl.rows = f.rows > 0 ? f.rows : 4;
          ctrl.value = String(f.value ?? '');
          ctrl.spellcheck = false;
          if (f.monospace) ctrl.classList.add('ij-mono');
        } else if (f.type === 'slider') {
          ctrl = d.createElement('input');
          ctrl.type = 'range';
          ctrl.min = String(f.min ?? 0); ctrl.max = String(f.max ?? 100); ctrl.step = String(f.step ?? 1);
          ctrl.value = String(f.value ?? f.min ?? 0);
        } else if (f.type === 'choice' || f.type === 'doc' || f.type === 'channel') {
          ctrl = d.createElement('select');
          fillSelect(ctrl, P.effectiveOptions(f, initialRaw()), f.value);
        } else if (f.type === 'radio') {
          ctrl = d.createElement('span');
          ctrl.className = 'ij-radio-group';
          ctrl.setAttribute('role', 'radiogroup');
          radios[f.id] = [];
          (f.options || []).forEach((o, k) => {
            const lab = d.createElement('label');
            lab.className = 'ij-radio';
            const r = d.createElement('input');
            r.type = 'radio'; r.name = fid; r.value = String(optValue(o)); r.id = fid + '-r' + k;
            r.checked = String(optValue(o)) === String(f.value ?? '');
            const txt = d.createElement('span');
            txt.textContent = optLabel(o);
            lab.appendChild(r); lab.appendChild(txt);
            ctrl.appendChild(lab);
            radios[f.id].push(r);
          });
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
        wrap.appendChild(ctrl);
        if (f.type === 'slider') {
          const out = d.createElement('output');
          out.className = 'ij-field-value';
          out.htmlFor = fid;
          out.textContent = ctrl.value;
          ctrl.addEventListener('input', () => { out.textContent = ctrl.value; });
          outputs[f.id] = out;
          wrap.appendChild(out);
        }
        if (f.units || f.unitsKey) {
          const u = d.createElement('span');
          u.className = 'ij-field-units';
          u.textContent = f.unitsKey ? t(f.unitsKey, f.units || f.unitsKey) : f.units;
          wrap.appendChild(u);
        }
        if (f.type === 'check') { row.appendChild(wrap); row.appendChild(label); }
        else { row.appendChild(label); row.appendChild(wrap); }
        body.appendChild(row);
      });

      const errorEl = d.createElement('div');
      errorEl.className = 'ij-dialog-error';
      errorEl.setAttribute('role', 'alert');
      errorEl.hidden = true;
      body.appendChild(errorEl);

      let previewBox = null, noteEl = null;
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
        noteEl = d.createElement('p');
        noteEl.className = 'ij-dialog-note';
        noteEl.hidden = true;
        body.appendChild(noteEl);
      }
      const previewCtl = { note(text) { if (!noteEl) return; noteEl.textContent = text || ''; noteEl.hidden = !text; } };

      const buttons = d.createElement('div');
      buttons.className = 'ij-dialog-buttons';
      const okBtn = button(spec.okLabel || t('view.ok', 'OK'), 'ij-btn--primary', () => commit());
      const cancelBtn = button(spec.cancelLabel || t('view.cancel', 'Cancel'), '', () => finish(null));
      // spec.noCancel: OK alone (ImageJ's GenericDialog.hideCancelButton; Escape and the close box still cancel)
      if (spec.noCancel !== true) buttons.appendChild(cancelBtn);
      buttons.appendChild(okBtn);

      box.appendChild(head); box.appendChild(body); box.appendChild(buttons);
      backdrop.appendChild(box);

      const readRaw = () => {
        const raw = {};
        for (const f of fields) {
          const c = controls[f.id];
          if (!c) continue;
          if (f.type === 'check') raw[f.id] = c.checked;
          else if (f.type === 'radio') { const on = (radios[f.id] || []).find((r) => r.checked); raw[f.id] = on ? on.value : ''; }
          else raw[f.id] = c.value;
        }
        return raw;
      };
      const setControl = (fid, v) => {
        const f = fields.find((x) => x.id === fid), c = controls[fid];
        if (!f || !c) return;
        if (f.type === 'number') { if (Number.isFinite(Number(v))) c.value = P.formatNumber(Number(v), f.decimals); }
        else if (f.type === 'check') c.checked = !!v;
        else if (f.type === 'radio') (radios[fid] || []).forEach((r) => { r.checked = r.value === String(v); });
        else { c.value = String(v ?? ''); if (outputs[fid]) outputs[fid].textContent = c.value; }
      };

      // A channel field lists the channels of the document its doc field names now.
      const syncChannelOptions = () => {
        const raw = readRaw();
        for (const f of fields) {
          if (f.type !== 'channel' || !f.docField || !f.optionsByDoc || !controls[f.id]) continue;
          const wanted = P.effectiveOptions(f, raw);
          const sel = controls[f.id];
          const sig = wanted.map((o) => String(optValue(o))).join('|');
          if (sel._sig === sig) continue;
          const keep = sel.value;
          sel._sig = sig;
          fillSelect(sel, wanted, wanted.some((o) => String(optValue(o)) === keep) ? keep : (wanted[0] ? optValue(wanted[0]) : ''));
        }
      };

      // enabledIf / visibleIf: a hidden field is not validated and keeps its initial value.
      const hiddenIds = new Set();
      const applyConditions = () => {
        for (let pass = 0; pass < 2; pass++) {
          const r = P.collectFields(fields, readRaw(), { hidden: hiddenIds });
          let changed = false;
          for (const f of fields) {
            const row = fieldEls[f.id];
            if (f.visibleIf && row) {
              let vis = true;
              try { vis = !!f.visibleIf(r.values); } catch (e) { console.error('IJWindows visibleIf', e); }
              if (vis === hiddenIds.has(f.id)) { changed = true; if (vis) hiddenIds.delete(f.id); else hiddenIds.add(f.id); }
              row.hidden = !vis;
            }
            if (f.enabledIf && controls[f.id]) {
              let on = true;
              try { on = !!f.enabledIf(r.values); } catch (e) { console.error('IJWindows enabledIf', e); }
              controls[f.id].disabled = !on;
              (radios[f.id] || []).forEach((rb) => { rb.disabled = !on; });
            }
          }
          if (!changed) break;
        }
      };

      const validate = () => {
        syncChannelOptions();
        applyConditions();
        const r = P.collectFields(fields, readRaw(), { hidden: hiddenIds });
        const msgs = {};
        for (const k of Object.keys(r.errors)) msgs[k] = t('view.invalid.' + r.errors[k], r.errors[k]);
        let ok = r.ok;
        if (r.ok && typeof spec.validate === 'function') {
          let v = null;
          try { v = spec.validate(r.values); } catch (e) { console.error('IJWindows validate', e); }
          if (v && typeof v === 'object') {
            for (const k of Object.keys(v)) { msgs[k] = t(v[k], String(v[k])); ok = false; }
          }
        }
        for (const f of fields) {
          const c = controls[f.id];
          if (!c) continue;
          const bad = msgs[f.id] !== undefined;
          c.classList.toggle('ij-invalid', bad);
          if (bad) { c.setAttribute('aria-invalid', 'true'); c.title = msgs[f.id]; }
          else { c.removeAttribute('aria-invalid'); c.removeAttribute('title'); }
        }
        const first = Object.keys(msgs)[0];
        errorEl.textContent = first !== undefined && ok === false && r.ok ? msgs[first] : '';
        errorEl.hidden = !errorEl.textContent;
        return { ok, values: r.values, errors: msgs };
      };

      let previewTimer = 0, closed = false, resolveFn, inSet = false;
      const firePreview = () => {
        if (!previewBox || !previewBox.checked) return;
        const r = P.collectFields(fields, readRaw(), { hidden: hiddenIds });
        if (r.ok) spec.preview.onChange(r.values, previewCtl);
      };
      const schedulePreview = () => {
        if (!previewBox) return;
        clearTimeout(previewTimer);
        previewTimer = setTimeout(firePreview, 100);
      };
      const set = (patch) => {
        inSet = true;
        try { for (const k of Object.keys(patch || {})) setControl(k, patch[k]); } finally { inSet = false; }
      };
      const idOfEl = new Map();
      for (const f of fields) {
        if (controls[f.id]) idOfEl.set(controls[f.id], f.id);
        for (const rb of radios[f.id] || []) idOfEl.set(rb, f.id);
      }
      const reported = new WeakMap();
      const onInput = (ev) => {
        const fresh = !!ev && P.dialogEventDecision(ev.type, ev.target, reported);
        if (fresh && !inSet && typeof spec.onChange === 'function') {
          syncChannelOptions();
          const r = P.collectFields(fields, readRaw(), { hidden: hiddenIds });
          const changed = ev && ev.target ? idOfEl.get(ev.target) : undefined;
          // Not while a field is invalid: a derived field computed from a half-typed number would print NaN.
          if (r.ok) { try { spec.onChange(r.values, set, changed); } catch (e) { console.error('IJWindows onChange', e); } }
        }
        validate();
        schedulePreview();
      };
      body.addEventListener('input', onInput);
      body.addEventListener('change', onInput);
      if (previewBox) {
        previewBox.addEventListener('change', () => {
          if (previewBox.checked) firePreview();
          else { spec.preview.onChange(null, previewCtl); previewCtl.note(null); }
        });
      }

      function commit() {
        const r = validate();
        if (!r.ok) {
          const firstBad = fields.find((f) => r.errors[f.id] !== undefined);
          if (firstBad && controls[firstBad.id]) controls[firstBad.id].focus();
          return;
        }
        finish(r.values);
      }

      function finish(values) {
        if (closed) return;
        closed = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        clearTimeout(previewTimer);
        d.removeEventListener('keydown', onKey, true);
        const idx = modalStack.indexOf(handle);
        if (idx >= 0) modalStack.splice(idx, 1);
        cleanupDrag();
        if (previewBox && spec.preview) { try { spec.preview.onChange(null, previewCtl); } catch (e) { console.error('IJWindows preview', e); } }
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        if (previous && previous.focus && d.contains(previous)) { try { previous.focus(); } catch (e) { /* gone */ } }
        resolveFn(values);
      }

      function onKey(e) {
        if (modalStack[modalStack.length - 1] !== handle) return;
        // A dialog that leaves the image usable (preview) only takes the keys typed inside it.
        if (nonModal && box.contains && e.target && !box.contains(e.target)) return;
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
      function onAbort() { finish(null); }
      if (signal) signal.addEventListener('abort', onAbort);
      modalStack.push(handle);
      mountPoint().appendChild(backdrop);
      const place = () => {
        const rb = rootBox();
        box.style.left = P.centreX(box.offsetWidth, rb.w) + 'px';
        box.style.top = Math.max(8, Math.round(rb.h * 0.12)) + 'px';
      };
      place();
      handle.place = place;
      const cleanupDrag = makeDraggable(box, head, null);
      d.addEventListener('keydown', onKey, true);
      validate();
      errorEl.hidden = true; errorEl.textContent = '';
      const firstCtrl = fields.map((f) => controls[f.id]).find((c) => c && !c.disabled);
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
        const place = () => {
          const rb = rootBox();
          box.style.left = P.centreX(box.offsetWidth, rb.w) + 'px';
          box.style.top = Math.max(8, Math.round(rb.h * 0.2)) + 'px';
        };
        place();
        handle.place = place;
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
      const titleId = 'ij-win-title-' + (++uid);
      const bar = d.createElement('div');
      bar.className = 'ij-window-title';
      const titleEl = d.createElement('span');
      titleEl.id = titleId;
      el.setAttribute('aria-labelledby', titleId);
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
      // a remembered size is applied BEFORE the position is clamped (a big one must not push the grip off-screen)
      let keptSize = null;
      if (saved && pos && Number.isFinite(pos.w) && Number.isFinite(pos.h)) {
        keptSize = { w: Math.max(200, Math.min(pos.w, box.w || pos.w)), h: Math.max(120, Math.min(pos.h, box.h || pos.h)) };
        el.style.width = keptSize.w + 'px'; el.style.height = keptSize.h + 'px';
      }
      const cp = P.clampWindowPos(pos.x, pos.y, el.offsetWidth, el.offsetHeight, box.w, box.h);
      el.style.left = Math.round(cp.x) + 'px';
      el.style.top = Math.round(cp.y) + 'px';
      const grip = d.createElement('div');
      grip.className = 'ij-resize-grip';
      grip.setAttribute('aria-hidden', 'true');
      el.appendChild(grip);
      // a drag stores the position only; the size is stored once the user resized the window by its grip
      const saveBox = (withSize) => {
        if (withSize) keptSize = { w: el.offsetWidth, h: el.offsetHeight };
        const o = { x: el.offsetLeft, y: el.offsetTop };
        if (keptSize) { o.w = keptSize.w; o.h = keptSize.h; }
        storageSet('lumen3d.ij.win.' + spec.id, JSON.stringify(o));
      };
      const cleanupDrag = makeDraggable(el, bar, () => saveBox(false));
      let rs = null;
      const gripDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        rs = { x: e.clientX, y: e.clientY, w: el.offsetWidth, h: el.offsetHeight };
        try { grip.setPointerCapture(e.pointerId); } catch (x) { /* synthetic */ }
      };
      const gripMove = (e) => {
        if (!rs) return;
        el.style.width = Math.max(200, Math.round(rs.w + e.clientX - rs.x)) + 'px';
        el.style.height = Math.max(120, Math.round(rs.h + e.clientY - rs.y)) + 'px';
      };
      const gripUp = () => { if (rs) { rs = null; saveBox(true); } };
      grip.addEventListener('pointerdown', gripDown); grip.addEventListener('pointermove', gripMove);
      grip.addEventListener('pointerup', gripUp); grip.addEventListener('pointercancel', gripUp);
      const raise = () => { const i = toolStack.indexOf(win); if (i >= 0) toolStack.push(toolStack.splice(i, 1)[0]); applyToolZ(); };
      el.addEventListener('pointerdown', raise);
      let open = true;
      const win = {
        id: spec.id, el, content,
        getTitle: () => titleEl.textContent,
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
          const si = toolStack.indexOf(win);
          if (si >= 0) toolStack.splice(si, 1);
          applyToolZ();
          grip.removeEventListener('pointerdown', gripDown); grip.removeEventListener('pointermove', gripMove);
          grip.removeEventListener('pointerup', gripUp); grip.removeEventListener('pointercancel', gripUp);
          cleanupDrag();
          el.removeEventListener('pointerdown', raise);
          closeBtn.removeEventListener('click', win.close);
          el.removeEventListener('keydown', onWinKey);
          // a closed window takes its focus with it: hand it back so the image shortcuts keep working
          const hadFocus = !!(el.contains && d.activeElement && el.contains(d.activeElement));
          if (el.parentNode) el.parentNode.removeChild(el);
          if (hadFocus && config.focusTarget) { try { config.focusTarget().focus({ preventScroll: true }); } catch (e) { /* gone */ } }
          if (spec.onClose) { try { spec.onClose(); } catch (e) { console.error('IJWindows onClose', e); } }
        }
      };
      const onWinKey = (e) => {
        if (e.key === 'Escape' && e.target && e.target.closest && !e.target.closest('input, select, textarea')) { e.stopPropagation(); win.close(); }
      };
      closeBtn.addEventListener('click', win.close);
      el.addEventListener('keydown', onWinKey);
      floatingMap.set(spec.id, win);
      toolStack.push(win);
      applyToolZ();
      return win;
    }

    /** Re-fits every open window and re-centres every open modal after the root changed size. */
    function reflow() {
      if (destroyed) return;
      for (const w of floatingMap.values()) w.move(w.el.offsetLeft, w.el.offsetTop);
      for (const h of modalStack) if (h.place) h.place();
    }
    let reflowObserver = null;
    const onWinResize = () => reflow();
    if (root && typeof ResizeObserver !== 'undefined') {
      reflowObserver = new ResizeObserver(onWinResize);
      reflowObserver.observe(root);
    } else {
      const v = doc().defaultView;
      if (v && v.addEventListener) { v.addEventListener('resize', onWinResize); reflowObserver = { disconnect: () => v.removeEventListener('resize', onWinResize) }; }
    }

    function closeAll() {
      for (const h of modalStack.slice()) h.close();
      for (const w of Array.from(floatingMap.values())) w.close();
    }
    function destroy() { closeAll(); destroyed = true; if (reflowObserver) { try { reflowObserver.disconnect(); } catch (e) { /* gone */ } reflowObserver = null; } root = null; }

    return {
      dialog, floating, confirm,
      hasModal: () => modalStack.length > 0,
      get: (id) => floatingMap.get(id) || null,
      /** Open tool / plot / table / panel windows, bottom to top: [{ id, title, win }]. */
      list: () => toolStack.map((w) => ({ id: w.id, title: w.getTitle(), win: w })),
      setRoot(r) { root = r; },
      closeAll, reflow, destroy
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
   IJPlot — the generic plot window's drawing and export
   ============================================================ */
/* openPlot(spec) of the extension API (ij-app.js) draws through this module. Pure except draw().
 *
 * spec = { title?, xLabel?, yLabel?,
 *   series:  [{ kind: 'line' | 'bars' | 'points', x: ArrayLike, y: ArrayLike, color?, label? }],
 *   image?:  { w, h, data: Float32Array (w·h, row 0 = the LOWEST y), logScale?, lut?: Uint8Array(768) | LUT name,
 *              xRange?: [x0, x1], yRange?: [y0, y1] }   a raster behind the series (a 2D histogram)
 *   overlays?: [{ kind: 'line', x1, y1, x2, y2, color? }]   in data coordinates (a regression line, a threshold)
 *   xRange?, yRange?: [lo, hi]   fixed axes
 *   csv?:    { columns: [name], rows: [[value]] }   what the CSV button saves (default: the series) }
 * Bars are centred on x, as wide as the smallest step between two x values (1 for one bar). */
const IJPlot = (() => {
  'use strict';

  const COLORS = ['#4e9bff', '#ff6b4e', '#46c46f', '#e0b43a', '#b070e0', '#38c8c8'];

  /** About `count` round tick values covering [lo, hi] (Heckbert's nice numbers). */
  function niceTicks(lo, hi, count) {
    const n = count > 1 ? count : 6;
    if (!(isFinite(lo) && isFinite(hi))) return [];
    if (hi < lo) { const t = lo; lo = hi; hi = t; }
    if (hi === lo) return [lo];
    const nice = (range, round) => {
      const exp = Math.floor(Math.log10(range)), f = range / Math.pow(10, exp);
      let nf;
      if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
      else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
      return nf * Math.pow(10, exp);
    };
    const step = nice(nice(hi - lo, false) / (n - 1), true);
    const out = [];
    const first = Math.ceil(lo / step - 1e-9) * step;
    for (let v = first; v <= hi + step * 1e-9 && out.length < 200; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)));
    return out;
  }

  function barWidth(x) {
    let w = Infinity;
    for (let i = 1; i < x.length; i++) { const d = Math.abs(x[i] - x[i - 1]); if (d > 0 && d < w) w = d; }
    return isFinite(w) ? w : 1;
  }

  /** Data extent of a spec: { x0, x1, y0, y1 } (fixed ranges win; bars include 0; never empty). */
  function extent(spec) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const add = (x, y) => {
      if (isFinite(x)) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
      if (isFinite(y)) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
    };
    for (const sr of spec.series || []) {
      const n = Math.min(sr.x ? sr.x.length : 0, sr.y ? sr.y.length : 0);
      const half = sr.kind === 'bars' ? barWidth(sr.x) / 2 : 0;
      for (let i = 0; i < n; i++) {
        add(sr.x[i] - half, sr.y[i]);
        if (half) add(sr.x[i] + half, 0);
      }
    }
    if (spec.image) {
      const im = spec.image, xr = im.xRange || [0, im.w], yr = im.yRange || [0, im.h];
      add(xr[0], yr[0]); add(xr[1], yr[1]);
    }
    for (const o of spec.overlays || []) { add(o.x1, o.y1); add(o.x2, o.y2); }
    if (spec.xRange) { x0 = spec.xRange[0]; x1 = spec.xRange[1]; }
    if (spec.yRange) { y0 = spec.yRange[0]; y1 = spec.yRange[1]; }
    if (!(x0 <= x1)) { x0 = 0; x1 = 1; }
    if (!(y0 <= y1)) { y0 = 0; y1 = 1; }
    if (x0 === x1) { x0 -= 0.5; x1 += 0.5; }
    if (y0 === y1) { y0 -= 0.5; y1 += 0.5; }
    return { x0, x1, y0, y1 };
  }

  function csvCell(v) {
    const s = v === undefined || v === null ? '' : (typeof v === 'number' ? String(v) : String(v));
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** The CSV the Save button writes: spec.csv, else the series (one table when they share their x). */
  function csvText(spec) {
    let columns, rows;
    if (spec.csv && Array.isArray(spec.csv.columns) && Array.isArray(spec.csv.rows)) { columns = spec.csv.columns; rows = spec.csv.rows; }
    else {
      const ser = (spec.series || []).filter((x) => x && x.x && x.y);
      const sameX = ser.length > 0 && ser.every((x) => x.x.length === ser[0].x.length && x.x.every((v, i) => v === ser[0].x[i]));
      if (sameX) {
        columns = [spec.xLabel || 'x'].concat(ser.map((x, i) => x.label || spec.yLabel || ('y' + (i + 1))));
        rows = Array.from(ser[0].x, (v, i) => [v].concat(ser.map((x) => x.y[i])));
      } else {
        columns = ['series', spec.xLabel || 'x', spec.yLabel || 'y'];
        rows = [];
        ser.forEach((x, k) => { for (let i = 0; i < Math.min(x.x.length, x.y.length); i++) rows.push([x.label || ('y' + (k + 1)), x.x[i], x.y[i]]); });
      }
    }
    return [columns.map(csvCell).join(',')].concat(rows.map((r) => Array.from(r, csvCell).join(','))).join('\n') + '\n';
  }

  const fmt = (v) => (Math.abs(v) >= 1e5 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(1) : String(Number(v.toPrecision(5))));

  /** Draws the spec on a 2D canvas (device pixels = canvas.width × canvas.height).
   *  opts = { fg, grid, bg, font, lut(name) → Uint8Array(768), dpr }. Returns the plot box. */
  function draw(canvas, spec, opts) {
    const o = opts || {};
    const g = canvas.getContext('2d');
    const dpr = o.dpr > 0 ? o.dpr : 1;
    const W = canvas.width, H = canvas.height;
    const fg = o.fg || '#ccc', grid = o.grid || 'rgba(128,128,128,0.35)';
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    if (o.bg) { g.fillStyle = o.bg; g.fillRect(0, 0, W, H); }
    const fs = Math.round(11 * dpr);
    g.font = fs + 'px sans-serif';
    const L = Math.round(54 * dpr), R = Math.round(12 * dpr), T = Math.round((spec.title ? 26 : 10) * dpr), B = Math.round(36 * dpr);
    const pw = W - L - R, ph = H - T - B;
    const box = { x: L, y: T, w: pw, h: ph };
    if (!(pw > 20 && ph > 20)) return box;
    const e = extent(spec);
    const X = (v) => L + ((v - e.x0) / (e.x1 - e.x0)) * pw;
    const Y = (v) => T + (1 - (v - e.y0) / (e.y1 - e.y0)) * ph;
    // the raster
    if (spec.image && spec.image.w > 0 && spec.image.h > 0 && spec.image.data && typeof document !== 'undefined') {
      const im = spec.image, xr = im.xRange || [0, im.w], yr = im.yRange || [0, im.h];
      let max = 0;
      for (let i = 0; i < im.data.length; i++) if (im.data[i] > max) max = im.data[i];
      const lut = im.lut instanceof Uint8Array ? im.lut : (o.lut ? o.lut(typeof im.lut === 'string' ? im.lut : 'Fire') : null);
      const off = document.createElement('canvas');
      off.width = im.w; off.height = im.h;
      const og = off.getContext('2d');
      const px = og.createImageData(im.w, im.h);
      const den = im.logScale ? Math.log1p(max) : max;
      for (let j = 0; j < im.h; j++) {
        for (let i = 0; i < im.w; i++) {
          const v = im.data[j * im.w + i];
          const k = ((im.h - 1 - j) * im.w + i) * 4; // row 0 is the lowest y: flip for the screen
          if (!(v > 0) || !(den > 0)) { px.data[k + 3] = 0; continue; }
          const q = Math.min(255, Math.max(0, Math.round(((im.logScale ? Math.log1p(v) : v) / den) * 255)));
          px.data[k] = lut ? lut[q * 3] : q; px.data[k + 1] = lut ? lut[q * 3 + 1] : q; px.data[k + 2] = lut ? lut[q * 3 + 2] : q; px.data[k + 3] = 255;
        }
      }
      og.putImageData(px, 0, 0);
      g.save();
      g.beginPath(); g.rect(L, T, pw, ph); g.clip();
      g.imageSmoothingEnabled = false;
      g.drawImage(off, X(xr[0]), Y(yr[1]), X(xr[1]) - X(xr[0]), Y(yr[0]) - Y(yr[1]));
      g.restore();
    }
    // grid + ticks
    g.lineWidth = 1; g.strokeStyle = grid; g.fillStyle = fg;
    g.textBaseline = 'middle'; g.textAlign = 'right';
    for (const v of niceTicks(e.y0, e.y1, 5)) { const y = Math.round(Y(v)) + 0.5; g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke(); g.fillText(fmt(v), L - 4 * dpr, y); }
    g.textBaseline = 'top'; g.textAlign = 'center';
    for (const v of niceTicks(e.x0, e.x1, 6)) { const x = Math.round(X(v)) + 0.5; g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke(); g.fillText(fmt(v), x, T + ph + 4 * dpr); }
    g.strokeStyle = fg; g.strokeRect(L + 0.5, T + 0.5, pw, ph);
    // series
    g.save();
    g.beginPath(); g.rect(L, T, pw, ph); g.clip();
    (spec.series || []).forEach((sr, k) => {
      const col = sr.color || COLORS[k % COLORS.length];
      const n = Math.min(sr.x ? sr.x.length : 0, sr.y ? sr.y.length : 0);
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = Math.max(1, dpr);
      if (sr.kind === 'bars') {
        const hw = barWidth(sr.x) / 2;
        const y0 = Y(Math.max(e.y0, Math.min(e.y1, 0)));
        for (let i = 0; i < n; i++) {
          const xa = X(sr.x[i] - hw), xb = X(sr.x[i] + hw), ya = Y(sr.y[i]);
          g.fillRect(xa, Math.min(ya, y0), Math.max(1, xb - xa), Math.abs(y0 - ya));
        }
      } else if (sr.kind === 'points') {
        const r = Math.max(1.5, 2 * dpr);
        for (let i = 0; i < n; i++) g.fillRect(X(sr.x[i]) - r / 2, Y(sr.y[i]) - r / 2, r, r);
      } else {
        g.beginPath();
        let pen = false;
        for (let i = 0; i < n; i++) {
          if (!isFinite(sr.y[i])) { pen = false; continue; }
          if (pen) g.lineTo(X(sr.x[i]), Y(sr.y[i])); else { g.moveTo(X(sr.x[i]), Y(sr.y[i])); pen = true; }
        }
        g.stroke();
      }
    });
    for (const ov of spec.overlays || []) {
      if (ov.kind !== 'line') continue;
      g.strokeStyle = ov.color || '#ffd400'; g.lineWidth = Math.max(1, dpr);
      g.beginPath(); g.moveTo(X(ov.x1), Y(ov.y1)); g.lineTo(X(ov.x2), Y(ov.y2)); g.stroke();
    }
    g.restore();
    // labels
    g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    if (spec.title) { g.font = 'bold ' + fs + 'px sans-serif'; g.fillText(String(spec.title), L + pw / 2, T - 8 * dpr); g.font = fs + 'px sans-serif'; }
    if (spec.xLabel) g.fillText(String(spec.xLabel), L + pw / 2, H - 4 * dpr);
    if (spec.yLabel) { g.save(); g.translate(10 * dpr, T + ph / 2); g.rotate(-Math.PI / 2); g.fillText(String(spec.yLabel), 0, 0); g.restore(); }
    return box;
  }

  return { niceTicks, extent, csvText, draw, barWidth, COLORS };
})();

/* ============================================================
   IJShell — ImageJ chrome and pointer handling
   ============================================================ */
const IJShell = (() => {
  'use strict';
  const P = IJViewPure;
  const SVGNS = 'http://www.w3.org/2000/svg';

  const DEFAULT_TOOLS = [
    { id: 'rect' }, { id: 'oval' }, { id: 'polygon' }, { id: 'freehand' }, { id: 'line' }, { id: 'polyline' }, { id: 'angle' }, { id: 'point' }, { id: 'wand' },
    { separator: true },
    { id: 'zoom' }, { id: 'hand' }
  ];
  const TOOL_FALLBACK = { rect: 'Rectangle', oval: 'Oval', polygon: 'Polygon', freehand: 'Freehand', line: 'Straight line', polyline: 'Segmented line', angle: 'Angle', point: 'Point', wand: 'Wand', zoom: 'Magnifying glass', hand: 'Scrolling hand' };
  const ROI_TOOLS = new Set(['rect', 'oval', 'polygon', 'freehand', 'line', 'polyline', 'angle', 'point', 'wand']);
  const ICONS = {
    rect: '<rect x="3.5" y="5.5" width="13" height="9"/>',
    oval: '<ellipse cx="10" cy="10" rx="7" ry="5"/>',
    polygon: '<path d="M4 14.5L6.5 5l8 1.5 2 7z"/>',
    freehand: '<path d="M3 13c2-7 4 3 6-2s3-5 5-1 2 3 3 2"/>',
    line: '<path d="M3.5 16L16.5 4"/>',
    polyline: '<path d="M3.5 15.5L8 7l4.5 6L16.5 4.5"/><circle cx="3.5" cy="15.5" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="7" r="1" fill="currentColor" stroke="none"/><circle cx="12.5" cy="13" r="1" fill="currentColor" stroke="none"/><circle cx="16.5" cy="4.5" r="1" fill="currentColor" stroke="none"/>',
    angle: '<path d="M16 15.5H4.5L14.5 5"/><path d="M10.5 15.5a6 6 0 00-1.7-4.2"/>',
    point: '<circle cx="10" cy="10" r="2"/><path d="M10 3v4M10 13v4M3 10h4M13 10h4"/>',
    wand: '<path d="M4 16L13 7"/><path d="M13 3v3M13 10v3M9.5 6.5h3M13.5 6.5h3M10.5 3.9l1.6 1.6M14 7.5l1.6 1.6M15.6 3.9l-1.6 1.6"/>',
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
   *   tools               [{ id, labelKey?, label?, icon?, cursor?, hidden?, ext? } | { separator: true }] (default: ImageJ's set);
   *                       `ext` = a tool of a package: its pointer events go to onToolPointer; `hidden` = no button until selected
   *   onCommand(cmd, { source: 'menu' | 'key', alt, shift })
   *   onTool(id)  onToolOptions(id)  (double-click on line / point)
   *   onRoi(roi | null, { final, source: 'draw' | 'move' | 'resize' | 'nudge' | 'clear' })
   *   onChannel(index, docId, mode?)   the channel bar moved: index = the active channel, mode = 'composite' ("all", position 0) | 'color' | 'gray'
   *   onCancel()
   *   readPixel(x, y) -> Promise<number[]>   coalesced, <= 1 in flight
   *   isActive()          false while the shell is hidden (shortcuts ignored)
   *   display             options for IJRenderer.create (onTileError, getLut, SVRManager, ...) + onViewChange(v, docId)
   *   onActivate(docId)   onCloseImage(docId)   onLayoutChange(kind)   selectionColor
   *   onToolPointer(docId, { type: 'down'|'move'|'up'|'cancel', x, y, button, shift, alt, ctrl })   image coordinates, while an `ext` tool is selected
   *   onMenuOpen(topName)   a top menu is about to open (the app refreshes its dynamic Window list)
   *   onCursor(docId, x, y, sx, sy)   the pointer over a view (image + stage pixel coordinates); onCursor(docId, null) when it leaves
   *   onPosition({ c, z, t }, docId)   the operator moved a stack slider / pressed > < , . / used the wheel (0-based; the view already shows it)
   *   onAnimate(docId, 'toggle')       the play button or the \ key   sliceLabel(docId, pos) → the label of that plane or null (subtitle)
   * shell: { el, workspace, layout (IJLayout), renderer, view(docId), activeView(), windows, setImage(info, {placement}), clearImage, setDisplayState, setTool, getTool,
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
    const wsHost = el('div', 'ij-workspace-host');
    wsHost.style.flex = '1 1 auto'; wsHost.style.minHeight = '0'; wsHost.style.display = 'flex'; wsHost.style.flexDirection = 'column'; wsHost.style.position = 'relative';
    const statusbar = el('div', 'ij-statusbar');
    statusbar.setAttribute('aria-label', t('view.statusbar', 'Status'));
    // only the message is a live region: the pointer readout changes on every move
    const statusPos = el('span', 'ij-status-pos');
    statusPos.setAttribute('aria-hidden', 'true');
    const statusText = el('span', 'ij-status-text');
    statusText.setAttribute('role', 'status');
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
    shell.append(menubar, toolbar, wsHost, statusbar);


    const windows = IJWindows.create({ root: shell, t: opts.t, focusTarget: () => focusTargetEl() });

    // ---- Renderer, layout, views ------------------------------------------------------------------------
    // ONE renderer (one WebGL2 context) for the whole app; one IJView + one pointer controller per document.
    const ctls = new Map();          // docId -> controller
    let activeDoc = null;
    const dopts = opts.display || {};
    const renderer = IJRenderer.create({ ...dopts, document: doc });
    function focusTargetEl() { const c = activeDoc !== null ? ctls.get(activeDoc) : null; return c ? c.stage : wsHost; }
    function activeCtl() { return activeDoc !== null ? ctls.get(activeDoc) || null : null; }

    function onViewChange(docId, v) {
      layout.setTabInfo(docId, { zoomPct: P.formatZoomPct(v.zoom) });
      const c = ctls.get(docId);
      if (c) c.badge.hidden = !(c.info && v.loading);
      if (dopts.onViewChange) dopts.onViewChange(v, docId);
    }

    function makePane(docId) {
      const pane = el('div', 'ij-pane');
      pane.style.display = 'flex'; pane.style.flexDirection = 'column'; pane.style.minHeight = '0'; pane.style.minWidth = '0'; pane.style.flex = '1 1 auto';
      const head = el('div', 'ij-pane-head');
      const subtitle = el('div', 'ij-subtitle');
      const badge = el('span', 'ij-title-badge', t('view.previewBadge', 'preview'));
      badge.hidden = true;
      head.append(subtitle, badge);
      const stage = el('div', 'ij-stage');
      stage.tabIndex = 0;
      stage.style.flex = '1 1 auto'; stage.style.minHeight = '0'; stage.style.position = 'relative';
      stage.dataset.docId = String(docId);
      stage.setAttribute('aria-label', t('view.stage', 'Image'));
      const channelBar = el('div', 'ij-channel-bar');
      channelBar.hidden = true;
      const channelLabel = el('span', 'ij-channel-label');
      const channelSlider = el('input', 'ij-channel-slider');
      // positions 0..nC: 0 = every channel (display mode Composite), k = channel k alone (Color, or Grayscale when that is the mode)
      channelSlider.type = 'range'; channelSlider.min = '0'; channelSlider.max = '1'; channelSlider.step = '1'; channelSlider.value = '0';
      channelSlider.setAttribute('aria-label', t('view.channel', 'Channel'));
      channelBar.append(channelLabel, channelSlider);
      // StackWindow: one row per dimension of a stack (z, t, or the one slider of a plain stack), built by the controller
      const stackBar = el('div', 'ij-stack-bar');
      stackBar.hidden = true;
      pane.append(head, stage, channelBar, stackBar);
      const view = IJView.create(renderer, stage, { docId, onViewChange: (v) => onViewChange(docId, v), selectionColor: opts.selectionColor });
      const ctl = makeController(docId, stage, view, { subtitle, badge, channelBar, channelLabel, channelSlider, stackBar });
      ctls.set(docId, ctl);
      return { el: pane, view, stage };
    }
    function destroyPane(docId) {
      const c = ctls.get(docId);
      ctls.delete(docId);
      if (c) c.destroy();
      if (c && c.view && c.view.destroy) c.view.destroy();
      if (activeDoc === docId) activeDoc = null;
    }
    const layout = IJLayout.create(wsHost, {
      t: opts.t, makePane, destroyPane,
      onActivate: (docId) => {
        for (const [d, c] of ctls) if (d !== docId) c.cancelPolygon();
        activeDoc = docId;
        if (opts.onActivate) opts.onActivate(docId);
      },
      onClose: (docId) => { if (opts.onCloseImage) opts.onCloseImage(docId); else layout.remove(docId); },
      onChange: (kind) => { if (opts.onLayoutChange) opts.onLayoutChange(kind); }
    });

    // ---- Tools ---------------------------------------------------------------------------------------
    let tool = 'rect';
    const toolButtons = new Map();
    // Tools a package registered (IJApp.extend({ tools })): { id, labelKey, icon?, cursor?, hidden?, ext: true }. The
    // pointer events of the stage go to opts.onToolPointer(docId, { type, x, y, button, shift, alt, ctrl }) while one is
    // selected; a `hidden` one has no button until it is selected (shell.setTool(id)).
    const extTools = new Map();
    const hiddenTools = new Set();
    let lineWidth = 1;
    for (const td of (opts.tools || DEFAULT_TOOLS)) {
      if (td.separator) { toolbar.appendChild(el('span', 'ij-tool-sep')); continue; }
      const b = el('button', 'ij-tool');
      b.type = 'button';
      b.dataset.tool = td.id;
      const label = td.labelKey ? t(td.labelKey, td.label || TOOL_FALLBACK[td.id] || td.id) : t('view.tool.' + td.id, td.label || TOOL_FALLBACK[td.id] || td.id);
      b.title = label; b.setAttribute('aria-label', label); b.setAttribute('aria-pressed', 'false');
      b.appendChild(svgIcon(doc, td.icon && ICONS[td.icon] ? td.icon : td.id));
      if (td.ext) extTools.set(td.id, td);
      if (td.hidden) { hiddenTools.add(td.id); b.hidden = true; }
      listen(b, 'click', () => setTool(td.id, true));
      listen(b, 'dblclick', () => {
        if (td.id === 'zoom') { const c = activeCtl(); if (c) c.view.view100(); }
        else if ((td.id === 'line' || td.id === 'point' || td.id === 'wand') && opts.onToolOptions) opts.onToolOptions(td.id);
      });
      toolbar.appendChild(b);
      toolButtons.set(td.id, b);
    }
    function setTool(id, notify) {
      if (!toolButtons.has(id)) return;
      if (tool !== id) for (const c of ctls.values()) c.cancelPolygon();
      tool = id;
      for (const [k, b] of toolButtons) {
        b.classList.toggle('is-active', k === id);
        b.setAttribute('aria-pressed', k === id ? 'true' : 'false');
        if (hiddenTools.has(k)) b.hidden = k !== id;
      }
      for (const c of ctls.values()) c.stageCursor();
      if (notify && opts.onTool) opts.onTool(id);
    }

    // ---- Menus ----------------------------------------------------------------------------------------
    let tree = [];
    let menuState = { open: false, stack: [0] };
    const titleButtons = [];
    let panelsEl = null;
    const SUBMENU_WIDTH = 220; // room reserved when deciding which side a submenu opens on
    let armed = false; // a click opened a menu: hovering another title switches

    function buildTree() {
      tree = P.buildMenuTree(opts.commands || [], { t, state: opts.getState ? opts.getState() : null, groups: opts.menuGroups || null });
    }

    // title listeners are released on every rebuild instead of piling up in `cleanups`
    const titleCleanups = [];
    const listenTitle = (target, ev, fn) => { target.addEventListener(ev, fn); titleCleanups.push(() => target.removeEventListener(ev, fn)); };
    const signatureOf = () => tree.map((x) => x.label).join('\u0001');
    let titleSignature = '';

    function renderTitles() {
      for (const fn of titleCleanups.splice(0)) fn();
      menubar.textContent = '';
      titleButtons.length = 0;
      titleSignature = signatureOf();
      tree.forEach((top, i) => {
        const b = el('button', 'ij-menu-title', top.label);
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.setAttribute('aria-haspopup', 'true');
        b.setAttribute('aria-expanded', 'false');
        b.tabIndex = i === (menuState.stack[0] || 0) ? 0 : -1;
        listenTitle(b, 'click', (e) => {
          e.preventDefault();
          if (menuState.open && menuState.stack[0] === i) { closeMenus(); return; }
          if (opts.onMenuOpen) { try { opts.onMenuOpen(tree[i].name); } catch (x) { console.error('IJShell onMenuOpen', x); } }
          menuState = { open: true, stack: [i, P.firstSelectable(tree[i].items)] };
          armed = true;
          renderMenus();
          b.focus();
        });
        listenTitle(b, 'pointerenter', () => {
          if (armed && menuState.open && menuState.stack[0] !== i) {
            if (opts.onMenuOpen) { try { opts.onMenuOpen(tree[i].name); } catch (x) { console.error('IJShell onMenuOpen', x); } }
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
      menubar.removeAttribute('aria-activedescendant');
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
          if (it.title) row.title = it.title;
          row.appendChild(el('span', 'ij-menu-label', it.label));
          if (it.type === 'item' && it.shortcut) row.appendChild(el('span', 'ij-menu-shortcut', it.shortcut));
          if (it.type === 'group') { row.classList.add('has-children'); row.setAttribute('aria-haspopup', 'true'); row.appendChild(el('span', 'ij-menu-arrow', '▸')); }
          if (it.disabled) { row.classList.add('is-disabled'); row.setAttribute('aria-disabled', 'true'); }
          row.id = 'ij-menu-row-' + d + '-' + idx;
          if (idx === sel) { row.classList.add('is-active'); anchorEl = row; menubar.setAttribute('aria-activedescendant', row.id); }
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
            runCommand(it.command, 'menu', e);
          });
          panel.appendChild(row);
        });
        panelsEl.appendChild(panel);
        // keep the panel inside the shell: shifted left / up, scrollable when taller than the shell
        const pw = panel.offsetWidth;
        if (rb.height > 0) { panel.style.maxHeight = Math.max(80, Math.round(rb.height)) + 'px'; panel.style.overflowY = 'auto'; }
        if (rb.width > 0) x = P.clampPopupX(x, pw, rb.width);
        if (rb.height > 0) y = P.clampPopupY(y, panel.offsetHeight, rb.height);
        panel.style.left = Math.round(x) + 'px'; panel.style.top = Math.round(y) + 'px';
        // submenu: right of the highlighted parent row, left of it when it would overflow
        const nextItem = list[menuState.stack[d]];
        if (nextItem && nextItem.type === 'group' && d < depth && anchorEl) {
          x = rb.width > 0 ? P.submenuX(x, pw, SUBMENU_WIDTH, rb.width) : x + pw - 2;
          y = y + anchorEl.offsetTop;
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

    // `ev` = the click / key event: the modifiers it carried go to the command (IJ.altKeyDown(), IJ.shiftKeyDown())
    function runCommand(cmd, source, ev) {
      closeMenus();
      try { focusTargetEl().focus({ preventScroll: true }); } catch (e) { /* no view yet */ }
      if (opts.onCommand) opts.onCommand(cmd, { source, alt: !!(ev && ev.altKey), shift: !!(ev && ev.shiftKey) });
    }

    listen(menubar, 'keydown', (e) => {
      if (!tree.length) return;
      const k = e.key;
      if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Escape', 'Home', 'End'].includes(k)) return;
      e.preventDefault(); e.stopPropagation();
      const r = P.menuKey(tree, menuState, k);
      menuState = r.state;
      if (r.activate) { runCommand(r.activate.command, 'key', e); return; }
      if (!menuState.open && k === 'Escape') { try { focusTargetEl().focus({ preventScroll: true }); } catch (x) { /* none */ } }
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
      // the titles only change with the labels: otherwise keep the buttons (and the focus on one)
      if (signatureOf() !== titleSignature || titleButtons.length !== tree.length) {
        const hadFocus = titleButtons.some((b) => b === doc.activeElement);
        renderTitles();
        if (hadFocus && titleButtons[menuState.stack[0]]) titleButtons[menuState.stack[0]].focus();
      }
      renderMenus();
    }
    refreshMenus();

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

    let spaceDown = false;
    function makeController(docId, stage, view, parts) {
      const { subtitle, badge, channelBar, channelLabel, channelSlider, stackBar } = parts;
      let info = null;
      const lst = [];
      const listen = (target, ev, fn, o) => { target.addEventListener(ev, fn, o); lst.push(() => target.removeEventListener(ev, fn, o)); };
      // the position on screen { c, z, t } (0-based) and the animation (null | fps), see "stacks" below
      let pos = { c: 0, z: 0, t: 0 };
      let running = null;
      // the display mode the channel bar follows, and the single-channel mode (Color / Grayscale) a move off "all" takes
      let dmode = 'composite', lastSingle = 'color';
      const noteMode = (m) => { if (m === 'composite' || m === 'color' || m === 'gray') { dmode = m; if (m !== 'composite') lastSingle = m; } };
      const stepInfo = () => Object.assign({}, info, { display: Object.assign({}, info.display, { mode: dmode, active: pos.c }) });
      function paintChannelBar() {
        if (!info) return;
        const n = info.channels ? info.channels.length : 1;
        channelSlider.min = '0'; channelSlider.max = String(Math.max(1, n));
        const v = dmode === 'composite' ? 0 : pos.c + 1;
        channelSlider.value = String(v);
        let text;
        if (v === 0) text = 'c: ' + t('view.channelAll', 'all');
        else { const nm = info.channels && info.channels[v - 1] && info.channels[v - 1].name; text = 'c: ' + v + '/' + n + (nm ? ' (' + nm + ')' : ''); }
        channelLabel.textContent = text;
        channelSlider.setAttribute('aria-valuetext', text);
      }
      const rowEls = [];     // [{ row, root, slider, count, play }]
      let rowsSig = '';
      // ---- Pixel read-out (<= 1 request in flight) ------------------------------------------------------------------------
      let pxPending = null, pxBusy = false;
      function showPos(ix, iy, values) {
        if (!info) { statusPos.textContent = ''; return; }
        const d = P.stackDimsOf(info);
        // ImagePlus.getLocationAsString: z = getSlice() - 1 on a displayed hyperstack, getCurrentSlice() - 1 otherwise
        const z = d.nZ * d.nT > 1 ? (P.isDimensionAware(info) ? pos.z : P.stackIndexOf(d, pos.c, pos.z, pos.t) - 1) : undefined;
        // the channel bar at a single channel shows that channel's value; at "all" every channel's (value=a,b,c)
        let shown = values;
        if (Array.isArray(values) && values.length > 1 && !info.rgb && d.nC > 1 && dmode !== 'composite' && values[pos.c] !== undefined) shown = [values[pos.c]];
        statusPos.textContent = P.formatStatus({ x: ix, y: iy, z, calibration: info.calibration, values: shown, bitDepth: info.bitDepth });
      }
      async function pxFlush() {
        if (pxBusy) return;
        pxBusy = true;
        try {
          while (pxPending && !destroyed) {
            const q = pxPending; pxPending = null;
            let values = null;
            try { values = opts.readPixel ? await opts.readPixel(q.x, q.y, docId) : null; } catch (e) { values = null; }
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
      let wheelAcc = 0;
      let hoverCursor = '';
      let rois = { all: [], showAll: false };

      function pushRois() { view.setRois({ active: activeRoi, all: rois.all, showAll: rois.showAll, handles: true }); }
      function emitRoi(roi, final, source) { if (opts.onRoi) opts.onRoi(roi, { final, source, docId }); }
      function commitRoi(roi, source, final = true) {
        activeRoi = roi;
        pushRois();
        if (roi) setStatus(P.describeRoi(roi, info && info.calibration));
        emitRoi(roi, final, source);
      }
      function cancelPolygon() { if (polyDraft) { polyDraft = null; view.setDraft(null); } }

      function stagePoint(e) {
        const r = stage.getBoundingClientRect();
        return { sx: e.clientX - r.left, sy: e.clientY - r.top };
      }
      function tolImg() { return 6 / Math.max(view.getView().zoom, 1e-6); }

      function stageCursor() {
        let c = 'default';
        if (tool === 'hand' || spaceDown) c = drag && drag.kind === 'pan' ? 'grabbing' : 'grab';
        else if (tool === 'zoom') c = 'zoom-in';
        else if (ROI_TOOLS.has(tool)) c = 'crosshair';
        else if (extTools.has(tool)) c = extTools.get(tool).cursor || 'crosshair';
        view.setCursor(hoverCursor || c);
      }

      function finishPolygon(close) {
        if (!polyDraft) return;
        const pts = polyDraft.points, kind = polyDraft.kind;
        polyDraft = null;
        view.setDraft(null);
        // a segmented line (finished by a double click / Enter) and an angle (its third click) are open: the Enter / double click of a polygon closes it
        if (kind === 'polyline') {
          if (pts.length >= 2) commitRoi({ type: 'polyline', points: pts, width: lineWidth }, 'draw'); else commitRoi(null, 'clear');
        } else if (kind === 'angle') {
          if (pts.length === 3) commitRoi({ type: 'angle', points: pts }, 'draw'); else commitRoi(null, 'clear');
        } else if (close && pts.length >= 3) commitRoi({ type: 'polygon', points: pts }, 'draw');
        else if (pts.length === 2 && !close) commitRoi({ type: 'line', x1: pts[0][0], y1: pts[0][1], x2: pts[1][0], y2: pts[1][1], width: 1 }, 'draw');
        else commitRoi(null, 'clear');
      }

      function onPointerDown(e) {
        if (!info) return;
        stage.focus({ preventScroll: true });
        const { sx, sy } = stagePoint(e);
        const p = view.screenToImage(sx, sy);
        const panning = e.button === 1 || spaceDown || tool === 'hand';
        if (panning && (e.button === 0 || e.button === 1)) {
          drag = { kind: 'pan', lx: e.clientX, ly: e.clientY, id: e.pointerId };
          stage.setPointerCapture(e.pointerId);
          stageCursor(); e.preventDefault();
          return;
        }
        if (tool === 'zoom') {
          if (e.button === 2 || e.altKey) { view.zoomAt(sx, sy, -1); return; }
          if (e.button !== 0) return;
          drag = { kind: 'zoomrect', sx, sy, cx: sx, cy: sy, id: e.pointerId };
          stage.setPointerCapture(e.pointerId);
          return;
        }
        // a tool of a package: it gets the pointer, the shell draws nothing
        if (extTools.has(tool) && opts.onToolPointer) {
          drag = { kind: 'ext', id: e.pointerId };
          stage.setPointerCapture(e.pointerId);
          opts.onToolPointer(docId, { type: 'down', x: p.x, y: p.y, button: e.button, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey });
          e.preventDefault();
          return;
        }
        if (e.button !== 0 || !ROI_TOOLS.has(tool)) return;

        // the wand traces what is under the click: the controller does it (the engine owns the pixels)
        if (tool === 'wand') {
          if (opts.onWand) opts.onWand(Math.floor(p.x), Math.floor(p.y), { shift: e.shiftKey, alt: e.altKey });
          return;
        }
        const tol = tolImg();
        // segmented line / angle in progress: a vertex per click (pixel-centre integers, as a line); an angle ends at its third
        if ((tool === 'polyline' || tool === 'angle') && polyDraft) {
          const pt = [Math.floor(p.x), Math.floor(p.y)];
          const last = polyDraft.points[polyDraft.points.length - 1];
          if (tool === 'polyline' && e.detail >= 2 && last && last[0] === pt[0] && last[1] === pt[1]) { finishPolygon(false); return; }
          polyDraft.points.push(pt);
          if (tool === 'angle' && polyDraft.points.length === 3) { finishPolygon(false); return; }
          view.setDraft({ points: polyDraft.points, rubber: [p.x, p.y] });
          return;
        }
        // polygon in progress: add a vertex (close on the first one / double click)
        if (tool === 'polygon' && polyDraft) {
          const pt = [Math.round(p.x), Math.round(p.y)];
          const first = polyDraft.points[0];
          const near = first && Math.hypot((first[0] - pt[0]) * view.getView().zoom, (first[1] - pt[1]) * view.getView().zoom) < 8;
          if (near && polyDraft.points.length >= 3) { finishPolygon(true); return; }
          if (e.detail >= 2 && polyDraft.points.length >= 3) { finishPolygon(true); return; }
          polyDraft.points.push(pt);
          view.setDraft({ points: polyDraft.points, rubber: [p.x, p.y] });
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
          if (!(tool === 'point' && !e.shiftKey) && P.hitRoi(activeRoi, p.x, p.y, (activeRoi.type === 'line' || activeRoi.type === 'polyline' || activeRoi.type === 'angle') ? tol : 0)) {
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
        if (tool === 'polyline' || tool === 'angle') {
          polyDraft = { kind: tool, points: [[Math.floor(p.x), Math.floor(p.y)]], rubber: null };
          activeRoi = null; pushRois();
          view.setDraft({ points: polyDraft.points, rubber: [p.x, p.y] });
          emitRoi(null, false, 'clear');
          return;
        }
        if (tool === 'polygon') {
          polyDraft = { kind: 'polygon', points: [[Math.round(p.x), Math.round(p.y)]], rubber: null };
          activeRoi = null; pushRois();
          view.setDraft({ points: polyDraft.points, rubber: [p.x, p.y] });
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
        const p = view.screenToImage(sx, sy);
        readout(p.x, p.y);
        if (opts.onCursor) opts.onCursor(docId, p.x, p.y, sx, sy);
        if (drag) {
          switch (drag.kind) {
            case 'ext':
              if (opts.onToolPointer) opts.onToolPointer(docId, { type: 'move', x: p.x, y: p.y, button: 0, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey });
              break;
            case 'pan':
              view.pan(e.clientX - drag.lx, e.clientY - drag.ly);
              drag.lx = e.clientX; drag.ly = e.clientY;
              break;
            case 'zoomrect': drag.cx = sx; drag.cy = sy; {
              const a = view.screenToImage(drag.sx, drag.sy);
              view.setRois({ active: { type: 'rect', x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(p.x - a.x), h: Math.abs(p.y - a.y) }, handles: false });
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
              view.setRois({ active: roi, handles: false });
              setStatus(P.describeRoi(roi, info.calibration));
              emitRoi(roi, false, 'draw');
            } break;
            case 'move': {
              const dx = Math.round(p.x - drag.p0.x), dy = Math.round(p.y - drag.p0.y);
              if (dx || dy) drag.moved = true;
              const roi = P.translateRoi(drag.start, dx, dy);
              activeRoi = roi; drag.roi = roi;
              view.setRois({ active: roi, handles: false });
              setStatus(P.describeRoi(roi, info.calibration));
              emitRoi(roi, false, 'move');
            } break;
            case 'resize': {
              const roi = P.moveHandle(drag.start, drag.handle, p.x, p.y, { shift: e.shiftKey });
              activeRoi = roi; drag.roi = roi;
              view.setRois({ active: roi, handles: false });
              setStatus(P.describeRoi(roi, info.calibration));
              emitRoi(roi, false, 'resize');
            } break;
            default: break;
          }
          return;
        }
        if (polyDraft) view.setDraft({ points: polyDraft.points, rubber: [p.x, p.y] });
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
          case 'ext':
            if (opts.onToolPointer) {
              const q = e ? stagePoint(e) : { sx: 0, sy: 0 };
              const ip = e ? view.screenToImage(q.sx, q.sy) : { x: NaN, y: NaN };
              opts.onToolPointer(docId, { type: cancelled ? 'cancel' : 'up', x: ip.x, y: ip.y, button: 0, shift: !!(e && e.shiftKey), alt: !!(e && e.altKey), ctrl: !!(e && (e.ctrlKey || e.metaKey)) });
            }
            break;
          case 'pan': stageCursor(); break;
          case 'zoomrect': {
            view.setRois({ active: activeRoi, handles: true });
            if (cancelled) break;
            const { sx, sy } = e ? stagePoint(e) : { sx: d.cx, sy: d.cy };
            if (Math.hypot(sx - d.sx, sy - d.sy) < 4) view.zoomAt(d.sx, d.sy, 1);
            else {
              const a = view.screenToImage(d.sx, d.sy), b = view.screenToImage(sx, sy);
              view.zoomToRect({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });
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
      listen(stage, 'pointerleave', () => { if (!drag) statusPos.textContent = ''; pxPending = null; if (opts.onCursor && !drag) opts.onCursor(docId, null); });
      listen(stage, 'contextmenu', (e) => { if (tool === 'zoom') e.preventDefault(); });
      listen(stage, 'dblclick', (e) => {
        if (tool === 'polygon' && polyDraft && polyDraft.points.length >= 3) { e.preventDefault(); finishPolygon(true); }
        else if (tool === 'polyline' && polyDraft && polyDraft.points.length >= 2) { e.preventDefault(); finishPolygon(false); }
      });
      listen(stage, 'wheel', (e) => {
        if (!info) return;
        e.preventDefault();
        const r = P.wheelSteps(wheelAcc, e.deltaY, e.deltaMode);
        wheelAcc = r.acc;
        // StackWindow.mouseWheelMoved: the wheel changes the slice of a stack (down = next); Ctrl keeps the zoom
        if (P.stackDimsOf(info).nZ * P.stackDimsOf(info).nT > 1 && !e.ctrlKey && !e.metaKey) {
          if (r.steps) { const np = P.wheelPosition(info, pos, -r.steps); if (np) movePosition(np); }
          return;
        }
        const { sx, sy } = stagePoint(e);
        for (let i = 0; i < Math.abs(r.steps); i++) view.zoomAt(sx, sy, r.steps > 0 ? 1 : -1);
      }, { passive: false });


      function keyDown(e) {
        if (polyDraft) {
          if (e.key === 'Enter') { e.preventDefault(); finishPolygon(polyDraft.kind === 'polygon'); return true; }
          if (e.key === 'Escape') { e.preventDefault(); cancelPolygon(); commitRoi(null, 'clear'); return true; }
          if (e.key === 'Backspace') {
            e.preventDefault();
            polyDraft.points.pop();
            if (!polyDraft.points.length) { cancelPolygon(); return true; }
            view.setDraft({ points: polyDraft.points, rubber: null });
            return true;
          }
        }
        if (drag && e.key === 'Escape') { e.preventDefault(); endDrag(null, true); return true; }
        // Animator: > or . = Next Slice, < or , = Previous Slice (Ctrl / Alt change which dimension a hyperstack moves, Alt = 10 slices
        // of a plain stack), \ = Start / Stop Animation; only on a stack
        if (info && P.stackDimsOf(info).n > 1 && !e.metaKey && !(e.ctrlKey && e.shiftKey)) {
          const k = e.key;
          const dir = k === '>' || k === '.' ? 1 : (k === '<' || k === ',' ? -1 : 0);
          if (dir) {
            const np = P.stepPosition(stepInfo(), pos, dir, { ctrl: e.ctrlKey, alt: e.altKey, space: spaceDown });
            e.preventDefault();
            if (np) movePosition(np);
            return true;
          }
          if (k === '\\' && !e.ctrlKey && !e.altKey) { e.preventDefault(); if (opts.onAnimate) opts.onAnimate(docId, 'toggle'); return true; }
        }
        if (activeRoi && stage.contains(e.target) && e.key.startsWith('Arrow') && !e.ctrlKey && !e.metaKey) {
          const step = e.shiftKey ? 10 : 1;
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          if (dx || dy) { e.preventDefault(); commitRoi(P.translateRoi(activeRoi, dx, dy), 'nudge'); return true; }
        }
        return false;
      }

      // ---- stacks (ij.gui.StackWindow): rows under the image, the position on screen -------------------------------------
      const sliceLabel = () => (opts.sliceLabel ? opts.sliceLabel(docId, pos) : null);
      function paintSubtitle() {
        if (!info) return;
        // the position drawn is the one on screen, whatever the engine's info still says
        subtitle.textContent = P.formatSubtitle(Object.assign({}, info, { z: pos.z, t: pos.t, display: Object.assign({}, info.display, { active: pos.c }) }),
          { label: sliceLabel(), running: running !== null });
      }
      function paintRows() {
        const rows = P.stackRows(info, pos);
        const sig = rows.map((r) => r.dim + r.max + (r.animated ? 'a' : '')).join(',');
        if (sig !== rowsSig) {
          rowsSig = sig;
          while (rowEls.length) { const r = rowEls.pop(); r.cleanup(); if (r.root.parentNode) r.root.parentNode.removeChild(r.root); }
          for (const row of rows) if (row.dim !== 'c') buildRow(row);
        }
        for (const r of rowEls) {
          const cur = rows.find((x) => x.dim === r.row.dim);
          if (!cur) continue;
          r.slider.value = String(cur.value);
          r.count.textContent = `${cur.value}/${cur.max}`;
          r.slider.setAttribute('aria-valuetext', `${cur.letter || 'slice'} ${cur.value}/${cur.max}`);
          if (r.play) { r.play.classList.toggle('is-running', running !== null); r.play.setAttribute('aria-pressed', running !== null ? 'true' : 'false'); r.play.textContent = running !== null ? '❚❚' : '▶'; }
        }
        stackBar.hidden = rowEls.length === 0;
      }
      function buildRow(row) {
        const root = el('div', 'ij-stack-row');
        root.dataset.dim = row.dim;
        const cl = [];
        let play = null;
        if (row.animated) {
          play = el('button', 'ij-stack-play', '▶');
          play.type = 'button';
          play.setAttribute('aria-label', t('view.animate', 'Animation'));
          play.title = t('view.animate', 'Animation');
          const onPlay = () => { if (opts.onAnimate) opts.onAnimate(docId, 'toggle'); };
          play.addEventListener('click', onPlay); cl.push(() => play.removeEventListener('click', onPlay));
          root.appendChild(play);
        }
        const letter = el('span', 'ij-stack-letter', row.letter || '');
        const slider = el('input', 'ij-stack-slider');
        slider.type = 'range'; slider.min = '1'; slider.max = String(row.max); slider.step = '1'; slider.value = String(row.value);
        slider.setAttribute('aria-label', row.letter ? t('view.dim.' + row.letter, row.letter) : t('view.slice', 'Slice'));
        const count = el('span', 'ij-stack-count');
        const onInput = () => movePosition(P.positionFromRow(info, pos, row, Number(slider.value)));
        slider.addEventListener('input', onInput); cl.push(() => slider.removeEventListener('input', onInput));
        root.append(letter, slider, count);
        stackBar.appendChild(root);
        rowEls.push({ row, root, slider, count, play, cleanup: () => { for (const f of cl) f(); } });
      }
      /** The operator moved: the view shows the plane at once (tile requests carry it), the app is told. */
      function movePosition(np) {
        if (!info) return;
        const next = P.clampPosition(info, np);
        if (next.c !== pos.c) {
          pos = Object.assign({}, pos, { c: next.c });
          view.setDisplay({ active: next.c });
          paintChannelBar();
          if (opts.onChannel) opts.onChannel(next.c, docId);
        }
        if (next.z !== pos.z || next.t !== pos.t) {
          pos = Object.assign({}, pos, { z: next.z, t: next.t });
          if (typeof view.setPosition === 'function') view.setPosition({ z: pos.z, t: pos.t });
          if (opts.onPosition) opts.onPosition({ c: pos.c, z: pos.z, t: pos.t }, docId);
        }
        paintRows(); paintSubtitle();
      }
      /** The app moved it (a command, a macro, the engine, a restore): the rows and the view follow, nothing is sent back. */
      function setPosition(np, o) {
        if (!info) return;
        const next = P.clampPosition(info, np);
        const planeMoved = next.z !== pos.z || next.t !== pos.t;
        pos = next;
        if (planeMoved && typeof view.setPosition === 'function') view.setPosition({ z: pos.z, t: pos.t });
        paintChannelBar();
        paintRows(); paintSubtitle();
        if (!o || o.keepStatus !== true) statusPos.textContent = '';
      }
      function setRunning(fps) { running = fps > 0 ? fps : null; paintRows(); paintSubtitle(); }

      // ---- the image of this view ----------------------------------------------------------------------------
      function setImage(imgInfo) {
        info = imgInfo || null;
        if (!info) { activeRoi = null; polyDraft = null; running = null; view.setImage(null); return; }
        const n = info.channels ? info.channels.length : 1;
        const active = Math.min(n - 1, Math.max(0, (info.display && info.display.active) || 0));
        pos = P.clampPosition(info, { c: active, z: info.z, t: info.t });
        noteMode(info.display && info.display.mode);
        channelBar.hidden = n < 2 || !!info.rgb;
        paintChannelBar();
        view.setImage(info);
        if (typeof view.setPosition === 'function') view.setPosition({ z: pos.z, t: pos.t });
        paintRows(); paintSubtitle();
        statusPos.textContent = '';
      }
      function updateInfo(imgInfo) {
        if (!imgInfo || !info) return;
        info = imgInfo;
        pos = P.clampPosition(info, pos);
        paintRows(); paintSubtitle();
        view.updateInfo(imgInfo);
      }
      function setDisplayState(state) {
        view.setDisplay(state);
        if (state && info) {
          // the bar follows a display-mode change made elsewhere (Channels Tool, Image > Color): Composite = "all", else the active channel
          if (state.mode) noteMode(state.mode);
          if (Number.isInteger(state.active) && pos.c !== state.active) pos = Object.assign({}, pos, { c: state.active });
          paintChannelBar(); paintSubtitle();
        }
      }
      listen(channelSlider, 'input', () => {
        const v = Number(channelSlider.value);
        if (v <= 0) {
          // "all": Composite mode, the active channel stays what it was
          dmode = 'composite';
          view.setDisplay({ mode: 'composite' });
          paintChannelBar();
          if (opts.onChannel) opts.onChannel(pos.c, docId, 'composite');
        } else {
          const mode = dmode === 'composite' ? lastSingle : dmode;
          dmode = mode;
          pos = Object.assign({}, pos, { c: v - 1 });
          view.setDisplay({ active: v - 1, mode });
          paintChannelBar();
          if (opts.onChannel) opts.onChannel(v - 1, docId, mode);
        }
        paintSubtitle();
      });
      listen(stage, 'blur', () => { if (spaceDown) { spaceDown = false; stageCursor(); } });
      function destroy() {
        for (const fn of lst.splice(0)) fn();
        pxPending = null;
        activeRoi = null; polyDraft = null;
      }
      return {
        docId, stage, view, subtitle, badge, channelBar,
        get info() { return info; },
        get polyDraft() { return polyDraft; },
        get activeRoi() { return activeRoi; },
        get drag() { return drag; },
        setImage, updateInfo, setDisplayState, keyDown, stageCursor, cancelPolygon, destroy, setPosition, setRunning,
        getPosition: () => Object.assign({}, pos), repaintSubtitle: paintSubtitle,
        setActiveRoi(roi) { activeRoi = roi || null; cancelPolygon(); pushRois(); setStatus(roi ? P.describeRoi(roi, info && info.calibration) : ''); },
        setRois(r) { rois = { all: (r && r.all) || [], showAll: !!(r && r.showAll) }; pushRois(); },
        commitRoi
      };
    }

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
      if (typeof Dialog !== 'undefined' && Dialog && typeof Dialog.isOpen === 'function' && Dialog.isOpen()) return;
      if (isTypingTarget(e.target)) return;
      if (menuState.open && menubar.contains(e.target)) return;
      const ac = activeCtl();
      if (e.key === ' ' && ac && (e.target === ac.stage || (e.target && shell.contains && shell.contains(e.target)))) {
        if (!spaceDown) { spaceDown = true; for (const c of ctls.values()) c.stageCursor(); }
        e.preventDefault();
        return;
      }
      if (ac && ac.keyDown(e)) return;
      if (e.key === 'Escape' && !progress.hidden && !cancelBtn.hidden) { e.preventDefault(); if (opts.onCancel) opts.onCancel(); return; }
      const sc = P.shortcutFromEvent(e);
      if (!sc) return;
      const cmd = shortcutMap.get(sc);
      if (!cmd) return;
      let enabled = true;
      if (typeof cmd.enabled === 'function') { try { enabled = !!cmd.enabled(opts.getState ? opts.getState() : null); } catch (x) { enabled = false; } }
      e.preventDefault();
      if (enabled && opts.onCommand) { closeMenus(); opts.onCommand(cmd, { source: 'key', alt: !!e.altKey, shift: !!e.shiftKey }); }
    }
    function onKeyUp(e) {
      if (e.key === ' ' && spaceDown) { spaceDown = false; for (const c of ctls.values()) c.stageCursor(); }
    }
    listen(doc, 'keydown', onKeyDown);
    listen(doc, 'keyup', onKeyUp);

    setTool('rect', false);

    // ---- Public API --------------------------------------------------------------------------------------------------------------
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const fn of cleanups.splice(0)) fn();
      for (const fn of titleCleanups.splice(0)) fn();
      windows.destroy();
      layout.destroy();
      renderer.destroy();
      if (shell.parentNode) shell.parentNode.removeChild(shell);
    }
    const ctlOf = (docId) => (docId === undefined || docId === null ? activeCtl() : ctls.get(docId) || null);

    return {
      el: shell, workspace: wsHost, layout, renderer, windows, menubar, statusBar: statusbar,
      view: (docId) => layout.view(docId),
      activeView: () => (activeDoc !== null ? layout.view(activeDoc) : null),
      activeDocId: () => activeDoc,
      /** Shows `imgInfo` in its own view (created on first call, placed as `o.placement` says). */
      setImage(imgInfo, o) {
        if (!imgInfo) return;
        if (!layout.has(imgInfo.docId)) layout.add(imgInfo.docId, o || {});
        const c = ctls.get(imgInfo.docId);
        if (!c) return;
        c.setImage(imgInfo);
        layout.setTabInfo(imgInfo.docId, { name: imgInfo.name || '' });
      },
      updateInfo(imgInfo) { const c = ctlOf(imgInfo && imgInfo.docId); if (c) { c.updateInfo(imgInfo); layout.setTabInfo(c.docId, { name: imgInfo.name || '' }); } },
      removeImage(docId) { layout.remove(docId); },
      /** No docId: every view goes (the empty workspace). */
      clearImage(docId) { if (docId === undefined || docId === null) { layout.clear(); activeDoc = null; } else layout.remove(docId); },
      setTitle(name, docId) { const c = ctlOf(docId); if (c) layout.setTabInfo(c.docId, { name: name || '' }); },
      setTabInfo: (docId, o) => layout.setTabInfo(docId, o),
      setDisplayState(state, docId) { const c = ctlOf(docId); if (c) c.setDisplayState(state); },
      /** The plane on screen ({ c, z, t }, 0-based): the rows, the subtitle and the view follow; nothing is reported back (opts.onPosition is the operator's). */
      setPosition(docId, p, o) { const c = ctlOf(docId); if (c) c.setPosition(p, o); },
      getPosition(docId) { const c = ctlOf(docId); return c ? c.getPosition() : null; },
      /** An animation runs (fps) or stopped (null): the play button and the subtitle follow. */
      setRunning(docId, fps) { const c = ctlOf(docId); if (c) c.setRunning(fps); },
      repaintSubtitle(docId) { const c = ctlOf(docId); if (c) c.repaintSubtitle(); },
      setTool: (id) => setTool(id, false), getTool: () => tool,
      setActiveRoi(roi, docId) { const c = ctlOf(docId); if (c) c.setActiveRoi(roi); },
      getActiveRoi: (docId) => { const c = ctlOf(docId); return c ? c.activeRoi : null; },
      setRois(r, docId) { const c = ctlOf(docId); if (c) c.setRois(r); },
      setLineWidth(w) { lineWidth = Math.max(1, Number(w) || 1); },
      setStatus, setProgress, setWarning,
      refreshMenus: () => { indexShortcuts(); refreshMenus(); },
      closeMenus,
      destroy
    };
  }

  return { create, DEFAULT_TOOLS };
})();
