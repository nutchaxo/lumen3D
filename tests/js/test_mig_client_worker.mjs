// Browser-executor worker (js/workers/migration-worker.js), SPEC §5.1, §6-A:
//   • loads plane-codec + the handler named by the migration id (importScripts, ?v= kept);
//   • a unit: Range requests on the stamped pack URLs, then ONE POST unit_put with the query
//     dataset/migration/unit/dry, the CSRF header, an octet-stream body = the unit blob;
//   • a 503 is retried with back-off; a dropped connection waits for the link (net offline →
//     online) without spending attempts; a 4xx is fatal at once; 401 carries its status;
//   • a host answering 200 to a Range request: the asked bytes are sliced from the whole pack;
//   • abort stops a unit in flight; bad migration ids are refused.
//
// Run: node tests/js/test_mig_client_worker.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const BS = 64;
const X = 70, Y = 66, Z = 10;
const vox = (x, y, z) => (x * 3 + y * 5 + z * 7 + 1) & 0xFF;

// one raw-u8 tree: bricks (bx,by) for bx,by in 0..1, bz 0; all in one pack
const brickToPack = {};
const parts = [];
let off = 0;
for (let by = 0; by < 2; by++) for (let bx = 0; bx < 2; bx++) {
  const b = new Uint8Array(BS * BS * BS);
  for (let z = 0; z < BS; z++) for (let y = 0; y < BS; y++) for (let x = 0; x < BS; x++) {
    const gx = bx * BS + x, gy = by * BS + y;
    b[(z * BS + y) * BS + x] = gx < X && gy < Y && z < Z ? vox(gx, gy, z) : 0;
  }
  brickToPack[`lod0/c0/x00${bx}_y00${by}_z000.webp`] = { url: 'lod0/c0/pack_00.bin', offset: off, length: b.length };
  parts.push(b); off += b.length;
}
const pack = new Uint8Array(off);
{ let o = 0; for (const p of parts) { pack.set(p, o); o += p.length; } }
const manifest = { channels: 1, brickSize: 64, levels: [{ level: 0, dimensions: { x: X, y: Y, z: Z } }], brickTransport: { mode: 'packs', encoding: 'raw-u8', brickToPack } };

function makeWorker(behaviour) {
  const out = [];
  const requests = [];
  const listeners = {};
  const self = {
    location: { href: 'http://h/js/workers/migration-worker.js?v=7' },
    postMessage: (m) => out.push(m),
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    removeEventListener: (ev, fn) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); },
    onmessage: null,
  };
  const loaded = [];
  const ctx = vm.createContext({
    self, console, URL, URLSearchParams, Blob, Response, CompressionStream, DecompressionStream,
    AbortController, performance,
    setTimeout: (fn) => setTimeout(fn, 0), clearTimeout,
    fetch: async (url, init = {}) => {
      const req = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body };
      requests.push(req);
      if (init.signal && init.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return behaviour(req, requests);
    },
  });
  ctx.self = self;
  ctx.importScripts = (rel) => {
    loaded.push(rel);
    const clean = rel.split('?')[0].replace(/^\.\.\//, 'js/');
    vm.runInContext(readFileSync(path.join(ROOT, clean), 'utf8'), ctx, { filename: clean });
  };
  vm.runInContext(readFileSync(path.join(ROOT, 'js/workers/migration-worker.js'), 'utf8'), ctx);
  vm.runInContext('globalThis.__PC = PlaneCodec;', ctx);
  ctx.LumenMigrationHandlers = self.LumenMigrationHandlers;   // the handler registers on self
  const send = (m) => self.onmessage({ data: m });
  const wait = async (pred) => { for (let i = 0; i < 3000; i++) { const m = out.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 1)); } throw new Error('timeout'); };
  return { out, requests, send, wait, loaded, PC: ctx.__PC, listeners };
}

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
const bytes = (u8, status = 206) => ({ ok: true, status, arrayBuffer: async () => u8.slice().buffer, json: async () => ({}) });
function rangeOf(req) { const m = /bytes=(\d+)-(\d+)/.exec(req.headers.Range || ''); return m ? [+m[1], +m[2] + 1] : null; }

function server(opts = {}) {
  let puts = 0;
  return (req, all) => {
    if (req.url.endsWith('/metadata.json')) return json({ type: '3d' });
    if (req.url.endsWith('/bricks/manifest.json')) return json(manifest);
    if (req.url.includes('pack_00.bin')) {
      if (opts.dropFirstRange && !all.some((r) => r !== req && r.url.includes('pack_00.bin'))) throw new TypeError('Failed to fetch');
      const [s, e] = rangeOf(req);
      return opts.ignoreRange ? bytes(pack, 200) : bytes(pack.subarray(s, e));
    }
    if (req.url.includes('action=ping')) return json({ ok: false }, 400);
    if (req.url.includes('action=unit_put')) {
      puts++;
      if (opts.putDies) throw new TypeError('connection reset');
      if (opts.putStatus) return json({ ok: false, error: 'nope' }, opts.putStatus);
      if (opts.fail503Once && puts === 1) return json({ ok: false, error: 'busy' }, 503);
      return json({ ok: true, done: 1, total: 4 });
    }
    return json({}, 404);
  };
}

async function runOne(opts) {
  const w = makeWorker(server(opts));
  w.send({ type: 'config', endpoint: 'http://h/api/migrations.php', csrf: 'tok' });
  w.send({ type: 'prepare', reqId: 1, migration: 'm002-planes', dataset: '3d/ds', datasetBase: 'http://h/DATA_WEB/3d/ds/' });
  const prep = await w.wait((m) => m.type === 'prepared');
  assert.ok(prep.ok, prep.error);
  w.send({ type: 'run', reqId: 2, migration: 'm002-planes', dataset: '3d/ds', unit: 't0.z0.c0.y0.x0', dry: !!opts.dry });
  const res = await w.wait((m) => m.type === 'unit_done' || m.type === 'unit_failed');
  return { w, res };
}

// 1. Nominal unit.
{
  const { w, res } = await runOne({});
  assert.equal(res.type, 'unit_done', res.error);
  assert.deepEqual(w.loaded, ['../core/plane-codec.js?v=7', '../migrations/m002-planes.js?v=7']);
  const ranges = w.requests.filter((r) => r.url.includes('pack_00.bin'));
  assert.ok(ranges.length >= 1);
  for (const r of ranges) assert.match(r.url, /^http:\/\/h\/DATA_WEB\/3d\/ds\/bricks\/lod0\/c0\/pack_00\.bin\?v=[0-9a-z]+$/);
  const put = w.requests.find((r) => r.url.includes('unit_put'));
  const q = new URL(put.url).searchParams;
  assert.equal(put.method, 'POST');
  assert.equal(q.get('dataset'), '3d/ds'); assert.equal(q.get('migration'), 'm002-planes');
  assert.equal(q.get('unit'), 't0.z0.c0.y0.x0'); assert.equal(q.get('dry'), '0');
  assert.equal(put.headers['X-CSRF-Token'], 'tok');
  assert.equal(put.headers['Content-Type'], 'application/octet-stream');
  const tiles = w.PC.parseUnitBlob(put.body);
  assert.equal(tiles.length, Z, 'one tile per plane of the 10-plane layer');
  for (const t of tiles) {
    const d = await w.PC.decodePngGray(t.png);
    assert.equal(d.width, X); assert.equal(d.height, Y);
    for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) assert.equal(d.data[y * X + x], vox(x, y, t.z));
  }
  assert.equal(res.bytesOut, put.body.length);
  assert.equal(res.done, 1); assert.equal(res.total, 4);
}
// 2. dry=1 for the benchmark
{ const { w } = await runOne({ dry: true }); assert.equal(new URL(w.requests.find((r) => r.url.includes('unit_put')).url).searchParams.get('dry'), '1'); }
// 3. 503 once → retried
{
  const { w, res } = await runOne({ fail503Once: true });
  assert.equal(res.type, 'unit_done');
  assert.equal(w.requests.filter((r) => r.url.includes('unit_put')).length, 2);
}
// 4. dropped connection → offline, probe, online, success
{
  const { w, res } = await runOne({ dropFirstRange: true });
  assert.equal(res.type, 'unit_done', res.error);
  const net = w.out.filter((m) => m.type === 'net').map((m) => m.online);
  assert.deepEqual(net, [false, true]);
  assert.ok(w.requests.some((r) => r.url.includes('action=ping')));
  assert.equal((w.listeners.online || []).length, 0, 'no online listener left behind by the wait');
}
// 5. 422 fatal at once; 401 carries its status
for (const st of [422, 401]) {
  const { w, res } = await runOne({ putStatus: st });
  assert.equal(res.type, 'unit_failed');
  assert.equal(res.status, st); assert.ok(res.fatal);
  assert.equal(w.requests.filter((r) => r.url.includes('unit_put')).length, 1);
}
// 6. host ignoring Range (200 with the whole pack)
{ const { res } = await runOne({ ignoreRange: true }); assert.equal(res.type, 'unit_done', res.error); }
// 6b. a request that always dies while the link answers: bounded, then a non-fatal failure
{
  const { w, res } = await runOne({ putDies: true });
  assert.equal(res.type, 'unit_failed');
  assert.equal(res.code, 'request_failed'); assert.equal(res.fatal, false);
  assert.equal(w.requests.filter((r) => r.url.includes('unit_put')).length, 8);
}
// 7. bad id refused
{
  const w = makeWorker(server());
  w.send({ type: 'prepare', reqId: 1, migration: '../evil', dataset: 'x', datasetBase: 'http://h/' });
  const r = await w.wait((m) => m.type === 'prepared');
  assert.equal(r.ok, false);
  assert.equal(w.loaded.length, 1, 'only the codec was loaded');
}

console.log('migration worker: OK');
