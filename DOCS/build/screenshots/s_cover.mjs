import { launch, newPage, BASE, sleep } from './shotlib.mjs';
const b = await launch();
const page = await newPage(b, { width: 1100, height: 1100 });
await page.goto(BASE + '/viewer.html?id=3d/Embryo-E95-Em2-Pecam1-Sox2&hideHeader=true', { waitUntil: 'networkidle' });
await sleep(30000);
await page.screenshot({ path: 'cover_raw.png' });

await b.close();
