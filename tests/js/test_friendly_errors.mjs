// Utils.friendlyError / friendlyErrorText: a technical failure (loader, GPU, server,
// file picker) reaches the reader as one translated sentence per category; the raw
// text (HTTP status, URL, parser message) never comes back from the helper.
//
// Run: node tests/js/test_friendly_errors.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

const dict = {};
const I18n = { t: (key) => (Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key) };
const U = loadModule('js/core/utils.js', 'Utils', {
  window: { location: { origin: 'https://lab.example' } },
  document: {},
  requestAnimationFrame: () => {},
  I18n,
});

const err = (message, extra = {}) => Object.assign(new Error(message), extra);
const dom = (name, message = '') => { const e = new Error(message); e.name = name; return e; };
const cat = (e, o) => U.friendlyError(e, o).category;

// By code (BrickLoader / SVRManager / VolumeViewer results).
assert.equal(cat(err('[BrickLoader] Manifest rejected: levels out of order', { code: 'BRICKS_MANIFEST_INVALID' })), 'damaged');
assert.equal(cat(err('[BrickLoader] index.bin rejected: bad magic', { code: 'BRICKS_INDEX_INVALID' })), 'damaged');
assert.equal(cat(err('Pack hash mismatch for bricks/p0.bin', { code: 'BRICKS_HASH_MISMATCH' })), 'damaged');
assert.equal(cat(err('x', { code: 'SVR_OVER_BUDGET' })), 'gpuMemory');
assert.equal(cat(err('x', { code: 'SVR_ALLOC_FAILED' })), 'gpuMemory');
assert.equal(cat({ available: false, reason: 'Insufficient GPU memory for every level', code: 'GPU_MEMORY' }), 'gpuMemory');
assert.equal(cat({ available: false, reason: 'No brick payload could be loaded', code: 'BRICKS_NONE_LOADED' }), 'noBricks');
assert.equal(cat({ available: false, reason: 'No bricks for requested timepoint 7', code: 'TIMEPOINT_MISSING' }), 'timepoint');
assert.equal(cat(err('3 brick(s) of 0/c0 could not be read', { code: 'READ_FAILED' })), 'readFailed');
assert.equal(cat('busy'), 'busy');
assert.equal(cat('vram-budget'), 'gpuMemory');
assert.equal(cat(err('x', { code: 'context-lost' })), 'gpuLost');

// By HTTP status, on the object or in the message.
assert.equal(cat(err('[BrickLoader] index.bin: HTTP 404 for bricks/index.bin', { code: 'BRICKS_INDEX_HTTP', status: 404 })), 'notFound');
assert.equal(cat(err('HTTP 404 for https://lab.example/DATA_WEB/3d/E85/bricks/lod0/p3.bin')), 'notFound');
assert.equal(cat(err('HTTP 503 for bricks/p0.bin (2 ranges)')), 'server');
assert.equal(cat(err('HTTP 403 for bricks/p0.bin')), 'access');
assert.equal(cat(err('No brick manifest (404)')), 'notFound');
assert.equal(cat(err('metadata.json unavailable (HTTP 500)', { code: 'METADATA_HTTP', status: 500 })), 'server');

// By message pattern.
assert.equal(cat(new TypeError('Failed to fetch')), 'network');
assert.equal(cat(new TypeError('NetworkError when attempting to fetch resource.')), 'network');
assert.equal(cat(new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON")), 'damaged');
assert.equal(cat(err('Invalid brick manifest payload')), 'damaged');
assert.equal(cat(err('Error creating WebGL context.')), 'webgl');
assert.equal(cat(err('Insufficient GPU memory for every level')), 'gpuMemory');

// Silent: cancellation and superseded loads.
for (const e of [dom('AbortError', 'The user aborted a request.'),
  err('[BrickLoader] another tree is mounted', { code: 'BRICKS_MOUNT_CHANGED', stale: true })]) {
  const f = U.friendlyError(e);
  assert.equal(f.silent, true, e.message);
  assert.equal(U.friendlyErrorText(e), '');
}

// The file picker: refused, disk full.
assert.equal(cat(dom('SecurityError', 'Must be handling a user gesture'), { context: 'save' }), 'saveRefused');
assert.equal(cat(dom('NotAllowedError'), { context: 'save' }), 'saveRefused');
assert.equal(cat(dom('QuotaExceededError')), 'diskFull');

// A coded user error keeps its own key and params.
const ue = U.userError('METADATA_INVALID', 'app.errMetadata', "This dataset's description is invalid.", 'Invalid metadata.json: dimensions x/y/z invalid');
assert.equal(U.friendlyError(ue).key, 'app.errMetadata');
assert.match(ue.message, /dimensions x\/y\/z invalid/, 'the technical detail stays on the message for the console');
assert.equal(U.friendlyErrorText(ue), "This dataset's description is invalid.");
const q = U.userError('QUALITY_UNAVAILABLE', 'viewer.qualityUnavailable', 'Quality {quality} unavailable', null, { quality: '1024' });
assert.equal(U.friendlyErrorText(q), 'Quality 1024 unavailable');

// Unknown → the generic sentence, never the raw text.
assert.equal(cat(err('multipart delimiter expected at byte 812')), 'unknown');
assert.equal(cat(null), 'unknown');

// Nothing technical can come back, translated or not.
const raw = [
  err('HTTP 404 for https://lab.example/DATA_WEB/3d/E85/bricks/lod0/p3.bin'),
  new TypeError('Failed to fetch'),
  new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"),
  err('[BrickLoader] index.bin rejected: bad magic', { code: 'BRICKS_INDEX_INVALID' }),
  err('multipart delimiter expected at byte 812'),
  err('Pack hash mismatch for https://lab.example/x.bin'),
  { available: false, reason: 'Timepoint 3: index t003/x is not inside its tree t003/', code: 'BRICKS_MANIFEST_INVALID' },
  'dataset live sans dimensions.t',
];
const forbidden = /HTTP \d|Failed to fetch|Unexpected token|https?:|\.bin|bad magic|multipart|DATA_WEB|BRICKS_|dimensions\.t/;
for (const e of raw) {
  const text = U.friendlyErrorText(e);
  assert.ok(text.length > 0, `a sentence for ${e && e.message || e}`);
  assert.doesNotMatch(text, forbidden, text);
}
// With translations present the key's text is what is shown.
dict['app.errNotFound'] = 'Des fichiers de ce jeu de données manquent sur le serveur.';
assert.equal(U.friendlyErrorText(raw[0]), dict['app.errNotFound']);

console.log('friendly errors: OK');
