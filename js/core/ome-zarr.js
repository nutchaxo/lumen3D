/**
 * OmeZarr — the pieces of an OME-Zarr v0.5 store (OME-NGFF 0.5 on Zarr v3) and of the zip that
 * carries it (DOCS/dataset-migrations/SPEC.md §14.9). Pure: no DOM, no network; the window and the
 * export worker both load it.
 *
 * Store layout of one export, `<name>.ome.zarr/`:
 *   zarr.json                      group: attributes.ome = { version "0.5", multiscales, omero }
 *   <k>/zarr.json                  one array per exported level k (path = the level's index)
 *   <k>/c/<c>/<sz>/<sy>/<sx>       one shard file (chunk key encoding "default", separator "/")
 *
 * Arrays: shape [C, Z_k, Y_k, X_k], uint8, fill 0, axes c, z, y, x (z, y, x in micrometer, scale =
 * the level's voxel size). Codec `sharding_indexed`: shard 1 × 64 × 1024 × 1024, inner chunk
 * 1 × 64 × 64 × 64 — one inner chunk is exactly one 64³ brick of the level, so a shard is one brick
 * layer (bz) × 16 × 16 bricks of one channel; inner codecs `bytes` + `gzip`; the index (C-order over
 * the 1 × 1 × 16 × 16 inner grid, u64 LE offset + u64 LE length per chunk, both 2⁶⁴ − 1 for an
 * absent chunk) is stored at the end, followed by its crc32c (index codecs `bytes` + `crc32c`).
 * An inner chunk holds the level's voxels of its 64³ box, z-major (C order), 0 past the volume.
 *
 * gzip, not zstd: a browser can encode gzip (CompressionStream) and every OME-Zarr reader decodes it.
 */
const OmeZarr = (() => {
  const BRICK = 64;
  const SHARD_XY = 1024;
  const PER_SHARD = SHARD_XY / BRICK;          // 16 bricks per shard side in X and Y
  const CHUNKS_PER_SHARD = PER_SHARD * PER_SHARD;
  const NGFF_VERSION = '0.5';

  // ── CRC-32 (zip, poly 0xEDB88320) and CRC-32C (Castagnoli, poly 0x82F63B78) ─────────────

  function _table(poly) {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (poly ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  }
  const T32 = _table(0xEDB88320);
  const T32C = _table(0x82F63B78);

  function _crc(table, bytes, seed) {
    let c = (seed ^ 0xFFFFFFFF) >>> 0;
    for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  /** CRC-32 of `bytes`, continuing `seed` (the CRC of what came before; 0 to start). */
  const crc32 = (bytes, seed = 0) => _crc(T32, bytes, seed);
  const crc32c = (bytes, seed = 0) => _crc(T32C, bytes, seed);

  // ── Metadata ────────────────────────────────────────────────────────────────

  function _hexColor(c) {
    const s = String(c || '').trim().replace(/^#/, '');
    return /^[0-9a-fA-F]{6}$/.test(s) ? s.toUpperCase() : 'FFFFFF';
  }

  /** zarr.json of one level array. */
  function arrayMeta(channels, dims) {
    return {
      zarr_format: 3,
      node_type: 'array',
      shape: [channels, dims.z, dims.y, dims.x],
      data_type: 'uint8',
      chunk_grid: { name: 'regular', configuration: { chunk_shape: [1, BRICK, SHARD_XY, SHARD_XY] } },
      chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
      fill_value: 0,
      codecs: [{
        name: 'sharding_indexed',
        configuration: {
          chunk_shape: [1, BRICK, BRICK, BRICK],
          codecs: [{ name: 'bytes', configuration: { endian: 'little' } }, { name: 'gzip', configuration: { level: 6 } }],
          index_codecs: [{ name: 'bytes', configuration: { endian: 'little' } }, { name: 'crc32c' }],
          index_location: 'end'
        }
      }],
      dimension_names: ['c', 'z', 'y', 'x'],
      attributes: {}
    };
  }

  /**
   * zarr.json of the root group. levels: [{ level, voxelSize: {x, y, z} }] highest resolution
   * first; channels: [{ label, color, window: {start, end} }] for the exported channels.
   */
  function groupMeta({ name, levels, channels }) {
    return {
      zarr_format: 3,
      node_type: 'group',
      attributes: {
        ome: {
          version: NGFF_VERSION,
          multiscales: [{
            name: String(name || ''),
            axes: [
              { name: 'c', type: 'channel' },
              { name: 'z', type: 'space', unit: 'micrometer' },
              { name: 'y', type: 'space', unit: 'micrometer' },
              { name: 'x', type: 'space', unit: 'micrometer' }
            ],
            datasets: levels.map(L => ({
              path: String(L.level),
              coordinateTransformations: [{ type: 'scale', scale: [1, L.voxelSize.z, L.voxelSize.y, L.voxelSize.x] }]
            }))
          }],
          omero: {
            channels: channels.map(ch => ({
              label: String(ch.label || ''),
              color: _hexColor(ch.color),
              active: true,
              window: { min: 0, max: 255, start: ch.window ? ch.window.start : 0, end: ch.window ? ch.window.end : 255 }
            })),
            rdefs: { model: 'color' }
          }
        }
      }
    };
  }

  // ── Shards ──────────────────────────────────────────────────────────────────

  /** Shards of one level and channel: [{ sz, sy, sx, key, bricks: [{ bx, by, bz, slot }] }]. */
  function shardsOf(level, channel, grid) {
    const out = [];
    for (let bz = 0; bz < grid.z; bz++) {
      for (let sy = 0; sy * PER_SHARD < grid.y; sy++) {
        for (let sx = 0; sx * PER_SHARD < grid.x; sx++) {
          const bricks = [];
          for (let ly = 0; ly < PER_SHARD; ly++) {
            for (let lx = 0; lx < PER_SHARD; lx++) {
              const bx = sx * PER_SHARD + lx, by = sy * PER_SHARD + ly;
              if (bx < grid.x && by < grid.y) bricks.push({ bx, by, bz, slot: ly * PER_SHARD + lx });
            }
          }
          out.push({ level, channel, sz: bz, sy, sx, key: `${level}/c/${channel}/${bz}/${sy}/${sx}`, bricks });
        }
      }
    }
    return out;
  }

  /**
   * One shard file from its encoded inner chunks: chunks[slot] = Uint8Array or null (absent),
   * slot = ly · 16 + lx. Chunks in slot order, then the index and its crc32c.
   */
  function shardBytes(chunks) {
    let total = 0;
    for (const c of chunks) if (c) total += c.length;
    const out = new Uint8Array(total + CHUNKS_PER_SHARD * 16 + 4);
    const dv = new DataView(out.buffer);
    let at = 0;
    for (let i = 0; i < CHUNKS_PER_SHARD; i++) {
      const p = total + 16 * i;
      const c = chunks[i];
      if (c && c.length) {
        out.set(c, at);
        dv.setBigUint64(p, BigInt(at), true);
        dv.setBigUint64(p + 8, BigInt(c.length), true);
        at += c.length;
      } else {
        dv.setBigUint64(p, 0xFFFFFFFFFFFFFFFFn, true);
        dv.setBigUint64(p + 8, 0xFFFFFFFFFFFFFFFFn, true);
      }
    }
    dv.setUint32(total + CHUNKS_PER_SHARD * 16, crc32c(out.subarray(total, total + CHUNKS_PER_SHARD * 16)), true);
    return out;
  }

  /**
   * The 64³ inner chunk of a brick from its delivered interior: `data` covers `box` (brick-local
   * voxel bounds, end exclusive, the part inside the volume), the rest is 0.
   */
  function chunkFromBrick(data, box) {
    const out = new Uint8Array(BRICK * BRICK * BRICK);
    const w = box.x1 - box.x0, h = box.y1 - box.y0, d = box.z1 - box.z0;
    for (let z = 0; z < d; z++) {
      for (let y = 0; y < h; y++) {
        const s = (z * h + y) * w;
        out.set(data.subarray(s, s + w), ((box.z0 + z) * BRICK + box.y0 + y) * BRICK + box.x0);
      }
    }
    return out;
  }

  /** The brick-local box of brick (bx, by, bz) inside a level of `dims` (what the loader delivers). */
  function brickBox(bx, by, bz, dims) {
    return {
      x0: 0, x1: Math.min(BRICK, dims.x - bx * BRICK),
      y0: 0, y1: Math.min(BRICK, dims.y - by * BRICK),
      z0: 0, z1: Math.min(BRICK, dims.z - bz * BRICK)
    };
  }

  // ── Zip (STORED, ZIP64 when an offset or the entry count needs it) ───────────────

  const DOS_TIME = 0, DOS_DATE = (1 << 5) | 1;   // 1980-01-01 00:00: deterministic archives
  const MAX32 = 0xFFFFFFFF;

  class ZipWriter {
    constructor() { this.offset = 0; this.entries = []; }

    /** The parts to append for one file (local header, then the bytes). `crc` may be given. */
    add(name, bytes, crc = null) {
      const nameBytes = new TextEncoder().encode(name);
      const size = bytes.length;
      if (size >= MAX32) throw new Error('OmeZarr zip: an entry of 4 GiB or more');
      const c = crc === null ? crc32(bytes) : crc >>> 0;
      const head = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(head.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 45, true);
      dv.setUint16(6, 0x0800, true);              // UTF-8 names
      dv.setUint16(8, 0, true);                   // stored
      dv.setUint16(10, DOS_TIME, true);
      dv.setUint16(12, DOS_DATE, true);
      dv.setUint32(14, c, true);
      dv.setUint32(18, size, true);
      dv.setUint32(22, size, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      head.set(nameBytes, 30);
      this.entries.push({ nameBytes, size, crc: c, offset: this.offset });
      this.offset += head.length + size;
      return [head, bytes];
    }

    /** The central directory and the end records. */
    finish() {
      const parts = [];
      const cdStart = this.offset;
      let cdSize = 0;
      for (const e of this.entries) {
        const z64 = e.offset >= MAX32;
        const extra = z64 ? 12 : 0;
        const h = new Uint8Array(46 + e.nameBytes.length + extra);
        const dv = new DataView(h.buffer);
        dv.setUint32(0, 0x02014b50, true);
        dv.setUint16(4, 45, true);
        dv.setUint16(6, 45, true);
        dv.setUint16(8, 0x0800, true);
        dv.setUint16(10, 0, true);
        dv.setUint16(12, DOS_TIME, true);
        dv.setUint16(14, DOS_DATE, true);
        dv.setUint32(16, e.crc, true);
        dv.setUint32(20, e.size, true);
        dv.setUint32(24, e.size, true);
        dv.setUint16(28, e.nameBytes.length, true);
        dv.setUint16(30, extra, true);
        dv.setUint16(32, 0, true);
        dv.setUint16(34, 0, true);
        dv.setUint16(36, 0, true);
        dv.setUint32(38, 0, true);
        dv.setUint32(42, z64 ? MAX32 : e.offset, true);
        h.set(e.nameBytes, 46);
        if (z64) {
          const p = 46 + e.nameBytes.length;
          dv.setUint16(p, 0x0001, true);
          dv.setUint16(p + 2, 8, true);
          dv.setBigUint64(p + 4, BigInt(e.offset), true);
        }
        parts.push(h);
        cdSize += h.length;
      }
      const n = this.entries.length;
      const z64 = n >= 0xFFFF || cdStart >= MAX32 || cdSize >= MAX32;
      if (z64) {
        const rec = new Uint8Array(56 + 20);
        const dv = new DataView(rec.buffer);
        dv.setUint32(0, 0x06064b50, true);
        dv.setBigUint64(4, 44n, true);
        dv.setUint16(12, 45, true);
        dv.setUint16(14, 45, true);
        dv.setUint32(16, 0, true);
        dv.setUint32(20, 0, true);
        dv.setBigUint64(24, BigInt(n), true);
        dv.setBigUint64(32, BigInt(n), true);
        dv.setBigUint64(40, BigInt(cdSize), true);
        dv.setBigUint64(48, BigInt(cdStart), true);
        dv.setUint32(56, 0x07064b50, true);
        dv.setUint32(60, 0, true);
        dv.setBigUint64(64, BigInt(cdStart + cdSize), true);
        dv.setUint32(72, 1, true);
        parts.push(rec);
      }
      const end = new Uint8Array(22);
      const dv = new DataView(end.buffer);
      dv.setUint32(0, 0x06054b50, true);
      dv.setUint16(8, z64 ? 0xFFFF : n, true);
      dv.setUint16(10, z64 ? 0xFFFF : n, true);
      dv.setUint32(12, z64 ? MAX32 : cdSize, true);
      dv.setUint32(16, z64 ? MAX32 : cdStart, true);
      parts.push(end);
      return parts;
    }
  }

  const api = {
    BRICK, SHARD_XY, PER_SHARD, CHUNKS_PER_SHARD, NGFF_VERSION,
    crc32, crc32c, arrayMeta, groupMeta, shardsOf, shardBytes, chunkFromBrick, brickBox, ZipWriter
  };
  return api;
})();

if (typeof self !== 'undefined' && typeof self.OmeZarr === 'undefined') {
  // Worker scopes reach a top-level const by bare name too; this keeps `self.OmeZarr` working.
  try { self.OmeZarr = OmeZarr; } catch (_) { /* frozen global */ }
}
