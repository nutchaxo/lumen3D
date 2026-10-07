import { launch, page0, BASE, sleep } from './common.mjs';
const b = await launch(); const page = await page0(b);
const t0 = Date.now();
await page.goto(`${BASE}/viewer.html?id=3d/Embryo-E95-Em2-Pecam1-Sox2`, { waitUntil: 'domcontentloaded', timeout: 120000 });
for (let i = 0; i < 40; i++) {
  await sleep(5000);
  const r = await page.evaluate(() => { try { const h = VolumeViewer.getChannelHistograms(); return [h.length, document.querySelector('#quality-stream-progress')?.className, document.querySelector('#ch-hist-0')?.innerHTML.length]; } catch (e) { return String(e); } });
  console.log(Math.round((Date.now() - t0) / 1000), JSON.stringify(r));
  if (r[0] > 0 && r[2] > 0) break;
}
await b.close();
