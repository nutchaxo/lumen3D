// The Studio's native slice loads one voxel plane (or a thin slab) of every LOD0
// brick the plane crosses, not whole bricks:
//   • the decode worker un-mosaics only the requested voxel box (`region`) of a
//     grid-packed brick, z-major, and returns the full brick when no box is asked;
//   • BrickLoader forwards `region` on every task row and never caches a brick that
//     was requested as a box (a partial brick in the LRU would be read as a whole one);
//   • SVRManager.writeRgbaBrickRegion uploads that box into the slot, points the page
//     table at the slot, and clears the entry again when the GPU upload fails.
//
// Run: node tests/js/test_native_slice_region.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadModule, ROOT } from './harness.mjs';

const tick = () => new Promise((r) => setTimeout(r, 0));
// Objects that cross a vm realm carry that realm's prototypes: compare them as plain data.
const plain = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
const BS = 64;
const COLS = 8;
// Every voxel of the synthetic brick has a value that depends on (z, y, x) alone, so a
// mis-placed row, column or tile is caught wherever it lands.
const expectedVoxel = (z, y, x) => (z * BS * BS + y * BS + x) % 251;

// ── decode worker with an (x, y)-aware getImageData stub ───────────────────────
const WORKER_SRC = readFileSync(path.join(ROOT, 'js/core/brick-decode-worker.js'), 'utf8');
function makeWorker(bmpWidth = 512, bmpHeight = 512) {
  const results = [];
  const reads = [];
  let pending = null;
  const self = { onmessage: null, postMessage: (m) => results.push(m) };
  const sandbox = {
    self, console,
    performance: { now: () => 0 },
    Blob: function () {},
    createImageBitmap: () => new Promise((res) => { pending = res; }),
    OffscreenCanvas: function (w, h) {
      this.width = w; this.height = h;
      this.getContext = () => ({
        globalCompositeOperation: '', drawImage() {},
        getImageData: (x, y, ww, hh) => {
          reads.push([x, y, ww, hh]);
          const data = new Uint8ClampedArray(ww * hh * 4);
          for (let py = 0; py < hh; py++) {
            for (let px = 0; px < ww; px++) {
              const gx = x + px;
              const gy = y + py;
              const z = Math.floor(gy / BS) * COLS + Math.floor(gx / BS);
              data[(py * ww + px) * 4] = expectedVoxel(z, gy % BS, gx % BS);
            }
          }
          return { data };
        },
      });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(WORKER_SRC, sandbox, { filename: 'brick-decode-worker.js' });
  return {
    async decode(id, region) {
      self.onmessage({ data: { type: 'DECODE', id, buffer: new ArrayBuffer(0), brickSize: BS, packing: { mode: 'grid', cols: COLS }, region } });
      await tick();
      pending({ width: bmpWidth, height: bmpHeight, close() {} });
      await tick(); await tick();
      const r = results.find((m) => m.type === 'DECODE_RESULT' && m.id === id);
      assert.ok(r && r.ok, `decode ${id} succeeded`);
      return { bytes: new Uint8Array(r.buffer), region: r.region, reads: reads.splice(0) };
    },
  };
}

{
  const w = makeWorker();

  // T1: no region -> the whole brick, unchanged layout.
  const full = await w.decode(1, undefined);
  assert.equal(full.bytes.length, BS * BS * BS, 'full brick length');
  assert.equal(full.region, null, 'no region echoed for a full decode');
  assert.equal(full.bytes[0], expectedVoxel(0, 0, 0));
  assert.equal(full.bytes[9 * BS * BS + 3 * BS + 5], expectedVoxel(9, 3, 5));
  assert.equal(full.bytes[63 * BS * BS + 63 * BS + 63], expectedVoxel(63, 63, 63));
  assert.deepEqual(full.reads, [[0, 0, 512, 512]], 'full decode reads the whole mosaic once');

  // T2: three z planes (an XY slice with one voxel of slack each side) -> compact, z-major.
  const zs = await w.decode(2, { x0: 0, x1: BS, y0: 0, y1: BS, z0: 9, z1: 12 });
  assert.equal(zs.bytes.length, 3 * BS * BS, 'three planes');
  assert.deepEqual(plain(zs.region), { x0: 0, x1: BS, y0: 0, y1: BS, z0: 9, z1: 12 }, 'region echoed');
  for (let z = 9; z < 12; z++) {
    for (let y = 0; y < BS; y++) {
      for (let x = 0; x < BS; x++) {
        const got = zs.bytes[(z - 9) * BS * BS + y * BS + x];
        if (got !== expectedVoxel(z, y, x)) assert.fail(`voxel (${z},${y},${x}) = ${got}, expected ${expectedVoxel(z, y, x)}`);
      }
    }
  }
  // Tiles 9..11 all sit on mosaic row 1: only that row of the image is read back.
  assert.deepEqual(zs.reads, [[0, 64, 512, 64]], 'reads only the tile row that holds z 9..11');

  // T3: a corner box of the last tile (tile (7,7)).
  const corner = await w.decode(3, { x0: 5, x1: 7, y0: 60, y1: 64, z0: 63, z1: 64 });
  assert.equal(corner.bytes.length, 2 * 4 * 1);
  for (let y = 60; y < 64; y++) for (let x = 5; x < 7; x++) {
    assert.equal(corner.bytes[(y - 60) * 2 + (x - 5)], expectedVoxel(63, y, x), `corner voxel (63,${y},${x})`);
  }

  // T4: three y rows across every z (an XZ slice): all 64 tiles, three rows each.
  const rows = await w.decode(4, { x0: 0, x1: BS, y0: 20, y1: 23, z0: 0, z1: BS });
  assert.equal(rows.bytes.length, BS * 3 * BS);
  for (let z = 0; z < BS; z += 7) for (let y = 20; y < 23; y++) for (let x = 0; x < BS; x += 5) {
    assert.equal(rows.bytes[z * 3 * BS + (y - 20) * BS + x], expectedVoxel(z, y, x), `row voxel (${z},${y},${x})`);
  }
  assert.deepEqual(rows.reads, [[0, 0, 512, 512]], 'a box spanning every tile row reads the whole mosaic');

  // T5: a box that covers everything is a full brick, not a region.
  const whole = await w.decode(5, { x0: 0, x1: BS, y0: 0, y1: BS, z0: 0, z1: BS });
  assert.equal(whole.bytes.length, BS * BS * BS);
  assert.equal(whole.region, null);

  // T6: a malformed box (empty range) falls back to the full brick rather than failing.
  const bad = await w.decode(6, { z0: 12, z1: 9 });
  assert.equal(bad.bytes.length, BS * BS * BS, 'empty range -> full brick');
  assert.equal(bad.region, null);

  // T7: a mosaic too small for the requested tiles never reads out of bounds.
  const small = makeWorker(256, 256);
  const clipped = await small.decode(7, { x0: 0, x1: BS, y0: 0, y1: BS, z0: 9, z1: 12 });
  assert.equal(clipped.bytes.length, 3 * BS * BS, 'clipped decode still delivers the box');
  console.log('decode worker region: OK');
}

// ── BrickLoader forwards `region` and never caches a partial brick ──────────────
{
  const brick = new Uint8Array(BS * BS * BS);
  const BL = loadModule('js/core/brick-loader.js', 'BrickLoader', {
    document: { createElement: () => ({ getContext: () => ({}) }) },
    navigator: { hardwareConcurrency: 1 },
    performance: { now: () => Date.now() },
    window: {},
    AbortController: globalThis.AbortController,
    DOMException: globalThis.DOMException,
    fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => brick.buffer.slice(0) }),
  });
  BL.init('DATA_WEB/3d/R/bricks', {
    levels: [{ level: 0, dimensions: { x: BS, y: BS, z: BS }, brickSize: BS, chunks: [{ id: '0_0_0' }] }],
    channels: 1, brickTransport: { encoding: 'raw-u8', mode: 'direct' },
  });
  const rows = [];
  const region = { x0: 0, x1: BS, y0: 0, y1: BS, z0: 30, z1: 33 };
  await BL.loadBrickTasks([{ lod: 0, channel: 0, bx: 0, by: 0, bz: 0, region }],
    { cacheResults: true, onBrickLoaded: (row) => rows.push(row) });
  assert.equal(rows.length, 1, 'one row delivered');
  assert.deepEqual(plain(rows[0].region), region, 'the task region rides on the row');
  assert.equal(rows[0].data.length, BS * BS * BS, 'a raw transport still delivers the whole brick');
  assert.equal(BL.getCacheStats().entries, 0, 'a brick requested as a box is never cached');

  rows.length = 0;
  await BL.loadBrickTasks([{ lod: 0, channel: 0, bx: 0, by: 0, bz: 0 }],
    { cacheResults: true, onBrickLoaded: (row) => rows.push(row) });
  assert.equal(rows[0].region, null, 'no region -> null on the row');
  assert.equal(BL.getCacheStats().entries, 1, 'a whole brick is cached as before');

  rows.length = 0;
  await BL.loadBrickTasks([{ lod: 0, channel: 0, bx: 0, by: 0, bz: 0, region }],
    { cacheResults: true, onBrickLoaded: (row) => rows.push(row) });
  assert.equal(rows[0].fromCache, true, 'a cached whole brick serves a region task');
  assert.deepEqual(plain(rows[0].region), region, 'and the row still says which box was asked');
  console.log('BrickLoader region pass-through: OK');
}

// ── SVRManager.writeRgbaBrickRegion ────────────────────────────────────────────
{
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, window: {} });
  vm.runInContext(readFileSync(path.join(ROOT, 'js/vendor/three.min.js'), 'utf8'), ctx, { filename: 'three.min.js' });
  vm.runInContext(readFileSync(path.join(ROOT, 'js/core/svr-manager.js'), 'utf8') + '\n;globalThis.__SVR = SVRManager;', ctx, { filename: 'svr-manager.js' });
  const SVRManager = ctx.__SVR;

  const calls = [];
  let nextError = 0;
  const GL = {
    NO_ERROR: 0, TEXTURE_3D: 1, TEXTURE_MIN_FILTER: 2, TEXTURE_MAG_FILTER: 3, NEAREST: 4,
    TEXTURE_WRAP_S: 5, TEXTURE_WRAP_T: 6, TEXTURE_WRAP_R: 7, CLAMP_TO_EDGE: 8, UNPACK_ALIGNMENT: 9,
    UNPACK_ROW_LENGTH: 10, UNPACK_IMAGE_HEIGHT: 11, UNPACK_SKIP_PIXELS: 12, UNPACK_SKIP_ROWS: 13,
    UNPACK_SKIP_IMAGES: 14, PIXEL_UNPACK_BUFFER: 15, RGBA8: 16, RGBA: 17, UNSIGNED_BYTE: 18, TEXTURE_BINDING_3D: 19,
    createTexture: () => ({}), bindTexture() {}, texParameteri() {}, pixelStorei() {}, bindBuffer() {}, deleteTexture() {},
    texStorage3D: (...a) => { calls.push(['texStorage3D', ...a.slice(3)]); }, texImage3D() {},
    getParameter: () => null,
    getError: () => { const e = nextError; nextError = 0; return e; },
    texSubImage3D: (target, level, x, y, z, w, h, d, fmt, type, data) => { calls.push(['texSubImage3D', x, y, z, w, h, d, data.length]); },
  };
  const props = new Map();
  const renderer = {
    getContext: () => GL,
    capabilities: { max3DTextureSize: 2048 },
    properties: { get: (o) => { if (!props.has(o)) props.set(o, {}); return props.get(o); } },
  };
  const uniform = () => ({ value: null });
  const material = { defines: {}, uniforms: {
    pageTable: uniform(), atlasDim: uniform(), volumeDim: uniform(), ptDim: uniform(), ptScale: uniform(), brickSize: uniform(), svrPageCount: uniform(),
    svrAtlas0: uniform(), svrAtlas1: uniform(), svrAtlas2: uniform(), svrAtlas3: uniform(), svrAtlas4: uniform(), svrAtlas5: uniform(), svrAtlas6: uniform(), svrAtlas7: uniform(),
  } };

  const svr = new SVRManager();
  svr.init(4, { x: 200, y: 130, z: 70 }, renderer, material, { targetSlots: 8 });
  assert.equal(svr.maxSlots, 64, 'smallest atlas that fits 8 bricks (256^3 = 64 slots)');
  calls.length = 0;

  const box = new Uint8Array(BS * BS * 3 * 4).fill(7);
  assert.equal(svr.writeRgbaBrickRegion(3, 2, 1, box, 0, 0, 17, BS, BS, 3), true, 'region upload accepted');
  const slot = svr.brickMap.get('3_2_1');
  const coord = svr._slotCoord(slot);
  assert.deepEqual(calls, [['texSubImage3D', coord.x * BS, coord.y * BS, coord.z * BS + 17, BS, BS, 3, BS * BS * 3 * 4]],
    'only the three planes are uploaded, at the slot origin plus the box offset');
  const ptIdx = (1 * svr.ptNx * svr.ptNy + 2 * svr.ptNx + 3) * 4;
  assert.deepEqual(Array.from(svr.pageData.subarray(ptIdx, ptIdx + 4)), [coord.x, coord.y, coord.z, coord.atlas + 1], 'page table points at the slot');

  // A box outside the brick, or too little data, is refused before touching anything.
  calls.length = 0;
  assert.equal(svr.writeRgbaBrickRegion(0, 0, 0, box, 0, 0, 62, BS, BS, 3), false, 'box past the brick end refused');
  assert.equal(svr.writeRgbaBrickRegion(0, 0, 0, box.subarray(0, 10), 0, 0, 0, BS, BS, 3), false, 'short data refused');
  assert.equal(calls.length, 0, 'nothing uploaded for a refused box');
  assert.equal(svr.brickMap.has('0_0_0'), false, 'no slot taken for a refused box');

  // A GL error on the upload clears the page-table entry: the shader must see "no brick".
  nextError = 1;
  assert.equal(svr.writeRgbaBrickRegion(1, 1, 0, box, 0, 0, 0, BS, BS, 3), false, 'GL error reported');
  const ptIdx2 = (0 * svr.ptNx * svr.ptNy + 1 * svr.ptNx + 1) * 4;
  assert.equal(svr.pageData[ptIdx2 + 3], 0, 'failed upload leaves the entry empty');
  console.log('SVRManager.writeRgbaBrickRegion: OK');
}

console.log('native slice region: OK');
