import { launch, page0, snap, outDir, openViewer, sleep } from './common.mjs';
const dir = outDir('ch09');
const b = await launch();
const page = await page0(b);
await openViewer(page, '3d/Embryo-E95-Em2-Pecam1-Sox2', 8000);
await page.click('#btn-reset-view').catch(()=>{});
await sleep(3000);
const setExp = async (v) => { await page.evaluate((v) => { const s = document.getElementById('slider-exposure'); s.value = v; s.dispatchEvent(new Event('input', {bubbles:true})); s.dispatchEvent(new Event('change', {bubbles:true})); }, v); };
const modes = [['fluorescence','fluorescence',100],['natural-fluorescence','naturelle',(+process.env.EN||400)],['structure-dvr','structure',(+process.env.ED||300)]];
for (const [v, n, e] of modes) {
  await page.selectOption('#select-render-mode', v);
  await setExp(e);
  await sleep(10000);
  await snap(page, dir, 'mode-' + n, { clip: { x: 640, y: 120, width: 700, height: 700 } });
  if (n==='fluorescence') await snap(page, dir, 'viewer-full');
}
await b.close();
