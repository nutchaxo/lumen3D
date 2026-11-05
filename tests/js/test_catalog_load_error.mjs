// Catalog.load() must tell a failed load from an empty catalog, and recover on retry.
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

const sample = [
  { id: '3d/a', type: '3d', name: 'Alpha', stage: 'E85' },
  { id: 'live/b', type: 'live', name: 'Beta', stage: 'E95' },
];

function make(responder) {
  let calls = 0;
  const Catalog = loadModule('js/core/catalog.js', 'Catalog', {
    fetch: async (...args) => { calls++; return responder(calls, ...args); },
  });
  return { Catalog, calls: () => calls };
}
const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

const origWarn = console.warn;
console.warn = () => {};
try {
  // 503
  {
    const { Catalog } = make(() => ({ ok: false, status: 503, json: async () => ({}) }));
    assert.equal(Catalog.getLoadError(), null, 'no error before any load');
    await Catalog.load();
    assert.deepEqual({ ...Catalog.getLoadError() }, { code: 'http', status: 503 });
    assert.equal(Catalog.getAll().length, 0);
  }
  // network down
  {
    const { Catalog } = make(() => { throw new TypeError('Failed to fetch'); });
    await Catalog.load();
    assert.deepEqual({ ...Catalog.getLoadError() }, { code: 'network', status: 0 });
    assert.ok(!('message' in Catalog.getLoadError()), 'no raw error text is exposed');
  }
  // 200 with a body that is not JSON / not a catalog
  {
    const { Catalog } = make(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }));
    await Catalog.load();
    assert.equal(Catalog.getLoadError().code, 'parse');
    const bad = make(() => okJson({ datasets: 'nope' }));
    await bad.Catalog.load();
    assert.equal(bad.Catalog.getLoadError().code, 'shape');
  }
  // genuinely empty catalog is NOT an error
  {
    const { Catalog } = make(() => okJson([]));
    await Catalog.load();
    assert.equal(Catalog.getLoadError(), null);
    assert.equal(Catalog.getAll().length, 0);
    const wrapped = make(() => okJson({ datasets: [] }));
    await wrapped.Catalog.load();
    assert.equal(wrapped.Catalog.getLoadError(), null);
  }
  // retry recovery, and a loaded catalog is only refetched on force
  {
    let failing = true;
    const { Catalog, calls } = make(() => (failing ? { ok: false, status: 500, json: async () => ({}) } : okJson(sample)));
    await Catalog.load();
    assert.ok(Catalog.getLoadError());
    failing = false;
    await Catalog.load();
    assert.equal(Catalog.getLoadError(), null, 'the next call recovers');
    assert.equal(Catalog.getAll().length, 2);
    const n = calls();
    await Catalog.load();
    assert.equal(calls(), n, 'a held catalog is not refetched');
    await Catalog.load({ force: true });
    assert.equal(calls(), n + 1, 'force refetches');
    failing = true;
    await Catalog.load({ force: true });
    assert.equal(Catalog.getLoadError().status, 500, 'a failed forced reload is reported');
    assert.equal(Catalog.getAll().length, 0);
    failing = false;
    await Catalog.load();
    assert.equal(Catalog.getAll().length, 2, 'and recovers again');
  }
  // valid catalog unchanged; concurrent callers share one request
  {
    const { Catalog, calls } = make(() => okJson(sample));
    await Promise.all([Catalog.load(), Catalog.load({ force: true })]);
    assert.equal(calls(), 1);
    assert.equal(Catalog.getLoadError(), null);
    assert.equal(Catalog.getById('3d/a').name, 'Alpha');
    assert.equal(Catalog.getAll()[0].volumeSources.length, 0);
    assert.equal(Catalog.filter({ type: 'live' }).length, 1);
    assert.equal(Catalog.getStats().totalDatasets, 2);
  }
} finally {
  console.warn = origWarn;
}
console.log('catalog load error state: OK');
