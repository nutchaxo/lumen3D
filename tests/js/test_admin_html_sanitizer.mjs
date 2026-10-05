// The page builder's HTML widget and every authored link go through an ALLOWLIST:
// listed elements/attributes survive, URL schemes are read the way the URL parser
// reads them (tab/newline/control characters ignored), SVG/MathML never survive.
//
// There is no DOM in Node, so the element walk runs on a tiny node model that
// implements exactly the DOM surface the sanitizer touches.
//
// Run: node tests/js/test_admin_html_sanitizer.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

const XHTML = 'http://www.w3.org/1999/xhtml';
const SVG = 'http://www.w3.org/2000/svg';

class Node_ {
  constructor(tag, attrs = {}, kids = [], ns = XHTML) {
    this.nodeType = 1; this.localName = tag; this.namespaceURI = ns;
    this._attrs = new Map(Object.entries(attrs));
    this.childNodes = kids; this.parent = null;
    kids.forEach((k) => { k.parent = this; });
  }
  get attributes() { return [...this._attrs].map(([name, value]) => ({ name, value })); }
  hasAttribute(n) { return this._attrs.has(n); }
  setAttribute(n, v) { this._attrs.set(n, String(v)); }
  removeAttribute(n) { this._attrs.delete(n); }
  remove() { if (this.parent) this.parent.childNodes = this.parent.childNodes.filter((c) => c !== this); }
  replaceWith(...nodes) {
    const p = this.parent; const i = p.childNodes.indexOf(this);
    p.childNodes.splice(i, 1, ...nodes); nodes.forEach((n) => { n.parent = p; });
  }
}
const text = (s) => ({ nodeType: 3, data: s, remove() {}, parent: null });
const el = (tag, attrs, ...kids) => new Node_(tag, attrs, kids);
const dump = (n) => (n.nodeType === 3 ? n.data
  : `<${n.localName}${n.attributes.map((a) => ` ${a.name}="${a.value}"`).join('')}>${n.childNodes.map(dump).join('')}</${n.localName}>`);

const R = loadModule('js/core/page-renderer.js', 'PageRenderer', {
  document: { createElement: () => ({}) }, window: {}, navigator: {}, I18n: undefined,
});
assert.ok(R && typeof R.sanitizeNode === 'function' && typeof R.safeHref === 'function', 'sanitizer is exported');

function clean(...kids) {
  const root = new Node_('root', {}, kids);
  R.sanitizeNode(root);
  return root.childNodes.map(dump).join('');
}

// ── Scheme reading: what the URL parser would navigate to ──────
for (const bad of [
  'javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)',
  'java\nscript:alert(1)', 'java\rscript:alert(1)', '\u0001javascript:alert(1)', '\u001fjavascript:alert(1)',
  'vbscript:msgbox', 'data:text/html,<script>', 'file:///etc/passwd',
  'java​script:alert(1)', 'java­script:x', 'blob:http://x/y', 'ftp://h/f',
]) {
  assert.equal(R.safeHref(bad), '', `refused: ${JSON.stringify(bad)}`);
}
for (const good of ['https://example.org/a?b=c', 'http://h', 'mailto:a@b.c', 'tel:+3212345', '#top', 'explorer.html', '/abs/path', '../up.html', '//cdn.host/x', 'page.html?x=1:2']) {
  assert.equal(R.safeHref(good), good, `kept: ${good}`);
}

// ── Elements: allowlist, unwrap, drop ──────────────────────────
assert.equal(clean(el('p', {}, text('hi'))), '<p>hi</p>');
assert.equal(clean(el('script', {}, text('alert(1)'))), '', 'script removed with its content');
assert.equal(clean(el('style', {}, text('*{display:none}'))), '', 'style removed');
assert.equal(clean(el('iframe', { src: 'https://x' })), '');
assert.equal(clean(el('form', { action: '/x' }, el('input', { name: 'p' }))), '', 'forms and inputs removed');
assert.equal(clean(el('foo-bar', {}, el('b', {}, text('x')))), '<b>x</b>', 'unknown element is unwrapped, its text kept');
assert.equal(clean(new Node_('svg', {}, [new Node_('style', {}, [text('x')], SVG)], SVG)), '', 'SVG namespace never survives');
assert.equal(clean(new Node_('script', {}, [text('x')], SVG)), '', 'lower-case SVG script is removed too');
assert.equal(clean(new Node_('math', {}, [], 'http://www.w3.org/1998/Math/MathML')), '', 'MathML removed');
const comment = new Node_('#comment');
comment.nodeType = 8;
assert.equal(clean(comment), '', 'comments removed');

// ── Attributes: allowlist ──────────────────────────────────────
assert.equal(clean(el('a', { href: 'https://ok.org', onclick: 'x()', onmouseover: 'y()', id: 'x', formaction: '/z' }, text('l'))),
  '<a href="https://ok.org" id="x">l</a>', 'event handlers and unknown attributes dropped, the id (an in-page anchor target) kept');
assert.equal(clean(el('video', { src: 'config/media/a.mp4', poster: 'javascript:x', controls: '', onplay: 'x()' }, el('source', { src: 'data:text/html,x', type: 'video/mp4' }))),
  '<video src="config/media/a.mp4" controls=""><source type="video/mp4"></source></video>', 'media an existing page embeds survives, its URLs checked');
assert.equal(clean(el('table', { border: '1', bgcolor: 'red' }, el('tbody', {}))), '<table border="1"><tbody></tbody></table>');
assert.equal(clean(el('a', { href: 'java\tscript:alert(1)' }, text('l'))), '<a>l</a>', 'obfuscated javascript: href dropped');
assert.equal(clean(el('a', { href: 'https://x', target: '_blank' }, text('l'))), '<a href="https://x" target="_blank" rel="noopener noreferrer">l</a>');
assert.equal(clean(el('a', { href: 'https://x', target: 'evilframe' }, text('l'))), '<a href="https://x">l</a>', 'named targets dropped');
assert.equal(clean(el('img', { src: 'javascript:x', alt: 'a' })), '<img alt="a"></img>');
assert.equal(clean(el('img', { src: 'data:image/png;base64,AAAA', alt: 'a' })), '<img src="data:image/png;base64,AAAA" alt="a"></img>', 'inline raster images survive');
assert.equal(clean(el('img', { src: 'data:image/svg+xml;base64,PHN2Zz4=' })), '<img></img>', 'inline SVG images do not');
assert.equal(clean(el('img', { src: 'data:text/html;base64,AAAA' })), '<img></img>');
assert.equal(clean(el('div', { 'data-x': '1', 'aria-label': 'l', class: 'c', srcdoc: '<script>' }, text('t'))),
  '<div data-x="1" aria-label="l" class="c">t</div>');

// ── Inline style: declaration by declaration ───────────────────
assert.equal(R.cleanInlineStyle('color: red; margin: 4px'), 'color: red; margin: 4px');
assert.equal(R.cleanInlineStyle('position: fixed; top: 0; color: red'), 'top: 0; color: red', 'fixed positioning removed');
assert.equal(R.cleanInlineStyle('position: sticky'), '');
assert.equal(R.cleanInlineStyle('position: relative'), 'position: relative');
assert.equal(R.cleanInlineStyle('z-index: 99999; color: red'), 'color: red', 'z-index removed');
assert.equal(R.cleanInlineStyle('background: url(javascript:alert(1))'), '');
assert.equal(R.cleanInlineStyle('background: url("https://h/i.png")'), 'background: url("https://h/i.png")');
assert.equal(R.cleanInlineStyle('background: url(data:image/png;base64,AA)'), '', 'data: urls in CSS refused');
assert.equal(R.cleanInlineStyle('width: expression(alert(1))'), '');
assert.equal(R.cleanInlineStyle('color: \\72 ed'), '', 'CSS escapes (obfuscation) refuse the whole attribute');
assert.equal(R.cleanInlineStyle('} body { display:none'), '', 'brace injection refused');
assert.equal(R.cleanInlineStyle('@import url(x)'), '');
assert.equal(clean(el('p', { style: 'position:fixed' }, text('x'))), '<p>x</p>', 'an emptied style attribute is removed');

console.log('admin HTML sanitizer (allowlist · URL scheme normalisation · SVG/MathML · inline style): OK');
