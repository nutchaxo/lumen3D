import {launch,newPage,shot,sleep,BASE} from '../shotlib.mjs';
const b=await launch(); const p=await newPage(b);
await p.goto(BASE+'/viewer.html?id=3d/Embryo-E95-Em2-Pecam1-Sox2');
await sleep(30000);
await p.screenshot({path:'t0.png'});
const html=await p.evaluate(()=>[...document.querySelectorAll('header button, header [data-plugin-id], #canvas-overlay button, .toolbar button')].map(b=>(b.id||'')+'|'+(b.dataset.pluginId||b.dataset.tool||'')+'|'+(b.title||b.getAttribute('aria-label'))+'|'+JSON.stringify(b.getBoundingClientRect().toJSON()).slice(0,60)).join('\n'));
console.log(html);
await b.close();
