/* Histogram Channel Plugin — index.js */
PluginRegistry.implement('histogram', {
  init(ctx) {
    this._ctx = ctx;
    return this;
  },

  // Channel UI is rendered by ChannelPanel BEFORE PluginRegistry.initAll runs
  // this plugin's init(ctx), so `this._ctx` is not yet set here. Resolve via the
  // global I18n singleton (plugin dictionaries are loaded during loadModules,
  // before the channel panel paints) with a literal English fallback.
  _t(key, fallback) {
    const k = `plugins.histogram.${key}`;
    if (typeof I18n !== 'undefined' && I18n.t) {
      const v = I18n.t(k);
      if (v !== k) return v;
    }
    return fallback;
  },

  getChannelUI(channel) {
    const t = (k, d) => this._t(k, d);
    return `
      <div class="histogram-editor" id="ch-editor-${channel.idx}">
        <div class="histogram-band" id="ch-band-${channel.idx}"></div>
        <div class="mini-histogram" id="ch-hist-${channel.idx}" title="Intensity histogram" data-i18n-title="js.intensityHist"></div>
        <button class="hist-handle handle-min" type="button" id="ch-handle-min-${channel.idx}" title="Minimum threshold" data-i18n-title="js.minThresh"></button>
        <button class="hist-handle handle-mid" type="button" id="ch-handle-mid-${channel.idx}" title="Midtone / gamma" data-i18n-title="js.midGamma"></button>
        <button class="hist-handle handle-max" type="button" id="ch-handle-max-${channel.idx}" title="Maximum threshold" data-i18n-title="js.maxThresh"></button>
      </div>
      <div class="channel-advanced-row">
        <span id="lbl-min-${channel.idx}">${t('min', 'Min')} 0</span>
        <span id="lbl-mid-${channel.idx}">${t('gamma', 'Gamma')} 1.00</span>
        <span id="lbl-max-${channel.idx}">${t('max', 'Max')} 100</span>
      </div>
      <div class="channel-actions mt-2" style="display: flex; justify-content: space-between; align-items: center;">
        <div style="display: flex; gap: 8px;">
          <button class="btn btn-outline btn-sm" type="button" data-channel-action="auto" data-channel-idx="${channel.idx}" data-i18n="js.auto">Auto</button>
          <button class="btn btn-outline btn-sm" type="button" data-channel-action="preset-soft" data-channel-idx="${channel.idx}" data-i18n="js.soft">Soft</button>
          <button class="btn btn-outline btn-sm" type="button" data-channel-action="preset-contrast" data-channel-idx="${channel.idx}" data-i18n="js.contrast">Contrast</button>
          <button class="btn btn-outline btn-sm" type="button" data-channel-action="reset" data-channel-idx="${channel.idx}" data-i18n="js.reset">Reset</button>
        </div>
        <label class="flex items-center gap-2 text-xs text-muted cursor-pointer" title="Filtre passe-haut pour écraser le fond noir" data-i18n-title="js.highPass">
          <input type="checkbox" id="ch-filter-${channel.idx}" data-channel-action="toggle-filter" data-channel-idx="${channel.idx}" ${channel.filterBackground ? 'checked' : ''}>
          <span data-i18n="plugins.histogram.ignoreLow">${t('ignoreLow', 'Ignore low')}</span>
        </label>
      </div>
    `;
  },

  bindChannelUI(idx, channel, container, callbacks) {
    const { onStateChange, getHistograms, getState } = callbacks;
    
    // Binding the histogram drag events
    const editor = container.querySelector(`#ch-editor-${idx}`);
    if (!editor) return;

    const clamp = (val, min, max) => Math.max(min, Math.min(max, val));
    const clamp01 = (val) => clamp(val, 0, 1);

    ['min', 'mid', 'max'].forEach(kind => {
      const handle = container.querySelector(`#ch-handle-${kind}-${idx}`);
      if (!handle) return;
      handle.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        handle.setPointerCapture?.(event.pointerId);
        
        // PERF-012: onStateChange updates a shader uniform (and can trigger a recompile),
        // so firing it on every pointermove thrashed. Coalesce drag updates to one per
        // animation frame; the initial click applies immediately and pointerup flushes
        // the final value so the last position always lands.
        const apply = (clientX) => {
          const rect = editor.getBoundingClientRect();
          const raw = clamp01((clientX - rect.left) / Math.max(1, rect.width));
          const state = getState(idx);

          if (kind === 'min') {
            state.min = Math.min(raw, state.max - 0.01);
          } else if (kind === 'max') {
            state.max = Math.max(raw, state.min + 0.01);
          } else {
            state.midtone = clamp(raw, state.min + 0.01, state.max - 0.01);
          }

          onStateChange(idx, state);
        };
        let _latestX = null;
        let _rafId = 0;
        const move = (clientX) => {
          _latestX = clientX;
          if (_rafId) return;
          _rafId = requestAnimationFrame(() => { _rafId = 0; apply(_latestX); });
        };
        apply(event.clientX);
        const onMove = (e) => move(e.clientX);
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
          if (_latestX != null) apply(_latestX);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });
    });

    // Binding the action buttons
    container.addEventListener('click', (e) => {
      const button = e.target.closest('[data-channel-action]');
      if (!button || parseInt(button.dataset.channelIdx, 10) !== idx) return;
      
      const action = button.dataset.channelAction;
      const state = getState(idx);
      const hist = getHistograms()[idx];

      if (action === 'auto') {
        const range = this._autoRangeFromHistogram(hist);
        state.min = range.min;
        state.max = range.max;
        state.midtone = 0.5 * (state.min + state.max);
        onStateChange(idx, state);
      }
      if (action === 'preset-soft') {
        state.min = 0.02;
        state.max = 0.94;
        state.midtone = 0.42;
        onStateChange(idx, state);
      }
      if (action === 'preset-contrast') {
        state.min = 0.08;
        state.max = 0.82;
        state.midtone = 0.5;
        onStateChange(idx, state);
      }
      if (action === 'reset') {
        state.min = 0;
        state.max = 1;
        state.midtone = 0.5;
        state.filterBackground = false;
        const filterToggle = container.querySelector(`#ch-filter-${idx}`);
        if (filterToggle) filterToggle.checked = false;
        onStateChange(idx, state);
      }
    });

    // Toggle filter
    const filterToggle = container.querySelector(`#ch-filter-${idx}`);
    if (filterToggle) {
      filterToggle.addEventListener('change', (e) => {
        const state = getState(idx);
        state.filterBackground = e.target.checked;
        onStateChange(idx, state);
      });
    }
  },

  _autoRangeFromHistogram(hist) {
    if (!hist?.counts?.length || !hist.total) return { min: 0.01, max: 0.98 };
    const lowTarget = hist.total * 0.005;
    const highTarget = hist.total * 0.995;
    let cumulative = 0;
    let minBin = 0;
    let maxBin = hist.counts.length - 1;
    for (let i = 0; i < hist.counts.length; i++) {
      cumulative += hist.counts[i];
      if (cumulative <= lowTarget) minBin = i;
      if (cumulative <= highTarget) maxBin = i;
    }
    return {
      min: Math.max(0, minBin / hist.counts.length),
      max: Math.min(1, (maxBin + 1) / hist.counts.length)
    };
  },

  syncUI(idx, channel, container, getHistograms) {
    // This method updates the UI elements based on the channel state
    const band = container.querySelector(`#ch-band-${idx}`);
    if (band) {
      band.style.left = `${channel.min * 100}%`;
      band.style.width = `${Math.max(0.5, (channel.max - channel.min) * 100)}%`;
    }
    const handles = {
      min: channel.min,
      mid: channel.midtone,
      max: channel.max
    };
    Object.entries(handles).forEach(([kind, value]) => {
      const handle = container.querySelector(`#ch-handle-${kind}-${idx}`);
      if (handle) handle.style.left = `calc(${value * 100}% - 6px)`;
    });

    const lblMin = container.querySelector(`#lbl-min-${idx}`);
    const lblMid = container.querySelector(`#lbl-mid-${idx}`);
    const lblMax = container.querySelector(`#lbl-max-${idx}`);
    const t = (k, d) => this._t(k, d);
    if (lblMin) lblMin.textContent = `${t('min', 'Min')} ${Math.round(channel.min * 255)}`;
    if (lblMid) lblMid.textContent = `${t('gamma', 'Gamma')} ${channel.gamma.toFixed(2)}`;
    if (lblMax) lblMax.textContent = `${t('max', 'Max')} ${Math.round(channel.max * 255)}`;

    this._renderHistogram(idx, channel, container, getHistograms);
  },

  _renderHistogram(idx, channel, container, getHistograms) {
    const node = container.querySelector(`#ch-hist-${idx}`);
    const editor = container.querySelector(`#ch-editor-${idx}`);
    if (!node) return;
    
    const hist = getHistograms()[idx];

    // Background gradient for the editor
    if (editor && channel.enabled) {
      editor.style.background = `linear-gradient(to right, #000000, ${channel.color})`;
    } else if (editor) {
      editor.style.background = 'transparent';
    }

    if (!hist?.counts?.length) {
      node.innerHTML = '';
      return;
    }

    const totalPixels = hist.total || hist.counts.reduce((sum, val) => sum + val, 0);
    const clipped = this._clipHistogramForDisplay(hist.counts);
    
    let displayCounts = [...clipped];
    
    // Fill "comb/sawtooth" holes natively caused by WebP YUV-to-RGB decoding artifacts
    for (let i = 1; i < displayCounts.length - 1; i++) {
      const prev = displayCounts[i-1];
      const next = displayCounts[i+1];
      if (displayCounts[i] < prev * 0.2 && displayCounts[i] < next * 0.2) {
        displayCounts[i] = (prev + next) / 2;
      }
    }

    if (channel.filterBackground) {
      // Filtre passe-haut fort (quadratique) pour écraser complètement le bruit de fond sombre
      displayCounts = displayCounts.map((count, i) => count * Math.pow(i / (displayCounts.length - 1), 2));
    }
    
    // True proportion of pixels (linear scale)
    const proportions = displayCounts.map(count => count / totalPixels);
    const maxProp = Math.max(1e-6, ...proportions);
    
    const pts = proportions.map((prop, i) => {
      const x = (i / (hist.counts.length - 1)) * 100;
      const y = 100 - (prop / maxProp) * 100;
      return `${x},${y}`;
    });
    
    const fillPts = `0,100 ${pts.join(' ')} 100,100`;
    node.innerHTML = `
      <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" style="display:block;">
        <polygon points="${fillPts}" fill="rgba(255,255,255,0.15)" stroke="none"></polygon>
        <polyline points="${pts.join(' ')}" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="1" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
      </svg>
    `;
  },

  _clipHistogramForDisplay(counts = []) {
    if (!counts.length) return [];
    const bgLimit = Math.max(1, Math.ceil(counts.length * 0.04));
    let signalPeak = 1;
    for (let i = bgLimit; i < counts.length; i++) {
      if (counts[i] > signalPeak) signalPeak = counts[i];
    }
    return counts.map((count, idx) => idx < bgLimit ? Math.min(count, signalPeak * 1.35) : count);
  },

  dispose() {}
});
