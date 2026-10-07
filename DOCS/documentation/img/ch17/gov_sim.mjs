// Runs the REAL NetGovernor class of js/pages/admin/migration-runner.js on a virtual clock.
import { NetGovernor } from '../../../../js/pages/admin/migration-runner.js';

function simulate({ ver, seconds = 70, latency = 0.25, failAt = [], clients = 8 }) {
  let now = 0;                      // ms
  const timers = [];                // {at, fn}
  const opts = ver === '1.59.2' ? { maxRate: 16, rate: 10, burst: 10 } : {};
  const g = new NetGovernor({ ...opts, now: () => now, setTimer: (fn, ms) => { timers.push({ at: now + ms, fn }); return 1; } });
  const events = [];   // request starts
  const rateTrace = [];
  const failQueue = failAt.slice().sort((a, b) => a - b);
  let started = 0;
  // each client loops: acquire -> wait latency -> release(outcome)
  const pendingRelease = [];
  function clientLoop(id) {
    g.acquire().then((release) => {
      started++; events.push(now / 1000);
      const doneAt = now + latency * 1000;
      pendingRelease.push({ at: doneAt, fn: () => {
        let out = 'ok';
        if (failQueue.length && now / 1000 >= failQueue[0]) { failQueue.shift(); out = 'throttled'; }
        release(out); if (now < seconds * 1000) clientLoop(id);
      } });
    });
  }
  for (let i = 0; i < clients; i++) clientLoop(i);
  const flush = () => new Promise((r) => setImmediate(r));
  return (async () => {
    while (now <= seconds * 1000) {
      await flush();
      // next event: earliest timer / release
      const all = [...timers.map((t) => ({ ...t, kind: 't', ref: t })), ...pendingRelease.map((t) => ({ ...t, kind: 'r', ref: t }))];
      if (!all.length) break;
      all.sort((a, b) => a.at - b.at);
      const nx = all[0];
      now = Math.max(now, nx.at);
      if (nx.kind === 't') timers.splice(timers.indexOf(nx.ref), 1); else pendingRelease.splice(pendingRelease.indexOf(nx.ref), 1);
      nx.fn();
      rateTrace.push([now / 1000, g.rate, g.holding ? 1 : 0, g.inFlight]);
    }
    const perSec = {};
    for (const t of events) { const s = Math.floor(t); if (s < seconds) perSec[s] = (perSec[s] || 0) + 1; }
    return { ver, started: events.filter((t) => t < seconds).length, perSec, rateTrace: rateTrace.filter((_, i) => i % 3 === 0).filter(r => r[0] < seconds) };
  })();
}
const out = {};
out.v159_3 = await simulate({ ver: '1.59.3', failAt: [20, 22, 23] });
out.v159_2 = await simulate({ ver: '1.59.2', failAt: [20, 22, 23] });
console.log(JSON.stringify(out));
