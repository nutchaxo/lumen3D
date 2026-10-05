/* ============================================================
   Lumen3D — PlaneLoader: reads a format-2 `planes/` tree
   ============================================================
   The native level (LOD0) of a brick tree re-cut into XY planes
   (DOCS/dataset-migrations/SPEC.md §3, §8): one pack `zNNNNN.bin` per z, a fixed
   header of headerBytes = 16 + 12·C·TY·TX (every z of a tree), then png-gray8 tiles
   of tileSize² in entry order (c-major, then ty, then tx). An XY region of one plane
   is a handful of tiles, so a native XY cut reads a few MB where the bricks path
   reads every brick the plane crosses whole along z (64 slices each).

     const tree = await PlaneLoader.open(planesBase, { dimensions, channels,
                                                       sourceManifestUrl, signal })
     tree.loadRegion(z, channels, rect, opts)      one plane
     tree.loadRegionMax(zs, channels, rect, opts)  per-channel maximum over planes
     tree.estimate(zs, channels, rect, opts)       bytes a load will fetch

   Format 3 (SPEC §12) adds `mips/`: per brick layer l (planes [64·l, 64·l + 64)) the
   per-channel maximum over its planes, packed like planes (`lNNNNN.bin`, magic LMIP):

     const mips = await PlaneLoader.openMips(mipsBase, sameOptions)
     mips.loadLayerMax(l, channels, rect, opts)    one layer's MIP
     PlaneLoader.planSlabMax(z0, z1, depth)        { layers, planes } of a slab
     PlaneLoader.loadSlabMax(tree, mips, z0, z1, channels, rect, opts)
                                                   slab MIP = max over planes [z0, z1)

   `rect` = { x0, y0, x1, y1 } image pixels, half-open. The header of each z is
   range-read once ([0, headerBytes), cached); the tiles a region needs are fetched
   as merged byte runs with Range requests (a server that answers 200 hands back the
   whole pack: the runs are cut out of it, and the tree stops asking for ranges).
   Tiles of length 0 are all-zero (no payload). Decoding runs in a small pool of
   plane-decode-workers, one horizontal band of tile rows each, so the per-channel
   planes of a region never cross the main thread in pieces.

   A tree is opened only when its manifest is exactly the one the bricks describe:
   schema, codec, level 0, LOD0 dimensions, channel count, tile grid, header size,
   and the sha256 of the bricks manifest it was cut from (a dataset re-processed
   since its planes were made must not show their stale pixels). Pack URLs carry
   `?v=` = FNV-1a of the planes manifest text, so a re-migrated tree is never read
   through yesterday's HTTP cache.
   ============================================================ */

const PlaneLoader = (() => {
  'use strict';

  const SCHEMA = 'lumen-planes-v1';
  const CODEC = 'png-gray8';
  const PACK_PATTERN = 'z{z}.bin';
  // Format 3 (SPEC §12): per brick layer l (planes [64·l, min(64·l + 64, Z))) the
  // per-voxel maximum over its planes, tiled and packed exactly like a plane.
  const MIPS_SCHEMA = 'lumen-mips-v1';
  const MIPS_PACK_PATTERN = 'l{l}.bin';
  const LAYER_DEPTH = 64;
  const KIND_PLANES = Object.freeze({ kind: 'planes', magic: 'LPLN', prefix: 'z', unit: 'plane' });
  const KIND_MIPS = Object.freeze({ kind: 'mips', magic: 'LMIP', prefix: 'l', unit: 'layer' });
  // Runs closer than this are fetched as one (the gap is cheaper than a request).
  const RANGE_GAP_BYTES = 256 * 1024;
  const HEADER_CACHE_MAX = 4096;
  const HEADER_FETCH_PARALLEL = 8;

  const _WORKER_URL = (() => {
    const base = 'js/workers/plane-decode-worker.js';
    try {
      const src = typeof document !== 'undefined' && document.currentScript ? document.currentScript.src : '';
      const m = /[?&]v=([^&#]+)/.exec(src || '');
      return m ? `${base}?v=${m[1]}` : base;
    } catch (e) {
      return base;
    }
  })();

  const _codec = () => (typeof PlaneCodec !== 'undefined' ? PlaneCodec : null);

  function _abortError() {
    return typeof DOMException === 'function'
      ? new DOMException('Plane load cancelled', 'AbortError')
      : Object.assign(new Error('Plane load cancelled'), { name: 'AbortError' });
  }
  function _throwIfAborted(signal) {
    if (signal && signal.aborted) throw _abortError();
  }
  function _planeError(code, message) {
    return Object.assign(new Error(message), { code });
  }

  // ── Hashes ───────────────────────────────────────────────────────────────────

  function _fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  // SHA-256 (FIPS 180-4) for a page without crypto.subtle (plain http on a LAN host
  // is not a secure context).
  const _K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  function _sha256Js(bytes) {
    const n = bytes.length;
    const padded = new Uint8Array(((n + 9 + 63) >> 6) << 6);
    padded.set(bytes);
    padded[n] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, Math.floor(n / 0x20000000), false);
    dv.setUint32(padded.length - 4, (n << 3) >>> 0, false);
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const W = new Uint32Array(64);
    const rotr = (x, r) => (x >>> r) | (x << (32 - r));
    for (let p = 0; p < padded.length; p += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(p + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
        const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const t1 = (h + S1 + ((e & f) ^ (~e & g)) + _K[i] + W[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    return Array.from(H, v => v.toString(16).padStart(8, '0')).join('');
  }
  async function sha256Hex(bytes) {
    const subtle = typeof crypto !== 'undefined' && crypto && crypto.subtle;
    if (subtle && typeof subtle.digest === 'function') {
      try {
        const d = new Uint8Array(await subtle.digest('SHA-256', bytes));
        return Array.from(d, v => v.toString(16).padStart(2, '0')).join('');
      } catch (e) { /* fall through to the JS digest */ }
    }
    return _sha256Js(bytes);
  }

  // ── Manifest validation ──────────────────────────────────────────────────────

  const _posInt = (v) => Number.isInteger(v) && v > 0;

  /**
   * The manifest object when it describes exactly the tree `expect` names, else an
   * Error carrying the reason (code PLANES_INVALID).
   */
  function validateManifest(m, expect = {}) {
    return _validateTree(m, expect, { file: 'planes/manifest.json', schema: SCHEMA, formatVersion: 2, packPattern: PACK_PATTERN });
  }

  /**
   * The mips/manifest.json of a format-3 tree (SPEC §12): the planes manifest's shape
   * with its own schema, formatVersion 3, packPattern l{l}.bin, layerDepth 64 and
   * layers = ceil(Z / 64). Error code MIPS_INVALID.
   */
  function validateMipsManifest(m, expect = {}) {
    _validateTree(m, expect, { file: 'mips/manifest.json', schema: MIPS_SCHEMA, formatVersion: 3, packPattern: MIPS_PACK_PATTERN, code: 'MIPS_INVALID' });
    if (m.layerDepth !== LAYER_DEPTH) throw _planeError('MIPS_INVALID', `mips/manifest.json: layerDepth ${JSON.stringify(m.layerDepth)} ≠ ${LAYER_DEPTH}`);
    const layers = Math.ceil(m.dimensions.z / LAYER_DEPTH);
    if (m.layers !== layers) throw _planeError('MIPS_INVALID', `mips/manifest.json: layers ${JSON.stringify(m.layers)} ≠ ceil(Z/${LAYER_DEPTH}) = ${layers}`);
    return m;
  }

  function _validateTree(m, expect, spec) {
    const fail = (why) => { throw _planeError(spec.code || 'PLANES_INVALID', `${spec.file}: ${why}`); };
    if (!m || typeof m !== 'object' || Array.isArray(m)) fail('not an object');
    if (m.schema !== spec.schema) fail(`schema ${JSON.stringify(m.schema)} ≠ ${spec.schema}`);
    if (m.formatVersion !== spec.formatVersion) fail(`formatVersion ${JSON.stringify(m.formatVersion)} ≠ ${spec.formatVersion}`);
    if (m.level !== 0) fail(`level ${JSON.stringify(m.level)} ≠ 0`);
    if (m.codec !== CODEC) fail(`codec ${JSON.stringify(m.codec)} ≠ ${CODEC}`);
    if (m.packPattern !== spec.packPattern) fail(`packPattern ${JSON.stringify(m.packPattern)} ≠ ${spec.packPattern}`);
    const d = m.dimensions || {};
    if (!_posInt(d.x) || !_posInt(d.y) || !_posInt(d.z)) fail('dimensions are not positive integers');
    const e = expect.dimensions;
    if (e) {
      for (const k of ['x', 'y', 'z']) {
        if (Number(e[k]) !== d[k]) fail(`dimensions.${k} ${d[k]} ≠ the bricks' LOD0 ${e[k]}`);
      }
    }
    if (!_posInt(m.channels) || m.channels > 0xFFFF) fail('channels is not a positive integer');
    if (expect.channels != null && Number(expect.channels) !== m.channels) fail(`channels ${m.channels} ≠ the bricks' ${expect.channels}`);
    if (!_posInt(m.tileSize)) fail('tileSize is not a positive integer');
    const tx = Math.ceil(d.x / m.tileSize);
    const ty = Math.ceil(d.y / m.tileSize);
    if (!m.tiles || m.tiles.x !== tx || m.tiles.y !== ty) fail(`tiles ≠ {x: ${tx}, y: ${ty}} for a ${m.tileSize} px tile`);
    const hb = 16 + 12 * m.channels * ty * tx;
    if (m.headerBytes !== hb) fail(`headerBytes ${m.headerBytes} ≠ 16 + 12·C·TY·TX = ${hb}`);
    const sha = m.source && m.source.manifestSha256;
    if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) fail('source.manifestSha256 is not a sha256 hex digest');
    return m;
  }

  /**
   * A pack header with the magic `magic` ("LPLN" plane, "LMIP" layer MIP). The magic
   * is checked here; the rest of the layout (shared by both, SPEC §3.2 / §12) is
   * parsed by PlaneCodec from a copy carrying the plane magic, so any codec version
   * reads either.
   */
  function _parseHeader(codec, bytes, magic, label) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < 4; i++) {
      if (u8[i] !== magic.charCodeAt(i)) throw _planeError('PLANES_INVALID', `${label}: magic is not ${magic}`);
    }
    let src = u8;
    if (magic !== KIND_PLANES.magic) {
      src = u8.slice();
      for (let i = 0; i < 4; i++) src[i] = KIND_PLANES.magic.charCodeAt(i);
    }
    try {
      return codec.parsePackHeader(src);
    } catch (e) {
      throw _planeError('PLANES_INVALID', `${label}: ${(e && e.message) || e}`);
    }
  }

  // ── Workers ──────────────────────────────────────────────────────────────────

  let _pool = null;
  let _seq = 0;
  const _pending = new Map();   // id → { resolve, reject }

  function _poolSize() {
    const hc = typeof navigator !== 'undefined' ? Number(navigator.hardwareConcurrency) || 4 : 4;
    return Math.max(1, Math.min(4, hc - 1));
  }

  function _workers() {
    if (_pool && _pool.every(w => w.alive)) return _pool;
    if (typeof Worker === 'undefined') throw _planeError('PLANES_NO_WORKER', 'Web Workers are unavailable');
    if (_pool) {
      // The survivors are terminated with the dead one: whatever they still owed (a band,
      // a MIP accumulator) is lost, so its caller must hear it rather than wait forever.
      const old = new Set(_pool);
      _pool.forEach(r => { try { r.w.terminate(); } catch (e) { /* gone */ } });
      const err = _planeError('PLANES_DECODE', 'plane decode workers restarted');
      for (const [id, p] of _pending) if (old.has(p.rec)) { _pending.delete(id); p.reject(err); }
    }
    _pool = [];
    for (let i = 0; i < _poolSize(); i++) {
      const rec = { w: new Worker(_WORKER_URL), alive: true };
      rec.w.onmessage = (event) => {
        const msg = event.data || {};
        const p = _pending.get(msg.id);
        if (!p) return;
        _pending.delete(msg.id);
        if (msg.error) p.reject(_planeError('PLANES_DECODE', msg.error));
        else p.resolve(msg);
      };
      rec.w.onerror = (event) => {
        rec.alive = false;
        const err = _planeError('PLANES_DECODE', `plane decode worker failed: ${event && event.message || 'error'}`);
        for (const [id, p] of _pending) if (p.rec === rec) { _pending.delete(id); p.reject(err); }
      };
      _pool.push(rec);
    }
    return _pool;
  }

  function _post(rec, msg, transfer) {
    const id = ++_seq;
    return new Promise((resolve, reject) => {
      _pending.set(id, { resolve, reject, rec });
      try {
        rec.w.postMessage({ ...msg, id }, transfer || []);
      } catch (err) {
        _pending.delete(id);
        reject(err);
      }
    });
  }

  /** Terminates the decode workers (they are respawned on the next load). */
  function dispose() {
    if (_pool) _pool.forEach(r => { try { r.w.terminate(); } catch (e) { /* gone */ } });
    _pool = null;
    for (const [, p] of _pending) p.reject(_abortError());
    _pending.clear();
  }

  // ── Network ──────────────────────────────────────────────────────────────────

  async function _readBody(resp, onBytes, signal) {
    if (!resp.body || typeof resp.body.getReader !== 'function') {
      const buf = new Uint8Array(await resp.arrayBuffer());
      onBytes && onBytes(buf.length);
      return buf;
    }
    const reader = resp.body.getReader();
    const parts = [];
    let total = 0;
    for (;;) {
      if (signal && signal.aborted) {
        try { reader.cancel(); } catch (e) { /* closed */ }
        throw _abortError();
      }
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      total += value.length;
      onBytes && onBytes(value.length);
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  // ── A tree ───────────────────────────────────────────────────────────────────

  function _makeTree(base, manifest, stamp, kind = KIND_PLANES) {
    const C = manifest.channels;
    const TS = manifest.tileSize;
    const TX = manifest.tiles.x;
    const TY = manifest.tiles.y;
    const dims = { x: manifest.dimensions.x, y: manifest.dimensions.y, z: manifest.dimensions.z };
    const headerBytes = manifest.headerBytes;
    // Packs of the tree: one per plane z (planes/) or per layer l (mips/).
    const count = kind === KIND_MIPS ? manifest.layers : dims.z;
    const P = kind.prefix;
    const headers = new Map();       // z → Promise<{ offsets: Float64Array, lengths: Uint32Array }>
    const wholeFiles = new Map();    // z → Promise<Uint8Array> (a server without ranges)
    let rangeless = false;

    const packUrl = (z) => `${base}/${P}${String(z).padStart(5, '0')}.bin${stamp ? `?v=${stamp}` : ''}`;

    const checkZ = (z) => {
      if (!Number.isInteger(z) || z < 0 || z >= count) throw _planeError('PLANES_RANGE', `${kind.unit} ${z} outside 0..${count - 1}`);
    };

    /** Bytes [start, end) of pack z (a 200 answer: the whole pack, kept for this z). */
    async function fetchBytes(z, start, end, signal, onBytes) {
      if (rangeless) {
        const whole = await wholeFile(z, signal, onBytes);
        if (end > whole.length) throw _planeError('PLANES_SHORT', `pack ${P}${z} is ${whole.length} bytes, needs ${end}`);
        return whole.subarray(start, end);
      }
      const resp = await fetch(packUrl(z), { headers: { Range: `bytes=${start}-${end - 1}` }, signal });
      if (resp.status === 206) {
        const cr = resp.headers && typeof resp.headers.get === 'function' ? resp.headers.get('Content-Range') : null;
        const m = cr ? /bytes\s+(\d+)-(\d+)\//i.exec(cr) : null;
        if (m && (Number(m[1]) !== start || Number(m[2]) !== end - 1)) {
          throw _planeError('PLANES_RANGE', `pack ${P}${z}: asked bytes ${start}-${end - 1}, got ${cr}`);
        }
        const body = await _readBody(resp, onBytes, signal);
        if (body.length !== end - start) throw _planeError('PLANES_SHORT', `pack ${P}${z}: ${body.length} bytes for a ${end - start}-byte range`);
        return body;
      }
      if (resp.status === 200) {
        // The server ignored Range: this answer is the whole pack. Later reads of this
        // tree ask for whole packs and cut them, rather than being sent each one again
        // per run.
        rangeless = true;
        const p = _readBody(resp, onBytes, signal);
        wholeFiles.set(z, p);
        p.catch(() => wholeFiles.delete(z));
        const whole = await p;
        if (end > whole.length) throw _planeError('PLANES_SHORT', `pack ${P}${z} is ${whole.length} bytes, needs ${end}`);
        return whole.subarray(start, end);
      }
      throw _planeError('PLANES_HTTP', `pack ${P}${z}: HTTP ${resp.status}`);
    }

    function wholeFile(z, signal, onBytes) {
      let p = wholeFiles.get(z);
      if (!p) {
        p = fetch(packUrl(z), { signal }).then((resp) => {
          if (!resp.ok) throw _planeError('PLANES_HTTP', `pack ${P}${z}: HTTP ${resp.status}`);
          return _readBody(resp, onBytes, signal);
        });
        wholeFiles.set(z, p);
        p.catch(() => wholeFiles.delete(z));
        // Keep the last few only: a slab walks through z once.
        while (wholeFiles.size > 4) wholeFiles.delete(wholeFiles.keys().next().value);
      }
      return p;
    }

    /** The entry table of pack z, cached. */
    function header(z, opts = {}) {
      checkZ(z);
      let p = headers.get(z);
      if (p) return p;
      p = (async () => {
        const bytes = await fetchBytes(z, 0, headerBytes, opts.signal, opts.onBytes);
        const codec = _codec();
        if (!codec) throw _planeError('PLANES_NO_CODEC', 'PlaneCodec is not loaded');
        const h = _parseHeader(codec, bytes, kind.magic, `pack ${P}${z}`);
        if (h.channels !== C || h.tilesX !== TX || h.tilesY !== TY || h.z !== z) {
          throw _planeError('PLANES_INVALID', `pack ${P}${z} header (${h.channels} ch, ${h.tilesX}×${h.tilesY}, z ${h.z}) ≠ the manifest's`);
        }
        const offsets = new Float64Array(h.entries.length);
        const lengths = new Uint32Array(h.entries.length);
        h.entries.forEach((e, i) => {
          if (e.length > 0 && e.offset < headerBytes) throw _planeError('PLANES_INVALID', `pack ${P}${z}: tile ${i} overlaps the header`);
          offsets[i] = e.offset;
          lengths[i] = e.length;
        });
        return { offsets, lengths };
      })();
      headers.set(z, p);
      p.catch(() => headers.delete(z));
      if (headers.size > HEADER_CACHE_MAX) headers.delete(headers.keys().next().value);
      return p;
    }

    function normRect(rect) {
      const r = rect || {};
      const x0 = Math.max(0, Math.floor(Number(r.x0) || 0));
      const y0 = Math.max(0, Math.floor(Number(r.y0) || 0));
      const x1 = Math.min(dims.x, Math.floor(r.x1 == null ? dims.x : Number(r.x1)));
      const y1 = Math.min(dims.y, Math.floor(r.y1 == null ? dims.y : Number(r.y1)));
      if (!(x1 > x0 && y1 > y0)) throw _planeError('PLANES_RANGE', 'empty region');
      return { x0, y0, x1, y1 };
    }

    function normChannels(channels) {
      const list = Array.isArray(channels) ? channels : Array.from({ length: C }, (_, c) => c);
      if (!list.length) throw _planeError('PLANES_RANGE', 'no channel requested');
      for (const c of list) if (!Number.isInteger(c) || c < 0 || c >= C) throw _planeError('PLANES_RANGE', `channel ${c} outside 0..${C - 1}`);
      return list;
    }

    /**
     * Horizontal bands of whole tile rows covering `rect`, one per decode worker
     * (at most): [{ y0, y1, ty0, ty1 }] in image pixels / tile rows.
     */
    function bandsOf(r, count) {
      const ty0 = Math.floor(r.y0 / TS);
      const ty1 = Math.floor((r.y1 - 1) / TS);
      const rows = ty1 - ty0 + 1;
      const n = Math.max(1, Math.min(count, rows));
      const out = [];
      for (let i = 0; i < n; i++) {
        const a = ty0 + Math.floor((i * rows) / n);
        const b = ty0 + Math.floor(((i + 1) * rows) / n) - 1;
        out.push({ ty0: a, ty1: b, y0: Math.max(r.y0, a * TS), y1: Math.min(r.y1, (b + 1) * TS) });
      }
      return out;
    }

    /**
     * The tiles of `rect` × `channels` in pack z (non-empty ones as merged byte
     * runs): { tiles: [{ ch, tx, ty, x0, y0, w, h, off, len, run }], runs: [{ start,
     * end }], bytes }.
     */
    function plan(h, list, r) {
      const tx0 = Math.floor(r.x0 / TS), tx1 = Math.floor((r.x1 - 1) / TS);
      const ty0 = Math.floor(r.y0 / TS), ty1 = Math.floor((r.y1 - 1) / TS);
      const tiles = [];
      list.forEach((c, ch) => {
        for (let ty = ty0; ty <= ty1; ty++) {
          for (let tx = tx0; tx <= tx1; tx++) {
            const i = (c * TY + ty) * TX + tx;
            tiles.push({
              ch, tx, ty, x0: tx * TS, y0: ty * TS,
              w: Math.min(TS, dims.x - tx * TS), h: Math.min(TS, dims.y - ty * TS),
              off: h.offsets[i], len: h.lengths[i], run: -1
            });
          }
        }
      });
      const full = tiles.filter(t => t.len > 0).sort((a, b) => a.off - b.off);
      const runs = [];
      for (const t of full) {
        const last = runs[runs.length - 1];
        if (last && t.off - last.end <= RANGE_GAP_BYTES) last.end = Math.max(last.end, t.off + t.len);
        else runs.push({ start: t.off, end: t.off + t.len });
        t.run = runs.length - 1;
      }
      let bytes = 0;
      for (const run of runs) bytes += run.end - run.start;
      return { tiles, runs, bytes, nonEmpty: full.length };
    }

    /**
     * Fetches the runs of pack z for `rect` and hands each band's tiles to its
     * worker. `jobFor(bandIndex, band, msg, transfer)` posts the band and resolves
     * with the worker's answer. → [answers in band order]
     */
    async function dispatch(z, list, r, bands, opts, jobFor) {
      const signal = opts.signal;
      const h = await header(z, opts);
      _throwIfAborted(signal);
      const p = plan(h, list, r);
      const runBytes = await Promise.all(p.runs.map(run => fetchBytes(z, run.start, run.end, signal, opts.onBytes)));
      _throwIfAborted(signal);
      return Promise.all(bands.map((band, bi) => {
        const mine = p.tiles.filter(t => t.ty >= band.ty0 && t.ty <= band.ty1);
        // The band's tile bytes, packed in one buffer of its own (transferred).
        let size = 0;
        for (const t of mine) if (t.len > 0) size += t.len;
        const bytes = new Uint8Array(size);
        let o = 0;
        const tiles = mine.map((t) => {
          if (!(t.len > 0)) return { ch: t.ch, x0: t.x0, y0: t.y0, w: t.w, h: t.h, off: 0, len: 0 };
          const run = p.runs[t.run];
          bytes.set(runBytes[t.run].subarray(t.off - run.start, t.off - run.start + t.len), o);
          const out = { ch: t.ch, x0: t.x0, y0: t.y0, w: t.w, h: t.h, off: o, len: t.len };
          o += t.len;
          return out;
        });
        const msg = { op: 'decode', width: r.x1 - r.x0, height: band.y1 - band.y0, x0: r.x0, y0: band.y0, nch: list.length, tiles, bytes: bytes.buffer };
        return jobFor(bi, band, msg, [bytes.buffer]).then((answer) => {
          opts.onTiles && opts.onTiles(mine.filter(t => t.len > 0).length);
          return answer;
        });
      }));
    }

    /**
     * One plane z over `rect`, per requested channel (uint8, rows of rect width).
     *   opts.signal    AbortSignal
     *   opts.onBytes(n) bytes received (header and tiles), as they arrive
     *   opts.onTiles(n) non-empty tiles decoded
     *   opts.compose   { components, slots, luts }: one interleaved buffer instead
     *   opts.onBand(band) each band as it is decoded ({ y0, height, width, planes |
     *                   rgba }); with opts.bands the region is not joined (→ { bands })
     * → { width, height, channels, data: [Uint8Array] } | { width, height, rgba }
     */
    async function loadRegion(z, channels, rect, opts = {}) {
      checkZ(z);
      const list = normChannels(channels);
      const r = normRect(rect);
      _throwIfAborted(opts.signal);
      const pool = _workers();
      const bands = bandsOf(r, pool.length);
      const compose = composeSpec(opts.compose);
      const results = await dispatch(z, list, r, bands, opts, (bi, band, msg, transfer) =>
        _post(pool[bi % pool.length], { ...msg, mode: 'new', compose }, transfer).then((answer) => {
          _throwIfAborted(opts.signal);
          const out = _bandResult(band, r, answer, compose);
          opts.onBand && opts.onBand(out);
          return out;
        }));
      if (opts.bands) return { width: r.x1 - r.x0, height: r.y1 - r.y0, bands: results };
      return _joinBands(r, list, results, compose);
    }

    /**
     * The per-channel maximum over the planes `zs` of `rect` (a MIP slab), reduced
     * in the workers as the planes arrive. Same options and answer as loadRegion,
     * plus opts.concurrency (packs in flight, default 3) and opts.onPlane(done, total).
     * On a mips tree `zs` are layer indices: the maximum over those layers' MIPs.
     */
    async function loadRegionMax(zs, channels, rect, opts = {}) {
      const list = normChannels(channels);
      const r = normRect(rect);
      const planes = Array.from(new Set(Array.isArray(zs) ? zs : [])).sort((a, b) => a - b);
      if (!planes.length) throw _planeError('PLANES_RANGE', `no ${kind.unit} requested`);
      planes.forEach(checkZ);
      return _reduceMax(planes.map(z => ({ tree: self, index: z })), list, r, opts);
    }

    /**
     * Bytes a load of `zs` × `channels` × `rect` fetches (headers not yet cached
     * included). opts.sample = N reads the headers of N planes spread over `zs` and
     * scales (an estimate, `exact: false`). → { bytes, tiles, exact }
     */
    async function estimate(zs, channels, rect, opts = {}) {
      const list = normChannels(channels);
      const r = normRect(rect);
      const all = Array.from(new Set(Array.isArray(zs) ? zs : [])).sort((a, b) => a - b);
      all.forEach(checkZ);
      const n = Number(opts.sample) > 0 ? Math.min(all.length, Math.floor(opts.sample)) : all.length;
      const pick = n >= all.length ? all : Array.from({ length: n }, (_, i) => all[Math.floor(((i + 0.5) * all.length) / n)]);
      let bytes = 0;
      let tiles = 0;
      let next = 0;
      const lane = async () => {
        while (next < pick.length) {
          const z = pick[next++];
          const cached = headers.has(z);
          const p = plan(await header(z, opts), list, r);
          bytes += p.bytes + (cached ? 0 : headerBytes);
          tiles += p.nonEmpty;
        }
      };
      await Promise.all(Array.from({ length: Math.min(HEADER_FETCH_PARALLEL, pick.length) }, lane));
      const k = pick.length ? all.length / pick.length : 0;
      return { bytes: Math.round(bytes * k), tiles: Math.round(tiles * k), exact: pick.length === all.length };
    }

    const self = {
      kind: kind.kind, base, manifest, stamp, dimensions: dims, channels: C, tileSize: TS, tiles: { x: TX, y: TY }, headerBytes,
      header, loadRegion, loadRegionMax, estimate,
      isRangeless: () => rangeless,
      _dispatch: dispatch, _normRect: normRect, _normChannels: normChannels, _bandsOf: bandsOf
    };
    if (kind === KIND_MIPS) {
      self.layers = count;
      self.layerDepth = LAYER_DEPTH;
      /** The MIP of layer l over `rect` (the per-channel maximum over its planes); loadRegion's answer. */
      self.loadLayerMax = (l, channels, rect, opts = {}) => loadRegion(l, channels, rect, opts);
      /** The maximum over several layer MIPs; loadRegionMax's answer. */
      self.loadLayersMax = (ls, channels, rect, opts = {}) => loadRegionMax(ls, channels, rect, opts);
      /** planSlabMax(z0, z1) over this tree's depth. */
      self.planSlabMax = (z0, z1) => planSlabMax(z0, z1, dims.z);
    }
    return Object.freeze(self);
  }

  const composeSpec = (compose) => (compose ? {
    components: compose.components || 4,
    slots: Array.isArray(compose.slots) ? compose.slots.slice() : null,
    luts: Array.isArray(compose.luts) ? compose.luts.map(l => (l && l.length >= 256 ? l : null)) : null
  } : null);

  function _bandResult(band, r, answer, compose) {
    const out = { y0: band.y0, height: band.y1 - band.y0, width: r.x1 - r.x0 };
    if (compose) out.rgba = new Uint8Array(answer.rgba);
    else out.planes = answer.planes.map(b => new Uint8Array(b));
    return out;
  }

  /** Joins band results into one region ({ data: [per channel] } or { rgba }). */
  function _joinBands(r, list, bands, compose) {
    const W = r.x1 - r.x0, H = r.y1 - r.y0;
    if (bands.length === 1) {
      const b = bands[0];
      return compose ? { width: W, height: H, rgba: b.rgba } : { width: W, height: H, channels: list, data: b.planes };
    }
    if (compose) {
      const comps = compose.components || 4;
      const rgba = new Uint8Array(W * H * comps);
      for (const b of bands) rgba.set(b.rgba, (b.y0 - r.y0) * W * comps);
      return { width: W, height: H, rgba };
    }
    const data = list.map(() => new Uint8Array(W * H));
    for (const b of bands) b.planes.forEach((p, i) => data[i].set(p, (b.y0 - r.y0) * W));
    return { width: W, height: H, channels: list, data };
  }

  /**
   * The per-channel maximum over `items` = [{ tree, index }] (planes of a planes tree,
   * layers of a mips tree — trees of one geometry), reduced in the workers' band
   * accumulators as each pack's tiles arrive. The maximum is order-free, so planes and
   * layer MIPs mix freely.
   */
  async function _reduceMax(items, list, r, opts = {}) {
    _throwIfAborted(opts.signal);
    const pool = _workers();
    const bands = items[0].tree._bandsOf(r, pool.length);
    const compose = composeSpec(opts.compose);
    const job = `max${++_seq}`;
    const keyOf = (bi) => `${job}:${bi}`;
    const drop = () => bands.forEach((_, bi) => {
      try { pool[bi % pool.length].w.postMessage({ op: 'drop', key: keyOf(bi) }); } catch (e) { /* gone */ }
    });
    try {
      let next = 0;
      let done = 0;
      let failed = false;
      const lane = async () => {
        try {
          while (next < items.length && !failed) {
            const item = items[next++];
            await item.tree._dispatch(item.index, list, r, bands, opts, (bi, band, msg, transfer) =>
              _post(pool[bi % pool.length], { ...msg, mode: 'max', key: keyOf(bi) }, transfer));
            _throwIfAborted(opts.signal);
            done++;
            opts.onPlane && opts.onPlane(done, items.length);
          }
        } catch (err) {
          failed = true;   // the other lanes stop at their next pack
          throw err;
        }
      };
      const lanes = Math.max(1, Math.min(items.length, Math.floor(Number(opts.concurrency) || 3)));
      await Promise.all(Array.from({ length: lanes }, lane));
      const results = await Promise.all(bands.map((band, bi) =>
        _post(pool[bi % pool.length], { op: 'take', key: keyOf(bi), compose }).then((answer) => {
          _throwIfAborted(opts.signal);
          const out = _bandResult(band, r, answer, compose);
          opts.onBand && opts.onBand(out);
          return out;
        })));
      if (opts.bands) return { width: r.x1 - r.x0, height: r.y1 - r.y0, bands: results };
      return _joinBands(r, list, results, compose);
    } catch (err) {
      drop();
      throw err;
    }
  }

  /**
   * How a z-stack MIP over the planes [z0, z1) of a volume `depth` planes deep splits
   * between layer MIPs and planes (SPEC §12): the layers lying wholly inside the slab
   * (layer l = planes [64·l, min(64·l + 64, depth))) and the planes of the partial
   * layers at both ends. The maximum over `layers` ∪ `planes` is the maximum over every
   * plane of the slab — valid only when the slab samples every plane.
   * → { layers: [l…], planes: [z…] }, both ascending.
   */
  function planSlabMax(z0, z1, depth) {
    const D = Math.floor(Number(depth));
    if (!(Number.isInteger(D) && D > 0)) throw _planeError('PLANES_RANGE', `bad volume depth ${depth}`);
    const a = Math.max(0, Math.floor(Number(z0)));
    const b = Math.min(D, Math.floor(Number(z1)));
    if (!(Number.isFinite(a) && Number.isFinite(b)) || b <= a) throw _planeError('PLANES_RANGE', `empty slab [${z0}, ${z1})`);
    const layers = [];
    const planes = [];
    for (let z = a; z < b;) {
      const l0 = Math.floor(z / LAYER_DEPTH) * LAYER_DEPTH;
      const l1 = Math.min(l0 + LAYER_DEPTH, D);
      if (z === l0 && l1 <= b) {
        layers.push(l0 / LAYER_DEPTH);
        z = l1;
      } else {
        const end = Math.min(l1, b);
        for (; z < end; z++) planes.push(z);
      }
    }
    return { layers, planes };
  }

  /**
   * The per-channel MIP over the planes [z0, z1) of `rect`: the layer MIPs (`mips`, a
   * tree from openMips) of the layers wholly inside the slab and the planes (`planes`,
   * a tree from open) of the partial layers at its ends — pixel-identical to
   * planes.loadRegionMax(every z of the slab). With mips null, every plane.
   * Same options and answer as loadRegionMax (onPlane counts packs read).
   */
  async function loadSlabMax(planes, mips, z0, z1, channels, rect, opts = {}) {
    if (!planes || planes.kind !== 'planes') throw _planeError('PLANES_RANGE', 'no planes tree');
    const depth = planes.dimensions.z;
    let plan = planSlabMax(z0, z1, depth);
    if (mips) {
      const same = mips.kind === 'mips' && mips.channels === planes.channels && mips.tileSize === planes.tileSize
        && ['x', 'y', 'z'].every(k => mips.dimensions[k] === planes.dimensions[k]);
      if (!same) throw _planeError('MIPS_INVALID', 'mips/ and planes/ describe different volumes');
    } else {
      const every = [];
      for (const l of plan.layers) for (let z = l * LAYER_DEPTH; z < Math.min(l * LAYER_DEPTH + LAYER_DEPTH, depth); z++) every.push(z);
      plan = { layers: [], planes: [...every, ...plan.planes].sort((x, y) => x - y) };
    }
    const list = planes._normChannels(channels);
    const r = planes._normRect(rect);
    const items = [
      ...plan.layers.map(l => ({ tree: mips, index: l })),
      ...plan.planes.map(z => ({ tree: planes, index: z }))
    ];
    return _reduceMax(items, list, r, opts);
  }

  /**
   * Opens the planes tree at `base` (the `planes/` directory, or `planes/tNNN` of a
   * timepoint).
   *   options.dimensions        the bricks' LOD0 {x, y, z} (must match)
   *   options.channels          the bricks' channel count (must match)
   *   options.sourceManifestUrl the bricks manifest the planes were cut from: its
   *                             sha256 must equal source.manifestSha256
   *   options.signal
   * → a tree (see the header) | throws (code PLANES_INVALID / PLANES_HTTP / …)
   */
  async function open(base, options = {}) {
    return _openTree(base, options, KIND_PLANES);
  }

  /**
   * Opens the format-3 layer-MIP tree at `base` (`mips/`, or `mips/tNNN` of a
   * timepoint), with the same options and checks as open() (code MIPS_INVALID for a
   * manifest that is not one, PLANES_STALE when cut from another bricks manifest).
   * → a mips tree: the tree API of open() over layer indices, plus layers, layerDepth,
   *   loadLayerMax(l, channels, rect, opts), loadLayersMax(ls, …), planSlabMax(z0, z1).
   */
  async function openMips(base, options = {}) {
    return _openTree(base, options, KIND_MIPS);
  }

  async function _openTree(base, options, kind) {
    const mips = kind === KIND_MIPS;
    const file = mips ? 'mips/manifest.json' : 'planes/manifest.json';
    const code = mips ? 'MIPS_INVALID' : 'PLANES_INVALID';
    const root = String(base || '').replace(/\/+$/, '');
    if (!root) throw _planeError(code, `no ${kind.kind} base`);
    if (!_codec()) throw _planeError('PLANES_NO_CODEC', 'PlaneCodec is not loaded');
    const resp = await fetch(`${root}/manifest.json`, { cache: 'no-cache', signal: options.signal });
    if (!resp.ok) throw _planeError('PLANES_HTTP', `${kind.kind} manifest: HTTP ${resp.status}`);
    const text = await resp.text();
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch (e) {
      throw _planeError(code, `${file} is not JSON`);
    }
    const expect = { dimensions: options.dimensions, channels: options.channels };
    if (mips) validateMipsManifest(manifest, expect);
    else validateManifest(manifest, expect);
    if (options.sourceManifestUrl) {
      // The copy the viewer itself read: the HTTP cache holds it.
      const src = await fetch(options.sourceManifestUrl, { cache: 'force-cache', signal: options.signal });
      if (!src.ok) throw _planeError('PLANES_HTTP', `bricks manifest: HTTP ${src.status}`);
      const digest = await sha256Hex(new Uint8Array(await src.arrayBuffer()));
      if (digest !== manifest.source.manifestSha256) {
        throw _planeError('PLANES_STALE', `${kind.kind}/ was cut from another bricks manifest (dataset re-processed since)`);
      }
    }
    return _makeTree(root, manifest, _fnv1a(text), kind);
  }

  return {
    open, openMips, validateManifest, validateMipsManifest, planSlabMax, loadSlabMax,
    sha256Hex, dispose, LAYER_DEPTH, _sha256Js, _fnv1a
  };
})();
