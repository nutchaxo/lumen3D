// Chapter 16 screenshots with numbered callouts. Read-only on the platform (nothing is saved).
// Usage:  UI_LANG=fr SHOT_OUT=/path/to/img/ch16 RAW=/path/to/raw node shots_final.mjs
import { launch, newPage, shot, sleep, BASE, annotate, clearCallouts } from '../shotlib.mjs';
import { adminPage, goTab } from '../admlogin.mjs';
const lang = process.env.UI_LANG || 'fr';
const OUT = process.env.SHOT_OUT;
const RAW = process.env.RAW || OUT;
const b = await launch();

// ---------- public pages (home in 4 languages, explorer in 4 languages, themes, mobile) ----------
for (const l of ['fr','en','es','nl']) {
  for (const [name, url] of [['home','index.html'],['explorer','explorer.html']]) {
    const p = await newPage(b, { width: 1280, height: 760, lang: l });
    await p.goto(`${BASE}/${url}`, { waitUntil: 'networkidle' }); await sleep(2500);
    await p.screenshot({ path: `${RAW}/${name}-${l}.png` });
    await p.context().close();
  }
}
for (const theme of ['dark','light']) {
  for (const [name, url] of [['home','index.html'],['explorer','explorer.html']]) {
    const p = await newPage(b, { width: 1280, height: 760, lang, theme });
    await p.goto(`${BASE}/${url}`, { waitUntil: 'networkidle' }); await sleep(2500);
    await p.screenshot({ path: `${RAW}/theme-${name}-${theme}.png` });
    await p.context().close();
  }
}
for (const [name, url, wait] of [['m-home','index.html',3000],['m-explorer','explorer.html',3500],['m-viewer','viewer.html?id=3d/Embryo-E95-Em2-Pecam1-Sox2',35000]]) {
  const p = await newPage(b, { width: 390, height: 780, scale: 2, lang });
  await p.goto(`${BASE}/${url}`, { waitUntil: 'networkidle' }); await sleep(wait);
  await p.screenshot({ path: `${RAW}/${name}.png` });
  if (name === 'm-viewer') { await p.click('#btn-hamburger'); await sleep(800); await p.screenshot({ path: `${RAW}/m-viewer-menu.png` }); }
  await p.context().close();
}

// ---------- language menu ----------
{
  const p = await newPage(b, { width: 1280, height: 560, lang });
  await p.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' }); await sleep(2000);
  await p.click('#lang-dropdown button'); await sleep(500);
  await shot(p, 'menu-langues', { targets: [
    { sel: '#lang-dropdown > button', n: 1, side: 'left' },
    { sel: '#lang-dropdown .dropdown-menu', n: 2, side: 'left' },
    { sel: '[data-action="colorblind"]', n: 3, side: 'bottom' },
    { sel: '#theme-toggle', n: 4, side: 'bottom' },
  ] });
  await p.context().close();
}

// ---------- legal page (public) ----------
{
  const p = await newPage(b, { width: 1280, height: 800, lang });
  await p.goto(`${BASE}/legal.html`, { waitUntil: 'networkidle' }); await sleep(2000);
  await shot(p, 'legal-public', { targets: [
    { sel: '#legal-content section h2', n: 1, side: 'right' },
    { sel: '#legal-content section p', n: 2, side: 'right' },
  ] });
  await p.context().close();
}

// ---------- viewer with the colour-vision simulation ----------
{
  const p = await newPage(b, { width: 1600, height: 950, lang });
  await p.goto(`${BASE}/viewer.html?id=3d/Embryo-E95-Em2-Pecam1-Sox2`, { waitUntil: 'networkidle' });
  await sleep(35000);
  const box = await p.locator('#volume-canvas, canvas').first().boundingBox();
  const clip = { x: 700, y: 120, width: 640, height: 680 };
  for (const m of ['none','protanopia','deuteranopia','tritanopia','achromatopsia']) {
    await p.evaluate(x => ColorBlind.set(x), m); await sleep(1500);
    await p.screenshot({ path: `${RAW}/cb-${m}.png`, clip });
  }
  await p.evaluate(x => ColorBlind.set(x), 'none'); await sleep(600);
  await p.evaluate(() => ColorBlind.openModal()); await sleep(1200);
  await shot(p, 'daltonisme-menu', { targets: [
    { sel: '.cb-modal-header h3', n: 1, side: 'right' },
    { sel: '.cb-option-card.active', n: 2, side: 'right' },
    { sel: '.cb-option-card[data-cb-type="deuteranopia"]', n: 3, side: 'right' },
    { sel: '.cb-option-card[data-cb-type="achromatopsia"]', n: 4, side: 'right' },
  ] });
  await p.evaluate(() => ColorBlind.closeModal && ColorBlind.closeModal());
  await p.context().close();
}

// ---------- admin tabs ----------
const page = await adminPage(b, { lang });
await goTab(page, '#branding', 4500);
await page.setViewportSize({ width: 1600, height: 1180 }); await sleep(800);
await shot(page, 'identite', { targets: [
  { sel: '#branding-root .adm-card', nth: 0, n: 1, side: 'tl' },
  { sel: '#branding-root .adm-card', nth: 1, n: 2, side: 'tl' },
  { sel: '#branding-root .adm-card', nth: 2, n: 3, side: 'tl' },
  { sel: '#branding-root .adm-card', nth: 3, n: 4, side: 'tl' },
  { sel: '#branding-root .adm-card', nth: 4, n: 5, side: 'tl' },
  { sel: '#branding-save', n: 6, side: 'left' },
  { sel: '#branding-root input[data-loc-path="specimen.plural"][data-loc="nl"]', n: 7, side: 'right' },
] });
await page.setViewportSize({ width: 1600, height: 950 });
await goTab(page, '#dataset-types', 4500);
await shot(page, 'types-donnees', { targets: [
  { sel: '#dtype-count-3d', n: 1, side: 'bottom' },
  { sel: '#dataset-types-root input[type="text"]', nth: 0, n: 2, side: 'right' },
  { sel: '#dataset-types-root summary', nth: 0, n: 3, side: 'right' },
  { sel: '#dtypes-reset', n: 4, side: 'left' },
  { sel: '#dtypes-save', n: 5, side: 'bottom' },
] });
await goTab(page, '#appearance', 6000);
await shot(page, 'apparence', { targets: [
  { sel: '.adm-color-input', nth: 0, n: 1, side: 'left' },
  { sel: '#appearance-font', n: 2, side: 'left' },
  { sel: '#appearance-radius', n: 3, side: 'left' },
  { sel: '#appearance-preview', n: 4, side: 'inside', dx: -300, dy: -150 },
  { sel: '#appearance-save', n: 5, side: 'bottom' },
] });
await goTab(page, '#stats', 4500);
await shot(page, 'stats', { targets: [
  { sel: '.adm-stat-card', nth: 0, n: 1, side: 'top' },
  { sel: '.adm-stat-card', nth: 1, n: 2, side: 'top' },
  { sel: '.adm-stat-card', nth: 2, n: 3, side: 'top' },
  { sel: '.adm-table', n: 4, side: 'left' },
] });
await goTab(page, '#legal', 3500);
await page.screenshot({ path: `${RAW}/adm-legal.png` });

// page editor (own tab): look, select, never edit
const ed = await page.context().newPage();
await ed.setViewportSize({ width: 1600, height: 950 });
await ed.goto(BASE + '/admpan.html?editor=about', { waitUntil: 'networkidle' }); await sleep(6000);
await shot(ed, 'editeur', { targets: [
  { sel: '#pages-side .adm-tabs, #pages-side > div', nth: 0, n: 1, side: 'right', dy: -2 },
  { sel: '#pages-palette', n: 2, side: 'right', dy: 40 },
  { sel: '#pe-dev-desktop', n: 3, side: 'bottom' },
  { sel: '#pe-status', n: 4, side: 'bottom' },
  { sel: '#pe-save', n: 5, side: 'bottom' },
  { sel: '#pe-publish', n: 6, side: 'bottom' },
  { sel: '#pages-frame-wrap', n: 7, side: 'inside', dx: 200, dy: 120 },
] });
// variables panel
await ed.locator('#pages-side button', { hasText: /Variables|Variables/ }).first().click().catch(() => console.log('no variables tab'));
await sleep(1200);
await ed.screenshot({ path: `${RAW}/editeur-variables.png`, clip: { x: 0, y: 55, width: 345, height: 895 } });
await ed.close();
await b.close();
