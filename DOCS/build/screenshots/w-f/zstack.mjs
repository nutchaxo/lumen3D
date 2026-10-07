import {launch,newPage,shot,openViewer,E95,sleep,boxes} from './lib.mjs';
const b=await launch(); const p=await newPage(b);
await openViewer(p,E95,2000);
await p.evaluate(()=>document.querySelector('[data-plugin-id="zstack-browser"]').click());
await sleep(15000);
let tg=await boxes(p,[{sel:'#zstack-diagram',n:1,side:'left'},{sel:'#zstack-notch',n:2,side:'left'},{sel:'#zstack-track',n:3,side:'left',pad:0},{sel:'#zstack-handle-top',n:4,side:'left'},{sel:'#zstack-handle-bottom',n:4,side:'left'},{sel:'#zstack-crop-row',n:5,side:'left'},{sel:'#zstack-info',n:6,side:'left'}]);
await shot(p,'zstack-3d',{targets:tg});
// drag the cursor from the notch into the track
await p.mouse.move(1562,139); await p.mouse.down(); await p.mouse.move(1562,200,{steps:6}); await p.mouse.move(1562,290,{steps:6}); await p.mouse.up();
await sleep(15000);
await p.screenshot({path:'z1.png'});
// thicker cursor
await p.evaluate(()=>{const i=document.getElementById('zstack-thickness-input'); i.value=12; i.dispatchEvent(new Event('change',{bubbles:true}));});
await sleep(10000);
await p.screenshot({path:'z2.png'});
console.log(await p.evaluate(()=>['zstack-cursor','zstack-slice-label','zstack-position-info'].map(i=>{const e=document.getElementById(i);const r=e.getBoundingClientRect();return i+' '+r.x+','+r.y+','+r.width+'x'+r.height+' '+e.textContent.trim().slice(0,100)}).join('\n')));
tg=await boxes(p,[{sel:'#zstack-notch',n:7,side:'left'},{sel:'#zstack-track',n:8,side:'left',pad:0},{sel:'#zstack-handle-top',n:9,side:'left'},{sel:'#zstack-handle-bottom',n:9,side:'left'},{sel:'#zstack-cursor',n:1,side:'left',pad:2},{sel:'#zstack-slice-label',n:2,side:'left'},{sel:'#zstack-thickness-input',n:3,side:'left'},{sel:'#zstack-spin',n:4,side:'left'},{sel:'#zstack-position-info',n:5,side:'left'},{sel:'#btn-zstack-studio',n:6,side:'left'}]);
await shot(p,'zstack-coupe',{targets:tg});
await b.close();
