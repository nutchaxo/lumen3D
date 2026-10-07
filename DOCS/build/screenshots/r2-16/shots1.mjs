// Public pages in 4 languages + theme light/dark + language menu. UI_LANG selects the UI language of single shots.
import { launch, newPage, shot, sleep, BASE } from '../shotlib.mjs';
const OUT = process.env.RAW || '/tmp/claude-0/-home-user-lumen3D/5ffff1c0-bcbf-5d42-83df-ee43f5e6cbc6/scratchpad/r2-16/raw';
process.env.SHOT_OUT = OUT;
const b = await launch();
for (const lang of ['fr','en','es','nl']) {
  for (const [name, url] of [['home','index.html'],['explorer','explorer.html']]) {
    const p = await newPage(b, { width: 1280, height: 760, lang });
    await p.goto(`${BASE}/${url}`, { waitUntil: 'networkidle' });
    await sleep(2500);
    await p.screenshot({ path: `${OUT}/${name}-${lang}.png` });
    await p.context().close();
  }
}
// theme light vs dark, home + explorer, fr
for (const theme of ['dark','light']) {
  for (const [name, url] of [['home','index.html'],['explorer','explorer.html']]) {
    const p = await newPage(b, { width: 1280, height: 760, lang: 'fr', theme });
    await p.goto(`${BASE}/${url}`, { waitUntil: 'networkidle' });
    await sleep(2500);
    await p.screenshot({ path: `${OUT}/theme-${name}-${theme}.png` });
    await p.context().close();
  }
}
// language menu open
{
  const p = await newPage(b, { width: 1280, height: 600, lang: 'fr' });
  await p.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await sleep(2000);
  await p.click('#lang-dropdown button');
  await sleep(500);
  await p.screenshot({ path: `${OUT}/langmenu.png` });
  await p.context().close();
}
await b.close();
