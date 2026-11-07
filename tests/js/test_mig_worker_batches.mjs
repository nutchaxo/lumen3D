// Browser-executor worker, m005 batches and pieces (SPEC §14.10):
//   • run_batch: the inputs of every unit in ONE unit_inputs_many, every byte run of the batch
//     read once (one read_ranges for runs the units share), results posted with unit_put_many;
//   • no request body above the host's limit (config maxBody = status.server.maxUnitBody): a
//     batch is flushed below it, a result larger than it goes up in pieces (unit_put_part,
//     offsets contiguous, the same total), alone;
//   • an item error of unit_inputs_many (unit_blocked) and a unit refused by unit_put_many are
//     unit_failed for that unit only; the others are unit_done;
//   • a server without unit_inputs_many answers batch_unsupported (the pool goes back to one
//     unit per request);
//   • a single-unit migration (m004) obeys the same limit: a larger result goes in pieces, and
//     a piece answered complete ends the unit;
//   • the batch's run cache is bounded: a run leaves it after the last unit that lists it, a run
//     missed by the prefetch is kept for a later unit only within BATCH_PREFETCH_BYTES.
//
// Run: node tests/js/test_mig_worker_batches.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const MB = 1024 * 1024;
const FAKE_HANDLER = `
  self.LumenMigrationHandlers = self.LumenMigrationHandlers || {};
  self.LumenMigrationHandlers['m005-matrix'] = {
    batchUnits: 8,
    prepare: async () => ({ trees: [{}] }),
    runUnit: async (inp, state, io) => {
      const got = await io.readRels([...inp.tiles, ...(inp.extra || [])]);
      let sum = 0; for (const g of got) sum += g[0];
      const body = new Uint8Array(inp.size); body.fill(sum & 0xFF);
      return { body, tiles: got.length };
    },
  };`;

// A single-unit migration (no batches): its result size comes with the unit key.
const FAKE_M004 = `
  self.LumenMigrationHandlers = self.LumenMigrationHandlers || {};
  self.LumenMigrationHandlers['m004-bricks-v3'] = {
    prepare: async () => ({ trees: [{}] }),
    planUnitWork: (key) => ({ size: Number(key.split('.').pop().slice(1)) }),
    runUnit: async (work) => ({ body: new Uint8Array(work.size).fill(7), tiles: 1, bytesIn: 0 }),
  };`;

function makeWorker(behaviour) {
  const out = [];
  const requests = [];
  const self = {
    location: { href: 'http://h/js/workers/migration-worker.js?v=7' },
    postMessage: (m) => out.push(m),
    addEventListener() {}, removeEventListener() {},
    onmessage: null,
  };
  const ctx = vm.createContext({
    self, console, URL, URLSearchParams, Blob, Response, TextEncoder, TextDecoder, AbortController, performance,
    setTimeout: (fn) => setTimeout(fn, 0), clearTimeout,
    fetch: async (url, init = {}) => {
      const req = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body };
      requests.push(req);
      return behaviour(req);
    },
  });
  ctx.self = self;
  ctx.importScripts = (rel) => {
    const clean = rel.split('?')[0].replace(/^\.\.\//, 'js/');
    if (clean === 'js/migrations/m005-matrix.js') { vm.runInContext(FAKE_HANDLER, ctx); return; }
    if (clean === 'js/migrations/m004-bricks-v3.js') { vm.runInContext(FAKE_M004, ctx); return; }
    vm.runInContext(readFileSync(path.join(ROOT, clean), 'utf8'), ctx, { filename: clean });
  };
  vm.runInContext(readFileSync(path.join(ROOT, 'js/workers/migration-worker.js'), 'utf8'), ctx);
  ctx.LumenMigrationHandlers = self.LumenMigrationHandlers;
  const send = (m) => self.onmessage({ data: m });
  const wait = async (pred) => { for (let i = 0; i < 5000; i++) { const m = out.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 1)); } throw new Error('timeout'); };
  return { out, requests, send, wait };
}

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
const asBytes = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));

function parsePutMany(body) {
  const u8 = asBytes(body);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = dv.getUint32(0, true);
  let o = 4;
  const out = [];
  for (let i = 0; i < n; i++) {
    const kl = dv.getUint16(o, true); o += 2;
    const key = new TextDecoder().decode(u8.subarray(o, o + kl)); o += kl;
    const ln = dv.getUint32(o, true); o += 4;
    out.push({ key, length: ln }); o += ln;
  }
  assert.equal(o, u8.length, 'no trailing bytes');
  return out;
}

// Units: five of 300 KB, one of 2.5 MB, one blocked by the server, one refused at put time.
const SIZES = { 'B.t0.k1.c0.a': 300_000, 'B.t0.k1.c0.b': 300_000, 'B.t0.k1.c0.c': 300_000, 'B.t0.k1.c0.d': 300_000,
  'B.t0.k1.c0.e': 300_000, 'B.t0.k0.c0.big': 2_500_000, 'B.t0.k2.c0.blocked': 10, 'B.t0.k1.c0.refused': 1000 };
const KEYS = Object.keys(SIZES);

function server(opts = {}) {
  const st = { puts: [], parts: [], reads: 0, maxBody: opts.maxBody };
  st.fn = (req) => {
    const bodyLen = req.body == null ? 0 : (typeof req.body === 'string' ? req.body.length : asBytes(req.body).length);
    if (st.maxBody) assert.ok(bodyLen <= st.maxBody, `${req.url} carries ${bodyLen} > ${st.maxBody}`);
    if (req.url.includes('action=unit_inputs_many')) {
      if (opts.old) return json({ error: 'Unknown action' }, 400);
      const b = JSON.parse(req.body);
      assert.equal(req.headers['X-CSRF-Token'], 'tok');
      return json({ ok: true, items: b.units.map((u) => (u.includes('blocked')
        ? { ok: false, unit: u, error: 'unit_blocked', status: 409 }
        // Every unit reads the same shared run plus one of its own.
        : { unit: u, empty: false, size: SIZES[u], tiles: [{ rel: 'planes/z0.bin', start: 0, end: 16 }, { rel: 'planes/' + u + '.bin', start: 0, end: 8 }] })) });
    }
    if (req.url.includes('action=read_ranges')) {
      st.reads++;
      const runs = JSON.parse(req.body).ranges;
      const parts = runs.map(([, s, e]) => new Uint8Array(e - s).fill(1));
      const total = parts.reduce((n, p) => n + p.length, 0);
      const outb = new Uint8Array(4 + 4 * parts.length + total);
      const dv = new DataView(outb.buffer);
      dv.setUint32(0, parts.length, true);
      let at = 4 + 4 * parts.length;
      parts.forEach((p, i) => { dv.setUint32(4 + 4 * i, p.length, true); outb.set(p, at); at += p.length; });
      return { ok: true, status: 200, arrayBuffer: async () => outb.buffer, json: async () => ({}) };
    }
    if (req.url.includes('action=unit_put_many')) {
      const entries = parsePutMany(req.body);
      st.puts.push(entries);
      return json({ ok: true, done: 1, total: KEYS.length, results: entries.map((e) => (e.key.includes('refused')
        ? { ok: false, unit: e.key, error: 'bad_blob', status: 400 } : { ok: true, unit: e.key })) });
    }
    if (req.url.includes('action=unit_put_part')) {
      const q = new URL(req.url).searchParams;
      const p = { unit: q.get('unit'), offset: +q.get('offset'), total: +q.get('total'), length: asBytes(req.body).length };
      st.parts.push(p);
      const complete = p.offset + p.length === p.total;
      return json(complete ? { ok: true, complete: true, done: 2, total: KEYS.length } : { ok: true, complete: false, received: p.offset + p.length });
    }
    return json({}, 404);
  };
  return st;
}

async function runBatch(opts) {
  const st = server(opts);
  const w = makeWorker(st.fn);
  w.send({ type: 'config', endpoint: 'http://h/api/migrations.php', csrf: 'tok', maxBody: opts.maxBody });
  w.send({ type: 'prepare', reqId: 1, migration: 'm005-matrix', dataset: '3d/ds', datasetBase: 'http://h/DATA_WEB/3d/ds/' });
  const prep = await w.wait((m) => m.type === 'prepared');
  assert.ok(prep.ok, prep.error);
  assert.equal(prep.batchUnits, 8);
  w.send({ type: 'run_batch', reqId: 2, migration: 'm005-matrix', dataset: '3d/ds', units: KEYS, dry: false });
  const res = await w.wait((m) => m.type === 'batch_done' || m.type === 'batch_unsupported');
  return { st, w, res };
}

// 1. A 1 MiB host: nothing above it, the big unit in pieces, the others batched.
{
  const { st, w, res } = await runBatch({ maxBody: 1 * MB });
  assert.equal(res.type, 'batch_done');
  const by = new Map(res.results.map((r) => [r.key, r]));
  assert.deepEqual(res.results.map((r) => r.key), KEYS, 'one result per unit, in order');
  for (const k of KEYS) {
    const want = k.includes('blocked') || k.includes('refused') ? 'unit_failed' : 'unit_done';
    assert.equal(by.get(k).type, want, k + ' ' + JSON.stringify(by.get(k)));
  }
  assert.equal(by.get('B.t0.k2.c0.blocked').code, 'unit_blocked');
  assert.equal(by.get('B.t0.k1.c0.refused').code, 'bad_blob');
  assert.equal(w.requests.filter((r) => r.url.includes('unit_inputs_many')).length, 1);
  assert.equal(st.reads, 1, 'the runs of the batch in one read_ranges');
  const ranges = JSON.parse(w.requests.find((r) => r.url.includes('read_ranges')).body).ranges;
  assert.equal(ranges.filter((r) => r[0] === 'planes/z0.bin').length, 1, 'a shared run read once');
  // Pieces: contiguous, one total, the big unit only.
  assert.ok(st.parts.length >= 3, 'the 2.5 MB unit in pieces');
  assert.ok(st.parts.every((p) => p.unit === 'B.t0.k0.c0.big' && p.total === 2_500_000));
  let off = 0;
  for (const p of st.parts) { assert.equal(p.offset, off); off += p.length; }
  assert.equal(off, 2_500_000);
  // Batches: every other unit stored once, none of them in pieces.
  const stored = st.puts.flat().map((e) => e.key).sort();
  assert.deepEqual(stored, KEYS.filter((k) => !k.includes('big') && !k.includes('blocked')).sort());
  assert.ok(st.puts.length >= 2, 'five 300 KB results do not fit one 1 MiB request');
}
// 2. A 32 MiB host: one put for every unit, no piece.
{
  const { st, res } = await runBatch({ maxBody: 32 * MB });
  assert.equal(res.type, 'batch_done');
  assert.equal(st.parts.length, 0);
  assert.equal(st.puts.length, 1);
  assert.equal(st.puts[0].length, KEYS.length - 1);
}
// 3. A server without the batch protocol.
{
  const { st, res } = await runBatch({ maxBody: 8 * MB, old: true });
  assert.equal(res.type, 'batch_unsupported');
  assert.equal(st.puts.length + st.parts.length, 0);
}

// 4. Every migration's result honours the host's limit: a 3 MB m004 unit on a 1 MiB host goes
//    up in pieces, a small one in one unit_put; a piece answered complete (the retry of a last
//    piece whose first answer was lost) ends the unit.
async function runSingle(key, maxBody, answer) {
  const st = { parts: [], puts: [] };
  const w = makeWorker((req) => {
    const len = req.body == null ? 0 : asBytes(req.body).length;
    assert.ok(len <= maxBody, `${req.url} carries ${len} > ${maxBody}`);
    const q = new URL(req.url).searchParams;
    if (q.get('action') === 'unit_put_part') {
      const p = { migration: q.get('migration'), unit: q.get('unit'), offset: +q.get('offset'), total: +q.get('total'), length: len };
      st.parts.push(p);
      return json(answer(p));
    }
    if (q.get('action') === 'unit_put') { st.puts.push({ unit: q.get('unit'), length: len }); return json({ ok: true, done: 1, total: 2 }); }
    return json({}, 404);
  });
  w.send({ type: 'config', endpoint: 'http://h/api/migrations.php', csrf: 'tok', maxBody });
  w.send({ type: 'prepare', reqId: 1, migration: 'm004-bricks-v3', dataset: '3d/ds', datasetBase: 'http://h/DATA_WEB/3d/ds/' });
  assert.ok((await w.wait((m) => m.type === 'prepared')).ok);
  w.send({ type: 'run', reqId: 2, migration: 'm004-bricks-v3', dataset: '3d/ds', unit: key, dry: false });
  return { st, res: await w.wait((m) => m.type === 'unit_done' || m.type === 'unit_failed') };
}
const pieceAnswer = (p) => (p.offset + p.length === p.total
  ? { ok: true, complete: true, done: 1, total: 2 } : { ok: true, complete: false, received: p.offset + p.length });
{
  const { st, res } = await runSingle('t0.k0.c0.z0.y0.s3000000', 1 * MB, pieceAnswer);
  assert.equal(res.type, 'unit_done', JSON.stringify(res));
  assert.equal(st.puts.length, 0);
  assert.ok(st.parts.length >= 3 && st.parts.every((p) => p.migration === 'm004-bricks-v3' && p.total === 3_000_000));
  let off = 0;
  for (const p of st.parts) { assert.equal(p.offset, off); off += p.length; }
  assert.equal(off, 3_000_000);
}
{
  const { st, res } = await runSingle('t0.k0.c0.z0.y0.s500000', 1 * MB, pieceAnswer);
  assert.equal(res.type, 'unit_done');
  assert.deepEqual([st.parts.length, st.puts.length], [0, 1]);
}
{
  const { st, res } = await runSingle('t0.k0.c0.z0.y0.s3000000', 1 * MB,
    (p) => (p.offset ? { ok: true, complete: true, done: 2, total: 2 } : { ok: true, complete: false, received: p.length }));
  assert.equal(res.type, 'unit_done');
  assert.equal(res.done, 2);
  assert.equal(st.parts.length, 2, 'no piece sent after a complete answer');
}

// 5. The run cache of a batch. P (40 MiB) fills the prefetch, so M (10 MiB, units b and c) and
//    Q (40 MiB, units b and c) are misses read by unit b: M is kept for c, Q is not (10 + 40 MiB
//    would pass the 48 MiB budget) and c reads it again. Unit d reads M without listing it: M
//    left the cache after c, its last unit, so it is read a third time. P, listed by a alone, is
//    read once.
{
  const P = { rel: 'planes/p.bin', start: 0, end: 40 * MB };
  const M = { rel: 'planes/m.bin', start: 0, end: 10 * MB };
  const Q = { rel: 'planes/q.bin', start: 0, end: 40 * MB };
  const UNITS = {
    'C.t0.k0.c0.a': { tiles: [P] },
    'C.t0.k0.c0.b': { tiles: [M, Q] },
    'C.t0.k0.c0.c': { tiles: [Q, M] },
    'C.t0.k0.c0.d': { tiles: [], extra: [M] },
  };
  const readsOf = new Map();
  const w = makeWorker((req) => {
    if (req.url.includes('action=unit_inputs_many')) {
      const b = JSON.parse(req.body);
      return json({ ok: true, items: b.units.map((u) => ({ unit: u, empty: false, size: 100, ...UNITS[u] })) });
    }
    if (req.url.includes('action=read_ranges')) {
      const runs = JSON.parse(req.body).ranges;
      for (const [rel] of runs) readsOf.set(rel, (readsOf.get(rel) || 0) + 1);
      const total = runs.reduce((n, [, s, e]) => n + e - s, 0);
      const outb = new Uint8Array(4 + 4 * runs.length + total);
      const dv = new DataView(outb.buffer);
      dv.setUint32(0, runs.length, true);
      runs.forEach(([, s, e], i) => dv.setUint32(4 + 4 * i, e - s, true));
      outb.fill(1, 4 + 4 * runs.length);
      return { ok: true, status: 200, arrayBuffer: async () => outb.buffer, json: async () => ({}) };
    }
    if (req.url.includes('action=unit_put_many')) {
      const entries = parsePutMany(req.body);
      return json({ ok: true, done: 1, total: 4, results: entries.map((e) => ({ ok: true, unit: e.key })) });
    }
    return json({}, 404);
  });
  w.send({ type: 'config', endpoint: 'http://h/api/migrations.php', csrf: 'tok', maxBody: 32 * MB });
  w.send({ type: 'prepare', reqId: 1, migration: 'm005-matrix', dataset: '3d/ds', datasetBase: 'http://h/DATA_WEB/3d/ds/' });
  assert.ok((await w.wait((m) => m.type === 'prepared')).ok);
  w.send({ type: 'run_batch', reqId: 2, migration: 'm005-matrix', dataset: '3d/ds', units: Object.keys(UNITS), dry: false });
  const res = await w.wait((m) => m.type === 'batch_done');
  assert.ok(res.results.every((r) => r.type === 'unit_done'), JSON.stringify(res.results));
  assert.equal(readsOf.get('planes/p.bin'), 1, 'P prefetched once');
  assert.equal(readsOf.get('planes/m.bin'), 2, 'M kept from b for c, read again by d after its last unit');
  assert.equal(readsOf.get('planes/q.bin'), 2, 'Q not kept: it would pass the prefetch budget');
  const by = new Map(res.results.map((r) => [r.key, r]));
  assert.equal(by.get('C.t0.k0.c0.b').bytesIn, 50 * MB);
  assert.equal(by.get('C.t0.k0.c0.c').bytesIn, 40 * MB, 'c reads Q alone');
  assert.equal(by.get('C.t0.k0.c0.d').bytesIn, 10 * MB);
}

console.log('migration worker batches: OK');
