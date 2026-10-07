import { launch, newAdmin, goTab, shot, sleep } from './common.mjs';
const b = await launch(); const page = await newAdmin(b);
await goTab(page, '#dataset-updates', 3000);
await page.click('[data-dupd="speed"]');
for (let i = 0; i < 9; i++) { await sleep(1000); await shot(page, 'sp-' + i); }
await b.close();
