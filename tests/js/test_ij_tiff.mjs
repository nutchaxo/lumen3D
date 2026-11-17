// IJTiff (ij-core.js): ImageJ-hyperstack writer and uncompressed reader.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = 'js/modules/studio/advanced-studio/ij-core.js';
vm.runInThisContext(readFileSync(path.join(ROOT, FILE), 'utf8'), { filename: FILE });
const { IJImage, IJLuts, IJTiff } = globalThis;

const arr = (a) => Array.from(a);
const throwsCode = (fn, code) => assert.throws(fn, (e) => e.code === code, 'expected ' + code);
let passed = 0;
function test(name, fn) { fn(); passed++; }

// ---- minimal TIFF directory walker over the bytes IJTiff.write produced
function ifds(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(String.fromCharCode(bytes[0], bytes[1]), 'II');
  assert.equal(dv.getUint16(2, true), 42);
  const out = [];
  let off = dv.getUint32(4, true);
  while (off) {
    const n = dv.getUint16(off, true), tags = {};
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      tags[dv.getUint16(e, true)] = { type: dv.getUint16(e + 2, true), count: dv.getUint32(e + 4, true), value: dv.getUint32(e + 8, true), at: e + 8 };
    }
    out.push(tags);
    off = dv.getUint32(off + 2 + n * 12, true);
  }
  return { dv, ifds: out };
}

function sample(bd, nCh) {
  const img = IJImage.create({
    name: 'sample', width: 5, height: 3, bitDepth: bd,
    channels: [{ name: 'DAPI', color: '#0000ff' }, { name: 'GFP', color: '#00ff00' }, { name: 'Cy5', color: '#ff00ff' }].slice(0, nCh),
    calibration: { pixelWidth: 0.25, pixelHeight: 0.5, unit: 'µm' }
  });
  img.channels.forEach((c, k) => {
    for (let i = 0; i < c.data.length; i++) {
      c.data[i] = bd === 8 ? (i * 17 + k * 40) & 255 : bd === 16 ? i * 4001 + k * 7 : (i - 6) * 1.5 + k * 0.125;
    }
    c.display.min = bd === 32 ? -9 : 3; c.display.max = bd === 8 ? 200 : bd === 16 ? 50000 : 12.5;
  });
  return img;
}

for (const bd of [8, 16, 32]) {
  test('round trip ' + bd + '-bit', () => {
    const img = sample(bd, 3);
    const bytes = IJTiff.write(img);
    const w = ifds(bytes);
    assert.equal(w.ifds.length, 3, 'one IFD per channel');
    const t0 = w.ifds[0];
    assert.equal(t0[256].value, 5); assert.equal(t0[257].value, 3); assert.equal(t0[258].value, bd);
    assert.equal(t0[259].value, 1); assert.equal(t0[339].value, bd === 32 ? 3 : 1);
    assert.ok(t0[270] && t0[50838] && t0[50839]); assert.ok(!w.ifds[1][270], 'description only on the first IFD');
    // strips are exactly the pixel bytes
    const planeBytes = 15 * bd / 8;
    assert.equal(t0[279].value, planeBytes);
    assert.equal(w.ifds[1][273].value - t0[273].value, planeBytes);
    assert.equal(t0[273].value + 3 * planeBytes, bytes.length);
    const back = IJTiff.read(bytes, 'sample');
    assert.equal(back.width, 5); assert.equal(back.height, 3); assert.equal(back.bitDepth, bd);
    assert.equal(back.channels.length, 3);
    img.channels.forEach((c, k) => {
      assert.deepEqual(arr(back.channels[k].data), arr(c.data));
      assert.equal(back.channels[k].name, c.name);
      assert.equal(back.channels[k].display.min, c.display.min);
      assert.equal(back.channels[k].display.max, c.display.max);
      assert.equal(back.channels[k].display.lut, c.display.lut);
      assert.equal(back.channels[k].display.invert, false);
      assert.equal(back.channels[k].color, c.color);
    });
    assert.ok(back.channels[0].data.constructor === img.channels[0].data.constructor);
    assert.equal(back.calibration.unit, 'µm');
    assert.ok(Math.abs(back.calibration.pixelWidth - 0.25) < 1e-6 && Math.abs(back.calibration.pixelHeight - 0.5) < 1e-6);
  });
}

test('description, resolution and metadata tags', () => {
  const img = sample(16, 2);
  const bytes = IJTiff.write(img);
  const { dv, ifds: list } = ifds(bytes);
  const t0 = list[0];
  let s = '';
  for (let i = 0; i < t0[270].count - 1; i++) s += String.fromCharCode(bytes[t0[270].value + i]);
  assert.equal(s, 'ImageJ=1.54f\nimages=2\nchannels=2\nslices=1\nframes=1\nhyperstack=true\nmode=composite\nunit=micron\nmin=3.0\nmax=50000.0\n');
  // XResolution = pixels per µm = 1 / 0.25 = 4 → 4000000 / 1000000
  assert.equal(t0[282].type, 5);
  assert.equal(dv.getUint32(t0[282].value, true) / dv.getUint32(t0[282].value + 4, true), 4);
  assert.equal(dv.getUint32(t0[283].value, true) / dv.getUint32(t0[283].value + 4, true), 2);
  assert.equal(t0[296].value, 1, 'ResolutionUnit none; the unit lives in the description');
  // ImageJ metadata: 'JIJI' magic (0x494a494a little endian), byte counts match the data
  assert.equal(t0[50838].type, 4); assert.equal(t0[50839].type, 1);
  const counts = []; for (let i = 0; i < t0[50838].count; i++) counts.push(dv.getUint32(t0[50838].value + i * 4, true));
  assert.equal(counts[0], 4 + 8 * 3);
  assert.equal(counts.reduce((a, b) => a + b, 0), t0[50839].count);
  assert.equal(dv.getUint32(t0[50839].value, true), 0x494a494a);
  // layout: header, then 'labl' ×2, 'rang' (2·2 doubles = 32 bytes), 'luts' ×2 (768 each)
  assert.deepEqual(counts.slice(1), [8, 6, 32, 768, 768]);
});

test('single channel is grayscale; uncalibrated has no resolution', () => {
  const img = IJImage.create({ width: 3, height: 2, bitDepth: 8 });
  img.channels[0].data.set([1, 2, 3, 4, 5, 6]);
  const bytes = IJTiff.write(img);
  const { ifds: list } = ifds(bytes);
  assert.equal(list.length, 1); assert.ok(!list[0][282] && !list[0][283]);
  let s = '';
  for (let i = 0; i < list[0][270].count - 1; i++) s += String.fromCharCode(bytes[list[0][270].value + i]);
  assert.ok(s.includes('mode=grayscale\n') && !s.includes('unit='), s);
  const back = IJTiff.read(bytes);
  assert.deepEqual(arr(back.channels[0].data), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(back.calibration, { pixelWidth: 1, pixelHeight: 1, unit: 'px' });
  assert.equal(back.name, 'Untitled');
});

test('LUTs: named, inverted, custom table', () => {
  const img = IJImage.create({ width: 2, height: 1, bitDepth: 8, channels: [{ name: 'a', color: '#ffffff' }, { name: 'b', color: '#ffffff' }, { name: 'c', color: '#ffffff' }, { name: 'd', color: '#ffffff' }] });
  img.channels[0].display.lut = 'Fire';
  img.channels[1].display.lut = 'Ice'; img.channels[1].display.invert = true;
  img.channels[2].display.lut = '#336699';
  const custom = new Uint8Array(768); for (let i = 0; i < 768; i++) custom[i] = (i * 7) & 255;
  img.channels[3].display.lut = custom;
  const back = IJTiff.read(IJTiff.write(img));
  assert.deepEqual([back.channels[0].display.lut, back.channels[0].display.invert], ['Fire', false]);
  assert.deepEqual([back.channels[1].display.lut, back.channels[1].display.invert], ['Ice', true]);
  assert.deepEqual([back.channels[2].display.lut, back.channels[2].color], ['#336699', '#336699']);
  assert.ok(back.channels[3].display.lut instanceof Uint8Array);
  assert.deepEqual(arr(back.channels[3].display.lut), arr(custom));
});

test('read: ImageJ one-IFD contiguous stack, big-endian, strips, errors', () => {
  // hand-built big-endian 16-bit, 2 planes of 2×1, one IFD + images=2 (ImageJ layout)
  const desc = 'ImageJ=1.53t\nimages=2\nchannels=2\nmin=0.0\nmax=1000.0\n\0';
  const entries = [];
  const parts = [];
  const hdr = new Uint8Array(8); const hv = new DataView(hdr.buffer);
  hv.setUint16(0, 0x4d4d); hv.setUint16(2, 42); hv.setUint32(4, 8);
  const nEntries = 9;
  const ifdSize = 2 + nEntries * 12 + 4;
  const descOff = 8 + ifdSize, dataOff = descOff + desc.length + (desc.length & 1);
  const buf = new Uint8Array(dataOff + 8); const dv = new DataView(buf.buffer);
  buf.set(hdr, 0);
  let p = 8; dv.setUint16(p, nEntries); p += 2;
  const ent = (tag, type, count, val) => { dv.setUint16(p, tag); dv.setUint16(p + 2, type); dv.setUint32(p + 4, count); if (type === 3 && count === 1) dv.setUint16(p + 8, val); else dv.setUint32(p + 8, val); p += 12; };
  ent(256, 4, 1, 2); ent(257, 4, 1, 1); ent(258, 3, 1, 16); ent(259, 3, 1, 1); ent(262, 3, 1, 1);
  ent(270, 2, desc.length, descOff); ent(273, 4, 1, dataOff); ent(277, 3, 1, 1); ent(279, 4, 1, 4);
  dv.setUint32(p, 0);
  for (let i = 0; i < desc.length; i++) buf[descOff + i] = desc.charCodeAt(i);
  [100, 200, 300, 65535].forEach((v, i) => dv.setUint16(dataOff + i * 2, v));
  const r = IJTiff.read(buf);
  assert.equal(r.channels.length, 2); assert.equal(r.bitDepth, 16);
  assert.deepEqual(arr(r.channels[0].data), [100, 200]); assert.deepEqual(arr(r.channels[1].data), [300, 65535]);
  assert.equal(r.channels[0].display.max, 1000);
  // ArrayBuffer input accepted
  assert.equal(IJTiff.read(buf.buffer.slice(0)).width, 2);

  // multi-strip: 2×2 8-bit in 2 strips of 1 row
  const t = new Uint8Array(8 + 2 + 10 * 12 + 4 + 4 + 8 + 4);
  const td = new DataView(t.buffer);
  t[0] = 0x49; t[1] = 0x49; td.setUint16(2, 42, true); td.setUint32(4, 8, true);
  let q = 8; td.setUint16(q, 9, true); q += 2;
  const e2 = (tag, type, count, val) => { td.setUint16(q, tag, true); td.setUint16(q + 2, type, true); td.setUint32(q + 4, count, true); if (type === 3 && count === 1) td.setUint16(q + 8, val, true); else td.setUint32(q + 8, val, true); q += 12; };
  const extra = 8 + 2 + 9 * 12 + 4;
  e2(256, 4, 1, 2); e2(257, 4, 1, 2); e2(258, 3, 1, 8); e2(259, 3, 1, 1); e2(262, 3, 1, 1);
  e2(273, 4, 2, extra); e2(277, 3, 1, 1); e2(278, 4, 1, 1); e2(279, 4, 2, extra + 8);
  td.setUint32(q, 0, true);
  td.setUint32(extra, extra + 16, true); td.setUint32(extra + 4, extra + 18, true);
  td.setUint32(extra + 8, 2, true); td.setUint32(extra + 12, 2, true);
  t.set([9, 8, 7, 6], extra + 16);
  assert.deepEqual(arr(IJTiff.read(t).channels[0].data), [9, 8, 7, 6]);

  // errors
  throwsCode(() => IJTiff.read(Uint8Array.from([1, 2, 3])), 'IJ_TIFF_UNSUPPORTED');
  throwsCode(() => IJTiff.read(Uint8Array.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0, 0])), 'IJ_TIFF_UNSUPPORTED');
  const lzw = IJTiff.write(IJImage.create({ width: 2, height: 2, bitDepth: 8 }));
  const ld = new DataView(lzw.buffer);
  const first = ld.getUint32(4, true);
  for (let i = 0; i < ld.getUint16(first, true); i++) { const e = first + 2 + i * 12; if (ld.getUint16(e, true) === 259) ld.setUint16(e + 8, 5, true); }
  throwsCode(() => IJTiff.read(lzw), 'IJ_TIFF_UNSUPPORTED');
  const trunc = IJTiff.write(IJImage.create({ width: 4, height: 4, bitDepth: 16 }));
  throwsCode(() => IJTiff.read(trunc.subarray(0, trunc.length - 5)), 'IJ_TIFF_UNSUPPORTED');
  // BigTIFF
  throwsCode(() => IJTiff.read(Uint8Array.from([0x49, 0x49, 43, 0, 8, 0, 0, 0, 0, 0, 0, 0])), 'IJ_TIFF_UNSUPPORTED');
});

test('write refuses images over 4 GiB and malformed images', () => {
  const huge = { name: 'h', width: 65536, height: 65536, bitDepth: 8, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'px' },
    channels: [{ name: 'a', color: '#fff', data: { length: 65536 * 65536 }, display: { min: 0, max: 255, lut: 'Grays', invert: false } }] };
  throwsCode(() => IJTiff.write(huge), 'IJ_TOO_LARGE');
  throwsCode(() => IJTiff.write({ width: 2, height: 2, bitDepth: 12, channels: [] }), 'IJ_BAD_SIZE');
  const bad = IJImage.create({ width: 2, height: 2, bitDepth: 8 }); bad.channels[0].data = new Uint8Array(3);
  throwsCode(() => IJTiff.write(bad), 'IJ_BAD_SIZE');
});

test('IJTiff reads pixel size back from cm / inch resolution units', () => {
  const img = IJImage.create({ width: 2, height: 1, bitDepth: 8, calibration: { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'µm' } });
  const bytes = IJTiff.write(img);
  const { dv, ifds: list } = ifds(bytes);
  // drop the description's unit by retagging: ResolutionUnit 3 (cm) and an empty description
  const d = list[0][270];
  for (let i = 0; i < d.count; i++) bytes[d.value + i] = 0x20;
  dv.setUint16(list[0][296].at, 3, true);
  const back = IJTiff.read(bytes);
  assert.equal(back.calibration.unit, 'µm');
  assert.ok(Math.abs(back.calibration.pixelWidth - 10000 / 2) < 1e-3, 'pixels per cm = 2 → 5000 µm per pixel');
});

console.log('test_ij_tiff: ' + passed + ' groups passed');
