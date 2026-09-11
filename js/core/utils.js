/* ============================================================
   IRIBHM Microscopy Platform — Shared Utilities
   ============================================================
   Helper functions used across the platform.
   ============================================================ */

const Utils = (() => {

  /**
   * Format file size in human-readable form
   * @param {number} bytes
   * @returns {string}
   */
  function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    // EDGE-043: Math.log of a negative/NaN size is NaN and Math.log(Infinity) is
    // Infinity, so the unit index goes out of range and the output degrades to
    // 'NaN undefined'. Reject non-finite/negative sizes, and clamp the index so a
    // value larger than 1 PB still reports in TB rather than indexing past the array.
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
  }

  /**
   * Format a date string to locale
   * @param {string} dateStr - ISO date string or DDMMYYYY
   * @returns {string}
   */
  function formatDate(dateStr) {
    if (!dateStr) return '—';
    // Handle DDMMYYYY format
    if (/^\d{8}$/.test(dateStr)) {
      const d = dateStr.slice(0, 2);
      const m = dateStr.slice(2, 4);
      const y = dateStr.slice(4, 8);
      return `${d}/${m}/${y}`;
    }
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString(I18n.getLanguage(), {
        year: 'numeric', month: 'short', day: 'numeric'
      });
    } catch {
      return dateStr;
    }
  }

  /**
   * Parse a dataset name into structured metadata
   * @param {string} name - e.g. "Egfl7eGFP-E75-Em1-18112025-GFP555-Pecam1-10x-2xzoom-4avg"
   * @returns {object}
   */
  function parseDatasetName(name) {
    const result = {
      line: null,
      stage: null,
      stageNumeric: null,
      embryo: null,
      date: null,
      markers: [],
      objective: null,
      interval: null,
      raw: name
    };

    // Try to extract components
    const parts = name.split('-');

    for (const part of parts) {
      // Line (e.g., Egfl7eGFP)
      if (/^Egfl7/i.test(part)) result.line = part;
      // Stage (e.g., E75, E7, E8, E775)
      else if (/^E\d+$/i.test(part)) {
        result.stage = part;
        const num = part.slice(1);
        result.stageNumeric = num.length > 1 ? parseFloat(num[0] + '.' + num.slice(1)) : parseInt(num);
      }
      // Embryo (e.g., Em1, Em10)
      else if (/^Em\d+$/i.test(part)) result.embryo = part;
      // Date (e.g., 18112025)
      else if (/^\d{8}$/.test(part)) result.date = part;
      // Interval (e.g., 10min, 30min)
      else if (/^\d+min$/i.test(part)) result.interval = part;
      // Objective (e.g., 10x)
      else if (/^\d+x$/i.test(part)) result.objective = part;
      // Markers
      else if (/^(GFP|DAPI|Pecam|Flk1|Alexa|RFP|mCherry)/i.test(part)) {
        result.markers.push(part);
      }
    }

    return result;
  }

  /**
   * Format embryonic stage for display
   * @param {string} stage - e.g. "E75"
   * @returns {string} e.g. "E7.5"
   */
  function formatStage(stage) {
    if (!stage) return '—';
    const match = stage.match(/^E(\d+)$/i);
    if (!match) return stage;
    const num = match[1];
    if (num.length === 1) return `E${num}`;
    return `E${num[0]}.${num.slice(1)}`;
  }

  /**
   * Debounce a function
   * @param {function} fn
   * @param {number} delay - ms
   * @returns {function}
   */
  function debounce(fn, delay = 300) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  /**
   * Throttle a function
   * @param {function} fn
   * @param {number} limit - ms
   * @returns {function}
   */
  function throttle(fn, limit = 100) {
    let inThrottle = false;
    return function (...args) {
      if (!inThrottle) {
        fn.apply(this, args);
        inThrottle = true;
        setTimeout(() => { inThrottle = false; }, limit);
      }
    };
  }

  /**
   * DEAD-035: shared navbar dropdown toggle (was duplicated verbatim in
   * landing.js and explorer.js). Toggles `.open` on the target dropdown and
   * installs a one-shot outside-click listener that removes itself once it
   * closes the menu — so no listener leaks across repeated toggles.
   * @param {string} id - element id of the dropdown container
   */
  function toggleDropdown(id) {
    const dropdown = document.getElementById(id);
    if (!dropdown) return;
    dropdown.classList.toggle('open');

    const close = (e) => {
      if (!dropdown.contains(e.target)) {
        dropdown.classList.remove('open');
        document.removeEventListener('click', close);
      }
    };
    setTimeout(() => document.addEventListener('click', close), 0);
  }

  /**
   * DEAD-035: close every open navbar dropdown. Shared between the page-level
   * switchLanguage handlers, whose only common step is closing the menus before
   * each page repopulates its own dynamic content.
   */
  function closeDropdowns() {
    document.querySelectorAll('.dropdown').forEach(d => d.classList.remove('open'));
  }

  /**
   * Build the navbar language switcher from the platform's *discovered*
   * locales (I18n.getAvailableLanguages()) instead of a hardcoded en/fr/es
   * list. Dropping a new lang/<code>.json therefore adds a menu entry with
   * no HTML edit, and a locale the platform does not ship is never offered.
   *
   * Each item shows the locale's flag + native name and calls the page's
   * onSwitch(code) (which forwards to I18n.setLanguage plus any page-local
   * re-render). The active locale is marked. Idempotent: it fully rebuilds
   * the menu, so it can be re-run after a language change.
   *
   * @param {function(string):void} onSwitch  invoked with the chosen code
   * @param {string} [dropdownId='lang-dropdown']
   */
  function populateLanguageMenu(onSwitch, dropdownId = 'lang-dropdown') {
    if (typeof I18n === 'undefined' || !I18n.getAvailableLanguages) return;
    const dropdown = document.getElementById(dropdownId);
    const menu = dropdown && dropdown.querySelector('.dropdown-menu');
    if (!menu) return;

    const current = I18n.getLanguage();
    menu.textContent = '';
    for (const lang of I18n.getAvailableLanguages()) {
      const btn = document.createElement('button');
      btn.className = 'dropdown-item' + (lang.code === current ? ' active' : '');
      btn.type = 'button';
      btn.dataset.lang = lang.code;
      btn.setAttribute('lang', lang.code);
      const flag = document.createElement('span');
      flag.textContent = lang.flag;
      btn.appendChild(flag);
      btn.appendChild(document.createTextNode(' ' + lang.native));
      btn.addEventListener('click', () => {
        if (typeof onSwitch === 'function') onSwitch(lang.code);
      });
      menu.appendChild(btn);
    }
  }

  /**
   * Create an HTML element with attributes and children
   * @param {string} tag
   * @param {object} attrs
   * @param {...(string|HTMLElement)} children
   * @returns {HTMLElement}
   */
  function el(tag, attrs = {}, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class' || key === 'className') {
        element.className = value;
      } else if (key === 'style' && typeof value === 'object') {
        Object.assign(element.style, value);
      } else if (key.startsWith('on') && typeof value === 'function') {
        element.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key.startsWith('data-')) {
        element.setAttribute(key, value);
      } else {
        element.setAttribute(key, value);
      }
    }
    for (const child of children) {
      if (typeof child === 'string') {
        element.appendChild(document.createTextNode(child));
      } else if (child instanceof HTMLElement) {
        element.appendChild(child);
      }
    }
    return element;
  }

  /**
   * Animated counter
   * @param {HTMLElement} element
   * @param {number} target
   * @param {number} duration - ms
   */
  function animateCounter(element, target, duration = 2000) {
    const start = performance.now();
    const initial = parseInt(element.textContent) || 0;

    function update(now) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(initial + (target - initial) * eased);
      element.textContent = current.toLocaleString();
      if (progress < 1) requestAnimationFrame(update);
    }
    requestAnimationFrame(update);
  }

  /**
   * Wait for next animation frame (promisified)
   * @returns {Promise<number>}
   */
  function nextFrame() {
    return new Promise(resolve => requestAnimationFrame(resolve));
  }

  /**
   * Sleep
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Clamp a value between min and max
   */
  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /**
   * Linear interpolation
   */
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /**
   * Map a value from one range to another
   */
  function mapRange(value, inMin, inMax, outMin, outMax) {
    return outMin + (outMax - outMin) * ((value - inMin) / (inMax - inMin));
  }

  /**
   * Generate a unique ID
   */
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /**
   * Escape text before inserting it into an HTML template.
   */
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Whether a postMessage event originates from this page's own origin.
   * Cross-panel sync (compare.html ↔ its same-origin viewer iframes) is strictly
   * same-origin, so messages from any other origin must be ignored.
   * @param {MessageEvent} event
   * @returns {boolean}
   */
  function isTrustedMessageOrigin(event) {
    if (!event) return false;
    const here = (typeof window !== 'undefined' && window.location) ? window.location.origin : null;
    return here !== null && event.origin === here;
  }

  /**
   * SEC-012: the targetOrigin for outbound postMessage. Cross-panel sync targets are
   * strictly same-origin (compare.html ↔ its own viewer iframes), so we post to this
   * page's exact origin instead of the wildcard '*' (which would leak study state to
   * any parent that framed the page). Falls back to '*' only outside a browser.
   * @returns {string}
   */
  // ── Dataset types ──────────────────────────────────────────────────────────
  // ONE vocabulary, everywhere: the directory under DATA_WEB/, the first segment
  // of a dataset id, metadata.json "type", plugin.json "dataTypes", the staging
  // id and the admin filters all spell a type the same way.
  //   '3d'        volumes of fixed specimens   DATA_WEB/3d/        viewer.html
  //   '2d'        calibrated photographs       DATA_WEB/2d/        2d.html
  //   'live'      4D timelapse volumes         DATA_WEB/live/      viewer.html
  //   'tracking'  cell-tracking trajectories   DATA_WEB/tracking/  tracking.html
  // What the operator SEES is never hardcoded — see datasetTypeLabel().
  const DATASET_TYPES = ['3d', '2d', 'live', 'tracking'];

  // Types whose bytes stream as 64³ bricks. A '2d' dataset is one photograph:
  // no bricks, no LOD pyramid, no channels.
  const VOLUME_DATASET_TYPES = ['3d', 'live', 'tracking'];

  const _TYPE_PAGE = { '3d': 'viewer.html', '2d': '2d.html', live: 'viewer.html', tracking: 'tracking.html' };
  const _TYPE_ICON = { '3d': 'layers', '2d': 'camera', live: 'video', tracking: 'git-branch' };
  const _TYPE_GRADIENT = {
    '3d': 'linear-gradient(135deg, #00D2FF22, #0F346044)',
    '2d': 'linear-gradient(135deg, #8B7CFF22, #1A1A2E44)',
    live: 'linear-gradient(135deg, #FFA72622, #16213E44)',
    tracking: 'linear-gradient(135deg, #00A65422, #1A1A2E44)'
  };

  function isDatasetType(type) { return DATASET_TYPES.indexOf(type) !== -1; }

  /** The type segment of a dataset id ('3d/Foo' → '3d'); null if not a type. */
  function datasetTypeOfId(id) {
    const seg = String(id || '').split('/')[0];
    return isDatasetType(seg) ? seg : null;
  }

  /**
   * Short display name of a type — badges, filter chips, selects, stats.
   * Resolution order:
   *   1. the operator's own name, config/instance.json datasetTypes.<type>.label
   *      (a flat string, or a per-locale object like `specimen`);
   *   2. the translated default types.<type>.label in lang/<code>.json;
   *   3. the type id, so a page that loaded neither InstanceConfig nor I18n
   *      still renders a name instead of an empty badge.
   */
  function datasetTypeLabel(type) { return _typeText(type, 'label'); }

  /** Long display name of a type — the landing page's type cards. */
  function datasetTypeTitle(type) { return _typeText(type, 'title') || _typeText(type, 'label'); }

  function _typeText(type, field) {
    if (!type) return '';
    try {
      if (typeof InstanceConfig !== 'undefined' && InstanceConfig.localized) {
        const v = InstanceConfig.localized(InstanceConfig.get(`datasetTypes.${type}.${field}`));
        if (v) return v;
      }
    } catch (_) { /* fall through to the translated default */ }
    try {
      // I18n.raw, never I18n.t: t() interpolates {type3d}… through
      // InstanceConfig.tokens(), which resolves them right back through here.
      if (typeof I18n !== 'undefined' && I18n.raw) {
        const v = I18n.raw(`types.${type}.${field}`);
        if (v) return v;
      }
    } catch (_) { /* fall through */ }
    return field === 'label' ? type : '';
  }

  /**
   * Fill every [data-dataset-type] (short label) and [data-dataset-type-title]
   * (long title) from the resolved type name — the twin of I18n's [data-i18n]
   * sweep and of InstanceConfig's [data-instance] sweep, for text that is NEITHER
   * a fixed translation NOR a plain config value but the combination of the two.
   * The inline markup stays the pre-script fallback. Called by both triggers
   * (a language switch and a config reload), so a page needs no wiring of its own.
   * @param {ParentNode} [root=document]
   */
  function applyDatasetTypeLabels(root) {
    root = root || (typeof document !== 'undefined' ? document : null);
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('[data-dataset-type]').forEach(el => {
      const v = datasetTypeLabel(el.getAttribute('data-dataset-type'));
      if (v) el.textContent = v;
    });
    root.querySelectorAll('[data-dataset-type-title]').forEach(el => {
      const v = datasetTypeTitle(el.getAttribute('data-dataset-type-title'));
      if (v) el.textContent = v;
    });
  }

  function datasetTypeIcon(type) { return _TYPE_ICON[type] || 'box'; }
  function datasetTypeBadgeClass(type) { return isDatasetType(type) ? `badge-${type}` : 'badge-3d'; }
  function datasetTypeGradient(type) { return _TYPE_GRADIENT[type] || _TYPE_GRADIENT['3d']; }

  /** The page that opens a dataset — takes a dataset record or a bare type. */
  function datasetPage(dataset) {
    const type = (dataset && typeof dataset === 'object') ? dataset.type : dataset;
    return _TYPE_PAGE[type] || 'viewer.html';
  }

  function datasetUrl(dataset) {
    return `${datasetPage(dataset)}?id=${encodeURIComponent(dataset.id)}`;
  }

  function trustedTargetOrigin() {
    return (typeof window !== 'undefined' && window.location && window.location.origin)
      ? window.location.origin
      : '*';
  }

  return {
    formatFileSize,
    formatDate,
    parseDatasetName,
    formatStage,
    debounce,
    throttle,
    toggleDropdown,
    closeDropdowns,
    populateLanguageMenu,
    el,
    animateCounter,
    nextFrame,
    sleep,
    clamp,
    lerp,
    mapRange,
    uid,
    escapeHtml,
    isTrustedMessageOrigin,
    trustedTargetOrigin,
    DATASET_TYPES,
    VOLUME_DATASET_TYPES,
    isDatasetType,
    datasetTypeOfId,
    datasetTypeLabel,
    datasetTypeTitle,
    applyDatasetTypeLabels,
    datasetTypeIcon,
    datasetTypeBadgeClass,
    datasetTypeGradient,
    datasetPage,
    datasetUrl
  };
})();
