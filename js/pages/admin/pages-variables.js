/**
 * Admin SPA — Pages editor "Variables" panel
 * ============================================================================
 * The Variables tab of the page-builder sidebar. Surfaces every {name} token an
 * author can drop into page text and replaces them at render time via PageVars:
 *
 *   • Variables dynamiques ⚡ — read-only builtins (year/date/time + live catalog
 *     counts). Computed on the fly; listed from the global PageVars.
 *   • Variables de marque — brand/specimen tokens from InstanceConfig.tokens()
 *     (read-only here; edited in the Identity tab).
 *   • Variables fixes — operator-authored reusable strings, CRUD'd straight on
 *     instance.variables and persisted through ctx.saveInstance().
 *
 * Every row copies its {token} to the clipboard on click. All DOM is built with
 * createElement/textContent (never innerHTML) so operator data can't inject.
 *
 * PageVars / InstanceConfig are classic-script globals living in the global
 * LEXICAL scope (not on window); a free reference from this module resolves up
 * the scope chain (same mechanism shared.js uses for I18n/Utils) — typeof-guarded
 * so a missing global degrades instead of throwing.
 */

'use strict';

import { refreshIcons, toast } from './shared.js';

// Fallback builtin names if PageVars isn't loaded yet (integrator loads it in
// admpan.html). Keeps the dynamic group populated so the UI never looks broken.
const BUILTIN_FALLBACK = ['year', 'date', 'time', 'datasetCount', 'specimenCount', 'cellCount', 'regionCount'];

// Custom-variable name grammar: letter, then letters/digits/underscore (≤32).
const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;

// ── Small DOM builders ────────────────────────────────────────────
function mk(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function mkBtn(cls, title) { const b = mk('button', cls); b.type = 'button'; if (title) b.title = title; return b; }
function mkIcon(name, size) { const i = document.createElement('i'); i.setAttribute('data-lucide', name); if (size) i.style.cssText = `width:${size}px;height:${size}px`; return i; }

export function renderVariablesPanel(host, ctx) {
  const t = (ctx && typeof ctx.t === 'function') ? ctx.t : (k, d) => d;

  // Live instance.variables (create the map lazily so authoring first var works).
  function varsObj() {
    const inst = ctx.instance;
    if (!inst || typeof inst !== 'object') return {};
    if (!inst.variables || typeof inst.variables !== 'object' || Array.isArray(inst.variables)) inst.variables = {};
    return inst.variables;
  }

  // ── Source lists (typeof-guarded globals) ───────────────────────
  function dynamicRows() {
    try {
      if (typeof PageVars !== 'undefined' && PageVars.list) {
        return PageVars.list().filter((r) => r.kind === 'dynamic');
      }
    } catch (_) { /* fall through */ }
    return BUILTIN_FALLBACK.map((name) => ({ name, kind: 'dynamic', value: '', desc: '' }));
  }
  function brandRows() {
    try {
      if (typeof InstanceConfig !== 'undefined' && InstanceConfig.tokens) {
        const tk = InstanceConfig.tokens() || {};
        return Object.keys(tk).map((name) => ({ name, value: tk[name] }));
      }
    } catch (_) { /* fall through */ }
    return [];
  }
  // Names an author can't claim: dynamic builtins + brand tokens.
  function reservedNames() {
    const set = new Set();
    dynamicRows().forEach((r) => set.add(r.name));
    brandRows().forEach((r) => set.add(r.name));
    return set;
  }

  // ── Persistence ─────────────────────────────────────────────────
  let _saveTimer = null;
  async function saveNow() {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    let ok = false;
    try { ok = await ctx.saveInstance(); } catch (_) { ok = false; }
    if (!ok) toast(t('pages.vr.saveError', 'Échec de l’enregistrement.'), 'error');
    return ok;
  }
  function scheduleSave() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => { _saveTimer = null; saveNow(); }, 800);
  }

  // ── Clipboard ───────────────────────────────────────────────────
  function copyToken(name) {
    const token = '{' + name + '}';
    const done = () => toast(t('pages.vr.copied', 'Copié') + ' ' + token, 'success');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(token).then(done, () => {});
        return;
      }
    } catch (_) { /* fall through */ }
    done();
  }

  // ── Row / group builders ────────────────────────────────────────
  function codeChip(name) {
    const c = mk('code', null, '{' + name + '}');
    c.style.cssText = 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;padding:2px 7px;border-radius:6px;background:var(--adm-surface);border:1px solid var(--adm-border);color:var(--adm-text);white-space:nowrap;flex:0 0 auto;';
    return c;
  }
  function badge(text, icon) {
    const b = mk('span');
    b.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:999px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.03em;background:var(--adm-accent-subtle);color:var(--adm-accent);flex:0 0 auto;';
    if (icon) b.appendChild(mkIcon(icon, 11));
    b.appendChild(mk('span', null, text));
    return b;
  }
  function groupHead(title, emoji, badgeText) {
    const wrap = mk('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:7px;margin:16px 0 4px;';
    if (emoji) { const e = mk('span', null, emoji); e.style.fontSize = '13px'; wrap.appendChild(e); }
    const h = mk('span', 'adm-field-label', title);
    h.style.cssText = 'font-size:12px;font-weight:700;margin:0;';
    wrap.appendChild(h);
    if (badgeText) wrap.appendChild(badge(badgeText));
    return wrap;
  }
  function groupHint(text) {
    const p = mk('p', 'adm-page-sub', text);
    p.style.cssText = 'font-size:11px;margin:0 0 8px;';
    return p;
  }

  // Read-only row (dynamic + brand groups): chip + value preview + copy affordance.
  function readonlyRow(name, valuePreview, rowBadge) {
    const row = mk('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:7px 9px;margin-bottom:5px;border:1px solid var(--adm-border);border-radius:var(--adm-radius-sm);background:var(--adm-card);cursor:pointer;';
    row.title = '{' + name + '}';
    row.appendChild(codeChip(name));
    const val = mk('span', null, valuePreview || '');
    val.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--adm-text-sec);';
    row.appendChild(val);
    if (rowBadge) row.appendChild(badge(rowBadge));
    const cp = mkIcon('copy', 13);
    cp.style.cssText = 'width:13px;height:13px;flex:0 0 auto;color:var(--adm-text-sec);';
    row.appendChild(cp);
    row.addEventListener('click', () => copyToken(name));
    return row;
  }

  // Editable row (fixed group): chip (copy) + value input (debounced save) + delete.
  function editableRow(name) {
    const row = mk('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:5px;padding:6px 8px;border:1px solid var(--adm-border);border-radius:var(--adm-radius-sm);background:var(--adm-card);';
    const chip = codeChip(name);
    chip.style.cursor = 'pointer';
    chip.title = t('pages.vr.copied', 'Copié') + ' — {' + name + '}';
    chip.addEventListener('click', () => copyToken(name));
    row.appendChild(chip);

    const inp = mk('input', 'adm-field-input');
    inp.type = 'text';
    inp.spellcheck = false;
    inp.placeholder = t('pages.vr.value', 'Valeur');
    const cur = varsObj()[name];
    inp.value = typeof cur === 'string' ? cur : (cur != null ? String(cur) : '');
    inp.style.cssText = 'flex:1;min-width:0;';
    inp.addEventListener('input', () => { varsObj()[name] = inp.value; scheduleSave(); });
    // Blur (which fires before a tab close/navigation) flushes the pending
    // debounced save immediately, so an edit made within the 800 ms window
    // isn't silently dropped.
    inp.addEventListener('change', () => { varsObj()[name] = inp.value; saveNow(); });
    row.appendChild(inp);

    const del = mkBtn('pbc-mini pbc-mini--danger', t('pages.delete', 'Supprimer'));
    del.appendChild(mkIcon('trash-2', 13));
    del.addEventListener('click', () => { delete varsObj()[name]; saveNow(); build(); });
    row.appendChild(del);
    return row;
  }

  // Add-a-variable row.
  function addRow() {
    const row = mk('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:8px;';
    const nameInp = mk('input', 'adm-field-input');
    nameInp.type = 'text';
    nameInp.spellcheck = false;
    nameInp.maxLength = 32;
    nameInp.placeholder = t('pages.vr.name', 'nom');
    nameInp.style.cssText = 'flex:1;min-width:0;';
    const valInp = mk('input', 'adm-field-input');
    valInp.type = 'text';
    valInp.spellcheck = false;
    valInp.placeholder = t('pages.vr.value', 'Valeur');
    valInp.style.cssText = 'flex:1;min-width:0;';
    const add = mkBtn('pbc-mini', t('pages.vr.add', 'Ajouter'));
    add.appendChild(mkIcon('plus', 14));

    const submit = () => {
      const name = nameInp.value.trim();
      if (!NAME_RE.test(name)) {
        toast(t('pages.vr.badName', 'Nom invalide : commencez par une lettre, puis lettres, chiffres ou _ (max 32).'), 'error');
        return;
      }
      const vars = varsObj();
      if (Object.prototype.hasOwnProperty.call(vars, name) || reservedNames().has(name)) {
        toast(t('pages.vr.nameTaken', 'Ce nom est déjà utilisé.'), 'error');
        return;
      }
      vars[name] = valInp.value;
      saveNow();
      build();
    };
    add.addEventListener('click', submit);
    const onEnter = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
    nameInp.addEventListener('keydown', onEnter);
    valInp.addEventListener('keydown', onEnter);

    row.appendChild(nameInp);
    row.appendChild(valInp);
    row.appendChild(add);
    return row;
  }

  // ── Full (re)build ──────────────────────────────────────────────
  function build() {
    host.textContent = '';

    const title = mk('div', 'adm-field-label', t('pages.vr.title', 'Variables'));
    title.style.cssText = 'font-size:13px;font-weight:700;margin:0 0 4px;';
    host.appendChild(title);
    host.appendChild(groupHint(t('pages.vr.hint', 'Écrivez {nom} dans n’importe quel texte de page ; il sera remplacé automatiquement.')));

    // GROUP 1 — dynamic (read-only)
    host.appendChild(groupHead(t('pages.vr.dynamic', 'Variables dynamiques'), '⚡'));
    dynamicRows().forEach((r) => host.appendChild(readonlyRow(r.name, r.value, t('pages.vr.dynBadge', 'dynamique'))));

    // GROUP 2 — brand tokens (read-only, edited in Identity tab)
    const brand = brandRows();
    if (brand.length) {
      host.appendChild(groupHead(t('pages.vr.brand', 'Variables de marque'), null, t('pages.vr.fixBadge', 'fixe') + ' · ' + t('admin.navBranding', 'Identité')));
      host.appendChild(groupHint(t('pages.vr.brandHint', 'Ces variables proviennent de l’onglet Identité ; modifiez-les là-bas.')));
      brand.forEach((r) => host.appendChild(readonlyRow(r.name, r.value)));
    }

    // GROUP 3 — fixed custom variables (CRUD)
    host.appendChild(groupHead(t('pages.vr.fixed', 'Variables fixes'), null, t('pages.vr.fixBadge', 'fixe')));
    host.appendChild(groupHint(t('pages.vr.fixedHint', 'Vos propres variables réutilisables (valeur unique).')));
    const vars = varsObj();
    Object.keys(vars).forEach((name) => host.appendChild(editableRow(name)));
    host.appendChild(addRow());

    refreshIcons(host);
  }

  build();
}
