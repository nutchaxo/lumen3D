import {DIR,launch,newPage,shot,openViewer,E95,sleep,boxes} from './lib.mjs';
const b=await launch(); const p=await newPage(b);
await openViewer(p,E95,2000);
await p.evaluate(()=>document.querySelector('[data-plugin-id="decompose-channels"]').click());
await sleep(30000);
await shot(p,'decomposer',{targets:[{box:{x:1366,y:123,width:122,height:32},n:1,side:'left'},{box:{x:1497,y:123,width:87,height:32},n:2,side:'bottom',dx:-30},{box:{x:1362,y:190,width:226,height:250},n:3,side:'left'},{box:{x:1362,y:458,width:226,height:250},n:4,side:'left',noBox:true}]});
await b.close();
