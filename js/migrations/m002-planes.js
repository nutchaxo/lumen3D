/**
 * Migration handler `m002-planes` — browser executor (DOCS/dataset-migrations/SPEC.md §3, §4, §6).
 *
 * Format 1 → 2: the native level of every brick tree re-cut into XY planes. One work unit
 * `t{t}.z{bz}.c{c}.y{ty}.x{tx}` = one brick layer, one channel, one 512×512 tile = the
 * ≤ 8×8 bricks of that layer under the tile; it yields up to 64 png-gray8 tiles, one per z.
 *
 * Runs inside js/workers/migration-worker.js (classic script, importScripts after
 * js/core/plane-codec.js). The handler is pure apart from `createImageBitmap` /
 * `OffscreenCanvas` (WebP decode) and the `io` the worker passes in (range fetches with
 * retries), so the same functions are exercised by the node tests.
 *
 * Handler contract (generic, see migration-worker.js):
 *   prepare(ctx)                 → state      ctx = { datasetBase: absolute URL ending in '/', fetchJson(url) }
 *   listUnits(state)             → [{ key, empty }]   every unit, in plan order
 *   planUnitWork(key, state)     → work descriptor (bricks, merged byte runs, expected bytes)
 *   runUnit(work, state, io)     → { body: Uint8Array (SPEC §5.1 unit blob), bytesIn, tiles }
 */
(function (root) {
    'use strict';

    const ID = 'm002-planes';
    const BRICK = 64;
    const TILE = 512;
    const BRICKS_PER_TILE = TILE / BRICK;      // 8
    // Bytes between two wanted bricks of one pack below which one request covers both:
    // a gap costs bandwidth, an extra request costs a round trip (~ tens of KB on a LAN).
    const RANGE_GAP_BYTES = 64 * 1024;
    const SUPPORTED_ENCODINGS = new Set(['webp-lossless', 'raw-u8', 'raw-u8-gzip', 'raw-rgba-gzip']);

    // ── Pack URL stamp: the viewer's `?v=` (BrickLoader._packStamp), byte for byte ──
    function packStamp(transport) {
        let h = 0x811c9dc5;
        const feed = (str) => {
            for (let i = 0; i < str.length; i++) {
                h ^= str.charCodeAt(i);
                h = Math.imul(h, 0x01000193) >>> 0;
            }
        };
        const hashes = transport.packHashes && typeof transport.packHashes === 'object' ? transport.packHashes : null;
        if (hashes && Object.keys(hashes).length) {
            for (const k in hashes) feed(`${k}=${hashes[k]};`);
        } else {
            const sizes = new Map();
            const index = transport.brickToPack || {};
            for (const p in index) {
                const e = index[p];
                if (!e || !e.url || !Number.isFinite(Number(e.offset)) || !Number.isFinite(Number(e.length))) continue;
                if (!isSafeRel(e.url)) continue;
                const url = String(e.url).replace(/^\/+/, '');
                const end = Number(e.offset) + Number(e.length);
                if (end > (sizes.get(url) || 0)) sizes.set(url, end);
            }
            for (const [url, size] of sizes) feed(`${url}:${size};`);
        }
        if (transport.createdAt) feed(String(transport.createdAt));
        return h.toString(36);
    }

    function isSafeRel(u) {
        const s = String(u || '').trim();
        if (!s || /^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//')) return false;
        return !s.replace(/^\/+/, '').split(/[\\/]/).includes('..');
    }

    function brickRel(lod, channel, bx, by, bz, encoding) {
        const c = `x${String(bx).padStart(3, '0')}_y${String(by).padStart(3, '0')}_z${String(bz).padStart(3, '0')}`;
        if (encoding === 'raw-rgba-gzip') return `lod${lod}/rgba/${c}.rgba`;
        return `lod${lod}/c${channel}/${c}.webp`;
    }

    function parseUnitKey(key) {
        const m = /^t(\d+)\.z(\d+)\.c(\d+)\.y(\d+)\.x(\d+)$/.exec(String(key));
        if (!m) throw new Error('bad unit key ' + key);
        return { t: +m[1], bz: +m[2], c: +m[3], ty: +m[4], tx: +m[5] };
    }

    function unitKey(t, bz, c, ty, tx) { return `t${t}.z${bz}.c${c}.y${ty}.x${tx}`; }

    // ── Trees ────────────────────────────────────────────────────────────────
    function _tree(t, base, manifest, row) {
        const levels = (row && Array.isArray(row.levels) && row.levels.length) ? row.levels : manifest.levels;
        const transport = (row && row.brickTransport) || manifest.brickTransport || null;
        const l0 = Array.isArray(levels) ? levels.find((l) => l && l.level === 0) || levels[0] : null;
        if (!l0 || !l0.dimensions) throw new Error('manifest without level 0');
        const dims = { x: +l0.dimensions.x, y: +l0.dimensions.y, z: +l0.dimensions.z };
        for (const a of ['x', 'y', 'z']) if (!(dims[a] > 0 && Number.isInteger(dims[a]))) throw new Error('bad level-0 dimensions');
        const channels = +((row && row.channels) || manifest.channels || 1);
        if (!(Number.isInteger(channels) && channels >= 1)) throw new Error('bad channel count');
        const encoding = (transport && transport.encoding) || 'webp-lossless';
        if (!SUPPORTED_ENCODINGS.has(encoding)) throw new Error('unsupported brick encoding ' + encoding);
        const packing = manifest.brickPacking || {};
        if (encoding === 'webp-lossless' && packing.mode !== 'grid' && packing.mode !== 'vertical') {
            throw new Error('unknown brick packing ' + JSON.stringify(packing.mode));
        }
        if ((manifest.brickSize || BRICK) !== BRICK) throw new Error('brickSize must be 64');
        const index = new Map();
        const b2p = transport && transport.brickToPack;
        if (!b2p || typeof b2p !== 'object') throw new Error('manifest without brickToPack (pack mode required)');
        for (const p in b2p) {
            const e = b2p[p];
            if (!e || !e.url || !isSafeRel(e.url)) continue;
            const offset = Number(e.offset), length = Number(e.length);
            if (!Number.isFinite(offset) || !Number.isFinite(length) || length <= 0) continue;
            index.set(String(p).replace(/^\/+/, ''), { url: String(e.url).replace(/^\/+/, ''), offset, length });
        }
        return {
            t, base, dims, channels, encoding, packing, index,
            query: `?v=${packStamp(transport)}`,
            nx: Math.ceil(dims.x / BRICK), ny: Math.ceil(dims.y / BRICK), nz: Math.ceil(dims.z / BRICK),
            tilesX: Math.ceil(dims.x / TILE), tilesY: Math.ceil(dims.y / TILE),
        };
    }

    /**
     * Reads the dataset's brick manifest(s) and returns one tree per brick tree: `bricks/` for
     * a 3d dataset (t = 0), `bricks/tNNN/` for each timepoint of a live one (t = NNN).
     */
    async function prepare(ctx) {
        const base = String(ctx.datasetBase).replace(/\/?$/, '/');
        let meta = null;
        try { meta = await ctx.fetchJson(base + 'metadata.json'); } catch (_) { meta = null; }
        let dir = meta && meta.qualities && meta.qualities.native && meta.qualities.native.directory;
        if (!dir || !isSafeRel(dir) || /[?#]/.test(dir)) dir = 'bricks';
        dir = String(dir).replace(/^\/+|\/+$/g, '');
        const manifest = await ctx.fetchJson(`${base}${dir}/manifest.json`);
        if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.levels)) throw new Error('invalid bricks manifest');
        const trees = [];
        const rows = manifest.timepoints && typeof manifest.timepoints === 'object' ? manifest.timepoints : null;
        if (rows && Object.keys(rows).length) {
            for (const k of Object.keys(rows)) {
                const m = /^t(\d+)$/.exec(k);
                if (!m) continue;
                const row = rows[k] || {};
                const path = row.path && isSafeRel(row.path) ? String(row.path).replace(/^\/+|\/+$/g, '') : k;
                trees.push(_tree(+m[1], `${base}${dir}/${path}/`, manifest, row));
            }
            trees.sort((a, b) => a.t - b.t);
        } else {
            trees.push(_tree(0, `${base}${dir}/`, manifest, null));
        }
        return { id: ID, trees, byT: new Map(trees.map((tr) => [tr.t, tr])) };
    }

    function _unitBricks(tree, u) {
        const out = [];
        const bx0 = u.tx * BRICKS_PER_TILE, by0 = u.ty * BRICKS_PER_TILE;
        for (let by = by0; by < Math.min(by0 + BRICKS_PER_TILE, tree.ny); by++) {
            for (let bx = bx0; bx < Math.min(bx0 + BRICKS_PER_TILE, tree.nx); bx++) {
                const rel = brickRel(0, u.c, bx, by, u.bz, tree.encoding);
                const e = tree.index.get(rel);
                if (e) out.push({ bx, by, bz: u.bz, rel, url: e.url, offset: e.offset, length: e.length });
            }
        }
        return out;
    }

    function listUnits(state) {
        const units = [];
        for (const tree of state.trees) {
            for (let bz = 0; bz < tree.nz; bz++) {
                for (let c = 0; c < tree.channels; c++) {
                    for (let ty = 0; ty < tree.tilesY; ty++) {
                        for (let tx = 0; tx < tree.tilesX; tx++) {
                            const u = { t: tree.t, bz, c, ty, tx };
                            units.push({ key: unitKey(tree.t, bz, c, ty, tx), empty: _unitBricks(tree, u).length === 0 });
                        }
                    }
                }
            }
        }
        return units;
    }

    /** Per pack, the wanted bricks' [offset, end) intervals merged across gaps ≤ RANGE_GAP_BYTES. */
    function mergeRuns(bricks, gap) {
        gap = gap === undefined ? RANGE_GAP_BYTES : gap;
        const perPack = new Map();
        for (const b of bricks) {
            let l = perPack.get(b.url);
            if (!l) perPack.set(b.url, l = []);
            l.push(b);
        }
        const runs = [];
        for (const [url, list] of perPack) {
            list.sort((a, b) => a.offset - b.offset);
            let cur = null;
            for (const b of list) {
                const end = b.offset + b.length;
                if (cur && b.offset - cur.end <= gap) {
                    cur.end = Math.max(cur.end, end);
                    cur.bricks.push(b);
                } else {
                    cur = { url, start: b.offset, end, bricks: [b] };
                    runs.push(cur);
                }
            }
        }
        return runs;
    }

    function planUnitWork(key, state) {
        const u = parseUnitKey(key);
        const tree = state.byT.get(u.t);
        if (!tree) throw new Error('unit of an unknown tree ' + key);
        if (u.c >= tree.channels || u.bz >= tree.nz || u.ty >= tree.tilesY || u.tx >= tree.tilesX) throw new Error('unit out of range ' + key);
        const bricks = _unitBricks(tree, u);
        const runs = mergeRuns(bricks);
        const z0 = u.bz * BRICK;
        return {
            key, unit: u, tree: u.t, bricks, runs,
            z0, depth: Math.min(BRICK, tree.dims.z - z0),
            width: Math.min(TILE, tree.dims.x - u.tx * TILE),
            height: Math.min(TILE, tree.dims.y - u.ty * TILE),
            bytesIn: runs.reduce((s, r) => s + (r.end - r.start), 0),
        };
    }

    // ── Brick decode (identical to js/core/brick-decode-worker.js) ───────────────
    /**
     * Grid mosaic → 64³ scalar brick, z-major then y then x. Tile (tx, ty) of the mosaic holds
     * z = ty·cols + tx; voxel (x, y, z) is mosaic pixel (tx·bs + x, ty·bs + y), value = R. A
     * pixel outside the decoded picture (truncated mosaic) is 0, as in the decode worker.
     */
    function unmosaicGrid(rgba, imgW, imgH, bs, cols) {
        const out = new Uint8Array(bs * bs * bs);
        const len = rgba.length;
        for (let z = 0; z < bs; z++) {
            const px0 = (z % cols) * bs;
            const py0 = Math.floor(z / cols) * bs;
            for (let y = 0; y < bs; y++) {
                const py = py0 + y;
                let d = (z * bs + y) * bs;
                for (let x = 0; x < bs; x++) {
                    const px = px0 + x;
                    const i = (py * imgW + px) * 4;
                    out[d++] = (px < imgW && py < imgH && i < len) ? rgba[i] : 0;
                }
            }
        }
        return out;
    }

    function gridCols(packing, bs) {
        const c = Number(packing && packing.cols);
        return (Number.isFinite(c) && c >= 1) ? c : Math.ceil(bs / Math.ceil(Math.sqrt(bs)));
    }

    let _canvas = null, _ctx2d = null;
    async function decodeWebpBrick(bytes, packing) {
        const blob = new Blob([bytes], { type: 'image/webp' });
        // Measured intensities, not colours: neither colour management nor premultiplication.
        const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        try {
            if (!_canvas || _canvas.width < bmp.width || _canvas.height < bmp.height) {
                _canvas = new OffscreenCanvas(Math.max(bmp.width, _canvas ? _canvas.width : 0), Math.max(bmp.height, _canvas ? _canvas.height : 0));
                _ctx2d = _canvas.getContext('2d', { willReadFrequently: true });
                _ctx2d.globalCompositeOperation = 'copy';
            }
            _ctx2d.drawImage(bmp, 0, 0);
            const data = _ctx2d.getImageData(0, 0, bmp.width, bmp.height).data;
            if (packing.mode === 'grid') return unmosaicGrid(data, bmp.width, bmp.height, BRICK, gridCols(packing, BRICK));
            const out = new Uint8Array(BRICK * BRICK * BRICK);
            const n = Math.min(out.length, data.length >> 2);
            for (let i = 0; i < n; i++) out[i] = data[i * 4];
            return out;
        } finally {
            if (bmp && typeof bmp.close === 'function') bmp.close();
        }
    }

    async function _gunzip(bytes) {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    /** One channel of one brick as 64³ scalar bytes (z, y, x). */
    async function decodeBrick(bytes, tree, channel) {
        const whole = BRICK * BRICK * BRICK;
        if (tree.encoding === 'webp-lossless') return decodeWebpBrick(bytes, tree.packing || {});
        if (tree.encoding === 'raw-u8' || tree.encoding === 'raw-u8-gzip') {
            const d = tree.encoding === 'raw-u8' ? new Uint8Array(bytes) : await _gunzip(bytes);
            if (d.length !== whole) throw new Error(`brick holds ${d.length} bytes, expected ${whole}`);
            return d;
        }
        const d = await _gunzip(bytes);   // raw-rgba-gzip: channels 0..3 interleaved
        if (d.length !== whole * 4) throw new Error(`brick holds ${d.length} bytes, expected ${whole * 4}`);
        const out = new Uint8Array(whole);
        for (let i = 0, s = channel; i < whole; i++, s += 4) out[i] = d[s];
        return out;
    }

    /**
     * Copies a 64³ brick into the unit's plane stack (depth × height × width, row-major), at
     * offset (ox, oy) inside the tile; voxels past the volume edge (brick padding) are dropped.
     */
    function scatterBrick(brick, planes, width, height, depth, ox, oy) {
        const w = Math.min(BRICK, width - ox);
        const h = Math.min(BRICK, height - oy);
        const d = Math.min(BRICK, depth);
        if (w <= 0 || h <= 0) return;
        for (let z = 0; z < d; z++) {
            const pz = z * height * width;
            for (let y = 0; y < h; y++) {
                const src = (z * BRICK + y) * BRICK;
                planes.set(brick.subarray(src, src + w), pz + (oy + y) * width + ox);
            }
        }
    }

    function isAllZero(a) {
        // A 32-bit view walks four times fewer elements; plane offsets are multiples of w·h.
        if ((a.byteOffset & 3) === 0) {
            const n4 = a.length >> 2;
            const u32 = new Uint32Array(a.buffer, a.byteOffset, n4);
            for (let i = 0; i < n4; i++) if (u32[i] !== 0) return false;
            for (let i = n4 << 2; i < a.length; i++) if (a[i] !== 0) return false;
            return true;
        }
        for (let i = 0; i < a.length; i++) if (a[i] !== 0) return false;
        return true;
    }

    /**
     * io.fetchRange(absoluteUrl, start, endExclusive) → Uint8Array of exactly end − start bytes.
     * An all-zero plane is not sent: its tile is `length = 0` in the pack (SPEC §3.2).
     */
    async function runUnit(work, state, io) {
        const tree = state.byT.get(work.tree);
        const planes = new Uint8Array(work.depth * work.height * work.width);
        let bytesIn = 0;
        for (const run of work.runs) {
            const url = tree.base + run.url + tree.query;
            const buf = await io.fetchRange(url, run.start, run.end);
            bytesIn += buf.length;
            for (const b of run.bricks) {
                const bytes = buf.subarray(b.offset - run.start, b.offset - run.start + b.length);
                const brick = await decodeBrick(bytes, tree, work.unit.c);
                scatterBrick(brick, planes, work.width, work.height, work.depth,
                    (b.bx - work.unit.tx * BRICKS_PER_TILE) * BRICK, (b.by - work.unit.ty * BRICKS_PER_TILE) * BRICK);
            }
            if (io.signal && io.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        const tiles = [];
        const plane = work.width * work.height;
        for (let z = 0; z < work.depth; z++) {
            const px = planes.subarray(z * plane, (z + 1) * plane);
            if (isAllZero(px)) continue;
            tiles.push({ z: work.z0 + z, png: await PlaneCodec.encodePngGray(work.width, work.height, px) });
        }
        const body = PlaneCodec.buildUnitBlob(tiles);
        return { body, bytesIn, tiles: tiles.length };
    }

    const handler = {
        id: ID,
        prepare, listUnits, planUnitWork, runUnit,
        // exposed for tests
        _internals: { packStamp, parseUnitKey, unitKey, mergeRuns, unmosaicGrid, scatterBrick, isAllZero, brickRel, gridCols, decodeBrick },
    };
    root.LumenMigrationHandlers = root.LumenMigrationHandlers || {};
    root.LumenMigrationHandlers[ID] = handler;
})(typeof self !== 'undefined' ? self : globalThis);
