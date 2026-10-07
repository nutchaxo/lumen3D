import {DIR,launch,newPage,openViewer,E95,sleep} from './lib.mjs';
import fs from 'fs';
const b=await launch(); const p=await newPage(b);
await openViewer(p,E95,2000);
await p.keyboard.press('c'); await sleep(12000);
await p.evaluate(()=>document.getElementById('btn-slicer-studio').click());
await sleep(25000);
const clip={x:268,y:58,width:1012,height:892};
await p.screenshot({path:DIR+'/studio-recolor-a.png',clip});
// recolour: DAPI off, Sox2 -> orange (real mouse)
await p.locator('#studio-channels #ch-toggle-0').click(); await sleep(2500);
await p.locator('#studio-channels [data-channel-action="toggle-color"][data-channel-idx="2"]').click(); await sleep(600);
await p.locator('#studio-channels #ch-color-popup-2 [data-color="#FF8800"]').click(); await sleep(3000);
await p.screenshot({path:DIR+'/studio-recolor-b.png',clip});
await b.close();
