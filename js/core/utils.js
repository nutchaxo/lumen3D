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
    dateStr = String(dateStr);
    // Eight digits are DDMMYYYY (the lab's file-name convention) or YYYYMMDD. The two are
    // told apart by digits 5-6: a month (01-12) only in YYYYMMDD, a century (19/20) only in
    // DDMMYYYY, so they never both match.
    if (/^\d{8}$/.test(dateStr) && /^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(dateStr)) {
      return `${dateStr.slice(6, 8)}/${dateStr.slice(4, 6)}/${dateStr.slice(0, 4)}`;
    }
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
        result.stageNumeric = parseFloat(_stageDigitsToDecimal(part.slice(1)));
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
    stage = String(stage);
    const match = stage.match(/^E(\d+)$/i);
    if (!match) return stage;
    return `E${_stageDigitsToDecimal(match[1])}`;
  }

  /**
   * "75" → "7.5", "775" → "7.75", "105" → "10.5", "10" → "10". Stages run from E7 to E18, so
   * the integer part is one digit or two: three or more digits starting with 10-20 carry a
   * two-digit integer part, two digits are a decimal only from 50 up (E75 = 7.5; E10 = 10).
   * Same rule as Catalog._stageNumber.
   */
  function _stageDigitsToDecimal(digits) {
    if (digits.length <= 1) return digits;
    if (digits.length === 2) return parseInt(digits, 10) >= 50 ? `${digits[0]}.${digits[1]}` : digits;
    const firstTwo = parseInt(digits.slice(0, 2), 10);
    if (firstTwo >= 10 && firstTwo <= 20) return `${digits.slice(0, 2)}.${digits.slice(2)}`;
    return `${digits[0]}.${digits.slice(1)}`;
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
    let pending = null;
    const open = () => {
      if (pending) {
        // The last call made inside the window is not lost: it runs when the window ends.
        const { ctx, args } = pending;
        pending = null;
        fn.apply(ctx, args);
        setTimeout(open, limit);
      } else {
        inThrottle = false;
      }
    };
    return function (...args) {
      if (!inThrottle) {
        fn.apply(this, args);
        inThrottle = true;
        setTimeout(open, limit);
      } else {
        pending = { ctx: this, args };
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
      if (typeof child === 'string' || typeof child === 'number') {
        element.appendChild(document.createTextNode(String(child)));
      } else if (child instanceof Node) {
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
   * Nearest 1-2-5 × 10ⁿ at or below `target` — a scale-bar length that reads as a
   * round number (1, 2, 5, 10, 20, 50 …). 0 for a target that is not positive.
   */
  function niceScaleLength(target) {
    if (!Number.isFinite(target) || !(target > 0)) return 0;
    const exp = Math.pow(10, Math.floor(Math.log10(target)));
    const m = target / exp;
    return Number(((m >= 5 ? 5 : m >= 2 ? 2 : 1) * exp).toPrecision(3));
  }

  /**
   * A length in µm as a label: "500 µm", "2 mm", "1.5 mm", "0.5 µm" (no trailing zeros).
   */
  function formatMicrons(um) {
    if (!Number.isFinite(um)) return '—';
    const trim = (v) => String(Number(v.toFixed(3)));
    return um >= 1000 ? `${trim(um / 1000)} mm` : `${trim(um)} µm`;
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
  // Cell tracking is not a type: a tracked timelapse is a 'live' dataset whose
  // metadata carries a `tracking` block, drawn as a layer of the same viewer.
  // What the operator SEES is never hardcoded — see datasetTypeLabel().
  const DATASET_TYPES = ['3d', '2d', 'live'];

  // Types whose bytes stream as 64³ bricks. A '2d' dataset is one photograph:
  // no bricks, no LOD pyramid, no channels.
  const VOLUME_DATASET_TYPES = ['3d', 'live'];

  const _TYPE_PAGE = { '3d': 'viewer.html', '2d': '2d.html', live: 'viewer.html' };
  const _TYPE_ICON = { '3d': 'layers', '2d': 'camera', live: 'video' };
  const _TYPE_GRADIENT = {
    '3d': 'linear-gradient(135deg, #00D2FF22, #0F346044)',
    '2d': 'linear-gradient(135deg, #8B7CFF22, #1A1A2E44)',
    live: 'linear-gradient(135deg, #FFA72622, #16213E44)'
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

  // ─── Errors shown to a reader ───────────────────────────────────────────────
  // What reaches the screen is one translated sentence per category; the raw text
  // (URLs, HTTP statuses, parser messages) stays in the console. `null` = silent.
  const _ERROR_TEXT = {
    cancelled: null,
    network: ['app.errNetwork', 'The server could not be reached. Check the connection and try again.'],
    notFound: ['app.errNotFound', 'Some of this dataset\'s files are missing on the server.'],
    access: ['app.errAccess', 'The server refused access to this dataset.'],
    server: ['app.errServer', 'The server ran into a problem. Try again in a moment.'],
    damaged: ['app.errDamaged', 'This dataset\'s files are damaged or incomplete. Its administrator needs to check it.'],
    metadata: ['app.errMetadata', 'This dataset\'s description is invalid.'],
    gpuMemory: ['app.errGpuMemory', 'Not enough GPU memory for this quality. Choose a lower quality or close other tabs.'],
    gpuLost: ['app.errGpuLost', 'The graphics card stopped responding. Reload the page.'],
    webgl: ['viewer.errNoWebgl', 'This browser refused to give the page a 3D (WebGL) context. Restart the browser completely and open the page again; if it persists, check that hardware acceleration is on.'],
    noBricks: ['app.errNoBricks', 'No part of the volume could be loaded at this quality.'],
    readFailed: ['app.errReadFailed', 'Part of the dataset could not be read. Check the connection and try again.'],
    timepoint: ['app.errTimepoint', 'This time point could not be loaded.'],
    busy: ['app.errBusy', 'Another operation is still running. Try again when it has finished.'],
    saveRefused: ['app.errSaveRefused', 'The browser refused to save the file. Choose another location or allow downloads for this site.'],
    diskFull: ['app.errDiskFull', 'There is not enough free disk space to save the file.'],
    unknown: ['app.errUnknown', 'Something went wrong. Try again; if it keeps happening, reload the page.'],
  };

  const _ERROR_CODES = {
    cancelled: 'cancelled', aborted: 'cancelled', ABORTED: 'cancelled', BRICKS_MOUNT_CHANGED: 'cancelled',
    BRICKS_MANIFEST_INVALID: 'damaged', BRICKS_INDEX_INVALID: 'damaged', BRICKS_COLUMN_UNKNOWN: 'damaged',
    BRICKS_HASH_MISMATCH: 'damaged', BRICKS_READ_FAILED: 'damaged', BRICKS_DECODE_FAILED: 'damaged',
    READ_FAILED: 'readFailed',
    BRICKS_RANGE_INVALID: 'server',
    METADATA_INVALID: 'metadata', METADATA_MISSING: 'metadata', DATASET_INVALID: 'metadata',
    SVR_OVER_BUDGET: 'gpuMemory', SVR_ALLOC_FAILED: 'gpuMemory', GPU_MEMORY: 'gpuMemory',
    'gpu-memory': 'gpuMemory', 'vram-budget': 'gpuMemory', 'alloc-failed': 'gpuMemory', budget: 'gpuMemory',
    'context-lost': 'gpuLost', CONTEXT_LOST: 'gpuLost',
    BRICKS_NONE_LOADED: 'noBricks', TIMEPOINT_MISSING: 'timepoint',
    busy: 'busy',
  };

  // Ordered: the first pattern that matches wins. Conservative on purpose — an
  // unrecognised message falls to `unknown`, never to a guessed category.
  const _ERROR_PATTERNS = [
    [/creating WebGL context|WebGL.*(not supported|unavailable|disabled)/i, 'webgl'],
    [/context (was )?lost|CONTEXT_LOST_WEBGL/i, 'gpuLost'],
    [/Insufficient GPU memory|out of GPU memory|SVR_OVER_BUDGET|SVR_ALLOC_FAILED|GL_OUT_OF_MEMORY/i, 'gpuMemory'],
    [/No brick payload/i, 'noBricks'],
    [/No bricks for requested timepoint/i, 'timepoint'],
    [/Failed to fetch|NetworkError|Load failed|network error|ERR_[A-Z_]+|timed out|fetch stalled/i, 'network'],
    [/Unexpected token|Unexpected end of (JSON|input)|is not valid JSON|JSON\.parse/i, 'damaged'],
    [/hash mismatch|Manifest rejected|Invalid brick manifest|index(\.bin)? rejected|bad magic|corrupt|BRICKS_INDEX_/i, 'damaged'],
  ];

  function _categoryForStatus(status) {
    const s = Number(status);
    if (!Number.isFinite(s)) return null;
    if (s === 0) return 'network';
    if (s === 404 || s === 410) return 'notFound';
    if (s === 401 || s === 403) return 'access';
    if (s === 408 || s === 429 || s >= 500) return 'server';
    if (s >= 400) return 'damaged';
    return null;
  }

  /**
   * An error meant for a reader, built where the failure is understood. The message
   * stays technical (logs); the UI reads `i18nKey` through friendlyError.
   */
  function userError(code, key, fallback, detail, params) {
    return Object.assign(new Error(detail || fallback || code), {
      code, i18nKey: key, i18nFallback: fallback, i18nParams: params || null,
    });
  }

  /**
   * err (Error, DOMException, loader result `{ reason, code, status }` or a bare
   * reason string) → `{ category, key, fallback, params, silent, detail }`. `key` /
   * `fallback` are null for a silent category. `options.context === 'save'` reads a
   * SecurityError / NotAllowedError as the browser refusing the file picker.
   */
  function friendlyError(err, options = {}) {
    const isObj = err && typeof err === 'object';
    const name = isObj ? String(err.name || '') : '';
    const code = isObj ? (err.code != null ? String(err.code) : '') : String(err || '');
    const message = isObj ? String(err.message || err.reason || '') : String(err || '');
    const detail = [name && name !== 'Error' ? name : '', code && code !== message ? code : '', message]
      .filter(Boolean).join(': ');
    const build = (category, key, fallback, params) => {
      const known = key ? null : _ERROR_TEXT[category];
      return {
        category,
        key: key || (known ? known[0] : null),
        fallback: fallback || (known ? known[1] : null),
        params: params || {},
        silent: !key && known === null,
        detail,
      };
    };
    if (isObj && typeof err.i18nKey === 'string' && err.i18nKey) {
      return build(err.category || _ERROR_CODES[code] || 'known', err.i18nKey, err.i18nFallback || null, err.i18nParams || null);
    }
    if (name === 'AbortError' || (isObj && (err.cancelled === true || err.stale === true))) return build('cancelled');
    if (code && _ERROR_CODES[code]) return build(_ERROR_CODES[code]);
    if (name === 'QuotaExceededError') return build('diskFull');
    if ((name === 'SecurityError' || name === 'NotAllowedError') && options.context === 'save') return build('saveRefused');
    const byStatus = _categoryForStatus(isObj ? err.status : undefined);
    if (byStatus) return build(byStatus);
    const http = /\bHTTP[\s/]*(\d{3})\b/i.exec(message) || /\bmanifest \((\d{3})\)/i.exec(message);
    if (http) {
      const c = _categoryForStatus(http[1]);
      if (c) return build(c);
    }
    for (const [rx, category] of _ERROR_PATTERNS) {
      if (rx.test(message) || rx.test(code)) return build(category);
    }
    if (name === 'TypeError' && /fetch/i.test(message)) return build('network');
    return build('unknown');
  }

  /** The translated sentence for err ('' when its category is silent). */
  function friendlyErrorText(err, options = {}) {
    const f = friendlyError(err, options);
    if (f.silent || !f.key) return '';
    if (typeof I18n !== 'undefined' && typeof I18n.t === 'function') {
      const text = I18n.t(f.key, f.params);
      if (text && text !== f.key) return text;
    }
    const fallback = f.fallback || _ERROR_TEXT.unknown[1];
    return fallback.replace(/\{([A-Za-z0-9_]+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(f.params, k) ? String(f.params[k]) : m));
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
    niceScaleLength,
    formatMicrons,
    mapRange,
    uid,
    escapeHtml,
    isTrustedMessageOrigin,
    trustedTargetOrigin,
    userError,
    friendlyError,
    friendlyErrorText,
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
