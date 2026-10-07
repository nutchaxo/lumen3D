import { launch, newPage, sleep, BASE } from '../shotlib.mjs';
const OUT = '/tmp/claude-0/-home-user-lumen3D/5ffff1c0-bcbf-5d42-83df-ee43f5e6cbc6/scratchpad/r2-16/raw';
const lang = process.env.UI_LANG || 'fr';
const b = await launch();
for (const [name, url, wait] of [['m-home','index.html',3000],['m-explorer','explorer.html',3500],['m-viewer','viewer.html?id=3d/Embryo-E95-Em2-Pecam1-Sox2',35000]]) {
  const p = await newPage(b, { width: 390, height: 780, scale: 2, lang });
  await p.goto(`${BASE}/${url}`, { waitUntil: 'networkidle' });
  await sleep(wait);
  await p.screenshot({ path: `${OUT}/${name}.png` });
  if (name === 'm-viewer') {
    await p.click('#btn-hamburger').catch(e => console.log('hamb', e.message.slice(0,80)));
    await sleep(800);
    await p.screenshot({ path: `${OUT}/m-viewer-menu.png` });
  }
  await p.context().close();
}
await b.close();
