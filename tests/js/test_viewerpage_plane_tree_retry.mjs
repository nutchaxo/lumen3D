// The Studio opens a dataset's planes/ and mips/ trees once per page
// (viewer.js _planesTreeOnScreen / _mipsTreeOnScreen). A failure that says the tree is
// not usable — invalid manifest, cut from another bricks manifest, no codec, a 404 — is
// remembered: the next pass reads the bricks at once without asking again. A failure of
// the network or of the server (a fetch that throws, a 503, a 429) is forgotten, so the
// next native pass opens the tree instead of reading whole brick layers for the rest of
// the session.
//
// Run: node tests/js/test_viewerpage_plane_tree_retry.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';

const src = readFileSync(path.join(ROOT, 'js/pages/viewer.js'), 'utf8').replace(/\r\n/g, '\n');
function lift(name) {
  const m = src.match(new RegExp(`\\n  (?:async )?function ${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?\\n  \\}\\n`));
  assert.ok(m, `${name} must be defined at module level in viewer.js`);
  return m[0];
}

const planeError = (code, message) => Object.assign(new Error(message), { code });

function makePage(outcomes) {
  const opened = [];
  const PlaneLoader = {};
  for (const kind of ['open', 'openMips']) {
    PlaneLoader[kind] = async (base) => {
      opened.push(base);
      const next = outcomes.shift();
      if (next instanceof Error) throw next;
      return { kind: kind === 'open' ? 'planes' : 'mips', base };
    };
  }
  const body = `
    const _planeTrees = new Map();
    const _basePath = 'DATA_WEB/3d/DS';
    const datasetMeta = { formatVersion: 3 };
    let _brickManifest = null;
    let _currentTimepoint = 0;
    const PlaneCodec = {};
    ${['_planesBaseOnScreen', '_planesTreeOnScreen', '_mipsTreeOnScreen'].map(lift).join('\n')}
    return { planes: _planesTreeOnScreen, mips: _mipsTreeOnScreen, cache: _planeTrees };
  `;
  const api = new Function('PlaneLoader', 'console', body)(PlaneLoader, { warn() {} });
  return { api, opened };
}

const dims = { x: 64, y: 64, z: 64, channels: 2 };

for (const [label, err] of [
  ['network failure', new TypeError('Failed to fetch')],
  ['503', planeError('PLANES_HTTP', 'planes manifest: HTTP 503')],
  ['429', planeError('PLANES_HTTP', 'planes manifest: HTTP 429')],
  ['bricks manifest 500', planeError('PLANES_HTTP', 'bricks manifest: HTTP 500')]
]) {
  const { api, opened } = makePage([err, null]);
  assert.equal(await api.planes(dims), null, `${label}: this pass reads the bricks`);
  const tree = await api.planes(dims);
  assert.ok(tree && tree.kind === 'planes', `${label}: the next pass opens the planes`);
  assert.equal(opened.length, 2);
  assert.equal(await api.planes(dims), tree, `${label}: the opened tree is kept`);
  assert.equal(opened.length, 2, `${label}: opened once it worked`);

  const m = makePage([err, null]);
  assert.equal(await m.api.mips(dims), null);
  const mt = await m.api.mips(dims);
  assert.ok(mt && mt.kind === 'mips', `${label}: the next pass opens the mips`);
  assert.deepEqual(m.opened, ['DATA_WEB/3d/DS/mips', 'DATA_WEB/3d/DS/mips']);
}
console.log('a transient failure opening planes/ or mips/ is retried on the next pass: OK');

for (const [label, err] of [
  ['invalid planes', planeError('PLANES_INVALID', 'planes/manifest.json: bad schema')],
  ['invalid mips', planeError('MIPS_INVALID', 'mips/manifest.json: bad schema')],
  ['stale', planeError('PLANES_STALE', 'planes/ was cut from another bricks manifest')],
  ['no codec', planeError('PLANES_NO_CODEC', 'PlaneCodec is not loaded')],
  ['404', planeError('PLANES_HTTP', 'planes manifest: HTTP 404')],
  ['410', planeError('PLANES_HTTP', 'planes manifest: HTTP 410')]
]) {
  const { api, opened } = makePage([err, null]);
  assert.equal(await api.planes(dims), null);
  assert.equal(await api.planes(dims), null, `${label}: remembered`);
  assert.equal(opened.length, 1, `${label}: not asked again`);
}
console.log('a missing or invalid tree is remembered for the page: OK');

// A newer entry is never removed by the failure of an older one.
{
  let rejectFirst;
  const PlaneLoader = {
    open: () => new Promise((_, reject) => { rejectFirst = reject; }),
    openMips: async () => null
  };
  const body = `
    const _planeTrees = new Map();
    const _basePath = 'DATA_WEB/3d/DS';
    const datasetMeta = { formatVersion: 2 };
    let _brickManifest = null;
    let _currentTimepoint = 0;
    const PlaneCodec = {};
    ${['_planesBaseOnScreen', '_planesTreeOnScreen'].map(lift).join('\n')}
    return { planes: _planesTreeOnScreen, cache: _planeTrees };
  `;
  const api = new Function('PlaneLoader', 'console', body)(PlaneLoader, { warn() {} });
  const first = api.planes(dims);
  const newer = Promise.resolve({ kind: 'planes' });
  api.cache.set('DATA_WEB/3d/DS/planes', newer);
  rejectFirst(new TypeError('Failed to fetch'));
  assert.equal(await first, null);
  assert.equal(api.cache.get('DATA_WEB/3d/DS/planes'), newer, 'the newer entry stays');
  console.log('an older failure leaves a newer entry alone: OK');
}

console.log('plane tree retry: OK');
