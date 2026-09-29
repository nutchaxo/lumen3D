// 3D view export (PNG): the core "Export the 3D view" feature of the viewer.
//
//   • tile planning (VolumeViewer): every output pixel belongs to exactly one tile;
//   • each tile's camera.setViewOffset arguments make the tiles one seamless frustum —
//     checked against the real three.js: a world point lands on the same image pixel
//     whether projected by the full camera or by the tile holding it;
//   • the jitter offset hands every tile fragment the gl_FragCoord of one full render;
//   • render-target fallbacks (MSAA, then halving tiles down to 256 px);
//   • µm per output pixel: the on-screen bar's rule (VolumeGrid._updateScaleBar),
//     scaled by the export factor — the exported bar at k× is the screen bar k× longer;
//   • size clamping to what a 2D canvas holds, requested sizes, bar colours and layout,
//     file-name sanitising, the "As displayed" background (viewer.js);
//   • structure: the button and its dialog in viewer.html (i18n attributes), the
//     handler wired in viewer.js and hidden in an embedded page, the renderer state
//     restored in a `finally`, the shader's jitter and alpha hooks.
//
// Run: node tests/js/test_view_export.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadModule, ROOT } from './harness.mjs';

const require = createRequire(import.meta.url);
const THREE = require('../../js/vendor/three.min.js');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const vvSrc = read('js/viewers/volume-viewer.js');
const viewerSrc = read('js/pages/viewer.js');
const gridSrc = read('js/viewers/volume-grid.js');
const html = read('viewer.html');

function lifter(src, file) {
  return (name) => {
    const m = src.match(new RegExp(`\\n  (?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n`));
    assert.ok(m, `${name} must be defined at module level in ${file}`);
    return m[0];
  };
}
const liftVV = lifter(vvSrc, 'volume-viewer.js');
const liftViewer = lifter(viewerSrc, 'viewer.js');
const liftGrid = lifter(gridSrc, 'volume-grid.js');

const Utils = loadModule('js/core/utils.js', 'Utils', {
  window: { location: { origin: 'https://lab.example' } }, document: {}, requestAnimationFrame: () => {},
});
const DisplayPresets = loadModule('js/core/display-presets.js', 'DisplayPresets', { console });

// ── VolumeViewer pure parts ──────────────────────────────────────────────────
const VV = new Function('THREE', `
  ${liftVV('_planExportTiles')}
  ${liftVV('_exportTileViewOffset')}
  ${liftVV('_exportTileFragOffset')}
  ${liftVV('_exportTileConfigs')}
  ${liftVV('_micronsPerPixelFor')}
  return { _planExportTiles, _exportTileViewOffset, _exportTileFragOffset, _exportTileConfigs, _micronsPerPixelFor };
`)(THREE);

// Tiles cover every pixel exactly once: per-pixel count on small images, and on large
// ones "inside the image + pairwise disjoint + areas summing to W·H" (equivalent).
{
  const perPixel = (W, H, tile) => {
    const count = new Uint8Array(W * H);
    for (const t of VV._planExportTiles(W, H, tile)) {
      assert.ok(t.w > 0 && t.h > 0 && t.w <= tile && t.h <= tile, `tile within ${tile}px (${JSON.stringify(t)})`);
      for (let y = t.y; y < t.y + t.h; y++) for (let x = t.x; x < t.x + t.w; x++) count[y * W + x]++;
    }
    assert.ok(count.every((c) => c === 1), `${W}×${H} in ${tile}px tiles: every pixel exactly once`);
  };
  perPixel(1, 1, 2048);
  perPixel(7, 5, 2);
  perPixel(300, 200, 64);
  perPixel(257, 129, 128);
  perPixel(640, 480, 2048);

  const byArea = (W, H, tile) => {
    const tiles = VV._planExportTiles(W, H, tile);
    let area = 0;
    for (const t of tiles) {
      assert.ok(t.x >= 0 && t.y >= 0 && t.x + t.w <= W && t.y + t.h <= H, 'tile inside the image');
      area += t.w * t.h;
    }
    assert.equal(area, W * H, `${W}×${H}: tile areas sum to the image`);
    for (let i = 0; i < tiles.length; i++) {
      for (let j = i + 1; j < tiles.length; j++) {
        const a = tiles[i], b = tiles[j];
        const disjoint = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        assert.ok(disjoint, `${W}×${H}: tiles ${i} and ${j} overlap`);
      }
    }
    return tiles.length;
  };
  assert.equal(byArea(16384, 16384, 2048), 64);
  assert.equal(byArea(7680, 4320, 2048), 4 * 3);
  assert.equal(byArea(2049, 2048, 2048), 2);
  assert.equal(byArea(3001, 1999, 256), 12 * 8);
  assert.deepEqual(VV._planExportTiles(4096, 3000, 2048).map((t) => [t.x, t.y, t.w, t.h]),
    [[0, 0, 2048, 2048], [2048, 0, 2048, 2048], [0, 2048, 2048, 952], [2048, 2048, 2048, 952]],
    'row-major from the top-left, the last row shorter');
}

// setViewOffset makes the tiles ONE frustum: a world point lands on pixel (px, py) of
// the full image and on (px − x, py − y) of the tile that holds it.
{
  const W = 5000, H = 3001;
  const full = new THREE.PerspectiveCamera(45, W / H, 0.1, 100);
  full.position.set(0.3, -0.2, 2.5);
  full.lookAt(0.05, 0.02, 0);
  full.updateMatrixWorld();
  full.updateProjectionMatrix();
  const tiles = VV._planExportTiles(W, H, 2048);
  const tileCams = tiles.map((t) => {
    const cam = full.clone();
    cam.setViewOffset(...VV._exportTileViewOffset(t, W, H));
    cam.updateMatrixWorld();
    return cam;
  });
  assert.deepEqual(VV._exportTileViewOffset(tiles[1], W, H), [W, H, 2048, 0, 2048, 2048], 'fullWidth, fullHeight, x, y, w, h');
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  let checked = 0;
  for (let n = 0; n < 4000; n++) {
    const p = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(1.4);
    const ndc = p.clone().project(full);
    const px = (ndc.x + 1) / 2 * W;
    const py = (1 - ndc.y) / 2 * H;
    if (!(px >= 0 && px < W && py >= 0 && py < H)) continue;
    const i = tiles.findIndex((t) => px >= t.x && px < t.x + t.w && py >= t.y && py < t.y + t.h);
    assert.ok(i >= 0, 'every visible point falls in a tile');
    const t = tiles[i];
    const local = p.clone().project(tileCams[i]);
    const lx = (local.x + 1) / 2 * t.w;
    const ly = (1 - local.y) / 2 * t.h;
    assert.ok(Math.abs(lx - (px - t.x)) < 1e-6 && Math.abs(ly - (py - t.y)) < 1e-6,
      `seamless: (${px.toFixed(3)}, ${py.toFixed(3)}) → tile ${i} (${lx.toFixed(3)}, ${ly.toFixed(3)})`);
    checked++;
  }
  assert.ok(checked > 1000, `enough points checked (${checked})`);
  const cleared = tileCams[0].clone();
  cleared.clearViewOffset();
  cleared.aspect = W / H;
  cleared.updateProjectionMatrix();
  assert.ok(cleared.projectionMatrix.equals(full.projectionMatrix), 'clearing the offset gives the full frustum back');
}

// The jitter offset: tile fragment (fx, fy) — GL window coordinates, origin at the
// tile's bottom-left — plus the offset is the fragment of one full W×H render.
{
  const W = 300, H = 170;
  for (const t of VV._planExportTiles(W, H, 64)) {
    const [ox, oy] = VV._exportTileFragOffset(t, H);
    for (const [c, r] of [[t.x, t.y], [t.x + t.w - 1, t.y + t.h - 1], [t.x + 3 < t.x + t.w ? t.x + 3 : t.x, t.y]]) {
      const fx = (c - t.x) + 0.5;
      const fy = (t.y + t.h - 1 - r) + 0.5;
      assert.equal(fx + ox, c + 0.5, 'column continues across the seam');
      assert.equal(fy + oy, (H - 1 - r) + 0.5, 'row continues across the seam (GL rows count upward)');
    }
  }
}

// Render-target fallbacks, best first.
assert.deepEqual(VV._exportTileConfigs(2048, 4), [
  { tile: 2048, samples: 4 }, { tile: 2048, samples: 0 }, { tile: 1024, samples: 0 },
  { tile: 512, samples: 0 }, { tile: 256, samples: 0 },
]);
assert.deepEqual(VV._exportTileConfigs(2048, 0).map((c) => c.samples), [0, 0, 0, 0], 'no MSAA entry without samples');
assert.deepEqual(VV._exportTileConfigs(200, 4), [{ tile: 200, samples: 4 }, { tile: 200, samples: 0 }], 'a small GPU limit is tried as is');
assert.deepEqual(VV._exportTileConfigs(1500, 0).map((c) => c.tile), [1500, 750, 375, 256], 'halving stops at 256 px');

// ── µm per output pixel = the on-screen bar's rule ───────────────────────────
// Same scenario as test_scale_bar_3d: 45° fov, camera at 2.5, an 800×600 view,
// physical.x 1630.66 µm over one world unit. 2·tan(22.5°)·2.5 = 2.0711 units span the
// view height → 5.6286 µm per CSS px; the on-screen bar reads 500 µm over 89 px.
const physical = { x: 1630.656774, y: 1630.656774, z: 527.05, calibrationStatus: 'estimated', mode: 'estimated' };
const camera = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 100);
camera.position.set(0, 0, 2.5);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();
const cube = { position: new THREE.Vector3(0, 0, 0), scale: new THREE.Vector3(1, 1, 0.323) };
{
  const umPerCssPx = VV._micronsPerPixelFor(camera, cube, physical, 600);
  assert.ok(Math.abs(umPerCssPx - 2 * Math.tan(Math.PI / 8) * 2.5 * 1630.656774 / 600) < 1e-9);
  assert.ok(Math.abs(umPerCssPx - 5.6286) < 1e-3, `5.6286 µm per CSS px (got ${umPerCssPx})`);
  assert.ok(Math.abs(VV._micronsPerPixelFor(camera, cube, physical, 2400) - umPerCssPx / 4) < 1e-12,
    'an image 4× taller at the same camera: µm per pixel divided by 4');
  // Depth along the view axis, as the screen bar: a panned specimen keeps its scale.
  const panned = { position: new THREE.Vector3(0.4, 0.3, 0), scale: cube.scale };
  assert.ok(Math.abs(VV._micronsPerPixelFor(camera, panned, physical, 600) - umPerCssPx) < 1e-12, 'pan-invariant');
  assert.equal(VV._micronsPerPixelFor(camera, cube, { ...physical, calibrationStatus: 'metadata-missing', mode: 'metadata-missing' }, 600), 0,
    'no calibration → no µm');
  const behind = { position: new THREE.Vector3(0, 0, 5), scale: cube.scale };
  assert.equal(VV._micronsPerPixelFor(camera, behind, physical, 600), 0, 'specimen behind the camera → 0');

  // Against the on-screen bar itself (VolumeGrid._updateScaleBar, lifted and run).
  const bar = { classes: new Set(), style: {}, textContent: '' };
  bar.classList = { add: (c) => bar.classes.add(c), remove: (c) => bar.classes.delete(c) };
  const Grid = new Function('THREE', 'document', 'Utils', 'env', `
    const _scaleDir = new THREE.Vector3();
    const _scaleRel = new THREE.Vector3();
    let _camera = env.camera, _renderer = env.renderer, _cube = env.cube;
    let _gridMode = 1;
    let _getPhysicalSize = () => env.physical;
    ${liftGrid('_updateScaleBar')}
    return { update: _updateScaleBar };
  `)(THREE, { getElementById: () => bar }, Utils, {
    camera, cube, physical, renderer: { domElement: { getBoundingClientRect: () => ({ width: 800, height: 600 }) } },
  });
  Grid.update();
  assert.equal(bar.textContent, '500 µm');
  const screenWidth = Number(String(bar.style.width).replace('px', ''));
  assert.equal(Math.max(20, Math.round(500 / umPerCssPx)), screenWidth, 'same µm per pixel as the on-screen bar');
}

// ── viewer.js pure parts ─────────────────────────────────────────────────────
const env = { displayState: { backgroundPreset: 'dark', backgroundColor: '#000000' } };
const V = new Function('Utils', 'DisplayPresets', 'env', `
  const VIEW_EXPORT_LIMITS = { maxSide: 16384, maxArea: 268435456 };
  const _displayState = env.displayState;
  ${liftViewer('_viewExportRequestedSize')}
  ${liftViewer('_clampExportSize')}
  ${liftViewer('_viewExportBackground')}
  ${liftViewer('_exportScaleBarLayout')}
  ${liftViewer('_exportScaleBarColors')}
  ${liftViewer('_viewExportFileName')}
  return { _viewExportRequestedSize, _clampExportSize, _viewExportBackground, _exportScaleBarLayout,
           _exportScaleBarColors, _viewExportFileName, VIEW_EXPORT_LIMITS };
`)(Utils, DisplayPresets, env);

// Requested sizes: the view's drawing buffer, multiples, a width with the view's aspect.
{
  const base = { width: 1600, height: 900, cssWidth: 800, cssHeight: 450 };
  assert.deepEqual(V._viewExportRequestedSize('screen', base), { width: 1600, height: 900 });
  assert.deepEqual(V._viewExportRequestedSize('2', base), { width: 3200, height: 1800 });
  assert.deepEqual(V._viewExportRequestedSize('4', base), { width: 6400, height: 3600 });
  assert.deepEqual(V._viewExportRequestedSize('custom', base, '3000'), { width: 3000, height: 1688 }, 'height follows the aspect');
  assert.deepEqual(V._viewExportRequestedSize('custom', base, ''), { width: 1600, height: 900 }, 'empty field → screen width');
  assert.deepEqual(V._viewExportRequestedSize('custom', base, '3'), { width: 16, height: 9 }, '16 px at least');
}

// Clamping to what a 2D canvas holds, aspect kept, never above a limit.
{
  const L = V.VIEW_EXPORT_LIMITS;
  assert.deepEqual(V._clampExportSize(800, 600), { width: 800, height: 600, clamped: false });
  assert.deepEqual(V._clampExportSize(16384, 16384), { width: 16384, height: 16384, clamped: false }, 'the limit itself fits');
  assert.deepEqual(V._clampExportSize(20000, 10000), { width: 16384, height: 8192, clamped: true });
  const big = V._clampExportSize(30000, 30000);
  assert.deepEqual(big, { width: 16384, height: 16384, clamped: true });
  const tall = V._clampExportSize(6400, 25600);
  assert.equal(tall.height, 16384);
  assert.equal(tall.width, 4096);
  const area = V._clampExportSize(3000, 2000, { maxSide: 10000, maxArea: 1e6 });
  assert.ok(area.clamped && area.width * area.height <= 1e6, 'area limit honoured');
  assert.ok(Math.abs(area.width / area.height - 1.5) < 0.01, 'aspect kept');
  for (const [w, h] of [[16385, 1], [99999, 12345], [12345, 99999], [18000, 16000], [16384, 16385]]) {
    const s = V._clampExportSize(w, h);
    assert.ok(s.clamped, `${w}×${h} clamped`);
    assert.ok(s.width <= L.maxSide && s.height <= L.maxSide && s.width * s.height <= L.maxArea, `${w}×${h} → ${s.width}×${s.height} within limits`);
    assert.ok(Math.abs(s.width / s.height - w / h) / (w / h) < 0.01 || Math.min(s.width, s.height) < 100, 'aspect kept');
  }
}

// Background: the chosen colour, or the sidebar preset for "As displayed".
{
  assert.equal(V._viewExportBackground('black'), '#000000');
  assert.equal(V._viewExportBackground('white'), '#ffffff');
  assert.equal(V._viewExportBackground('transparent'), null);
  assert.equal(V._viewExportBackground('display'), '#000000', 'dark preset');
  env.displayState.backgroundPreset = 'paper';
  assert.equal(V._viewExportBackground('display'), '#f8f5ec');
  env.displayState.backgroundPreset = 'transparent';
  assert.equal(V._viewExportBackground('display'), null, 'transparent preset → transparent PNG');
  env.displayState.backgroundPreset = 'custom';
  env.displayState.backgroundColor = '#123456';
  assert.equal(V._viewExportBackground('display'), '#123456');
}

// The exported bar is the screen bar k× larger: same length in µm, k× the pixels.
{
  const umPerCssPx = VV._micronsPerPixelFor(camera, cube, physical, 600);
  const at = (k) => V._exportScaleBarLayout({
    width: 800 * k, height: 600 * k, cssWidth: 800, cssHeight: 600,
    umPerPx: VV._micronsPerPixelFor(camera, cube, physical, 600 * k),
  });
  const one = at(1);
  assert.equal(one.lengthUm, 500);
  assert.equal(one.label, '500 µm');
  assert.ok(Math.abs(one.barPx - 500 / umPerCssPx) < 1e-9);
  assert.equal(Math.round(one.barPx), 89, 'the on-screen 89 px');
  for (const k of [2, 3.5, 4, 10]) {
    const l = at(k);
    assert.equal(l.lengthUm, 500, `k=${k}: same length in µm`);
    assert.ok(Math.abs(l.barPx - one.barPx * k) < 1e-6, `k=${k}: bar ${k}× longer in pixels`);
    assert.ok(Math.abs(l.margin - 20 * k) < 1e-9 && Math.abs(l.fontPx - 12 * k) < 1e-9 && Math.abs(l.thickness - 2 * k) < 1e-9, 'margin, text, rule scale with k');
    assert.ok(Math.abs(l.x + l.barPx - (800 * k - 20 * k)) < 1e-6, 'right-aligned at the margin');
    assert.ok(Math.abs(l.y + l.thickness - (600 * k - 20 * k)) < 1e-6, 'bottom at the margin');
    // The bar measures what it says: barPx output pixels × µm per output pixel.
    assert.ok(Math.abs(l.barPx * VV._micronsPerPixelFor(camera, cube, physical, 600 * k) - 500) < 1e-9);
  }
  assert.equal(V._exportScaleBarLayout({ width: 800, height: 600, cssWidth: 800, cssHeight: 600, umPerPx: 0 }), null, 'no calibration → no bar');
}

// Bar colours contrast with the background.
{
  assert.equal(V._exportScaleBarColors('#000000').fill, '#ffffff');
  assert.equal(V._exportScaleBarColors(null).fill, '#ffffff', 'transparent: the screen bar (white, dark halo)');
  assert.equal(V._exportScaleBarColors('#1a1d27').fill, '#ffffff');
  assert.equal(V._exportScaleBarColors('#ffffff').fill, '#000000');
  assert.equal(V._exportScaleBarColors('#f4f6fb').fill, '#000000', 'light preset');
  assert.equal(V._exportScaleBarColors('#f8f5ec').fill, '#000000', 'paper preset');
}

// File name: "<dataset>_3d_<W>x<H>.png", sanitised like the other exports.
{
  assert.equal(V._viewExportFileName('Egfl7eGFP E8.5 / Em3 (fixed)', 1920, 1080), 'Egfl7eGFP_E8.5_Em3_fixed_3d_1920x1080.png');
  assert.equal(V._viewExportFileName('__embryo__', 10, 20), 'embryo_3d_10x20.png');
  assert.equal(V._viewExportFileName('', 10, 20), 'view_3d_10x20.png');
  assert.equal(V._viewExportFileName(undefined, 10, 20), 'view_3d_10x20.png');
  assert.equal(V._viewExportFileName('../../etc/passwd', 1, 1), '.._.._etc_passwd_3d_1x1.png', 'no path separator survives');
}

// ── Structure ────────────────────────────────────────────────────────────────
{
  const button = html.match(/<button[^>]*id="btn-export-view"[^>]*>\s*<i data-lucide="([^"]+)"/);
  assert.ok(button, 'viewer.html carries the export button');
  assert.equal(button[1], 'image-down');
  const tag = html.match(/<button[^>]*id="btn-export-view"[^>]*>/)[0];
  assert.ok(/data-i18n-title="tips\.exportView"/.test(tag) && /data-i18n-aria="tips\.exportView"/.test(tag), 'translated title and label');
  assert.ok(/aria-controls="view-export-popover"/.test(tag) && /aria-expanded="false"/.test(tag), 'announces its popover');
  const overlay = html.slice(html.indexOf('<div class="canvas-overlay">'), html.indexOf('<div class="canvas-overlay">') + 2000);
  const iReset = overlay.indexOf('id="btn-reset-view"');
  const iExport = overlay.indexOf('id="btn-export-view"');
  const iWorkspace = overlay.indexOf('id="btn-reset-workspace"');
  assert.ok(iReset > 0 && iExport > iReset && iWorkspace > iExport, 'next to btn-reset-view, in the floating controls');

  const pop = html.slice(html.indexOf('id="view-export-popover"'), html.indexOf('<!-- Quality loading progress'));
  assert.ok(/role="dialog"/.test(html.match(/<div[^>]*id="view-export-popover"[^>]*>/)[0]), 'a dialog');
  for (const v of ['screen', '2', '4', 'custom']) assert.ok(pop.includes(`name="view-export-size" value="${v}"`), `size ${v}`);
  for (const v of ['display', 'transparent', 'black', 'white']) assert.ok(pop.includes(`name="view-export-bg" value="${v}"`), `background ${v}`);
  assert.ok(/id="view-export-scalebar" checked/.test(pop), 'scale bar on by default');
  for (const id of ['view-export-width', 'view-export-dims', 'view-export-clamp', 'view-export-scalebar-note',
    'view-export-status', 'view-export-fill', 'btn-view-export-go', 'btn-view-export-cancel', 'btn-view-export-close']) {
    assert.ok(pop.includes(`id="${id}"`), `${id} in the dialog`);
  }
  assert.ok(!/\sstyle="/.test(pop) && !/onclick=/.test(pop), 'no inline style or handler in the dialog');
  for (const key of ['exportView.title', 'exportView.size', 'exportView.sizeScreen', 'exportView.width', 'exportView.clamped',
    'exportView.bgDisplay', 'exportView.bgBlack', 'exportView.bgWhite', 'exportView.overlays', 'exportView.scaleBar',
    'exportView.noCalibration', 'viewer.exportPng', 'app.cancel']) {
    assert.ok(pop.includes(`data-i18n="${key}"`), `${key} bound in the dialog`);
  }

  const bindVolume = liftViewer('_bindVolumeControls');
  assert.ok(/_bindViewExport\(\);/.test(bindVolume), '_bindVolumeControls wires the export');
  const bind = liftViewer('_bindViewExport');
  assert.ok(/if \(_isIframe\) \{[\s\S]*?btn\.classList\.add\('hidden'\)[\s\S]*?return;/.test(bind), 'hidden in an embedded page');
  assert.ok(/e\.key !== 'Escape'/.test(bind) && /'pointerdown', onOutside, true/.test(bind), 'Escape and a press outside close it');
  assert.ok(/aria-expanded', 'true'/.test(bind) && /aria-expanded', 'false'/.test(bind), 'aria-expanded kept in sync');
  const run = liftViewer('_runViewExport');
  assert.ok(/VolumeViewer\.renderViewImage\(\{/.test(run), 'renders through VolumeViewer.renderViewImage');
  assert.ok(/signal: controller\.signal/.test(run) && /onProgress:/.test(run), 'cancellable, with progress');
  assert.ok(/ExportManager\.downloadBlob\(blob, fileName\)/.test(run), 'downloads through ExportManager');
  assert.ok(/_viewExportFileName\(datasetMeta\?\.name/.test(run), 'named after the dataset');
  assert.ok(/_drawExportScaleBar\([\s\S]*?micronsPerPixel/.test(run), 'the bar uses the µm per pixel of the rendered image');
  assert.ok(/finally \{[\s\S]*?_viewExportAbort = null;[\s\S]*?_setViewExportBusy\(false\)/.test(run), 'busy state always released');
  assert.ok(/Timeline\.pause\(\)/.test(run), 'a playing timelapse is paused first');
  assert.ok(/exportView\.progressTile', 'Rendering tile \{tile\}\/\{tiles\}…'/.test(run), 'precise progress, not a spinner');

  const tile = liftVV('_renderExportTile');
  const fin = tile.slice(tile.lastIndexOf('} finally {'));
  for (const [re, what] of [
    [/renderer\.setRenderTarget\(prevTarget\)/, 'render target'],
    [/renderer\.setClearColor\(prevClearColor, prevClearAlpha\)/, 'clear colour and alpha'],
    [/snap\.camera\.clearViewOffset\(\)/, 'view offset'],
    [/material\.uniforms\.steps\.value = prevSteps/, 'step count'],
    [/m\.blending = saved\.blending/, 'material blending'],
    [/m\.uniforms\.exportAlpha\.value = saved\.exportAlpha/, 'export alpha'],
    [/m\.uniforms\.fragCoordOffset\.value\.copy\(saved\.offset\)/, 'jitter offset'],
    [/cube\.quaternion\.copy\(live\.quaternion\)/, 'live pose'],
  ]) assert.ok(re.test(fin), `the tile restores the ${what} in finally`);
  assert.ok(/material\.uniforms\.steps\.value = _targetSteps/.test(tile), 'idle step count, never the interactive one');
  assert.ok(/setViewOffset\(\.\.\._exportTileViewOffset\(tile, width, height\)\)/.test(tile), 'tile window of the full frustum');
  assert.ok(!/requestAnimationFrame/.test(tile), 'no frame callback in a tile');

  const render = liftVV('renderViewImage');
  assert.ok(/finally \{[\s\S]*?_disposeExportTargets\(targets\);[\s\S]*?_viewExportInFlight = false;[\s\S]*?_scheduleFrame\(\);/.test(render),
    'targets disposed, lock released and a normal frame scheduled in finally');
  assert.ok(/await _macrotask\(\)/.test(render) && !/requestAnimationFrame/.test(render), 'yields by macrotask (rAF freezes in a hidden tab)');
  assert.ok(/_throwIfViewExportStopped\(signal\)/.test(render), 'honours the AbortSignal between tiles');
  // Behaviour (superseded streams, slice loads, display changes): test_view_export_consistency.mjs.
  assert.ok(/_isVolumeStreaming\(\) \|\| _activeVolumeEntry !== entry/.test(render), 'a volume changing under the tiles restarts the image');
  assert.ok(/_sameExportFingerprint\(fingerprint, _exportFingerprint\(\)\)/.test(render), 'so does a display change');
  assert.ok(/\n    renderViewImage,\n    getViewSize,\n    micronsPerPixel,\n/.test(vvSrc), 'exported by VolumeViewer');
  assert.ok(/hash\(gl_FragCoord\.xy \+ fragCoordOffset\)/.test(vvSrc), 'the jitter reads the full-image fragment coordinate');
  assert.ok(/fragColor = vec4\(fluColor, fragAlpha\(fluColor, 1\.0 - clebT\)\)/.test(vvSrc)
    && /fragColor = vec4\(finalColor, fragAlpha\(finalColor, renderMode == 0 \? accumAlpha : 0\.0\)\)/.test(vvSrc),
    'every ray-march output goes through fragAlpha');
  assert.ok(/if \(exportAlpha == 0\) return 1\.0;/.test(vvSrc), 'alpha 1 on screen, as before');
  assert.ok(/fragCoordOffset: \{ value: new THREE\.Vector2\(0, 0\) \},\n\s*exportAlpha: \{ value: 0 \},/.test(vvSrc), 'inert defaults on the material');

  const css = read('css/viewer.css');
  assert.ok(/body\.viewer-iframe #btn-export-view/.test(css), 'hidden by CSS too in an embedded page');
  const block = css.slice(css.indexOf('.view-export-popover {'), css.indexOf('.view-export-popover {') + 800);
  assert.ok(/var\(--bg-surface\)/.test(block) && /var\(--text-primary\)/.test(block) && /var\(--border-default\)/.test(block),
    'theme tokens (light and dark follow)');
}

// ── Translations: once the locales carry the export strings, all four carry all of them.
{
  const used = [...new Set((viewerSrc + html).match(/\b(?:exportView\.[A-Za-z]+|tips\.exportView)\b/g))];
  assert.ok(used.length >= 20, 'the dialog and its states are translatable');
  const resolve = (dict, key) => key.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), dict);
  const locales = ['en', 'fr', 'es', 'nl'].map((code) => [code, JSON.parse(read(`lang/${code}.json`))]);
  if (resolve(locales[0][1], 'exportView.title') !== undefined) {
    for (const [code, dict] of locales) {
      for (const key of used) assert.equal(typeof resolve(dict, key), 'string', `lang/${code}.json carries ${key}`);
    }
  }
}

console.log('3D view export (seamless tiles, µm per output pixel, clamping, file name, dialog wiring, state restored): OK');
