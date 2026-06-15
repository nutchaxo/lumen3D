/* ============================================================
   IRIBHM Microscopy Platform — Internationalization (i18n)
   ============================================================
   Loads translation JSON files and provides t('key.path')
   lookup. Supports dynamic language switching.
   ============================================================ */

const I18n = (() => {
  let _translations = {};
  let _currentLang = 'en';
  let _fallbackLang = 'en';
  let _loaded = {};
  const _listeners = [];

  /**
   * Load a language file
   * @param {string} lang - Language code (e.g. 'en', 'fr')
   * @returns {Promise<object>} The translations object
   */
  async function loadLanguage(lang) {
    if (_loaded[lang]) return _loaded[lang];
    try {
      const basePath = _getBasePath();
      const resp = await fetch(`${basePath}lang/${lang}.json`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      _loaded[lang] = data;
      return data;
    } catch (err) {
      console.warn(`[i18n] Failed to load language "${lang}":`, err);
      return null;
    }
  }

  /**
   * Determine base path relative to current HTML file
   */
  function _getBasePath() {
    const path = window.location.pathname;
    const depth = (path.match(/\//g) || []).length - 1;
    if (path.endsWith('/') || path.endsWith('index.html')) return './';
    return './';
  }

  /**
   * Initialize i18n with saved preference or browser language
   * @returns {Promise<void>}
   */
  async function init() {
    // Check saved preference
    const saved = localStorage.getItem('iribhm-lang');
    const browserLang = navigator.language.split('-')[0];
    const lang = saved || (['fr', 'en'].includes(browserLang) ? browserLang : 'en');

    // Load fallback first, then target
    await loadLanguage(_fallbackLang);
    if (lang !== _fallbackLang) {
      await loadLanguage(lang);
    }
    _currentLang = lang;
    _translations = _loaded[lang] || _loaded[_fallbackLang] || {};

    document.documentElement.setAttribute('lang', lang);
    _applyTranslations();
  }

  /**
   * Switch language
   * @param {string} lang - Language code
   * @returns {Promise<void>}
   */
  async function setLanguage(lang) {
    if (lang === _currentLang) return;
    await loadLanguage(lang);
    _currentLang = lang;
    _translations = _loaded[lang] || _loaded[_fallbackLang] || {};
    localStorage.setItem('iribhm-lang', lang);
    document.documentElement.setAttribute('lang', lang);
    _applyTranslations();
    _notify();
  }

  /**
   * Get current language
   * @returns {string}
   */
  function getLanguage() {
    return _currentLang;
  }

  /**
   * Translate a key path (e.g. 'nav.home')
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

    // Replace {param} placeholders
    if (params) {
      Object.keys(params).forEach(p => {
        value = value.replace(new RegExp(`\\{${p}\\}`, 'g'), params[p]);
      });
    }
    return value;
  }

  /**
   * Resolve a dot-separated path in an object
   */
  function _resolve(key, obj) {
    return key.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
  }

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

    // Update language dropdowns active state
    document.querySelectorAll('.dropdown-item[onclick^="switchLanguage"]').forEach(el => {
      const langMatch = el.getAttribute('onclick').match(/'([^']+)'/);
      if (langMatch && langMatch[1] === _currentLang) {
        el.classList.add('active');
        el.style.background = 'var(--bg-surface-3)';
        el.style.fontWeight = 'bold';
      } else {
        el.classList.remove('active');
        el.style.background = '';
        el.style.fontWeight = 'normal';
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
    _listeners.forEach(fn => fn(_currentLang));
  }

  return {
    init,
    t,
    setLanguage,
    getLanguage,
    onLanguageChange,
    loadLanguage,
    translateDOM: _applyTranslations
  };
})();
