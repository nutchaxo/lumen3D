// Import tab: empty, running, rejected files, Datasets list with an import row, staging banner, dock sizes, exit guard.
// Needs: $S/import-src (parent folder holding 3d/Embryo-E85-Em9-Import-Demo + stray files), nothing staged on the server.
import { launch, newAdmin, goTab, shot, elShot, rect, sleep, S, T } from './common.mjs';
const b = await launch();
const page = await newAdmin(b);
page.on('dialog', d => d.accept());
await page.route('**/viewer.html*', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><body style="margin:0;background:#050510"></body>' })); // the preview of a half-sent volume is useless and hangs software GL
await goTab(page, '#upload', 2000);
// clean any previous staged import
for (let i = 0; i < 6; i++) {
  const d = page.locator('[data-upl-action="discard"]').first();
  if (!(await d.count())) break;
  await d.click(); await sleep(1500);
}
const hideDock = v => page.evaluate(v => { const d = document.getElementById('upload-dock'); if (d) d.style.visibility = v ? 'hidden' : ''; }, v);
const toGlobal = () => page.evaluate(() => document.querySelector('.upl-global')?.scrollIntoView({ block: 'start' }));
const reg = { x: 248, y: 58, width: 1352, height: 700 };
await shot(page, 'import-empty', { clip: { x: 248, y: 58, width: 1352, height: 700 }, targets: [
  { sel: '#upl-refresh', n: 1, side: 'left' }, { sel: '.upl-drop', n: 2, side: 'inside', noBox: false, pad: -4, dy: -60 },
  { sel: '#upl-pick', n: 3, side: 'right' }, { sel: '.upl-note', n: 4, side: 'left' } ] });

await page.route('**/api/upload.php**', async r => { const q = r.request(); if ((q.postDataBuffer()?.length || 0) > 100000) await sleep(+(process.env.BLOCK_DELAY||5000)); r.continue(); });
await page.setInputFiles('#upl-input', S + '/import-src');
await page.waitForSelector('.upl-card', { timeout: 30000 });
await sleep(150);
await hideDock(true);
await shot(page, 'import-nonedit', { clip: { x: 248, y: 58, width: 1352, height: 700 } });
await page.waitForSelector('[data-upl-action="edit"]', { timeout: 60000 });
await sleep(2500);
await page.locator('details.upl-card-rejected').first().evaluate(d => { d.open = true; }).catch(() => {});
await sleep(400);
await toGlobal(); await sleep(400);
await shot(page, 'import-running', { clip: { x: 248, y: 58, width: 1352, height: 700 }, targets: [
  { sel: '.upl-global', n: 1, side: 'right', dx: -40 }, { sel: '[data-upl-action="pause"]', n: 2, side: 'top' },
  { sel: '.upl-card', n: 3, side: 'right', pad: 6 }, { sel: '.upl-card .upl-state', n: 4, side: 'right' },
  { sel: '[data-upl-action="edit"]', n: 5, side: 'top' }, { sel: 'details.upl-card-rejected summary', n: 6, side: 'right' } ] });
await hideDock(true);
const sec = page.locator('.upl-rejected').first();
if (await sec.count()) { await sec.scrollIntoViewIfNeeded(); await sleep(300);
  const bx = await sec.locator('xpath=ancestor::section[1]').boundingBox();
  await shot(page, 'import-rejected', { clip: { x: 248, y: Math.max(0, bx.y - 20), width: 1352, height: Math.min(300, 950 - bx.y) } }); }
await hideDock(false); await page.evaluate(() => window.scrollTo(0, 0));
// Datasets list with the import row
await goTab(page, '#datasets', 3500);
await shot(page, 'datasets-list-import', { clip: { x: 248, y: 58, width: 290, height: 892 }, targets: [
  { sel: '#ds-filter-tabs [data-type="staging"]', n: 1, side: 'bottom', dy: -4 }, { sel: '.dataset-item.is-staging', n: 2, side: 'tl', dx: 10, pad: 2 } ] });
const row = page.locator('#dataset-list [data-id*="Import-Demo"], #dataset-list >> text=Import-Demo').first();
await row.click(); await sleep(4000);
await hideDock(true);
await shot(page, 'datasets-staging-banner', { clip: { x: 1230, y: 58, width: 370, height: 892 }, targets: [ { sel: '.ds-staging-banner', n: 1, side: 'tl', dx: 12 }, { sel: '#vis-row', n: 2, side: 'tl', dx: 12 }, { sel: '#f-name', n: 3, side: 'tl', dx: 12 }, { sel: '#btn-save', n: 4, side: 'tl', dx: 12 } ] });
await hideDock(false);
// dock sizes (on the Datasets tab)
const dockClip = { x: 1000, y: 700, width: 600, height: 250 };
await shot(page, 'import-dock-bar', { clip: dockClip, targets: [
  { sel: '.dock-bar [data-dock-action="shrink"]', n: 1, side: 'top' }, { sel: '.dock-bar-title', n: 2, side: 'top' }, { sel: '.dock-bar .dock-progress', n: 3, side: 'top', dy: 20 }, { sel: '.dock-bar-sub', n: 4, side: 'bottom' }, { sel: '.dock-bar [data-dock-action="expand"]', n: 5, side: 'top' } ] });
await page.locator('[data-dock-action="shrink"]').click(); await sleep(600);
await shot(page, 'import-dock-bubble', { clip: { x: 1400, y: 780, width: 200, height: 170 }, targets: [ { sel: '.dock-bubble', n: 1, side: 'tl' } ] });
await page.locator('[data-dock-action="expand"]').first().click(); await sleep(600);
await page.locator('.dock-bar [data-dock-action="expand"]').click(); await sleep(800);
await shot(page, 'import-dock-panel', { clip: { x: 1100, y: 450, width: 500, height: 500 }, targets: [
  { sel: '.dock-head-title', n: 1, side: 'top' }, { sel: '.dock-global', n: 2, side: 'tl', dx: 12 }, { sel: '.dock-row', n: 3, side: 'tl', dx: 12 }, { sel: '.dock-row-actions', n: 4, side: 'bottom' }, { sel: '.dock-head-actions', n: 5, side: 'top' } ] });
// exit guard
await page.locator('#btn-logout').click(); await sleep(800);
await shot(page, 'import-exit-guard', { clip: { x: 400, y: 250, width: 800, height: 450 }, targets: [ { sel: '#upl-exit-stay', n: 1, side: 'bottom' }, { sel: '#upl-exit-leave', n: 2, side: 'bottom' } ] });
await page.locator('#upl-exit-stay').click(); await sleep(500);
// phase 2: let the transfer finish -> staged
await page.unroute('**/api/upload.php**');
await goTab(page, '#upload', 1500);
const pb = page.locator('[data-upl-action="publish"]').first();
for (let i = 0; i < 120 && !(await pb.count()); i++) await sleep(1000);
await sleep(1500);
await hideDock(true); await toGlobal(); await sleep(400);
await shot(page, 'import-staged', { clip: { x: 248, y: 58, width: 1352, height: 760 }, targets: [
  { sel: '.upl-card', n: 1, side: 'right', pad: 6 }, { sel: '.upl-card .upl-state', n: 2, side: 'right' },
  { sel: '[data-upl-action="edit"]', n: 3, side: 'top' }, { sel: '[data-upl-action="validate"]', n: 4, side: 'top' },
  { sel: '[data-upl-action="publish"]', n: 5, side: 'top' }, { sel: '[data-upl-action="discard"]', n: 6, side: 'bottom' } ] });
await hideDock(false);
await page.locator('[data-upl-action="validate"]').first().click(); await sleep(2500);
await shot(page, 'import-validated', { clip: { x: 248, y: 58, width: 1352, height: 892 } });
await goTab(page, '#datasets', 3000);
await page.locator('#dataset-list >> text=Import-Demo').first().click(); await sleep(3000); await hideDock(true);
await shot(page, 'datasets-staged-banner', { clip: { x: 1230, y: 58, width: 370, height: 892 }, targets: [ { sel: '.ds-staging-banner', n: 1, side: 'tl', dx: 12 } ] });
// cleanup: delete the staged import
await goTab(page, '#upload', 1500);
await page.locator('[data-upl-action="discard"]').first().click(); await sleep(2000);
await b.close();
