import { launch, newPage, shot, sleep, BASE } from '../shotlib.mjs';
import { adminPage, goTab } from '../admlogin.mjs';
const lang = process.env.UI_LANG || 'fr';
const b = await launch();
const page = await adminPage(b, { lang });
await goTab(page, '#branding', 4500);
await page.setViewportSize({ width: 1600, height: 1180 }); await sleep(800);
await shot(page, 'identite', { targets: [
  { sel: '#branding-root .adm-card', nth: 0, n: 1, side: 'tl' },
  { sel: '#branding-root .adm-card', nth: 1, n: 2, side: 'tl' },
  { sel: '#branding-root .adm-card', nth: 2, n: 3, side: 'tl' },
  { sel: '#branding-root .adm-card', nth: 3, n: 4, side: 'tl' },
  { sel: '#branding-root .adm-card', nth: 4, n: 5, side: 'tl' },
  { sel: '#branding-save', n: 6, side: 'bottom' },
  { sel: '#branding-root input[data-loc-path="specimen.plural"][data-loc="nl"]', n: 7, side: 'right' },
] });
const ed = await page.context().newPage();
await ed.setViewportSize({ width: 1600, height: 950 });
await ed.goto(BASE + '/admpan.html?editor=about', { waitUntil: 'networkidle' }); await sleep(6000);
await shot(ed, 'editeur', { targets: [
  { sel: '#pe-select', n: 1, side: 'bottom' },
  { sel: '#pe-loc', n: 2, side: 'bottom' },
  { sel: '#pages-side > div', nth: 0, n: 3, side: 'right', dy: -2 },
  { sel: '#pages-palette', n: 4, side: 'right', dy: 60 },
  { sel: '#pe-dev-desktop', n: 5, side: 'bottom' },
  { sel: '#pe-save', n: 6, side: 'bottom' },
  { sel: '#pe-publish', n: 7, side: 'bottom' },
  { box: { x: 900, y: 300, width: 300, height: 90 }, noBox: true, n: 8, side: 'inside' },
] });
await ed.setViewportSize({ width: 1600, height: 1500 }); await sleep(1500);
await ed.locator('#pages-side button', { hasText: 'Variables' }).first().click(); await sleep(1500);
await ed.screenshot({ path: `${process.env.SHOT_OUT}/editeur-variables.png`, clip: { x: 0, y: 55, width: 345, height: 1440 } });
await ed.close();
// colour-vision chooser
const p = await newPage(b, { width: 1600, height: 950, lang });
await p.goto(`${BASE}/viewer.html?id=3d/Embryo-E95-Em2-Pecam1-Sox2`, { waitUntil: 'networkidle' });
await sleep(30000);
await p.evaluate(() => ColorBlind.openModal()); await sleep(1200);
await shot(p, 'daltonisme-menu', { targets: [
  { sel: '.cb-modal-header h3', n: 1, side: 'right' },
  { sel: '.cb-option-card.active', n: 2, side: 'right' },
  { sel: '.cb-option-card[data-cb-type="deuteranopia"]', n: 3, side: 'right', dx: 270 },
  { sel: '.cb-option-card[data-cb-type="achromatopsia"]', n: 4, side: 'right', dx: 270 },
] });
await b.close();
