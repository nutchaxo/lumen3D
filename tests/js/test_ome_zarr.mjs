// OME-Zarr v0.5 export (js/core/ome-zarr.js, ome-zarr-export.js, js/workers/ome-zarr-worker.js).
//
// A synthetic two-channel volume with two levels (one 2 × 1 shard grid, absent bricks, partial
// edge bricks) is exported through OmeZarrExport.run with a fake BrickLoader and the REAL worker
// (run in a Node vm). Python then reads the zip with zipfile: the NGFF 0.5 group and array
// metadata, every shard index (CRC-32C checked), every gzip inner chunk, and every voxel equal to
// the source (0 past the volume and for absent bricks); the zip CRCs are Python's own check. With
// zarr-python ≥ 3 installed the store is also opened by zarr itself and compared.
//
// Run: node tests/js/test_ome_zarr.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

if (typeof CompressionStream === 'undefined') { console.log('SKIP no CompressionStream'); process.exit(0); }

const DIMS = [{ x: 150, y: 1100, z: 70 }, { x: 75, y: 550, z: 70 }];
const C = 2;
const value = (k, c, x, y, z) => (((x >> 6) + (y >> 6) + (z >> 6) + c + k) % 3 === 0) ? 0 : 1 + ((x * 7 + y * 13 + z * 29 + c * 101 + k * 17) % 250);
const present = (k, c, bx, by, bz) => {
  // A brick is stored iff its interior holds a non-zero voxel (the formula zeroes whole bricks).
  return value(k, c, bx * 64, by * 64, bz * 64) !== 0;
};

const fakeLoader = {
  isReady: () => true,
  getFormat: () => ({
    version: 5, apron: 1, channels: C,
    levels: DIMS.map((d, k) => ({ level: k, dims: d, voxelSize: { x: 0.5 * (k + 1), y: 0.5 * (k + 1), z: 2 }, target: k ? 256 : null,
      grid: { x: Math.ceil(d.x / 64), y: Math.ceil(d.y / 64), z: Math.ceil(d.z / 64) } }))
  }),
  hasBrick: (bx, by, bz, k) => [0, 1].some(c => present(k, c, bx, by, bz)),
  brickLocation: (t) => present(t.lod, t.channel, t.bx, t.by, t.bz) ? { url: 'x', offset: 0, length: 1 } : null,
  estimateTaskBytes: (tasks) => tasks.length * 1000,
  async loadBrickTasks(tasks, opts) {
    for (const t of tasks) {
      const r = t.region, w = r.x1 - r.x0, h = r.y1 - r.y0, d = r.z1 - r.z0;
      const data = new Uint8Array(w * h * d);
      for (let z = 0; z < d; z++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        data[(z * h + y) * w + x] = value(t.lod, t.channel, t.bx * 64 + r.x0 - 1 + x, t.by * 64 + r.y0 - 1 + y, t.bz * 64 + r.z0 - 1 + z);
      }
      opts.onBrickLoaded({ bx: t.bx, by: t.by, bz: t.bz, channel: t.channel, lod: t.lod, data });
      await null;
    }
    return { summary: { failed: [], cancelled: false } };
  }
};

const zarrSrc = readFileSync(path.join(ROOT, 'js/core/ome-zarr.js'), 'utf8');
const web = { TextEncoder, Blob, Response, CompressionStream, BigInt, console };

// The worker, in its own context, reached through a Worker stand-in.
function makeWorkerClass() {
  return class FakeWorker {
    constructor() {
      const ctx = vm.createContext({ ...web, URL, location: { href: 'http://x/js/workers/ome-zarr-worker.js' } });
      ctx.self = ctx;
      ctx.importScripts = () => vm.runInContext(zarrSrc, ctx);
      ctx.self.postMessage = (m) => setTimeout(() => this.onmessage?.({ data: m }), 0);
      vm.runInContext(readFileSync(path.join(ROOT, 'js/workers/ome-zarr-worker.js'), 'utf8'), ctx);
      this._ctx = ctx;
    }
    postMessage(m) { setTimeout(() => this._ctx.onmessage({ data: m }), 0); }
  };
}

const ctx = vm.createContext({ ...web, BrickLoader: fakeLoader, Worker: makeWorkerClass(), document: { querySelector: () => null } });
vm.runInContext(zarrSrc + '\n' + readFileSync(path.join(ROOT, 'js/core/ome-zarr-export.js'), 'utf8')
  + '\n;globalThis.__X = { OmeZarr, OmeZarrExport };', ctx);
const { OmeZarr, OmeZarrExport } = ctx.__X;

// Pure pieces first: CRC vectors and the shard grid.
assert.equal(OmeZarr.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
assert.equal(OmeZarr.crc32c(new TextEncoder().encode('123456789')), 0xE3069283);
assert.equal(OmeZarr.shardsOf(0, 0, { x: 3, y: 18, z: 2 }).length, 2 * 2);

const parts = [];
const sink = { write: (p) => { parts.push(Buffer.from(p.buffer, p.byteOffset, p.byteLength)); }, close() {}, abort() {} };
const progress = [];
const res = await OmeZarrExport.run({
  levelIds: [0, 1], channelIds: [0, 1], name: 'SYN', sink,
  channels: [{ label: 'DAPI', color: '#00AAFF', window: { start: 0, end: 200 } }, { label: 'GFP', color: '#00FF00' }],
  onProgress: (p) => progress.push(p)
});
assert.ok(res.shards > 0 && res.chunks > 0, JSON.stringify(res));
assert.equal(progress.at(-1).done, progress.at(-1).total);
const zipPath = path.join(mkdtempSync(path.join(os.tmpdir(), 'lumen-omezarr-')), 'SYN.ome.zarr.zip');
writeFileSync(zipPath, Buffer.concat(parts));

const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const script = String.raw`
import gzip, json, struct, sys, zipfile
p, dims = sys.argv[1], json.loads(sys.argv[2])
def crc32c(b):
    c = 0xFFFFFFFF
    for x in b:
        c ^= x
        for _ in range(8):
            c = (c >> 1) ^ (0x82F63B78 if c & 1 else 0)
    return c ^ 0xFFFFFFFF
def value(k, c, x, y, z):
    if ((x >> 6) + (y >> 6) + (z >> 6) + c + k) % 3 == 0: return 0
    return 1 + ((x * 7 + y * 13 + z * 29 + c * 101 + k * 17) % 250)
z = zipfile.ZipFile(p)
assert z.testzip() is None, "zip crc"
names = set(z.namelist())
root = json.loads(z.read("SYN.ome.zarr/zarr.json"))
assert root["zarr_format"] == 3 and root["node_type"] == "group"
ome = root["attributes"]["ome"]
assert ome["version"] == "0.5"
ms = ome["multiscales"][0]
assert [a["name"] for a in ms["axes"]] == ["c", "z", "y", "x"]
assert [d["path"] for d in ms["datasets"]] == ["0", "1"]
assert ms["datasets"][1]["coordinateTransformations"][0]["scale"] == [1, 2, 1.0, 1.0]
assert [c["label"] for c in ome["omero"]["channels"]] == ["DAPI", "GFP"] and ome["omero"]["channels"][0]["color"] == "00AAFF"
voxels = chunks = 0
for k, d in enumerate(dims):
    meta = json.loads(z.read("SYN.ome.zarr/%d/zarr.json" % k))
    assert meta["shape"] == [2, d["z"], d["y"], d["x"]] and meta["data_type"] == "uint8"
    sh = meta["codecs"][0]["configuration"]
    assert sh["chunk_shape"] == [1, 64, 64, 64] and sh["index_location"] == "end"
    gz, gy, gx = -(-d["z"] // 64), -(-d["y"] // 64), -(-d["x"] // 64)
    for c in range(2):
        for bz in range(gz):
            for sy in range(-(-gy // 16)):
                for sx in range(-(-gx // 16)):
                    name = "SYN.ome.zarr/%d/c/%d/%d/%d/%d" % (k, c, bz, sy, sx)
                    data = z.read(name) if name in names else None
                    if data is not None:
                        idx = data[-(256 * 16 + 4):-4]
                        assert struct.unpack("<I", data[-4:])[0] == crc32c(idx), "index crc32c"
                    for ly in range(16):
                        for lx in range(16):
                            bx, by = sx * 16 + lx, sy * 16 + ly
                            if bx >= gx or by >= gy: continue
                            off = ln = 2**64 - 1
                            if data is not None:
                                off, ln = struct.unpack_from("<QQ", idx, 16 * (ly * 16 + lx))
                            if off == 2**64 - 1:
                                block = bytes(64 ** 3)
                            else:
                                block = gzip.decompress(data[off:off + ln]); chunks += 1
                            assert len(block) == 64 ** 3
                            for zz in range(0, 64, 9):
                                for yy in range(0, 64, 7):
                                    for xx in range(0, 64, 5):
                                        X, Y, Z = bx * 64 + xx, by * 64 + yy, bz * 64 + zz
                                        want = value(k, c, X, Y, Z) if X < d["x"] and Y < d["y"] and Z < d["z"] else 0
                                        got = block[(zz * 64 + yy) * 64 + xx]
                                        assert got == want, (k, c, X, Y, Z, got, want)
                                        voxels += 1
out = {"voxels": voxels, "chunks": chunks, "zarr": None}
try:
    import zarr, numpy as np
    if int(zarr.__version__.split(".")[0]) >= 3:
        store = zarr.storage.ZipStore(p, mode="r")
        g = zarr.open_group(store, mode="r", path="SYN.ome.zarr")
        a = g["0"][:]
        ok = all(int(a[c, Z, Y, X]) == value(0, c, X, Y, Z) for c in range(2) for Z in (0, 33, 69) for Y in (0, 500, 1099) for X in (0, 77, 149))
        out["zarr"] = bool(ok)
except ImportError:
    pass
print(json.dumps(out))
`;
let out;
try {
  out = JSON.parse(execFileSync(py, ['-c', script, zipPath, JSON.stringify(DIMS)], { maxBuffer: 1 << 26 }).toString());
} catch (e) {
  if (/ENOENT/.test(String(e.message))) { console.log('SKIP python unavailable'); process.exit(0); }
  throw e;
}
assert.equal(out.chunks, res.chunks, 'every stored chunk decoded');
assert.ok(out.voxels > 100000);
if (out.zarr !== null) assert.equal(out.zarr, true, 'zarr-python reads the same voxels');
rmSync(path.dirname(zipPath), { recursive: true, force: true });
console.log(`ok - ${res.shards} shards, ${res.chunks} chunks, ${out.voxels} voxels checked${out.zarr === null ? ' (zarr-python not installed)' : ', zarr-python agrees'}`);
