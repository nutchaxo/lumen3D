// Format 6 on the reading side (DOCS/dataset-migrations/SPEC.md §15):
//   • BrickLoader validates a v6 tree (schema iribhm-bricks-v6, version 6, columns exactly ll
//     and q30) and refuses one with another column set or a version 5; it mounts like a v5
//     tree and tells the formats apart (getFormat().matrixFormat), and getBasePath() names the
//     mounted tree;
//   • a q30 brick decodes by its trailer: 0..12 = lossy + dead zone, 0xFF = the ll image,
//     0xFE (a b4 fallback, which format 6 does not have) is refused;
//   • VolumeViewer shows q30 by default on a v6 tree (a bare resolution, or a column the tree
//     does not have, lands on q30), keeps `ll` for an explicit export key, never refines at rest;
//   • Q30Export parses the q30 index and lists the packs a level reaches, and downloads the
//     frame it started on to the end when another timepoint is mounted meanwhile; that frame
//     is the one ON SCREEN (DataAccess.displayedTree), not a frame the prefetch mounted.
//
// Run: node tests/js/test_format6_reader.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadModule, ROOT } from './harness.mjs';

const sha = (u8) => createHash('sha256').update(u8).digest('hex');

function lbix(levels, channels, entries) {
  const head = 12 + 16 * levels.length;
  let total = head;
  for (const [gx, gy, gz] of levels) total += 10 * channels * gx * gy * gz;
  const u8 = new Uint8Array(total);
  const dv = new DataView(u8.buffer);
  u8.set([76, 66, 73, 88]);
  dv.setUint16(4, 1, true); dv.setUint16(6, levels.length, true); dv.setUint16(8, channels, true);
  levels.forEach(([gx, gy, gz, pc], k) => { dv.setUint32(12 + 16 * k, gx, true); dv.setUint32(16 + 16 * k, gy, true); dv.setUint32(20 + 16 * k, gz, true); dv.setUint32(24 + 16 * k, pc, true); });
  let at = head;
  levels.forEach(([gx, gy, gz], k) => {
    for (let c = 0; c < channels; c++) {
      const m = entries[k][c] || new Map();
      for (let i = 0; i < gx * gy * gz; i++) {
        const e = m.get(i);
        if (e) { dv.setUint16(at, e[0], true); dv.setUint32(at + 2, e[1], true); dv.setUint32(at + 6, e[2], true); }
        at += 10;
      }
    }
  });
  return u8;
}

function makeTree() {
  const levels = [[3, 2, 1, 1], [1, 1, 1, 1]];
  const ll = lbix(levels, 2, [[new Map([[0, [0, 0, 100]], [1, [0, 100, 50]]]), new Map([[4, [0, 0, 80]]])], [new Map([[0, [0, 0, 30]]]), new Map()]]);
  const q30 = lbix([[3, 2, 1, 2], [1, 1, 1, 1]], 2, [[new Map([[0, [0, 0, 40]], [1, [0, 40, 20]]]), new Map([[4, [1, 7, 33]]])], [new Map([[0, [0, 0, 9]]]), new Map()]]);
  const files = { 'index/ll.bin': ll, 'index/q30.bin': q30 };
  const ref = (u8, url) => ({ url, bytes: u8.length, sha256: sha(u8) });
  const manifest = {
    schema: 'iribhm-bricks-v6', version: 6, formatVersion: 6, channels: 2, brickSize: 64, apron: 1,
    levels: [
      { level: 0, target: 'native', dimensions: { x: 130, y: 70, z: 10 }, voxelSize: { x: 0.5, y: 0.5, z: 2 }, gridSize: { x: 3, y: 2, z: 1 }, brickCount: 3 },
      { level: 1, target: 256, dimensions: { x: 64, y: 35, z: 10 }, voxelSize: { x: 1, y: 1, z: 2 }, gridSize: { x: 1, y: 1, z: 1 }, brickCount: 1 }
    ],
    columns: [
      { id: 'll', codec: 'webp-lossless', mosaic: 'grid66', maxError: 0 },
      { id: 'q30', codec: 'webp-lossy-dz', mosaic: 'grid80', quality: 30, maxError: null }
    ],
    index: { columns: { ll: ref(ll, 'index/ll.bin'), q30: ref(q30, 'index/q30.bin') }, cuts: [] },
    bytes: { 0: { ll: [150, 80], q30: [60, 33] }, 1: { ll: [30, 0], q30: [9, 0] } },
    timepoints: null, histograms: []
  };
  return { manifest, files };
}

function makeLoader(files) {
  const fetchImpl = async (url) => {
    const rel = String(url).split('/bricks/')[1].split('?')[0];
    const u8 = files[rel];
    if (!u8) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => u8.slice().buffer };
  };
  return loadModule('js/core/brick-loader.js', 'BrickLoader', {
    document: { createElement: () => ({ getContext: () => ({}) }) },
    navigator: { hardwareConcurrency: 2 },
    performance: { now: () => Date.now() },
    window: {},
    crypto: globalThis.crypto,
    AbortController: globalThis.AbortController,
    DOMException: globalThis.DOMException,
    fetch: fetchImpl,
  });
}

// ── validation and mount ──────────────────────────────────────────────────────
{
  const { manifest, files } = makeTree();
  const BL = makeLoader(files);
  BL._validateManifest(manifest);
  const bad = (mut, why) => {
    const m = JSON.parse(JSON.stringify(manifest));
    mut(m);
    assert.throws(() => BL._validateManifest(m), undefined, why);
  };
  bad(m => { m.version = 5; }, 'a v6 schema with version 5');
  bad(m => { m.columns.push({ id: 'q50', codec: 'webp-lossy-dz', mosaic: 'grid80', quality: 50, maxError: null }); m.index.columns.q50 = m.index.columns.q30; }, 'a third column');
  bad(m => { m.columns = [m.columns[1], m.columns[0]]; }, 'the columns out of order');
  await BL.init('DATA_WEB/3d/F/bricks', manifest);
  const fmt = BL.getFormat();
  assert.equal(fmt.version, 5, 'mounted as a matrix tree');
  assert.equal(fmt.matrixFormat, 6);
  assert.deepEqual(JSON.parse(JSON.stringify(fmt.columns.map(c => c.id))), ['ll', 'q30']);
  assert.equal(fmt.columns[1].quality, 30);
  assert.equal(BL.getBasePath(), 'DATA_WEB/3d/F/bricks');
  await BL.ensureColumns(['q30']);
  assert.equal(BL.taskBytes({ lod: 0, channel: 1, bx: 1, by: 1, bz: 0, column: 'q30' }), 33);
  assert.match(BL.brickLocation({ lod: 0, channel: 1, bx: 1, by: 1, bz: 0, column: 'q30' }).url, /^l0\/q30\/c1\/p00001\.bin\?v=/);
  console.log('v6 validation and mount: OK');
}

// ── q30 payloads: 0xFE refused ────────────────────────────────────────────────
{
  const src = readFileSync(path.join(ROOT, 'js/core/brick-loader.js'), 'utf8');
  const fn = src.slice(src.indexOf('function _v5Payload'), src.indexOf('\n  }\n', src.indexOf('function _v5Payload')));
  assert.match(fn, /a b4 fallback in a tree without a b4 column/, 'a 0xFE brick of a tree without b4 is refused');
  console.log('q30 trailer rule: OK');
}

// ── VolumeViewer column choice (source rule) ─────────────────────────────────
{
  const src = readFileSync(path.join(ROOT, 'js/viewers/volume-viewer.js'), 'utf8');
  const body = src.slice(src.indexOf('function _qualityColumnFor'), src.indexOf('function _brickConcurrencyForQuality'));
  const _qualityColumnOf = (key) => { const s = String(key || ''); const at = s.indexOf('@'); return at > 0 ? s.slice(at + 1) : null; };
  // eslint-disable-next-line no-new-func
  const pick = new Function('_qualityColumnOf', `${body}; return _qualityColumnFor;`)(_qualityColumnOf);
  const v6 = { columns: [{ id: 'll' }, { id: 'q30' }] };
  assert.equal(pick('native', v6), 'q30');
  assert.equal(pick('512x512@b2', v6), 'q30');
  assert.equal(pick('native@ll', v6), 'll', 'an export asks for ll explicitly');
  assert.equal(pick('native', { columns: [{ id: 'll' }, { id: 'b2' }] }), 'b2', 'format 5 unchanged');
  console.log('v6 column choice: OK');
}

// ── Q30Export index → packs ───────────────────────────────────────────────────
{
  const { manifest, files } = makeTree();
  const BL = makeLoader(files);
  await BL.init('DATA_WEB/3d/F/bricks', manifest);
  const Q = loadModule('js/core/q30-export.js', 'Q30Export', { BrickLoader: BL, OmeZarr: {}, I18n: undefined, Utils: undefined });
  assert.equal(Q.available(), true);
  const idx = Q.parseIndex(files['index/q30.bin']);
  assert.deepEqual(JSON.parse(JSON.stringify(Q.packsOf(idx, 0))), [
    { level: 0, channel: 0, pack: 0, end: 60 },
    { level: 0, channel: 1, pack: 1, end: 40 }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(Q.packsOf(idx, 1))), [{ level: 1, channel: 0, pack: 0, end: 9 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(Q.sizes())), { 0: 93, 1: 9 });
  console.log('Q30 download plan: OK');
}

// ── Q30Export pinned to the frame it started on ───────────────────────────────
// A timelapse frame is re-mounted (t000 → t001) while the packs download: every URL, the
// index and the manifest in the zip stay those of t000 (packs of another frame under t000's
// index would be a corrupt download).
{
  const frames = { t000: makeTree(), t001: makeTree() };
  const fill = { t000: 0xA0, t001: 0xB1 };
  let mounted = 't000';
  const loader = {
    isReady: () => true,
    getManifest: () => frames[mounted].manifest,
    getBasePath: () => `DATA_WEB/live/F/bricks/${mounted}`,
  };
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const u = String(url).split('?')[0];
    if (u === 'DATA_WEB/live/F/metadata.json') return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('{"id":"live/F"}').buffer };
    const m = u.match(/^DATA_WEB\/live\/F\/bricks\/(t\d{3})\/(.+)$/);
    if (!m) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const [, frame, rel] = m;
    if (frames[frame].files[rel]) return { ok: true, status: 200, arrayBuffer: async () => frames[frame].files[rel].slice().buffer };
    const p = rel.match(/^l(\d+)\/q30\/c(\d+)\/p(\d{5})\.bin$/);
    if (!p) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    mounted = 't001';                       // the user scrubs the timeline mid-download
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(64).fill(fill[frame]).buffer };
  };
  const OmeZarr = loadModule('js/core/ome-zarr.js', 'OmeZarr', { TextEncoder, BigInt });
  const Q = loadModule('js/core/q30-export.js', 'Q30Export', { BrickLoader: loader, OmeZarr, TextEncoder, fetch: fetchImpl, I18n: undefined, Utils: undefined });
  const parts = [];
  const sink = { write: (p) => { parts.push(Buffer.from(p.buffer, p.byteOffset, p.byteLength)); } };
  const r = await Q.run({ levelIds: [0], name: 'F', sink });
  assert.equal(r.packs, 2);
  assert.ok(urls.length >= 4 && urls.every(u => /^DATA_WEB\/live\/F\/(metadata\.json|bricks\/t000\/)/.test(u)), `every read comes from t000: ${urls.join(', ')}`);
  const zip = Buffer.concat(parts);
  const entries = new Map();
  for (let at = 0; zip.readUInt32LE(at) === 0x04034b50;) {
    const size = zip.readUInt32LE(at + 18), nameLen = zip.readUInt16LE(at + 26);
    const name = zip.subarray(at + 30, at + 30 + nameLen).toString('utf8');
    entries.set(name, zip.subarray(at + 30 + nameLen, at + 30 + nameLen + size));
    at += 30 + nameLen + size;
  }
  assert.deepEqual(entries.get('bricks/index/q30.bin'), Buffer.from(frames.t000.files['index/q30.bin']));
  assert.ok(entries.get('bricks/l0/q30/c0/p00000.bin').every(b => b === 0xA0), 'pack 0 of t000');
  assert.ok(entries.get('bricks/l0/q30/c1/p00001.bin').every(b => b === 0xA0), 'pack 1 of t000, after the re-mount');
  assert.equal(JSON.parse(entries.get('bricks/manifest.json').toString('utf8')).schema, 'iribhm-bricks-v6');
  assert.equal(mounted, 't001', 'the re-mount did happen mid-download');
  console.log('Q30 download pinned to its frame: OK');
}

// ── Q30Export downloads the frame on screen, not the prefetched mount ─────────
// t000 is on screen while the prefetch has left t001 mounted: the sizes shown and every byte
// downloaded are t000's.
{
  const frames = { t000: makeTree(), t001: makeTree() };
  const fill = { t000: 0xA0, t001: 0xB1 };
  const loader = {
    isReady: () => true,
    getManifest: () => frames.t001.manifest,
    getBasePath: () => 'DATA_WEB/live/F/bricks/t001',
  };
  const DataAccess = { displayedTree: () => ({ path: 'DATA_WEB/live/F/bricks/t000/', manifest: frames.t000.manifest }) };
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const u = String(url).split('?')[0];
    if (u === 'DATA_WEB/live/F/metadata.json') return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('{"id":"live/F"}').buffer };
    const m = u.match(/^DATA_WEB\/live\/F\/bricks\/(t\d{3})\/(.+)$/);
    if (!m) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const [, frame, rel] = m;
    if (frames[frame].files[rel]) return { ok: true, status: 200, arrayBuffer: async () => frames[frame].files[rel].slice().buffer };
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(64).fill(fill[frame]).buffer };
  };
  const OmeZarr = loadModule('js/core/ome-zarr.js', 'OmeZarr', { TextEncoder, BigInt });
  const Q = loadModule('js/core/q30-export.js', 'Q30Export', { BrickLoader: loader, DataAccess, OmeZarr, TextEncoder, fetch: fetchImpl, I18n: undefined, Utils: undefined });
  assert.equal(Q.available(), true);
  const parts = [];
  const r = await Q.run({ levelIds: [0], name: 'F', sink: { write: (p) => { parts.push(Buffer.from(p.buffer, p.byteOffset, p.byteLength)); } } });
  assert.equal(r.packs, 2);
  assert.ok(urls.every(u => /^DATA_WEB\/live\/F\/(metadata\.json|bricks\/t000\/)/.test(u)), `every read comes from the frame on screen: ${urls.join(', ')}`);
  const zip = Buffer.concat(parts);
  assert.ok(zip.includes(Buffer.alloc(64, 0xA0)) && !zip.includes(Buffer.alloc(64, 0xB1)), 'the packs of t000 only');
  console.log('Q30 download of the frame on screen: OK');

  // No tree on screen (the viewer released its volumes on a WebGL context loss): the
  // prefetched t001 still mounted is not offered nor downloaded under the frame's name.
  DataAccess.displayedTree = () => ({ path: null, manifest: null });
  urls.length = 0;
  assert.equal(Q.available(), false, 'nothing on screen: no Q30 download');
  assert.deepEqual(JSON.parse(JSON.stringify(Q.sizes())), {});
  await assert.rejects(Q.run({ levelIds: [0], name: 'F', sink: { write() {} } }), (err) => err.code === 'BRICKS_NOT_INITIALIZED');
  assert.equal(urls.length, 0, 'no byte of the prefetched frame');
  console.log('Q30 download refused while no tree is on screen: OK');
}

// ── Q30Export section appears once a tree is on screen ────────────────────────
// The Download Center mounts the section once per render. Opened while BrickLoader is mounted
// but the viewer shows no brick tree (a timepoint's coarse preview detached the previous volume,
// a WebGL context loss released it), the section keeps looking and appears when the frame is
// back, without reopening the Download Center; a tree on screen that has no q30 column ends
// the wait. Real data-access.js between the viewer and the export.
{
  const { manifest } = makeTree();
  const v5 = { ...manifest, schema: 'iribhm-bricks-v5' };
  let shown = null;
  let ready = true;
  const loader = { isReady: () => ready, getManifest: () => manifest, getBasePath: () => 'DATA_WEB/live/F/bricks/t001' };
  const VolumeViewer = { getDisplayedTree: () => shown };
  const DataAccess = loadModule('js/core/data-access.js', 'DataAccess', { BrickLoader: loader, VolumeViewer });
  const timers = [];
  const fakeTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const tick = () => { const due = timers.splice(0); due.forEach(t => t.fn()); return due.length; };
  const Q = loadModule('js/core/q30-export.js', 'Q30Export', { BrickLoader: loader, DataAccess, OmeZarr: {}, I18n: undefined, Utils: undefined, window: {}, setTimeout: fakeTimeout });
  const node = () => ({ textContent: '', disabled: false, hidden: true, style: {}, addEventListener() {} });
  const section = () => {
    const nodes = new Map();
    return {
      hidden: true, isConnected: true, innerHTML: '',
      querySelector(s) { if (!nodes.has(s)) nodes.set(s, node()); return nodes.get(s); },
      querySelectorAll: () => [],
      addEventListener() {},
    };
  };

  // Nothing on screen, then the frame comes back.
  let el = section();
  Q.mount(el, { dataset: { id: 'live/F', type: 'live' } });
  assert.equal(el.hidden, true, 'nothing on screen: section hidden');
  assert.equal(timers.length, 1, 'nothing on screen: the section keeps looking');
  assert.equal(tick(), 1);
  assert.equal(el.hidden, true, 'still nothing on screen');
  assert.equal(timers.length, 1, 'still looking');
  shown = { path: 'DATA_WEB/live/F/bricks/t000', manifest };
  tick();
  assert.equal(el.hidden, false, 'the frame is back: the Q30 section appears');
  assert.match(el.innerHTML, /data-q30-start/);
  assert.equal(timers.length, 0, 'shown: no more polling');

  // Loader not mounted yet: keeps looking too.
  ready = false; shown = null;
  el = section();
  Q.mount(el, { dataset: { id: 'live/F' } });
  assert.equal(el.hidden, true);
  assert.equal(timers.length, 1, 'loader not ready: keeps looking');
  timers.length = 0;
  ready = true;

  // A tree on screen without the q30 column ends the wait.
  shown = { path: 'DATA_WEB/3d/G/bricks', manifest: v5 };
  el = section();
  Q.mount(el, { dataset: { id: '3d/G' } });
  assert.equal(el.hidden, true, 'a v5 tree: no Q30 section');
  assert.equal(timers.length, 0, 'a v5 tree on screen: no polling');

  // A section no longer in the page stops looking.
  shown = null;
  el = section();
  el.isConnected = false;
  Q.mount(el, { dataset: { id: 'live/F' } });
  assert.equal(timers.length, 0, 'a detached section: no polling');
  console.log('Q30 section appears once a tree is on screen: OK');
}
