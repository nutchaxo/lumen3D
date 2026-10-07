import { launch, newPage, sleep, BASE } from '../shotlib.mjs';
const LANG = process.env.UI_LANG || 'fr';
const OUT = process.env.IMG_DIR || '/home/user/lumen3D/DOCS/documentation/img/ch15';
const b = await launch();
for (const [url, name] of [['/viewer.html?id=3d/Embryo-E95-Em2-Pecam1-Sox2','barre-3d.png'],['/viewer.html?id=live/Demo-Lumen3D-E85-Em1-30min-2ch-4tp','barre-live.png'],['/2d.html?id=2d/DLL4xCD1-E95-x3.2-240913-1','barre-2d.png']]) {
  const p = await newPage(b, { lang: LANG, theme: 'light' });
  await p.goto(BASE + url);
  await sleep(14000);
  const sel = await p.evaluate(() => { const e = document.querySelector('#viewer-toolbar') || document.querySelector('.viewer-toolbar'); if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; });
  console.log(name, JSON.stringify(sel));
  if (sel && sel.w > 50) await p.screenshot({ path: `${OUT}/${name}`, clip: { x: Math.max(0, sel.x - 10), y: Math.max(0, sel.y - 8), width: Math.min(1600, sel.w + 20), height: sel.h + 16 } });
  await p.context().close();
}
await b.close();
