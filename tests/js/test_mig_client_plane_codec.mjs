// PlaneCodec (js/core/plane-codec.js) — the byte formats of a format-2 `planes/` tree
// (DOCS/dataset-migrations/SPEC.md §3, §5.1):
//   • png-gray8 round trips exactly (random data, every edge size of a 512 tile);
//   • the encoder's PNG is valid for an INDEPENDENT decoder (node:zlib inflate + the PNG
//     unfilter written here), carries exactly IHDR/IDAT/IEND with correct CRCs, colour type
//     0, bit depth 8, filter None on every row (the choice of every encoder), and no colour-management chunk;
//   • the decoder handles all five PNG filter types (PNGs built here with node:zlib);
//   • the decoder refuses anything but 8-bit greyscale non-interlaced and a bad CRC;
//   • the plane-pack header and the unit blob have the normative little-endian layout.
//
// Run: node tests/js/test_mig_client_plane_codec.mjs
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { loadModule } from './harness.mjs';

const PC = loadModule('js/core/plane-codec.js', 'PlaneCodec', {
  CompressionStream, DecompressionStream, Blob, Response,
});
const u8 = (a) => Buffer.from(a.buffer ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength) : a);

let seed = 12345;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed >>> 8; };
function randomPlane(w, h, mode) {
  const a = new Uint8Array(w * h);
  for (let i = 0; i < a.length; i++) {
    if (mode === 'sparse') a[i] = (rnd() % 17 === 0) ? rnd() & 0xFF : 0;
    else if (mode === 'smooth') a[i] = ((i % w) + Math.floor(i / w) * 3) & 0xFF;
    else a[i] = rnd() & 0xFF;
  }
  return a;
}

// ── independent PNG reader ──
function readChunks(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], 'PNG signature');
  const chunks = [];
  let p = 8;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    const crc = buf.readUInt32BE(p + 8 + len);
    assert.equal(crc, zlib.crc32(buf.subarray(p + 4, p + 8 + len)), `CRC of ${type}`);
    chunks.push({ type, data });
    p += 12 + len;
  }
  return chunks;
}
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
}
function independentDecode(png) {
  const chunks = readChunks(png);
  assert.equal(chunks[0].type, 'IHDR');
  assert.equal(chunks[chunks.length - 1].type, 'IEND');
  for (const c of chunks) assert.ok(['IHDR', 'IDAT', 'IEND'].includes(c.type), `unexpected chunk ${c.type}`);
  const ih = chunks[0].data;
  const w = ih.readUInt32BE(0), h = ih.readUInt32BE(4);
  assert.deepEqual([...ih.subarray(8, 13)], [8, 0, 0, 0, 0], 'bit depth 8, greyscale, deflate, filter 0, no interlace');
  const raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  assert.equal(raw.length, (w + 1) * h);
  const out = new Uint8Array(w * h);
  const filters = [];
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (w + 1)];
    filters.push(ft);
    for (let x = 0; x < w; x++) {
      const v = raw[y * (w + 1) + 1 + x];
      const a = x ? out[y * w + x - 1] : 0, b = y ? out[(y - 1) * w + x] : 0, c = x && y ? out[(y - 1) * w + x - 1] : 0;
      out[y * w + x] = (ft === 0 ? v : ft === 1 ? v + a : ft === 2 ? v + b : ft === 3 ? v + ((a + b) >> 1) : v + paeth(a, b, c)) & 0xFF;
    }
  }
  return { w, h, data: out, filters };
}

// ── independent PNG writer with chosen filter per row ──
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
  return Buffer.concat([len, td, crc]);
}
function writePng(w, h, px, filterOf, opts = {}) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    const ft = filterOf(y);
    raw[y * (w + 1)] = ft;
    for (let x = 0; x < w; x++) {
      const v = px[y * w + x];
      const a = x ? px[y * w + x - 1] : 0, b = y ? px[(y - 1) * w + x] : 0, c = x && y ? px[(y - 1) * w + x - 1] : 0;
      const pred = ft === 0 ? 0 : ft === 1 ? a : ft === 2 ? b : ft === 3 ? ((a + b) >> 1) : paeth(a, b, c);
      raw[y * (w + 1) + 1 + x] = (v - pred) & 0xFF;
    }
  }
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4);
  ih[8] = opts.depth ?? 8; ih[9] = opts.colorType ?? 0;
  const z = zlib.deflateSync(raw, { level: 9 });
  // Split IDAT in two to exercise multi-IDAT concatenation.
  const cut = Math.floor(z.length / 2);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ih),
    ...(opts.extra ? [chunk(opts.extra, Buffer.from('x'))] : []),
    chunk('IDAT', z.subarray(0, cut)), chunk('IDAT', z.subarray(cut)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 1. Round trips + independent validity.
for (const [w, h, mode] of [[1, 1, 'rand'], [512, 512, 'rand'], [512, 512, 'sparse'], [88, 18, 'smooth'], [37, 11, 'rand'], [300, 1, 'rand'], [1, 300, 'smooth']]) {
  const px = randomPlane(w, h, mode);
  const png = await PC.encodePngGray(w, h, px);
  const ours = await PC.decodePngGray(png);
  assert.equal(ours.width, w); assert.equal(ours.height, h);
  assert.ok(u8(ours.data).equals(u8(px)), `round trip ${w}x${h} ${mode}`);
  const ind = independentDecode(Buffer.from(png));
  assert.equal(ind.w, w); assert.equal(ind.h, h);
  assert.ok(u8(ind.data).equals(u8(px)), `independent decode ${w}x${h} ${mode}`);
  assert.ok(ind.filters.every((f) => f === 0), 'reference filter: None on every row');
  const hdr = PC.readPngHeader(png);
  assert.deepEqual({ ...hdr }, { width: w, height: h, bitDepth: 8, colorType: 0, compression: 0, filter: 0, interlace: 0 });
}
// zlib stream (RFC 1950) inside IDAT: CMF byte 0x78
{
  const png = Buffer.from(await PC.encodePngGray(4, 4, new Uint8Array(16)));
  const idat = readChunks(png).find((c) => c.type === 'IDAT').data;
  assert.equal(idat[0] & 0x0F, 8, 'CM = deflate');
  assert.equal(((idat[0] << 8) | idat[1]) % 31, 0, 'zlib header check bits');
}

// 2. Every filter type decodes.
for (const scheme of ['0', '1', '2', '3', '4', 'mixed']) {
  const w = 61, h = 23;
  const px = randomPlane(w, h, scheme === 'mixed' ? 'rand' : 'smooth');
  const png = writePng(w, h, px, (y) => (scheme === 'mixed' ? y % 5 : +scheme));
  const d = await PC.decodePngGray(png);
  assert.ok(u8(d.data).equals(u8(px)), `filter ${scheme}`);
}
// Ancillary chunks are skipped by the decoder (encoder never writes them).
{
  const px = randomPlane(9, 9, 'rand');
  const d = await PC.decodePngGray(writePng(9, 9, px, () => 4, { extra: 'tEXt' }));
  assert.ok(u8(d.data).equals(u8(px)));
}

// 3. Refusals.
await assert.rejects(PC.decodePngGray(writePng(4, 4, new Uint8Array(16), () => 0, { colorType: 2 })), /greyscale/);
await assert.rejects(PC.decodePngGray(writePng(4, 4, new Uint8Array(16), () => 0, { depth: 16 })), /greyscale/);
await assert.rejects(PC.decodePngGray(new Uint8Array([1, 2, 3])), /not a PNG/);
{
  const png = Buffer.from(await PC.encodePngGray(8, 8, randomPlane(8, 8, 'rand')));
  png[png.length - 20] ^= 0xFF;  // inside IDAT (IEND is the last 12 bytes)
  await assert.rejects(PC.decodePngGray(png), /CRC|short|invalid|incorrect|data/i);
}
await assert.rejects(PC.encodePngGray(4, 4, new Uint8Array(15)), /length/);
await assert.rejects(PC.encodePngGray(0, 4, new Uint8Array(0)), /size/);
assert.equal(PC.crc32(Buffer.from('IEND')), zlib.crc32(Buffer.from('IEND')));

// 4. Plane-pack header.
{
  const C = 4, TX = 8, TY = 8;
  assert.equal(PC.headerBytes(C, TX, TY), 3088, 'SPEC example: 16 + 12·4·8·8');
  assert.equal(PC.PACK_MAGIC, 'LPLN');
  // entry order: c-major, then ty, then tx
  assert.equal(PC.tileIndex(0, 0, 1, TX, TY), 1);
  assert.equal(PC.tileIndex(0, 1, 0, TX, TY), TX);
  assert.equal(PC.tileIndex(1, 0, 0, TX, TY), TX * TY);
  assert.equal(PC.tileIndex(3, 7, 7, TX, TY), C * TX * TY - 1);
  const entries = [];
  let off = PC.headerBytes(C, TX, TY);
  for (let i = 0; i < C * TX * TY; i++) {
    const len = i % 7 === 0 ? 0 : 1000 + i;
    entries.push({ offset: len ? off : 0, length: len });
    off += len;
  }
  entries[5] = { offset: 2 ** 40 + 3, length: 77 };  // u64 offsets above 4 GiB survive
  const h = PC.buildPackHeader({ channels: C, tilesX: TX, tilesY: TY, z: 70000, entries });
  assert.equal(h.length, 3088);
  const b = Buffer.from(h);
  assert.equal(b.toString('latin1', 0, 4), 'LPLN');
  assert.equal(b.readUInt16LE(4), 1);
  assert.equal(b.readUInt16LE(6), C);
  assert.equal(b.readUInt16LE(8), TX);
  assert.equal(b.readUInt16LE(10), TY);
  assert.equal(b.readUInt32LE(12), 70000);
  assert.equal(b.readBigUInt64LE(16 + 12 * 5), BigInt(2 ** 40 + 3));
  assert.equal(b.readUInt32LE(16 + 12 * 5 + 8), 77);
  assert.equal(b.readBigUInt64LE(16), 0n); assert.equal(b.readUInt32LE(24), 0, 'entry 0 is an empty tile');
  const p = PC.parsePackHeader(h);
  assert.equal(p.version, 1); assert.equal(p.channels, C); assert.equal(p.tilesX, TX); assert.equal(p.tilesY, TY); assert.equal(p.z, 70000);
  assert.deepEqual(JSON.parse(JSON.stringify(p.entries)), entries);
  // parse accepts a whole pack (header followed by payloads) and an ArrayBuffer
  const whole = new Uint8Array(h.length + 50); whole.set(h);
  assert.equal(PC.parsePackHeader(whole.buffer).entries.length, C * TX * TY);
  assert.throws(() => PC.parsePackHeader(h.subarray(0, 100)), /short/);
  const bad = new Uint8Array(h); bad[0] = 0x58;
  assert.throws(() => PC.parsePackHeader(bad), /magic/);
  assert.throws(() => PC.buildPackHeader({ channels: 1, tilesX: 1, tilesY: 1, z: 0, entries: [] }), /entries/);
}

// 5. Unit blob (SPEC §5.1).
{
  const tiles = [{ z: 64, png: new Uint8Array([1, 2, 3]) }, { z: 127, png: new Uint8Array([9]) }];
  const blob = Buffer.from(PC.buildUnitBlob(tiles));
  assert.equal(blob.length, 4 + 8 + 3 + 8 + 1);
  assert.equal(blob.readUInt32LE(0), 2);
  assert.equal(blob.readUInt32LE(4), 64); assert.equal(blob.readUInt32LE(8), 3);
  assert.deepEqual([...blob.subarray(12, 15)], [1, 2, 3]);
  assert.equal(blob.readUInt32LE(15), 127); assert.equal(blob.readUInt32LE(19), 1);
  assert.equal(blob[23], 9);
  const back = PC.parseUnitBlob(blob);
  assert.deepEqual(JSON.parse(JSON.stringify(back.map((t) => ({ z: t.z, png: [...t.png] })))), [{ z: 64, png: [1, 2, 3] }, { z: 127, png: [9] }]);
  assert.equal(PC.buildUnitBlob([]).length, 4);
  assert.throws(() => PC.parseUnitBlob(Buffer.concat([blob, Buffer.from([0])])), /trailing/);
}

console.log('plane-codec: OK');
