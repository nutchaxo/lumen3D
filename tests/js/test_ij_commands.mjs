// Command registry of the Advanced Studio controller (js/modules/studio/advanced-studio/ij-app.js)
// and of the packages that extend it (ij-cmds-<pkg>.js, through IJApp.extend).
//
// Checks, without a browser: every command (v1 and package) has a menu path, a unique `order` in
// its (sub)menu and a label in all four plugin lang files — the lang files being merged with the
// `lang-parts/<pkg>.json` of the packages while those exist (format: { en: {…}, fr: {…}, es: {…},
// nl: {…} }; a key defined twice with another value fails) — shortcuts are unique and none is a
// key the browser keeps, every v1 run() reaches a method of the app facade and every package
// run() only calls members of the documented extension API (against a recording api), enabled()
// follows the state (no image, 32-bit Apply, no selection, busy), every literal lang key the
// controller and the package files read exists (namespaces cmd. op. menu. meas. tool. res. err.
// dlg.<prefix>.), and the pure helpers (shortcut matching, level plan, slice range, B&C slider
// arithmetic).
//
// Run: node tests/js/test_ij_commands.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadModule, ROOT } from './harness.mjs';

// Values built inside the vm context come from another realm: compare them as JSON.
const same = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const SRC = readFileSync(path.join(DIR, 'ij-app.js'), 'utf8');
// One context: the controller, then every package's command file (they call IJApp.extend at load).
const CMD_FILES = readdirSync(DIR).filter((f) => /^ij-cmds-[a-z0-9]+\.js$/.test(f)).sort();
const PROC_FILES = readdirSync(DIR).filter((f) => /^ij-proc-[a-z0-9]+\.js$/.test(f)).sort();
const ctx = vm.createContext({ console, setTimeout, clearTimeout });
vm.runInContext(SRC + '\n;globalThis.__IJApp = IJApp;', ctx, { filename: 'ij-app.js' });
for (const f of CMD_FILES) vm.runInContext(readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
const IJApp = ctx.__IJApp;
assert.ok(IJApp, 'IJApp loads without a DOM');

const readJson = (f) => JSON.parse(readFileSync(path.join(DIR, f), 'utf8'));
const LANGS = ['en', 'fr', 'es', 'nl'];
const lang = Object.fromEntries(LANGS.map((c) => [c, readJson(`lang/${c}.json`)]));
const baseLang = JSON.parse(JSON.stringify(lang));
// lang-parts/<pkg>.json: { en: {...}, fr: {...}, es: {...}, nl: {...} } merged under the base dictionaries.
const PARTS_DIR = path.join(DIR, 'lang-parts');
if (existsSync(PARTS_DIR)) {
  const merge = (dst, src, where) => {
    for (const k of Object.keys(src)) {
      if (src[k] && typeof src[k] === 'object') { if (dst[k] === undefined) dst[k] = {}; assert.ok(typeof dst[k] === 'object', `${where}.${k} is a section`); merge(dst[k], src[k], `${where}.${k}`); }
      else {
        if (dst[k] !== undefined) assert.equal(dst[k], src[k], `lang key ${where}.${k} is defined twice with another value`);
        dst[k] = src[k];
      }
    }
  };
  for (const f of readdirSync(PARTS_DIR).filter((x) => x.endsWith('.json')).sort()) {
    const part = JSON.parse(readFileSync(path.join(PARTS_DIR, f), 'utf8'));
    for (const c of LANGS) { assert.ok(part[c], `lang-parts/${f} has the language ${c}`); merge(lang[c], part[c], `${c}`); }
  }
}
const resolve = (o, k) => k.split('.').reduce((a, c) => (a && a[c] !== undefined ? a[c] : undefined), o);
const leafKeys = (o, prefix = '', out = new Set()) => {
  for (const k of Object.keys(o)) {
    const v = o[k], kp = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') leafKeys(v, kp, out); else out.add(kp);
  }
  return out;
};

// ── manifest ──
const pj = readJson('plugin.json');
assert.equal(pj.id, 'advanced-studio');
assert.equal(pj.placement, 'studio');
assert.deepEqual(pj.i18nLanguages, LANGS);
// PLAN-wave3 §2.8: the final order — the 17 packages (7 of wave 2, 9 tool packages, the library), the view, the layout, the controller, the commands
const PKGS = ['bg', 'filters', 'seg', 'multi', 'geom', 'roi', 'coloc', 'thr', 'enh', 'fft', 'sel', 'io', 'ov', 'ana', 'edit', 'fiji', 'lib'];
assert.deepEqual(pj.scripts, ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', ...PKGS.map((k) => `ij-proc-${k}.js`), 'ij-view.js', 'ij-layout.js', 'ij-app.js',
  ...PKGS.map((k) => `ij-cmds-${k}.js`)], 'plugin.json#scripts: the final order');
for (const f of pj.scripts) assert.ok(existsSync(path.join(DIR, f)), `${f} exists`);
same(IJApp.WORKER_SCRIPTS, ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-engine.js', ...PKGS.map((k) => `ij-proc-${k}.js`)],
  'the worker loads the mandatory scripts, then every package file');
assert.deepEqual(pj.styles, ['ij-style.css']);
assert.deepEqual(pj.contexts, ['page']);
assert.ok(pj.platformCompat.includes('1.83.0'));

// ── lang parity ──
const enKeys = leafKeys(lang.en);
for (const c of LANGS) {
  const keys = leafKeys(lang[c]);
  assert.deepEqual([...keys].sort(), [...enKeys].sort(), `${c}.json has the key set of en.json`);
  for (const k of keys) assert.ok(String(resolve(lang[c], k)).length > 0, `${c}:${k} is empty`);
}
// {tokens} must be the same set in every language.
const tokens = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
for (const k of enKeys) {
  for (const c of LANGS) assert.equal(tokens(resolve(lang[c], k)), tokens(resolve(lang.en, k)), `${c}:${k} keeps its {tokens}`);
}

// ── registry shape ──
const VP = loadModule('js/modules/studio/advanced-studio/ij-view.js', 'IJViewPure', {});
const VP_TOP = Array.from(VP.TOP_ORDER);
const COMMANDS = IJApp.COMMANDS;
assert.ok(COMMANDS.length >= 80, 'the registry holds every PLAN §2.1/§2.2 entry');
const V1 = COMMANDS.filter((c) => !c.ext);
assert.ok(V1.length >= 80);
const ids = new Set();
for (const c of COMMANDS) {
  assert.ok(!ids.has(c.id), `duplicate command id ${c.id}`);
  ids.add(c.id);
  assert.ok(/^[A-Za-z0-9]+$/.test(c.id), `${c.id}: ids carry no dot (they are lang keys)`);
  assert.ok(Array.isArray(c.menu) && c.menu.length >= 1 && c.menu.every((s) => typeof s === 'string' && s), `${c.id}: menu path`);
  assert.equal(c.labelKey, `cmd.${c.id}`);
  assert.ok(typeof c.order === 'number' && Number.isFinite(c.order), `${c.id}: a numeric menu order`);
  assert.equal(typeof c.enabled, 'function', `${c.id}: enabled()`);
  assert.equal(typeof c.run, 'function', `${c.id}: run()`);
  for (const code of LANGS) assert.ok(typeof resolve(lang[code], c.labelKey) === 'string', `${code}: ${c.labelKey}`);
  for (const seg of c.menu) for (const code of LANGS) assert.ok(typeof resolve(lang[code], `menu.${seg}`) === 'string', `${code}: menu.${seg}`);
}

// Menu positions: inside one (sub)menu the orders (commands and submenus together) are unique, and every
// submenu a command sits in has its position in GROUP_META (the frozen table of PLAN-wave2 §1).
{
  const lists = new Map(); // path → [[label, order]]
  const add = (p, label, order) => { if (!lists.has(p)) lists.set(p, []); lists.get(p).push([label, order]); };
  for (const c of COMMANDS) {
    add(c.menu.join('/'), c.id, c.order);
    for (let k = 2; k <= c.menu.length; k++) {
      const gp = c.menu.slice(0, k).join('/');
      assert.ok(IJApp.GROUP_META[gp] && typeof IJApp.GROUP_META[gp].order === 'number', `${c.id}: submenu ${gp} has a position in GROUP_META`);
    }
  }
  for (const [gp, meta] of Object.entries(IJApp.GROUP_META)) add(gp.split('/').slice(0, -1).join('/'), 'group ' + gp, meta.order);
  for (const [p, list] of lists) {
    const seenOrder = new Map();
    for (const [label, order] of list) {
      assert.ok(!seenOrder.has(order), `menu ${p}: ${label} and ${seenOrder.get(order)} share the order ${order}`);
      seenOrder.set(order, label);
    }
  }
}

// Top-level menus appear in ImageJ's order.
const tops = [];
for (const c of COMMANDS) if (!tops.includes(c.menu[0])) tops.push(c.menu[0]);
assert.deepEqual(tops.filter((n) => n !== 'Plugins'), ['File', 'Edit', 'Image', 'Process', 'Analyze', 'Window', 'Help']);
assert.ok(VP_TOP.indexOf('Plugins') > VP_TOP.indexOf('Analyze') && VP_TOP.indexOf('Plugins') < VP_TOP.indexOf('Window'), 'Plugins sits between Analyze and Window');

// Every entry of PLAN §2.1 / §2.2 is there.
const mustHave = ['fileOpen', 'fileSaveTiff', 'fileSavePng', 'fileSaveResults', 'fileRevert', 'fileRecover', 'fileClose', 'fileSimple', 'fileCloseStudio',
  'editUndo', 'editRedo', 'editInvert', 'editSelectAll', 'editSelectNone', 'editRestoreSelection', 'editMakeInverse', 'editClear', 'editClearOutside', 'editFill',
  'typeBit8', 'typeBit16', 'typeBit32', 'adjustBC', 'adjustThreshold', 'imageInfo', 'imageCrop', 'imageDuplicate', 'colorChannels', 'stackProject',
  'transformFlipH', 'transformFlipV', 'transformRotateRight', 'transformRotateLeft', 'zoomIn', 'zoomOut', 'zoomOriginal', 'zoomToSelection', 'zoomFit',
  'binMask', 'binFillHoles', 'binErode', 'binDilate', 'binOpen', 'binClose',
  'mathAdd', 'mathSubtract', 'mathMultiply', 'mathDivide', 'mathMin', 'mathMax', 'mathAbs', 'mathSet',
  'filterGaussian', 'filterMedian', 'filterMean', 'filterMinimum', 'filterMaximum',
  'analyzeMeasure', 'analyzeSetMeasurements', 'analyzeParticles', 'analyzeHistogram', 'analyzePlotProfile', 'toolsRoiManager', 'helpAbout', 'helpShortcuts'];
for (const id of mustHave) assert.ok(ids.has(id), `missing command ${id}`);
for (const n of ['Grays', 'Red', 'Green', 'Blue', 'Cyan', 'Magenta', 'Yellow', 'Fire', 'Ice', 'Spectrum', '16Colors', 'HiLo', 'Invert']) {
  assert.ok(ids.has('lut' + n), `missing lookup table entry ${n}`);
}
assert.equal(IJApp.LUT_NAMES.length, 12);

// ── shortcuts ──
// The shell (ij-view.js) owns the keyboard: it indexes each command's `shortcut` through
// IJViewPure.normalizeShortcut and matches events with IJViewPure.shortcutFromEvent. The test
// uses those two functions, so what it checks is what the shell will do.
assert.equal(typeof VP.normalizeShortcut, 'function');
const RESERVED = new Set(['Ctrl+W', 'Ctrl+T', 'Ctrl+N', 'Ctrl+H', 'Ctrl+Q', 'Ctrl+R', 'Ctrl+L', 'Ctrl+P', 'Ctrl+D', 'Ctrl+F', 'Ctrl+Shift+C', 'Ctrl+Shift+I',
  'Ctrl+Shift+D', 'Ctrl+Shift+A', 'Ctrl+Shift+N', 'Ctrl+Shift+T', 'Ctrl+Shift+W', 'Ctrl+Tab', 'F5', 'F11', 'F12', 'Alt+F4', 'Escape'].map((k) => VP.normalizeShortcut(k)));
const seen = new Map();
for (const c of COMMANDS) {
  if (!c.shortcut) { assert.equal(c.keys.length, 0, `${c.id}: keys without a shortcut`); continue; }
  assert.ok(c.keys.length >= 1, `${c.id}: shortcut without keys`);
  assert.ok(c.keys.includes(c.shortcut), `${c.id}: the displayed shortcut is one of its keys`);
  for (const k of c.keys) {
    const n = VP.normalizeShortcut(k);
    assert.ok(n, `${c.id}: ${k} is a key spec`);
    assert.ok(!RESERVED.has(n), `${c.id}: ${k} is a key the browser keeps`);
    assert.ok(!/^Ctrl\+(Shift\+)?[wtnh]$/i.test(k), `${c.id}: never Ctrl+W/T/N/H`);
    assert.ok(!seen.has(n), `${c.id}: ${k} already used by ${seen.get(n)}`);
    seen.set(n, c.id);
  }
}
for (const [spec, id] of [['m', 'analyzeMeasure'], ['t', 'editAddToManager'], ['h', 'analyzeHistogram'], ['k', 'analyzePlotProfile'], ['Shift+C', 'adjustBC'],
  ['Shift+T', 'adjustThreshold'], ['Shift+I', 'editInvert'], ['Shift+X', 'imageCrop'], ['Shift+D', 'imageDuplicate'], ['Shift+A', 'editSelectNone'],
  ['Shift+E', 'editRestoreSelection'], ['+', 'zoomIn'], ['-', 'zoomOut'], ['Ctrl+Z', 'editUndo'], ['Ctrl+Shift+Z', 'editRedo'], ['Ctrl+Y', 'editRedo'],
  ['Ctrl+S', 'fileSaveTiff'], ['Ctrl+A', 'editSelectAll'], [']', 'windowShowAll']]) {
  assert.equal(seen.get(VP.normalizeShortcut(spec)), id, `PLAN §2.3: ${spec} → ${id}`);
}

// Real keyboard events land on the registry the way the shell matches them.
const ev = (key, mods = {}) => ({ key, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: !!mods.meta });
const hit = (e) => seen.get(VP.shortcutFromEvent(e));
assert.equal(hit(ev('m')), 'analyzeMeasure');
assert.equal(hit(ev('M', { shift: true })), undefined, 'Shift+M is not bound');
assert.equal(hit(ev('C', { shift: true })), 'adjustBC');
assert.equal(hit(ev('z', { ctrl: true })), 'editUndo');
assert.equal(hit(ev('Z', { ctrl: true, shift: true })), 'editRedo');
assert.equal(hit(ev('y', { ctrl: true })), 'editRedo');
assert.equal(hit(ev('z', { meta: true })), 'editUndo', 'Cmd acts as Ctrl');
assert.equal(hit(ev('+', { shift: true })), 'zoomIn', 'the + key is Shift+= on a US layout');
assert.equal(hit(ev('=')), 'zoomIn', 'the shell reads = as +');
assert.equal(hit(ev('-')), 'zoomOut');
assert.equal(hit(ev('w', { ctrl: true })), undefined);
assert.equal(hit(ev('t', { ctrl: true })), undefined, 'Ctrl+T is left to the browser');
assert.equal(hit(ev('n', { ctrl: true })), undefined);
assert.equal(hit(ev('h', { ctrl: true })), undefined);
assert.equal(hit(ev('t')), 'editAddToManager');


// ── every run() reaches a method of the facade ──
const apiBlock = /const API = \{([\s\S]*?)\n  \};/.exec(SRC);
assert.ok(apiBlock, 'API facade found');
const apiNames = new Set();
for (const m of (apiBlock[1] + ' ,').matchAll(/(?:^|[\s,{])(\w+)(?=\s*[:,}\n])/g)) apiNames.add(m[1]);
for (const c of V1) {
  const called = [];
  const app = new Proxy({}, { get: (_, name) => (...args) => { called.push(String(name)); return undefined; } });
  c.run(app);
  assert.equal(called.length, 1, `${c.id}: run() makes exactly one call on the app`);
  assert.ok(apiNames.has(called[0]), `${c.id}: app.${called[0]} is in the API facade`);
}
// A package command talks to the documented extension API, nothing else.
const EXT_MEMBERS = new Set(IJApp.EXT_API_MEMBERS);
for (const m of ['tr', 'state', 'dialog', 'run', 'compute', 'estimate', 'preview', 'cancelPreview', 'overlay', 'clearOverlay', 'setRoi', 'addResults', 'openTable', 'openPlot', 'openTool', 'setDisplay', 'toast', 'error', 'rename',
  'openPanel', 'closePanel', 'on', 'annotations', 'settings', 'sessionData', 'commands', 'runCommand', 'lastCommand', 'call', 'adopt', 'putBlob', 'setPending', 'clearPending', 'addDoc', 'closeDoc', 'view', 'setTool',
  'setThreshold', 'colorValue', 'registerLut', 'pickFile', 'saveFile', 'copyText', 'renderPng', 'profile', 'roiManager']) {
  assert.ok(EXT_MEMBERS.has(m), `the extension API has ${m}`);
}
// Runs a package command against a recording api. A member that is not documented throws an AssertionError
// from inside the Proxy — also from an async command, after its first await: that rejection is NOT swallowed.
async function runRecorded(c) {
  const called = [];
  const state = { doc: null, docs: [], roi: null, busy: false, activeChannel: 0, threshold: null, measurements: [], lineWidth: 1, roiList: [], resultsCount: 0 };
  const nested = (member) => new Proxy({}, { get: (_, sub) => (...args) => { called.push(String(member) + '.' + String(sub)); return Promise.resolve(null); } });
  const api = new Proxy({}, { get: (_, name) => {
    assert.ok(EXT_MEMBERS.has(String(name)), `${c.id}: api.${String(name)} is not a documented member of the extension API`);
    // members that hold a set of functions (api.annotations.add(...), api.settings.get(...)) answer with a recording object of their own
    if (['annotations', 'settings', 'sessionData', 'roiManager'].includes(String(name))) return nested(name);
    return (...args) => {
      called.push(String(name));
      if (name === 'state') return state;
      if (name === 'tr') return String(args[0]);
      return Promise.resolve(null);
    };
  } });
  try { await c.run(api); } catch (err) { if (err && err.code === 'ERR_ASSERTION') throw err; /* the recording api answers null: a command may fail on it */ }
  return called;
}
for (const c of COMMANDS.filter((x) => x.ext)) {
  const called = await runRecorded(c);
  assert.ok(called.length >= 1, `${c.id}: run() calls the extension API at least once`);
}
// the check itself can fail: a sync call and an async call (after an await) on an undocumented member
await assert.rejects(runRecorded({ id: 'fakeSync', run: (api) => api.bogus() }), /not a documented member/);
await assert.rejects(runRecorded({ id: 'fakeAsync', run: async (api) => { await api.dialog({}); api.bogus(); } }), /not a documented member/);

// ── enabled() rules ──
const img = (bitDepth, extra) => Object.assign({ docId: 1, name: 'x', width: 10, height: 10, bitDepth, channels: [{ name: 'a' }], calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'µm' } }, extra);
const state = (o) => Object.assign({ doc: null, roi: null, prevRoi: null, busy: false, nDocs: 0, canUndo: false, canRedo: false, dirty: false, hasResults: false, canProject: true }, o);
const by = Object.fromEntries(COMMANDS.map((c) => [c.id, c]));
const en = (id, st) => by[id].enabled(st);

// no image
const none = state({});
const needsImage = V1.filter((c) => !['fileOpen', 'fileRecover', 'fileSimple', 'fileCloseStudio', 'stackProject', 'analyzeSetMeasurements', 'toolsRoiManager',
  'windowResults', 'windowRoiManager', 'helpAbout', 'helpShortcuts', 'windowNext', 'windowPrevious', 'analyzeClearResults', 'fileSaveResults'].includes(c.id));
for (const c of needsImage) assert.equal(c.enabled(none), false, `${c.id} is disabled without an image`);
for (const id of ['fileOpen', 'fileRecover', 'fileSimple', 'fileCloseStudio', 'stackProject', 'analyzeSetMeasurements', 'toolsRoiManager', 'helpAbout', 'helpShortcuts']) {
  assert.equal(en(id, none), true, `${id} works without an image`);
}
assert.equal(en('stackProject', state({ canProject: false })), false, 'Z Project needs a figure the source can read');
assert.equal(en('fileSaveResults', none), false);
assert.equal(en('fileSaveResults', state({ hasResults: true })), true);
assert.equal(en('analyzeClearResults', state({ hasResults: true })), true);
assert.equal(en('windowNext', state({ nDocs: 1 })), false);
assert.equal(en('windowNext', state({ nDocs: 2 })), true);

// 32-bit: Apply LUT refused, type entry of the current depth disabled
const s32 = state({ doc: img(32) });
assert.equal(en('lutApply', s32), false, 'Apply is not available on 32-bit');
assert.equal(en('lutApply', state({ doc: img(8) })), true);
assert.equal(en('lutApply', state({ doc: img(16) })), true);
assert.equal(en('typeBit32', s32), false);
assert.equal(en('typeBit8', s32), true);
assert.equal(en('typeBit16', state({ doc: img(16) })), false);
assert.equal(en('adjustBC', s32), true);

// binary operations need 8 bits; Convert to Mask works from any depth
for (const id of ['binFillHoles', 'binErode', 'binDilate', 'binOpen', 'binClose', 'analyzeParticles']) {
  assert.equal(en(id, state({ doc: img(8) })), true, `${id} on 8-bit`);
  assert.equal(en(id, state({ doc: img(16) })), false, `${id} on 16-bit`);
  assert.equal(en(id, state({ doc: img(32) })), false, `${id} on 32-bit`);
}
assert.equal(en('binMask', state({ doc: img(16) })), true);

// selection rules
const rect = { type: 'rect', x: 1, y: 1, w: 3, h: 3 };
const line = { type: 'line', x1: 0, y1: 0, x2: 5, y2: 5, width: 1 };
const pt = { type: 'point', points: [[1, 1]] };
const withDoc = (roi, o) => state(Object.assign({ doc: img(8), roi }, o));
for (const id of ['editClear', 'editClearOutside', 'imageCrop', 'zoomToSelection', 'editMakeInverse']) {
  assert.equal(en(id, withDoc(null)), false, `${id} needs a selection`);
  assert.equal(en(id, withDoc(rect)), true, `${id} with an area selection`);
  assert.equal(en(id, withDoc(line)), false, `${id}: a line is not an area`);
  assert.equal(en(id, withDoc(pt)), false, `${id}: a point is not an area`);
}
assert.equal(en('editSelectNone', withDoc(null)), false);
assert.equal(en('editSelectNone', withDoc(rect)), true);
assert.equal(en('editAddToManager', withDoc(null)), false);
assert.equal(en('editAddToManager', withDoc(line)), true);
assert.equal(en('analyzePlotProfile', withDoc(rect)), true, 'Plot Profile takes a rectangle (the column average) since wave 3');
assert.equal(en('analyzePlotProfile', withDoc({ type: 'oval', x: 1, y: 1, w: 4, h: 4 })), false, 'Plot Profile needs a line or a rectangle');
assert.equal(en('analyzePlotProfile', withDoc(null)), false);
assert.equal(en('analyzePlotProfile', withDoc(line)), true);
assert.equal(en('editRestoreSelection', withDoc(null)), false);
assert.equal(en('editRestoreSelection', withDoc(null, { prevRoi: rect })), true);
assert.equal(en('editFill', withDoc(null)), true, 'Fill works on the whole image without a selection');
assert.equal(en('analyzeMeasure', withDoc(null)), true, 'Measure takes the whole image without a selection');

// undo / redo / revert follow history and dirtiness
assert.equal(en('editUndo', withDoc(null)), false);
assert.equal(en('editUndo', withDoc(null, { canUndo: true })), true);
assert.equal(en('editRedo', withDoc(null, { canUndo: true })), false);
assert.equal(en('editRedo', withDoc(null, { canRedo: true })), true);
assert.equal(en('fileRevert', withDoc(null)), false);
assert.equal(en('fileRevert', withDoc(null, { dirty: true })), true);

// a running operation disables every document command (Cancel is the only way out)
const busy = withDoc(rect, { busy: true, canUndo: true, canRedo: true, dirty: true, hasResults: true, nDocs: 3 });
for (const c of V1) {
  if (['fileSimple', 'fileCloseStudio', 'analyzeSetMeasurements', 'toolsRoiManager', 'windowResults', 'windowRoiManager', 'helpAbout', 'helpShortcuts', 'windowNext', 'windowPrevious', 'analyzeClearResults',
    'windowShowAll', 'windowPutBehind', 'windowCascade', 'windowTile', 'toolsSyncWindows'].includes(c.id)) continue;
  assert.equal(c.enabled(busy), false, `${c.id} is disabled while an operation runs`);
}

// ── every literal lang key the controller reads exists ──
const used = new Set();
for (const m of SRC.matchAll(/\btr\('([a-zA-Z0-9_.]+)'(?!\s*\+)/g)) used.add(m[1]);
for (const m of SRC.matchAll(/labelKey: '([a-zA-Z0-9_.]+)'/g)) used.add(m[1]);
// The package files: tr('…') / api.tr('…'), labelKey / stepKey, tick(…, 'op.x'), 'op.' + name. Their keys live in the
// namespaces cmd. op. menu. meas. tool. res. err. dlg.<prefix>. — or are keys the base dictionaries already hold.
const PREFIX = { bg: 'bg', filters: 'flt', seg: 'seg', multi: 'multi', geom: 'geom', roi: 'roi', coloc: 'coloc', thr: 'thr', enh: 'enh', fft: 'fft', sel: 'sel', io: 'io', ov: 'ov', ana: 'ana',
  edit: 'edit', fiji: 'fiji', lib: 'lib' };
// PLAN-wave3 §1.3: the packages may also use the keys of warnings, the About box and the shell's menu names
const NAMESPACES = ['cmd.', 'op.', 'menu.', 'meas.', 'tool.', 'res.', 'err.', 'warn.', 'about.', 'view.menu.'];
for (const f of [...CMD_FILES, ...PROC_FILES]) {
  const pkg = /^ij-(?:cmds|proc)-([a-z0-9]+)\.js$/.exec(f)[1];
  const text = readFileSync(path.join(DIR, f), 'utf8');
  const keys = new Set();
  for (const m of text.matchAll(/\b(?:api\.)?tr\('([a-zA-Z0-9_.]+)'(?!\s*\+)/g)) keys.add(m[1]);
  for (const m of text.matchAll(/\b(?:labelKey|stepKey|titleKey): '([a-zA-Z0-9_.]+)'/g)) keys.add(m[1]);
  for (const m of text.matchAll(/\btick\([^)]*?'(op\.[A-Za-z0-9]+)'/g)) keys.add(m[1]);
  // Every other string literal that LOOKS like a key of the namespaces: the messages a dialog's validate() returns,
  // unitsKey, option labels... (comments are dropped first).
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
  for (const m of code.matchAll(/'((?:cmd|op|menu|meas|tool|res|err|warn|about|view\.menu|dlg\.[a-z]+)\.[A-Za-z0-9_.]*[A-Za-z0-9_])'/g)) keys.add(m[1]);
  for (const k of keys) {
    const ok = NAMESPACES.some((n) => k.startsWith(n)) || k.startsWith('dlg.' + PREFIX[pkg] + '.') || resolve(baseLang.en, k) !== undefined;
    assert.ok(ok, `${f}: key ${k} is outside the namespaces a package may use`);
    used.add(k);
  }
}
for (const m of SRC.matchAll(/ERROR_KEYS = \{([\s\S]*?)\};/g)) for (const k of m[1].matchAll(/'(err\.[A-Za-z0-9]+)'/g)) used.add(k[1]);
used.delete('cmd.'); // prefix of a computed key
for (const k of used) {
  if (k.endsWith('.')) continue;
  for (const code of LANGS) assert.ok(typeof resolve(lang[code], k) === 'string', `${code}: lang key ${k} read by ij-app.js`);
}
// Computed keys: op.<name>, proj.<method>, meas.<group>, cmd.<id>, tool.<id>, step.<k> (optional).
for (const op of ['invert', 'math', 'fill', 'clear', 'clearOutside', 'crop', 'flipH', 'flipV', 'rotate90', 'convert', 'applyLut', 'gaussian', 'rank', 'binary', 'toMask',
  'duplicate', 'histogram', 'measure', 'open', 'particles', 'profile', 'restore', 'revert', 'undo', 'redo']) {
  assert.ok(typeof resolve(lang.en, `op.${op}`) === 'string', `op.${op}`);
}
for (const m of ['max', 'min', 'sum', 'avg', 'sd', 'median']) assert.ok(typeof resolve(lang.en, `proj.${m}`) === 'string', `proj.${m}`);
for (const g of Object.keys(IJApp.MEASURE_GROUPS)) assert.ok(typeof resolve(lang.en, `meas.${g}`) === 'string', `meas.${g}`);
for (const t of IJApp.TOOLS) if (!t.separator) assert.ok(typeof resolve(lang.en, t.labelKey) === 'string', t.labelKey);
for (const k of Object.values(IJApp.ERROR_KEYS)) assert.ok(typeof resolve(lang.en, k) === 'string', k);
// No raw error text reaches the DOM: nothing in the controller writes err.message to a node.
assert.ok(!/\.(textContent|innerText|innerHTML)\s*=\s*[^;]*\.message/.test(SRC), 'err.message never goes to the DOM');
assert.ok(!/text:\s*[a-zA-Z_.]*err[a-zA-Z_.]*\.message/.test(SRC), 'err.message is never a text node');
assert.ok(!/innerHTML/.test(SRC), 'no innerHTML in the controller');

// ── error keys ──
assert.equal(IJApp.errorKey({ code: 'IJ_OVER_BUDGET' }), 'err.overBudget');
assert.equal(IJApp.errorKey({ code: 'IJ_NOT_32BIT' }), 'err.not32bit');
assert.equal(IJApp.errorKey({ code: 'STUDIO_FRAME_LOST' }), 'err.frameLost');
assert.equal(IJApp.errorKey({ code: 'SOMETHING_ELSE' }), '');
assert.equal(IJApp.errorKey(new Error('x')), '');
assert.equal(IJApp.errorKey(null), '');

// ── Z Project planning ──
assert.equal(IJApp.outputBitDepth('max', 500), 8);
assert.equal(IJApp.outputBitDepth('min', 3), 8);
assert.equal(IJApp.outputBitDepth('sum', 257), 16);
assert.equal(IJApp.outputBitDepth('sum', 258), 32);
assert.equal(IJApp.outputBitDepth('avg', 2), 32);
assert.equal(IJApp.outputBitDepth('sd', 2), 32);
assert.equal(IJApp.outputBitDepth('median', 2), 32);

const desc = { channels: [{}, {}, {}], levels: [
  { level: 2, width: 1024, height: 1024, indices: [0, 1] },
  { level: 0, width: 5735, height: 5735, indices: [0, 1, 2, 3] },
  { level: 1, width: 2868, height: 2868, indices: [0, 1] }] };
const plan8 = IJApp.planLevels(desc, 512 * 1048576, 8);
same(plan8.map((l) => l.level), [0, 1, 2], 'finest first, whatever the order of the description');
assert.equal(plan8[0].bytes8, 5735 * 5735 * 3);
assert.equal(plan8[0].bytes32, 5735 * 5735 * 3 * 4);
assert.equal(plan8[0].fits, 5735 * 5735 * 3 * 2 <= 512 * 1048576, 'native 8-bit x3 plus one undo step vs 512 MiB');
assert.equal(plan8[1].fits, true);
const plan32 = IJApp.planLevels(desc, 512 * 1048576, 32);
assert.equal(plan32[0].fits, false, 'native 32-bit x3 does not fit 512 MiB');
assert.equal(plan32[1].fits, 2868 * 2868 * 3 * 4 * 2 <= 512 * 1048576);
assert.equal(plan32[2].fits, true);

same(IJApp.mapRange(1, 200, 200, 200), [0, 200]);
same(IJApp.mapRange(10, 20, 200, 200), [9, 20], 'slices 10..20 inclusive');
same(IJApp.mapRange(1, 200, 200, 100), [0, 100], 'the whole range on a level with half the planes');
same(IJApp.mapRange(101, 200, 200, 100), [50, 100]);
same(IJApp.mapRange(7, 7, 200, 100), [3, 4], 'a one-slice range keeps one plane at a coarser level');
same(IJApp.mapRange(1, 1, 1, 1), [0, 1]);

// ── Brightness/Contrast slider arithmetic (ImageJ ContrastAdjuster) ──
const B = IJApp.bcMath;
assert.equal(B.range, 256);
// Full range ⇒ contrast slider in the middle, brightness in the middle.
assert.ok(Math.abs(B.contrastToPos(0, 255, 0, 255) - 128) < 1e-9);
assert.ok(Math.abs(B.brightnessToPos(0, 255, 0, 255) - 128) < 1e-9);
// Round trips: positions → window → positions.
for (const pos of [10, 64, 128, 190, 250]) {
  const w = B.fromContrast(pos, 40, 200, 0, 255);
  const back = B.contrastToPos(w.min, w.max, 0, 255);
  assert.ok(Math.abs(back - pos) < 1e-6, `contrast ${pos} → ${back}`);
}
for (const pos of [10, 100, 128, 200, 250]) {
  const w = B.fromBrightness(pos, 40, 200, 0, 255);
  assert.ok(Math.abs(w.max - w.min - 160) < 1e-9, 'brightness keeps the window width');
  assert.ok(Math.abs(B.brightnessToPos(w.min, w.max, 0, 255) - pos) < 1e-6);
}
// More contrast narrows the window around its centre.
const narrow = B.fromContrast(200, 0, 255, 0, 255), wide = B.fromContrast(60, 0, 255, 0, 255);
assert.ok(narrow.max - narrow.min < 255 && wide.max - wide.min > 255);

// ── measurement keys ──
same(IJApp.measurementKeys(['area', 'mean', 'minMax'], false), ['area', 'mean', 'min', 'max']);
same(IJApp.measurementKeys(['area'], true), ['area', 'length', 'angle']);

// ── the controller only calls what ij-view.js provides ──
const VIEW = readFileSync(path.join(DIR, 'ij-view.js'), 'utf8').split('\r\n').join('\n');
const returnedNames = (anchor) => {
  const i = VIEW.indexOf(anchor);
  assert.ok(i >= 0, `ij-view.js: ${anchor}`);
  const j = VIEW.indexOf('\n    };', i);
  const names = new Set();
  for (const m of (VIEW.slice(i, j) + " ,").matchAll(/(?:^|[\s,{])(\w+)(?=\s*[:,(\n}])/g)) names.add(m[1]);
  return names;
};
const shellApi = returnedNames('return {\n      el: shell, workspace: wsHost');
const windowsApi = returnedNames('return {\n      dialog, floating, confirm');
// IJView (ij-layout.js): the members of the object it returns, plus the ones of IJLayout the controller reaches through shell.layout
const LAYOUT = readFileSync(path.join(DIR, 'ij-layout.js'), 'utf8').split('\r\n').join('\n');
const namesOf = (anchor, endMark) => {
  const i = LAYOUT.indexOf(anchor);
  assert.ok(i >= 0, `ij-layout.js: ${anchor}`);
  const j = LAYOUT.indexOf(endMark, i);
  const names = new Set();
  for (const m of (LAYOUT.slice(i, j) + ' ,').matchAll(/(?:^|[\s,{])(\w+)(?=\s*[:,(\n}])/g)) names.add(m[1]);
  return names;
};
const viewApi = namesOf('Object.assign(self, {', '\n    });');
const layoutApi = namesOf('    const api = {\n      el: ws,', '\n    };\n    return api;');
for (const [re, set, label] of [[/S\.shell\.windows\.(\w+)/g, windowsApi, 'shell.windows'], [/S\.shell\.layout\.(\w+)/g, layoutApi, 'shell.layout'],
  [/(?:viewOf\([^()]*\)|activeView\(\)|\brv|\buv|\biv|\bdv)\.(\w+)/g, viewApi, 'view'], [/S\.shell\.(\w+)/g, shellApi, 'shell']]) {
  for (const m of SRC.matchAll(re)) {
    if (label === 'shell' && (m[1] === 'windows' || m[1] === 'layout')) continue;
    assert.ok(set.has(m[1]), `ij-app.js calls ${label}.${m[1]}, which ij-view.js / ij-layout.js does not provide`);
  }
}
// no "the display" any more: every use goes through a document's view
assert.ok(!/S\.display\b|S\.host\b|shell\.stage\b|shell\.display\b/.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'ij-app.js no longer uses S.display / S.host / shell.stage');
const createCall = /IJShell\.create\(S\.appEl, \{([\s\S]*?)\n      \}\);/.exec(SRC);
assert.ok(createCall, 'IJShell.create call found');
for (const m of createCall[1].matchAll(/(?:^|[\s,{])(commands|getState|t|tools|onCommand|onTool|onToolOptions|onRoi|onChannel|onCancel|readPixel|isActive|display|onActivate|onCloseImage|onLayoutChange)\s*[:,]/g)) {
  assert.ok(new RegExp('opts\\.' + m[1] + '\\b').test(VIEW), `the shell reads option ${m[1]}`);
}
assert.ok(/IJWindows\.create\(\{ root: shell/.test(VIEW) && /windows,/.test(VIEW), 'the shell exposes its windows');

// ── the error codes the controller maps are codes the engine / pure modules really throw ──
const CODE_SRC = ['ij-engine.js', 'ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', ...PROC_FILES, ...CMD_FILES].map((f) => readFileSync(path.join(DIR, f), 'utf8')).join('\n');
// IJ_SIZE_MISMATCH is mapped by W0 for the packages that compare two images (Image Calculator, Coloc): they throw it.
const PACKAGE_THROWN = new Set(['IJ_WORKER_CRASHED', 'IJ_SIZE_MISMATCH']); // the client raises its own crash code
for (const code of Object.keys(IJApp.ERROR_KEYS)) {
  if (!code.startsWith('IJ_') || PACKAGE_THROWN.has(code)) continue;
  assert.ok(CODE_SRC.includes(`'${code}'`), `ERROR_KEYS maps ${code}, which no engine module throws`);
}
for (const code of ['IJ_CANCELLED', 'IJ_EMPTY_ROI', 'IJ_NEEDS_ROI', 'IJ_NOTHING_TO_UNDO', 'IJ_NOT_BINARY', 'IJ_STORAGE_QUOTA', 'IJ_STORAGE_FAILED', 'IJ_BAD_ARGS']) {
  assert.ok(CODE_SRC.includes(`'${code}'`), `${code} is thrown by the engine`);
}
assert.ok(/IJ_CANCELLED/.test(SRC), 'a cancelled operation is recognised, not reported as an error');

// ── every button class the controller uses is styled ──
const CSS = readFileSync(path.join(DIR, 'ij-style.css'), 'utf8');
for (const m of SRC.matchAll(/'(ij-btn--[a-z]+)'/g)) assert.ok(CSS.includes('.' + m[1]), `${m[1]} has a rule in ij-style.css`);
// ── both themes define the text colours of warnings and errors ──
assert.ok(/--ij-warn-text/.test(CSS) && /\[data-theme="light"\] \.ij-root\s*\{[^}]*--ij-warn-text[^}]*--ij-danger-text/.test(CSS), 'light theme text tokens for warning / error');

// ── PLAN-wave3 §1.2 / §1.3: the menu rows and submenus of the controller (the rows other packages own are theirs) ──
{
  const orderOf = Object.fromEntries(COMMANDS.map((c) => [c.id, c]));
  const want = { fileClose: ['File', 20], fileOpen: ['File', 10], fileRevert: ['File', 30], fileRecover: ['File', 40], fileSimple: ['File', 60], fileCloseStudio: ['File', 70],
    editMakeInverse: ['Edit/Selection', 100], editAddToManager: ['Edit/Selection', 240], editSelectAll: ['Edit/Selection', 10], editSelectNone: ['Edit/Selection', 20], editRestoreSelection: ['Edit/Selection', 30],
    stackProject: ['Image/Stacks', 20], lutInvert: ['Image/LookupTables', 10], lutApply: ['Image/LookupTables', 20], lutFire: ['Image/LookupTables', 30], lutGrays: ['Image/LookupTables', 40],
    lutIce: ['Image/LookupTables', 50], lutSpectrum: ['Image/LookupTables', 60], lutRed: ['Image/LookupTables', 80], lutGreen: ['Image/LookupTables', 90], lutBlue: ['Image/LookupTables', 100],
    lutCyan: ['Image/LookupTables', 110], lutMagenta: ['Image/LookupTables', 120], lutYellow: ['Image/LookupTables', 130], lut16Colors: ['Image/LookupTables', 150], lutHiLo: ['Image/LookupTables', 160],
    toolsRoiManager: ['Analyze/Tools', 50], toolsSyncWindows: ['Analyze/Tools', 80],
    windowShowAll: ['Window', 10], windowPutBehind: ['Window', 20], windowCascade: ['Window', 30], windowTile: ['Window', 40], windowNext: ['Window', 70], windowPrevious: ['Window', 80] };
  for (const [id, [menu, order]] of Object.entries(want)) {
    assert.ok(orderOf[id], id);
    assert.equal(orderOf[id].menu.join('/'), menu, `${id} menu`);
    assert.equal(orderOf[id].order, order, `${id} order`);
  }
  // ImageJ's separators: before Close, before the Simple view, before Lookup Tables' file LUTs, before Next Image; none before Color › Channels Tool, none before Edit › Selection › Add to Manager
  for (const id of ['fileClose', 'fileSimple', 'lutFire', 'lut16Colors', 'windowNext']) assert.equal(orderOf[id].separatorBefore, true, `${id} has a separator above`);
  for (const id of ['colorChannels', 'editAddToManager']) assert.ok(!orderOf[id].separatorBefore, `${id} has no separator above`);
  const G = IJApp.GROUP_META;
  const wantGroups = { 'File/New': 5, 'File/Import': 15, 'File/SaveAs': 25, 'Edit/Selection': 70, 'Edit/Options': 80, 'Image/Overlay': 125, 'Image/LookupTables': 130, 'Process/FFT': 85, 'Analyze/Tools': 110,
    'Analyze/Colocalization': 120, 'Analyze/LocalThickness': 140, 'Analyze/Skeleton': 150, 'Plugins/Analyze': 10, 'Plugins/Analyze/CellCounter': 10, 'Plugins/Process': 20, 'Plugins/Utilities': 30 };
  for (const [p, order] of Object.entries(wantGroups)) assert.equal(G[p] && G[p].order, order, `GROUP_META ${p}`);
  assert.ok(!G['Image/Zoom'].separatorBefore, 'Zoom has no separator above (it follows Transform)');
  assert.equal(G['Image/LookupTables'].separatorBefore, true);
  assert.equal(G['Analyze/Colocalization'].separatorBefore, true);
  // every menu segment of the new submenus has its name in the four languages
  for (const seg of ['New', 'Import', 'Options', 'Overlay', 'FFT', 'Colocalization', 'LocalThickness', 'Skeleton', 'Plugins', 'CellCounter', 'Utilities']) {
    for (const code of LANGS) assert.ok(typeof resolve(lang[code], `menu.${seg}`) === 'string' && resolve(lang[code], `menu.${seg}`).length > 0, `${code}: menu.${seg}`);
  }
}
// ImageJ's Executer does not remember Undo and Close (Repeat Command would repeat the command before them), and Repeat Command itself runs the remembered one without replacing it: `repeatable`
for (const c of COMMANDS) assert.equal(c.repeatable === false, ['editUndo', 'fileClose', 'procRepeatCommand'].includes(c.id), `${c.id}: repeatable`);

console.log(`ij commands: OK (${COMMANDS.length} commands, ${seen.size} key specs, ${enKeys.size} lang keys x ${LANGS.length})`);
