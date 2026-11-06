// Admin panel keyboard and narrow-screen behaviour:
//  - shared.js modalize(): a dialog is named, the rest of the page is inert while it
//    is open (live regions excepted, a node made inert by someone else untouched,
//    stacked dialogs released in any order) and focus is moved in, kept in, and
//    given back; askPassword, the Pages import/export dialogs and the upload exit
//    guard all go through it;
//  - the collapsed sidebar keeps every label as an accessible name (visually hidden,
//    not display:none) and gives each icon a tooltip; the collapse button says
//    Expand when collapsed;
//  - the mobile drawer: aria-expanded, focus moved in, Escape / backdrop close it and
//    give focus back, and the closed drawer is out of the Tab order;
//  - the Datasets tab mounts no viewer while the preview column is hidden and gates
//    the controls that would act on it.
//
// Run: node tests/js/test_admin_modal_drawer_preview.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadModule, ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// ── minimal DOM ──────────────────────────────────────────────────────────────
class Doc {
  constructor() { this.listeners = {}; this.activeElement = null; this.body = new El(this, 'body'); }
  createElement(tag) { return new El(this, tag); }
  getElementById(id) { return this.body.all().find((n) => n.id === id) || null; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((l) => l !== fn); }
  fire(t, ev) {
    const out = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...ev };
    for (const fn of [...(this.listeners[t] || [])]) fn(out);
    return out;
  }
}
const FOCUSABLE_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A']);
class El {
  constructor(doc, tag) {
    this.doc = doc; this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
    this.attrs = {}; this.disabled = false; this.visible = true;
  }
  get id() { return this.attrs.id || ''; }
  set id(v) { this.attrs.id = String(v); }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.doc.body; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); this.parentNode = null; }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  isInert() { for (let x = this; x; x = x.parentNode) if (x.hasAttribute('inert')) return true; return false; }
  focus() { if (!this.isInert()) this.doc.activeElement = this; }
  getClientRects() { return this.visible ? [{}] : []; }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  // The trap asks for its focusable selector list; the model answers with its controls.
  querySelectorAll() { return this.all().filter((n) => FOCUSABLE_TAGS.has(n.tagName) && !n.disabled); }
}

const doc = new Doc();
globalThis.document = doc;
globalThis.window = { location: { origin: 'http://h' }, addEventListener() {} };
globalThis.Utils = loadModule('js/core/utils.js', 'Utils', {
  window: globalThis.window, document: doc, requestAnimationFrame: () => {},
});
assert.equal(typeof globalThis.Utils.trapFocus, 'function', 'the shared focus trap is there');
const shared = await import(pathToFileURL(path.join(ROOT, 'js/pages/admin/shared.js')).href);

// ── 1. modalize ──────────────────────────────────────────────────────────────
{
  const app = doc.body.appendChild(doc.createElement('div')); app.id = 'admin-app';
  const opener = app.appendChild(doc.createElement('button'));
  const toasts = doc.body.appendChild(doc.createElement('div')); toasts.id = 'toast-container';
  const status = doc.body.appendChild(doc.createElement('div')); status.id = 'toast-status';
  const script = doc.body.appendChild(doc.createElement('script'));
  const foreign = doc.body.appendChild(doc.createElement('div')); foreign.setAttribute('inert', '');
  opener.focus();

  const overlay = doc.body.appendChild(doc.createElement('div'));
  const card = overlay.appendChild(doc.createElement('div'));
  const title = card.appendChild(doc.createElement('h3')); title.id = shared.modalId('t');
  const first = card.appendChild(doc.createElement('button'));
  const last = card.appendChild(doc.createElement('button'));

  const release = shared.modalize(overlay, { labelledBy: title.id, describedBy: 'd1', container: card });
  assert.equal(overlay.getAttribute('aria-labelledby'), title.id, 'the dialog is named by its title');
  assert.equal(overlay.getAttribute('aria-describedby'), 'd1');
  assert.ok(app.hasAttribute('inert'), 'the page behind is inert');
  assert.ok(!overlay.hasAttribute('inert'), 'the dialog is not');
  assert.ok(!toasts.hasAttribute('inert') && !status.hasAttribute('inert'), 'toasts and announcers stay live');
  assert.ok(!script.hasAttribute('inert'), 'scripts are left alone');
  assert.equal(doc.activeElement, first, 'focus moves to the first control when none is named');
  doc.activeElement = last;
  let ev = doc.fire('keydown', { key: 'Tab' });
  assert.ok(ev.defaultPrevented);
  assert.equal(doc.activeElement, first, 'Tab wraps inside the dialog');
  doc.fire('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(doc.activeElement, last, 'Shift+Tab wraps the other way');

  // A second dialog over the first one.
  const over = doc.body.appendChild(doc.createElement('div'));
  const ok = over.appendChild(doc.createElement('button'));
  const release2 = shared.modalize(over, { initialFocus: ok });
  assert.equal(doc.activeElement, ok, 'initialFocus wins');
  assert.ok(overlay.hasAttribute('inert'), 'the dialog underneath is inert too');
  release2();
  assert.ok(!overlay.hasAttribute('inert'), 'closing the top dialog gives the one underneath back');
  assert.ok(app.hasAttribute('inert'), '…while the page stays inert for it');
  assert.equal(doc.activeElement, last, 'focus returns to the control that opened the second dialog');
  over.remove();

  release();
  assert.ok(!app.hasAttribute('inert'), 'the page is back');
  assert.ok(foreign.hasAttribute('inert'), 'a node inert before the dialog stays inert');
  assert.equal(doc.activeElement, opener, 'focus returns to the opener');
  assert.equal((doc.listeners.keydown || []).length, 0, 'no key listener left behind');
  release();   // idempotent
  overlay.remove();

  // Released in the other order: the first dialog closes while the second is open.
  const a = doc.body.appendChild(doc.createElement('div')); a.appendChild(doc.createElement('button'));
  const relA = shared.modalize(a);
  const b = doc.body.appendChild(doc.createElement('div')); b.appendChild(doc.createElement('button'));
  const relB = shared.modalize(b);
  relA({ restore: false });
  a.remove();
  assert.ok(app.hasAttribute('inert'), 'the page stays inert while another dialog holds it');
  relB({ restore: false });
  assert.ok(!app.hasAttribute('inert'), 'and comes back with the last one');
  b.remove();
  assert.notEqual(shared.modalId('x'), shared.modalId('x'), 'ids are unique');
}

// ── 2. The three admin dialogs use it ────────────────────────────────────────
{
  const sharedSrc = read('js/pages/admin/shared.js');
  const ask = sharedSrc.slice(sharedSrc.indexOf('export function askPassword'));
  assert.match(ask, /modalize\(overlay, \{ labelledBy: titleId, describedBy: bodyId, initialFocus: input \}\)/, 'password dialog');
  assert.match(ask, /<h3 class="upl-exit-title" id="\$\{titleId\}">/, 'password dialog title has an id');

  const xfer = read('js/pages/admin/pages-transfer-ui.js');
  const open = xfer.slice(xfer.indexOf('function openDialog'), xfer.indexOf('function localLabel'));
  assert.match(open, /title\.id = modalId\('pg-xfer-title'\)/, 'transfer dialogs name themselves');
  assert.match(open, /release = modalize\(overlay, \{/, 'transfer dialogs are modal');
  assert.match(open, /if \(release\) release\(\);\s*overlay\.remove\(\)/, 'the page comes back before the overlay goes');
  assert.ok(xfer.includes(`initialFocus: '[data-act="cancel"]'`), 'export focuses Cancel while it reads the pages');
  assert.ok(xfer.includes(`$('input[data-slug]:not(:disabled)')?.focus()`), 'then the first page');
  assert.ok(xfer.includes(`$('input[data-i]')?.focus()`), 'import focuses its first page');

  const shell = read('js/pages/admin/shell.js');
  assert.match(shell, /_releaseExitOverlay = modalize\(overlay, \{\s*labelledBy: 'upl-exit-title',\s*describedBy: 'upl-exit-body',\s*initialFocus: el\('upl-exit-stay'\)/, 'upload exit guard');
  assert.match(read('admpan.html'), /<p class="upl-exit-body" id="upl-exit-body"/);
}

// ── 3. Collapsed sidebar: names and tooltips ─────────────────────────────────
{
  const css = read('css/admin-shell.css');
  const mobileAt = css.indexOf('@media (max-width: 900px)');
  const wide = css.slice(0, mobileAt);
  assert.ok(!/\.adm-sidebar\.collapsed \.adm-nav-label[^{]*\{[^}]*display:\s*none/.test(wide), 'a collapsed label is not display:none');
  const hidden = /\.adm-sidebar\.collapsed \.adm-nav-label \{([^}]*)\}/.exec(wide);
  assert.ok(hidden, 'collapsed label rule');
  for (const decl of ['position: absolute', 'width: 1px', 'height: 1px', 'overflow: hidden', 'clip-path: inset(50%)']) {
    assert.ok(hidden[1].includes(decl), `collapsed label is visually hidden (${decl})`);
  }
  const mobile = css.slice(mobileAt, css.indexOf('@media (max-width: 760px)'));
  const shown = /\.adm-sidebar\.collapsed \.adm-nav-label \{([^}]*)\}/.exec(mobile);
  assert.ok(shown && /position: static/.test(shown[1]) && /width: auto/.test(shown[1]) && /clip-path: none/.test(shown[1]),
    'the drawer shows the labels again');

  const shell = read('js/pages/admin/shell.js');
  const apply = shell.slice(shell.indexOf('function applyCollapsed'), shell.indexOf('function toggleCollapsed'));
  assert.match(apply, /on \? 'admin\.expand' : 'admin\.collapse'/, 'the collapse button says Expand when collapsed');
  assert.match(apply, /label\.setAttribute\('data-i18n', key\)/, 'and keeps saying it after a language switch');
  assert.match(apply, /syncNavTitles\(\)/);
  const sync = shell.slice(shell.indexOf('function syncNavTitles'), shell.indexOf('function openMobileSidebar'));
  assert.match(sync, /if \(collapsed && text\) item\.setAttribute\('title', text\);\s*else item\.removeAttribute\('title'\);/, 'tooltips only while collapsed');
  assert.match(shell.slice(shell.indexOf('async function switchLanguage')), /syncNavTitles\(\);/, 'tooltips follow the language');
}

// ── 4. Mobile drawer ─────────────────────────────────────────────────────────
{
  const html = read('admpan.html');
  assert.match(html, /id="btn-mobile-menu"[^>]*aria-controls="adm-sidebar" aria-expanded="false"/, 'menu button state');
  const css = read('css/admin-shell.css');
  const mobile = css.slice(css.indexOf('@media (max-width: 900px)'), css.indexOf('@media (max-width: 760px)'));
  const closed = /\n  \.adm-sidebar \{([^}]*)\}/.exec(mobile);
  assert.ok(closed && /visibility: hidden/.test(closed[1]) && /visibility 0s linear 0\.25s/.test(closed[1]),
    'the closed drawer leaves the Tab order once it has slid out');
  assert.match(mobile, /\.adm-sidebar\.open \{[^}]*visibility: visible; transition-delay: 0s, 0s;/, 'the open drawer is visible at once');

  const shell = read('js/pages/admin/shell.js');
  const openFn = shell.slice(shell.indexOf('function openMobileSidebar'), shell.indexOf('function closeMobileSidebar'));
  assert.match(openFn, /setAttribute\('aria-expanded', 'true'\)/);
  assert.match(openFn, /\.adm-nav-item\.active'\) \|\| sidebar\.querySelector\('\.adm-nav-item'\)\)\?\.focus\(\)/, 'focus moves into the drawer');
  const closeFn = shell.slice(shell.indexOf('function closeMobileSidebar'), shell.indexOf('// ── Theme'));
  assert.match(closeFn, /if \(!sidebar\?\.classList\.contains\('open'\)\) return;/, 'closing a closed drawer does nothing');
  assert.match(closeFn, /setAttribute\('aria-expanded', 'false'\)/);
  assert.match(closeFn, /if \(restoreFocus\) btn\?\.focus\(\);/, 'focus goes back only when dismissed');
  assert.match(shell, /addEventListener\('click', \(\) => closeMobileSidebar\(\{ restoreFocus: true \}\)\)/, 'backdrop dismisses');
  assert.match(shell, /if \(!e\.defaultPrevented && el\('adm-sidebar'\)\?\.classList\.contains\('open'\)\) closeMobileSidebar\(\{ restoreFocus: true \}\);/, 'Escape dismisses');
  // switchTab still closes without moving focus off the tab just opened.
  assert.match(shell, /if \(!force && id === _activeTab\) \{ closeMobileSidebar\(\); return; \}/);
}

// ── 5. Datasets tab with the preview column hidden ───────────────────────────
{
  const admCss = read('css/admpan.css');
  assert.match(admCss, /@media \(max-width: 860px\) \{\s*\.panel-preview \{ display: none; \}/, 'the breakpoint the tab mirrors');
  const tab = read('js/pages/admin/tab-datasets.js');
  assert.ok(tab.includes(`const PREVIEW_HIDDEN_QUERY = '(max-width: 860px)';`), 'same breakpoint in the tab');
  const select = tab.slice(tab.indexOf('async function selectDataset'), tab.indexOf('function abortSelection'));
  assert.match(select, /if \(isStagingEditable\(meta\)\) mountPreview\(_current\);/, 'a selection goes through the gate');
  assert.ok(!/loadPreview\(/.test(select), 'never straight to the viewer');
  assert.match(tab, /!DOM\.previewFrame\.getAttribute\('src'\)\) mountPreview\(_current\)/, 'nor does an import that becomes editable');
  const mount = tab.slice(tab.indexOf('function mountPreview'), tab.indexOf('function stopPreview'));
  assert.match(mount, /if \(previewHidden\(\)\) \{ stopPreview\(\); return; \}/);
  const stop = tab.slice(tab.indexOf('function stopPreview'), tab.indexOf('function onPreviewVisibilityChange'));
  assert.match(stop, /if \(src && src !== 'about:blank'\) DOM\.previewFrame\.src = 'about:blank';/, 'a running viewer is unloaded');
  const change = tab.slice(tab.indexOf('function onPreviewVisibilityChange'), tab.indexOf('function loadPreview'));
  assert.match(change, /_isCalibratingOrientation = false;/, 'a calibration in flight is cancelled when the frame goes');
  assert.match(change, /else if \(_current && _draft && isStagingEditable\(_draft\)\) \{\s*loadPreview\(_current\);/, 'widening mounts the preview again');
  const gate = tab.slice(tab.indexOf('function applyPreviewGate'), tab.indexOf('function dimsLabel'));
  assert.match(gate, /\[DOM\.btnDefineOrientation, DOM\.btnCaptureView\]\.forEach\(\(b\) => \{ if \(b\) b\.disabled = !editable \|\| blind; \}\)/);
  assert.match(gate, /o\.disabled = blind && o\.value !== 'none'/, '"none" stays selectable: it only clears the stored view');
  assert.ok(!/fSampleSide|orientationAxesList/.test(gate), 'sample side and axis names stay editable');
  const req = tab.slice(tab.indexOf('function requestOrientationView'), tab.indexOf('const win = DOM.previewFrame?.contentWindow;', tab.indexOf('function requestOrientationView')));
  assert.match(req, /if \(previewHidden\(\)\) \{[^}]*admin\.previewNeedsWideScreen/, 'no pose is captured from a frame nobody saw');
  assert.match(tab, /_previewMq\?\.addEventListener\?\.\('change', onPreviewVisibilityChange\)/, 'follows the window across the breakpoint');
  assert.match(tab, /if \(!src \|\| src === 'about:blank'\) return;/, 'the blank page is not shown as a preview');
  assert.match(read('admpan.html'), /id="preview-narrow-hint" style="display:none" data-i18n="admin\.previewNeedsWideScreen"/, 'the hint');
}

console.log('admin modal dialogs · collapsed sidebar names · mobile drawer · hidden preview: OK');
