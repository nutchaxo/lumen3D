// Chapter 13 screenshots. Env: UI_LANG=fr|en, IMG_DIR=<output dir>
import { launch, newPage, BASE, sleep, annotate, clearCallouts } from '../shotlib.mjs';
import fs from 'fs';
const LANG = process.env.UI_LANG || 'fr';
const DIR = process.env.IMG_DIR || '/home/user/lumen3D/DOCS/documentation/img/ch13';
fs.mkdirSync(DIR, { recursive: true });
const L = {
  fr: { groups: ['Données', 'Site public', 'Extensions', 'Système'], crumb: 'Fil d’Ariane', theme: 'Thème', lang: 'Langue', out: 'Déconnexion', explorer: 'Vers le site public',
        list: 'Liste', preview: 'Aperçu', settings: 'Réglages', drop: 'Zone de dépôt', safe: 'Dossier privé', refresh: 'Actualiser',
        speed: 'Test de vitesse', todo: 'Datasets à mettre à jour', formats: 'Formats de données' },
  en: { groups: ['Data', 'Public site', 'Extensions', 'System'], crumb: 'Breadcrumb', theme: 'Theme', lang: 'Language', out: 'Log out', explorer: 'To the public site',
        list: 'List', preview: 'Preview', settings: 'Settings', drop: 'Drop zone', safe: 'Private folder', refresh: 'Refresh',
        speed: 'Speed test', todo: 'Datasets to update', formats: 'Data formats' },
}[LANG];
const b = await launch();
const page = await newPage(b, { width: 1600, height: 950, lang: LANG });
await page.addInitScript(l => { try { localStorage.setItem('iribhm-lang', l); localStorage.setItem('lumen-lang', l); localStorage.setItem('adm-lang', l); } catch (_) {} }, LANG);
await page.goto(BASE + '/admpan.html', { waitUntil: 'networkidle' });
await sleep(800);
await page.fill('#login-username', 'admin');
await page.fill('#login-password', (process.env.ADMIN_PASSWORD || ''));
await page.click('#btn-login');
await sleep(3000);
const go = async (h, w = 2500) => { await page.evaluate(x => { location.hash = x; }, h); await sleep(w); };
const shot = async (name, targets, clip) => {
  await annotate(page, targets);
  await page.screenshot({ path: `${DIR}/${name}.png`, clip });
  await clearCallouts(page);
  console.log('shot', name);
};
// 1. overview
await go('#datasets', 4000);
await shot('admin-overview', [
  { sel: '[data-group="data"]', n: 1, side: 'tr', pad: 2 },
  { sel: '[data-group="site"]', n: 2, side: 'tr', pad: 2 },
  { sel: '[data-group="ext"]', n: 3, side: 'tr', pad: 2 },
  { sel: '[data-group="system"]', n: 4, side: 'tr', pad: 2 },
  { sel: '.adm-topbar-title', n: 5, side: 'right', pad: 4 },
  { sel: '.adm-nav-ext', n: 6, side: 'right', pad: 2 },
], { x: 0, y: 0, width: 540, height: 950 });
// 2. import
await go('#upload', 3000);
await shot('admin-import', [
  { sel: '.upl-drop', n: 1, side: 'tl', pad: 2 },
  { sel: '.upl-note, .upl-warn', n: 2, side: 'tl', pad: 2 },
  { sel: '.upl-global', n: 3, side: 'tl', pad: 2 },
  { sel: '.upl-state', n: 4, side: 'right', pad: 2 },
  { sel: '.upl-section .adm-btn-sm', n: 5, side: 'bottom', pad: 3 },
]);
// 3. dataset updates (read only)
await go('#dataset-updates', 5000);
await shot('admin-dataset-updates', [
  { sel: '.dupd-card', n: 1, side: 'tl', pad: 2 },
  { sel: '.dupd-card .adm-btn-accent', n: 2, side: 'left', pad: 3 },
  { sel: '.dupd-seg', n: 3, side: 'left', pad: 3, nth: 0 },
  { sel: '.dupd-card .adm-btn-accent', n: 4, side: 'left', pad: 3, nth: 1 },
  { sel: '.dupd-card ~ * .adm-btn-accent, .adm-page-head .adm-btn-accent', n: 5, side: 'top', pad: 3 },
]);
await b.close();
