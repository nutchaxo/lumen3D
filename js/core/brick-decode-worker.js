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
    const imgData = ctx.getImageData(0, 0, bmp.width, bmp.height);
    const t2 = performance.now();

    
    const totalVoxels = bs * bs * bs;
    const bytes = new Uint8Array(totalVoxels);
    const srcData = imgData.data;
    
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
      const srcDataLocal = srcData;
      const bytesLocal = bytes;
      const bsLocal = bs;
      
      const maxTileX = (bsLocal - 1) % cols;
      const maxTileY = Math.floor((bsLocal - 1) / cols);
      const maxPX = maxTileX * bsLocal + bsLocal - 1;
      const maxPY = maxTileY * bsLocal + bsLocal - 1;
      const isSafe = (bmpWidth > maxPX) && (bmp.height > maxPY) && ((maxPY * bmpWidth + maxPX) * 4 < srcDataLocal.length);
      
      if (isSafe) {
        for (let z = 0; z < bsLocal; z++) {
          const tileX = z % cols;
          const tileY = Math.floor(z / cols);
          const tileX_bs = tileX * bsLocal;
          const tileY_bs = tileY * bsLocal;
          const z_bs_bs = z * bsLocal * bsLocal;
          
          for (let y = 0; y < bsLocal; y++) {
            const py = tileY_bs + y;
            const py_width = py * bmpWidth;
            const z_bs_bs_y_bs = z_bs_bs + y * bsLocal;
            
            let srcIdx = (py_width + tileX_bs) * 4;
            let dstIdx = z_bs_bs_y_bs;
            
            for (let x = 0; x < bsLocal; x++) {
              bytesLocal[dstIdx++] = srcDataLocal[srcIdx];
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
            const py_width = py * bmpWidth;
            const z_bs_bs_y_bs = z_bs_bs + y * bsLocal;
            
            let srcIdx = (py_width + tileX_bs) * 4;
            let dstIdx = z_bs_bs_y_bs;
            
            for (let x = 0; x < bsLocal; x++) {
              bytesLocal[dstIdx++] = srcIdx < srcLen ? srcDataLocal[srcIdx] : 0;
              srcIdx += 4;
            }
          }
        }
      }
    } else if (packing.mode === 'vertical') {
      // Explicit legacy vertical layout (width=bs, height=bs*bs). No current dataset
      // produces this; kept only for an explicitly-tagged manifest, never as a default.
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
