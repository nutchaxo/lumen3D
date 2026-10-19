// m006-q30 browser handler (js/migrations/m006-q30.js), SPEC §15.4.
//
// Node has no WebP codec: the m005 encoder's WebP calls are replaced by stand-ins, and what is
// checked is the handler's own work — every ll run of the unit read once through readRels, each
// brick decoded and encoded in column q30 with its ll bytes as the known fallback, the blob in
// the layout dataset_migrations.py parses (`_m005_parse_brick_blob(blob, ("q30",))`, bricks in
// (bz, by, bx) order), an empty or brickless unit refused, the q30 column of the m005 encoder
// falling back to ll only.
//
// Run: node tests/js/test_m006_handler.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { loadModule, ROOT } from './harness.mjs';

const streams = {
  CompressionStream: globalThis.CompressionStream, DecompressionStream: globalThis.DecompressionStream,
  Blob: globalThis.Blob, Response: globalThis.Response,
};
const PlaneCodec = loadModule('js/core/plane-codec.js', 'PlaneCodec', streams);
const handlers = loadModule('js/migrations/m005-matrix.js', 'LumenMigrationHandlers', { ...streams, PlaneCodec, BigInt });
const H6 = loadModule('js/migrations/m006-q30.js', 'LumenMigrationHandlers', { LumenMigrationHandlers: handlers })['m006-q30'];
const I = handlers['m005-matrix']._internals;
assert.ok(H6, 'm006 registered');
assert.equal(JSON.stringify(H6.requires), '["m005-matrix"]');
assert.ok(H6.batchUnits > 1);

// Stand-ins for the WebP codec: a "brick image" is its 66³ voxels; a lossy encoding is shorter.
const calls = { decode: 0, encode: [] };
I.decodeWebp = async (bytes) => { calls.decode++; return { width: I.M66_W, height: I.M66_H, data: I.mosaic66(bytes.slice(1)) }; };
const realEncode = I.encodeBrick;
I.encodeBrick = async (b66, cid, known) => {
  calls.encode.push({ cid, knownLl: !!(known && known.ll), sum: b66.reduce((a, v) => a + v, 0) });
  return new Uint8Array([7, 7, b66[0], 3]);
};

const runs = [
  { rel: 'bricks/l1/ll/c0/p00000.bin', start: 100, end: 100 + 1 + 66 ** 3, bz: 0, by: 1, bx: 0 },
  { rel: 'bricks/l1/ll/c0/p00000.bin', start: 0, end: 1 + 66 ** 3, bz: 0, by: 0, bx: 1 },
];
const reads = [];
const io = {
  readRels: async (list) => {
    reads.push(list.length);
    return list.map((r, i) => { const b = new Uint8Array(r.end - r.start); b.fill(10 + i); return b; });
  },
};
const res = await H6.runUnit({ unit: 't0.k1.c0.z0.y0.x0', empty: false, bricks: runs }, {}, io);
assert.deepEqual(reads, [2], 'one read for the whole unit');
assert.equal(calls.decode, 2);
assert.deepEqual(calls.encode.map((c) => [c.cid, c.knownLl]), [['q30', true], ['q30', true]]);
assert.equal(res.tiles, 2);

// The blob, parsed by the Python reference.
const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
let parsed;
try {
  parsed = JSON.parse(execFileSync(py, ['-c', `
import sys, json, base64
import dataset_migrations as dm
b = dm._m005_parse_brick_blob(base64.b64decode(sys.stdin.read()), ("q30",))
print(json.dumps([[list(k), list(v["q30"])] for k, v in sorted(b.items())]))
`], { input: Buffer.from(res.body).toString('base64'), cwd: ROOT,
    env: { ...process.env, PYTHONPATH: ROOT + path.delimiter + (process.env.PYTHONPATH || '') } }).toString());
} catch (e) {
  if (/No module named|ENOENT/.test(String(e.stderr || e.message))) { console.log('SKIP python unavailable'); process.exit(0); }
  throw e;
}
assert.deepEqual(parsed, [[[0, 0, 1], [7, 7, 11, 3]], [[0, 1, 0], [7, 7, 10, 3]]], 'bricks in (bz, by, bx) order');

await assert.rejects(H6.runUnit({ unit: 'x', empty: true }, {}, io), (e) => e.code === 'empty_unit');
await assert.rejects(H6.runUnit({ unit: 'x', empty: false, bricks: [] }, {}, io), (e) => e.code === 'bad_unit_inputs');
await assert.rejects(H6.planUnitWork('t0.k0.c0.z0.y0.x0', {}, { unitInputs: async () => ({ unit: 'other' }) }), (e) => e.code === 'bad_unit_inputs');

// The m005 encoder's q30 column falls back to its ll image only (never b4).
I.encodeBrick = realEncode;
assert.ok(String(realEncode).includes('col.fallbacks'), "encodeBrick reads the column's own fallbacks");
console.log('m006 handler: OK');
