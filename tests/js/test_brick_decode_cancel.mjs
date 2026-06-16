// Unit test for ELE-16 / RACE-007: brick-decode-worker must honour CANCEL.
// cancelPending() posts {type:'CANCEL'} but the worker only handled 'DECODE',
// so stale decode results kept coming back. The fix adds a cancel epoch:
// queued jobs are skipped and in-flight results suppressed after a CANCEL.
//
// Run: node tests/js/test_brick_decode_cancel.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(path.join(ROOT, 'js/core/brick-decode-worker.js'), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));

function makeWorker() {
  const results = [];
  let pending = null;
  const self = { onmessage: null, postMessage: (m) => results.push(m) };
  const sandbox = {
    self, console,
    performance: { now: () => 0 },
    Blob: function () {},
    createImageBitmap: () => new Promise((resolve, reject) => { pending = { resolve, reject }; }),
    OffscreenCanvas: function (w, h) {
      this.width = w; this.height = h;
      this.getContext = () => ({
        globalCompositeOperation: '',
        drawImage() {},
        getImageData: (x, y, ww, hh) => ({ data: new Uint8ClampedArray(ww * hh * 4) }),
      });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'brick-decode-worker.js' });
  return {
    send: (m) => self.onmessage({ data: m }),
    resolveBitmap: () => pending && pending.resolve({ width: 4, height: 4 }),
    ids: () => results.filter((m) => m.type === 'DECODE_RESULT').map((m) => m.id),
    results,
  };
}

const DEC = (id) => ({ type: 'DECODE', id, buffer: new ArrayBuffer(0), brickSize: 4, packing: { mode: 'vertical' } });

// 1) nominal decode -> one ok result
{
  const w = makeWorker();
  w.send(DEC(1));
  await tick();
  w.resolveBitmap();
  await tick(); await tick();
  assert.deepEqual(w.ids(), [1]);
  assert.equal(w.results[0].ok, true);
}

// 2) CANCEL drops a queued job; a later (new-epoch) job still completes
{
  const w = makeWorker();
  w.send(DEC(1));            // queued, bitmap not resolved
  w.send({ type: 'CANCEL' });
  await tick();              // id=1 runs, epoch guard returns before awaiting
  w.send(DEC(2));
  await tick();
  w.resolveBitmap();         // resolves id=2
  await tick(); await tick();
  assert.ok(!w.ids().includes(1), 'cancelled queued job must not post a result');
  assert.ok(w.ids().includes(2), 'post-cancel job (new epoch) must complete');
}

// 3) CANCEL while in-flight suppresses the result
{
  const w = makeWorker();
  w.send(DEC(1));
  await tick();              // processDecode started, awaiting bitmap
  w.send({ type: 'CANCEL' }); // epoch bumped mid-flight
  w.resolveBitmap();          // decode proceeds, hits success guard -> suppressed
  await tick(); await tick();
  assert.ok(!w.ids().includes(1), 'in-flight cancelled job must not post a result');
}

console.log('ELE-16 brick-decode-worker CANCEL epoch: OK');
