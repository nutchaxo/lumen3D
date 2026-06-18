/* ============================================================
   IRIBHM Microscopy Platform — AABB-Plane Intersector
   ============================================================
   Pure-JS implementation of the Slab Method for AABB-Plane
   intersection testing. Used for smart brick fetching:
   given a cut plane, determine which 3D bricks intersect it.
   ============================================================ */

const AABBIntersector = (() => {

  /**
   * Test which AABBs from a manifest are intersected by a slab (thick plane).
   * 
   * @param {Array} chunks - Array of chunk objects with { id, aabb: { min: [x,y,z], max: [x,y,z] }, isEmpty }
   * @param {Object} slab - { nx, ny, nz, d, thickness } plane equation + slab thickness
   * @returns {Array} Array of chunk objects that intersect the slab
   */
  function getIntersectingChunks(chunks, slab) {
    if (!Array.isArray(chunks) || !slab) return [];

    const { nx, ny, nz, d, thickness } = slab;
    const halfThickness = (thickness || 0.05) * 0.5;
    const result = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk.isEmpty) continue;

      const aabb = chunk.aabb;
      if (!aabb) continue;

      const minX = aabb.min[0];
      const minY = aabb.min[1];
      const minZ = aabb.min[2];
      const maxX = aabb.max[0];
      const maxY = aabb.max[1];
      const maxZ = aabb.max[2];

      // Centre of the brick
      const cx = (maxX + minX) * 0.5;
      const cy = (maxY + minY) * 0.5;
      const cz = (maxZ + minZ) * 0.5;

      // Half-extents
      const ex = (maxX - minX) * 0.5;
      const ey = (maxY - minY) * 0.5;
      const ez = (maxZ - minZ) * 0.5;

      // Signed distance from centre to plane
      const distance = (nx * cx) + (ny * cy) + (nz * cz) + d;

      // Projected radius of the AABB onto the plane normal
      const projectedRadius = (ex * Math.abs(nx)) +
                               (ey * Math.abs(ny)) +
                               (ez * Math.abs(nz));

      // Intersection test: |distance| <= projectedRadius + halfThickness
      if (Math.abs(distance) <= (projectedRadius + halfThickness)) {
        result.push(chunk);
      }
    }

    return result;
  }

  /**
   * Compute the plane equation for a given planeSpec (matching VolumeViewer format).
   * Returns { nx, ny, nz, d } where nx*x + ny*y + nz*z + d = 0.
   * 
   * @param {Object} planeSpec - { mode, value, yaw, pitch, roll }
   * @param {Object} volumeDims - { x, y, z } volume dimensions in voxels
   * @returns {Object} { nx, ny, nz, d, thickness }
   */
  function planeFromSpec(planeSpec, volumeDims, thickness = 0.05) {
    if (!planeSpec || !volumeDims) return null;

    let nx, ny, nz;
    const mode = planeSpec.mode || 'xy';

    if (mode === 'yz') {
      nx = 1; ny = 0; nz = 0;
    } else if (mode === 'xz') {
      nx = 0; ny = 1; nz = 0;
    } else if (mode === 'oblique') {
      // EDGE-009 (Rule 1.4): `yaw || 0` let Infinity / a truthy non-numeric through
      // (Math.sin(Infinity)=NaN), and `hypot(NaN,…)||1` normalizes by 1 so NaN
      // propagated into the plane equation. Sanitize angles to finite numbers; if the
      // resulting normal is degenerate (non-finite or zero length), fall back to xy.
      const yawV = (Number.isFinite(+planeSpec.yaw) ? +planeSpec.yaw : 0) * Math.PI / 180;
      const pitchV = (Number.isFinite(+planeSpec.pitch) ? +planeSpec.pitch : 0) * Math.PI / 180;
      nx = Math.cos(pitchV) * Math.sin(yawV);
      ny = Math.sin(pitchV);
      nz = Math.cos(pitchV) * Math.cos(yawV);
      const len = Math.hypot(nx, ny, nz);
      if (Number.isFinite(len) && len > 0) {
        nx /= len; ny /= len; nz /= len;
      } else {
        nx = 0; ny = 0; nz = 1;
      }
    } else {
      // XY mode
      nx = 0; ny = 0; nz = 1;
    }

    const value = Number.isFinite(+planeSpec.value) ? Math.min(1, Math.max(0, +planeSpec.value)) : 0.5;
    const span = Math.max(volumeDims.x || 1, volumeDims.y || 1, volumeDims.z || 1);
    const center = {
      x: (volumeDims.x * 0.5) + (nx * (value - 0.5) * span),
      y: (volumeDims.y * 0.5) + (ny * (value - 0.5) * span),
      z: (volumeDims.z * 0.5) + (nz * (value - 0.5) * span)
    };

    // d = -(nx*cx + ny*cy + nz*cz)
    const d = -(nx * center.x + ny * center.y + nz * center.z);

    return { nx, ny, nz, d, thickness };
  }

  /**
   * Smart fetch: Given a manifest and a plane spec, return the list of
   * non-empty chunk IDs that need to be fetched.
   * 
   * @param {Object} manifest - Brick manifest (v2 format from brick_preprocessor_dask.py)
   * @param {Object} planeSpec - Cut plane specification
   * @param {Object} volumeDims - Volume dimensions { x, y, z }
   * @param {number} slabThickness - Slab thickness for intersection
   * @returns {Array} Array of chunk objects to fetch
   */
  function smartFetchList(manifest, planeSpec, volumeDims, slabThickness = 5) {
    if (!manifest || !planeSpec || !volumeDims) return [];

    // Get chunks from manifest
    const chunks = _extractChunks(manifest);
    if (!chunks.length) return [];

    // Compute plane equation
    const slab = planeFromSpec(planeSpec, volumeDims, slabThickness);
    if (!slab) return [];

    // Find intersecting chunks
    return getIntersectingChunks(chunks, slab);
  }

  /**
   * Extract chunk list from manifest (v2 LOD-based format).
   */
  function _extractChunks(manifest) {
    // v2 format (brick_preprocessor_dask.py) — LOD-based
    if (Array.isArray(manifest.levels)) {
      const lod0 = manifest.levels[0];
      if (lod0?.chunks) {
        return lod0.chunks.map(c => ({
          ...c,
          id: c.id || `${Number(c.bz) || 0}_${Number(c.by) || 0}_${Number(c.bx) || 0}`,
          aabb: c.aabb || { min: c.min, max: c.max },
          isEmpty: c.isEmpty ?? (c.nonEmpty === false)
        }));
      }
    }

    return [];
  }

  return {
    getIntersectingChunks,
    planeFromSpec,
    smartFetchList
  };
})();
