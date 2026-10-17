// Several "Data updates" tabs of one browser (js/pages/admin/migration-tabs.js, SPEC §7.3):
//   • the tabs converting at once split the governor's limits (in flight, rate, burst): the sum
//     stays one page's; an idle tab takes no share; a silent tab is forgotten after PEER_TTL_MS,
//     a closing one at once;
//   • a failure-driven cooldown in one tab holds the other tabs' requests too;
//   • one tab per dataset: a claim another tab holds is refused (Web Locks, and the heartbeat
//     fallback without them); a released claim can be taken by another tab;
//   • the Runner skips a dataset another tab holds (event `elsewhere`), runs the others, and lets
//     every claim go when it pauses or finishes.
//
// Run: node tests/js/test_mig_tabs.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './harness.mjs';

const T = await import(pathToFileURL(path.join(ROOT, 'js/pages/admin/migration-tabs.js')).href);
const R = await import(pathToFileURL(path.join(ROOT, 'js/pages/admin/migration-runner.js')).href);
const { TabCoordinator, PEER_TTL_MS } = T;
const { NetGovernor, Runner } = R;

// One "browser": a channel hub (no delivery to the sender, like BroadcastChannel) and a lock manager.
function browser() {
  const members = new Set();
  const hub = {
    channel() {
      const ch = { listeners: [], addEventListener(_t, fn) { this.listeners.push(fn); },
        postMessage(data) { for (const m of members) if (m !== ch) for (const fn of m.listeners) fn({ data: JSON.parse(JSON.stringify(data)) }); },
        close() { members.delete(ch); } };
      members.add(ch);
      return ch;
    },
  };
  const held = new Set();
  const locks = {
    request(name, opts, cb) {
      if (held.has(name)) return Promise.resolve(cb(null));
      held.add(name);
      return Promise.resolve(cb({ name })).finally(() => held.delete(name));
    },
  };
  return { hub, locks, held };
}

let clock = 0;
const now = () => clock;
const noTimer = { setInterval: () => 1, clearInterval: () => {} };
function tab(b, opts = {}) {
  const governor = new NetGovernor({ now, setTimer: () => 0 });
  const c = new TabCoordinator({ governor, channel: b.hub.channel(), locks: opts.noLocks ? null : b.locks, now, scope: '/x/', ...noTimer });
  return { c, governor };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

// 1. Shares.
{
  const b = browser();
  const a = tab(b), bb = tab(b), cc = tab(b);
  assert.equal(a.governor.maxInFlight, 6);
  a.c.setActive(true);
  assert.equal(a.c.activeTabs(), 1);
  assert.equal(a.governor.maxInFlight, 6, 'idle tabs take no share');
  bb.c.setActive(true); cc.c.setActive(true);
  for (const x of [a, bb, cc]) {
    assert.equal(x.c.activeTabs(), 3);
    assert.equal(x.governor.maxInFlight, 2);
    assert.ok(Math.abs(x.governor.maxRate - 2) < 1e-9);
    assert.ok(x.governor.rate <= x.governor.maxRate);
  }
  const sum = [a, bb, cc].reduce((n, x) => n + x.governor.maxRate, 0);
  assert.ok(Math.abs(sum - 6) < 1e-9, 'the browser as a whole stays at one page’s rate');
  // A tab closing gives its share back at once; a silent one after the TTL.
  cc.c.close();
  assert.equal(a.c.activeTabs(), 2);
  assert.equal(a.governor.maxInFlight, 3);
  clock += PEER_TTL_MS + 1;
  a.c._expire();
  assert.equal(a.c.activeTabs(), 1);
  assert.equal(a.governor.maxInFlight, 6);
  assert.ok(Math.abs(a.governor.maxRate - 6) < 1e-9);
  bb.c.close(); a.c.close();
}

// 2. One tab's cooldown holds the others.
{
  const b = browser();
  const a = tab(b), bb = tab(b);
  a.c.setActive(true); bb.c.setActive(true);
  assert.equal(bb.governor.holding, false);
  const release = await a.governor.acquire();
  release('throttled');
  assert.equal(a.governor.holding, true);
  assert.equal(bb.governor.holding, true, 'the other tab holds its requests too');
  a.c.close(); bb.c.close();
}

// 3. One tab per dataset, with and without Web Locks.
for (const noLocks of [false, true]) {
  const b = browser();
  const a = tab(b, { noLocks }), bb = tab(b, { noLocks });
  const ra = await a.c.claim('3d/E85');
  assert.equal(typeof ra, 'function');
  assert.equal(await a.c.claim('3d/E85'), ra, 'a tab re-claiming what it holds gets the same claim');
  assert.equal(await bb.c.claim('3d/E85'), null, 'held by the other tab');
  assert.equal(bb.c.heldElsewhere('3d/E85'), true);
  assert.equal(a.c.heldElsewhere('3d/E85'), false);
  assert.equal(typeof (await bb.c.claim('3d/E95')), 'function', 'another dataset is free');
  ra();
  await flush();
  assert.equal(bb.c.heldElsewhere('3d/E85'), false);
  assert.equal(typeof (await bb.c.claim('3d/E85')), 'function', 'released: the other tab may take it');
  a.c.close(); bb.c.close();
}

// 4. Runner: skips a dataset held elsewhere, releases its claims when done.
{
  const b = browser();
  const a = tab(b), bb = tab(b);
  const held = await bb.c.claim('3d/B');
  assert.ok(held);
  const events = [];
  const ran = [];
  const runner = new Runner({
    api: {}, pool: () => ({}), datasetBase: () => '',
    claim: (id) => a.c.claim(id),
    onEvent: (e) => events.push(e),
  });
  runner._runJob = async (item) => { ran.push(item.dataset); assert.equal(bb.c.heldElsewhere(item.dataset), true, 'held while it runs'); return 'done'; };
  runner.enqueue([{ dataset: '3d/A', migration: 'm005-matrix' }, { dataset: '3d/B', migration: 'm005-matrix' }, { dataset: '3d/C', migration: 'm005-matrix' }]);
  await runner._loop;
  assert.deepEqual(ran, ['3d/A', '3d/C']);
  assert.deepEqual(events.filter((e) => e.type === 'elsewhere').map((e) => e.dataset), ['3d/B']);
  assert.equal(runner.state, 'idle');
  await flush();
  assert.equal(a.c.held.size, 0, 'every claim let go');
  assert.equal(bb.c.heldElsewhere('3d/A'), false);
  // A paused runner lets its dataset go too.
  const r2 = new Runner({ api: {}, pool: () => ({}), datasetBase: () => '', claim: (id) => a.c.claim(id), onEvent: () => {} });
  r2._runJob = async () => 'paused';
  r2.enqueue([{ dataset: '3d/D', migration: 'm005-matrix' }]);
  await r2._loop;
  assert.equal(r2.state, 'paused');
  await flush();
  assert.equal(a.c.held.size, 0);
  a.c.close(); bb.c.close();
}

console.log('migration tabs: OK');
