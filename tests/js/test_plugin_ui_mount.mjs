// Unit tests for the plugin-mounted UI helpers of js/core/utils.js — the one
// implementation behind `ctx.ui.addSidebarSection` / `ctx.ui.addCanvasPanel` of the
// volume viewer (viewer.js) and the photograph page (2d.js), plus the dataset base
// URL both pages build every fetch on.
//   • a section is sanitised, prefixed and replaced when added again under its id;
//   • the handle carries `section` as an alias of `root` on both pages;
//   • a section never takes (nor removes) an id held by a node of the page;
//   • the 2d form: optional id, no prefix, its own body class;
//   • canvas panels: id required, sanitised, replaced;
//   • datasetBaseUrl: DATA_WEB/<path>, or the admin blob proxy for `staging:`.
//
// Run: node tests/js/test_plugin_ui_mount.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadModule, ROOT } from './harness.mjs';

// ── A minimal DOM: what the helpers touch, nothing more ──────────────────────
class ClassList {
  constructor(el) { this.el = el; }
  _set() { return new Set(String(this.el.className || '').split(/\s+/).filter(Boolean)); }
  contains(c) { return this._set().has(c); }
  add(c) { const s = this._set(); s.add(c); this.el.className = [...s].join(' '); }
  remove(c) { const s = this._set(); s.delete(c); this.el.className = [...s].join(' '); }
  toggle(c, force) {
    const on = force === undefined ? !this.contains(c) : Boolean(force);
    if (on) this.add(c); else this.remove(c);
    return on;
  }
}

function makeDocument() {
  const doc = {
    body: null,
    createElement(tag) {
      const el = {
        tagName: String(tag).toUpperCase(), id: '', className: '', hidden: false, innerHTML: '', textContent: '',
        style: { cssText: '' }, children: [], parentNode: null, ownerDocument: doc,
        appendChild(child) {
          child.parentNode?.children.splice(child.parentNode.children.indexOf(child), 1);
          child.parentNode = el; el.children.push(child); return child;
        },
        remove() {
          if (!el.parentNode) return;
          el.parentNode.children.splice(el.parentNode.children.indexOf(el), 1);
          el.parentNode = null;
        },
      };
      el.classList = new ClassList(el);
      return el;
    },
    getElementById(id) {
      const walk = (node) => {
        if (node.id === id) return node;
        for (const c of node.children) { const hit = walk(c); if (hit) return hit; }
        return null;
      };
      return id ? walk(doc.body) : null;
    },
  };
  doc.body = doc.createElement('body');
  return doc;
}

const document = makeDocument();
const iconCalls = [];
const Utils = loadModule('js/core/utils.js', 'Utils', {
  document,
  window: { lucide: { createIcons: (opts) => iconCalls.push(opts) }, location: { origin: 'http://x' } },
  navigator: { language: 'en' },
});
const sidebar = document.createElement('aside');
sidebar.id = 'viewer-sidebar';
document.body.appendChild(sidebar);

// ── Viewer form: id required, sanitised, prefixed, replaced ──────────────────
{
  assert.equal(Utils.mountPluginSection(sidebar, { title: 'x' }), null, 'the viewer form refuses a section without an id');
  assert.equal(Utils.mountPluginSection(null, { id: 'a' }), null, 'no container, no section');
  assert.equal(Utils.mountPluginSection(sidebar, { id: '<>!' }), null, 'an id with nothing left after sanitising is refused');
  let bound = null;
  const h = Utils.mountPluginSection(sidebar, { id: 'trails"<x>', title: 'Trails', html: '<b>hi</b>', bind: (body, handle) => { bound = { body, handle }; } });
  assert.ok(h, 'a section is mounted');
  assert.equal(h.root.id, 'plugin-section-trailsx', 'the id is sanitised and prefixed');
  assert.equal(h.section, h.root, '`section` is an alias of `root` on the viewer too');
  assert.equal(h.root.className, 'panel-section plugin-section');
  assert.equal(h.body.className, 'plugin-section-body');
  assert.equal(h.body.innerHTML, '<b>hi</b>');
  assert.equal(h.root.children[0].children[0].textContent, 'Trails');
  assert.equal(bound.body, h.body, 'bind receives the body');
  assert.equal(bound.handle, h, '… and the handle');
  assert.equal(sidebar.children.length, 1);
  assert.ok(iconCalls.some((c) => c.nodes[0] === h.root), 'icons are drawn in the new section');

  h.setTitle(null);
  assert.equal(h.root.children[0].children[0].textContent, '', 'a null title reads as empty, not "null"');
  h.setHtml(undefined);
  assert.equal(h.body.innerHTML, '', 'setHtml(undefined) empties the body instead of printing "undefined"');
  h.hide(); assert.equal(h.root.hidden, true);
  h.show(); assert.equal(h.root.hidden, false);

  const again = Utils.mountPluginSection(sidebar, { id: 'trails"<x>', title: 'Again', hidden: true });
  assert.equal(sidebar.children.length, 1, 'adding the section again replaces it (a re-activated plugin)');
  assert.equal(sidebar.children[0], again.root);
  assert.equal(again.root.hidden, true, 'hidden is honoured');
  again.remove();
  assert.equal(sidebar.children.length, 0, 'remove() takes the node away');
}

// ── 2d form: optional id, no prefix, page body class; never steals a page id ──
{
  const opts = { idPrefix: '', requireId: false, bodyClass: 'p2d-plugin-body' };
  const anon = Utils.mountPluginSection(sidebar, { title: 'No id' }, opts);
  assert.ok(anon, 'the 2d form accepts a section without an id');
  assert.equal(anon.root.id, '', '… and gives it none');
  assert.equal(anon.body.className, 'p2d-plugin-body');

  const a = Utils.mountPluginSection(sidebar, { id: 'display-adjust-section', title: 'A' }, opts);
  assert.equal(a.root.id, 'display-adjust-section', 'the id stays as the plugin gave it');
  const { section, body } = a;
  assert.equal(section, a.root, 'the 2d plugins destructure `section`');
  assert.equal(body, a.body);
  const before = sidebar.children.length;
  const b = Utils.mountPluginSection(sidebar, { id: 'display-adjust-section', title: 'B' }, opts);
  assert.equal(sidebar.children.length, before, 'adding it twice replaces it: no duplicate node, no duplicate id');
  assert.equal(document.getElementById('display-adjust-section'), b.root);

  // A node of the page holding the id is neither removed nor shadowed by a duplicate.
  const pageNode = document.createElement('div');
  pageNode.id = 'measure-section';
  pageNode.className = 'panel-section';
  sidebar.appendChild(pageNode);
  const c = Utils.mountPluginSection(sidebar, { id: 'measure-section', title: 'C' }, opts);
  assert.ok(c, 'the section still mounts');
  assert.equal(pageNode.parentNode, sidebar, "the page's own node is kept");
  assert.equal(c.root.id, '', 'and the plugin section goes without the taken id');
  assert.equal(document.getElementById('measure-section'), pageNode);
  [anon, b, c].forEach((h) => h.remove());
  pageNode.remove();
}

// ── Canvas panels ────────────────────────────────────────────────────────────
{
  const stage = document.createElement('div');
  document.body.appendChild(stage);
  assert.equal(Utils.mountPluginPanel(stage, {}), null, 'a panel needs an id');
  assert.equal(Utils.mountPluginPanel(null, { id: 'p' }), null, 'and a container');
  let bound = null;
  const p = Utils.mountPluginPanel(stage, { id: 'charts/1', className: 'wide', style: 'top:4px', html: '<i></i>', bind: (root, h) => { bound = { root, h }; } });
  assert.equal(p.root.id, 'plugin-panel-charts1', 'sanitised and prefixed');
  assert.equal(p.root.className, 'scientific-panel wide');
  assert.equal(p.root.style.cssText, 'top:4px');
  assert.equal(bound.root, p.root);
  assert.equal(p.isVisible(), false);
  p.show(); assert.equal(p.isVisible(), true);
  assert.equal(p.toggle(), false, 'toggle flips');
  assert.equal(p.toggle(true), true, 'toggle(force)');
  p.hide(); assert.equal(p.isVisible(), false);
  const q = Utils.mountPluginPanel(stage, { id: 'charts/1' });
  assert.equal(stage.children.length, 1, 'a panel added again replaces the earlier one');
  assert.equal(q.root.className, 'scientific-panel');
  q.remove();
  assert.equal(stage.children.length, 0);
}

// ── datasetBaseUrl ───────────────────────────────────────────────────────────
assert.equal(Utils.datasetBaseUrl('3d/E85-Em1'), 'DATA_WEB/3d/E85-Em1');
assert.equal(Utils.datasetBaseUrl('staging:live/A B'), 'api/upload.php?action=blob&ds=live%2FA%20B&path=', 'a staged import goes through the blob proxy');
assert.equal(Utils.datasetBaseUrl(null), 'DATA_WEB/');

// ── The pages use them (no copy left behind) ─────────────────────────────────
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r/g, '');
const viewer = read('js/pages/viewer.js');
const page2d = read('js/pages/2d.js');
for (const [name, src] of [['viewer.js', viewer], ['2d.js', page2d]]) {
  assert.ok(src.includes('Utils.mountPluginSection('), `${name} mounts plugin sections through Utils`);
  assert.ok(src.includes('Utils.mountPluginPanel('), `${name} mounts canvas panels through Utils`);
  assert.ok(src.includes('Utils.datasetBaseUrl('), `${name} builds dataset URLs through Utils`);
  assert.ok(!src.includes("document.createElement('div');\n    root.className = `scientific-panel"), `${name} keeps no copy of the panel builder`);
  assert.ok(!src.includes('api/upload.php?action=blob&ds='), `${name} keeps no copy of the proxy URL`);
}

console.log('plugin UI mount helpers (sections, panels, dataset base URL): OK');
