import { launch, newPage, BASE, sleep, waitLoaded } from './common.mjs';
const b = await launch();
const R='/tmp/claude-0/-home-user-lumen3D/5ffff1c0-bcbf-5d42-83df-ee43f5e6cbc6/scratchpad/w-b/raw/';
const page = await newPage(b, {});
await page.goto(BASE+'/viewer.html?id=3d/Embryo-E95-Em2-Pecam1-Sox2',{waitUntil:'domcontentloaded'});
console.log(await waitLoaded(page)); await sleep(15000);
await page.screenshot({path:R+'viewer.png',timeout:240000});
await b.close();
