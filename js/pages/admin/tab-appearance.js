/**
 * Admin SPA — Appearance (theme editor)
 * =====================================
 * White-label theme editor. Edits a curated set of design tokens (brand palette,
 * font family, corner radius) with a LIVE preview of the public site inside a
 * same-origin iframe. Persists to config/theme.json via /api/site.php, which the
 * server compiles to a served config/theme.css (<link> after themes.css on every
 * public page) — so the change survives reloads with no flash and no CSP issue
 * (a served same-origin stylesheet, not an injected <style>). The live preview
 * uses CSSOM setProperty on the iframe's <html> (style attribute → allowed by
 * style-src-attr), never an injected <style> (blocked by style-src-elem).
 *
 * Only tokens the operator actually changes are written; untouched tokens fall
 * through to css/variables.css. "Reset" restores the neutral default (empty).
 */

'use strict';

import { API_SITE, t, escHtml, apiFetch, apiFetchStatus, toast, el, refreshIcons } from './shared.js';
import { setUnsaved } from './bus.js';

// ── Color math (hex ↔ rgb ↔ hsl) ────────────────────────────────
function _hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function _rgbToHex(r, g, b) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}
function _rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}
function _hslToRgb(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  const hue = (p, q, tt) => {
    if (tt < 0) tt += 1; if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  if (s === 0) { const v = l * 255; return { r: v, g: v, b: v }; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return { r: hue(p, q, h + 1 / 3) * 255, g: hue(p, q, h) * 255, b: hue(p, q, h - 1 / 3) * 255 };
}
function _adjustL(hex, dl) {
  const rgb = _hexToRgb(hex); if (!rgb) return hex;
  const hsl = _rgbToHsl(rgb);
  const out = _hslToRgb(hsl.h, hsl.s, Math.max(0, Math.min(100, hsl.l + dl)));
  return _rgbToHex(out.r, out.g, out.b);
}
function _rgba(hex, a) {
  const rgb = _hexToRgb(hex); if (!rgb) return hex;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`;
}

// ── Curated controls ────────────────────────────────────────────
// Each brand colour drives itself + a small ramp of derived tokens so a single
// picker keeps hover/dark/subtle variants coherent with the chosen hue.
const COLORS = [
  { base: '--color-primary', key: 'appearance.colPrimary', def: 'Couleur primaire',
    derive: { '--color-primary-hover': { dl: 8 }, '--color-primary-dark': { dl: -10 }, '--color-primary-subtle': { a: 0.15 } } },
  { base: '--color-accent', key: 'appearance.colAccent', def: "Couleur d'accent",
    derive: { '--color-accent-hover': { dl: 8 }, '--color-accent-dark': { dl: -10 }, '--color-accent-subtle': { a: 0.12 } } },
  { base: '--color-green', key: 'appearance.colSuccess', def: 'Succès',
    derive: { '--color-green-hover': { dl: 8 }, '--color-green-subtle': { a: 0.12 }, '--color-success': { copy: true } } },
  { base: '--color-error', key: 'appearance.colError', def: 'Erreur',
    derive: { '--color-error-subtle': { a: 0.12 } } },
  { base: '--color-warning', key: 'appearance.colWarning', def: 'Avertissement',
    derive: { '--color-warning-subtle': { a: 0.12 } } },
];

const FONTS = [
  { id: 'inter',   def: 'Inter (défaut)',   stack: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" },
  { id: 'system',  def: 'Système',          stack: "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" },
  { id: 'grotesk', def: 'Grotesque',        stack: "'Segoe UI', 'Helvetica Neue', Arial, sans-serif" },
  { id: 'serif',   def: 'Serif',            stack: "Georgia, 'Times New Roman', Cambria, serif" },
  { id: 'rounded', def: 'Arrondie',         stack: "'Trebuchet MS', 'Segoe UI', Verdana, sans-serif" },
];

const RADII = [
  { id: 'default', def: 'Standard',    md: null,   lg: null },
  { id: 'sharp',   def: 'Net',         md: '5px',  lg: '7px' },
  { id: 'soft',    def: 'Doux',        md: '12px', lg: '16px' },
  { id: 'round',   def: 'Rond',        md: '18px', lg: '24px' },
];

let _theme = { tokens: {}, dark: {}, light: {} };   // full doc loaded from server
let _overrides = {};                                 // working token overrides
let _dirty = false;
let _previewDoc = null;

function _mark(on) { _dirty = on; setUnsaved(on); const s = el('appearance-save'); if (s) s.disabled = !on; }

function _computed(name, fallback) {
  if (_overrides[name] != null) return _overrides[name];
  try {
    if (_previewDoc) {
      const v = getComputedStyle(_previewDoc.documentElement).getPropertyValue(name).trim();
      if (v) return v;
    }
  } catch (_) { /* iframe not ready */ }
  return fallback;
}

function _applyOverridesToPreview() {
  if (!_previewDoc) return;
  const root = _previewDoc.documentElement;
  for (const [k, v] of Object.entries(_overrides)) {
    try { root.style.setProperty(k, v); } catch (_) {}
  }
}

function _setColor(base, hex, derive) {
  _overrides[base] = hex;
  for (const [name, rule] of Object.entries(derive || {})) {
    if (rule.copy) _overrides[name] = hex;
    else if (typeof rule.dl === 'number') _overrides[name] = _adjustL(hex, rule.dl);
    else if (typeof rule.a === 'number') _overrides[name] = _rgba(hex, rule.a);
  }
  _applyOverridesToPreview();
  _mark(true);
}

function _setFont(stack) {
  if (stack) _overrides['--font-sans'] = stack; else delete _overrides['--font-sans'];
  _applyOverridesToPreview();
  _mark(true);
}

function _setRadius(opt) {
  ['--radius-md', '--radius-lg'].forEach((k, i) => {
    const v = i === 0 ? opt.md : opt.lg;
    if (v) _overrides[k] = v; else delete _overrides[k];
    if (_previewDoc) { try { if (v) _previewDoc.documentElement.style.setProperty(k, v); else _previewDoc.documentElement.style.removeProperty(k); } catch (_) {} }
  });
  _mark(true);
}

function render() {
  const root = el('appearance-root');
  if (!root) return;

  const colorRows = COLORS.map((c) => `
    <label class="adm-field" style="flex-direction:row;align-items:center;gap:12px;justify-content:space-between">
      <span class="adm-field-label" style="margin:0">${escHtml(t(c.key, c.def))}</span>
      <input type="color" class="adm-color-input" data-color="${c.base}" style="width:52px;height:34px;border:none;background:none;cursor:pointer">
    </label>`).join('');

  const fontOpts = FONTS.map((f) => `<option value="${f.id}">${escHtml(t('appearance.font.' + f.id, f.def))}</option>`).join('');
  const radiusOpts = RADII.map((r) => `<option value="${r.id}">${escHtml(t('appearance.radius.' + r.id, r.def))}</option>`).join('');

  root.innerHTML = `
    <div class="adm-page-head">
      <div>
        <h2 class="adm-page-title">${escHtml(t('appearance.title', 'Apparence'))}</h2>
        <p class="adm-page-sub">${escHtml(t('appearance.sub', 'Personnalisez le thème du site public (couleurs, police, arrondis). Aperçu en direct.'))}</p>
      </div>
      <div style="display:flex;gap:8px">
        <button class="adm-btn adm-btn-ghost adm-btn-sm" id="appearance-reset"><i data-lucide="rotate-ccw"></i> ${escHtml(t('appearance.reset', 'Réinitialiser'))}</button>
        <button class="adm-btn adm-btn-accent adm-btn-sm" id="appearance-save" disabled><i data-lucide="save"></i> ${escHtml(t('appearance.save', 'Enregistrer'))}</button>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:320px 1fr;gap:20px;align-items:start">
      <div class="adm-card" style="padding:18px">
        <div class="adm-card-head"><i data-lucide="palette"></i><span>${escHtml(t('appearance.colors', 'Couleurs de marque'))}</span></div>
        <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">${colorRows}</div>

        <div class="adm-card-head" style="margin-top:20px"><i data-lucide="type"></i><span>${escHtml(t('appearance.typography', 'Typographie'))}</span></div>
        <label class="adm-field" style="margin-top:8px">
          <span class="adm-field-label">${escHtml(t('appearance.fontLabel', 'Police'))}</span>
          <select class="adm-field-input" id="appearance-font">${fontOpts}</select>
        </label>

        <div class="adm-card-head" style="margin-top:20px"><i data-lucide="square"></i><span>${escHtml(t('appearance.shape', 'Formes'))}</span></div>
        <label class="adm-field" style="margin-top:8px">
          <span class="adm-field-label">${escHtml(t('appearance.radiusLabel', 'Arrondi des coins'))}</span>
          <select class="adm-field-input" id="appearance-radius">${radiusOpts}</select>
        </label>
      </div>

      <div class="adm-card" style="padding:0;overflow:hidden">
        <div class="adm-card-head" style="padding:12px 16px"><i data-lucide="eye"></i><span>${escHtml(t('appearance.preview', 'Aperçu en direct'))}</span></div>
        <iframe id="appearance-preview" src="index.html" title="preview" style="width:100%;height:560px;border:none;border-top:1px solid var(--adm-border, #2a2a3a);background:#0d0d1a"></iframe>
      </div>
    </div>`;

  // Wire controls
  root.querySelectorAll('.adm-color-input').forEach((input) => {
    const base = input.getAttribute('data-color');
    const spec = COLORS.find((c) => c.base === base);
    input.addEventListener('input', () => _setColor(base, input.value, spec.derive));
  });
  el('appearance-font').addEventListener('change', (e) => {
    const f = FONTS.find((x) => x.id === e.target.value);
    _setFont(f && f.id !== 'inter' ? f.stack : (f ? f.stack : null));
  });
  el('appearance-radius').addEventListener('change', (e) => {
    const r = RADII.find((x) => x.id === e.target.value) || RADII[0];
    _setRadius(r);
  });
  el('appearance-save').addEventListener('click', save);
  el('appearance-reset').addEventListener('click', reset);

  const frame = el('appearance-preview');
  frame.addEventListener('load', _onPreviewReady);

  refreshIcons(root);
}

function _onPreviewReady() {
  const frame = el('appearance-preview');
  try { _previewDoc = frame.contentDocument || frame.contentWindow.document; } catch (_) { _previewDoc = null; }
  // Re-apply unsaved overrides on top of the (freshly loaded) saved theme.css.
  _applyOverridesToPreview();
  // Prefill the pickers from the current effective values.
  COLORS.forEach((c) => {
    const input = document.querySelector(`.adm-color-input[data-color="${c.base}"]`);
    if (!input) return;
    let val = _computed(c.base, '#000000');
    const m = /#([0-9a-f]{6})/i.exec(val);
    input.value = m ? '#' + m[1] : (val.startsWith('#') ? val : '#000000');
  });
  // Prefill font/radius selects from existing overrides.
  const fontSel = el('appearance-font');
  if (fontSel && _overrides['--font-sans']) {
    const f = FONTS.find((x) => x.stack === _overrides['--font-sans']);
    if (f) fontSel.value = f.id;
  }
  const radSel = el('appearance-radius');
  if (radSel) {
    const r = RADII.find((x) => x.md && _overrides['--radius-md'] === x.md);
    radSel.value = r ? r.id : 'default';
  }
}

async function load() {
  const data = await apiFetch(`${API_SITE}?action=get&doc=theme`);
  _theme = (data && typeof data === 'object') ? data : { tokens: {}, dark: {}, light: {} };
  _overrides = Object.assign({}, _theme.tokens || {});
  _mark(false);
  render();
}

async function save() {
  const body = { tokens: _overrides, dark: _theme.dark || {}, light: _theme.light || {} };
  const r = await apiFetchStatus(`${API_SITE}?action=save&doc=theme`, { method: 'POST', body: JSON.stringify(body) });
  if (r.ok) {
    _theme.tokens = Object.assign({}, _overrides);
    _mark(false);
    toast(t('appearance.saved', 'Thème enregistré.'), 'success');
    const frame = el('appearance-preview');
    if (frame) frame.contentWindow.location.reload();   // confirm persisted look (re-fetches theme.css)
  } else {
    toast(t('appearance.saveError', "Échec de l'enregistrement du thème."), 'error');
  }
}

async function reset() {
  if (!confirm(t('appearance.resetConfirm', 'Réinitialiser le thème aux valeurs par défaut ?'))) return;
  const r = await apiFetchStatus(`${API_SITE}?action=reset&doc=theme`, { method: 'POST', body: '{}' });
  if (r.ok) {
    _overrides = {};
    _theme = { tokens: {}, dark: {}, light: {} };
    _mark(false);
    toast(t('appearance.resetDone', 'Thème réinitialisé.'), 'success');
    const frame = el('appearance-preview');
    if (frame) frame.contentWindow.location.reload();
    // Re-render so pickers pull the restored defaults after the iframe reloads.
  } else {
    toast(t('appearance.saveError', "Échec de l'enregistrement du thème."), 'error');
  }
}

export const AppearanceTab = {
  id: 'appearance',
  titleKey: 'admin.navAppearance',
  titleDefault: 'Apparence',
  mounted: false,
  mount() { render(); load(); },
  activate() { load(); },
  relabel() { render(); load(); },
};
