/* ============================================================
   IRIBHM Microscopy Platform — Brick Loader
   ============================================================
   Loads chunked volume bricks (64³) from a manifest,
   manages an LRU memory cache, and provides sampling API.
   ============================================================ */

const BrickLoader = (() => {
  // Real bricks are 64³ (preprocess/3-chunk_packer.py: BRICK_SIZE=64, mosaicked 8×8
  // into 512² tiles). This is the fallback used only when a manifest level omits
  // brickSize; it MUST match the decode/SVR/shader size (all hardcoded to 64).
  // The old value 128 was a legacy constant that never matched real data and made
  // every fallback wrong (mis-sized blank bricks, 8× cache-memory estimate).
  const BRICK_SIZE = 64;
  const LRU_LIMIT = 200;
  const PACK_CACHE_LIMIT = 128;
  const DEFAULT_CONCURRENT_LOADS = 24;

  let _manifest = null;
  let _basePath = '';
  let _cache = new Map();     // key -> { data: Uint8Array, lod, channel, lastUsed }
  let _packIndex = new Map(); // brick relative path -> { url, offset, length }
  let _packCache = new Map(); // pack URL -> { promise: Promise<ArrayBuffer>, lastUsed: number }
  let _activeBricksSet = new Set(); // set of "lod:bx_by_bz" for fast lookup
  let _workerSeq = 0;
  let _workers = [];
  let _workerNextIdx = 0;
  let _workerReady = false;
  let _workerPending = new Map();
  let _pendingAbort = null;
  let _generation = 0;     // ELE-12: bumped on every init(); tags in-flight loads so stale results are dropped
  let _datasetTag = '';    // ELE-12/13: identifies the current dataset; part of the cache key
  let _packFetchController = (typeof AbortController !== 'undefined') ? new AbortController() : null;  // ELE-17: loader-owned, lifetime = pack cache (NOT per-load)
  let _loading = false;
  let _fallbackWarningCount = 0;
  let _fallbackCanvas = null;
  let _fallbackCtx = null;
  const _supportsWebGL3D = (() => {
    try {
      return !!document.createElement('canvas').getContext('webgl2');
    } catch { return false; }
  })();
  const _settings = {
    concurrentLoads: DEFAULT_CONCURRENT_LOADS,
    verifyHashes: false
  };

  // ELE-21 (Rule 1.4): encodages que le décodeur sait traiter (cf. _fetchPackedRawBrick).
  const _KNOWN_ENCODINGS = new Set(['raw-u8', 'raw-u8-gzip', 'raw-rgba-gzip', 'webp-lossless']);

  /**
   * ELE-21 (Rule 1.4): valide la structure minimale d'un manifest AVANT montage.
   * Throw explicite si malformé -> rejet propre plutôt qu'un TypeError opaque plus loin
   * (getDimensions / volume-viewer). N'inspecte PAS nonEmpty/occupiedRatio : une brick
   * vide (ESS, ELE-20) est un état légitime, pas une erreur de structure.
   */
  function _validateManifest(manifest) {
    const reject = (msg) => { throw new Error('[BrickLoader] Manifest rejected: ' + msg); };
    if (!manifest || typeof manifest !== 'object') reject('manifest is not an object.');
    if (!Array.isArray(manifest.levels) || manifest.levels.length === 0) reject('levels must be a non-empty array.');
    if (manifest.channels !== undefined && !(Number.isInteger(manifest.channels) && manifest.channels >= 1)) {
      reject('channels must be an integer >= 1.');
    }
    if (manifest.brickSize !== undefined && !(Number.isInteger(manifest.brickSize) && manifest.brickSize > 0)) {
      reject('brickSize must be a positive integer.');
    }
    manifest.levels.forEach((level, i) => {
      if (!level || typeof level !== 'object') reject('level[' + i + '] is not an object.');
      if (!Number.isInteger(level.level) || level.level < 0) reject('level[' + i + '].level must be a non-negative integer.');
      const d = level.dimensions;
      if (!d || typeof d !== 'object') reject('level[' + i + '].dimensions is missing.');
      for (const axis of ['x', 'y', 'z']) {
        if (!(Number.isFinite(d[axis]) && d[axis] > 0)) reject('level[' + i + '].dimensions.' + axis + ' must be a positive number.');
      }
      const bs = level.brickSize !== undefined ? level.brickSize : manifest.brickSize;
      if (bs !== undefined && !(Number.isInteger(bs) && bs > 0)) reject('level[' + i + '].brickSize must be a positive integer.');
    });
    const enc = manifest.brickTransport && manifest.brickTransport.encoding;
    if (enc !== undefined && enc !== null && !_KNOWN_ENCODINGS.has(enc)) {
      reject('unknown brickTransport.encoding "' + enc + '".');
    }
  }

  /**
   * Initialize from a brick manifest JSON.
   * @param {string} basePath  e.g. "DATA_WEB/fixed/dataset-name/bricks"
   * @param {object} manifest  parsed manifest.json
   */
  function init(basePath, manifest) {
    _validateManifest(manifest);     // ELE-21 (Rule 1.4): rejet AVANT toute mutation d'état partagé
    cancelPending();                 // ELE-12: abort any prior in-flight load BEFORE mutating shared state
    _generation++;                   // ELE-12: invalidate tasks that captured the previous generation
    _basePath = basePath.replace(/\/$/, '');
    _datasetTag = _basePath;         // ELE-12/13: dataset identity, part of the cache key
    _manifest = manifest;
    _cache.clear();
    _packCache.clear();
    // ELE-17: a real dataset switch -> cancel orphaned pack fetches and renew the loader-owned controller
    if (_packFetchController) { try { _packFetchController.abort(); } catch (e) {} }
    _packFetchController = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    _buildPackIndex();
    _initWorker();
    
    _activeBricksSet.clear();
    if (manifest && Array.isArray(manifest.levels)) {
      manifest.levels.forEach(level => {
        const lod = level.level;
        if (Array.isArray(level.chunks)) {
          level.chunks.forEach(chunk => {
            const parts = chunk.id.split('_');
            if (parts.length === 3) {
              const bz = parseInt(parts[0], 10);
              const by = parseInt(parts[1], 10);
              const bx = parseInt(parts[2], 10);
              if (chunk.nonEmpty !== false) {
                _activeBricksSet.add(`${lod}:${bx}_${by}_${bz}`);
              }
            }
          });
        }
      });
    }
  }

  function hasBrick(bx, by, bz, lod = 0) {
    return _activeBricksSet.has(`${lod}:${bx}_${by}_${bz}`);
  }

  function activeBricks(lod = 0) {
    const prefix = `${lod}:`;
    const bricks = [];
    for (const key of _activeBricksSet) {
      if (!key.startsWith(prefix)) continue;
      const parts = key.slice(prefix.length).split('_').map(v => parseInt(v, 10));
      if (parts.length !== 3 || parts.some(v => !Number.isFinite(v))) continue;
      bricks.push({ bx: parts[0], by: parts[1], bz: parts[2] });
    }
    return bricks;
  }

  function configure(options = {}) {
    if (Number.isFinite(Number(options.concurrentLoads))) {
      _settings.concurrentLoads = Math.max(2, Math.min(96, Math.round(Number(options.concurrentLoads))));
    }
    if (options.verifyHashes !== undefined) {
      _settings.verifyHashes = Boolean(options.verifyHashes);
    }
  }

  function isReady() {
    return Boolean(_manifest);
  }

  function getManifest() {
    return _manifest;
  }

  /**
   * Get the volume dimensions for a given LOD level.
   */
  function getDimensions(lod = 0) {
    if (!_manifest) return null;
    const level = _manifest.levels?.[lod] || _manifest.levels?.[0];
    if (!level) return null;
    return {
      x: level.dimensions.x,
      y: level.dimensions.y,
      z: level.dimensions.z,
      channels: _manifest.channels || 1,
      brickSize: level.brickSize || BRICK_SIZE,
      lod
    };
  }

  /**
   * Compute which bricks intersect a given axis-aligned slab.
   * Returns array of { bx, by, bz } brick coordinates.
   */
  function bricksForSlab(axis, value, lod = 0) {
    const dims = getDimensions(lod);
    if (!dims) return [];
    const bs = dims.brickSize;
    const nx = Math.ceil(dims.x / bs);
    const ny = Math.ceil(dims.y / bs);
    const nz = Math.ceil(dims.z / bs);
    const bricks = [];

    // value is normalized [0,1] — convert to voxel index
    const sliceIndex = Math.round(value * (
      axis === 'x' ? dims.x - 1 : axis === 'y' ? dims.y - 1 : dims.z - 1
    ));
    const brickSlice = Math.floor(sliceIndex / bs);

    for (let by = 0; by < ny; by++) {
      for (let bx = 0; bx < nx; bx++) {
        for (let bz = 0; bz < nz; bz++) {
          if (axis === 'z' && bz === brickSlice) bricks.push({ bx, by, bz });
          else if (axis === 'y' && by === brickSlice) bricks.push({ bx, by, bz });
          else if (axis === 'x' && bx === brickSlice) bricks.push({ bx, by, bz });
        }
      }
    }
    return bricks;
  }

  /**
   * Compute all bricks needed for a 3D bounding box (normalized [0,1]).
   */
  function bricksForRegion(minNorm, maxNorm, lod = 0) {
    const dims = getDimensions(lod);
    if (!dims) return [];
    const bs = dims.brickSize;

    const x0 = Math.floor(minNorm.x * dims.x / bs);
    const y0 = Math.floor(minNorm.y * dims.y / bs);
    const z0 = Math.floor(minNorm.z * dims.z / bs);
    const x1 = Math.floor(maxNorm.x * dims.x / bs);
    const y1 = Math.floor(maxNorm.y * dims.y / bs);
    const z1 = Math.floor(maxNorm.z * dims.z / bs);

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
   * Load a set of bricks (by coordinates) for a given channel and LOD.
   * Returns a Map of "bx_by_bz" -> Uint8Array pixel data.
   */
  async function loadBricks(brickCoords, channel = 0, lod = 0, options = {}) {
    const tasks = brickCoords.map(({ bx, by, bz }) => ({ bx, by, bz, channel, lod }));
    const taskResults = await loadBrickTasks(tasks, {
      ...options,
      cancelPrevious: options.cancelPrevious !== false,
      onBrickLoaded: (row) => {
        options.onBrickLoaded?.(row);
      }
    });
    const results = new Map();
    for (const [key, data] of taskResults.entries()) {
      const coord = key.split(':').pop();
      if (coord) results.set(coord, data);
    }
    return results;
  }

  /**
   * Load an interleaved list of brick/channel tasks with a single queue.
   * Task shape: { bx, by, bz, channel, lod }.
   */
  async function loadBrickTasks(tasks, options = {}) {
    if (!_manifest) throw new Error('BrickLoader not initialized.');
    
    if (options.cancelPrevious !== false) cancelPending();
    const controller = new AbortController();
    _pendingAbort = controller;
    _loading = true;
    const generation = _generation;   // ELE-12: snapshot; drop results if a dataset switch bumps _generation

    const results = new Map();
    const toLoad = [];
    const list = Array.isArray(tasks) ? tasks : [];
    let loaded = 0;
    const total = list.length;
    let cacheHits = 0;
    const useDecodedCache = options.cacheResults === true || (!options.streamOnly && options.cacheResults !== false);

    // Check cache first
    for (const task of list) {
      const lod = Number.isFinite(Number(task.lod)) ? Number(task.lod) : 0;
      const channel = Number.isFinite(Number(task.channel)) ? Number(task.channel) : 0;
      const { bx, by, bz } = task;
      const key = _cacheKey(lod, channel, bx, by, bz);
      const cached = useDecodedCache ? _cache.get(key) : null;
      if (cached) {
        cached.lastUsed = performance.now();
        if (!options.streamOnly) results.set(key, cached.data);
        options.onBrickLoaded?.({
          bx,
          by,
          bz,
          channel,
          lod,
          data: cached.data,
          fromCache: true
        });
        loaded++;
        cacheHits++;
        if (options.onProgress) options.onProgress(loaded / total);
        
        // Yield to prevent GPU upload lockups when processing thousands of cached bricks
        if (cacheHits % 4 === 0) {
          await new Promise(r => setTimeout(r, 0));
        }
      } else {
        toLoad.push({ bx, by, bz, channel, lod, key });
      }
    }

    // Load remaining in batches
    const queued = options.preserveOrder ? toLoad : _interleaveByTransport(toLoad);
    if (!queued.length && loaded === total) {
      options.onProgress?.(1);
      _loading = false;
      _pendingAbort = null;
      return results;
    }

    const concurrency = Math.max(1, Math.min(
      Number(options.concurrency) || _settings.concurrentLoads || DEFAULT_CONCURRENT_LOADS,
      queued.length
    ));
    let index = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (index < queued.length && !controller.signal.aborted && generation === _generation) {
        const { bx, by, bz, channel, lod, key } = queued[index++];
        let success = false;
        let retries = 3;
        while (retries > 0 && !success && !controller.signal.aborted) {
          try {
            const url = _brickUrl(lod, channel, bx, by, bz);
            const data = await _fetchBrickImage(url, controller.signal, { bx, by, bz, lod });
            if (generation !== _generation) { success = true; break; }  // ELE-12: switch during fetch -> don't write to the new dataset's cache
            if (useDecodedCache) {
              _cache.set(key, { data, lod, channel, lastUsed: performance.now() });
              _trimCache();
            }
            if (!options.streamOnly) results.set(key, data);
            options.onBrickLoaded?.({
              bx,
              by,
              bz,
              channel,
              lod,
              data
            });
            success = true;
          } catch (err) {
            if (err.name === 'AbortError') break;
            retries--;
            if (retries === 0) {
              console.warn(`[BrickLoader] Failed to load brick ${key} after retries:`, err);
              // ELE-20: dégradation gracieuse TRACÉE (Rule 1.1) — la brick est droppée
              // (jamais écrite au cache/atlas) et le viewer est notifié pour surfacer un statut.
              options.onBrickError?.({ bx, by, bz, channel, lod, error: err });
            } else {
              await new Promise(r => setTimeout(r, 500));
            }
          }
        }
        loaded++;
        if (options.onProgress) options.onProgress(loaded / total);
        
        // Yield slightly to prevent blocking UI when downloads are super fast (e.g. localhost)
        await new Promise(r => setTimeout(r, 1));
      }
    });
    await Promise.allSettled(workers);

    _loading = false;
    _pendingAbort = null;
    return results;
  }

  function _interleaveByTransport(tasks) {
    if (!Array.isArray(tasks) || tasks.length < 2) return tasks || [];
    const groups = new Map();
    for (const task of tasks) {
      const groupKey = _transportKeyForTask(task);
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(task);
    }
    if (groups.size <= 1) return tasks;
    const buckets = [...groups.values()].sort((a, b) => b.length - a.length);
    if (_packIndex.size > 0) {
      return buckets.flat();
    }
    const out = [];
    let added = true;
    while (added) {
      added = false;
      for (const bucket of buckets) {
        if (!bucket.length) continue;
        out.push(bucket.shift());
        added = true;
      }
    }
    return out;
  }

  /**
   * Assemble loaded bricks into a flat Uint8Array volume suitable for a 3D texture.
   * Output shape: [depth * height * width * 4] (RGBA, one channel per color slot).
   */
  function assembleBricks(brickDataMap, brickCoords, channel, lod = 0) {
    const dims = getDimensions(lod);
    if (!dims) return null;
    const bs = dims.brickSize;
    const width = dims.x;
    const height = dims.y;
    const depth = dims.z;
    const channels = Math.min(4, dims.channels);

    const volume = new Uint8Array(width * height * depth * 4);

    for (const { bx, by, bz } of brickCoords) {
      const key = `${bx}_${by}_${bz}`;
      const data = brickDataMap.get(key);
      if (!data) continue;

      const ox = bx * bs;
      const oy = by * bs;
      const oz = bz * bs;
      const bw = Math.min(bs, width - ox);
      const bh = Math.min(bs, height - oy);
      const bd = Math.min(bs, depth - oz);

      for (let lz = 0; lz < bd; lz++) {
        for (let ly = 0; ly < bh; ly++) {
          for (let lx = 0; lx < bw; lx++) {
            const srcIdx = (lz * bs * bs + ly * bs + lx);
            const gx = ox + lx;
            const gy = oy + ly;
            const gz = oz + lz;
            const dstIdx = ((gz * height + gy) * width + gx) * 4;
            // Place this channel's data in the appropriate RGBA slot
            const value = data[srcIdx] || 0;
            volume[dstIdx + channel] = value;
          }
        }
      }
    }

    return { data: volume, width, height, depth, channels };
  }

  function cancelPending() {
    if (_pendingAbort) {
      _pendingAbort.abort();
      _pendingAbort = null;
    }
    _workers.forEach(w => w.postMessage({ type: 'CANCEL' }));
    _workerPending.forEach(({ reject }) => reject(new DOMException('Brick loading cancelled', 'AbortError')));
    _workerPending.clear();
    _loading = false;
  }

  function isLoading() {
    return _loading;
  }

  function getCacheStats() {
    return {
      entries: _cache.size,
      limit: LRU_LIMIT,
      memoryEstimateMB: Math.round(_cache.size * BRICK_SIZE * BRICK_SIZE * BRICK_SIZE / 1024 / 1024)
    };
  }

  function clearCache() {
    _cache.clear();
    _packCache.clear();
    // ELE-17: teardown of the pack cache -> abort orphaned pack fetches, renew controller
    if (_packFetchController) { try { _packFetchController.abort(); } catch (e) {} }
    _packFetchController = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    _workers.forEach(w => w.postMessage({ type: 'CANCEL' }));
  }

  function _perf() {
    return typeof PerfTelemetry !== 'undefined' ? PerfTelemetry : null;
  }

  function _initWorker() {
    _workerReady = false;
    _workerPending.forEach(({ reject }) => reject(new Error('Brick worker restarted')));
    _workerPending.clear();
    if (typeof Worker === 'undefined') return;
    if (_workers && _workers.length > 0) {
      _workers.forEach(w => { try { w.terminate(); } catch (e) {} });
    }
    _workers = [];
    _workerNextIdx = 0;
    
    const cores = navigator.hardwareConcurrency || 4;
    const count = Math.max(1, Math.min(8, cores - 1));
    for (let i = 0; i < count; i++) {
        try {
          const w = new Worker('js/core/brick-decode-worker.js?v=' + Date.now());
          w.onmessage = (event) => {
            const msg = event.data || {};
            if (msg.type === 'DECODE_RESULT') {
              const pending = _workerPending.get(msg.id);
              if (!pending) return;
              _workerPending.delete(msg.id);
              if (msg.ok) {
                const bytes = new Uint8Array(msg.buffer);
                bytes._transport = 'worker';
                bytes.perf = msg.perf;
                pending.resolve(bytes);
              } else {
                pending.reject(new Error(msg.message || 'Brick worker fetch failed'));
              }
            }
          };
          w.onerror = (err) => {
            console.error('[BrickLoader] Decode Worker error:', err);
          };
          _workers.push(w);
        } catch (e) {
          console.warn('[BrickLoader] Failed to init worker:', e);
        }
    }
    _workerReady = true;
  }

  // ── Internal ──────────────────────────────────────────────

  function _cacheKey(lod, channel, bx, by, bz) {
    // ELE-13: prefix with the dataset tag so bricks from different datasets can
    // never collide in the shared LRU cache. The '|' delimiter keeps the coord
    // as the last ':'-segment (preserves key.split(':').pop() used elsewhere).
    return `${_datasetTag}|${lod}:c${channel}:${bx}_${by}_${bz}`;
  }

  function _brickUrl(lod, channel, bx, by, bz) {
    if (channel === -1 || channel === 'rgba') {
      const prefix = `${_basePath}/lod${lod}/rgba`;
      return `${prefix}/x${String(bx).padStart(3, '0')}_y${String(by).padStart(3, '0')}_z${String(bz).padStart(3, '0')}.rgba`;
    }
    const prefix = `${_basePath}/lod${lod}/c${channel}`;
    return `${prefix}/x${String(bx).padStart(3, '0')}_y${String(by).padStart(3, '0')}_z${String(bz).padStart(3, '0')}.webp`;
  }

  function _transportKeyForTask(task) {
    const url = _brickUrl(task.lod, task.channel, task.bx, task.by, task.bz);
    const rel = _hashKeyFromUrl(url);
    return _packIndex.get(rel)?.url || rel;
  }

  async function _fetchBrickImage(url, signal, coord = null) {
    const perf = _perf();
    const span = perf?.start('brick.fetch.decode.unpack', { url });
    const t0 = performance.now?.() || Date.now();
    const raw = await _fetchPackedRawBrick(url, signal, coord);
    if (raw) {
      const t1 = performance.now?.() || Date.now();
      perf?.end(span, {
        status: 'ok',
        transport: _manifest?.brickTransport?.encoding || 'raw-u8-pack',
        worker: raw._transport === 'worker',
        bytes: raw.byteLength || 0,
        fetchMs: Math.round((t1 - t0) * 100) / 100,
        blobMs: 0,
        hashMs: 0,
        decodeMs: 0,
        unpackMs: 0
      });
      return raw;
    }
    const blob = await _fetchBrickBlob(url, signal);
    const t1 = performance.now?.() || Date.now();
    const t2 = performance.now?.() || Date.now();
    if (_settings.verifyHashes) {
      await _verifyBrickHash(url, blob);
    }
    const t3 = performance.now?.() || Date.now();
    let objectUrl = null;
    const img = window.createImageBitmap
      ? await createImageBitmap(blob)
      : await _imageElement(objectUrl = URL.createObjectURL(blob));
    const t4 = performance.now?.() || Date.now();

    // Extract grayscale voxel data from the image.
    // Legacy packing: vertical stack (width=bs, height=bs*bs).
    // v2 packing: atlas grid (cols x rows tiles of bs x bs slices).
    const bs = _manifest?.levels?.[0]?.brickSize || BRICK_SIZE;
    const packing = _manifest?.brickPacking || { mode: 'vertical' };
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
    const imageData = _fallbackCtx.getImageData(0, 0, img.width, img.height);

    const totalVoxels = bs * bs * bs;
    const data = new Uint8Array(totalVoxels);
    const srcData = imageData.data;
    if (packing?.mode === 'grid') {
      // ELE-25 (BUG-004): miroir du défaut du worker — la mosaïque réelle est 8x8
      // (3-chunk_packer.py). Dériver de la géométrie réelle plutôt que le 16 magique trompeur.
      const _gridCols = Number(packing.cols);
      const cols = (Number.isFinite(_gridCols) && _gridCols >= 1)
        ? _gridCols
        : Math.ceil(bs / Math.ceil(Math.sqrt(bs)));
      const canvasWidth = img.width;
      const srcDataLocal = srcData;
      const dataLocal = data;
      const bsLocal = bs;
      
      const maxTileX = (bsLocal - 1) % cols;
      const maxTileY = Math.floor((bsLocal - 1) / cols);
      const maxPX = maxTileX * bsLocal + bsLocal - 1;
      const maxPY = maxTileY * bsLocal + bsLocal - 1;
      const isSafe = (canvasWidth > maxPX) && (img.height > maxPY) && ((maxPY * canvasWidth + maxPX) * 4 < srcDataLocal.length);
      
      if (isSafe) {
        for (let z = 0; z < bsLocal; z++) {
          const tileX = z % cols;
          const tileY = Math.floor(z / cols);
          const tileX_bs = tileX * bsLocal;
          const tileY_bs = tileY * bsLocal;
          const z_bs_bs = z * bsLocal * bsLocal;
          for (let y = 0; y < bsLocal; y++) {
            const py = tileY_bs + y;
            const py_width = py * canvasWidth;
            const z_bs_bs_y_bs = z_bs_bs + y * bsLocal;
            
            let srcIdx = (py_width + tileX_bs) * 4;
            let dstIdx = z_bs_bs_y_bs;
            
            for (let x = 0; x < bsLocal; x++) {
              dataLocal[dstIdx++] = srcDataLocal[srcIdx];
              srcIdx += 4;
            }
          }
        }
      } else {
        const srcLen = srcDataLocal.length;
        for (let z = 0; z < bsLocal; z++) {
          const tileX = z % cols;
          const tileY = Math.floor(z / cols);
          const tileX_bs = tileX * bsLocal;
          const tileY_bs = tileY * bsLocal;
          const z_bs_bs = z * bsLocal * bsLocal;
          for (let y = 0; y < bsLocal; y++) {
            const py = tileY_bs + y;
            const py_width = py * canvasWidth;
            const z_bs_bs_y_bs = z_bs_bs + y * bsLocal;
            
            let srcIdx = (py_width + tileX_bs) * 4;
            let dstIdx = z_bs_bs_y_bs;
            
            for (let x = 0; x < bsLocal; x++) {
              dataLocal[dstIdx++] = srcIdx < srcLen ? srcDataLocal[srcIdx] : 0;
              srcIdx += 4;
            }
          }
        }
      }
    } else {
      const len = Math.min(totalVoxels, srcData.length >> 2);
      const srcDataLocal = srcData;
      const dataLocal = data;
      let srcIdx = 0;
      for (let i = 0; i < len; i++) {
        dataLocal[i] = srcDataLocal[srcIdx];
        srcIdx += 4;
      }
    }

    if (objectUrl) URL.revokeObjectURL(objectUrl);
    const t5 = performance.now?.() || Date.now();
    perf?.end(span, {
      status: 'ok',
      bytes: Number(blob.size) || 0,
      fetchMs: Math.round((t1 - t0) * 100) / 100,
      blobMs: Math.round((t2 - t1) * 100) / 100,
      hashMs: Math.round((t3 - t2) * 100) / 100,
      decodeMs: Math.round((t4 - t3) * 100) / 100,
      unpackMs: Math.round((t5 - t4) * 100) / 100
    });
    return data;
  }

  async function _fetchPackedRawBrick(url, signal, coord = null) {
    // ELE-20: une brick attendue (présente dans _activeBricksSet via hasBrick) mais
    // absente de _packIndex OU renvoyant 404 est un ÉCHEC (-> throw -> drop tracé), pas
    // un vide d'ESS. Seul un vide non référencé par le manifest est un zéro légitime.
    const _expected = coord ? hasBrick(coord.bx, coord.by, coord.bz, coord.lod) : false;
    const encoding = _manifest?.brickTransport?.encoding;
    const isGzip = encoding === 'raw-u8-gzip' || encoding === 'raw-rgba-gzip';
    const isWebp = encoding === 'webp-lossless';
    const isRaw = encoding === 'raw-u8' || isGzip || isWebp;

    if (!isRaw) return null;
    const rel = _hashKeyFromUrl(url);
    const cleanRel = String(rel || '').replace(/^\/+/, '');
    const packed = _packIndex.get(cleanRel);
    
    // NATIVE DIRECT FETCH (unpacked)
    if (!packed) {
      if (_manifest?.brickTransport?.mode === 'packs' || _packIndex.size > 0) {
        // ELE-20: brick réclamée par le manifest mais absente de l'index pack =
        // pack/manifest incohérent -> échec tracé, pas un vide silencieux.
        if (_expected) throw new Error('Brick expected but missing from pack index: ' + url);
        const bs = _manifest?.levels?.[0]?.brickSize || BRICK_SIZE;
        const channels = encoding === 'raw-rgba-gzip' ? 4 : 1;
        return new Uint8Array(bs * bs * bs * channels);
      }
      if (isRaw) {
        if (!_supportsWebGL3D) {
          if (_fallbackWarningCount++ < 1) console.warn('[BrickLoader] Fetching raw brick bypassed: 3D textures unsupported.');
          return new Uint8Array(0);
        }
        
        let fileExt = encoding === 'raw-rgba-gzip' ? '.rgba.gz' : '.bin.gz';
        if (isWebp) fileExt = '.webp';
        let targetRel = cleanRel.replace(/\.(webp|rgba|bin)$/, fileExt);
        const chunkUrl = `${_basePath}/${targetRel}`;
        
        if (isWebp && _workers.length > 0 && _workerReady) {
            const resp = await fetch(chunkUrl, { signal });
            if (!resp.ok) {
                // ELE-20: 404 / range non honoré -> échec tracé (retry + drop), jamais des zéros silencieux.
                throw new Error('HTTP ' + resp.status + ' for ' + chunkUrl);
            }
            const buffer = await resp.arrayBuffer();
            try {
              return await _decodeWebpBrickInWorkerPool(buffer, signal, _manifest?.levels?.[0]?.brickSize || BRICK_SIZE, _manifest?.brickPacking || { mode: 'vertical' });
            } catch (e) {
              console.error('[BrickLoader] Worker decode failed, falling back:', e);
            }
        }
        
        const resp = await fetch(chunkUrl, { signal });
        if (!resp.ok) {
            // ELE-20: 404 sur fetch raw/gzip direct -> échec tracé, pas des zéros silencieux.
            throw new Error('HTTP ' + resp.status + ' for ' + chunkUrl);
        }
        const buffer = await resp.arrayBuffer();
        if (isGzip) return await _decompressSlice(buffer);
        return new Uint8Array(buffer);
      }
      return null;
    }
    
    // PACKED FETCH
    if (!_supportsWebGL3D) {
      if (_fallbackWarningCount++ < 1) console.warn('[BrickLoader] Fetching raw brick bypassed: 3D textures unsupported.');
      return new Uint8Array(0);
    }
    
    const buffer = await _fetchPackBuffer(packed.url, signal);
    const start = Math.max(0, Number(packed.offset) || 0);
    const end = start + Math.max(0, Number(packed.length) || 0);
    const compressedSlice = buffer.slice(start, end);
    
    if (isWebp && _workers.length > 0 && _workerReady) {
      const sliceCopy = compressedSlice.slice(0); // Copy to avoid detached buffer fallback error
      try {
        return await _decodeWebpBrickInWorkerPool(sliceCopy, signal, _manifest?.levels?.[0]?.brickSize || BRICK_SIZE, _manifest?.brickPacking || { mode: 'vertical' });
      } catch (e) {
        console.error('[BrickLoader] Worker decode failed, falling back:', e);
      }
    }
    
    if (isGzip) return await _decompressSlice(compressedSlice);
    return new Uint8Array(compressedSlice);
  }

  async function _decompressSlice(buffer) {
    if (typeof DecompressionStream !== 'undefined') {
      const stream = new Response(buffer).body.pipeThrough(new DecompressionStream('gzip'));
      const uncompressed = await new Response(stream).arrayBuffer();
      return new Uint8Array(uncompressed);
    }
    throw new Error('DecompressionStream is unavailable.');
  }

  function _decodeWebpBrickInWorkerPool(buffer, signal, brickSize, packing) {
    const id = ++_workerSeq;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Brick loading cancelled', 'AbortError'));
        return;
      }
      const onAbort = () => {
        _workerPending.delete(id);
        reject(new DOMException('Brick loading cancelled', 'AbortError'));
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });
      _workerPending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener?.('abort', onAbort);
          if (value.perf && window.VolumeViewerDebug?.logBrickDecode) {
            console.log(`[PERF-WORKER] decode: ${value.perf.total.toFixed(2)}ms (bmp: ${value.perf.bmp.toFixed(2)}, img: ${value.perf.img.toFixed(2)}, loop: ${value.perf.loop.toFixed(2)})`);
          }
          resolve(value);
        },
        reject: (err) => {
          signal?.removeEventListener?.('abort', onAbort);
          reject(err);
        }
      });
      const worker = _workers[_workerNextIdx];
      _workerNextIdx = (_workerNextIdx + 1) % _workers.length;
      worker.__idx = _workerNextIdx; worker.postMessage({ type: 'DECODE', id, buffer, brickSize, packing }, [buffer]);
    });
  }

  async function _fetchBrickBlob(url, signal) {
    const rel = _hashKeyFromUrl(url);
    const packed = _packIndex.get(rel);
    if (packed) {
      const buffer = await _fetchPackBuffer(packed.url, signal);
      const start = Math.max(0, Number(packed.offset) || 0);
      const end = start + Math.max(0, Number(packed.length) || 0);
      return new Blob([buffer.slice(start, end)], { type: 'image/webp' });
    }
    const resp = await fetch(url, { signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    return resp.blob();
  }

  // ELE-17 (RACE-031): the per-URL pack promise is shared between concurrent
  // loads. Binding the actual fetch to the FIRST caller's per-load signal meant
  // a stale load's cancellation aborted bricks of the current load. Bind the
  // shared fetch to the loader-owned _packFetchController (lifetime = pack cache,
  // only aborted on init()/clearCache) and honour the caller's own signal by
  // racing the shared promise against it — without poisoning it for others.
  async function _fetchPackBuffer(relativeUrl, signal) {
    const url = `${_basePath}/${String(relativeUrl).replace(/^\/+/, '')}`;
    let entry = _packCache.get(url);
    if (!entry) {
      _trimPackCache(PACK_CACHE_LIMIT - 1);
      const fetchSignal = _packFetchController ? _packFetchController.signal : signal;
      const promise = fetch(url, { signal: fetchSignal }).then(async resp => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
        return resp.arrayBuffer();
      }).catch(err => {
        _packCache.delete(url);
        throw err;
      });
      entry = { promise, lastUsed: performance.now?.() || Date.now() };
      _packCache.set(url, entry);
    } else {
      entry.lastUsed = performance.now?.() || Date.now();
    }
    return _awaitWithSignal(entry.promise, signal);
  }

  // Resolve/reject with `promise`, but reject early (AbortError) if `signal`
  // aborts — without aborting the underlying shared fetch (other callers keep it).
  function _awaitWithSignal(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
        (e) => { signal.removeEventListener('abort', onAbort); reject(e); }
      );
    });
  }

  function _trimPackCache(limit = PACK_CACHE_LIMIT) {
    if (_packCache.size <= limit) return;
    const entries = [..._packCache.entries()].sort((a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0));
    const removeCount = Math.max(0, _packCache.size - Math.max(0, limit));
    for (let i = 0; i < removeCount; i++) {
      _packCache.delete(entries[i][0]);
    }
  }

  function _buildPackIndex() {
    _packIndex = new Map();
    const index = _manifest?.brickTransport?.brickToPack;
    if (!index || typeof index !== 'object') return;
    for (const [brickPath, entry] of Object.entries(index)) {
      if (!entry?.url || !Number.isFinite(Number(entry.offset)) || !Number.isFinite(Number(entry.length))) continue;
      _packIndex.set(String(brickPath).replace(/^\/+/, ''), {
        url: String(entry.url).replace(/^\/+/, ''),
        offset: Number(entry.offset),
        length: Number(entry.length)
      });
    }
  }

  async function _verifyBrickHash(url, blob) {
    if (!_manifest?.hashes || !window.crypto?.subtle) return;
    const expected = _manifest.hashes[_hashKeyFromUrl(url)];
    if (!expected) return;
    const buf = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    const actual = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    if (actual !== expected) {
      throw new Error('Brick hash mismatch for ' + url);
    }
  }

  function _hashKeyFromUrl(url) {
    try {
      // Robustly extract the relative path regardless of absolute/relative differences
      let rel = String(url);
      if (rel.startsWith('http')) {
        const parsedUrl = new URL(rel);
        rel = parsedUrl.pathname;
      }
      // Convert basePath to a pathname for safe replacement
      let base = String(_basePath);
      if (base.startsWith('http')) {
        base = new URL(base).pathname;
      } else if (!base.startsWith('/')) {
        base = '/' + base;
      }
      if (!rel.startsWith('/')) rel = '/' + rel;
      
      if (rel.startsWith(base)) {
        return rel.slice(base.length).replace(/^\/+/, '');
      }
      return rel.replace(/^\/+/, '');
    } catch (e) {
      return String(url).replace(_basePath, '').replace(/^\/+/, '');
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

  function _trimCache() {
    if (_cache.size <= LRU_LIMIT) return;
    // Evict least recently used
    const entries = [..._cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const toRemove = entries.slice(0, _cache.size - LRU_LIMIT);
    for (const [key] of toRemove) {
      _cache.delete(key);
    }
  }

  return {
    init,
    isReady,
    getManifest,
    getTransportEncoding: () => _manifest?.brickTransport?.encoding || null,
    getDimensions,
    configure,
    bricksForSlab,
    bricksForRegion,
    hasBrick,
    activeBricks,
    loadBricks,
    loadBrickTasks,
    assembleBricks,
    cancelPending,
    isLoading,
    getCacheStats,
    clearCache,
    _cacheKey,         // exposed for unit testing (ELE-13)
    _fetchPackBuffer,  // exposed for unit testing (ELE-17)
    _validateManifest  // exposed for unit testing (ELE-21)
  };
})();
