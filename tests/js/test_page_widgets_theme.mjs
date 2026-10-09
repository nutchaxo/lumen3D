// Page-builder widgets that misrendered in the light theme or on a phone:
//  - no default colour may lean on --bg-base, a token no theme defines, without
//    a real theme fallback (badge pill, cite-block Copy button and BibTeX box);
//  - the cta-banner subtitle follows the band's colour, its buttons can wrap;
//  - an image honours its alignment and never gets a max-width wider than its column;
//  - links of richtext / spec-list / icon-list get a light-theme-safe accent (and a
//    colour setting), pages that set their own accent in custom CSS keep it;
//  - a zoomed gallery clips the picture, not its caption; automatic columns
//    never strand one image when another column count avoids it;
//  - a column holding one feature-card stretches it to the row height and the
//    card's link sits at its bottom.
//
// There is no DOM in Node: the renderer runs on a small element model that
// implements the surface it touches.
//
// Run: node tests/js/test_page_widgets_theme.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadModule, ROOT } from './harness.mjs';

class Style {
  constructor() { this.cssText = ''; }
  setProperty(k, v) { this.cssText += `;${k}:${v}`; }
}
class El {
  constructor(tag) {
    this.nodeType = 1; this.localName = tag; this.tagName = tag.toUpperCase();
    this.childNodes = []; this.parentNode = null; this.style = new Style();
    this.className = ''; this.attrs = {}; this._text = ''; this.isConnected = false;
  }
  get classList() {
    const self = this;
    const list = () => self.className.split(/\s+/).filter(Boolean);
    return {
      add(...c) { self.className = [...new Set([...list(), ...c])].join(' '); },
      contains(c) { return list().includes(c); },
      toggle(c, on) { const has = list().includes(c); if (on ?? !has) this.add(c); else self.className = list().filter((x) => x !== c).join(' '); },
    };
  }
  appendChild(n) { n.parentNode = this; this.childNodes.push(n); return n; }
  insertBefore(n, ref) {
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    n.parentNode = this;
    if (i < 0) this.childNodes.push(n); else this.childNodes.splice(i, 0, n);
    return n;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  set textContent(v) { this.childNodes = []; this._text = String(v); }
  get textContent() { return this._text + this.childNodes.map((c) => c.textContent).join(''); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener() {}
}
const document = {
  createElement: (tag) => new El(tag),
  createTextNode: (s) => ({ nodeType: 3, textContent: String(s), style: null }),
};

let lastObserver = null;
class FakeResizeObserver {
  constructor(cb) { this.cb = cb; this.targets = []; this.disconnected = false; lastObserver = this; }
  observe(t) { this.targets.push(t); }
  disconnect() { this.disconnected = true; }
  fire(width) { this.cb([{ target: this.targets[0], contentRect: { width, height: 300 } }]); }
}

const R = loadModule('js/core/page-renderer.js', 'PageRenderer', {
  document, window: {}, navigator: {}, ResizeObserver: FakeResizeObserver,
});
assert.ok(R && typeof R.renderWidget === 'function', 'renderer loaded');

const all = (n, out = []) => { if (n && n.nodeType === 1) { out.push(n); n.childNodes.forEach((c) => all(c, out)); } return out; };
const cssOf = (n) => all(n).map((e) => e.style.cssText).join('\n');
const find = (n, pred) => all(n).find(pred);
const widget = (type, props, text) => R.renderWidget({ id: 'w', type, props: props || {}, text }).childNodes[0];

// ── 1. --bg-base never stands alone ─────────────────────────────────────────
const BARE_BG_BASE = /var\(\s*--bg-base\s*(\)|,\s*#)/;
{
  const badge = widget('badge', { items: [{ text: 'Under construction' }] });
  const pill = badge.childNodes[0];
  assert.match(pill.style.cssText, /var\(--bg-base, var\(--bg-body/, 'badge pill: page background with a theme fallback');
  assert.doesNotMatch(cssOf(badge), BARE_BG_BASE, 'badge: no bare --bg-base');

  const cite = widget('cite-block', { title: 'Cite', text: 'Doe 2024', extra: '@article{x}', copy: true });
  const btn = find(cite, (e) => e.localName === 'button' && /height:30px/.test(e.style.cssText));
  const pre = find(cite, (e) => e.localName === 'pre');
  assert.ok(btn && pre, 'cite-block renders its Copy button and BibTeX box');
  assert.match(btn.style.cssText, /background:var\(--bg-base, var\(--bg-body/);
  assert.match(pre.style.cssText, /background:var\(--bg-base, var\(--bg-body/);
  assert.doesNotMatch(cssOf(cite), BARE_BG_BASE, 'cite-block: no bare --bg-base');

  // The editor's former "site background" swatch stored a bare var(--bg-base).
  const legacy = widget('badge', { items: [{ text: 'x' }], pillBg: 'var(--bg-base)', pillColor: 'var(--bg-base)' });
  assert.match(legacy.childNodes[0].style.cssText, /background:var\(--bg-base, var\(--bg-body\)\)/);
  assert.match(legacy.childNodes[0].style.cssText, /color:var\(--bg-base, var\(--bg-body\)\)/);
  const sec = R.renderSection({ props: { bg: 'var(--bg-base)', style: { css: 'outline-color: var(--bg-base);' } }, columns: [] });
  assert.doesNotMatch(sec.style.cssText, BARE_BG_BASE, 'section bg and custom CSS read the legacy token with a fallback');

  // Pages already published override the token in the widget's custom CSS: the
  // declaration itself is left alone and still lands on the widget root.
  const patched = widget('cite-block', { title: 'Cite', text: 'x', style: { css: '--bg-base: var(--bg-body);' } });
  assert.match(patched.style.cssText, /--bg-base: var\(--bg-body\);/);
}

// ── 2. cta-banner ──────────────────────────────────────────────────────────
{
  const banner = widget('cta-banner', {
    subtitle: 'Explore the volumes', align: 'left',
    cta: { text: 'Open the explorer', href: 'explorer.html' }, cta2: { text: 'Compare datasets', href: 'compare.html' },
  }, 'Ready?');
  const sub = find(banner, (e) => e.localName === 'p');
  assert.match(sub.style.cssText, /color:inherit/, 'subtitle follows the band colour, not base.css p');
  assert.doesNotMatch(cssOf(banner), /white-space:nowrap/, 'labels may wrap on a narrow band');
  const row = banner.childNodes[1];
  assert.equal(row.childNodes.length, 2, 'two buttons grouped in one row');
  assert.match(row.style.cssText, /flex:0 1 auto/, 'the row may shrink to the band');
  assert.match(row.style.cssText, /flex-wrap:wrap/);
  row.childNodes.forEach((a) => {
    assert.match(a.style.cssText, /flex:0 1 auto/);
    assert.match(a.style.cssText, /max-width:100%/);
  });
  assert.match(banner.childNodes[0].style.cssText, /min-width:min\(220px,100%\)/, 'text block never wider than the band');
  const single = widget('cta-banner', { cta: { text: 'Go', href: 'x.html' } }, 'T');
  assert.match(single.childNodes[1].style.cssText, /max-width:100%/, 'a lone button cannot overflow either');
}

// ── 3. image alignment and max width ───────────────────────────────────────
{
  const img = (props) => find(widget('image', { src: 'a.webp', ...props }), (e) => e.localName === 'img');
  assert.match(img({}).style.cssText, /margin-left:auto;margin-right:auto/, 'default centre');
  assert.match(img({ align: 'right' }).style.cssText, /margin-left:auto;margin-right:0/, 'right');
  assert.doesNotMatch(img({ align: 'left' }).style.cssText, /margin-left:auto/, 'left');
  assert.match(img({ align: 'center', style: { align: 'right' } }).style.cssText, /margin-left:auto;margin-right:0/,
    'style.align (text group, wins on the wrapper) places the image too');
  const capped = img({ align: 'center', style: { maxWidth: 240, radius: 4 } }).style.cssText;
  assert.match(capped, /max-width:min\(100%, 240px\)/, 'max width never above the column');
  assert.doesNotMatch(capped, /max-width:240px/, 'no bare px max-width');
  assert.match(capped, /border-radius:4px/, 'surface group still applied');
  const leftCapped = img({ align: 'left', style: { maxWidth: 240 } }).style.cssText;
  assert.doesNotMatch(leftCapped, /margin-left:auto/, 'a capped image follows its alignment');
  const linked = widget('image', { src: 'a.webp', href: 'viewer.html', caption: 'TS11d' });
  assert.equal(linked.localName, 'figure');
  assert.ok(find(linked, (e) => e.localName === 'a' && e.childNodes[0].localName === 'img'), 'link wraps the image');
}

// ── 4. links of the text widgets ───────────────────────────────────────────
{
  const rich = widget('richtext', { markup: true }, 'See [PubMed](https://pubmed.ncbi.nlm.nih.gov/1).');
  assert.ok(rich.classList.contains('pr-links'), 'richtext root carries the light-theme link class');
  const a = find(rich, (e) => e.localName === 'a');
  assert.equal(a.style.cssText, '', 'no inline colour by default: base.css a + the class rule');
  const richC = widget('richtext', { markup: true, linkColor: '#004488' }, '[x](https://a.b)');
  assert.match(find(richC, (e) => e.localName === 'a').style.cssText, /color:#004488/, 'richtext linkColor');

  for (const [type, items] of [['spec-list', [{ label: 'Code', value: 'GitHub', href: 'https://github.com' }]],
    ['icon-list', [{ icon: 'mail', text: 'Contact', href: 'mailto:a@b.c' }]]]) {
    const root = widget(type, { items });
    assert.ok(root.classList.contains('pr-links'), `${type}: root carries the class`);
    const link = find(root, (e) => e.localName === 'a');
    assert.match(link.style.cssText, /^color:var\(--color-accent,#00D2FF\);text-decoration:none$/, `${type}: default link reads --color-accent`);
    const coloured = find(widget(type, { items, linkColor: 'var(--text-primary)' }), (e) => e.localName === 'a');
    assert.match(coloured.style.cssText, /^color:var\(--text-primary\);text-decoration:none$/, `${type}: linkColor`);
    // The workaround of published pages: --color-accent set inline on the root,
    // which outranks the class rule of css/pages.css.
    const patched = widget(type, { items, style: { css: '--color-accent: color-mix(in srgb, var(--color-primary) 60%, var(--text-primary));' } });
    assert.match(patched.style.cssText, /--color-accent: color-mix/);
  }

  const pagesCss = readFileSync(path.join(ROOT, 'css/pages.css'), 'utf8');
  const rule = /\[data-theme="light"\]\s*\.pr-links\s*\{([^}]*)\}/.exec(pagesCss);
  assert.ok(rule, 'css/pages.css has the light-theme .pr-links rule');
  assert.match(rule[1], /--color-accent:\s*var\(--color-accent-text\)/);
  assert.match(rule[1], /--color-accent-hover:\s*var\(--color-accent-text-hover\)/);

  const themes = readFileSync(path.join(ROOT, 'css/themes.css'), 'utf8');
  const block = (re) => {
    const m = re.exec(themes);
    assert.ok(m, `themes.css block ${re}`);
    return themes.slice(m.index, themes.indexOf('}', m.index));
  };
  const token = (b, name) => { const m = new RegExp(`${name}:\\s*([^;]+);`).exec(b); return m && m[1].trim(); };
  const dark = block(/^:root,\s*\[data-theme="dark"\]\s*\{/m);
  assert.equal(token(dark, '--color-accent-text'), 'var(--color-accent)', 'dark theme keeps the accent as is');
  const light = block(/^\[data-theme="light"\]\s*\{/m);
  const fixed = token(light, '--color-accent-text');
  const lum = (hex) => {
    const c = hex.replace('#', '').match(/../g).map((h) => { const v = parseInt(h, 16) / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const bg of ['--bg-body', '--bg-surface', '--bg-surface-2']) {
    const r = ratio(fixed, token(light, bg));
    assert.ok(r >= 4.5, `light link colour ${fixed} on ${bg}: ${r.toFixed(2)}:1 ≥ 4.5:1`);
  }
  assert.match(themes, /@supports \(color: color-mix\(in srgb, red 50%, black\)\) \{\s*\[data-theme="light"\] \{\s*--color-accent-text:\s*color-mix\(in srgb, var\(--color-accent\) 45%, var\(--text-primary\)\)/,
    'the light link colour follows the operator accent where color-mix exists');
}

// ── 5. gallery ─────────────────────────────────────────────────────────────
{
  const images = Array.from({ length: 6 }, (_, i) => ({ src: `g${i}.webp`, alt: `TS1${i}` }));
  const zoomCap = widget('gallery', { images, zoom: true, captions: true, style: { radius: 16 } });
  zoomCap.childNodes.forEach((cell) => {
    assert.doesNotMatch(cell.style.cssText, /overflow:hidden/, 'the cell does not clip its caption');
    const [frame, caption] = cell.childNodes;
    assert.match(frame.style.cssText, /overflow:hidden;border-radius:16px/, 'the picture frame clips the zoom');
    assert.equal(frame.childNodes[0].localName, 'img');
    assert.equal(caption.textContent.startsWith('TS1'), true, 'caption outside the clipped frame');
  });
  const zoomOnly = widget('gallery', { images, zoom: true });
  assert.match(zoomOnly.childNodes[0].style.cssText, /overflow:hidden;border-radius:/, 'zoom without captions unchanged');
  assert.equal(zoomOnly.childNodes[0].childNodes[0].localName, 'img');

  const G = R.galleryColumns;
  assert.equal(G(6, 6), 0, 'one row: auto-fill kept');
  assert.equal(G(6, 5), 3, '6 on 5 tracks: 3 + 3');
  assert.equal(G(6, 4), 3, '6 on 4 tracks: 3 + 3');
  assert.equal(G(7, 5), 5, '7 on 5 tracks: 5 + 2');
  assert.equal(G(8, 6), 4, '8 on 6 tracks: 4 + 4');
  assert.equal(G(5, 4), 3, '5 on 4 tracks: 3 + 2');
  assert.equal(G(7, 3), 3, '7 on 3 tracks: no orphan-free layout, keep the tracks');
  for (let n = 1; n <= 30; n++) {
    for (let fit = 1; fit <= 12; fit++) {
      const c = G(n, fit);
      if (n <= fit) { assert.equal(c, 0); continue; }
      assert.ok(c >= 1 && c <= fit, `n=${n} fit=${fit}: ${c} columns within the tracks`);
      let avoidable = false;
      for (let k = 2; k <= fit; k++) if (n % k !== 1) avoidable = true;
      if (avoidable && c > 1) assert.notEqual(n % c, 1, `n=${n} fit=${fit}: ${c} columns strand one image`);
    }
  }

  lastObserver = null;
  const grid = widget('gallery', { images });
  const ro = lastObserver;
  assert.ok(ro && ro.targets[0] === grid, 'automatic columns observe the grid width');
  grid.isConnected = true;
  ro.fire(900);    // (900 + 12) / (160 + 12) = 5 tracks for 6 images
  assert.equal(grid.style.gridTemplateColumns, 'repeat(3,minmax(0,1fr))');
  ro.fire(1100);   // 6 tracks: one row
  assert.equal(grid.style.gridTemplateColumns, 'repeat(auto-fill,minmax(160px,1fr))');
  grid.isConnected = false;
  ro.fire(0);
  assert.ok(ro.disconnected, 'a detached grid stops observing');
  lastObserver = null;
  widget('gallery', { images, cols: 6 });
  assert.equal(lastObserver, null, 'explicit columns are never re-chosen');
}

// ── 6. feature-card rows ───────────────────────────────────────────────────
{
  const card = (props) => ({ id: 'c', type: 'feature-card', text: 'Fixed embryos',
    props: { media: 'icon', icon: 'layers', desc: 'Confocal stacks', link: { text: 'View', href: 'explorer.html' }, ...props } });
  const v = R.renderWidget(card({})).childNodes[0];
  assert.match(v.style.cssText, /height:100%/);
  assert.match(v.style.cssText, /display:flex;flex-direction:column/, 'vertical card is a flex column');
  const foot = v.childNodes[v.childNodes.length - 1];
  assert.match(foot.style.cssText, /^margin-top:auto$/, 'the link sits at the bottom of a taller card');
  assert.match(foot.childNodes[0].style.cssText, /margin-top:14px/, 'and keeps its own gap to the text');
  assert.equal(v.childNodes[0].childNodes[0].style.cssText.startsWith('display:inline-flex'), true,
    'the icon badge stays inline in a line of its own (text-align places it)');

  const hc = R.renderWidget(card({ layout: 'h' })).childNodes[0];
  const textCol = hc.childNodes[1];
  assert.match(textCol.style.cssText, /align-self:stretch;display:flex;flex-direction:column/, 'horizontal text column fills the card');

  const one = { width: 4, widgets: [card({})] };
  const two = { width: 4, widgets: [{ id: 'h', type: 'heading', text: 'T' }, card({})] };
  assert.ok(R.fillsColumn(one) && !R.fillsColumn(two));
  assert.match(R.columnCss(one, 24, 3), /display:flex;flex-direction:column/, 'a lone card makes its column a flex column');
  assert.doesNotMatch(R.columnCss(two, 24, 3), /display:flex/, 'several widgets keep the block flow');
  const section = R.renderSection({ props: {}, columns: [one, one, two] });
  const cols = section.childNodes[0].childNodes[0].childNodes;
  assert.match(cols[0].childNodes[0].style.cssText, /flex:1 1 0%/, 'the widget box takes the column height');
  cols[2].childNodes.forEach((box) => assert.doesNotMatch(box.style.cssText, /flex:1 1 0%/));
}

console.log('OK test_page_widgets_theme');
