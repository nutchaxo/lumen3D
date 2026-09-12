// DatasetGallery — the operator-attached images moved out of the sidebar into a
// floating dock in the bottom-right corner of the canvas (web v1.53.2). What is
// locked here is the contract the UI depends on:
//   · the dock is mounted INSIDE the canvas area, never in the sidebar
//   · hide → a single puce carrying the image count; the puce reopens to the
//     size the dock had (open OR large), not always to the compact one
//   · the state survives a dataset switch and a reload (localStorage), and a
//     browser that refuses storage loses the preference, never the gallery
//   · a thumbnail opens the lightbox in every state
//   · a dataset with no image shows no dock at all
//
// Run: node tests/js/test_gallery_dock.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

// ── Minimal DOM ───────────────────────────────────────────────
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parent: null,
    attrs: {},
    dataset: {},
    style: {},
    handlers: {},
    className: '',
    id: '',
    title: '',
    hidden: false,
    get childElementCount() { return el.children.length; },
    get isConnected() {
      let n = el;
      while (n.parent) n = n.parent;
      return n.__root === true;
    },
    get textContent() { return el._text || ''; },
    set textContent(v) { el._text = String(v); el.children = []; },
    appendChild(child) { child.parent = el; el.children.push(child); return child; },
    append(...nodes) { nodes.forEach((n) => el.appendChild(n)); },
    remove() {
      if (!el.parent) return;
      el.parent.children = el.parent.children.filter((c) => c !== el);
      el.parent = null;
    },
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; },
    removeAttribute(k) { delete el.attrs[k]; },
    addEventListener(type, fn) { (el.handlers[type] = el.handlers[type] || []).push(fn); },
    removeEventListener(type, fn) {
      el.handlers[type] = (el.handlers[type] || []).filter((f) => f !== fn);
    },
    focus() { doc.activeElement = el; },
    querySelectorAll(sel) {
      const cls = sel.replace('.', '');
      return el.children.filter((c) => String(c.className).split(' ').includes(cls));
    },
    fire(type, ev = {}) { (el.handlers[type] || []).forEach((fn) => fn(ev)); },
  };
  return el;
}

const mount = makeEl('div');
mount.className = 'viewer-canvas-container';
mount.__root = true;
const body = makeEl('body');
body.__root = true;
body.classList = {
  set: new Set(),
  add(c) { body.classList.set.add(c); },
  remove(c) { body.classList.set.delete(c); },
  contains(c) { return body.classList.set.has(c); },
};
const doc = {
  body,
  activeElement: body,
  createElement: makeEl,
  querySelector: (sel) => (sel === '.viewer-canvas-container' ? mount : null),
  addEventListener() {},
  removeEventListener() {},
};

const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};

const sandbox = () => ({
  document: doc,
  localStorage,
  window: {},        // no lucide: the dock must build without the icon library
  I18n: { t: (k) => k },
});

const ITEMS = [
  { file: 'coupe sagittale.png', title: 'Coupe' },
  { file: 'schema.webp', caption: 'Schéma' },
];

const find = (root, cls) => {
  const out = [];
  (function walk(n) {
    if (String(n.className).split(' ').includes(cls)) out.push(n);
    n.children.forEach(walk);
  })(root);
  return out;
};
const dockOf = () => mount.children.find((c) => c.id === 'gallery-dock');

function fresh() {
  mount.children = [];
  body.children = [];
  body.classList.set.clear();
  store.clear();
  return loadModule('js/components/dataset-gallery.js', 'DatasetGallery', sandbox());
}

// ── 1. The dock mounts in the canvas area, not in the sidebar ──
{
  const G = fresh();
  G.init({ basePath: 'DATA_WEB/3d/em1/', items: ITEMS });
  const dock = dockOf();
  assert.ok(dock, 'the dock is appended to .viewer-canvas-container');
  assert.equal(dock.hidden, false, 'a dataset with images shows the dock');
  assert.equal(dock.dataset.state, 'open', 'default state is the compact grid');

  const thumbs = find(dock, 'gallery-thumb');
  assert.equal(thumbs.length, 2, 'one tile per image');
  assert.equal(
    thumbs[0].children[0].src,
    'DATA_WEB/3d/em1/gallery/coupe%20sagittale.png',
    'the file name is percent-encoded into the URL (trailing slash of basePath dropped)'
  );
  assert.equal(find(dock, 'gallery-dock-count')[0].textContent, '2', 'header counts the images');
  assert.equal(find(dock, 'gallery-dock-chip-count')[0].textContent, '2', 'the puce carries the count too');
}

// ── 2. Hide → puce, puce → back to the size it had ──
{
  const G = fresh();
  G.init({ basePath: 'DATA_WEB/3d/em1', items: ITEMS });
  const dock = dockOf();
  const btnHide = find(dock, 'gallery-dock-hide')[0];
  const btnSize = find(dock, 'gallery-dock-size')[0];
  const chip = find(dock, 'gallery-dock-chip')[0];

  btnSize.fire('click');
  assert.equal(dock.dataset.state, 'large', 'the size button enlarges the dock');
  assert.equal(btnSize.getAttribute('data-i18n-title'), 'viewer.galleryReduce',
    'enlarged, the same button offers to reduce (and keeps its i18n key for the language switcher)');

  btnHide.fire('click');
  assert.equal(dock.dataset.state, 'chip', 'hide collapses to the puce');
  assert.equal(dock.hidden, false, 'the puce stays on screen — hiding is not removing');
  assert.equal(doc.activeElement, chip, 'focus follows the control that replaced the hidden one');

  chip.fire('click');
  assert.equal(dock.dataset.state, 'large', 'the puce reopens to the size the dock had, not the compact one');
  assert.equal(doc.activeElement, btnHide, 'focus returns to the hide button');
}

// ── 3. The state survives a dataset switch and a reload ──
{
  const G = fresh();
  G.init({ basePath: 'DATA_WEB/3d/em1', items: ITEMS });
  find(dockOf(), 'gallery-dock-hide')[0].fire('click');
  assert.equal(store.get('iribhm-gallery-dock'), 'chip', 'the state is persisted');

  G.init({ basePath: 'DATA_WEB/3d/em2', items: [ITEMS[0]] });   // dataset switch, same page
  assert.equal(dockOf().dataset.state, 'chip', 'a new dataset keeps the choice the operator made');
  assert.equal(find(dockOf(), 'gallery-dock-chip-count')[0].textContent, '1', 'the count follows the dataset');

  mount.children = [];                                          // reload: fresh module, same storage
  const G2 = loadModule('js/components/dataset-gallery.js', 'DatasetGallery', sandbox());
  G2.init({ basePath: 'DATA_WEB/3d/em2', items: ITEMS });
  assert.equal(dockOf().dataset.state, 'chip', 'the choice is restored on the next page load');
  assert.equal(G2.state(), 'chip', 'state() reports it');
}

// ── 4. Storage refused (private mode) loses the preference, not the gallery ──
{
  mount.children = [];
  body.children = [];
  const hostile = {
    ...sandbox(),
    localStorage: {
      getItem() { throw new Error('SecurityError'); },
      setItem() { throw new Error('SecurityError'); },
    },
  };
  const G = loadModule('js/components/dataset-gallery.js', 'DatasetGallery', hostile);
  assert.doesNotThrow(() => G.init({ basePath: 'b', items: ITEMS }), 'init survives a hostile storage');
  const dock = dockOf();
  assert.equal(dock.dataset.state, 'open', 'falls back to the compact grid');
  assert.doesNotThrow(() => find(dock, 'gallery-dock-hide')[0].fire('click'), 'collapsing survives it too');
  assert.equal(dock.dataset.state, 'chip', 'and still works');
}

// ── 5. A thumbnail opens the lightbox — in every dock state ──
{
  const G = fresh();
  G.init({ basePath: 'DATA_WEB/2d/wm1', items: ITEMS });
  const dock = dockOf();
  find(dock, 'gallery-dock-size')[0].fire('click');             // enlarged
  find(dock, 'gallery-thumb')[1].fire('click');
  const lb = body.children.find((c) => c.className === 'gallery-lightbox');
  assert.ok(lb && lb.hidden === false, 'the lightbox opens from a thumbnail');
  assert.ok(body.classList.contains('gallery-lightbox-open'), 'the page is locked behind it');
  assert.equal(find(lb, 'gallery-lb-img')[0].src, 'DATA_WEB/2d/wm1/gallery/schema.webp', 'it shows the clicked image');
  G.step(1);
  assert.equal(find(lb, 'gallery-lb-img')[0].src, 'DATA_WEB/2d/wm1/gallery/coupe%20sagittale.png', 'it wraps around the set');
  G.close();
  assert.equal(lb.hidden, true, 'and closes');
  assert.equal(body.classList.contains('gallery-lightbox-open'), false, 'releasing the page');
}

// ── 6. No image → no dock at all (Rule 1.3: the canvas owns the screen) ──
{
  const G = fresh();
  G.init({ basePath: 'DATA_WEB/3d/em3', items: [] });
  assert.equal(dockOf().hidden, true, 'a dataset with no attached image shows nothing');
  assert.equal(G.count(), 0, 'count() reports it');

  G.setItems(ITEMS);
  assert.equal(dockOf().hidden, false, 'attaching images reveals the same dock');

  // Every file vanished from the folder behind the viewer's back.
  find(dockOf(), 'gallery-thumb').forEach((t) => t.children[0].fire('error'));
  assert.equal(dockOf().hidden, true, 'a dock whose every tile failed to load hides itself');
}

console.log('gallery dock (mount, states, persistence, lightbox, empty dataset): OK');
