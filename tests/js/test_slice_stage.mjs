// Unit tests for the slice stage (web v1.55.2): while the slice tool is open the two
// renders trade places — the slicer's canvas fills the canvas area, the WebGL canvas
// moves into the inspector's square — and the tool and the Z-stack browser exclude
// each other.
//   • VolumeSlicer: setPreviewResolution / the settled refine pass / onVisibleChange /
//     flushPreview / the plane-key whitelist (behavioural, stub THREE + renderer);
//   • zstack-browser: opening closes the slice tool and drops a staged slice;
//   • slice-inspector: activate() toggles the ToolManager's 'slice';
//   • viewer.js / compare.js / viewer.html / CSS / lang: the swap, the exclusion on
//     the tool change, the restore path, the figure capture (structural).
//
// Run: node tests/js/test_slice_stage.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadModule, ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r/g, '');

// ── VolumeSlicer (behavioural) ───────────────────────────────────────────────
{
  const allocations = [];
  const disposed = [];
  // Real vector / quaternion math (the plane geometry evolves with the Studio's
  // native slice); only the GPU objects are stubbed.
  const REAL = createRequire(import.meta.url)('../../js/vendor/three.min.js');
  const THREE = {
    ...REAL,
    Scene: class { constructor() { this.children = []; } add(o) { this.children.push(o); } },
    OrthographicCamera: class {},
    PlaneGeometry: class {},
    Mesh: class { constructor(g, m) { this.material = m; } },
    ShaderMaterial: class { constructor(o) { Object.assign(this, o); } dispose() {} },
    WebGLRenderTarget: class {
      constructor(w) { this.width = w; allocations.push(w); }
      dispose() { disposed.push(this.width); }
    },
  };
  const renders = [];
  const renderer = {
    autoClear: false,
    getRenderTarget: () => null, getViewport() {}, setViewport() {}, setRenderTarget() {}, clear() {}, render() {},
    getPixelRatio: () => 1,
    readRenderTargetPixels: (t, x, y, w, h, buf) => { renders.push(w); buf.fill(7); },
  };
  const document = {
    createElement: () => {
      const c = { width: 0, height: 0, className: '', puts: [] };
      c.getContext = () => ({
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: (img) => { c.puts.push(img.width); },
        clearRect() {}, fillRect() {}, fillText() {},
      });
      return c;
    },
  };
  let rafQueue = [];
  let timers = [];
  const S = loadModule('js/viewers/volume-slicer.js', 'VolumeSlicer', {
    THREE, document, window: {},
    requestAnimationFrame: (cb) => { rafQueue.push(cb); return rafQueue.length; },
    cancelAnimationFrame: () => { rafQueue = []; },
    setTimeout: (cb, ms) => { const id = { cb, ms }; timers.push(id); return id; },
    clearTimeout: (id) => { timers = timers.filter((t) => t !== id); },
  });
  const flushRaf = () => rafQueue.splice(0).forEach((cb) => cb(0));
  const fireTimers = () => timers.splice(0).forEach((t) => t.cb());
  // Objects born in the vm realm have another Object prototype: copy before deepEqual.
  const resolution = () => ({ ...S.getPreviewResolution() });

  const material = { uniforms: { svrAtlas0: { value: { isTexture: true } }, numChannels: { value: 1 } }, defines: {} };
  assert.equal(S.init({ renderer, material }), true, 'slicer initialises');
  const preview = S.getPreviewCanvas();
  assert.equal(preview.width, 320, 'sidebar preview is 320 px');
  assert.deepEqual(resolution(), { size: 320, refineSize: 0 });
  assert.equal(S.getPlaneExtentUnits(), 1.5, 'the square spans 2 × EXTENT cube units');

  const seen = [];
  S.onVisibleChange((v) => seen.push(v));
  S.setVisible(true); S.setVisible(true); S.setVisible(false); S.setVisible(true);
  assert.deepEqual(seen, [true, false, true], 'visibility fires on a change only');

  flushRaf();
  assert.deepEqual(renders, [320], 'one interactive render at the sidebar size');
  assert.equal(timers.length, 0, 'no refine pass without a refine size');

  // On the stage: interactive at 1024, a sharper pass once the plane settles.
  S.setPreviewResolution(1024, 1603);
  assert.deepEqual(resolution(), { size: 1024, refineSize: 1600 }, 'sizes snap to a multiple of 8');
  flushRaf();
  assert.equal(renders.at(-1), 1024, 'renders at the interactive size');
  assert.equal(preview.width, 1024, 'the canvas follows the render size');
  assert.equal(timers.length, 1, 'a refine pass is armed');
  assert.equal(timers[0].ms, 160, 'after the settle delay');

  S.setPlaneSpec({ value: 0.4 });
  assert.equal(timers.length, 0, 'a new spec cancels the pending refine — a drag never pays it');
  flushRaf();
  assert.equal(renders.at(-1), 1024);
  fireTimers();
  assert.equal(renders.at(-1), 1600, 'the settled plane is rendered sharp');
  assert.equal(preview.width, 1600);
  assert.equal(preview.puts.at(-1), 1600, 'the sharp pass reaches the canvas');

  S.setPlaneSpec({ value: 0.45 });
  assert.equal(S.flushPreview(), true, 'flushPreview renders now');
  assert.equal(renders.at(-1), 1600, 'at the sharpest size');
  assert.equal(rafQueue.length, 0, 'and drops the pending interactive frame');

  S.setPreviewResolution();
  assert.deepEqual(resolution(), { size: 320, refineSize: 0 }, 'back to the sidebar size');
  assert.ok(disposed.includes(1024) && disposed.includes(1600), 'the stage passes are released');
  flushRaf();
  assert.equal(preview.width, 320);
  assert.equal(allocations.filter((n) => n === 320).length, 2, 'the sidebar pass, released on the way to the stage, is re-created lazily');

  S.setPreviewResolution(5000, 9000);
  assert.deepEqual(resolution(), { size: 2048, refineSize: 0 }, 'capped at the readback ceiling, no refine at the cap');
  S.setPreviewResolution('nope', -3);
  assert.deepEqual(resolution(), { size: 320, refineSize: 0 }, 'garbage falls back to the default');

  // A sibling panel's spec carries the 3D plane's own keys: they stay out of the slicer.
  S.setPlaneSpec({ value: 0.3, mode: 'xz', visible: false, normal: [0, 0, 1], orientation: [0, 0, 0, 1], axis: 'z' });
  const spec = S.getPlaneSpec();
  assert.equal(spec.value, 0.3);
  assert.equal(spec.mode, 'xz');
  for (const k of ['visible', 'normal', 'orientation', 'axis']) assert.ok(!(k in spec), `${k} filtered out`);

  S.setVisible(false);
  assert.equal(timers.length, 0, 'hiding cancels a pending refine');
  S.dispose();
  assert.ok(disposed.includes(320), 'dispose releases every pass');
}

// ── zstack-browser: opening closes the slice tool (behavioural) ──────────────
{
  const elements = new Map();
  const makeEl = (id) => {
    const classes = new Set();
    const el = {
      id, style: {}, attrs: {}, textContent: '', value: '', max: '', title: '', disabled: false,
      classList: {
        add: (c) => classes.add(c), remove: (c) => classes.delete(c),
        toggle: (c, on) => { on ? classes.add(c) : classes.delete(c); return classes.has(c); },
        contains: (c) => classes.has(c),
      },
      setAttribute: (k, v) => { el.attrs[k] = String(v); },
      addEventListener() {},
      querySelector: () => null,
      getContext: () => new Proxy({}, { get: () => () => {} }),
      width: 200, height: 280,
    };
    return el;
  };
  const $ = (id) => { if (!elements.has(id)) elements.set(id, makeEl(id)); return elements.get(id); };
  let plugin = null;
  loadModule('js/modules/tools/zstack-browser/index.js', 'ZNone', {
    PluginRegistry: { implement: (_id, obj) => { plugin = obj; }, syncToolbarButton() {} },
    document: { getElementById: $ },
    AbortController,
  });
  assert.ok(plugin, 'zstack-browser captured');
  const calls = [];
  let tool = 'slice';
  const ctx = {
    _state: { zstackActive: false, zstackCurrentSlice: 0, suppressZstackSync: false },
    iframe: { isIframe: () => false, postMessage() {}, panelIndex: () => null },
    viewer: {
      setClipRange_z() {}, setView() {}, setRotationLocked() {}, resetClipping() {},
      setCutPlaneVisible: (v) => calls.push(['cutPlane', v]),
    },
    tools: { current: () => tool, activate: (t) => { calls.push(['tool', t]); tool = t; } },
    slicer: { setVisible: (v) => calls.push(['slicerVisible', v]) },
    dataset: { getMeta: () => ({ dimensions: { z: 50, c: 1 }, voxel_size: { z: 1 } }) },
    ui: { scheduleResize() {}, openStudio() {} },
    i18n: { t: (k) => k, onLanguageChange() {} },
  };
  plugin.init(ctx);

  plugin.activate();
  assert.equal(ctx._state.zstackActive, true, 'browser open');
  assert.deepEqual(calls, [['tool', 'navigate'], ['slicerVisible', false], ['cutPlane', false]],
    'opening leaves the slice tool, drops a staged slice and hides the 3D plane');

  calls.length = 0;
  plugin.applyState(false, null);
  tool = 'navigate';
  plugin.applyState(true, null);
  assert.ok(!calls.some((c) => c[0] === 'tool'), 'no tool change when the slice tool is not current');
  assert.ok(calls.some((c) => c[0] === 'slicerVisible' && c[1] === false), 'a slice a sibling staged still goes');
  plugin.applyState(false, null);

  // Closing a browser that is not open leaves the volume alone: a workspace restore
  // applies { zstackActive: false } right after the cut plane it restored, and the
  // browser's resetClipping used to erase that plane (and tell the siblings 'off').
  const resets = [];
  const posted = [];
  ctx.viewer.resetClipping = () => resets.push(1);
  ctx.iframe = { isIframe: () => true, postMessage: (m) => posted.push(m), panelIndex: () => 0 };
  plugin.setState({ zstackActive: false, zstackSlice: 0 });
  plugin.applyState(false, null);
  assert.equal(resets.length, 0, 'no resetClipping for a browser that was not open');
  assert.equal(posted.length, 0, "no SYNC_ZSTACK_SLICE 'off' either");
  plugin.applyState(true, null);
  plugin.applyState(false, null);
  assert.equal(resets.length, 1, 'a real close still resets the clip');
  assert.ok(posted.some((m) => m.type === 'SYNC_ZSTACK_SLICE' && m.mode === 'off'), 'and tells the siblings');
  ctx.iframe = { isIframe: () => false, postMessage() {}, panelIndex: () => null };

  // A ctx without tools/slicer (older core, the slab test's ctx): still opens.
  delete ctx.tools; delete ctx.slicer; delete ctx.viewer.setCutPlaneVisible;
  plugin.activate();
  assert.equal(ctx._state.zstackActive, true, 'exclusion is optional-chained');
  plugin.dispose();
}

// ── slice-inspector: activate() toggles the ToolManager's 'slice' ─────────────
{
  let plugin = null;
  loadModule('js/modules/tools/slice-inspector/index.js', 'SNone', {
    PluginRegistry: { implement: (_id, obj) => { plugin = obj; } },
    document: { getElementById: () => null, querySelectorAll: () => [] },
  });
  assert.ok(plugin, 'slice-inspector captured');
  let tool = 'navigate';
  const toolCalls = [];
  const hides = [];
  const ctx = {
    slicer: { setVisible: (v) => hides.push(['slicer', v]) },
    viewer: { setCutPlaneVisible: (v) => hides.push(['plane', v]), onPlaneSpecChange() {} },
    ui: { scheduleResize: () => hides.push(['resize']) },
    tools: { current: () => tool, activate: (t) => { toolCalls.push(t); tool = t; } },
  };
  plugin.init(ctx);
  plugin.activate();
  plugin.activate();
  assert.deepEqual(toolCalls, ['slice', 'navigate'], 'activate() toggles through the ToolManager, under the chip name');
  plugin.reset();
  assert.deepEqual(hides, [['slicer', false], ['plane', false], ['resize']], 'reset with the tool off hides the panel and the slice');
  tool = 'slice'; toolCalls.length = 0;
  plugin.reset();
  assert.deepEqual(toolCalls, ['navigate'], 'reset with the tool on leaves it through the ToolManager');
}

// ── Structural: the swap and the exclusion in the pages ──────────────────────
{
  const v = read('js/pages/viewer.js');
  const onChange = v.slice(v.indexOf('onChange: (tool) => {'), v.indexOf('onChange: (tool) => {') + 900);
  assert.ok(/if \(tool === 'slice' && _zstackActive\) _applyZstackState\(false, null\);/.test(onChange), 'picking the slice tool closes the browser');
  assert.ok(onChange.indexOf('_applyZstackState(false, null)') < onChange.indexOf("_slicerShow(tool === 'slice')"), 'closed before the panel opens (resetClipping would undo the plane)');
  assert.ok(/VolumeSlicer\.onVisibleChange\(_setSliceStage\)/.test(v), 'the stage follows the slicer visibility');
  const stage = v.slice(v.indexOf('function _setSliceStage(on)'), v.indexOf('function _updateSliceStageResolution'));
  assert.ok(/stage\.appendChild\(slice\)/.test(stage) && /mount\.appendChild\(gl\)/.test(stage), 'on: slice canvas to the stage, WebGL canvas to the inspector square');
  assert.ok(/insertBefore\(gl, stage\)/.test(stage) && /mount\.appendChild\(slice\)/.test(stage), 'off: both canvases go back');
  assert.ok(/VolumeSlicer\.setPreviewResolution\(\)/.test(stage), 'off: sidebar resolution again');
  assert.ok(/setCameraState\(\{ kind: 'volume', cameraZ: cam\.z \}\)/.test(stage), 'an untouched camera distance comes back');
  assert.ok(/body\.classList\.toggle\('slice-staged', on\)/.test(stage), 'body flag for the CSS');
  assert.equal((v.match(/ToolManager\.activate\('cut'\)/g) || []).length, 0, "no restore through the chip-less 'cut' name");
  assert.ok(/try \{ ToolManager\.activate\('slice'\); \} finally \{ _suppressToolSync = false; \}/.test(v), 'a saved open plane reopens the slice tool, silently in a panel');
  const fig = v.slice(v.indexOf('async function _getFigureBlob'), v.indexOf('async function _getFigureBlob') + 600);
  assert.ok(/_sliceStaged/.test(fig) && /flushPreview/.test(fig), 'a screenshot on the stage captures the sharp slice');
  const sync = v.slice(v.indexOf("data.type === 'SYNC_SLICER_SPEC'"), v.indexOf("data.type === 'SYNC_TIME'"));
  assert.ok(/VolumeViewer\.setPlaneSpec\(spec, \{ notify: false, visible: specVisible \|\| ownTool \}\)/.test(sync), 'the 3D plane follows a sibling');
  assert.ok(/if \(!ownTool\) VolumeSlicer\.setVisible\(specVisible\)/.test(sync), 'a sibling drives the stage only when the own tool is off');
  assert.ok(/if \(specVisible && _zstackActive\) _applyZstackState\(false, null\)/.test(sync), 'a staged slice closes the browser');
  const syncZ = v.slice(v.indexOf("data.type === 'SYNC_Z'"), v.indexOf("data.type === 'SYNC_CHANNELS'"));
  assert.ok(/VolumeSlicer\.isVisible\(\)/.test(syncZ) && /VolumeSlicer\.setPlaneSpec\(\{ value \}\)/.test(syncZ), 'SYNC_Z moves the staged slice too');
  assert.ok(/setPlaneSpec: \(s, o\) => VolumeViewer\.setPlaneSpec\(s, o\)/.test(v), 'ctx.viewer.setPlaneSpec for the inspector');

  const vv = read('js/viewers/volume-viewer.js');
  assert.ok(/const namedMode = \['xy', 'xz', 'yz'\]\.includes\(spec\.mode\);\s*if \(!namedMode && Array\.isArray\(spec\.orientation\)/.test(vv), 'a named plane mode keeps its own orientation (a restored xz plane stays xz)');

  const c = read('js/pages/compare.js');
  assert.ok(/doc\.getElementById\('slice-stage'\)/.test(c) && !/slicer-sync-overlay/.test(c), 'compare figure reads the stage, not an overlay');

  const html = read('viewer.html');
  const gl = html.indexOf('id="webgl-canvas"');
  const st = html.indexOf('id="slice-stage"');
  assert.ok(gl > 0 && st > gl && st - gl < 400, 'the stage sits right after the WebGL canvas (overlays keep painting above it)');
  assert.ok(/id="slice-stage-scale"/.test(html), 'the stage carries its own scale bar');
  assert.ok(/data-i18n="viewer\.sliceInset3d"/.test(html), 'caption under the inspector square');

  const css = read('css/viewer.css');
  assert.ok(/\.slice-stage canvas \{[^}]*object-fit: contain/.test(css), 'the slice is letterboxed, never stretched');
  assert.ok(/body\.slice-staged #viewer-scale-bar \{\s*display: none !important;/.test(css), 'the 3D scale bar hides while staged');
  assert.ok(/\.slicer-preview-mount #webgl-canvas \{\s*cursor: grab;/.test(css), 'grab cursor in the inset');
  const tools = read('css/tools.css');
  assert.ok(/body\[data-active-tool="slice"\] #webgl-canvas/.test(tools) && !/data-active-tool="cut"/.test(tools), "cursor rule keyed on the ToolManager's tool name");

  for (const code of ['en', 'fr', 'es', 'nl']) {
    const dict = JSON.parse(read(`lang/${code}.json`));
    assert.equal(typeof dict.viewer?.sliceInset3d, 'string', `${code}: viewer.sliceInset3d`);
  }

  const inspector = JSON.parse(read('js/modules/tools/slice-inspector/plugin.json'));
  assert.equal(inspector.platformCompat, '>=1.55.2', 'the inspector needs the core that stages the slice');
  assert.equal(inspector.tool, 'slice');
  const zs = read('js/modules/tools/zstack-browser/index.js');
  assert.ok(/tools\?\.current\?\.\(\) === 'slice'\) tools\.activate\('navigate'\)/.test(zs), 'the browser closes the slice tool when it opens');
}

// ── VolumeViewer: the orientation quaternion round-trips (numerical, real Three.js) ──
{
  const require = createRequire(import.meta.url);
  const THREE = require('../../js/vendor/three.min.js');
  const src = read('js/viewers/volume-viewer.js');
  const lift = (name) => {
    const m = src.match(new RegExp(`\\n  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n`));
    assert.ok(m, `${name} must be defined at module level in volume-viewer.js`);
    return m[0];
  };
  const H = new Function('THREE', `
    let _planeSpec = { mode: 'xy', value: 0.5, yaw: 0, pitch: 0, roll: 0 };
    ${lift('_finiteNumber')}
    ${lift('_normalForPlaneSpec')}
    ${lift('_orientationForPlaneSpec')}
    ${lift('_applyOrientationToSpec')}
    return { forward: _orientationForPlaneSpec, inverse: _applyOrientationToSpec, normal: _normalForPlaneSpec };
  `)(THREE);
  const wrap = (d) => ((d + 540) % 360) - 180;
  let checked = 0;
  for (const yaw of [-170, -95, -25, 0, 25, 60, 120, 179]) {
    for (const pitch of [-80, -30, 0, 15, 45, 88]) {
      for (const roll of [-150, -40, 0, 30, 170]) {
        const spec = { mode: 'oblique', value: 0.37, yaw, pitch, roll };
        const q = H.forward(spec).toArray();
        const back = { ...spec };
        H.inverse(back, q);
        assert.equal(back.mode, 'oblique');
        const d = Math.max(Math.abs(wrap(back.yaw - yaw)), Math.abs(back.pitch - pitch), Math.abs(wrap(back.roll - roll)));
        assert.ok(d < 1e-6, `oblique yaw ${yaw} pitch ${pitch} roll ${roll} round-trips (got ${back.yaw.toFixed(3)} / ${back.pitch.toFixed(3)} / ${back.roll.toFixed(3)})`);
        const n0 = H.normal(spec), n1 = H.normal(back);
        assert.ok(n0.distanceTo(n1) < 1e-9, 'same plane normal after the round trip');
        checked++;
      }
    }
  }
  assert.equal(checked, 8 * 6 * 5);
}

console.log('slice stage (swap of the two renders, refine pass, slice ⇄ z-stack exclusion): OK');
