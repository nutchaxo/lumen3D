// Datasets tab (list, editor, gallery, orientation, 2D) + shell shots.
// CHANGES STATE TEMPORARILY: toggles the visibility of 3d/Embryo-E105-Em3-Pecam1 and back, attaches 3 gallery images
// to it and deletes them again (nothing is saved with the Save button). Back up its metadata.json before, restore after.
import { launch, newAdmin, goTab, shot, sleep, S, T, rect } from './common.mjs';
const E105 = '3d/Embryo-E105-Em3-Pecam1', P2D = '2d/DLL4xCD1-E95-x3.2-240913-1';
const b = await launch(); const page = await newAdmin(b);
page.on('dialog', d => d.accept());
const step = async (name, fn) => { try { await fn(); } catch (e) { console.log('  [FAIL]', name, String(e).split('\n')[0]); } };

// ---------- shell ----------
await step('shell', async () => {
  await goTab(page, '#datasets', 2500);
  await shot(page, 'shell-overview', { targets: [
    { sel: '.adm-nav-group[data-group="data"]', n: 1, side: 'right', pad: 2 },
    { sel: '.adm-nav-group[data-group="site"]', n: 2, side: 'right', pad: 2 },
    { sel: '.adm-nav-group[data-group="ext"]', n: 3, side: 'right', pad: 2 },
    { sel: '.adm-nav-group[data-group="system"]', n: 4, side: 'right', pad: 2 },
    { sel: '#topbar-tab-group', n: 5, side: 'bottom' }, { sel: '#btn-theme', n: 6, side: 'bottom' },
    { sel: '#btn-lang', n: 7, side: 'bottom' }, { sel: '#btn-logout', n: 8, side: 'bottom' },
    { sel: '#btn-collapse', n: 9, side: 'right' }, { sel: '#adm-sidebar a[href*="explorer"]', n: 10, side: 'right' } ] });
  await page.click('#btn-collapse'); await sleep(600);
  await shot(page, 'shell-sidebar-collapsed', { clip: { x: 0, y: 0, width: 560, height: 560 } });
  await page.click('#btn-collapse'); await sleep(600);
});
await step('topbar', async () => {
  await goTab(page, '#dataset-types', 2500);
  await page.locator('#dataset-types-root input').first().fill(({fr:'Volumes',en:'Volumes',es:'Volúmenes',nl:'Volumes'})[process.env.UI_LANG||'fr']);
  await sleep(600);
  await shot(page, 'shell-topbar', { clip: { x: 248, y: 0, width: 1352, height: 58 }, targets: [
    { sel: '#topbar-tab-group', n: 1, side: 'bottom' }, { sel: '#header-unsaved-wrap', n: 2, side: 'bottom' },
    { sel: '#btn-theme', n: 3, side: 'bottom' }, { sel: '#btn-lang', n: 4, side: 'bottom' }, { sel: '#header-username', n: 5, side: 'bottom' }, { sel: '#btn-logout', n: 6, side: 'bottom' } ] });
  await page.reload({ waitUntil: 'networkidle' }); await sleep(1500);
  await page.evaluate(() => { location.hash = '#datasets'; }); await sleep(2500);
});

// ---------- empty + list ----------
await step('empty', async () => { await shot(page, 'tab-datasets-empty'); });
await step('list', async () => {
  await page.locator(`.dataset-item[data-id="${E105}"] .item-vis-btn`).click(); await sleep(1500);
  await shot(page, 'datasets-list', { clip: { x: 248, y: 58, width: 290, height: 892 }, targets: [
    { sel: '#dataset-count', n: 1, side: 'right', dx: -40 }, { sel: '#dataset-search', n: 2, side: 'bottom', dy: -12 }, { sel: '#ds-filter-tabs', n: 3, side: 'bottom', dy: -12 },
    { sel: '.dataset-item:nth-child(1) .item-stage', n: 4, side: 'bottom', dy: -4 }, { sel: '.item-hidden-badge', n: 5, side: 'right' },
    { sel: '.dataset-item:nth-child(2) .item-vis-btn', n: 6, side: 'left' }, { sel: '.dataset-item:nth-child(2) .item-status', n: 7, side: 'left' } ] });
  await page.locator(`.dataset-item[data-id="${E105}"] .item-vis-btn`).click(); await sleep(1500);
});

// ---------- the editor ----------
await page.locator(`.dataset-item[data-id="${E105}"]`).click();
await sleep(28000);
const cfg = '.config-body';
const scrollCfg = y => page.evaluate(([s, y]) => { document.querySelector(s).scrollTop = y; }, [cfg, y]);
await step('overview', async () => {
  await shot(page, 'tab-datasets', { targets: [
    { sel: '#dataset-count', n: 1, side: 'right', dx: -40 }, { sel: '#dataset-search', n: 2, side: 'bottom', dy: -10 }, { sel: '#ds-filter-tabs', n: 3, side: 'bottom', dy: -10 },
    { sel: `.dataset-item[data-id="${E105}"]`, n: 4, side: 'right', dx: -60 }, { sel: '#preview-frame-wrap', n: 5, side: 'inside', noBox: false, pad: -3 },
    { sel: '#config-panel', n: 6, side: 'left', pad: -3, dx: 40 } ] });
  await shot(page, 'datasets-preview', { clip: { x: 528, y: 58, width: 712, height: 892 }, targets: [
    { sel: '#preview-frame-wrap', n: 1, side: 'inside', pad: -3, dy: -300 }, { sel: '#preview-label-bar', n: 2, side: 'top' }, { sel: '#btn-set-preview', n: 3, side: 'top' } ] });
});
await step('config-top', async () => {
  await scrollCfg(0); await sleep(300);
  const gal = (await rect(page, '#config-panel .config-section', 2));
  await shot(page, 'datasets-config-top', { clip: { x: 1230, y: 58, width: 370, height: 892 }, targets: [
    { sel: '#btn-save', n: 1, side: 'tl', dx: 12 }, { sel: '#btn-reset', n: 2, side: 'tl', dx: 12 }, { sel: '#vis-row', n: 3, side: 'tl', dx: 12 },
    { sel: '#f-name', n: 4, side: 'tl', dx: 12 }, { sel: '#f-stage', n: 5, side: 'tl', dx: 12 }, { sel: '#f-description', n: 6, side: 'tl', dx: 12 }, { sel: '#f-folder', n: 7, side: 'tl', dx: 12 } ] });
});
await step('gallery', async () => {
  await scrollCfg(430); await sleep(300);
  await page.setInputFiles('#gallery-file', [S + '/admin/gal/MIP_C1_DAPI.png', S + '/admin/gal/MIP_C2_Pecam1.png', S + '/admin/gal/MIP_C3_Sox2.png']);
  await sleep(5000);
  const caps = page.locator('#gallery-grid input[type="text"], #gallery-grid textarea');
  const n = await caps.count(); const labels = ['DAPI', 'Pecam1', 'Sox2'];
  for (let i = 0; i < Math.min(n, 3); i++) await caps.nth(i).fill(({fr:'Projection maximale — ',en:'Maximum projection — ',es:'Proyección máxima — ',nl:'Maximumprojectie — '})[process.env.UI_LANG||'fr'] + labels[i]);
  await page.evaluate(() => document.querySelector('#gallery-drop').scrollIntoView({ block: 'start' })); await sleep(500);
  await shot(page, 'datasets-gallery', { clip: { x: 1230, y: 58, width: 370, height: 892 }, targets: [
    { sel: '#gallery-drop', n: 1, side: 'tl', dx: 12 }, { sel: '.gal-caption', n: 2, side: 'tl', dx: 12 },
    { sel: '[data-gal-move="1"]', n: 3, side: 'tl', dx: 12 }, { sel: '.gal-del', n: 4, side: 'tl', dx: 12 }, { sel: '.gal-formats', n: 5, side: 'tl', dx: 12 } ] });
});
await step('gallery-clean', async () => {
  for (let i = 0; i < 5; i++) {
    const del = page.locator('.gal-del').first();
    if (!(await del.count())) break; await del.click(); await sleep(1500);
  }
  console.log('  gallery left:', await page.locator('#gallery-grid img').count());
  await sleep(4500);
});
await step('config-bottom', async () => {
  await page.evaluate(() => { const f = document.querySelector('.config-row:has(#f-vox-x)'); const b = document.querySelector('.config-body'); b.scrollTop = f.offsetTop - 140; });
  await sleep(500);
  await shot(page, 'datasets-config-bottom', { clip: { x: 1230, y: 58, width: 370, height: 892 }, targets: [
    { sel: '.config-row:has(#f-vox-x)', n: 1, side: 'tl', dx: 12 }, { sel: '#f-exposure', n: 2, side: 'tl', dx: 12 }, { sel: '#f-sample-side', n: 3, side: 'tl', dx: 12 },
    { sel: '#btn-define-orientation', n: 4, side: 'tl', dx: 12 } ] });
});
await step('orientation', async () => {
  await scrollCfg(99999);
  await page.click('#btn-define-orientation'); await sleep(4000);
  await shot(page, 'datasets-orientation-zoom', { clip: { x: 848, y: 58, width: 392, height: 892 } });
  await shot(page, 'datasets-orientation', { clip: { x: 528, y: 58, width: 1072, height: 892 }, targets: [
    { sel: '#f-sample-side', n: 1, side: 'left' }, { sel: '#btn-define-orientation', n: 2, side: 'left' }, { sel: '#orientation-axes-list', n: 3, side: 'left' }, { sel: '#f-default-view', n: 4, side: 'left' }, { sel: '#btn-capture-view', n: 5, side: 'left' } ] });
  await page.click('#btn-define-orientation'); await sleep(1500);
});
await step('sample-side', async () => {
  await scrollCfg(99999);
  const radios = page.locator('#f-sample-side input[type="radio"]');
  await radios.nth(1).check(); await sleep(4500);
  await shot(page, 'datasets-sample-side', { clip: { x: 528, y: 58, width: 1072, height: 892 }, targets: [
    { sel: '#f-sample-side', n: 1, side: 'left' }, { sel: '#preview-frame-wrap', n: 2, side: 'inside', pad: -3, dy: -250 } ] });
  await radios.nth(0).check(); await sleep(1000);
});
await step('reset', async () => { await page.click('#btn-reset'); await sleep(1500); });
// 2D photograph
await step('2d', async () => {
  await page.locator(`.dataset-item[data-id="${P2D}"]`).click(); await sleep(9000);
  await scrollCfg(0);
  await shot(page, 'datasets-2d', { clip: { x: 528, y: 58, width: 1072, height: 892 }, targets: [
    { sel: '#preview-frame-wrap', n: 1, side: 'inside', pad: -3, dy: -250 }, { sel: '#f-dims', n: 2, side: 'left' } ] });
  await scrollCfg(99999); await sleep(400);
  await shot(page, 'datasets-2d-orientation', { clip: { x: 1230, y: 58, width: 370, height: 892 }, targets: [ { sel: '#btn-define-orientation', n: 1, side: 'tl', dx: 12 } ] });
});
await b.close();
