// DataAccess.readRegion(box, channels, { handle }) reads the pin the caller already holds
// instead of pinning the tree on screen again (the Studio's advanced view takes one pin at
// open and reads many blocks of it). With the REAL BrickLoader and two frames of one
// `live` dataset:
//   - without `handle` every read pins the tree on screen (BrickLoader.pinTree);
//   - with `handle` no pin is taken: any number of reads, each answered by the given tree;
//   - the given pin keeps being read after the screen moved on to another frame (the frame
//     the caller pinned is the one it gets, never the one on screen);
//   - `handle: null` (a loader that cannot pin) behaves as no option at all.
//
// Run: node tests/js/test_data_access_handle.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

const BS = 64;
const BRICK = BS * BS * BS;
const NX = 2;
const ROOT_URL = 'DATA_WEB/live/T/bricks';
const FRAMES = ['t000', 't001', 't002'];
const FILL = { t000: 11, t001: 22, t002: 33 };

// One raw-u8 tree per frame: NX bricks of one channel, every voxel of frame f = FILL[f] + bx.
function makeFrame(f) {
  const pack = new Uint8Array(NX * BRICK);
  const brickToPack = {};
  const chunks = [];
  for (let bx = 0; bx < NX; bx++) {
    pack.fill(FILL[f] + bx, bx * BRICK, (bx + 1) * BRICK);
    brickToPack[`lod0/c0/x${String(bx).padStart(3, '0')}_y000_z000.webp`] = { url: 'lod0/c0/pack_00.bin', offset: bx * BRICK, length: BRICK };
    chunks.push({ id: `0_0_${bx}` });
  }
  return {
    pack,
    manifest: {
      levels: [{ level: 0, dimensions: { x: NX * BS, y: BS, z: BS }, brickSize: BS, chunks }],
      channels: 1,
      brickTransport: { encoding: 'raw-u8', mode: 'packs', packSize: NX, brickToPack }
    }
  };
}
const frames = Object.fromEntries(FRAMES.map(f => [f, makeFrame(f)]));

function makeWorld() {
  const requests = [];
  let gate = null;
  const fetchImpl = async (url, init = {}) => {
    const [frame, rel] = String(url).split('?')[0].slice(ROOT_URL.length + 1).split(/\/(.+)/);
    requests.push(frame);
    if (gate) await gate.wait;
    const pack = frames[frame]?.pack;
    if (!pack || rel !== 'lod0/c0/pack_00.bin') return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
    const range = init.headers?.Range;
    if (range) {
      const [lo, hi] = range.slice(6).split('-').map(Number);
      return { ok: true, status: 206, headers: { get: (h) => (h === 'Content-Range' ? `bytes ${lo}-${hi}/${pack.length}` : null) }, arrayBuffer: async () => pack.buffer.slice(lo, hi + 1) };
    }
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => pack.buffer.slice(0) };
  };
  const BL = loadModule('js/core/brick-loader.js', 'BrickLoader', {
    document: { createElement: () => ({ getContext: () => ({}) }) },
    navigator: { hardwareConcurrency: 2 },
    performance: { now: () => Date.now() },
    window: {},
    AbortController: globalThis.AbortController,
    DOMException: globalThis.DOMException,
    fetch: fetchImpl
  });
  // A raw-u8 tree delivers whole bricks (a WebP tree's decode worker cuts the task's
  // `region`): the loader seen by DataAccess crops the region the same way, everything
  // else — mounts, pins, reads — is the real BrickLoader.
  const crop = (data, r) => {
    const w = r.x1 - r.x0, h = r.y1 - r.y0, d = r.z1 - r.z0;
    const out = new Uint8Array(w * h * d);
    for (let z = 0; z < d; z++) for (let y = 0; y < h; y++) {
      const s = ((r.z0 + z) * BS + (r.y0 + y)) * BS + r.x0;
      out.set(data.subarray(s, s + w), (z * h + y) * w);
    }
    return out;
  };
  const loader = {
    ...BL,
    loadBrickTasks(tasks, opts) {
      const regions = new Map(tasks.map(t => [`${t.bx}_${t.by}_${t.bz}_${t.channel}`, t.region]));
      return BL.loadBrickTasks(tasks.map(({ region, ...t }) => t), {
        ...opts,
        onBrickLoaded: (row) => opts.onBrickLoaded({ ...row, data: crop(row.data, regions.get(`${row.bx}_${row.by}_${row.bz}_${row.channel}`)) })
      });
    }
  };
  return {
    BL: loader, requests,
    hold() { let open; gate = { wait: new Promise(r => { open = r; }) }; return () => { gate = null; open(); }; }
  };
}


const shown = { tree: null };
const VolumeViewer = { getDisplayedTree: () => shown.tree, getPhysicalSize: () => null };
const show = (f) => { shown.tree = { path: `${ROOT_URL}/${f}`, manifest: frames[f].manifest }; };
const countingLoader = (BL) => {
  const calls = { pin: 0 };
  return { calls, loader: { ...BL, pinTree: (...args) => { calls.pin++; return BL.pinTree(...args); } } };
};
const box = { x0: 60, x1: 70, y0: 0, y1: 4, z0: 0, z1: 2 };
const expectFrame = (data, f) => {
  for (let i = 0; i < data.length; i++) assert.equal(data[i], FILL[f] + ((60 + (i % 10)) >= BS ? 1 : 0), `voxel ${i} of ${f}`);
};

{
  const { BL, requests } = makeWorld();
  await BL.init(`${ROOT_URL}/t000`, frames.t000.manifest);
  show('t000');
  const { calls, loader } = countingLoader(BL);
  const D = loadModule('js/core/data-access.js', 'DataAccess', { BrickLoader: loader, VolumeViewer });
  await D.readRegion(box, [0]);
  await D.readRegion(box, [0]);
  assert.equal(calls.pin, 2, 'without a handle every read pins the tree on screen');

  calls.pin = 0;
  const handle = await D.pinDisplayed();
  assert.equal(calls.pin, 1);
  calls.pin = 0;
  for (let i = 0; i < 4; i++) expectFrame((await D.readRegion(box, [0], { handle })).data[0], 't000');
  assert.equal(calls.pin, 0, 'with a handle no pin is taken, however many blocks are read');
  assert.ok(requests.every(f => f === 't000'));
  console.log('readRegion with a handle takes no pin of its own: OK');

  // The screen moves on to frame t001 (and the prefetch mounts it): the pinned frame is still the one read.
  show('t001');
  await BL.init(`${ROOT_URL}/t001`, frames.t001.manifest);
  requests.length = 0;
  expectFrame((await D.readRegion(box, [0], { handle })).data[0], 't000');
  assert.ok(requests.length === 0 || requests.every(f => f === 't000'), `the pinned frame's packs only: ${requests.join(', ')}`);
  assert.deepEqual(await D.valueAt({ x: 100, y: 3, z: 9 }, [0], { handle }), [FILL.t000 + 1], 'valueAt forwards the handle');
  expectFrame((await D.readRegion(box, [0])).data[0], 't001');
  console.log('a given pin keeps its frame after the screen moved on: OK');
}

{
  // A handle of a dataset that is no longer mounted is refused by the loader, not read.
  const { BL } = makeWorld();
  await BL.init(`${ROOT_URL}/t000`, frames.t000.manifest);
  show('t000');
  const D = loadModule('js/core/data-access.js', 'DataAccess', { BrickLoader: BL, VolumeViewer });
  const handle = await D.pinDisplayed();
  await BL.init('DATA_WEB/live/OTHER/bricks/t000', frames.t000.manifest);
  await assert.rejects(D.readRegion(box, [0], { handle }), (err) => err.code === 'BRICKS_MOUNT_CHANGED', 'a stale pin is refused');
  console.log('a pin of a switched dataset is refused: OK');
}

{
  // handle: null / undefined = not given.
  const { BL } = makeWorld();
  await BL.init(`${ROOT_URL}/t000`, frames.t000.manifest);
  show('t000');
  const { calls, loader } = countingLoader(BL);
  const D = loadModule('js/core/data-access.js', 'DataAccess', { BrickLoader: loader, VolumeViewer });
  expectFrame((await D.readRegion(box, [0], { handle: null })).data[0], 't000');
  expectFrame((await D.readRegion(box, [0], { handle: undefined })).data[0], 't000');
  assert.equal(calls.pin, 2);
  console.log('a missing handle pins as before: OK');
}

console.log('DataAccess handle option: OK');
