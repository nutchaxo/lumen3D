/* ============================================================
   IRIBHM Microscopy Platform - Display Presets
   ============================================================ */

const DisplayPresets = (() => {
  const PRESETS = {
    dark: { id: 'dark', label: 'Dark', color: '#000000', transparent: false },
    light: { id: 'light', label: 'Light', color: '#f4f6fb', transparent: false },
    paper: { id: 'paper', label: 'Paper', color: '#f8f5ec', transparent: false },
    transparent: { id: 'transparent', label: 'Transparent', color: 'transparent', transparent: true },
    custom: { id: 'custom', label: 'Custom', color: '#1a1d27', transparent: false }
  };

  function list() {
    return Object.values(PRESETS).map(item => ({ ...item }));
  }

  function resolve(input, customColor = null) {
    const preset = PRESETS[input] || PRESETS.dark;
    if (preset.id === 'custom') {
      return {
        ...preset,
        color: _normalizeColor(customColor || preset.color)
      };
    }
    return {
      ...preset,
      color: preset.transparent ? 'transparent' : _normalizeColor(preset.color)
    };
  }

  function _normalizeColor(value) {
    const color = String(value || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(color)) {
      return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`.toLowerCase();
    }
    return '#1a1d27';
  }

  return {
    list,
    resolve
  };
})();
