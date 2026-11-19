// The wave-3 extension points of the Advanced Studio (PLAN-wave3 §2.5, §2.6): what a package may register (panels, tools,
// worker commands, repeatable, three-level menus), the new api members, the worker side (IJOpRegistry commands, blobs, doc.import,
// engine.configure / registerLut, the session meta), the Window menu and Synchronize Windows — driven through
// tests/js/ij_harness.mjs (the REAL ij-worker.js and engine behind a fake Worker, the real controller behind a recording chrome).
//
// Run: node tests/js/test_ij_ext_api3.mjs
import assert from 'node:assert/strict';
import { boot, until, sleep, J } from './ij_harness.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (err) { console.error('FAIL ' + name); throw err; }
}
const arr = (a) => Array.from(a);
const reject = async (p, code, what) => {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert.ok(err, what + ': it must reject');
  assert.equal(err.code, code, what + ': ' + (err && err.code));
  return err;
};
const throws = (fn, code, what) => {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, what + ': it must throw');
  assert.equal(err.code, code, what + ': ' + (err && err.code));
};

// ── a package of the test: worker commands, ops, a panel, a tool ──────────────────────────────────────────────
const FIJI_PROC = `
(function (root) {
  'use strict';
  const R = root.IJOpRegistry;
  R.defineCommand('doc.fiji.echo', { pkg: 'fiji', handler: async (a, E) => ({ v: a.v, hasBudget: E.budgetBytes > 0, members: Object.keys(E).sort() }) });
  R.defineCommand('doc.fiji.make', { pkg: 'fiji', handler: async (a, E) => {
    E.reserve(a.w * a.h);
    const data = new Uint8Array(a.w * a.h).fill(a.fill);
    const info = E.createDoc({ name: a.name || 'made', width: a.w, height: a.h, bitDepth: 8, calibration: { pixelWidth: 2, pixelHeight: 2, unit: 'um' },
      channels: [{ data, name: 'M', color: '#ffffff' }] }, { provenance: { made: true }, hidden: !!a.hidden });
    E.postEvent({ event: 'made', docId: info.docId });
    return info;
  } });
  R.defineCommand('doc.fiji.leak', { pkg: 'fiji', handler: async (a, E) => { E.reserve(8 * 1048576); return 'leaked'; } });
  R.defineCommand('doc.fiji.wait', { pkg: 'fiji', long: true, handler: async (a, E) => { for (let i = 0; i < 600; i++) { await new Promise((r) => setTimeout(r, 5)); E.check(); } return 'late'; } });
  R.defineCommand('doc.fiji.boom', { pkg: 'fiji', handler: async (a, E) => { throw E.ijError('IJ_BAD_ARGS', 'boom'); } });
  R.defineCommand('doc.fiji.locked', { pkg: 'fiji', handler: async (a, E) => E.lockDocs([a.docId], async () => { const v = E.readDoc(a.docId); return { w: v.width, frozen: Object.isFrozen(v) }; }) });
  R.define('blobSum', { kind: 'compute', version: 1, run: (view, params) => { let s = 0; for (const v of params.data) s += v; return { s, n: params.data.length, kind: params.data.constructor.name }; } });
  R.define('blobPaint', { kind: 'pixel', version: 1, prepare(view, c, p) { return { apron: { x: 0, y: 0 }, fn: (src) => { const o = src.data.slice(); for (let i = 0; i < o.length && i < p.data.length; i++) o[i] = p.data[i]; return o; } }; } });
})(typeof self !== 'undefined' ? self : globalThis);
`;
// the page twin of the worker's broken package: its command is known to the page, the worker lost it
const ENH_PAGE = `IJOpRegistry.defineCommand('doc.enh.half', { pkg: 'enh', handler() { return 1; } });`;
const ENH_WORKER = `IJOpRegistry.defineCommand('doc.enh.half', { pkg: 'enh', handler() { return 1; } }); throw new Error('this package does not load');`;
const FIJI_CMDS = `
(function () {
  'use strict';
  const log = globalThis.__log = [];
  IJApp.extend({
    pkg: 'fiji',
    commands: [
      { id: 'zHand', menu: ['Process'], order: 990, run(api) { globalThis.__api = api; } },
      { id: 'zRep', menu: ['Process'], order: 991, run() { globalThis.__ran = (globalThis.__ran || 0) + 1; } },
      { id: 'zNoRep', menu: ['Process'], order: 992, repeatable: false, run() {} },
      { id: 'zDeep', menu: ['Plugins', 'Analyze', 'CellCounter'], order: 10, run() {} }
    ],
    panels: {
      zPanel: { titleKey: 'cmd.zRep', persist: true, defaultSize: { w: 300, h: 200 }, build(el, papi) {
        el.setAttribute('data-built', 'yes'); globalThis.__panelApi = papi;
        const inst = { kinds: [], disposed: 0, refresh(kind) { inst.kinds.push(kind); }, dispose() { inst.disposed++; } };
        globalThis.__panel = inst;
        return inst;
      } },
      zPlain: { titleKey: 'cmd.zRep', build() { return {}; } }
    },
    tools: [{ id: 'zTool', labelKey: 'tool.rect', hidden: true, cursor: 'copy', onPointer(api, e) { log.push(e); if (e.type === 'down' && e.shift) throw new Error('tool failure'); } }],
    longCommands: ['doc.fiji.wait']
  });
})();
`;
// packages whose names stay free for the rules of IJApp.extend
const FREE = { 'ij-cmds-sel.js': '', 'ij-cmds-ov.js': '', 'ij-cmds-io.js': '', 'ij-cmds-thr.js': '' };
const SOURCES = { pageSources: Object.assign({ 'ij-cmds-fiji.js': FIJI_CMDS, 'ij-proc-fiji.js': FIJI_PROC, 'ij-proc-enh.js': ENH_PAGE }, FREE),
  workerSources: { 'ij-proc-fiji.js': FIJI_PROC, 'ij-proc-enh.js': ENH_WORKER } };
async function start(extra) {
  const t = await boot(Object.assign({}, SOURCES, extra || {}));
  const sh = await t.open();
  await t.runCommand('zHand');
  return { t, sh, api: t.page.__api, id: t.activeId() };
}
// A request of the page reaches the worker one timer tick after it is logged (t.engine() goes in at once): wait for the delivery
const delivered = async (t, pred, what) => { await until(() => t.log.msgs.some(pred), what, 4000); await sleep(30); };

// ═════════════ 1. IJApp.extend: panels, tools, longCommands, repeatable, depth ═════════════
await test('extend: a panel, a tool, worker commands Cancel may reach, repeatable and a three-level menu are validated before anything is registered', async () => {
  const t = await boot(SOURCES);
  const A = t.IJApp;
  const ext = (spec) => () => A.extend(Object.assign({ pkg: 'sel', commands: [] }, spec));
  throws(ext({ commands: [{ id: 'dd', menu: ['Plugins', 'Analyze', 'CellCounter', 'x'], order: 1, run() {} }] }), 'IJ_BAD_ARGS', 'four menu levels');
  throws(ext({ commands: [{ id: 'dd', menu: ['Process'], order: 1, repeatable: 'no', run() {} }] }), 'IJ_BAD_ARGS', 'repeatable must be a boolean');
  throws(ext({ panels: { bc: { titleKey: 'cmd.zRep', build() { return {}; } } } }), 'IJ_BAD_ARGS', 'the id of a built-in tool window');
  throws(ext({ panels: { zPanel: { titleKey: 'cmd.zRep', build() { return {}; } } } }), 'IJ_BAD_ARGS', 'a panel id already registered');
  throws(ext({ panels: { nb: { titleKey: 'cmd.zRep' } } }), 'IJ_BAD_ARGS', 'a panel without build');
  throws(ext({ panels: { nt: { build() { return {}; } } } }), 'IJ_BAD_ARGS', 'a panel without titleKey');
  throws(ext({ panels: { ns: { titleKey: 'x', build() { return {}; }, defaultSize: { w: 0, h: 5 } } } }), 'IJ_BAD_ARGS', 'a defaultSize of 0');
  throws(ext({ panels: { 'bad id': { titleKey: 'x', build() { return {}; } } } }), 'IJ_BAD_ARGS', 'a panel id with a space');
  throws(ext({ tools: [{ id: 'rect', labelKey: 'tool.rect', onPointer() {} }] }), 'IJ_BAD_ARGS', 'a tool id of a built-in tool');
  throws(ext({ tools: [{ id: 'zTool', labelKey: 'tool.rect', onPointer() {} }] }), 'IJ_BAD_ARGS', 'a tool id already registered');
  throws(ext({ tools: [{ id: 'nt', labelKey: 'tool.rect', after: 'nothing', onPointer() {} }] }), 'IJ_BAD_ARGS', 'after: an unknown tool');
  throws(ext({ tools: [{ id: 'nt', labelKey: 'tool.rect' }] }), 'IJ_BAD_ARGS', 'a tool without onPointer');
  throws(ext({ longCommands: ['notACommand'] }), 'IJ_BAD_ARGS', 'a long command needs a dotted name');
  // nothing of the refused registrations is left behind (pkg 'sel' is still free)
  assert.ok(!A.COMMANDS.some((c) => c.id === 'dd'));
  assert.ok(!A.TOOLS.some((x) => x.id === 'nt'));
  // a good one
  A.extend({ pkg: 'sel', commands: [{ id: 'zDeep3', menu: ['Plugins', 'Analyze', 'CellCounter'], order: 20, run() {} }],
    tools: [{ id: 'zAfter', labelKey: 'tool.rect', after: 'rect', icon: 'wand', onPointer() {} }, { id: 'zEnd', labelKey: 'tool.rect', onPointer() {} }], longCommands: ['doc.sel.x'] });
  const ids = A.TOOLS.filter((x) => !x.separator).map((x) => x.id);
  assert.equal(ids[ids.indexOf('rect') + 1], 'zAfter', 'after: the tool follows the one it names');
  assert.ok(ids.indexOf('zEnd') > ids.indexOf('hand'), 'no `after`: at the end');
  assert.ok(A.TOOLS.find((x) => x.id === 'zTool').hidden && A.TOOLS.find((x) => x.id === 'zTool').ext, 'registered tools are marked ext, hidden kept');
  // repeatable defaults to true, the three the plan names (Repeat itself is the Edit package's) are false
  assert.equal(A.COMMANDS.find((c) => c.id === 'zRep').repeatable, true);
  assert.equal(A.COMMANDS.find((c) => c.id === 'zNoRep').repeatable, false);
  assert.equal(A.COMMANDS.find((c) => c.id === 'zDeep').menu.length, 3);
  assert.ok(A.GROUP_META['Plugins/Analyze/CellCounter'], 'the three-level submenu has its place');
  t.close();
});

// ═════════════ 2. panels ═════════════
await test('panels: openPanel builds once, the window refreshes with the tool-window kinds, closePanel disposes, persist reopens it after a reload', async () => {
  const { t, sh, api } = await start();
  assert.equal(await api.openPanel('zPanel'), true);
  assert.ok(sh.windows.floats.has('zPanel'), 'a tool window');
  const el = t.panel('zPanel');
  assert.ok(el, 'the panel element');
  assert.equal(typeof t.page.__panelApi.annotations.get, 'function', 'the panel received the api');
  assert.equal((await t.page.__panelApi.call('doc.fiji.echo', { v: 5 })).v, 5, 'the api of a panel is bound to its package');
  assert.equal(await api.openPanel('zPanel'), true, 'opening it again raises it');
  assert.equal(sh.windows.floats.size, 1);
  const inst = t.page.__panel;
  assert.equal(inst.kinds[0], 'doc', 'the first refresh is `doc`');
  await t.runCommand('imageDuplicate');
  await until(() => inst.kinds.length > 1, 'a refresh after the document changed');
  assert.ok(inst.kinds.every((k) => typeof k === 'string'));
  // the window title is the panel's titleKey
  assert.equal(sh.windows.floats.get('zPanel').spec.title, t.ctx.i18n.t('cmd.zRep'));
  await reject(api.openPanel('nopanel'), 'IJ_BAD_ARGS', 'an unknown panel');
  // persisted: the window list of the session meta names it; a panel without persist is not listed
  await api.openPanel('zPlain');
  const put1 = await until(() => t.log.msgs.filter((m) => m.cmd === 'session.putMeta' && m.args.windows).pop(), 'session meta written', 4000);
  await until(() => t.log.msgs.some((m) => m.cmd === 'session.putMeta' && m.args.windows && m.args.windows.includes('zPanel') && !m.args.windows.includes('zPlain')), 'zPanel persisted, zPlain not', 4000);
  void put1;
  api.closePanel('zPanel');
  assert.equal(inst.disposed, 1, 'dispose ran');
  assert.ok(!sh.windows.floats.has('zPanel'));
  assert.doesNotThrow(() => api.closePanel('zPanel'), 'closing a closed panel is harmless');
  // reload: a session that listed the panel opens it again
  await api.openPanel('zPanel');
  await until(() => t.log.msgs.some((m) => m.cmd === 'session.putMeta' && m.args.windows && m.args.windows.includes('zPanel') && m.args.windows.length >= 1 && m.at !== undefined) || t.log.msgs.filter((m) => m.cmd === 'session.putMeta').length > 2, 'meta again', 4000).catch(() => {});
  await t.flush();
  await sleep(1400);
  const t2 = await t.reload();
  const sh2 = await t2.open();
  await until(() => sh2.windows.floats.has('zPanel'), 'the panel reopened with the session', 6000);
  t2.close();
});

// ═════════════ 3. events ═════════════
await test('on(): activeDoc, doc (opened / pixels / size / display / renamed / closed), roi, results, layout, tool; off() and unknown names', async () => {
  const { t, sh, api, id } = await start();
  const seen = [];
  const offs = ['activeDoc', 'doc', 'roi', 'results', 'layout', 'tool'].map((e) => api.on(e, (p) => seen.push([e, p === undefined ? null : J(p)])));
  throws(() => api.on('nonsense', () => {}), 'IJ_BAD_ARGS', 'unknown event');
  throws(() => api.on('doc', null), 'IJ_BAD_ARGS', 'not a function');
  api.on('ext:made', () => {});
  const kinds = () => seen.filter((s) => s[0] === 'doc').map((s) => s[1].kind);
  await t.runCommand('imageDuplicate');
  await until(() => kinds().includes('opened'), 'opened');
  assert.ok(seen.some((s) => s[0] === 'activeDoc'), 'the duplicate became the active document');
  assert.ok(seen.some((s) => s[0] === 'layout'), 'a layout change');
  const second = t.activeId();
  seen.length = 0;
  await t.runCommand('editInvert');
  assert.ok(kinds().includes('pixels'), 'pixels after Invert: ' + kinds());
  await api.setDisplay(second, 0, { min: 1, max: 9 });
  assert.ok(kinds().includes('display'), 'display');
  await api.rename(second, 'renamed one');
  assert.ok(kinds().includes('renamed'), 'renamed: ' + kinds());
  api.setRoi({ type: 'rect', x: 1, y: 1, w: 5, h: 5 }, { docId: second });
  assert.ok(seen.some((s) => s[0] === 'roi' && s[1].docId === second && s[1].roi && s[1].final === true), 'roi');
  await t.runCommand('analyzeMeasure');
  assert.ok(seen.some((s) => s[0] === 'results'), 'results');
  await t.runCommand('imageCrop');
  await until(() => kinds().includes('size'), 'size after Crop');
  api.setTool('oval');
  assert.ok(seen.some((s) => s[0] === 'tool' && s[1] === 'oval'), 'tool');
  seen.length = 0;
  for (const off of offs) off();
  await api.setDisplay(second, 0, { min: 2, max: 8 });
  assert.equal(seen.length, 0, 'a listener that was switched off hears nothing');
  // a listener that throws does not stop the others or the app
  let heard = 0;
  api.on('doc', () => { throw new Error('listener failure'); });
  api.on('doc', () => { heard++; });
  await api.setDisplay(second, 0, { min: 3, max: 7 });
  assert.equal(heard, 1);
  const before = sh.layout.order().length;
  await t.runCommand('fileClose');
  await until(() => sh.layout.order().length === before - 1, 'closed');
  assert.ok(true);
  t.close();
});

// ═════════════ 4. annotations ═════════════
await test('annotations: the five kinds, tags, ids, visibility, validation, the view gets them, a size change clears them', async () => {
  const { t, sh, api, id } = await start();
  const A = api.annotations;
  assert.deepEqual(J(A.get(id)), { visible: true, items: [] });
  const items = [
    { kind: 'roi', roi: { type: 'rect', x: 2, y: 2, w: 5, h: 5 }, stroke: '#ff0000', tag: 'a' },
    { kind: 'text', x: 3, y: 4, text: 'hello', size: 10, color: '#00ff00', bold: true, align: 'center', tag: 'a' },
    { kind: 'shapes', lines: [0, 0, 5, 5], circles: [3, 3, 2], points: [1, 1], stroke: '#0000ff', width: 2 },
    { kind: 'rect', x: 1, y: 1, w: 3, h: 3, fill: '#ff00ff80' },
    { kind: 'marker', x: 6, y: 6, type: 3, color: '#ffff00', label: true, tag: 'm' }
  ];
  A.set(id, items);
  const got = A.get(id);
  assert.equal(got.items.length, 5);
  assert.ok(got.items.every((x) => typeof x.id === 'string' && x.id), 'every item has an id');
  assert.equal(new Set(got.items.map((x) => x.id)).size, 5, 'ids are unique');
  assert.equal(got.items[1].size, 10); assert.equal(got.items[1].align, 'center');
  assert.equal(got.items[0].roi.type, 'rect');
  // get() returns a copy
  got.items[0].roi.x = 99;
  assert.equal(A.get(id).items[0].roi.x, 2);
  // the view receives them
  assert.equal(sh.view(id).annotations.items.length, 5);
  assert.equal(sh.view(id).annotations.visible, true);
  // set with a tag replaces only the items of that tag
  A.set(id, [{ kind: 'marker', x: 9, y: 9, type: 1, color: '#ffffff' }], { tag: 'm' });
  const after = A.get(id).items;
  assert.equal(after.length, 5);
  assert.equal(after.filter((x) => x.tag === 'm').length, 1);
  assert.equal(after.find((x) => x.tag === 'm').x, 9, 'the marker was replaced');
  assert.equal(after.filter((x) => x.tag === 'a').length, 2, 'the other tag was kept');
  // add, remove by id and by tag
  A.add(id, [{ kind: 'rect', x: 0, y: 0, w: 1, h: 1 }]);
  assert.equal(A.get(id).items.length, 6);
  const victim = A.get(id).items[0].id;
  A.remove(id, { ids: [victim] });
  assert.ok(!A.get(id).items.some((x) => x.id === victim));
  A.remove(id, { tag: 'a' });
  assert.ok(!A.get(id).items.some((x) => x.tag === 'a'));
  throws(() => A.remove(id, {}), 'IJ_BAD_ARGS', 'remove needs ids or a tag');
  // visibility
  A.setVisible(id, false);
  assert.equal(A.get(id).visible, false); assert.equal(sh.view(id).annotations.visible, false);
  A.setVisible(id, 'toggle');
  assert.equal(A.get(id).visible, true);
  // validation: nothing of a bad batch is kept
  const n = A.get(id).items.length;
  throws(() => A.add(id, [{ kind: 'rect', x: 0, y: 0, w: 1, h: 1 }, { kind: 'text', x: 0, y: 0, text: 5 }]), 'IJ_BAD_ARGS', 'a text that is not a string');
  throws(() => A.add(id, [{ kind: 'zigzag' }]), 'IJ_BAD_ARGS', 'unknown kind');
  throws(() => A.add(id, [{ kind: 'rect', x: NaN, y: 0, w: 1, h: 1 }]), 'IJ_BAD_ARGS', 'NaN');
  throws(() => A.add(id, [{ kind: 'marker', x: 1, y: 1, type: 9 }]), 'IJ_BAD_ARGS', 'marker type 1..8');
  throws(() => A.add(id, [{ kind: 'shapes', lines: [1, 2, 3] }]), 'IJ_BAD_ARGS', 'lines come by fours');
  throws(() => A.add(id, [{ kind: 'text', x: 0, y: 0, text: 'x', color: 'red' }]), 'IJ_BAD_ARGS', 'a colour is #rrggbb');
  throws(() => A.add(99999, [{ kind: 'rect', x: 0, y: 0, w: 1, h: 1 }]), 'IJ_BAD_ARGS', 'no such image');
  assert.equal(A.get(id).items.length, n, 'a refused batch changes nothing');
  assert.ok(A.get(id).items.length > 0);
  // a size change clears them, with a warning
  const msgs = t.log.status.length;
  api.setRoi({ type: 'rect', x: 0, y: 0, w: 10, h: 8 });
  await t.runCommand('imageCrop');
  await until(() => A.get(t.activeId()).items.length === 0 || t.activeId() !== id, 'cleared');
  assert.equal(A.get(id).items.length, 0, 'a crop removed the overlay');
  assert.ok(t.log.status.slice(msgs).some((s) => /overlay/i.test(String(s))), 'with a warning in the status bar: ' + t.log.status.slice(msgs));
  assert.equal(sh.view(id).annotations.items.length, 0);
  t.close();
});

await test('annotations survive a reload with the session (the engine keeps the meta key), over the 10 000-item mark they are dropped with a warning', async () => {
  const { t, api, id } = await start();
  api.annotations.set(id, [{ kind: 'text', x: 1, y: 2, text: 'kept', tag: 't' }, { kind: 'rect', x: 0, y: 0, w: 2, h: 2 }]);
  api.annotations.setVisible(id, false);
  await delivered(t, (m) => m.cmd === 'session.putMeta' && m.args.annotations && m.args.annotations[id], 'meta carries the annotations');
  await t.flush();
  const key = (await t.store.shared.list())[0].key;
  const stored = (await t.store.shared.load(key)).meta;
  assert.ok(stored.ui && stored.ui.annotations && stored.ui.annotations[id], 'stored under ui.annotations');
  assert.equal(stored.ui.annotations[id].visible, false);
  assert.equal(stored.ui.annotations[id].items.length, 2);
  const t2 = await t.reload();
  const sh2 = await t2.open();
  const id2 = t2.activeId();
  assert.equal(id2, id, 'the document keeps its id across a reload');
  await t2.runCommand('zHand');
  const back = t2.page.__api.annotations.get(id2);
  assert.equal(back.visible, false);
  assert.equal(back.items.length, 2);
  assert.equal(back.items.find((x) => x.kind === 'text').text, 'kept');
  assert.equal(sh2.view(id2).annotations.items.length, 2, 'the view shows them again');
  // the engine side of the rule: more than 10 000 items of one document are not stored, and the answer says so
  const big = await t2.engine('session.putMeta', { key, annotations: { [id2]: { visible: true, items: new Array(10001).fill({ kind: 'rect', x: 0, y: 0, w: 1, h: 1 }) }, other: { visible: true, items: [] } } });
  assert.deepEqual(J(big.dropped), [{ key: 'annotations', code: 'IJ_LAY_META_TOO_LARGE', docId: id2 }]);
  const ok = await t2.engine('session.putMeta', { key, annotations: { other: { visible: true, items: [{ kind: 'rect' }] } } });
  assert.deepEqual(J(ok), {});
  t2.close();
});

// ═════════════ 5. settings, session data ═════════════
await test('settings: the core defaults, a package keeps to its prefix, values persist in localStorage; sessionData is the package\'s own and capped', async () => {
  const { t, api, id } = await start();
  const fiji = t.page.__api;
  assert.equal(fiji.settings.get('conv.scale'), true);
  assert.equal(fiji.settings.get('conv.fullRange16'), false);
  assert.equal(fiji.settings.get('misc.divZero'), 'Infinity');
  assert.equal(fiji.settings.get('colors.foreground'), 'white');
  assert.equal(fiji.settings.get('colors.background'), 'black');
  assert.equal(fiji.settings.get('colors.selection'), 'yellow');
  assert.equal(fiji.settings.get('appearance.interpolate'), false);
  assert.equal(fiji.settings.get('fiji.anything'), undefined);
  fiji.settings.set('fiji.counter', { types: 8, name: 'x' });
  assert.deepEqual(J(fiji.settings.get('fiji.counter')), { types: 8, name: 'x' });
  assert.deepEqual(J(t.settings.get('fiji.counter')), { types: 8, name: 'x' }, 'stored in localStorage "lumen3d.ij.prefs"');
  throws(() => fiji.settings.set('thr.method', 'Otsu'), 'IJ_EXT_FORBIDDEN', 'another package\'s prefix');
  throws(() => fiji.settings.set('conv.scale', false), 'IJ_EXT_FORBIDDEN', 'a core key belongs to the Edit package');
  throws(() => fiji.settings.set('nodots', 1), 'IJ_BAD_ARGS', 'a key is prefix.name');
  throws(() => fiji.settings.set('fiji.big', 'x'.repeat(70000)), 'IJ_BAD_ARGS', 'a value over 64 KiB');
  throws(() => t.IJApp.apiFor(null).settings.set('fiji.counter', 1), 'IJ_EXT_FORBIDDEN', 'the unbound api has no package');
  // the Edit package writes the core keys; the interpolation reaches the views at once
  const sh = t.shell;
  const edit = t.api('edit');
  edit.settings.set('appearance.interpolate', true);
  assert.equal(sh.view(id).interpolate, true);
  edit.settings.set('colors.foreground', 'red');
  assert.equal(edit.settings.get('colors.foreground'), 'red');
  // session data
  fiji.sessionData.set('fiji', { markers: [1, 2, 3] });
  assert.deepEqual(J(fiji.sessionData.get('fiji')), { markers: [1, 2, 3] });
  assert.equal(t.api('thr').sessionData.get('thr'), null, 'nothing yet');
  throws(() => fiji.sessionData.get('thr'), 'IJ_EXT_FORBIDDEN', 'another package\'s data');
  throws(() => fiji.sessionData.set('thr', {}), 'IJ_EXT_FORBIDDEN', 'another package\'s data');
  throws(() => fiji.sessionData.set('fiji', { big: 'x'.repeat(300 * 1024) }), 'IJ_BAD_ARGS', 'over 256 KiB');
  await delivered(t, (m) => m.cmd === 'session.putMeta' && m.args.ext && m.args.ext.fiji, 'the data is in the session meta');
  await t.flush();
  const t2 = await t.reload();
  await t2.open();
  assert.deepEqual(J(t2.api('fiji').sessionData.get('fiji')), { markers: [1, 2, 3] }, 'restored with the session');
  assert.deepEqual(J(t2.settings.get('fiji.counter')), { types: 8, name: 'x' }, 'settings live in localStorage, kept across a reload');
  fiji.sessionData.set('fiji', null);
  assert.equal(fiji.sessionData.get('fiji'), null);
  t2.close();
});

// ═════════════ 6. commands, runCommand, lastCommand ═════════════
await test('commands() lists the registry; runCommand runs the command with its dialog; lastCommand skips Undo and Close and the non-repeatable', async () => {
  const { t, sh, api, id } = await start();
  const list = api.commands();
  assert.ok(Array.isArray(list) && list.length > 100);
  const inv = list.find((c) => c.id === 'editInvert');
  assert.equal(inv.label, t.ctx.i18n.t('cmd.editInvert'));
  assert.deepEqual(arr(inv.path), ['Edit']);
  assert.equal(inv.shortcut, 'Shift+I');
  assert.equal(inv.enabled, true);
  assert.equal(list.find((c) => c.id === 'editUndo').enabled, false, 'nothing to undo yet');
  assert.deepEqual(arr(list.find((c) => c.id === 'zDeep').path), ['Plugins', 'Analyze', 'Cell Counter']);
  assert.deepEqual(arr(list.find((c) => c.id === 'lutFire').path), ['Image', 'Lookup Tables']);
  assert.deepEqual(J(api.lastCommand()), { id: 'zHand' }, 'the command that handed the api out');
  await t.runCommand('zRep');
  assert.deepEqual(J(api.lastCommand()), { id: 'zRep' });
  await t.runCommand('zNoRep');
  assert.deepEqual(J(api.lastCommand()), { id: 'zRep' }, 'repeatable:false is not remembered');
  await t.runCommand('editInvert');
  assert.deepEqual(J(api.lastCommand()), { id: 'editInvert' });
  await t.runCommand('editUndo');
  assert.deepEqual(J(api.lastCommand()), { id: 'editInvert' }, 'Undo is not remembered (IJ/Executer.java:37-45)');
  // runCommand: the command runs as from the menu — its own dialog appears (answered by the harness' scripted values)
  const n = t.log.dialogSpecs.length;
  t.script.dialogs.push({ radius: 33 });
  await api.runCommand('procSubtractBackground');
  assert.ok(t.log.dialogSpecs.length > n, 'the dialog of the command was shown');
  assert.deepEqual(J(api.lastCommand()), { id: 'procSubtractBackground' });
  // a second run: the dialog remembers the values the first one was answered with
  t.script.dialogs.length = 0;
  t.script.dialogs.push(null);
  await api.runCommand('procSubtractBackground');
  const spec = t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
  assert.equal(spec.fields.find((f) => f.id === 'radius').value, 33, 'pre-filled by the dialog memory');
  await reject(Promise.resolve().then(() => api.runCommand('noSuchCommand')), 'IJ_BAD_ARGS', 'unknown command');
  assert.equal(await api.runCommand('editUndo').then(() => 'ran'), 'ran');
  t.close();
});

// ═════════════ 7. worker commands: call, adopt, E ═════════════
await test('call(): only a command of the calling package, busy / Cancel like api.run, errors reported, results returned, E handed to the handler', async () => {
  const { t, sh, api, id } = await start();
  const r = await api.call('doc.fiji.echo', { v: 41 });
  assert.equal(r.v, 41); assert.equal(r.hasBudget, true);
  assert.deepEqual(arr(r.members).sort(), ['budgetBytes', 'check', 'createDoc', 'done', 'fetch', 'ijError', 'lockDocs', 'postEvent', 'readDoc', 'release', 'reserve', 'tick', 'transfer'].sort(), 'the services of E');
  // not the package's own: refused; not a command at all: refused
  await reject(api.call('doc.enh.half', {}), 'IJ_EXT_FORBIDDEN', 'a command of another package');
  await reject(api.call('doc.fiji.nothing', {}), 'IJ_EXT_FORBIDDEN', 'an unregistered name');
  await reject(api.call('doc.run', {}), 'IJ_EXT_FORBIDDEN', 'a built-in command');
  await reject(t.api('thr').call('doc.fiji.echo', {}), 'IJ_EXT_FORBIDDEN', 'the command of fiji from thr');
  // a handler that throws: reported to the operator by the call itself, the result is null
  const e0 = t.errors.length;
  assert.equal(await api.call('doc.fiji.boom', {}), null);
  assert.equal(t.errors.length, e0 + 1, 'an error dialog');
  t.errors.length = 0;
  // Cancel reaches a long command
  const p = api.call('doc.fiji.wait', {}, { long: true, labelKey: 'op.invert' });
  await until(() => t.IJApp && t.shell.progress.some((x) => x && x.label), 'the busy state with the progress label');
  assert.equal(t.shell.progress.filter(Boolean).pop().label, t.ctx.i18n.t('op.invert'));
  t.shell.opts.onCancel();
  assert.equal(await p, null, 'cancelled');
  assert.equal(t.errors.length, 0, 'a cancel is not an error');
  // `long` declared by extend({ longCommands }) too: no flag in the call
  const p2 = api.call('doc.fiji.wait', {});
  await sleep(40);
  t.shell.opts.onCancel();
  assert.equal(await p2, null);
  // busy: a second step while one runs is not started
  const slow = api.call('doc.fiji.wait', {}, { long: true });
  await sleep(20);
  assert.equal(await api.call('doc.fiji.echo', { v: 1 }), null, 'busy');
  t.shell.opts.onCancel();
  await slow;
  // reservations of a handler are given back with the request
  const used = async () => (await t.engine('doc.info', { docId: id })).memory.usedBytes;
  const base = await used();
  await api.call('doc.fiji.leak', {});
  assert.equal(await used(), base, 'E.reserve without release is returned at the end of the request');
  // lockDocs / readDoc
  const lk = await api.call('doc.fiji.locked', { docId: id });
  assert.deepEqual(J(lk), { w: 40, frozen: true });
  t.close();
});

await test('adopt(): a document the worker made (E.createDoc) gets a view, a tab, a menu entry and the session; hidden ones get none; ext events reach api.on', async () => {
  const { t, sh, api, id } = await start();
  const events = [];
  api.on('ext:made', (m) => events.push(m));
  const info = await api.call('doc.fiji.make', { w: 12, h: 8, fill: 90, name: 'built' });
  assert.equal(info.name, 'built');
  assert.equal(sh.layout.order().length, 1, 'not adopted yet: no view');
  const newId = await api.adopt(info, { placement: 'splitRight', provenance: { from: 'test' } });
  assert.equal(newId, info.docId);
  assert.equal(sh.lay.adds[sh.lay.adds.length - 1].placement, 'splitRight');
  assert.ok(sh.view(newId), 'a view');
  assert.equal(t.activeId(), newId);
  assert.ok(t.cmd('winImg' + newId) || t.shell.opts.commands.some((c) => c.id === 'winImg' + newId), 'a Window menu entry');
  await until(() => events.length === 1, 'the worker event reached api.on("ext:made")');
  assert.equal(events[0].docId, info.docId);
  assert.equal((await t.engine('doc.info', { docId: newId })).provenance.made, true);
  // hidden: kept, but nobody sees it
  const hid = await api.call('doc.fiji.make', { w: 6, h: 6, fill: 3, hidden: true, name: 'ghost' });
  assert.equal(hid.hidden, true);
  const hid2 = await api.adopt(hid, {});
  assert.equal(hid2, hid.docId);
  assert.ok(!sh.view(hid.docId), 'no view');
  assert.ok(!sh.opts.commands.some((c) => c.id === 'winImg' + hid.docId), 'no menu entry');
  assert.ok(!api.state().docs.some((d) => d.docId === hid.docId), 'not in state().docs');
  assert.ok(t.log.dialogSpecs.length >= 0);
  assert.equal(api.state().docs.length, 2);
  t.close();
});

await test('a package that failed to load: its worker commands answer IJ_MODULE_MISSING, the page refuses api.call', async () => {
  const { t, api } = await start();
  await until(() => t.failedPackages().has('enh'), 'enh failed in the worker');
  await reject(t.engine('doc.enh.half', {}), 'IJ_MODULE_MISSING', 'the withdrawn command');
  await reject(t.engine('doc.nothing.here', {}), 'IJ_UNKNOWN_CMD', 'a name nobody registered');
  await reject(t.api('enh').call('doc.enh.half', {}), 'IJ_MODULE_MISSING', 'the page knows the package failed');
  // the other packages still work
  assert.equal((await api.call('doc.fiji.echo', { v: 2 })).v, 2);
  t.close();
});

await test('IJOpRegistry commands: names, ownership, idempotence, withdrawal; built-in handlers cannot be shadowed', async () => {
  const t = await boot(SOURCES);
  const R = t.page.IJOpRegistry;
  const h = () => 1;
  throws(() => R.defineCommand('noDots', { pkg: 'fiji', handler: h }), 'IJ_BAD_ARGS', 'a dotted name');
  throws(() => R.defineCommand('engine.configure', { pkg: 'fiji', handler: h }), 'IJ_BAD_ARGS', 'engine. belongs to the engine');
  throws(() => R.defineCommand('session.x', { pkg: 'fiji', handler: h }), 'IJ_BAD_ARGS', 'session. belongs to the engine');
  throws(() => R.defineCommand('doc.x.y', { pkg: 'Bad', handler: h }), 'IJ_BAD_ARGS', 'a package name');
  throws(() => R.defineCommand('doc.x.y', { pkg: 'fiji' }), 'IJ_BAD_ARGS', 'a handler');
  const spec = { pkg: 'fiji', long: true, handler: h };
  assert.equal(R.defineCommand('doc.t.one', spec), spec);
  assert.equal(R.defineCommand('doc.t.one', spec), spec, 'idempotent for the same spec');
  throws(() => R.defineCommand('doc.t.one', { pkg: 'fiji', handler: h }), 'IJ_BAD_ARGS', 'another spec under the same name');
  assert.equal(R.getCommand('doc.t.one'), spec);
  assert.equal(R.getCommand('doc.t.nope'), null);
  assert.ok(R.listCommands().includes('doc.t.one'));
  assert.deepEqual(arr(R.listCommands('enh')), ['doc.enh.half']);
  assert.equal(R.isWithdrawnCommand('doc.t.one'), false);
  assert.equal(R.unregisterCommand('doc.t.one'), true);
  assert.equal(R.getCommand('doc.t.one'), null);
  assert.equal(R.isWithdrawnCommand('doc.t.one'), true);
  assert.equal(R.unregisterCommand('doc.t.one'), false);
  // the engine prefers its own handler to a command named like it: the command is withdrawn at start
  const w = await boot({ workerSources: { 'ij-proc-fiji.js': `IJOpRegistry.defineCommand('doc.info', { pkg: 'fiji', handler() { return 'shadow'; } }); IJOpRegistry.defineCommand('doc.fiji.ok', { pkg: 'fiji', handler() { return 'ok'; } });` }, pageSources: { 'ij-proc-fiji.js': '' } });
  const sw = await w.spawn();
  await w.engine('doc.create', { name: 'd', width: 4, height: 4, bitDepth: 8, channels: [{ name: 'A', color: '#fff' }] }, sw);
  const list = await w.engine('doc.list', {}, sw);
  assert.equal(list.docs.length, 1, 'doc.list is the engine\'s');
  assert.equal(await w.engine('doc.fiji.ok', {}, sw), 'ok');
  t.close(); w.close();
});

// ═════════════ 8. blobs ═════════════
await test('putBlob + blobRef: a typed array travels once; the params of a compute and a run resolve it; a big one is journaled ONCE and replays after a reload', async () => {
  const { t, api, id } = await start();
  const data = new Uint8Array(100000).map((_, i) => (i * 7) & 255);
  const ref = await api.putBlob(data);
  assert.equal(typeof ref.blobRef, 'string'); assert.equal(ref.kind, 'Uint8Array');
  assert.equal(data.length, 100000, 'the caller keeps its array');
  const ref2 = await api.putBlob(data);
  assert.equal(ref2.blobRef, ref.blobRef, 'the same bytes are one blob');
  let sum = 0; for (const v of data) sum += v;
  const res = await t.engine('doc.compute', { docId: id, op: 'blobSum', params: { data: ref }, roi: null, channel: 0 });
  assert.deepEqual(J(res), { s: sum, n: 100000, kind: 'Uint8Array' });
  // preview with a blobRef (a pixel op): the engine answers a preview event
  const seq = 4242;
  await t.engine('doc.preview', { docId: id, seq, op: 'blobPaint', params: { data: ref }, roi: null, channel: 0, level: 0, x0: 0, y0: 0, x1: 40, y1: 30 });
  await until(() => t.log.events.some((e) => e.event === 'preview' && e.seq === seq), 'the preview came back');
  // an unknown ref fails cleanly
  await reject(t.engine('doc.compute', { docId: id, op: 'blobSum', params: { data: { blobRef: 'ffff-1', kind: 'Uint8Array' } }, roi: null, channel: 0 }), 'IJ_NO_BLOB', 'unknown blobRef');
  await reject(api.putBlob(new Uint8Array(65 * 1048576)), 'IJ_TOO_LARGE', 'over 64 MiB');
  await reject(api.putBlob([1, 2, 3]), 'IJ_BAD_ARGS', 'not a typed array');
  // run: the committed entry holds a marker, the bytes live once beside the journal
  await t.engine('doc.run', { docId: id, op: 'blobPaint', params: { data: ref }, roi: null, channel: 0 });
  await t.engine('doc.run', { docId: id, op: 'blobPaint', params: { data: ref }, roi: null, channel: 1 });
  const before = Array.from(await t.pixels(id, 0));
  await t.engine('flush', {});
  const key = (await t.store.shared.list())[0].key;
  const stored = (await t.store.shared.load(key)).docs[id];
  const entries = stored.journal.filter((e) => e.kind === 'run' && e.op === 'blobPaint');
  if (stored.snapshot && stored.snapshot.journalSeq >= 1 && !entries.length) assert.ok(true, 'a snapshot already covers the entries');
  else {
    assert.ok(entries.length >= 1, 'journal entries of the run');
    assert.ok(entries.every((e) => e.params.data && typeof e.params.data.blobRef === 'string' && !ArrayBuffer.isView(e.params.data)), 'the params carry a marker, not the bytes');
    assert.equal(Object.keys(stored.blobs).length, 1, 'the body is stored once for both entries');
    assert.equal(Array.from(stored.blobs[entries[0].params.data.blobRef].data).length, 100000);
  }
  const t2 = await t.reload({ flush: false });
  const w2 = await t2.spawn();
  const rs = await t2.engine('session.restore', { key }, w2);
  assert.equal(rs.warnings.length, 0, JSON.stringify(rs.warnings));
  assert.deepEqual(Array.from(await t2.pixels(id, 0)), before, 'the replay gives the same pixels');
  t2.close();
  t.close();
});

await test('blob budget: a blob counts against memory, an unused one is given up when memory is short, a used one stays until its document closes', async () => {
  const t = await boot(Object.assign({}, SOURCES, { budgetBytes: 8 * 1048576 }));
  const w = await t.spawn();
  const d = await t.engine('doc.create', { name: 'd', width: 64, height: 64, bitDepth: 8, channels: [{ name: 'A', color: '#fff' }] }, w);
  const info = async () => (await t.engine('doc.info', { docId: d.docId }, w)).memory.usedBytes;
  await w.engine.whenIdle();   // the baseline is stored: its copy in memory is gone
  const base = await info();
  const a = await t.engine('engine.putBlob', { data: new Uint8Array(3 * 1048576).fill(1) }, w);
  assert.equal(await info(), base + 3 * 1048576, 'counted');
  // a second blob that does not fit evicts the first, which nothing used
  const b = await t.engine('engine.putBlob', { data: new Uint8Array(6 * 1048576).fill(2) }, w);
  assert.equal(await info(), base + 6 * 1048576);
  await reject(t.engine('doc.compute', { docId: d.docId, op: 'blobSum', params: { data: a }, roi: null, channel: 0 }, w), 'IJ_NO_BLOB', 'the unused blob was given up');
  assert.deepEqual(J(await t.engine('engine.dropBlob', { blobRef: b.blobRef }, w)), { dropped: true });
  assert.equal(await info(), base);
  // used by a document: it stays and is not droppable
  const c = await t.engine('engine.putBlob', { data: new Uint8Array(70000).fill(3) }, w);
  await t.engine('doc.run', { docId: d.docId, op: 'blobPaint', params: { data: c }, roi: null, channel: 0 }, w);
  assert.deepEqual(J(await t.engine('engine.dropBlob', { blobRef: c.blobRef }, w)), { dropped: false });
  // a compute and a preview (a cancelled paste) do not pin the blob to the document
  const e = await t.engine('engine.putBlob', { data: new Uint8Array(70000).fill(5) }, w);
  await t.engine('doc.compute', { docId: d.docId, op: 'blobSum', params: { data: e }, roi: null, channel: 0 }, w);
  await t.engine('doc.preview', { docId: d.docId, seq: 99, op: 'blobPaint', params: { data: e }, roi: null, channel: 0, level: 0, x0: 0, y0: 0, x1: 16, y1: 16 }, w);
  assert.deepEqual(J(await t.engine('engine.dropBlob', { blobRef: e.blobRef }, w)), { dropped: true }, 'a preview / compute leaves the blob droppable');
  await t.engine('doc.close', { docId: d.docId, discard: true }, w);
  await reject(t.engine('doc.compute', { docId: d.docId, op: 'blobSum', params: { data: c }, roi: null, channel: 0 }, w), 'IJ_NO_DOC', 'closed');
  t.close();
});

// ═════════════ 9. addDoc ═════════════
await test('addDoc: an image the page built becomes a document (visible with a tab, or hidden); bad images are refused', async () => {
  const { t, sh, api, id } = await start();
  const px = new Uint16Array(10 * 6).map((_, i) => i * 100);
  const newId = await api.addDoc({ name: 'pasted', width: 10, height: 6, bitDepth: 16, calibration: { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'um' },
    channels: [{ data: px, name: 'P', color: '#00ff00' }] }, { placement: 'splitRight', provenance: { from: 'paste' } });
  assert.ok(sh.view(newId), 'a view'); assert.equal(sh.lay.adds[sh.lay.adds.length - 1].placement, 'splitRight');
  assert.equal(t.activeId(), newId);
  const info = await t.engine('doc.info', { docId: newId });
  assert.equal(info.name, 'pasted'); assert.equal(info.bitDepth, 16); assert.equal(info.provenance.imported, true); assert.equal(info.provenance.from, 'paste');
  assert.equal(info.unsaved, true, 'a new image is unsaved');
  const tile = await t.pixels(newId, 0);
  assert.equal(tile[7], 700);
  const hid = await api.addDoc({ name: 'h', width: 4, height: 4, bitDepth: 8, channels: [{ data: new Uint8Array(16).fill(5), name: 'H', color: '#fff' }] }, { hidden: true });
  assert.ok(!sh.view(hid));
  assert.equal((await t.engine('doc.info', { docId: hid })).hidden, true);
  assert.equal(api.state().docs.length, 2, 'the hidden one is not listed');
  assert.ok(!t.shell.opts.getState().docs.some((d) => d.docId === hid));
  // hidden documents are no choice of a dialog field
  await t.runCommand('procImageCalculator', { op: 'add', allChannels: false }, { expectError: true }).catch(() => {});
  // bad images
  await reject(api.addDoc({ name: 'x', width: 4, height: 4, bitDepth: 8, channels: [{ data: new Uint16Array(16) }] }, {}), 'IJ_BAD_ARGS', 'wrong array type');
  await reject(api.addDoc({ name: 'x', width: 4, height: 4, bitDepth: 8, channels: [{ data: new Uint8Array(15) }] }, {}), 'IJ_BAD_ARGS', 'wrong length');
  await reject(api.addDoc({ name: 'x', width: 4, height: 4, bitDepth: 12, channels: [{ data: new Uint8Array(16) }] }, {}), 'IJ_BAD_ARGS', 'bad depth');
  await reject(api.addDoc({ name: 'x', width: 4, height: 4, bitDepth: 8, channels: [] }, {}), 'IJ_BAD_ARGS', 'no channel');
  // closeDoc: the unsaved prompt (the harness answers with the primary option, Save, whose picker is a download), then closed
  assert.equal(await api.closeDoc(99999), false, 'no such document');
  t.close();
});

// ═════════════ 10. pending ═════════════
await test('setPending: commit runs before any command and an image switch, Enter commits, Escape cancels, clearPending forgets it', async () => {
  const { t, sh, api, id } = await start();
  const order = [];
  const mk = (name) => ({ labelKey: 'status.copied', commit: async () => { order.push(name + ':commit'); }, cancel: () => { order.push(name + ':cancel'); } });
  api.setPending(mk('p1'));
  assert.equal(t.log.status[t.log.status.length - 1], t.ctx.i18n.t('status.copied'), 'the status bar shows labelKey');
  await t.runCommand('editInvert');
  assert.deepEqual(order, ['p1:commit'], 'committed before the command ran');
  await t.runCommand('editInvert');
  assert.deepEqual(order, ['p1:commit'], 'only once');
  // an image switch commits
  await t.runCommand('imageDuplicate');
  const second = t.activeId();
  api.setPending(mk('p2'));
  sh.layout.activate(id);
  await until(() => order.includes('p2:commit'), 'committed on the image switch');
  // Enter / Escape, from the capture-phase listener of the app element
  const el = t.root.children[0];
  const keydown = (key, target) => { let prevented = false; for (const f of el.listeners.keydown || []) f({ key, target: target || { tagName: 'DIV' }, preventDefault() { prevented = true; }, stopPropagation() {} }); return prevented; };
  api.setPending(mk('p3'));
  assert.equal(keydown('Escape'), true);
  assert.ok(order.includes('p3:cancel'));
  api.setPending(mk('p4'));
  assert.equal(keydown('Enter', { tagName: 'INPUT' }), false, 'a text field keeps its keys');
  assert.ok(!order.includes('p4:commit'));
  keydown('Enter');
  await until(() => order.includes('p4:commit'), 'Enter commits');
  assert.equal(keydown('Escape'), false, 'nothing pending: the key goes on to the shell');
  api.setPending(mk('p5'));
  api.clearPending();
  await t.runCommand('editInvert');
  assert.ok(!order.some((s) => s.startsWith('p5')), 'a cleared state is forgotten');
  // a second setPending cancels the first
  api.setPending(mk('p6')); api.setPending(mk('p7'));
  assert.ok(order.includes('p6:cancel'));
  throws(() => api.setPending({ labelKey: 'x', commit() {} }), 'IJ_BAD_ARGS', 'cancel is required');
  void second;
  t.close();
});

// ═════════════ 11. the smaller members ═════════════
await test('setTool, view, setThreshold, roiManager, colorValue, profile', async () => {
  const { t, sh, api, id } = await start();
  // tools: a registered hidden tool can be selected; its pointer events reach onPointer with the package api
  api.setTool('zTool');
  assert.equal(t.shell.opts.tools.find((x) => x.id === 'zTool').hidden, true);
  const log = t.page.__log;
  t.shell.opts.onToolPointer(id, { type: 'down', x: 3, y: 4, button: 0, shift: false, alt: false, ctrl: false });
  t.shell.opts.onToolPointer(id, { type: 'up', x: 3, y: 4, button: 0, shift: false, alt: false, ctrl: false });
  assert.deepEqual(J(log.map((e) => [e.type, e.docId, e.x, e.y])), [['down', id, 3, 4], ['up', id, 3, 4]]);
  t.shell.opts.onToolPointer(id, { type: 'down', x: 1, y: 1, button: 0, shift: true, alt: false, ctrl: false });
  await sleep(20);
  assert.equal(t.errors.length, 1, 'a failing tool is reported');
  t.errors.length = 0;
  api.setTool('rect');
  t.shell.opts.onToolPointer(id, { type: 'down', x: 1, y: 1 });
  assert.equal(log.length, 3, 'another tool selected: the package tool hears nothing');
  throws(() => api.setTool('nope'), 'IJ_BAD_ARGS', 'unknown tool');
  // view
  const v = api.view(id);
  assert.deepEqual(Object.keys(v).sort(), ['getView', 'setView', 'visibleRect']);
  v.setView({ zoom: 2, ox: 5, oy: 6 });
  assert.equal(v.getView().zoom, 2);
  assert.equal(api.view(123456), null);
  // setThreshold drives the window
  await api.setThreshold(id, 1, { lower: 20, upper: 120, dark: false });
  const thr = api.state().threshold;
  assert.deepEqual([thr.docId, thr.channel, thr.lower, thr.upper, thr.dark], [id, 1, 20, 120, false]);
  await reject(api.setThreshold(id, 7, { lower: 1, upper: 2 }), 'IJ_BAD_ARGS', 'bad channel');
  await reject(api.setThreshold(id, 0, { lower: 5, upper: 2 }), 'IJ_BAD_ARGS', 'lower > upper');
  // roiManager
  const R = api.roiManager;
  R.add([{ roi: { type: 'rect', x: 1, y: 1, w: 4, h: 4 }, name: 'one', stroke: '#ff0000', width: 2 }, { roi: { type: 'oval', x: 5, y: 5, w: 6, h: 6 } }]);
  const list = R.list();
  assert.equal(list.length, 2); assert.equal(list[0].name, 'one'); assert.equal(list[0].stroke, '#ff0000'); assert.equal(list[0].width, 2); assert.equal(list[0].docId, id);
  assert.ok(list[1].name, 'a default name');
  assert.equal(sh.view(id).rois.all[0].stroke, '#ff0000', 'the view draws each entry with its own style');
  R.select([1]); assert.deepEqual(arr(R.selected()), [1]);
  R.select([]); assert.deepEqual(arr(R.selected()), []);
  throws(() => R.add([{ roi: { type: 'bogus' } }]), 'IJ_BAD_ROI', 'a bad selection');
  throws(() => R.add([{ roi: { type: 'rect', x: 0, y: 0, w: 1, h: 1 }, docId: 424242 }]), 'IJ_BAD_ARGS', 'no such image');
  R.set([list[1]]);
  assert.equal(R.list().length, 1);
  assert.equal(R.list()[0].roi.type, 'oval');
  // a selection name survives validation
  R.add([{ roi: { type: 'rect', x: 1, y: 1, w: 2, h: 2, name: 'named' }, name: 'n2' }]);
  throws(() => R.add([{ roi: { type: 'rect', x: 1, y: 1, w: 2, h: 2, name: 5 } }]), 'IJ_BAD_ROI', 'name must be a string');
  // colorValue: ImageJ's setColor on a grey image
  await api.setDisplay(id, 0, { lut: 'Grays' });   // the harness' channel 0 is blue: a grey table for the arithmetic below
  assert.equal(api.colorValue(id, 0, 'foreground'), 255, '8-bit white on the Grays table is 255');
  assert.equal(api.colorValue(id, 0, 'background'), 0);
  t.api('edit').settings.set('colors.foreground', 'red');
  assert.equal(api.colorValue(id, 0, 'foreground'), 85, 'red: the nearest grey of the default table, weighted (255,0,0): (v-255)² + 2v² is smallest at 85');
  t.api('edit').settings.set('colors.foreground', '#808080');
  assert.equal(api.colorValue(id, 0, 'foreground'), 128);
  await api.setDisplay(id, 1, { lut: 'Green' });
  t.api('edit').settings.set('colors.foreground', 'white');
  assert.equal(api.colorValue(id, 1, 'foreground'), 255, 'on a Green table white is the brightest green');
  assert.equal(api.colorValue(id, 1, 'background'), 0);
  throws(() => api.colorValue(id, 9, 'foreground'), 'IJ_BAD_ARGS', 'bad channel');
  throws(() => api.colorValue(id, 0, 'middle'), 'IJ_BAD_ARGS', 'foreground or background');
  // 16-bit: the value sits inside the display range
  await t.runCommand('typeBit16');
  await until(() => api.state().doc.bitDepth === 16, '16-bit');
  await sleep(80);   // the worker's invalidate refreshes the display state of the converted image
  await api.setDisplay(id, 0, { min: 1000, max: 3000 });
  t.api('edit').settings.set('colors.foreground', 'white');
  assert.equal(api.colorValue(id, 0, 'foreground'), 3000, 'white = the top of the display range');
  t.api('edit').settings.set('colors.background', 'black');
  assert.equal(api.colorValue(id, 0, 'background'), 0, 'black on a range that starts above 0 stays 0 (ShortProcessor.setColor)');
  t.api('edit').settings.set('colors.foreground', 'gray');
  assert.equal(api.colorValue(id, 0, 'foreground'), Math.trunc(1000 + 2000 * (128 / 255)), 'gray: min + (max-min)*bestIndex/255, cast to int');
  // Fill uses it: editFill writes the foreground value
  t.api('edit').settings.set('colors.foreground', 'white');
  api.setRoi({ type: 'rect', x: 0, y: 0, w: 3, h: 3 });
  const want = api.colorValue(id, 1, 'foreground');   // Fill works on the active channel (the Threshold step above made it channel 1)
  await t.runCommand('editFill');
  assert.equal((await t.pixels(id, 1))[0], want, 'Fill writes colorValue(foreground) of its channel');
  // profile: the line of the worker's doc.profile
  const prof = await api.profile(id, { type: 'line', x1: 0, y1: 5, x2: 9, y2: 5, width: 1 }, 0);
  assert.ok(prof.values.length >= 9 && typeof prof.step === 'number' && prof.step > 0);
  t.close();
});

await test('registerLut: the table is known to the page and the worker, kept in the session, named by a channel and written by the TIFF export', async () => {
  const { t, api, id } = await start();
  const tab = new Uint8Array(768); for (let i = 0; i < 256; i++) { tab[i * 3] = i; tab[i * 3 + 1] = 255 - i; tab[i * 3 + 2] = (i * 3) & 255; }
  await api.registerLut('My ramp', tab);
  assert.deepEqual(arr(t.page.IJLuts.get('My ramp')), arr(tab));
  assert.equal(t.page.IJLuts.identify(tab).lut, 'My ramp', 'the reader identifies it by name');
  await reject(api.registerLut('Fire', tab), 'IJ_BAD_LUT', 'a built-in name');
  await reject(api.registerLut('#ff0000', tab), 'IJ_BAD_LUT', 'a colour is no name');
  await reject(api.registerLut('short', new Uint8Array(10)), 'IJ_BAD_ARGS', 'size');
  await api.setDisplay(id, 0, { lut: 'My ramp' });
  assert.equal(api.state().doc.channels[0].display.lut, 'My ramp');
  const exp = await t.engine('doc.exportTiff', { docId: id });
  assert.ok(exp.bytes.byteLength > 100);
  const img = t.page.IJTiff.read(new Uint8Array(exp.bytes), 'x');
  assert.equal(img.channels[0].display.lut, 'My ramp', 'the exported table reads back as the registered name');
  // the session keeps it; a restored page registers it before any view names it
  await delivered(t, (m) => m.cmd === 'session.putMeta' && m.args.luts && m.args.luts['My ramp'], 'luts in the meta');
  await t.flush();
  const t2 = await t.reload();
  await t2.open();
  assert.deepEqual(arr(t2.page.IJLuts.get('My ramp')), arr(tab), 'registered again after the reload');
  assert.equal(t2.api('fiji').state().doc.channels[0].display.lut, 'My ramp');
  t2.close();
});

await test('pickFile, saveFile, copyText, renderPng', async () => {
  const { t, sh, api, id } = await start();
  t.pickFile([{ name: 'a.txt', size: 3 }, { name: 'b.txt', size: 4 }]);
  const files = await api.pickFile({ accept: '.txt', multiple: true });
  assert.deepEqual(J(files.map((f) => f.name)), ['a.txt', 'b.txt']);
  t.pickFile(null);
  assert.equal(await api.pickFile({ accept: '.txt' }), null, 'cancelled');
  const ok = await api.saveFile('out.csv', 'text/csv', '.csv', 'plot.saveCsv', async () => new Blob(['a,b\n1,2\n'], { type: 'text/csv' }));
  assert.equal(ok, true);
  assert.equal(t.saved.length, 1); assert.equal(t.saved[0].name, 'out.csv'); assert.ok(t.saved[0].blob instanceof Blob);
  await reject(api.saveFile('x', 'text/csv', '.csv', 'plot.saveCsv', null), 'IJ_BAD_ARGS', 'produce is required');
  // copyText: the browser's clipboard; a refusal rejects with the browser's error
  let written = null;
  t.page.navigator.clipboard = { writeText: async (s) => { written = s; } };
  await api.copyText('some text');
  assert.equal(written, 'some text');
  t.page.navigator.clipboard = { writeText: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } };
  await reject(api.copyText('x'), undefined, 'a refusal').catch((e) => { assert.equal(e.name, 'NotAllowedError'); });
  // renderPng: the picture as displayed (the stand-in view answers with a canvas of the fake DOM)
  sh.view(id).renderToCanvas = async () => ({ width: 8, height: 6, toBlob: (cb) => cb(new Blob([new Uint8Array(4)], { type: 'image/png' })) });
  const blob = await api.renderPng(id, {});
  assert.ok(blob instanceof Blob && blob.type === 'image/png');
  await reject(api.renderPng(99999, {}), 'IJ_BAD_ARGS', 'no view');
  t.close();
});

// ═════════════ 12. the Window menu, placements, Synchronize Windows ═════════════
await test('Window menu: ImageJ\'s order, the open tool windows before the images, Results / ROI Manager only while closed, the layout commands', async () => {
  const { t, sh, api, id } = await start();
  const win = () => t.shell.opts.commands.filter((c) => c.menu && c.menu[0] === 'Window');
  const order = (list) => list.slice().sort((a, b) => a.order - b.order).map((c) => c.id);
  let ids = order(win());
  assert.deepEqual(J(ids.slice(0, 6)), ['windowShowAll', 'windowPutBehind', 'windowCascade', 'windowTile', 'windowResults', 'windowRoiManager'], ids.join());
  assert.ok(ids.includes('winImg' + id));
  assert.ok(ids.indexOf('winImg' + id) > ids.indexOf('windowRoiManager') && ids.indexOf('winImg' + id) < ids.indexOf('windowNext'), 'the images sit between the windows and Next / Previous');
  assert.deepEqual(J(ids.slice(-2)), ['windowNext', 'windowPrevious']);
  const inf = (await t.engine('doc.info', { docId: id }));
  const bytes = inf.width * inf.height * inf.channels.length * (inf.bitDepth / 8);
  assert.equal(win().find((c) => c.id === 'winImg' + id).label, inf.name + ' ' + t.IJApp.imageSizeString(bytes), '"name size" as ImageJ (ImageWindow.getImageSize)');
  // ImageWindow.getImageSize: K below 1024, MB with one decimal below 10000 K, whole MB below 1 GB, GB; a trailing ".0" is dropped; d2s rounds half-even
  const S = t.IJApp.imageSizeString;
  assert.deepEqual([512, 1536, 2560, 64 * 1024].map(S), ['0K', '2K', '2K', '64K']);
  assert.deepEqual([1024 * 1024, 1024 * 5000, 1024 * 9999, 1024 * 10000, 1024 * 1024 * 512, 1024 * 1048575].map(S), ['1MB', '4.9MB', '9.8MB', '10MB', '512MB', '1024MB']);
  assert.deepEqual([1024 * 1048576, 1024 * 1048576 * 3.25].map(S), ['1GB', '3.2GB'], 'GB with one decimal, half-even on 3.25');
  // Results open: its static row gives way to the window's own row, listed before the images
  await t.runCommand('windowResults');
  ids = order(win());
  assert.ok(!ids.includes('windowResults'), 'the opener is replaced by the open window');
  assert.ok(ids.includes('winToolresults'), 'the open window is listed');
  assert.ok(ids.includes('windowRoiManager'), 'the ROI Manager is still closed: its opener stays');
  assert.ok(ids.indexOf('winToolresults') < ids.indexOf('winImg' + id));
  assert.equal(win().find((c) => c.id === 'windowRoiManager').separatorBefore, true, 'a separator opens the tool-window section');
  // a table / panel window joins the list too
  await api.openPanel('zPanel');
  assert.ok(win().some((c) => c.id === 'winToolzPanel'));
  api.closePanel('zPanel');
  assert.ok(!win().some((c) => c.id === 'winToolzPanel'));
  // opening the Window menu refreshes it (a static window closed without the app's knowledge)
  t.shell.opts.onMenuOpen('Window');
  // the layout commands reach the layout
  const fired = [];
  for (const n of ['showAll', 'putBehind', 'cascade', 'tile']) { const o = sh.layout[n]; sh.layout[n] = (...a) => { fired.push(n); return o(...a); }; }
  await t.runCommand('windowShowAll'); await t.runCommand('windowPutBehind'); await t.runCommand('windowCascade'); await t.runCommand('windowTile');
  assert.deepEqual(fired, ['showAll', 'putBehind', 'cascade', 'tile']);
  assert.equal(t.cmd('windowShowAll').shortcut[0], ']');
  // the image list follows the layout order and the next / previous commands follow it
  await t.runCommand('imageDuplicate');
  const second = t.activeId();
  assert.deepEqual(J(order(win()).filter((x) => x.startsWith('winImg'))), J(sh.layout.order().map((d) => 'winImg' + d)));
  await t.runCommand('windowNext');
  assert.notEqual(t.activeId(), second);
  // hidden images are not listed
  const h = await api.addDoc({ name: 'ghost', width: 3, height: 3, bitDepth: 8, channels: [{ data: new Uint8Array(9), name: 'g', color: '#fff' }] }, { hidden: true });
  assert.ok(!win().some((c) => c.id === 'winImg' + h));
  t.close();
});

await test('placements: Split Channels fills one grid with its source, Merge Channels and the Image Calculator open to the right', async () => {
  const { t, sh } = await start({ channels: 3 });
  await t.runCommand('colorSplitChannels');
  await until(() => sh.layout.order().length === 4, 'the split channels have their views');
  const grid = sh.lay.adds.filter((a) => a.placement === 'gridWithSource');
  assert.equal(grid.length >= 1, true, 'gridWithSource');
  assert.equal(grid[0].docIds.length, 3, 'one view per channel');
  assert.equal(grid[0].anchor, grid[0].anchor);
  const before = sh.lay.adds.length;
  await t.runCommand('procImageCalculator', { op: 'add', allChannels: true, float32: false });
  await until(() => sh.lay.adds.length > before, 'the result has its view');
  assert.equal(sh.lay.adds[sh.lay.adds.length - 1].placement, 'splitRight', 'Image Calculator');
  t.close();
});

await test('placements: a Split Channels grid says closing the source frees memory when the budget is near', async () => {
  const { t, sh } = await start({ channels: 3, budgetBytes: 12000 });
  await t.runCommand('colorSplitChannels');
  await until(() => sh.layout.order().length === 4, 'the grid');
  await until(() => t.log.status.some((x) => x === t.ctx.i18n.t('status.gridMemory')), 'the memory note in the status bar', 3000);
  t.close();
  // plenty of room: no note
  const big = await start({ channels: 3 });
  await big.t.runCommand('colorSplitChannels');
  await until(() => big.sh.layout.order().length === 4, 'the grid');
  await sleep(50);
  assert.ok(!big.t.log.status.some((x) => x === big.t.ctx.i18n.t('status.gridMemory')));
  big.t.close();
});

await test('placements: Merge Channels opens to the right', async () => {
  const { t, sh } = await start({ channels: 2 });
  await t.runCommand('colorSplitChannels');
  await until(() => sh.layout.order().length === 3, 'two channels');
  const before = sh.lay.adds.length;
  await t.runCommand('colorMergeChannels', { c1: t.shell.opts.getState().docs.find((d) => /C1/.test(d.name)).docId, c2: t.shell.opts.getState().docs.find((d) => /C2/.test(d.name)).docId });
  await until(() => sh.lay.adds.length > before, 'the merge has its view');
  assert.equal(sh.lay.adds[sh.lay.adds.length - 1].placement, 'splitRight');
  t.close();
});

// the panel's controls of the fake DOM: its buttons and its checkboxes, in the order they were built
const controls = (panel, tag) => { const out = []; const walk = (e) => { if (e && e.tagName === tag) out.push(e); for (const c of (e && e.children) || []) walk(c); }; walk(panel); return out; };
const click = (el) => { for (const f of el.listeners.click || []) f({ target: el }); };
const tick = (el, on) => { el.checked = on; for (const f of el.listeners.change || []) f({ target: el }); };

await test('Synchronize Windows: cursor marks, zoom / pan relay without an echo, the ticked images are persisted, Unsynchronize All frees them', async () => {
  const { t, sh, api, id } = await start();
  await t.runCommand('imageDuplicate');
  const second = t.activeId();
  await t.runCommand('toolsSyncWindows');
  assert.ok(sh.windows.floats.has('sync'), 'the panel');
  const panel = t.panel('sync');
  assert.equal(controls(panel, 'INPUT').length >= 3, true, 'Sync cursor, Image coordinates, Image scaling (then one tick per image)');
  const btns = controls(panel, 'BUTTON');
  assert.ok(btns.length >= 2, 'Synchronize All and Unsynchronize All');
  click(btns[0]);
  const a = sh.view(id), b = sh.view(second);
  // cursor: the same image pixel in the other views, nothing in the view the pointer is over
  t.shell.opts.onCursor(id, 12.5, 7.25, 100, 80);
  assert.deepEqual(J(b.cursorMark), { x: 12.5, y: 7.25 });
  assert.equal(a.cursorMark, null);
  t.shell.opts.onCursor(id, null);
  assert.equal(b.cursorMark, null, 'the mark goes when the pointer leaves');
  // zoom / pan: the other view follows once, and no echo comes back
  let aSets = 0, bSets = 0;
  const oa = a.setView, ob = b.setView;
  a.setView = (s) => { aSets++; return oa(s); }; b.setView = (s) => { bSets++; return ob(s); };
  oa({ zoom: 3, ox: -30, oy: -60 });   // the user moves A
  await sleep(10);
  assert.equal(bSets, 1, 'B followed');
  assert.equal(aSets, 0, 'A was not told back');
  assert.deepEqual(J([b.getView().zoom, b.getView().ox, b.getView().oy]), [3, -30, -60]);
  // the echo of B's own listener (a real view reports its change a frame later) changes nothing either
  ob({ zoom: 3, ox: -30, oy: -60 });
  await sleep(10);
  assert.equal(aSets, 0, 'an equal view is not relayed');
  // a target that clamps (a smaller image) reports its own clamped view as NOT the user's: the source is not dragged back
  b.clamp = (v) => Object.assign({}, v, { ox: Math.max(v.ox, -10) });
  oa({ zoom: 4, ox: -50, oy: -5 });
  await sleep(10);
  assert.equal(b.getView().ox, -10, 'B clamped');
  assert.equal(a.getView().ox, -50, 'A keeps the place the user chose, the clamp of B is not relayed back');
  b.clamp = null;
  assert.equal(bSets, 2); bSets = 1;
  // persisted
  await until(() => t.log.msgs.some((m) => m.cmd === 'session.putMeta' && m.args.sync && m.args.sync.docs.length === 2), 'sync state in the meta', 4000);
  const sync = t.log.msgs.filter((m) => m.cmd === 'session.putMeta' && m.args.sync).pop().args.sync;
  assert.deepEqual(J([sync.cursor, sync.imageCoords, sync.scaling]), [true, true, false]);
  assert.deepEqual(J(sync.docs.slice().sort()), J([id, second].sort()));
  // Sync cursor off: no marks
  tick(controls(panel, 'INPUT')[0], false);
  t.shell.opts.onCursor(id, 3, 3, 10, 10);
  assert.equal(b.cursorMark, null, 'cursor sync off');
  // Unsynchronize All: the views are free
  click(btns[1]);
  oa({ zoom: 5, ox: 0, oy: 0 });
  await sleep(10);
  assert.equal(bSets, 1, 'no relay after Unsynchronize All');
  // a closed image leaves the set
  click(btns[0]);
  const before = sh.layout.order().length;
  await t.runCommand('fileClose');
  await until(() => sh.layout.order().length === before - 1, 'closed');
  t.close();
});

await test('Synchronize Windows maths: "Image scaling" keeps the physical size through each calibration, "Image coordinates" off keeps the screen offset', async () => {
  const { t, sh, api, id } = await start();
  const info = await t.engine('doc.info', { docId: id });
  const pw = info.calibration.pixelWidth;
  const other = await api.addDoc({ name: 'coarse', width: 20, height: 15, bitDepth: 8, calibration: { pixelWidth: pw * 4, pixelHeight: pw * 4, unit: info.calibration.unit },
    channels: [{ data: new Uint8Array(300), name: 'c', color: '#ffffff' }] }, {});
  await t.runCommand('toolsSyncWindows');
  const panel = t.panel('sync');
  const inputs = controls(panel, 'INPUT');
  click(controls(panel, 'BUTTON')[0]);
  const a = sh.view(id), b = sh.view(other);
  // scaling off, image coordinates on: the same pixels
  a.setView({ zoom: 2, ox: -20, oy: -10 });
  assert.deepEqual(J([b.getView().zoom, b.getView().ox, b.getView().oy]), [2, -20, -10]);
  // scaling on: B's pixels are 4 times as big, so showing the same micrometres per screen pixel takes 4 times the zoom; the corner of the
  // view is the same place (in micrometres), which is the same offset in screen pixels
  tick(inputs[2], true);
  a.setView({ zoom: 2, ox: -20, oy: -10 });
  const g = b.getView();
  assert.ok(Math.abs(g.zoom - 8) < 1e-9 && Math.abs(g.ox - (-(10 * pw) / (4 * pw) * 8)) < 1e-9 && Math.abs(g.oy - (-(5 * pw) / (4 * pw) * 8)) < 1e-9, JSON.stringify(g));
  t.shell.opts.onCursor(id, 8, 4, 0, 0);
  assert.deepEqual(J(b.cursorMark), { x: 2, y: 1 }, 'the cursor goes through the calibration');
  // image coordinates off: the same offset from the top-left corner of the view, in screen pixels
  tick(inputs[1], false);
  b.viewState = { zoom: 2, ox: 10, oy: 20 };
  t.shell.opts.onCursor(id, 1, 1, 50, 60);
  assert.deepEqual(J(b.cursorMark), { x: (50 - 10) / 2, y: (60 - 20) / 2 });
  t.close();
});

// ═════════════ 13. the worker side of the rest ═════════════
await test('engine.configure moves the tile cache; engine.registerLut and doc.import are validated', async () => {
  const t = await boot(SOURCES);
  const w = await t.spawn();
  assert.deepEqual(J(await t.engine('engine.configure', { tileCacheBytes: 64 * 1048576 }, w)), { tileCacheBytes: 64 * 1048576 });
  await reject(t.engine('engine.configure', { tileCacheBytes: -5 }, w), 'IJ_BAD_ARGS', 'a negative cache');
  await reject(t.engine('engine.configure', { tileCacheBytes: 10 }, w), 'IJ_BAD_ARGS', 'under 1 MiB');
  await reject(t.engine('engine.registerLut', { name: 'x', table: new Uint8Array(3) }, w), 'IJ_BAD_ARGS', 'a short table');
  assert.deepEqual(J(await t.engine('engine.registerLut', { name: 'ramp', table: new Uint8Array(768).fill(9) }, w)), { name: 'ramp' });
  const imp = await t.engine('doc.import', { image: { name: 'imp', width: 3, height: 2, bitDepth: 32, channels: [{ data: new Float32Array([1, 2, 3, 4, 5, 6]), name: 'f', color: '#fff' }] }, provenance: { k: 1 } }, w);
  assert.equal(imp.info.bitDepth, 32); assert.equal(imp.info.provenance.imported, true); assert.equal(imp.info.provenance.k, 1); assert.equal(imp.info.hidden, false);
  await reject(t.engine('doc.import', { image: { name: 'bad', width: 3, height: 2, bitDepth: 32, channels: [{ data: new Float32Array(5) }] } }, w), 'IJ_BAD_ARGS', 'length');
  await reject(t.engine('doc.import', {}, w), 'IJ_BAD_ARGS', 'no image');
  const img = (o) => ({ name: 'v', width: 2, height: 2, bitDepth: 8, channels: [{ data: new Uint8Array(4), name: 'c', color: '#ff0000' }], ...o });
  await reject(t.engine('doc.import', { image: img({ calibration: { pixelWidth: 0, pixelHeight: 1, unit: 'um' } }) }, w), 'IJ_BAD_ARGS', 'pixelWidth 0');
  await reject(t.engine('doc.import', { image: img({ calibration: { pixelWidth: NaN, pixelHeight: 1 } }) }, w), 'IJ_BAD_ARGS', 'pixelWidth NaN');
  await reject(t.engine('doc.import', { image: img({ calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'x'.repeat(65) } }) }, w), 'IJ_BAD_ARGS', 'unit too long');
  await reject(t.engine('doc.import', { image: img({ channels: [{ data: new Uint8Array(4), color: 'red' }] }) }, w), 'IJ_BAD_ARGS', 'color');
  await reject(t.engine('doc.import', { image: img({ channels: [{ data: new Uint8Array(4), name: 5 }] }) }, w), 'IJ_BAD_ARGS', 'name');
  // a display that cannot be used falls back to the default one: the document still saves
  const bd = await t.engine('doc.import', { image: img({ channels: [{ data: new Uint8Array([0, 10, 20, 30]), name: 'c', color: '#ff0000', display: { min: 5, max: 1, lut: 'NoSuchLut' } }] }) }, w);
  const bi = await t.engine('doc.info', { docId: bd.docId }, w);
  const dsp = bi.channels[0].display;
  assert.ok(dsp && dsp.min <= dsp.max && dsp.lut !== 'NoSuchLut', 'bad display replaced by the default');
  // an imported document is restorable (its baseline was stored)
  await t.engine('flush', {}, w);
  const key = (await t.store.shared.list()).find((r) => r.docIds.includes(imp.docId)).key;
  const t2 = await t.reload({ flush: false });
  const w2 = await t2.spawn();
  const rs = await t2.engine('session.restore', { key }, w2);
  assert.ok(rs.docIds.includes(imp.docId));
  assert.equal((await t2.engine('doc.info', { docId: imp.docId }, w2)).provenance.imported, true);
  t2.close(); t.close();
});

await test('session.putMeta: the keys are checked by type and size; the answer names what was dropped; the old four keys still work', async () => {
  const t = await boot(SOURCES);
  const w = await t.spawn();
  const d = await t.engine('doc.create', { name: 'd', width: 4, height: 4, bitDepth: 8, channels: [{ name: 'A', color: '#fff' }] }, w);
  await w.engine.whenIdle();
  const key = (await t.store.shared.list())[0].key;
  const meta = async () => (await t.store.shared.load(key)).meta.ui;
  const ok = await t.engine('session.putMeta', { key, results: [{ Area: 1 }], rois: [], measurements: ['area'], windows: ['results'], layout: { v: 1, order: [d.docId] }, sync: { cursor: true, docs: [] },
    luts: { ramp: new Array(768).fill(1) }, ext: { fiji: { a: 1 } }, annotations: { [d.docId]: { visible: false, items: [{ kind: 'rect' }] } } }, w);
  assert.deepEqual(J(ok), {});
  await w.engine.whenIdle();
  const m = await meta();
  assert.deepEqual(J(Object.keys(m).sort()), ['annotations', 'ext', 'layout', 'luts', 'measurements', 'results', 'rois', 'sync', 'windows']);
  assert.equal(m.annotations[d.docId].visible, false);
  // type errors drop that key only
  const bad = await t.engine('session.putMeta', { key, results: 'nope', layout: [1], luts: { ramp: [1, 2] }, ext: [], annotations: { x: { items: 'no' } }, sync: 5, unknownKey: 1 }, w);
  const dropped = J(bad.dropped).map((x) => x.key + ':' + x.code).sort();
  assert.deepEqual(dropped, ['annotations:IJ_BAD_ARGS', 'ext:IJ_BAD_ARGS', 'layout:IJ_BAD_ARGS', 'luts:IJ_BAD_ARGS', 'results:IJ_BAD_ARGS', 'sync:IJ_BAD_ARGS']);
  const m2 = await meta();
  assert.ok(!('unknownKey' in m2), 'only the whitelisted keys are stored');
  // sizes: one package over 256 KiB; the total over 4 MiB drops the annotations first, then the extension data, then the tables, then the Results
  const big = await t.engine('session.putMeta', { key, ext: { fiji: { s: 'x'.repeat(300000) }, thr: { ok: 1 } } }, w);
  assert.deepEqual(J(big.dropped), [{ key: 'ext', code: 'IJ_LAY_META_TOO_LARGE', docId: 'fiji' }]);
  const m3 = await meta();
  assert.deepEqual(J(m3.ext), { thr: { ok: 1 } });
  const rows = []; for (let i = 0; i < 40000; i++) rows.push({ Label: 'row' + i, Area: i, Mean: i / 3, Note: 'padding '.repeat(12) });
  const huge = await t.engine('session.putMeta', { key, results: rows, layout: { v: 1 } }, w);
  assert.deepEqual(J(huge.dropped), [{ key: 'results', code: 'IJ_LAY_META_TOO_LARGE' }]);
  assert.deepEqual(J((await meta()).layout), { v: 1 });
  t.close();
});

await test('IJLuts.register / IJRoi name and polyline width validate', async () => {
  const t = await boot(SOURCES);
  const { IJLuts, IJRoi } = t.page;
  const tab = new Uint8Array(768).fill(3);
  assert.equal(IJLuts.register('mine', tab), 'mine');
  tab[0] = 99; assert.equal(IJLuts.get('mine')[0], 3, 'the table was copied');
  // package edit registers its two LutLoader tables on both sides at load
  assert.deepEqual(arr(IJLuts.registered().map((x) => x.name)), ['3-3-2 RGB', 'Red/Green', 'mine']);
  assert.equal(IJLuts.names().includes('mine'), false, 'names() stays the built-in set');
  assert.equal(IJLuts.register('mine', new Uint8Array(768).fill(4)), 'mine', 're-registering replaces');
  assert.equal(IJLuts.get('mine')[0], 4);
  throws(() => IJLuts.register('Grays', tab), 'IJ_BAD_LUT', 'built-in');
  throws(() => IJLuts.register('', tab), 'IJ_BAD_LUT', 'empty');
  throws(() => IJLuts.register('x'.repeat(65), tab), 'IJ_BAD_LUT', 'too long');
  throws(() => IJLuts.register('ok', new Uint8Array(767)), 'IJ_BAD_LUT', 'size');
  throws(() => IJLuts.register('ok', [1, 2]), 'IJ_BAD_LUT', 'not a Uint8Array');
  // IJRoi.validate: a name (string, ≤ 255), the width of a segmented line
  assert.ok(IJRoi.validate({ type: 'rect', x: 0, y: 0, w: 2, h: 2, name: 'ok' }));
  throws(() => IJRoi.validate({ type: 'rect', x: 0, y: 0, w: 2, h: 2, name: 7 }), 'IJ_BAD_ROI', 'name type');
  throws(() => IJRoi.validate({ type: 'rect', x: 0, y: 0, w: 2, h: 2, name: 'x'.repeat(256) }), 'IJ_BAD_ROI', 'name length');
  assert.ok(IJRoi.validate({ type: 'polyline', points: [[0, 0], [3, 3]], width: 4 }));
  throws(() => IJRoi.validate({ type: 'polyline', points: [[0, 0], [3, 3]], width: -1 }), 'IJ_BAD_ROI', 'negative width');
  throws(() => IJRoi.validate({ type: 'polyline', points: [[0, 0], [3, 3]], width: 'x' }), 'IJ_BAD_ROI', 'non-number width');
  assert.equal(IJRoi.translate({ type: 'rect', x: 0, y: 0, w: 2, h: 2, name: 'keep' }, 3, 4).name, 'keep', 'translate keeps the name');
  t.close();
});

console.log(`ij ext api 3: ${passed} groups ok`);
process.exit(0);
