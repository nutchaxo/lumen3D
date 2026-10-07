import {DIR,launch,newPage,shot,sleep,boxes,BASE} from './lib.mjs';
const b=await launch(); const p=await newPage(b);
await p.goto(BASE+'/compare.html?add=3d/Embryo-E95-Em2-Pecam1-Sox2'); await sleep(8000);
await p.screenshot({path:'c0.png'});
console.log(await p.evaluate(()=>[...document.querySelectorAll('header button, header select, header label, header input, #compare-toolbar *')].filter(e=>e.id||e.dataset.action).map(b=>(b.id||b.dataset.action)+'|'+(b.title||'')+'|'+Math.round(b.getBoundingClientRect().x)+','+Math.round(b.getBoundingClientRect().y)).join('\n')));
await b.close();
