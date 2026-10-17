/* ============================================================
   Lumen3D — cut store decode worker (DOCS/dataset-migrations/SPEC.md §14.5)
   ============================================================
   Decodes what CutStore reads, off the main thread, with CutStore's own code (loaded
   here, so the page and the worker cannot drift):
     { id, op: 'cut', bytes: ArrayBuffer, bz }  → { id, data: ArrayBuffer }   a cut brick
                                                    (bz·32·32 voxels, z-major)
     { id, op: 'png', bytes: ArrayBuffer }      → { id, width, height, data }  a png-gray8
                                                    tile of an xz / yz pack
     → { id, error } on failure
   ============================================================ */
'use strict';

const _V = (() => { try { return new URL(self.location.href).search; } catch (_) { return ''; } })();
importScripts('../core/plane-codec.js' + _V, '../core/cut-store.js' + _V);

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    const bytes = new Uint8Array(m.bytes);
    if (m.op === 'cut') {
      const data = await CutStore.decodeCutBrickLocal(bytes, m.bz);
      self.postMessage({ id: m.id, data: data.buffer }, [data.buffer]);
    } else if (m.op === 'png') {
      const img = await PlaneCodec.decodePngGray(bytes);
      const data = img.data.buffer.byteLength === img.data.length ? img.data : img.data.slice();
      self.postMessage({ id: m.id, width: img.width, height: img.height, data: data.buffer }, [data.buffer]);
    } else {
      throw new Error('unknown op ' + m.op);
    }
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err && err.message || err) });
  }
};
