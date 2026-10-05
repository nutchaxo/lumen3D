/* ============================================================
   IRIBHM Microscopy Platform — Brick Loader
   ============================================================
   Streams 64³ volume bricks out of the packs described by a dataset's
   brick manifest (bricks/manifest.json) and hands them, decoded, to the
   caller. Nothing decoded is cached here: the GPU atlas is where bricks
   live once loaded. What is held is the COMPRESSED bytes of the packs a
   running batch still needs, under a byte budget.

   Vocabulary
   - mount: one manifest + the URL it is served from (one timepoint of a
     timelapse is its own mount). A batch keeps the mount it started on,
     so a timepoint or quality switch never redirects its requests.
   - batch: one loadBrickTasks() call. It owns its cancellation (its own
     AbortController, optionally an external AbortSignal), its decode jobs
     in the worker pool, and reports every task it could not deliver.
   - source: the bytes a brick is cut from — a whole pack, or a byte run
     of it asked with a Range header (`byteRanges`). Sources are shared
     between batches and reference-counted by the tasks still to read
     them: a source no live task needs is aborted while in flight and
     dropped once landed.

   Two tree formats, told apart by the manifest's schema:
   - v2: per-brick `brickToPack` entries in the manifest, 64³ bricks in
     8 × 8 mosaics of 64², init() mounts at once.
   - v3 (DOCS/dataset-migrations/SPEC.md §13): `iribhm-bricks-v3`, a binary
     `index.bin` (checked against the manifest's length and sha256) located in
     O(1) per brick, packs `l{k}/c{c}/pNNNNN.bin?v=<12 hex of its sha256>`,
     66³ bricks (64³ + a 1-voxel border) in 9 × 8 mosaics of 66². init()
     returns a promise and mounts once the index has landed; getFormat() tells
     the caller which frame (stride 64 or 66) the delivered bricks are in.
   The runs of one pack a batch asks with Range are coalesced into multi-range
   requests (multipart/byteranges) on v3 trees (configure({ multiRange })).
   ============================================================ */

const BrickLoader = (() => {
  // Real bricks are 64³ (preprocess/3-chunk_packer.py: BRICK_SIZE=64, mosaicked 8×8
  // into 512² tiles). The decoder, the SVR atlas and both shaders are built on it; a
  // manifest declaring another size is rejected rather than mounted scrambled.
  const BRICK_SIZE = 64;
  const MiB = 1024 * 1024;
  const DEFAULT_CONCURRENT_LOADS = 24;
  // Pack bodies in flight at once. A browser opens at most six HTTP/1.1 connections
  // to a host and queues the rest in arrival order, the page's own calls included:
  // with every socket busy on a pack body, the admin panel's next request (the list,
  // the metadata of the dataset just clicked) waited for whole packs to land. Four
  // slots leave two sockets free; a bandwidth-bound link gains nothing from more
  // parallel bodies, and decoding — not the fetch — is what the loads above run.
  const DEFAULT_PACK_FETCH_SLOTS = 4;
  // Landed compressed bytes kept in memory. A pack (4–24 MB on the reference data)
  // is held only while a running batch still has bricks to cut from it; these
  // budgets bound the total when the batches in flight need more than that.
  const DEFAULT_PACK_CACHE_BYTES = 192 * MiB;
  const DEFAULT_RANGE_CACHE_BYTES = 64 * MiB;
  // Packs warmed for a timepoint that is not mounted yet (prefetchPacks).
  const DEFAULT_PREFETCH_CACHE_BYTES = 32 * MiB;
  // How far ahead of the task being decoded a batch asks for its next sources, so
  // the network keeps working while a pack's bricks decode.
  const DEFAULT_LOOKAHEAD_BYTES = 64 * MiB;
  // A decode job unanswered this long means a hung worker: it is replaced and its
  // jobs are retried. A pack body that receives nothing this long is aborted.
  const DEFAULT_DECODE_TIMEOUT_MS = 30000;
  const DEFAULT_FETCH_STALL_MS = 30000;
  const RETRY_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 500;
  const MAX_WORKER_RESPAWNS = 3;
  // Byte-range fetching (loadBrickTasks `byteRanges`): a cut through the volume needs
  // a few bricks of many packs — on the reference dataset an XZ cut needs 21 MB of
  // tiles spread over 157 MB of packs, a YZ cut 24 MB over 572 MB — so the runs the
  // batch really needs are asked with a Range header instead of whole packs. Runs
  // closer than RANGE_GAP_BYTES are merged (the gap is cheaper than a request); a
  // pack whose runs would still cover most of it, or need too many requests, is
  // fetched whole (an XY cut needs 93 % of its packs and stays as it was).
  const RANGE_GAP_BYTES = 512 * 1024;
  const RANGE_MAX_RUNS_PER_PACK = 48;
  const RANGE_WHOLE_PACK_FRACTION = 0.6;
  // Multi-range requests (`Range: bytes=a-b, c-d, …`): the runs of one pack asked
  // together in ONE request, answered as multipart/byteranges. An XZ/YZ cut through a
  // v3 tree reads one small run per brick of hundreds of packs; one request per pack
  // instead of per run is what keeps it from queueing behind the socket limit. A part
  // costs ~100 bytes of headers, so runs are merged only across small gaps. Caps keep
  // the Range header under the 8 KB request-line/header limit of common servers.
  const MULTI_RANGE_GAP_BYTES = 32 * 1024;
  const MULTI_RANGE_MAX_RUNS_PER_PACK = 512;
  const MULTI_RANGE_MAX_PARTS = 64;
  const MULTI_RANGE_MAX_HEADER = 8000;

  // ── Brick tree v3 (DOCS/dataset-migrations/SPEC.md §13) ──────────────────────
  // Bricks of 64³ interior stored with a 1-voxel border (apron) as 66³, the 66 slices
  // of 66² laid 9 columns × 8 rows (594 × 528, the last 6 slots empty), one WebP
  // lossless image per brick and channel; a binary index locates every brick.
  const V3_SCHEMA = 'iribhm-bricks-v3';
  const V3_APRON = 1;
  const V3_STRIDE = BRICK_SIZE + 2 * V3_APRON;      // 66
  const V3_COLS = 9;
  const V3_ROWS = 8;
  const V3_INDEX_MAGIC = 'LBIX';
  const V3_INDEX_HEAD = 12;                         // magic, u16 version, levels, channels, reserved
  const V3_LEVEL_HEAD = 16;                         // u32 gridX, gridY, gridZ, packCount
  const V3_ENTRY = 10;                              // u16 pack, u32 offset, u32 length
  const V3_MAX_BRICK_BYTES = 16 * MiB;              // a pack is ≤ 16 MiB, so is a brick
  const V3_INDEX_CACHE = 16;

  // The worker script carries the platform's own cache-busting stamp (the `?v=` of
  // this script's tag), so a release reloads it and a dataset switch does not.
  const _WORKER_URL = (() => {
    const base = 'js/core/brick-decode-worker.js';
    try {
      const src = typeof document !== 'undefined' && document.currentScript ? document.currentScript.src : '';
      const m = /[?&]v=([^&#]+)/.exec(src || '');
      return m ? `${base}?v=${m[1]}` : base;
    } catch (e) {
      return base;
    }
  })();

  const _settings = {
    concurrentLoads: DEFAULT_CONCURRENT_LOADS,
    packFetchSlots: DEFAULT_PACK_FETCH_SLOTS,
    packCacheBytes: DEFAULT_PACK_CACHE_BYTES,
    rangeCacheBytes: DEFAULT_RANGE_CACHE_BYTES,
    prefetchCacheBytes: DEFAULT_PREFETCH_CACHE_BYTES,
    lookaheadBytes: DEFAULT_LOOKAHEAD_BYTES,
    decodeTimeoutMs: DEFAULT_DECODE_TIMEOUT_MS,
    fetchStallMs: DEFAULT_FETCH_STALL_MS,
    decodeWorkers: 0,          // 0 = min(8, cores − 1)
    verifyHashes: false,
    multiRange: 'auto'         // 'auto' (v3 trees) | 'on' (every tree) | 'off'
  };

  let _mount = null;
  let _initSeq = 0;
  let _pendingInit = null;     // a v3 mount waiting for its index
  let _datasetEpoch = 0;       // bumped on a real dataset switch
  let _batchSeq = 0;
  const _batches = new Set();

  // Sources. key = absolute pack URL (whole pack) or `${url}#${start}-${end}` (run).
  const _store = new Map();
  const _runsByPack = new Map();        // absolute pack url -> Set<run entry>
  const _packRefs = new Map();          // absolute pack url -> planned tasks still to read it
  const _runRefs = new Map();           // run key -> planned tasks still to read it
  const _bytes = { pack: 0, run: 0 };   // landed bytes held, per kind
  const _rangeUnsupportedHosts = new Set();
  const _rangeSupportedHosts = new Set();
  const _rangeProbes = new Map();         // host -> promise of its first range answer
  const _multiRangeBadHosts = new Set();  // hosts whose multi-range answers could not be used
  const _runGroups = new Map();           // absolute pack url -> run request waiting for a slot
  const _stats = { packFetches: 0, runFetches: 0, fetchedBytes: 0, refetches: 0, evictedInUse: 0 };
  const _fetchedOnce = new Set();       // keys fetched in this dataset (re-download counter)

  let _workerSeq = 0;
  let _workers = [];                    // { w, alive, inflight, respawns }
  const _workerPending = new Map();     // id -> { rec, batchId, resolve, reject, timer, signal, onAbort }
  let _fallbackCanvas = null;
  let _fallbackCtx = null;
  let _fallbackWarned = false;

  const _supportsWebGL3D = (() => {
    try {
      return !!document.createElement('canvas').getContext('webgl2');
    } catch { return false; }
  })();

  const _now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const _abortError = (msg = 'Brick loading cancelled') => new DOMException(msg, 'AbortError');

  // ── Fetch slots: foreground first, background (prefetch) only when idle ──────
  let _fetchSlotsBusy = 0;
  const _fgWaiters = [];
  const _bgWaiters = [];

  function _drainFetchSlots() {
    while (_fetchSlotsBusy < _settings.packFetchSlots && (_fgWaiters.length || _bgWaiters.length)) {
      _fetchSlotsBusy++;
      (_fgWaiters.length ? _fgWaiters : _bgWaiters).shift().start();
    }
  }

  function _releaseFetchSlot() {
    _fetchSlotsBusy = Math.max(0, _fetchSlotsBusy - 1);
    _drainFetchSlots();
  }

  /**
   * Runs `request` (it returns the promise of a fetched body) once a pack-fetch slot
   * is free, foreground requests in order of arrival before any background one; the
   * slot is held until the body has landed. An abort of `signal` while still waiting
   * rejects at once and leaves the queue.
   */
  function _withFetchSlot(request, signal, background = false) {
    if (signal?.aborted) return Promise.reject(_abortError('Aborted'));
    let acquired;
    if (_fetchSlotsBusy < _settings.packFetchSlots && (!background || !_fgWaiters.length)) {
      _fetchSlotsBusy++;
      acquired = Promise.resolve();
    } else {
      const queue = background ? _bgWaiters : _fgWaiters;
      acquired = new Promise((resolve, reject) => {
        const waiter = { start: () => { signal?.removeEventListener('abort', onAbort); resolve(); } };
        const onAbort = () => {
          const i = queue.indexOf(waiter);
          if (i >= 0) queue.splice(i, 1);
          reject(_abortError('Aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        queue.push(waiter);
      });
    }
    return acquired.then(() => Promise.resolve().then(request).finally(_releaseFetchSlot));
  }

  // ELE-21 (Rule 1.4): encodages que le décodeur sait traiter.
  const _KNOWN_ENCODINGS = new Set(['raw-u8', 'raw-u8-gzip', 'raw-rgba-gzip', 'webp-lossless']);

  // SEC-017 (Rule 1.4): une URL de pack vient du manifest et est concaténée telle
  // quelle sur le basePath du dataset puis fetchée. On refuse toute URL pouvant
  // s'échapper du répertoire dataset : segment '..', URL absolue (scheme:) ou
  // protocole-relative (//host). Les coords bx/by/bz sont dérivées d'entiers (pas de
  // chaîne utilisateur) — seul l'URL issue du manifest est un vecteur.
  function _isSafePackUrl(u) {
    const s = String(u == null ? '' : u).trim();
    if (!s) return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return false;   // scheme: (http:, file:, data:, …)
    if (s.startsWith('//')) return false;               // protocole-relative
    return !s.replace(/^\/+/, '').split(/[\\/]/).includes('..');
  }

  // The pack-URL scan of a 72 k-entry brickToPack is the costly part of validation:
  // done once per transport object (a timelapse frame shares its row's object).
  const _safeTransports = new WeakSet();

  /**
   * ELE-21 (Rule 1.4): valide la structure minimale d'un manifest AVANT montage.
   * Throw explicite si malformé -> rejet propre plutôt qu'un TypeError opaque plus loin.
   * N'inspecte PAS nonEmpty/occupiedRatio : une brick vide (ESS) est un état légitime.
   */
  function _validateManifest(manifest) {
    const reject = (msg) => { throw new Error('[BrickLoader] Manifest rejected: ' + msg); };
    if (!manifest || typeof manifest !== 'object') reject('manifest is not an object.');
    if (_isV3(manifest)) { _validateManifestV3(manifest, reject); return; }
    if (!Array.isArray(manifest.levels) || manifest.levels.length === 0) reject('levels must be a non-empty array.');
    if (manifest.channels !== undefined && !(Number.isInteger(manifest.channels) && manifest.channels >= 1)) {
      reject('channels must be an integer >= 1.');
    }
    if (manifest.brickSize !== undefined && manifest.brickSize !== BRICK_SIZE) {
      reject('brickSize must be ' + BRICK_SIZE + ' (the decoder, the atlas and the shaders are built on it).');
    }
    manifest.levels.forEach((level, i) => {
      if (!level || typeof level !== 'object') reject('level[' + i + '] is not an object.');
      if (!Number.isInteger(level.level) || level.level < 0) reject('level[' + i + '].level must be a non-negative integer.');
      // A level is addressed by its number everywhere (pack paths lod<N>/, the quality
      // ladder); an array out of order would mount one level's bricks as another's.
      if (level.level !== i) reject('level[' + i + '].level must be ' + i + ' (levels listed in order).');
      const d = level.dimensions;
      if (!d || typeof d !== 'object') reject('level[' + i + '].dimensions is missing.');
      for (const axis of ['x', 'y', 'z']) {
        if (!(Number.isFinite(d[axis]) && d[axis] > 0)) reject('level[' + i + '].dimensions.' + axis + ' must be a positive number.');
      }
      if (level.brickSize !== undefined && level.brickSize !== BRICK_SIZE) {
        reject('level[' + i + '].brickSize must be ' + BRICK_SIZE + '.');
      }
    });
    const enc = manifest.brickTransport && manifest.brickTransport.encoding;
    if (enc !== undefined && enc !== null && !_KNOWN_ENCODINGS.has(enc)) {
      reject('unknown brickTransport.encoding "' + enc + '".');
    }
    // BUG-065 (Rule 1.4): un packing absent ne vaut PAS 'vertical' (décoder une mosaïque
    // grid en lecture linéaire mélangeait le volume en silence). Si présent, mode ∈
    // {grid, vertical} ; un dataset webp-lossless DOIT porter un grid valide.
    const bp = manifest.brickPacking;
    if (bp !== undefined && bp !== null) {
      if (typeof bp !== 'object' || (bp.mode !== 'grid' && bp.mode !== 'vertical')) {
        reject('brickPacking.mode must be "grid" or "vertical".');
      }
      if (bp.mode === 'grid') {
        for (const k of ['cols', 'rows']) {
          if (bp[k] !== undefined && !(Number.isInteger(bp[k]) && bp[k] >= 1)) {
            reject('brickPacking.' + k + ' must be a positive integer.');
          }
        }
      }
    }
    if (enc === 'webp-lossless' && !(bp && bp.mode === 'grid')) {
      reject('webp-lossless requires brickPacking.mode "grid".');
    }
    // SEC-017 (Rule 1.4): rejet du manifest si une URL de pack peut s'échapper du dataset.
    const transport = manifest.brickTransport;
    const b2p = transport && transport.brickToPack;
    if (b2p && typeof b2p === 'object' && !_safeTransports.has(transport)) {
      for (const entry of Object.values(b2p)) {
        if (entry && entry.url !== undefined && !_isSafePackUrl(entry.url)) {
          reject('brickTransport.brickToPack contains an unsafe pack url "' + entry.url + '".');
        }
      }
      _safeTransports.add(transport);
    }
  }

  /** A v3 tree is told by its schema (SPEC §13.7); anything else is read as v2. */
  function _isV3(manifest) {
    return Boolean(manifest) && (manifest.schema === V3_SCHEMA || manifest.version === 3);
  }

  const _gridOf = (n) => Math.ceil(n / BRICK_SIZE);

  /** SPEC §13.3: the manifest of a v3 tree, every field the reader relies on. */
  function _validateManifestV3(m, reject) {
    if (m.schema !== V3_SCHEMA) reject(`schema must be "${V3_SCHEMA}" for a version-3 tree.`);
    if (m.version !== 3) reject('version must be 3.');
    if (!(Number.isInteger(m.channels) && m.channels >= 1 && m.channels <= 0xFFFF)) reject('channels must be an integer in 1..65535.');
    if (m.brickSize !== BRICK_SIZE) reject('brickSize must be ' + BRICK_SIZE + '.');
    if (m.apron !== V3_APRON) reject('apron must be ' + V3_APRON + '.');
    const bp = m.brickPacking;
    if (!bp || bp.mode !== 'grid' || bp.cols !== V3_COLS || bp.rows !== V3_ROWS || bp.slice !== V3_STRIDE) {
      reject(`brickPacking must be {"mode":"grid","cols":${V3_COLS},"rows":${V3_ROWS},"slice":${V3_STRIDE}}.`);
    }
    if (m.encoding !== 'webp-lossless') reject('encoding must be "webp-lossless".');
    if (!Array.isArray(m.levels) || m.levels.length === 0 || m.levels.length > 0xFFFF) reject('levels must be a non-empty array.');
    m.levels.forEach((level, i) => {
      if (!level || typeof level !== 'object') reject('level[' + i + '] is not an object.');
      if (level.level !== i) reject('level[' + i + '].level must be ' + i + ' (levels listed in order).');
      const d = level.dimensions;
      const g = level.gridSize;
      if (!d || typeof d !== 'object') reject('level[' + i + '].dimensions is missing.');
      if (!g || typeof g !== 'object') reject('level[' + i + '].gridSize is missing.');
      for (const axis of ['x', 'y', 'z']) {
        if (!(Number.isInteger(d[axis]) && d[axis] > 0)) reject('level[' + i + '].dimensions.' + axis + ' must be a positive integer.');
        if (g[axis] !== _gridOf(d[axis])) reject('level[' + i + '].gridSize.' + axis + ' must be ceil(dimensions/' + BRICK_SIZE + ') = ' + _gridOf(d[axis]) + '.');
      }
      const v = level.voxelSize;
      if (v !== undefined && v !== null) {
        for (const axis of ['x', 'y', 'z']) {
          if (!(Number.isFinite(v[axis]) && v[axis] > 0)) reject('level[' + i + '].voxelSize.' + axis + ' must be a positive number.');
        }
      }
    });
    const ix = m.index;
    if (!ix || typeof ix !== 'object') reject('index is missing.');
    if (!_isSafePackUrl(ix.url)) reject('index.url is not a safe relative url.');
    if (!(Number.isInteger(ix.bytes) && ix.bytes > 0)) reject('index.bytes must be a positive integer.');
    if (typeof ix.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(ix.sha256)) reject('index.sha256 must be a sha256 hex digest.');
    if (m.timepoints !== undefined && m.timepoints !== null && !Array.isArray(m.timepoints)) reject('timepoints must be null or an array.');
  }

  // ── v3 binary index ───────────────────────────────────────────────────────────
  const _v3IndexCache = new Map();   // absolute index url -> Promise<parsed index>

  function _v3PackRel(k, c, p) {
    return `l${k}/c${c}/p${String(p).padStart(5, '0')}.bin`;
  }

  function _v3IndexError(msg) {
    return Object.assign(new Error('[BrickLoader] index.bin rejected: ' + msg), { fatal: true, code: 'BRICKS_INDEX_INVALID' });
  }

  /**
   * SPEC §13.3 `index.bin`: "LBIX", u16 version 1, u16 levels, u16 channels, u16
   * reserved; per level u32 gridX, gridY, gridZ, packCount; then per level, per
   * channel, per brick in (bz, by, bx) order { u16 pack, u32 offset, u32 length }.
   * The pack names are implicit (l{k}/c{c}/pNNNNN.bin), so the file is exactly that
   * long. Checked against the manifest: level and channel counts, every level's grid,
   * every stored brick's pack number (< packCount) and size. Returns the lookup
   * tables: the raw entries (read in place), the per-level occupancy union over
   * channels and every pack's size (the end of its last brick).
   */
  function _parseV3Index(bytes, manifest) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u8.length < V3_INDEX_HEAD) throw _v3IndexError(`${u8.length} bytes, shorter than its header`);
    for (let i = 0; i < 4; i++) {
      if (u8[i] !== V3_INDEX_MAGIC.charCodeAt(i)) throw _v3IndexError('bad magic');
    }
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const version = dv.getUint16(4, true);
    const L = dv.getUint16(6, true);
    const C = dv.getUint16(8, true);
    if (version !== 1) throw _v3IndexError(`version ${version} ≠ 1`);
    if (L !== manifest.levels.length) throw _v3IndexError(`${L} levels ≠ the manifest's ${manifest.levels.length}`);
    if (C !== manifest.channels) throw _v3IndexError(`${C} channels ≠ the manifest's ${manifest.channels}`);
    if (u8.length < V3_INDEX_HEAD + V3_LEVEL_HEAD * L) throw _v3IndexError('truncated level table');
    const levels = [];
    let at = V3_INDEX_HEAD + V3_LEVEL_HEAD * L;
    for (let k = 0; k < L; k++) {
      const p = V3_INDEX_HEAD + V3_LEVEL_HEAD * k;
      const nx = dv.getUint32(p, true), ny = dv.getUint32(p + 4, true), nz = dv.getUint32(p + 8, true);
      const packCount = dv.getUint32(p + 12, true);
      const ml = manifest.levels[k];
      if (nx !== ml.gridSize.x || ny !== ml.gridSize.y || nz !== ml.gridSize.z) {
        throw _v3IndexError(`level ${k} grid ${nx}×${ny}×${nz} ≠ the manifest's ${ml.gridSize.x}×${ml.gridSize.y}×${ml.gridSize.z}`);
      }
      const slots = nx * ny * nz;
      levels.push({ k, nx, ny, nz, slots, packCount, base: at, dims: ml.dimensions, voxelSize: ml.voxelSize || null });
      at += V3_ENTRY * C * slots;
    }
    if (u8.length !== at) throw _v3IndexError(`${u8.length} bytes ≠ ${at} for the levels' grids`);
    const packSizes = new Map();   // pack rel url -> bytes
    for (const lv of levels) {
      const bits = new Uint8Array(lv.slots);
      let count = 0;
      for (let c = 0; c < C; c++) {
        const base = lv.base + V3_ENTRY * c * lv.slots;
        let lastPack = -1, lastRel = '', lastEnd = 0;
        for (let i = 0; i < lv.slots; i++) {
          const e = base + V3_ENTRY * i;
          const length = dv.getUint32(e + 6, true);
          if (length === 0) continue;
          const pack = dv.getUint16(e, true);
          const offset = dv.getUint32(e + 2, true);
          if (pack >= lv.packCount) throw _v3IndexError(`level ${lv.k} channel ${c} brick ${i}: pack ${pack} ≥ packCount ${lv.packCount}`);
          if (length > V3_MAX_BRICK_BYTES) throw _v3IndexError(`level ${lv.k} channel ${c} brick ${i}: ${length} bytes`);
          if (pack !== lastPack) {
            if (lastPack >= 0 && lastEnd > (packSizes.get(lastRel) || 0)) packSizes.set(lastRel, lastEnd);
            lastPack = pack; lastRel = _v3PackRel(lv.k, c, pack); lastEnd = packSizes.get(lastRel) || 0;
          }
          if (offset + length > lastEnd) lastEnd = offset + length;
          if (!bits[i]) { bits[i] = 1; count++; }
        }
        if (lastPack >= 0 && lastEnd > (packSizes.get(lastRel) || 0)) packSizes.set(lastRel, lastEnd);
      }
      lv.bits = bits;
      lv.count = count;
    }
    return { u8, dv, channels: C, levels, packSizes };
  }

  /** One brick's location in a parsed v3 index, or null (absent ⇒ zeros). O(1). */
  function _v3Lookup(index, k, c, bx, by, bz) {
    const lv = index.levels[k];
    if (!lv || !(c >= 0 && c < index.channels)) return null;
    if (!(bx >= 0 && bx < lv.nx && by >= 0 && by < lv.ny && bz >= 0 && bz < lv.nz)) return null;
    const e = lv.base + V3_ENTRY * (c * lv.slots + (bz * lv.ny + by) * lv.nx + bx);
    const length = index.dv.getUint32(e + 6, true);
    if (!length) return null;
    return { url: _v3PackRel(k, c, index.dv.getUint16(e, true)), offset: index.dv.getUint32(e + 2, true), length };
  }

  /** SHA-256 hex of `bytes`: PlaneLoader's (crypto.subtle, else its FIPS 180-4 JS digest), else crypto.subtle. */
  async function _sha256HexAny(bytes) {
    if (typeof PlaneLoader !== 'undefined' && PlaneLoader && typeof PlaneLoader.sha256Hex === 'function') {
      return PlaneLoader.sha256Hex(bytes);
    }
    if (typeof crypto !== 'undefined' && crypto && crypto.subtle) return _sha256Hex(bytes);
    throw _v3IndexError('no SHA-256 implementation available to verify it');
  }

  /**
   * The parsed index of the v3 tree at `basePath` (fetched once per url + sha256):
   * its length must be `index.bytes` and its sha256 `index.sha256`.
   */
  function _loadV3Index(basePath, manifest, signal) {
    const ix = manifest.index;
    const url = `${String(basePath).replace(/\/$/, '')}/${String(ix.url).replace(/^\/+/, '')}?v=${ix.sha256.slice(0, 12)}`;
    let p = _v3IndexCache.get(url);
    if (p) {
      return p.then((parsed) => {
        const gridsDiffer = parsed.levels.some((lv, k) => {
          const g = manifest.levels[k] && manifest.levels[k].gridSize;
          return !g || lv.nx !== g.x || lv.ny !== g.y || lv.nz !== g.z;
        });
        if (parsed.levels.length !== manifest.levels.length || parsed.channels !== manifest.channels || gridsDiffer) {
          throw _v3IndexError('cached index does not match this manifest');
        }
        return parsed;
      });
    }
    p = (async () => {
      const resp = await fetch(url, signal ? { signal } : undefined);
      if (!resp.ok) throw Object.assign(new Error(`[BrickLoader] index.bin: HTTP ${resp.status} for ${url}`), { code: 'BRICKS_INDEX_HTTP' });
      const bytes = new Uint8Array(await resp.arrayBuffer());
      if (bytes.length !== ix.bytes) throw _v3IndexError(`${bytes.length} bytes ≠ index.bytes ${ix.bytes}`);
      const digest = await _sha256HexAny(bytes);
      if (digest !== ix.sha256) throw _v3IndexError('sha256 differs from the manifest\'s index.sha256');
      return _parseV3Index(bytes, manifest);
    })();
    _v3IndexCache.set(url, p);
    p.catch(() => { if (_v3IndexCache.get(url) === p) _v3IndexCache.delete(url); });
    while (_v3IndexCache.size > V3_INDEX_CACHE) _v3IndexCache.delete(_v3IndexCache.keys().next().value);
    return p;
  }

  // ── Mount ─────────────────────────────────────────────────────────────────
  // Derived indices are built once per manifest part and reused by every mount of
  // it: a quality step re-inits on the same manifest object, a timelapse frame on a
  // fresh wrapper around its row's shared `levels` / `brickTransport` objects.
  const _packIndexCache = new WeakMap();   // brickTransport -> { packIndex, packSizes }
  const _levelCache = new WeakMap();       // levels array -> Map(level -> grid)
  const _EMPTY_INDEX = { packIndex: new Map(), packSizes: new Map(), stamp: '' };

  /**
   * A version for the pack URLs of one transport (`?v=<stamp>`). Packs are served
   * with a day-long HTTP cache, so a dataset re-processed under the same name must
   * not read yesterday's packs through today's manifest. The stamp is an FNV-1a
   * 32-bit hash of what changes whenever a pack's bytes do: the published sha256 of
   * every pack when the manifest carries them, else every pack's URL and size.
   * Stable for an unchanged manifest, computed once per transport object.
   */
  function _packStamp(transport, packSizes) {
    let h = 0x811c9dc5;
    const feed = (str) => {
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
    };
    const hashes = transport.packHashes && typeof transport.packHashes === 'object' ? transport.packHashes : null;
    if (hashes && Object.keys(hashes).length) {
      for (const k in hashes) feed(`${k}=${hashes[k]};`);
    } else {
      for (const [url, size] of packSizes) feed(`${url}:${size};`);
    }
    if (transport.createdAt) feed(String(transport.createdAt));
    return h.toString(36);
  }

  function _packIndexFor(transport) {
    if (!transport || typeof transport !== 'object') return _EMPTY_INDEX;
    let built = _packIndexCache.get(transport);
    if (built) return built;
    const packIndex = new Map();  // brick relative path -> { url, offset, length }
    const packSizes = new Map();  // pack relative url -> bytes (the end of its last brick)
    const index = transport.brickToPack;
    if (index && typeof index === 'object') {
      for (const brickPath in index) {
        const entry = index[brickPath];
        if (!entry?.url || !Number.isFinite(Number(entry.offset)) || !Number.isFinite(Number(entry.length))) continue;
        if (!_isSafePackUrl(entry.url)) continue;  // SEC-017: defense in depth
        const url = String(entry.url).replace(/^\/+/, '');
        const offset = Number(entry.offset);
        const length = Number(entry.length);
        packIndex.set(String(brickPath).replace(/^\/+/, ''), { url, offset, length });
        // A pack is the concatenation of its bricks: its size is the end of the last one.
        if (offset + length > (packSizes.get(url) || 0)) packSizes.set(url, offset + length);
      }
    }
    built = { packIndex, packSizes, stamp: _packStamp(transport, packSizes) };
    _packIndexCache.set(transport, built);
    return built;
  }

  /**
   * Per level, the brick grid and a one-byte-per-brick occupancy map. Brick (bx, by,
   * bz) is at index (bz·ny + by)·nx + bx with n = ceil(dimension / 64); a chunk id is
   * "bz_by_bx". `nonEmpty` is the union over channels: a brick is listed when any
   * channel has data there.
   */
  function _levelsFor(manifest) {
    let grids = _levelCache.get(manifest.levels);
    if (grids) return grids;
    grids = new Map();
    for (const level of manifest.levels) {
      const d = level.dimensions;
      const nx = Math.ceil(d.x / BRICK_SIZE);
      const ny = Math.ceil(d.y / BRICK_SIZE);
      const nz = Math.ceil(d.z / BRICK_SIZE);
      const bits = new Uint8Array(nx * ny * nz);
      let count = 0;
      if (Array.isArray(level.chunks)) {
        for (const chunk of level.chunks) {
          if (!chunk || chunk.nonEmpty === false || typeof chunk.id !== 'string') continue;
          const parts = chunk.id.split('_');
          if (parts.length !== 3) continue;
          const bz = parseInt(parts[0], 10);
          const by = parseInt(parts[1], 10);
          const bx = parseInt(parts[2], 10);
          if (!(bx >= 0 && bx < nx && by >= 0 && by < ny && bz >= 0 && bz < nz)) continue;
          const i = (bz * ny + by) * nx + bx;
          if (!bits[i]) { bits[i] = 1; count++; }
        }
      }
      grids.set(level.level, { dims: d, nx, ny, nz, bits, count });
    }
    _levelCache.set(manifest.levels, grids);
    return grids;
  }

  function _makeMount(basePath, manifest) {
    const transport = manifest.brickTransport || null;
    const { packIndex, packSizes, stamp } = _packIndexFor(transport);
    return {
      version: 2,
      bs: BRICK_SIZE,
      apron: 0,
      hasPackIndex: packIndex.size > 0,
      lookup: (lod, channel, bx, by, bz) => packIndex.get(_relBrickPath(lod, channel, bx, by, bz)) || null,
      packQuery: stamp ? `?v=${stamp}` : '',
      basePath,
      manifest,
      encoding: transport?.encoding || null,
      packMode: transport?.mode === 'packs' || packIndex.size > 0,
      packing: manifest.brickPacking || {},
      packIndex,
      packSizes,
      packHashes: transport?.packHashes && typeof transport.packHashes === 'object' ? transport.packHashes : null,
      brickHashes: manifest.hashes && typeof manifest.hashes === 'object' ? manifest.hashes : null,
      grids: _levelsFor(manifest)
    };
  }

  function _makeMountV3(basePath, manifest, index) {
    const grids = new Map();
    for (const lv of index.levels) {
      const ml = manifest.levels[lv.k];
      grids.set(lv.k, { dims: ml.dimensions, nx: lv.nx, ny: lv.ny, nz: lv.nz, bits: lv.bits, count: lv.count, voxelSize: ml.voxelSize || null, packCount: lv.packCount });
    }
    return {
      version: 3,
      bs: V3_STRIDE,
      apron: V3_APRON,
      hasPackIndex: true,
      lookup: (lod, channel, bx, by, bz) => _v3Lookup(index, lod, channel, bx, by, bz),
      packQuery: `?v=${manifest.index.sha256.slice(0, 12)}`,
      basePath,
      manifest,
      index,
      encoding: 'webp-lossless',
      packMode: true,
      packing: { mode: 'grid', cols: V3_COLS, rows: V3_ROWS, slice: V3_STRIDE },
      packIndex: null,
      packSizes: index.packSizes,
      packHashes: null,
      brickHashes: null,
      grids
    };
  }

  /** Dataset root = the mount path without its trailing per-timepoint segment.
   *  ".../bricks/t007" and ".../bricks/t008" are the same dataset, one frame apart. */
  function _datasetRoot(path) {
    return String(path || '').replace(/\/$/, '').replace(/\/t\d+$/, '');
  }

  /**
   * Mount a brick manifest served under `basePath` (e.g. "DATA_WEB/3d/<name>/bricks",
   * or ".../bricks/t007" for one frame of a timelapse). A malformed manifest throws
   * before anything changes. Re-mounting the same manifest at the same path is free.
   * Mounting another DATASET cancels every running batch and drops every source;
   * another quality or timepoint of the same dataset cancels nothing — each batch
   * keeps the mount it was started on.
   */
  function init(basePath, manifest, options = {}) {
    _validateManifest(manifest);     // ELE-21 (Rule 1.4): rejet AVANT toute mutation d'état
    const next = String(basePath).replace(/\/$/, '');
    const token = ++_initSeq;
    if (!_isV3(manifest)) {
      _pendingInit = null;
      _commitMount(next, manifest, () => _makeMount(next, manifest));
      return Promise.resolve();
    }
    // A v3 tree mounts once its index has landed and checked out; until then the
    // previous mount stays (and loadBrickTasks waits for this one).
    if (_mount && _mount.manifest === manifest && _mount.basePath === next) {
      _pendingInit = null;
      return Promise.resolve();
    }
    const p = _loadV3Index(next, manifest, options.signal).then((index) => {
      if (token !== _initSeq) return;    // a later init won
      _commitMount(next, manifest, () => _makeMountV3(next, manifest, index));
    });
    const tracked = p.catch(() => {}).then(() => { if (_pendingInit === tracked) _pendingInit = null; });
    _pendingInit = tracked;
    return p;
  }

  function _commitMount(next, manifest, make) {
    if (_mount && _mount.manifest === manifest && _mount.basePath === next) return;
    const sameDataset = Boolean(_mount) && _datasetRoot(next) === _datasetRoot(_mount.basePath);
    if (_mount && !sameDataset) _switchDataset();
    _mount = make();
    _ensureWorkers();
  }

  function _switchDataset() {
    _datasetEpoch++;
    for (const batch of [..._batches]) _cancelBatch(batch, 'dataset-switch');
    for (const entry of [..._store.values()]) _dropEntry(entry, true);
    _store.clear();
    _runsByPack.clear();
    _runGroups.clear();
    _packRefs.clear();
    _runRefs.clear();
    _bytes.pack = 0;
    _bytes.run = 0;
    _fetchedOnce.clear();
    _workers.forEach(rec => { if (rec.alive) rec.w.postMessage({ type: 'CANCEL' }); });
  }

  // ── Queries on the current mount ─────────────────────────────────────────────
  function _grid(lod) {
    return _mount ? _mount.grids.get(Number(lod)) || null : null;
  }

  function hasBrick(bx, by, bz, lod = 0) {
    const g = _grid(lod);
    if (!g || !(bx >= 0 && bx < g.nx && by >= 0 && by < g.ny && bz >= 0 && bz < g.nz)) return false;
    return g.bits[(bz * g.ny + by) * g.nx + bx] === 1;
  }

  /** The non-empty bricks of a level, z-major then y then x. */
  function activeBricks(lod = 0) {
    const g = _grid(lod);
    const bricks = [];
    if (!g) return bricks;
    let i = 0;
    for (let bz = 0; bz < g.nz; bz++) {
      for (let by = 0; by < g.ny; by++) {
        for (let bx = 0; bx < g.nx; bx++, i++) {
          if (g.bits[i]) bricks.push({ bx, by, bz });
        }
      }
    }
    return bricks;
  }

  /** How many bricks of a level are non-empty, without listing them. */
  function activeBrickCount(lod = 0) {
    return _grid(lod)?.count || 0;
  }

  function configure(options = {}) {
    const num = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
    if (num(options.concurrentLoads) !== null) {
      _settings.concurrentLoads = Math.max(2, Math.min(96, Math.round(num(options.concurrentLoads))));
    }
    if (num(options.packFetchSlots) !== null) {
      _settings.packFetchSlots = Math.max(1, Math.min(16, Math.round(num(options.packFetchSlots))));
      _drainFetchSlots();
    }
    if (num(options.packCacheBytes) !== null) _settings.packCacheBytes = Math.max(8 * MiB, num(options.packCacheBytes));
    if (num(options.rangeCacheBytes) !== null) _settings.rangeCacheBytes = Math.max(4 * MiB, num(options.rangeCacheBytes));
    if (num(options.prefetchCacheBytes) !== null) _settings.prefetchCacheBytes = Math.max(0, num(options.prefetchCacheBytes));
    if (num(options.lookaheadBytes) !== null) _settings.lookaheadBytes = Math.max(0, num(options.lookaheadBytes));
    if (num(options.decodeTimeoutMs) !== null) _settings.decodeTimeoutMs = Math.max(1000, num(options.decodeTimeoutMs));
    if (num(options.fetchStallMs) !== null) _settings.fetchStallMs = Math.max(1000, num(options.fetchStallMs));
    if (num(options.decodeWorkers) !== null) {
      _settings.decodeWorkers = Math.max(0, Math.min(16, Math.round(num(options.decodeWorkers))));
      if (_mount) _ensureWorkers();
    }
    if (options.verifyHashes !== undefined) {
      _settings.verifyHashes = Boolean(options.verifyHashes);
    }
    if (options.multiRange !== undefined) {
      const m = options.multiRange === true ? 'on' : (options.multiRange === false ? 'off' : String(options.multiRange));
      if (m === 'auto' || m === 'on' || m === 'off') _settings.multiRange = m;
    }
    _trimStore();
  }

  function isReady() {
    return Boolean(_mount);
  }

  function getManifest() {
    return _mount ? _mount.manifest : null;
  }

  /** Dimensions of a level, or null for a level the manifest does not have. */
  function getDimensions(lod = 0) {
    const g = _grid(lod);
    if (!g) return null;
    return {
      x: g.dims.x,
      y: g.dims.y,
      z: g.dims.z,
      channels: _mount.manifest.channels || 1,
      brickSize: BRICK_SIZE,
      brickStride: _mount.bs,
      apron: _mount.apron,
      lod: Number(lod)
    };
  }

  /**
   * The mounted tree's format: { version: 2|3, apron: 0|1, brickStride: 64|66,
   * brickSize: 64, channels, levels: [{ level, dims: {x,y,z}, voxelSize: {x,y,z}|null,
   * grid: {x,y,z}, brickCount }] } — null before a mount. `brickCount` counts the
   * brick slots any channel stores.
   */
  function getFormat() {
    if (!_mount) return null;
    const levels = [];
    for (const k of [..._mount.grids.keys()].sort((a, b) => a - b)) levels.push(getLevelInfo(k));
    return {
      version: _mount.version,
      apron: _mount.apron,
      brickStride: _mount.bs,
      brickSize: BRICK_SIZE,
      channels: _mount.manifest.channels || 1,
      levels
    };
  }

  /** One level of the mounted tree (see getFormat), or null. v3 adds `packCount`. */
  function getLevelInfo(k) {
    const g = _grid(k);
    if (!g) return null;
    const ml = Array.isArray(_mount.manifest.levels) ? _mount.manifest.levels[Number(k)] : null;
    const vs = g.voxelSize || (ml && ml.voxelSize) || null;
    const info = {
      level: Number(k),
      dims: { x: g.dims.x, y: g.dims.y, z: g.dims.z },
      voxelSize: vs ? { x: vs.x, y: vs.y, z: vs.z } : null,
      grid: { x: g.nx, y: g.ny, z: g.nz },
      brickCount: g.count
    };
    if (_mount.version === 3) info.packCount = g.packCount;
    return info;
  }

  /**
   * All bricks of a box given in normalized [0,1] coordinates. Each brick index is
   * clamped to the grid (EDGE-055 / BUG-034): maxNorm = 1.0 or a negative minNorm
   * never yields a brick outside it.
   */
  function bricksForRegion(minNorm, maxNorm, lod = 0) {
    const dims = getDimensions(lod);
    if (!dims) return [];
    const bs = dims.brickSize;
    const nx = Math.ceil(dims.x / bs);
    const ny = Math.ceil(dims.y / bs);
    const nz = Math.ceil(dims.z / bs);
    const clamp = (v, n) => Math.max(0, Math.min(n - 1, Math.floor(v)));
    const x0 = clamp(minNorm.x * dims.x / bs, nx);
    const y0 = clamp(minNorm.y * dims.y / bs, ny);
    const z0 = clamp(minNorm.z * dims.z / bs, nz);
    const x1 = clamp(maxNorm.x * dims.x / bs, nx);
    const y1 = clamp(maxNorm.y * dims.y / bs, ny);
    const z1 = clamp(maxNorm.z * dims.z / bs, nz);
    const bricks = [];
    for (let bz = z0; bz <= z1; bz++) {
      for (let by = y0; by <= y1; by++) {
        for (let bx = x0; bx <= x1; bx++) {
          bricks.push({ bx, by, bz });
        }
      }
    }
    return bricks;
  }

  /**
   * One channel of a set of bricks. Returns Map "bx_by_bz" -> voxels (plus the
   * batch `summary`, see loadBrickTasks).
   */
  async function loadBricks(brickCoords, channel = 0, lod = 0, options = {}) {
    const tasks = brickCoords.map(({ bx, by, bz }) => ({ bx, by, bz, channel, lod }));
    const taskResults = await loadBrickTasks(tasks, { ...options, streamOnly: false });
    const results = new Map();
    for (const [key, data] of taskResults.entries()) {
      const coord = key.split(':').pop();
      if (coord) results.set(coord, data);
    }
    results.summary = taskResults.summary;
    return results;
  }

  // ── Regions ──────────────────────────────────────────────────────────────────
  /** The integer voxel box of a brick a task asks for, or null for the whole brick
   *  (same rule as the decode worker: empty, malformed or full boxes mean whole). */
  function _normalizeRegion(raw, bs = BRICK_SIZE) {
    if (!raw || typeof raw !== 'object') return null;
    const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number(v))));
    const box = {
      x0: clampInt(raw.x0 ?? 0, 0, bs), x1: clampInt(raw.x1 ?? bs, 0, bs),
      y0: clampInt(raw.y0 ?? 0, 0, bs), y1: clampInt(raw.y1 ?? bs, 0, bs),
      z0: clampInt(raw.z0 ?? 0, 0, bs), z1: clampInt(raw.z1 ?? bs, 0, bs)
    };
    for (const k of ['x', 'y', 'z']) {
      if (!Number.isFinite(box[k + '0']) || !Number.isFinite(box[k + '1']) || box[k + '1'] <= box[k + '0']) return null;
    }
    if (box.x0 === 0 && box.y0 === 0 && box.z0 === 0 && box.x1 === bs && box.y1 === bs && box.z1 === bs) return null;
    return box;
  }

  const _regionVoxels = (r, bs = BRICK_SIZE) => (r ? (r.x1 - r.x0) * (r.y1 - r.y0) * (r.z1 - r.z0) : bs * bs * bs);
  const _regionKey = (r) => (r ? `${r.x0},${r.x1},${r.y0},${r.y1},${r.z0},${r.z1}` : '');

  /** The box `region` (or the whole brick) cut out of a whole brick of `comps` bytes per voxel. */
  function _cropBox(data, bs, region, comps) {
    if (!region) return data;
    const rw = region.x1 - region.x0;
    const out = new Uint8Array(_regionVoxels(region, bs) * comps);
    const rowBytes = rw * comps;
    let dst = 0;
    for (let z = region.z0; z < region.z1; z++) {
      for (let y = region.y0; y < region.y1; y++) {
        const src = ((z * bs + y) * bs + region.x0) * comps;
        out.set(data.subarray(src, src + rowBytes), dst);
        dst += rowBytes;
      }
    }
    return out;
  }

  // ── Batches ────────────────────────────────────────────────────────────────
  /**
   * Load brick tasks — `{ bx, by, bz, channel, lod, region? }`, `channel` -1 for the
   * RGBA transport, `region` an optional voxel box {x0,x1,y0,y1,z0,z1} of the brick —
   * as one batch.
   *
   * On a v3 tree (getFormat().version === 3) a brick is delivered as its stored 66³
   * (stride 66: stored voxel s of an axis is volume voxel 64·b − 1 + s, the border
   * clamped to the volume's edge), `region` is a box of that 66³ frame, a brick the
   * index does not hold is zeros 66³ (border included), and channel -1 is refused.
   *
   * options
   *   onBrickLoaded(row)   row = { bx, by, bz, channel, lod, data, region, batchId }.
   *                        `data` is the brick's voxels, or the `region` box alone when
   *                        a grid-packed brick was asked as a box (length tells which).
   *   onBrickError(row)    a task that failed for good: { bx, by, bz, channel, lod, error }.
   *   onProgress(f)        fraction of tasks settled.
   *   onComplete(summary)  see below; also returned as `result.summary`.
   *   signal               AbortSignal cancelling this batch only.
   *   shouldAbort()        polled between tasks; true cancels this batch.
   *   group / cancelPrevious
   *                        Starting a batch cancels the live batches of its group when
   *                        `cancelPrevious` is not false. The default group is
   *                        'stream'; a batch started with `cancelPrevious: false` and no
   *                        group is independent: no other batch cancels it (only its own
   *                        signal/shouldAbort, cancelPending() or a dataset switch).
   *   concurrency          tasks decoded at once (default configure().concurrentLoads).
   *   strictOrder          keep the task order literally. By default the order is
   *                        pack-major (see _packMajorOrder): it starts at the caller's
   *                        FIRST brick and expands outward pack by pack, so a pack is
   *                        downloaded once and released as soon as its bricks are cut.
   *                        `preserveOrder` is accepted and means the default.
   *   byteRanges           fetch, for packs the batch needs only part of, the byte
   *                        runs of its bricks (Range requests) instead of whole packs.
   *   luts                 per-channel Uint8Array(256) applied to the decoded bytes.
   *   compose              { channels?, luts?, components?: 4|2|1, cropToVolume? }:
   *                        deliver one row per BRICK instead of per task — the
   *                        channels interleaved at `components` bytes per voxel (channel c
   *                        in byte c), LUT applied, in a decode worker. The row is
   *                        { bx, by, bz, lod, channel: 'rgba', composed: true, data,
   *                        region, components, channels: [delivered], failedChannels:
   *                        [failed] }; a channel that failed for good is left at zero
   *                        and reported through onBrickError; a brick none of whose
   *                        channels could be loaded is not delivered. `cropToVolume`
   *                        cuts an edge brick to the voxels inside the volume (the row's
   *                        `region` is then that box), which SVRManager.writeRgbaBrick
   *                        uploads without another copy. On a v3 tree the box keeps
   *                        the stored voxels whose volume coordinate lies in
   *                        [−1, dimension] (the voxels inside plus a 1-voxel border).
   *   streamOnly           do not collect the returned Map (callers that consume rows).
   *   manifest             the manifest the tasks were planned on: rejects (code
   *                        BRICKS_MOUNT_CHANGED) when another tree is mounted by then.
   *   cacheResults / readCache  accepted and ignored: decoded bricks are not cached.
   *
   * Resolves (never rejects on cancellation) to a Map "<lod>:c<channel>:bx_by_bz" ->
   * data (empty with streamOnly) carrying `summary` = { batchId, total, delivered,
   * failed: [{bx,by,bz,channel,lod,error}], skipped: [{bx,by,bz,channel,lod}],
   * cancelled, reason }. Every task is in exactly one of delivered / failed / skipped:
   * `skipped` lists what a cancellation left undone.
   */
  async function loadBrickTasks(tasks, options = {}) {
    if (_pendingInit) await _pendingInit;
    if (!_mount) throw new Error('BrickLoader not initialized.');
    // A caller that planned its tasks on one tree names it: another tree mounted
    // meanwhile (a timepoint prefetch, the detail streaming re-mounting the frame on
    // screen, a v3 index landing) must not silently serve these coordinates.
    if (options.manifest && _mount.manifest !== options.manifest) {
      throw Object.assign(new Error('[BrickLoader] another tree is mounted than the one these tasks were planned on'), { code: 'BRICKS_MOUNT_CHANGED', stale: true });
    }
    const mount = _mount;
    const list = Array.isArray(tasks) ? tasks : [];
    const explicitGroup = typeof options.group === 'string' && options.group ? options.group : null;
    const group = explicitGroup || (options.cancelPrevious === false ? null : 'stream');
    if (group && options.cancelPrevious !== false) {
      for (const other of [..._batches]) if (other.group === group) _cancelBatch(other, 'superseded');
    }

    const batch = {
      id: ++_batchSeq,
      group,
      mount,
      datasetEpoch: _datasetEpoch,
      controller: new AbortController(),
      reason: null,
      order: [],
      next: 0,
      lookIdx: 0,
      windowBytes: 0,
      srcRemaining: new Map(),
      inWindow: new Map(),
      rangePlan: null,
      luts: Array.isArray(options.luts) ? options.luts : null
    };
    batch.signal = batch.controller.signal;
    _batches.add(batch);
    const external = options.signal || null;
    const onExternalAbort = () => _cancelBatch(batch, 'signal');
    if (external) {
      if (external.aborted) _cancelBatch(batch, 'signal');
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }
    const shouldAbort = typeof options.shouldAbort === 'function' ? options.shouldAbort : null;
    const pollAbort = () => {
      if (!batch.reason && shouldAbort && shouldAbort()) _cancelBatch(batch, 'shouldAbort');
      return Boolean(batch.reason);
    };

    const results = new Map();
    const summary = { batchId: batch.id, total: list.length, delivered: 0, failed: [], skipped: [], cancelled: false, reason: null };
    const failedTasks = new Set();
    const deliveredTasks = new Set();
    let settledTasks = 0;
    const progress = () => {
      settledTasks++;
      options.onProgress?.(list.length ? settledTasks / list.length : 1);
    };

    // PERF-022: yield on a ~8ms time budget instead of a hard per-brick setTimeout(1).
    const YIELD_BUDGET_MS = 8;
    let _lastYield = _now();
    const _yieldIfBudgetSpent = async () => {
      if (_now() - _lastYield > YIELD_BUDGET_MS) {
        await new Promise(r => setTimeout(r, 0));
        _lastYield = _now();
      }
    };

    const planned = list.map((task, index) => _planTask(mount, task, index));
    batch.multiRange = _multiRangeFor(mount);
    batch.rangePlan = options.byteRanges && !_rangeUnsupportedHosts.has(_hostOf(mount.basePath))
      ? _planRanges(planned, mount, batch.multiRange)
      : null;
    for (const t of planned) _attachSource(batch, t);
    batch.order = (options.strictOrder === true) ? planned : _packMajorOrder(planned, mount);
    batch.order.forEach((t, i) => { t.orderIdx = i; });

    const compose = options.compose && typeof options.compose === 'object' ? _normalizeCompose(options.compose, planned) : null;

    try {
      if (!batch.reason && planned.length) {
        if (compose) {
          await _runComposeBatch(batch, compose, options, {
            pollAbort, progress, _yieldIfBudgetSpent, failedTasks, deliveredTasks, summary
          });
        } else {
          await _runTaskBatch(batch, options, {
            pollAbort, progress, _yieldIfBudgetSpent, failedTasks, deliveredTasks, summary, results
          });
        }
      }
    } finally {
      if (external) external.removeEventListener('abort', onExternalAbort);
      for (const t of planned) _unrefTask(batch, t);
      _batches.delete(batch);
      _trimStore();
    }

    for (const t of planned) {
      if (deliveredTasks.has(t) || failedTasks.has(t)) continue;
      summary.skipped.push({ bx: t.bx, by: t.by, bz: t.bz, channel: t.channel, lod: t.lod });
    }
    summary.delivered = deliveredTasks.size;
    summary.cancelled = Boolean(batch.reason);
    summary.reason = batch.reason;
    if (!planned.length) options.onProgress?.(1);
    results.summary = summary;
    options.onComplete?.(summary);
    return results;
  }

  function _planTask(mount, task, index) {
    const lod = Number.isFinite(Number(task.lod)) ? Number(task.lod) : 0;
    const channel = (task.channel === -1 || task.channel === 'rgba') ? -1
      : (Number.isFinite(Number(task.channel)) ? Number(task.channel) : 0);
    const { bx, by, bz } = task;
    const rel = mount.version === 3 ? `l${lod}/c${channel}/${bz}_${by}_${bx}` : _relBrickPath(lod, channel, bx, by, bz);
    const packed = mount.lookup(lod, channel, bx, by, bz);
    const nregion = _normalizeRegion(task.region, mount.bs);
    return {
      index, lod, channel, bx, by, bz, rel, packed,
      region: task.region || null,
      nregion,
      brickKey: `${lod}:${bx}_${by}_${bz}|${_regionKey(nregion)}`,
      src: null,
      unrefed: false
    };
  }

  function _attachSource(batch, t) {
    if (!t.packed) return;
    const packAbs = _absUrl(batch.mount, t.packed.url);
    const runs = batch.rangePlan?.get(t.packed.url);
    const run = runs?.find(r => r.start <= t.packed.offset && t.packed.offset + t.packed.length <= r.end) || null;
    const size = batch.mount.packSizes.get(t.packed.url) || (t.packed.offset + t.packed.length);
    t.src = {
      packAbs,
      packRel: t.packed.url,
      runKey: run ? `${packAbs}#${run.start}-${run.end}` : null,
      runStart: run ? run.start : 0,
      runEnd: run ? run.end : 0,
      bytes: run ? run.end - run.start : size,
      hash: batch.mount.packHashes ? batch.mount.packHashes[t.packed.url] || null : null,
      multi: Boolean(batch.multiRange)
    };
    _packRefs.set(packAbs, (_packRefs.get(packAbs) || 0) + 1);
    if (t.src.runKey) _runRefs.set(t.src.runKey, (_runRefs.get(t.src.runKey) || 0) + 1);
    // A pack warmed by prefetchPacks is now someone's: it follows the refcount from here.
    const warm = _store.get(packAbs);
    if (warm) warm.retain = false;
    const windowKey = t.src.runKey || packAbs;
    batch.srcRemaining.set(windowKey, (batch.srcRemaining.get(windowKey) || 0) + 1);
  }

  function _unrefTask(batch, t) {
    if (t.unrefed) return;
    t.unrefed = true;
    if (!t.src) return;
    const { packAbs, runKey } = t.src;
    const p = (_packRefs.get(packAbs) || 0) - 1;
    if (p > 0) _packRefs.set(packAbs, p); else _packRefs.delete(packAbs);
    if (runKey) {
      const r = (_runRefs.get(runKey) || 0) - 1;
      if (r > 0) _runRefs.set(runKey, r); else _runRefs.delete(runKey);
      const re = _store.get(runKey);
      if (re) _maybeRelease(re);
    }
    const pe = _store.get(packAbs);
    if (pe) _maybeRelease(pe);
    const windowKey = runKey || packAbs;
    const left = (batch.srcRemaining.get(windowKey) || 0) - 1;
    if (left > 0) {
      batch.srcRemaining.set(windowKey, left);
    } else {
      batch.srcRemaining.delete(windowKey);
      if (batch.inWindow.has(windowKey)) {
        batch.windowBytes -= batch.inWindow.get(windowKey);
        batch.inWindow.delete(windowKey);
      }
    }
  }

  /**
   * Pack-major order. A pack holds 128 consecutive bricks of ONE channel in raster
   * order (x fastest, then y, then z), so the bricks are grouped by the source their
   * first task is cut from, and the groups are taken in raster order expanding
   * outward from the group of the caller's FIRST brick (the centre, for a
   * centre-first caller): |raster(group) − raster(first brick)| ascending. The other
   * channels' packs cover raster spans too, so each of them is cut through within a
   * few consecutive groups and released; a caller order that jumps between packs
   * (the viewer's radial order) instead held up to 0.9 GB of packs on the reference
   * data, or re-downloaded them (4.9× on E95-1 native). Inside a group the bricks
   * keep raster order and a brick's channel tasks stay together.
   */
  function _packMajorOrder(planned, mount = _mount) {
    if (planned.length < 2) return planned;
    const raster = (t) => {
      const g = mount ? mount.grids.get(t.lod) : null;
      const r = g ? (t.bz * g.ny + t.by) * g.nx + t.bx : t.index;
      return t.lod * 1e12 + r;
    };
    const bricks = new Map();     // brickKey -> { first, raster, tasks }
    for (const t of planned) {
      let b = bricks.get(t.brickKey);
      if (!b) bricks.set(t.brickKey, b = { first: t.index, raster: raster(t), tasks: [] });
      b.tasks.push(t);
    }
    let origin = null;
    const groups = new Map();     // anchor -> { raster, bricks }
    for (const b of bricks.values()) {
      if (!origin || b.first < origin.first) origin = b;
      const anchorTask = b.tasks.find(x => x.src) || null;
      const anchor = anchorTask ? (anchorTask.src.runKey || anchorTask.src.packAbs) : `brick:${b.tasks[0].brickKey}`;
      let g = groups.get(anchor);
      if (!g) groups.set(anchor, g = { raster: b.raster, bricks: [] });
      g.raster = Math.min(g.raster, b.raster);
      g.bricks.push(b);
    }
    const o = origin.raster;
    const out = [];
    const sorted = [...groups.values()].sort((a, b) => (Math.abs(a.raster - o) - Math.abs(b.raster - o)) || (a.raster - b.raster));
    for (const g of sorted) {
      g.bricks.sort((a, b) => a.raster - b.raster);
      for (const b of g.bricks) out.push(...b.tasks);
    }
    return out;
  }

  /** Ask for the sources of the next tasks, up to `lookaheadBytes` not yet consumed. */
  function _pump(batch) {
    while (batch.lookIdx < batch.order.length && batch.windowBytes < _settings.lookaheadBytes && !batch.reason) {
      const t = batch.order[batch.lookIdx++];
      if (!t.src || t.unrefed) continue;
      const key = t.src.runKey || t.src.packAbs;
      if (batch.inWindow.has(key) || !batch.srcRemaining.has(key)) continue;
      batch.inWindow.set(key, t.src.bytes);
      batch.windowBytes += t.src.bytes;
      _sourceEntry(batch, t);
    }
  }

  function _cancelBatch(batch, reason) {
    if (batch.reason) return;
    batch.reason = reason;
    try { batch.controller.abort(); } catch (e) { /* already aborted */ }
    for (const [id, p] of [..._workerPending]) {
      if (p.batchId === batch.id) _settlePending(id, false, _abortError());
    }
    _workers.forEach(rec => { if (rec.alive) rec.w.postMessage({ type: 'CANCEL', batch: batch.id }); });
    // Release the sources of every task not started yet, so a download nobody else
    // wants stops now instead of finishing in the background.
    for (let i = batch.next; i < batch.order.length; i++) _unrefTask(batch, batch.order[i]);
  }

  async function _runTaskBatch(batch, options, ctx) {
    const { pollAbort, progress, _yieldIfBudgetSpent, failedTasks, deliveredTasks, results } = ctx;
    const concurrency = Math.max(1, Math.min(
      Number(options.concurrency) || _settings.concurrentLoads || DEFAULT_CONCURRENT_LOADS,
      batch.order.length
    ));
    const runner = async () => {
      while (batch.next < batch.order.length) {
        if (pollAbort()) break;
        const t = batch.order[batch.next++];
        _pump(batch);
        const outcome = await _attemptTask(batch, t, () => _loadTask(batch, t));
        if (outcome.ok) {
          if (!batch.reason && batch.datasetEpoch === _datasetEpoch) {
            deliveredTasks.add(t);
            if (!options.streamOnly) results.set(`${t.lod}:c${t.channel}:${t.bx}_${t.by}_${t.bz}`, outcome.data);
            options.onBrickLoaded?.({
              bx: t.bx, by: t.by, bz: t.bz, channel: t.channel, lod: t.lod,
              data: outcome.data, region: t.region || null, batchId: batch.id
            });
          }
        } else if (!batch.reason) {
          failedTasks.add(t);
          ctx.summary.failed.push({ bx: t.bx, by: t.by, bz: t.bz, channel: t.channel, lod: t.lod, error: outcome.error });
          console.warn(`[BrickLoader] Brick ${t.rel} failed:`, outcome.error);
          // ELE-20 (Rule 1.1): the brick is dropped (never uploaded) and reported.
          options.onBrickError?.({ bx: t.bx, by: t.by, bz: t.bz, channel: t.channel, lod: t.lod, error: outcome.error });
        }
        _unrefTask(batch, t);
        if (!batch.reason) progress();
        await _yieldIfBudgetSpent();
      }
    };
    await Promise.allSettled(Array.from({ length: concurrency }, runner));
  }

  /** Up to RETRY_ATTEMPTS tries of `fn`; an error marked `fatal` is not retried. */
  async function _attemptTask(batch, t, fn, stopOnWorkerLost = false) {
    let lastError = null;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      if (batch.reason) return { ok: false, error: _abortError() };
      try {
        const data = await fn(attempt);
        return { ok: true, data };
      } catch (err) {
        lastError = err;
        if (batch.reason) return { ok: false, error: err };
        // A lost worker took a composed brick's partial buffer with it: the whole brick
        // restarts (in _composeUnit), retrying this channel alone would be wrong.
        if (err && (err.fatal || (stopOnWorkerLost && err.workerLost))) break;
        if (attempt < RETRY_ATTEMPTS) await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
      }
    }
    return { ok: false, error: lastError };
  }

  const _fatal = (message) => Object.assign(new Error(message), { fatal: true });

  function _expectedLength(mount, t, comps) {
    const region = mount.packing?.mode === 'grid' ? t.nregion : null;
    return _regionVoxels(region, mount.bs) * comps;
  }

  /**
   * The decoded voxels of one task. Never returns compressed bytes: a brick that
   * cannot be decoded, or decodes to a size that is neither the brick nor the asked
   * box, throws — the caller drops and reports it.
   */
  async function _loadTask(batch, t, assemble = null) {
    const mount = batch.mount;
    const enc = mount.encoding;
    if (!_supportsWebGL3D) throw _fatal('3D textures (WebGL2) are unavailable: bricks cannot be displayed.');
    const lut = batch.luts && t.channel >= 0 ? batch.luts[t.channel] || null : null;
    const bs = mount.bs;
    const whole = bs * bs * bs;
    if (mount.version === 3 && !(Number.isInteger(t.channel) && t.channel >= 0 && t.channel < (mount.manifest.channels || 1))) {
      throw _fatal(`channel ${t.channel} does not exist in this tree (${mount.manifest.channels} channels)`);
    }

    if (!t.packed && mount.packMode) {
      // ELE-20: brickToPack is the per-channel authority in pack mode. A brick absent
      // from it was ESS-skipped for THIS channel (the union `nonEmpty` flag can still
      // mark the slot occupied because another channel has data there): zeros. In a
      // v3 tree an absent brick is zeros border included (SPEC §13.2).
      if (assemble) return null;
      const comps = enc === 'raw-rgba-gzip' ? 4 : 1;
      return new Uint8Array(_regionVoxels(mount.packing?.mode === 'grid' ? t.nregion : null, bs) * comps);
    }

    let bytes;
    if (t.packed) {
      bytes = await _readSlice(batch, t);
    } else {
      const ext = enc === 'raw-rgba-gzip' ? '.rgba.gz' : (enc === 'raw-u8-gzip' ? '.bin.gz' : (enc === 'raw-u8' ? '.bin' : '.webp'));
      const rel = enc ? t.rel.replace(/\.(webp|rgba|bin)$/, ext) : t.rel;
      const url = `${mount.basePath}/${rel}`;
      const resp = await fetch(url, { signal: batch.signal });
      // ELE-20: 404 sur un fetch direct -> échec tracé (retry + drop), jamais des zéros.
      if (!resp.ok) throw new Error('HTTP ' + resp.status + ' for ' + url);
      bytes = await resp.arrayBuffer();
      if (!enc && _settings.verifyHashes) await _verifyBrickHash(mount, t.rel, bytes);
    }

    if (enc === 'raw-u8' || enc === 'raw-u8-gzip' || enc === 'raw-rgba-gzip') {
      const data = enc === 'raw-u8' ? new Uint8Array(bytes) : await _decompressSlice(bytes);
      const comps = enc === 'raw-rgba-gzip' ? 4 : 1;
      if (data.length !== whole * comps) {
        throw _fatal(`brick ${t.rel} holds ${data.length} bytes, expected ${whole * comps}`);
      }
      if (lut && comps === 1) for (let i = 0; i < data.length; i++) data[i] = lut[data[i]];
      return data;
    }

    // webp-lossless, or a legacy manifest without transport (one .webp per brick).
    const packing = mount.packing || {};
    if (packing.mode !== 'grid' && packing.mode !== 'vertical') {
      throw _fatal('unknown brick packing ' + JSON.stringify(packing.mode) + ' for ' + t.rel);
    }
    const expected = _expectedLength(mount, t, 1);
    const job = { buffer: bytes, brickSize: bs, packing, region: t.nregion, lut };
    // A v3 mosaic has one exact size; any other picture is a corrupt brick, not a
    // truncated one to pad with zeros.
    if (mount.version === 3) job.expect = { width: V3_COLS * V3_STRIDE, height: V3_ROWS * V3_STRIDE };
    if (assemble) {
      return _decodeInto(batch, job, assemble);
    }
    const data = await _decodeWebp(batch, job);
    if (data.length !== expected) {
      throw _fatal(`brick ${t.rel} decoded to ${data.length} voxels, expected ${expected}`);
    }
    return data;
  }

  // ── Sources ─────────────────────────────────────────────────────────────────
  /** Whether the runs of a batch on `mount` may share multi-range requests. */
  function _multiRangeFor(mount) {
    const mode = _settings.multiRange;
    if (mode === 'off') return false;
    // A host whose multi-range answers were unusable gets single-range plans again
    // (wide gap merging, few runs per pack), not 512 one-run requests per pack.
    if (mount && _multiRangeBadHosts.has(_hostOf(mount.basePath))) return false;
    if (mode === 'on') return true;
    return Boolean(mount && mount.version === 3);
  }

  function _hostOf(basePath) {
    const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]+)/i.exec(String(basePath || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function _absUrl(mount, rel) {
    return `${mount.basePath}/${String(rel).replace(/^\/+/, '')}${mount.packQuery || ''}`;
  }

  function _newEntry(key, kind, url) {
    const entry = {
      key, kind, url,
      start: 0, end: 0,
      state: 'pending',
      buffer: null, base: 0, bytes: 0,
      retain: false,
      readers: 0,
      lastUsed: _now(),
      controller: new AbortController(),
      accounted: false
    };
    entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
    entry.promise.catch(() => {});
    _store.set(key, entry);
    return entry;
  }

  /** The entry a task reads from: the whole pack when one is held or coming, else its
   *  planned byte run, else the whole pack (created and requested on demand). */
  function _sourceEntry(batch, t, forceWhole = false) {
    const src = t.src;
    const whole = _store.get(src.packAbs);
    if (whole) return whole;
    const useRun = !forceWhole && src.runKey && batch.rangePlan && batch.rangePlan.has(src.packRel);
    if (useRun) return _store.get(src.runKey) || _createRunEntry(src);
    return _createPackEntry(src.packAbs, { hash: src.hash });
  }

  function _createPackEntry(url, { retain = false, background = false, hash = null } = {}) {
    const entry = _newEntry(url, 'pack', url);
    entry.retain = retain;
    if (_fetchedOnce.has(url)) _stats.refetches++;
    _fetchedOnce.add(url);
    const signal = entry.controller.signal;
    _withFetchSlot(async () => {
      _stats.packFetches++;
      const resp = await fetch(url, { signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
      const buffer = await _readBody(resp, entry);
      if (hash && _settings.verifyHashes) await _verifyPackHash(url, buffer, hash);
      return buffer;
    }, signal, background).then(
      (buffer) => _settleReady(entry, buffer, 0),
      (err) => _settleFailed(entry, err)
    );
    return entry;
  }

  /**
   * Whether a host honours Range is learnt from ONE request: until its first range
   * request has answered, the others wait, so a host that ignores Range (it answers
   * 200 with the whole pack) costs one whole-pack download, not one per run.
   */
  function _rangeGate(host, entry) {
    if (_rangeSupportedHosts.has(host) || _rangeUnsupportedHosts.has(host)) return null;
    const probe = _rangeProbes.get(host);
    if (probe) return probe;
    let done;
    const p = new Promise(resolve => { done = resolve; });
    p.done = () => { if (_rangeProbes.get(host) === p) _rangeProbes.delete(host); done(); };
    _rangeProbes.set(host, p);
    entry.probe = p;
    return null;
  }

  function _createRunEntry(src) {
    const entry = _newEntry(src.runKey, 'run', src.packAbs);
    entry.start = src.runStart;
    entry.end = src.runEnd;
    entry.src = src;
    let set = _runsByPack.get(src.packAbs);
    if (!set) _runsByPack.set(src.packAbs, set = new Set());
    set.add(entry);
    if (_fetchedOnce.has(entry.key)) _stats.refetches++;
    _fetchedOnce.add(entry.key);
    const host = _hostOf(src.packAbs);
    (async () => {
      const gate = _rangeGate(host, entry);
      if (gate) await gate;
      if (entry.state !== 'pending') { _endProbe(entry); return; }
      // The whole pack is held or on its way (a 200 answer to a sibling run, another
      // batch's whole-pack request), or this host ignores Range: read from the pack.
      if (_store.get(src.packAbs) || _rangeUnsupportedHosts.has(host)) { _endProbe(entry); _runViaWholePack(entry); return; }
      // The probe of a host goes alone: what it learns (Range honoured or not) decides
      // for the requests waiting behind it.
      if (src.multi && !entry.probe && !_multiRangeBadHosts.has(host)) _enqueueRun(entry);
      else _fetchRuns(src.packAbs, host, [entry], null);
    })();
    return entry;
  }

  function _endProbe(entry) {
    if (entry.probe) { entry.probe.done(); entry.probe = null; }
  }

  function _runViaWholePack(entry) {
    const src = entry.src;
    const pack = _store.get(src.packAbs) || _createPackEntry(src.packAbs, { hash: src.hash });
    pack.promise.then(() => _migrateRunsToPack(src.packAbs, pack), (err) => _settleFailed(entry, err));
  }

  /**
   * Multi-range coalescing: a run of a pack joins that pack's request still waiting
   * for a fetch slot; the runs are taken (sorted, capped) when the slot frees, so
   * everything asked of a pack meanwhile leaves in one request.
   */
  function _enqueueRun(entry) {
    const url = entry.src.packAbs;
    let g = _runGroups.get(url);
    if (!g) {
      g = { url, host: _hostOf(url), queue: [], ctrl: new AbortController(), taken: false };
      _runGroups.set(url, g);
      // A microtask lets a batch's synchronous pump add all its runs before the group asks.
      Promise.resolve().then(() => _fetchRuns(url, g.host, null, g));
    }
    g.queue.push(entry);
    entry.controller.signal.addEventListener('abort', () => {
      // Every run gone before the request left: the slot wait is abandoned.
      if (!g.taken && g.queue.every(e => e.state !== 'pending')) {
        if (_runGroups.get(url) === g) _runGroups.delete(url);
        try { g.ctrl.abort(); } catch (err) { /* settled */ }
      }
    }, { once: true });
  }

  /** The runs of a waiting group one request carries (part and header caps); the rest form the next group. */
  function _takeRuns(g) {
    g.taken = true;
    if (_runGroups.get(g.url) === g) _runGroups.delete(g.url);
    const live = g.queue.filter(e => e.state === 'pending').sort((a, b) => (a.start - b.start) || (a.end - b.end));
    const taken = [];
    let header = 'bytes='.length;
    for (const e of live) {
      const part = String(e.start).length + String(e.end - 1).length + 3;   // "a-b, "
      if (taken.length && (taken.length >= MULTI_RANGE_MAX_PARTS || header + part > MULTI_RANGE_MAX_HEADER)) break;
      taken.push(e);
      header += part;
    }
    for (const e of live.slice(taken.length)) _enqueueRun(e);
    return taken;
  }

  /**
   * One request for runs of the pack `url` — `entries`, or the runs of `group` taken
   * when the fetch slot frees: `Range: bytes=a-b` for one run, `bytes=a-b, c-d, …` for
   * several. The answer is
   *   206 multipart/byteranges  every run cut out of the part that covers it;
   *   206 one part              the runs its Content-Range covers (a server may merge
   *                             close ranges, or serve only the first); the others are
   *                             asked again one by one;
   *   200                       the whole pack: kept as the pack, ranges stop for the host.
   * A multipart body that cannot be parsed, or one unlabelled body for several ranges,
   * sends its runs again one by one and stops multi-range requests to that host.
   */
  function _fetchRuns(url, host, entries, group) {
    const ctrl = group ? group.ctrl : new AbortController();
    const holder = { controller: ctrl };
    let live = entries || [];
    const watch = (list) => {
      for (const e of list) {
        e.controller.signal.addEventListener('abort', () => {
          if (list.every(x => x.state !== 'pending')) { try { ctrl.abort(); } catch (err) { /* settled */ } }
        }, { once: true });
      }
    };
    if (!group) watch(live);
    _withFetchSlot(async () => {
      if (group) { live = _takeRuns(group); watch(live); }
      const whole = _store.get(url);
      if (whole) return { adopt: whole };
      live = live.filter(e => e.state === 'pending');
      if (!live.length) return { done: true };
      _stats.runFetches++;
      const range = 'bytes=' + live.map(e => `${e.start}-${e.end - 1}`).join(', ');
      const resp = await fetch(url, { signal: ctrl.signal, headers: { Range: range } });
      if (resp.status === 206) {
        _rangeSupportedHosts.add(host);
        live.forEach(_endProbe);
        const header = (name) => (resp.headers && typeof resp.headers.get === 'function' ? resp.headers.get(name) || '' : '');
        const contentType = header('content-type');
        const contentRange = header('content-range');
        const body = new Uint8Array(await _readBody(resp, holder));
        if (/^\s*multipart\/byteranges/i.test(contentType)) {
          try {
            return { parts: _parseMultipartByteranges(body, contentType) };
          } catch (err) {
            if (live.length < 2) throw err;
            _multiRangeBadHosts.add(host);
            console.warn(`[BrickLoader] Multi-range answer of ${url} unusable (${err.message}); asking its runs one by one.`);
            return { retry: live };
          }
        }
        if (contentRange) {
          const cr = _parseContentRange(contentRange);
          if (!cr || cr.end - cr.start !== body.length) {
            throw new Error(`Range answer of ${url}: Content-Range "${contentRange}" for ${body.length} bytes`);
          }
          return { parts: [{ start: cr.start, end: cr.end, bytes: body }] };
        }
        if (live.length === 1) {
          const e = live[0];
          if (body.length !== e.end - e.start) {
            throw new Error(`Range ${e.start}-${e.end - 1} of ${url} answered ${body.length} bytes`);
          }
          return { parts: [{ start: e.start, end: e.end, bytes: body }] };
        }
        // Several ranges asked, one unlabelled body: nothing tells where it belongs.
        _multiRangeBadHosts.add(host);
        return { retry: live };
      }
      if (resp.status === 200) {
        // The server ignored Range and sent the whole pack: keep it as the pack, let
        // every run of that pack read from it. A 200 to SEVERAL ranges says only that
        // the host will not answer multi-range requests (a server's range-count cap):
        // single ranges stay planned (its probe was a single range). A 200 to one range
        // stops range planning on this host.
        if (live.length > 1) _multiRangeBadHosts.add(host);
        else _rangeUnsupportedHosts.add(host);
        const buffer = await _readBody(resp, holder);
        const pack = _adoptWholePack(url, buffer);
        live.forEach(_endProbe);
        return { adopt: pack };
      }
      const what = live.length === 1 ? `range ${live[0].start}-${live[0].end - 1}` : `${live.length} ranges`;
      throw new Error(`HTTP ${resp.status} for ${url} (${what})`);
    }, ctrl.signal).then(
      (got) => {
        live.forEach(_endProbe);
        if (got.adopt) {
          if (got.adopt.state === 'ready') _migrateRunsToPack(url, got.adopt);
          else got.adopt.promise.then(() => _migrateRunsToPack(url, got.adopt), (err) => live.forEach(e => _settleFailed(e, err)));
          return;
        }
        if (got.retry) {
          for (const e of got.retry) if (e.state === 'pending') _fetchRuns(url, host, [e], null);
          return;
        }
        if (!got.parts) return;
        const missing = [];
        for (const e of live) {
          if (e.state !== 'pending') continue;
          const part = got.parts.find(p => p.start <= e.start && e.end <= p.end);
          if (part) _settleReady(e, part.bytes.slice(e.start - part.start, e.end - part.start).buffer, e.start);
          else missing.push(e);
        }
        if (!missing.length) return;
        if (live.length === 1) {
          const e = missing[0];
          _settleFailed(e, new Error(`Range ${e.start}-${e.end - 1} of ${url} answered another range`));
          return;
        }
        if (missing.length === live.length) _multiRangeBadHosts.add(host);
        for (const e of missing) _fetchRuns(url, host, [e], null);
      },
      (err) => {
        live.forEach(_endProbe);
        // Abandoned while waiting for a slot (every run gone): settle what is queued.
        const settle = group && !group.taken ? group.queue : live;
        settle.forEach(e => _settleFailed(e, err));
      }
    );
  }

  /** "bytes a-b/total" → { start: a, end: b + 1 } (end exclusive), or null. */
  function _parseContentRange(value) {
    const m = /^\s*bytes\s+(\d+)\s*-\s*(\d+)\s*\/\s*(\d+|\*)\s*$/i.exec(String(value || ''));
    if (!m) return null;
    const start = Number(m[1]);
    const last = Number(m[2]);
    if (!(last >= start) || (m[3] !== '*' && last >= Number(m[3]))) return null;
    return { start, end: last + 1 };
  }

  /**
   * A multipart/byteranges body (RFC 9110 §14.6) → [{ start, end, bytes }]. Each part:
   * "--boundary", a line break, header lines up to an empty line (Content-Range
   * required), then exactly the bytes its Content-Range announces — cut by that length,
   * never by searching for the boundary (brick bytes may contain it) — and the next
   * delimiter right after (one line break between). "--boundary--" closes the body.
   * Anything else throws.
   */
  function _parseMultipartByteranges(body, contentType) {
    const m = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ''));
    if (!m) throw new Error('multipart answer without a boundary');
    const boundary = m[1] || m[2];
    const delim = new Uint8Array(boundary.length + 2);
    delim[0] = 45; delim[1] = 45;   // "--"
    for (let i = 0; i < boundary.length; i++) {
      const code = boundary.charCodeAt(i);
      if (code < 32 || code > 126) throw new Error('multipart boundary is not printable ASCII');
      delim[i + 2] = code;
    }
    const delimAt = (pos) => {
      if (pos < 0 || pos + delim.length > body.length) return false;
      for (let i = 0; i < delim.length; i++) if (body[pos + i] !== delim[i]) return false;
      return true;
    };
    const eolAfter = (pos) => (body[pos] === 13 && body[pos + 1] === 10 ? pos + 2 : (body[pos] === 10 ? pos + 1 : pos));
    // The first delimiter opens the body, possibly after a line break (or a short preamble).
    let pos = -1;
    for (let i = 0; i + delim.length <= body.length && i < 1024; i++) {
      if (delimAt(i) && (i === 0 || body[i - 1] === 10)) { pos = i; break; }
    }
    if (pos < 0) throw new Error('multipart answer without a delimiter');
    const parts = [];
    for (;;) {
      if (!delimAt(pos)) throw new Error(`multipart delimiter expected at byte ${pos}`);
      pos += delim.length;
      if (body[pos] === 45 && body[pos + 1] === 45) break;   // the closing "--boundary--"
      while (body[pos] === 32 || body[pos] === 9) pos++;      // transport padding
      const next = eolAfter(pos);
      if (next === pos) throw new Error('multipart delimiter not followed by a line break');
      pos = next;
      let range = null;
      for (;;) {
        let eol = pos;
        while (eol < body.length && body[eol] !== 10) eol++;
        if (eol >= body.length) throw new Error('multipart part headers run past the body');
        let line = '';
        for (let i = pos; i < eol; i++) line += String.fromCharCode(body[i]);
        line = line.replace(/\r$/, '');
        pos = eol + 1;
        if (!line) break;
        const h = /^\s*content-range\s*:\s*(.*)$/i.exec(line);
        if (h) {
          range = _parseContentRange(h[1]);
          if (!range) throw new Error(`multipart part with a malformed Content-Range "${h[1]}"`);
        }
      }
      if (!range) throw new Error('multipart part without a Content-Range');
      const len = range.end - range.start;
      if (pos + len > body.length) throw new Error('multipart part shorter than its Content-Range');
      parts.push({ start: range.start, end: range.end, bytes: body.subarray(pos, pos + len) });
      pos = eolAfter(pos + len);
    }
    if (!parts.length) throw new Error('multipart answer without a part');
    return parts;
  }

  /** A 200 body of pack `url` (the caller decides what it says about the host). */
  function _adoptWholePack(url, buffer) {
    for (const batch of _batches) {
      if (batch.rangePlan) {
        for (const rel of [...batch.rangePlan.keys()]) if (_absUrl(batch.mount, rel) === url) batch.rangePlan.delete(rel);
      }
    }
    let pack = _store.get(url);
    if (pack && pack.state === 'ready') return pack;
    if (pack) {
      // A whole-pack request of another batch is in flight: this body answers it.
      _settleReady(pack, buffer, 0);
      try { pack.controller.abort(); } catch (e) { /* settled */ }
      return pack;
    }
    pack = _newEntry(url, 'pack', url);
    _settleReady(pack, buffer, 0);
    return pack;
  }

  function _migrateRunsToPack(url, pack) {
    const set = _runsByPack.get(url);
    if (!set) return;
    for (const run of [...set]) {
      if (run.state === 'pending') {
        run.state = 'ready';
        run.buffer = pack.buffer;
        run.base = 0;
        run.resolve({ buffer: pack.buffer, base: 0 });
      }
      try { run.controller.abort(); } catch (e) { /* settled */ }
      _dropEntry(run, false);
    }
    _runsByPack.delete(url);
  }

  /** Reads a response body, aborting it when nothing arrives for `fetchStallMs`. */
  async function _readBody(resp, entry) {
    const reader = resp.body && typeof resp.body.getReader === 'function' ? resp.body.getReader() : null;
    if (!reader) return resp.arrayBuffer();
    const declared = Number(resp.headers?.get?.('content-length')) || 0;
    let out = declared > 0 ? new Uint8Array(declared) : null;
    const chunks = [];
    let received = 0;
    let stallTimer = null;
    const arm = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        try { reader.cancel(); } catch (e) { /* closed */ }
        try { entry.controller.abort(); } catch (e) { /* settled */ }
      }, _settings.fetchStallMs);
    };
    try {
      arm();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        if (out && received + value.length <= out.length) {
          out.set(value, received);
        } else {
          if (out) { chunks.push(out.subarray(0, received)); out = null; }
          chunks.push(value);
        }
        received += value.length;
      }
    } finally {
      clearTimeout(stallTimer);
    }
    if (entry.controller.signal.aborted) throw _abortError('Pack body stalled or cancelled');
    if (out) return received === out.length ? out.buffer : out.buffer.slice(0, received);
    const joined = new Uint8Array(received);
    let at = 0;
    for (const c of chunks) { joined.set(c, at); at += c.length; }
    return joined.buffer;
  }

  function _settleReady(entry, buffer, base) {
    if (entry.state !== 'pending') return;
    entry.state = 'ready';
    entry.buffer = buffer;
    entry.base = base;
    entry.bytes = buffer.byteLength;
    _stats.fetchedBytes += buffer.byteLength;
    if (_store.get(entry.key) === entry) {
      _bytes[entry.kind] += entry.bytes;
      entry.accounted = true;
    }
    entry.resolve({ buffer, base });
    _maybeRelease(entry);
    _trimStore();
  }

  function _settleFailed(entry, err) {
    if (entry.state !== 'pending') return;
    entry.state = 'failed';
    if (_store.get(entry.key) === entry) _store.delete(entry.key);
    if (entry.kind === 'run') _runsByPack.get(entry.url)?.delete(entry);
    entry.reject(err);
  }

  function _refsOf(entry) {
    return entry.kind === 'run' ? (_runRefs.get(entry.key) || 0) : (_packRefs.get(entry.key) || 0);
  }

  /** Drop an entry no live task needs: abort it in flight, release it once landed. */
  function _maybeRelease(entry) {
    if (_store.get(entry.key) !== entry) return;
    if (entry.retain || entry.readers > 0 || _refsOf(entry) > 0) return;
    _dropEntry(entry, true);
  }

  function _dropEntry(entry, abort) {
    if (_store.get(entry.key) === entry) _store.delete(entry.key);
    if (entry.accounted) {
      _bytes[entry.kind] = Math.max(0, _bytes[entry.kind] - entry.bytes);
      entry.accounted = false;
    }
    if (entry.kind === 'run') _runsByPack.get(entry.url)?.delete(entry);
    if (entry.state === 'pending') {
      entry.state = 'failed';
      if (abort) { try { entry.controller.abort(); } catch (e) { /* settled */ } }
      entry.reject(_abortError('Source released'));
    }
    entry.buffer = null;
  }

  /**
   * Keep the landed bytes under the budgets: first the sources no task needs any
   * more (prefetched packs), then — only when the batches in flight need more than
   * the budget — the least recently read sources that no task is reading right now;
   * those are fetched again if a task still needs them (counted in `refetches`).
   */
  function _trimStore() {
    const retained = [..._store.values()].filter(e => e.retain && e.state === 'ready');
    let retainedBytes = retained.reduce((s, e) => s + e.bytes, 0);
    retained.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const e of retained) {
      if (retainedBytes <= _settings.prefetchCacheBytes) break;
      retainedBytes -= e.bytes;
      _dropEntry(e, false);
    }
    for (const kind of ['pack', 'run']) {
      const budget = kind === 'pack' ? _settings.packCacheBytes : _settings.rangeCacheBytes;
      if (_bytes[kind] <= budget) continue;
      const candidates = [..._store.values()]
        .filter(e => e.kind === kind && e.state === 'ready' && e.readers === 0)
        .sort((a, b) => ((_refsOf(a) > 0) - (_refsOf(b) > 0)) || (a.lastUsed - b.lastUsed));
      for (const e of candidates) {
        if (_bytes[kind] <= budget) break;
        if (_refsOf(e) > 0) _stats.evictedInUse++;
        _dropEntry(e, false);
      }
    }
  }

  /** The bytes of one brick, cut out of its source (a private copy, safe to transfer). */
  async function _readSlice(batch, t) {
    const { offset, length } = t.packed;
    for (let pass = 0; pass < 2; pass++) {
      const entry = _sourceEntry(batch, t, pass > 0);
      const viaRun = entry.kind === 'run';
      entry.readers++;
      entry.lastUsed = _now();
      try {
        const got = await _awaitWithSignal(entry.promise, batch.signal);
        const at = offset - got.base;
        if (at < 0 || at + length > got.buffer.byteLength) {
          throw new Error(`brick ${t.rel} lies outside the ${got.buffer.byteLength} bytes fetched for it`);
        }
        return got.buffer.slice(at, at + length);
      } catch (err) {
        if (batch.reason) throw err;
        // A refused or broken range: this pack is fetched whole for the rest of the batch.
        if (viaRun && pass === 0) {
          batch.rangePlan?.delete(t.src.packRel);
          continue;
        }
        throw err;
      } finally {
        entry.readers--;
        entry.lastUsed = _now();
        _maybeRelease(entry);
      }
    }
    throw new Error(`brick ${t.rel} could not be read`);
  }

  // Resolve/reject with `promise`, but reject early (AbortError) if `signal` aborts —
  // without aborting the underlying shared fetch (other batches keep it).
  function _awaitWithSignal(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(_abortError('Aborted'));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(_abortError('Aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
        (e) => { signal.removeEventListener('abort', onAbort); reject(e); }
      );
    });
  }

  async function _decompressSlice(buffer) {
    if (typeof DecompressionStream !== 'undefined') {
      const stream = new Response(buffer).body.pipeThrough(new DecompressionStream('gzip'));
      const uncompressed = await new Response(stream).arrayBuffer();
      return new Uint8Array(uncompressed);
    }
    throw _fatal('DecompressionStream is unavailable.');
  }

  async function _sha256Hex(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }

  async function _verifyPackHash(url, buffer, expected) {
    if (typeof crypto === 'undefined' || !crypto.subtle) return;
    const actual = await _sha256Hex(buffer);
    if (actual !== String(expected).toLowerCase()) throw new Error('Pack hash mismatch for ' + url);
  }

  async function _verifyBrickHash(mount, rel, buffer) {
    const expected = mount.brickHashes ? mount.brickHashes[rel] : null;
    if (!expected || typeof crypto === 'undefined' || !crypto.subtle) return;
    if ((await _sha256Hex(buffer)) !== expected) throw _fatal('Brick hash mismatch for ' + rel);
  }

  /**
   * Fill the pack store for a timepoint that is NOT mounted, so switching to it costs
   * a decode rather than a download. Packs are asked through the background queue
   * (after every foreground request), kept under `prefetchCacheBytes`, and become
   * ordinary refcounted sources once a batch reads them.
   *
   * @param {string} baseDir   ".../bricks/t007" — the neighbour's mount path
   * @param {object} transport that timepoint's brickTransport
   * @param {number} lod
   * @param {number|null} channel  one channel, or null for every channel
   * @param {number} maxPacks
   * @returns {Promise<number>} packs now held
   */
  function prefetchPacks(baseDir, transport, lod = 0, channel = 0, maxPacks = 8) {
    if (_isV3(transport)) return _prefetchPacksV3(baseDir, transport, lod, channel, maxPacks);
    const b2p = transport?.brickToPack;
    if (!b2p || typeof b2p !== 'object') return Promise.resolve(0);
    const prefix = channel === null || channel === undefined ? `lod${lod}/` : `lod${lod}/c${channel}/`;
    const base = String(baseDir).replace(/\/$/, '');
    const query = _packIndexFor(transport).stamp ? `?v=${_packIndexFor(transport).stamp}` : '';
    const sizes = new Map();
    for (const key in b2p) {
      const entry = b2p[key];
      if (!key.startsWith(prefix) || !entry?.url || !_isSafePackUrl(entry.url)) continue;
      const url = `${base}/${String(entry.url).replace(/^\/+/, '')}${query}`;
      const end = Number(entry.offset) + Number(entry.length);
      if (!sizes.has(url) && sizes.size >= maxPacks) break;
      sizes.set(url, Math.max(sizes.get(url) || 0, Number.isFinite(end) ? end : 0));
    }
    if (!sizes.size) return Promise.resolve(0);
    let retainedBytes = [..._store.values()].filter(e => e.retain).reduce((s, e) => s + (e.bytes || 0), 0);
    const waits = [];
    for (const [url, size] of sizes) {
      const held = _store.get(url);
      if (held) { waits.push(held.promise.then(() => true, () => false)); continue; }
      if (retainedBytes + size > _settings.prefetchCacheBytes) break;
      retainedBytes += size;
      const entry = _createPackEntry(url, { retain: true, background: true });
      // A failed prefetch is not an error: the foreground load will retry properly.
      waits.push(entry.promise.then(() => true, () => false));
    }
    return Promise.all(waits).then(rows => rows.filter(Boolean).length);
  }

  /**
   * prefetchPacks for a v3 tree: `manifest` is that tree's v3 manifest (its `index`
   * names the tree's own index.bin). The index is fetched (and cached), then the packs
   * of level `lod` — one channel, or every channel when `channel` is null — in pack
   * order, up to `maxPacks`, under the same prefetch budget.
   */
  async function _prefetchPacksV3(baseDir, manifest, lod, channel, maxPacks) {
    try { _validateManifest(manifest); } catch (e) { return 0; }
    const base = String(baseDir).replace(/\/$/, '');
    let index;
    try { index = await _loadV3Index(base, manifest); } catch (e) { return 0; }
    const lv = index.levels[Number(lod)];
    if (!lv) return 0;
    const query = `?v=${manifest.index.sha256.slice(0, 12)}`;
    const channels = channel === null || channel === undefined
      ? Array.from({ length: index.channels }, (_, c) => c)
      : [Number(channel)];
    const sizes = new Map();
    outer:
    for (const c of channels) {
      for (let p = 0; p < lv.packCount; p++) {
        const rel = _v3PackRel(lv.k, c, p);
        const size = index.packSizes.get(rel);
        if (!size) continue;
        if (sizes.size >= maxPacks) break outer;
        sizes.set(`${base}/${rel}${query}`, size);
      }
    }
    if (!sizes.size) return 0;
    let retainedBytes = [..._store.values()].filter(e => e.retain).reduce((s, e) => s + (e.bytes || 0), 0);
    const waits = [];
    for (const [url, size] of sizes) {
      const held = _store.get(url);
      if (held) { waits.push(held.promise.then(() => true, () => false)); continue; }
      if (retainedBytes + size > _settings.prefetchCacheBytes) break;
      retainedBytes += size;
      const entry = _createPackEntry(url, { retain: true, background: true });
      waits.push(entry.promise.then(() => true, () => false));
    }
    const rows = await Promise.all(waits);
    return rows.filter(Boolean).length;
  }

  // ── Range planning ─────────────────────────────────────────────────────────
  /**
   * For a batch that needs only part of some packs, the byte runs to fetch instead of
   * whole packs: per pack, the bricks' [offset, end) intervals sorted and merged across
   * gaps up to RANGE_GAP_BYTES; a pack whose runs would still cover most of it, or
   * need too many requests, is left to be fetched whole. Map<pack rel url, runs> or null.
   */
  function _planRanges(tasks, mount = _mount, multi = false) {
    if (!mount || !mount.hasPackIndex) return null;
    // With multi-range requests a run costs a part, not a request: merge only across
    // small gaps, and allow as many runs as a pack has bricks.
    const gap = multi ? MULTI_RANGE_GAP_BYTES : RANGE_GAP_BYTES;
    const maxRuns = multi ? MULTI_RANGE_MAX_RUNS_PER_PACK : RANGE_MAX_RUNS_PER_PACK;
    const perPack = new Map();
    for (const task of Array.isArray(tasks) ? tasks : []) {
      const packed = task.packed !== undefined
        ? task.packed
        : mount.lookup(task.lod ?? 0, task.channel ?? 0, task.bx, task.by, task.bz);
      if (!packed) continue;
      let list = perPack.get(packed.url);
      if (!list) perPack.set(packed.url, list = []);
      list.push([packed.offset, packed.offset + packed.length]);
    }
    const plan = new Map();
    for (const [url, intervals] of perPack) {
      const size = mount.packSizes.get(url) || 0;
      if (!size) continue;
      intervals.sort((a, b) => a[0] - b[0]);
      const runs = [];
      let current = [intervals[0][0], intervals[0][1]];
      for (let i = 1; i < intervals.length; i++) {
        const [start, end] = intervals[i];
        if (start - current[1] <= gap) current[1] = Math.max(current[1], end);
        else { runs.push(current); current = [start, end]; }
      }
      runs.push(current);
      const bytes = runs.reduce((sum, r) => sum + (r[1] - r[0]), 0);
      if (runs.length > maxRuns || bytes >= RANGE_WHOLE_PACK_FRACTION * size) continue;
      plan.set(url, runs.map(([start, end]) => ({ start, end })));
    }
    return plan.size ? plan : null;
  }

  function _relBrickPath(lod, channel, bx, by, bz) {
    const c = `x${String(bx).padStart(3, '0')}_y${String(by).padStart(3, '0')}_z${String(bz).padStart(3, '0')}`;
    if (channel === -1 || channel === 'rgba') return `lod${lod}/rgba/${c}.rgba`;
    return `lod${lod}/c${channel}/${c}.webp`;
  }

  /** Compressed bytes of one brick task in its pack (0 when the pack index has no entry). */
  function taskBytes(task) {
    if (!task || !_mount || !_mount.hasPackIndex) return 0;
    return _mount.lookup(task.lod ?? 0, task.channel ?? 0, task.bx, task.by, task.bz)?.length || 0;
  }

  /** Where one brick task's bytes are stored: { url (pack, relative to the tree), offset, length } or null. */
  function brickLocation(task) {
    if (!task || !_mount || !_mount.hasPackIndex) return null;
    const loc = _mount.lookup(task.lod ?? 0, task.channel ?? 0, task.bx, task.by, task.bz);
    return loc ? { url: loc.url, offset: loc.offset, length: loc.length } : null;
  }

  /** Compressed bytes a batch of tasks has to bring in, pack index permitting. */
  function estimateTaskBytes(tasks) {
    let total = 0;
    for (const task of Array.isArray(tasks) ? tasks : []) total += taskBytes(task);
    return total;
  }

  // ── Composed bricks ─────────────────────────────────────────────────────────
  function _normalizeCompose(raw, planned) {
    const components = [1, 2, 4].includes(Number(raw.components)) ? Number(raw.components) : 4;
    const maxChannel = planned.reduce((m, t) => Math.max(m, t.channel), -1);
    const channels = Math.max(1, Math.min(components, Number(raw.channels) || (maxChannel + 1) || 1));
    return {
      components,
      channels,
      luts: Array.isArray(raw.luts) ? raw.luts : [],
      cropToVolume: raw.cropToVolume === true
    };
  }

  /** The box a composed brick is delivered as: the task's box, cut to the volume. */
  function _composeRegion(mount, unit, compose) {
    let r = unit.tasks[0].nregion;
    if (compose.cropToVolume) {
      const g = mount.grids.get(unit.lod);
      if (g) {
        const bs = mount.bs;
        // v3: stored voxel s is volume voxel 64·b − 1 + s; keep s < dim − 64·b + 2,
        // i.e. the voxels inside and one border voxel past the last one.
        const extra = mount.apron ? 2 * mount.apron : 0;
        const bw = Math.min(bs, g.dims.x - unit.bx * BRICK_SIZE + extra);
        const bh = Math.min(bs, g.dims.y - unit.by * BRICK_SIZE + extra);
        const bd = Math.min(bs, g.dims.z - unit.bz * BRICK_SIZE + extra);
        const base = r || { x0: 0, x1: bs, y0: 0, y1: bs, z0: 0, z1: bs };
        r = _normalizeRegion({
          x0: base.x0, x1: Math.min(base.x1, bw),
          y0: base.y0, y1: Math.min(base.y1, bh),
          z0: base.z0, z1: Math.min(base.z1, bd)
        }, bs);
      }
    }
    return r;
  }

  async function _runComposeBatch(batch, compose, options, ctx) {
    const { pollAbort, progress, _yieldIfBudgetSpent, failedTasks, deliveredTasks, summary } = ctx;
    const units = [];
    const byKey = new Map();
    for (const t of batch.order) {
      let u = byKey.get(t.brickKey);
      if (!u) {
        byKey.set(t.brickKey, u = { key: t.brickKey, bx: t.bx, by: t.by, bz: t.bz, lod: t.lod, tasks: [] });
        units.push(u);
      }
      u.tasks.push(t);
    }
    const perUnit = Math.max(1, Math.round(batch.order.length / Math.max(1, units.length)));
    const concurrency = Math.max(1, Math.min(
      Math.ceil((Number(options.concurrency) || _settings.concurrentLoads || DEFAULT_CONCURRENT_LOADS) / perUnit),
      units.length
    ));
    let nextUnit = 0;
    const runner = async () => {
      while (nextUnit < units.length) {
        if (pollAbort()) break;
        const unit = units[nextUnit++];
        // Tasks before this unit's are done or running: keep batch.next in step so a
        // cancellation releases the sources of the units not started yet.
        batch.next = Math.max(batch.next, unit.tasks[unit.tasks.length - 1].orderIdx + 1);
        _pump(batch);
        const out = await _composeUnit(batch, unit, compose);
        if (!batch.reason && batch.datasetEpoch === _datasetEpoch) {
          for (const t of unit.tasks) {
            if (out.failed.has(t)) {
              failedTasks.add(t);
              summary.failed.push({ bx: t.bx, by: t.by, bz: t.bz, channel: t.channel, lod: t.lod, error: out.failed.get(t) });
              console.warn(`[BrickLoader] Brick ${t.rel} failed:`, out.failed.get(t));
              options.onBrickError?.({ bx: t.bx, by: t.by, bz: t.bz, channel: t.channel, lod: t.lod, error: out.failed.get(t) });
            } else if (out.data) {
              deliveredTasks.add(t);
            }
          }
          if (out.data) {
            options.onBrickLoaded?.({
              bx: unit.bx, by: unit.by, bz: unit.bz, lod: unit.lod,
              channel: 'rgba', composed: true, components: compose.components,
              data: out.data, region: out.region,
              channels: unit.tasks.filter(t => !out.failed.has(t)).map(t => t.channel),
              failedChannels: unit.tasks.filter(t => out.failed.has(t)).map(t => t.channel),
              batchId: batch.id
            });
          }
          for (let i = 0; i < unit.tasks.length; i++) progress();
        }
        for (const t of unit.tasks) _unrefTask(batch, t);
        await _yieldIfBudgetSpent();
      }
    };
    await Promise.allSettled(Array.from({ length: concurrency }, runner));
  }

  /**
   * One brick, every channel task of it: each channel is decoded straight into the
   * brick's interleaved buffer by ONE worker (LUT applied there), then the buffer is
   * taken back once. A worker lost mid-brick takes the partial buffer with it, so the
   * whole brick starts again on another worker (bounded by RETRY_ATTEMPTS).
   */
  async function _composeUnit(batch, unit, compose) {
    const mount = batch.mount;
    const region = _composeRegion(mount, unit, compose);
    const voxels = _regionVoxels(region, mount.bs);
    const comps = compose.components;
    const failed = new Map();
    const rgbaTransport = unit.tasks.some(t => t.channel === -1);
    for (let restart = 0; restart < RETRY_ATTEMPTS; restart++) {
      failed.clear();
      if (batch.reason) return { data: null, failed, region };
      const workerDecodes = !rgbaTransport && mount.packing?.mode === 'grid'
        && mount.encoding !== 'raw-u8' && mount.encoding !== 'raw-u8-gzip';
      const rec = workerDecodes ? _pickWorker() : null;
      const gen = rec ? rec.gen : 0;
      const assemblyKey = `${batch.id}:${unit.key}:${restart}`;
      const scalars = [];
      let lost = false;
      let inWorker = 0;
      await Promise.all(unit.tasks.map(async (t) => {
        const channel = t.channel;
        if (channel !== -1 && (channel < 0 || channel >= comps)) {
          failed.set(t, _fatal(`channel ${channel} does not fit ${comps} components`));
          return;
        }
        const lut = channel >= 0 ? compose.luts[channel] || null : null;
        const job = { ...t, nregion: region };
        const outcome = await _attemptTask(batch, t, () => {
          if (rec) {
            const assemble = { rec, gen, key: assemblyKey, slot: channel, components: comps, lut };
            return _loadTask(batch, job, assemble);
          }
          return _loadTask(batch, job);
        }, true);
        if (!outcome.ok) {
          if (outcome.error?.workerLost) lost = true;
          failed.set(t, outcome.error);
          return;
        }
        if (outcome.data === 'assembled') inWorker++;
        else if (outcome.data) scalars.push({ channel, data: outcome.data, lut });
      }));
      if (batch.reason) {
        if (rec?.alive) rec.w.postMessage({ type: 'DROP', key: assemblyKey });
        return { data: null, failed, region };
      }
      if (lost && restart < RETRY_ATTEMPTS - 1) continue;
      if (failed.size === unit.tasks.length) {
        if (rec?.alive) rec.w.postMessage({ type: 'DROP', key: assemblyKey });
        return { data: null, failed, region };
      }
      let data;
      try {
        if (rec && inWorker && (!rec.alive || rec.gen !== gen)) {
          throw Object.assign(new Error('Brick decode worker lost'), { workerLost: true });
        }
        data = (rec && inWorker)
          ? await _postToWorker(batch, rec, { type: 'TAKE', key: assemblyKey, voxels, components: comps })
          : new Uint8Array(voxels * comps);
      } catch (err) {
        if (batch.reason) return { data: null, failed, region };
        if (restart < RETRY_ATTEMPTS - 1) continue;
        for (const t of unit.tasks) if (!failed.has(t)) failed.set(t, err);
        return { data: null, failed, region };
      }
      if (!data || data.length !== voxels * comps) {
        for (const t of unit.tasks) if (!failed.has(t)) failed.set(t, _fatal(`brick ${unit.key} assembled to ${data ? data.length : 0} bytes, expected ${voxels * comps}`));
        return { data: null, failed, region };
      }
      // Main-thread paths (raw transports, no worker): interleave here.
      for (const s of scalars) {
        if (s.channel === -1) {
          const box = s.data.length === voxels * 4 ? s.data : _cropBox(s.data, mount.bs, region, 4);
          const luts = compose.luts;
          for (let i = 0, o = 0; i < voxels; i++, o += 4) {
            for (let c = 0; c < Math.min(4, comps); c++) {
              const v = box[o + c];
              data[i * comps + c] = luts[c] ? luts[c][v] : v;
            }
          }
          continue;
        }
        const box = s.data.length === voxels ? s.data : _cropBox(s.data, mount.bs, region, 1);
        const lut = s.lut;
        for (let i = 0, o = s.channel; i < voxels; i++, o += comps) {
          const v = box[i];
          data[o] = lut ? lut[v] : v;
        }
      }
      return { data, failed, region };
    }
    return { data: null, failed, region };
  }

  // ── Decoding ────────────────────────────────────────────────────────────────
  async function _decodeWebp(batch, job) {
    const rec = _pickWorker();
    if (rec) {
      return _postToWorker(batch, rec, {
        type: 'DECODE', buffer: job.buffer, brickSize: job.brickSize,
        packing: job.packing, region: job.region, lut: job.lut, expect: job.expect || null
      }, [job.buffer]);
    }
    return _decodeWebpMainThread(job);
  }

  async function _decodeInto(batch, job, assemble) {
    const { rec, gen, key, slot, components, lut } = assemble;
    if (!rec.alive || rec.gen !== gen) throw Object.assign(new Error('Brick decode worker lost'), { workerLost: true });
    await _postToWorker(batch, rec, {
      type: 'DECODE', buffer: job.buffer, brickSize: job.brickSize, packing: job.packing,
      region: job.region, lut, expect: job.expect || null, assemble: { key, slot, components }
    }, [job.buffer]);
    return 'assembled';
  }

  /** Main-thread decode, used only when no decode worker can run (CSP, file://). */
  async function _decodeWebpMainThread(job) {
    if (!_fallbackWarned) {
      _fallbackWarned = true;
      console.warn('[BrickLoader] No decode worker available: decoding bricks on the main thread.');
    }
    const bs = job.brickSize;
    const packing = job.packing || {};
    const blob = new Blob([job.buffer], { type: 'image/webp' });
    let img = null;
    let objectUrl = null;
    try {
      if (typeof createImageBitmap === 'function') {
        img = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      } else {
        objectUrl = URL.createObjectURL(blob);
        img = await _imageElement(objectUrl);
      }
      if (job.expect && (img.width !== job.expect.width || img.height !== job.expect.height)) {
        throw _fatal(`brick mosaic is ${img.width}×${img.height}, expected ${job.expect.width}×${job.expect.height}`);
      }
      if (!_fallbackCanvas) {
        _fallbackCanvas = typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(img.width, img.height)
          : document.createElement('canvas');
        _fallbackCanvas.width = img.width;
        _fallbackCanvas.height = img.height;
        _fallbackCtx = _fallbackCanvas.getContext('2d', { willReadFrequently: true });
        _fallbackCtx.globalCompositeOperation = 'copy';
      } else if (_fallbackCanvas.width < img.width || _fallbackCanvas.height < img.height) {
        _fallbackCanvas.width = Math.max(_fallbackCanvas.width, img.width);
        _fallbackCanvas.height = Math.max(_fallbackCanvas.height, img.height);
        _fallbackCtx = _fallbackCanvas.getContext('2d', { willReadFrequently: true });
        _fallbackCtx.globalCompositeOperation = 'copy';
      }
      _fallbackCtx.drawImage(img, 0, 0);
      const src = _fallbackCtx.getImageData(0, 0, img.width, img.height).data;
      const region = packing.mode === 'grid' ? job.region : null;
      const r = region || { x0: 0, x1: bs, y0: 0, y1: bs, z0: 0, z1: bs };
      const rw = r.x1 - r.x0, rh = r.y1 - r.y0;
      const out = new Uint8Array(_regionVoxels(region, bs));
      const lut = job.lut || null;
      if (packing.mode === 'grid') {
        // Tile (tx, ty) holds z = ty·cols + tx; voxel (x, y, z) is mosaic pixel (tx·bs + x, ty·bs + y).
        const gridCols = Number(packing.cols);
        const cols = (Number.isFinite(gridCols) && gridCols >= 1) ? gridCols : Math.ceil(bs / Math.ceil(Math.sqrt(bs)));
        const w = img.width;
        for (let z = r.z0; z < r.z1; z++) {
          const px0 = (z % cols) * bs;
          const py0 = Math.floor(z / cols) * bs;
          for (let y = r.y0; y < r.y1; y++) {
            let dst = ((z - r.z0) * rh + (y - r.y0)) * rw;
            const py = py0 + y;
            for (let x = r.x0; x < r.x1; x++) {
              const px = px0 + x;
              const i = (py * w + px) * 4;
              const v = (px < w && py < img.height && i < src.length) ? src[i] : 0;
              out[dst++] = lut ? lut[v] : v;
            }
          }
        }
      } else {
        const len = Math.min(out.length, src.length >> 2);
        for (let i = 0; i < len; i++) out[i] = lut ? lut[src[i * 4]] : src[i * 4];
      }
      return out;
    } finally {
      if (img && typeof img.close === 'function') img.close();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }

  function _imageElement(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  // ── Worker pool ──────────────────────────────────────────────────────────────
  function _workerTarget() {
    if (_settings.decodeWorkers > 0) return _settings.decodeWorkers;
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    return Math.max(1, Math.min(8, cores - 1));
  }

  /** Spawns the pool once (it survives dataset switches) and resizes it to the target. */
  function _ensureWorkers() {
    if (typeof Worker === 'undefined') return;
    const target = _workerTarget();
    _workers = _workers.filter(rec => rec.alive);
    while (_workers.filter(r => r.alive).length > target) {
      const idle = _workers.find(r => r.alive && r.inflight === 0) || _workers.find(r => r.alive);
      _retireWorker(idle, new Error('Brick decode pool resized'));
      _workers.splice(_workers.indexOf(idle), 1);
    }
    while (_workers.filter(r => r.alive).length < target) {
      const rec = { w: null, alive: false, inflight: 0, respawns: 0, gen: 0 };
      if (!_spawnWorker(rec)) break;
      _workers.push(rec);
    }
  }

  function _spawnWorker(rec) {
    let w;
    try {
      w = new Worker(_WORKER_URL);
    } catch (e) {
      console.warn('[BrickLoader] Failed to start a decode worker:', e);
      return false;
    }
    rec.w = w;
    rec.alive = true;
    rec.gen = (rec.gen || 0) + 1;
    rec.inflight = 0;
    w.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type !== 'DECODE_RESULT') return;
      const pending = _workerPending.get(msg.id);
      if (!pending) return;
      if (msg.ok) {
        if (msg.perf && typeof window !== 'undefined' && window.VolumeViewerDebug?.logBrickDecode) {
          console.log(`[PERF-WORKER] decode: ${msg.perf.total.toFixed(2)}ms (bmp: ${msg.perf.bmp.toFixed(2)}, img: ${msg.perf.img.toFixed(2)}, loop: ${msg.perf.loop.toFixed(2)})`);
        }
        _settlePending(msg.id, true, msg.buffer ? new Uint8Array(msg.buffer) : null);
      } else {
        _settlePending(msg.id, false, new Error(msg.message || 'Brick decode failed'));
      }
    };
    // A worker that fails to load (404, CSP) or dies (OOM) never answers again: its
    // jobs are rejected (retried elsewhere) and it is replaced a bounded number of times.
    const onDead = (event) => {
      event?.preventDefault?.();
      _onWorkerDead(rec, new Error('Brick decode worker failed' + (event?.message ? ': ' + event.message : '')));
    };
    w.onerror = onDead;
    w.onmessageerror = onDead;
    return true;
  }

  function _retireWorker(rec, err) {
    if (!rec) return;
    rec.alive = false;
    try { rec.w?.terminate(); } catch (e) { /* gone */ }
    for (const [id, p] of [..._workerPending]) {
      if (p.rec === rec) _settlePending(id, false, Object.assign(err, { workerLost: true }));
    }
  }

  function _onWorkerDead(rec, err) {
    if (!rec.alive) return;
    console.error('[BrickLoader] Decode worker lost:', err.message);
    _retireWorker(rec, err);
    if (rec.respawns < MAX_WORKER_RESPAWNS) {
      rec.respawns++;
      _spawnWorker(rec);
    }
  }

  function _pickWorker() {
    let best = null;
    for (const rec of _workers) {
      if (rec.alive && (!best || rec.inflight < best.inflight)) best = rec;
    }
    return best;
  }

  function _postToWorker(batch, rec, msg, transfer = []) {
    const id = ++_workerSeq;
    return new Promise((resolve, reject) => {
      if (batch.signal.aborted) { reject(_abortError()); return; }
      if (!rec.alive) { reject(Object.assign(new Error('Brick decode worker lost'), { workerLost: true })); return; }
      const pending = { rec, batchId: batch.id, resolve, reject, signal: batch.signal, onAbort: null, timer: null };
      pending.onAbort = () => _settlePending(id, false, _abortError());
      batch.signal.addEventListener('abort', pending.onAbort, { once: true });
      pending.timer = setTimeout(() => {
        if (_workerPending.has(id)) _onWorkerDead(rec, new Error('Brick decode timed out'));
      }, _settings.decodeTimeoutMs);
      _workerPending.set(id, pending);
      rec.inflight++;
      try {
        rec.w.postMessage({ ...msg, id, batch: batch.id }, transfer);
      } catch (err) {
        _settlePending(id, false, err);
      }
    });
  }

  function _settlePending(id, ok, value) {
    const p = _workerPending.get(id);
    if (!p) return;
    _workerPending.delete(id);
    clearTimeout(p.timer);
    p.signal?.removeEventListener('abort', p.onAbort);
    p.rec.inflight = Math.max(0, p.rec.inflight - 1);
    if (ok) p.resolve(value); else p.reject(value);
  }

  // ── Cancellation / teardown ────────────────────────────────────────────────
  /** Cancel every running batch (all groups, independent ones included). */
  function cancelPending() {
    for (const batch of [..._batches]) _cancelBatch(batch, 'cancelPending');
  }

  /** Cancel the running batches of one group (e.g. 'stream'). */
  function cancelGroup(group) {
    for (const batch of [..._batches]) if (batch.group === group) _cancelBatch(batch, 'cancelGroup');
  }

  function isLoading() {
    return _batches.size > 0;
  }

  /** Drop every source no running batch needs (prefetched packs included). */
  function trimCaches() {
    for (const entry of [..._store.values()]) {
      entry.retain = false;
      _maybeRelease(entry);
    }
    _trimStore();
  }

  /** Teardown: cancel every batch, drop every source, release the fallback canvas. */
  function clearCache() {
    cancelPending();
    for (const entry of [..._store.values()]) _dropEntry(entry, true);
    _store.clear();
    _runsByPack.clear();
    _runGroups.clear();
    _bytes.pack = 0;
    _bytes.run = 0;
    // LEAK-013 (Rule 1.2): the main-thread decode canvas grows to the largest mosaic seen.
    _fallbackCtx = null;
    _fallbackCanvas = null;
  }

  function getCacheStats() {
    let pending = 0;
    let packEntries = 0;
    let rangeEntries = 0;
    for (const e of _store.values()) {
      if (e.state === 'pending') pending++;
      else if (e.kind === 'pack') packEntries++;
      else rangeEntries++;
    }
    return {
      entries: 0,                  // decoded bricks are not cached
      packEntries,
      rangeEntries,
      pendingSources: pending,
      packBytes: _bytes.pack,
      rangeBytes: _bytes.run,
      memoryEstimateMB: Math.round((_bytes.pack + _bytes.run) / MiB),
      packCacheBytes: _settings.packCacheBytes,
      rangeCacheBytes: _settings.rangeCacheBytes,
      liveBatches: _batches.size,
      workers: _workers.filter(r => r.alive).length,
      packFetches: _stats.packFetches,
      runFetches: _stats.runFetches,
      fetchedBytes: _stats.fetchedBytes,
      refetches: _stats.refetches,
      evictedInUse: _stats.evictedInUse
    };
  }

  /** A whole pack's bytes through the shared store (held only while awaited). */
  async function _fetchPackBuffer(relativeUrl, signal) {
    if (!_mount) throw new Error('BrickLoader not initialized.');
    const url = _absUrl(_mount, relativeUrl);
    _packRefs.set(url, (_packRefs.get(url) || 0) + 1);
    const entry = _store.get(url) || _createPackEntry(url);
    try {
      const got = await _awaitWithSignal(entry.promise, signal);
      return got.buffer;
    } finally {
      const n = (_packRefs.get(url) || 0) - 1;
      if (n > 0) _packRefs.set(url, n); else _packRefs.delete(url);
      const e = _store.get(url);
      if (e) _maybeRelease(e);
    }
  }

  return {
    init,
    isReady,
    getManifest,
    getTransportEncoding: () => (_mount ? _mount.encoding : null),
    getDimensions,
    getFormat,
    getLevelInfo,
    configure,
    bricksForRegion,
    hasBrick,
    prefetchPacks,
    activeBricks,
    activeBrickCount,
    loadBricks,
    loadBrickTasks,
    cancelPending,
    cancelGroup,
    isLoading,
    getCacheStats,
    trimCaches,
    clearCache,
    taskBytes,
    brickLocation,
    estimateTaskBytes,
    _planRanges,       // exposed for unit testing
    _packMajorOrder,   // exposed for unit testing
    _fetchPackBuffer,  // exposed for unit testing (ELE-17)
    _validateManifest, // exposed for unit testing (ELE-21)
    _parseV3Index,     // exposed for unit testing (SPEC §13.3)
    _parseMultipartByteranges,  // exposed for unit testing
    _parseContentRange          // exposed for unit testing
  };
})();
