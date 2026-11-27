// The visible time range of a timelapse (web v1.92.0): `metadata.timeRange {start, end}`
// narrows what the timeline offers, never what the dataset holds.
//   • TimeRange: a malformed value means "no range"; the stored form is null when the
//     window is the whole series (behavioural);
//   • Timeline: the track, the keys, the scrub, the loop and the buffer follow the
//     window while frames stay absolute (behavioural);
//   • wiring: the curated keys of the three pipelines, viewer.html, the admin page and the
//     four dictionaries (structural).
//
// Run: node tests/js/test_time_range.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadModule, ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r/g, '');

// ── TimeRange ────────────────────────────────────────────────────────────────
const TimeRange = loadModule('js/core/time-range.js', 'TimeRange');
{
  const n = (raw, total = 100) => TimeRange.normalize(raw, total);
  assert.deepEqual({ ...n(null) }, { start: 0, end: 99, count: 100, total: 100, active: false });
  assert.deepEqual({ ...n({ start: 10, end: 59 }) }, { start: 10, end: 59, count: 50, total: 100, active: true });
  assert.equal(n({ start: 0, end: 99 }).active, false, 'the whole series is not a range');
  assert.equal(n({ start: 5, end: 5 }).count, 1, 'a one-frame window is allowed');

  // Anything unusable leaves the dataset whole — a bad value must never hide it.
  for (const bad of [undefined, 'x', 7, [], { start: 'a', end: 4 }, { start: 3 }, { start: null, end: 4 },
    { start: true, end: 4 }, { start: 1.5, end: 4 }, { start: -1, end: 4 }, { start: 4, end: 100 },
    { start: 9, end: 4 }, { start: NaN, end: 4 }]) {
    assert.equal(n(bad).active, false, `ignored: ${JSON.stringify(bad)}`);
    assert.equal(n(bad).count, 100);
  }
  assert.equal(n({ start: '10', end: '20' }).start, 10, 'whole numbers written as strings are accepted');
  assert.equal(TimeRange.normalize(null, undefined).count, 1, 'no length → one frame, never NaN');

  assert.deepEqual({ ...TimeRange.toStored(n({ start: 10, end: 59 })) }, { start: 10, end: 59 });
  assert.equal(TimeRange.toStored(n(null)), null);

  const r = n({ start: 10, end: 59 });
  assert.equal(TimeRange.clamp(r, 3), 10);
  assert.equal(TimeRange.clamp(r, 80), 59);
  assert.equal(TimeRange.clamp(r, 30), 30);
  assert.equal(TimeRange.clamp(r, NaN), 10);
  assert.equal(TimeRange.fractionOf(r, 10), 0);
  assert.equal(TimeRange.fractionOf(r, 59), 1);
  assert.equal(TimeRange.fractionOf(n({ start: 5, end: 5 }), 5), 0);
  assert.equal(TimeRange.frameAt(r, 0), 10);
  assert.equal(TimeRange.frameAt(r, 1), 59);
  assert.equal(TimeRange.frameAt(r, 0.5), 35);   // round(0.5 × 49) = 25 → 10 + 25
  // Panels of different windows align by fraction of what each shows.
  const other = n({ start: 0, end: 9 }, 10);
  assert.equal(TimeRange.frameAt(other, TimeRange.fractionOf(r, 59)), 9);
}

// ── Timeline ─────────────────────────────────────────────────────────────────
class FakeElement {
  constructor(id = '', attrs = {}) {
    this.id = id; this.attrs = { ...attrs }; this.style = { setProperty() {} };
    this.listeners = {}; this.textContent = ''; this.children = {}; this._html = '';
  }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, init = {}) {
    let prevented = false;
    const e = { type, target: this, preventDefault() { prevented = true; }, ...init };
    for (const fn of this.listeners[type] || []) fn(e);
    return prevented;
  }
  appendChild(c) { return c; }
  getBoundingClientRect() { return { left: 0, width: 100, top: 0, height: 24 }; }
  setPointerCapture() {}
  releasePointerCapture() {}
  querySelector(sel) { return sel.startsWith('#') ? (this.children[sel.slice(1)] || null) : null; }
  get innerHTML() { return this._html; }
  set innerHTML(html) {
    this._html = html;
    this.children = {};
    for (const m of html.matchAll(/<\w+([^>]*)>/g)) {
      const attrs = {};
      for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
      if (attrs.id) this.children[attrs.id] = new FakeElement(attrs.id, attrs);
    }
  }
}

function mount(options) {
  const container = new FakeElement('timeline-panel');
  const rafQueue = [];
  let now = 0;
  const sandbox = {
    document: { getElementById: (id) => (id === 'timeline-panel' ? container : null), createElement: () => new FakeElement(), addEventListener() {} },
    I18n: { t: (k) => k, getLanguage: () => 'en', onLanguageChange() {} },
    window: {},
    performance: { now: () => now },
    requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
    cancelAnimationFrame: () => { rafQueue.length = 0; },
  };
  const Timeline = loadModule('js/components/timeline.js', 'Timeline', sandbox);
  const changes = [];
  Timeline.init('timeline-panel', options, (s) => changes.push(s));
  const advance = (ms) => { now += ms; const fn = rafQueue.shift(); if (fn) fn(); };
  return { Timeline, container, changes, advance, track: container.children['timeline-scrubber-track'] };
}

{
  const { Timeline, container, changes, track } = mount({ totalFrames: 100, range: { start: 20, end: 69 }, speedToggle: true });
  const key = (k) => track.dispatch('keydown', { key: k });
  const last = () => changes[changes.length - 1].frame;
  const text = () => container.children['timeline-time-display'];

  assert.equal(Timeline.getFrame(), 20, 'opens on the first visible frame');
  assert.deepEqual({ ...Timeline.getRange() }, { start: 20, end: 69 });
  assert.equal(track.getAttribute('aria-valuemin'), '20');
  assert.equal(track.getAttribute('aria-valuemax'), '69');
  assert.equal(track.getAttribute('aria-valuenow'), '20');
  assert.equal(container.children['timeline-scrubber-handle'].style.left, '0%');

  key('ArrowLeft');
  assert.equal(last(), 20, 'cannot go before the window');
  key('End');
  assert.equal(last(), 69, 'End = last visible frame');
  assert.equal(container.children['timeline-scrubber-handle'].style.left, '100%');
  key('ArrowRight');
  assert.equal(last(), 69, 'cannot go past the window');
  key('Home');
  assert.equal(last(), 20, 'Home = first visible frame');
  key('PageUp'); key('PageUp'); key('PageUp'); key('PageUp'); key('PageUp'); key('PageUp');
  assert.equal(last(), 69, 'a page step stops at the window');

  Timeline.setFrame(5, true, true);
  assert.equal(last(), 20, 'a frame before the window lands on its start');
  Timeline.setFrame(90, true, true);
  assert.equal(last(), 69, 'a frame after the window lands on its end');
  Timeline.setFrame(45, true, true);
  assert.equal(container.children['timeline-scrubber-handle'].style.left, `${(25 / 49) * 100}%`);

  // Scrubbing maps the track onto the window (the fake track is 100 px wide).
  track.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 0 });
  assert.equal(last(), 20);
  track.dispatch('pointermove', { pointerId: 1, clientX: 100 });
  assert.equal(last(), 69);
  track.dispatch('pointerup', { pointerId: 1 });

  // Buffered frames outside the window are not drawn; the others are placed inside it.
  const segs = [];
  container.children['timeline-scrubber-buffer'].appendChild = (c) => { segs.push(c); return c; };
  Timeline.updateBuffer(new Set([3, 4, 20, 21, 22, 90]));
  assert.equal(segs.length, 1, 'one segment: 20..22');
  assert.equal(segs[0].style.left, '0%');
  assert.ok(Math.abs(parseFloat(segs[0].style.width) - (2.5 / 49) * 100) < 1e-9);
  void text;
}

{
  // Playback wraps at the window's end, never beyond it, and never before its start.
  const { Timeline, changes, advance } = mount({ totalFrames: 100, range: { start: 20, end: 24 }, speedToggle: true, speedFps: 10 });
  Timeline.play();
  const seen = new Set();
  for (let i = 0; i < 80; i++) { advance(100); Timeline.getFrame(); }
  for (const c of changes) seen.add(Math.round(c.frame));
  Timeline.pause();
  assert.ok(seen.size > 1, 'the playhead moved');
  for (const f of seen) assert.ok(f >= 20 && f <= 24, `frame ${f} stays inside 20..24`);
}

{
  // No range, or a malformed one: the whole series.
  for (const range of [undefined, null, { start: 9, end: 2 }, { start: -1, end: 5 }, { start: 0, end: 500 }, { start: 'a', end: 3 }]) {
    const { Timeline, track } = mount({ totalFrames: 30, range });
    assert.deepEqual({ ...Timeline.getRange() }, { start: 0, end: 29 }, JSON.stringify(range));
    assert.equal(track.getAttribute('aria-valuemax'), '29');
  }
}

// ── Wiring ───────────────────────────────────────────────────────────────────
for (const rel of ['preprocess/run_preprocess.py', 'upload_staging.py', 'api/_upload_lib.php']) {
  assert.ok(/['"]timeRange['"]/.test(read(rel)), `${rel}: timeRange survives a re-import (curated key)`);
}
{
  const viewer = read('viewer.html');
  assert.ok(viewer.indexOf('js/core/time-range.js') > -1 && viewer.indexOf('js/core/time-range.js') < viewer.indexOf('js/components/timeline.js'),
    'viewer.html loads time-range.js before the timeline');
  assert.ok(read('admpan.html').includes('js/core/time-range.js'), 'admpan.html loads time-range.js');
  const vjs = read('js/pages/viewer.js');
  assert.ok(vjs.includes('TimeRange.normalize(isAdmin ? null : datasetMeta.timeRange'), 'the admin preview always gets the whole series');
  assert.ok(vjs.includes("data.type === 'SET_TIMEPOINT' && isLive && _adminPreview"), 'SET_TIMEPOINT is admin-preview only');
}
{
  const keys = ['secTimeRange', 'timeRangeHint', 'timeRangeStart', 'timeRangeEnd', 'timeRangeSummary', 'timeRangeFull', 'timeRangeReset', 'timeRangeTrack'];
  for (const code of ['en', 'fr', 'es', 'nl']) {
    const admin = JSON.parse(read(`lang/${code}.json`)).admin;
    for (const k of keys) assert.ok(typeof admin[k] === 'string' && admin[k].length > 0, `lang/${code}.json admin.${k}`);
  }
  // The window never touches what a download carries: nothing in the export code reads it.
  for (const rel of ['js/core/export-manager.js', 'js/core/ome-zarr-export.js', 'js/core/q30-export.js']) {
    assert.ok(!read(rel).includes('timeRange'), `${rel} ignores the visible range`);
  }
}

console.log('test_time_range: ok');
