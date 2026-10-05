// Browser handler of migration m002-planes (js/migrations/m002-planes.js), SPEC §3–§5.1:
//   • a grid mosaic is un-mosaicked EXACTLY like js/core/brick-decode-worker.js (the real
//     worker is run on the same synthetic mosaics, full and truncated, cols given or not);
//   • the pack `?v=` stamp equals BrickLoader._packStamp (its source is lifted from
//     brick-loader.js and run on the same transports);
//   • a whole synthetic dataset (3d and live, webp-lossless and raw-u8 bricks, ESS-dropped
//     bricks, edge tiles 88×18, padding garbage past the volume edge, an all-zero plane)
//     is migrated unit by unit through prepare/listUnits/planUnitWork/runUnit; the unit
//     blobs are parsed, every PNG decoded, and the rebuilt planes equal the volume voxel
//     for voxel. Empty units are exactly the ones with no brick; all-zero planes are omitted.
//
// Run: node tests/js/test_mig_client_m002.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const BS = 64;
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));

// ── Fake image stack: a "webp" brick is 4 id bytes + noise; its decoded picture is looked up ──
const pictures = new Map();   // id → { width, height, rgba }
class FakeBlob extends Blob {
  constructor(parts, opts) { super(parts, opts); this._parts = parts; }
}
function blobId(blob) {
  const b = blob._parts[0];
  const u = new Uint8Array(b.buffer || b, b.byteOffset || 0, 4);
  return (u[0] | (u[1] << 8) | (u[2] << 16) | (u[3] << 24)) >>> 0;
}
function imageSandbox(extra = {}) {
  let current = null;
  return {
    Blob: FakeBlob,
    createImageBitmap: async (blob, opts) => {
      assert.equal(opts.premultiplyAlpha, 'none');
      assert.equal(opts.colorSpaceConversion, 'none');
      const pic = pictures.get(blobId(blob));
      assert.ok(pic, 'unknown picture');
      return { width: pic.width, height: pic.height, pic, close() {} };
    },
    OffscreenCanvas: function (w, h) {
      this.width = w; this.height = h;
      this.getContext = () => ({
        globalCompositeOperation: '',
        drawImage(bmp) { current = bmp.pic; },
        getImageData: (x, y, ww, hh) => {
          const out = new Uint8ClampedArray(ww * hh * 4);
          for (let r = 0; r < hh; r++) {
            for (let c = 0; c < ww; c++) {
              const sx = x + c, sy = y + r;
              if (sx < current.width && sy < current.height) {
                const s = (sy * current.width + sx) * 4;
                out.set(current.rgba.subarray(s, s + 4), (r * ww + c) * 4);
              }
            }
          }
          return { data: out };
        },
      });
    },
    ...extra,
  };
}

function loadHandler() {
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, CompressionStream, DecompressionStream, Response,
    ...imageSandbox(),
  });
  vm.runInContext(read('js/core/plane-codec.js'), ctx, { filename: 'plane-codec.js' });
  vm.runInContext(read('js/migrations/m002-planes.js'), ctx, { filename: 'm002-planes.js' });
  vm.runInContext('globalThis.__PC = PlaneCodec;', ctx);
  return { H: ctx.LumenMigrationHandlers['m002-planes'], PC: ctx.__PC };
}
const { H, PC } = loadHandler();
const I = H._internals;

// ── 1. Un-mosaic parity with the real decode worker ──
function runDecodeWorker(pic, packing) {
  const results = [];
  const self = { onmessage: null, postMessage: (m) => results.push(m) };
  const ctx = vm.createContext({ self, console, performance: { now: () => 0 }, ...imageSandbox() });
  vm.runInContext(read('js/core/brick-decode-worker.js'), ctx);
  const id = 0xA0000000 + pictures.size;
  pictures.set(id, pic);
  const buf = new Uint8Array(8); new DataView(buf.buffer).setUint32(0, id, true);
  self.onmessage({ data: { type: 'DECODE', id: 1, buffer: buf.buffer, brickSize: BS, packing } });
  return { results, id, buf };
}
let seed = 99;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 24; };
for (const [w, h] of [[512, 512], [512, 448], [448, 512], [512, 70]]) {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = rnd();
  for (const packing of [{ mode: 'grid', cols: 8, rows: 8 }, { mode: 'grid' }]) {
    const { results, buf } = runDecodeWorker({ width: w, height: h, rgba }, packing);
    for (let i = 0; i < 20 && !results.length; i++) await tick();
    assert.equal(results.length, 1);
    assert.ok(results[0].ok, results[0].message);
    const ref = new Uint8Array(results[0].buffer);
    const ours = I.unmosaicGrid(rgba, w, h, BS, I.gridCols(packing, BS));
    assert.ok(Buffer.from(ours).equals(Buffer.from(ref)), `un-mosaic ${w}x${h} cols=${packing.cols}`);
    // and through the handler's own decode path (createImageBitmap → canvas → R)
    const viaDecode = await I.decodeBrick(buf, { encoding: 'webp-lossless', packing }, 0);
    assert.ok(Buffer.from(viaDecode).equals(Buffer.from(ref)), `decodeBrick ${w}x${h}`);
  }
}

// ── 2. ?v= stamp parity with BrickLoader._packStamp ──
{
  const src = read('js/core/brick-loader.js');
  const m = /function _packStamp\(transport, packSizes\) \{[\s\S]*?\r?\n  \}\r?\n/.exec(src);
  assert.ok(m, '_packStamp found in brick-loader.js');
  const ref = new Function(`${m[0]}; return _packStamp;`)();
  const sizesOf = (t) => {
    const s = new Map();
    for (const k in t.brickToPack) {
      const e = t.brickToPack[k];
      const end = e.offset + e.length;
      if (end > (s.get(e.url) || 0)) s.set(e.url, end);
    }
    return s;
  };
  const b2p = { 'lod0/c0/a.webp': { url: 'lod0/c0/pack_00.bin', offset: 0, length: 10 }, 'lod0/c0/b.webp': { url: 'lod0/c0/pack_00.bin', offset: 10, length: 5 }, 'lod1/c0/c.webp': { url: 'lod1/c0/pack_00.bin', offset: 0, length: 7 } };
  for (const t of [{ brickToPack: b2p }, { brickToPack: b2p, createdAt: '2026-01-01T00:00:00' }, { brickToPack: b2p, packHashes: { 'lod0/c0/pack_00.bin': 'ab', 'lod1/c0/pack_00.bin': 'cd' } }]) {
    assert.equal(I.packStamp(t), ref(t, sizesOf(t)));
  }
}

// ── 3. Whole synthetic datasets ──
const X = 600, Y = 530, Z = 70, C = 2;
function voxel(t, x, y, z, c) {
  if (z === 69) return 0;                        // an all-zero plane: never sent
  return ((x * 7 + y * 13 + z * 31 + c * 101 + t * 50) ^ (x >> 3)) & 0xFF;
}
const dropped = (t, bx, by, bz, c) => (bx + by + bz + c + t) % 5 === 0;   // ESS

function brickVoxels(t, bx, by, bz, c) {
  const out = new Uint8Array(BS * BS * BS);
  for (let z = 0; z < BS; z++) for (let y = 0; y < BS; y++) for (let x = 0; x < BS; x++) {
    const gx = bx * BS + x, gy = by * BS + y, gz = bz * BS + z;
    // Past the volume edge the pipeline pads; garbage there must never reach a plane.
    out[(z * BS + y) * BS + x] = (gx < X && gy < Y && gz < Z) ? voxel(t, gx, gy, gz, c) : 0xEE;
  }
  return out;
}
function mosaicOf(vox) {
  const rgba = new Uint8Array(512 * 512 * 4);
  for (let z = 0; z < BS; z++) for (let y = 0; y < BS; y++) for (let x = 0; x < BS; x++) {
    const px = (z % 8) * BS + x, py = Math.floor(z / 8) * BS + y;
    const i = (py * 512 + px) * 4;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = vox[(z * BS + y) * BS + x];
    rgba[i + 3] = 255;
  }
  return rgba;
}

let nextId = 1;
function buildTree(t, encoding) {
  const nx = Math.ceil(X / BS), ny = Math.ceil(Y / BS), nz = Math.ceil(Z / BS);
  const packs = new Map();
  const brickToPack = {};
  for (let c = 0; c < C; c++) {
    const parts = [];
    let off = 0;
    for (let bz = 0; bz < nz; bz++) for (let by = 0; by < ny; by++) for (let bx = 0; bx < nx; bx++) {
      if (dropped(t, bx, by, bz, c)) continue;
      const vox = brickVoxels(t, bx, by, bz, c);
      let bytes;
      if (encoding === 'raw-u8') bytes = vox;
      else {
        const id = nextId++;
        pictures.set(id, { width: 512, height: 512, rgba: mosaicOf(vox) });
        bytes = new Uint8Array(40 + (id % 13));
        new DataView(bytes.buffer).setUint32(0, id, true);
      }
      const url = `lod0/c${c}/pack_${String(parts.length >> 4).padStart(2, '0')}.bin`;
      const rel = `lod0/c${c}/x${String(bx).padStart(3, '0')}_y${String(by).padStart(3, '0')}_z${String(bz).padStart(3, '0')}.webp`;
      parts.push({ url, bytes });
      brickToPack[rel] = { url, offset: 0, length: bytes.length };
      brickToPack[rel]._p = parts[parts.length - 1];
    }
    // lay out packs
    const byUrl = new Map();
    for (const p of parts) { if (!byUrl.has(p.url)) byUrl.set(p.url, []); byUrl.get(p.url).push(p); }
    for (const [url, list] of byUrl) {
      let o = 0;
      for (const p of list) { p.offset = o; o += p.bytes.length; }
      const buf = new Uint8Array(o);
      for (const p of list) buf.set(p.bytes, p.offset);
      packs.set(url, buf);
    }
    void off;
  }
  for (const k in brickToPack) { brickToPack[k].offset = brickToPack[k]._p.offset; delete brickToPack[k]._p; }
  return {
    packs,
    levels: [{ level: 0, dimensions: { x: X, y: Y, z: Z } }, { level: 1, dimensions: { x: 300, y: 265, z: 35 } }],
    brickTransport: { mode: 'packs', encoding, brickToPack },
  };
}

async function migrate(kind, encoding) {
  const trees = kind === 'live' ? [0, 1] : [0];
  const built = trees.map((t) => buildTree(t, encoding));
  const base = `http://h/DATA_WEB/${kind}/ds/`;
  const manifest = {
    channels: C, brickSize: 64, brickPacking: { mode: 'grid', cols: 8, rows: 8 },
    levels: built[0].levels, brickTransport: built[0].brickTransport,
  };
  if (kind === 'live') {
    manifest.timepoints = {};
    trees.forEach((t, i) => { manifest.timepoints[`t00${t}`] = { path: `t00${t}`, channels: C, levels: built[i].levels, brickTransport: built[i].brickTransport }; });
  }
  const docs = { [`${base}metadata.json`]: { type: kind }, [`${base}bricks/manifest.json`]: manifest };
  const state = await H.prepare({ datasetBase: base.slice(0, -1), fetchJson: async (u) => { assert.ok(u in docs, u); return docs[u]; } });
  assert.equal(state.trees.length, trees.length);

  const rebuilt = trees.map(() => Array.from({ length: C }, () => new Uint8Array(X * Y * Z)));
  const units = H.listUnits(state);
  assert.equal(units.length, trees.length * 2 * C * 2 * 2, 'nz·C·tilesY·tilesX per tree');
  assert.equal(new Set(units.map((u) => u.key)).size, units.length);
  let fetched = 0;
  for (const { key, empty } of units) {
    const u = I.parseUnitKey(key);
    const tree = built[trees.indexOf(u.t)];
    // empty ⇔ no brick of that tile/layer/channel survived ESS
    let any = false;
    for (let by = u.ty * 8; by < Math.min(u.ty * 8 + 8, Math.ceil(Y / BS)); by++) {
      for (let bx = u.tx * 8; bx < Math.min(u.tx * 8 + 8, Math.ceil(X / BS)); bx++) if (!dropped(u.t, bx, by, u.bz, u.c)) any = true;
    }
    assert.equal(empty, !any, `empty flag of ${key}`);
    if (empty) continue;
    const work = H.planUnitWork(key, state);
    assert.equal(work.width, u.tx ? X - 512 : 512);
    assert.equal(work.height, u.ty ? Y - 512 : 512);
    assert.equal(work.depth, u.bz ? Z - 64 : 64);
    const io = {
      fetchRange: async (url, s, e) => {
        const prefix = kind === 'live' ? `${base}bricks/t00${u.t}/` : `${base}bricks/`;
        assert.ok(url.startsWith(prefix), url);
        const m = /^(.*)\?v=([0-9a-z]+)$/.exec(url.slice(prefix.length));
        assert.ok(m, 'stamped pack url ' + url);
        assert.equal(m[2], I.packStamp(tree.brickTransport));
        const pack = tree.packs.get(m[1]);
        assert.ok(pack && e <= pack.length && s < e);
        fetched += e - s;
        return pack.subarray(s, e);
      },
    };
    const res = await H.runUnit(work, state, io);
    assert.equal(res.bytesIn, work.bytesIn);
    const tiles = PC.parseUnitBlob(res.body);
    assert.equal(tiles.length, res.tiles);
    for (const tile of tiles) {
      assert.ok(tile.z >= u.bz * 64 && tile.z < u.bz * 64 + work.depth, 'z inside the layer');
      assert.notEqual(tile.z, 69, 'an all-zero plane is not sent');
      const hdr = PC.readPngHeader(tile.png);
      assert.equal(hdr.width, work.width); assert.equal(hdr.height, work.height); assert.equal(hdr.colorType, 0);
      const d = await PC.decodePngGray(tile.png);
      const vol = rebuilt[trees.indexOf(u.t)][u.c];
      for (let y = 0; y < work.height; y++) {
        vol.set(d.data.subarray(y * work.width, (y + 1) * work.width), (tile.z * Y + u.ty * 512 + y) * X + u.tx * 512);
      }
    }
  }
  // voxel-exact comparison
  for (const t of trees) for (let c = 0; c < C; c++) {
    const vol = rebuilt[trees.indexOf(t)][c];
    let bad = 0;
    for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) {
      const want = dropped(t, x >> 6, y >> 6, z >> 6, c) ? 0 : voxel(t, x, y, z, c);
      if (vol[(z * Y + y) * X + x] !== want) bad++;
    }
    assert.equal(bad, 0, `${kind}/${encoding} t${t} c${c}: ${bad} voxels differ`);
  }
  assert.ok(fetched > 0);
}

await migrate('3d', 'webp-lossless');
await migrate('3d', 'raw-u8');
await migrate('live', 'webp-lossless');

// ── 4. Run merging and refusals ──
{
  const runs = I.mergeRuns([
    { url: 'a', offset: 0, length: 10 }, { url: 'a', offset: 100, length: 10 },
    { url: 'a', offset: 200000, length: 5 }, { url: 'b', offset: 3, length: 4 },
  ], 64 * 1024);
  assert.deepEqual(JSON.parse(JSON.stringify(runs.map((r) => [r.url, r.start, r.end, r.bricks.length]))), [['a', 0, 110, 2], ['a', 200000, 200005, 1], ['b', 3, 7, 1]]);
  assert.throws(() => I.parseUnitKey('t0.z0.c0.y0'), /bad unit key/);
  await assert.rejects(H.prepare({ datasetBase: 'http://h/x', fetchJson: async (u) => (u.endsWith('manifest.json')
    ? { levels: [{ level: 0, dimensions: { x: 1, y: 1, z: 1 } }], brickTransport: { encoding: 'jpeg', brickToPack: {} } } : {}) }), /unsupported brick encoding/);
}

console.log('m002-planes handler: OK');
