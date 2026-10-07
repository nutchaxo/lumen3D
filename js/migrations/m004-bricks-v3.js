/**
 * Migration handler `m004-bricks-v3` — browser executor (DOCS/dataset-migrations/SPEC.md §13).
 *
 * Format 3 → 4: the v2 brick pyramid is replaced by a v3 one. Every level is halved in X and Y
 * and, when that keeps the voxel from becoming coarser in XY than in Z, in Z too (§13.1);
 * every brick is stored as 66³ = its 64³ interior plus a 1-voxel apron (§13.2), as a 9 × 8
 * mosaic of 66 × 66 slices, lossless WebP.
 *
 * One work unit `t{t}.k{k}.c{c}.z{BZ}.y{BY}.x{BX}` = the ≤ 4×4×4 bricks of super-block
 * (BZ, BY, BX) of level k, one channel. Its inputs:
 *   k = 0  the v2 LOD0 bricks under the block and its 1-voxel neighbourhood (range reads of the
 *          published packs, decoded exactly like js/core/brick-decode-worker.js, through the
 *          m002 handler's decoder — loaded by the worker from `requires`);
 *   k ≥ 1  the level k−1 v3 bricks already produced by this job, read back from the server's
 *          store (`io.fetchStored`): a level runs only once the previous one is complete.
 *
 * Arithmetic (normative, identical in the three implementations):
 *   D_k(x, y, z)       level-k voxel, defined on [0, X_k) × [0, Y_k) × [0, Z_k)
 *   D_0                = the stored uint8 LOD0 voxel (a v2 brick absent from the manifest is 0)
 *   D_{k+1}(x, y, z)   = ⌊(S + ⌊n/2⌋) / n⌋, S = Σ D_k(x', y', z') over the n voxels that exist of
 *                        x' ∈ {2x, 2x+1}, y' ∈ {2y, 2y+1}, z' ∈ {2z, 2z+1} (halved) or {z} (not)
 *   stored voxel (i, j, l) of brick (bx, by, bz), i, j, l ∈ [0, 66):
 *                        D_k(clampX(64·bx − 1 + i), clampY(64·by − 1 + j), clampZ(64·bz − 1 + l))
 *   mosaic pixel       (66·(l mod 9) + i, 66·⌊l / 9⌋ + j) of a 594 × 528 picture; slots 66..71 = 0
 *   kept               iff a voxel of the 64³ interior (i, j, l ∈ [1, 65)) is ≥ 1
 *
 * Unit blob (browser → server):
 *   u32 count, count × { u32 bz, u32 by, u32 bx, u32 length, WebP bytes }  (little-endian,
 *   absolute brick indices of level k; a dropped brick is not sent)
 *
 * Handler contract: see js/workers/migration-worker.js.
 */
(function (root) {
    'use strict';

    const ID = 'm004-bricks-v3';
    const BRICK = 64;
    const APRON = 1;
    const SLAB = BRICK + 2 * APRON;            // 66
    const COLS = 9, ROWS = 8;
    const MOSAIC_W = COLS * SLAB;              // 594
    const MOSAIC_H = ROWS * SLAB;              // 528
    const SUPER = 4;                           // bricks per super-block side
    const STOP_XY = 128;
    const Z_RATIO = 1.5;

    const m002 = () => {
        const h = root.LumenMigrationHandlers && root.LumenMigrationHandlers['m002-planes'];
        if (!h || !h._internals) throw new Error('m004-bricks-v3 needs the m002-planes decoder');
        return h;
    };

    // ── §13.1 levels ──────────────────────────────────────────────────────────────

    /**
     * Level geometry from LOD0 dimensions and voxel size (µm). Level k+1 halves X and Y
     * (⌈n/2⌉); it halves Z iff vz_k ≤ 1.5 · vxy_{k+1}, where vxy_{k+1} is the COARSER of the two
     * XY voxel sizes after the step (each doubled exactly). Levels are added while
     * max(X, Y) > 128. Same rule as dataset_migrations.py:level_geometry.
     */
    function levelPlan(dims0, voxel0) {
        const v = voxelTriplet(voxel0) || { x: 1, y: 1, z: 1 };
        const levels = [];
        let d = { x: dims0.x, y: dims0.y, z: dims0.z };
        let vs = v;
        let halveZ = false;
        for (let k = 0; ; k++) {
            levels.push({
                level: k, dimensions: { ...d }, voxelSize: { ...vs },
                gridSize: { x: Math.ceil(d.x / BRICK), y: Math.ceil(d.y / BRICK), z: Math.ceil(d.z / BRICK) },
                halveZ,   // how this level was made from level k−1 (false for level 0)
            });
            if (Math.max(d.x, d.y) <= STOP_XY) break;
            const next = { x: vs.x * 2, y: vs.y * 2, z: vs.z };
            halveZ = vs.z <= Z_RATIO * Math.max(next.x, next.y);
            if (halveZ) next.z = vs.z * 2;
            d = { x: Math.ceil(d.x / 2), y: Math.ceil(d.y / 2), z: halveZ ? Math.ceil(d.z / 2) : d.z };
            vs = next;
        }
        return levels;
    }

    /** {x, y, z} of finite positive numbers, or null. */
    function voxelTriplet(v) {
        if (!v || typeof v !== 'object') return null;
        const o = { x: Number(v.x), y: Number(v.y), z: Number(v.z) };
        return [o.x, o.y, o.z].every((n) => Number.isFinite(n) && n > 0) ? o : null;
    }

    function unitKey(t, k, c, BZ, BY, BX) { return `t${t}.k${k}.c${c}.z${BZ}.y${BY}.x${BX}`; }

    function parseUnitKey(key) {
        const m = /^t(\d+)\.k(\d+)\.c(\d+)\.z(\d+)\.y(\d+)\.x(\d+)$/.exec(String(key));
        if (!m) throw new Error('bad unit key ' + key);
        return { t: +m[1], k: +m[2], c: +m[3], BZ: +m[4], BY: +m[5], BX: +m[6] };
    }

    // ── Unit blob ─────────────────────────────────────────────────────────────────

    function buildBrickBlob(bricks) {
        let total = 4;
        for (const b of bricks) total += 16 + b.bytes.length;
        const out = new Uint8Array(total);
        const dv = new DataView(out.buffer);
        dv.setUint32(0, bricks.length, true);
        let o = 4;
        for (const b of bricks) {
            dv.setUint32(o, b.bz >>> 0, true);
            dv.setUint32(o + 4, b.by >>> 0, true);
            dv.setUint32(o + 8, b.bx >>> 0, true);
            dv.setUint32(o + 12, b.bytes.length, true);
            out.set(b.bytes, o + 16);
            o += 16 + b.bytes.length;
        }
        return out;
    }

    function parseBrickBlob(bytes) {
        bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (bytes.length < 4) throw new Error('brick blob: short');
        const count = dv.getUint32(0, true);
        const out = [];
        let o = 4;
        for (let i = 0; i < count; i++) {
            if (o + 16 > bytes.length) throw new Error('brick blob: truncated');
            const len = dv.getUint32(o + 12, true);
            if (o + 16 + len > bytes.length) throw new Error('brick blob: truncated');
            out.push({ bz: dv.getUint32(o, true), by: dv.getUint32(o + 4, true), bx: dv.getUint32(o + 8, true), bytes: bytes.subarray(o + 16, o + 16 + len) });
            o += 16 + len;
        }
        if (o !== bytes.length) throw new Error('brick blob: trailing bytes');
        return out;
    }

    // ── Trees ─────────────────────────────────────────────────────────────────────

    async function prepare(ctx) {
        const memo = new Map();
        const fetchJson = (url) => {
            if (!memo.has(url)) memo.set(url, ctx.fetchJson(url));
            return memo.get(url);
        };
        const base = String(ctx.datasetBase).replace(/\/?$/, '/');
        let meta = null;
        try { meta = await fetchJson(base + 'metadata.json'); } catch (_) { meta = null; }
        const src = await m002().prepare({ datasetBase: base, fetchJson });
        // The source manifest is the one m002 just read (memoised).
        let manifest = null;
        for (const [url, p] of memo) if (/\/manifest\.json$/.test(url)) manifest = await p;
        if (manifest && (manifest.schema === 'iribhm-bricks-v3' || manifest.version === 3)) {
            throw Object.assign(new Error('the bricks are already v3'), { code: 'source_not_v2' });
        }
        // Same source order as the server (dataset_migrations.py:_manifest_voxel): the bricks
        // manifest's voxelSize, else metadata.json voxel_size, else 1 µm isotropic.
        const vs = voxelTriplet(manifest && manifest.voxelSize) || voxelTriplet(meta && meta.voxel_size) || null;
        const trees = src.trees.map((tr) => ({ t: tr.t, v2: tr, channels: tr.channels, levels: levelPlan(tr.dims, vs) }));
        return { id: ID, trees, byT: new Map(trees.map((tr) => [tr.t, tr])) };
    }

    function _blockRange(B, n) { return [B * SUPER, Math.min(B * SUPER + SUPER, n)]; }

    function _interiorV2Present(tree, c, u) {
        const I = m002()._internals;
        const g = tree.levels[0].gridSize;
        const [z0, z1] = _blockRange(u.BZ, g.z), [y0, y1] = _blockRange(u.BY, g.y), [x0, x1] = _blockRange(u.BX, g.x);
        for (let bz = z0; bz < z1; bz++) for (let by = y0; by < y1; by++) for (let bx = x0; bx < x1; bx++) {
            if (tree.v2.index.has(I.brickRel(0, c, bx, by, bz, tree.v2.encoding))) return true;
        }
        return false;
    }

    /**
     * Every unit, level by level (a level needs the previous one complete). A level-0 unit
     * whose 64 interior v2 bricks are all absent is empty (its interiors are zero, nothing is
     * kept); emptiness of higher levels is the server's (it holds the produced bricks).
     * opts.sample: level 0 only — the only units a benchmark can run before a job exists.
     */
    function listUnits(state, opts) {
        const units = [];
        for (const tr of state.trees) {
            const levels = opts && opts.sample ? tr.levels.slice(0, 1) : tr.levels;
            for (const L of levels) {
                const g = L.gridSize;
                for (let c = 0; c < tr.channels; c++) {
                    for (let BZ = 0; BZ < Math.ceil(g.z / SUPER); BZ++) {
                        for (let BY = 0; BY < Math.ceil(g.y / SUPER); BY++) {
                            for (let BX = 0; BX < Math.ceil(g.x / SUPER); BX++) {
                                const u = { BZ, BY, BX };
                                units.push({
                                    key: unitKey(tr.t, L.level, c, BZ, BY, BX), level: L.level,
                                    empty: L.level === 0 ? !_interiorV2Present(tr, c, u) : false,
                                });
                            }
                        }
                    }
                }
            }
        }
        // Level-major across trees: every tree's level k before any level k + 1.
        units.sort((a, b) => a.level - b.level);
        return units;
    }

    /**
     * Geometry of a unit: its output bricks, the box of level-k voxels D it needs (interiors +
     * aprons, clipped to the volume) and the source bricks to read.
     */
    function planUnitWork(key, state) {
        const u = parseUnitKey(key);
        const tr = state.byT.get(u.t);
        if (!tr) throw new Error('unit of an unknown tree ' + key);
        const L = tr.levels[u.k];
        if (!L || u.c >= tr.channels) throw new Error('unit out of range ' + key);
        const g = L.gridSize, d = L.dimensions;
        if (u.BZ * SUPER >= g.z || u.BY * SUPER >= g.y || u.BX * SUPER >= g.x) throw new Error('unit out of range ' + key);
        const [bz0, bz1] = _blockRange(u.BZ, g.z), [by0, by1] = _blockRange(u.BY, g.y), [bx0, bx1] = _blockRange(u.BX, g.x);
        const box = {
            x0: Math.max(0, BRICK * bx0 - APRON), x1: Math.min(d.x, BRICK * bx1 + APRON),
            y0: Math.max(0, BRICK * by0 - APRON), y1: Math.min(d.y, BRICK * by1 + APRON),
            z0: Math.max(0, BRICK * bz0 - APRON), z1: Math.min(d.z, BRICK * bz1 + APRON),
        };
        const work = { key, unit: u, tree: u.t, level: u.k, bricks: { bz0, bz1, by0, by1, bx0, bx1 }, box, dims: d };
        if (u.k === 0) {
            const I = m002()._internals;
            const src = [];
            for (let bz = box.z0 >> 6; bz <= (box.z1 - 1) >> 6; bz++) {
                for (let by = box.y0 >> 6; by <= (box.y1 - 1) >> 6; by++) {
                    for (let bx = box.x0 >> 6; bx <= (box.x1 - 1) >> 6; bx++) {
                        const rel = I.brickRel(0, u.c, bx, by, bz, tr.v2.encoding);
                        const e = tr.v2.index.get(rel);
                        if (e) src.push({ bx, by, bz, rel, url: e.url, offset: e.offset, length: e.length });
                    }
                }
            }
            work.interiorPresent = _interiorV2Present(tr, u.c, u);
            work.source = { kind: 'v2', bricks: src, runs: I.mergeRuns(src) };
            work.bytesIn = work.source.runs.reduce((s, r) => s + (r.end - r.start), 0);
        } else {
            const P = tr.levels[u.k - 1].dimensions;
            const halve = L.halveZ;
            const sbox = {
                x0: 2 * box.x0, x1: Math.min(P.x, 2 * box.x1),
                y0: 2 * box.y0, y1: Math.min(P.y, 2 * box.y1),
                z0: halve ? 2 * box.z0 : box.z0, z1: halve ? Math.min(P.z, 2 * box.z1) : box.z1,
            };
            const list = [];
            for (let bz = sbox.z0 >> 6; bz <= (sbox.z1 - 1) >> 6; bz++) {
                for (let by = sbox.y0 >> 6; by <= (sbox.y1 - 1) >> 6; by++) {
                    for (let bx = sbox.x0 >> 6; bx <= (sbox.x1 - 1) >> 6; bx++) list.push([bz, by, bx]);
                }
            }
            work.interiorPresent = true;
            work.source = { kind: 'v3', level: u.k - 1, box: sbox, dims: P, halveZ: halve, bricks: list };
        }
        return work;
    }

    // ── Source voxels ─────────────────────────────────────────────────────────────

    /** v3 mosaic RGBA (594 × 528) → 66³ scalar brick, (l, j, i) order. */
    function unmosaicV3(rgba, w, h) {
        if (w !== MOSAIC_W || h !== MOSAIC_H) throw Object.assign(new Error(`v3 brick is ${w}×${h}, expected ${MOSAIC_W}×${MOSAIC_H}`), { code: 'brick_undecodable', fatal: true });
        const out = new Uint8Array(SLAB * SLAB * SLAB);
        for (let l = 0; l < SLAB; l++) {
            const px0 = (l % COLS) * SLAB, py0 = Math.floor(l / COLS) * SLAB;
            for (let j = 0; j < SLAB; j++) {
                let s = ((py0 + j) * MOSAIC_W + px0) * 4;
                let d = (l * SLAB + j) * SLAB;
                for (let i = 0; i < SLAB; i++, s += 4) out[d++] = rgba[s];
            }
        }
        return out;
    }

    let _dec = null, _decCtx = null;
    async function decodeV3Brick(bytes) {
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        try {
            if (!_dec) {
                _dec = new OffscreenCanvas(MOSAIC_W, MOSAIC_H);
                _decCtx = _dec.getContext('2d', { willReadFrequently: true });
                _decCtx.globalCompositeOperation = 'copy';
            }
            if (bmp.width !== MOSAIC_W || bmp.height !== MOSAIC_H) {
                throw Object.assign(new Error(`v3 brick is ${bmp.width}×${bmp.height}, expected ${MOSAIC_W}×${MOSAIC_H}`), { code: 'brick_undecodable', fatal: true });
            }
            _decCtx.drawImage(bmp, 0, 0);
            return unmosaicV3(_decCtx.getImageData(0, 0, MOSAIC_W, MOSAIC_H).data, MOSAIC_W, MOSAIC_H);
        } finally {
            if (bmp && typeof bmp.close === 'function') bmp.close();
        }
    }

    /**
     * Decoded source bricks of one z brick-layer at a time (the sweep goes up in z, so a layer
     * is never needed again once passed): ≤ 6×6 v2 bricks or ≤ 10×10 v3 bricks in memory.
     * `get(bz, by, bx)` → { data, stride, off } or null for an absent (zero) brick.
     */
    function makeSourceCache(loadOne) {
        let layer = -1;
        let cur = new Map();
        return {
            async get(bz, by, bx) {
                if (bz !== layer) {
                    if (bz < layer) throw new Error('source sweep went backwards');
                    cur = new Map();
                    layer = bz;
                }
                const k = by * 65536 + bx;
                if (!cur.has(k)) cur.set(k, loadOne(bz, by, bx));
                return cur.get(k);
            },
        };
    }

    /**
     * One z-plane of source voxels over [x0, x1) × [y0, y1), row-major, assembled from the
     * bricks under it (an absent brick is zero). All coordinates are inside the source volume.
     */
    async function sourcePlane(cache, z, x0, x1, y0, y1) {
        const w = x1 - x0, h = y1 - y0;
        const out = new Uint8Array(w * h);
        const bz = z >> 6, lz = z & 63;
        for (let by = y0 >> 6; by <= (y1 - 1) >> 6; by++) {
            for (let bx = x0 >> 6; bx <= (x1 - 1) >> 6; bx++) {
                const b = await cache.get(bz, by, bx);
                if (!b) continue;
                const ya = Math.max(y0, by * BRICK), yb = Math.min(y1, by * BRICK + BRICK);
                const xa = Math.max(x0, bx * BRICK), xb = Math.min(x1, bx * BRICK + BRICK);
                const s = b.stride, o = b.off;
                for (let y = ya; y < yb; y++) {
                    const src = ((lz + o) * s + (y - by * BRICK + o)) * s + (xa - bx * BRICK + o);
                    out.set(b.data.subarray(src, src + (xb - xa)), (y - y0) * w + (xa - x0));
                }
            }
        }
        return out;
    }

    /**
     * One output plane of level k+1 from one or two source planes of level k (pw × ph, the
     * source box starting at an even coordinate 2·x0, 2·y0): ⌊(S + ⌊n/2⌋) / n⌋ over the voxels
     * that exist. Output size ow × oh; `p1` is null when Z is not halved or 2z + 1 ≥ Z_k.
     */
    function reducePlane(p0, p1, pw, ph, ow, oh) {
        const out = new Uint8Array(ow * oh);
        const nz = p1 ? 2 : 1;
        for (let y = 0; y < oh; y++) {
            const r0 = 2 * y * pw;
            const twoRows = 2 * y + 1 < ph;
            const r1 = r0 + pw;
            for (let x = 0; x < ow; x++) {
                const i = r0 + 2 * x;
                const twoCols = 2 * x + 1 < pw;
                let s = p0[i], n = 1;
                if (twoCols) { s += p0[i + 1]; n++; }
                if (twoRows) { s += p0[r1 + 2 * x]; n++; if (twoCols) { s += p0[r1 + 2 * x + 1]; n++; } }
                if (p1) {
                    s += p1[i];
                    if (twoCols) s += p1[i + 1];
                    if (twoRows) { s += p1[r1 + 2 * x]; if (twoCols) s += p1[r1 + 2 * x + 1]; }
                }
                n *= nz;
                out[y * ow + x] = Math.floor((s + (n >> 1)) / n);
            }
        }
        return out;
    }

    /**
     * The 594 × 528 RGBA mosaic of brick (bx, by, bz) from the unit's voxel box D (clamp to
     * edge outside the volume), and whether its interior holds a voxel ≥ 1.
     */
    function mosaicBrick(D, box, dims, bx, by, bz, rgba) {
        rgba = rgba || new Uint8ClampedArray(MOSAIC_W * MOSAIC_H * 4);
        rgba.fill(0);
        for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
        const dw = box.x1 - box.x0, dh = box.y1 - box.y0;
        const clampIdx = (b, n, lo) => {
            const a = new Int32Array(SLAB);
            for (let i = 0; i < SLAB; i++) a[i] = Math.min(n - 1, Math.max(0, BRICK * b - APRON + i)) - lo;
            return a;
        };
        const ix = clampIdx(bx, dims.x, box.x0), iy = clampIdx(by, dims.y, box.y0), iz = clampIdx(bz, dims.z, box.z0);
        let kept = false;
        for (let l = 0; l < SLAB; l++) {
            const px0 = (l % COLS) * SLAB, py0 = Math.floor(l / COLS) * SLAB;
            const plane = iz[l] * dh * dw;
            const zIn = l >= APRON && l < SLAB - APRON;
            for (let j = 0; j < SLAB; j++) {
                const row = plane + iy[j] * dw;
                const yzIn = zIn && j >= APRON && j < SLAB - APRON;
                let p = ((py0 + j) * MOSAIC_W + px0) * 4;
                for (let i = 0; i < SLAB; i++, p += 4) {
                    const v = D[row + ix[i]];
                    rgba[p] = v; rgba[p + 1] = v; rgba[p + 2] = v;
                    if (v && yzIn && i >= APRON && i < SLAB - APRON) kept = true;
                }
            }
        }
        return { rgba, kept };
    }

    // ── WebP lossless encode ──────────────────────────────────────────────────────

    /**
     * { width, height } of a WebP whose image is a VP8L (lossless) bitstream, else null: the
     * same RIFF walk as the server's refusal test (dataset_migrations.py:webp_lossless_size) —
     * RIFF size even and equal to the file, a VP8X only as the first chunk, not animated, no
     * lossy `VP8 ` chunk, exactly one VP8L chunk of version 0, a VP8X canvas equal to it.
     */
    function losslessWebpSize(b) {
        const n = b.length;
        if (n < 20) return null;
        const tag = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
        if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP') return null;
        const u32 = (o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
        const u24 = (o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
        const riff = u32(4);
        if (riff + 8 !== n || riff % 2) return null;
        let pos = 12, image = null, canvas = null;
        while (pos < n) {
            if (pos + 8 > n) return null;
            const kind = tag(pos), size = u32(pos + 4), body = pos + 8;
            if (body + size > n) return null;
            if (kind === 'VP8X') {
                if (pos !== 12 || size < 10 || (b[body] & 0x02)) return null;
                canvas = { width: 1 + u24(body + 4), height: 1 + u24(body + 7) };
            } else if (kind === 'VP8 ' || kind === 'ANIM' || kind === 'ANMF') {
                return null;
            } else if (kind === 'VP8L') {
                if (image || size < 5 || b[body] !== 0x2F) return null;
                const bits = u32(body + 1);
                if (bits >>> 29) return null;
                image = { width: (bits & 0x3FFF) + 1, height: ((bits >>> 14) & 0x3FFF) + 1 };
            }
            pos = body + size + (size & 1);
        }
        if (!image) return null;
        if (canvas && (canvas.width !== image.width || canvas.height !== image.height)) return null;
        return image;
    }

    function isLosslessWebp(b) { return losslessWebpSize(b) !== null; }

    let _enc = null, _encCtx = null;
    async function encodeWebpLossless(rgba, w, h) {
        if (!_enc || _enc.width !== w || _enc.height !== h) {
            _enc = new OffscreenCanvas(w, h);
            _encCtx = _enc.getContext('2d', { willReadFrequently: true });
        }
        _encCtx.putImageData(new ImageData(rgba, w, h), 0, 0);
        // Chromium encodes WebP losslessly at quality 1.0; the probe proves it per browser.
        const blob = await _enc.convertToBlob({ type: 'image/webp', quality: 1 });
        if (!blob || blob.type !== 'image/webp') throw Object.assign(new Error('this browser does not encode WebP'), { code: 'no_webp_lossless_encode', fatal: true });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const size = losslessWebpSize(bytes);
        // The server refuses anything but a VP8L picture of exactly this size (SPEC §13.8).
        if (!size || size.width !== w || size.height !== h) {
            throw Object.assign(new Error('this browser did not encode a lossless WebP of ' + w + '×' + h), { code: 'no_webp_lossless_encode', fatal: true });
        }
        return bytes;
    }

    async function _decodeRgba(bytes) {
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        try {
            const c = new OffscreenCanvas(bmp.width, bmp.height);
            const x = c.getContext('2d', { willReadFrequently: true });
            x.globalCompositeOperation = 'copy';
            x.drawImage(bmp, 0, 0);
            return { width: bmp.width, height: bmp.height, data: x.getImageData(0, 0, bmp.width, bmp.height).data };
        } finally {
            if (bmp && typeof bmp.close === 'function') bmp.close();
        }
    }

    /**
     * The browser executor needs WebP lossless ENCODING: a sample mosaic (every byte value,
     * noise, flat runs, the empty slots) is encoded and decoded back; one differing byte and
     * the browser is unavailable for this migration.
     */
    async function probe() {
        const no = { available: false, reasons: ['no_webp_lossless_encode'] };
        if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined' || typeof ImageData === 'undefined') return no;
        try {
            const w = MOSAIC_W, h = MOSAIC_H;
            const rgba = new Uint8ClampedArray(w * h * 4);
            let seed = 0x9e3779b9;
            for (let p = 0, i = 0; i < w * h; i++, p += 4) {
                seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
                const y = Math.floor(i / w);
                const v = y < 66 ? (i % 256) : y < 330 ? ((seed >>> 13) & 0xFF) : y < 462 ? ((i >> 7) & 1) * 37 : 0;
                rgba[p] = v; rgba[p + 1] = v; rgba[p + 2] = v; rgba[p + 3] = 255;
            }
            const d = await _decodeRgba(await encodeWebpLossless(rgba, w, h));
            if (d.width !== w || d.height !== h) return no;
            for (let p = 0; p < rgba.length; p += 4) if (d.data[p] !== rgba[p]) return no;
            return { available: true, reasons: [] };
        } catch (_) {
            return no;
        }
    }

    // ── Unit ──────────────────────────────────────────────────────────────────────

    async function _sourceCache(work, tree, io) {
        const src = work.source;
        if (src.kind === 'v2') {
            const I = m002()._internals;
            const bytes = new Map();
            let bytesIn = 0;
            const bufs = await I.fetchAll(io, src.runs.map((run) => ({ url: tree.v2.base + run.url + tree.v2.query, start: run.start, end: run.end })));
            for (let r = 0; r < src.runs.length; r++) {
                const run = src.runs[r];
                const buf = bufs[r];
                bufs[r] = null;
                bytesIn += buf.length;
                for (const b of run.bricks) {
                    bytes.set(`${b.bz},${b.by},${b.bx}`, buf.subarray(b.offset - run.start, b.offset - run.start + b.length));
                }
                if (io.signal && io.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            }
            const cache = makeSourceCache(async (bz, by, bx) => {
                const b = bytes.get(`${bz},${by},${bx}`);
                if (!b) return null;
                bytes.delete(`${bz},${by},${bx}`);
                return { data: await I.decodeBrick(b, tree.v2, work.unit.c), stride: BRICK, off: 0 };
            });
            return { cache, bytesIn };
        }
        // The worker answers a list [{ bz, by, bx, bytes }]; a brick blob is accepted too.
        const stored = await io.fetchStored({ t: work.tree, level: src.level, channel: work.unit.c, bricks: src.bricks });
        const bytes = new Map();
        let bytesIn = 0;
        for (const b of Array.isArray(stored) ? stored : parseBrickBlob(stored)) {
            bytes.set(`${b.bz},${b.by},${b.bx}`, b.bytes);
            bytesIn += b.bytes.length;
        }
        const cache = makeSourceCache(async (bz, by, bx) => {
            const b = bytes.get(`${bz},${by},${bx}`);
            if (!b) return null;
            bytes.delete(`${bz},${by},${bx}`);
            return { data: await decodeV3Brick(b), stride: SLAB, off: APRON };
        });
        return { cache, bytesIn };
    }

    /** The level-k voxels of the unit's box, z-major: (z1−z0) × (y1−y0) × (x1−x0). */
    async function buildBox(work, cache) {
        const { box } = work;
        const dw = box.x1 - box.x0, dh = box.y1 - box.y0;
        const D = new Uint8Array(dw * dh * (box.z1 - box.z0));
        const src = work.source;
        for (let z = box.z0; z < box.z1; z++) {
            const o = (z - box.z0) * dw * dh;
            if (src.kind === 'v2') {
                D.set(await sourcePlane(cache, z, box.x0, box.x1, box.y0, box.y1), o);
                continue;
            }
            const sb = src.box;
            const pw = sb.x1 - sb.x0, ph = sb.y1 - sb.y0;
            const s0 = src.halveZ ? 2 * z : z;
            const p0 = await sourcePlane(cache, s0, sb.x0, sb.x1, sb.y0, sb.y1);
            const p1 = src.halveZ && s0 + 1 < src.dims.z ? await sourcePlane(cache, s0 + 1, sb.x0, sb.x1, sb.y0, sb.y1) : null;
            D.set(reducePlane(p0, p1, pw, ph, dw, dh), o);
        }
        return D;
    }

    async function runUnit(work, state, io) {
        const tree = state.byT.get(work.tree);
        if (!work.interiorPresent) return { body: buildBrickBlob([]), bytesIn: 0, tiles: 0 };
        const { cache, bytesIn } = await _sourceCache(work, tree, io);
        const D = await buildBox(work, cache);
        const out = [];
        const rgba = new Uint8ClampedArray(MOSAIC_W * MOSAIC_H * 4);
        const b = work.bricks;
        for (let bz = b.bz0; bz < b.bz1; bz++) {
            for (let by = b.by0; by < b.by1; by++) {
                for (let bx = b.bx0; bx < b.bx1; bx++) {
                    if (io.signal && io.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
                    const m = mosaicBrick(D, work.box, work.dims, bx, by, bz, rgba);
                    if (!m.kept) continue;
                    out.push({ bz, by, bx, bytes: await encodeWebpLossless(m.rgba, MOSAIC_W, MOSAIC_H) });
                }
            }
        }
        return { body: buildBrickBlob(out), bytesIn, tiles: out.length };
    }

    const handler = {
        id: ID,
        // Needs the v2 brick decoder of m002 (the worker imports it after this file).
        requires: ['m002-planes'],
        // A unit holds ≤ 258³ voxels (17 MiB) plus one decoded source layer (≤ 29 MiB).
        slotsPerWorker: 1,
        prepare, listUnits, planUnitWork, runUnit, probe,
        _internals: {
            levelPlan, voxelTriplet, isLosslessWebp, losslessWebpSize, unitKey, parseUnitKey, buildBrickBlob, parseBrickBlob, unmosaicV3, mosaicBrick,
            reducePlane, sourcePlane, makeSourceCache, buildBox, MOSAIC_W, MOSAIC_H, SLAB, COLS, ROWS,
        },
    };
    root.LumenMigrationHandlers = root.LumenMigrationHandlers || {};
    root.LumenMigrationHandlers[ID] = handler;
})(typeof self !== 'undefined' ? self : globalThis);
