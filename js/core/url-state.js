const UrlState = (() => {
  let _syncInterval = null;
  let _lastHash = '';
  let _getState = null;
  let _baseline = null;         // fingerprint of the workspace the page opened with
  let _lastFingerprint = null;  // fingerprint at the previous tick (skips re-encoding)
  let _baselineIsPristine = false;
  let _settleTimer = null;
  let _suspendedUntil = 0;
  // A tick awaits its compression, so a write can be in flight when the hash is
  // dropped. Anything that invalidates the URL bumps this; a tick whose generation
  // is stale throws its result away instead of resurrecting the state just cleared.
  let _generation = 0;

  // Counters that move on their own (the brick cache fills as the volume streams)
  // are NOT the operator changing something. Left in the fingerprint they would
  // stamp a #state= onto a URL nobody touched, and re-compress the whole workspace
  // every single second. They stay in the payload — only the change test ignores them.
  const VOLATILE_PATHS = [['viewer', 'cache']];

  // A workspace is a few KB. Deflate expands up to ~1000:1, so a crafted link must not
  // be allowed to inflate unbounded; and a #state= past a few tens of KB is no longer a
  // link anyone can share (browsers truncate or refuse such URLs).
  const MAX_HASH_CHARS = 2 * 1024 * 1024;
  const MAX_INFLATED_BYTES = 16 * 1024 * 1024;
  const MAX_WRITTEN_HASH_CHARS = 64 * 1024;
  let _warnedOversize = false;

  async function encodeState(state) {
    try {
      const json = JSON.stringify(state);
      const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      const blob = await new Response(stream).blob();
      const buffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      let binaryStr = '';
      const chunkSize = 8192;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binaryStr += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }

      const base64 = btoa(binaryStr);
      return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    } catch (err) {
      console.warn('[UrlState] Failed to encode state:', err);
      return null;
    }
  }

  async function decodeState(hashStr) {
    if (!hashStr || !hashStr.startsWith('#state=')) return null;
    try {
      if (hashStr.length > MAX_HASH_CHARS) throw new Error('state hash too long');
      const base64url = hashStr.replace('#state=', '');
      const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((base64url.length + 3) % 4);
      const binaryStr = atob(base64);

      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      const reader = stream.getReader();
      const parts = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_INFLATED_BYTES) {
          try { await reader.cancel(); } catch (_) { /* already torn down */ }
          throw new Error('decompressed state exceeds ' + MAX_INFLATED_BYTES + ' bytes');
        }
        parts.push(value);
      }
      const merged = new Uint8Array(total);
      let at = 0;
      for (const p of parts) { merged.set(p, at); at += p.byteLength; }
      return JSON.parse(new TextDecoder('utf-8').decode(merged));
    } catch (err) {
      console.warn('[UrlState] Failed to decode state from URL:', err);
      return null;
    }
  }

  /** True when the current URL carries a workspace state. */
  function hasState() {
    return Boolean(window.location.hash && window.location.hash.startsWith('#state='));
  }

  /**
   * Drop #state= from the address bar without touching history or reloading.
   * The state is not "restored away" — it is simply no longer the URL's business.
   */
  function clearHash() {
    _lastHash = '';
    _lastFingerprint = null;
    _generation++;
    if (!window.location.hash) return;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  /**
   * @param {Function} getStateFn  returns the workspace state to serialize
   * @param {number} [intervalMs]
   * @param {{pristine?: boolean}} [options]
   *        pristine:true declares "what getStateFn returns right now is the
   *        untouched dataset" — no hash is written until it actually differs, so
   *        merely opening a viewer no longer plants a state in the URL. Callers
   *        that restored a shared state must leave it false: there the current
   *        state IS worth keeping in the URL.
   */
  function startSync(getStateFn, intervalMs = 1000, options = {}) {
    if (_syncInterval) clearInterval(_syncInterval);

    _getState = getStateFn;
    _lastHash = window.location.hash;
    _baselineIsPristine = options.pristine === true;
    _baseline = _baselineIsPristine ? _fingerprint(_readState()) : null;
    _lastFingerprint = null;
    _suspendedUntil = 0;

    _syncInterval = setInterval(_tick, intervalMs);
  }

  function stopSync() {
    if (_syncInterval) {
      clearInterval(_syncInterval);
      _syncInterval = null;
    }
    if (_settleTimer) {
      clearTimeout(_settleTimer);
      _settleTimer = null;
    }
  }

  /**
   * Adopt the current workspace as the new "untouched" reference — what the reset
   * button needs so the URL it just cleared does not grow a fresh #state= one tick
   * later. `settleMs` holds the sync off while the reset's asynchronous tail (a
   * channel re-notify, a timepoint reload) lands, then snapshots what settled.
   * @param {{clearHash?: boolean, settleMs?: number}} [options]
   */
  function rebaseline(options = {}) {
    if (options.clearHash !== false) clearHash();
    _baselineIsPristine = true;
    _generation++;

    const settleMs = Number.isFinite(options.settleMs) ? Math.max(0, options.settleMs) : 0;
    if (_settleTimer) clearTimeout(_settleTimer);
    if (!settleMs) {
      _capture();
      return;
    }

    // Wait for the workspace to STOP moving before deciding what "unchanged" means.
    // A reset can restart a volume load whose completion still edits the state
    // seconds later (physical calibration, camera fit); a single delayed snapshot
    // would freeze a mid-flight value as the reference and the very next tick would
    // stamp a #state= back onto the URL the reset just cleaned. Two identical reads
    // in a row end the watch — or the deadline, so a viewer that never goes quiet
    // still gets a baseline.
    const deadline = performance.now() + settleMs * 4;
    let previous = null;
    _suspendedUntil = deadline + settleMs;
    const poll = () => {
      const current = _fingerprint(_readState());
      if ((current !== null && current === previous) || performance.now() >= deadline) {
        _settleTimer = null;
        _suspendedUntil = 0;
        _baseline = current;
        _lastFingerprint = current;
        return;
      }
      previous = current;
      _settleTimer = setTimeout(poll, settleMs);
    };
    _settleTimer = setTimeout(poll, settleMs);
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  function _capture() {
    _baseline = _fingerprint(_readState());
    _lastFingerprint = _baseline;
  }

  function _readState() {
    try {
      return _getState ? _getState() : null;
    } catch (err) {
      console.warn('[UrlState] state provider threw:', err);
      return null;
    }
  }

  function _fingerprint(state) {
    if (!state) return null;
    try {
      // One serialisation, with the volatile members dropped by the replacer (no deep clone).
      const holders = [];
      for (const path of VOLATILE_PATHS) {
        let node = state;
        for (let i = 0; i < path.length - 1 && node; i++) node = node[path[i]];
        if (node && typeof node === 'object') holders.push([node, path[path.length - 1]]);
      }
      return JSON.stringify(state, function (key, value) {
        for (const [holder, name] of holders) if (this === holder && key === name) return undefined;
        return value;
      });
    } catch (err) {
      return null;
    }
  }

  async function _tick() {
    if (_suspendedUntil && performance.now() < _suspendedUntil) return;
    const state = _readState();
    if (!state) return;

    const fingerprint = _fingerprint(state);
    if (fingerprint === null || fingerprint === _lastFingerprint) return;
    _lastFingerprint = fingerprint;

    // Back to exactly how the dataset opened: the URL has nothing to carry.
    if (_baselineIsPristine && fingerprint === _baseline) {
      clearHash();
      _lastFingerprint = fingerprint;
      return;
    }

    const generation = _generation;
    const encoded = await encodeState(state);
    if (!encoded || generation !== _generation) return;
    if (encoded.length > MAX_WRITTEN_HASH_CHARS) {
      if (!_warnedOversize) {
        _warnedOversize = true;
        console.warn('[UrlState] Workspace too large for a shareable link; the address bar is no longer updated (use "Save state" to export it).');
      }
      // A stale #state= would restore an older workspace than the one on screen.
      if (window.location.hash.startsWith('#state=')) { clearHash(); _lastFingerprint = fingerprint; }
      return;
    }
    const newHash = `#state=${encoded}`;
    // Only update if it actually changed to prevent history spam and layout thrashing
    if (newHash !== window.location.hash && newHash !== _lastHash) {
      _lastHash = newHash;
      try {
        window.history.replaceState(null, '', window.location.pathname + window.location.search + newHash);
      } catch (err) {
        console.warn('[UrlState] Could not write the address bar:', err);
      }
    }
  }

  return { encodeState, decodeState, hasState, clearHash, startSync, stopSync, rebaseline };
})();
