/* ============================================================
   IRIBHM Microscopy Platform — fine empty-space cells (8³ max)
   ============================================================
   The ray-marcher skips empty space per 8³ cell, not per 64³ brick. A cell holds,
   for each channel, the raw maximum over every voxel a trilinear sample taken inside
   the cell can read. The shader asks whether the DISPLAYED value of that maximum
   (window, gamma, opacity, channel on/off) is at or below the mode's threshold:
   channelValues() is non-decreasing in the raw value, so if the maximum shows nothing
   no voxel of the cell does, and jumping to the cell's exit changes no pixel. Moving a
   slider changes nothing here.

   Footprint. A sample at continuous voxel position p (voxel i spans [i, i + 1]) reads
   the voxels ⌊p − ½⌋ and ⌊p − ½⌋ + 1 per axis on a bordered (LINEAR) atlas, the voxel
   ⌊p⌋ on a NEAREST one. For p inside cell c (voxels 8c … 8c + 7) that is the voxels
   8c − apron … 8c + 7 + apron, apron = 1 or 0. A bordered brick stores volume voxel
   i at index i + 1, so cell c of the brick reads stored indices 8c … 8c + 7 + 2·apron
   — always inside the stored box, no neighbouring brick needed.

   Compressed atlas. The GPU reads the BC-decoded voxels. A block is 4 × 4 texels of
   one plane and its palette is fitted to ALL sixteen, so a voxel of the footprint
   decodes from the block's whole content, and the least-squares endpoints can pass
   the block's source maximum. `blocks: true` therefore widens x and y to whole
   blocks (a block with only zeros decodes to exact zeros, so an empty cell stays 0),
   and a nonzero maximum is raised by `margin` (saturating at 255). A larger maximum
   only makes a cell less skippable.
   ============================================================ */
const CellMax = (() => {
  const CELL = 8;

  /**
   * The cells of one brick. `data` holds w × h × d voxels of `components` interleaved
   * bytes (x fastest), the box the brick was stored/uploaded as; the result is
   * cellsPerBrick³ RGBA texels (x fastest), cellsPerBrick = 64 / 8, the raw maximum of
   * channel k in byte k (0 for a component the data does not have). A cell beyond the
   * box (a brick cut at the volume's edge) is 255: never visited, never skippable.
   * @returns {Uint8Array}
   */
  function fromBox(data, components, w, h, d, { apron = 0, margin = 0, blocks = false, brickInterior = 64 } = {}) {
    const n = Math.round(brickInterior / CELL);
    const span = CELL - 1 + 2 * (apron ? 1 : 0);
    // x and y reach the end of the last 4-texel block the footprint touches.
    const spanXY = blocks ? Math.ceil((span + 1) / 4) * 4 - 1 : span;
    const comps = Math.max(1, Math.min(4, components | 0));
    // Separable running maxima: x over the footprint, then y, then z.
    const ax = new Uint8Array(d * h * n * comps);
    for (let z = 0; z < d; z++) {
      for (let y = 0; y < h; y++) {
        const row = (z * h + y) * w * comps;
        for (let cx = 0; cx < n; cx++) {
          const lo = cx * CELL;
          if (lo >= w) continue;
          const hi = Math.min(w - 1, lo + spanXY);
          const o = ((z * h + y) * n + cx) * comps;
          for (let c = 0; c < comps; c++) {
            let m = 0;
            for (let x = lo; x <= hi; x++) { const v = data[row + x * comps + c]; if (v > m) m = v; }
            ax[o + c] = m;
          }
        }
      }
    }
    const ay = new Uint8Array(d * n * n * comps);
    for (let z = 0; z < d; z++) {
      for (let cy = 0; cy < n; cy++) {
        const lo = cy * CELL;
        if (lo >= h) continue;
        const hi = Math.min(h - 1, lo + spanXY);
        for (let cx = 0; cx < n; cx++) {
          const o = ((z * n + cy) * n + cx) * comps;
          for (let c = 0; c < comps; c++) {
            let m = 0;
            for (let y = lo; y <= hi; y++) { const v = ax[((z * h + y) * n + cx) * comps + c]; if (v > m) m = v; }
            ay[o + c] = m;
          }
        }
      }
    }
    const out = new Uint8Array(n * n * n * 4);
    for (let cz = 0; cz < n; cz++) {
      const lo = cz * CELL;
      for (let cy = 0; cy < n; cy++) {
        for (let cx = 0; cx < n; cx++) {
          const o = ((cz * n + cy) * n + cx) * 4;
          if (lo >= d || cy * CELL >= h || cx * CELL >= w) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 255; continue; }
          const hi = Math.min(d - 1, lo + span);
          for (let c = 0; c < comps; c++) {
            let m = 0;
            for (let z = lo; z <= hi; z++) { const v = ay[((z * n + cy) * n + cx) * comps + c]; if (v > m) m = v; }
            out[o + c] = m > 0 && margin > 0 ? Math.min(255, m + margin) : m;
          }
        }
      }
    }
    return out;
  }

  /** Margin (in raw byte levels) added to a nonzero maximum of a BC-compressed brick. */
  const BC_MARGIN = 24;

  return { CELL, BC_MARGIN, fromBox };
})();

if (typeof self !== 'undefined' && typeof self.CellMax === 'undefined') {
  try { self.CellMax = CellMax; } catch (_) { /* frozen global */ }
}
