/* Z-Stack Browser — index.js
 *
 * The panel's slider is a custom vertical control in three parts:
 *   • a "3D" notch above the track — with the cursor parked there every kept slice is
 *     shown in 3D and the view rotates freely;
 *   • the track — one position per slice, slice 0 at the top like the diagram beside
 *     it. The cursor is a rounded bar whose height is the number of slices shown at
 *     once (drag an edge to change it); dropping it into the track locks the view
 *     top-down (XY);
 *   • two triangular trim handles — the slices above the top one and below the bottom
 *     one are masked out, in 3D and in slice mode alike.
 *
 * Rendering is a single clip range on the volume: [cropLo, cropHi] in 3D mode, its
 * intersection with the cursor in slice mode. viewer.js keeps the cross-iframe
 * receiver (SYNC_ZSTACK_SLICE → applySync) and the early TOGGLE_ZSTACK listener,
 * which need ViewerApp's internal scope.
 *
 * Slice indices are 0-based internally and 1-based in every readout.
 */
PluginRegistry.implement('zstack-browser', {
  _ctx: null,
  _els: null,
  _ac: null,

  // '3d' = cursor in the notch (all kept slices), 'slice' = cursor on the track.
  _mode: '3d',
  // First slice of the cursor and how many slices it spans.
  _lo: 0,
  _thickness: 1,
  // Kept range, inclusive. Infinity resolves to the last slice once dims are known.
  _cropLo: 0,
  _cropHi: Infinity,
  // Whether WE locked the view top-down (slice mode) — released on 3D and on close.
  _viewLocked: false,
  _drag: null,

  init(ctx) {
    this._ctx = ctx;
    this._bindControls();
    this._applyLabels();
    ctx.i18n.onLanguageChange?.(() => { this._applyLabels(); this._render(); });
    return this;
  },

  // ── Public toggle (called by toolbar button binding) ──────

  activate() {
    const st = this._ctx._state;
    st.zstackActive = !st.zstackActive;
    if (st.zstackActive) this._resetFields();
    this._syncButton(st.zstackActive);
    this._show(st.zstackActive);
    return { active: st.zstackActive };
  },

  // ── Programmatic state (viewer.js _applyZstackState, compare TOGGLE_ZSTACK) ──

  applyState(desired, slice = null) {
    const st = this._ctx._state;
    st.zstackActive = desired;
    this._syncButton(desired);
    this._show(desired);
    if (desired && Number.isFinite(slice) && slice > 0) {
      // Applied synchronously, while the SYNC_ZSTACK_SLICE receiver's echo guard is
      // still raised; re-arm it anyway so a caller without one cannot ping-pong with
      // the sibling panel. Restore prev to keep nesting safe.
      const prev = st.suppressZstackSync;
      st.suppressZstackSync = true;
      try { this._goToSlice(slice); } finally { st.suppressZstackSync = prev; }
    }
  },

  /** Mirror a sibling panel's browser (SYNC_ZSTACK_SLICE payload). */
  applySync(data) {
    if (!data) return;
    const { z } = this._getDims();
    if (z < 1) return;
    // Panels may hold different stacks: map indices by depth fraction, not verbatim.
    const total = Number(data.sliceTotal);
    const s = total > 0 && total !== z ? z / total : 1;
    const m = (v) => Math.round(Number(v) * s);
    if (Array.isArray(data.crop) && data.crop.length === 2) {
      this._cropLo = m(data.crop[0]);
      this._cropHi = m(data.crop[1]);
    }
    if (Number.isFinite(Number(data.thickness))) this._thickness = Math.max(1, m(data.thickness));
    if (data.mode === '3d') {
      this._mode = '3d';
    } else {
      this._mode = 'slice';
      this._lo = Number.isFinite(Number(data.cursor))
        ? m(data.cursor)
        : m(data.sliceIndex) - Math.floor((this._thickness - 1) / 2);
    }
    this._clampFields();
    this._apply();
  },

  // ── Workspace state ───────────────────────────────────────

  getState() {
    const st = this._ctx._state;
    return {
      zstackActive: st.zstackActive,
      zstackSlice: st.zstackCurrentSlice,
      mode: this._mode,
      cursor: this._lo,
      thickness: this._thickness,
      crop: [this._cropLo, this._cropHi]
    };
  },

  setState(s) {
    if (!s || typeof s.zstackActive !== 'boolean') return;
    this._restoreFields(s);
    this.applyState(s.zstackActive, null);
  },

  reset() {
    this._resetFields();
    this.applyState(false, null);
  },

  // ── Queries used by viewer.js ─────────────────────────────

  /** True while the browser holds the view top-down (camera sync is then zoom-only). */
  isSliceMode() {
    return !!this._ctx?._state.zstackActive && this._mode === 'slice';
  },

  /** The slice the Studio exports: cursor centre, or the middle of the kept range in 3D. */
  getStudioSliceIndex() {
    if (this._mode === 'slice') return this._lo + Math.floor((this._thickness - 1) / 2);
    return Math.floor((this._cropLo + this._cropHi) / 2);
  },

  /** The slices on screen, inclusive: the cursor's bar, or the whole kept range in 3D. */
  getStudioSliceRange() {
    if (this._mode === 'slice') return { lo: this._lo, hi: this._lo + this._thickness - 1 };
    return { lo: this._cropLo, hi: this._cropHi };
  },

  // ── Private: state ────────────────────────────────────────

  _resetFields() {
    this._mode = '3d';
    this._lo = 0;
    this._thickness = 1;
    this._cropLo = 0;
    this._cropHi = Infinity;
    this._clampFields();
  },

  _restoreFields(s) {
    const int = (v, fallback) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : fallback);
    const crop = Array.isArray(s.crop) && s.crop.length === 2 ? s.crop : [0, Infinity];
    this._cropLo = int(crop[0], 0);
    this._cropHi = Number(crop[1]) === Infinity ? Infinity : int(crop[1], Infinity);
    this._thickness = Math.max(1, int(s.thickness, 1));
    if (s.mode === '3d' || s.mode === 'slice') {
      this._mode = s.mode;
      this._lo = int(s.cursor, int(s.zstackSlice, 0));
    } else {
      // A state saved by the single-slice browser: its slice was the slab centre.
      const slice = int(s.zstackSlice, -1);
      this._mode = slice >= 0 ? 'slice' : '3d';
      this._lo = Math.max(0, slice);
    }
    this._clampFields();
  },

  _clampFields() {
    const { z } = this._getDims();
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    this._cropLo = clamp(this._cropLo, 0, z - 1);
    this._cropHi = clamp(this._cropHi, this._cropLo, z - 1);
    const kept = this._cropHi - this._cropLo + 1;
    this._thickness = clamp(this._thickness, 1, kept);
    this._lo = clamp(this._lo, this._cropLo, this._cropHi - this._thickness + 1);
  },

  /** Push mode + ranges to the volume, the DOM and (compare mode) the sibling panels. */
  _apply() {
    const st = this._ctx._state;
    const v = this._ctx.viewer;
    const { z } = this._getDims();
    let lo, hi;
    if (this._mode === '3d') {
      if (this._viewLocked) { v.setRotationLocked(false); this._viewLocked = false; }
      st.zstackCurrentSlice = -1;
      lo = this._cropLo;
      hi = this._cropHi;
    } else {
      if (!this._viewLocked) { v.setView('xy'); v.setRotationLocked(true); this._viewLocked = true; }
      lo = this._lo;
      hi = this._lo + this._thickness - 1;
      st.zstackCurrentSlice = lo + Math.floor((this._thickness - 1) / 2);
    }
    // Slice i occupies [i/z, (i+1)/z] of the normalised depth.
    v.setClipRange_z(lo / z, (hi + 1) / z);

    this._render();
    this._drawDiagram();

    if (this._ctx.iframe.isIframe() && !st.suppressZstackSync) {
      this._ctx.iframe.postMessage({
        type: 'SYNC_ZSTACK_SLICE',
        sliceIndex: Math.max(0, st.zstackCurrentSlice),
        sliceTotal: z,
        lo: lo / z,
        hi: (hi + 1) / z,
        mode: this._mode,
        cursor: this._lo,
        thickness: this._thickness,
        crop: [this._cropLo, this._cropHi],
        sourceIndex: this._ctx.iframe.panelIndex()
      });
    }
  },

  _enter3d() {
    if (this._mode === '3d') return;
    this._mode = '3d';
    this._apply();
  },

  /** Slice mode with the cursor's first slice at `lo` (clamped into the kept range). */
  _setCursor(lo) {
    this._mode = 'slice';
    this._lo = Math.round(lo);
    this._clampFields();
    this._apply();
  },

  /** Slice mode with the cursor centred on `index`. */
  _goToSlice(index) {
    this._setCursor(Math.round(index) - Math.floor((this._thickness - 1) / 2));
  },

  _setThickness(n) {
    this._thickness = Math.max(1, Math.round(n));
    this._clampFields();
    this._apply();
  },

  /** Step the cursor; the notch is one stop above the first kept slice. */
  _nudge(delta) {
    if (this._mode === '3d') {
      if (delta > 0) this._setCursor(this._cropLo);
      return;
    }
    const next = this._lo + delta;
    if (next < this._cropLo) {
      if (this._lo === this._cropLo) this._enter3d();
      else this._setCursor(this._cropLo);
      return;
    }
    this._setCursor(next);
  },

  _resetCrop() {
    this._cropLo = 0;
    this._cropHi = Infinity;
    this._clampFields();
    this._apply();
  },

  // ── Private: DOM ──────────────────────────────────────────

  _syncButton(active) {
    const btn = document.getElementById('btn-toggle-zstack');
    if (!btn) return;
    btn.classList.toggle('btn-solid', active);
    btn.classList.toggle('btn-ghost', !active);
  },

  _bindControls() {
    // The toolbar toggle is generated by PluginRegistry.buildToolbarButtons()
    // and wired to this module's activate() by bindToolbarButtons() — no self-bind.
    const $ = (id) => document.getElementById(id);
    this._ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const opts = this._ac ? { signal: this._ac.signal } : undefined;
    const on = (el, type, fn, extra) => { if (el) el.addEventListener(type, fn, extra ? { ...extra, ...(opts || {}) } : opts); };

    on($('btn-close-zstack'), 'click', () => {
      const st = this._ctx._state;
      st.zstackActive = false;
      this._syncButton(false);
      this._show(false);
    });

    on($('btn-zstack-prev'), 'click', () => this._nudge(-1));
    on($('btn-zstack-next'), 'click', () => this._nudge(1));
    on($('btn-zstack-thk-minus'), 'click', () => this._setThickness(this._thickness - 1));
    on($('btn-zstack-thk-plus'), 'click', () => this._setThickness(this._thickness + 1));
    on($('zstack-thickness-input'), 'change', (e) => this._setThickness(Number(e.target.value) || 1));
    on($('btn-zstack-crop-reset'), 'click', () => this._resetCrop());
    on($('btn-zstack-studio'), 'click', () => this._ctx.ui.openStudio());

    // Click on the diagram → slice mode on that plane.
    const diagCanvas = $('zstack-diagram-canvas');
    if (diagCanvas) {
      diagCanvas.style.cursor = 'pointer';
      on(diagCanvas, 'click', (e) => {
        const rect = diagCanvas.getBoundingClientRect();
        const scaleY = diagCanvas.height / rect.height;
        const clickY = (e.clientY - rect.top) * scaleY;
        const { z } = this._getDims();
        if (z < 1) return;
        const stackTop = 20;
        const stackBottom = diagCanvas.height - 30;
        const t = Math.max(0, Math.min(1, (clickY - stackTop) / (stackBottom - stackTop)));
        this._goToSlice(Math.round(t * (z - 1)));
      });
    }

    const root = $('zstack-vslider');
    const track = $('zstack-track');
    if (!root || !track) return;
    this._els = {
      root, track,
      notch: $('zstack-notch'),
      cursor: $('zstack-cursor'),
      maskTop: $('zstack-mask-top'),
      maskBottom: $('zstack-mask-bottom'),
      handleTop: $('zstack-handle-top'),
      handleBottom: $('zstack-handle-bottom'),
      sliceLabel: $('zstack-slice-label'),
      posLabel: $('zstack-position-label'),
      posInfo: $('zstack-position-info'),
      prev: $('btn-zstack-prev'),
      next: $('btn-zstack-next'),
      thkLabel: $('zstack-thickness-label'),
      thkInput: $('zstack-thickness-input'),
      thkUm: $('zstack-thickness-um'),
      cropRow: $('zstack-crop-row'),
      cropLabel: $('zstack-crop-label'),
      cropReset: $('btn-zstack-crop-reset')
    };

    on(root, 'pointerdown', (e) => this._startDrag(e));
    on(root, 'pointermove', (e) => this._dragTo(e));
    on(root, 'pointerup', () => this._endDrag());
    on(root, 'pointercancel', () => this._endDrag());
    on(root, 'wheel', (e) => {
      if (!this._ctx._state.zstackActive) return;
      e.preventDefault();
      this._nudge(e.deltaY > 0 ? 1 : -1);
    }, { passive: false });
    on(root, 'keydown', (e) => this._onKey(e));
  },

  _applyLabels() {
    const E = this._els;
    if (!E) return;
    const t = (k, p) => this._ctx.i18n.t(k, p);
    const title = (el, key) => { if (el) el.title = t(key); };
    title(E.notch, 'notchTitle');
    title(E.track, 'trackTitle');
    title(E.cursor, 'cursorTitle');
    title(E.handleTop, 'trimAboveTitle');
    title(E.handleBottom, 'trimBelowTitle');
    title(E.cropReset, 'resetTrim');
    if (E.thkLabel) E.thkLabel.textContent = t('thickness');
    if (E.thkInput) E.thkInput.title = t('thicknessTitle');
    if (E.root) E.root.setAttribute('aria-label', t('title'));
    const notchText = E.notch?.querySelector?.('span');
    if (notchText) notchText.textContent = t('notch');
  },

  /** Where the pointer is on the track: the slice under it and the nearest boundary. */
  _pointerPos(e) {
    const rect = this._els.track.getBoundingClientRect();
    const { z } = this._getDims();
    const frac = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    return {
      slice: clamp(Math.floor(frac * z), 0, z - 1),
      boundary: clamp(Math.round(frac * z), 0, z),
      above: e.clientY < rect.top - 6
    };
  },

  _startDrag(e) {
    if (e.button !== 0 || !this._ctx._state.zstackActive) return;
    const hit = (sel) => (typeof e.target?.closest === 'function' ? e.target.closest(sel) : null);
    let kind = null;
    let grab = 0;
    const centreGrab = Math.floor((this._thickness - 1) / 2);
    if (hit('.zs-notch')) {
      this._enter3d();
      kind = 'move';
      grab = centreGrab;
    } else if (hit('.zs-handle-top')) {
      kind = 'crop-top';
    } else if (hit('.zs-handle-bottom')) {
      kind = 'crop-bottom';
    } else if (hit('.zs-grip-top')) {
      kind = 'grip-top';
    } else if (hit('.zs-grip-bottom')) {
      kind = 'grip-bottom';
    } else if (hit('.zs-cursor')) {
      kind = 'move';
      grab = this._pointerPos(e).slice - this._lo;
    } else if (hit('.zs-track')) {
      kind = 'move';
      grab = centreGrab;
      this._setCursor(this._pointerPos(e).slice - grab);
    } else {
      return;
    }
    e.preventDefault();
    this._els.root.focus?.({ preventScroll: true });
    this._els.root.setPointerCapture?.(e.pointerId);
    this._els.root.classList.add('zs-dragging');
    this._drag = { kind, grab };
  },

  _dragTo(e) {
    const d = this._drag;
    if (!d) return;
    const p = this._pointerPos(e);
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    if (d.kind === 'move') {
      if (p.above) this._enter3d();
      else this._setCursor(p.slice - d.grab);
      return;
    }
    if (d.kind === 'grip-top') {
      const hi = this._lo + this._thickness - 1;
      const lo = clamp(p.boundary, this._cropLo, hi);
      this._lo = lo;
      this._thickness = hi - lo + 1;
    } else if (d.kind === 'grip-bottom') {
      const hi = clamp(p.boundary - 1, this._lo, this._cropHi);
      this._thickness = hi - this._lo + 1;
    } else if (d.kind === 'crop-top') {
      this._cropLo = clamp(p.boundary, 0, this._cropHi);
    } else if (d.kind === 'crop-bottom') {
      const { z } = this._getDims();
      this._cropHi = clamp(p.boundary - 1, this._cropLo, z - 1);
    }
    this._clampFields();
    this._apply();
  },

  _endDrag() {
    if (!this._drag) return;
    this._drag = null;
    this._els.root.classList.remove('zs-dragging');
  },

  _onKey(e) {
    if (!this._ctx._state.zstackActive) return;
    const { z } = this._getDims();
    switch (e.key) {
      case 'ArrowUp': this._nudge(-1); break;
      case 'ArrowDown': this._nudge(1); break;
      case 'PageUp': this._nudge(-Math.max(1, Math.round(z / 10))); break;
      case 'PageDown': this._nudge(Math.max(1, Math.round(z / 10))); break;
      case 'Home': this._enter3d(); break;
      case 'End': this._setCursor(this._cropHi - this._thickness + 1); break;
      case '+': case '=': this._setThickness(this._thickness + 1); break;
      case '-': case '_': this._setThickness(this._thickness - 1); break;
      default: return;
    }
    e.preventDefault();
  },

  _show(visible) {
    const panel = document.getElementById('zstack-browser');
    if (!panel) return;
    panel.classList.toggle('zstack-hidden', !visible);
    const v = this._ctx.viewer;
    if (visible) {
      this._populateInfo();
      this._clampFields();
      this._apply();
    } else {
      if (this._viewLocked) { v.setRotationLocked(false); this._viewLocked = false; }
      v.resetClipping();
      this._ctx._state.zstackCurrentSlice = 0;
    }
    this._ctx.ui.scheduleResize();
  },

  _getDims() {
    const meta = this._ctx.dataset.getMeta();
    const dims = meta?.dimensions || {};
    const vs = meta?.voxel_size || {};
    const z = Number(dims.z) || 1;
    const c = Number(dims.c) || 1;
    const vz = Number(vs.z) || 1;
    const totalRange = z > 1 ? (z - 1) * vz : vz;
    const interval = z > 1 ? vz : 0;
    return { z, c, vz, totalRange, interval };
  },

  _populateInfo() {
    const { z, c, vz, totalRange, interval } = this._getDims();
    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    set('zstack-total-slices', String(z));
    set('zstack-range', `${totalRange.toFixed(2)} µm`);
    set('zstack-interval', interval > 0 ? `${interval.toFixed(2)} µm` : '—');
    set('zstack-voxel-z', `${vz.toFixed(4)} µm`);
    set('zstack-channels', String(c));
    const E = this._els;
    if (E?.root) {
      E.root.setAttribute('aria-valuemin', '-1');
      E.root.setAttribute('aria-valuemax', String(z - 1));
    }
  },

  _render() {
    const E = this._els;
    if (!E) return;
    const { z, vz } = this._getDims();
    const t = (k, p) => this._ctx.i18n.t(k, p);
    const is3d = this._mode === '3d';
    const a = this._lo;
    const b = this._lo + this._thickness - 1;
    const kept = this._cropHi - this._cropLo + 1;
    const pct = (v) => `${(v * 100).toFixed(4)}%`;
    const um = (i) => (i * vz).toFixed(2);

    E.root.classList.toggle('zs-mode-3d', is3d);
    E.maskTop.style.height = pct(this._cropLo / z);
    E.maskBottom.style.height = pct((z - 1 - this._cropHi) / z);
    E.handleTop.style.top = pct(this._cropLo / z);
    E.handleBottom.style.top = pct((this._cropHi + 1) / z);
    E.cursor.style.top = pct(a / z);
    E.cursor.style.height = pct(this._thickness / z);

    let slice, pos, info;
    if (is3d) {
      slice = t('notch');
      pos = `${um(this._cropLo)}–${um(this._cropHi)} µm`;
      info = t('info3d', { n: kept, total: z, lo: this._cropLo + 1, hi: this._cropHi + 1, depth: (kept * vz).toFixed(2) });
    } else if (this._thickness === 1) {
      slice = `${a + 1} / ${z}`;
      pos = `${um(a)} µm`;
      info = t('sliceDepth', { n: a + 1, total: z, depth: um(a) });
    } else {
      slice = `${a + 1}–${b + 1} / ${z}`;
      pos = `${um(a)}–${um(b)} µm`;
      info = t('slabDepth', { a: a + 1, b: b + 1, total: z, from: um(a), to: um(b) });
    }
    if (E.sliceLabel) E.sliceLabel.textContent = slice;
    if (E.posLabel) E.posLabel.textContent = pos;
    if (E.posInfo) E.posInfo.textContent = info;

    if (E.thkInput) { E.thkInput.max = String(kept); E.thkInput.value = String(this._thickness); }
    if (E.thkUm) E.thkUm.textContent = `${(this._thickness * vz).toFixed(2)} µm`;
    if (E.cropLabel) {
      E.cropLabel.textContent = kept === z
        ? t('keptAll', { total: z })
        : t('kept', { lo: this._cropLo + 1, hi: this._cropHi + 1, n: kept, total: z });
    }
    if (E.cropRow) E.cropRow.classList.toggle('zs-full', kept === z);
    if (E.prev) E.prev.disabled = is3d;
    if (E.next) E.next.disabled = !is3d && a >= this._cropHi - this._thickness + 1;

    E.root.setAttribute('aria-valuenow', String(is3d ? -1 : this._ctx._state.zstackCurrentSlice));
    E.root.setAttribute('aria-valuetext', info);
  },

  _drawDiagram() {
    const canvas = document.getElementById('zstack-diagram-canvas');
    if (!canvas) return;
    const ctx2d = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx2d.clearRect(0, 0, W, H);

    const { z } = this._getDims();
    if (z < 1) return;

    const maxVisible  = Math.min(z, 40);
    const step        = z > maxVisible ? z / maxVisible : 1;
    const planeCount  = Math.min(z, maxVisible);
    const planeW      = 130;
    const planeDepth  = 14;
    const skewX       = 20;
    const stackTop    = 20;
    const stackBottom = H - 30;
    const stackRange  = stackBottom - stackTop;
    const is3d = this._mode === '3d';
    const a = this._lo;
    const b = this._lo + this._thickness - 1;
    const centre = a + Math.floor((this._thickness - 1) / 2);

    // A thin cursor can fall between two drawn planes: always light the closest one.
    let closestPlane = 0;
    let closestDist  = Infinity;
    for (let i = 0; i < planeCount; i++) {
      const d = Math.abs(Math.round(i * step) - centre);
      if (d < closestDist) { closestDist = d; closestPlane = i; }
    }

    for (let i = 0; i < planeCount; i++) {
      const ri = Math.round(i * step);
      const t  = i / Math.max(1, planeCount - 1);
      const y  = stackTop + t * stackRange;
      const cx = (W - planeW) / 2;
      const trimmed = ri < this._cropLo || ri > this._cropHi;
      const inSlab = !is3d && !trimmed && ((ri >= a && ri <= b) || i === closestPlane);

      ctx2d.save();
      ctx2d.beginPath();
      ctx2d.moveTo(cx + skewX,          y);
      ctx2d.lineTo(cx + planeW + skewX, y);
      ctx2d.lineTo(cx + planeW,         y + planeDepth);
      ctx2d.lineTo(cx,                  y + planeDepth);
      ctx2d.closePath();

      if (trimmed) {
        ctx2d.globalAlpha = 0.5;
        ctx2d.fillStyle   = 'rgba(120, 120, 130, 0.12)';
        ctx2d.strokeStyle = 'rgba(255, 107, 107, 0.35)';
        ctx2d.lineWidth   = 1;
      } else if (inSlab) {
        ctx2d.globalAlpha = 1.0;
        ctx2d.fillStyle   = 'rgba(80, 180, 255, 0.55)';
        ctx2d.strokeStyle = 'rgba(80, 200, 255, 0.95)';
        ctx2d.lineWidth   = 2;
      } else if (is3d) {
        ctx2d.globalAlpha = 0.55;
        ctx2d.fillStyle   = 'rgba(80, 180, 255, 0.45)';
        ctx2d.strokeStyle = 'rgba(80, 200, 255, 0.7)';
        ctx2d.lineWidth   = 1;
      } else {
        ctx2d.globalAlpha = 0.1;
        ctx2d.fillStyle   = 'rgba(50, 90, 160, 0.3)';
        ctx2d.strokeStyle = 'rgba(100, 160, 220, 0.25)';
        ctx2d.lineWidth   = 1;
      }
      ctx2d.fill();
      ctx2d.stroke();
      ctx2d.restore();
    }

    const kept = this._cropHi - this._cropLo + 1;
    let label;
    if (is3d) label = `3D · ${kept} / ${z}`;
    else if (this._thickness === 1) label = `Z ${a + 1} / ${z}`;
    else label = `Z ${a + 1}–${b + 1} / ${z}`;

    ctx2d.save();
    ctx2d.font      = 'bold 11px Inter, sans-serif';
    ctx2d.fillStyle = 'rgba(255,255,255,0.7)';
    ctx2d.textAlign = 'center';
    ctx2d.fillText(label, W / 2, H - 6);
    ctx2d.restore();
  },

  dispose() {
    this._ac?.abort();
    this._ac = null;
    this._els = null;
    this._drag = null;
  }
});
