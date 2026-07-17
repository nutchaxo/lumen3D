/**
 * Admin SPA — Pages editor field controls (click-first, zero-raw-values)
 * ============================================================================
 * Reusable control library for the Pages tab settings sidebar. Every widget /
 * column / section setting is declared as a field descriptor and rendered by
 * renderFields(host, obj, fields, ctx); controls write straight into the model
 * object via dot-paths and call ctx.onChange() (mark dirty + live iframe sync).
 *
 * Descriptor types ({k: 'props.x', l: 'Label', t: <type>, …}):
 *   text | ltext | ltextarea      plain / localized inputs (ph, hint)
 *   select                        dropdown, opts: [[value, label]]
 *   check                         toggle switch
 *   seg                           segmented buttons, opts: [[value, label, icon?]];
 *                                 refresh:true re-runs ctx.refresh() after commit
 *   slider                        range + fine number twin (min, max, step,
 *                                 unit, dv = visual default; ph ⇒ clearable "auto")
 *   color                         rich picker: theme tokens + Récents + palette +
 *                                 custom + opacity (color-mix); grad:true adds
 *                                 the GRADIENT tab (presets, stops, angle pad,
 *                                 linear/radial, save-as-preset)
 *   icon                          searchable Lucide icon picker (first tile
 *                                 clears the field to '' — "Aucune")
 *   items                         repeatable list editor (item: [subfields],
 *                                 mk: () => newItem, summary: (item,lv) => str;
 *                                 subfields support refresh:true + dis(item))
 *   spacing                       4-side linked padding/margin control:
 *                                 keys:{top,right,bottom,left} (dot-paths), min, max
 *   shadow                        preset seg ('' | sm | md | lg | glow) at `k`,
 *                                 with a conditional color picker at `colorKey`
 *
 * Any field descriptor may also carry:
 *   showIf(obj) → false           skip rendering the field entirely
 *
 * ctx = { loc, onChange(), gradients: { get: () => [css…], save: (list) => },
 *         refresh?, groupKey? }    refresh/groupKey are supplied by renderGroups.
 *
 * renderGroups(host, obj, groups, ctx) — groups: [{title, icon, fields, open?}].
 * Renders each as a <details class="pbc-group"> (open-state remembered across
 * re-renders, keyed by `${ctx.groupKey}|${title}`); passes each group's own
 * fields through renderFields with a `refresh` that redraws just that group's
 * body (used by seg fields declaring refresh:true, e.g. media-kind switches).
 *
 * The generated CSS strings stay 100% compatible with PageRenderer's
 * sanitizers (_sanitizeCss keeps parens, strips <>;{}) — colors compose to
 * plain values, `color-mix(in srgb, C N%, transparent)` for opacity and
 * `linear|radial-gradient(…)` for gradients, all parseable back on reopen.
 */

'use strict';

import { t, refreshIcons } from './shared.js';

// ── Path + locale helpers ─────────────────────────────────────────
export function pathGet(o, path) { let v = o; for (const s of path.split('.')) { if (v != null && typeof v === 'object') v = v[s]; else return undefined; } return v; }
export function pathPut(o, path, val) { const s = path.split('.'); let c = o; for (let i = 0; i < s.length - 1; i++) { if (typeof c[s[i]] !== 'object' || c[s[i]] == null) c[s[i]] = {}; c = c[s[i]]; } c[s[s.length - 1]] = val; }
function locVal(v, loc) { if (v == null) return ''; if (typeof v === 'string') return v; if (typeof v === 'object') return v[loc] || ''; return String(v); }

// ── Design constants ──────────────────────────────────────────────
// Theme tokens: previews use the public-site fallbacks (the admin page does
// not load the site theme); the live iframe shows the truly resolved color.
const THEME_SWATCHES = [
  ['var(--color-primary)', '#00A654', 'colorPrimary', 'Couleur primaire'],
  ['var(--color-accent)', '#00D2FF', 'colorAccent', 'Couleur accent'],
  ['var(--bg-base)', '#0d0d1a', 'colorBgBase', 'Fond du site'],
  ['var(--bg-surface)', '#161622', 'colorSurface', 'Surface / carte'],
  ['var(--text-primary)', '#e8e8f0', 'colorText', 'Texte'],
  ['var(--text-muted)', '#8a8a9a', 'colorTextMuted', 'Texte atténué'],
  ['var(--border-subtle)', '#2a2a3a', 'colorBorder', 'Bordure'],
];
const PALETTE_COLORS = [
  '#ffffff', '#d8dbe6', '#9aa0b5', '#5a6072', '#2b2f3d', '#14161f', '#000000',
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#10b981',
  '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7',
  '#d946ef', '#ec4899', '#f43f5e',
];
// Session-only "recently used" solid colors (not persisted — resets on reload,
// shared across every color field so a pick in one control shows up in others).
const _recentColors = [];
function _pushRecentColor(v) {
  if (!v || isGradient(v)) return;
  const i = _recentColors.indexOf(v);
  if (i !== -1) _recentColors.splice(i, 1);
  _recentColors.unshift(v);
  if (_recentColors.length > 8) _recentColors.length = 8;
}
export const BUILTIN_GRADIENTS = [
  'linear-gradient(135deg, var(--color-primary,#00A654) 0%, var(--color-accent,#00D2FF) 100%)',
  'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  'linear-gradient(135deg, #2af598 0%, #009efd 100%)',
  'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
  'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
  'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
  'linear-gradient(135deg, #30cfd0 0%, #330867 100%)',
  'linear-gradient(135deg, #134e5e 0%, #71b280 100%)',
  'linear-gradient(135deg, #c31432 0%, #240b36 100%)',
  'linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)',
  'linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)',
  'radial-gradient(circle, #667eea 0%, #2b2d5e 100%)',
];
// 8-way direction pad (CSS: 0deg = to top, clockwise).
const DIRECTIONS = [
  [315, 'arrow-up-left'], [0, 'arrow-up'], [45, 'arrow-up-right'], [90, 'arrow-right'],
  [135, 'arrow-down-right'], [180, 'arrow-down'], [225, 'arrow-down-left'], [270, 'arrow-left'],
];
const FAVORITE_ICONS = [
  'star', 'heart', 'sparkles', 'award', 'badge-check', 'check-circle', 'info', 'alert-circle',
  'microscope', 'flask-conical', 'atom', 'dna', 'brain', 'activity', 'leaf', 'sun',
  'moon', 'zap', 'flame', 'droplet', 'eye', 'camera', 'image', 'video',
  'map-pin', 'globe', 'mail', 'phone', 'calendar', 'clock', 'users', 'user',
  'book-open', 'graduation-cap', 'lightbulb', 'rocket', 'target', 'layers', 'database', 'settings',
  'wrench', 'shield', 'lock', 'download', 'upload', 'external-link', 'arrow-right', 'github',
];

// ── Small DOM builders ────────────────────────────────────────────
function mk(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function mkBtn(cls, title) { const b = mk('button', cls); b.type = 'button'; if (title) b.title = title; return b; }
function mkIcon(name, size) { const i = document.createElement('i'); i.setAttribute('data-lucide', name); if (size) i.style.cssText = `width:${size}px;height:${size}px`; return i; }
function fieldWrap(label) {
  const w = mk('div', 'adm-field');
  if (label) w.appendChild(mk('span', 'adm-field-label', label));
  return w;
}
function kebab(s) { return String(s).replace(/([a-z])([A-Z])/g, '$1-$2').replace(/([a-zA-Z])(\d)/g, '$1-$2').toLowerCase(); }
function allLucideNames() {
  try {
    if (window.lucide && window.lucide.icons) return Object.keys(window.lucide.icons).map(kebab);
  } catch (_) {}
  return FAVORITE_ICONS;
}

// ── Color value model ─────────────────────────────────────────────
// A stored value is one of: '' | <color> | color-mix(in srgb, <color> A%,
// transparent) | linear|radial-gradient(…). Decompose for round-trip editing.
function parseAlphaColor(v) {
  const m = /^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%\s*,\s*transparent\s*\)$/i.exec(String(v || '').trim());
  if (m) return { base: m[1], alpha: Math.round(+m[2]) };
  return { base: String(v || '').trim(), alpha: 100 };
}
function composeAlphaColor(base, alpha) {
  if (!base) return '';
  return alpha >= 100 ? base : `color-mix(in srgb, ${base} ${alpha}%, transparent)`;
}
// Split gradient args on top-level commas (colors contain nested parens).
function splitTopLevel(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
export function parseGradient(v) {
  const m = /^(linear|radial)-gradient\((.+)\)$/i.exec(String(v || '').trim());
  if (!m) return null;
  const args = splitTopLevel(m[2]);
  if (!args.length) return null;
  const g = { type: m[1].toLowerCase(), angle: 135, stops: [] };
  let first = 0;
  const am = /^(\d+(?:\.\d+)?)deg$/.exec(args[0]);
  const TO = { 'to top': 0, 'to top right': 45, 'to right top': 45, 'to right': 90, 'to bottom right': 135, 'to right bottom': 135, 'to bottom': 180, 'to bottom left': 225, 'to left bottom': 225, 'to left': 270, 'to top left': 315, 'to left top': 315 };
  if (am) { g.angle = Math.round(+am[1]) % 360; first = 1; }
  else if (/^(circle|ellipse)/i.test(args[0])) first = 1;
  else if (TO[args[0].toLowerCase()] != null) { g.angle = TO[args[0].toLowerCase()]; first = 1; }
  else if (/^to\s/i.test(args[0])) { first = 1; }   // unknown keyword direction — skip it, keep default angle
  for (let i = first; i < args.length; i++) {
    const sm = /^(.*?)(?:\s+[\d.]+%)?$/.exec(args[i]);
    if (sm && sm[1]) g.stops.push(sm[1].trim());
  }
  return g.stops.length >= 2 ? g : null;
}
export function buildGradient(g) {
  const stops = g.stops.map((c, i) => `${c} ${Math.round((i / (g.stops.length - 1)) * 100)}%`).join(', ');
  return g.type === 'radial' ? `radial-gradient(circle, ${stops})` : `linear-gradient(${g.angle}deg, ${stops})`;
}
function isGradient(v) { return /^(linear|radial)-gradient\(/i.test(String(v || '').trim()); }
function swatchTitle(sw) { return t('pages.pc.' + sw[2], sw[3]); }
function prettyColorLabel(v) {
  const s = String(v || '').trim();
  if (!s) return t('pages.pc.auto', 'Auto');
  if (isGradient(s)) return t('pages.pc.gradient', 'Dégradé');
  const { base, alpha } = parseAlphaColor(s);
  const tm = /^var\(\s*(--[\w-]+)/.exec(base);
  const sw = tm ? THEME_SWATCHES.find((x) => x[0] === `var(${tm[1]})`) : null;
  const name = sw ? swatchTitle(sw) : (tm ? tm[1] : base);
  return alpha < 100 ? `${name} · ${alpha}%` : name;
}
// Preview background for the admin sidebar: the site theme tokens are not
// loaded here, so give fallback-less var(--x) a representative fallback.
// var() already carrying a fallback is left untouched.
function previewBg(v) {
  return String(v || '').replace(/var\(\s*(--[\w-]+)\s*\)/g, (m, name) => {
    const sw = THEME_SWATCHES.find((x) => x[0] === `var(${name})`);
    return sw ? `var(${name}, ${sw[1]})` : m;
  });
}
function applyChip(chip, v) {
  chip.classList.toggle('pbc-chip--empty', !v);
  chip.style.background = v ? previewBg(v) : '';
}

// ══════════════════════════════════════════════════════════════════
// Individual controls
// ══════════════════════════════════════════════════════════════════

function ctlText(obj, f, ctx) {
  const w = fieldWrap(f.l);
  const inp = mk('input', 'adm-field-input');
  inp.type = 'text';
  inp.placeholder = f.ph || '';
  const val = pathGet(obj, f.k);
  inp.value = typeof val === 'string' ? val : (val != null ? String(val) : '');
  inp.addEventListener('input', () => { pathPut(obj, f.k, inp.value); ctx.onChange(); });
  w.appendChild(inp);
  if (f.hint) { const h = mk('span', 'adm-page-sub', f.hint); h.style.cssText = 'font-size:11px;margin-top:2px'; w.appendChild(h); }
  return w;
}

function ctlLText(obj, f, ctx, area) {
  const w = fieldWrap(f.l);
  const inp = area ? mk('textarea', 'adm-field-input') : mk('input', 'adm-field-input');
  if (area) { inp.rows = f.rows || 4; inp.style.resize = 'vertical'; } else inp.type = 'text';
  inp.placeholder = f.ph || '';
  inp.value = locVal(pathGet(obj, f.k), ctx.loc);
  inp.addEventListener('input', () => {
    let o = pathGet(obj, f.k);
    if (typeof o !== 'object' || o == null) { o = {}; pathPut(obj, f.k, o); }
    o[ctx.loc] = inp.value;
    ctx.onChange();
  });
  w.appendChild(inp);
  return w;
}

function ctlSelect(obj, f, ctx) {
  const w = fieldWrap(f.l);
  const sel = mk('select', 'adm-field-input');
  const cur = String(pathGet(obj, f.k) ?? '');
  (f.opts || []).forEach(([v, lab]) => {
    const o = mk('option', null, lab); o.value = v; if (cur === v) o.selected = true; sel.appendChild(o);
  });
  sel.addEventListener('change', () => { pathPut(obj, f.k, sel.value); ctx.onChange(); if (f.refresh && ctx.refresh) ctx.refresh(); });
  w.appendChild(sel);
  return w;
}

function ctlCheck(obj, f, ctx) {
  const w = mk('label', 'adm-field pbc-checkrow');
  w.appendChild(mk('span', 'adm-field-label', f.l));
  const sw = mk('span', 'pbc-switch');
  const inp = document.createElement('input');
  inp.type = 'checkbox';
  inp.checked = !!pathGet(obj, f.k);
  sw.appendChild(inp);
  sw.appendChild(mk('span', 'pbc-switch-knob'));
  inp.addEventListener('change', () => { pathPut(obj, f.k, inp.checked); ctx.onChange(); });
  w.appendChild(sw);
  return w;
}

function ctlSeg(obj, f, ctx) {
  const w = fieldWrap(f.l);
  const seg = mk('div', 'pbc-seg');
  const cur = String(pathGet(obj, f.k) ?? '');
  const btns = [];
  (f.opts || []).forEach(([v, lab, icon]) => {
    const b = mkBtn(null, lab || v);
    if (icon) b.appendChild(mkIcon(icon, 14));
    if (lab) b.appendChild(mk('span', null, lab));
    if (cur === String(v)) b.classList.add('on');
    b.addEventListener('click', () => {
      pathPut(obj, f.k, v);
      btns.forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      ctx.onChange();
      if (f.refresh && ctx.refresh) ctx.refresh();
    });
    btns.push(b);
    seg.appendChild(b);
  });
  w.appendChild(seg);
  return w;
}

function ctlSlider(obj, f, ctx) {
  const w = fieldWrap(null);
  const head = mk('div', 'pbc-slider-head');
  head.appendChild(mk('span', 'adm-field-label', f.l));
  const clearable = f.ph != null;
  w.appendChild(head);
  const row = mk('div', 'pbc-row');
  const range = document.createElement('input');
  range.type = 'range';
  range.className = 'pbc-range';
  range.min = f.min; range.max = f.max; range.step = f.step || 1;
  const num = mk('input', 'pbc-num');
  num.type = 'number';
  num.min = f.min; num.max = f.max; num.step = f.step || 1;
  num.placeholder = f.ph || '';
  const unit = mk('span', 'pbc-unit', f.unit || 'px');
  const reset = mkBtn('pbc-reset', t('pages.pc.reset', 'Réinitialiser (auto)'));
  reset.textContent = '×';
  const cur = pathGet(obj, f.k);
  const isSet = cur !== '' && cur != null && !isNaN(+cur);
  range.value = isSet ? +cur : (f.dv != null ? f.dv : f.min);
  num.value = isSet ? String(+cur) : '';
  reset.style.display = clearable && isSet ? '' : 'none';
  const commit = (v) => {
    pathPut(obj, f.k, v);
    reset.style.display = clearable && v !== '' ? '' : 'none';
    ctx.onChange();
  };
  range.addEventListener('input', () => { num.value = range.value; commit(+range.value); });
  num.addEventListener('input', () => {
    if (num.value === '') { commit(''); range.value = f.dv != null ? f.dv : f.min; return; }
    const v = +num.value;
    if (!isNaN(v)) { range.value = Math.max(+f.min, Math.min(+f.max, v)); commit(v); }
  });
  reset.addEventListener('click', () => { num.value = ''; range.value = f.dv != null ? f.dv : f.min; commit(''); });
  row.appendChild(range);
  row.appendChild(num);
  row.appendChild(unit);
  if (clearable) row.appendChild(reset);
  w.appendChild(row);
  return w;
}

// ── Linked 4-side spacing control (Elementor-style padding/margin) ────────
const _SPACING_SIDES = ['top', 'right', 'bottom', 'left'];
const _SPACING_LBL = { top: 'T', right: 'R', bottom: 'B', left: 'L' };
function ctlSpacing(obj, f, ctx) {
  const min = f.min != null ? +f.min : 0;
  const max = f.max != null ? +f.max : 300;
  const w = mk('div', 'adm-field');
  const head = mk('div', 'pbc-slider-head');
  head.appendChild(mk('span', 'adm-field-label', f.l));
  const linkBtn = mkBtn('pbc-mini pbc-spacing-link');
  head.appendChild(linkBtn);
  w.appendChild(head);

  const grid = mk('div', 'pbc-spacing');
  const inputs = {};
  _SPACING_SIDES.forEach((side) => {
    const cell = mk('div', 'pbc-spacing-cell');
    const inp = mk('input', 'pbc-num');
    inp.type = 'number';
    inp.min = min; inp.max = max;
    inp.placeholder = 'auto';
    inputs[side] = inp;
    cell.appendChild(inp);
    cell.appendChild(mk('span', 'pbc-spacing-lbl', _SPACING_LBL[side]));
    grid.appendChild(cell);
  });
  const reset = mkBtn('pbc-reset', t('pages.pc.reset', 'Réinitialiser (auto)'));
  reset.textContent = '×';
  grid.appendChild(reset);
  w.appendChild(grid);

  const getVal = (side) => {
    const v = pathGet(obj, f.keys[side]);
    return (v === '' || v == null || isNaN(+v)) ? '' : +v;
  };
  const allSame = () => {
    const vals = _SPACING_SIDES.map(getVal);
    return vals.every((v) => v === vals[0]);
  };
  let linked = allSame();

  const syncLinkBtn = () => {
    linkBtn.textContent = '';
    linkBtn.appendChild(mkIcon(linked ? 'link' : 'unlink', 13));
    linkBtn.classList.toggle('on', linked);
    linkBtn.title = linked ? t('pages.st.linked', 'Lier les côtés') : t('pages.st.unlinked', 'Côtés indépendants');
    refreshIcons(linkBtn);
  };
  const syncInputs = () => { _SPACING_SIDES.forEach((s) => { const v = getVal(s); inputs[s].value = v === '' ? '' : String(v); }); };
  syncLinkBtn();
  syncInputs();

  const commitSide = (side, val) => pathPut(obj, f.keys[side], val);

  _SPACING_SIDES.forEach((side) => {
    inputs[side].addEventListener('input', () => {
      const raw = inputs[side].value;
      const val = raw === '' ? '' : Math.max(min, Math.min(max, +raw));
      if (linked) {
        _SPACING_SIDES.forEach((s) => { commitSide(s, val); if (s !== side) inputs[s].value = val === '' ? '' : String(val); });
      } else {
        commitSide(side, val);
      }
      ctx.onChange();
    });
  });

  linkBtn.addEventListener('click', () => {
    linked = !linked;
    if (linked) {
      const first = _SPACING_SIDES.map(getVal).find((v) => v !== '');
      _SPACING_SIDES.forEach((s) => commitSide(s, first == null ? '' : first));
      syncInputs();
      ctx.onChange();
    }
    syncLinkBtn();
  });

  reset.addEventListener('click', () => {
    _SPACING_SIDES.forEach((s) => commitSide(s, ''));
    syncInputs();
    ctx.onChange();
  });

  return w;
}

// ── Shadow preset + conditional color ──────────────────────────────
function ctlShadow(obj, f, ctx) {
  const w = mk('div', 'adm-field');
  const colorHost = mk('div');
  const drawColor = () => {
    colorHost.textContent = '';
    const v = String(pathGet(obj, f.k) || '');
    if (v && f.colorKey) {
      colorHost.appendChild(ctlColor(obj, {
        k: f.colorKey,
        l: t('pages.st.shadowColor', "Couleur de l'ombre"),
        grad: false,
      }, ctx));
    }
  };
  const seg = ctlSeg(obj, {
    k: f.k,
    l: f.l,
    refresh: true,
    opts: [
      ['', '—'],
      ['sm', 'S'],
      ['md', 'M'],
      ['lg', 'L'],
      ['glow', t('pages.st.shadowGlow', 'Halo')],
    ],
  }, Object.assign({}, ctx, { refresh: drawColor }));
  w.appendChild(seg);
  w.appendChild(colorHost);
  drawColor();
  return w;
}

// ── Rich color / gradient picker ──────────────────────────────────
function ctlColor(obj, f, ctx) {
  const w = fieldWrap(f.l);
  const cur = () => String(pathGet(obj, f.k) || '');

  const btn = mkBtn('pbc-colbtn');
  const chip = mk('span', 'pbc-chip');
  const lbl = mk('span', 'pbc-colbtn-val');
  // Rotate a wrapper span, not the <i>: lucide.createIcons REPLACES the <i>
  // with an <svg>, which would leave `caret` pointing at a detached node.
  const caret = mk('span', 'pbc-caret');
  caret.appendChild(mkIcon('chevron-down', 13));
  btn.appendChild(chip); btn.appendChild(lbl); btn.appendChild(caret);
  const sync = () => { applyChip(chip, cur()); lbl.textContent = prettyColorLabel(cur()); };
  sync();
  w.appendChild(btn);

  const pop = mk('div', 'pbc-pop');
  pop.hidden = true;
  w.appendChild(pop);

  const set = (v) => { pathPut(obj, f.k, v); _pushRecentColor(v); sync(); ctx.onChange(); };

  let mode = null; // 'color' | 'grad'
  const openPanel = () => {
    pop.hidden = false;
    caret.style.transform = 'rotate(180deg)';
    buildPanel();
  };
  const closePanel = () => { pop.hidden = true; caret.style.transform = ''; };
  btn.addEventListener('click', () => (pop.hidden ? openPanel() : closePanel()));

  function buildPanel() {
    pop.textContent = '';
    // gradFirst: fields whose whole point is a gradient (e.g. text gradient)
    // open on the Dégradé tab when still empty.
    if (mode == null) mode = isGradient(cur()) ? 'grad' : (f.gradFirst && !cur() ? 'grad' : 'color');
    if (f.grad) {
      const seg = mk('div', 'pbc-seg');
      [['color', t('pages.pc.solid', 'Couleur')], ['grad', t('pages.pc.gradient', 'Dégradé')]].forEach(([m, lab]) => {
        const b = mkBtn(null, lab);
        b.appendChild(mk('span', null, lab));
        if (mode === m) b.classList.add('on');
        b.addEventListener('click', () => { mode = m; buildPanel(); });
        seg.appendChild(b);
      });
      pop.appendChild(seg);
    }
    if (mode === 'grad' && f.grad) buildGradPane();
    else buildColorPane();
    refreshIcons(pop);
  }

  // ---- solid color pane ----
  function buildColorPane() {
    const state = parseAlphaColor(isGradient(cur()) ? '' : cur());

    // clear + theme tokens + palette
    const grid = mk('div', 'pbc-swgrid');
    const none = mkBtn('pbc-sw pbc-sw--none', t('pages.pc.none', 'Aucune (auto)'));
    none.addEventListener('click', () => { set(''); closePanel(); });
    grid.appendChild(none);
    THEME_SWATCHES.forEach((sw) => {
      const [tok, fb] = sw;
      const b = mkBtn('pbc-sw', swatchTitle(sw) + ' — ' + t('pages.pc.themeHint', 'suit le thème du site'));
      b.style.background = `var(${tok.slice(4, -1)}, ${fb})`;
      b.appendChild(mk('span', 'pbc-sw-dot'));
      b.addEventListener('click', () => { state.base = tok; set(composeAlphaColor(state.base, state.alpha)); });
      grid.appendChild(b);
    });
    if (_recentColors.length) {
      grid.appendChild(mk('div', 'pbc-recent-label', t('pages.pc.recent', 'Récents')));
      _recentColors.forEach((c) => {
        const b = mkBtn('pbc-sw', c);
        b.style.background = previewBg(c);
        b.addEventListener('click', () => set(c));
        grid.appendChild(b);
      });
    }
    PALETTE_COLORS.forEach((c) => {
      const b = mkBtn('pbc-sw', c);
      b.style.background = c;
      b.addEventListener('click', () => { state.base = c; set(composeAlphaColor(state.base, state.alpha)); });
      grid.appendChild(b);
    });
    pop.appendChild(grid);

    // custom color + opacity
    const rowC = mk('div', 'pbc-row');
    const nat = document.createElement('input');
    nat.type = 'color';
    nat.className = 'pbc-native';
    nat.value = /^#[0-9a-f]{6}$/i.test(state.base) ? state.base : '#888888';
    nat.title = t('pages.pc.custom', 'Couleur personnalisée');
    nat.addEventListener('input', () => { state.base = nat.value; set(composeAlphaColor(state.base, state.alpha)); });
    rowC.appendChild(nat);
    rowC.appendChild(mk('span', 'pbc-mini-label', t('pages.pc.custom', 'Couleur personnalisée')));
    pop.appendChild(rowC);

    const rowA = mk('div', 'pbc-row');
    rowA.appendChild(mk('span', 'pbc-mini-label', t('pages.pc.opacity', 'Opacité')));
    const al = document.createElement('input');
    al.type = 'range'; al.className = 'pbc-range'; al.min = 0; al.max = 100; al.step = 5;
    al.value = state.alpha;
    const alv = mk('span', 'pbc-unit', state.alpha + '%');
    al.addEventListener('input', () => {
      state.alpha = +al.value; alv.textContent = state.alpha + '%';
      if (state.base) set(composeAlphaColor(state.base, state.alpha));
    });
    rowA.appendChild(al); rowA.appendChild(alv);
    pop.appendChild(rowA);

    // advanced raw value (var(), any CSS color) — collapsed by default
    const det = document.createElement('details');
    det.className = 'pbc-adv';
    const sum = mk('summary', null, t('pages.pc.advanced', 'Avancé (valeur CSS)'));
    det.appendChild(sum);
    const raw = mk('input', 'adm-field-input');
    raw.type = 'text';
    raw.placeholder = '#0a84ff / var(--color-primary) / rgba(…)';
    raw.value = cur();
    raw.addEventListener('input', () => { pathPut(obj, f.k, raw.value); sync(); ctx.onChange(); });
    det.appendChild(raw);
    pop.appendChild(det);
  }

  // ---- gradient pane ----
  function buildGradPane() {
    const g = parseGradient(cur()) || { type: 'linear', angle: 135, stops: ['#667eea', '#764ba2'] };

    const prev = mk('div', 'pbc-gradprev');
    const paint = () => { prev.style.background = previewBg(buildGradient(g)); };
    paint();
    pop.appendChild(prev);
    const apply = () => { paint(); set(buildGradient(g)); };

    // presets: built-in + operator customs (with delete)
    const customs = (ctx.gradients && ctx.gradients.get()) || [];
    const pg = mk('div', 'pbc-presetgrid');
    const addPresetTile = (css, custom, idx) => {
      const cell = mk('div', 'pbc-preset-cell');
      const b = mkBtn('pbc-preset', t('pages.pc.applyPreset', 'Appliquer ce dégradé'));
      b.style.background = previewBg(css);
      b.addEventListener('click', () => {
        const parsed = parseGradient(css);
        if (parsed) { Object.assign(g, parsed); apply(); buildPanel(); }
        else set(css);
      });
      cell.appendChild(b);
      if (custom) {
        const del = mkBtn('pbc-preset-del', t('pages.pc.deletePreset', 'Supprimer ce préréglage'));
        del.textContent = '×';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          const list = (ctx.gradients.get() || []).slice();
          list.splice(idx, 1);
          ctx.gradients.save(list);
          buildPanel();
        });
        cell.appendChild(del);
      }
      pg.appendChild(cell);
    };
    BUILTIN_GRADIENTS.forEach((css) => addPresetTile(css, false));
    customs.forEach((css, i) => addPresetTile(css, true, i));
    pop.appendChild(pg);

    // save current as preset
    const save = mkBtn('pbc-savepreset');
    save.appendChild(mkIcon('star', 13));
    save.appendChild(mk('span', null, t('pages.pc.savePreset', 'Enregistrer comme préréglage')));
    save.addEventListener('click', () => {
      const css = buildGradient(g);
      const list = (ctx.gradients.get() || []).slice();
      if (!list.includes(css) && !BUILTIN_GRADIENTS.includes(css)) {
        list.push(css);
        ctx.gradients.save(list);
        buildPanel();
      }
    });
    pop.appendChild(save);

    // stops — each one carries its own transparency (composed via color-mix so
    // "fade to transparent" gradients need zero hand-written rgba()).
    const stopsBox = mk('div', 'pbc-stops');
    const drawStops = () => {
      stopsBox.textContent = '';
      g.stops.forEach((stop, i) => {
        const sa = parseAlphaColor(stop);
        const commit = () => { g.stops[i] = composeAlphaColor(sa.base, sa.alpha); apply(); };
        const row = mk('div', 'pbc-row');
        const nat = document.createElement('input');
        nat.type = 'color'; nat.className = 'pbc-native';
        nat.value = /^#[0-9a-f]{6}$/i.test(sa.base) ? sa.base : '#888888';
        const raw = mk('input', 'adm-field-input pbc-stop-raw');
        raw.type = 'text'; raw.value = sa.base;
        nat.addEventListener('input', () => { sa.base = nat.value; raw.value = sa.base; commit(); });
        raw.addEventListener('input', () => { sa.base = raw.value; if (/^#[0-9a-f]{6}$/i.test(sa.base)) nat.value = sa.base; commit(); });
        row.appendChild(nat); row.appendChild(raw);
        if (g.stops.length > 2) {
          const del = mkBtn('pbc-reset', t('pages.delete', 'Supprimer'));
          del.textContent = '×';
          del.addEventListener('click', () => { g.stops.splice(i, 1); apply(); drawStops(); });
          row.appendChild(del);
        }
        stopsBox.appendChild(row);
        const rowA = mk('div', 'pbc-row pbc-stop-alpha');
        rowA.title = t('pages.pc.opacity', 'Opacité');
        rowA.appendChild(mk('span', 'pbc-unit', 'α'));
        const al = document.createElement('input');
        al.type = 'range'; al.className = 'pbc-range'; al.min = 0; al.max = 100; al.step = 5;
        al.value = sa.alpha;
        const alv = mk('span', 'pbc-unit', sa.alpha + '%');
        al.addEventListener('input', () => { sa.alpha = +al.value; alv.textContent = sa.alpha + '%'; commit(); });
        rowA.appendChild(al); rowA.appendChild(alv);
        stopsBox.appendChild(rowA);
      });
      if (g.stops.length < 3) {
        const add = mkBtn('pbc-addstop');
        add.textContent = '＋ ' + t('pages.pc.addStop', 'Ajouter une couleur');
        add.addEventListener('click', () => { g.stops.push('#ffffff'); apply(); drawStops(); });
        stopsBox.appendChild(add);
      }
    };
    drawStops();
    pop.appendChild(stopsBox);

    // type (linear/radial) + direction
    const typeSeg = mk('div', 'pbc-seg');
    const dirWrap = mk('div');
    [['linear', t('pages.pc.linear', 'Linéaire')], ['radial', t('pages.pc.radial', 'Radial')]].forEach(([v, lab]) => {
      const b = mkBtn(null, lab);
      b.appendChild(mk('span', null, lab));
      if (g.type === v) b.classList.add('on');
      b.addEventListener('click', () => {
        g.type = v; apply();
        typeSeg.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        dirWrap.style.display = v === 'radial' ? 'none' : '';
      });
      typeSeg.appendChild(b);
    });
    pop.appendChild(typeSeg);

    dirWrap.style.display = g.type === 'radial' ? 'none' : '';
    const pad = mk('div', 'pbc-dirpad');
    const dirBtns = [];
    DIRECTIONS.forEach(([deg, icon]) => {
      const b = mkBtn('pbc-dir', deg + '°');
      b.appendChild(mkIcon(icon, 14));
      if (g.angle === deg) b.classList.add('on');
      b.addEventListener('click', () => {
        g.angle = deg; apply();
        dirBtns.forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        ang.value = deg; angv.textContent = deg + '°';
      });
      dirBtns.push(b);
      pad.appendChild(b);
    });
    dirWrap.appendChild(pad);
    const rowAng = mk('div', 'pbc-row');
    const ang = document.createElement('input');
    ang.type = 'range'; ang.className = 'pbc-range'; ang.min = 0; ang.max = 355; ang.step = 5;
    ang.value = g.angle;
    const angv = mk('span', 'pbc-unit', g.angle + '°');
    ang.addEventListener('input', () => {
      g.angle = +ang.value; angv.textContent = g.angle + '°'; apply();
      dirBtns.forEach((x, i) => x.classList.toggle('on', DIRECTIONS[i][0] === g.angle));
    });
    rowAng.appendChild(ang); rowAng.appendChild(angv);
    dirWrap.appendChild(rowAng);
    pop.appendChild(dirWrap);

    // clear gradient
    const clear = mkBtn('pbc-addstop');
    clear.textContent = t('pages.pc.noGradient', 'Retirer le dégradé (auto)');
    clear.addEventListener('click', () => { set(''); mode = 'color'; closePanel(); });
    pop.appendChild(clear);
  }

  return w;
}

// ── Lucide icon picker ────────────────────────────────────────────
function ctlIcon(obj, f, ctx) {
  const w = fieldWrap(f.l);
  const btn = mkBtn('pbc-colbtn');
  const prev = mk('span', 'pbc-iconprev');
  const cur = () => String(pathGet(obj, f.k) || 'star');
  prev.appendChild(mkIcon(cur(), 17));
  const lbl = mk('span', 'pbc-colbtn-val', cur());
  const caret = mk('span', 'pbc-caret');
  caret.appendChild(mkIcon('chevron-down', 13));
  btn.appendChild(prev); btn.appendChild(lbl); btn.appendChild(caret);
  w.appendChild(btn);

  const pop = mk('div', 'pbc-pop');
  pop.hidden = true;
  w.appendChild(pop);

  const search = mk('input', 'adm-field-input');
  search.type = 'text';
  search.placeholder = t('pages.pc.searchIcon', 'Rechercher une icône…');
  const grid = mk('div', 'pbc-icongrid');
  const count = mk('div', 'pbc-mini-label');
  pop.appendChild(search); pop.appendChild(grid); pop.appendChild(count);

  const all = allLucideNames();
  const draw = () => {
    grid.textContent = '';
    const none = mkBtn(null, t('pages.pc.noIcon', 'Aucune'));
    none.appendChild(mkIcon('ban', 17));
    none.addEventListener('click', () => {
      pathPut(obj, f.k, '');
      lbl.textContent = t('pages.pc.noIcon', 'Aucune');
      prev.textContent = '';
      pop.hidden = true; caret.style.transform = '';
      ctx.onChange();
    });
    grid.appendChild(none);
    const q = search.value.trim().toLowerCase();
    const list = q ? all.filter((n) => n.includes(q)) : FAVORITE_ICONS.filter((n) => all.includes(n));
    const shown = list.slice(0, 96);
    shown.forEach((n) => {
      const b = mkBtn(null, n);
      b.appendChild(mkIcon(n, 17));
      b.addEventListener('click', () => {
        pathPut(obj, f.k, n);
        lbl.textContent = n;
        prev.textContent = '';
        prev.appendChild(mkIcon(n, 17));
        refreshIcons(prev);
        pop.hidden = true; caret.style.transform = '';
        ctx.onChange();
      });
      grid.appendChild(b);
    });
    count.textContent = q
      ? t('pages.pc.iconMatches', '{n} icônes trouvées').replace('{n}', String(list.length))
      : t('pages.pc.iconHintFav', 'Populaires — tapez pour chercher parmi toutes les icônes');
    refreshIcons(grid);
  };
  search.addEventListener('input', draw);
  btn.addEventListener('click', () => {
    pop.hidden = !pop.hidden;
    caret.style.transform = pop.hidden ? '' : 'rotate(180deg)';
    if (!pop.hidden) { draw(); search.focus(); }
  });
  return w;
}

// ── Repeatable items editor ───────────────────────────────────────
function ctlItems(obj, f, ctx) {
  const w = fieldWrap(f.l);
  const list = () => {
    let a = pathGet(obj, f.k);
    if (!Array.isArray(a)) { a = []; pathPut(obj, f.k, a); }
    return a;
  };
  const box = mk('div', 'pbc-items');
  w.appendChild(box);
  let openIdx = 0;

  const draw = () => {
    const items = list();
    box.textContent = '';
    items.forEach((item, i) => {
      const card = mk('div', 'pbc-item');
      const head = mk('div', 'pbc-item-head');
      const title = mk('span', 'pbc-item-title',
        `${i + 1}. ${(f.summary ? f.summary(item, (v) => locVal(v, ctx.loc)) : '') || t('pages.pc.item', 'Élément')}`);
      head.appendChild(title);
      const tools = mk('span', 'pbc-item-tools');
      const up = mkBtn('pbc-mini', t('pages.moveUp', 'Monter')); up.appendChild(mkIcon('chevron-up', 13));
      const dn = mkBtn('pbc-mini', t('pages.moveDown', 'Descendre')); dn.appendChild(mkIcon('chevron-down', 13));
      const del = mkBtn('pbc-mini pbc-mini--danger', t('pages.delete', 'Supprimer')); del.appendChild(mkIcon('trash-2', 13));
      up.disabled = i === 0; dn.disabled = i === items.length - 1;
      up.addEventListener('click', (e) => { e.stopPropagation(); [items[i - 1], items[i]] = [items[i], items[i - 1]]; openIdx = i - 1; ctx.onChange(); draw(); });
      dn.addEventListener('click', (e) => { e.stopPropagation(); [items[i + 1], items[i]] = [items[i], items[i + 1]]; openIdx = i + 1; ctx.onChange(); draw(); });
      del.addEventListener('click', (e) => { e.stopPropagation(); items.splice(i, 1); openIdx = Math.max(0, openIdx - 1); ctx.onChange(); draw(); });
      tools.appendChild(up); tools.appendChild(dn); tools.appendChild(del);
      head.appendChild(tools);
      card.appendChild(head);

      const body = mk('div', 'pbc-item-body');
      body.hidden = i !== openIdx;
      const drawBody = () => {
        body.textContent = '';
        renderFields(body, item, (f.item || []).map((sf) => {
          const c = Object.assign({}, sf);
          if (typeof sf.dis === 'function' && sf.dis(item)) c.disabled = true;
          return c;
        }), Object.assign({}, ctx, { refresh: drawBody }));
      };
      drawBody();
      head.addEventListener('click', () => { openIdx = (openIdx === i ? -1 : i); draw(); });
      card.appendChild(body);
      box.appendChild(card);
    });

    const add = mkBtn('pbc-addstop');
    add.textContent = '＋ ' + (f.addLabel || t('pages.pc.addItem', 'Ajouter un élément'));
    if (f.max && items.length >= f.max) add.disabled = true;
    add.addEventListener('click', () => {
      items.push(f.mk ? f.mk() : {});
      openIdx = items.length - 1;
      ctx.onChange();
      draw();
    });
    box.appendChild(add);
    refreshIcons(box);
  };
  draw();
  return w;
}

// ══════════════════════════════════════════════════════════════════
// Entry point
// ══════════════════════════════════════════════════════════════════
export function renderFields(host, obj, fields, ctx) {
  (fields || []).forEach((f) => {
    if (typeof f.showIf === 'function' && !f.showIf(obj)) return;
    let node = null;
    switch (f.t) {
      case 'ltext': node = ctlLText(obj, f, ctx, false); break;
      case 'ltextarea': node = ctlLText(obj, f, ctx, true); break;
      case 'select': node = ctlSelect(obj, f, ctx); break;
      case 'check': node = ctlCheck(obj, f, ctx); break;
      case 'seg': node = ctlSeg(obj, f, ctx); break;
      case 'slider': node = ctlSlider(obj, f, ctx); break;
      case 'color': node = ctlColor(obj, f, ctx); break;
      case 'icon': node = ctlIcon(obj, f, ctx); break;
      case 'items': node = ctlItems(obj, f, ctx); break;
      case 'spacing': node = ctlSpacing(obj, f, ctx); break;
      case 'shadow': node = ctlShadow(obj, f, ctx); break;
      case 'number': node = ctlSlider(obj, Object.assign({ min: 0, max: 500 }, f), ctx); break;
      default: node = ctlText(obj, f, ctx);
    }
    if (node) {
      if (f.disabled) node.querySelectorAll('input,select,textarea,button').forEach((x) => (x.disabled = true));
      host.appendChild(node);
    }
  });
  refreshIcons(host);
}

// ── Grouped-fields accordion (Elementor-style settings panel) ─────
// groups: [{ title, icon, fields, open? }]. Open/closed state per group
// persists across re-renders (widget re-selection, tab switch) for the
// session, keyed by `${ctx.groupKey}|${title}` so different widgets/tabs
// don't fight over the same key.
const _groupOpenState = new Map();
export function renderGroups(host, obj, groups, ctx) {
  (groups || []).forEach((g) => {
    const key = (ctx && ctx.groupKey ? ctx.groupKey : '') + '|' + g.title;
    const det = document.createElement('details');
    det.className = 'pbc-group';
    const remembered = _groupOpenState.get(key);
    det.open = remembered != null ? remembered : (groups.length === 1 || !!g.open);
    const sum = mk('summary');
    if (g.icon) sum.appendChild(mkIcon(g.icon, 14));
    sum.appendChild(mk('span', null, g.title));
    const caret = mk('span', 'pbc-group-caret');
    caret.appendChild(mkIcon('chevron-down', 14));
    sum.appendChild(caret);
    det.appendChild(sum);
    const body = mk('div', 'pbc-group-body');
    det.appendChild(body);
    const redraw = () => {
      body.textContent = '';
      renderFields(body, obj, g.fields, Object.assign({}, ctx, { refresh: redraw }));
    };
    redraw();
    det.addEventListener('toggle', () => { _groupOpenState.set(key, det.open); });
    host.appendChild(det);
  });
  refreshIcons(host);
}
