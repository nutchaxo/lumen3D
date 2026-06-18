// Unit tests for the streaming-pipeline integrity batch:
//   SEC-017  manifest pack URLs (brickToPack.url) could escape the dataset dir ('..')
//   BUG-065  absent/unknown brickPacking decoded a grid mosaic as a linear read
//            (silent scrambled volume, ok:true) — now rejected/failed-loud
//   EDGE-055 bricksForRegion emitted out-of-grid indices for maxNorm=1.0
//   BUG-034  bricksForRegion emitted negative indices for negative minNorm
//   LEAK-013 clearCache never released the main-thread decode-fallback canvas
//   LEAK-011 decode worker never closed the decoded ImageBitmap
//   PERF-022 loadBrickTasks yielded a hard setTimeout(1) per brick
//
// Run: node tests/js/test_streaming_integrity.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function makeLoader() {
  return loadModule('js/core/brick-loader.js', 'BrickLoader', {
    document: { createElement: () => ({ getContext: () => ({}) }) },
    navigator: { hardwareConcurrency: 1 },
    performance: { now: () => Date.now() },
    window: {},
    AbortController: globalThis.AbortController,
    DOMException: globalThis.DOMException,
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }),
  });
}

const LEVELS = [{ level: 0, dimensions: { x: 128, y: 128, z: 128 }, brickSize: 64 }];

// ── SEC-017: a pack URL escaping the dataset dir rejects the whole manifest ──
{
  const BL = makeLoader();
  const unsafe = {
    levels: LEVELS, channels: 1,
    brickTransport: { encoding: 'raw-u8', brickToPack: { 'x000_y000_z000.bin': { url: '../../../etc/passwd', offset: 0, length: 10 } } },
  };
  assert.throws(() => BL._validateManifest(unsafe), /unsafe pack url/i, 'SEC-017: ".." pack url rejected');
  for (const bad of ['//evil.com/p.bin', 'http://evil/p.bin', 'a/../../b.bin', 'file:///etc/passwd']) {
    const m = { levels: LEVELS, channels: 1, brickTransport: { encoding: 'raw-u8', brickToPack: { k: { url: bad, offset: 0, length: 1 } } } };
    assert.throws(() => BL._validateManifest(m), `SEC-017: unsafe url "${bad}" rejected`);
  }
  const safe = { levels: LEVELS, channels: 1, brickTransport: { encoding: 'raw-u8', brickToPack: { k: { url: 'lod0/pack0.bin', offset: 0, length: 1 } } } };
  assert.doesNotThrow(() => BL._validateManifest(safe), 'SEC-017: a normal relative pack url is accepted');
}

// ── BUG-065: brickPacking validation (webp requires grid; bad mode rejected) ──
{
  const BL = makeLoader();
  assert.throws(() => BL._validateManifest({ levels: LEVELS, channels: 1, brickTransport: { encoding: 'webp-lossless' } }),
    /grid/i, 'BUG-065: webp-lossless without brickPacking grid rejected');
  assert.throws(() => BL._validateManifest({ levels: LEVELS, brickPacking: { mode: 'zigzag' } }),
    /brickPacking\.mode/, 'BUG-065: unknown packing mode rejected');
  assert.throws(() => BL._validateManifest({ levels: LEVELS, brickPacking: { mode: 'grid', cols: 0 } }),
    /cols/, 'BUG-065: non-positive grid cols rejected');
  assert.doesNotThrow(() => BL._validateManifest({ levels: LEVELS, channels: 1, brickTransport: { encoding: 'webp-lossless' }, brickPacking: { mode: 'grid', cols: 8, rows: 8 } }),
    'BUG-065: webp-lossless with valid grid accepted');
  assert.doesNotThrow(() => BL._validateManifest({ levels: LEVELS, channels: 1, brickTransport: { encoding: 'raw-u8' } }),
    'BUG-065: raw-u8 without brickPacking still valid (only webp requires it)');
}

// ── EDGE-055 + BUG-034: bricksForRegion clamps indices to [0, n-1] ──
{
  const BL = makeLoader();
  BL.init('DATA_WEB/fixed/R/bricks', { levels: LEVELS, channels: 1, brickTransport: { encoding: 'raw-u8' } });
  // nx=ny=nz=ceil(128/64)=2 -> valid indices 0..1
  const full = BL.bricksForRegion({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, 0);
  assert.ok(full.length > 0, 'region returns bricks');
  for (const b of full) {
    for (const k of ['bx', 'by', 'bz']) {
      assert.ok(b[k] >= 0 && b[k] < 2, `EDGE-055: ${k}=${b[k]} stays in grid [0,2)`);
    }
  }
  assert.equal(Math.max(...full.map(b => b.bx)), 1, 'EDGE-055: maxNorm=1.0 does NOT emit out-of-grid index 2');

  const neg = BL.bricksForRegion({ x: -1, y: -1, z: -1 }, { x: 0.4, y: 0.4, z: 0.4 }, 0);
  for (const b of neg) {
    assert.ok(b.bx >= 0 && b.by >= 0 && b.bz >= 0, 'BUG-034: negative minNorm clamped to >= 0');
  }
}

// ── Decode worker: BUG-065 fail-loud on unknown mode; vertical still decodes ──
function runDecode(packing) {
  const results = [];
  let pending = null;
  const self = { onmessage: null, postMessage: (m) => results.push(m) };
  const sandbox = {
    self, console, performance: { now: () => 0 },
    Blob: function () {},
    createImageBitmap: () => new Promise((res) => { pending = res; }),
    OffscreenCanvas: function (w, h) {
      this.width = w; this.height = h;
      this.getContext = () => ({ globalCompositeOperation: '', drawImage() {}, getImageData: (x, y, ww, hh) => ({ data: new Uint8ClampedArray(ww * hh * 4) }) });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(ROOT, 'js/core/brick-decode-worker.js'), 'utf8'), sandbox, { filename: 'brick-decode-worker.js' });
  self.onmessage({ data: { type: 'DECODE', id: 7, buffer: new ArrayBuffer(0), brickSize: 4, packing } });
  return { results, resolve: () => pending && pending({ width: 512, height: 512 }) };
}

{
  const w = runDecode({ mode: 'lasagna' });
  await new Promise(r => setTimeout(r, 0));
  w.resolve();
  await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
  const r = w.results.find(m => m.type === 'DECODE_RESULT' && m.id === 7);
  assert.ok(r && r.ok === false, 'BUG-065: unknown packing mode fails loud (ok:false), no scrambled volume');
  assert.match(r.message, /unknown packing mode/i, 'BUG-065: clear error message');
}
{
  const w = runDecode({}); // absent mode -> also fail loud, not silent vertical garbage
  await new Promise(r => setTimeout(r, 0));
  w.resolve();
  await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
  const r = w.results.find(m => m.type === 'DECODE_RESULT' && m.id === 7);
  assert.ok(r && r.ok === false, 'BUG-065: absent packing mode also fails loud');
}

// ── Structural: LEAK-011 / LEAK-013 / PERF-022 ──
{
  const dec = readFileSync(path.join(ROOT, 'js/core/brick-decode-worker.js'), 'utf8');
  assert.ok(/finally\s*\{[\s\S]*bmp\.close\(\)/.test(dec), 'LEAK-011: bmp.close() released in a finally');
  assert.ok(!/\|\|\s*\{\s*mode:\s*['"]vertical['"]\s*\}/.test(dec), 'BUG-065: no implicit vertical default in worker');

  const bl = readFileSync(path.join(ROOT, 'js/core/brick-loader.js'), 'utf8');
  assert.ok(/_fallbackCanvas = null/.test(bl) && /clearCache/.test(bl), 'LEAK-013: clearCache nulls the fallback canvas');
  assert.ok(!/setTimeout\(r, 1\)/.test(bl), 'PERF-022: hard per-brick setTimeout(1) removed');
  assert.ok(/_yieldIfBudgetSpent/.test(bl), 'PERF-022: time-budgeted yield in place');
  assert.ok(!/brickPacking \|\| \{ mode: ['"]vertical['"] \}/.test(bl), 'BUG-065: no implicit vertical default in loader');
}

console.log('streaming integrity (SEC-017, BUG-065, EDGE-055/BUG-034, LEAK-011/013, PERF-022): OK');
