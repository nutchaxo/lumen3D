// Review fixes of the viewer page, the slicer and the Studio, run as written (each
// function lifted from its source) against scripted stubs:
//   • a timelapse frame that fails after the frame on screen was taken down for it
//     puts that frame back (from the cache), the scrubber goes back to it, and the
//     put-back is neither posted to the siblings nor retried in a loop;
//   • a sibling's SYNC_TIME frame is clamped to this series' length;
//   • a boot failure posts PANEL_ERROR once;
//   • metadata.json: a 404 of a published dataset is fatal, a 5xx / no answer falls
//     back to the catalog row when it carries the dimensions (as before the change);
//   • QUALITY_STATUS says when the viewer settled on a coarser level than asked;
//   • an uncalibrated Studio picture measures in image pixels;
//   • the Studio channel panel follows a raw refilled in place (raw.version);
//   • the slicer clears its target to transparent black whatever the page's clear colour;
//   • a quality switch made while a frame request runs (or waits) reloads THAT frame,
//     not the one still on screen, and a same-frame reload posts no SYNC_TIME.
//
// Run: node tests/js/test_viewerpage_review_fixes.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const viewerSrc = read('js/pages/viewer.js');
const studioSrc = read('js/components/studio-editor.js');
const slicerSrc = read('js/viewers/volume-slicer.js');

function lift(src, name) {
  const m = src.match(new RegExp(`\\n  (?:async )?function ${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?\\n  \\}\\n`));
  assert.ok(m, `${name} must be defined at module level`);
  return m[0];
}

const tick = () => new Promise(resolve => setImmediate(resolve));
// Values made in a vm context have that realm's prototypes: compare their JSON.
const plain = (v) => JSON.parse(JSON.stringify(v));

// ── 1. A failed frame of a timelapse ────────────────────────────────────────────
{
  const run = async ({ failFrames, mountedAfterFailure }) => {
    const ctx = vm.createContext({ console, setImmediate });
    const log = { loads: [], errors: [], frames: [] };
    ctx.env = { failFrames, mountedAfterFailure, log };
    vm.runInContext(`
      let _tpInFlight = false, _tpPending = null, _tpTarget = null, _currentTimepoint = 3, isLive = true, mounted = true;
      const Timeline = { setFrame: (f, i, n) => env.log.frames.push([f, n]) };
      function _hasMountedVolume() { return mounted; }
      function _showLoadingError(err) { env.log.errors.push(err.message); }
      function _loadTimepoint(basePath, t, opts) {
        env.log.loads.push([t, opts.origin]);
        return new Promise((resolve, reject) => setImmediate(() => {
          if (env.failFrames.includes(t)) { mounted = env.mountedAfterFailure; reject(new Error('frame ' + t)); }
          else { _currentTimepoint = t; mounted = true; resolve({ ok: true }); }
        }));
      }
      ${lift(viewerSrc, '_requestTimepoint')}
      globalThis.api = { req: _requestTimepoint, cur: () => _currentTimepoint, mounted: () => mounted };
    `, ctx);
    ctx.api.req('base', 7, 'user');
    for (let i = 0; i < 10; i++) await tick();
    return { log, api: ctx.api };
  };

  // The volume on screen was taken down for the failed frame: frame 3 comes back.
  let { log, api } = await run({ failFrames: [7], mountedAfterFailure: false });
  assert.deepEqual(plain(log.loads), [[7, 'user'], [3, 'sync']], 'the frame on screen is put back, silently (no SYNC_TIME)');
  assert.deepEqual(plain(log.frames), [[3, false]], 'the scrubber goes back to the frame on screen');
  assert.equal(api.cur(), 3);
  assert.equal(api.mounted(), true, 'a volume is on screen again');

  // Still mounted (a deferred swap): nothing to put back.
  ({ log } = await run({ failFrames: [7], mountedAfterFailure: true }));
  assert.deepEqual(plain(log.loads), [[7, 'user']], 'no reload when the frame on screen stayed up');

  // The put-back fails too: one attempt, no loop.
  ({ log } = await run({ failFrames: [7, 3], mountedAfterFailure: false }));
  assert.deepEqual(plain(log.loads), [[7, 'user'], [3, 'sync']], 'a failed put-back is not retried');
  assert.equal(log.errors.length, 2);
  console.log('failed timelapse frame: the frame on screen is put back: OK');
}

// ── 2. SYNC_TIME clamped to this series ─────────────────────────────────────────
{
  const block = viewerSrc.match(/\} else if \(data\.type === 'SYNC_TIME' && isLive\) \{\n([\s\S]*?)\n    \}\n/);
  assert.ok(block, 'SYNC_TIME handler');
  const ctx = vm.createContext({});
  const out = [];
  ctx.out = out;
  vm.runInContext(`
    const datasetMeta = { dimensions: { t: 10 } };
    const _basePath = 'b';
    const Timeline = { setFrame: () => {} };
    function _requestTimepoint(b, f, o) { out.push([f, o]); }
    globalThis.handle = (data) => { ${block[1]} };
  `, ctx);
  ctx.handle({ value: 40, total: 0 });
  ctx.handle({ value: -3, total: 0 });
  ctx.handle({ value: 99, total: 100, fraction: 1 });
  assert.deepEqual(plain(out), [[9, 'sync'], [0, 'sync'], [9, 'sync']], 'a sibling frame is clamped to [0, t − 1]');
  console.log('SYNC_TIME frame clamped: OK');
}

// ── 3. One PANEL_ERROR on a boot failure ────────────────────────────────────────
{
  const posts = [];
  const ctx = vm.createContext({ posts });
  vm.runInContext(`
    let _isInitialized = false;
    function _postToHost(m) { posts.push(m); }
    function _showLoadingError(err) { _postToHost({ type: 'PANEL_ERROR', message: err.message }); }
    ${lift(viewerSrc, '_bootFailed')}
    globalThis.fail = _bootFailed;
  `, ctx);
  ctx.fail(new Error('boom'));
  assert.equal(posts.filter(p => p.type === 'PANEL_ERROR').length, 1, 'PANEL_ERROR is posted once');
  const posts2 = [];
  const ctx2 = vm.createContext({ posts: posts2 });
  vm.runInContext(`
    let _isInitialized = false;
    function _postToHost(m) { posts.push(m); }
    function _showLoadingError() { throw new Error('no DOM'); }
    ${lift(viewerSrc, '_bootFailed')}
    globalThis.fail = _bootFailed;
  `, ctx2);
  assert.throws(() => ctx2.fail(new Error('boom')));
  assert.equal(posts2.length, 1, 'still told when the error card itself failed');
  console.log('boot failure: one PANEL_ERROR: OK');
}

// ── 4. metadata.json unavailable ────────────────────────────────────────────────
{
  const run = async ({ status, path: p = '3d/a', dims = true }) => {
    const ctx = vm.createContext({ console: { warn() {} } });
    ctx.res = { status };
    vm.runInContext(`
      const _STAGING_PREFIX = 'staging:';
      let datasetMeta = { id: '${p}', path: '${p}', type: '3d', ${dims ? 'dimensions: { x: 1, y: 1, z: 1 },' : ''} };
      let _prefetchedMeta = null;
      const _t = (k, f) => f;
      const _tf = (k, f, p) => f.replace('{status}', p.status);
      function _fetchDatasetMetadata() { return Promise.resolve({ ok: false, status: res.status, meta: null, error: null }); }
      ${lift(viewerSrc, '_mergeDatasetMetadata')}
      globalThis.go = _mergeDatasetMetadata;
    `, ctx);
    try { await ctx.go(); return 'mounted'; } catch (err) { return err.message; }
  };
  assert.match(await run({ status: 404 }), /HTTP 404/, 'a published dataset without metadata.json is refused');
  assert.equal(await run({ status: 503 }), 'mounted', 'a 5xx falls back to the catalog row');
  assert.equal(await run({ status: 0 }), 'mounted', 'no answer falls back to the catalog row');
  assert.match(await run({ status: 503, dims: false }), /HTTP 503/, 'never without the catalog dimensions');
  assert.equal(await run({ status: 404, path: 'staging:3d/a' }), 'mounted', 'a staged import reads the catalog row');
  console.log('metadata.json unavailable: 404 fatal, transient falls back: OK');
}

// ── 5. QUALITY_STATUS of a downgraded switch ────────────────────────────────────
{
  const block = viewerSrc.match(/\} else if \(data\.type === 'SET_QUALITY'\) \{\n([\s\S]*?)\n    \} else if \(data\.type === 'SET_SAMPLE_UPSIDE_DOWN'\)/);
  assert.ok(block, 'SET_QUALITY handler');
  const posts = [];
  const ctx = vm.createContext({ posts });
  vm.runInContext(`
    let _qualityMode = '512x512', _currentTimepoint = null;
    const _loadedQualities = new Set();
    const _qualityKey = (t, q) => q;
    const _normalizeQualityParam = (q) => (['512x512', '1024x1024', 'native'].includes(q) ? q : null);
    const _withColumn = (q) => q;   // a v2 / v3 tree: no compression column
    const _qualityBaseOf = (q) => String(q || '').split('@')[0];
    function _postToHost(m) { posts.push(m); }
    function _setQualityMode(q) { _qualityMode = q === 'native' ? '1024x1024' : q; return Promise.resolve({ ok: true }); }
    globalThis.handle = (data) => { ${block[1]} };
  `, ctx);
  ctx.handle({ quality: 'native' });
  await tick();
  assert.equal(posts[0].phase, 'ready');
  assert.equal(posts[0].quality, '1024x1024');
  assert.equal(posts[0].requested, 'native');
  assert.equal(posts[0].downgraded, true, 'the host hears the switch settled lower than asked');
  ctx.handle({ quality: 'bogus' });
  assert.equal(posts[1].phase, 'error', 'an unknown level is answered');
  console.log('QUALITY_STATUS downgraded: OK');
}

// ── 6. Studio: uncalibrated picture in pixels, channel panel on raw.version ─────
{
  const ctx = vm.createContext({});
  vm.runInContext(`
    let _doc = null;
    ${lift(studioSrc, '_normalizePixelSize')}
    ${lift(studioSrc, '_isUncalibrated')}
    ${lift(studioSrc, '_pixelSizeForPoint')}
    globalThis.api = { set: (d) => { _doc = d; }, px: () => _pixelSizeForPoint(0, 0) };
  `, ctx);
  ctx.api.set({ calibration: { calibrated: false, pixelSizeUm: { x: 0.0002, y: 0.0002 } }, layoutMaps: [] });
  assert.deepEqual(plain({ ...ctx.api.px() }), { x: 1, y: 1 }, 'an uncalibrated picture counts image pixels');
  ctx.api.set({ calibration: { calibrated: true, pixelSizeUm: { x: 0.5, y: 0.5 } }, layoutMaps: [] });
  assert.equal(ctx.api.px().x, 0.5, 'a calibrated one keeps its µm per px');
  assert.match(studioSrc, /rawVersion: raw\?\.version/, 'the channel panel cache is keyed on raw.version');
  assert.match(studioSrc, /_channelsShown\.rawVersion === shown\.rawVersion/, 'and compares it');
  console.log('Studio calibration and channel panel cache: OK');
}

// ── 7. The slicer's target is cleared transparent ───────────────────────────────
{
  const draw = lift(slicerSrc, '_drawInto');
  const calls = [];
  const renderer = {
    _clear: { c: 0x223344, a: 1 },
    getRenderTarget: () => null,
    getViewport: (v) => v,
    setViewport() {},
    autoClear: false,
    getClearColor: (c) => { c.v = renderer._clear.c; return c; },
    getClearAlpha: () => renderer._clear.a,
    setClearColor: (c, a) => { renderer._clear = { c: typeof c === 'object' ? c.v : c, a }; calls.push(['setClearColor', renderer._clear.c, a]); },
    setRenderTarget() {},
    clear: () => calls.push(['clear', renderer._clear.c, renderer._clear.a]),
    render() {},
    readRenderTargetPixels() {}
  };
  const ctx = vm.createContext({
    THREE: { Vector4: class { set() {} }, Color: class {} },
    _renderer: renderer,
    _scene: { children: [{ material: null }] },
    _camera: {}
  });
  vm.runInContext(`${draw}\nglobalThis.go = _drawInto;`, ctx);
  ctx.go({}, { viewport: { set() {} } }, 4, 4, new Uint8Array(64));
  const cleared = calls.find(c => c[0] === 'clear');
  assert.deepEqual(plain(cleared.slice(1)), [0, 0], 'the target is cleared to transparent black');
  assert.deepEqual(renderer._clear, { c: 0x223344, a: 1 }, 'the page clear colour is restored');
  console.log('slicer target cleared transparent: OK');
}

// ── 8. A quality switch during a frame request ──────────────────────────────────
{
  const run = async (script, { failFrames = [] } = {}) => {
    const ctx = vm.createContext({ console, setImmediate });
    const log = { loads: [], posted: [], frames: [], status: [] };
    ctx.env = { log, failFrames };
    vm.runInContext(`
      let _tpInFlight = false, _tpPending = null, _tpTarget = null, _currentTimepoint = 5, isLive = true;
      let _qualityMode = '512x512', _basePath = 'base', token = 0;
      const Timeline = { setFrame: (f, i, n) => env.log.frames.push([f, n]) };
      const VolumeViewer = { setQualityTarget() {} };
      const Utils = { friendlyErrorText: () => '' };
      const document = { getElementById: () => null };
      function _hasMountedVolume() { return true; }
      function _showLoadingError() {}
      function _applyQualityMode(v) { _qualityMode = v; }
      function _kickPrefetch() {}
      function _showQualityInSelect() {}
      function _setQualityStatus(s) { env.log.status.push(s); }
      function _qualityLabel(q) { return q; }
      // A load supersedes every earlier one (the page's _activeLoadToken): the earlier
      // resolves undefined and changes nothing; the winner shows its frame and tells the
      // siblings unless the frame came from one of them.
      function _loadTimepoint(basePath, t, opts = {}) {
        const mine = ++token;
        env.log.loads.push([t, opts.origin || null, Boolean(opts.force), _qualityMode]);
        return new Promise((resolve, reject) => setImmediate(() => {
          if (mine !== token) { resolve(undefined); return; }
          if (env.failFrames.includes(t) && opts.force) { reject(new Error('frame ' + t)); return; }
          _currentTimepoint = t;
          if (opts.origin !== 'sync') env.log.posted.push(['SYNC_TIME', t]);
          resolve({ ok: true });
        }));
      }
      ${lift(viewerSrc, '_requestTimepoint')}
      ${lift(viewerSrc, '_setQualityMode')}
      globalThis.api = { req: _requestTimepoint, quality: _setQualityMode, cur: () => _currentTimepoint,
        inFlight: () => _tpInFlight, pending: () => _tpPending, target: () => _tpTarget };
    `, ctx);
    await script(ctx.api);
    for (let i = 0; i < 10; i++) await tick();
    return { log, api: ctx.api };
  };

  // Scrub to 20, then switch quality while 20 is still loading.
  let { log, api } = await run(async (a) => { a.req('base', 20, 'user'); a.quality('1024x1024').catch(() => {}); });
  assert.deepEqual(plain(log.loads), [[20, 'user', false, '512x512'], [20, 'user', true, '1024x1024']],
    'the switch reloads the frame the scrubber asked for, at the new quality');
  assert.equal(api.cur(), 20, 'frame 20 ends on screen');
  assert.deepEqual(plain(log.posted), [['SYNC_TIME', 20]], 'announced once, never the old frame');
  assert.equal(api.target(), null, 'no request left recorded');
  assert.equal(api.inFlight(), false);

  // A frame queued behind the running one is the one to load; nothing is re-asked after.
  ({ log, api } = await run(async (a) => { a.req('base', 20, 'user'); a.req('base', 30, 'user'); a.quality('native').catch(() => {}); }));
  assert.deepEqual(plain(log.loads), [[20, 'user', false, '512x512'], [30, 'user', true, 'native']],
    'the queued frame is taken over by the switch, not loaded a second time');
  assert.equal(api.cur(), 30);
  assert.equal(api.pending(), null);

  // A frame a sibling asked for stays silent at the new quality.
  ({ log, api } = await run(async (a) => { a.req('base', 12, 'sync'); a.quality('1024x1024').catch(() => {}); }));
  assert.deepEqual(plain(log.loads.map(l => l.slice(0, 3))), [[12, 'sync', false], [12, 'sync', true]]);
  assert.equal(api.cur(), 12);
  assert.deepEqual(plain(log.posted), [], 'no SYNC_TIME echo of a sibling frame');

  // No request running: the frame on screen is reloaded, and a quality change is no time change.
  ({ log, api } = await run(async (a) => { a.quality('1024x1024').catch(() => {}); }));
  assert.deepEqual(plain(log.loads), [[5, 'sync', true, '1024x1024']]);
  assert.deepEqual(plain(log.posted), [], 'a same-frame quality reload posts no SYNC_TIME');

  // The switch fails on the frame it carried: the scrubber goes back to the frame on screen.
  ({ log, api } = await run(async (a) => { a.req('base', 20, 'user'); a.quality('native').catch(() => {}); }, { failFrames: [20] }));
  assert.equal(api.cur(), 5, 'frame 5 is still the one on screen');
  assert.deepEqual(plain(log.frames), [[5, false]], 'the scrubber is put back on it');
  console.log('quality switch during a frame request reloads the requested frame: OK');
}

console.log('viewer page review fixes: OK');
