import { launch, page0, openViewer, sleep } from './common.mjs';
import fs from 'fs';
const b = await launch(); const page = await page0(b);
await openViewer(page, '3d/Embryo-E95-Em2-Pecam1-Sox2', 30000);
const h = await page.evaluate(() => document.querySelector('#channel-list, .channel-list, #channels-container')?.outerHTML?.slice(0, 6000) || document.querySelector('aside').innerHTML.slice(0, 8000));
fs.writeFileSync('dom.html', h);
await b.close();
