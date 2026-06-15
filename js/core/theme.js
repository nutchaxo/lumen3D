/* ============================================================
   IRIBHM Microscopy Platform — Theme Management
   ============================================================
   Dark/light theme toggle with localStorage persistence.
   ============================================================ */

const Theme = (() => {
  let _current = 'dark';
  const _listeners = [];

  /**
   * Initialize theme from saved preference or system preference
   */
  function init() {
    const saved = localStorage.getItem('iribhm-theme');
    if (saved) {
      _current = saved;
    } else {
      // Check system preference
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      _current = prefersDark ? 'dark' : 'dark'; // Default to dark for microscopy
    }
    _apply();

    // Listen for system theme changes
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
      if (!localStorage.getItem('iribhm-theme')) {
        _current = e.matches ? 'dark' : 'light';
        _apply();
        _notify();
      }
    });
  }

  /**
   * Toggle between dark and light
   */
  function toggle() {
    _current = _current === 'dark' ? 'light' : 'dark';
    localStorage.setItem('iribhm-theme', _current);
    _apply();
    _notify();
  }

  /**
   * Set a specific theme
   * @param {string} theme - 'dark' or 'light'
   */
  function set(theme) {
    if (theme !== 'dark' && theme !== 'light') return;
    _current = theme;
    localStorage.setItem('iribhm-theme', _current);
    _apply();
    _notify();
  }

  /**
   * Get current theme
   * @returns {string} 'dark' or 'light'
   */
  function get() {
    return _current;
  }

  /**
   * Check if current theme is dark
   * @returns {boolean}
   */
  function isDark() {
    return _current === 'dark';
  }

  function _apply() {
    document.documentElement.setAttribute('data-theme', _current);
    // Update any theme toggle icons
    document.querySelectorAll('[data-theme-icon]').forEach(el => {
      el.setAttribute('data-theme-icon', _current);
    });
  }

  /**
   * Register a listener for theme changes
   * @param {function} fn - Callback receiving (theme)
   */
  function onChange(fn) {
    _listeners.push(fn);
  }

  function _notify() {
    _listeners.forEach(fn => fn(_current));
  }

  return { init, toggle, set, get, isDark, onChange };
})();
