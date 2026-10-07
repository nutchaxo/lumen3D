import { launch, shot, sleep, BASE } from '../shotlib.mjs';
import { adminPage } from '../admlogin.mjs';
const lang = process.env.UI_LANG || 'fr';
const b = await launch();
const page = await adminPage(b, { lang });
const ed = await page.context().newPage();
await ed.setViewportSize({ width: 1600, height: 950 });
await ed.goto(BASE + '/admpan.html?editor=about', { waitUntil: 'networkidle' }); await sleep(6000);
await shot(ed, 'editeur', { targets: [
  { sel: '#pe-select', n: 1, side: 'tr' },
  { sel: '#pe-loc', n: 2, side: 'tr' },
  { sel: '#pages-side > div', nth: 0, n: 3, side: 'tl' },
  { sel: '#pages-palette', n: 4, side: 'right', dy: 60 },
  { sel: '#pe-dev-desktop', n: 5, side: 'bottom' },
  { sel: '#pe-save', n: 6, side: 'bottom' },
  { sel: '#pe-publish', n: 7, side: 'bottom' },
  { box: { x: 900, y: 300, width: 300, height: 90 }, noBox: true, n: 8, side: 'inside' },
] });
await b.close();
