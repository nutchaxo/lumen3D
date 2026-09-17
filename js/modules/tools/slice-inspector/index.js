/* Slice Inspector — index.js
 *
 * Owns the inspector panel (#slice-inspector): preset buttons, position / angle /
 * slab sliders, projection select and the Studio button, bound to the VolumeSlicer
 * through ctx.slicer. The tool itself is the ToolManager's 'slice' (its chip comes
 * from plugin.json#tool): viewer.js opens and closes the panel on the tool change,
 * and while the tool is open the two renders trade places — the slice fills the
 * canvas area, the 3D view sits in this panel's square, where the plane is still
 * dragged (viewer.js _setSliceStage). The tool and the Z-stack browser exclude
 * each other: each side closes the other when it opens.
 */
PluginRegistry.implement('slice-inspector', {
  _ctx: null,

  init(ctx) {
    this._ctx = ctx;
    this._initSlicer();
    return this;
  },

  // ── Programmatic door (the chip itself is wired by ToolManager) ──

  activate() {
    const tools = this._ctx?.tools;
    if (!tools) return;
    tools.activate(tools.current() === 'slice' ? 'navigate' : 'slice');
  },

  getState() { return null; }, // Plane spec is stored in viewer.js workspace state

  // The plane spec itself is reset by the viewer (VolumeViewer.resetClipping);
  // what belongs to this module is the panel and the slicer render loop.
  reset() {
    const tools = this._ctx?.tools;
    if (tools?.current() === 'slice') tools.activate('navigate');
    else this._hide();
  },

  // ── Private ───────────────────────────────────────────────

  _initSlicer() {
    const ctx = this._ctx;
    if (!ctx.slicer.init) return;

    // Initialize slicer with renderer
    const r = ctx.viewer.getRenderer();
    if (r) {
      ctx.slicer.init({ renderer: r, material: ctx.viewer.getMaterial() });
      const mat = ctx.viewer.getMaterial();
      if (mat) ctx.slicer.updateMaterial(mat);
    }

    // Mount preview canvas
    const mount = document.getElementById('slicer-preview-mount');
    if (mount) {
      mount.innerHTML = '';
      const previewCanvas = ctx.slicer.getPreviewCanvas();
      if (previewCanvas) mount.appendChild(previewCanvas);
    }

    // Preset buttons
    document.querySelectorAll('.slicer-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.preset;
        document.querySelectorAll('.slicer-preset').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._setSpec({ mode, yaw: 0, pitch: 0, roll: 0 });
        this._syncSlidersFromSpec();
      });
    });

    // Position slider
    this._bindSlider('slicer-position', 'slicer-val-pos',
      v => this._setSpec({ value: v / 100 }),
      v => (v / 100).toFixed(2));

    // Angle sliders
    this._bindSlider('slicer-yaw', 'slicer-val-yaw',
      v => { this._setSpec({ mode: 'oblique', yaw: v }); this._syncPresetButtons('oblique'); },
      v => `${v}°`);
    this._bindSlider('slicer-pitch', 'slicer-val-pitch',
      v => { this._setSpec({ mode: 'oblique', pitch: v }); this._syncPresetButtons('oblique'); },
      v => `${v}°`);
    this._bindSlider('slicer-roll', 'slicer-val-roll',
      v => { this._setSpec({ mode: 'oblique', roll: v }); this._syncPresetButtons('oblique'); },
      v => `${v}°`);

    // Slab thickness
    this._bindSlider('slicer-slab', 'slicer-val-slab',
      v => this._setSpec({ slabThickness: v }),
      v => String(v));

    // Projection mode
    document.getElementById('slicer-projection')?.addEventListener('change', e => {
      this._setSpec({ projection: e.target.value });
    });

    // Open in Studio
    document.getElementById('btn-slicer-studio')?.addEventListener('click', () => ctx.ui.openStudio());

    // Sync slicer when 3D plane changes via drag
    ctx.viewer.onPlaneSpecChange(spec => {
      if (!ctx.slicer.isVisible()) return;
      ctx.slicer.setPlaneSpec(spec);
      this._syncSlidersFromSpec();
      this._syncPresetButtons(spec.mode);
    });
  },

  _setSpec(partial) {
    const ctx = this._ctx;
    const cur  = ctx.slicer.getPlaneSpec();
    const next = { ...cur, ...partial };
    delete next.orientation;
    delete next.normal;
    ctx.slicer.setPlaneSpec(next);
    // The 3D plane mesh follows, silently: the slicer already has the spec.
    ctx.viewer.setPlaneSpec?.(next, { notify: false });
  },

  _bindSlider(sliderId, labelId, onChange, format) {
    const slider = document.getElementById(sliderId);
    const label  = document.getElementById(labelId);
    if (!slider) return;
    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      if (label) label.textContent = format(v);
      onChange(v);
    });
  },

  _syncSlidersFromSpec() {
    const spec = this._ctx.slicer.getPlaneSpec();
    const set = (id, val, labelId, fmt) => {
      const el = document.getElementById(id);
      const lb = document.getElementById(labelId);
      if (el) el.value = val;
      if (lb) lb.textContent = fmt;
    };
    set('slicer-position', Math.round((spec.value || 0.5) * 100), 'slicer-val-pos', (spec.value || 0.5).toFixed(2));
    set('slicer-yaw',   spec.yaw   || 0, 'slicer-val-yaw',   `${spec.yaw   || 0}°`);
    set('slicer-pitch', spec.pitch || 0, 'slicer-val-pitch', `${spec.pitch || 0}°`);
    set('slicer-roll',  spec.roll  || 0, 'slicer-val-roll',  `${spec.roll  || 0}°`);
    set('slicer-slab',  spec.slabThickness || 1, 'slicer-val-slab', String(spec.slabThickness || 1));
    const proj = document.getElementById('slicer-projection');
    if (proj) proj.value = spec.projection || 'single';
  },

  _syncPresetButtons(mode) {
    document.querySelectorAll('.slicer-preset').forEach(b => {
      b.classList.toggle('active', b.dataset.preset === mode);
    });
  },

  // Panel and slice off (the slicer's visibility takes the stage down with it).
  _hide() {
    document.getElementById('slice-inspector')?.classList.add('hidden');
    this._ctx.slicer.setVisible(false);
    this._ctx.viewer.setCutPlaneVisible(false);
    this._ctx.ui.scheduleResize();
  },

  dispose() {
    this._hide();
  }
});
