/* ============================================================
   Lumen3D — plane decode worker (format-2 `planes/` trees)
   ============================================================
   Decodes the png-gray8 tiles of one horizontal band of a plane region
   (DOCS/dataset-migrations/SPEC.md §3) and lays them out as one uint8 plane per
   requested channel, off the main thread (PlaneLoader holds the network side):

     { id, op: 'decode', key, mode: 'new' | 'max', width, height, x0, y0, nch,
       tiles: [{ ch, x0, y0, w, h, off, len }], bytes: ArrayBuffer, compose? }
        mode 'new' → { id, planes: [ArrayBuffer × nch], tiles } or, with
                     `compose`, { id, rgba: ArrayBuffer, tiles }
        mode 'max' → { id, ok: true, tiles }  the band is max-ed into the
                     accumulator `key` (a MIP over several planes)
     { id, op: 'take', key, compose? } → the accumulator, as 'new' answers; dropped
     { op: 'drop', key }                → the accumulator is released
     → { id, error } on failure

   `compose` = { components, slots: [component of each output channel], luts:
   [Uint8Array(256) | null per output channel] }: the channels interleaved at stride
   `components`, LUT applied — the layout of a composed brick row (BrickLoader
   compose), so the band is uploaded to the plane texture as it comes. A MIP is
   reduced on the stored values and the LUT applied to the maximum: the floor LUT is
   non-decreasing (0 up to the floor, then round((v − floor)·255/(255 − floor)),
   clamped), so lut(max v) = max lut(v), the bricks path's order of operations.

   Tiles are decoded by PlaneCodec.decodePngGray (inflate through the platform's
   DecompressionStream + PNG unfiltering in JS), never through createImageBitmap +
   canvas readback: a canvas read is the browser's to perturb (anti-fingerprinting
   noise in Brave, Firefox's resistFingerprinting, colour management policy on
   untagged images), and these values are measurements.
   ============================================================ */

'use strict';

const PlaneDecodeOps = (() => {
  const Codec = () => (typeof PlaneCodec !== 'undefined' ? PlaneCodec : self.PlaneCodec);
  const DECODE_PARALLEL = 8;

  function _bandPlanes(nch, width, height) {
    const out = [];
    for (let c = 0; c < nch; c++) out.push(new Uint8Array(width * height));
    return out;
  }

  /**
   * Decodes `tiles` (their bytes at [off, off+len) of `bytes`) into `planes` (one
   * width × height array per output channel, the band whose top-left image pixel is
   * (x0, y0)); `max` takes the per-pixel maximum with what the planes hold.
   */
  async function decodeInto(planes, msg, max) {
    const bytes = msg.bytes instanceof Uint8Array ? msg.bytes : new Uint8Array(msg.bytes || new ArrayBuffer(0));
    const { width, height, x0, y0 } = msg;
    const tiles = Array.isArray(msg.tiles) ? msg.tiles : [];
    let decoded = 0;
    const one = async (t) => {
      if (!(t.len > 0)) return;   // an all-zero tile: nothing to write, nothing to max
      if (t.off < 0 || t.off + t.len > bytes.length) throw new Error(`plane tile bytes out of range (${t.off}+${t.len} > ${bytes.length})`);
      const img = await Codec().decodePngGray(bytes.subarray(t.off, t.off + t.len));
      if (img.width !== t.w || img.height !== t.h) {
        throw new Error(`plane tile is ${img.width} × ${img.height}, expected ${t.w} × ${t.h}`);
      }
      const dst = planes[t.ch];
      if (!dst) throw new Error(`plane tile channel ${t.ch} out of range`);
      // The intersection of the tile with the band, in image pixels.
      const ix0 = Math.max(t.x0, x0), ix1 = Math.min(t.x0 + t.w, x0 + width);
      const iy0 = Math.max(t.y0, y0), iy1 = Math.min(t.y0 + t.h, y0 + height);
      if (ix1 <= ix0 || iy1 <= iy0) return;
      const n = ix1 - ix0;
      for (let y = iy0; y < iy1; y++) {
        const s = (y - t.y0) * t.w + (ix0 - t.x0);
        const d = (y - y0) * width + (ix0 - x0);
        if (!max) dst.set(img.data.subarray(s, s + n), d);
        else {
          const src = img.data;
          for (let i = 0; i < n; i++) {
            const v = src[s + i];
            if (v > dst[d + i]) dst[d + i] = v;
          }
        }
      }
      decoded++;
    };
    for (let i = 0; i < tiles.length; i += DECODE_PARALLEL) {
      await Promise.all(tiles.slice(i, i + DECODE_PARALLEL).map(one));
    }
    return decoded;
  }

  /** Interleaves per-channel planes at stride `components`, LUT applied. */
  function compose(planes, voxels, spec) {
    const comps = Math.max(1, Math.min(4, Math.floor(Number(spec.components) || 4)));
    const out = new Uint8Array(voxels * comps);
    planes.forEach((p, i) => {
      const slot = Array.isArray(spec.slots) && Number.isInteger(spec.slots[i]) ? spec.slots[i] : i;
      if (slot < 0 || slot >= comps) throw new Error(`compose slot ${slot} does not fit ${comps} components`);
      const lut = spec.luts && spec.luts[i] && spec.luts[i].length >= 256 ? spec.luts[i] : null;
      for (let v = 0, o = slot; v < voxels; v++, o += comps) out[o] = lut ? lut[p[v]] : p[v];
    });
    return out;
  }

  return { decodeInto, compose, _bandPlanes };
})();

if (typeof importScripts === 'function' && typeof self !== 'undefined' && typeof window === 'undefined') {
  // The worker carries the platform's cache-busting stamp: the codec it imports, too.
  const stamp = (/[?&]v=([^&#]+)/.exec(self.location && self.location.search || '') || [])[1];
  importScripts(`../core/plane-codec.js${stamp ? `?v=${stamp}` : ''}`);

  const accumulators = new Map();   // key → { planes, width, height }
  const answer = (id, planes, spec, tiles = 0) => {
    if (spec) {
      const rgba = PlaneDecodeOps.compose(planes, planes.length ? planes[0].length : 0, spec);
      self.postMessage({ id, rgba: rgba.buffer, tiles }, [rgba.buffer]);
    } else {
      const buffers = planes.map(p => p.buffer);
      self.postMessage({ id, planes: buffers, tiles }, buffers);
    }
  };

  self.onmessage = async (event) => {
    const msg = event.data || {};
    try {
      if (msg.op === 'decode') {
        if (msg.mode === 'max') {
          let acc = accumulators.get(msg.key);
          if (!acc) {
            acc = { planes: PlaneDecodeOps._bandPlanes(msg.nch, msg.width, msg.height), width: msg.width, height: msg.height };
            accumulators.set(msg.key, acc);
          } else if (acc.width !== msg.width || acc.height !== msg.height || acc.planes.length !== msg.nch) {
            throw new Error('accumulator shape changed within a job');
          }
          const tiles = await PlaneDecodeOps.decodeInto(acc.planes, msg, true);
          self.postMessage({ id: msg.id, ok: true, tiles });
        } else {
          const planes = PlaneDecodeOps._bandPlanes(msg.nch, msg.width, msg.height);
          const tiles = await PlaneDecodeOps.decodeInto(planes, msg, false);
          answer(msg.id, planes, msg.compose || null, tiles);
        }
      } else if (msg.op === 'take') {
        const acc = accumulators.get(msg.key);
        accumulators.delete(msg.key);
        if (!acc) throw new Error(`no accumulator ${msg.key}`);
        answer(msg.id, acc.planes, msg.compose || null);
      } else if (msg.op === 'drop') {
        accumulators.delete(msg.key);
      } else {
        self.postMessage({ id: msg.id, error: `unknown op ${msg.op}` });
      }
    } catch (err) {
      if (msg.op === 'decode' && msg.mode === 'max') accumulators.delete(msg.key);
      self.postMessage({ id: msg.id, error: String((err && err.message) || err) });
    }
  };
}
