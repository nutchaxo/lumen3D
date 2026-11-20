// IJTiff (ij-core.js) on stacks, hyperstacks and RGB: every ImageJ 1.54p TIFF fixture of tests/fixtures/ij-stacks/tiff both ways
// (write: our bytes against ImageJ's TiffEncoder; read: ImageJ's bytes against ImageJ's own re-opened image), round trips, legacy
// single-plane files unchanged, the compressed reader (IJLocalTiff) agreeing with the uncompressed one.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
for (const f of ['ij-core.js']) vm.runInThisContext(readFileSync(path.join(DIR, f), 'utf8'), { filename: f });
const { IJLuts, IJTiff, IJStack } = globalThis;

let passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name); throw e; } }
const arr = (a) => Array.from(a);

// ---- fixture decoding (README "Schema")
function decodeArray(d, bd) {
  if (Array.isArray(d)) return bd === 8 ? Uint8Array.from(d) : bd === 16 ? Uint16Array.from(d) : Float32Array.from(d);
  const b = Buffer.from(d.b64, 'base64');
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return d.dtype === 'u8' ? new Uint8Array(ab) : d.dtype === 'u16' ? new Uint16Array(ab) : new Float32Array(ab);
}
const planarToTable = (b64) => { const p = Buffer.from(b64, 'base64'), t = new Uint8Array(768); for (let i = 0; i < 256; i++) { t[i * 3] = p[i]; t[i * 3 + 1] = p[256 + i]; t[i * 3 + 2] = p[512 + i]; } return t; };
function lutDisplay(l) {
  if (l === 'grays') return { lut: 'Grays', invert: false };
  if (l === 'inverting') return { lut: 'Grays', invert: true };
  return { lut: planarToTable(l.rgb), invert: false };
}
const effective = (lut, invert) => { const t = IJLuts.get(lut); if (!invert) return t; const r = new Uint8Array(768); for (let i = 0; i < 256; i++) for (let k = 0; k < 3; k++) r[i * 3 + k] = t[(255 - i) * 3 + k]; return r; };
const sameTable = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** STACK of a fixture → the image the engine holds (stack image shape, API.md §3). */
function stackToImage(s) {
  const rgb = s.bitDepth === 24;
  const nC = rgb ? 1 : s.dims.c, nZ = s.dims.z, nT = s.dims.t, NP = nZ * nT;
  const bd = rgb ? 8 : s.bitDepth;
  const n = s.width * s.height;
  let channels;
  if (rgb) {
    channels = [0, 1, 2].map((k) => ({ name: ['Red', 'Green', 'Blue'][k], color: ['#ff0000', '#00ff00', '#0000ff'][k], display: { min: 0, max: 255, lut: ['Red', 'Green', 'Blue'][k], invert: false }, planes: [] }));
    for (const p of s.planes) { const px = decodeArray(p, 8); for (let k = 0; k < 3; k++) { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = px[i * 3 + k]; channels[k].planes.push(a); } }
  } else {
    channels = [];
    for (let c = 0; c < nC; c++) {
      const planes = [];
      for (let pi = 0; pi < NP; pi++) { const t = Math.floor(pi / nZ), z = pi % nZ; planes.push(decodeArray(s.planes[t * nC * nZ + z * nC + c], bd)); }
      const r = s.displayRanges[Math.min(c, s.displayRanges.length - 1)];
      const l = lutDisplay(s.luts ? s.luts[Math.min(c, s.luts.length - 1)] : 'grays');
      channels.push({ name: 'C' + (c + 1), color: '#ffffff', display: { min: r[0], max: r[1], lut: l.lut, invert: l.invert }, planes, data: planes[0] });
    }
  }
  const cal = s.calibration;
  const img = {
    name: s.title, width: s.width, height: s.height, bitDepth: bd, nZ, nT, hyperstack: !!s.hyperstack, rgb,
    labels: s.labels ? s.labels.slice() : null, channels, active: Math.max(0, ((s.position && s.position.c) || 1) - 1),
    mode: s.mode === 'grayscale' ? 'gray' : (s.mode || (nC > 1 ? 'composite' : 'gray')),
    calibration: { pixelWidth: cal.pixelWidth, pixelHeight: cal.pixelHeight, pixelDepth: cal.pixelDepth, unit: cal.unit, xOrigin: cal.xOrigin, yOrigin: cal.yOrigin, zOrigin: cal.zOrigin,
      frameInterval: cal.frameInterval, timeUnit: cal.timeUnit, fps: cal.fps, loop: cal.loop }
  };
  if (nC > 1 && s.composite !== true) img.mode = 'composite';
  return img;
}

const dir = path.join(ROOT, 'tests', 'fixtures', 'ij-stacks', 'tiff');
if (!existsSync(dir)) { console.log('SKIP tests/fixtures/ij-stacks/tiff is absent (generate it with tools/ij_fixtures/run4.sh)'); process.exit(0); }
const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'description_strings.json').sort();
// The two cases whose input does not carry what ImageJ wrote: an Info property and an Overlay set after the image was built (the
// document model has neither, so those bytes are not reproducible from the input; the pixels / description still are).
const NOT_FROM_INPUT = new Set(['stack_u8_info_property', 'stack_u8_overlay']);

function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

for (const f of files) {
  const j = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
  const name = f.replace(/\.json$/, '');
  const expectBytes = new Uint8Array(Buffer.from(j.tiff.b64, 'base64'));

  test('write == ImageJ TiffEncoder: ' + name, () => {
    const img = stackToImage(j.input);
    const bytes = IJTiff.write(img);
    if (NOT_FROM_INPUT.has(name)) { assert.ok(bytes.length > 0); return; }
    // a single plane of a grey image keeps the layout of the first versions (little endian, one IFD per channel): not ImageJ's bytes
    if (!img.rgb && img.nZ * img.nT === 1) { assert.equal(String.fromCharCode(bytes[0], bytes[1]), 'II'); return; }
    const at = firstDifference(bytes, expectBytes);
    assert.equal(at, -1, `first differing byte ${at} of ${bytes.length} (ImageJ ${expectBytes.length})`);
  });

  test('read(ImageJ bytes) == ImageJ re-opened: ' + name, () => {
    const img = IJTiff.read(expectBytes, 'x');
    const re = j.reopened;
    const rgb = re.bitDepth === 24;
    assert.equal(img.width, re.width); assert.equal(img.height, re.height);
    assert.equal(!!img.rgb, rgb);
    assert.equal(img.bitDepth, rgb ? 8 : re.bitDepth);
    const nZ = img.nZ || 1, nT = img.nT || 1, nC = rgb ? 1 : img.channels.length;
    if (rgb) assert.deepEqual([1, re.dims.z, re.dims.t], [nC, nZ, nT]);
    else assert.deepEqual([re.dims.c, re.dims.z, re.dims.t], [nC, nZ, nT]);
    assert.equal(!!img.hyperstack, !!re.hyperstack);
    // pixels, plane by plane in ImageJ's stack order
    const N = re.planes.length;
    for (let n = 0; n < N; n++) {
      const t = Math.floor(n / (nC * nZ)), rem = n % (nC * nZ), z = Math.floor(rem / nC), c = rem % nC, pi = t * nZ + z;
      const want = decodeArray(re.planes[n], rgb ? 8 : re.bitDepth);
      if (rgb) {
        for (let k = 0; k < 3; k++) { const got = img.channels[k].planes ? img.channels[k].planes[pi] : img.channels[k].data; for (let i = 0; i < got.length; i++) if (got[i] !== want[i * 3 + k]) assert.fail('rgb plane ' + n + ' pixel ' + i); }
      } else {
        const got = img.channels[c].planes ? img.channels[c].planes[pi] : img.channels[c].data;
        assert.deepEqual(arr(got), arr(want), 'plane ' + (n + 1));
      }
    }
    if (re.labels && re.labels.some((l) => l)) {
      if (nZ * nT > 1 || rgb) assert.deepEqual(img.labels, re.labels.map((l) => l || null));
      else assert.deepEqual(img.channels.map((c) => c.name), re.labels);
    }
    if (!rgb && nC > 1) assert.equal(img.mode, re.mode === 'grayscale' ? 'gray' : re.mode);
    // display ranges and LUTs
    if (!rgb) {
      re.displayRanges.forEach((r, c) => {
        const d = img.channels[Math.min(c, nC - 1)].display;
        assert.deepEqual([d.min, d.max], r, 'display range of channel ' + (c + 1));
      });
      (re.luts || []).forEach((l, c) => {
        const d = img.channels[Math.min(c, nC - 1)].display;
        const want = l === 'grays' ? IJLuts.get('Grays') : l === 'inverting' ? effective('Grays', true) : planarToTable(l.rgb);
        assert.ok(sameTable(effective(d.lut, d.invert), want), 'LUT of channel ' + (c + 1));
      });
    }
    // calibration (ImageJ's "micron" is shown as µm here)
    const cal = img.calibration, rc = re.calibration;
    const unit = rc.unit === 'micron' || rc.unit === 'um' || rc.unit === '\\u00B5m' ? 'µm' : rc.unit;
    if (rc.unit !== 'pixel' && rc.pixelWidth !== 1) {
      assert.equal(cal.unit, unit);
      assert.ok(Math.abs(cal.pixelWidth - rc.pixelWidth) < 1e-5 * rc.pixelWidth, 'pixelWidth');
      assert.ok(Math.abs(cal.pixelHeight - rc.pixelHeight) < 1e-5 * rc.pixelHeight, 'pixelHeight');
    }
    if (nZ * nT > 1 || rgb) assert.ok(Math.abs((cal.pixelDepth || 1) - rc.pixelDepth) < 1e-9, 'pixelDepth ' + cal.pixelDepth + ' vs ' + rc.pixelDepth);
    assert.equal(cal.frameInterval || 0, rc.frameInterval, 'frameInterval');
    if (nZ * nT > 1) { assert.equal(cal.fps || 0, rc.fps, 'fps'); assert.equal(!!cal.loop, !!rc.loop, 'loop'); }
  });

  test('read(write(image)) round trip: ' + name, () => {
    const img = stackToImage(j.input);
    const bytes = IJTiff.write(img);
    const back = IJTiff.read(bytes, 'rt');
    assert.equal(!!back.rgb, !!img.rgb);
    assert.equal(back.nZ || 1, img.nZ); assert.equal(back.nT || 1, img.nT);
    assert.equal(!!back.hyperstack, img.hyperstack && (img.channels.length > 1 || img.rgb ? (img.nZ > 1 || img.nT > 1 || img.channels.length > 1) : true) && (back.hyperstack || false));
    img.channels.forEach((c, k) => {
      const planes = back.channels[k].planes || [back.channels[k].data];
      c.planes.forEach((p, pi) => assert.deepEqual(arr(planes[pi]), arr(p), 'channel ' + k + ' plane ' + pi));
      assert.equal(back.channels[k].display.min, c.display.min); assert.equal(back.channels[k].display.max, c.display.max);
    });
    if (img.labels && img.labels.some((l) => l)) assert.deepEqual(back.labels, img.labels.map((l) => l || null));
  });
}

// ---- IJStack and the model
test('IJStack index maths agrees with the file order of the hyperstack fixture', () => {
  const dims = { nC: 2, nZ: 3, nT: 2 };
  assert.equal(IJStack.stackIndex(dims, 1, 2, 1), 12);
  assert.deepEqual(IJStack.position(dims, 12), { c: 1, z: 2, t: 1 });
});

// ---- description strings
test('description strings of FileSaver (description_strings.json)', () => {
  const j = JSON.parse(readFileSync(path.join(dir, 'description_strings.json'), 'utf8'));
  const text = (bytes) => { const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let at = dv.getUint32(4, false); const n = dv.getUint16(at, false); for (let i = 0; i < n; i++) { const e = at + 2 + i * 12; if (dv.getUint16(e, false) === 270) { const off = dv.getUint32(e + 8, false), len = dv.getUint32(e + 4, false); return String.fromCharCode(...bytes.subarray(off, off + len)); } } return null; };
  assert.equal(j.cases.length, 5);
  // the hyp16 case is the calibrated 2c3z2t hyperstack: the same text as its fixture
  const h = JSON.parse(readFileSync(path.join(dir, 'hyperstack_u16_2c3z2t_calibrated.json'), 'utf8'));
  const got = text(IJTiff.write(stackToImage(h.input)));
  assert.equal(got, j.cases.find((c) => c.name === 'hyp16').description);
});

// ---- javaDouble / escapes
test('Java number and escape formatting', () => {
  const d = IJTiff.javaDouble;
  assert.equal(d(2), '2.0'); assert.equal(d(1.5), '1.5'); assert.equal(d(-45.275856018066406), '-45.275856018066406');
  assert.equal(d(1e7), '1.0E7'); assert.equal(d(12345678.5), '1.23456785E7'); assert.equal(d(0.0001), '1.0E-4'); assert.equal(d(0.001), '0.001');
  assert.equal(IJTiff.escapedLine('unit=µm'), 'unit=\\u00B5m\n');
  assert.equal(IJTiff.escapedLine('a\\b'), 'a\\u005Cb\n');
});

// ---- legacy single-plane files are unchanged
test('a single-plane document keeps the first versions\' layout (little endian, one IFD per channel)', () => {
  const img = { name: 'x', width: 3, height: 2, bitDepth: 8, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'px' },
    channels: [{ name: 'a', color: '#ffffff', data: Uint8Array.from([1, 2, 3, 4, 5, 6]), display: { min: 0, max: 255, lut: 'Grays', invert: false } }] };
  const bytes = IJTiff.write(img);
  assert.equal(String.fromCharCode(bytes[0], bytes[1]), 'II');
  const back = IJTiff.read(bytes);
  assert.deepEqual(arr(back.channels[0].data), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(back.calibration, { pixelWidth: 1, pixelHeight: 1, unit: 'px' });
  assert.equal(back.nZ, undefined); assert.equal(back.rgb, undefined);
  // the same image as a one-slice stack object (nZ = nT = 1, planes list) is the legacy layout too
  img.channels[0].planes = [img.channels[0].data]; img.nZ = 1; img.nT = 1;
  assert.deepEqual(arr(IJTiff.write(img)), arr(bytes));
});

test('an RGB image of one plane is written as ImageJ writes it', () => {
  const n = 6, r = new Uint8Array(n).map((_, i) => i * 10), g = new Uint8Array(n).map((_, i) => 100 + i), b = new Uint8Array(n).map((_, i) => 255 - i);
  const img = { name: 'c', width: 3, height: 2, bitDepth: 8, rgb: true, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' },
    channels: [{ name: 'Red', data: r }, { name: 'Green', data: g }, { name: 'Blue', data: b }] };
  const bytes = IJTiff.write(img);
  assert.equal(String.fromCharCode(bytes[0], bytes[1]), 'MM');
  const back = IJTiff.read(bytes);
  assert.equal(back.rgb, true); assert.equal(back.bitDepth, 8);
  assert.deepEqual(back.channels.map((c) => c.name), ['Red', 'Green', 'Blue']);
  assert.deepEqual([arr(back.channels[0].data), arr(back.channels[1].data), arr(back.channels[2].data)], [arr(r), arr(g), arr(b)]);
});

// ---- hand-built files: RGB chunky / planar, palette, several IFDs without a description, compression
for (const f of ['ij-proc-lib.js', 'ij-proc-io.js']) vm.runInThisContext(readFileSync(path.join(DIR, f), 'utf8'), { filename: f });
const { IJLocalTiff } = globalThis;

/** A classic TIFF of 8-bit RGB / grey images: o = { W, H, images: [[plane…]] (1 or 3 planes of W·H bytes), planar, le, deflate, predictor, rps, description, palette (768 shorts) } */
function buildFile(o) {
  const le = o.le !== false, W = o.W, H = o.H, rps = o.rps || H, spp = o.images[0].length;
  const chunks = [];
  let pos = 8;
  const put = (u8) => { const at = pos; chunks.push(u8); pos += u8.length; if (pos & 1) { chunks.push(new Uint8Array(1)); pos++; } return at; };
  const u16 = (v) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, le); return b; };
  const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, le); return b; };
  const stripsOf = (rowsOf) => {
    const offsets = [], counts = [];
    for (let s = 0; s * rps < H; s++) {
      const rows = Math.min(rps, H - s * rps);
      let bytes = rowsOf(s * rps, rows);
      if (o.predictor === 2) {
        const stride = o.planar || spp === 1 ? 1 : spp, rowLen = W * stride;
        for (let y = 0; y < rows; y++) for (let x = rowLen - 1; x >= stride; x--) bytes[y * rowLen + x] = (bytes[y * rowLen + x] - bytes[y * rowLen + x - stride]) & 255;
      }
      if (o.deflate) bytes = new Uint8Array(zlib.deflateSync(Buffer.from(bytes)));
      offsets.push(put(bytes)); counts.push(bytes.length);
    }
    return { offsets, counts };
  };
  const ifds = o.images.map((planes, k) => {
    let all;
    if (o.planar && spp === 3) {
      all = planes.map((pl) => stripsOf((y0, rows) => pl.slice(y0 * W, (y0 + rows) * W)));
      all = { offsets: all.flatMap((x) => x.offsets), counts: all.flatMap((x) => x.counts) };
    } else {
      all = stripsOf((y0, rows) => {
        const out = new Uint8Array(rows * W * spp);
        for (let i = 0; i < rows * W; i++) for (let c = 0; c < spp; c++) out[i * spp + c] = planes[c][y0 * W + i];
        return out;
      });
    }
    const e = [];
    const long = (tag, v) => e.push([tag, 4, 1, u32(v)]);
    const short = (tag, v) => e.push([tag, 3, 1, u16(v)]);
    long(256, W); long(257, H);
    if (spp === 3) e.push([258, 3, 3, Uint8Array.from([...u16(8), ...u16(8), ...u16(8)])]); else short(258, 8);
    short(259, o.deflate ? 8 : 1); short(262, spp === 3 ? 2 : (o.palette ? 3 : 1));
    if (k === 0 && o.description) { const t = new TextEncoder().encode(o.description + '\0'); e.push([270, 2, t.length, t]); }
    e.push([273, 4, all.offsets.length, Uint8Array.from(all.offsets.flatMap((v) => Array.from(u32(v))))]);
    short(277, spp); long(278, rps);
    e.push([279, 4, all.counts.length, Uint8Array.from(all.counts.flatMap((v) => Array.from(u32(v))))]);
    if (spp === 3) short(284, o.planar ? 2 : 1);
    if (o.predictor === 2) short(317, 2);
    if (o.palette) e.push([320, 3, 768, Uint8Array.from(Array.from(o.palette).flatMap((v) => Array.from(u16(v))))]);
    e.sort((a, b) => a[0] - b[0]);
    return e;
  });
  ifds.forEach((e) => e.forEach((ent) => { if (ent[3].length > 4) ent.push(put(ent[3])); }));
  const at = [];
  ifds.forEach((e) => { at.push(pos); pos += 2 + e.length * 12 + 4; if (pos & 1) pos++; });
  const file = new Uint8Array(pos), dv = new DataView(file.buffer);
  file[0] = file[1] = le ? 0x49 : 0x4d; dv.setUint16(2, 42, le); dv.setUint32(4, at[0], le);
  let off = 8;
  for (const c of chunks) { file.set(c, off); off += c.length; }
  ifds.forEach((e, k) => {
    let p = at[k]; dv.setUint16(p, e.length, le); p += 2;
    for (const ent of e) {
      dv.setUint16(p, ent[0], le); dv.setUint16(p + 2, ent[1], le); dv.setUint32(p + 4, ent[2], le);
      if (ent.length === 5) dv.setUint32(p + 8, ent[4], le); else file.set(ent[3], p + 8);
      p += 12;
    }
    dv.setUint32(p, k + 1 < at.length ? at[k + 1] : 0, le);
  });
  return file;
}
const gradient = (n, seed) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed * 41) & 255);
const tableOf = (d) => { const t = IJLuts.get(d.lut); if (!d.invert) return t; const r = new Uint8Array(768); for (let i = 0; i < 256; i++) for (let k = 0; k < 3; k++) r[i * 3 + k] = t[(255 - i) * 3 + k]; return r; };

test('RGB: chunky and planar, little and big endian, 1 and 3 images', () => {
  const W = 6, H = 5;
  for (const planar of [false, true]) for (const le of [true, false]) for (const k of [1, 3]) {
    const images = Array.from({ length: k }, (_, i) => [gradient(W * H, i * 3), gradient(W * H, i * 3 + 1), gradient(W * H, i * 3 + 2)]);
    const bytes = buildFile({ W, H, images, planar, le, rps: 2, description: k > 1 ? 'ImageJ=1.54p\nimages=' + k + '\nslices=' + k + '\n' : undefined });
    const img = IJTiff.read(bytes, 'rgb');
    assert.equal(img.rgb, true); assert.equal(img.bitDepth, 8); assert.equal(img.channels.length, 3);
    assert.equal(img.nZ, k); assert.equal(img.nT, 1);
    images.forEach((im, i) => im.forEach((pl, c) => assert.deepEqual(arr(k > 1 ? img.channels[c].planes[i] : img.channels[c].data), arr(pl), `planar ${planar} le ${le} image ${i} sample ${c}`)));
  }
});

test('several IFDs without a description are a z-stack (ImageJ); the description gives channels, frames, mode', () => {
  const W = 4, H = 3;
  const gray = [0, 1, 2].map((i) => [gradient(W * H, i)]);
  const img = IJTiff.read(buildFile({ W, H, images: gray }), 'g');
  assert.deepEqual([img.nZ, img.nT, img.channels.length, img.hyperstack, img.rgb], [3, 1, 1, false, false]);
  gray.forEach((im, i) => assert.deepEqual(arr(img.channels[0].planes[i]), arr(im[0])));
  const withC = IJTiff.read(buildFile({ W, H, images: gray, description: 'ImageJ=1.54p\nimages=3\nchannels=3\nmode=color\n' }), 'c');
  assert.deepEqual([withC.nZ || 1, withC.nT || 1, withC.channels.length, withC.mode], [1, 1, 3, 'color']);
  assert.deepEqual(withC.channels.map((c) => c.display.lut), ['Red', 'Green', 'Blue'], 'a composite without LUTs shows the default colours of ImageJ');
  // c * z * t that does not match the number of images: a plain stack
  const odd = IJTiff.read(buildFile({ W, H, images: gray, description: 'ImageJ=1.54p\nimages=3\nchannels=2\nslices=2\n' }), 'o');
  assert.deepEqual([odd.nZ, odd.channels.length], [3, 1]);
  // t only
  const tt = IJTiff.read(buildFile({ W, H, images: gray, description: 'ImageJ=1.54p\nimages=3\nframes=3\nfinterval=2.5\n' }), 't');
  assert.deepEqual([tt.nZ, tt.nT, tt.hyperstack], [1, 3, false]); assert.equal(tt.calibration.frameInterval, 2.5);
});

test('8-bit palette image: the colour map becomes the LUT, white-is-zero an inverting LUT', () => {
  const W = 4, H = 2;
  const palette = new Uint16Array(768);
  for (let i = 0; i < 256; i++) { palette[i] = i << 8; palette[256 + i] = 0; palette[512 + i] = (255 - i) << 8; }
  const img = IJTiff.read(buildFile({ W, H, images: [[gradient(W * H, 1)]], palette }), 'p');
  const t = tableOf(img.channels[0].display);
  assert.deepEqual([t[3 * 100], t[3 * 100 + 1], t[3 * 100 + 2]], [100, 0, 155]);
  const wz = buildFile({ W, H, images: [[gradient(W * H, 1)]] });
  const dv = new DataView(wz.buffer);
  const base = dv.getUint32(4, true), n = dv.getUint16(base, true);
  for (let i = 0; i < n; i++) { const e = base + 2 + i * 12; if (dv.getUint16(e, true) === 262) dv.setUint16(e + 8, 0, true); }
  assert.equal(IJTiff.read(wz, 'w').channels[0].display.invert, true);
});

test('refusals: 12 bits, BigTIFF, RGBA, LZW, short files', () => {
  const U = (e) => e.code === 'IJ_TIFF_UNSUPPORTED';
  assert.throws(() => IJTiff.read(new Uint8Array(4)), U);
  assert.throws(() => IJTiff.read(Uint8Array.from([0x49, 0x49, 43, 0, 8, 0, 0, 0])), U);
  assert.throws(() => IJTiff.read(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])), U);
  const good = buildFile({ W: 3, H: 2, images: [[gradient(6, 1)]] });
  const patch = (tag, value) => { const c = good.slice(); const dv = new DataView(c.buffer); const base = dv.getUint32(4, true); const n = dv.getUint16(base, true); for (let i = 0; i < n; i++) { const e = base + 2 + i * 12; if (dv.getUint16(e, true) === tag) dv.setUint16(e + 8, value, true); } return c; };
  assert.throws(() => IJTiff.read(patch(258, 12)), U);
  assert.throws(() => IJTiff.read(patch(277, 4)), U);
  assert.throws(() => IJTiff.read(patch(259, 5)), U, 'LZW is not read');
  assert.throws(() => IJTiff.read(good.slice(0, 40)), U);
});

await (async () => {
  try {
    const W = 9, H = 7;
    const mk = (i) => [gradient(W * H, i * 3), gradient(W * H, i * 3 + 1), gradient(W * H, i * 3 + 2)];
    for (const planar of [false, true]) for (const predictor of [1, 2]) {
      const images = [mk(0), mk(1)];
      const description = 'ImageJ=1.54p\nimages=2\nslices=2\nunit=micron\nspacing=3.5\n';
      const raw = buildFile({ W, H, images, planar, rps: 3, description });
      const packed = buildFile({ W, H, images, planar, rps: 3, description, deflate: true, predictor });
      assert.equal(IJLocalTiff.needsDecoder(raw), false); assert.equal(IJLocalTiff.needsDecoder(packed), true);
      const a = IJTiff.read(raw, 'x'), b = await IJLocalTiff.read(packed, 'x');
      assert.equal(b.rgb, true); assert.equal(b.nZ, 2);
      for (let c = 0; c < 3; c++) for (let i = 0; i < 2; i++) assert.deepEqual(arr(b.channels[c].planes[i]), arr(a.channels[c].planes[i]), `planar ${planar} predictor ${predictor}`);
      assert.equal(b.calibration.pixelDepth, 3.5);
    }
    const gray = [0, 1, 2].map((i) => [gradient(W * H, i)]);
    const g = await IJLocalTiff.read(buildFile({ W, H, images: gray, rps: 2, deflate: true, predictor: 2 }), 'g');
    assert.equal(g.nZ, 3); gray.forEach((im, i) => assert.deepEqual(arr(g.channels[0].planes[i]), arr(im[0])));
    passed++;
  } catch (e) { console.error('FAIL the compressed reader (IJLocalTiff) gives the uncompressed reader\'s image, RGB and stacks included'); throw e; }
})();

console.log('test_ij_stk_tiff: ' + passed + ' passed');
