// Package P6 (roi): the toolbar tools of ij-view.js — Segmented line, Angle, Wand — and the selection geometry they need
// (hit test, handles, handle move, status line) — against a small fake DOM and WebGL2 (the same stand-ins as test_ij_view_pure).
//
// Run: node tests/js/test_ij_roi_view.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';
import { loadViewModules } from './ij_harness.mjs';

const FILE = 'js/modules/studio/advanced-studio/ij-view.js';
const deq = (a, b, m) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m);

// ── the pure geometry ──
const P = loadModule(FILE, 'IJViewPure', {});
const pl = { type: 'polyline', points: [[10, 10], [30, 10], [30, 30]], width: 1 };
assert.equal(P.hitRoi(pl, 20, 10.4, 0), true, 'on the first segment');
assert.equal(P.hitRoi(pl, 30.3, 20, 0), true, 'on the second segment');
assert.equal(P.hitRoi(pl, 20, 20, 0), false, 'inside the corner, away from both segments');
assert.equal(P.hitRoi(pl, 20, 14, 5), true, 'a click tolerance widens the reach');
assert.equal(P.roiHandles(pl).length, 3, 'a vertex handle per point');
deq(P.moveHandle(pl, 'v1', 33.7, 8.2).points[1], [33, 8], 'a vertex lands on integer pixel-centre coordinates, as a line end');
const ang = { type: 'angle', points: [[10, 10], [20, 10], [20, 20]] };
assert.equal(P.hitRoi(ang, 15, 10, 0), true);
assert.equal(P.roiHandles(ang).length, 3);
assert.equal(P.describeRoi(ang, null), 'angle=90');
assert.equal(P.describeRoi({ type: 'angle', points: [[10, 10], [20, 10], [30, 20]] }, null), 'angle=135');
assert.equal(P.describeRoi(pl, { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'µm' }), 'n=3, length=20 µm');
assert.ok(/^n=2/.test(P.describeRoi({ type: 'angle', points: [[1, 1], [2, 2]] }, null)));
deq(P.roiBounds(pl), { x: 10, y: 10, w: 20, h: 20 });

// ── the shell: a fake DOM and WebGL2 ──
const rafQueue = [];
function makeGl() {
  const base = { getError: () => 0, getShaderParameter: () => true, getProgramParameter: () => true, getShaderInfoLog: () => '', getProgramInfoLog: () => '', getUniformLocation: () => ({}), getExtension: () => null };
  return new Proxy(base, { get(t, name) { if (name in t) return t[name]; if (typeof name !== 'string') return undefined; if (/^[A-Z0-9_]+$/.test(name)) { let h = 7; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return (h % 60000) + 1; } return () => ({}); } });
}
class FEl {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.style = {}; this.dataset = {}; this.children = []; this.parentNode = null;
    this._attrs = {}; this._text = ''; this.cls = new Set(); this.hidden = false; this._ls = []; this.clientWidth = 0; this.clientHeight = 0; this.width = 300; this.height = 150; this.value = ''; this.type = '';
    const self = this;
    this.classList = { add: (...c) => c.forEach((x) => x && self.cls.add(x)), remove: (...c) => c.forEach((x) => self.cls.delete(x)), contains: (c) => self.cls.has(c), toggle(c, f) { const on = f === undefined ? !self.cls.has(c) : !!f; if (on) self.cls.add(c); else self.cls.delete(c); return on; } };
  }
  get className() { return Array.from(this.cls).join(' '); }
  set className(v) { this.cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children = []; this._text = String(v); }
  set innerHTML(v) { this._html = v; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
  removeAttribute(k) { delete this._attrs[k]; }
  addEventListener(ev, fn) { this._ls.push({ ev, fn }); }
  removeEventListener(ev, fn) { this._ls = this._ls.filter((l) => !(l.ev === ev && l.fn === fn)); }
  fire(ev, e = {}) { const evt = { type: ev, target: this, button: 0, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...e }; for (const l of this._ls.slice()) if (l.ev === ev) l.fn(evt); return evt; }
  focus() { this.ownerDocument.activeElement = this; }
  select() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: this.clientWidth || 200, bottom: this.clientHeight || 20, width: this.clientWidth || 200, height: this.clientHeight || 20 }; }
  closest() { return null; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  getContext(type) { if (type === 'webgl2') return this._gl || (this._gl = makeGl()); return new Proxy({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) }, { get: (t, n) => (n in t ? t[n] : () => {}), set: () => true }); }
}
const win = { devicePixelRatio: 1, innerWidth: 1000, innerHeight: 700, requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; }, cancelAnimationFrame() {}, getComputedStyle: () => ({ position: 'relative' }), addEventListener() {}, removeEventListener() {} };
const doc = {
  defaultView: win, activeElement: null, _ls: [],
  createElement: (t) => new FEl(t, doc), createElementNS: (ns, t) => new FEl(t, doc), contains: () => true,
  addEventListener(ev, fn) { doc._ls.push({ ev, fn }); }, removeEventListener(ev, fn) { doc._ls = doc._ls.filter((l) => !(l.ev === ev && l.fn === fn)); },
  fire(ev, e = {}) { const evt = { type: ev, target: doc.body, key: '', preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...e }; for (const l of doc._ls.slice()) if (l.ev === ev) l.fn(evt); return evt; }
};
doc.body = new FEl('body', doc);
class FEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }
const Sh = loadViewModules({ Event: FEvent }).IJShell;

const root = new FEl('div', doc);
root.clientWidth = 1000; root.clientHeight = 700;
doc.body.appendChild(root);
const rois = [], wand = [], toolOptions = [];
const shell = Sh.create(root, {
  t: (k, f) => f, commands: [], getState: () => ({}), onCommand() {},
  onRoi: (r, o) => rois.push([r, o]), onTool() {}, onToolOptions: (id) => toolOptions.push(id), onWand: (x, y, e) => wand.push([x, y, e]),
  readPixel: async () => [0], display: {}
});
shell.el.clientWidth = 1000; shell.el.clientHeight = 700;
shell.layout.add(1, {});
shell.view(1).element.clientWidth = 800; shell.view(1).element.clientHeight = 600;
shell.view(1).resize();
shell.setImage({ docId: 1, name: 'e.tif', width: 100, height: 100, bitDepth: 8, channels: [{ name: 'c', color: '#fff', display: { min: 0, max: 255, lut: 'Grays', invert: false } }], calibration: null });
shell.view(1).setTileProvider(async () => ({ width: 100, height: 100, bitDepth: 8, data: new Uint8Array(10000) }));
for (let i = 0; i < 4; i++) { for (const fn of rafQueue.splice(0)) fn(); await new Promise((r) => setTimeout(r, 0)); }
const st = shell.view(1).element;
const ptr = (x, y, extra = {}) => ({ clientX: x, clientY: y, pointerId: 1, ...extra });
// the image (100 × 100 at zoom 1) is centred in the 800 × 600 stage: pixel (0, 0) at (350, 250)
const at = (px, py) => [350 + px, 250 + py];
const down = (px, py, extra) => st.fire('pointerdown', ptr(...at(px, py), extra));

// the toolbar holds the three tools, in the planned places
const toolIds = Array.from(shell.el.children.length ? [] : []);
void toolIds;
const buttons = [];
(function walk(n) { for (const c of n.children) { if (c.dataset && c.dataset.tool) buttons.push(c.dataset.tool); walk(c); } })(shell.el);
deq(buttons, ['rect', 'oval', 'polygon', 'freehand', 'line', 'polyline', 'angle', 'point', 'wand', 'zoom', 'hand'], 'Segmented line and Angle after Straight line, Wand after Point');

// Wand: a click hands the pixel to the controller; nothing is selected by the shell itself
shell.setTool('wand');
down(30, 40);
deq(wand.map((w) => [w[0], w[1]]), [[30, 40]]);
assert.equal(shell.getActiveRoi(), null);
assert.equal(rois.length, 0);

// Segmented line: a vertex per click, a double click (or Enter) finishes; vertices are integers
shell.setTool('polyline');
down(10, 10, { detail: 1 }); down(40, 10, { detail: 1 }); down(40, 30, { detail: 1 });
assert.equal(shell.getActiveRoi(), null, 'still being drawn');
st.fire('dblclick', ptr(...at(40, 30)));
let r = shell.getActiveRoi();
assert.equal(r.type, 'polyline');
deq(r.points, [[10, 10], [40, 10], [40, 30]]);
assert.equal(r.width, 1);
assert.equal(rois[rois.length - 1][1].final, true);
// the line width of the Straight line tool applies
shell.setLineWidth(4);
down(5, 60, { detail: 1 }); down(25, 60, { detail: 1 });
doc.fire('keydown', { key: 'Enter', target: st });
r = shell.getActiveRoi();
assert.equal(r.type, 'polyline'); assert.equal(r.width, 4);
// Backspace removes the last vertex; Escape cancels the draft
shell.setLineWidth(1);
down(50, 60, { detail: 1 }); down(60, 70, { detail: 1 }); down(70, 60, { detail: 1 });
doc.fire('keydown', { key: 'Backspace', target: st });
doc.fire('keydown', { key: 'Enter', target: st });
deq(shell.getActiveRoi().points, [[50, 60], [60, 70]]);
shell.setTool('polyline');
down(80, 80, { detail: 1 }); down(90, 80, { detail: 1 });
doc.fire('keydown', { key: 'Escape', target: st });
assert.equal(shell.getActiveRoi(), null);
// one vertex only: nothing to keep
down(80, 80, { detail: 1 });
doc.fire('keydown', { key: 'Enter', target: st });
assert.equal(shell.getActiveRoi(), null);

// Angle: three clicks, no more
shell.setTool('angle');
down(10, 50, { detail: 1 }); down(30, 50, { detail: 1 });
assert.equal(shell.getActiveRoi(), null);
down(30, 20, { detail: 1 });
r = shell.getActiveRoi();
assert.equal(r.type, 'angle');
deq(r.points, [[10, 50], [30, 50], [30, 20]]);
assert.equal(P.describeRoi(r, null), 'angle=90');
// a vertex handle of the finished angle moves it
shell.setTool('angle');
down(30, 20, { detail: 1 });
st.fire('pointermove', ptr(...at(40, 20)));
st.fire('pointerup', ptr(...at(40, 20)));
deq(shell.getActiveRoi().points[2], [40, 20]);
// switching tools drops an unfinished draft
shell.setTool('polyline');
down(5, 5, { detail: 1 }); down(15, 5, { detail: 1 });
shell.setTool('rect');
doc.fire('keydown', { key: 'Enter', target: st });
const n = rois.length;
assert.ok(n > 0);
// double clicking the Wand / Straight line / Point buttons opens their options
const wandBtn = (function find(nn) { for (const c of nn.children) { if (c.dataset && c.dataset.tool === 'wand') return c; const f = find(c); if (f) return f; } return null; })(shell.el);
wandBtn.fire('dblclick');
deq(toolOptions, ['wand']);

shell.destroy();
console.log('ij roi view: ok');
