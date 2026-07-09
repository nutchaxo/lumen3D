/* ============================================================
   Lumen3D — Instance Configuration (white-label)
   ============================================================
   Single source of truth for the DEPLOYMENT-specific "study content"
   that the generic engine must never hardcode: brand identity, the
   specimen vocabulary, SEO/head text, footer, and navigation.

   Loaded EARLY (before I18n.init and before any page render) as a
   classic-script IIFE singleton — referenced by the bare name
   `InstanceConfig`, never window.InstanceConfig (see CLAUDE.md §8).

   Two consumption channels:
     • i18n token substitution — I18n.t() interpolates {brand},
       {specimen}, {specimenPlural}, … from InstanceConfig.tokens()
       so locale strings stay generic (no "embryo"/"IRIBHM" baked in).
     • DOM binding — [data-instance="path"] (textContent) and
       [data-instance-attr="attr:path; …"] (attributes), applied by
       applyDom(); the head <title>/<meta> by applyHead(). These are
       the client twin of the server-side {{SITE:path}} injection in
       dev_server.py:_serve_html / api/_html_server.php, so PHP / Python
       hosts get flash-free, SEO-correct heads and static hosts still
       resolve everything client-side.

   The config file (config/instance.json) is PUBLIC (served like
   lang/*.json). Secrets never live here — they stay under api/.
   ============================================================ */

const InstanceConfig = (() => {
  'use strict';

  // Crash-proof floor: a fully neutral, domain-agnostic default. If the
  // fetch fails (offline, fresh install before the wizard) the platform
  // still renders with generic vocabulary instead of a broken page.
  const DEFAULT = {
    brand: {
      name: 'Lumen3D', shortName: 'Lumen3D', productName: 'Lumen3D',
      monogram: 'L3', logoEmoji: '🔬', tagline: '3D Imaging Data Viewer',
      organization: ''
    },
    specimen: { singular: 'sample', plural: 'samples' },
    org: { name: '', url: '' },
    seo: {
      description: 'Browser-based viewer for large 3D imaging volumes.',
      keywords: '3D viewer, volume rendering, imaging'
    },
    pageTitles: {
      home: 'Lumen3D — 3D Imaging Data Viewer',
      explorer: 'Data Explorer — Lumen3D', viewer: 'Viewer — Lumen3D',
      compare: 'Compare — Lumen3D', tracking: 'Tracking — Lumen3D',
      about: 'About — Lumen3D', admin: 'Admin — Lumen3D', legal: 'Legal — Lumen3D'
    },
    footer: { copyright: '© Lumen3D', links: [] },
    nav: {
      showExplorer: true, showCompare: true, showTracking: true,
      showAbout: true, showLegal: false, customPages: []
    }
  };

  let _config = _clone(DEFAULT);
  let _loaded = false;
  const _listeners = [];

  function _clone(o) { return JSON.parse(JSON.stringify(o)); }

  // Deep-merge src over dst: plain objects merge recursively; arrays and
  // primitives replace wholesale (so an operator can clear footer.links to []).
  function _merge(dst, src) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) return src;
    const out = (dst && typeof dst === 'object' && !Array.isArray(dst)) ? dst : {};
    for (const k of Object.keys(src)) {
      const sv = src[k];
      out[k] = (sv && typeof sv === 'object' && !Array.isArray(sv))
        ? _merge(out[k], sv) : sv;
    }
    return out;
  }

  /** Resolve a dot-path (e.g. 'footer.links.0.url') against the config. */
  function get(path, dflt) {
    if (!path) return dflt;
    let v = _config;
    for (const seg of String(path).split('.')) {
      if (v != null && typeof v === 'object' && seg in v) v = v[seg];
      else return dflt;
    }
    return v === undefined ? dflt : v;
  }

  function all() { return _config; }
  function isLoaded() { return _loaded; }

  /**
   * Fetch config/instance.json and merge it over the neutral default.
   * Tolerant: any failure keeps the embedded default (fail-soft, never throws).
   * @returns {Promise<object>}
   */
  async function load() {
    try {
      const resp = await fetch('./config/instance.json', { cache: 'no-store' });
      if (resp.ok) {
        const data = await resp.json();
        if (data && typeof data === 'object') _config = _merge(_clone(DEFAULT), data);
      }
    } catch (_) { /* keep default */ }
    _loaded = true;
    _notify();
    return _config;
  }

  function _cap(s) { s = String(s || ''); return s ? s[0].toUpperCase() + s.slice(1) : s; }

  function _curLocale() {
    try {
      if (typeof I18n !== 'undefined' && I18n.getLanguage) return I18n.getLanguage();
    } catch (_) { /* fall through */ }
    return 'en';
  }

  // A localizable value: either a flat string (same in every language) or a
  // per-locale object like { en:"embryo", fr:"embryon" }. Resolves current
  // locale → 'en' → first available. Lets the specimen noun be grammatically
  // correct per language while a single-language deployment can stay a string.
  function _localized(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const loc = _curLocale();
      return v[loc] || v.en || Object.values(v)[0] || '';
    }
    return String(v);
  }

  /**
   * Token map injected into every I18n.t() resolution so locale strings can
   * reference {brand}, {specimen}, … instead of baking a domain noun in.
   */
  function tokens() {
    const b = _config.brand || {};
    const sp = _config.specimen || {};
    const org = _config.org || {};
    const sing = _localized(sp.singular);
    const plur = _localized(sp.plural);
    return {
      brand: _localized(b.name) || '',
      brandShort: _localized(b.shortName) || _localized(b.name) || '',
      product: _localized(b.productName) || _localized(b.name) || '',
      tagline: _localized(b.tagline) || '',
      org: _localized(org.name) || _localized(b.organization) || '',
      orgShort: _localized(b.organization) || _localized(org.name) || '',
      specimen: sing,
      specimenPlural: plur,
      Specimen: _cap(sing),
      SpecimenPlural: _cap(plur)
    };
  }

  // ─── DOM application ──────────────────────────────────────

  /**
   * Fill [data-instance] (textContent) and [data-instance-attr] (attributes)
   * from the config. Safe to call repeatedly (e.g. after a language switch,
   * or after the config reloads in the admin preview iframe).
   * @param {ParentNode} [root=document]
   */
  function applyDom(root) {
    root = root || document;
    root.querySelectorAll('[data-instance]').forEach(el => {
      const v = get(el.getAttribute('data-instance'));
      if (typeof v === 'string') el.textContent = v;
    });
    // "attr:path; attr2:path2" — set each attribute to the resolved value.
    root.querySelectorAll('[data-instance-attr]').forEach(el => {
      const spec = el.getAttribute('data-instance-attr') || '';
      spec.split(';').forEach(pair => {
        const idx = pair.indexOf(':');
        if (idx < 0) return;
        const attr = pair.slice(0, idx).trim();
        const path = pair.slice(idx + 1).trim();
        if (!attr) return;
        const v = get(path);
        if (typeof v === 'string') el.setAttribute(attr, v);
      });
    });
    try { applyNav(root); } catch (_) {}
  }

  /**
   * Make the public navbar config-driven: toggle the standard links by the
   * nav.showX flags, inject operator-created custom pages, and a Legal link.
   * Idempotent — re-injected links are tagged and cleared before re-appending
   * (applyDom may run again after a language switch).
   */
  function applyNav(root) {
    root = root || document;
    const nav = _config.nav || {};
    const stdMap = {
      'explorer.html': nav.showExplorer,
      'compare.html': nav.showCompare,
      'tracking.html': nav.showTracking,
      'about.html': nav.showAbout
    };
    root.querySelectorAll('.navbar-links').forEach(container => {
      container.querySelectorAll('a.navbar-link').forEach(a => {
        if (a.hasAttribute('data-instance-navlink')) return;
        const href = (a.getAttribute('href') || '').split('?')[0].split('#')[0];
        if (href in stdMap) a.style.display = (stdMap[href] === false) ? 'none' : '';
      });
      container.querySelectorAll('[data-instance-navlink]').forEach(e => e.remove());
      const pages = Array.isArray(nav.customPages) ? nav.customPages : [];
      pages.forEach(pg => {
        if (!pg || pg.show === false || !pg.slug) return;
        const a = document.createElement('a');
        a.className = 'navbar-link';
        a.setAttribute('data-instance-navlink', '');
        a.href = 'page.html?slug=' + encodeURIComponent(pg.slug);
        a.textContent = _localized(pg.label) || pg.slug;
        container.appendChild(a);
      });
    });

    // Legal notices live in the FOOTER (not the header nav). Inject / remove a
    // Legal link in every .footer-links when nav.showLegal is on. Idempotent
    // (tagged links are cleared and re-appended, e.g. after a language switch).
    let legalLabel = 'Legal';
    try { if (typeof I18n !== 'undefined' && I18n.t) { const v = I18n.t('legal.pageTitle'); if (v && v !== 'legal.pageTitle') legalLabel = v; } } catch (_) {}
    root.querySelectorAll('.footer-links').forEach(fl => {
      fl.querySelectorAll('[data-instance-legal]').forEach(e => e.remove());
      if (nav.showLegal) {
        const a = document.createElement('a');
        a.setAttribute('data-instance-legal', '');
        a.href = 'legal.html';
        a.textContent = legalLabel;
        fl.appendChild(a);
      }
    });
  }

  /**
   * Set document.title + <meta name=description|keywords> from the config.
   * The page key comes from <body data-page="…"> (falls back to 'home').
   * This is the client twin of the server-side {{SITE:…}} head injection —
   * it keeps static hosts correct and never diverges (same source of truth).
   */
  function applyHead() {
    const key = (document.body && document.body.dataset && document.body.dataset.page) || 'home';
    const title = get('pageTitles.' + key);
    if (typeof title === 'string' && title) document.title = title;
    _setMeta('description', get('seo.description'));
    _setMeta('keywords', get('seo.keywords'));
  }

  function _setMeta(name, value) {
    if (typeof value !== 'string') return;
    let el = document.head && document.head.querySelector(`meta[name="${name}"]`);
    if (!el && document.head) {
      el = document.createElement('meta');
      el.setAttribute('name', name);
      document.head.appendChild(el);
    }
    if (el) el.setAttribute('content', value);
  }

  /** Convenience: load() then apply head + DOM. Use in a page controller. */
  async function boot() {
    await load();
    try { applyHead(); } catch (_) {}
    try { applyDom(document); } catch (_) {}
    return _config;
  }

  function onChange(fn) { if (typeof fn === 'function') _listeners.push(fn); }
  function _notify() {
    _listeners.forEach(fn => { try { fn(_config); } catch (_) {} });
  }

  return { load, boot, get, all, tokens, applyDom, applyHead, applyNav, onChange, isLoaded };
})();
