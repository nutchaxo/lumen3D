// Browser-executor worker, web 1.59 (js/workers/migration-worker.js), SPEC §13.5:
//   • `probe` loads the handler, then the handlers it `requires` (m004 → m002), with the ?v=
//     stamp, and answers the handler's verdict;
//   • `prepare` reports the handler's `slotsPerWorker`;
//   • an m004 level-0 unit range-reads the v2 packs and PUTs a brick blob; a level-1 unit reads
//     each level-0 brick it needs back with GET `action=store_get&dataset&migration&brick=
//     t.k.c.z.y.x` (404 `absent` = a dropped brick = zeros) and PUTs bricks equal to the
//     reference reduction of the volume;
//   • a refused `store_get` (409) is a fatal unit failure carrying the server's code.
//
// Run: node tests/js/test_v3_bmig_worker.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const BS = 64, SLAB = 66, MW = 594;
const X = 200, Y = 10, Z = 3;
const vox = (x, y, z) => ((x * 7 + y * 13 + z * 29) % 5 === 0 ? (x * 3 + y * 5 + z * 11 + 1) & 0xFF : 0);

// v2 raw-u8 tree: bricks bx 0..3 (by 0, bz 0), one pack
const brickToPack = {};
const parts = [];
let off = 0;
for (let bx = 0; bx < 4; bx++) {
  const b = new Uint8Array(BS ** 3).fill(0x5A);   // padding garbage past the edge
  for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) for (let x = 0; x < BS; x++) {
    const gx = bx * BS + x;
    if (gx < X) b[(z * BS + y) * BS + x] = vox(gx, y, z);
  }
  brickToPack[`lod0/c0/x00${bx}_y000_z000.webp`] = { url: 'lod0/c0/pack_00.bin', offset: off, length: b.length };
  parts.push(b); off += b.length;
}
const pack = new Uint8Array(off);
{ let o = 0; for (const p of parts) { pack.set(p, o); o += p.length; } }
const manifest = { schema: 'iribhm-bricks-v2', version: 2, channels: 1, brickSize: 64, levels: [{ level: 0, dimensions: { x: X, y: Y, z: Z } }], brickTransport: { mode: 'packs', encoding: 'raw-u8', brickToPack } };

// A minimal RIFF/WEBP file whose VP8L chunk carries a picture id.
function fakeWebp(id, w = 594, h = 528) {
  const b = new Uint8Array(32);
  const dv = new DataView(b.buffer);
  b.set([0x52, 0x49, 0x46, 0x46], 0); dv.setUint32(4, 24, true); b.set([0x57, 0x45, 0x42, 0x50], 8);
  b.set([0x56, 0x50, 0x38, 0x4C], 12); dv.setUint32(16, 12, true);
  b[20] = 0x2F; dv.setUint32(21, ((w - 1) | ((h - 1) << 14)) >>> 0, true); dv.setUint32(25, id, true);
  return b;
}
const fakeWebpId = (u) => new DataView(u.buffer, u.byteOffset, u.byteLength).getUint32(25, true);

function makeWorker(behaviour) {
  const out = [], requests = [], loaded = [];
  const pictures = new Map();
  let nextId = 1;
  function OffscreenCanvas(w, h) {
    this.width = w; this.height = h;
    let px = new Uint8ClampedArray(w * h * 4);
    this.getContext = () => ({
      globalCompositeOperation: '',
      putImageData(img) { px = new Uint8ClampedArray(img.data); },
      drawImage(bmp) { px = new Uint8ClampedArray(bmp.pic.rgba); },
      getImageData(x, y, ww, hh) { return { data: px.slice(0, ww * hh * 4) }; },
    });
    this.convertToBlob = async () => {
      const id = nextId++;
      pictures.set(id, { width: this.width, height: this.height, rgba: new Uint8ClampedArray(px) });
      return new Blob([fakeWebp(id, this.width, this.height)], { type: 'image/webp' });
    };
  }
  const self = {
    location: { href: 'http://h/js/workers/migration-worker.js?v=7' },
    postMessage: (m) => out.push(m), addEventListener() {}, removeEventListener() {}, onmessage: null,
  };
  const ctx = vm.createContext({
    self, console, URL, URLSearchParams, Blob, Response, CompressionStream, DecompressionStream, AbortController, performance,
    setTimeout: (fn) => setTimeout(fn, 0), clearTimeout,
    OffscreenCanvas, ImageData: class { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } },
    createImageBitmap: async (blob) => {
      const u = new Uint8Array(await blob.arrayBuffer());
      const pic = pictures.get(fakeWebpId(u));
      return { width: pic.width, height: pic.height, pic, close() {} };
    },
    fetch: async (url, init = {}) => {
      const req = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body };
      requests.push(req);
      return behaviour(req);
    },
  });
  ctx.importScripts = (rel) => {
    loaded.push(rel);
    const clean = rel.split('?')[0].replace(/^\.\.\//, 'js/');
    vm.runInContext(readFileSync(path.join(ROOT, clean), 'utf8'), ctx, { filename: clean });
  };
  vm.runInContext(readFileSync(path.join(ROOT, 'js/workers/migration-worker.js'), 'utf8'), ctx);
  const send = (m) => self.onmessage({ data: m });
  const wait = async (pred) => { for (let i = 0; i < 5000; i++) { const m = out.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 1)); } throw new Error('timeout'); };
  return { out, requests, loaded, send, wait, pictures };
}

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0) });
const bytes = (u8, status = 206) => ({ ok: status < 400, status, arrayBuffer: async () => u8.slice().buffer, json: async () => ({}) });
const rangeOf = (req) => { const m = /bytes=(\d+)-(\d+)/.exec(req.headers.Range || ''); return [+m[1], +m[2] + 1]; };

function parseBlob(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = dv.getUint32(0, true);
  const out = [];
  let o = 4;
  for (let i = 0; i < n; i++) {
    const len = dv.getUint32(o + 12, true);
    out.push({ bz: dv.getUint32(o, true), by: dv.getUint32(o + 4, true), bx: dv.getUint32(o + 8, true), bytes: u8.slice(o + 16, o + 16 + len) });
    o += 16 + len;
  }
  assert.equal(o, u8.length);
  return out;
}

const stored = new Map();   // level → [{bz,by,bx,bytes}]
let refuseSource = false;
const server = (req) => {
  if (req.url.endsWith('/metadata.json')) return json({ type: '3d' });
  if (req.url.endsWith('/bricks/manifest.json')) return json(manifest);
  if (req.url.includes('pack_00.bin')) { const [s, e] = rangeOf(req); return bytes(pack.subarray(s, e)); }
  if (req.url.includes('action=store_get')) {
    if (refuseSource) return json({ ok: false, error: 'job_not_running' }, 409);
    const q = new URL(req.url).searchParams;
    assert.equal(q.get('dataset'), '3d/ds'); assert.equal(q.get('migration'), 'm004-bricks-v3');
    const m = /^t(\d+)\.k(\d+)\.c(\d+)\.z(\d+)\.y(\d+)\.x(\d+)$/.exec(q.get('brick'));
    const b = (stored.get(+m[2]) || []).find((x) => x.bz === +m[4] && x.by === +m[5] && x.bx === +m[6]);
    return b ? bytes(b.bytes, 200) : json({ error: 'absent' }, 404);
  }
  if (req.url.includes('action=unit_put')) {
    const k = +/\.k(\d+)\./.exec(new URL(req.url).searchParams.get('unit'))[1];
    stored.set(k, (stored.get(k) || []).concat(parseBlob(new Uint8Array(req.body))));
    return json({ ok: true, done: 1, total: 3 });
  }
  return json({}, 404);
};

const w = makeWorker(server);
w.send({ type: 'config', endpoint: 'http://h/api/migrations.php', csrf: 'tok' });

// probe + requires
w.send({ type: 'probe', reqId: 1, migration: 'm004-bricks-v3' });
const pr = await w.wait((m) => m.type === 'probed' && m.reqId === 1);
assert.equal(pr.available, true, JSON.stringify(pr));
assert.deepEqual(w.loaded, ['../core/plane-codec.js?v=7', '../migrations/m004-bricks-v3.js?v=7', '../migrations/m002-planes.js?v=7']);
w.send({ type: 'probe', reqId: 2, migration: 'm003-layer-mips' });
assert.equal((await w.wait((m) => m.type === 'probed' && m.reqId === 2)).available, true);
w.send({ type: 'probe', reqId: 3, migration: 'm999-nothing' });
const none = await w.wait((m) => m.type === 'probed' && m.reqId === 3);
assert.equal(none.available, false); assert.deepEqual([...none.reasons], ['no_handler']);

// prepare
w.send({ type: 'prepare', reqId: 4, migration: 'm004-bricks-v3', dataset: '3d/ds', datasetBase: 'http://h/DATA_WEB/3d/ds/' });
const prep = await w.wait((m) => m.type === 'prepared' && m.reqId === 4);
assert.ok(prep.ok, prep.error);
assert.equal(prep.slotsPerWorker, 1);
w.send({ type: 'list', reqId: 5, migration: 'm004-bricks-v3', dataset: '3d/ds', opts: { sample: true } });
const listed = await w.wait((m) => m.type === 'listed' && m.reqId === 5);
assert.deepEqual([...listed.units.map((u) => u.key)], ['t0.k0.c0.z0.y0.x0']);

// level 0
w.send({ type: 'run', reqId: 6, migration: 'm004-bricks-v3', dataset: '3d/ds', unit: 't0.k0.c0.z0.y0.x0' });
const r0 = await w.wait((m) => (m.type === 'unit_done' || m.type === 'unit_failed') && m.reqId === 6);
assert.equal(r0.type, 'unit_done', r0.error);
assert.deepEqual(stored.get(0).map((b) => b.bx), [0, 1, 2, 3]);

// level 1: one store_get per source brick
const lvl0 = stored.get(0);
w.send({ type: 'run', reqId: 7, migration: 'm004-bricks-v3', dataset: '3d/ds', unit: 't0.k1.c0.z0.y0.x0' });
const r1 = await w.wait((m) => (m.type === 'unit_done' || m.type === 'unit_failed') && m.reqId === 7);
assert.equal(r1.type, 'unit_done', r1.error);
const src = w.requests.filter((r) => r.url.includes('action=store_get'));
assert.deepEqual(src.map((r) => new URL(r.url).searchParams.get('brick')).sort(), ['t0.k0.c0.z0.y0.x0', 't0.k0.c0.z0.y0.x1', 't0.k0.c0.z0.y0.x2', 't0.k0.c0.z0.y0.x3']);
for (const r of src) assert.equal(r.method, 'GET');
assert.equal(r1.bytesIn, lvl0.reduce((s, b) => s + b.bytes.length, 0), 'bytesIn = the bytes of the bricks read');

// reference: level 1 = 100 × 5 × 2 (isotropic default → Z halved)
const X1 = 100, Y1 = 5, Z1 = 2;
const l1 = new Uint8Array(X1 * Y1 * Z1);
for (let z = 0; z < Z1; z++) for (let y = 0; y < Y1; y++) for (let x = 0; x < X1; x++) {
  let s = 0, n = 0;
  for (const zz of [2 * z, 2 * z + 1]) for (const yy of [2 * y, 2 * y + 1]) for (const xx of [2 * x, 2 * x + 1]) {
    if (zz < Z && yy < Y && xx < X) { s += vox(xx, yy, zz); n++; }
  }
  l1[(z * Y1 + y) * X1 + x] = Math.floor((s + Math.floor(n / 2)) / n);
}
const k1 = stored.get(1);
assert.deepEqual(k1.map((b) => b.bx), [0, 1]);
for (const b of k1) {
  const pic = w.pictures.get(fakeWebpId(b.bytes));
  const cl = (v, n) => Math.min(n - 1, Math.max(0, v));
  for (let l = 0; l < SLAB; l++) for (let j = 0; j < SLAB; j++) for (let i = 0; i < SLAB; i++) {
    const p = ((Math.floor(l / 9) * SLAB + j) * MW + (l % 9) * SLAB + i) * 4;
    const exp = l1[(cl(l - 1, Z1) * Y1 + cl(j - 1, Y1)) * X1 + cl(b.bx * BS - 1 + i, X1)];
    if (pic.rgba[p] !== exp) assert.fail(`k1 brick ${b.bx} voxel ${i},${j},${l}: ${pic.rgba[p]} ≠ ${exp}`);
  }
}

// a refused store_get is fatal with the server's code
refuseSource = true;
w.send({ type: 'run', reqId: 8, migration: 'm004-bricks-v3', dataset: '3d/ds', unit: 't0.k1.c0.z0.y0.x0' });
const r2 = await w.wait((m) => (m.type === 'unit_done' || m.type === 'unit_failed') && m.reqId === 8);
assert.equal(r2.type, 'unit_failed');
assert.equal(r2.code, 'job_not_running');
assert.equal(r2.status, 409);
assert.equal(r2.fatal, true);

console.log('migration worker (formats 3/4): OK');
