import { launch, shot, sleep } from './shotlib.mjs';
import { adminPage, goTab } from './admlogin.mjs';
const b = await launch();
const page = await adminPage(b);
for (const t of ['upload','dataset-updates','dataset-types','stats','branding','appearance','pages','legal','plugins','marketplace','updates','pipeline','security','docs']) {
  await goTab(page, '#' + t, 5000);
  await shot(page, 'raw-' + t);
}
await goTab(page, '#datasets', 3000);
await page.click('text=Embryo-E95-Em2');
await sleep(25000);
await shot(page, 'raw-datasets-sel');
await b.close();
