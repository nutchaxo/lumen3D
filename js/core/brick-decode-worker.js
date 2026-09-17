/* IRIBHM Brick Decode Worker
   Decodes WebP buffers into Raw Uint8Arrays off the main thread. */

let decodeQueue = Promise.resolve();
let canvas = null;
let ctx = null;
let cancelEpoch = 0;   // bumped on CANCEL; queued/in-flight decodes from an older epoch are dropped

self.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type === 'CANCEL') {
    // A superseded load (dataset / quality / timepoint switch) asked to cancel:
    // bump the epoch so queued jobs are skipped and in-flight results suppressed.
    // (The CPU decode loop is not abortable mid-flight, so we gate the result.)
    cancelEpoch++;
    return;
  }
  if (msg.type === 'DECODE') {
    const epoch = cancelEpoch;
    decodeQueue = decodeQueue.then(() => processDecode(msg, epoch)).catch(console.error);
  }
};

async function processDecode(msg, epoch) {
  // Skip a job cancelled before it started running.
  if (epoch !== cancelEpoch) return;
  const id = msg.id;
  let bmp = null;
  try {
    const t0 = performance.now();
    const buffer = msg.buffer;
    const bs = msg.brickSize || 64;
    // BUG-065: no implicit 'vertical' default — a linear read of a grid-mosaic image
    // scrambles the volume (silent garbage with ok:true). An unknown/absent mode now
    // fails loud below instead of mounting corrupt voxels.
    const packing = msg.packing || {};

    const blob = new Blob([buffer], { type: 'image/webp' });
    bmp = await createImageBitmap(blob);
    const t1 = performance.now();

    if (!canvas) {
      canvas = new OffscreenCanvas(bmp.width, bmp.height);
      ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.globalCompositeOperation = 'copy';
    } else if (canvas.width < bmp.width || canvas.height < bmp.height) {
      canvas.width = Math.max(canvas.width, bmp.width);
      canvas.height = Math.max(canvas.height, bmp.height);
      ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.globalCompositeOperation = 'copy';
    }
    ctx.drawImage(bmp, 0, 0);

    // An optional sub-box of the brick, voxel ranges [x0,x1) x [y0,y1) x [z0,z1).
    // A slice through the volume needs one or a few voxel planes of every brick it
    // crosses, and un-mosaicking, shipping and uploading the other sixty is what made
    // the Studio's native pass crawl. The result is then the compact region alone
    // (z-major, then y, then x); a caller tells it from a full brick by its length.
    // Only the grid layout knows how to cut: every other path returns the full brick.
    const region = packing.mode === 'grid' ? normalizeRegion(msg.region, bs) : null;
    const rx0 = region ? region.x0 : 0, rx1 = region ? region.x1 : bs;
    const ry0 = region ? region.y0 : 0, ry1 = region ? region.y1 : bs;
    const rz0 = region ? region.z0 : 0, rz1 = region ? region.z1 : bs;
    const rw = rx1 - rx0, rh = ry1 - ry0, rd = rz1 - rz0;
    const totalVoxels = bs * bs * bs;
    const bytes = new Uint8Array(rw * rh * rd);
    let t2 = t1;

    if (packing.mode === 'grid') {
      // ELE-25 (BUG-004): la mosaïque réelle (3-chunk_packer.py) est invariablement 8x8
      // pour bs=64. Le défaut historique 16 ne correspondait à AUCUN format produit et
      // provoquait un délacement Z silencieux (ok:true) si un manifest grid omettait `cols`.
      // On dérive le défaut de la géométrie réelle : ceil(bs/ceil(sqrt(bs))) -> 64 => 8.
      const _gridCols = Number(packing.cols);
      const cols = (Number.isFinite(_gridCols) && _gridCols >= 1)
        ? _gridCols
        : Math.ceil(bs / Math.ceil(Math.sqrt(bs)));
      const bmpWidth = bmp.width;
      const bsLocal = bs;

      // Read back only the mosaic rows that hold the wanted tiles: for a single
      // slice that is one tile row (an eighth of the image) instead of the whole
      // 512x512 readback.
      const tileY0 = Math.floor(rz0 / cols);
      const tileY1 = Math.floor((rz1 - 1) / cols);
      const rowOrigin = tileY0 * bsLocal;
      const readH = Math.max(1, Math.min(bmp.height - rowOrigin, (tileY1 - tileY0 + 1) * bsLocal));
      const imgData = ctx.getImageData(0, rowOrigin, bmpWidth, readH);
      t2 = performance.now();
      const srcDataLocal = imgData.data;
      const bytesLocal = bytes;

      let maxTileX = 0;
      for (let z = rz0; z < rz1; z++) maxTileX = Math.max(maxTileX, z % cols);
      const maxPX = maxTileX * bsLocal + rx1 - 1;
      const maxPY = (tileY1 - tileY0) * bsLocal + ry1 - 1;
      const isSafe = (bmpWidth > maxPX) && (readH > maxPY) && ((maxPY * bmpWidth + maxPX) * 4 < srcDataLocal.length);
      const srcLen = srcDataLocal.length;

      for (let z = rz0; z < rz1; z++) {
        const tileX_bs = (z % cols) * bsLocal;
        const tileY_bs = (Math.floor(z / cols) - tileY0) * bsLocal;
        const zOff = (z - rz0) * rh * rw;

        for (let y = ry0; y < ry1; y++) {
          let srcIdx = ((tileY_bs + y) * bmpWidth + tileX_bs + rx0) * 4;
          let dstIdx = zOff + (y - ry0) * rw;

          if (isSafe) {
            for (let x = rx0; x < rx1; x++) {
              bytesLocal[dstIdx++] = srcDataLocal[srcIdx];
              srcIdx += 4;
            }
          } else {
            for (let x = rx0; x < rx1; x++) {
              bytesLocal[dstIdx++] = srcIdx < srcLen ? srcDataLocal[srcIdx] : 0;
              srcIdx += 4;
            }
          }
        }
      }
    } else if (packing.mode === 'vertical') {
      // Explicit legacy vertical layout (width=bs, height=bs*bs). No current dataset
      // produces this; kept only for an explicitly-tagged manifest, never as a default.
      const imgData = ctx.getImageData(0, 0, bmp.width, bmp.height);
      t2 = performance.now();
      const srcData = imgData.data;
      const len = Math.min(totalVoxels, srcData.length >> 2);
      const srcDataLocal = srcData;
      const bytesLocal = bytes;
      let srcIdx = 0;
      for (let i = 0; i < len; i++) {
        bytesLocal[i] = srcDataLocal[srcIdx];
        srcIdx += 4;
      }
    } else {
      // BUG-065 (Rule 1.4 / 1.1): unknown or absent packing mode — fail loud rather
      // than silently producing a scrambled volume. The loader surfaces the dropped
      // brick as a status (onBrickError) instead of mounting corrupt data.
      if (epoch !== cancelEpoch) return;
      self.postMessage({ type: 'DECODE_RESULT', id, ok: false, message: 'unknown packing mode: ' + JSON.stringify(packing.mode) });
      return;
    }

    const t3 = performance.now();

    // Suppress the result if a CANCEL arrived while we were decoding.
    if (epoch !== cancelEpoch) return;
    self.postMessage({
      type: 'DECODE_RESULT',
      id,
      ok: true,
      buffer: bytes.buffer,
      region,
      perf: { bmp: t1-t0, img: t2-t1, loop: t3-t2, total: t3-t0 }
    }, [bytes.buffer]);
  } catch (err) {
    if (epoch !== cancelEpoch) return;
    self.postMessage({ type: 'DECODE_RESULT', id, ok: false, message: err.message });
  } finally {
    // LEAK-011 (Rule 1.2): release the decoded ImageBitmap graphics handle on every
    // path (success, cancel-suppress, error) — otherwise one bitmap leaks per brick.
    if (bmp && typeof bmp.close === 'function') bmp.close();
  }
}

/**
 * A requested sub-box of a brick, or null for the whole brick. Bounds are integers
 * clamped to [0, bs]; an empty or malformed box, and a box covering everything, both
 * mean "the full brick" so the caller's length test stays the only contract.
 */
function normalizeRegion(raw, bs) {
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
