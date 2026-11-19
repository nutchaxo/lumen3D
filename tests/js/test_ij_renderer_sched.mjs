// Advanced Studio — ij-layout.js: the pure scheduler of the shared renderer (IJRenderSched): tile request order across
// views, the inflight cap, the shared byte budget with pinned coarse levels, the worker's tile cache size.
//
// Run: node tests/js/test_ij_renderer_sched.mjs
import assert from 'node:assert/strict';
import { loadViewModules } from './ij_harness.mjs';

const { IJRenderSched: S, IJViewPure: P } = loadViewModules({});
const MiB = 1024 * 1024;
const A = (x) => JSON.parse(JSON.stringify(x)); // values from the vm context have another realm's prototypes
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };
const req = (key, rank, area, docId = 1) => ({ key, docId, rank, area, c: 0, L: 0, tx: 0, ty: 0 });

test('requests: the active view first, then the other visible views by visible area, then prefetch', () => {
  const q = S.createQueue({ cap: 10 });
  q.beginFrame();
  q.want(req('prefetch', 2, 9e9));
  q.want(req('small', 1, 1000));
  q.want(req('big', 1, 5000));
  q.want(req('active-b', 0, 100));
  q.want(req('active-a', 0, 100));
  assert.deepEqual(A(q.take(0).map((r) => r.key)), ['active-b', 'active-a', 'big', 'small', 'prefetch'], 'rank, then area (bigger first), then arrival');
});

test('the inflight cap of 10 is global: running requests count against it', () => {
  assert.equal(S.MAX_INFLIGHT, 10);
  const q = S.createQueue({ cap: S.MAX_INFLIGHT });
  q.beginFrame();
  for (let i = 0; i < 25; i++) q.want(req('k' + i, i % 3, 100, i % 4));
  assert.equal(q.take(7).length, 3, '7 in flight: 3 may start');
  assert.equal(q.take(10).length, 0, 'at the cap: none');
  assert.equal(q.take(0).length, 10);
  assert.equal(q.size, 25 - 3 - 10, 'what was taken is gone, the rest waits');
});

test('a key is asked once per frame; a busy key is skipped; beginFrame forgets the queue', () => {
  const q = S.createQueue({ cap: 10 });
  q.beginFrame();
  assert.equal(q.want(req('a', 0, 1)), true);
  assert.equal(q.want(req('a', 1, 2)), false, 'the same tile from two views is one request');
  q.want(req('b', 0, 1));
  assert.deepEqual(A(q.take(0, (k) => k === 'a').map((r) => r.key)), ['b']);
  assert.equal(q.size, 1);
  q.beginFrame();
  assert.equal(q.size, 0);
  assert.equal(q.want(req('a', 0, 1)), true);
});

test('shared budget: one LRU across documents evicts the oldest first, pinned and in-use tiles stay', () => {
  const lru = P.createLru();
  lru.add('1|0|3|0|0', 4 * MiB, true);            // doc 1 coarse level (pinned)
  lru.add('2|0|3|0|0', 4 * MiB, true);            // doc 2 coarse level (pinned)
  lru.add('1|0|0|0|0', 16 * MiB);
  lru.add('2|0|0|0|0', 16 * MiB);
  lru.add('1|0|0|1|0', 16 * MiB);
  const entries = lru.keys().map((k) => ({ key: k, bytes: k.includes('|3|') ? 4 * MiB : 16 * MiB, pinned: k.includes('|3|') }));
  const evict = S.planEviction(entries, lru.total, 40 * MiB, new Set(['2|0|0|0|0']));
  assert.deepEqual(A(evict), ['1|0|0|0|0', '1|0|0|1|0'].slice(0, evict.length), 'oldest first, never the pinned ones nor the protected one');
  assert.ok(!evict.includes('2|0|0|0|0') && !evict.some((k) => k.includes('|3|')));
  const left = lru.total - evict.length * 16 * MiB;
  assert.ok(left <= 40 * MiB || evict.length === 2, 'the budget is met or only unevictable entries remain');
  assert.deepEqual(A(S.planEviction(entries, 10 * MiB, 40 * MiB)), [], 'under budget: nothing');
});

test('pinned coarse levels: at most a quarter of the budget', () => {
  assert.equal(S.canPin(0, 8 * MiB, 64 * MiB), true);
  assert.equal(S.canPin(10 * MiB, 6 * MiB, 64 * MiB), true, 'exactly a quarter');
  assert.equal(S.canPin(10 * MiB, 7 * MiB, 64 * MiB), false);
  assert.equal(S.canPin(0, 1, 0), false);
});

test("the worker's tile cache follows the number of visible views: min(512 MiB, budget / 2, 64 MiB x (1 + views))", () => {
  assert.equal(S.workerTileCacheBytes(0, 4096 * MiB), 64 * MiB);
  assert.equal(S.workerTileCacheBytes(1, 4096 * MiB), 128 * MiB);
  assert.equal(S.workerTileCacheBytes(3, 4096 * MiB), 256 * MiB);
  assert.equal(S.workerTileCacheBytes(20, 4096 * MiB), 512 * MiB);
  assert.equal(S.workerTileCacheBytes(5, 300 * MiB), 150 * MiB, 'half the engine budget');
  assert.equal(S.workerTileCacheBytes(5, 50 * MiB), 25 * MiB, 'half the engine budget, never more (no floor above it)');
});

console.log(`ij renderer scheduler: ${n} groups ok`);
