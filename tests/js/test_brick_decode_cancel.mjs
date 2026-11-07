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
    resolveBitmap: (width = 4, height = 4) => pending && pending.resolve({ width, height }),
    // The worker's assembly map: a top-level const of the script, reachable by name
    // from another script run in the same context.
    assemblies: () => vm.runInContext('assemblies', sandbox),
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

// 4) A compose job whose batch is cancelled (and its assembly dropped) while it awaits
//    its bitmap must not create the assembly afterwards: nothing would ever free it.
const ASM = (id, key, slot, batch) => ({
  type: 'DECODE', id, batch, buffer: new ArrayBuffer(0), brickSize: 4,
  packing: { mode: 'grid', cols: 2 }, assemble: { key, slot, components: 4 },
});
{
  const w = makeWorker();
  w.send(ASM(1, '7:u0:0', 0, 7));
  await tick();                         // in flight, awaiting the bitmap
  w.send({ type: 'CANCEL', batch: 7 });
  w.send({ type: 'DROP', key: '7:u0:0' });
  w.resolveBitmap(8, 8);
  await tick(); await tick(); await tick();
  assert.deepEqual(w.ids(), [], 'a cancelled compose job posts no result');
  assert.equal(w.assemblies().size, 0, 'a cancelled compose job leaves no assembly behind');
}

// 5) The same for a global CANCEL (epoch), without any DROP.
{
  const w = makeWorker();
  w.send(ASM(1, '3:u0:0', 0, 3));
  await tick();
  w.send({ type: 'CANCEL' });
  w.resolveBitmap(8, 8);
  await tick(); await tick(); await tick();
  assert.equal(w.assemblies().size, 0, 'an epoch-cancelled compose job leaves no assembly behind');
}

// 6) A DROP runs after the jobs posted before it: a live job still decoding when its
//    unit drops the key (every channel failed elsewhere) cannot re-create the assembly.
{
  const w = makeWorker();
  w.send(ASM(1, '5:u1:0', 1, 5));
  await tick();
  w.send({ type: 'DROP', key: '5:u1:0' });
  w.resolveBitmap(8, 8);
  await tick(); await tick(); await tick();
  assert.deepEqual(w.ids(), [1], 'the live job still answers');
  assert.equal(w.assemblies().size, 0, 'the DROP that followed it freed the assembly');
}

// 7) A live compose job keeps its assembly for the TAKE that follows.
{
  const w = makeWorker();
  w.send(ASM(1, '9:u2:0', 0, 9));
  await tick();
  w.resolveBitmap(8, 8);
  await tick(); await tick(); await tick();
  assert.deepEqual(w.ids(), [1]);
  assert.equal(w.assemblies().size, 1, 'the assembly waits for its TAKE');
  assert.equal(w.assemblies().get('9:u2:0').buf.length, 4 * 4 * 4 * 4);
  w.send({ type: 'TAKE', id: 2, batch: 9, key: '9:u2:0', voxels: 64, components: 4 });
  await tick(); await tick();
  assert.equal(w.assemblies().size, 0, 'TAKE hands the assembly over and forgets it');
  assert.equal(w.results.find((m) => m.id === 2).buffer.byteLength, 256);
}

console.log('ELE-16 brick-decode-worker CANCEL epoch: OK');
