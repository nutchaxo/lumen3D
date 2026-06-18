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
      const raw = String(customColor ?? '').trim();
      // EDGE-059: 'transparent' must stay selectable as a custom value (the user
      // can type it), and an invalid custom color must not be silently masked as
      // the default tint — warn so a malformed value is surfaced, not swallowed.
      if (raw.toLowerCase() === 'transparent') {
        return { ...preset, color: 'transparent', transparent: true };
      }
      const normalized = _normalizeColor(raw || preset.color);
      if (raw && normalized === null) {
        console.warn(`[DisplayPresets] invalid custom color "${customColor}", using default ${preset.color}`);
      }
      return { ...preset, color: normalized || preset.color };
    }
    return {
      ...preset,
      color: preset.transparent ? 'transparent' : (_normalizeColor(preset.color) || preset.color)
    };
  }

  // Returns a canonical 6-digit lowercase hex, or null when the input is not a
  // valid hex color (EDGE-059 — callers decide how to surface/replace null).
  function _normalizeColor(value) {
    const color = String(value || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(color)) {
      return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`.toLowerCase();
    }
    return null;
  }

  return {
    list,
    resolve
  };
})();
