/* IRIBHM Brick Decode Worker
   Decodes WebP buffers into Raw Uint8Arrays off the main thread. */

let decodeQueue = Promise.resolve();
let canvas = null;
let ctx = null;

self.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type === 'DECODE') {
    decodeQueue = decodeQueue.then(() => processDecode(msg)).catch(console.error);
  }
};

async function processDecode(msg) {
  const id = msg.id;
  try {
    const t0 = performance.now();
    const buffer = msg.buffer;
    const bs = msg.brickSize || 64;
    const packing = msg.packing || { mode: 'vertical' };
    
    const blob = new Blob([buffer], { type: 'image/webp' });
    const bmp = await createImageBitmap(blob);
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
      const cols = Math.max(1, Number(packing.cols) || 16);
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
    } else {
      const len = Math.min(totalVoxels, srcData.length >> 2);
      const srcDataLocal = srcData;
      const bytesLocal = bytes;
      let srcIdx = 0;
      for (let i = 0; i < len; i++) {
        bytesLocal[i] = srcDataLocal[srcIdx];
        srcIdx += 4;
      }
    }
    
    const t3 = performance.now();
    
    self.postMessage({ 
      type: 'DECODE_RESULT', 
      id, 
      ok: true, 
      buffer: bytes.buffer,
      perf: { bmp: t1-t0, img: t2-t1, loop: t3-t2, total: t3-t0 }
    }, [bytes.buffer]);
  } catch (err) {
    self.postMessage({ type: 'DECODE_RESULT', id, ok: false, message: err.message });
  }
}
