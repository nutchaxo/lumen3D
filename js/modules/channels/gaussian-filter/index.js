/* Gaussian Filter Channel Plugin — index.js */
PluginRegistry.implement('gaussian-filter', {
  init(ctx) {
    this._ctx = ctx;
    return this;
  },

  // Sliders currently on screen, by channel index; the blur runs on the dense volume
  // texture only, so they follow VolumeViewer.getCapabilities().denoise.
  _sliders: null,
  _onCapabilities: null,

  _currentCapabilities() {
    return typeof VolumeViewer !== 'undefined' && VolumeViewer.getCapabilities
      ? VolumeViewer.getCapabilities()
      : null;
  },

  _applyCapabilities(caps) {
    const denoise = caps?.denoise;
    // Before the first volume ('no-volume') the sigma is kept and applied on load.
    const unavailable = Boolean(denoise && denoise.available === false && denoise.reason !== 'no-volume');
    const tip = unavailable
      ? (denoise.reason === 'sparse-atlas'
        ? this._t('unavailableSparse', 'Not available at this quality (sparse brick atlas): choose a lower quality to use the blur.')
        : this._t('unavailable', 'The blur is not available for this volume.'))
      : '';
    for (const slider of (this._sliders?.values() || [])) {
      if (slider.isConnected === false) continue;
      slider.disabled = unavailable;
      const row = (slider.closest && slider.closest('.channel-denoise-row')) || slider;
      if (tip) row.title = tip; else row.removeAttribute?.('title');
    }
  },

  _listenCapabilities() {
    if (this._onCapabilities || typeof window === 'undefined') return;
    this._onCapabilities = (e) => this._applyCapabilities(e.detail);
    window.addEventListener('volume-capabilities', this._onCapabilities);
  },

  // getChannelUI runs BEFORE init(ctx) (ChannelPanel paints before initAll), so
  // `this._ctx` is not set yet — resolve via the global I18n with a fallback.
  _t(key, fallback) {
    const k = `plugins.gaussian-filter.${key}`;
    if (typeof I18n !== 'undefined' && I18n.t) {
      const v = I18n.t(k);
      if (v !== k) return v;
    }
    return fallback;
  },

  getChannelUI(channel) {
    // Channel values come from metadata / workspace files: only a plain hex colour
    // and a finite sigma may reach the markup.
    const color = /^#[0-9a-f]{3,8}$/i.test(String(channel.color)) ? channel.color : '#888888';
    const sigma = Number.isFinite(Number(channel.denoise_sigma)) ? Number(channel.denoise_sigma) : 0;
    return `
      <div class="channel-denoise-row" style="display: flex; align-items: center; gap: 8px; padding: 4px 0 2px 0;">
        <label for="ch-denoise-${channel.idx}" class="text-xs text-muted" style="white-space: nowrap;" data-i18n="plugins.gaussian-filter.label">${this._t('label', 'Gaussian blur σ')}</label>
        <input type="range" id="ch-denoise-${channel.idx}" min="0" max="5.0" step="0.1" value="${sigma}" style="flex: 1; accent-color: ${color};">
        <span id="ch-denoise-val-${channel.idx}" class="text-xs text-muted" style="min-width: 28px; text-align: right;">${sigma.toFixed(1)}</span>
      </div>
    `;
  },

  bindChannelUI(idx, channel, container, callbacks) {
    const { onStateChange, getState } = callbacks;
    const denoiseSlider = container.querySelector(`#ch-denoise-${idx}`);
    if (denoiseSlider) {
      if (!this._sliders) this._sliders = new Map();
      this._sliders.set(idx, denoiseSlider);
      this._listenCapabilities();
      this._applyCapabilities(this._currentCapabilities());
      denoiseSlider.addEventListener('input', (e) => {
        const valLabel = container.querySelector(`#ch-denoise-val-${idx}`);
        if (valLabel) valLabel.textContent = (parseFloat(e.target.value) || 0).toFixed(1);
      });
      denoiseSlider.addEventListener('change', (e) => {
        const state = getState(idx);
        state.denoise_sigma = parseFloat(e.target.value) || 0;
        const valLabel = container.querySelector(`#ch-denoise-val-${idx}`);
        if (valLabel) valLabel.textContent = state.denoise_sigma.toFixed(1);
        onStateChange(idx, state);
      });
    }
  },

  syncUI(idx, channel, container) {
    const denoiseSlider = container.querySelector(`#ch-denoise-${idx}`);
    const denoiseVal = container.querySelector(`#ch-denoise-val-${idx}`);
    if (denoiseSlider) denoiseSlider.value = channel.denoise_sigma ?? 0;
    if (denoiseVal) denoiseVal.textContent = (channel.denoise_sigma ?? 0).toFixed(1);
  },

  dispose() {
    if (this._onCapabilities && typeof window !== 'undefined') window.removeEventListener('volume-capabilities', this._onCapabilities);
    this._onCapabilities = null;
    this._sliders = null;
  }
});
