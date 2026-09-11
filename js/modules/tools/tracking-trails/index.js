/* Tracking Trails — index.js
 *
 * The trajectory of every tracked cell, drawn in the volume's own object space
 * (a child of the volume cube, like the centroid overlay), so orbit, pan, the
 * physical aspect ratio, the Z display scale and the shader's clip box all
 * apply unchanged. Positions are read through ctx.tracking — never re-derived
 * from tracks.json — so the trails and the points can only ever agree on which
 * frame of reference (stabilised / raw) is on screen.
 *
 * One THREE.LineSegments holds every segment of every trail; it is rebuilt on a
 * frame change, a clip change, a selection change or an option change. On the
 * reference series that is ≤ 579 cells × 29 steps, well under a millisecond.
 */
PluginRegistry.implement('tracking-trails', {
  _ctx: null,
  _T: null,
  _active: false,
  _section: null,
  _unsubs: [],
  _group: null,
  _lines: null,
  _geometry: null,
  _material: null,
  _capacity: 0,
  _maxSpeed: 0,
  _opts: { length: 0, future: false, opacity: 0.6, colorBy: 'region' },

  _t(key, params) { return this._ctx.i18n.t(key, params); },

  init(ctx) {
    this._ctx = ctx;
    this._T = ctx.tracking;
    if (!this._T || !this._T.isAvailable()) return this;   // chip hidden by requires:['tracking']
    this._section = ctx.ui.addSidebarSection({
      id: 'tracking-trails',
      title: this._t('title'),
      html: this._html(),
      hidden: true,
      bind: (body) => this._bind(body)
    });
    const rebuild = () => this._rebuild();
    this._unsubs = [
      this._T.on('loaded', () => { this._maxSpeed = 0; this._syncLengthRange(); rebuild(); }),
      this._T.on('frame', rebuild),
      this._T.on('refresh', rebuild),
      this._T.on('selection', rebuild),
      this._T.on('style', rebuild)
    ];
    ctx.i18n.onLanguageChange?.(() => this._applyLabels());
    return this;
  },

  activate() {
    this._setActive(!this._active);
    return { active: this._active };
  },

  // ── Workspace state ───────────────────────────────────────

  getState() { return { active: this._active, ...this._opts }; },

  setState(s) {
    if (!s || typeof s !== 'object') return;
    if (Number.isFinite(s.length)) this._opts.length = Math.max(0, Math.round(s.length));
    if (typeof s.future === 'boolean') this._opts.future = s.future;
    if (Number.isFinite(s.opacity)) this._opts.opacity = Math.max(0.05, Math.min(1, s.opacity));
    if (s.colorBy === 'region' || s.colorBy === 'speed') this._opts.colorBy = s.colorBy;
    this._syncControls();
    this._setActive(Boolean(s.active));
    PluginRegistry.syncToolbarButton('tracking-trails', { active: this._active });
  },

  reset() {
    this._opts = { length: 0, future: false, opacity: 0.6, colorBy: 'region' };
    this._syncControls();
    this._setActive(false);
    PluginRegistry.syncToolbarButton('tracking-trails', { active: false });
  },

  dispose() {
    this._unsubs.forEach(fn => fn());
    this._unsubs = [];
    this._destroyLines();
    this._section?.remove();
    this._section = null;
  },

  // ── Private: state ────────────────────────────────────────

  _setActive(on) {
    this._active = Boolean(on);
    if (this._section) this._section.root.hidden = !this._active;
    if (this._active) this._rebuild();
    else if (this._group) { this._group.visible = false; this._T.triggerRender(); }
  },

  // ── Private: geometry ─────────────────────────────────────

  _ensureLines(segmentCount) {
    if (this._lines && this._capacity >= segmentCount) return true;
    const parent = this._T.getVolumeObject();
    if (!parent) return false;
    this._destroyLines();
    this._capacity = Math.max(64, segmentCount);
    this._geometry = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(new Float32Array(this._capacity * 2 * 3), 3);
    const col = new THREE.BufferAttribute(new Float32Array(this._capacity * 2 * 3), 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    col.setUsage(THREE.DynamicDrawUsage);
    this._geometry.setAttribute('position', pos);
    this._geometry.setAttribute('color', col);
    this._geometry.setDrawRange(0, 0);
    this._material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: this._opts.opacity,
      // The volume is an additive ray-march without depth: a depth test would
      // hide every trail behind the cube's front face (same rule as the points).
      depthTest: false,
      depthWrite: false
    });
    this._lines = new THREE.LineSegments(this._geometry, this._material);
    this._lines.frustumCulled = false;
    this._group = new THREE.Group();
    this._group.renderOrder = 39;      // just under the centroids (40)
    this._group.add(this._lines);
    parent.add(this._group);
    return true;
  },

  _destroyLines() {
    if (this._group) {
      const parent = this._T?.getVolumeObject();
      parent?.remove(this._group);
    }
    this._geometry?.dispose?.();
    this._material?.dispose?.();
    this._group = null; this._lines = null; this._geometry = null; this._material = null;
    this._capacity = 0;
  },

  /** The fastest step of the whole series, so "colour by speed" keeps one scale
   *  across frames instead of re-normalising every rebuild. */
  _speedScale(data) {
    if (this._maxSpeed > 0) return this._maxSpeed;
    let max = 0;
    const a = [0, 0, 0], b = [0, 0, 0];
    for (let c = 0; c < data.cellTotal; c++) {
      for (let f = data.firstFrame[c]; f < data.lastFrame[c]; f++) {
        if (!this._T.positionUm(c, f, {}, a) || !this._T.positionUm(c, f + 1, {}, b)) continue;
        const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / this._dt(data, f);
        if (d > max) max = d;
      }
    }
    this._maxSpeed = max > 0 ? max : 1;
    return this._maxSpeed;
  },

  _dt(data, f) {
    const t = data.timepoints;
    return (t && t.length > f + 1) ? Math.max(1e-6, t[f + 1] - t[f]) : 1;
  },

  _rebuild() {
    if (!this._active) return;
    const T = this._T;
    const data = T.getData();
    if (!data) return;
    const maxSegments = data.cellTotal * Math.max(1, data.frameCount - 1);
    if (!this._ensureLines(maxSegments)) return;

    const style = T.getStyle() || {};
    const frame = T.getFrame();
    const selected = T.getSelected();
    const len = this._opts.length > 0 ? this._opts.length : data.frameCount;
    const bySpeed = this._opts.colorBy === 'speed';
    const maxSpeed = bySpeed ? this._speedScale(data) : 1;
    const pos = this._geometry.attributes.position.array;
    const col = this._geometry.attributes.color.array;
    const v0 = new THREE.Vector3(), v1 = new THREE.Vector3();
    const um0 = [0, 0, 0], um1 = [0, 0, 0];
    const tmp = new THREE.Color();
    let n = 0;   // vertices written

    for (let c = 0; c < data.cellTotal; c++) {
      const flags = data.flags[c];
      if (style.showMitosis === false && (flags & 1)) continue;
      if (style.showFusion === false && (flags & 2)) continue;
      const first = data.firstFrame[c], last = data.lastFrame[c];
      if (first < 0 || last <= first) continue;
      const isSel = c === selected;
      const pastStart = Math.max(first, frame - len);
      const pastEnd = Math.min(last, frame);
      const futureEnd = this._opts.future ? Math.min(last, frame + len) : pastEnd;
      if (pastStart >= futureEnd) continue;

      const r = data.palette[c * 3], g = data.palette[c * 3 + 1], b = data.palette[c * 3 + 2];
      for (let f = pastStart; f < futureEnd; f++) {
        if (!T.positionObject(c, f, v0) || !T.positionObject(c, f + 1, v1)) continue;
        // A segment entirely outside the clip box goes with the points it links.
        if (!T.isInsideClip(v0) && !T.isInsideClip(v1)) continue;
        const ahead = f >= pastEnd;
        // Older steps fade towards the tail; the path ahead is a faint hint.
        let k = ahead ? 0.3 : 0.35 + 0.65 * ((f - pastStart + 1) / Math.max(1, pastEnd - pastStart));
        if (isSel) k = ahead ? 0.55 : 1;
        if (bySpeed) {
          T.positionUm(c, f, {}, um0); T.positionUm(c, f + 1, {}, um1);
          const s = Math.hypot(um1[0] - um0[0], um1[1] - um0[1], um1[2] - um0[2]) / this._dt(data, f);
          tmp.setHSL(0.58 - Math.min(1, s / maxSpeed) * 0.58, 0.95, 0.56);
        } else {
          tmp.setRGB(r, g, b);
        }
        if (isSel) tmp.lerp(new THREE.Color(1, 1, 1), 0.5);
        const o = n * 3;
        pos[o] = v0.x; pos[o + 1] = v0.y; pos[o + 2] = v0.z;
        pos[o + 3] = v1.x; pos[o + 4] = v1.y; pos[o + 5] = v1.z;
        col[o] = tmp.r * k; col[o + 1] = tmp.g * k; col[o + 2] = tmp.b * k;
        col[o + 3] = tmp.r * k; col[o + 4] = tmp.g * k; col[o + 5] = tmp.b * k;
        n += 2;
      }
    }
    this._geometry.setDrawRange(0, n);
    this._geometry.attributes.position.needsUpdate = true;
    this._geometry.attributes.color.needsUpdate = true;
    this._material.opacity = this._opts.opacity;
    this._group.visible = n > 0 && style.visible !== false;
    T.triggerRender();
  },

  // ── Private: sidebar ──────────────────────────────────────

  _html() {
    const esc = (s) => this._ctx.ui.escapeHtml(s);
    return `
      <div class="layer-row">
        <label for="tt-length" data-tt="length">${esc(this._t('length'))}</label>
        <input type="range" id="tt-length" min="0" max="1" step="1" value="0">
        <output id="tt-length-out">${esc(this._t('allFrames'))}</output>
      </div>
      <label class="tool-toggle"><input type="checkbox" id="tt-future"><span data-tt="future">${esc(this._t('future'))}</span></label>
      <div class="layer-row">
        <label for="tt-opacity" data-tt="opacity">${esc(this._t('opacity'))}</label>
        <input type="range" id="tt-opacity" min="5" max="100" step="5" value="60">
        <output id="tt-opacity-out">60%</output>
      </div>
      <label class="text-xs text-muted"><span data-tt="colorBy">${esc(this._t('colorBy'))}</span>
        <select id="tt-color" class="form-select text-sm p-1 rounded border border-light bg-surface text-primary" style="width:100%;">
          <option value="region" data-tt="colorRegion">${esc(this._t('colorRegion'))}</option>
          <option value="speed" data-tt="colorSpeed">${esc(this._t('colorSpeed'))}</option>
        </select>
      </label>`;
  },

  _bind(body) {
    const $ = (id) => body.querySelector(`#${id}`);
    this._els = {
      length: $('tt-length'), lengthOut: $('tt-length-out'), future: $('tt-future'),
      opacity: $('tt-opacity'), opacityOut: $('tt-opacity-out'), color: $('tt-color')
    };
    this._els.length?.addEventListener('input', () => {
      this._opts.length = Number(this._els.length.value) || 0;
      this._syncLengthLabel();
      this._rebuild();
    });
    this._els.future?.addEventListener('change', () => { this._opts.future = this._els.future.checked; this._rebuild(); });
    this._els.opacity?.addEventListener('input', () => {
      this._opts.opacity = Number(this._els.opacity.value) / 100;
      if (this._els.opacityOut) this._els.opacityOut.textContent = `${this._els.opacity.value}%`;
      this._rebuild();
    });
    this._els.color?.addEventListener('change', () => { this._opts.colorBy = this._els.color.value; this._rebuild(); });
    this._syncLengthRange();
    this._syncControls();
  },

  _syncLengthRange() {
    const data = this._T?.getData();
    if (this._els?.length && data) this._els.length.max = String(Math.max(1, data.frameCount - 1));
    this._syncLengthLabel();
  },

  _syncLengthLabel() {
    if (!this._els?.lengthOut) return;
    this._els.lengthOut.textContent = this._opts.length > 0
      ? this._t('frames', { n: this._opts.length })
      : this._t('allFrames');
  },

  _syncControls() {
    const E = this._els;
    if (!E) return;
    if (E.length) E.length.value = String(this._opts.length);
    if (E.future) E.future.checked = this._opts.future;
    if (E.opacity) E.opacity.value = String(Math.round(this._opts.opacity * 100));
    if (E.opacityOut) E.opacityOut.textContent = `${Math.round(this._opts.opacity * 100)}%`;
    if (E.color) E.color.value = this._opts.colorBy;
    this._syncLengthLabel();
  },

  _applyLabels() {
    if (!this._section) return;
    this._section.setTitle(this._t('title'));
    this._section.body.querySelectorAll('[data-tt]').forEach(el => {
      el.textContent = this._t(el.getAttribute('data-tt'));
    });
    this._syncLengthLabel();
  }
});
