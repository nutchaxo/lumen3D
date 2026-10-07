import {DIR,launch,newPage,shot,sleep,boxes,P2D,BASE} from './lib.mjs';
const b=await launch();
async function fresh(){const p=await newPage(b,{theme:'dark'});await p.goto(BASE+'/2d.html?id='+P2D);await sleep(14000);return p;}
const clk=async(p,s)=>{await p.evaluate(s=>document.querySelector(s).click(),s);await sleep(2500)};
// display adjust
let p=await fresh();
await clk(p,'#btn-display-adjust');
console.log(await p.evaluate(()=>[...document.querySelectorAll('input[type=range]')].map(e=>e.id+':'+Math.round(e.getBoundingClientRect().x)+','+Math.round(e.getBoundingClientRect().y)).join(' ')));
await p.evaluate(()=>{const s=(id,v)=>{const e=document.getElementById(id); if(!e) return; e.value=v; e.dispatchEvent(new Event('input',{bubbles:true}));};});
await shot(p,'2d-affichage',{targets:[{box:{x:0,y:678,width:320,height:260},n:1,side:'right',pad:0,dx:-8}]});
await p.context().close();
// grid
p=await fresh(); await clk(p,'#btn-calibrated-grid');
let tg=await boxes(p,[{sel:'#btn-calibrated-grid',n:1,side:'bottom'}]);
await shot(p,'2d-grille',{targets:tg}); await p.context().close();
// orientation
p=await fresh(); await clk(p,'#btn-orientation-2d');
await p.evaluate(()=>{const e=[...document.querySelectorAll('input[type=range]')].find(e=>e.min==='-180'&&e.max==='180'); if(e){e.value=25;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}});
await sleep(2500);
await shot(p,'2d-orientation',{targets:[{box:{x:0,y:655,width:320,height:210},n:1,side:'right',pad:0,dx:-8,dy:40},{box:{x:950,y:112,width:20,height:830},n:2,side:'right',pad:0,noBox:true,dx:10}]}); await p.context().close();
// figure panel
p=await fresh(); await clk(p,'#btn-figure-panel'); await sleep(4000);
await p.evaluate(()=>{const c=[...document.querySelectorAll('input[type=checkbox]')].filter(e=>e.getBoundingClientRect().x>200&&e.getBoundingClientRect().x<300&&e.getBoundingClientRect().y>150&&e.getBoundingClientRect().y<260&&!e.checked); c.forEach(e=>e.click());});
await sleep(8000);
await shot(p,'2d-planche',{targets:[{box:{x:260,y:170,width:260,height:85},n:1,side:'left',pad:0,noBox:true,dx:-4},{box:{x:530,y:165,width:720,height:90},n:2,side:'top',pad:0},{box:{x:540,y:350,width:800,height:355},n:3,side:'top',pad:0,noBox:true,dy:30},{box:{x:1020,y:810,width:320,height:40},n:4,side:'top',pad:0}]}); await p.context().close();
// split
p=await fresh(); await clk(p,'#btn-split-view'); await sleep(15000);
await shot(p,'2d-vue-divisee',{targets:[{box:{x:0,y:660,width:320,height:230},n:1,side:'right',pad:0,dx:-8},{box:{x:975,y:260,width:610,height:535},n:2,side:'inside',pad:0,noBox:true}]});
await b.close();
