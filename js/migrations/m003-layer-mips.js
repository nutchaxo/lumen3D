/**
 * Migration handler `m003-layer-mips` — browser executor (DOCS/dataset-migrations/SPEC.md §12).
 *
 * Format 2 → 3: for every brick layer `l` (planes z ∈ [64·l, min(64·l + 64, Z))) and channel
 * `c` of every tree, the per-voxel MAXIMUM over the layer's planes of LOD0, at native XY
 * resolution, tiled like the planes. One work unit `t{t}.l{l}.c{c}.y{ty}.x{tx}` = one layer,
 * one channel, one 512×512 tile: it range-reads that tile in each of the layer's ≤ 64 plane
 * packs (`planes/zNNNNN.bin`, header first — cached per z), decodes them with the normative JS
 * PNG decoder (`PlaneCodec.decodePngGray`: canvas read-back is not exact), takes the max, and
 * sends ONE png-gray8 tile (filter None) — none when the maximum is all zero (its pack entry
 * is then `length = 0`).
 *
 * Unit blob (SPEC §5.1 layout with the layer index in place of z):
 *   u32 count (0 or 1), count × { u32 l, u32 length, PNG bytes }
 *
 * Handler contract: see js/workers/migration-worker.js.
 */
(function (root) {
    'use strict';

    const ID = 'm003-layer-mips';
    const LAYER = 64;
    const SCHEMA = 'lumen-planes-v1';
    const CODEC = 'png-gray8';
    const HEADER_CACHE_MAX = 1024;
    const FETCH_PARALLEL = 8;

    const codec = () => root.PlaneCodec || (typeof PlaneCodec !== 'undefined' ? PlaneCodec : null);

    function isSafeRel(u) {
        const s = String(u || '').trim();
        if (!s || /^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//')) return false;
        return !s.replace(/^\/+/, '').split(/[\\/]/).includes('..');
    }

    // Same `?v=` as PlaneLoader (FNV-1a of the planes manifest text): one HTTP cache entry
    // per migrated tree, shared with the viewer.
    function fnv1a(str) {
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
        return h.toString(36);
    }

    function unitKey(t, l, c, ty, tx) { return `t${t}.l${l}.c${c}.y${ty}.x${tx}`; }

    function parseUnitKey(key) {
        const m = /^t(\d+)\.l(\d+)\.c(\d+)\.y(\d+)\.x(\d+)$/.exec(String(key));
        if (!m) throw new Error('bad unit key ' + key);
        return { t: +m[1], l: +m[2], c: +m[3], ty: +m[4], tx: +m[5] };
    }

    /**
     * Tree ids of a bricks manifest: v2 (`timepoints` object keyed tNNN) or v3 (`timepoints`
     * array of `{ path: 'tNNN', index }`, or of bare 'tNNN' names).
     */
    function treeIds(manifest) {
        const tp = manifest && manifest.timepoints;
        const out = [];
        if (Array.isArray(tp)) {
            for (const e of tp) {
                const name = String(e && typeof e === 'object' ? e.path : e).replace(/^\/+|\/+$/g, '');
                const m = /^t(\d+)$/.exec(name);
                if (m) out.push({ t: +m[1], name });
            }
        } else if (tp && typeof tp === 'object' && Object.keys(tp).length) {
            for (const k of Object.keys(tp)) { const m = /^t(\d+)$/.exec(k); if (m) out.push({ t: +m[1], name: k }); }
        }
        out.sort((a, b) => a.t - b.t);
        return out;
    }

    /** A planes manifest (SPEC §3.1) checked enough to read packs from it safely. */
    function validatePlanesManifest(m) {
        const fail = (why) => { throw new Error('invalid planes manifest: ' + why); };
        if (!m || typeof m !== 'object') fail('not an object');
        if (m.schema !== SCHEMA) fail('schema');
        if (m.codec !== CODEC) fail('codec');
        const d = m.dimensions || {};
        const dims = { x: +d.x, y: +d.y, z: +d.z };
        for (const a of ['x', 'y', 'z']) if (!(Number.isInteger(dims[a]) && dims[a] > 0)) fail('dimensions');
        const C = +m.channels, TS = +m.tileSize;
        if (!(Number.isInteger(C) && C >= 1 && C <= 0xFFFF)) fail('channels');
        if (TS !== 512) fail('tileSize');
        const TX = Math.ceil(dims.x / TS), TY = Math.ceil(dims.y / TS);
        if (!m.tiles || +m.tiles.x !== TX || +m.tiles.y !== TY) fail('tiles');
        if (+m.headerBytes !== codec().headerBytes(C, TX, TY)) fail('headerBytes');
        return { dims, channels: C, tileSize: TS, tilesX: TX, tilesY: TY, headerBytes: +m.headerBytes };
    }

    async function _readTree(ctx, t, base) {
        const url = base + 'manifest.json';
        const text = ctx.fetchText ? await ctx.fetchText(url) : JSON.stringify(await ctx.fetchJson(url));
        let m;
        try { m = JSON.parse(text); } catch (_) { throw new Error('invalid planes manifest JSON at ' + url); }
        const g = validatePlanesManifest(m);
        return {
            t, base, ...g,
            layers: Math.ceil(g.dims.z / LAYER),
            query: `?v=${fnv1a(text)}`,
            headers: new Map(),     // z → Promise<entries>
        };
    }

    /**
     * Reads the tree list from the bricks manifest (v2 or v3: the trees are the same) and
     * every tree's `planes/manifest.json`. ctx = { datasetBase, fetchJson, fetchText? }.
     */
    async function prepare(ctx) {
        const base = String(ctx.datasetBase).replace(/\/?$/, '/');
        let meta = null;
        try { meta = await ctx.fetchJson(base + 'metadata.json'); } catch (_) { meta = null; }
        let dir = meta && meta.qualities && meta.qualities.native && meta.qualities.native.directory;
        if (!dir || !isSafeRel(dir) || /[?#]/.test(dir)) dir = 'bricks';
        dir = String(dir).replace(/^\/+|\/+$/g, '');
        const bricks = await ctx.fetchJson(`${base}${dir}/manifest.json`);
        if (!bricks || typeof bricks !== 'object') throw new Error('invalid bricks manifest');
        const ids = treeIds(bricks);
        const trees = [];
        if (ids.length) {
            for (const { t, name } of ids) trees.push(await _readTree(ctx, t, `${base}planes/${name}/`));
        } else {
            trees.push(await _readTree(ctx, 0, `${base}planes/`));
        }
        return { id: ID, trees, byT: new Map(trees.map((tr) => [tr.t, tr])) };
    }

    /**
     * Every unit, in plan order (t, l, c, ty, tx). Emptiness needs the plane headers, which
     * only the server's plan reads: `empty` is false here (the browser lists units for its
     * benchmark only, where an empty one is merely a cheap sample).
     */
    function listUnits(state) {
        const units = [];
        for (const tr of state.trees) {
            for (let l = 0; l < tr.layers; l++) {
                for (let c = 0; c < tr.channels; c++) {
                    for (let ty = 0; ty < tr.tilesY; ty++) {
                        for (let tx = 0; tx < tr.tilesX; tx++) units.push({ key: unitKey(tr.t, l, c, ty, tx), empty: false });
                    }
                }
            }
        }
        return units;
    }

    function planUnitWork(key, state) {
        const u = parseUnitKey(key);
        const tr = state.byT.get(u.t);
        if (!tr) throw new Error('unit of an unknown tree ' + key);
        if (u.l >= tr.layers || u.c >= tr.channels || u.ty >= tr.tilesY || u.tx >= tr.tilesX) throw new Error('unit out of range ' + key);
        const z0 = u.l * LAYER;
        return {
            key, unit: u, tree: u.t, z0, z1: Math.min(z0 + LAYER, tr.dims.z),
            width: Math.min(tr.tileSize, tr.dims.x - u.tx * tr.tileSize),
            height: Math.min(tr.tileSize, tr.dims.y - u.ty * tr.tileSize),
        };
    }

    function packUrl(tr, z) { return `${tr.base}z${String(z).padStart(5, '0')}.bin${tr.query}`; }

    function _header(tr, z, io) {
        let p = tr.headers.get(z);
        if (!p) {
            p = io.fetchRange(packUrl(tr, z), 0, tr.headerBytes).then((bytes) => {
                const h = codec().parsePackHeader(bytes, codec().PACK_MAGIC);
                if (h.channels !== tr.channels || h.tilesX !== tr.tilesX || h.tilesY !== tr.tilesY || h.z !== z) {
                    throw Object.assign(new Error(`plane pack z${z} does not match its manifest`), { code: 'bad_plane_pack', fatal: true });
                }
                return h.entries;
            });
            p.catch(() => tr.headers.delete(z));
            tr.headers.set(z, p);
            while (tr.headers.size > HEADER_CACHE_MAX) tr.headers.delete(tr.headers.keys().next().value);
        }
        return p;
    }

    /** Per-voxel maximum, in place: acc[i] = max(acc[i], px[i]). */
    function maxInto(acc, px) {
        for (let i = 0; i < acc.length; i++) { const v = px[i]; if (v > acc[i]) acc[i] = v; }
        return acc;
    }

    function isAllZero(a) {
        for (let i = 0; i < a.length; i++) if (a[i] !== 0) return false;
        return true;
    }

    /** `fn` over `items`, n at a time; the first failure stops every lane (no more fetches). */
    async function _pool(n, items, fn) {
        let next = 0;
        let failed = false;
        const lane = async () => {
            while (next < items.length && !failed) {
                const i = next++;
                try { await fn(items[i], i); } catch (err) { failed = true; throw err; }
            }
        };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, lane));
    }

    /**
     * The plane headers this unit needs and the tree has not read yet, in one batched read
     * (io.fetchRanges) — a layer projection reads 64 plane files, one request each was most of
     * the executor's traffic. Without fetchRanges, _header reads them one by one.
     */
    async function _prefetchHeaders(tr, zs, io) {
        if (typeof io.fetchRanges !== 'function') return 0;
        const missing = zs.filter((z) => !tr.headers.has(z));
        if (!missing.length) return 0;
        const bufs = await io.fetchRanges(missing.map((z) => ({ url: packUrl(tr, z), start: 0, end: tr.headerBytes })));
        missing.forEach((z, i) => {
            const bytes = bufs[i];
            const p = Promise.resolve().then(() => {
                const h = codec().parsePackHeader(bytes, codec().PACK_MAGIC);
                if (h.channels !== tr.channels || h.tilesX !== tr.tilesX || h.tilesY !== tr.tilesY || h.z !== z) {
                    throw Object.assign(new Error(`plane pack z${z} does not match its manifest`), { code: 'bad_plane_pack', fatal: true });
                }
                return h.entries;
            });
            p.catch(() => tr.headers.delete(z));
            tr.headers.set(z, p);
        });
        while (tr.headers.size > HEADER_CACHE_MAX) tr.headers.delete(tr.headers.keys().next().value);
        return missing.length * tr.headerBytes;
    }

    async function runUnit(work, state, io) {
        const tr = state.byT.get(work.tree);
        const PC = codec();
        const idx = PC.tileIndex(work.unit.c, work.unit.ty, work.unit.tx, tr.tilesX, tr.tilesY);
        const acc = new Uint8Array(work.width * work.height);
        let bytesIn = 0;
        const zs = [];
        for (let z = work.z0; z < work.z1; z++) zs.push(z);
        if (typeof io.fetchRanges === 'function') {
            bytesIn += await _prefetchHeaders(tr, zs, io);
            const want = [];
            for (const z of zs) {
                const e = (await _header(tr, z, io))[idx];
                if (e && e.length) want.push({ z, url: packUrl(tr, z), start: e.offset, end: e.offset + e.length });
            }
            if (io.signal && io.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            const pngs = want.length ? await io.fetchRanges(want) : [];
            for (let i = 0; i < want.length; i++) {
                const png = pngs[i];
                pngs[i] = null;
                bytesIn += png.length;
                const d = await PC.decodePngGray(png);
                if (d.width !== work.width || d.height !== work.height) {
                    throw Object.assign(new Error(`plane tile z${want[i].z} is ${d.width}×${d.height}, expected ${work.width}×${work.height}`), { code: 'bad_plane_tile', fatal: true });
                }
                maxInto(acc, d.data);
            }
            const tiles = isAllZero(acc) ? [] : [{ z: work.unit.l, png: await PC.encodePngGray(work.width, work.height, acc) }];
            return { body: PC.buildUnitBlob(tiles), bytesIn, tiles: tiles.length };
        }
        await _pool(FETCH_PARALLEL, zs, async (z) => {
            if (io.signal && io.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            const fresh = !tr.headers.has(z);
            const entries = await _header(tr, z, io);
            if (fresh) bytesIn += tr.headerBytes;
            const e = entries[idx];
            if (!e || !e.length) return;   // an all-zero tile adds nothing to a maximum
            const png = await io.fetchRange(packUrl(tr, z), e.offset, e.offset + e.length);
            bytesIn += png.length;
            const d = await PC.decodePngGray(png);
            if (d.width !== work.width || d.height !== work.height) {
                throw Object.assign(new Error(`plane tile z${z} is ${d.width}×${d.height}, expected ${work.width}×${work.height}`), { code: 'bad_plane_tile', fatal: true });
            }
            maxInto(acc, d.data);
        });
        const tiles = isAllZero(acc) ? [] : [{ z: work.unit.l, png: await PC.encodePngGray(work.width, work.height, acc) }];
        return { body: PC.buildUnitBlob(tiles), bytesIn, tiles: tiles.length };
    }

    /** The browser can run this migration iff it encodes and decodes png-gray8 exactly. */
    async function probe() {
        const PC = codec();
        if (!PC) return { available: false, reasons: ['no_plane_codec'] };
        if (typeof CompressionStream === 'undefined' || typeof DecompressionStream === 'undefined') {
            return { available: false, reasons: ['no_compression_stream'] };
        }
        try {
            const w = 37, h = 5;
            const px = new Uint8Array(w * h);
            for (let i = 0; i < px.length; i++) px[i] = (i * 97 + 13) & 0xFF;
            const d = await PC.decodePngGray(await PC.encodePngGray(w, h, px));
            for (let i = 0; i < px.length; i++) if (d.data[i] !== px[i]) return { available: false, reasons: ['no_png_codec'] };
            return { available: true, reasons: [] };
        } catch (_) {
            return { available: false, reasons: ['no_png_codec'] };
        }
    }

    const handler = {
        id: ID,
        // Each unit holds one 512² accumulator plus ≤ 8 decoded tiles: as light as m002.
        slotsPerWorker: 2,
        prepare, listUnits, planUnitWork, runUnit, probe,
        _internals: { fnv1a, unitKey, parseUnitKey, treeIds, validatePlanesManifest, maxInto, packUrl },
    };
    root.LumenMigrationHandlers = root.LumenMigrationHandlers || {};
    root.LumenMigrationHandlers[ID] = handler;
})(typeof self !== 'undefined' ? self : globalThis);
