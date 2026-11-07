// Timeline (js/components/timeline.js) is operable without a pointer: the play button
// is named after what it will do, the scrubber is an ARIA slider whose value follows
// the frame shown, and the slider's own keys move the playhead — only while it has
// the focus, never through a document-wide listener.
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

// A DOM just large enough for the timeline: the container's innerHTML is scanned for
// the elements carrying an id, each a stub with attributes, style and listeners.
class FakeElement {
  constructor(id = '', attrs = {}) {
    this.id = id;
    this.attrs = { ...attrs };
    this.style = { setProperty() {} };
    this.listeners = {};
    this.textContent = '';
    this.children = {};
    this._html = '';
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

const container = new FakeElement('timeline-panel');
const docListeners = [];
const document = {
  getElementById: (id) => (id === 'timeline-panel' ? container : null),
  createElement: () => new FakeElement(),
  addEventListener: (type) => docListeners.push(type),
};
const strings = {
  'viewer.play': 'Lecture', 'viewer.pause': 'Pause', 'viewer.timepoint': 'Point temporel',
  'viewer.fpsUnit': 'img/s', 'viewer.playbackSpeed': 'Vitesse',
};
let langCb = null;
const I18n = {
  t: (k) => strings[k] || k,
  getLanguage: () => 'fr',
  onLanguageChange: (cb) => { langCb = cb; },
};
const rafQueue = [];
const sandbox = {
  document, I18n, window: {}, performance,
  requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
  cancelAnimationFrame: () => { rafQueue.length = 0; },
};
const Timeline = loadModule('js/components/timeline.js', 'Timeline', sandbox);

const changes = [];
Timeline.init('timeline-panel', { totalFrames: 30, speedToggle: true }, (s) => changes.push(s));

const play = container.children['timeline-btn-play'];
const track = container.children['timeline-scrubber-track'];
assert.ok(play && track, 'play button and scrubber rendered');

// Play button: named, type=button (it sits in no form, but never a submit by accident).
assert.equal(play.getAttribute('type'), 'button');
assert.equal(play.getAttribute('aria-label'), 'Lecture');
assert.equal(play.getAttribute('title'), 'Lecture');

// Scrubber: a focusable slider over the indices the counter shows.
assert.equal(track.getAttribute('role'), 'slider');
assert.equal(track.getAttribute('tabindex'), '0');
assert.equal(track.getAttribute('aria-label'), 'Point temporel');
assert.equal(track.getAttribute('aria-valuemin'), '0');
assert.equal(track.getAttribute('aria-valuemax'), '29');
assert.equal(track.getAttribute('aria-valuenow'), '0');
assert.equal(track.getAttribute('aria-valuetext'), '0 / 29');

const key = (k, extra = {}) => track.dispatch('keydown', { key: k, ...extra });
const lastFrame = () => changes[changes.length - 1].frame;

assert.equal(key('ArrowRight'), true, 'ArrowRight handled');
assert.equal(lastFrame(), 1);
assert.equal(track.getAttribute('aria-valuenow'), '1');
assert.equal(track.getAttribute('aria-valuetext'), '1 / 29');
key('ArrowUp');
assert.equal(lastFrame(), 2);
key('ArrowLeft'); key('ArrowDown');
assert.equal(lastFrame(), 0);
key('ArrowLeft');
assert.equal(lastFrame(), 0, 'clamped at the first frame');
key('PageUp');
assert.equal(lastFrame(), 10);
key('End');
assert.equal(lastFrame(), 29);
key('ArrowRight');
assert.equal(lastFrame(), 29, 'clamped at the last frame');
key('PageDown');
assert.equal(lastFrame(), 19);
key('Home');
assert.equal(lastFrame(), 0);
assert.equal(Timeline.getFrame(), 0);

// Keys the slider does not own, and browser chords, are left alone.
const before = changes.length;
assert.equal(key('a'), false);
assert.equal(key('Tab'), false);
assert.equal(key('ArrowRight', { ctrlKey: true }), false);
assert.equal(changes.length, before, 'no frame change for a foreign key');

// No document-wide keydown: the arrows keep their meaning outside the focused track.
assert.ok(!docListeners.includes('keydown'), 'timeline installs no document keydown listener');

// Playing renames the button; a key stops playback and lands on the asked frame, told once.
play.dispatch('click', { detail: 0 });
assert.equal(play.getAttribute('aria-label'), 'Pause');
assert.equal(play.getAttribute('title'), 'Pause');
Timeline.setFrame(5, true, false);
const n = changes.length;
key('ArrowRight');
assert.equal(changes.length, n + 1, 'one notification for a key during playback');
assert.equal(lastFrame(), 6);
assert.equal(changes[changes.length - 1].isPlaying, false, 'playback stopped by the key');
assert.equal(play.getAttribute('aria-label'), 'Lecture');

// A language switch re-labels both controls.
strings['viewer.play'] = 'Play';
strings['viewer.timepoint'] = 'Timepoint';
assert.equal(typeof langCb, 'function');
langCb();
assert.equal(play.getAttribute('aria-label'), 'Play');
assert.equal(track.getAttribute('aria-label'), 'Timepoint');

// A re-init (another timelapse) rebuilds the markup: the new elements get their
// attributes even though the values equal the cached ones of the old elements.
Timeline.init('timeline-panel', { totalFrames: 30, speedToggle: true }, () => {});
const track2 = container.children['timeline-scrubber-track'];
assert.notEqual(track2, track);
assert.equal(track2.getAttribute('aria-valuemax'), '29');
assert.equal(track2.getAttribute('aria-valuenow'), '0');
assert.equal(container.children['timeline-btn-play'].getAttribute('aria-label'), 'Play');

console.log('test_timeline_a11y: OK');
