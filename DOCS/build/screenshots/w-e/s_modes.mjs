import { launch, page0, snap, outDir, openViewer, sleep, L } from './common.mjs';
const dir = outDir('ch09');
const b = await launch();
const page = await page0(b);
await openViewer(page, '3d/Embryo-E95-Em2-Pecam1-Sox2', 50000);
await page.click('#btn-reset-view').catch(()=>{});
await sleep(3000);
const modes = [['fluorescence','fluorescence'],['natural-fluorescence','naturelle'],['structure-dvr','structure']];
for (const [v, n] of modes) {
  await page.selectOption('#select-render-mode', v);
  await sleep(9000);
  // canvas only
  const box = await page.locator('#volume-canvas, canvas').first().boundingBox();
  await snap(page, dir, 'mode-' + n, { clip: { x: 640, y: 120, width: 700, height: 700 } });
  await snap(page, dir, 'mode-' + n + '-full');
}
console.log(await page.evaluate(() => [...document.querySelectorAll('#select-render-mode option')].map(o => o.value + ':' + o.textContent)));
await b.close();
