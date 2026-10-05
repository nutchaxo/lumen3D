/**
 * PlaneCodec — the byte formats of a format-2 `planes/` tree (DOCS/dataset-migrations/SPEC.md §3).
 *
 *  - png-gray8 tiles: a standard PNG, colour type 0, bit depth 8, no ancillary chunk, so a
 *    browser decodes the bytes verbatim (no colour management). The encoder uses filter 0
 *    (None) on every row, like the Python, PHP and pipeline encoders: on shot-noise-dominated
 *    microscopy planes it is 40–80 % smaller than Sub and costs nothing to compute. The zlib
 *    stream is CompressionStream('deflate') (RFC 1950, which is exactly what IDAT carries).
 *    The decoder accepts all five filter types.
 *  - plane packs `zNNNNN.bin`: 16-byte header "LPLN" + C·TY·TX entries {u64 offset, u32 length},
 *    little-endian, c-major then ty then tx; length 0 = an all-zero tile without payload.
 *    A format-3 layer-MIP pack `mips/lNNNNN.bin` (SPEC §12) has the same layout with the
 *    magic "LMIP" and the layer index in the `z` field.
 *
 * Classic script, usable from a window and from a worker (importScripts). No DOM.
 */
const PlaneCodec = (() => {
    'use strict';

    const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const PACK_MAGIC = 'LPLN';
    const MIPS_MAGIC = 'LMIP';
    const PACK_MAGICS = [PACK_MAGIC, MIPS_MAGIC];
    const PACK_VERSION = 1;
    const PACK_FIXED_BYTES = 16;
    const PACK_ENTRY_BYTES = 12;

    // CRC-32 (ISO-HDLC, reflected polynomial 0xEDB88320) as PNG §5.5 requires over type+data.
    const CRC_TABLE = (() => {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c >>> 0;
        }
        return t;
    })();

    function crc32(bytes, start, end) {
        let c = 0xFFFFFFFF;
        for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    function _concat(parts, total) {
        if (total === undefined) total = parts.reduce((s, p) => s + p.length, 0);
        const out = new Uint8Array(total);
        let o = 0;
        for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
    }

    async function _streamThrough(bytes, transform) {
        const stream = new Blob([bytes]).stream().pipeThrough(transform);
        const reader = stream.getReader();
        const parts = [];
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(value);
            total += value.length;
        }
        return _concat(parts, total);
    }

    function _chunk(type, data) {
        const out = new Uint8Array(12 + data.length);
        const dv = new DataView(out.buffer);
        dv.setUint32(0, data.length);
        for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
        out.set(data, 8);
        dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
        return out;
    }

    /** Filter Sub on every row: Raw(x) − Raw(x − 1), bpp = 1 (one greyscale byte per pixel). */
    function filterSub(width, height, data) {
        const stride = width + 1;
        const out = new Uint8Array(stride * height);
        for (let y = 0; y < height; y++) {
            const r = y * width;
            const o = y * stride;
            out[o] = 1;
            let prev = 0;
            for (let x = 0; x < width; x++) {
                const v = data[r + x];
                out[o + 1 + x] = (v - prev) & 0xFF;
                prev = v;
            }
        }
        return out;
    }

    /** Filter None on every row: a 0 filter-type byte before each row's raw bytes. */
    function filterNone(width, height, data) {
        const stride = width + 1;
        const out = new Uint8Array(stride * height);
        for (let y = 0; y < height; y++) out.set(data.subarray(y * width, (y + 1) * width), y * stride + 1);
        return out;
    }

    async function encodePngGray(width, height, data) {
        if (!(width > 0 && height > 0) || width !== (width | 0) || height !== (height | 0)) {
            throw new Error('PlaneCodec.encodePngGray: invalid size');
        }
        if (!data || data.length !== width * height) {
            throw new Error('PlaneCodec.encodePngGray: data length ≠ width·height');
        }
        if (typeof CompressionStream === 'undefined') throw new Error('PlaneCodec: CompressionStream unavailable');
        const ihdr = new Uint8Array(13);
        const dv = new DataView(ihdr.buffer);
        dv.setUint32(0, width);
        dv.setUint32(4, height);
        ihdr[8] = 8;  // bit depth
        ihdr[9] = 0;  // colour type: greyscale
        ihdr[10] = 0; // compression: deflate
        ihdr[11] = 0; // filter method 0
        ihdr[12] = 0; // no interlace
        const px = data instanceof Uint8Array ? data : Uint8Array.from(data);
        const zlib = await _streamThrough(filterNone(width, height, px), new CompressionStream('deflate'));
        return _concat([PNG_SIGNATURE, _chunk('IHDR', ihdr), _chunk('IDAT', zlib), _chunk('IEND', new Uint8Array(0))]);
    }

    /** Reads the IHDR without inflating: { width, height, bitDepth, colorType, interlace } or null. */
    function readPngHeader(bytes) {
        bytes = _u8(bytes);
        if (bytes.length < 33) return null;
        for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return null;
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (dv.getUint32(8) !== 13 || String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== 'IHDR') return null;
        return {
            width: dv.getUint32(16),
            height: dv.getUint32(20),
            bitDepth: bytes[24],
            colorType: bytes[25],
            compression: bytes[26],
            filter: bytes[27],
            interlace: bytes[28],
        };
    }

    function _paeth(a, b, c) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        if (pa <= pb && pa <= pc) return a;
        if (pb <= pc) return b;
        return c;
    }

    async function decodePngGray(bytes) {
        bytes = _u8(bytes);
        const h = readPngHeader(bytes);
        if (!h) throw new Error('PlaneCodec.decodePngGray: not a PNG');
        if (h.bitDepth !== 8 || h.colorType !== 0 || h.compression !== 0 || h.filter !== 0 || h.interlace !== 0) {
            throw new Error('PlaneCodec.decodePngGray: only 8-bit greyscale, non-interlaced PNG is supported');
        }
        if (typeof DecompressionStream === 'undefined') throw new Error('PlaneCodec: DecompressionStream unavailable');
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const idat = [];
        let pos = 8;
        let sawEnd = false;
        while (pos + 12 <= bytes.length) {
            const len = dv.getUint32(pos);
            const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
            const dataEnd = pos + 8 + len;
            if (dataEnd + 4 > bytes.length) throw new Error('PlaneCodec.decodePngGray: truncated chunk ' + type);
            if (crc32(bytes, pos + 4, dataEnd) !== dv.getUint32(dataEnd)) {
                throw new Error('PlaneCodec.decodePngGray: CRC mismatch in ' + type);
            }
            if (type === 'IDAT') idat.push(bytes.subarray(pos + 8, dataEnd));
            if (type === 'IEND') { sawEnd = true; break; }
            pos = dataEnd + 4;
        }
        if (!sawEnd || !idat.length) throw new Error('PlaneCodec.decodePngGray: missing IDAT/IEND');
        const { width, height } = h;
        const raw = await _streamThrough(_concat(idat), new DecompressionStream('deflate'));
        const stride = width + 1;
        if (raw.length < stride * height) throw new Error('PlaneCodec.decodePngGray: short image data');
        const out = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) {
            const ft = raw[y * stride];
            const src = y * stride + 1;
            const o = y * width;
            const up = o - width; // previous reconstructed row (y > 0)
            for (let x = 0; x < width; x++) {
                const v = raw[src + x];
                const a = x > 0 ? out[o + x - 1] : 0;
                const b = y > 0 ? out[up + x] : 0;
                const c = (x > 0 && y > 0) ? out[up + x - 1] : 0;
                let r;
                switch (ft) {
                    case 0: r = v; break;
                    case 1: r = v + a; break;
                    case 2: r = v + b; break;
                    case 3: r = v + ((a + b) >> 1); break;
                    case 4: r = v + _paeth(a, b, c); break;
                    default: throw new Error('PlaneCodec.decodePngGray: bad filter type ' + ft);
                }
                out[o + x] = r & 0xFF;
            }
        }
        return { width, height, data: out };
    }

    function _u8(x) {
        if (x instanceof Uint8Array) return x;
        // Tag test rather than instanceof: a buffer from another realm (worker transfer, vm) qualifies.
        if (Object.prototype.toString.call(x) === '[object ArrayBuffer]') return new Uint8Array(x);
        if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
        throw new Error('PlaneCodec: expected bytes');
    }

    function headerBytes(channels, tilesX, tilesY) {
        return PACK_FIXED_BYTES + PACK_ENTRY_BYTES * channels * tilesY * tilesX;
    }

    function tileIndex(c, ty, tx, tilesX, tilesY) {
        return (c * tilesY + ty) * tilesX + tx;
    }

    function buildPackHeader({ channels, tilesX, tilesY, z, entries, magic }) {
        magic = magic === undefined ? PACK_MAGIC : magic;
        if (!PACK_MAGICS.includes(magic)) throw new Error('PlaneCodec.buildPackHeader: unknown magic');
        const n = channels * tilesX * tilesY;
        if (!Array.isArray(entries) || entries.length !== n) throw new Error('PlaneCodec.buildPackHeader: need C·TY·TX entries');
        for (const v of [channels, tilesX, tilesY]) {
            if (!(v >= 1 && v <= 0xFFFF) || v !== (v | 0)) throw new Error('PlaneCodec.buildPackHeader: bad count');
        }
        const out = new Uint8Array(headerBytes(channels, tilesX, tilesY));
        const dv = new DataView(out.buffer);
        for (let i = 0; i < 4; i++) out[i] = magic.charCodeAt(i);
        dv.setUint16(4, PACK_VERSION, true);
        dv.setUint16(6, channels, true);
        dv.setUint16(8, tilesX, true);
        dv.setUint16(10, tilesY, true);
        dv.setUint32(12, z >>> 0, true);
        for (let i = 0; i < n; i++) {
            const e = entries[i] || { offset: 0, length: 0 };
            const p = PACK_FIXED_BYTES + i * PACK_ENTRY_BYTES;
            dv.setBigUint64(p, BigInt(e.length ? e.offset : 0), true);
            dv.setUint32(p + 8, e.length >>> 0, true);
        }
        return out;
    }

    /**
     * `expectMagic` (optional): 'LPLN' or 'LMIP' — a plane pack read where a MIP pack is
     * expected (or the reverse) is refused; without it either magic is accepted.
     */
    function parsePackHeader(bytes, expectMagic) {
        bytes = _u8(bytes);
        if (bytes.length < PACK_FIXED_BYTES) throw new Error('PlaneCodec.parsePackHeader: short header');
        const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
        if (!PACK_MAGICS.includes(magic) || (expectMagic !== undefined && magic !== expectMagic)) {
            throw new Error('PlaneCodec.parsePackHeader: bad magic');
        }
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const version = dv.getUint16(4, true);
        if (version !== PACK_VERSION) throw new Error('PlaneCodec.parsePackHeader: unsupported version ' + version);
        const channels = dv.getUint16(6, true);
        const tilesX = dv.getUint16(8, true);
        const tilesY = dv.getUint16(10, true);
        const z = dv.getUint32(12, true);
        const n = channels * tilesX * tilesY;
        if (bytes.length < headerBytes(channels, tilesX, tilesY)) throw new Error('PlaneCodec.parsePackHeader: short header');
        const entries = new Array(n);
        for (let i = 0; i < n; i++) {
            const p = PACK_FIXED_BYTES + i * PACK_ENTRY_BYTES;
            const off = dv.getBigUint64(p, true);
            if (off > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('PlaneCodec.parsePackHeader: offset out of range');
            entries[i] = { offset: Number(off), length: dv.getUint32(p + 8, true) };
        }
        return { magic, version, channels, tilesX, tilesY, z, entries };
    }

    /** SPEC §5.1 unit blob: u32 count, then count × { u32 z, u32 length, PNG bytes } (little-endian). */
    function buildUnitBlob(planes) {
        let total = 4;
        for (const p of planes) total += 8 + p.png.length;
        const out = new Uint8Array(total);
        const dv = new DataView(out.buffer);
        dv.setUint32(0, planes.length, true);
        let o = 4;
        for (const p of planes) {
            dv.setUint32(o, p.z >>> 0, true);
            dv.setUint32(o + 4, p.png.length, true);
            out.set(p.png, o + 8);
            o += 8 + p.png.length;
        }
        return out;
    }

    function parseUnitBlob(bytes) {
        bytes = _u8(bytes);
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (bytes.length < 4) throw new Error('PlaneCodec.parseUnitBlob: short blob');
        const count = dv.getUint32(0, true);
        const planes = [];
        let o = 4;
        for (let i = 0; i < count; i++) {
            if (o + 8 > bytes.length) throw new Error('PlaneCodec.parseUnitBlob: truncated');
            const z = dv.getUint32(o, true);
            const len = dv.getUint32(o + 4, true);
            if (o + 8 + len > bytes.length) throw new Error('PlaneCodec.parseUnitBlob: truncated');
            planes.push({ z, png: bytes.subarray(o + 8, o + 8 + len) });
            o += 8 + len;
        }
        if (o !== bytes.length) throw new Error('PlaneCodec.parseUnitBlob: trailing bytes');
        return planes;
    }

    const api = {
        PNG_SIGNATURE,
        PACK_MAGIC,
        MIPS_MAGIC,
        PACK_VERSION,
        crc32: (b) => { const u = _u8(b); return crc32(u, 0, u.length); },
        filterNone,
        filterSub,
        encodePngGray,
        decodePngGray,
        readPngHeader,
        headerBytes,
        tileIndex,
        buildPackHeader,
        parsePackHeader,
        buildUnitBlob,
        parseUnitBlob,
    };
    return api;
})();

if (typeof self !== 'undefined' && typeof self.PlaneCodec === 'undefined') {
    // Worker scopes reach a top-level const by bare name too; this keeps `self.PlaneCodec`
    // available for code that addresses the global explicitly (and for Node tests via vm).
    try { self.PlaneCodec = PlaneCodec; } catch (_) { /* frozen global */ }
}
