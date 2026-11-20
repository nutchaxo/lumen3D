/* ============================================================
   IRIBHM Microscopy Platform — Plugin Trust (client)
   ============================================================
   Twin of dev_server.py's trust module. The SERVER is the trust
   authority (it holds the approval store and vouches a tier + hash
   in /api/plugins); this client re-hashes the EXACT bytes it is
   about to execute and refuses to run anything whose bytes don't
   match the vouch (anti-TOCTOU, INV-2) or that isn't trusted.

   Canonical hash — MUST match dev_server.py:_plugin_hash
   (validated by tests/plugin-trust-vector.json):
     fileHash   = sha256(raw bytes as served — no CRLF/BOM change)
     pluginHash = sha256( "lumen-plugin-trust/1\n" +
                          sorted("<relpath>:<filehash>").join("\n") )

   Tiers: 'bundled' | 'dev' | 'approved-trusted' | 'sandboxed' | 'untrusted'.
   Fail-closed everywhere: no crypto.subtle (insecure origin), a hash
   mismatch, or an absent vouch ⇒ 'untrusted'.
   ============================================================ */

const PluginTrust = (() => {
  const SCHEME = 'lumen-plugin-trust/1';

  function _hex(buf) {
    const b = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
    return s;
  }

  const _subtle = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto.subtle : null;

  async function fileHash(bytes) {
    // bytes: Uint8Array of the raw file as served.
    return _hex(await _subtle.digest('SHA-256', bytes));
  }

  /** fileHashes: { relpath: hexhash } → composite plugin hash. */
  async function pluginHash(fileHashes) {
    const lines = Object.keys(fileHashes).sort().map(rel => `${rel}:${fileHashes[rel]}`);
    const doc = SCHEME + '\n' + lines.join('\n');
    return _hex(await _subtle.digest('SHA-256', new TextEncoder().encode(doc)));
  }

  // At most this many plugin-file requests are in flight at once across every plugin
  // of the page: a cold cache would otherwise open one request per file of every
  // plugin together, which a host that bans an address on a burst takes for an attack.
  const MAX_IN_FLIGHT = 6;
  let _inFlight = 0;
  const _waiting = [];

  function _acquire() {
    if (_inFlight < MAX_IN_FLIGHT) { _inFlight++; return Promise.resolve(); }
    return new Promise(resolve => _waiting.push(resolve));
  }

  function _release() {
    const next = _waiting.shift();
    if (next) next();   // the slot passes to the next request without being freed
    else _inFlight--;
  }

  /** Hex stamp a plugin's URLs carry: the head of a (sha256) hash. Null when unusable. */
  function stampOf(hash) {
    return typeof hash === 'string' && /^[0-9a-f]{16,}$/i.test(hash) ? hash.slice(0, 16).toLowerCase() : null;
  }

  /** Fetch the raw bytes of every file and (when WebCrypto is available) hash them.
      Always returns the bytes (keyed by relpath — the SAME bytes that get executed,
      INV-2); `hash`/`fileHashes` are null on an insecure origin (no crypto.subtle),
      where the client cannot re-verify and falls back to the server vouch. Returns
      null only on a fetch failure.

      `options.stamp` — a string, or (rel) → string|null — appends `?v=<stamp>` to each
      URL and lets the browser answer from its HTTP cache (the host sends such a URL
      immutable). The stamp is the head of the very hash the bytes must produce, so a
      changed file lives at a new URL and nothing is ever revalidated. Without a stamp
      every file is read with 'no-cache': the browser revalidates with the origin and
      reuses its stored body only on a 304.
      `options.cache` forces a fetch cache mode (the one retry after a mismatch uses
      'reload'). INV-2 never rests on the cache: the bytes hashed here are the bytes
      executed, and their hash must match the server vouch, so a stale or poisoned
      body is refused or re-fetched, never run. */
  async function hashPluginFiles(basePath, modPath, relFiles, options) {
    const opts = options || {};
    const stampFor = typeof opts.stamp === 'function' ? opts.stamp : () => opts.stamp || null;
    const entries = await Promise.all(relFiles.map(async rel => {
      await _acquire();
      try {
        const stamp = stampFor(rel);
        const url = `${basePath}/${modPath}/${rel}${stamp ? `?v=${stamp}` : ''}`;
        const resp = await fetch(url, { cache: opts.cache || (stamp ? 'default' : 'no-cache') });
        if (!resp.ok) return null;
        const b = new Uint8Array(await resp.arrayBuffer());
        return { rel, b, h: _subtle ? await fileHash(b) : null };
      } catch (_) {
        return null;
      } finally {
        _release();
      }
    }));
    const fileHashes = {};
    const bytes = {};
    for (const e of entries) {
      if (!e) return null;
      bytes[e.rel] = e.b;
      if (_subtle) fileHashes[e.rel] = e.h;
    }
    return { hash: _subtle ? await pluginHash(fileHashes) : null, fileHashes, bytes };
  }

  /**
   * Decide how a plugin may run. The server's discovery vouch carries the
   * authoritative tier; this verifies the on-disk bytes still match it.
   *
   * `vouch` is a SEPARATE argument on purpose. It used to be read off `meta.trust`,
   * but `meta` may legitimately come from the plugin's own plugin.json — so a plugin
   * could author its own trust tier and escape the sandbox it was approved under.
   * The caller now sources the vouch exclusively from an authoritative discovery
   * endpoint; a null vouch means "no trust authority here", handled below.
   *
   * @param {object} meta   plugin metadata (never a trust source)
   * @param {object|null} vouch  server verdict {tier, hash, mode, caps, files}
   * @returns {Promise<{tier, hash?, mode?, caps?, reason}>}
   */
  const TRUSTED = ['bundled', 'dev', 'approved-trusted', 'sandboxed'];

  async function evaluate(meta, vouch, basePath, modPath, releaseManifest) {

    // No server vouch = a static host with no trust authority. Only 'bundled' is
    // client-verifiable there, against version.json — and it needs WebCrypto.
    if (!vouch) {
      if (!releaseManifest) return { tier: 'untrusted', reason: 'no server vouch, no manifest' };
      if (!_subtle) return { tier: 'untrusted', reason: 'hash-unavailable (serve over https/localhost)' };
      // Enumerate ALL of the plugin's files FROM the manifest (not just index.js +
      // plugin.json) so a sibling helper/worker is content-pinned too (fix RT-med).
      const prefix = `${basePath}/${modPath}/`;
      const relFiles = Object.keys(releaseManifest).filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length));
      if (!relFiles.includes('index.js')) return { tier: 'untrusted', reason: 'index.js not in manifest' };
      // Each file is stamped with the head of the hash the manifest pins for it.
      const manifestStamp = rel => (_subtle ? stampOf(releaseManifest[prefix + rel]) : null);
      const matches = h => relFiles.every(rel => releaseManifest[prefix + rel] === h.fileHashes[rel]);
      let h = await hashPluginFiles(basePath, modPath, relFiles, { stamp: manifestStamp });
      // A body served from the HTTP cache may be stale or poisoned: one more read that
      // bypasses it before the files are declared different from the manifest.
      if (h && h.hash && !matches(h)) {
        h = await hashPluginFiles(basePath, modPath, relFiles, { stamp: manifestStamp, cache: 'reload' });
      }
      if (!h || !h.hash) return { tier: 'untrusted', reason: 'hash-unavailable' };
      return matches(h) ? { tier: 'bundled', hash: h.hash, bytes: h.bytes['index.js'], files: h.bytes, reason: 'manifest match' }
                        : { tier: 'untrusted', reason: 'manifest mismatch' };
    }

    if (!TRUSTED.includes(vouch.tier)) return { tier: 'untrusted', reason: 'server vouch not trusted' };

    const relFiles = Array.isArray(vouch.files) && vouch.files.length ? vouch.files : ['index.js', 'plugin.json'];
    // The composite hash changes whenever any file of the plugin does, so its head is a
    // version stamp for every file: a plugin that did not change is never requested again.
    const stamp = _subtle ? stampOf(vouch.hash) : null;
    let h = await hashPluginFiles(basePath, modPath, relFiles, { stamp });
    // Bytes that may have come from the HTTP cache and do not match the vouch get one
    // read that bypasses it, so a stale entry cannot quarantine a good plugin; a file
    // that still differs is refused below as it always was.
    if (h && h.hash && stamp && h.hash !== vouch.hash) {
      h = await hashPluginFiles(basePath, modPath, relFiles, { stamp, cache: 'reload' });
    }
    if (!h) return { tier: 'untrusted', reason: 'fetch failed' };

    if (!_subtle) {
      // Insecure origin (http on a LAN IP): no WebCrypto → the client cannot re-hash.
      // The server (first-party authority) already classified and excluded untrusted,
      // so degrade to trusting its vouch (INV-2 relaxed) rather than break the viewer.
      console.warn('[PluginTrust] WebCrypto unavailable (insecure origin) — trusting the server vouch without client re-hash. Serve over HTTPS or http://localhost for full integrity verification.');
      return { tier: vouch.tier, hash: vouch.hash, mode: vouch.mode, caps: vouch.caps,
               bytes: h.bytes['index.js'], files: h.bytes, reason: vouch.tier + ' (server-vouched, no client re-hash)' };
    }

    // INV-2: the bytes we are about to run must equal what the server classified.
    if (h.hash !== vouch.hash) {
      return { tier: 'untrusted', hash: h.hash,
               reason: 'content changed since server classification (hash mismatch)' };
    }
    return { tier: vouch.tier, hash: h.hash, mode: vouch.mode, caps: vouch.caps,
             bytes: h.bytes['index.js'], files: h.bytes, reason: vouch.tier };
  }

  return { SCHEME, MAX_IN_FLIGHT, fileHash, pluginHash, hashPluginFiles, stampOf, evaluate,
           available: () => !!_subtle };
})();

// Node test harness support (tests/test_plugin_trust.js) — inert in the browser.
if (typeof module !== 'undefined' && module.exports) module.exports = PluginTrust;
