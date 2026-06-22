/* Deep Zoom 2D — index.js
 *
 * Migrates _bindDeepZoomToggle, _enterDeepZoom, _exitDeepZoom,
 * _updateDzSliceLabel, _hasTiles2dSource from viewer.js.
 *
 * The button (btn-toggle-deepzoom) is hidden by default in the HTML
 * and shown only when a tiles2d source is detected at dataset load.
 * This module manages its own visibility after init().
 */
PluginRegistry.implement('deepzoom-2d', {
  _ctx: null,
  _active: false,

  init(ctx) {
    this._ctx = ctx;
    this._active = false;
    this._bindControls();
    this._updateButtonVisibility();
    return this;
  },

  activate() {
    if (this._active) {
      this._exit();
    } else {
      this._enter();
    }
    return { active: this._active };
  },

  getState() { return null; }, // DeepZoom is transient, not persisted

  // ── Private ───────────────────────────────────────────────

  _hasTiles2d() {
    const meta = this._ctx.dataset.getMeta();
    if (!meta?.volumeSources) return false;
    return meta.volumeSources.some(s => s.kind === 'deepzoom2d' && s.available !== false);
  },

  _updateButtonVisibility() {
    const btn = document.getElementById('btn-toggle-deepzoom');
    if (!btn) return;
    btn.style.display = this._hasTiles2d() ? '' : 'none';
  },

  _bindControls() {
    // Toolbar button is generated + wired to activate() by PluginRegistry.
    // This module manages only the in-mode panel controls and button visibility.
    const btn = document.getElementById('btn-toggle-deepzoom');
    if (btn) btn.style.display = 'none'; // Hidden until dataset confirms tiles2d

    document.getElementById('btn-dz-exit')?.addEventListener('click', () => this._exit());

    document.getElementById('btn-dz-prev')?.addEventListener('click', () => {
      if (typeof DeepZoomViewer !== 'undefined' && DeepZoomViewer.isActive()) {
        DeepZoomViewer.nudgeSlice(-1);
        this._updateSliceLabel();
      }
    });

    document.getElementById('btn-dz-next')?.addEventListener('click', () => {
      if (typeof DeepZoomViewer !== 'undefined' && DeepZoomViewer.isActive()) {
        DeepZoomViewer.nudgeSlice(1);
        this._updateSliceLabel();
      }
    });

    // Keyboard shortcuts in 2D mode
    document.addEventListener('keydown', (e) => {
      if (!this._active) return;
      if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
      switch (e.key) {
        case 'PageUp': case 'ArrowUp':
          if (e.shiftKey || e.key === 'PageUp') {
            e.preventDefault();
            if (typeof DeepZoomViewer !== 'undefined' && DeepZoomViewer.isActive()) {
              DeepZoomViewer.nudgeSlice(-1);
              this._updateSliceLabel();
            }
          }
          break;
        case 'PageDown': case 'ArrowDown':
          if (e.shiftKey || e.key === 'PageDown') {
            e.preventDefault();
            if (typeof DeepZoomViewer !== 'undefined' && DeepZoomViewer.isActive()) {
              DeepZoomViewer.nudgeSlice(1);
              this._updateSliceLabel();
            }
          }
          break;
        case 'Home':
          e.preventDefault();
          if (typeof DeepZoomViewer !== 'undefined') { DeepZoomViewer.setSlice(0); this._updateSliceLabel(); }
          break;
        case 'End':
          e.preventDefault();
          if (typeof DeepZoomViewer !== 'undefined') {
            DeepZoomViewer.setSlice(DeepZoomViewer.getSliceCount() - 1);
            this._updateSliceLabel();
          }
          break;
        case 'Escape':
          e.preventDefault();
          this._exit();
          break;
      }
    });
  },

  async _enter() {
    if (typeof DeepZoomViewer === 'undefined' || !DeepZoomViewer.isAvailable()) {
      console.warn('[deepzoom-2d] OpenSeadragon not loaded, cannot enter 2D mode.');
      return;
    }

    this._ctx.ui.perf()?.event('viewer.deepzoom.enter');

    const dzContainer = document.getElementById('deepzoom-container');
    const dzControls  = document.getElementById('deepzoom-controls');
    const canvas      = document.getElementById('webgl-canvas');
    const btn         = document.getElementById('btn-toggle-deepzoom');
    if (!dzContainer) return;

    dzContainer.classList.remove('hidden');
    dzControls?.classList.remove('hidden');
    if (canvas) canvas.style.visibility = 'hidden';
    // Keep the toggle's visual state consistent with PluginRegistry.bindToolbarButtons
    // (which sets btn-solid/btn-ghost) so EVERY exit path — toolbar, Escape, dz-exit,
    // failed-load — leaves matching classes. Mirrors decomposition-panel _syncToolbarButton.
    if (btn) { btn.classList.add('active', 'btn-solid'); btn.classList.remove('btn-ghost'); }
    this._active = true;

    DeepZoomViewer.init('deepzoom-container');

    const meta        = this._ctx.dataset.getMeta();
    const tiles2dSrc  = meta.volumeSources.find(s => s.kind === 'deepzoom2d');
    const manifestPath = tiles2dSrc?.manifestPath
      || tiles2dSrc?.path
      || `DATA_WEB/${meta.path}/tiles2d/manifest.json`;

    const loaded = await DeepZoomViewer.loadManifest(manifestPath, {
      initialSlice: Math.floor((meta.dimensions?.z || 1) / 2)
    });

    if (!loaded) {
      console.warn('[deepzoom-2d] Failed to load tiles2d manifest, exiting 2D mode.');
      this._exit();
      return;
    }

    this._updateSliceLabel();
    this._ctx.ui.createIcons();
  },

  _exit() {
    this._ctx.ui.perf()?.event('viewer.deepzoom.exit');

    const dzContainer = document.getElementById('deepzoom-container');
    const dzControls  = document.getElementById('deepzoom-controls');
    const canvas      = document.getElementById('webgl-canvas');
    const btn         = document.getElementById('btn-toggle-deepzoom');

    if (dzContainer) dzContainer.classList.add('hidden');
    if (dzControls)  dzControls.classList.add('hidden');
    if (canvas) canvas.style.visibility = '';
    if (btn) { btn.classList.remove('active', 'btn-solid'); btn.classList.add('btn-ghost'); }

    if (typeof DeepZoomViewer !== 'undefined') DeepZoomViewer.destroy();
    this._active = false;
    this._ctx.viewer.resize();
  },

  _updateSliceLabel() {
    const label = document.getElementById('dz-slice-label');
    if (!label || typeof DeepZoomViewer === 'undefined') return;
    label.textContent = `Z ${DeepZoomViewer.getCurrentSlice() + 1} / ${DeepZoomViewer.getSliceCount()}`;
  },

  dispose() {
    if (this._active) this._exit();
  }
});
