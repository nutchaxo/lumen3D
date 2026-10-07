import { launch, newAdmin, goTab, shot, sleep } from './common.mjs';
const b = await launch(); const page = await newAdmin(b);
const CL = { x: 248, y: 0, width: 1352, height: 830 };
await goTab(page, '#appearance', 9000);
for (const f of page.frames()) await f.evaluate(()=>document.querySelectorAll('.btn-accent').forEach(e=>{ if(getComputedStyle(e).color===getComputedStyle(e).backgroundColor) e.style.color='#0D0D1A'; })).catch(()=>{});
await sleep(400);
await shot(page, 'tab-appearance', { clip: CL, targets: [
  { sel: '#appearance-root .adm-card', n: 1, side: 'left', nth: 0, dx: 30 }, { sel: '#appearance-root .adm-card', n: 2, side: 'left', nth: 1, dx: 30 },
  { sel: '#appearance-root .adm-page-head .adm-btn-accent', n: 5, side: 'bottom' }, { sel: '#appearance-root .adm-page-head .adm-btn-ghost', n: 6, side: 'bottom' } ]});
await b.close();
