import {DIR,launch,newPage,shot,openViewer,LIVE,sleep,boxes} from './lib.mjs';
const b=await launch(); const p=await newPage(b);
await openViewer(p,LIVE,5000);
await p.screenshot({path:'live0.png'});
console.log(await p.evaluate(()=>[...document.querySelectorAll('header [data-plugin-id]')].map(e=>e.dataset.pluginId).join(' ')));
console.log(await p.evaluate(()=>[...document.querySelectorAll('#timeline-panel *')].filter(e=>e.id).map(e=>e.id+' '+Math.round(e.getBoundingClientRect().x)+','+Math.round(e.getBoundingClientRect().y)+','+Math.round(e.getBoundingClientRect().width)+'x'+Math.round(e.getBoundingClientRect().height)).join('\n')));
await b.close();
