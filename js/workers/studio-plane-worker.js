/* ============================================================
   Lumen3D — Studio plane worker
   ============================================================
   The heavy loops of the Studio's native pass on an axis-aligned plane, off the
   main thread (StudioPlaneOps holds the arithmetic):

     { id, op: 'reduce', data, box, axis, keep }
        → { id, data, w, h }          per-channel max of a brick box over the voxel
                                      planes `keep` (a MIP slab), `data` transferred
     { id, op: 'coverage', geometry, renderRes, window, warp }
        → { id, mask }                the footprint of a projected slab (Uint8Array)
     → { id, error } on failure
   ============================================================ */

'use strict';

importScripts('studio-plane-ops.js');

self.onmessage = (event) => {
  const msg = event.data || {};
  try {
    if (msg.op === 'reduce') {
      const tile = StudioPlaneOps.reduceMax(new Uint8Array(msg.data), msg.box, msg.axis, msg.keep);
      self.postMessage({ id: msg.id, data: tile.data, w: tile.w, h: tile.h }, [tile.data.buffer]);
    } else if (msg.op === 'coverage') {
      const mask = StudioPlaneOps.coverageMask(msg.geometry, msg.renderRes, msg.window, msg.warp || null);
      self.postMessage({ id: msg.id, mask }, [mask.buffer]);
    } else {
      self.postMessage({ id: msg.id, error: `unknown op ${msg.op}` });
    }
  } catch (err) {
    self.postMessage({ id: msg.id, error: String((err && err.message) || err) });
  }
};
