/* IRIBHM Brick Fetch Worker
   Fetches and decompresses packed brick payloads off the main thread. */

let _manifest = null;
let _basePath = '';
let _packIndex = new Map();
let _packCache = new Map();
let _controllers = new Set();

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type === 'INIT') {
    _basePath = String(msg.basePath || '').replace(/\/$/, '');
    _manifest = msg.manifest || null;
    _packCache = new Map();
    _buildPackIndex();
    self.postMessage({ type: 'READY' });
    return;
  }
  if (msg.type === 'CANCEL') {
    for (const controller of _controllers) controller.abort();
    _controllers.clear();
    _packCache.clear();
    return;
  }
  if (msg.type === 'FETCH_RAW') {
    const id = msg.id;
    try {
      const bytes = await _fetchRaw(msg.rel);
      self.postMessage({ type: 'RAW_RESULT', id, ok: true, buffer: bytes.buffer }, [bytes.buffer]);
    } catch (err) {
      const cleanRel = String(msg.rel || '').replace(/^\/+/, '');
      const packed = _packIndex.get(cleanRel);
      const targetUrl = packed ? `${_basePath}/${String(packed.url).replace(/^\/+/, '')}` : `${_basePath}/${cleanRel}`;
      self.postMessage({ type: 'RAW_RESULT', id, ok: false, message: `Failed to fetch URL [${targetUrl}]: ${err?.message || String(err)}` });
    }
  }
};

  async function _fetchRaw(rel) {
    const encoding = _manifest?.brickTransport?.encoding;
    const isGzip = encoding === 'raw-u8-gzip' || encoding === 'raw-rgba-gzip';
    const isWebp = encoding === 'webp-lossless';
    const isRaw = encoding === 'raw-u8' || isGzip || isWebp;

    const cleanRel = String(rel || '').replace(/^\/+/, '');
    const packed = _packIndex.get(cleanRel);
    
    // NATIVE DIRECT FETCH (unpacked)
    if (!packed) {
        if (_manifest?.brickTransport?.mode === 'packs' || _packIndex.size > 0) {
            const bs = _manifest?.levels?.[0]?.brickSize || 64; // real bricks are 64³ (was misleading legacy 128)
            const channels = encoding === 'raw-rgba-gzip' ? 4 : 1;
            return new Uint8Array(bs * bs * bs * channels);
        }
        if (isRaw) {
            let fileExt = encoding === 'raw-rgba-gzip' ? '.rgba.gz' : (isWebp ? '.webp' : '.bin.gz');
            let targetRel = cleanRel.replace(/\.(webp|rgba|bin)$/, fileExt);
            const url = `${_basePath}/${targetRel}`;
            const resp = await fetch(url);
            if (!resp.ok) {
                const bs = _manifest?.levels?.[0]?.brickSize || 64; // real bricks are 64³ (was misleading legacy 128)
                const channels = encoding === 'raw-rgba-gzip' ? 4 : 1;
                return new Uint8Array(bs * bs * bs * channels);
            }
            const buffer = await resp.arrayBuffer();
            if (isGzip) return await _decompressSlice(buffer);
            if (isWebp) return await _decodeWebpBrick(buffer);
            return new Uint8Array(buffer);
        }
        throw new Error(`No packed brick entry for ${rel}`);
    }

    // PACKED FETCH (legacy)
    const buffer = await _fetchPackBuffer(packed.url);
    const start = Math.max(0, Number(packed.offset) || 0);
    const end = start + Math.max(0, Number(packed.length) || 0);
    const compressedSlice = buffer.slice(start, end);
    
    if (isGzip) return await _decompressSlice(compressedSlice);
    if (isWebp) return await _decodeWebpBrick(compressedSlice);
    return new Uint8Array(compressedSlice);
  }

async function _decompressSlice(buffer) {
  if (typeof DecompressionStream !== 'undefined') {
    const stream = new Response(buffer).body.pipeThrough(new DecompressionStream('gzip'));
    const uncompressed = await new Response(stream).arrayBuffer();
    return new Uint8Array(uncompressed);
  }
  throw new Error('DecompressionStream is unavailable in this worker.');
}

async function _decodeWebpBrick(buffer) {
    const blob = new Blob([buffer], { type: 'image/webp' });
    const imgBitmap = await createImageBitmap(blob);
    
    const canvas = new OffscreenCanvas(512, 512);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(imgBitmap, 0, 0);
    const imgData = ctx.getImageData(0, 0, 512, 512).data;
    
    const volume = new Uint8Array(64 * 64 * 64);
    for (let z = 0; z < 64; z++) {
        const row = Math.floor(z / 8);
        const col = z % 8;
        const zOffset = z * 64 * 64;
        for (let y = 0; y < 64; y++) {
            const destOffset = zOffset + (y * 64);
            const srcRowOffset = ((row * 64 + y) * 512 + (col * 64)) * 4;
            for (let x = 0; x < 64; x++) {
                volume[destOffset + x] = imgData[srcRowOffset + x * 4];
            }
        }
    }
    return volume;
}

async function _fetchPackBuffer(relativeUrl) {
  const url = `${_basePath}/${String(relativeUrl).replace(/^\/+/, '')}`;
  let promise = _packCache.get(url);
  if (!promise) {
    const controller = new AbortController();
    _controllers.add(controller);
    promise = fetch(url, { signal: controller.signal })
      .then(async resp => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
        return resp.arrayBuffer();
      })
      .finally(() => _controllers.delete(controller))
      .catch(err => {
        console.error(`[Worker] Fetch failed for URL: ${url}`, err);
        _packCache.delete(url);
        throw err;
      });
    _packCache.set(url, promise);
  }
  return promise;
}

async function _decompressGzipResponse(resp) {
  if (typeof DecompressionStream !== 'undefined' && resp.body) {
    const stream = resp.body.pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }
  throw new Error('DecompressionStream is unavailable in this worker.');
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
