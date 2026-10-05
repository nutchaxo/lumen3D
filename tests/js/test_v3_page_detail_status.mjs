// The viewer's "Zoom detail" control (viewer.js _bindDetailControls): the select drives
// VolumeViewer.setDetailMode('auto'|'on'|'off'), the line under it shows the renderer's own
// (translated) VolumeViewer detail status message, and a mode the renderer reports is
// reflected in the select. Without the renderer API the control hides.
//
// Run: node tests/js/test_v3_page_detail_status.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';

const src = readFileSync(path.join(ROOT, 'js/pages/viewer.js'), 'utf8').replace(/\r\n/g, '\n');
const html = readFileSync(path.join(ROOT, 'viewer.html'), 'utf8');
function lift(name) {
  const m = src.match(new RegExp(`\\n  function ${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?\\n  \\}\\n`));
  assert.ok(m, name);
  return m[0];
}
const modes = src.match(/\n {2}const DETAIL_MODES = [^\n]+\n/);
assert.ok(modes, 'DETAIL_MODES');

assert.match(html, /id="select-detail-mode"/, 'the select is in the quality section');
assert.match(html, /id="detail-status"[^>]*role="status"/, 'the status line is announced');
for (const v of ['auto', 'on', 'off']) assert.match(html, new RegExp(`<option value="${v}"`), `option ${v}`);
assert.match(src, /_bindDetailControls\(\);/, 'bound with the volume controls');

function page(VolumeViewer) {
  const label = { classList: { set: new Set(), add(c) { this.set.add(c); } } };
  const select = {
    value: 'auto', listeners: {},
    addEventListener(t, f) { this.listeners[t] = f; },
    closest: () => label,
  };
  const line = { textContent: '' };
  const document = { getElementById: (id) => ({ 'select-detail-mode': select, 'detail-status': line })[id] || null };
  const body = `${modes[0]}${lift('_renderDetailStatus')}${lift('_bindDetailControls')} return { bind: _bindDetailControls };`;
  const api = new Function('document', 'VolumeViewer', body)(document, VolumeViewer);
  return { api, select, line, label };
}

{
  let mode = 'auto';
  let listener = null;
  const calls = [];
  const VV = {
    setDetailMode: (m) => { calls.push(m); mode = m; return mode; },
    getDetailStatus: () => ({ mode, message: '' }),
    onDetailStatus: (cb) => { listener = cb; cb({ mode, message: '' }); return () => {}; },
  };
  const { api, select, line } = page(VV);
  api.bind();
  assert.equal(line.textContent, '');
  listener({ mode: 'auto', message: 'Detail: 12 bricks of level 1 in view' });
  assert.equal(line.textContent, 'Detail: 12 bricks of level 1 in view', 'the renderer message, verbatim');
  select.value = 'off';
  select.listeners.change();
  assert.deepEqual(calls, ['off']);
  assert.equal(select.value, 'off');
  select.value = 'bogus';
  select.listeners.change();
  assert.deepEqual(calls, ['off', 'auto'], 'an unknown value asks for auto');
  listener({ mode: 'on', message: '' });
  assert.equal(select.value, 'on', 'a mode set elsewhere shows in the select');
  assert.equal(line.textContent, '');
}

{
  const { api, label } = page({});
  api.bind();
  assert.ok(label.classList.set.has('hidden'), 'no renderer API: the control hides');
}

console.log('viewer zoom-detail control: OK');
