// A widget the editor cannot draw shows a translated placeholder naming the
// widget type, never the exception text (which goes to the console only), and
// an unknown type is told apart from a renderer that threw. A live page draws
// nothing for either.
//
// Run: node tests/js/test_page_widget_error_box.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

class El {
  constructor(tag) {
    this.nodeType = 1; this.localName = tag; this.childNodes = [];
    this.style = { cssText: '', setProperty() {} }; this.className = ''; this.attrs = {}; this._text = '';
    this.dataset = {};
  }
  get classList() { return { add() {}, contains() { return false; }, toggle() {} }; }
  appendChild(n) { this.childNodes.push(n); return n; }
  insertBefore(n) { this.childNodes.push(n); return n; }
  set textContent(v) { this.childNodes = []; this._text = String(v); }
  get textContent() { return this._text + this.childNodes.map((c) => c.textContent).join(''); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener() {}
}
const body = new El('body');
const document = {
  body,
  createElement: (tag) => new El(tag),
  createTextNode: (s) => ({ nodeType: 3, textContent: String(s), style: null }),
};

const DICT = {
  'pages.widgetUnknown': 'TR-UNKNOWN',
  'pages.widgetError': 'TR-ERROR',
};
const I18n = { t: (k) => (k in DICT ? DICT[k] : k) };
const warnings = [];
const console = { warn: (...a) => warnings.push(a), log() {}, error() {} };

const R = loadModule('js/core/page-renderer.js', 'PageRenderer', {
  document, window: {}, navigator: {}, I18n, console,
});
assert.ok(R && typeof R.renderWidget === 'function', 'renderer loaded');

const SECRET = "Cannot read properties of undefined (reading 'map')";
const throwing = () => ({
  id: 'w', type: 'heading',
  props: new Proxy({}, { get(_, k) { if (k === 'style') return undefined; throw new Error(SECRET); } }),
});

// Live page: both degrade to nothing.
assert.equal(R.renderWidget({ id: 'w', type: 'no-such-widget', props: {} }), null, 'live page: unknown type draws nothing');
assert.equal(R.renderWidget(throwing()), null, 'live page: a failing widget draws nothing');

// Editor.
body.dataset.editing = '1';
{
  const box = R.renderWidget({ id: 'w', type: 'no-such-widget', props: {} });
  const text = box.textContent;
  assert.match(text, /no-such-widget/, 'unknown: names the type');
  assert.match(text, /TR-UNKNOWN/, 'unknown: translated reason');
  assert.doesNotMatch(text, /inconnu/, 'unknown: no French literal');
}
{
  const before = warnings.length;
  const box = R.renderWidget(throwing());
  const text = box.textContent;
  assert.match(text, /heading/, 'error: names the type');
  assert.match(text, /TR-ERROR/, 'error: translated reason');
  assert.ok(!text.includes(SECRET), 'error: the exception text never reaches the page');
  assert.ok(warnings.length > before, 'error: the exception is logged to the console');
}
// Without a dictionary entry the English fallback is used, never the key.
{
  delete DICT['pages.widgetError'];
  const text = R.renderWidget(throwing()).textContent;
  assert.match(text, /could not be drawn/, 'missing key: English fallback');
  assert.doesNotMatch(text, /pages\.widgetError/, 'missing key: the raw key is not shown');
}
process.stdout.write('OK test_page_widget_error_box\n');
