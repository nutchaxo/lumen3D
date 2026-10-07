import {DIR,launch,newPage,shot,openViewer,LIVE,sleep,boxes,scrollSidebar} from './lib.mjs';
const b=await launch(); const p=await newPage(b);
await openViewer(p,LIVE,4000);
const click=async s=>{await p.evaluate(s=>document.querySelector(s).click(),s);await sleep(2500)};
await p.mouse.click(255+1329*0.97,911); await sleep(4000);
// inspector
await p.keyboard.press('i'); await sleep(800); await p.mouse.click(997,339); await sleep(3500);
await scrollSidebar(p,-640); await sleep(800);
await shot(p,'suivi-inspecteur',{targets:[{box:{x:960,y:300,width:90,height:80},n:1,side:'right',pad:0},{box:{x:0,y:395,width:320,height:50},n:2,side:'right',pad:0,dx:-8,noBox:false},{box:{x:8,y:455,width:300,height:290},n:3,side:'right',pad:0,dx:-8,dy:-60},{box:{x:8,y:790,width:300,height:75},n:4,side:'right',pad:0,dx:-8}]});
await p.keyboard.press('v');
// cell distance
await p.keyboard.press('d'); await sleep(800);
await p.mouse.click(933,337); await sleep(2500); await p.mouse.click(1020,241); await sleep(3500);
let tg=await boxes(p,[{sel:'.scientific-panel.visible',n:3,side:'left',pad:0}]);
tg.push({box:{x:918,y:322,width:32,height:32},n:1,side:'left',pad:0},{box:{x:1004,y:226,width:32,height:32},n:2,side:'right',pad:0});
await shot(p,'suivi-distance',{targets:tg});
await p.keyboard.press('Escape');
// charts
await click('[data-plugin-id="tracking-charts"]'); await sleep(6000);
await shot(p,'suivi-graphiques',{targets:[{box:{x:336,y:75,width:440,height:320},n:1,side:'right',pad:0},{box:{x:348,y:153,width:290,height:36},n:2,side:'bottom',pad:0},{box:{x:604,y:98,width:104,height:34},n:3,side:'bottom',pad:0}]});
await b.close();
