/* Gaussian Filter Channel Plugin — index.js */
PluginRegistry.implement('gaussian-filter', {
  init(ctx) {
    this._ctx = ctx;
    return this;
  },

  getChannelUI(channel) {
    return `
      <div class="channel-denoise-row" style="display: flex; align-items: center; gap: 8px; padding: 4px 0 2px 0;">
        <label for="ch-denoise-${channel.idx}" class="text-xs text-muted" style="white-space: nowrap;">Filtre gaussien \u03C3</label>
        <input type="range" id="ch-denoise-${channel.idx}" min="0" max="5.0" step="0.1" value="${channel.denoise_sigma}" style="flex: 1; accent-color: ${channel.color};">
        <span id="ch-denoise-val-${channel.idx}" class="text-xs text-muted" style="min-width: 28px; text-align: right;">${Number(channel.denoise_sigma).toFixed(1)}</span>
      </div>
    `;
  },

  bindChannelUI(idx, channel, container, callbacks) {
    const { onStateChange, getState } = callbacks;
    const denoiseSlider = container.querySelector(`#ch-denoise-${idx}`);
    if (denoiseSlider) {
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

  dispose() {}
});
