/**
 * Migration handler `m005-matrix` — browser executor (DOCS/dataset-migrations/SPEC.md §14.10).
 *
 * Format 4 → 5: the resolution × compression matrix. Unlike m002–m004, the browser does not
 * plan a unit itself: it asks the server (`unit_inputs`) which byte runs the unit reads — the
 * png-gray8 tiles of level-k planes (level 0 = the published `planes/`, levels ≥ 1 = the
 * planes the job's stage A stored, `@store/A/…`) and, for a level-0 brick unit, the format-4
 * bricks — reads them through `read_ranges` and computes the unit with the same arithmetic as
 * format5.py. Stages (unit key `S.t…`):
 *
 *   A  t.c.z        one native plane → that plane at every level k ≥ 1 (exact area average,
 *                   `resamplePlane`), one single-channel LPLN pack per level
 *   B  t.k.c.z.y.x  the 66³ bricks of one 4×4×4 super-block of level k, every column but the
 *                   level-0 `ll` (the format-4 bricks, linked as they are at finalize)
 *   C  t.k.c.xz|yz.bN  the XZ (or YZ) cuts of 64 consecutive rows (columns), one orth pack
 *   D  t.k.c.z.y.x  the 32 × 32 × bz cut bricks of one 8×8×8 super-block, one cut record
 *
 * Arithmetic (normative, identical to format5.py):
 *   level-k plane      P_k(x, y) = ⌊(Σ w_x(i, x)·w_y(j, y)·P_0(i, j) + ⌊D/2⌋) / D⌋, D = W0·H0, w the
 *                      overlaps of source voxel i (covering [i·n1, (i+1)·n1)) and output voxel x
 *                      (covering [x·n0, (x+1)·n0)) on the integer line of length n0·n1
 *   b2 / b4            the index of the bounded quantizer of half-width e, stored lossless
 *   q80 / q50          WebP lossy of the 80-px-pitch mosaic + a dead-zone byte τ ∈ 0..12 (the τ
 *                      minimising the interior's squared error once decoded values ≤ τ are 0);
 *                      replaced by the b4 image + 0xFE or the ll image + 0xFF when one of them
 *                      is not larger (the smallest form wins, the more faithful on a tie)
 *
 * The WebP encoders of a browser are not libwebp's of Pillow: lossless images decode to the
 * same voxels, lossy ones look the same; the bytes differ. The server checks every image's
 * kind and size (dataset_migrations.py:_m005_check_brick).
 *
 * Unit bodies (browser → server, little-endian):
 *   A  u32 n, n × { u32 k, u32 length }, then the n LPLN packs (length 0 = an all-zero plane)
 *   B  u32 n, n × { u32 bz, by, bx }, per column n × u32 length, payloads column-major
 *   C  the orth pack          D  the cut record (empty body = every cut brick is zero)
 *
 * Handler contract: see js/workers/migration-worker.js.
 */
(function (root) {
    'use strict';

    const ID = 'm005-matrix';
    const BRICK = 64;
    const APRON = 1;
    const SLICE = BRICK + 2 * APRON;               // 66
    const COLS = 9, ROWS = 8;
    const M66_W = COLS * SLICE, M66_H = ROWS * SLICE;   // 594 × 528
    const PITCH = 80;
    const PAD = (PITCH - SLICE) / 2;               // 7
    const M80_W = COLS * PITCH, M80_H = ROWS * PITCH;   // 720 × 640
    const TILE = 512;
    const DEAD_ZONE_MAX = 12;
    const TAG_B4 = 0xFE, TAG_LL = 0xFF;
    const CUT_XY = 32, CUT_SUPER = 8;
    const CUT_RECORD_HEAD = CUT_SUPER ** 3 * 8;
    const ORTH_MAGIC = { xz: 'LPXZ', yz: 'LPYZ' };
    const ORTH_HEADER = 20, ORTH_ENTRY = 12;
    const PLANE_HEADER = 16, PLANE_ENTRY = 12;
    // Compressed tiles kept by this worker across units: consecutive XZ units read the same
    // 512-row band of every plane, consecutive brick and cut units the same 512² tiles.
    const TILE_CACHE_BYTES = 128 * 1024 * 1024;

    const COLUMNS = {
        ll: { codec: 'webp-lossless' },
        b2: { codec: 'webp-lossless-lut', maxError: 2 },
        b4: { codec: 'webp-lossless-lut', maxError: 4 },
        q80: { codec: 'webp-lossy-dz', quality: 80 },
        q50: { codec: 'webp-lossy-dz', quality: 50 },
    };
    const isLossy = (cid) => column(cid).codec === 'webp-lossy-dz';

    function column(cid) {
        const c = COLUMNS[cid];
        if (!c) throw new Error('unknown column ' + cid);
        return c;
    }

    function fail(code, message, fatal) {
        return Object.assign(new Error(message || code), { code, fatal: fatal !== false });
    }

    function aborted(io) {
        if (io && io.signal && io.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }

    // ── Quantizer (SPEC §14.3) ────────────────────────────────────────────────────

    /** index_of of the bounded quantizer of half-width e: 0 alone, then bins of 2e + 1 values. */
    function quantizerIndex(e) {
        const indexOf = new Uint8Array(256);
        for (let s = 1, k = 1; s <= 255; k++) {
            const hi = Math.min(255, s + 2 * e);
            for (let v = s; v <= hi; v++) indexOf[v] = k;
            s = hi + 1;
        }
        return indexOf;
    }
    const QUANT = { 2: quantizerIndex(2), 4: quantizerIndex(4) };

    // ── Levels (SPEC §14.1) ───────────────────────────────────────────────────────

    /** Source index and overlap of each output voxel along an axis n0 → n1 (K slots each). */
    function axisWeights(n0, n1) {
        let K = 1;
        for (let i = 0; i < n1; i++) {
            const j0 = Math.floor(i * n0 / n1), j1 = Math.floor(((i + 1) * n0 - 1) / n1);
            K = Math.max(K, j1 - j0 + 1);
        }
        const idx = new Int32Array(n1 * K), w = new Float64Array(n1 * K);
        for (let i = 0; i < n1; i++) {
            const lo = i * n0, hi = (i + 1) * n0;
            const j0 = Math.floor(lo / n1), j1 = Math.floor((hi - 1) / n1);
            for (let k = 0; k < K; k++) {
                const j = j0 + k;
                idx[i * K + k] = Math.min(j, n0 - 1);
                w[i * K + k] = j <= j1 ? Math.min((j + 1) * n1, hi) - Math.max(j * n1, lo) : 0;
            }
        }
        return { idx, w, K };
    }

    /**
     * The exact area average of a W0 × H0 plane on w1 × h1 (format5.py:resample_plane): the
     * X pass then the Y pass in integers (every sum ≤ 255·W0·H0 < 2^53, exact in a double),
     * one division by D = W0·H0 rounded half up.
     */
    function resamplePlane(src, W0, H0, w1, h1) {
        if (w1 === W0 && h1 === H0) return src.slice();
        const ax = axisWeights(W0, w1), ay = axisWeights(H0, h1);
        const D = W0 * H0, half = Math.floor(D / 2);
        const out = new Uint8Array(w1 * h1);
        const rows = new Map();
        const rowX = (j) => {
            let r = rows.get(j);
            if (r) return r;
            r = new Float64Array(w1);
            const base = j * W0;
            for (let i = 0, p = 0; i < w1; i++) {
                let s = 0;
                for (let k = 0; k < ax.K; k++, p++) {
                    const wt = ax.w[p];
                    if (wt) s += src[base + ax.idx[p]] * wt;
                }
                r[i] = s;
            }
            rows.set(j, r);
            return r;
        };
        const acc = new Float64Array(w1);
        for (let y = 0; y < h1; y++) {
            acc.fill(0);
            for (let k = 0; k < ay.K; k++) {
                const p = y * ay.K + k;
                const wt = ay.w[p];
                if (!wt) continue;
                const r = rowX(ay.idx[p]);
                for (let x = 0; x < w1; x++) acc[x] += r[x] * wt;
            }
            const o = y * w1;
            for (let x = 0; x < w1; x++) out[o + x] = Math.floor((acc[x] + half) / D);
            // Source rows only move forward: drop those the next output row no longer reads.
            const next = y + 1 < h1 ? ay.idx[(y + 1) * ay.K] : Infinity;
            for (const j of rows.keys()) if (j < next) rows.delete(j);
        }
        return out;
    }

    // ── Bricks (SPEC §14.2) ───────────────────────────────────────────────────────

    /** Region-relative indices of the 66 clamped samples of brick b along an axis of n voxels. */
    function apronIndex(b, n, origin) {
        const a = new Int32Array(SLICE);
        for (let i = 0; i < SLICE; i++) a[i] = Math.min(n - 1, Math.max(0, BRICK * b - APRON + i)) - origin;
        return a;
    }

    /** The 66³ brick (z, y, x) of a level from `region` (rw × rh × rd voxels from `origin`). */
    function brickWithApron(region, rw, rh, origin, dims, bx, by, bz) {
        const ix = apronIndex(bx, dims.x, origin.x), iy = apronIndex(by, dims.y, origin.y), iz = apronIndex(bz, dims.z, origin.z);
        const out = new Uint8Array(SLICE * SLICE * SLICE);
        let o = 0;
        for (let l = 0; l < SLICE; l++) {
            const plane = iz[l] * rh * rw;
            for (let j = 0; j < SLICE; j++) {
                const row = plane + iy[j] * rw;
                for (let i = 0; i < SLICE; i++) out[o++] = region[row + ix[i]];
            }
        }
        return out;
    }

    function brickKept(b) {
        for (let l = APRON; l < APRON + BRICK; l++) {
            for (let j = APRON; j < APRON + BRICK; j++) {
                const o = (l * SLICE + j) * SLICE;
                for (let i = o + APRON; i < o + APRON + BRICK; i++) if (b[i]) return true;
            }
        }
        return false;
    }

    /** 594 × 528: slice s at column s mod 9, row ⌊s / 9⌋; the 6 last slots zero. */
    function mosaic66(b) {
        const out = new Uint8Array(M66_W * M66_H);
        for (let l = 0; l < SLICE; l++) {
            const px0 = (l % COLS) * SLICE, py0 = Math.floor(l / COLS) * SLICE;
            for (let j = 0; j < SLICE; j++) {
                const s = (l * SLICE + j) * SLICE;
                out.set(b.subarray(s, s + SLICE), (py0 + j) * M66_W + px0);
            }
        }
        return out;
    }

    function unmosaic66(img) {
        const out = new Uint8Array(SLICE * SLICE * SLICE);
        for (let l = 0; l < SLICE; l++) {
            const px0 = (l % COLS) * SLICE, py0 = Math.floor(l / COLS) * SLICE;
            for (let j = 0; j < SLICE; j++) {
                const s = (py0 + j) * M66_W + px0;
                out.set(img.subarray(s, s + SLICE), (l * SLICE + j) * SLICE);
            }
        }
        return out;
    }

    /** 720 × 640: the 66² slices centred in 80-px slots with 7 px of edge replication. */
    function mosaic80(b) {
        const out = new Uint8Array(M80_W * M80_H);
        for (let l = 0; l < SLICE; l++) {
            const px0 = (l % COLS) * PITCH, py0 = Math.floor(l / COLS) * PITCH;
            for (let y = 0; y < PITCH; y++) {
                const j = Math.min(SLICE - 1, Math.max(0, y - PAD));
                const s = (l * SLICE + j) * SLICE;
                const o = (py0 + y) * M80_W + px0;
                for (let x = 0; x < PITCH; x++) out[o + x] = b[s + Math.min(SLICE - 1, Math.max(0, x - PAD))];
            }
        }
        return out;
    }

    function unmosaic80(img) {
        const out = new Uint8Array(SLICE * SLICE * SLICE);
        for (let l = 0; l < SLICE; l++) {
            const px0 = (l % COLS) * PITCH + PAD, py0 = Math.floor(l / COLS) * PITCH + PAD;
            for (let j = 0; j < SLICE; j++) {
                const s = (py0 + j) * M80_W + px0;
                out.set(img.subarray(s, s + SLICE), (l * SLICE + j) * SLICE);
            }
        }
        return out;
    }

    /** τ ∈ 0..12 minimising the interior's squared error once decoded values ≤ τ are 0 (smallest on a tie). */
    function deadZone(src, dec) {
        const cnt = new Float64Array(256), s1 = new Float64Array(256);
        let sse = 0;
        for (let l = APRON; l < APRON + BRICK; l++) {
            for (let j = APRON; j < APRON + BRICK; j++) {
                const o = (l * SLICE + j) * SLICE;
                for (let i = o + APRON; i < o + APRON + BRICK; i++) {
                    const d = dec[i], s = src[i];
                    sse += (d - s) * (d - s);
                    cnt[d]++;
                    s1[d] += s;
                }
            }
        }
        let best = 0, bestSse = sse;
        for (let tau = 1; tau <= DEAD_ZONE_MAX; tau++) {
            // A decoded value τ set to 0: (0 − s)² replaces (τ − s)², a change of 2τ·s − τ².
            if (cnt[tau]) sse += 2 * tau * s1[tau] - cnt[tau] * tau * tau;
            if (sse < bestSse) { best = tau; bestSse = sse; }
        }
        return best;
    }

    // ── WebP ──────────────────────────────────────────────────────────────────────

    /** { width, height, lossless } of a still WebP (VP8 or VP8L, with or without VP8X), else null. */
    function webpSize(b) {
        const n = b.length;
        if (n < 20) return null;
        const tag = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
        const u32 = (o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
        if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP' || u32(4) + 8 !== n) return null;
        for (let pos = 12; pos < n;) {
            if (pos + 8 > n) return null;
            const kind = tag(pos), size = u32(pos + 4), at = pos + 8;
            if (at + size > n) return null;
            if (kind === 'VP8L') {
                if (size < 5 || b[at] !== 0x2F) return null;
                const bits = u32(at + 1);
                return { width: (bits & 0x3FFF) + 1, height: ((bits >>> 14) & 0x3FFF) + 1, lossless: true };
            }
            if (kind === 'VP8 ') {
                if (size < 10 || b[at + 3] !== 0x9D || b[at + 4] !== 0x01 || b[at + 5] !== 0x2A) return null;
                return { width: (b[at + 6] | (b[at + 7] << 8)) & 0x3FFF, height: (b[at + 8] | (b[at + 9] << 8)) & 0x3FFF, lossless: false };
            }
            if (kind === 'ANIM' || kind === 'ANMF') return null;
            pos = at + size + (size & 1);
        }
        return null;
    }

    const _canvases = new Map();
    function canvasOf(w, h) {
        const key = w + 'x' + h;
        let c = _canvases.get(key);
        if (!c) {
            const canvas = new OffscreenCanvas(w, h);
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.globalCompositeOperation = 'copy';
            c = { canvas, ctx };
            _canvases.set(key, c);
        }
        return c;
    }

    /** A greyscale picture as WebP: lossless (quality 1 in Chromium), or lossy at `quality` (0–100). */
    async function encodeWebp(grey, w, h, quality) {
        const lossless = quality === undefined;
        const rgba = new Uint8ClampedArray(w * h * 4);
        for (let i = 0, p = 0; i < grey.length; i++, p += 4) {
            const v = grey[i];
            rgba[p] = v; rgba[p + 1] = v; rgba[p + 2] = v; rgba[p + 3] = 255;
        }
        const { canvas, ctx } = canvasOf(w, h);
        ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
        const blob = await canvas.convertToBlob({ type: 'image/webp', quality: lossless ? 1 : quality / 100 });
        if (!blob || blob.type !== 'image/webp') throw fail('no_webp_encode', 'this browser does not encode WebP');
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const size = webpSize(bytes);
        if (!size || size.width !== w || size.height !== h || size.lossless !== lossless) {
            throw fail(lossless ? 'no_webp_lossless_encode' : 'no_webp_lossy_encode', `this browser did not encode a ${lossless ? 'lossless' : 'lossy'} WebP of ${w}×${h}`);
        }
        return bytes;
    }

    /** The first component of a decoded WebP, { width, height, data }. */
    async function decodeWebp(bytes) {
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        try {
            const { ctx } = canvasOf(bmp.width, bmp.height);
            ctx.drawImage(bmp, 0, 0);
            const rgba = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
            const data = new Uint8Array(bmp.width * bmp.height);
            for (let i = 0, p = 0; i < data.length; i++, p += 4) data[i] = rgba[p];
            return { width: bmp.width, height: bmp.height, data };
        } finally {
            if (typeof bmp.close === 'function') bmp.close();
        }
    }

    function concat(parts) {
        let n = 0;
        for (const p of parts) n += p.length;
        const out = new Uint8Array(n);
        let o = 0;
        for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
    }

    function withByte(bytes, tag) {
        const out = new Uint8Array(bytes.length + 1);
        out.set(bytes);
        out[bytes.length] = tag;
        return out;
    }

    /** The stored image of one brick channel in column `cid` (format5.py:encode_brick). */
    async function encodeBrick(b66, cid, known) {
        const col = column(cid);
        if (col.codec === 'webp-lossless') return encodeWebp(mosaic66(b66), M66_W, M66_H);
        if (col.codec === 'webp-lossless-lut') {
            const q = QUANT[col.maxError];
            const idx = new Uint8Array(b66.length);
            for (let i = 0; i < b66.length; i++) idx[i] = q[b66[i]];
            return encodeWebp(mosaic66(idx), M66_W, M66_H);
        }
        const data = await encodeWebp(mosaic80(b66), M80_W, M80_H, col.quality);
        const dec = await decodeWebp(data);
        if (dec.width !== M80_W || dec.height !== M80_H) throw fail('brick_undecodable', 'lossy brick decoded at the wrong size');
        let best = withByte(data, deadZone(b66, unmosaic80(dec.data)));
        for (const [tag, other] of [[TAG_LL, 'll'], [TAG_B4, 'b4']]) {
            let alt = known[other];
            if (!alt) alt = known[other] = await encodeBrick(b66, other, known);
            if (alt.length + 1 <= best.length) best = withByte(alt, tag);
        }
        return best;
    }

    /** { column: bytes } of one kept brick; the faithful columns first (a lossy one compares itself with them). */
    async function encodeBrickColumns(b66, columns, known) {
        known = Object.assign({}, known || {});
        const order = columns.slice().sort((a, b) => Number(isLossy(a)) - Number(isLossy(b)));
        const out = {};
        for (const cid of order) {
            out[cid] = known[cid] || await encodeBrick(b66, cid, known);
            known[cid] = out[cid];
        }
        return out;
    }

    /** Stage-B body (dataset_migrations.py:_m005_brick_blob): bricks in (bz, by, bx) order. */
    function brickBlob(bricks, columns) {
        const keys = bricks.slice().sort((a, b) => a.bz - b.bz || a.by - b.by || a.bx - b.bx);
        const n = keys.length;
        const head = new Uint8Array(4 + 12 * n + 4 * n * columns.length);
        const dv = new DataView(head.buffer);
        dv.setUint32(0, n, true);
        keys.forEach((b, i) => {
            dv.setUint32(4 + 12 * i, b.bz, true);
            dv.setUint32(8 + 12 * i, b.by, true);
            dv.setUint32(12 + 12 * i, b.bx, true);
        });
        let o = 4 + 12 * n;
        for (const cid of columns) for (const b of keys) { dv.setUint32(o, b.enc[cid].length, true); o += 4; }
        const parts = [head];
        for (const cid of columns) for (const b of keys) parts.push(b.enc[cid]);
        return concat(parts);
    }

    // ── Planes and orthogonal packs ───────────────────────────────────────────────

    /** png-gray8 tiles (filter None) of a W × H plane, row-major (ty, tx); null = all zero. */
    async function planeTiles(plane, W, H) {
        const out = [];
        for (let ty = 0; ty < Math.ceil(H / TILE); ty++) {
            for (let tx = 0; tx < Math.ceil(W / TILE); tx++) {
                const w = Math.min(TILE, W - tx * TILE), h = Math.min(TILE, H - ty * TILE);
                const t = new Uint8Array(w * h);
                let any = false;
                for (let y = 0; y < h; y++) {
                    const s = (ty * TILE + y) * W + tx * TILE;
                    const row = plane.subarray(s, s + w);
                    t.set(row, y * w);
                    if (!any) for (let x = 0; x < w; x++) if (row[x]) { any = true; break; }
                }
                out.push(any ? await PlaneCodec.encodePngGray(w, h, t) : null);
            }
        }
        return out;
    }

    /** One LPLN pack (SPEC §3.2), single channel: header, entries (u64 offset, u32 length), tiles. */
    function planePack(z, tilesX, tilesY, tiles) {
        const n = tilesX * tilesY;
        const head = new Uint8Array(PLANE_HEADER + PLANE_ENTRY * n);
        const dv = new DataView(head.buffer);
        for (let i = 0; i < 4; i++) head[i] = 'LPLN'.charCodeAt(i);
        dv.setUint16(4, 1, true);
        dv.setUint16(6, 1, true);
        dv.setUint16(8, tilesX, true);
        dv.setUint16(10, tilesY, true);
        dv.setUint32(12, z >>> 0, true);
        let offset = head.length;
        tiles.forEach((t, i) => {
            const len = t ? t.length : 0;
            dv.setBigUint64(PLANE_HEADER + PLANE_ENTRY * i, BigInt(len ? offset : 0), true);
            dv.setUint32(PLANE_HEADER + PLANE_ENTRY * i + 8, len, true);
            offset += len;
        });
        return concat([head, ...tiles.filter(Boolean)]);
    }

    /**
     * One xz / yz pack (format5.py:orth_pack): images[r] is Z × A (row-major, z then a),
     * tiled ≤ 512 along a × ≤ 512 along z; entries in order (row, tz, ta).
     */
    async function orthPack(kind, first, images, Z, A) {
        const ta = Math.ceil(A / TILE), tz = Math.ceil(Z / TILE);
        const n = images.length * ta * tz;
        const head = new Uint8Array(ORTH_HEADER + ORTH_ENTRY * n);
        const dv = new DataView(head.buffer);
        for (let i = 0; i < 4; i++) head[i] = ORTH_MAGIC[kind].charCodeAt(i);
        dv.setUint16(4, 1, true);
        dv.setUint16(6, ta, true);
        dv.setUint16(8, tz, true);
        dv.setUint16(10, 0, true);
        dv.setUint32(12, first >>> 0, true);
        dv.setUint32(16, images.length, true);
        let offset = head.length, e = 0;
        const payloads = [];
        for (const im of images) {
            for (let iz = 0; iz < tz; iz++) {
                for (let ia = 0; ia < ta; ia++, e++) {
                    const w = Math.min(TILE, A - ia * TILE), h = Math.min(TILE, Z - iz * TILE);
                    const t = new Uint8Array(w * h);
                    let any = false;
                    for (let y = 0; y < h; y++) {
                        const s = (iz * TILE + y) * A + ia * TILE;
                        const row = im.subarray(s, s + w);
                        t.set(row, y * w);
                        if (!any) for (let x = 0; x < w; x++) if (row[x]) { any = true; break; }
                    }
                    const data = any ? await PlaneCodec.encodePngGray(w, h, t) : null;
                    const len = data ? data.length : 0;
                    dv.setBigUint64(ORTH_HEADER + ORTH_ENTRY * e, BigInt(len ? offset : 0), true);
                    dv.setUint32(ORTH_HEADER + ORTH_ENTRY * e + 8, len, true);
                    offset += len;
                    if (data) payloads.push(data);
                }
            }
        }
        return concat([head, ...payloads]);
    }

    // ── Cut bricks (SPEC §14.5) ───────────────────────────────────────────────────

    /** (height, width) of a cut brick's mosaic: bz slices of 32², min(bz, 8) per row. */
    function cutMosaicShape(bz) {
        const cols = Math.min(bz, 8);
        return { h: CUT_XY * Math.ceil(bz / cols), w: CUT_XY * cols, cols };
    }

    /**
     * The record of cut super-block (sz, sy, sx) (format5.py:cut_record), or null when every
     * brick is zero: 512 × { u32 offset from the record's start, u32 length } in (bz, by, bx)
     * order, then the lossless WebP mosaics.
     */
    async function cutRecord(region, rw, rh, origin, dims, bz, sz, sy, sx) {
        const { h: mh, w: mw, cols } = cutMosaicShape(bz);
        const head = new Uint8Array(CUT_RECORD_HEAD);
        const dv = new DataView(head.buffer);
        const payloads = [];
        let offset = CUT_RECORD_HEAD, e = 0, kept = false;
        for (let lz = 0; lz < CUT_SUPER; lz++) {
            for (let ly = 0; ly < CUT_SUPER; ly++) {
                for (let lx = 0; lx < CUT_SUPER; lx++, e++) {
                    const z0 = (sz * CUT_SUPER + lz) * bz, y0 = (sy * CUT_SUPER + ly) * CUT_XY, x0 = (sx * CUT_SUPER + lx) * CUT_XY;
                    let data = null;
                    if (z0 < dims.z && y0 < dims.y && x0 < dims.x) {
                        const z1 = Math.min(dims.z, z0 + bz), y1 = Math.min(dims.y, y0 + CUT_XY), x1 = Math.min(dims.x, x0 + CUT_XY);
                        const img = new Uint8Array(mw * mh);
                        let any = false;
                        for (let z = z0; z < z1; z++) {
                            const s = z - z0;
                            const px0 = (s % cols) * CUT_XY, py0 = Math.floor(s / cols) * CUT_XY;
                            for (let y = y0; y < y1; y++) {
                                const src = ((z - origin.z) * rh + (y - origin.y)) * rw + (x0 - origin.x);
                                const row = region.subarray(src, src + (x1 - x0));
                                img.set(row, (py0 + y - y0) * mw + px0);
                                if (!any) for (let x = 0; x < row.length; x++) if (row[x]) { any = true; break; }
                            }
                        }
                        if (any) { data = await encodeWebp(img, mw, mh); kept = true; }
                    }
                    const len = data ? data.length : 0;
                    dv.setUint32(8 * e, len ? offset : 0, true);
                    dv.setUint32(8 * e + 4, len, true);
                    offset += len;
                    if (data) payloads.push(data);
                }
            }
        }
        return kept ? concat([head, ...payloads]) : null;
    }

    // ── Reads ─────────────────────────────────────────────────────────────────────

    const _tileCache = new Map();   // `${rel}|${start}|${end}` → Uint8Array, insertion = LRU order
    let _tileCacheBytes = 0;

    /** The bytes of [{ rel, start, end }] through read_ranges; runs for which cacheable(i) are kept across units. */
    async function readRuns(io, runs, cacheable) {
        if (typeof io.readRels !== 'function') throw fail('no_read_ranges', 'this worker cannot read by path');
        const out = new Array(runs.length);
        const missing = [];
        runs.forEach((r, i) => {
            const key = `${r.rel}|${r.start}|${r.end}`;
            const hit = cacheable(i) ? _tileCache.get(key) : undefined;
            if (hit) {
                _tileCache.delete(key);
                _tileCache.set(key, hit);
                out[i] = hit;
            } else missing.push(i);
        });
        let bytesIn = 0;
        if (missing.length) {
            const got = await io.readRels(missing.map((i) => ({ rel: runs[i].rel, start: runs[i].start, end: runs[i].end })));
            missing.forEach((i, n) => {
                const b = got[n];
                if (!b || b.length !== runs[i].end - runs[i].start) throw fail('short_read', 'read_ranges answered a short run', false);
                out[i] = b;
                bytesIn += b.length;
                if (cacheable(i) && b.length <= TILE_CACHE_BYTES / 8) {
                    // Own copy: the run is a view into the whole answer of its batch.
                    _tileCache.set(`${runs[i].rel}|${runs[i].start}|${runs[i].end}`, b.slice());
                    _tileCacheBytes += b.length;
                }
            });
            for (const [k, v] of _tileCache) {
                if (_tileCacheBytes <= TILE_CACHE_BYTES) break;
                _tileCache.delete(k);
                _tileCacheBytes -= v.length;
            }
        }
        return { data: out, bytesIn };
    }

    /** The unit's box of level voxels, z-major, from its png-gray8 tiles (absent = 0). */
    async function regionFromTiles(inp, tiles, data, io) {
        const [x0, x1] = inp.box.x, [y0, y1] = inp.box.y, [z0, z1] = inp.box.z;
        const rw = x1 - x0, rh = y1 - y0;
        const region = new Uint8Array(rw * rh * (z1 - z0));
        for (let n = 0; n < tiles.length; n++) {
            aborted(io);
            const t = tiles[n];
            const img = await PlaneCodec.decodePngGray(data[n]);
            if (img.width !== t.w || img.height !== t.h) throw fail('tile_undecodable', `tile of plane ${t.z} is ${img.width}×${img.height}`);
            const a0 = Math.max(y0, t.y0), a1 = Math.min(y1, t.y0 + t.h);
            const b0 = Math.max(x0, t.x0), b1 = Math.min(x1, t.x0 + t.w);
            if (a0 >= a1 || b0 >= b1) continue;
            const base = (t.z - z0) * rh * rw;
            for (let y = a0; y < a1; y++) {
                const s = (y - t.y0) * t.w + (b0 - t.x0);
                region.set(img.data.subarray(s, s + (b1 - b0)), base + (y - y0) * rw + (b0 - x0));
            }
        }
        return { region, rw, rh, origin: { x: x0, y: y0, z: z0 } };
    }

    // ── Handler ───────────────────────────────────────────────────────────────────

    async function prepare() { return { id: ID }; }

    // The server lists the units and orders the waves (a later level waits for stage A).
    function listUnits() { return []; }

    async function planUnitWork(key, state, io) {
        if (!io || typeof io.unitInputs !== 'function') throw fail('no_unit_inputs', 'this worker cannot ask the server for unit inputs');
        const inp = await io.unitInputs();
        if (!inp || inp.unit !== key) throw fail('bad_unit_inputs', 'unit_inputs answered another unit');
        return inp;
    }

    async function runUnit(inp, state, io) {
        if (inp.empty) throw fail('empty_unit', 'the server lists no work for ' + inp.unit);
        const L = inp.levels[inp.level].dimensions;
        const tiles = inp.tiles || [], bricks = inp.bricks || [];
        // Tiles of a later stage are cached (neighbouring units read the same ones); a native
        // plane of stage A and the format-4 bricks are read once.
        const read = await readRuns(io, tiles.concat(bricks), (i) => inp.stage !== 'A' && i < tiles.length);
        const tdata = read.data.slice(0, tiles.length), bdata = read.data.slice(tiles.length);
        const done = (body, count) => ({ body, bytesIn: read.bytesIn, tiles: count });

        if (inp.stage === 'A') {
            const { region } = await regionFromTiles(inp, tiles, tdata, io);
            const W0 = L.x, H0 = L.y;
            const packs = [];
            for (const row of inp.levels.slice(1)) {
                aborted(io);
                const d = row.dimensions;
                const p = resamplePlane(region, W0, H0, d.x, d.y);
                let any = false;
                for (let i = 0; i < p.length; i++) if (p[i]) { any = true; break; }
                const pack = any ? planePack(inp.box.z[0], Math.ceil(d.x / TILE), Math.ceil(d.y / TILE), await planeTiles(p, d.x, d.y)) : new Uint8Array(0);
                packs.push({ k: row.level, pack });
            }
            packs.sort((a, b) => a.k - b.k);
            const head = new Uint8Array(4 + 8 * packs.length);
            const dv = new DataView(head.buffer);
            dv.setUint32(0, packs.length, true);
            packs.forEach((p, i) => { dv.setUint32(4 + 8 * i, p.k, true); dv.setUint32(8 + 8 * i, p.pack.length, true); });
            return done(concat([head, ...packs.map((p) => p.pack)]), packs.filter((p) => p.pack.length).length);
        }

        if (inp.stage === 'B') {
            const cols = inp.columns;
            const out = [];
            if (inp.level === 0) {
                for (let n = 0; n < bricks.length; n++) {
                    aborted(io);
                    const r = bricks[n];
                    const img = await decodeWebp(bdata[n]);
                    if (img.width !== M66_W || img.height !== M66_H) throw fail('brick_undecodable', `format-4 brick is ${img.width}×${img.height}`);
                    out.push({ bz: r.bz, by: r.by, bx: r.bx, enc: await encodeBrickColumns(unmosaic66(img.data), cols, { ll: bdata[n] }) });
                }
            } else {
                const { region, rw, rh, origin } = await regionFromTiles(inp, tiles, tdata, io);
                for (const [bz, by, bx] of inp.outBricks) {
                    aborted(io);
                    const b66 = brickWithApron(region, rw, rh, origin, L, bx, by, bz);
                    if (brickKept(b66)) out.push({ bz, by, bx, enc: await encodeBrickColumns(b66, cols) });
                }
            }
            return done(out.length ? brickBlob(out, cols) : new Uint8Array(0), out.length);
        }

        const { region, rw, rh, origin } = await regionFromTiles(inp, tiles, tdata, io);
        if (inp.stage === 'C') {
            const Z = L.z;
            const images = [];
            for (let r = 0; r < inp.count; r++) {
                if (inp.kind === 'xz') {
                    const im = new Uint8Array(Z * rw);
                    for (let z = 0; z < Z; z++) im.set(region.subarray((z * rh + r) * rw, (z * rh + r) * rw + rw), z * rw);
                    images.push(im);
                } else {
                    const im = new Uint8Array(Z * rh);
                    for (let z = 0; z < Z; z++) for (let y = 0; y < rh; y++) im[z * rh + y] = region[(z * rh + y) * rw + r];
                    images.push(im);
                }
            }
            const A = inp.kind === 'xz' ? rw : rh;
            return done(await orthPack(inp.kind, inp.first, images, Z, A), images.length);
        }
        if (inp.stage === 'D') {
            const [sz, sy, sx] = inp.super;
            const rec = await cutRecord(region, rw, rh, origin, L, inp.brickZ, sz, sy, sx);
            return done(rec || new Uint8Array(0), rec ? 1 : 0);
        }
        throw fail('bad_unit_inputs', 'unknown stage ' + inp.stage);
    }

    /**
     * The browser executor needs WebP lossless encoding exact to the byte value, WebP lossy
     * encoding (VP8, the right size) and CompressionStream (png-gray8 tiles).
     */
    async function probe() {
        const reasons = [];
        if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined' || typeof ImageData === 'undefined') {
            return { available: false, reasons: ['no_webp_lossless_encode'] };
        }
        if (typeof CompressionStream === 'undefined') reasons.push('no_compression_stream');
        try {
            const img = new Uint8Array(M66_W * M66_H);
            let seed = 0x9e3779b9;
            for (let i = 0; i < img.length; i++) {
                seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
                const y = Math.floor(i / M66_W);
                img[i] = y < 66 ? i % 256 : y < 330 ? (seed >>> 13) & 0xFF : y < 462 ? ((i >> 7) & 1) * 37 : 0;
            }
            const d = await decodeWebp(await encodeWebp(img, M66_W, M66_H));
            if (d.width !== M66_W || d.height !== M66_H || d.data.some((v, i) => v !== img[i])) reasons.push('no_webp_lossless_encode');
        } catch (_) {
            reasons.push('no_webp_lossless_encode');
        }
        try {
            await encodeWebp(new Uint8Array(M80_W * M80_H).fill(90), M80_W, M80_H, 80);
        } catch (_) {
            reasons.push('no_webp_lossy_encode');
        }
        return { available: !reasons.length, reasons };
    }

    const handler = {
        id: ID,
        // A unit holds at most one native plane band (an XZ unit: X × 64 × Z voxels).
        slotsPerWorker: 1,
        // Units per batch (worker run_batch): one unit_inputs_many, the shared runs read once,
        // one unit_put_many per 16 MiB of results — most of a small unit was its three requests.
        batchUnits: 16,
        prepare, listUnits, planUnitWork, runUnit, probe,
        _internals: {
            quantizerIndex, axisWeights, resamplePlane, apronIndex, brickWithApron, brickKept, mosaic66, unmosaic66,
            mosaic80, unmosaic80, deadZone, webpSize, encodeBrick, encodeBrickColumns, brickBlob, planeTiles, planePack,
            orthPack, cutMosaicShape, cutRecord, regionFromTiles, readRuns,
            _clearTileCache: () => { _tileCache.clear(); _tileCacheBytes = 0; },
        },
    };
    root.LumenMigrationHandlers = root.LumenMigrationHandlers || {};
    root.LumenMigrationHandlers[ID] = handler;
})(typeof self !== 'undefined' ? self : globalThis);
