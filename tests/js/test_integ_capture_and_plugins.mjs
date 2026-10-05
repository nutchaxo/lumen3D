/* Integration of the viewer's capture path and two plugin behaviours.

   (a) The WebGL canvas keeps no drawing buffer between frames, so every reader renders
       it in its own task first: viewer.js inits with preserveDrawingBuffer:false and
       exposes renderNow (ctx.viewer, ExportManager) and getCaptureCanvas (Compare);
       Compare reads a panel only through the page's getCaptureCanvas, never through
       the frame's document; the Download Center passes renderNow to ExportManager.
   (b) measure-distance — a pick that only met the volume's bounding box is not a
       point of the specimen: no measurement is stored, a notice is shown.
   (c) gaussian-filter — the slider follows VolumeViewer.getCapabilities().denoise and
       the 'volume-capabilities' event: disabled with a reason on a sparse atlas,
       enabled again on a dense volume, untouched before the first volume.

   Run: node tests/js/test_integ_capture_and_plugins.mjs */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');

// ── (a) capture path ───────────────────────────────────────────────────────────
{
  const v = read('js/pages/viewer.js');
  assert.ok(/VolumeViewer\.init\('webgl-canvas', \{ preserveDrawingBuffer: false \}\)/.test(v), 'the viewer drops the kept drawing buffer');
  assert.ok(/renderNow: \(\) => VolumeViewer\.renderNow\?\.\(\) \|\| false/.test(v), 'ctx.viewer.renderNow for plugins');
  assert.ok(/getCaptureCanvas,/.test(v), 'ViewerApp.getCaptureCanvas is public');
  const cap = v.slice(v.indexOf('function getCaptureCanvas()'), v.indexOf('function getSamplingVolume()'));
  assert.ok(/VolumeViewer\.renderNow\?\.\(\)/.test(cap), 'getCaptureCanvas renders the WebGL view before handing it out');
  // _copyCanvas copies the slicer's 2D read-back canvases, never the WebGL one.
  const copyFn = [v.indexOf('function _copyCanvas('), v.indexOf('}', v.indexOf('function _copyCanvas('))];
  for (const m of v.matchAll(/drawImage\((canvas|renderer\.domElement), /g)) {
    if (m.index > copyFn[0] && m.index < copyFn[1]) continue;
    const before = v.slice(Math.max(0, m.index - 400), m.index);
    assert.ok(/renderNow/.test(before), `a drawImage of the WebGL canvas renders first (offset ${m.index})`);
  }

  const c = read('js/pages/compare.js');
  assert.ok(!/contentDocument/.test(c), 'Compare never reads a panel document');
  // Compare asks the page (REQUEST_CAPTURE) and the page snapshots what it shows into a
  // bitmap in the task of the request (test_v3_page_compare_rpc.mjs runs both sides).
  assert.ok(/_rpc\.request\(panel\.index, 'REQUEST_CAPTURE'/.test(c) && !/\.(?:ViewerApp|App2D)\b/.test(c), 'Compare asks each page for its canvas');
  assert.ok(/const canvas = getCaptureCanvas\(\);\s*if \(canvas && canvas\.width && canvas\.height && typeof createImageBitmap === 'function'\) pending = createImageBitmap\(canvas\)/.test(v),
    'the volume page snapshots its capture canvas in the task of the request');
  assert.ok(/getCaptureCanvas:/.test(read('js/pages/2d.js')), 'the photograph page answers too');

  const em = read('js/core/export-manager.js');
  const fallback = em.slice(em.indexOf('const canvas = _ctx.getCanvas?.();'), em.indexOf('async function exportGraph'));
  assert.ok(/_ctx\.renderNow\?\.\(\);\s*\n?\s*const blob = await new Promise\(resolve => canvas\.toBlob/.test(fallback), 'ExportManager renders before reading a canvas');
  assert.ok(/renderNow: \(\) => this\._ctx\.viewer\?\.renderNow\?\.\(\)/.test(read('js/modules/tools/download-center/index.js')), 'the Download Center hands renderNow over');
  assert.ok(!/AnnotationManager/.test(read('js/modules/tools/download-center/index.js')), 'no dead annotation export');

  for (const html of ['viewer.html', 'compare.html', 'explorer.html']) {
    const h = read(html);
    for (const gone of ['aabb-intersector.js', 'download-manifest.js', 'annotation-manager.js', 'annotation-layer.js']) {
      assert.ok(!h.includes(gone), `${html} does not load ${gone}`);
    }
  }
}

function loadPlugin(id, extra = {}) {
  let impl = null;
  const sandbox = {
    console, Math, Number, String, Object, Array, Map, Set, JSON, Error, Promise, Boolean,
    PluginRegistry: { implement: (_id, obj) => { impl = obj; } },
    ...extra
  };
  vm.createContext(sandbox);
  vm.runInContext(read(`js/modules/${id}/index.js`), sandbox, { filename: `${id}/index.js` });
  assert.ok(impl, `${id} registers`);
  return impl;
}

// ── (b) measure-distance ───────────────────────────────────────────────────────
{
  const md = loadPlugin('tools/measure-distance', { document: { getElementById: () => null } });
  const added = [];
  let status = '';
  const ctx = {
    i18n: { t: (k) => k },
    measurements: { list: () => [], add: (_s, m) => added.push(m) },
    viewer: { onMeasurePoint() {}, setMeasurements() {}, getPhysicalCalibration: () => ({ calibrationStatus: 'exact' }) },
    ui: { escapeHtml: (s) => s },
    _state: { currentTimepoint: 0 }
  };
  md.init(ctx);
  md._setStatus = (s) => { status = s; };
  md._render = () => {};
  const real = { normalized: { x: 0.2, y: 0.2, z: 0.2 }, physicalUm: { x: 2, y: 2, z: 2 }, onBoundingBox: false };
  const box = { normalized: { x: 0, y: 0.5, z: 0.5 }, physicalUm: { x: 0, y: 5, z: 5 }, onBoundingBox: true };
  md._handlePoint(real);
  md._handlePoint(box);
  assert.equal(added.length, 0, 'a bounding-box pick never completes a measurement');
  assert.equal(status, 'noStructure', 'the user is told nothing is under the cursor');
  assert.equal(md._draft.length, 1, 'the first real point is kept');
  md._handlePoint({ ...real, physicalUm: { x: 5, y: 6, z: 2 } });
  assert.equal(added.length, 1, 'a second real point measures');
  assert.equal(added[0].distance, 5);
  for (const code of ['en', 'fr', 'es', 'nl']) {
    assert.equal(typeof JSON.parse(read(`js/modules/tools/measure-distance/lang/${code}.json`)).noStructure, 'string', `${code}: noStructure`);
  }
}

// ── (c) gaussian-filter ────────────────────────────────────────────────────────
{
  let caps = { denoise: { available: false, reason: 'no-volume' } };
  const listeners = {};
  const window = {
    addEventListener: (t, fn) => { listeners[t] = fn; },
    removeEventListener: (t, fn) => { if (listeners[t] === fn) delete listeners[t]; }
  };
  const gf = loadPlugin('channels/gaussian-filter', { window, VolumeViewer: { getCapabilities: () => caps } });
  const row = { title: '', removeAttribute(a) { if (a === 'title') this.title = ''; } };
  const slider = { disabled: false, isConnected: true, closest: () => row, addEventListener() {} };
  const container = { querySelector: (sel) => (sel === '#ch-denoise-0' ? slider : null) };
  gf.init({});
  gf.bindChannelUI(0, { denoise_sigma: 0 }, container, { onStateChange() {}, getState: () => ({}) });
  assert.equal(slider.disabled, false, 'before the first volume the slider stays usable');
  assert.ok(typeof listeners['volume-capabilities'] === 'function', 'the plugin follows the capability event');

  listeners['volume-capabilities']({ detail: { denoise: { available: false, reason: 'sparse-atlas' } } });
  assert.equal(slider.disabled, true, 'a sparse atlas disables the blur');
  assert.ok(/sparse brick atlas/.test(row.title), 'with the reason as a tooltip');

  listeners['volume-capabilities']({ detail: { denoise: { available: true, reason: null } } });
  assert.equal(slider.disabled, false, 'a dense volume enables it again');
  assert.equal(row.title, '', 'and clears the tooltip');

  caps = { denoise: { available: false, reason: 'sparse-atlas' } };
  const slider2 = { disabled: false, isConnected: true, closest: () => row, addEventListener() {} };
  gf.bindChannelUI(1, { denoise_sigma: 0 }, { querySelector: (sel) => (sel === '#ch-denoise-1' ? slider2 : null) }, { onStateChange() {}, getState: () => ({}) });
  assert.equal(slider2.disabled, true, 'a slider built on a sparse atlas starts disabled');

  gf.dispose();
  assert.equal(listeners['volume-capabilities'], undefined, 'dispose removes the listener');
  for (const code of ['en', 'fr', 'es', 'nl']) {
    const d = JSON.parse(read(`js/modules/channels/gaussian-filter/lang/${code}.json`));
    assert.ok(typeof d.unavailableSparse === 'string' && typeof d.unavailable === 'string', `${code}: unavailable texts`);
  }
}

console.log('capture path (no kept drawing buffer), measure-distance bounding-box pick, gaussian-filter capabilities: OK');
