/* ============================================================
   IRIBHM Microscopy Platform — Internationalization (i18n)
   ============================================================
   Loads translation JSON files and provides t('key.path')
   lookup. Supports dynamic language switching.

   Two translation scopes share ONE per-language tree:
     • Platform strings      → lang/<code>.json            (top-level keys)
     • Plugin strings         → js/modules/.../<id>/lang/<code>.json
                                merged under  plugins.<id>.<key>

   Because plugin dictionaries live in the same per-language object as
   the platform ones, every existing mechanism (t(), data-i18n*,
   _applyTranslations, the English fallback in t()) works on plugin keys
   with zero special-casing. In particular the per-plugin "missing
   locale → English" rule is automatic: if a plugin ships en+fr but the
   UI is in 'es', _loaded.es.plugins[id] is undefined, so t() falls
   through to _loaded.en.plugins[id] — exactly the desired behaviour.

   The set of *selectable* languages is driven by what the PLATFORM
   ships (lang/*.json), discovered at runtime. A plugin that ships a
   locale the platform lacks simply never gets that locale loaded (it is
   not offered), and a platform locale a plugin lacks falls back to the
   plugin's English — see loadPluginLang / _ensurePluginLang.
   ============================================================ */

const I18n = (() => {
  let _translations = {};
  let _currentLang = 'en';
  let _fallbackLang = 'en';
  let _loaded = {};
  const _listeners = [];

  // Registered plugins awaiting their per-language dictionaries.
  //   id → { path: 'js/modules/<placement>/<id>', langs: string[]|null }
  // `langs` is the explicit list of shipped locales (plugin.json
  // `i18nLanguages`); null means "unknown" → we probe en + current lang
  // tolerantly (a 404 is swallowed, so drop-in authoring still works).
  const _plugins = {};

  // Display metadata for known locales. Adding lang/<code>.json for any
  // code listed here makes it appear in the switcher fully labelled. An
  // unknown code still works (it falls back to an uppercased code + a
  // neutral flag), this table only controls how nicely it is shown.
  const LANG_META = {
    en: { native: 'English',    english: 'English',    flag: '🇬🇧' },
    fr: { native: 'Français',   english: 'French',     flag: '🇫🇷' },
    es: { native: 'Español',    english: 'Spanish',    flag: '🇪🇸' },
    zh: { native: '中文',        english: 'Chinese',    flag: '🇨🇳' },
    de: { native: 'Deutsch',    english: 'German',     flag: '🇩🇪' },
    it: { native: 'Italiano',   english: 'Italian',    flag: '🇮🇹' },
    pt: { native: 'Português',  english: 'Portuguese', flag: '🇵🇹' },
    nl: { native: 'Nederlands', english: 'Dutch',      flag: '🇳🇱' },
    ja: { native: '日本語',      english: 'Japanese',   flag: '🇯🇵' },
    ko: { native: '한국어',      english: 'Korean',     flag: '🇰🇷' },
    ru: { native: 'Русский',    english: 'Russian',    flag: '🇷🇺' },
    ar: { native: 'العربية',     english: 'Arabic',     flag: '🇸🇦', rtl: true },
  };

  // Crash-proof floor: the locales that ship in-repo today. Discovery
  // (endpoint → lang/manifest.json) overrides this when available, so
  // dropping a new lang/<code>.json is picked up without code edits.
  const DEFAULT_LANGS = ['en', 'fr', 'es'];
  let _available = DEFAULT_LANGS.slice();

  /**
   * Load a platform language file (idempotent / cached).
   * @param {string} lang - Language code (e.g. 'en', 'fr')
   * @returns {Promise<object|null>} The translations object, or null on failure
   */
  async function loadLanguage(lang) {
    if (_loaded[lang]) return _loaded[lang];
    try {
      const basePath = _getBasePath();
      const resp = await fetch(`${basePath}lang/${lang}.json`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      // Preserve any plugin dictionaries already registered for this lang
      // before the platform file arrived (registration order is not
      // guaranteed relative to setLanguage).
      const existingPlugins = _loaded[lang] && _loaded[lang].plugins;
      if (existingPlugins) data.plugins = Object.assign(data.plugins || {}, existingPlugins);
      _loaded[lang] = data;
      return data;
    } catch (err) {
      console.warn(`[i18n] Failed to load language "${lang}":`, err);
      return null;
    }
  }

  /**
   * Determine base path relative to current HTML file. Every entry page
   * lives at the repo root, so a relative './' resolves both lang/ and
   * js/modules/ correctly (including inside the compare iframes).
   */
  function _getBasePath() {
    return './';
  }

  // ─── Language discovery ───────────────────────────────────

  /**
   * Normalize one discovery payload to an array of language codes.
   * Accepts ["en","fr"], {languages:[…]}, or [{code:"en"}, …].
   */
  function _normalizeLangList(data) {
    const arr = Array.isArray(data) ? data : data?.languages;
    if (!Array.isArray(arr)) return null;
    const codes = arr
      .map(x => (typeof x === 'string' ? x : x?.code))
      .filter(c => typeof c === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(c));
    return codes.length ? codes : null;
  }

  /**
   * Resolve the platform's available locales with the same hybrid
   * strategy the plugin registry uses for folder discovery:
   *   1. live endpoint   (dev_server.py /api/languages)
   *   2. static manifest (lang/manifest.json — static/PHP hosts)
   *   3. embedded default (DEFAULT_LANGS — crash-proof floor)
   * 'en' is always guaranteed present (it is the fallback locale).
   * @returns {Promise<string[]>}
   */
  async function discoverLanguages() {
    const basePath = _getBasePath();
    const candidates = ['api/languages', 'api/languages.php', `${basePath}lang/manifest.json`];
    for (const url of candidates) {
      try {
        const resp = await fetch(url, { cache: 'no-store' });
        if (!resp.ok) continue;
        const codes = _normalizeLangList(await resp.json());
        if (codes) {
          if (!codes.includes(_fallbackLang)) codes.unshift(_fallbackLang);
          _available = codes;
          return _available;
        }
      } catch (_) { /* fall through */ }
    }
    _available = DEFAULT_LANGS.slice();
    return _available;
  }

  /**
   * Display descriptor for one locale code.
   * @returns {{code,native,english,flag,rtl}}
   */
  function getLanguageMeta(code) {
    const m = LANG_META[code];
    return {
      code,
      native: m?.native || code.toUpperCase(),
      english: m?.english || code.toUpperCase(),
      flag: m?.flag || '🏳️',
      rtl: !!m?.rtl,
    };
  }

  /**
   * The languages a switcher should offer — exactly the platform's
   * discovered locales (a plugin-only locale is intentionally excluded).
   * @returns {Array<{code,native,english,flag,rtl}>}
   */
  function getAvailableLanguages() {
    return _available.map(getLanguageMeta);
  }

  function isAvailable(code) {
    return _available.includes(code);
  }

  // ─── Plugin translation loading ───────────────────────────

  /**
   * Register a plugin and load its dictionaries for the fallback locale
   * (English, always) plus the active locale. Safe to call repeatedly.
   * @param {string} id          plugin id (matches plugin.json id)
   * @param {string} path        'js/modules/<placement>/<id>'
   * @param {string[]} [langs]   shipped locales (plugin.json i18nLanguages)
   */
  async function loadPluginLang(id, path, langs) {
    if (!id || !path) return;
    _plugins[id] = { path, langs: Array.isArray(langs) ? langs.slice() : null };
    await _ensurePluginLang(id, _fallbackLang);
    if (_currentLang !== _fallbackLang) await _ensurePluginLang(id, _currentLang);
  }

  /**
   * Fetch (once) one plugin's dictionary for one locale and graft it into
   * _loaded[lang].plugins[id]. No-ops when the plugin does not ship that
   * locale (declared list) — the English fallback in t() then covers it.
   */
  async function _ensurePluginLang(id, lang) {
    const entry = _plugins[id];
    if (!entry) return;
    // Declared list known and excludes this locale → skip the fetch
    // entirely (avoids 404 noise); t() will fall back to English.
    if (entry.langs && !entry.langs.includes(lang)) return;
    if (_loaded[lang]?.plugins?.[id]) return; // already loaded
    try {
      const resp = await fetch(`${entry.path}/lang/${lang}.json`, { cache: 'no-store' });
      if (!resp.ok) return;
      const data = await resp.json();
      _loaded[lang] = _loaded[lang] || {};
      _loaded[lang].plugins = _loaded[lang].plugins || {};
      _loaded[lang].plugins[id] = data;
      if (lang === _currentLang) _translations = _loaded[_currentLang] || _translations;
    } catch (_) { /* tolerated: plugin simply stays English here */ }
  }

  // ─── Init / switch ────────────────────────────────────────

  /**
   * Initialize i18n with saved preference or browser language.
   * @returns {Promise<void>}
   */
  async function init() {
    await discoverLanguages();

    const saved = localStorage.getItem('iribhm-lang');
    const browserLang = (navigator.language || 'en').split('-')[0];
    let lang = _fallbackLang;
    if (saved && isAvailable(saved)) lang = saved;
    else if (isAvailable(browserLang)) lang = browserLang;

    // Load fallback first, then target
    await loadLanguage(_fallbackLang);
    if (lang !== _fallbackLang) await loadLanguage(lang);

    // A saved/target locale whose file failed to load must not strand the
    // UI on a half-applied language — fall back cleanly.
    if (!_loaded[lang]) lang = _fallbackLang;

    _currentLang = lang;
    _translations = _loaded[lang] || _loaded[_fallbackLang] || {};
    _applyDocumentLang();
    _applyTranslations();
  }

  /**
   * Switch language. Loads the platform file AND every registered
   * plugin's dictionary for the new locale before applying.
   * @param {string} lang - Language code
   * @returns {Promise<void>}
   */
  async function setLanguage(lang) {
    if (lang === _currentLang) return;
    if (!isAvailable(lang)) {
      console.warn(`[i18n] setLanguage("${lang}") ignored — not an available platform locale.`);
      return;
    }
    await loadLanguage(lang);
    if (!_loaded[lang]) return; // load failed → keep current language

    await Promise.all(Object.keys(_plugins).map(id => _ensurePluginLang(id, lang)));

    _currentLang = lang;
    _translations = _loaded[lang] || _loaded[_fallbackLang] || {};
    localStorage.setItem('iribhm-lang', lang);
    _applyDocumentLang();
    _applyTranslations();
    _notify();
  }

  function _applyDocumentLang() {
    document.documentElement.setAttribute('lang', _currentLang);
    document.documentElement.setAttribute('dir', getLanguageMeta(_currentLang).rtl ? 'rtl' : 'ltr');
  }

  /**
   * Get current language
   * @returns {string}
   */
  function getLanguage() {
    return _currentLang;
  }

  // ─── Lookup ───────────────────────────────────────────────

  /**
   * Translate a key path (e.g. 'nav.home', or 'plugins.measure-distance.noMeasure').
   * Falls back to English, then to the key itself.
   * @param {string} key - Dot-separated key path
   * @param {object} [params] - Replacement parameters {count: 5}
   * @returns {string}
   */
  function t(key, params) {
    let value = _resolve(key, _translations);
    if (value === undefined && _loaded[_fallbackLang]) {
      value = _resolve(key, _loaded[_fallbackLang]);
    }
    if (value === undefined) return key;
    // BUG-016: a non-leaf key (e.g. t('nav') where 'nav' is a sub-object) resolves
    // to an object/array; the .replace() below would throw. Treat a non-string
    // resolution like an unresolved key and return the key itself.
    if (typeof value !== 'string') return key;

    // Replace {param} placeholders
    if (params) {
      Object.keys(params).forEach(p => {
        value = value.replace(new RegExp(`\\{${p}\\}`, 'g'), params[p]);
      });
    }
    return value;
  }

  /**
   * Plugin-scoped lookup: resolve a plugin-local key under plugins.<id>.
   * @param {string} id   plugin id
   * @param {string} key  plugin-local key path
   * @param {object} [params]
   * @returns {string}
   */
  function tp(id, key, params) {
    return t(`plugins.${id}.${key}`, params);
  }

  /**
   * Scoped i18n façade handed to a plugin via ctx.i18n. `t` auto-namespaces
   * to the plugin id, so plugin code calls ctx.i18n.t('noMeasure').
   * @param {string} id  plugin id
   */
  function forPlugin(id) {
    return {
      t: (key, params) => tp(id, key, params),
      getLanguage,
      onLanguageChange,
    };
  }

  /**
   * Resolve a dot-separated path in an object
   */
  function _resolve(key, obj) {
    return key.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
  }

  // ─── DOM application ──────────────────────────────────────

  /**
   * Apply translations to all elements with data-i18n attribute
   */
  function _applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const translated = t(key);
      if (translated !== key) {
        el.textContent = translated;
      }
    });

    // Handle placeholders
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      const translated = t(key);
      if (translated !== key) {
        el.setAttribute('placeholder', translated);
      }
    });

    // Handle titles/tooltips
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      const translated = t(key);
      if (translated !== key) {
        el.setAttribute('title', translated);
      }
    });

    // Handle aria-labels
    document.querySelectorAll('[data-i18n-aria]').forEach(el => {
      const key = el.getAttribute('data-i18n-aria');
      const translated = t(key);
      if (translated !== key) {
        el.setAttribute('aria-label', translated);
      }
    });

    // Handle innerHTML targets (text containing markup, used sparingly)
    document.querySelectorAll('[data-i18n-html]').forEach(el => {
      const key = el.getAttribute('data-i18n-html');
      const translated = t(key);
      if (translated !== key) {
        el.innerHTML = translated;
      }
    });
  }

  /**
   * Register a listener for language changes
   * @param {function} fn - Callback receiving (lang)
   */
  function onLanguageChange(fn) {
    _listeners.push(fn);
  }

  function _notify() {
    _listeners.forEach(fn => {
      try { fn(_currentLang); } catch (err) { console.warn('[i18n] listener error:', err); }
    });
  }

  return {
    init,
    t,
    tp,
    forPlugin,
    setLanguage,
    getLanguage,
    onLanguageChange,
    loadLanguage,
    loadPluginLang,
    discoverLanguages,
    getAvailableLanguages,
    getLanguageMeta,
    isAvailable,
    translateDOM: _applyTranslations,
  };
})();
