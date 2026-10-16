// m005-matrix browser handler (js/migrations/m005-matrix.js) against format5.py.
//
// What Node can run without a WebP codec: the level arithmetic (resamplePlane), the
// quantizer, the dead zone, the 66- and 80-px mosaics, the apron brick, and the binary
// layouts the server parses (LPLN packs, xz/yz packs, the stage-B blob) — every one compared
// with, or parsed by, the Python reference. The WebP paths run in a browser (see
// DOCS/dataset-migrations/SPEC.md §14.10 for the end-to-end check).
//
// Run: node tests/js/test_m005_handler.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { loadModule, ROOT } from './harness.mjs';

const streams = {
  CompressionStream: globalThis.CompressionStream, DecompressionStream: globalThis.DecompressionStream,
  Blob: globalThis.Blob, Response: globalThis.Response,
};
if (!streams.CompressionStream) {
  console.log('SKIP no CompressionStream in this Node');
  process.exit(0);
}
const PlaneCodec = loadModule('js/core/plane-codec.js', 'PlaneCodec', streams);
const handlers = loadModule('js/migrations/m005-matrix.js', 'LumenMigrationHandlers', { ...streams, PlaneCodec, BigInt });
const H = handlers['m005-matrix'];
const I = H._internals;

function python(code, payload) {
  const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  let out;
  try {
    out = execFileSync(py, ['-c', code], {
      input: JSON.stringify(payload), cwd: ROOT, maxBuffer: 1 << 28,
      env: { ...process.env, PYTHONPATH: ROOT + path.delimiter + (process.env.PYTHONPATH || '') },
    });
  } catch (e) {
    if (/No module named 'numpy'|not found|ENOENT/.test(String(e.stderr || e.message))) {
      console.log('SKIP python/numpy unavailable');
      process.exit(0);
    }
    throw e;
  }
  return JSON.parse(out.toString('utf8'));
}

const b64 = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; };
}
function noise(n, seed, sparse) {
  const r = rng(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const v = r(); out[i] = sparse && (v & 7) ? 0 : (v >>> 11) & 0xFF; }
  return out;
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log('ok -', name);
}

await test('resamplePlane equals format5.resample_plane', async () => {
  const cases = [[300, 270, 256, 230], [1000, 37, 256, 9], [513, 700, 375, 512], [64, 64, 64, 64], [777, 777, 256, 256], [5, 3, 1, 1]];
  const planes = cases.map(([w, h], i) => noise(w * h, 17 + i, i % 2 === 1));
  const ref = python(`
import sys, json, base64, numpy as np, format5 as f5
d = json.load(sys.stdin)
out = []
for (w, h, w1, h1), p in zip(d["cases"], d["planes"]):
    a = np.frombuffer(base64.b64decode(p), dtype=np.uint8).reshape(h, w)
    out.append(base64.b64encode(f5.resample_plane(a, w1, h1).tobytes()).decode())
print(json.dumps(out))`, { cases, planes: planes.map(b64) });
  cases.forEach(([w, h, w1, h1], i) => {
    const got = I.resamplePlane(planes[i], w, h, w1, h1);
    assert.deepEqual(Array.from(got), Array.from(unb64(ref[i])), `case ${cases[i]}`);
  });
});

await test('quantizer, mosaics, dead zone and apron brick equal format5.py', async () => {
  const b66 = noise(66 ** 3, 5, true);
  const dec = new Uint8Array(b66.length);
  const r = rng(9);
  for (let i = 0; i < dec.length; i++) dec[i] = Math.max(0, Math.min(255, b66[i] + ((r() >>> 20) % 9) - 4 + (b66[i] ? 0 : (r() >>> 28) % 6)));
  const region = noise(70 * 69 * 68, 11, false);
  const ref = python(`
import sys, json, base64, numpy as np, format5 as f5
d = json.load(sys.stdin)
b = np.frombuffer(base64.b64decode(d["b"]), dtype=np.uint8).reshape(66, 66, 66)
dec = np.frombuffer(base64.b64decode(d["dec"]), dtype=np.uint8).reshape(66, 66, 66)
reg = np.frombuffer(base64.b64decode(d["region"]), dtype=np.uint8).reshape(68, 69, 70)
e = lambda a: base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()
print(json.dumps({
  "q2": f5.quantizer(2)[0].tolist(), "q4": f5.quantizer(4)[0].tolist(),
  "m66": e(f5.mosaic66(b)), "m80": e(f5.mosaic80(b)), "dz": f5.dead_zone(b, dec),
  "apron": e(f5.brick_with_apron(reg, 1, 0, 0, (130, 69, 68), (60, 0, 0))),
  "kept": f5.brick_kept(b)}))`, { b: b64(b66), dec: b64(dec), region: b64(region) });
  assert.deepEqual(Array.from(I.quantizerIndex(2)), ref.q2);
  assert.deepEqual(Array.from(I.quantizerIndex(4)), ref.q4);
  const m66 = I.mosaic66(b66), m80 = I.mosaic80(b66);
  assert.deepEqual(Array.from(m66), Array.from(unb64(ref.m66)));
  assert.deepEqual(Array.from(m80), Array.from(unb64(ref.m80)));
  assert.deepEqual(Array.from(I.unmosaic66(m66)), Array.from(b66));
  assert.deepEqual(Array.from(I.unmosaic80(m80)), Array.from(b66));
  assert.equal(I.deadZone(b66, dec), ref.dz);
  assert.equal(I.brickKept(b66), ref.kept);
  const apron = I.brickWithApron(region, 70, 69, { x: 60, y: 0, z: 0 }, { x: 130, y: 69, z: 68 }, 1, 0, 0);
  assert.deepEqual(Array.from(apron), Array.from(unb64(ref.apron)));
});

await test('LPLN and xz/yz packs parse and decode in Python', async () => {
  const W = 700, Hh = 530;
  const plane = noise(W * Hh, 3, true);
  for (let y = 0; y < 512; y++) for (let x = 512; x < W; x++) plane[y * W + x] = 0;   // an all-zero tile
  const tiles = await I.planeTiles(plane, W, Hh);
  assert.equal(tiles.length, 4);
  assert.equal(tiles[1], null);
  const pack = I.planePack(12, 2, 2, tiles);
  const Z = 9, A = 600;
  const images = [noise(Z * A, 21, true), new Uint8Array(Z * A), noise(Z * A, 22, false)];
  const orth = await I.orthPack('yz', 128, images, Z, A);
  const ref = python(`
import sys, json, base64, numpy as np, format5 as f5
d = json.load(sys.stdin)
pack = base64.b64decode(d["pack"])
z, c, tx, ty, entries = f5.parse_plane_pack(pack)
plane = np.zeros((ty * 512, tx * 512), dtype=np.uint8)
for i, (off, ln) in enumerate(entries):
    if ln:
        t = f5.unpng_gray8(pack[off:off + ln])
        r, q = divmod(i, tx)
        plane[r * 512:r * 512 + t.shape[0], q * 512:q * 512 + t.shape[1]] = t
orth = base64.b64decode(d["orth"])
first, count, ta, tz, oe = f5.parse_orth_pack(orth, "yz")
imgs = []
for row in range(count):
    im = np.zeros((tz * 512, ta * 512), dtype=np.uint8)
    for iz in range(tz):
        for ia in range(ta):
            off, ln = oe[(row * tz + iz) * ta + ia]
            if ln:
                t = f5.unpng_gray8(orth[off:off + ln])
                im[iz * 512:iz * 512 + t.shape[0], ia * 512:ia * 512 + t.shape[1]] = t
    imgs.append(base64.b64encode(im[:d["Z"], :d["A"]].tobytes()).decode())
print(json.dumps({"z": z, "c": c, "tx": tx, "ty": ty, "zeros": [ln for _o, ln in entries].count(0),
  "plane": base64.b64encode(plane[:d["H"], :d["W"]].tobytes()).decode(),
  "first": first, "count": count, "ta": ta, "tz": tz, "imgs": imgs,
  "empty": sum(1 for _o, ln in oe if not ln)}))`, { pack: b64(pack), orth: b64(orth), W, H: Hh, Z, A });
  assert.deepEqual([ref.z, ref.c, ref.tx, ref.ty, ref.zeros], [12, 1, 2, 2, 1]);
  assert.deepEqual(Array.from(unb64(ref.plane)), Array.from(plane));
  assert.deepEqual([ref.first, ref.count, ref.ta, ref.tz, ref.empty], [128, 3, 2, 1, 2]);
  images.forEach((im, i) => assert.deepEqual(Array.from(unb64(ref.imgs[i])), Array.from(im)));
});

await test('stage-B blob parses with dataset_migrations._m005_parse_brick_blob', async () => {
  const cols = ['b2', 'b4', 'q80', 'q50'];
  const mk = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + n) & 0xFF);
  const bricks = [
    { bz: 1, by: 0, bx: 2, enc: { b2: mk(3), b4: mk(5), q80: mk(7), q50: mk(2) } },
    { bz: 0, by: 3, bx: 1, enc: { b2: mk(4), b4: mk(1), q80: mk(9), q50: mk(6) } },
  ];
  const blob = I.brickBlob(bricks, cols);
  const ref = python(`
import sys, json, base64, dataset_migrations as dm
d = json.load(sys.stdin)
out = dm._m005_parse_brick_blob(base64.b64decode(d["blob"]), d["cols"])
print(json.dumps({"%d,%d,%d" % k: {c: base64.b64encode(v[c]).decode() for c in d["cols"]} for k, v in out.items()}))`, { blob: b64(blob), cols });
  assert.deepEqual(Object.keys(ref), ['0,3,1', '1,0,2']);
  for (const b of bricks) {
    for (const c of cols) assert.deepEqual(Array.from(unb64(ref[`${b.bz},${b.by},${b.bx}`][c])), Array.from(b.enc[c]));
  }
});

await test('webpSize reads VP8L and VP8 headers', async () => {
  const riff = (chunk, body) => {
    const n = 4 + 8 + body.length + (body.length & 1);
    const out = new Uint8Array(8 + n);
    const dv = new DataView(out.buffer);
    out.set([82, 73, 70, 70]); dv.setUint32(4, n, true); out.set([87, 69, 66, 80], 8);
    out.set([...chunk].map((ch) => ch.charCodeAt(0)), 12); dv.setUint32(16, body.length, true); out.set(body, 20);
    return out;
  };
  const vp8l = new Uint8Array(5); vp8l[0] = 0x2F;
  new DataView(vp8l.buffer).setUint32(1, (593) | (527 << 14), true);
  assert.deepEqual({ ...I.webpSize(riff('VP8L', vp8l)) }, { width: 594, height: 528, lossless: true });
  const vp8 = new Uint8Array(10); vp8.set([0, 0, 0, 0x9D, 0x01, 0x2A]);
  new DataView(vp8.buffer).setUint16(6, 720, true); new DataView(vp8.buffer).setUint16(8, 640, true);
  assert.deepEqual({ ...I.webpSize(riff('VP8 ', vp8)) }, { width: 720, height: 640, lossless: false });
  assert.equal(I.webpSize(new Uint8Array(30)), null);
});

console.log(`${passed} passed`);
