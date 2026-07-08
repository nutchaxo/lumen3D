/* ============================================================
   IRIBHM Microscopy Platform — Plugin/platform compatibility
   ============================================================
   Evaluates a plugin.json `platformCompat` declaration against the
   platform version. Twin implementation of dev_server.py's
   _compat_satisfies() — both are validated against the SAME vector
   (tests/compat-vector.json); any semantic change must land in the
   three places at once.

   Declaration forms:
     absent / null      → compatible (bundled plugins predate the field)
     "*" or "x"         → compatible (explicit wildcard)
     RANGE (string)     → whitespace-separated comparators, ALL must hold:
                          ">=1.4.0 <2.0.0", "^1.4.0" (≥1.4.0 <2.0.0),
                          "~1.4.1" (≥1.4.1 <1.5.0), bare token = exact/prefix
     LIST (array)       → bare tokens, ANY may hold (the OR form):
                          ["1.3", "1.4.x"], ["1.4.0", "1.4.1"], ["1.x"]
     bare token         → 3 numeric parts = exact ("1.4.1");
                          fewer = prefix ("1.4" ≡ "1.4.x" ≡ ≥1.4.0 <1.5.0)

   Fail-closed: a present-but-unreadable declaration (wrong type, unknown
   token, operator inside a list) is INCOMPATIBLE — never a thrown error,
   never silently compatible. The single fail-OPEN case is an UNKNOWN
   platform version (dev checkouts without version.json): the gate is
   inert there by design, and says so in `reason`.
   ============================================================ */

const Compat = (() => {
  /** "1.4.1-rc2" → [1,4,1] (numeric dotted prefix; pre-release suffix ignored).
      Returns null when the token has no leading numeric part. */
  function _nums(s) {
    const m = /^(\d+(?:\.\d+){0,2})/.exec(String(s).trim());
    if (!m) return null;
    return m[1].split('.').map(Number);
  }

  /** Compare two version arrays, padding to 3 parts with zeros. */
  function _cmp(a, b) {
    for (let i = 0; i < 3; i++) {
      const x = a[i] || 0, y = b[i] || 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  /** Bare token → interval {min, maxEx} | {exact} | {any:true} | null (invalid).
      "1.4.x"/"1.4.*" strip to the "1.4" prefix form. */
  function _bareToken(tok) {
    tok = tok.trim();
    if (tok === '*' || tok === 'x') return { any: true };
    const stripped = tok.replace(/\.[x*]$/i, '');
    const explicitWildcard = stripped !== tok;
    const nums = _nums(stripped);
    if (!nums || !/^\d+(\.\d+){0,2}$/.test(stripped)) return null;
    if (nums.length === 3 && !explicitWildcard) return { exact: nums };
    // Prefix: ≥ prefix.0(.0)  <  prefix with last part + 1
    const min = nums.slice();
    const maxEx = nums.slice();
    maxEx[maxEx.length - 1] += 1;
    return { min, maxEx };
  }

  /** One RANGE comparator → predicate(version)|null. */
  function _comparator(tok) {
    const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(tok.trim());
    if (!m) return null;
    const op = m[1] || '';
    const body = m[2];
    if (!op) {
      const b = _bareToken(body);
      if (!b) return null;
      if (b.any) return () => true;
      if (b.exact) return (v) => _cmp(v, b.exact) === 0;
      return (v) => _cmp(v, b.min) >= 0 && _cmp(v, b.maxEx) < 0;
    }
    const nums = _nums(body);
    if (!nums || !/^\d+(\.\d+){0,2}([.-].*)?$/.test(body.trim())) return null;
    switch (op) {
      case '>=': return (v) => _cmp(v, nums) >= 0;
      case '>':  return (v) => _cmp(v, nums) > 0;
      case '<=': return (v) => _cmp(v, nums) <= 0;
      case '<':  return (v) => _cmp(v, nums) < 0;
      case '=':  return (v) => _cmp(v, nums) === 0;
      case '^': { // ≥A.B.C < (A+1).0.0
        const maxEx = [nums[0] + 1, 0, 0];
        return (v) => _cmp(v, nums) >= 0 && _cmp(v, maxEx) < 0;
      }
      case '~': { // ≥A.B.C < A.(B+1).0
        const maxEx = [nums[0], (nums[1] || 0) + 1, 0];
        return (v) => _cmp(v, nums) >= 0 && _cmp(v, maxEx) < 0;
      }
    }
    return null;
  }

  /**
   * @param {string|null} platformVersion  e.g. "1.5.0"; null/undefined = unknown
   * @param {*} decl  the plugin.json `platformCompat` value
   * @returns {{ok: boolean, reason: string}}
   */
  function satisfies(platformVersion, decl) {
    if (decl === undefined || decl === null) {
      return { ok: true, reason: 'no constraint declared' };
    }
    if (platformVersion === undefined || platformVersion === null) {
      return { ok: true, reason: 'platform version unknown — gate disabled' };
    }
    const v = _nums(platformVersion);
    if (!v) return { ok: true, reason: 'platform version unreadable — gate disabled' };

    if (typeof decl === 'string') {
      const tokens = decl.trim().split(/\s+/).filter(Boolean);
      if (!tokens.length) return { ok: false, reason: 'empty constraint' };
      for (const tok of tokens) {
        const pred = _comparator(tok);
        if (!pred) return { ok: false, reason: `unreadable constraint token "${tok}"` };
        if (!pred(v)) return { ok: false, reason: `platform ${platformVersion} fails "${decl}"` };
      }
      return { ok: true, reason: `matches "${decl}"` };
    }

    if (Array.isArray(decl)) {
      if (!decl.length) return { ok: false, reason: 'empty constraint list' };
      for (const item of decl) {
        if (typeof item !== 'string' || /^(>=|<=|>|<|=|\^|~)/.test(item.trim())) {
          return { ok: false, reason: `invalid list item "${item}" (bare tokens only)` };
        }
        const b = _bareToken(item);
        if (!b) return { ok: false, reason: `unreadable list token "${item}"` };
        if (b.any) return { ok: true, reason: 'wildcard' };
        if (b.exact ? _cmp(v, b.exact) === 0 : (_cmp(v, b.min) >= 0 && _cmp(v, b.maxEx) < 0)) {
          return { ok: true, reason: `matches "${item}"` };
        }
      }
      return { ok: false, reason: `platform ${platformVersion} matches none of [${decl.join(', ')}]` };
    }

    return { ok: false, reason: `unreadable constraint (type ${typeof decl})` };
  }

  // ─── Platform version resolution ──────────────────────────
  // Release installs ship version.json at the web root (static, every host).
  // Dev checkouts have no version.json (gitignored) but run dev_server.py,
  // which answers /api/health. When neither responds the version is unknown
  // and the compat gate is inert (see satisfies()).
  let _versionPromise = null;

  function platformVersion() {
    if (!_versionPromise) {
      _versionPromise = (async () => {
        for (const [url, key] of [['version.json', 'web'], ['api/health', 'web']]) {
          try {
            const resp = await fetch(url, { cache: 'no-store' });
            if (!resp.ok) continue;
            const v = (await resp.json())?.[key];
            if (typeof v === 'string' && v) return v;
          } catch (_) { /* fall through */ }
        }
        console.info('[Compat] Platform version unknown (no version.json, no /api/health) — compat gate disabled.');
        return null;
      })();
    }
    return _versionPromise;
  }

  return { satisfies, platformVersion };
})();

// Node test harness support (tests/test_compat.js) — inert in the browser.
if (typeof module !== 'undefined' && module.exports) module.exports = Compat;
