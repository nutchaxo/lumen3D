/* ============================================================
   Lumen3D — Page variables ({variable} tokens)  [white-label]
   ============================================================
   Public resolution of {name} tokens used in page-builder text.
   Two kinds:
     • DYNAMIC builtins — computed at CALL TIME (year / date / time
       and live catalog counts), locale-aware via I18n.getLanguage().
     • FIXED custom variables — operator-authored, stored in
       config/instance.json under `variables` (read via InstanceConfig).
       Each value is a plain string OR a per-locale object {en,fr,…}.

   Brand / specimen tokens are intentionally NOT here:
   InstanceConfig.tokens() already supplies {brand}/{specimen}/… and
   the page renderer merges both maps (custom vars win on collision).

   Classic-script IIFE singleton — referenced by the bare name
   `PageVars`, never window.PageVars (see CLAUDE.md §8). All globals it
   consults (I18n, Catalog, InstanceConfig) are typeof-guarded so the
   module never throws before they exist.
   ============================================================ */

const PageVars = (() => {
  'use strict';

  function _locale() {
    try {
      if (typeof I18n !== 'undefined' && I18n.getLanguage) return I18n.getLanguage() || 'en';
    } catch (_) { /* fall through */ }
    return 'en';
  }

  // Live catalog counts — fail-soft to '0' before the catalog has loaded.
  function _stats() {
    try {
      if (typeof Catalog !== 'undefined' && Catalog.getStats) return Catalog.getStats() || {};
    } catch (_) { /* fall through */ }
    return {};
  }
  function _count(key) {
    const v = _stats()[key];
    return (v == null || isNaN(+v)) ? '0' : String(v);
  }

  // DYNAMIC builtins — each `get()` computes its current value on demand.
  // `desc` is a short French label for the admin listing UI.
  const BUILTINS = [
    { name: 'year', desc: 'Année en cours', get: () => String(new Date().getFullYear()) },
    {
      name: 'date', desc: 'Date du jour (format long)',
      get: () => {
        try { return new Date().toLocaleDateString(_locale(), { year: 'numeric', month: 'long', day: 'numeric' }); }
        catch (_) { return new Date().toDateString(); }
      }
    },
    {
      name: 'time', desc: 'Heure actuelle (HH:MM)',
      get: () => {
        try { return new Date().toLocaleTimeString(_locale(), { hour: '2-digit', minute: '2-digit' }); }
        catch (_) { return ''; }
      }
    },
    { name: 'datasetCount', desc: 'Nombre de jeux de données', get: () => _count('totalDatasets') },
    { name: 'specimenCount', desc: 'Nombre de spécimens', get: () => _count('totalEmbryos') },
    { name: 'cellCount', desc: 'Nombre de cellules suivies', get: () => _count('totalCells') },
    { name: 'regionCount', desc: 'Nombre de régions', get: () => _count('totalRegions') },
  ];

  // A custom-var value: plain string (same in every language) or a
  // per-locale object {en,fr,…}. Resolve current locale → 'en' → first.
  function _localized(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const loc = _locale();
      return v[loc] || v.en || Object.values(v)[0] || '';
    }
    return String(v);
  }

  function _customs() {
    try {
      if (typeof InstanceConfig !== 'undefined' && InstanceConfig.get) {
        const c = InstanceConfig.get('variables', {});
        if (c && typeof c === 'object' && !Array.isArray(c)) return c;
      }
    } catch (_) { /* fall through */ }
    return {};
  }

  /**
   * Flat {name: stringValue} map. Dynamic builtins first, operator
   * customs merged over them (later wins — a custom var may deliberately
   * override a builtin name).
   * @returns {Object<string,string>}
   */
  function tokens() {
    const out = {};
    for (const b of BUILTINS) out[b.name] = b.get();
    const cust = _customs();
    for (const k of Object.keys(cust)) out[k] = _localized(cust[k]);
    return out;
  }

  /**
   * Descriptor list for the admin UI.
   * @returns {Array<{name:string, kind:'dynamic'|'fixed', value:string, desc:string}>}
   */
  function list() {
    const rows = BUILTINS.map((b) => ({ name: b.name, kind: 'dynamic', value: b.get(), desc: b.desc }));
    const cust = _customs();
    for (const k of Object.keys(cust)) rows.push({ name: k, kind: 'fixed', value: _localized(cust[k]), desc: '' });
    return rows;
  }

  // {name} where name is [A-Za-z][A-Za-z0-9_]* — unknown names left as-is.
  const TOKEN_RE = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

  /**
   * Replace every {name} occurrence in `str` from tokens(); names that
   * have no matching variable are left untouched (verbatim {name}).
   * @param {string} str
   * @returns {string}
   */
  function resolve(str) {
    if (str == null) return '';
    const s = String(str);
    if (s.indexOf('{') < 0) return s;
    const map = tokens();
    return s.replace(TOKEN_RE, (m, name) =>
      Object.prototype.hasOwnProperty.call(map, name) ? map[name] : m);
  }

  return { tokens, list, resolve };
})();
