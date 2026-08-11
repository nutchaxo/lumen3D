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
      const base64url = hashStr.replace('#state=', '');
      const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((base64url.length + 3) % 4);
      const binaryStr = atob(base64);

      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      const json = await new Response(stream).text();
      return JSON.parse(json);
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
      const copy = JSON.parse(JSON.stringify(state));
      for (const path of VOLATILE_PATHS) {
        let node = copy;
        for (let i = 0; i < path.length - 1 && node; i++) node = node[path[i]];
        if (node && typeof node === 'object') delete node[path[path.length - 1]];
      }
      return JSON.stringify(copy);
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
    const newHash = `#state=${encoded}`;
    // Only update if it actually changed to prevent history spam and layout thrashing
    if (newHash !== window.location.hash && newHash !== _lastHash) {
      _lastHash = newHash;
      window.history.replaceState(null, '', window.location.pathname + window.location.search + newHash);
    }
  }

  return { encodeState, decodeState, hasState, clearHash, startSync, stopSync, rebaseline };
})();
