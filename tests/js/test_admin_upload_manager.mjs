// Import orchestrator: dataset grouping, the up-front secure-context check, a drop
// while paused resuming the worker, failed files surfacing (and being retryable),
// the plan being sent one dataset at a time.
//
// Run: node tests/js/test_admin_upload_manager.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './harness.mjs';

const posts = [];          // worker messages
const requests = [];       // fetch calls
let planCalls = 0;
globalThis.Utils = { DATASET_TYPES: ['3d', '2d', 'live'] };
globalThis.I18n = { t: (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k) };
globalThis.document = { baseURI: 'http://h/', getElementById: () => null };
globalThis.window = { isSecureContext: true, addEventListener() {}, location: { origin: 'http://h' } };
Object.defineProperty(globalThis, 'crypto', { value: { subtle: {} }, configurable: true });
globalThis.Worker = class { constructor() { this.onmessage = null; globalThis.__lastWorker = this; } postMessage(m) { posts.push(m); } terminate() {} };
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
  const u = String(url);
  if (u.includes('action=limits')) return json({ ok: true, chunkSize: 1 << 20, parallel: 2, backend: 'py' });
  if (u.includes('action=plan')) {
    planCalls++;
    const body = JSON.parse(init.body);
    return json({ ok: true, chunkSize: 1 << 20, datasets: body.datasets.map((d) => ({
      key: `${d.type}/${d.folder}`, type: d.type, folder: d.folder, state: 'uploading', published: false,
      totalBytes: d.files.reduce((s, f) => s + f.size, 0), receivedBytes: 0,
      files: d.files.map((f) => ({ path: f.path, size: f.size, done: false, missing: [0], chunkSize: 1 << 20, tier: 0 })),
    })) });
  }
  return json({ ok: true, datasets: [] });
};
function json(body, status = 200) { return { status, ok: status < 400, text: async () => JSON.stringify(body) }; }

const M = await import(pathToFileURL(path.join(ROOT, 'js/pages/admin/upload-manager.js')).href);

const f = (name, size = 10, content = null) => ({
  path: name,
  file: { size, text: async () => content ?? '', slice: () => ({}) },
});
const meta = (type) => JSON.stringify({ type, name: 'N' });

// ── grouping ───────────────────────────────────────────────────
{
  const entries = [
    f('DATA_WEB/3d/a/metadata.json', 5, meta('3d')),
    f('DATA_WEB/3d/a/bricks/manifest.json'),
    f('DATA_WEB/3d/a/bricks/lod0/p0.bin'),
    f('DATA_WEB/live/b/metadata.json', 5, meta('live')),
    f('DATA_WEB/live/b/bricks/lod0/p0.bin'),
    f('DATA_WEB/readme.txt'),
  ];
  const g = await M.groupIntoDatasets(entries);
  assert.equal(g.datasets.length, 2);
  const a = g.datasets.find((d) => d.folder === 'a');
  assert.equal(a.type, '3d');
  assert.deepEqual(a.files.map((x) => x.path).sort(), ['bricks/lod0/p0.bin', 'bricks/manifest.json', 'metadata.json']);
  assert.deepEqual(g.orphans, ['DATA_WEB/readme.txt'], 'a loose file is reported, not attached to a dataset');

  // nested root: the deepest metadata.json wins its files
  const nested = await M.groupIntoDatasets([
    f('3d/outer/metadata.json', 5, meta('3d')), f('3d/outer/x.bin'),
    f('3d/outer/inner/metadata.json', 5, meta('3d')), f('3d/outer/inner/y.bin'),
  ]);
  const inner = nested.datasets.find((d) => d.folder === 'inner');
  const outer = nested.datasets.find((d) => d.folder === 'outer');
  assert.deepEqual(inner.files.map((x) => x.path).sort(), ['metadata.json', 'y.bin']);
  assert.deepEqual(outer.files.map((x) => x.path).sort(), ['metadata.json', 'x.bin']);

  const flat = await M.groupIntoDatasets([f('metadata.json', 5, meta('3d')), f('a.bin')]);
  assert.equal(flat.flatDrop, true);
}

// ── secure context: one clear refusal, before any request ──────
{
  window.isSecureContext = false;
  const before = requests.length;
  const r = await M.startImport([f('3d/a/metadata.json', 5, meta('3d'))]);
  assert.equal(r.ok, false);
  assert.match(M.getState().error, /upl\.errInsecure|HTTPS|connexion sécurisée/);
  assert.equal(requests.length, before, 'no request is made');
  assert.equal(M.getState().phase, 'idle');
  window.isSecureContext = true;
}

// ── the plan goes one dataset at a time ────────────────────────
{
  planCalls = 0;
  const entries = [
    f('3d/a/metadata.json', 5, meta('3d')), f('3d/a/bricks/lod0/p0.bin', 100),
    f('live/b/metadata.json', 5, meta('live')), f('live/b/bricks/lod0/p0.bin', 100),
  ];
  const r = await M.startImport(entries);
  assert.equal(r.ok, true);
  assert.equal(planCalls, 2, 'one plan request per dataset');
  assert.equal(M.getState().phase, 'uploading');
  const enq = posts.filter((m) => m.type === 'enqueue');
  assert.equal(enq.length, 1);
  assert.equal(enq[0].jobs.length, 4);
}

// ── offline / failed files / retry ─────────────────────────────
{
  const worker = globalThis.__lastWorker;
  worker.onmessage({ data: { type: 'network', online: false } });
  assert.equal(M.getState().network, 'offline');
  worker.onmessage({ data: { type: 'network', online: true } });
  assert.equal(M.getState().network, 'online');

  worker.onmessage({ data: { type: 'file-error', ds: '3d/a', path: 'bricks/lod0/p0.bin', reason: 'http_500' } });
  worker.onmessage({ data: { type: 'file-error', ds: '3d/a', path: 'bricks/lod0/p0.bin', reason: 'http_500' } });
  assert.equal(M.getState().failed.length, 1, 'the same file is listed once');
  await worker.onmessage({ data: { type: 'idle' } });
  assert.equal(M.getState().phase, 'done');
  assert.match(M.getState().error, /errSomeFailed/, '"done" with failures says so');
  assert.equal(M.hasFailed(), true);

  planCalls = 0;
  const r = await M.retryFailed();
  assert.equal(r.ok, true, 'retry re-plans the last drop');
  assert.equal(planCalls, 2);
  assert.deepEqual(M.getState().failed, [], 'the failure list is reset by a new run');
}

// ── a drop while paused resumes the worker ─────────────────────
{
  M.pause();
  assert.equal(M.getState().phase, 'paused');
  posts.length = 0;
  const r = await M.startImport([f('3d/c/metadata.json', 5, meta('3d')), f('3d/c/bricks/lod0/p0.bin', 100)]);
  assert.equal(r.ok, true);
  assert.equal(M.getState().phase, 'uploading');
  const kinds = posts.map((m) => m.type);
  assert.ok(kinds.indexOf('enqueue') !== -1 && kinds.indexOf('resume') > kinds.indexOf('enqueue'), 'enqueue then resume');

  // ...and a plan failure while paused leaves it paused (not "idle" with a frozen worker)
  M.pause();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).includes('action=plan') ? json({ error: 'x' }, 500) : realFetch(url, init));
  const bad = await M.startImport([f('3d/d/metadata.json', 5, meta('3d'))]);
  assert.equal(bad.ok, false);
  assert.equal(M.getState().phase, 'paused');
  globalThis.fetch = realFetch;
}

// ── a fatal during an outage clears the offline banner ─────────
{
  const worker = globalThis.__lastWorker;
  worker.onmessage({ data: { type: 'network', online: false } });
  assert.equal(M.getState().network, 'offline');
  await worker.onmessage({ data: { type: 'fatal', reason: 'unauthorized' } });
  assert.equal(M.getState().phase, 'idle');
  assert.equal(M.getState().network, 'online', 'no "connection lost" banner left over a stopped transfer');
}

console.log('admin upload manager (grouping · secure-context check · per-dataset plan): OK');
