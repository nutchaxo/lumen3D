// Advanced Studio — ij-view.js: the pure helpers (zoom ladder, screen <-> image, tile and
// level selection, LRU accounting, menu keyboard model, dialog value parsing, ROI geometry,
// formatting) and a smoke run of IJDisplay against a fake DOM / WebGL2 (tile requests,
// coarser-level fallback, VRAM LRU, stale refresh, context loss, export, destroy frees every
// GL object).
//
// Run: node tests/js/test_ij_view_pure.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

const FILE = 'js/modules/studio/advanced-studio/ij-view.js';
const P = loadModule(FILE, 'IJViewPure');
// values built inside the vm context have another realm's prototypes: compare as JSON
const deq = (a, b) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} !~ ${b}`);

// ── zoom ladder ──────────────────────────────────────────────────────────────
{
  assert.equal(P.ZOOM_LADDER[0], 1 / 32);
  assert.equal(P.ZOOM_LADDER[P.ZOOM_LADDER.length - 1], 32);
  assert.ok(P.ZOOM_LADDER.includes(1) && P.ZOOM_LADDER.includes(0.75) && P.ZOOM_LADDER.includes(1.5));
  for (let i = 1; i < P.ZOOM_LADDER.length; i++) assert.ok(P.ZOOM_LADDER[i] > P.ZOOM_LADDER[i - 1]);
  assert.equal(P.nextZoom(1, 1), 1.5);
  assert.equal(P.nextZoom(1, -1), 0.75);
  assert.equal(P.nextZoom(0.3, 1), 1 / 3);          // off-ladder: the next one up
  assert.equal(P.nextZoom(0.3, -1), 1 / 4);
  assert.equal(P.nextZoom(32, 1), 32);
  assert.equal(P.nextZoom(1 / 32, -1), 1 / 32);
  assert.equal(P.snapZoomDown(0.3), 1 / 4);
  assert.equal(P.snapZoomDown(1), 1);
  assert.equal(P.snapZoomDown(0.001), 1 / 32);
  assert.equal(P.clampZoom(100), 32);
  assert.equal(P.formatZoomPct(1), '100');
  assert.equal(P.formatZoomPct(1 / 32), '3.1');
  assert.equal(P.formatZoomPct(0.157), '15.7');
  assert.equal(P.formatZoomPct(32), '3200');
}

// ── pyramid levels and tiles ──────────────────────────────────────────────────
{
  deq({ ...P.levelDims(5735, 5735, 0) }, { w: 5735, h: 5735 });
  deq({ ...P.levelDims(5735, 5735, 1) }, { w: 2868, h: 2868 });   // ceil
  deq({ ...P.levelDims(5735, 5735, 3) }, { w: 717, h: 717 });
  assert.equal(P.maxLevelFor(1024, 1024), 0);
  assert.equal(P.maxLevelFor(1025, 10), 1);
  assert.equal(P.maxLevelFor(5735, 5735), 3);                                  // 717 <= 1024
  assert.equal(P.levelForZoom(1), 0);
  assert.equal(P.levelForZoom(2), 0);
  assert.equal(P.levelForZoom(0.5), 1);
  assert.equal(P.levelForZoom(0.4), 1);
  assert.equal(P.levelForZoom(0.25), 2);
  assert.equal(P.levelForZoom(1 / 32), 5);
  assert.equal(P.levelForZoom(1 / 32, 3), 3, 'capped by maxLevel');
  assert.equal(P.levelForZoom(0.7), 0);
  const g = P.tileGrid(5735, 3000, 0);
  assert.equal(g.cols, 6); assert.equal(g.rows, 3);
  deq({ ...P.tileTexels(0, 5, 2, 5735, 3000) }, { w: 5735 - 5120, h: 3000 - 2048 });
  deq({ ...P.tileImageRect(1, 1, 0, 5735, 5735) }, { x0: 2048, y0: 0, x1: 4096, y1: 2048 });
  deq({ ...P.tileImageRect(0, 5, 2, 5735, 3000) }, { x0: 5120, y0: 2048, x1: 5735, y1: 3000 }, 'clipped to the image');
  deq({ ...P.parentTile(0, 5, 3, 2) }, { tx: 1, ty: 0 });
}

// ── screen <-> image ───────────────────────────────────────────────────────────
{
  const v = { zoom: 2, ox: 30, oy: -10 };
  const s = P.imageToScreen(v, 15, 40);
  deq({ ...s }, { x: 60, y: 70 });
  const i = P.screenToImage(v, s.x, s.y);
  near(i.x, 15); near(i.y, 40);
  // zoomAround keeps the point under the cursor fixed
  for (const z of [0.5, 1, 3, 32]) {
    const nv = P.zoomAround(v, 123, 77, z);
    const a = P.screenToImage(v, 123, 77), b = P.screenToImage(nv, 123, 77);
    near(a.x, b.x, 1e-9); near(a.y, b.y, 1e-9);
    assert.equal(nv.zoom, z);
  }
  // fit: centred, never above 100 %
  const f = P.fitView(800, 600, 3000, 2000);
  near(f.zoom, 800 / 3000);
  near(f.ox, 0); near(f.oy, (600 - 2000 * f.zoom) / 2);
  const small = P.fitView(800, 600, 100, 50);
  assert.equal(small.zoom, 1); near(small.ox, 350); near(small.oy, 275);
  assert.equal(P.fitView(800, 600, 3000, 2000, { snap: true }).zoom, 1 / 4);
  // clampPan: a small image stays centred, a large one cannot leave the viewport
  const c1 = P.clampPan({ zoom: 1, ox: -500, oy: 900 }, 800, 600, 100, 50);
  near(c1.ox, 350); near(c1.oy, 275);
  const c2 = P.clampPan({ zoom: 1, ox: 50, oy: -5000 }, 800, 600, 2000, 1500);
  assert.equal(c2.ox, 0); assert.equal(c2.oy, 600 - 1500);
  // viewForRect centres the rectangle, ladder zoom that fits
  const r = P.viewForRect({ x: 100, y: 100, w: 200, h: 100 }, 800, 600);
  assert.equal(r.zoom, 4);
  near(r.ox + 200 * r.zoom, 400); near(r.oy + 150 * r.zoom, 300);
}

// ── tile selection ──────────────────────────────────────────────────────────────
{
  // image 5000x3000 fit in 800x600: level 2 -> 1250x750 -> one tile
  const f = P.fitView(800, 600, 5000, 3000);
  const L = P.levelForZoom(f.zoom, P.maxLevelFor(5000, 3000));
  assert.equal(L, 2);
  assert.equal(P.visibleTiles(f, 800, 600, 5000, 3000, L).length, 2, 'level 2 spans 2 tile columns (1250 > 1024)');
  // 100 % on the top-left: level 0, 800x600 sits in tile (0,0)
  const t0 = P.visibleTiles({ zoom: 1, ox: 0, oy: 0 }, 800, 600, 5000, 3000, 0);
  deq(t0.map((t) => [t.tx, t.ty]), [[0, 0]]);
  // panned so the viewport straddles 4 tiles; nearest the centre first
  const t4 = P.visibleTiles({ zoom: 1, ox: -700, oy: -800 }, 800, 600, 5000, 3000, 0);
  assert.equal(t4.length, 4);
  deq(t4.map((t) => `${t.tx},${t.ty}`).sort(), ['0,0', '0,1', '1,0', '1,1']);
  // fully outside the image
  assert.equal(P.visibleTiles({ zoom: 1, ox: 5000, oy: 0 }, 800, 600, 5000, 3000, 0).length, 0);
  // the viewport edge exactly on a tile boundary does not pull in the next tile
  const edge = P.visibleTiles({ zoom: 1, ox: -224, oy: 0 }, 800, 600, 5000, 3000, 0);
  deq(edge.map((t) => t.tx).sort(), [0], 'viewport ends at x = 1024');
}

// ── LRU ───────────────────────────────────────────────────────────────────────────
{
  const lru = P.createLru();
  lru.add('a', 10); lru.add('b', 10); lru.add('c', 10, true); lru.add('d', 10);
  assert.equal(lru.total, 40);
  lru.touch('a');                                           // order: b c d a
  deq(lru.evict(30), ['b']);
  assert.equal(lru.total, 30);
  deq(lru.evict(10, new Set(['d'])), ['a'], 'pinned c and protected d stay');
  assert.equal(lru.total, 20);
  deq(lru.evict(0), ['d'], 'only the unpinned remain evictable');
  deq(lru.keys(), ['c']);
  lru.add('c', 5, true);                                    // re-add replaces
  assert.equal(lru.total, 5);
  assert.equal(lru.remove('zz'), false);
  lru.clear();
  assert.equal(lru.total, 0);
  const MiB = 1024 * 1024;
  assert.equal(P.tileBudgetBytes({}), 256 * MiB);
  assert.equal(P.tileBudgetBytes({ platformBudget: 2048 * MiB, liveBytes: 1900 * MiB }), 148 * MiB);
  assert.equal(P.tileBudgetBytes({ platformBudget: 1000 * MiB, liveBytes: 990 * MiB }), 32 * MiB, 'floor');
  assert.equal(P.tileBudgetBytes({ platformBudget: 8192 * MiB, liveBytes: 0 }), 256 * MiB, 'cap');
}

// ── wheel accumulation ────────────────────────────────────────────────────────────
{
  deq({ ...P.wheelSteps(0, -100) }, { steps: 1, acc: -40 });
  assert.equal(P.wheelSteps(0, 100).steps, -1);
  let acc = 0, total = 0;
  for (let i = 0; i < 10; i++) { const r = P.wheelSteps(acc, -10); acc = r.acc; total += r.steps; }
  assert.equal(total, 1, 'ten small deltas make one step');
  assert.equal(P.wheelSteps(0, -3, 1).steps, 1, 'line mode');
}

// ── shortcuts ──────────────────────────────────────────────────────────────────────
{
  const ev = (key, m = {}) => ({ key, ...m });
  assert.equal(P.shortcutFromEvent(ev('m')), 'm');
  assert.equal(P.shortcutFromEvent(ev('M', { shiftKey: true })), 'Shift+M');
  assert.equal(P.shortcutFromEvent(ev('z', { ctrlKey: true })), 'Ctrl+Z');
  assert.equal(P.shortcutFromEvent(ev('Z', { ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+Z');
  assert.equal(P.shortcutFromEvent(ev('+', { shiftKey: true })), '+');
  assert.equal(P.shortcutFromEvent(ev('=')), '+');
  assert.equal(P.shortcutFromEvent(ev('-')), '-');
  assert.equal(P.shortcutFromEvent(ev('Escape')), 'Escape');
  assert.equal(P.shortcutFromEvent(ev('Delete', { shiftKey: true })), 'Shift+Delete');
  assert.equal(P.shortcutFromEvent(ev('Shift')), null);
  assert.equal(P.shortcutFromEvent(ev('y', { metaKey: true })), 'Ctrl+Y');
  assert.equal(P.normalizeShortcut('ctrl+shift+z'), 'Ctrl+Shift+Z');
  assert.equal(P.normalizeShortcut('Shift+C'), 'Shift+C');
  assert.equal(P.normalizeShortcut('M'), 'm');
  assert.equal(P.normalizeShortcut('+'), '+');
  assert.equal(P.normalizeShortcut('Ctrl++'), 'Ctrl++');
  assert.equal(P.normalizeShortcut('-'), '-');
  assert.equal(P.normalizeShortcut(''), null);
  assert.equal(P.shortcutLabel('m'), 'M');
  assert.equal(P.shortcutLabel('Ctrl+S'), 'Ctrl+S');
}

// ── menu tree and keyboard model ─────────────────────────────────────────────────────
{
  const state = { image: true, ok: false };
  const commands = [
    { id: 'help.about', menu: ['Help'], label: 'About' },
    { id: 'file.open', menu: ['File'], label: 'Open...', shortcut: 'Ctrl+O' },
    { id: 'file.save', menu: ['File'], label: 'Save', shortcut: 'Ctrl+S', separatorBefore: true },
    { id: 'image.adj.bc', menu: ['Image', 'Adjust'], label: 'Brightness/Contrast...', shortcut: 'Shift+C', enabled: (s) => s.image },
    { id: 'image.adj.th', menu: ['Image', 'Adjust'], label: 'Threshold...', enabled: (s) => s.ok },
    { id: 'image.crop', menu: ['Image'], label: 'Crop', shortcut: 'Shift+X', separatorBefore: true },
    { id: 'zzz.custom', menu: ['Zzz'], label: 'Custom' },
    { id: 'edit.nothing', menu: ['Edit', 'Selection'], label: 'None', enabled: (s) => s.ok },
    { id: 'orphan', label: 'No menu' },
    { separator: true, menu: ['File'] }
  ];
  const tree = P.buildMenuTree(commands, { state });
  deq(tree.map((x) => x.name), ['File', 'Edit', 'Image', 'Help', 'Zzz'], 'ImageJ order, unknown tops last, empty dropped');
  const file = tree[0];
  deq(file.items.map((i) => i.type), ['item', 'separator', 'item'], 'trailing separator trimmed');
  assert.equal(file.items[2].shortcut, 'Ctrl+S');
  const image = tree[2];
  deq(image.items.map((i) => i.type), ['group', 'separator', 'item']);
  assert.equal(image.items[0].label, 'Adjust');
  assert.equal(image.items[0].children[0].disabled, false);
  assert.equal(image.items[0].children[1].disabled, true);
  assert.equal(image.items[0].disabled, false);
  assert.equal(tree[1].items[0].disabled, true, 'a group with only disabled entries is disabled');

  // closed bar: arrows move the top, Down opens
  let st = { open: false, stack: [0] };
  st = P.menuKey(tree, st, 'ArrowRight').state; assert.equal(st.stack[0], 1);
  st = P.menuKey(tree, st, 'ArrowLeft').state; st = P.menuKey(tree, st, 'ArrowLeft').state; assert.equal(st.stack[0], tree.length - 1, 'wraps');
  st = { open: false, stack: [2] };
  st = P.menuKey(tree, st, 'ArrowDown').state;
  deq({ ...st, stack: st.stack.slice() }, { open: true, stack: [2, 0] });
  // Right on a group opens its submenu on the first enabled child; Down skips the disabled one
  let r = P.menuKey(tree, st, 'ArrowRight'); st = r.state;
  deq(st.stack, [2, 0, 0]);
  st = P.menuKey(tree, st, 'ArrowDown').state;
  assert.equal(st.stack[2], 0, 'only one enabled child: stays');
  // Left closes the submenu; Down skips the separator and lands on Crop
  st = P.menuKey(tree, st, 'ArrowLeft').state; deq(st.stack, [2, 0]);
  st = P.menuKey(tree, st, 'ArrowDown').state; deq(st.stack, [2, 2], 'separator skipped');
  st = P.menuKey(tree, st, 'ArrowDown').state; deq(st.stack, [2, 0], 'wraps to the first');
  st = P.menuKey(tree, st, 'ArrowUp').state; deq(st.stack, [2, 2]);
  // Enter on an item activates and closes
  r = P.menuKey(tree, st, 'Enter');
  assert.equal(r.activate.id, 'image.crop');
  assert.equal(r.state.open, false);
  // Enter on a group opens it; Enter on a child activates
  st = { open: true, stack: [2, 0] };
  st = P.menuKey(tree, st, 'Enter').state; deq(st.stack, [2, 0, 0]);
  r = P.menuKey(tree, st, 'Enter'); assert.equal(r.activate.id, 'image.adj.bc');
  // Escape pops a level, then closes
  st = { open: true, stack: [2, 0, 0] };
  st = P.menuKey(tree, st, 'Escape').state; deq(st.stack, [2, 0]); assert.equal(st.open, true);
  st = P.menuKey(tree, st, 'Escape').state; assert.equal(st.open, false);
  // Right on a plain item moves to the next top menu (opened); Left goes back
  st = { open: true, stack: [0, 0] };
  st = P.menuKey(tree, st, 'ArrowRight').state; deq({ open: st.open, top: st.stack[0] }, { open: true, top: 1 });
  st = P.menuKey(tree, st, 'ArrowLeft').state; assert.equal(st.stack[0], 0);
  // a disabled item never activates
  st = { open: true, stack: [2, 0, 1] };
  assert.equal(P.menuKey(tree, st, 'Enter').activate, null);
  // Home / End
  st = P.menuKey(tree, { open: true, stack: [2, 0] }, 'End').state; deq(st.stack, [2, 2]);
  st = P.menuKey(tree, st, 'Home').state; deq(st.stack, [2, 0]);
  // empty tree
  assert.equal(P.menuKey([], { open: false, stack: [0] }, 'ArrowDown').activate, null);
  // t(): translations and fallbacks
  const tr = P.buildMenuTree(commands, { t: (k, f) => (k === 'view.menu.File' ? 'Fichier' : k), state });
  assert.equal(tr[0].label, 'Fichier');
  assert.equal(tr[2].label, 'Image', 'a t that echoes the key falls back to the English name');
}

// ── dialog value parsing ───────────────────────────────────────────────────────────────
{
  deq({ ...P.parseNumber('1,5') }, { ok: true, value: 1.5 });
  deq({ ...P.parseNumber(' -2.25 ') }, { ok: true, value: -2.25 });
  deq({ ...P.parseNumber('1e3') }, { ok: true, value: 1000 });
  deq({ ...P.parseNumber('.5') }, { ok: true, value: 0.5 });
  assert.equal(P.parseNumber('abc').code, 'nan');
  assert.equal(P.parseNumber('').code, 'nan');
  assert.equal(P.parseNumber('1.2.3').code, 'nan');
  assert.equal(P.parseNumber('12', { max: 10 }).code, 'range');
  assert.equal(P.parseNumber('-1', { min: 0 }).code, 'range');
  assert.equal(P.parseNumber('2.5', { integer: true }).code, 'integer');
  assert.equal(P.parseNumber('3', { integer: true, min: 1, max: 5 }).ok, true);
  assert.equal(P.formatNumber(2, 2), '2.00');
  assert.equal(P.formatNumber(0.1 + 0.2), '0.3');
  const fields = [
    { type: 'number', id: 'sigma', min: 0, max: 100 },
    { type: 'number', id: 'n', integer: true, min: 1 },
    { type: 'choice', id: 'method', options: ['max', { value: 'sum', label: 'Sum' }] },
    { type: 'check', id: 'dark' },
    { type: 'string', id: 'name' },
    { type: 'message', id: 'info' }
  ];
  const ok = P.collectFields(fields, { sigma: '2,5', n: '4', method: 'sum', dark: true, name: 'x' });
  assert.equal(ok.ok, true);
  deq({ ...ok.values }, { sigma: 2.5, n: 4, method: 'sum', dark: true, name: 'x' });
  const bad = P.collectFields(fields, { sigma: '-1', n: '1.5', method: 'nope', dark: false, name: '' });
  assert.equal(bad.ok, false);
  deq({ ...bad.errors }, { sigma: 'range', n: 'integer', method: 'choice' });
}

// ── window clamp ───────────────────────────────────────────────────────────────────────────
{
  const c = P.clampWindowPos(-500, -20, 300, 200, 1000, 700);
  assert.equal(c.x, 24 - 300); assert.equal(c.y, 0);
  const d = P.clampWindowPos(5000, 5000, 300, 200, 1000, 700);
  assert.equal(d.x, 1000 - 24); assert.equal(d.y, 700 - 24);
  const e = P.clampWindowPos(100, 100, 300, 200, 1000, 700);
  deq({ ...e }, { x: 100, y: 100 });
}

// ── ROI geometry ──────────────────────────────────────────────────────────────────────────────
{
  deq({ ...P.roiFromDrag('rect', { x: 10.7, y: 20.2 }, { x: 4.1, y: 30.9 }) }, { type: 'rect', x: 4, y: 20, w: 6, h: 10 });
  deq({ ...P.roiFromDrag('oval', { x: 10, y: 10 }, { x: 14, y: 30 }, { shift: true }) }, { type: 'oval', x: 10, y: 10, w: 20, h: 20 });
  deq({ ...P.roiFromDrag('rect', { x: 50, y: 50 }, { x: 40, y: 45 }, { alt: true }) }, { type: 'rect', x: 40, y: 45, w: 20, h: 10 });
  const ln = P.lineFromDrag({ x: 3.2, y: 4.9 }, { x: 10.1, y: 4.2 });
  // Integer endpoints (ImageJ Line tool without sub-pixel): IJOps.profile then reads exact pixels.
  deq({ ...ln }, { type: 'line', x1: 3, y1: 4, x2: 10, y2: 4, width: 1 });
  const diag = P.lineFromDrag({ x: 0, y: 0 }, { x: 10, y: 7 }, { shift: true });
  near(Math.abs(diag.x2 - diag.x1), Math.abs(diag.y2 - diag.y1), 1);
  const rect = { type: 'rect', x: 10, y: 20, w: 30, h: 40 };
  assert.equal(P.roiHandles(rect).length, 8);
  deq({ ...P.handleAt(rect, 10.5, 20.5, 2) }, { id: 'nw', x: 10, y: 20 });
  assert.equal(P.handleAt(rect, 25, 40, 2), null);
  const moved = P.moveHandle(rect, 'se', 60, 90);
  deq({ ...moved }, { type: 'rect', x: 10, y: 20, w: 50, h: 70 });
  const flipped = P.moveHandle(rect, 'e', 5, 0);
  assert.equal(flipped.x, 5); assert.equal(flipped.w, 5, 'dragging past the opposite edge normalises');
  const sq = P.moveHandle(rect, 'se', 60, 50, { shift: true });
  assert.equal(sq.w, sq.h);
  const line = { type: 'line', x1: 1, y1: 1, x2: 20, y2: 1, width: 1 };
  assert.equal(P.roiHandles(line).length, 2);
  const l2 = P.moveHandle(line, 'p2', 30.2, 10.7);
  assert.equal(l2.x1, 1); assert.equal(l2.y1, 1); assert.equal(l2.x2, 30); assert.equal(l2.y2, 10);
  const poly = { type: 'polygon', points: [[0, 0], [10, 0], [10, 10], [0, 10]] };
  assert.equal(P.roiHandles(poly).length, 4);
  deq(P.moveHandle(poly, 'v2', 12.4, 11.6).points[2], [12, 12]);
  assert.equal(P.hitRoi(rect, 20, 30), true); assert.equal(P.hitRoi(rect, 5, 30), false); assert.equal(P.hitRoi(rect, 8.5, 30, 2), true);
  const oval = { type: 'oval', x: 0, y: 0, w: 10, h: 10 };
  assert.equal(P.hitRoi(oval, 5, 5), true); assert.equal(P.hitRoi(oval, 0.5, 0.5), false);
  assert.equal(P.hitRoi(poly, 5, 5), true); assert.equal(P.hitRoi(poly, 15, 5), false);
  const tri = { type: 'polygon', points: [[0, 0], [10, 0], [0, 10]] };
  assert.equal(P.hitRoi(tri, 2, 2), true); assert.equal(P.hitRoi(tri, 8, 8), false);
  assert.equal(P.hitRoi(line, 10, 2, 1.5), true); assert.equal(P.hitRoi(line, 10, 8, 1.5), false);
  assert.equal(P.hitRoi({ type: 'point', points: [[5.5, 5.5]] }, 6, 6, 1), true);
  deq({ ...P.roiBounds(poly) }, { x: 0, y: 0, w: 10, h: 10 });
  deq({ ...P.roiBounds(line) }, { x: 1, y: 1, w: 19, h: 0 });
  const tr = P.translateRoi(poly, 3, -2);
  deq(tr.points[1], [13, -2]);
  assert.equal(poly.points[1][0], 10, 'the original is untouched');
  deq({ ...P.translateRoi(line, 1, 1) }, { type: 'line', x1: 2, y1: 2, x2: 21, y2: 2, width: 1 });
  deq({ ...P.translateRoi({ type: 'mask', x: 1, y: 2, w: 3, h: 4, rle: [0, 2] }, 1, 1) }, { type: 'mask', x: 2, y: 3, w: 3, h: 4, rle: [0, 2] });
  assert.equal(P.isAreaRoi(rect), true); assert.equal(P.isAreaRoi(line), false);
  assert.equal(P.handleCursor('nw'), 'nwse-resize'); assert.equal(P.handleCursor('n'), 'ns-resize'); assert.equal(P.handleCursor('e'), 'ew-resize'); assert.equal(P.handleCursor('ne'), 'nesw-resize');
}

// ── formatting ────────────────────────────────────────────────────────────────────────────────
{
  assert.equal(P.formatSize(500), '500 B');
  assert.equal(P.formatSize(256 * 1024), '256K');
  assert.equal(P.formatSize(1.5 * 1024 * 1024), '1.5MB');
  assert.equal(P.formatSize(94 * 1024 * 1024), '94MB');
  assert.equal(P.formatSize(3 * 1024 ** 3), '3.00GB');
  assert.equal(P.formatSubtitle({ width: 512, height: 512, bitDepth: 8, channels: [{}, {}, {}] }), '512×512 pixels; 8-bit; 768K');
  assert.equal(
    P.formatSubtitle({ width: 512, height: 256, bitDepth: 16, channels: 1, calibration: { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'µm' } }),
    '256×128 µm (512×256); 16-bit; 256K'
  );
  assert.equal(P.formatStatus({ x: 3, y: 4, values: [12, 0], bitDepth: 8 }), 'x=3, y=4, value=12,0');
  assert.equal(
    P.formatStatus({ x: 10, y: 20, calibration: { pixelWidth: 0.25, pixelHeight: 0.25, unit: 'µm' }, values: [1.23456789], bitDepth: 32 }),
    'x=10, y=20 (2.5, 5 µm), value=1.23457'
  );
  assert.equal(P.formatStatus({ x: 1, y: 1 }), 'x=1, y=1');
  assert.equal(P.describeRoi({ type: 'rect', x: 1.2, y: 2.9, w: 30.5, h: 4 }), 'x=1, y=2, w=30, h=4');
  assert.equal(P.describeRoi({ type: 'line', x1: 0, y1: 10, x2: 10, y2: 0, width: 1 }, { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'µm' }), 'angle=45, length=7.071 µm');
  assert.equal(P.describeRoi(null), '');
}

// ── fakes shared by the IJDisplay and IJShell runs ──────────────────────────────────────────
const listeners = { added: 0, removed: 0, map: new Map() };
const rafQueue = [];
const live = new Set();
const stats = { uploads: 0, draws: 0, createdTextures: 0 };
const GL_CONSTS = { NO_ERROR: 0, OUT_OF_MEMORY: 0x505 };

function makeGl() {
  const base = {
    getError: () => 0,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
    getUniformLocation: () => ({}),
    getExtension: () => null,
    texSubImage2D: () => { stats.uploads++; },
    drawArrays: () => { stats.draws++; },
    readPixels: () => {}
  };
  const kinds = { createShader: 'shader', createProgram: 'program', createBuffer: 'buffer', createVertexArray: 'vao', createTexture: 'texture', createFramebuffer: 'fbo' };
  const deletes = { deleteShader: 1, deleteProgram: 1, deleteBuffer: 1, deleteVertexArray: 1, deleteTexture: 1, deleteFramebuffer: 1 };
  return new Proxy(base, {
    get(t, name) {
      if (name in t) return t[name];
      if (typeof name !== 'string') return undefined;
      if (name in GL_CONSTS) return GL_CONSTS[name];
      if (/^[A-Z0-9_]+$/.test(name)) { let h = 7; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return (h % 60000) + 1; }
      if (kinds[name]) return () => { const o = { kind: kinds[name] }; live.add(o); if (o.kind === 'texture') stats.createdTextures++; return o; };
      if (deletes[name]) return (o) => { live.delete(o); };
      return () => {};
    }
  });
}


// ── IJDisplay against a fake DOM / WebGL2 ─────────────────────────────────────────────────────
{
  const MiB = 1024 * 1024;
  const sandbox = {};
  const D = loadModule(FILE, 'IJDisplay', sandbox);

  function makeEl(tag, doc) {
    const el = {
      tagName: tag.toUpperCase(), style: {}, children: [], parentNode: null, width: 300, height: 150,
      clientWidth: 0, clientHeight: 0, className: '', ownerDocument: doc,
      appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
      removeChild(c) { el.children = el.children.filter((x) => x !== c); c.parentNode = null; return c; },
      addEventListener(ev, fn) { listeners.added++; listeners.map.set(ev + ':' + fn, { el, ev, fn }); },
      removeEventListener(ev, fn) { if (listeners.map.delete(ev + ':' + fn)) listeners.removed++; },
      fire(ev, e = {}) { for (const l of listeners.map.values()) if (l.el === el && l.ev === ev) l.fn({ preventDefault() {}, ...e }); },
      getContext(type) {
        if (type === 'webgl2') return el._gl || (el._gl = makeGl());
        return new Proxy({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }) }, {
          get: (t, n) => (n in t ? t[n] : () => {}), set: () => true
        });
      }
    };
    return el;
  }

  function makeEnv(clientW = 800, clientH = 600) {
    const win = {
      devicePixelRatio: 1,
      requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
      cancelAnimationFrame: () => {},
      getComputedStyle: () => ({ position: 'relative' }),
      addEventListener() {}, removeEventListener() {}
    };
    const doc = { defaultView: win, createElement: (t) => makeEl(t, doc) };
    const host = makeEl('div', doc);
    host.clientWidth = clientW; host.clientHeight = clientH;
    return { host, doc };
  }
  const flush = async (n = 8) => {
    for (let i = 0; i < n; i++) {
      const q = rafQueue.splice(0);
      for (const fn of q) fn();
      await new Promise((r) => setTimeout(r, 0));
    }
  };

  const mkTile = (bits, w, h, fill = 7) => {
    const data = bits === 8 ? new Uint8Array(w * h) : bits === 16 ? new Uint16Array(w * h) : new Float32Array(w * h);
    data.fill(fill);
    return { width: w, height: h, bitDepth: bits, data };
  };
  const makeProvider = (W, H, bits) => {
    const calls = [];
    const fn = async (c, L, tx, ty) => {
      calls.push([c, L, tx, ty]);
      const t = P.tileTexels(L, tx, ty, W, H);
      return mkTile(bits, t.w, t.h);
    };
    fn.calls = calls;
    return fn;
  };
  const info = (W, H, bits, nch) => ({
    docId: 1, name: 'x', width: W, height: H, bitDepth: bits,
    channels: Array.from({ length: nch }, (_, i) => ({ name: 'c' + i, color: '#fff', display: { min: 0, max: bits === 8 ? 255 : 65535, lut: 'Grays', invert: false } })),
    calibration: null
  });

  // 1. fit view: coarsest tile first, then the displayed level; fallback while loading
  {
    const { host } = makeEnv();
    const views = [];
    const disp = D.create(host, { onViewChange: (v) => views.push(v) });
    const prov = makeProvider(3000, 2000, 8);
    disp.setImage(info(3000, 2000, 8, 2));
    disp.setTileProvider(prov);
    await flush(1);
    assert.ok(prov.calls.length > 0);
    deq(prov.calls[0].slice(1), [2, 0, 0], 'the coarsest level is requested first');
    await flush(6);
    const st = disp.getStats();
    assert.equal(st.level, 1);
    assert.equal(st.residentTiles, 6, '2 channels x (coarsest + 2 tiles of level 1)');
    assert.equal(st.loading, false);
    assert.ok(stats.draws > 0);
    assert.ok(views.some((v) => v.loading) && views[views.length - 1].loading === false, 'loading flag raised then lowered');
    const v = disp.getView();
    near(v.zoom, 800 / 3000); assert.equal(v.maxLevel, 2);
    // transforms
    const s = disp.imageToScreen(1500, 1000);
    const back = disp.screenToImage(s.x, s.y);
    near(back.x, 1500, 1e-6); near(back.y, 1000, 1e-6);
    // zoom in: ladder step 1/3 -> level 1 still; cursor-anchored
    const before = disp.screenToImage(400, 300);
    disp.zoomAt(400, 300, 1);
    const after = disp.screenToImage(400, 300);
    near(before.x, after.x, 1e-6);
    assert.equal(disp.getView().zoom, 1 / 3);
    disp.view100();
    assert.equal(disp.getView().zoom, 1);
    await flush(6);
    assert.equal(disp.getStats().level, 0);
    // uniform-only changes cause no new request
    const n0 = prov.calls.length;
    disp.setDisplay({ channel: 0, min: 10, max: 100, lut: 'Fire', invert: true });
    disp.setDisplay({ mode: 'color', active: 1 });
    disp.setDisplay({ mode: 'composite', visible: [true, false] });
    disp.setThresholdOverlay({ channel: 0, lower: 10, upper: 90, mode: 'overunder' });
    disp.setThresholdOverlay(null);
    disp.setRois({ active: { type: 'rect', x: 1, y: 1, w: 5, h: 5 }, all: [{ type: 'oval', x: 3, y: 3, w: 9, h: 9 }], showAll: true });
    disp.setDraft({ points: [[1, 1], [5, 5]], rubber: [9, 9] });
    disp.setDraft(null);
    await flush(3);
    assert.equal(prov.calls.length, n0, 'display state changes are uniforms only');
    // preview region: pixels uploaded, freed on null
    const up0 = stats.uploads;
    disp.setPreview({ level: 0, x0: 10, y0: 10, w: 64, h: 64, bitDepth: 8, channels: { 0: new Uint8Array(64 * 64) } });
    await flush(2);
    assert.equal(stats.uploads, up0 + 1);
    disp.setPreview(null);
    // stale refresh keeps tiles and re-requests the visible ones
    const resident = disp.getStats().residentTiles;
    disp.invalidate([0]);
    assert.equal(disp.getStats().residentTiles, resident, 'tiles stay until replaced');
    const n1 = prov.calls.length;
    await flush(6);
    assert.ok(prov.calls.length > n1, 'visible tiles of channel 0 are fetched again');
    assert.ok(prov.calls.slice(n1).every((c) => c[0] === 0));
    // export at half size
    disp.setImage(info(3000, 2000, 8, 2));
    const out = await disp.renderToCanvas({ scale: 0.5 });
    assert.equal(out.width, 1500); assert.equal(out.height, 1000);
    await assert.rejects(disp.renderToCanvas({ scale: 100 }), (e) => e.code === 'IJ_EXPORT_TOO_LARGE');
    const ac = { aborted: true };
    await assert.rejects(disp.renderToCanvas({ scale: 0.25, signal: ac }), (e) => e.code === 'IJ_CANCELLED');
    // context loss: tiles re-requested after the restore
    const canvas = host.children[0];
    const nBefore = prov.calls.length;
    canvas.fire('webglcontextlost');
    live.clear();                                                          // the browser freed everything with the context
    await flush(2);
    assert.equal(disp.getStats().residentTiles, 0);
    canvas.fire('webglcontextrestored');
    await flush(8);
    assert.ok(prov.calls.length > nBefore && disp.getStats().residentTiles > 0, 'recreated and tiles re-requested');
    // destroy frees every GL object and every listener
    disp.destroy();
    assert.equal(live.size, 0, 'no GL object left: ' + Array.from(live).map((o) => o.kind).join(','));
    assert.equal(host.children.length, 0);
    assert.equal(listeners.map.size, 0, 'every listener removed');
    disp.destroy();                                                        // idempotent
  }

  // 2. VRAM LRU: a 32-bit image panned across many tiles stays within the budget
  {
    const { host } = makeEnv();
    const svr = { vramBudget: () => 0, liveAtlasBytes: () => 0 };           // floor = 32 MiB
    const disp = D.create(host, { SVRManager: svr });
    const prov = makeProvider(12000, 12000, 32);
    disp.setImage(info(12000, 12000, 32, 1));
    disp.setTileProvider(prov);
    disp.view100();
    for (let i = 0; i < 12; i++) { disp.pan(-1024, -300); await flush(4); }
    const st = disp.getStats();
    assert.ok(prov.calls.filter((c) => c[1] === 0).length > 8, 'many level-0 tiles were fetched');
    assert.ok(st.residentBytes <= st.budgetBytes + 8 * MiB, `${st.residentBytes} within ${st.budgetBytes}`);
    assert.equal(st.budgetBytes, 32 * MiB);
    disp.destroy();
    assert.equal(live.size, 0);
  }

  // 3. a failing provider is reported and retried with back-off, never throws
  {
    const { host } = makeEnv();
    const errors = [];
    const disp = D.create(host, { onTileError: (e) => errors.push(e) });
    let calls = 0;
    disp.setImage(info(500, 500, 16, 1));
    disp.setTileProvider(async () => { calls++; throw new Error('boom'); });
    await flush(6);
    assert.ok(errors.length >= 1 && calls >= 1);
    const c1 = calls;
    await flush(6);
    assert.equal(calls, c1, 'no hot retry loop');
    disp.destroy();
    assert.equal(live.size, 0);
  }
}

// ── popup / step helpers ──
{
  assert.equal(P.numberStep({ step: 'any' }), 0.1);
  assert.equal(P.numberStep({ step: 'any', integer: true }), 1);
  assert.equal(P.numberStep({ step: 0.5 }), 0.5);
  assert.equal(P.numberStep({ step: 0 }), 0.1);
  assert.equal(P.numberStep({}), 0.1);
  assert.equal(P.clampPopupX(500, 200, 600), 400);
  assert.equal(P.clampPopupX(10, 200, 600), 10);
  assert.equal(P.clampPopupX(10, 800, 600), 0);
  assert.equal(P.clampPopupY(250, 100, 300), 200);
  assert.equal(P.submenuX(100, 150, 200, 600), 248);
  assert.equal(P.submenuX(400, 150, 200, 600), 202, 'opens to the left of its parent when it would overflow');
  assert.equal(P.submenuX(10, 150, 200, 300), 0);
  assert.equal(P.centreX(200, 1000), 400);
  assert.equal(P.centreX(1200, 1000), 8);
}

// ── IJShell / IJWindows against a small fake DOM ──────────────────────────────────────────────
{
  class FClassList {
    constructor(el) { this.el = el; this.set = new Set(); }
    add(...c) { c.forEach((x) => x && this.set.add(x)); }
    remove(...c) { c.forEach((x) => this.set.delete(x)); }
    contains(c) { return this.set.has(c); }
    toggle(c, force) { const on = force === undefined ? !this.set.has(c) : !!force; if (on) this.set.add(c); else this.set.delete(c); return on; }
  }
  const DOC_LISTENERS = new Map();
  class FEl {
    constructor(tag, doc) {
      this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.style = {}; this.dataset = {}; this.children = []; this.parentNode = null;
      this._attrs = {}; this._text = ''; this.classList = new FClassList(this); this.hidden = false; this.disabled = false;
      this._ls = []; this.clientWidth = 0; this.clientHeight = 0; this.width = 300; this.height = 150; this.value = ''; this.checked = false; this.type = '';
      this.tabIndex = -1; this.id = ''; this.title = '';
    }
    get className() { return Array.from(this.classList.set).join(' '); }
    set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; this._text = String(v); }
    set innerHTML(v) { this._html = v; }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
    append(...cs) { cs.forEach((c) => this.appendChild(c)); }
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
    setAttribute(k, v) { this._attrs[k] = String(v); }
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
    removeAttribute(k) { delete this._attrs[k]; }
    addEventListener(ev, fn) { this._ls.push({ ev, fn }); listeners.map.set(ev + ':' + fn + ':' + this._uid(), { el: this, ev, fn }); listeners.added++; }
    removeEventListener(ev, fn) {
      const i = this._ls.findIndex((l) => l.ev === ev && l.fn === fn);
      if (i >= 0) { this._ls.splice(i, 1); listeners.map.delete(ev + ':' + fn + ':' + this._uid()); listeners.removed++; }
    }
    _uid() { return this._id || (this._id = ++FEl.n); }
    fire(ev, e = {}) {
      const evt = { type: ev, target: this, button: 0, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...e };
      for (const l of this._ls.slice()) if (l.ev === ev) l.fn(evt);
      return evt;
    }
    dispatchEvent(e) { e.target = this; for (const l of this._ls.slice()) if (l.ev === e.type) l.fn(e); return true; }
    focus() { this.ownerDocument.activeElement = this; }
    select() {}
    setPointerCapture() {}
    releasePointerCapture() {}
    getBoundingClientRect() { return { left: 0, top: 0, right: this.clientWidth || 200, bottom: this.clientHeight || 20, width: this.clientWidth || 200, height: this.clientHeight || 20 }; }
    get offsetWidth() { return 220; }
    get offsetHeight() { return 120; }
    get offsetLeft() { return parseFloat(this.style.left) || 0; }
    get offsetTop() { return parseFloat(this.style.top) || 0; }
    closest(sel) {
      const names = sel.split(',').map((x) => x.trim());
      for (let x = this; x; x = x.parentNode) {
        for (const n of names) if (n === '[hidden]' ? x.hidden : x.tagName === n.toUpperCase()) return x;
      }
      return null;
    }
    querySelectorAll(sel) {
      const out = [];
      const focusable = sel.includes('button:not');
      const walk = (n) => {
        for (const c of n.children) {
          if (focusable ? (['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(c.tagName) && !c.disabled) : c.tagName === sel.toUpperCase()) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    getContext(type) {
      if (type === 'webgl2') return this._gl || (this._gl = makeGl());
      return new Proxy({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) }, { get: (t, n) => (n in t ? t[n] : () => {}), set: () => true });
    }
  }
  FEl.n = 0;

  const win = {
    devicePixelRatio: 1, innerWidth: 1000, innerHeight: 700,
    requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; }, cancelAnimationFrame() {},
    getComputedStyle: () => ({ position: 'relative' }), addEventListener() {}, removeEventListener() {}
  };
  const doc = {
    defaultView: win, activeElement: null,
    createElement: (t) => new FEl(t, doc),
    createElementNS: (ns, t) => new FEl(t, doc),
    contains: () => true,
    addEventListener(ev, fn) { doc._ls.push({ ev, fn }); listeners.map.set(ev + ':' + fn + ':doc', { el: doc, ev, fn }); listeners.added++; },
    removeEventListener(ev, fn) {
      const i = doc._ls.findIndex((l) => l.ev === ev && l.fn === fn);
      if (i >= 0) { doc._ls.splice(i, 1); listeners.map.delete(ev + ':' + fn + ':doc'); listeners.removed++; }
    },
    _ls: [],
    fire(ev, e = {}) {
      const evt = { type: ev, target: doc.body, key: '', preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...e };
      for (const l of doc._ls.slice()) if (l.ev === ev) l.fn(evt);
      return evt;
    }
  };
  doc.body = new FEl('body', doc);
  class FEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }

  const Sh = loadModule(FILE, 'IJShell', { Event: FEvent });
  const flush2 = async (n = 6) => {
    for (let i = 0; i < n; i++) { const q = rafQueue.splice(0); for (const fn of q) fn(); await new Promise((r) => setTimeout(r, 0)); }
  };
  const byClass = (root, cls, out = []) => {
    for (const c of root.children) { if (c.classList.contains(cls)) out.push(c); byClass(c, cls, out); }
    return out;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stagePtr = (x, y, extra = {}) => ({ clientX: x, clientY: y, pointerId: 1, ...extra });

  const root = new FEl('div', doc);
  root.clientWidth = 1000; root.clientHeight = 700;
  doc.body.appendChild(root);

  const ran = [], rois = [], tools = [];
  const commands = [
    { id: 'file.open', menu: ['File'], label: 'Open...', shortcut: 'Ctrl+O' },
    { id: 'edit.undo', menu: ['Edit'], label: 'Undo', shortcut: 'Ctrl+Z', enabled: () => false },
    { id: 'image.bc', menu: ['Image', 'Adjust'], label: 'Brightness/Contrast...', shortcut: 'Shift+C' },
    { id: 'analyze.measure', menu: ['Analyze'], label: 'Measure', shortcut: 'm' }
  ];
  const shell = Sh.create(root, {
    t: (k, f) => f,
    commands,
    getState: () => ({}),
    onCommand: (c, o) => ran.push([c.id, o.source]),
    onRoi: (r, o) => rois.push([r, o]),
    onTool: (id) => tools.push(id),
    readPixel: async (x, y) => [x + y],
    display: {}
  });
  shell.el.clientWidth = 1000; shell.el.clientHeight = 700;
  shell.stage.clientWidth = 800; shell.stage.clientHeight = 600;
  shell.display.resize();

  // menu bar: ImageJ order and hover / keyboard behaviour
  const titles = byClass(shell.menubar, 'ij-menu-title');
  deq(titles.map((b) => b.textContent), ['File', 'Edit', 'Image', 'Analyze']);
  titles[2].fire('click');
  let panels = byClass(shell.el, 'ij-menu-panel');
  assert.equal(panels.length, 1);
  deq(byClass(panels[0], 'ij-menu-label').map((x) => x.textContent), ['Adjust']);
  assert.ok(byClass(panels[0], 'ij-menu-item')[0].classList.contains('has-children'));
  // hovering another title switches while the bar is armed
  titles[1].fire('pointerenter');
  panels = byClass(shell.el, 'ij-menu-panel');
  deq(byClass(panels[0], 'ij-menu-label').map((x) => x.textContent), ['Undo']);
  assert.ok(byClass(panels[0], 'ij-menu-item')[0].classList.contains('is-disabled'));
  titles[2].fire('pointerenter');
  // keyboard: Right opens the submenu, Enter runs the command
  shell.menubar.fire('keydown', { key: 'ArrowRight' });
  panels = byClass(shell.el, 'ij-menu-panel');
  assert.equal(panels.length, 2, 'submenu panel open');
  assert.equal(byClass(panels[1], 'ij-menu-shortcut')[0].textContent, 'Shift+C');
  shell.menubar.fire('keydown', { key: 'Enter' });
  deq(ran.pop(), ['image.bc', 'key']);
  assert.equal(byClass(shell.el, 'ij-menu-panel').length, 0, 'closed after a command');
  // a click on a leaf runs it
  titles[0].fire('click');
  byClass(shell.el, 'ij-menu-item')[0].fire('click');
  deq(ran.pop(), ['file.open', 'menu']);
  // Escape closes
  titles[3].fire('click');
  shell.menubar.fire('keydown', { key: 'Escape' });
  assert.equal(byClass(shell.el, 'ij-menu-panel').length, 0);
  // click outside closes
  titles[3].fire('click');
  doc.fire('pointerdown', { target: doc.body });
  assert.equal(byClass(shell.el, 'ij-menu-panel').length, 0);

  // shortcuts: plain key, modified key, disabled command, typing target
  doc.fire('keydown', { key: 'm' });
  deq(ran.pop(), ['analyze.measure', 'key']);
  doc.fire('keydown', { key: 'z', ctrlKey: true });
  assert.equal(ran.length, 0, 'disabled command is not run');
  const typing = new FEl('input', doc); typing.type = 'text';
  doc.fire('keydown', { key: 'm', target: typing });
  assert.equal(ran.length, 0, 'ignored while typing');
  const slider = new FEl('input', doc); slider.type = 'range';
  doc.fire('keydown', { key: 'm', target: slider });
  deq(ran.pop(), ['analyze.measure', 'key'], 'a focused range input does not block shortcuts');

  // image + title bar
  const channels = [0, 1, 2].map((i) => ({ name: 'c' + i, color: '#fff', display: { min: 0, max: 255, lut: 'Grays', invert: false } }));
  shell.setImage({ docId: 1, name: 'embryo.tif', width: 100, height: 100, bitDepth: 8, channels, calibration: { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'µm' } });
  shell.display.setTileProvider(async (c, L, tx, ty) => { const t = P.tileTexels(L, tx, ty, 100, 100); return mkTileFake(t.w, t.h, 20); });
  function mkTileFake(w, h, v) { const data = new Uint8Array(w * h); data.fill(v); return { width: w, height: h, bitDepth: 8, data }; }
  await flush2(4);
  assert.equal(byClass(shell.el, 'ij-title-name')[0].textContent, 'embryo.tif');
  assert.equal(byClass(shell.el, 'ij-title-zoom')[0].textContent, ' (100%)');
  assert.equal(byClass(shell.el, 'ij-subtitle')[0].textContent, '50×50 µm (100×100); 8-bit; 29.3K'.replace('29.3K', '29K'));
  const chBar = byClass(shell.el, 'ij-channel-bar')[0];
  assert.equal(chBar.hidden, false);
  assert.equal(byClass(shell.el, 'ij-channel-label')[0].textContent, 'c: 1/3');
  const chSlider = byClass(shell.el, 'ij-channel-slider')[0];
  chSlider.value = '3'; chSlider.fire('input');
  assert.equal(byClass(shell.el, 'ij-channel-label')[0].textContent, 'c: 3/3');

  // ROI drawing / resizing / moving with the rectangle tool; image (100x100) is centred at (350, 250)
  const st = shell.stage;
  st.fire('pointerdown', stagePtr(360, 260));
  st.fire('pointermove', stagePtr(400, 300));
  let last = rois[rois.length - 1];
  deq({ ...last[0] }, { type: 'rect', x: 10, y: 10, w: 40, h: 40 });
  assert.equal(last[1].final, false);
  st.fire('pointerup', stagePtr(400, 300));
  last = rois[rois.length - 1];
  assert.equal(last[1].final, true);
  deq({ ...shell.getActiveRoi() }, { type: 'rect', x: 10, y: 10, w: 40, h: 40 });
  assert.equal(byClass(shell.el, 'ij-status-text')[0].textContent, 'x=10, y=10, w=40, h=40');
  // resize from the south-east handle
  st.fire('pointerdown', stagePtr(400, 300));
  st.fire('pointermove', stagePtr(420, 320));
  st.fire('pointerup', stagePtr(420, 320));
  deq({ ...shell.getActiveRoi() }, { type: 'rect', x: 10, y: 10, w: 60, h: 60 });
  assert.equal(rois[rois.length - 1][1].source, 'resize');
  // move from the inside
  st.fire('pointerdown', stagePtr(380, 280));
  st.fire('pointermove', stagePtr(395, 285));
  st.fire('pointerup', stagePtr(395, 285));
  deq({ ...shell.getActiveRoi() }, { type: 'rect', x: 25, y: 15, w: 60, h: 60 });
  assert.equal(rois[rois.length - 1][1].source, 'move');
  // arrow nudge
  doc.fire('keydown', { key: 'ArrowRight', target: st });
  assert.equal(shell.getActiveRoi().x, 26);
  // a click without a drag deselects
  st.fire('pointerdown', stagePtr(355, 255));
  st.fire('pointerup', stagePtr(355, 255));
  assert.equal(shell.getActiveRoi(), null);
  assert.equal(rois[rois.length - 1][0], null);

  // polygon: click, click, click, double-click
  shell.setTool('polygon');
  st.fire('pointerdown', stagePtr(360, 260, { detail: 1 }));
  st.fire('pointermove', stagePtr(420, 260));
  st.fire('pointerdown', stagePtr(420, 260, { detail: 1 }));
  st.fire('pointerdown', stagePtr(420, 320, { detail: 1 }));
  st.fire('dblclick', stagePtr(420, 320));
  assert.equal(shell.getActiveRoi().type, 'polygon');
  assert.equal(shell.getActiveRoi().points.length, 3);
  // Escape cancels an unfinished polygon
  st.fire('pointerdown', stagePtr(440, 340, { detail: 1 }));          // outside the finished polygon
  doc.fire('keydown', { key: 'Escape', target: st });
  assert.equal(shell.getActiveRoi(), null);

  // point tool, shift adds
  shell.setTool('point');
  st.fire('pointerdown', stagePtr(360, 260));
  st.fire('pointerdown', stagePtr(380, 270, { shiftKey: true }));
  assert.equal(shell.getActiveRoi().points.length, 2);
  deq(shell.getActiveRoi().points[0], [10.5, 10.5]);

  // line tool
  shell.setTool('line');
  st.fire('pointerdown', stagePtr(450, 250));
  st.fire('pointermove', stagePtr(460, 250));
  st.fire('pointerup', stagePtr(460, 250));
  const ln = shell.getActiveRoi();
  assert.equal(ln.type, 'line'); assert.equal(ln.x2 - ln.x1, 10);

  // toolbar click selects and notifies
  byClass(shell.el, 'ij-tool').find((b) => b.dataset.tool === 'oval').fire('click');
  assert.equal(shell.getTool(), 'oval'); deq(tools, ['oval']);

  // wheel zoom at the cursor (one notch = one ladder step), hand tool pans
  const v0 = shell.display.getView().zoom;
  st.fire('wheel', { deltaY: -100, deltaMode: 0, clientX: 400, clientY: 300 });
  assert.equal(shell.display.getView().zoom, P.nextZoom(v0, 1));
  shell.setTool('hand');
  shell.display.setZoom(16);                                          // 1600 px: larger than the viewport, so it can pan
  const o0 = shell.display.getView();
  st.fire('pointerdown', stagePtr(100, 100));
  st.fire('pointermove', stagePtr(130, 110));
  st.fire('pointerup', stagePtr(130, 110));
  const o1 = shell.display.getView();
  assert.ok(o1.ox !== o0.ox && o1.oy !== o0.oy, 'pan moved the view');

  // pixel read-out (coalesced) + status / progress / warning
  shell.display.fit();
  shell.setTool('rect');
  st.fire('pointermove', stagePtr(360, 260));
  await sleep(5);
  assert.match(byClass(shell.el, 'ij-status-pos')[0].textContent, /^x=10, y=10 \(5, 5 µm\), value=20$/);
  shell.setProgress({ fraction: 0.375, label: 'Loading 37 %', cancellable: true });
  assert.equal(byClass(shell.el, 'ij-progress-fill')[0].style.width, '38%');
  assert.equal(byClass(shell.el, 'ij-cancel')[0].hidden, false);
  shell.setProgress(null);
  assert.equal(byClass(shell.el, 'ij-progress')[0].hidden, true);
  shell.setWarning('not protected');
  assert.equal(byClass(shell.el, 'ij-warning')[0].textContent, 'not protected');

  // ── dialogs ──
  const previews = [];
  const p = shell.windows.dialog({
    title: 'Gaussian Blur',
    fields: [
      { type: 'number', id: 'sigma', label: 'Sigma', value: 2, min: 0, max: 50, units: 'px' },
      { type: 'check', id: 'scaled', label: 'Scaled units', value: false },
      { type: 'choice', id: 'm', label: 'Mode', options: ['a', { value: 'b', label: 'B' }], value: 'b' },
      { type: 'message', id: 'msg', label: 'hello' }
    ],
    preview: { onChange: (v) => previews.push(v) }
  });
  const backdrop = byClass(shell.el, 'ij-dialog-backdrop')[0];
  assert.ok(backdrop);
  assert.equal(shell.windows.hasModal(), true);
  const inputs = [];
  const collect = (n) => { for (const c of n.children) { if (['INPUT', 'SELECT'].includes(c.tagName)) inputs.push(c); collect(c); } };
  collect(backdrop);
  const sigma = inputs.find((i) => i.name === 'sigma');
  assert.equal(sigma.value, '2');
  assert.equal(doc.activeElement, sigma, 'first field focused');
  const body = byClass(backdrop, 'ij-dialog-body')[0];
  // invalid value blocks OK
  sigma.value = '-4'; body.fire('input');
  assert.ok(sigma.classList.contains('ij-invalid'));
  const ev1 = doc.fire('keydown', { key: 'Enter', target: sigma });
  assert.equal(ev1.stopped, true);
  assert.equal(shell.windows.hasModal(), true, 'still open');
  // valid value + preview
  sigma.value = '3,5'; body.fire('input');
  assert.ok(!sigma.classList.contains('ij-invalid'));
  const pbox = inputs.find((i) => String(i.id).endsWith('-preview'));
  pbox.checked = true; pbox.fire('change');
  deq({ ...previews[previews.length - 1] }, { sigma: 3.5, scaled: false, m: 'b' });
  const nPrev = previews.length;
  body.fire('input'); body.fire('input');
  await sleep(160);
  assert.equal(previews.length, nPrev + 1, 'typing is debounced');
  // Tab wraps inside the dialog
  const btns = byClass(backdrop, 'ij-btn');
  btns[btns.length - 1].focus();
  const tabEv = doc.fire('keydown', { key: 'Tab', target: btns[btns.length - 1] });
  assert.equal(tabEv.defaultPrevented, true);
  assert.notEqual(doc.activeElement, btns[btns.length - 1], 'focus moved to the first control');
  // Enter commits
  doc.fire('keydown', { key: 'Enter', target: sigma });
  const values = await p;
  deq({ ...values }, { sigma: 3.5, scaled: false, m: 'b' });
  assert.equal(previews[previews.length - 1], null, 'preview cleared on close');
  assert.equal(shell.windows.hasModal(), false);
  assert.equal(byClass(shell.el, 'ij-dialog-backdrop').length, 0);
  // Escape cancels
  const p2 = shell.windows.dialog({ title: 'x', fields: [{ type: 'number', id: 'n', label: 'N', value: 1 }] });
  doc.fire('keydown', { key: 'Escape', target: doc.body });
  assert.equal(await p2, null);
  // OK button
  const p3 = shell.windows.dialog({ title: 'x', fields: [{ type: 'number', id: 'n', label: 'N', value: 1, integer: true }] });
  const okBtn = byClass(shell.el, 'ij-btn--primary')[0];
  okBtn.fire('click');
  deq({ ...(await p3) }, { n: 1 });
  // confirm (no platform Dialog in this sandbox -> own dialog)
  const pc = shell.windows.confirm({ title: 'Leave?', message: 'Unsaved', options: [{ id: 'save', label: 'Save' }, { id: 'discard', label: 'Discard', variant: 'danger' }], dismissId: 'cancel' });
  const cbtns = byClass(shell.el, 'ij-btn');
  deq(cbtns.map((b) => b.textContent), ['Save', 'Discard']);
  cbtns[1].fire('click');
  assert.equal(await pc, 'discard');
  const pc2 = shell.windows.confirm({ title: 'x', message: 'y', options: [{ id: 'a', label: 'A' }], dismissId: 'cancel' });
  doc.fire('keydown', { key: 'Escape', target: doc.body });
  assert.equal(await pc2, 'cancel');

  // ── floating windows ──
  let closed = 0;
  const content = new FEl('div', doc);
  const fw = shell.windows.floating({ id: 'bc', title: 'B&C', content, onClose: () => closed++, x: 60, y: 80 });
  assert.equal(byClass(shell.el, 'ij-window').length, 1);
  assert.equal(fw.el.style.left, '60px');
  assert.equal(shell.windows.floating({ id: 'bc', title: 'again' }), fw, 'same id raises the existing window');
  const bar = byClass(fw.el, 'ij-window-title')[0];
  bar.fire('pointerdown', { clientX: 70, clientY: 90, pointerId: 1 });
  bar.fire('pointermove', { clientX: 170, clientY: 140, pointerId: 1 });
  bar.fire('pointerup', { clientX: 170, clientY: 140, pointerId: 1 });
  assert.equal(fw.el.style.left, '160px'); assert.equal(fw.el.style.top, '130px');
  bar.fire('pointerdown', { clientX: 170, clientY: 140, pointerId: 1 });
  bar.fire('pointermove', { clientX: 9000, clientY: -500, pointerId: 1 });
  bar.fire('pointerup', { clientX: 9000, clientY: -500, pointerId: 1 });
  assert.ok(parseFloat(fw.el.style.left) <= 1000 - 24 && parseFloat(fw.el.style.top) >= 0, 'stays inside the root');
  byClass(fw.el, 'ij-window-close')[0].fire('click');
  assert.equal(closed, 1);
  assert.equal(byClass(shell.el, 'ij-window').length, 0);
  assert.equal(fw.isOpen(), false);

  // ── refreshMenus: no listener growth, buttons (and their focus) kept ──
  {
    const t0 = byClass(shell.menubar, 'ij-menu-title');
    t0[1].focus();
    const before = listeners.added - listeners.removed;
    for (let i = 0; i < 50; i++) shell.refreshMenus();
    assert.equal(listeners.added - listeners.removed, before, 'refreshMenus leaves the listener count alone');
    const t1 = byClass(shell.menubar, 'ij-menu-title');
    assert.equal(t1.length, t0.length);
    assert.ok(t1.every((b, i) => b === t0[i]), 'same title buttons');
    assert.equal(doc.activeElement, t0[1], 'focus kept');
  }

  // ── floating windows and modals follow a smaller root ──
  {
    const c2 = new FEl('div', doc);
    const w2 = shell.windows.floating({ id: 'far', title: 'Far', content: c2, x: 900, y: 500 });
    const pm = shell.windows.dialog({ title: 'x', fields: [{ type: 'number', id: 'n', label: 'N', value: 1 }] });
    const dbox = byClass(shell.el, 'ij-dialog')[0];
    const leftBefore = parseFloat(dbox.style.left);
    shell.el.clientWidth = 400; shell.el.clientHeight = 300;
    shell.windows.reflow();
    assert.ok(parseFloat(w2.el.style.left) <= 400 - 24, 'window pulled back inside: ' + w2.el.style.left);
    assert.ok(parseFloat(w2.el.style.top) <= 300 - 24);
    assert.ok(parseFloat(dbox.style.left) < leftBefore, 'modal re-centred');
    doc.fire('keydown', { key: 'Escape', target: doc.body });
    assert.equal(await pm, null);
    // closing a focused window gives the focus back to the image stage
    w2.el.focus();
    w2.close();
    assert.equal(doc.activeElement, shell.stage, 'focus returns to the stage');
    shell.el.clientWidth = 1000; shell.el.clientHeight = 700;
  }

  // ── destroy: nothing left behind ──
  shell.destroy();
  assert.equal(root.children.length, 0);
  assert.equal(live.size, 0, 'GL objects freed');
  // listeners on elements the shell built die with those elements; the ones on persistent
  // objects (the document, the stage and the canvases) must all be gone
  const stuck = Array.from(listeners.map.values()).filter((l) => l.el === doc || l.el === st || l.el.tagName === 'CANVAS');
  assert.equal(stuck.length, 0, 'persistent listeners removed: ' + stuck.map((l) => l.ev).join(','));
  shell.destroy();
}

console.log('ij-view (pure helpers, IJDisplay on a fake WebGL2, IJShell + IJWindows on a fake DOM): OK');
