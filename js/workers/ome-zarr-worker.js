/* ============================================================
   Lumen3D — OME-Zarr export worker (DOCS/dataset-migrations/SPEC.md §14.9)
   ============================================================
   Turns the lossless bricks of one shard into the shard file: each brick's interior placed in
   its 64³ inner chunk (0 past the volume), gzip-encoded, chunks in slot order, the index and
   its crc32c at the end (OmeZarr.shardBytes), and the CRC-32 of the whole file for its zip entry.
   An inner chunk holding only zeros is left absent (its fill value is 0).

   in   { type: 'shard', id, bricks: [{ slot, box: {x0,x1,y0,y1,z0,z1}, data: ArrayBuffer }] }
   out  { type: 'shard', id, ok, bytes: ArrayBuffer | null, crc, chunks, error? }
   ============================================================ */
'use strict';

const _V = (() => { try { return new URL(self.location.href).search; } catch (_) { return ''; } })();
importScripts('../core/ome-zarr.js' + _V);

const PARALLEL = 16;

async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function allZero(a) {
  for (let i = 0; i < a.length; i++) if (a[i]) return false;
  return true;
}

async function buildShard(bricks) {
  const chunks = new Array(OmeZarr.CHUNKS_PER_SHARD).fill(null);
  let n = 0;
  for (let i = 0; i < bricks.length; i += PARALLEL) {
    await Promise.all(bricks.slice(i, i + PARALLEL).map(async (b) => {
      const chunk = OmeZarr.chunkFromBrick(new Uint8Array(b.data), b.box);
      if (allZero(chunk)) return;
      chunks[b.slot] = await gzip(chunk);
      n++;
    }));
  }
  if (!n) return { bytes: null, crc: 0, chunks: 0 };
  const bytes = OmeZarr.shardBytes(chunks);
  return { bytes, crc: OmeZarr.crc32(bytes), chunks: n };
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.type !== 'shard') return;
  try {
    const r = await buildShard(msg.bricks || []);
    const buf = r.bytes ? r.bytes.buffer : null;
    self.postMessage({ type: 'shard', id: msg.id, ok: true, bytes: buf, crc: r.crc, chunks: r.chunks }, buf ? [buf] : []);
  } catch (err) {
    self.postMessage({ type: 'shard', id: msg.id, ok: false, error: String(err && err.message || err) });
  }
};
