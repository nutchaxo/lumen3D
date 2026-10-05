/* IRIBHM Brick Decode Worker
   Decodes the 512² WebP mosaic of one 64³ brick channel (8×8 tiles, one z plane per
   tile) into voxel bytes off the main thread, and optionally composes the channels of
   a brick into one RGBA buffer so the page never runs the per-voxel interleave.
   A v3 brick (66³ with its 1-voxel border, 9 × 8 tiles of 66², 594 × 528) is the same
   grid layout with brickSize 66 and cols 9: `brickSize` is the stored edge (tile size
   and brick extent alike), `expect` {width, height} the only picture size accepted.

   Messages (all but CANCEL are run in arrival order on one queue):
     DECODE {id, batch, buffer, brickSize, packing, region?, lut?, assemble?, expect?}
       → DECODE_RESULT {id, ok, buffer?, region, assembled?, message?}
       Without `assemble` the result is the scalar voxels of `region` (or of the
       whole brick), with `lut` (256 bytes) applied when given.
       With `assemble: {key, slot, components}` the voxels are written, LUT applied,
       at stride `components` into the assembly buffer `key` (created zero-filled on
       first use, sized region voxels × components) and the result carries no bytes.
     TAKE {id, batch, key, voxels, components} → DECODE_RESULT {id, ok, buffer}: the
       assembly, transferred and forgotten (zero-filled when no channel was written).
     DROP {key}: forget an assembly.
     CANCEL {batch?}: with a batch id, drop that batch's queued jobs, suppress its
       in-flight results and forget its assemblies; without, the same for every job
       posted so far (epoch). */

let decodeQueue = Promise.resolve();
let canvas = null;
let ctx = null;
let cancelEpoch = 0;   // bumped on a global CANCEL; jobs from an older epoch are dropped
const cancelledBatches = new Set();
const CANCELLED_BATCH_MEMORY = 1024;
const assemblies = new Map();   // key -> { buf: Uint8Array, batch }

self.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type === 'CANCEL') {
    if (msg.batch !== undefined && msg.batch !== null) {
      cancelledBatches.add(msg.batch);
      if (cancelledBatches.size > CANCELLED_BATCH_MEMORY) {
        cancelledBatches.delete(cancelledBatches.values().next().value);
      }
      for (const [key, a] of assemblies) if (a.batch === msg.batch) assemblies.delete(key);
    } else {
      // The CPU decode loop is not abortable mid-flight, so the result is gated instead.
      cancelEpoch++;
      assemblies.clear();
    }
    return;
  }
  if (msg.type === 'DROP') {
    assemblies.delete(msg.key);
    return;
  }
  if (msg.type === 'DECODE' || msg.type === 'TAKE') {
    const epoch = cancelEpoch;
    decodeQueue = decodeQueue.then(() => (msg.type === 'TAKE' ? processTake(msg, epoch) : processDecode(msg, epoch))).catch(console.error);
  }
};

function isLive(msg, epoch) {
  return epoch === cancelEpoch && !(msg.batch !== undefined && msg.batch !== null && cancelledBatches.has(msg.batch));
}

function processTake(msg, epoch) {
  if (!isLive(msg, epoch)) return;
  const components = msg.components || 4;
  let a = assemblies.get(msg.key);
  assemblies.delete(msg.key);
  const buf = a ? a.buf : new Uint8Array(Math.max(0, msg.voxels | 0) * components);
  self.postMessage({ type: 'DECODE_RESULT', id: msg.id, ok: true, buffer: buf.buffer, assembled: true }, [buf.buffer]);
}

async function processDecode(msg, epoch) {
  // Skip a job cancelled before it started running.
  if (!isLive(msg, epoch)) return;
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
    // The bytes are measured intensities, not colours: no colour management, no
    // alpha premultiplication may touch them on the way to the canvas.
    bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const t1 = performance.now();
    // A mosaic of a known size (a v3 brick: 9 × 8 slices of 66², 594 × 528) that
    // decodes to another size is corrupt: refuse it rather than pad it with zeros.
    const expect = msg.expect && typeof msg.expect === 'object' ? msg.expect : null;
    if (expect && (bmp.width !== expect.width || bmp.height !== expect.height)) {
      throw new Error(`brick mosaic is ${bmp.width}×${bmp.height}, expected ${expect.width}×${expect.height}`);
    }

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
    const voxels = rw * rh * rd;
    const totalVoxels = bs * bs * bs;

    // Destination: a fresh scalar buffer, or the brick's RGBA (or RG / R) assembly at
    // stride `components`, offset `slot`.
    const assemble = msg.assemble && typeof msg.assemble === 'object' ? msg.assemble : null;
    let dst, stride, offset;
    if (assemble) {
      stride = Math.max(1, Math.min(4, assemble.components || 4));
      offset = Math.max(0, Math.min(stride - 1, assemble.slot | 0));
      let a = assemblies.get(assemble.key);
      if (!a || a.buf.length !== voxels * stride) {
        a = { buf: new Uint8Array(voxels * stride), batch: msg.batch };
        assemblies.set(assemble.key, a);
      }
      dst = a.buf;
    } else {
      stride = 1;
      offset = 0;
      dst = new Uint8Array(voxels);
    }
    const lut = msg.lut && msg.lut.length >= 256 ? msg.lut : null;
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

      // Tile (tx, ty) of the mosaic holds z = ty·cols + tx; voxel (x, y, z) sits at
      // mosaic pixel (tx·bs + x, ty·bs + y). Only the wanted y rows of each wanted
      // tile row are read back: one band of `rh` rows per tile row when the box is
      // thinner than a tile (an XZ cut reads 8 × 3 rows instead of 512), otherwise
      // the tile rows as one block.
      const tileY0 = Math.floor(rz0 / cols);
      const tileY1 = Math.floor((rz1 - 1) / cols);
      const bands = [];
      if (rh < bs && tileY1 > tileY0) {
        for (let ty = tileY0; ty <= tileY1; ty++) {
          const top = ty * bs + ry0;
          const h = Math.max(0, Math.min(bmp.height - top, rh));
          bands.push({ ty0: ty, ty1: ty, top, h, data: h > 0 ? ctx.getImageData(0, top, bmpWidth, h).data : null });
        }
      } else {
        const top = tileY0 * bs;
        const h = Math.max(1, Math.min(bmp.height - top, (tileY1 - tileY0 + 1) * bs));
        bands.push({ ty0: tileY0, ty1: tileY1, top, h, data: ctx.getImageData(0, top, bmpWidth, h).data });
      }
      t2 = performance.now();

      for (const band of bands) {
        const src = band.data;
        const srcLen = src ? src.length : 0;
        for (let z = Math.max(rz0, band.ty0 * cols); z < Math.min(rz1, (band.ty1 + 1) * cols); z++) {
          const tileX_bs = (z % cols) * bs;
          const tileTop = Math.floor(z / cols) * bs;
          const zOff = (z - rz0) * rh * rw;
          for (let y = ry0; y < ry1; y++) {
            const py = tileTop + y - band.top;          // row inside the band
            let dstIdx = (zOff + (y - ry0) * rw) * stride + offset;
            if (!src || py < 0 || py >= band.h || tileX_bs + rx1 > bmpWidth) {
              // Out of the decoded picture (a truncated mosaic): those voxels stay 0.
              let srcIdx = (py * bmpWidth + tileX_bs + rx0) * 4;
              for (let x = rx0; x < rx1; x++) {
                const v = (src && py >= 0 && py < band.h && tileX_bs + x < bmpWidth && srcIdx < srcLen) ? src[srcIdx] : 0;
                dst[dstIdx] = lut ? lut[v] : v;
                dstIdx += stride;
                srcIdx += 4;
              }
              continue;
            }
            let srcIdx = (py * bmpWidth + tileX_bs + rx0) * 4;
            if (lut) {
              for (let x = rx0; x < rx1; x++) { dst[dstIdx] = lut[src[srcIdx]]; dstIdx += stride; srcIdx += 4; }
            } else {
              for (let x = rx0; x < rx1; x++) { dst[dstIdx] = src[srcIdx]; dstIdx += stride; srcIdx += 4; }
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
      const len = Math.min(totalVoxels, srcData.length >> 2, voxels);
      let srcIdx = 0;
      for (let i = 0, d = offset; i < len; i++, d += stride) {
        const v = srcData[srcIdx];
        dst[d] = lut ? lut[v] : v;
        srcIdx += 4;
      }
    } else {
      // BUG-065 (Rule 1.4 / 1.1): unknown or absent packing mode — fail loud rather
      // than silently producing a scrambled volume. The loader surfaces the dropped
      // brick as a status (onBrickError) instead of mounting corrupt data.
      if (!isLive(msg, epoch)) return;
      self.postMessage({ type: 'DECODE_RESULT', id, ok: false, message: 'unknown packing mode: ' + JSON.stringify(packing.mode) });
      return;
    }

    const t3 = performance.now();

    // Suppress the result if a CANCEL arrived while we were decoding.
    if (!isLive(msg, epoch)) return;
    const perf = { bmp: t1 - t0, img: t2 - t1, loop: t3 - t2, total: t3 - t0 };
    if (assemble) {
      self.postMessage({ type: 'DECODE_RESULT', id, ok: true, assembled: true, region, perf });
    } else {
      self.postMessage({ type: 'DECODE_RESULT', id, ok: true, buffer: dst.buffer, region, perf }, [dst.buffer]);
    }
  } catch (err) {
    if (!isLive(msg, epoch)) return;
    self.postMessage({ type: 'DECODE_RESULT', id, ok: false, message: err && err.message ? err.message : String(err) });
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
