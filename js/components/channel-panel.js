/* ============================================================
   IRIBHM Microscopy Platform - Channel Controls
   ============================================================ */

window.createChannelPanel = function() {
  function _getEl(id) { return _container ? _container.querySelector('#' + id) : null; }
  let _container = null;
  let _channels = [];
  let _histograms = [];
  let _onChangeCallback = null;

  const DEFAULT_COLORS = ['#00FF00', '#00AAFF', '#FF00FF', '#FF0000'];
  const OPACITY_LEVELS = [0.7, 0.42, 1];

  function init(containerId, metadata, onChange) {
    _container = document.getElementById(containerId);
    if (!_container) return;
    _onChangeCallback = onChange;

    const numChannels = Math.max(1, Number(metadata?.dimensions?.c) || 1);
    const metaChannels = Array.isArray(metadata?.channels) ? metadata.channels : [];
    const metaColors = Array.isArray(metadata?.colors) ? metadata.colors : [];
    const displayDefaults = Array.isArray(metadata?.display_defaults) ? metadata.display_defaults : [];
    const prepApplied = Boolean(metadata?.preprocessing_applied);
    _channels = [];
    _container.innerHTML = '';

    for (let i = 0; i < numChannels; i++) {
      const channelMeta = metaChannels[i];
      const dd = displayDefaults[i] || null;

      // Nom : display_defaults > channelMeta > fallback générique
      const name = dd?.name
        || (typeof channelMeta === 'string' ? channelMeta : (channelMeta?.name || `Channel ${i + 1}`));

      // Couleur : display_defaults > metadata.colors[i] > channelMeta.color > auto-détection
      const color = dd?.color
        || metaColors[i]
        || (typeof channelMeta === 'object' && channelMeta?.color ? channelMeta.color : null)
        || _colorForChannel(name, i);

      // Quand display_defaults est présent, on utilise ses valeurs de contraste/gamma.
      // Sinon, si preprocessing_applied: identité (min=0, max=1, gamma=1).
      // Sinon, fallback sur channelMeta (rétrocompatibilité).
      let chMin, chMax, chGamma, chMidtone;
      if (dd) {
        chMin = dd.min ?? 0;
        chMax = dd.max ?? 1;
        chGamma = dd.gamma ?? 1;
        // Calcul du midtone à partir du gamma : relativeMidtone = 0.5^(1/gamma)
        const safeGamma = Math.max(0.18, chGamma);
        const relativeMidtone = Math.pow(0.5, 1.0 / safeGamma);
        chMidtone = chMin + relativeMidtone * (chMax - chMin);
      } else if (prepApplied) {
        chMin = 0;
        chMax = 1;
        chGamma = 1;
        chMidtone = 0.5;
      } else {
        chMin = channelMeta?.min ?? 0;
        chMax = channelMeta?.max ?? 1;
        chGamma = channelMeta?.gamma ?? 1;
        chMidtone = channelMeta?.midtone ?? channelMeta?.mid ?? null;
        if (chMidtone === null) {
          const safeGamma = Math.max(0.18, chGamma);
          const relativeMidtone = Math.pow(0.5, 1.0 / safeGamma);
          chMidtone = chMin + relativeMidtone * (chMax - chMin);
        }
      }

      _channels.push({
        idx: i,
        name,
        color,
        min: chMin,
        max: chMax,
        midtone: chMidtone,
        gamma: chGamma,
        opacity: dd?.opacity ?? channelMeta?.opacity ?? 0.7,
        enabled: dd ? (dd.enabled !== false) : ((channelMeta?.enabled !== undefined ? channelMeta.enabled : channelMeta?.active) !== false),
        expanded: channelMeta?.expanded !== undefined ? channelMeta.expanded : (i === 0),
        filterBackground: channelMeta?.filterBackground || false,
        denoise_sigma: dd?.denoise_sigma ?? 0
      });
    }

    _renderAll();
    _channels.forEach((_, idx) => _notify(idx));
  }

  function setHistograms(histograms = []) {
    _histograms = histograms;
    if (typeof PluginRegistry !== 'undefined') {
      const plugins = PluginRegistry.listByPlacement('channels');
      _channels.forEach((_, idx) => {
        const item = _getEl(`channel-item-${idx}`);
        plugins.forEach(p => {
          const mod = PluginRegistry.getModule(p.id);
          if (mod?.impl?.syncUI) mod.impl.syncUI(idx, _channels[idx], item, () => _histograms);
        });
      });
    }
  }

  function getState() {
    return _channels.map(channel => ({ ...channel, denoise_sigma: channel.denoise_sigma ?? 0 }));
  }

  function setState(state = [], options = {}) {
    if (!Array.isArray(state)) return;
    state.forEach((item, idx) => {
      if (!_channels[idx]) return;
      const nextMin = _clamp01(item.min ?? _channels[idx].min);
      const nextMax = Math.max(_clamp01(item.max ?? _channels[idx].max), nextMin + 0.01);
      
      let nextGamma = Number.isFinite(item.gamma) ? item.gamma : _channels[idx].gamma;
      let nextMidtone = item.midtone ?? item.mid ?? null;
      if (nextMidtone === null && Number.isFinite(item.gamma)) {
        const safeGamma = Math.max(0.18, nextGamma);
        const relativeMidtone = Math.pow(0.5, 1.0 / safeGamma);
        nextMidtone = nextMin + relativeMidtone * (nextMax - nextMin);
      } else if (nextMidtone === null) {
        nextMidtone = _channels[idx].midtone;
      } else {
        nextMidtone = _clamp01(nextMidtone);
        nextGamma = _midtoneToGamma((nextMidtone - nextMin) / Math.max(0.001, nextMax - nextMin));
      }

      _channels[idx] = {
        ..._channels[idx],
        color: item.color || _channels[idx].color,
        min: nextMin,
        max: nextMax,
        midtone: nextMidtone,
        gamma: nextGamma,
        opacity: _clamp(Number(item.opacity ?? _channels[idx].opacity), 0.05, 1),
        enabled: (item.enabled !== undefined ? item.enabled : item.active) !== false,
        expanded: item.expanded === undefined ? _channels[idx].expanded : Boolean(item.expanded),
        denoise_sigma: item.denoise_sigma ?? _channels[idx].denoise_sigma ?? 0
      };
      _clampMidtone(idx);
    });
    _renderAll();
    if (options.notify !== false) _channels.forEach((_, idx) => _notify(idx));
  }

  function _renderAll() {
    if (!_container) return;
    _container.innerHTML = _channels.map(channel => _channelHtml(channel)).join('');
    _channels.forEach(channel => _bindChannel(channel.idx));
    if (window.lucide) lucide.createIcons({ nodes: [_container] });
    _channels.forEach((_, idx) => {
      _syncChannelUi(idx);
    });
  }

  const PALETTE = [
    // Flashy / Neon (Row 1)
    ['#FF0000', '#00FF00', '#FF8800', '#FFFF00', '#8800FF', '#FF00FF', '#00AAFF', '#00FFFF', '#FFFFFF'],
    // Lighter (Row 2)
    ['#FF8888', '#88FF88', '#FFCC88', '#FFFF88', '#CC88FF', '#FF88FF', '#88CCFF', '#88FFFF', '#CCCCCC'],
    // Darker (Row 3)
    ['#AA0000', '#00AA00', '#AA5500', '#AAAA00', '#5500AA', '#AA00AA', '#0055AA', '#00AAAA', '#666666']
  ];

  function _colorGridHtml(idx) {
    let html = `<div class="color-grid-popup" id="ch-color-popup-${idx}" style="display: none; position: absolute; right: 0; top: 100%; margin-top: 4px; background: var(--bg-surface, #222); border: 1px solid var(--border-color, #444); border-radius: 6px; padding: 6px; z-index: 100; box-shadow: 0 4px 12px rgba(0,0,0,0.5); flex-direction: column; gap: 4px;">`;
    for (const row of PALETTE) {
      html += `<div style="display: flex; gap: 4px;">`;
      for (const color of row) {
        html += `<button type="button" data-channel-action="set-color" data-channel-idx="${idx}" data-color="${color}" style="width: 20px; height: 20px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.15); background: ${color}; padding: 0; cursor: pointer; transition: transform 0.1s;" title="${color}" onmouseover="this.style.transform='scale(1.1)'" onmouseout="this.style.transform='scale(1)'"></button>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
    return html;
  }

  function _channelHtml(channel) {
    const safeName = Utils.escapeHtml ? Utils.escapeHtml(channel.name) : channel.name;
    const expanded = channel.expanded ? 'expanded' : '';
    
    let pluginsHtml = '';
    if (typeof PluginRegistry !== 'undefined') {
      PluginRegistry.listByPlacement('channels').forEach(p => {
        const mod = PluginRegistry.getModule(p.id);
        if (mod?.impl?.getChannelUI) pluginsHtml += mod.impl.getChannelUI(channel);
      });
    }

    return `
      <section class="channel-item ${expanded}" id="channel-item-${channel.idx}">
          <div class="channel-header-row">
            <div class="channel-main">
              <div class="channel-name" style="cursor:default">
                <label style="display:flex;align-items:center;margin:0;cursor:pointer;">
                  <input type="checkbox" id="ch-toggle-${channel.idx}" ${channel.enabled ? 'checked' : ''}>
                  <span class="channel-swatch" style="background:${channel.color};margin-left:8px;"></span>
                </label>
                <input type="text" id="ch-name-input-${channel.idx}" value="${safeName}" spellcheck="false" style="background:transparent;border:none;border-bottom:1px solid transparent;color:inherit;font-size:inherit;font-family:inherit;font-weight:inherit;outline:none;width:100%;transition:border-color 0.2s;" onfocus="this.style.borderColor='rgba(255,255,255,0.2)'" onblur="this.style.borderColor='transparent'">
              </div>
              <div class="channel-quick">
              <button class="btn btn-ghost btn-sm channel-icon-btn" type="button" data-channel-action="solo" data-channel-idx="${channel.idx}" title="Solo channel" data-i18n-title="js.soloChannel">
                <i data-lucide="focus"></i>
              </button>
              <button class="btn btn-ghost btn-sm channel-icon-btn" type="button" data-channel-action="opacity" data-channel-idx="${channel.idx}" title="Cycle opacity" data-i18n-title="js.cycleOpacity">
                <i data-lucide="droplets"></i>
              </button>
              <div style="position: relative; display: inline-block;">
                <button class="btn btn-ghost btn-sm channel-icon-btn" type="button" data-channel-action="toggle-color" data-channel-idx="${channel.idx}" title="Channel color" data-i18n-title="js.channelColor">
                  <span class="channel-swatch" style="background:${channel.color}; width:16px; height:16px; display:inline-block; border-radius:3px; border:1px solid rgba(255,255,255,0.2); vertical-align:middle;"></span>
                </button>
                ${_colorGridHtml(channel.idx)}
              </div>
              <button class="btn btn-ghost btn-sm channel-icon-btn channel-disclosure" type="button" data-channel-action="expand" data-channel-idx="${channel.idx}" aria-expanded="${channel.expanded}">
                <i data-lucide="${channel.expanded ? 'chevron-up' : 'chevron-down'}"></i>
              </button>
            </div>
          </div>
          <div class="channel-summary">
            <span id="ch-summary-${channel.idx}">0-100 | gamma 1.00</span>
          </div>
          <div class="channel-advanced" id="ch-advanced-${channel.idx}">
            ${pluginsHtml}
          </div>
      </section>
    `;
  }

  function _bindChannel(idx) {
    const item = _getEl(`channel-item-${idx}`);
    if (!item) return;
      item.querySelector(`#ch-toggle-${idx}`)?.addEventListener('change', (e) => {
        _channels[idx].enabled = e.target.checked;
        item.classList.toggle('is-disabled', !_channels[idx].enabled);
        _notify(idx);
      });
      const nameInput = item.querySelector(`#ch-name-input-${idx}`);
      if (nameInput) {
        nameInput.addEventListener('change', (e) => {
          _channels[idx].name = e.target.value;
          _notify(idx);
        });
      }

    item.addEventListener('click', (e) => {
      const button = e.target.closest('[data-channel-action]');
      if (!button) return;
      const action = button.dataset.channelAction;
      if (action === 'expand') {
        _channels[idx].expanded = !_channels[idx].expanded;
        item.classList.toggle('expanded', _channels[idx].expanded);
        button.setAttribute('aria-expanded', String(_channels[idx].expanded));
        const icon = button.querySelector('[data-lucide]');
        if (icon) icon.setAttribute('data-lucide', _channels[idx].expanded ? 'chevron-up' : 'chevron-down');
        if (window.lucide) lucide.createIcons({ nodes: [button] });
        _notify(idx);
        return;
      }
      if (action === 'toggle-color') {
        const popup = _getEl(`ch-color-popup-${idx}`);
        if (popup) {
          const isVisible = popup.style.display === 'flex';
          document.querySelectorAll('.color-grid-popup').forEach(p => p.style.display = 'none');
          if (!isVisible) popup.style.display = 'flex';
        }
        return;
      }
      if (action === 'set-color') {
        _channels[idx].color = button.dataset.color;
        const popup = _getEl(`ch-color-popup-${idx}`);
        if (popup) popup.style.display = 'none';
        _syncChannelUi(idx);
        _notify(idx);
        return;
      }
      if (action === 'solo') {
        _channels.forEach((channel, channelIdx) => {
          channel.enabled = channelIdx === idx;
          _getEl(`ch-toggle-${channelIdx}`)?.toggleAttribute('checked', channel.enabled);
          const toggle = _getEl(`ch-toggle-${channelIdx}`);
          if (toggle) toggle.checked = channel.enabled;
          _getEl(`channel-item-${channelIdx}`)?.classList.toggle('is-disabled', !channel.enabled);
          _notify(channelIdx);
        });
        return;
      }
      if (action === 'opacity') {
        const current = OPACITY_LEVELS.findIndex(level => Math.abs(level - _channels[idx].opacity) < 1e-6);
        _channels[idx].opacity = OPACITY_LEVELS[(current + 1 + OPACITY_LEVELS.length) % OPACITY_LEVELS.length];
        _syncChannelUi(idx);
        _notify(idx);
        return;
      }
    });

    if (typeof PluginRegistry !== 'undefined') {
      PluginRegistry.listByPlacement('channels').forEach(p => {
        const mod = PluginRegistry.getModule(p.id);
        if (mod?.impl?.bindChannelUI) {
          mod.impl.bindChannelUI(idx, _channels[idx], item, {
            getState: (i) => _channels[i],
            onStateChange: (i, state) => {
              _channels[i] = { ..._channels[i], ...state };
              _clampMidtone(i);
              _syncChannelUi(i);
              _notify(i);
            },
            getHistograms: () => _histograms
          });
        }
      });
    }
  }

  // Histogram code moved to histogram plugin

  function _syncChannelUi(idx) {
    const channel = _channels[idx];
    channel.gamma = _midtoneToGamma(_relativeMidtone(idx));
    const item = _getEl(`channel-item-${idx}`);
    if (item) item.classList.toggle('is-disabled', !channel.enabled);
    const swatches = item?.querySelectorAll('.channel-swatch');
    if (swatches) swatches.forEach(sw => sw.style.background = channel.color);
    const summary = _getEl(`ch-summary-${idx}`);
    const minVal = Math.round(channel.min * 255);
    const maxVal = Math.round(channel.max * 255);
    if (summary) summary.textContent = `${minVal}-${maxVal} | gamma ${channel.gamma.toFixed(2)} | ${Math.round(channel.opacity * 100)}%`;
    
    if (typeof PluginRegistry !== 'undefined' && item) {
      PluginRegistry.listByPlacement('channels').forEach(p => {
        const mod = PluginRegistry.getModule(p.id);
        if (mod?.impl?.syncUI) mod.impl.syncUI(idx, channel, item, () => _histograms);
      });
    }
  }

  function _clampMidtone(idx) {
    const channel = _channels[idx];
    channel.midtone = _clamp(channel.midtone, channel.min + 0.01, channel.max - 0.01);
  }

  function _relativeMidtone(idx) {
    const channel = _channels[idx];
    return _clamp01((channel.midtone - channel.min) / Math.max(0.001, channel.max - channel.min));
  }

  function _midtoneToGamma(value) {
    const v = _clamp(value, 0.001, 0.999);
    return Math.max(0.18, Math.min(5.5, Math.log(0.5) / Math.log(v)));
  }

  function _notify(idx) {
    if (_onChangeCallback) _onChangeCallback(idx, { ..._channels[idx] });
  }

  // _autoRangeFromHistogram removed

  function _colorForChannel(name, idx) {
    const lower = String(name || '').toLowerCase();
    if (lower.includes('gfp')) return '#00FF00';
    if (lower.includes('dapi') || lower.includes('hoechst')) return '#00AAFF';
    if (lower.includes('pecam') || lower.includes('picam')) return '#FF00FF';
    if (lower.includes('rfp') || lower.includes('mcherry') || lower.includes('alexa')) return '#FF0000';
    return DEFAULT_COLORS[idx % DEFAULT_COLORS.length];
  }

  function _clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function _clamp01(value) {
    const num = Number(value);
    return Number.isFinite(num) ? Math.max(0, Math.min(1, num)) : 0;
  }

  // Close color popups when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-channel-action="toggle-color"]') && !e.target.closest('.color-grid-popup')) {
      document.querySelectorAll('.color-grid-popup').forEach(p => p.style.display = 'none');
    }
  });

  return {
    init,
    setHistograms,
    getState,
    setState
  };
};
const ChannelPanel = window.createChannelPanel();
