/* Measure Distance — index.js
 *
 * Migrates _handleVolumeMeasurePoint, _createVolumeMeasurement,
 * _renderVolumeMeasurement, _handleVolumeMeasureListClick,
 * _clearVolumeMeasurement, _setVolumeMeasureStatus,
 * _showMeasureColorPopup, _closeMeasureColorPopup, _distance3d,
 * _fmtUm (inline), MEASURE_PALETTE, MEASUREMENT_COLORS from viewer.js.
 *
 * This module manages its own measurement state locally, syncing it
 * with MeasurementStore via ctx.measurements.
 */
PluginRegistry.implement('measure-distance', {
  _ctx: null,
  _draft: [],         // Up to 2 pending raw pick points
  _measurements: [],  // Committed measurements from MeasurementStore
  _unsubscribe: null, // VolumeViewer.onMeasurePoint cleanup

  // ─── Colour constants ──────────────────────────────────────
  PALETTE: [
    ['#FFD700', '#00FFFF', '#FF1493', '#7FFF00', '#FF4500'],
    ['#9400D3', '#00FF7F', '#FF69B4', '#1E90FF', '#FFFFFF']
  ],
  COLORS: ['#00FFFF','#FFD700','#FF1493','#7FFF00','#FF4500','#9400D3','#00FF7F','#FF69B4'],

  init(ctx) {
    this._ctx = ctx;
    // Load persisted measurements
    this._measurements = ctx.measurements.list('viewer');

    // Hook VolumeViewer pick events
    ctx.viewer.onMeasurePoint(pt => this._handlePoint(pt));

    // Bind list interaction (toggle, delete, rename, color)
    const list = document.getElementById('volume-measure-list');
    if (list) {
      list.addEventListener('click',  e => this._handleListEvent(e));
      list.addEventListener('change', e => this._handleListEvent(e));
    }

    // Bind Clear button
    document.getElementById('btn-measure-clear')?.addEventListener('click', () => this._clear());

    this._render();
    return this;
  },

  // ── Workspace state ───────────────────────────────────────

  getState() {
    return { measurements: this._measurements };
  },

  setState(s) {
    if (!s?.measurements) return;
    this._measurements = this._ctx.measurements.setAll('viewer', s.measurements);
    this._ctx.viewer.setMeasurements(this._measurements);
    this._render();
  },

  // ── Private ───────────────────────────────────────────────

  _handlePoint(point) {
    const calibration = this._ctx.viewer.getPhysicalCalibration?.();
    if (calibration?.calibrationStatus === 'metadata-missing') {
      this._setStatus('Physical calibration is missing for this dataset. Distance measurement needs calibrated voxel metadata.');
      return;
    }
    if (!point?.physicalUm) {
      this._setStatus('No calibrated volume point was detected.');
      return;
    }
    if (this._draft.length >= 2) this._draft = [];
    this._draft.push(point);
    if (this._draft.length === 2) this._commit();
    this._render();
  },

  _commit() {
    if (this._draft.length !== 2) return;
    const [aPoint, bPoint] = this._draft;
    const color = this.COLORS[this._measurements.length % this.COLORS.length];
    const measurement = this._ctx.measurements.add('viewer', {
      scope: 'viewer',
      label: `Measure ${this._measurements.length + 1}`,
      unit: 'um',
      distance: this._dist3d(aPoint.physicalUm, bPoint.physicalUm),
      points: this._draft.map(p => ({ normalized: p.normalized, physicalUm: p.physicalUm })),
      timepoint: this._ctx._state.currentTimepoint,
      color
    });
    this._measurements.push(measurement);
    this._draft = [];
    this._ctx.viewer.setMeasurements(this._measurements);
  },

  _clear() {
    this._draft = [];
    this._measurements = this._ctx.measurements.clear('viewer');
    this._ctx.viewer.setMeasurements(this._measurements);
    this._render();
  },

  _render() {
    const list = document.getElementById('volume-measure-list');
    const esc  = s => this._ctx.ui.escapeHtml(s);

    if (list) {
      list.innerHTML = this._measurements.length
        ? this._measurements.map(item => `
          <div class="measurement-row" style="display:flex;align-items:center;gap:4px;padding:4px 0;">
            <button class="btn btn-ghost btn-sm measure-color-btn" type="button"
              data-volume-measure-action="toggle-color" data-measurement-id="${esc(item.id)}"
              style="padding:0;width:24px;height:24px;border:none;flex-shrink:0;">
              <span style="background:${item.color};width:16px;height:16px;display:inline-block;border-radius:3px;border:1px solid rgba(255,255,255,0.2);vertical-align:middle;"></span>
            </button>
            <input type="text" value="${esc(item.label || '')}" placeholder="Label"
              class="form-input text-xs" data-volume-measure-action="rename" data-measurement-id="${esc(item.id)}"
              style="flex:1;min-width:0;width:50px;padding:2px 4px;background:rgba(0,0,0,0.2);border:1px solid var(--border-light);color:var(--text-primary);border-radius:4px;">
            <span style="white-space:nowrap;font-size:11px;color:var(--text-muted);">
              ${item.visible === false ? 'Hidden' : `${this._fmtUm(item.distance)} µm`}
            </span>
            <span class="related-actions" style="display:flex;gap:2px;">
              <button class="btn btn-ghost btn-sm" type="button"
                data-volume-measure-action="toggle" data-measurement-id="${esc(item.id)}" style="padding:2px;">
                <i data-lucide="${item.visible === false ? 'eye-off' : 'eye'}"></i>
              </button>
              <button class="btn btn-ghost btn-sm" type="button"
                data-volume-measure-action="delete" data-measurement-id="${esc(item.id)}" style="padding:2px;">
                <i data-lucide="trash-2"></i>
              </button>
            </span>
          </div>
        `).join('')
        : 'No saved measurement yet.';
      this._ctx.ui.createIcons({ nodes: [list] });
    }

    // Status / live result area
    if (!this._draft.length) {
      this._setStatus('Click two points on the embryo surface.');
      return;
    }
    if (this._draft.length === 1) {
      const p = this._draft[0].physicalUm;
      this._setStatus(`
        <div class="metric-tile"><small>Point A</small><strong>${this._fmtUm(p.x)}, ${this._fmtUm(p.y)}, ${this._fmtUm(p.z)} um</strong></div>
        <div class="text-xs text-muted">Click a second point to measure distance.</div>
      `);
      return;
    }
    const [a, b] = this._draft.map(p => p.physicalUm);
    const dist   = this._dist3d(a, b);
    this._setStatus(`
      <div class="metric-grid">
        <div class="metric-tile"><small>Distance</small><strong>${this._fmtUm(dist)} um</strong></div>
        <div class="metric-tile"><small>Delta Z</small><strong>${this._fmtUm(Math.abs(a.z - b.z))} um</strong></div>
      </div>
      <div class="text-xs text-muted">Measured between two picked surface points in calibrated physical coordinates.</div>
    `);
  },

  _handleListEvent(e) {
    const action = e.target.closest('[data-volume-measure-action]')?.dataset.volumeMeasureAction;
    const id     = e.target.closest('[data-measurement-id]')?.dataset.measurementId;
    if (!action || !id) return;

    if (action === 'toggle' && e.type === 'click') {
      const item = this._measurements.find(r => r.id === id);
      if (!item) return;
      this._ctx.measurements.update('viewer', id, { visible: item.visible === false });
      this._measurements = this._ctx.measurements.list('viewer');
      this._ctx.viewer.setMeasurements(this._measurements);
      this._render();
    }
    if (action === 'delete' && e.type === 'click') {
      this._measurements = this._ctx.measurements.remove('viewer', id);
      this._ctx.viewer.setMeasurements(this._measurements);
      this._render();
    }
    if (action === 'rename' && e.type === 'change') {
      this._ctx.measurements.update('viewer', id, { label: e.target.value });
      this._measurements = this._ctx.measurements.list('viewer');
      this._ctx.viewer.setMeasurements(this._measurements);
      this._render();
    }
    if (action === 'toggle-color' && e.type === 'click') {
      const btn = e.target.closest('[data-volume-measure-action="toggle-color"]');
      if (btn) this._showColorPopup(id, btn);
    }
  },

  _showColorPopup(id, anchorEl) {
    this._closeColorPopup();
    const popup = document.createElement('div');
    popup.id = 'measure-color-popup-active';
    popup.style.cssText = 'position:fixed;background:var(--bg-surface,#222);border:1px solid var(--border-color,#444);border-radius:6px;padding:6px;z-index:99999;box-shadow:0 4px 12px rgba(0,0,0,0.5);display:flex;flex-direction:column;gap:4px;';
    for (const row of this.PALETTE) {
      const rowDiv = document.createElement('div');
      rowDiv.style.cssText = 'display:flex;gap:4px;';
      for (const color of row) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.style.cssText = `width:20px;height:20px;border-radius:4px;border:1px solid rgba(255,255,255,0.15);background:${color};padding:0;cursor:pointer;transition:transform 0.1s;`;
        btn.title = color;
        btn.onmouseover = () => btn.style.transform = 'scale(1.1)';
        btn.onmouseout  = () => btn.style.transform = 'scale(1)';
        btn.onclick = (e) => {
          e.stopPropagation();
          this._ctx.measurements.update('viewer', id, { color });
          this._measurements = this._ctx.measurements.list('viewer');
          this._ctx.viewer.setMeasurements(this._measurements);
          this._render();
          this._closeColorPopup();
        };
        rowDiv.appendChild(btn);
      }
      popup.appendChild(rowDiv);
    }
    document.body.appendChild(popup);
    const rect = anchorEl.getBoundingClientRect();
    popup.style.top  = `${rect.bottom + 4}px`;
    popup.style.left = `${rect.left}px`;
    requestAnimationFrame(() => {
      const pr = popup.getBoundingClientRect();
      if (pr.right > window.innerWidth) popup.style.left = `${rect.right - pr.width}px`;
    });
  },

  _closeColorPopup() {
    document.getElementById('measure-color-popup-active')?.remove();
  },

  _setStatus(html) {
    const node = document.getElementById('volume-measure-status');
    if (node) node.innerHTML = html;
  },

  _dist3d(a, b) {
    const dx = (a.x || 0) - (b.x || 0);
    const dy = (a.y || 0) - (b.y || 0);
    const dz = (a.z || 0) - (b.z || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  },

  _fmtUm(v) {
    if (!Number.isFinite(v)) return '—';
    return v >= 1000 ? `${(v / 1000).toFixed(3)} mm` : `${v.toFixed(2)} µm`;
  },

  dispose() {
    this._clear();
    this._closeColorPopup();
  }
});
