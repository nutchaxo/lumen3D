import { launch, newPage, shot, sleep, BASE } from '../shotlib.mjs';
const lang='en';
const b = await launch();
// colour-vision chooser
const p = await newPage(b, { width: 1600, height: 950, lang });
await p.goto(`${BASE}/viewer.html?id=3d/Embryo-E95-Em2-Pecam1-Sox2`, { waitUntil: 'networkidle' });
await sleep(30000);
await p.evaluate(() => ColorBlind.openModal()); await sleep(1200);console.log(await p.evaluate(()=>[...document.querySelectorAll('.cb-modal-header h3')].map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height,getComputedStyle(e).display]})));
await shot(p, 'daltonisme-menu', { targets: [
  { sel: '.cb-modal-header h3', n: 1, side: 'right' },
  { sel: '.cb-option-card.active', n: 2, side: 'right' },
  { sel: '.cb-option-card[data-cb-type="deuteranopia"]', n: 3, side: 'right', dx: 270 },
  { sel: '.cb-option-card[data-cb-type="achromatopsia"]', n: 4, side: 'right', dx: 270 },
] });
await b.close();
