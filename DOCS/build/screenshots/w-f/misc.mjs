import {DIR,launch,newPage,shot,openViewer,E95,sleep,boxes} from './lib.mjs';
const b=await launch(); const p=await newPage(b);
await openViewer(p,E95,2000);
const click=async s=>{await p.evaluate(s=>document.querySelector(s).click(),s);await sleep(3000)};
// export 3D view popover
await click('#btn-export-view'); await sleep(1500);
console.log(await p.evaluate(()=>{const e=document.getElementById('view-export-popover');const r=e.getBoundingClientRect();return r.x+','+r.y+','+r.width+'x'+r.height}));
let tg=await boxes(p,[{sel:'#view-export-popover',n:2,side:'left'},{sel:'#btn-export-view',n:1,side:'left'}]);
await shot(p,'export-vue',{targets:tg});
await p.keyboard.press('Escape'); await sleep(500);
// download center
await click('[data-plugin-id="download-center"]'); await sleep(3000);
await p.screenshot({path:DIR+'/centre-telechargement.png'});
await p.keyboard.press('Escape'); await sleep(800);
// chunk debug
await click('[data-plugin-id="chunk-debug"]'); await sleep(5000);
await p.mouse.move(980,480); await sleep(1500);
await p.screenshot({path:DIR+'/chunk-debug.png'});
await click('[data-plugin-id="chunk-debug"]');
// presentation mode


await b.close();
