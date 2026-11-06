// DataAccess reads the timepoint ON SCREEN, not BrickLoader's mounted tree. On a timelapse
// the two differ in normal use: the background prefetch mounts the frames after the one on
// screen (VolumeViewer.loadBrickedVolumeStream with preload), and a cached frame is shown
// without a mount. With the REAL BrickLoader and two frames of one `live` dataset:
//   • frame t000 is shown, the prefetch has mounted t001: readRegion / valueAt return
//     t000's voxels, read from t000's packs;
//   • the prefetch mounts t002 while a read is in flight: the read completes on t000
//     (no BRICKS_MOUNT_CHANGED, no voxel of another frame);
//   • locate() names t000's pack once the frame is pinned;
//   • a frame shown from the cache that was never mounted (or no longer held) is pinned by
//     building its tree, without mounting it; a tree of another dataset is refused
//     (BRICKS_MOUNT_CHANGED), and a pin taken before a dataset switch is refused afterwards;
//   • without VolumeViewer (a page with no volume on screen) the mounted tree is read.
//
// Run: node tests/js/test_data_access_mount_pin.mjs
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

{
  const { BL, requests } = makeWorld();
  // Frame t000 is loaded and shown, then the prefetch mounts t001.
  await BL.init(`${ROOT_URL}/t000`, frames.t000.manifest);
  show('t000');
  await BL.init(`${ROOT_URL}/t001`, frames.t001.manifest);
  assert.equal(BL.getBasePath(), `${ROOT_URL}/t001`, 'the prefetch left t001 mounted');
  const D = loadModule('js/core/data-access.js', 'DataAccess', { BrickLoader: BL, VolumeViewer });
  assert.equal(D.displayedTree().path, `${ROOT_URL}/t000`);
  const r = await D.readRegion({ x0: 60, x1: 70, y0: 0, y1: 4, z0: 0, z1: 2 }, [0]);
  for (let i = 0; i < r.data[0].length; i++) {
    const x = 60 + (i % 10);
    assert.equal(r.data[0][i], FILL.t000 + (x >= BS ? 1 : 0), 'voxels of the frame on screen');
  }
  assert.ok(requests.length > 0 && requests.every(f => f === 't000'), `every read from t000: ${requests.join(', ')}`);
  assert.deepEqual(await D.valueAt({ x: 100, y: 3, z: 9 }, [0]), [FILL.t000 + 1]);
  assert.equal(BL.getBasePath(), `${ROOT_URL}/t001`, 'the read mounted nothing');
  console.log('readRegion reads the frame on screen, not the prefetched mount: OK');

  const loc = D.locate({ x: 70, y: 0, z: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(loc.brick)), { bx: 1, by: 0, bz: 0 });
  assert.equal(loc.pack.offset, BRICK, 'locate answers from the pinned tree on screen');
  console.log('locate answers for the frame on screen: OK');
}

{
  const { BL, requests, hold } = makeWorld();
  await BL.init(`${ROOT_URL}/t000`, frames.t000.manifest);
  show('t000');
  const D = loadModule('js/core/data-access.js', 'DataAccess', { BrickLoader: BL, VolumeViewer });
  // The read's pack request is held while the prefetch mounts t001, then t002.
  const release = hold();
  const read = D.readRegion({ x0: 0, x1: 128, y0: 0, y1: 2, z0: 0, z1: 1 }, [0]);
  for (let i = 0; i < 50 && !requests.length; i++) await new Promise(r => setTimeout(r, 2));
  assert.ok(requests.length > 0, 'the read has asked for its pack');
  await BL.init(`${ROOT_URL}/t001`, frames.t001.manifest);
  await BL.init(`${ROOT_URL}/t002`, frames.t002.manifest);
  release();
  const r = await read;
  for (let i = 0; i < r.data[0].length; i++) {
    assert.equal(r.data[0][i], FILL.t000 + (((i % 128) >= BS) ? 1 : 0), 'the read stays on t000');
  }
  assert.ok(requests.every(f => f === 't000'), `no pack of a prefetched frame: ${requests.join(', ')}`);
  console.log('a timepoint mounted during the read changes nothing: OK');
}

{
  const { BL } = makeWorld();
  await BL.init(`${ROOT_URL}/t001`, frames.t001.manifest);
  const D = loadModule('js/core/data-access.js', 'DataAccess', { BrickLoader: BL });
  assert.equal(D.displayedTree().path, `${ROOT_URL}/t001`, 'no volume on screen: the mounted tree');
  assert.deepEqual(await D.valueAt({ x: 3, y: 3, z: 3 }, [0]), [FILL.t001]);
  console.log('without a volume on screen the mounted tree is read: OK');
}

{
  // A viewer that shows no brick tree (its volumes released by a WebGL context loss,
  // nothing activated yet) while the prefetch left t001 mounted: no tree on screen,
  // and a read is refused rather than answered from the prefetched frame.
  const { BL, requests } = makeWorld();
  await BL.init(`${ROOT_URL}/t000`, frames.t000.manifest);
  show('t000');
  const D = loadModule('js/core/data-access.js', 'DataAccess', { BrickLoader: BL, VolumeViewer });
  assert.deepEqual(await D.valueAt({ x: 3, y: 3, z: 3 }, [0]), [FILL.t000]);
  await BL.init(`${ROOT_URL}/t001`, frames.t001.manifest);
  shown.tree = null;
  const before = requests.length;
  assert.equal(D.displayedTree().path, null, 'nothing on screen: not the mounted t001');
  await assert.rejects(D.valueAt({ x: 3, y: 3, z: 3 }, [0]), (err) => err.code === 'NO_DATASET');
  await assert.rejects(D.pinDisplayed(), (err) => err.code === 'NO_DATASET');
  assert.equal(requests.length, before, 'no pack of the prefetched frame is read');
  show('t000');
  assert.deepEqual(await D.valueAt({ x: 70, y: 3, z: 3 }, [0]), [FILL.t000 + 1], 'the frame back on screen reads again');
  console.log('a viewer showing no tree reads nothing, not the prefetched mount: OK');
}

{
  const { BL, requests } = makeWorld();
  await BL.init(`${ROOT_URL}/t000`, frames.t000.manifest);
  show('t002');
  const D = loadModule('js/core/data-access.js', 'DataAccess', { BrickLoader: BL, VolumeViewer });
  assert.deepEqual(await D.valueAt({ x: 70, y: 1, z: 1 }, [0]), [FILL.t002 + 1], 'a frame never mounted is read from its own tree');
  assert.ok(requests.every(f => f === 't002'), `only t002's pack: ${requests.join(', ')}`);
  assert.equal(BL.getBasePath(), `${ROOT_URL}/t000`, 'pinning it mounted nothing');
  console.log('a cached frame never mounted is pinned without a mount: OK');

  const handle = await BL.pinTree(`${ROOT_URL}/t002`, frames.t002.manifest);
  await assert.rejects(BL.pinTree('DATA_WEB/live/OTHER/bricks/t000', frames.t000.manifest), (err) => err.code === 'BRICKS_MOUNT_CHANGED',
    'a tree of another dataset is not pinned');
  await BL.init('DATA_WEB/live/OTHER/bricks/t000', frames.t000.manifest);
  await assert.rejects(BL.loadBrickTasks([{ lod: 0, channel: 0, bx: 0, by: 0, bz: 0 }], { mount: handle, streamOnly: true }),
    (err) => err.code === 'BRICKS_MOUNT_CHANGED', 'a pin of the previous dataset is refused after a switch');
  assert.throws(() => BL.withMount(handle, () => 0), (err) => err.code === 'BRICKS_MOUNT_CHANGED');
  assert.throws(() => BL.withMount({ grids: new Map() }, () => 0), (err) => err.code === 'BRICKS_BAD_HANDLE', 'only a handle of this loader');
  console.log('pins are scoped to the mounted dataset: OK');
}
