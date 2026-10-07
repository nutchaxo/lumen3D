import { launch, newPage, sleep, BASE } from '../shotlib.mjs';
import { adminPage, goTab } from '../admlogin.mjs';
const OUT = '/tmp/claude-0/-home-user-lumen3D/5ffff1c0-bcbf-5d42-83df-ee43f5e6cbc6/scratchpad/r2-16/raw';
const lang = process.env.UI_LANG || 'fr';
const b = await launch();
const page = await adminPage(b, { lang });
for (const t of ['branding','dataset-types','appearance','legal','stats','pages']) {
  await goTab(page, '#' + t, 5000);
  await page.screenshot({ path: `${OUT}/adm-${t}.png` });
}
// page editor in its own tab (read-only: select, never edit)
const ed = await page.context().newPage();
ed.on('pageerror', e => console.log('  [ed pageerror]', String(e).slice(0,200)));
await ed.setViewportSize({ width: 1600, height: 950 });
await ed.goto(BASE + '/admpan.html?editor=about', { waitUntil: 'networkidle' });
await sleep(6000);
await ed.screenshot({ path: `${OUT}/adm-editor.png` });
await b.close();
