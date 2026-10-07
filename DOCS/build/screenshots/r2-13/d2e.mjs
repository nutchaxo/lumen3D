import {DIR,launch,newPage,shot,sleep,boxes,BASE} from './lib.mjs';
const b=await launch(); const p=await newPage(b);
await p.goto('http://localhost:8080/2d.html?id=2d/DLL4xCD1-E95-x3.2-240913-1'); await sleep(8000);
await p.keyboard.press('b'); await sleep(2500);
await p.screenshot({path:'/tmp/claude-0/-home-user-lumen3D/5ffff1c0-bcbf-5d42-83df-ee43f5e6cbc6/scratchpad/t-e/d2b.png'});
await b.close();
