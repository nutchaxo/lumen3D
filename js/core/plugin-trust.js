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

  /** Fetch the raw bytes of every file and (when WebCrypto is available) hash them.
      Always returns the bytes (keyed by relpath — the SAME bytes that get executed,
      INV-2); `hash`/`fileHashes` are null on an insecure origin (no crypto.subtle),
      where the client cannot re-verify and falls back to the server vouch. Returns
      null only on a fetch failure. */
  async function hashPluginFiles(basePath, modPath, relFiles) {
    // Every file of a plugin is fetched concurrently (they were fetched one after the
    // other, which stretched the viewer boot by the sum of the round-trips).
    //
    // Cache policy, and why it does not weaken INV-2:
    //  - Anything the page may EXECUTE (index.js, workers, helpers — i.e. everything that
    //    is not a .json data file) is read with 'no-store': the bytes hashed are the
    //    bytes from the origin right now, nothing a cache could have kept.
    //  - .json files (plugin.json, lang/<code>.json) are never executed; they are only
    //    folded into the composite hash. They use 'no-cache': the browser must
    //    revalidate with the origin (If-None-Match / If-Modified-Since) and only a 304
    //    reuses the stored body, so a file edited on disk is always re-read. The hash is
    //    still computed over the real bytes. With a Last-Modified-only validator the
    //    resolution is one second, which is acceptable because these bytes never run.
    const entries = await Promise.all(relFiles.map(async rel => {
      try {
        const executable = !/\.json$/i.test(rel);
        const resp = await fetch(`${basePath}/${modPath}/${rel}`, { cache: executable ? 'no-store' : 'no-cache' });
        if (!resp.ok) return null;
        const b = new Uint8Array(await resp.arrayBuffer());
        return { rel, b, h: _subtle ? await fileHash(b) : null };
      } catch (_) {
        return null;
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
      const h = await hashPluginFiles(basePath, modPath, relFiles);
      if (!h || !h.hash) return { tier: 'untrusted', reason: 'hash-unavailable' };
      const ok = relFiles.every(rel => releaseManifest[prefix + rel] === h.fileHashes[rel]);
      return ok ? { tier: 'bundled', hash: h.hash, bytes: h.bytes['index.js'], files: h.bytes, reason: 'manifest match' }
                : { tier: 'untrusted', reason: 'manifest mismatch' };
    }

    if (!TRUSTED.includes(vouch.tier)) return { tier: 'untrusted', reason: 'server vouch not trusted' };

    const relFiles = Array.isArray(vouch.files) && vouch.files.length ? vouch.files : ['index.js', 'plugin.json'];
    const h = await hashPluginFiles(basePath, modPath, relFiles);
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

  return { SCHEME, fileHash, pluginHash, hashPluginFiles, evaluate,
           available: () => !!_subtle };
})();

// Node test harness support (tests/test_plugin_trust.js) — inert in the browser.
if (typeof module !== 'undefined' && module.exports) module.exports = PluginTrust;
