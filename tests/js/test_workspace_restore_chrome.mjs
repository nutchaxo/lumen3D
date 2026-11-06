// Restoring a saved view must never leave the page chrome out of reach:
//   • a state with the sidebar hidden shows the floating reopen button on the page
//     (it is the only way back to the sidebar there), and hides it again when the
//     state has the sidebar open; inside a Compare panel the host's toggle owns it;
//   • presentation mode is the presentation-mode plugin's state: the core neither
//     writes it into ui nor applies a bare ui.presentationMode (an old #state= link
//     without the plugin would otherwise hide the header for good).
// _applyWorkspaceStateCore and _getWorkspaceState are lifted from viewer.js as written.
//
// Run: node tests/js/test_workspace_restore_chrome.mjs
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

const LIFTED = ['_applyWorkspaceStateCore', '_getWorkspaceState'].map(lift).join('\n');

function classList() {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    toggle: (c, on) => { const want = on === undefined ? !set.has(c) : !!on; if (want) set.add(c); else set.delete(c); return want; },
    contains: (c) => set.has(c)
  };
}

function makeEnv({ iframe = false } = {}) {
  const body = { classList: classList() };
  const sidebar = { classList: classList() };
  const reopen = { id: 'btn-reopen-sidebar', style: { display: 'none' } };
  const icons = [];
  const resizes = [];
  const sandbox = {
    body, sidebar, reopen, icons, resizes,
    document: {
      body,
      getElementById: (id) => (id === 'btn-reopen-sidebar' ? reopen : null),
      querySelector: (sel) => (sel === '.viewer-sidebar' ? sidebar : null)
    },
    window: { lucide: { createIcons: (opts) => icons.push(opts) } },
    lucide: { createIcons: (opts) => icons.push(opts) },
    VolumeViewer: {
      setCameraState() {}, getCameraState: () => ({}), getCutPlaneState: () => null,
      getPlaneSpec: () => null, getPhysicalSize: () => null, getCacheStats: () => ({})
    },
    MeasurementStore: { list: () => [] },
    ChannelPanel: { getState: () => [] },
    PluginRegistry: { getWorkspaceState: () => ({}), setWorkspaceState() {} },
    console
  };
  const prelude = `
    const _isIframe = ${iframe};
    const isLive = false;
    const datasetId = '3d/test';
    let _isInitialized = true, _pendingPluginState = null;
    let _displayState = { backgroundPreset: 'dark', backgroundColor: '#000000' };
    let _channelState = [], _zDisplayScale = 1, _zstackActive = false, _zstackCurrentSlice = -1;
    let _currentTimepoint = 0, _qualityMode = '512x512', _volumeSourcePreference = 'auto';
    let _basePath = 'DATA_WEB/3d/test', _registration = null, _stabilizeVolume = true;
    let _playbackFps = 4;
    function _scheduleViewerResize() { resizes.push(1); }
    function _updateVolumeSourceStatus() {}
    function _currentExposure() { return 1; }
  `;
  vm.createContext(sandbox);
  vm.runInContext(`${prelude}\n${LIFTED}\nglobalThis.__api = { apply: _applyWorkspaceStateCore, get: _getWorkspaceState };`, sandbox);
  return sandbox;
}

// Sidebar hidden on the standalone page → the reopen button appears.
{
  const env = makeEnv();
  env.__api.apply({ ui: { sidebarHidden: true } });
  assert.equal(env.sidebar.classList.contains('sidebar-hidden'), true);
  assert.equal(env.reopen.style.display, 'flex', 'a restored hidden sidebar must leave its reopen button on screen');
  assert.equal(env.icons.length, 1, 'the reopen button icon is drawn');
  env.__api.apply({ ui: { sidebarHidden: false } });
  assert.equal(env.sidebar.classList.contains('sidebar-hidden'), false);
  assert.equal(env.reopen.style.display, 'none', 'an open sidebar hides the reopen button');
}

// Inside a Compare panel the host's toggle drives the sidebar: the button is left alone.
{
  const env = makeEnv({ iframe: true });
  env.__api.apply({ ui: { sidebarHidden: true } });
  assert.equal(env.sidebar.classList.contains('sidebar-hidden'), true);
  assert.equal(env.reopen.style.display, 'none');
}

// A bare ui.presentationMode (old link, plugin absent) is not applied by the core.
{
  const env = makeEnv();
  env.__api.apply({ ui: { presentationMode: true } });
  assert.equal(env.body.classList.contains('presentation-mode'), false,
    'the core must not hide the header on its own: only the plugin, which owns the exit, may');
}

// The saved state no longer carries ui.presentationMode (the plugin's entry does).
{
  const env = makeEnv();
  env.body.classList.add('presentation-mode');
  const state = env.__api.get();
  assert.equal('presentationMode' in state.ui, false);
  assert.equal(typeof state.ui.sidebarHidden, 'boolean');
}

console.log('test_workspace_restore_chrome: ok');
