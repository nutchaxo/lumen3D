// Screenshots of chapter 15 (read-only). UI_LANG=fr|en, IMG_DIR=<dir>
import { launch, newPage, annotate, sleep, BASE } from '../shotlib.mjs';
const LANG = process.env.UI_LANG || 'fr';
const OUT = process.env.IMG_DIR || '/home/user/lumen3D/DOCS/documentation/img/ch15';
const b = await launch();
async function bar(url, name, targets, wait = 9000) {
  const p = await newPage(b, { lang: LANG, theme: 'light' });
  await p.goto(BASE + url);
  await sleep(wait);
  const box = await p.locator('#viewer-toolbar').boundingBox().catch(() => null);
  if (targets.length) await annotate(p, targets);
  const el = p.locator('#viewer-toolbar');
  await el.waitFor({timeout:60000}); const bb = await el.boundingBox();
  await p.screenshot({ path: `${OUT}/${name}`, clip: { x: Math.max(0, bb.x - 10), y: Math.max(0, bb.y - 8), width: Math.min(1600, bb.width + 20), height: bb.height + 16 } });
  console.log(name, bb);
  await p.context().close();
}
await bar('/viewer.html?id=3d/Embryo-E95-Em2-Pecam1-Sox2', 'barre-3d.png', [], 12000);
await bar('/viewer.html?id=live/Demo-Lumen3D-E85-Em1-30min-2ch-4tp', 'barre-live.png', [], 12000);
{
  const p = await newPage(b, { lang: LANG, theme: 'light' });
  await p.goto(BASE + '/2d.html?id=2d/DLL4xCD1-E95-x3.2-240913-1');
  await sleep(8000);
  const el = p.locator('.viewer-toolbar, #viewer-toolbar, .toolbar-actions').first();
  await p.screenshot({ path: `${OUT}/barre-2d-full.png` });
  await p.context().close();
}
await b.close();
