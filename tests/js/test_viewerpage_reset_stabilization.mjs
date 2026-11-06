// Reset workspace on a stabilised timelapse, run as written in viewer.js
// (resetWorkspace and the stabilisation helpers lifted from the source):
//   • a timelapse switched to "Raw images" goes back to the stabilised frame,
//     with the select, the status line and the overlays (viewer-timepoint-ready)
//     following, BEFORE the URL baseline is taken;
//   • a dataset without an applicable registration is left alone (no event, no
//     transform), and a timelapse already stabilised re-dispatches nothing.
//
// Run: node tests/js/test_viewerpage_reset_stabilization.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const viewerSrc = readFileSync(path.join(ROOT, 'js/pages/viewer.js'), 'utf8').replace(/\r\n/g, '\n');

function lift(name) {
  const m = viewerSrc.match(new RegExp(`\\n  (?:async )?function ${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?\\n  \\}\\n`));
  assert.ok(m, `${name} must be defined at module level in viewer.js`);
  return m[0];
}

const LIFTED = ['resetWorkspace', 'setVolumeStabilized', '_renderStabilizationControl',
  '_applyStabilization', '_transformForTimepoint'].map(lift).join('\n');

function makeEnv({ registration, stabilized, timepoint = 3 }) {
  const log = [];
  const el = (id) => {
    const classes = new Set();
    return {
      id, value: '', textContent: '', style: {},
      classList: {
        toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c)
      }
    };
  };
  const elements = Object.fromEntries(['label-stabilization', 'select-stabilization',
    'stabilization-status', 'select-render-mode', 'slider-exposure',
    'select-background-preset', 'input-background-color'].map(id => [id, el(id)]));
  const events = [];
  const sandbox = {
    log, elements, events,
    document: {
      getElementById: (id) => elements[id] || null,
      querySelector: () => null
    },
    window: { dispatchEvent: (e) => { events.push(e); log.push(`event:${e.type}`); } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    PluginRegistry: { resetAll() {}, activate() {} },
    ToolManager: { activate() {} },
    VolumeViewer: {
      resetView() {}, setCutPlaneVisible() {}, setMeasurements() {}, triggerRender() {},
      setTimepointTransform: (m) => { log.push(`transform:${m ? 'stabilised' : 'raw'}`); sandbox._stabilizedOnGpu = Boolean(m); },
      isStabilized: () => Boolean(sandbox._stabilizedOnGpu)
    },
    MeasurementStore: { clear() {} },
    ChannelPanel: { reset() {}, getState: () => [] },
    UrlState: { rebaseline: () => log.push('rebaseline') },
    Timeline: { setFrame() {} },
    _stabilizedOnGpu: stabilized,
    console
  };
  const prelude = `
    let _registration = ${registration ? JSON.stringify(registration) : 'null'};
    let _stabilizeVolume = ${Boolean(stabilized)};
    let _currentTimepoint = ${timepoint};
    let _volumeMeasurements = [], _volumeMeasureDraft = [], _channelState = [];
    const datasetId = 'live/TEST', isLive = true, _isIframe = true;
    const _tt = (k, fb) => fb, _t = (k, fb) => fb, _perf = () => null;
    const _resetClipSliders = () => {}, _renderVolumeMeasurement = () => {};
    const _defaultRenderModeId = () => null, _defaultExposureSliderValue = () => '50';
    const _syncExposureFromUi = () => {}, _syncBackgroundFromUi = () => {};
    const _resetZDisplayScale = () => {}, _scheduleViewerResize = () => {};
  `;
  const epilogue = `
    this.reset = resetWorkspace;
    this.setStabilized = setVolumeStabilized;
    this.state = () => ({ stabilize: _stabilizeVolume });
  `;
  vm.createContext(sandbox);
  vm.runInContext(`(function () {${prelude}\n${LIFTED}\n${epilogue}}).call(this);`, sandbox);
  return sandbox;
}

const REG = { appliedToVolume: true, transforms: [{ index: 3, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }] };

// A stabilised timelapse the operator switched to "Raw images".
{
  const env = makeEnv({ registration: REG, stabilized: true });
  env.setStabilized(false);
  assert.equal(env.state().stabilize, false);
  assert.equal(env.elements['select-stabilization'].value, 'off');
  env.log.length = 0;
  env.events.length = 0;

  env.reset();
  assert.equal(env.state().stabilize, true, 'reset must bring the stabilised frame back');
  assert.equal(env.elements['select-stabilization'].value, 'on', 'the select follows');
  assert.match(env.elements['stabilization-status'].textContent, /Drift and rotation removed/);
  const tp = env.events.find(e => e.type === 'viewer-timepoint-ready');
  assert.ok(tp, 'overlays are told the frame of reference changed');
  assert.equal(tp.detail.frame, 3);
  assert.equal(tp.detail.stabilized, true);
  const iTransform = env.log.indexOf('transform:stabilised');
  const iBaseline = env.log.indexOf('rebaseline');
  assert.ok(iTransform >= 0 && iBaseline > iTransform,
    'the stabilised frame is restored before the URL baseline is taken');
}

// Already stabilised: nothing re-dispatched, nothing re-applied.
{
  const env = makeEnv({ registration: REG, stabilized: true });
  env.reset();
  assert.equal(env.state().stabilize, true);
  assert.ok(!env.log.some(l => l.startsWith('transform:')));
  assert.ok(!env.events.some(e => e.type === 'viewer-timepoint-ready'));
}

// No applicable registration: the reset leaves stabilisation alone.
{
  const env = makeEnv({ registration: null, stabilized: false });
  env.reset();
  assert.equal(env.state().stabilize, false);
  assert.ok(!env.log.some(l => l.startsWith('transform:')));
  assert.ok(!env.events.some(e => e.type === 'viewer-timepoint-ready'));
  assert.ok(env.log.includes('rebaseline'));
}

console.log('test_viewerpage_reset_stabilization: OK');
