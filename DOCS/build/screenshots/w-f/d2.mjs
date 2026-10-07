import {DIR,launch,newPage,shot,sleep,boxes,P2D,BASE} from './lib.mjs';
const b=await launch(); const p=await newPage(b,{theme:'dark'});
await p.goto(BASE+'/2d.html?id='+P2D); await sleep(15000);
const click=async s=>{await p.evaluate(s=>document.querySelector(s).click(),s);await sleep(2500)};
const id=s=>`#${s}`;
const bt=[['[data-tool="navigate"]',1],['[data-tool="measure"]',2],['#btn-studio',3],['[data-plugin-id="download-center"]',4],['#btn-figure-panel',5],['#btn-screenshot',6],['#btn-fit',7],['#btn-native',8],['#btn-isolate',9],['#btn-calibrated-grid',10],['#btn-display-adjust',11],['#btn-orientation-2d',12],['#btn-prev',13],['#btn-browse',14],['#btn-next',15],['#btn-presentation',16],['#btn-split-view',17]];
let tg=await boxes(p,bt.map(([sel,n])=>({sel,n,side:'bottom',pad:2})));
tg.push({box:{x:336,y:902,width:58,height:30},n:18,side:'right',pad:2},{box:{x:1456,y:121,width:124,height:22},n:19,side:'bottom',pad:2},{box:{x:0,y:165,width:320,height:260},n:20,side:'right',dx:-6,dy:100,pad:0});
await shot(p,'2d-barre',{targets:tg});
await p.screenshot({path:DIR+'/2d-avant.png'});
// isolation
await click('#btn-isolate'); await sleep(6000);
tg=await boxes(p,[{sel:'#btn-isolate',n:1,side:'bottom'}]);
await shot(p,'2d-isolation',{targets:tg});
await click('#btn-isolate'); await sleep(2000);
// measure
await p.keyboard.press('m'); await sleep(800);
await p.mouse.click(740,470); await sleep(800); await p.mouse.click(1180,520); await sleep(1500);
tg=await boxes(p,[{sel:'[data-tool="measure"]',n:1,side:'bottom'}]);
await shot(p,'2d-mesure',{targets:tg});
await p.keyboard.press('v');
// display adjust
await click('#btn-display-adjust'); await sleep(1500);
await p.screenshot({path:'d2_disp.png'});
await click('#btn-display-adjust');
await click('#btn-calibrated-grid'); await sleep(1500);
await p.screenshot({path:'d2_grid.png'});
await click('#btn-calibrated-grid');await click('#btn-calibrated-grid');await click('#btn-calibrated-grid');
await click('#btn-orientation-2d'); await sleep(1500);
await p.screenshot({path:'d2_orient.png'});
await click('#btn-orientation-2d');
await click('#btn-figure-panel'); await sleep(6000);
await p.screenshot({path:'d2_fig.png'});
await p.keyboard.press('Escape');await sleep(1000);
await click('#btn-split-view'); await sleep(12000);
await p.screenshot({path:'d2_split.png'});
await b.close();
