import { launch, newPage, sleep, BASE } from '../shotlib.mjs';
const OUT = '/tmp/claude-0/-home-user-lumen3D/5ffff1c0-bcbf-5d42-83df-ee43f5e6cbc6/scratchpad/r2-16/raw';
const lang = process.env.UI_LANG || 'fr';
const b = await launch();
const p = await newPage(b, { width: 1600, height: 950, lang });
await p.goto(`${BASE}/viewer.html?id=3d/Embryo-E95-Em2-Pecam1-Sox2`, { waitUntil: 'networkidle' });
await sleep(35000);
await p.screenshot({ path: `${OUT}/cb-none-full.png` });
for (const m of ['protanopia','deuteranopia','tritanopia','achromatopsia']) {
  await p.evaluate(x => ColorBlind.set(x), m);
  await sleep(1500);
  await p.screenshot({ path: `${OUT}/cb-${m}-full.png` });
}
await p.evaluate(x => ColorBlind.set(x), 'none');
await sleep(800);
await p.evaluate(() => ColorBlind.openModal());
await sleep(1200);
await p.screenshot({ path: `${OUT}/cb-modal.png` });
await b.close();
