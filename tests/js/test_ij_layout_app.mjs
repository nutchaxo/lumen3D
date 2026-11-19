// Advanced Studio — the controller (ij-app.js) against the layout / view stand-in of tests/js/ij_harness.mjs: one view per
// open image, placement policies, and the single-display assumptions of PLAN-wave3 §2.4 that were fixed.
//
// Run: node tests/js/test_ij_layout_app.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, until, sleep, J, DIR } from './ij_harness.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (err) { console.error('FAIL ' + name); throw err; }
}

// A package of the test: hands out the extension api so a test can call it with any document.
const STUB = `(function () {
  'use strict';
  globalThis.__layKinds = [];
  IJApp.extend({ pkg: 'bg', commands: [{ id: 'zLayApi', menu: ['Process'], order: 990, run(api) { globalThis.__api = api; } }],
    panels: { layPanel: { titleKey: 'cmd.zLayApi', build() { return { refresh(kind) { globalThis.__layKinds.push(kind); } }; } } } });
})();`;
const pageSources = { 'ij-cmds-bg.js': STUB };

async function twoDocs(t) {
  const sh = await t.open();
  const first = t.activeId();
  await t.runCommand('imageDuplicate');
  await until(() => sh.layout.order().length === 2, 'the duplicate has its tab');
  const second = sh.layout.order().find((d) => d !== first);
  await until(() => sh.layout.active() === second && t.activeId() === second, 'the duplicate is active');
  await t.runCommand('zLayApi');
  return { sh, first, second, api: t.page.__api };
}
const post = (t, m) => t.worker.onmessage({ data: m });

await test('open: the projection gets its own view in a tab; the provider is the view\'s own', async () => {
  const t = await boot({ pageSources });
  const sh = await t.open();
  const id = t.activeId();
  assert.equal(sh.lay.adds[0].placement, 'tab');
  assert.ok(sh.view(id) && typeof sh.view(id).provider === 'function', 'tile provider on the view of the document');
  assert.equal(sh.layout.active(), id);
  assert.ok(sh.lay.tabInfo.get(id) && sh.lay.tabInfo.get(id).name, 'the tab carries the image name');
  t.close();
});

await test('placeholder of a streamed load lives in the new document\'s own view (no docId -1, no second view)', async () => {
  const t = await boot({ pageSources });
  const sh = await t.open();
  const id = t.activeId();
  assert.ok(sh.images.length >= 1);
  assert.ok(sh.images.every((i) => !i || i.docId === id), 'a placeholder (when the source can draw one) carries the id of the document being built');
  assert.equal(sh.lay.adds.length, 1, 'one view for the placeholder and the image that replaces it');
  assert.ok(!sh.images.some((i) => i && i.docId === -1));
  t.close();
});

await test('Duplicate: a tab of its own; both views keep their providers and tiles; switching tabs never refits nor refetches (§2.4 #10)', async () => {
  const t = await boot({ pageSources });
  const { sh, first, second } = await twoDocs(t);
  assert.equal(sh.lay.adds[1].placement, 'tab');
  assert.ok(sh.view(first).provider && sh.view(second).provider && sh.view(first).provider !== sh.view(second).provider);
  const fits = sh.view(first).fits, imgs = sh.view(first).images.length;
  sh.clickTab(first);
  await until(() => t.activeId() === first || sh.layout.active() === first, 'tab clicked');
  await sleep(20);
  assert.equal(sh.view(first).fits, fits, 'no refit');
  assert.equal(sh.view(first).images.length, imgs, 'the image is not set again');
  assert.equal(sh.layout.active(), first);
  t.close();
});

await test('worker preview / invalidate events reach the view of THEIR document, active or not (§2.4 #1 #2)', async () => {
  const t = await boot({ pageSources });
  const { sh, first, second } = await twoDocs(t);
  const p = { event: 'preview', docId: first, seq: 0, level: 0, x0: 0, y0: 0, w: 2, h: 2, bitDepth: 8, channels: { 0: new Uint8Array(4) } };
  post(t, p);
  assert.ok(sh.view(first).preview, 'the preview went to the first view');
  assert.equal(sh.view(second).preview, null, 'the active view is untouched');
  const n2 = sh.view(second).invalidations.length;
  post(t, { event: 'invalidate', docId: first, channels: [0] });
  assert.deepEqual(J(sh.view(first).invalidations.slice(-1)), [[0]], 'the background view drops its tiles');
  assert.equal(sh.view(second).invalidations.length, n2);
  t.close();
});

await test('api.run on a background document invalidates ITS view and does not steal the focus (§2.4 #3)', async () => {
  const t = await boot({ pageSources });
  const { sh, first, second, api } = await twoDocs(t);
  const n1 = sh.view(first).invalidations.length, n2 = sh.view(second).invalidations.length;
  const r = await api.run('invert', {}, { docId: first, noRoi: true });
  assert.ok(r, 'ran');
  assert.ok(sh.view(first).invalidations.length > n1, 'the background view refreshes');
  assert.equal(sh.view(second).invalidations.length, n2, 'the active one is not refreshed');
  assert.equal(sh.layout.active(), second, 'the active tab did not change');
  t.close();
});

await test('previews and overlays are drawn on the view of their document only (§2.4 #4 #5)', async () => {
  const t = await boot({ pageSources });
  const { sh, first, second, api } = await twoDocs(t);
  api.overlay([{ kind: 'points', pts: [1, 2], color: '#f00' }]);
  assert.ok(sh.view(second).overlay, 'overlay on the active view');
  assert.equal(sh.view(first).overlay, null);
  sh.clickTab(first);
  api.overlay([{ kind: 'rect', x: 0, y: 0, w: 2, h: 2, color: '#0f0' }]);
  assert.equal(sh.view(second).overlay, null, 'the previous overlay was cleared');
  assert.ok(sh.view(first).overlay);
  api.clearOverlay();
  assert.equal(sh.view(first).overlay, null);
  // the visible rectangle of the preview comes from the document's own view
  sh.view(first).viewState = { zoom: 2, ox: -4, oy: -4 };
  const r = await api.preview('invert', {}, { docId: first });
  assert.equal(r.ok, true);
  t.close();
});

await test('the threshold overlay follows the active document and is cleared on the others (§2.4 #6)', async () => {
  const t = await boot({ pageSources });
  const { sh, first, second, api } = await twoDocs(t);
  await api.openTool('threshold');
  await until(() => sh.view(second).thr, 'overlay on the active doc');
  assert.equal(sh.view(first).thr, null);
  sh.clickTab(first);
  await until(() => sh.view(first).thr && sh.view(second).thr === null, 'the overlay moved with the window');
  t.close();
});

await test('zoom commands act on the active view (§2.4 #7)', async () => {
  const t = await boot({ pageSources });
  const { sh, first, second } = await twoDocs(t);
  const fits = (d) => sh.view(d).fits;
  const f1 = fits(first), f2 = fits(second);
  await t.runCommand('zoomFit');
  assert.equal(fits(second), f2 + 1); assert.equal(fits(first), f1);
  t.close();
});

await test('Window › Next follows the layout order; closing falls back to the layout neighbour (§2.4 #14)', async () => {
  const t = await boot({ pageSources });
  const { sh, first, second } = await twoDocs(t);
  const winCmds = () => sh.opts.commands.filter((c) => /^winImg/.test(c.id)).map((c) => c.id);
  assert.deepEqual(J(winCmds()), sh.layout.order().map((d) => 'winImg' + d), 'the Window menu lists the images in visual order');
  await t.runCommand('windowNext');
  await until(() => sh.layout.active() === first, 'Next went to the other tab');
  await sh.clickClose(first);
  await until(() => sh.lay.removed.includes(first), 'closed');
  await until(() => sh.layout.active() === second && t.activeId() === second, 'the neighbour took over');
  assert.equal(sh.layout.order().length, 1);
  t.close();
});

await test('closing the last image shows the empty state in the workspace, not inside a stage (§2.4 #8)', async () => {
  const t = await boot({ pageSources });
  const sh = await t.open();
  await sh.clickClose(t.activeId());
  await until(() => sh.workspace.children.some((c) => /ij-empty/.test(c.className)), 'the empty state is attached to the workspace');
  t.close();
});

await test('a worker that dies clears the layout (§2.4 #9)', async () => {
  const t = await boot({ pageSources });
  const sh = await t.open();
  const before = sh.lay.cleared;
  post(t, { event: 'initError', code: 'X' });
  await until(() => sh.lay.cleared > before, 'layout cleared by the crash recovery');
  assert.equal(sh.layout.order().length, 0);
  t.close();
});

await test('the layout goes into the session meta, and the worker tile cache follows the visible views (§2.4 #19 #22)', async () => {
  const t = await boot({ pageSources });
  const { sh, first, second } = await twoDocs(t);
  await until(() => t.log.msgs.some((m) => m.cmd === 'session.putMeta' && m.args && m.args.layout && m.args.layout.order && m.args.layout.order.length === 2), 'putMeta carries the layout', 3000);
  const cfg = t.log.msgs.filter((m) => m.cmd === 'engine.configure');
  assert.ok(cfg.length >= 1 && cfg.every((m) => Number.isFinite(m.args.tileCacheBytes) && m.args.tileCacheBytes >= 64 * 1024 * 1024), 'engine.configure { tileCacheBytes } sent');
  t.close();
});

await test('restoring a session: every document gets a view, the stored layout is applied on an empty workspace, tool windows reopen (§2.4 #18 #21)', async () => {
  const t = await boot({ pageSources });
  await t.open();
  await t.flush();
  const t2 = await boot({ pageSources, storage: t.store.shared });
  const META = { layout: { v: 1, order: [], marker: 'stored' }, windows: ['results', 'table-9'], results: [], rois: [] };
  const OrigW = t2.page.Worker;
  const restoreIds = new Set();
  t2.log.intercept = (m) => { if (m.cmd === 'session.restore') restoreIds.add(m.id); return undefined; };
  t2.page.Worker = class extends OrigW {
    constructor(u) {
      super(u);
      const orig = this.far.postMessage.bind(this.far);
      this.far.postMessage = (m) => { if (m && restoreIds.has(m.id) && m.ok && m.result) { m.result.meta = META; restoreIds.delete(m.id); } return orig(m); };
    }
  };
  const sh = await t2.open().catch(() => null) || await until(() => t2.shell, 'second shell');
  await until(() => sh.lay.restored.length === 1, 'the stored layout was applied', 6000);
  assert.equal(sh.lay.restored[0].json.marker, 'stored');
  assert.ok(sh.lay.restored[0].ids.length >= 1, 'with the ids of the restored documents');
  await until(() => sh.windows.floats.has('results'), 'the Results window of the session reopened');
  assert.ok(!sh.windows.floats.has('table-9'), 'only known tool windows reopen');
  t2.close();
});

await test('readPixel routes to the document it is given, not the active one (§2.4 #15)', async () => {
  const t = await boot({ pageSources });
  const { sh, first, second } = await twoDocs(t);
  const pixelDocs = () => t.log.msgs.filter((m) => m.cmd === 'doc.pixel').map((m) => m.args.docId);
  const n0 = pixelDocs().length;
  await sh.opts.readPixel(1, 1, first);
  await sh.opts.readPixel(2, 2);
  assert.deepEqual(J(pixelDocs().slice(n0)), J([first, second]), 'an explicit doc, then the active one');
  t.close();
});

await test('tool windows follow the active document: an activation schedules a refresh of kind doc (§2.4 #16)', async () => {
  const t = await boot({ pageSources });
  const { sh, first, second, api } = await twoDocs(t);
  assert.equal(await api.openPanel('layPanel'), true);
  await sleep(120);
  t.page.__layKinds.length = 0;
  sh.clickTab(first);
  await until(() => t.page.__layKinds.includes('doc'), 'the panel was told the document changed');
  t.page.__layKinds.length = 0;
  sh.clickTab(second);
  await until(() => t.page.__layKinds.includes('doc'), 'and again for the other one');
  t.close();
});

await test('a pixel edit of a background document keeps the other tab active and does not refresh the tool windows for it (§2.4 #3 #16)', async () => {
  const t = await boot({ pageSources });
  const { sh, first, second, api } = await twoDocs(t);
  assert.equal(await api.openPanel('layPanel'), true);
  await sleep(120);
  t.page.__layKinds.length = 0;
  await api.run('invert', { channel: 0 }, { docId: first }).catch(() => {});
  await sleep(150);
  assert.equal(sh.layout.active(), second, 'the focus stays');
  assert.ok(!t.page.__layKinds.includes('pixels'), 'the open windows describe the active document, which did not change');
  t.close();
});

await test('no use of "the display" is left in the controller; the layout owns the views (§2.4 #20)', async () => {
  const src = fs.readFileSync(path.join(DIR, 'ij-app.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/S\.display\b|S\.host\b|shell\.stage\b|shell\.display\b/.test(src));
  const lay = fs.readFileSync(path.join(DIR, 'ij-layout.js'), 'utf8');
  assert.ok(/const Z = \{ image: \[10, 29\], tool: \[30, 49\], menu: 60, dialog: 80 \}/.test(lay), 'z-order bands');
  const view = fs.readFileSync(path.join(DIR, 'ij-view.js'), 'utf8');
  assert.ok(!/\+\+zTop/.test(view), 'no unbounded z counter');
  assert.ok(/String\(30 \+ Math\.min\(i, 19\)\)/.test(view), 'tool windows stay in 30..49');
});

console.log(`ij layout app: ${passed} groups ok`);
process.exit(0);
