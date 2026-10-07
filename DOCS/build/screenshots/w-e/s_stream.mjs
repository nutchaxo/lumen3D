import { launch, page0, snap, outDir, openViewer, sleep, L, BASE, annotate, clearCallouts } from './common.mjs';
const dir = outDir('ch10');
const b = await launch();
const page = await page0(b);
// 1. progress line during the first load
await page.goto(`${BASE}/viewer.html?id=3d/Embryo-E95-Em2-Pecam1-Sox2`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => { const e = document.querySelector('#quality-stream-progress'); return e && !e.classList.contains('hidden') && /\d+\s*%/.test(e.innerText); }, null, { timeout: 120000 });
await sleep(1500);
await snap(page, dir, 'progression', { clip: { x: 320, y: 840, width: 520, height: 110 } });
await snap(page, dir, 'chargement-page');
await page.waitForFunction(() => document.querySelector('#quality-stream-progress')?.classList.contains('hidden'), null, { timeout: 240000 }).catch(() => {});
await sleep(20000);
// 2. render-quality panel with the list open
await page.evaluate(() => { document.querySelector('#select-quality').scrollIntoView({ block: 'center' }); });
await sleep(800);
await page.evaluate(() => { const s = document.querySelector('#select-quality'); s.size = s.options.length; });
await sleep(500);
const q = await page.evaluate(() => [...document.querySelectorAll('#select-quality option')].map(o => o.value + ':' + o.textContent));
console.log(q);
const box = await page.locator('#select-quality').boundingBox();
await snap(page, dir, 'qualite-liste', { clip: { x: 0, y: Math.max(0, box.y - 60), width: 320, height: 330 } });
await page.evaluate(() => { const s = document.querySelector('#select-quality'); s.size = 1; });
// detail panel
await page.evaluate(() => { const s = document.querySelector('#select-detail-mode'); s.size = 3; });
const b2 = await page.locator('#select-detail-mode').boundingBox();
await snap(page, dir, 'detail-liste', { clip: { x: 0, y: Math.max(0, b2.y - 120), width: 320, height: 260 } });
await b.close();
