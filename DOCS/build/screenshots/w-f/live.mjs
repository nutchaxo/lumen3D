import {DIR,launch,newPage,shot,openViewer,LIVE,sleep,boxes,scrollSidebar} from './lib.mjs';
const b=await launch(); const p=await newPage(b);
await openViewer(p,LIVE,4000);
const click=async s=>{await p.evaluate(s=>document.querySelector(s).click(),s);await sleep(2500)};
const seek=async f=>{await p.mouse.click(255+1329*f,911); await sleep(4000)};
// 1 timeline
await seek(0.66);
let tg=await boxes(p,[{sel:'#timeline-btn-play',n:1,side:'top'},{sel:'#timeline-btn-speed',n:2,side:'top'},{sel:'#timeline-time-display',n:3,side:'top'},{sel:'#timeline-scrubber-track',n:4,side:'top',dx:200}]);
tg.push({box:{x:16,y:618,width:286,height:176},n:5,side:'right',pad:3,dy:-60});
await shot(p,'timeline',{targets:tg});
// 2 menu (toolbar collapsed on this narrow header)
await click('#btn-hamburger');
tg=await boxes(p,[{sel:'[data-tool="inspect"]',n:1,side:'bottom'},{sel:'[data-tool="cell-measure"]',n:2,side:'bottom'},{sel:'[data-plugin-id="tracking-charts"]',n:3,side:'bottom'},{sel:'[data-plugin-id="tracking-trails"]',n:4,side:'bottom'},{sel:'[data-plugin-id="tracking-surface"]',n:5,side:'bottom'}]);
await shot(p,'suivi-menu',{clip:{x:1200,y:55,width:400,height:450},targets:tg});
await click('#btn-hamburger');
// 3 surface + trails
await click('[data-plugin-id="tracking-trails"]');
await click('[data-plugin-id="tracking-surface"]'); await sleep(3000);
await seek(0.97);
await scrollSidebar(p); await sleep(1000);
await shot(p,'suivi-trajectoires',{targets:[{box:{x:0,y:185,width:320,height:480},n:2,side:'right',pad:0,dx:-8,dy:-110,noBox:false},{box:{x:0,y:683,width:320,height:175},n:1,side:'right',pad:0,dx:-8}]});
await click('[data-plugin-id="tracking-trails"]'); await click('[data-plugin-id="tracking-surface"]');
// 4 inspector
await scrollSidebar(p,0);
await p.keyboard.press('i'); await sleep(800); await p.mouse.click(997,339); await sleep(3500);
await scrollSidebar(p,560); await sleep(800);
await p.screenshot({path:'l_insp_a.png'});
await scrollSidebar(p); await sleep(800);
await p.screenshot({path:'l_insp_b.png'});
await b.close();
