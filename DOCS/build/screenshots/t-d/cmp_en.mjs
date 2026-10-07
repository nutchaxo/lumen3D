import {DIR,launch,newPage,shot,sleep,boxes,BASE,E95,P2D} from './lib.mjs';
const b=await launch(); let p=await newPage(b);
await p.goto(BASE+`/compare.html?add=${E95}&add=3d/Embryo-E85-Em1-Pecam1-Sox2&add=${P2D}`); await sleep(240000);
let tg=await boxes(p,[{sel:'#btn-add-dataset',n:1,side:'bottom'},{sel:'#btn-compare-studio',n:3,side:'bottom'},{sel:'#btn-export-compare',n:4,side:'bottom'},{sel:'#btn-save-compare-workspace',n:5,side:'bottom'},{sel:'#btn-restore-compare-workspace',n:5,side:'bottom'},{sel:'#compare-layout-mode',n:6,side:'bottom'},{sel:'#compare-quality',n:7,side:'bottom'},{sel:'#btn-add-dataset',n:0,side:'bottom'}]);
tg=tg.filter(t=>t.n!==0); tg.push({box:{x:1188,y:76,width:402,height:32},n:8,side:'bottom',pad:2},{box:{x:163,y:72,width:131,height:40},n:2,side:'bottom',pad:2},{box:{x:12,y:131,width:228,height:26},n:9,side:'bottom',pad:2},{box:{x:1357,y:129,width:240,height:30},n:10,side:'bottom',pad:2});
await shot(p,'comparer',{targets:tg});
await p.context().close();
p=await newPage(b);
await b.close();
