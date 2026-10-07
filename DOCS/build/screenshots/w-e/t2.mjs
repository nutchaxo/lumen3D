import { launch, page0, openViewer } from './common.mjs';
const b = await launch(); const page = await page0(b);
await openViewer(page, '3d/Embryo-E95-Em2-Pecam1-Sox2', 5000);
console.log(await page.evaluate(() => [...document.querySelectorAll('#select-render-mode option')].map(o => o.value + ':' + o.textContent)));
await b.close();
