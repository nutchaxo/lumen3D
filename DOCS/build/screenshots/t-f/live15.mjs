import { launch, newPage, sleep, BASE } from '../shotlib.mjs';
const b = await launch();
const p = await newPage(b, { lang: 'en', theme: 'light', width: 1900, height: 950 });
await p.goto(BASE + '/viewer.html?id=live/Demo-Lumen3D-E85-Em1-30min-2ch-4tp');
await sleep(14000);
const sel = await p.evaluate(() => { const e = document.querySelector('#viewer-toolbar'); const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; });
console.log(JSON.stringify(sel));
if (sel.w>50) await p.screenshot({ path: '/home/user/lumen3D/DOCS/documentation/img-en/ch15/barre-live.png', clip: { x: Math.max(0, sel.x - 10), y: Math.max(0, sel.y - 8), width: sel.w + 20, height: sel.h + 16 } });
await b.close();
