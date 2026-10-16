import { launch, page0, snap, outDir, openViewer, sleep, L, BASE, annotate, clearCallouts } from '../w-e/common.mjs';
const dir = outDir(process.env.CH || 'f5');
const b = await launch();
const page = await page0(b, { height: 1000 });
await openViewer(page, '3d/Embryo-E95-Em2-Pecam1-Sox2', 6000);
// sidebar widened so the five columns show at once (on screen: scroll the table sideways)
await page.evaluate(() => { const s = document.querySelector('.viewer-sidebar'); s.style.width = '600px'; window.dispatchEvent(new Event('resize')); });
await sleep(2500);
await page.evaluate(() => document.querySelector('#quality-matrix').scrollIntoView({ block: 'center' }));
await sleep(1000);
const box = await page.locator('#quality-matrix').boundingBox();
const cells = page.locator('#quality-matrix .qm-cell');
console.log('cells', await cells.count());
await snap(page, dir, 'matrice', { clip: { x: Math.max(0, box.x - 12), y: Math.max(0, box.y - 50), width: box.width + 24, height: box.height + 64 },
  targets: [
    { sel: '#quality-matrix thead th', nth: 0, n: 1, side: 'top' },
    { box: await page.evaluate(() => { const t = [...document.querySelectorAll('#quality-matrix thead th')].slice(1).map(e => e.getBoundingClientRect()); return { x: t[0].left, y: t[0].top, width: t[t.length - 1].right - t[0].left, height: t[0].height }; }), n: 2, side: 'top' },
    { sel: '#quality-matrix .qm-gpu', nth: 2, n: 3, side: 'bottom' },
    { sel: '#quality-matrix .qm-cell.qm-active', n: 4, side: 'bottom' },
  ] });
// 3D view export dialog: quality choice
await page.evaluate(() => { const s = document.querySelector('.viewer-sidebar'); s.style.width = ''; window.dispatchEvent(new Event('resize')); });
await sleep(1500);
await page.click('#btn-export-view');
await sleep(1200);
await page.evaluate(() => { const r = document.querySelector('input[name="view-export-quality"][value="lossless"]'); r.closest('label').click(); });
await sleep(1500);
const pb = await page.locator('#view-export-popover').boundingBox();
console.log('popover', pb, await page.locator('#view-export-quality-note').innerText().catch(() => ''));
await snap(page, dir, 'export-vue', { clip: { x: pb.x - 10, y: pb.y - 10, width: pb.width + 20, height: pb.height + 20 } });
await b.close();
