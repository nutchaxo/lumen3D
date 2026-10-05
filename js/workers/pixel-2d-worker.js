/* ============================================================
   Lumen3D — 2D pixel worker
   ============================================================
   Runs the 2D viewer's display adjustments and stain isolation off the
   main thread. The page hands over an ImageBitmap of the photograph
   (transferred, not copied) and gets one back with the result painted in.

     in   { id, imageId, job, bitmap }       job: see PixelOps2D.run
     out  { id, bitmap } | { id, error }

   The illumination / tissue-context maps depend on the image alone, so they
   are kept per `imageId`: a slider drag then costs one look-up pass.
   ============================================================ */

'use strict';

importScripts('pixel-ops-2d.js');

let _cacheFor = null;
let _cache = {};

function _frameOf(bitmap) {
  const w = bitmap.width, h = bitmap.height;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  return { canvas, ctx, frame: ctx.getImageData(0, 0, w, h), w, h };
}

function _sampler(bitmap) {
  return (sw, sh) => {
    const small = new OffscreenCanvas(sw, sh);
    const sctx = small.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(bitmap, 0, 0, sw, sh);
    return sctx.getImageData(0, 0, sw, sh).data;
  };
}

self.onmessage = (e) => {
  const { id, imageId, job, bitmap } = e.data;
  try {
    if (imageId !== _cacheFor) { _cacheFor = imageId; _cache = {}; }
    const { canvas, ctx, frame, w, h } = _frameOf(bitmap);
    PixelOps2D.run(job, frame.data, w, h, _sampler(bitmap), _cache);
    ctx.putImageData(frame, 0, 0);
    bitmap.close();
    const out = canvas.transferToImageBitmap();
    self.postMessage({ id, bitmap: out }, [out]);
  } catch (err) {
    try { bitmap.close(); } catch (_) { /* already closed */ }
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
