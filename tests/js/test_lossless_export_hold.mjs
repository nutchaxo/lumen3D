// A lossless export (viewer.js _withLosslessQuality) runs its render only once the
// lossless level is really on screen, and every export of a timelapse holds the
// timeline still:
//   • a reload that a later load took over (a scrub, a time sync) — _setQualityMode
//     resolving undefined — rejects with LOSSLESS_INTERRUPTED and never renders; the
//     quality on screen before is put back;
//   • a reload the GPU settled on a coarser level rejects the same way;
//   • a successful reload pauses playback, renders, and restores the quality;
//   • already at the lossless level, the export waits for the frame request still
//     running (_requestTimepoint) before it renders;
//   • the Decompose export (decomposition-panel.js _exportImageWithChoice) holds the
//     timeline before the "current" export, and a failure reaches the reader as the
//     translated sentence of Utils.friendlyErrorText, never as err.message.
//
// Run: node tests/js/test_lossless_export_hold.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const viewerSrc = read('js/pages/viewer.js');
const decoSrc = read('js/components/decomposition-panel.js');
function lift(src, name) {
  const m = src.match(new RegExp(`\\n  (?:async )?function ${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?\\n  \\}\\n`));
  assert.ok(m, `${name} must be defined at module level`);
  return m[0];
}

const userError = (code, key, fallback, detail, params) => Object.assign(new Error(detail || fallback || code), {
  code, i18nKey: key, i18nFallback: fallback, i18nParams: params || null
});

function makeViewer({ quality = '512x512@b2', live = true, setQuality }) {
  const env = {
    quality,
    calls: [],
    paused: 0,
    setQuality,
    loads: [],
    target: { key: 'native@ll', lod: 0, dims: { x: 10, y: 10, z: 10 }, native: true }
  };
  const Timeline = {
    pause() { env.paused++; },
    setFrame() {}
  };
  const body = `
    const isLive = env.live;
    let _qualityMode = env.quality;
    let _exportingLossless = false;
    let _tpInFlight = false;
    let _tpPending = null;
    let _tpTarget = null;
    let _currentTimepoint = 0;
    const Utils = { userError: env.userError };
    function _t(k, f) { return f; }
    function _losslessExportTarget() { return env.target; }
    function _lodForQuality(q) { return String(q).startsWith('native') ? 0 : 2; }
    function _isV5BrickManifest() { return true; }
    function _isV6BrickManifest() { return false; }
    function _currentColumn() { const at = _qualityMode.indexOf('@'); return at > 0 ? _qualityMode.slice(at + 1) : 'b2'; }
    function _qualityBaseOf(k) { const at = String(k).indexOf('@'); return at > 0 ? String(k).slice(0, at) : String(k); }
    function _v6DisplayColumn() { return 'q30'; }
    function _hasMountedVolume() { return true; }
    function _showLoadingError() {}
    async function _setQualityMode(value) {
      env.calls.push(value);
      return env.setQuality(value, (q) => { _qualityMode = q; });
    }
    function _loadTimepoint(basePath, frame) {
      return new Promise((resolve) => { env.loads.push({ frame, resolve: () => { _currentTimepoint = frame; resolve({ ok: true }); } }); });
    }
    ${['_whenTimepointIdle', '_holdTimelineForExport', '_requestTimepoint', '_withLosslessQuality'].map(n => lift(viewerSrc, n)).join('\n')}
    return {
      withLossless: _withLosslessQuality,
      hold: _holdTimelineForExport,
      request: _requestTimepoint,
      quality: () => _qualityMode
    };
  `;
  env.live = live;
  env.userError = userError;
  const api = new Function('env', 'Timeline', body)(env, Timeline);
  return { api, env };
}

// ── A superseded reload: no render, rejected, quality put back ────────────────────
{
  const { api, env } = makeViewer({
    setQuality: (value, set) => { set(value); return value === 'native@ll' ? undefined : { ok: true }; }
  });
  let rendered = false;
  await assert.rejects(api.withLossless(() => { rendered = true; }), (err) => {
    assert.equal(err.code, 'LOSSLESS_INTERRUPTED');
    assert.equal(err.i18nKey, 'exportView.losslessInterrupted');
    return true;
  });
  assert.equal(rendered, false, 'the export is not rendered from whatever is on screen');
  assert.deepEqual(env.calls, ['native@ll', '512x512@b2'], 'the reload, then the quality shown before');
  assert.ok(env.paused >= 1, 'playback is paused');
  console.log('superseded lossless reload: rejected, nothing rendered, quality restored: OK');
}

// ── A reload that landed on a coarser level ───────────────────────────────────────
{
  const { api } = makeViewer({
    setQuality: (value, set) => { set(value === 'native@ll' ? '1024x1024@ll' : value); return { ok: true, quality: value }; }
  });
  let rendered = false;
  await assert.rejects(api.withLossless(() => { rendered = true; }), { code: 'LOSSLESS_INTERRUPTED' });
  assert.equal(rendered, false);
  console.log('lossless reload downgraded by the GPU: rejected: OK');
}

// ── The reload succeeds ───────────────────────────────────────────────────────────
{
  const { api, env } = makeViewer({
    setQuality: (value, set) => { set(value); return { ok: true, quality: value }; }
  });
  let seen = null;
  const out = await api.withLossless((target) => { seen = api.quality(); return target.key; });
  assert.equal(out, 'native@ll');
  assert.equal(seen, 'native@ll', 'rendered at the lossless level');
  assert.deepEqual(env.calls, ['native@ll', '512x512@b2']);
  assert.equal(api.quality(), '512x512@b2', 'the quality is put back');
  assert.ok(env.paused >= 1);
  console.log('lossless reload on screen: rendered then restored: OK');
}

// ── Already lossless: wait for the frame request still running ────────────────────
{
  const { api, env } = makeViewer({
    quality: 'native@ll',
    setQuality: (value, set) => { set(value); return { ok: true }; }
  });
  api.request('/ds', 3);
  assert.equal(env.loads.length, 1, 'a frame request is running');
  let rendered = false;
  const p = api.withLossless(() => { rendered = true; });
  await new Promise(r => setTimeout(r, 120));
  assert.equal(rendered, false, 'the render waits for the frame on its way');
  env.loads[0].resolve();
  await p;
  assert.equal(rendered, true, 'rendered once the frame is on screen');
  assert.deepEqual(env.calls, [], 'no reload needed');
  // Not a timelapse: nothing to hold.
  const still = makeViewer({ live: false, setQuality: () => ({ ok: true }) });
  await still.api.hold();
  assert.equal(still.env.paused, 0);
  console.log('already lossless: the export waits for the running frame request: OK');
}

// ── The Decompose export ──────────────────────────────────────────────────────────
function decompose({ choice, hold, withLossless }) {
  const log = [];
  const toasts = [];
  const ViewerApp = {
    askExportQuality: async () => choice,
    holdForExport: hold ? async () => { log.push('hold'); } : undefined,
    withLosslessQuality: withLossless
  };
  const body = `
    async function _exportImage() { env.log.push('export'); }
    ${lift(decoSrc, '_exportImageWithChoice')}
    return _exportImageWithChoice;
  `;
  const Utils = {
    friendlyErrorText: (err) => (err && err.i18nKey ? `T:${err.i18nKey}` : 'T:unknown')
  };
  const run = new Function('env', 'window', 'Utils', 'ExportManager', 'console', body)(
    { log }, { ViewerApp }, Utils, { toast: (t) => toasts.push(t) }, { error() {}, warn() {} }
  );
  return { run, log, toasts };
}

{
  const d = decompose({ choice: 'current', hold: true });
  await d.run();
  assert.deepEqual(d.log, ['hold', 'export'], 'the timeline is held before the current export');

  const failing = decompose({
    choice: 'lossless',
    hold: true,
    withLossless: async () => { throw userError('LOSSLESS_INTERRUPTED', 'exportView.losslessInterrupted', 'x', 'raw detail /api/x'); }
  });
  await failing.run();
  assert.deepEqual(failing.toasts, ['T:exportView.losslessInterrupted'], 'the reader gets the translated sentence');
  assert.ok(!failing.toasts.some(t => t.includes('raw detail')), 'never the technical message');

  const cancelled = decompose({ choice: null, hold: true });
  await cancelled.run();
  assert.deepEqual(cancelled.log, [], 'a cancelled choice exports nothing');
  console.log('Decompose export: timeline held, failures translated: OK');
}

console.log('lossless export hold: OK');
