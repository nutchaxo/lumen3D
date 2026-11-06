// ChannelPanel.patchChannel: a sibling panel's relayed channel edit (Compare, SYNC_CHANNELS)
// arrives once per frame while a handle is dragged. It must update that one channel in
// place — no rebuild of the panel's markup — clamp exactly as setState does, and leave an
// active solo alone unless the edit changes the visibility.
//
// Run: node tests/js/test_channel_patch.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, loadModule } from './harness.mjs';

function fakeElement(id) {
  const classes = new Set();
  const attrs = new Map();
  const listeners = new Map();
  const el = {
    id, checked: false, value: '', textContent: '', style: {}, dataset: {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, on) => { const want = on === undefined ? !classes.has(c) : Boolean(on); if (want) classes.add(c); else classes.delete(c); return want; },
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => attrs.get(k) ?? null,
    addEventListener: (type, fn) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    fire: (type, event) => (listeners.get(type) || []).forEach(fn => fn(event)),
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
  };
  return el;
}

function makePanel(channels) {
  const els = new Map();
  const get = (id) => { if (!els.has(id)) els.set(id, fakeElement(id)); return els.get(id); };
  let renders = 0;
  let html = '';
  const container = fakeElement('channel-container');
  Object.defineProperty(container, 'innerHTML', {
    get: () => html,
    set: (v) => { html = v; renders++; els.clear(); },   // a re-render replaces every node
  });
  // The item answers the selectors patchChannel and _bindChannel use.
  const itemQuery = (idx) => (sel) => {
    if (sel.startsWith('#')) return get(sel.slice(1));
    if (sel === '[data-channel-action="expand"]') return get(`expand-btn-${idx}`);
    return null;
  };
  const getWithItems = (id) => {
    const el = get(id);
    const m = /^channel-item-(\d+)$/.exec(id);
    if (m && el.querySelector !== el.__itemQuery) { el.__itemQuery = itemQuery(Number(m[1])); el.querySelector = el.__itemQuery; }
    return el;
  };
  container.querySelector = (sel) => (sel.startsWith('#') ? getWithItems(sel.slice(1)) : null);
  const notified = [];
  const win = { addEventListener() {} };
  const doc = { getElementById: () => container, addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [] };
  loadModule('js/components/channel-panel.js', 'createChannelPanel', {
    window: win, document: doc, Utils: { escapeHtml: (s) => String(s) }, ChannelPanel: undefined,
  });
  const panel = win.createChannelPanel();
  panel.init('channel-container', { dimensions: { c: channels.length }, channels }, (idx, params) => notified.push([idx, params]));
  const solo = (idx) => {
    const button = { dataset: { channelAction: 'solo', channelIdx: String(idx) } };
    getWithItems(`channel-item-${idx}`).fire('click', { target: { closest: () => button } });
  };
  return { panel, get: getWithItems, renders: () => renders, notified, solo };
}

const CHANNELS = [
  { name: 'DAPI', color: '#0000ff', min: 0, max: 1, gamma: 1 },
  { name: 'GFP', color: '#00ff00', min: 0.1, max: 0.9, gamma: 1.2 },
  { name: 'RFP', color: '#ff0000', min: 0, max: 1, gamma: 1, enabled: false },
];

// ── in place: no rebuild, no notification unless asked ──
{
  const p = makePanel(CHANNELS);
  const renders = p.renders();
  p.notified.length = 0;
  const cur = p.panel.getState()[1];
  const applied = p.panel.patchChannel(1, { ...cur, max: 0.6, min: 0.2 }, { notify: false });
  assert.equal(p.renders(), renders, 'a relayed edit does not rebuild the panel');
  assert.equal(p.notified.length, 0, 'notify:false sends nothing back out');
  assert.equal(p.panel.getState()[1].max, 0.6);
  assert.equal(applied.min, 0.2, 'returns the accepted state');
  assert.ok(p.get('ch-summary-1').textContent.startsWith('51-153'), 'the channel summary follows');
  p.panel.patchChannel(1, { ...p.panel.getState()[1], gamma: 2 });
  assert.equal(p.notified.length, 1, 'the default notifies the one channel');
  assert.equal(p.notified[0][0], 1);
  assert.equal(p.panel.patchChannel(9, { max: 0.5 }), null, 'an unknown channel is refused');
  assert.equal(p.panel.patchChannel(0, null), null);
}

// ── same clamping as setState ──
{
  const items = [
    { min: 1, max: 0.2 },
    { min: -3, max: 7, gamma: 3 },
    { min: 0.3, max: 0.5, midtone: 9 },
    { opacity: 'abc', color: '#123;x:y' },
    { opacity: 0.01, color: '#abc', denoise_sigma: 1.5, expanded: true },
  ];
  for (const item of items) {
    const a = makePanel(CHANNELS);
    const b = makePanel(CHANNELS);
    const base = a.panel.getState();
    a.panel.patchChannel(1, { ...base[1], ...item }, { notify: false });
    const full = [...base];
    full[1] = { ...base[1], ...item };
    b.panel.setState(full, { notify: false });
    assert.deepEqual(JSON.parse(JSON.stringify(a.panel.getState()[1])), JSON.parse(JSON.stringify(b.panel.getState()[1])), `patch == setState for ${JSON.stringify(item)}`);
  }
}

// ── an active solo survives an unrelated edit, and ends with a visibility change ──
{
  const p = makePanel(CHANNELS);
  p.solo(0);
  assert.deepEqual([...p.panel.getState().map(c => c.enabled)], [true, false, false], 'solo isolates DAPI');
  // A sibling drags GFP's max: its visibility here (off, under the solo) is what it sends back.
  p.panel.patchChannel(1, { ...p.panel.getState()[1], max: 0.7 }, { notify: false });
  p.solo(0);
  assert.deepEqual([...p.panel.getState().map(c => c.enabled)], [true, true, false], 'pressing solo again restores the view before it: the solo was kept');

  const q = makePanel(CHANNELS);
  q.solo(0);
  q.panel.patchChannel(2, { ...q.panel.getState()[2], enabled: true }, { notify: false });
  assert.equal(q.get('ch-toggle-2').checked, true, 'the visibility box follows');
  q.solo(0);
  assert.deepEqual([...q.panel.getState().map(c => c.enabled)], [true, false, false], 'a visibility edit ends the solo: the next press isolates again');
}

// ── the disclosure follows a relayed expand ──
{
  const p = makePanel(CHANNELS);
  const was = p.panel.getState()[1].expanded;
  p.panel.patchChannel(1, { ...p.panel.getState()[1], expanded: !was }, { notify: false });
  assert.equal(p.get('channel-item-1').classList.contains('expanded'), !was);
  assert.equal(p.get('expand-btn-1').getAttribute('aria-expanded'), String(!was));
}

// ── the Compare receiver patches; the full setState stays for restores ──
{
  const src = readFileSync(path.join(ROOT, 'js/pages/viewer.js'), 'utf8').replace(/\r/g, '');
  const at = src.indexOf("data.type === 'SYNC_CHANNELS'");
  const branch = src.slice(at, src.indexOf("data.type === 'SYNC_EXPOSURE'", at));
  assert.ok(branch.includes('ChannelPanel.patchChannel(matchingIdx'), 'SYNC_CHANNELS patches the one channel');
  assert.ok(!branch.includes('ChannelPanel.setState('), 'and never rebuilds the whole panel');
}

console.log('channel patch: OK');
