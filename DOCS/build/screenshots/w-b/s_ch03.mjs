// Usage: UI_LANG=fr|en [IMG_DIR_BASE=/path/img-en] node s_ch03.mjs [landing explorer 2d about viewer live compare admin ...]
import { adminPage, goTab } from '../admlogin.mjs';
import { launch, newPage, BASE, sleep, waitLoaded, snap, L, LANG } from './common.mjs';
const which = process.argv.slice(2);
const want = n => !which.length || which.includes(n);
const CH = 'ch03';
const b = await launch();

if (want('landing')) {
  const p = await newPage(b, { width: 1600, height: 1500 });
  await p.goto(BASE + '/index.html', { waitUntil: 'networkidle' }); await sleep(2500);
  await p.evaluate(() => { const h = document.querySelector('.hero'); h.style.minHeight = '430px'; h.style.height = '430px'; });
  await p.evaluate(() => document.querySelectorAll('.animate-fade-in-up').forEach(e => { e.style.opacity = 1; e.style.transform = 'none'; }));
  await sleep(1500);
  await snap(p, 'accueil', CH, { clip: { x: 0, y: 0, width: 1600, height: 1170 }, targets: [
    { box: { x: 628, y: 14, width: 370, height: 36 }, n: 1, side: 'right' },
    { sel: '#hero h1', n: 2, side: 'right' },
    { sel: '.hero-actions', n: 3, side: 'right' },
    { sel: '.stats-bar', n: 4, side: 'right' },
    { sel: '.type-cards', n: 5, side: 'top' },
  ]});
  await p.context().close();
}
if (want('explorer')) {
  const p = await newPage(b, {});
  await p.goto(BASE + '/explorer.html', { waitUntil: 'networkidle' }); await sleep(3500);
  await snap(p, 'explorateur', CH, { targets: [
    { sel: '#search-input', n: 1, side: 'top' },
    { sel: '.filter-group', n: 2, side: 'tl', nth: 0 },
    { sel: '#filter-stage-group', n: 3, side: 'tl' },
    { sel: '#sort-select', n: 4, side: 'top' },
    { sel: '.dataset-card, .dataset-grid > *', n: 5, side: 'tr' },
  ]});
  await p.context().close();
}
if (want('2d')) {
  const p = await newPage(b, {});
  await p.goto(BASE + '/2d.html?id=2d/DLL4xCD1-E95-x3.2-240913-1', { waitUntil: 'networkidle' }); await sleep(8000);
  await snap(p, 'page-2d', CH, { targets: [
    { sel: '#viewer-toolbar, .viewer-toolbar', n: 1, side: 'bottom', pad: 0 },
    { sel: '#p2d-info', n: 2, side: 'right' },
    { sel: '#measure-section', n: 3, side: 'right' },
    { box: { x: 334, y: 903, width: 62, height: 28 }, n: 4, side: 'right' },
    { sel: '#p2d-zoom', n: 5, side: 'bottom' },
  ]});
  await p.context().close();
}
if (want('about')) {
  const p = await newPage(b, {});
  await p.goto(BASE + '/about.html', { waitUntil: 'networkidle' }); await sleep(3000);
  await snap(p, 'a-propos', CH);
  await p.goto(BASE + '/legal.html', { waitUntil: 'networkidle' }); await sleep(2000);
  await snap(p, 'mentions-legales', CH);
  await p.context().close();
}
if (want('viewer')) {
  const p = await newPage(b, {});
  await p.goto(BASE + '/viewer.html?id=3d/Embryo-E95-Em2-Pecam1-Sox2', { waitUntil: 'domcontentloaded' });
  await waitLoaded(p); await sleep(12000);
  // fold the first channel so that Display and Quality fit
  await p.evaluate(() => { const b = document.querySelector('#channel-container .channel-expand, #channel-container button[aria-expanded="true"]'); b && b.click(); });
  await sleep(1500);
  await snap(p, 'viewer-3d', CH, { targets: [
    { sel: '[data-tool-group="tools"]', n: 1, side: 'bottom' },
    { sel: '[data-tool-group="export"]', n: 2, side: 'bottom' },
    { sel: '[data-tool-group="visuals"]', n: 3, side: 'bottom' },
    { sel: '[data-tool-group="layouts"]', n: 4, side: 'bottom' },
    { sel: '#channel-container', n: 5, side: 'right' },
    { sel: '#select-quality', n: 6, side: 'right' },
    { sel: '#btn-center-sample', n: 7, side: 'left', pad: 3 },
  ]});
  await p.context().close();
}
if (want('live')) {
  const p = await newPage(b, {});
  await p.goto(BASE + '/viewer.html?id=live/Demo-Lumen3D-E85-Em1-30min-2ch-4tp', { waitUntil: 'domcontentloaded' });
  await waitLoaded(p); await sleep(12000);
  await p.click('#btn-hamburger'); await sleep(1500);
  await snap(p, 'viewer-live', CH, { targets: [
    { box: { x: 1224, y: 60, width: 360, height: 434 }, n: 1, side: 'left' },
    { box: { x: 12, y: 618, width: 292, height: 178 }, n: 2, side: 'right' },
    { box: { x: 16, y: 892, width: 146, height: 40 }, n: 3, side: 'top' },
    { box: { x: 164, y: 899, width: 90, height: 24 }, n: 4, side: 'top' },
    { box: { x: 256, y: 898, width: 1328, height: 28 }, n: 5, side: 'top', dx: 300 },
  ]});
  await p.context().close();
}
if (want('compare')) {
  const p = await newPage(b, {});
  await p.goto(BASE + '/compare.html?add=3d/Embryo-E85-Em1-Pecam1-Sox2&add=3d/Embryo-E95-Em2-Pecam1-Sox2&add=3d/Embryo-E105-Em3-Pecam1', { waitUntil: 'domcontentloaded' });
  await sleep(20000);
  // wait until the three panels are ready (no loader text left in any iframe)
  for (let i = 0; i < 120; i++) {
    const ok = await p.evaluate(() => [...document.querySelectorAll('iframe')].every(f => { try { const l = f.contentDocument.getElementById('viewer-loader'); return l && getComputedStyle(l).display === 'none'; } catch (e) { return false; } })).catch(() => false);
    if (ok) break; await sleep(3000);
  }
  await sleep(60000);
  await snap(p, 'comparer', CH, { targets: [
    { box: { x: 24, y: 76, width: 196, height: 36 }, n: 1, side: 'top' },
    { box: { x: 238, y: 72, width: 132, height: 42 }, n: 2, side: 'top' },
    { box: { x: 384, y: 76, width: 432, height: 32 }, n: 3, side: 'top' },
    { box: { x: 830, y: 76, width: 214, height: 32 }, n: 4, side: 'top' },
    { box: { x: 1198, y: 80, width: 388, height: 24 }, n: 5, side: 'top' },
    { box: { x: 1354, y: 128, width: 190, height: 32 }, n: 6, side: 'left' },
    { box: { x: 10, y: 130, width: 228, height: 28 }, n: 7, side: 'bottom' },
  ]});
  await p.context().close();
}
if (want('admin')) {
  const p = await adminPage(b, { lang: LANG });
  await goTab(p, '#datasets', 4000);
  await snap(p, 'admin-apercu', CH, { targets: [
    { box: { x: 6, y: 76, width: 236, height: 774 }, n: 1, side: 'tr', pad: 2 },
    { box: { x: 250, y: 62, width: 274, height: 786 }, n: 2, side: 'tr', pad: 2 },
    { box: { x: 1242, y: 62, width: 354, height: 786 }, n: 3, side: 'tl', pad: 2 },
    { box: { x: 1376, y: 12, width: 204, height: 34 }, n: 4, side: 'bottom' },
  ]});
  await p.context().close();
}
await b.close();
