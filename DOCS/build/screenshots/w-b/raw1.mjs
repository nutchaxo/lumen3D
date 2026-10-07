import { launch, newPage, BASE, sleep } from '../shotlib.mjs';
const b = await launch();
const R='/tmp/claude-0/-home-user-lumen3D/5ffff1c0-bcbf-5d42-83df-ee43f5e6cbc6/scratchpad/w-b/raw/';
const page = await newPage(b, {});
for (const [n,u,w] of [['index','/index.html',3000],['explorer','/explorer.html',3000],['about','/about.html',2500],['legal','/legal.html',2000],['2d','/2d.html?id=2d/DLL4xCD1-E95-x3.2-240913-1',6000]]) {
  await page.goto(BASE+u,{waitUntil:'networkidle'}); await sleep(w);
  await page.screenshot({path:R+n+'.png'}); console.log(n);
}
await b.close();
