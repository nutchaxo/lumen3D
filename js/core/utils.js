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
    trustedTargetOrigin
  };
})();
