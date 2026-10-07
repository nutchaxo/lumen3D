// Shared helpers of the admin-guide screenshot scripts.
//   UI_LANG = fr|en|es|nl   (admin UI language, default fr)
//   IMG_DIR = output folder (default /home/user/lumen3D/DOCS/admin-guide/img)
//   S       = scratch dir holding the demo import sources (default: parent of this file)
import { launch, newPage, annotate, clearCallouts, sleep, BASE, chromium } from '../shotlib.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
export { launch, sleep, BASE, annotate, clearCallouts };
export const LANG = process.env.UI_LANG || 'fr';
export const IMG_DIR = process.env.IMG_DIR || '/home/user/lumen3D/DOCS/admin-guide/img';
export const S = process.env.S || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const USER = process.env.ADM_USER || 'admin';
export const PASS = process.env.ADM_PASS || (process.env.ADMIN_PASSWORD || '');

// Callout labels (only where a short word helps; most callouts are bare numbers explained by the legend table).
const DICT = {
  fr: { groups: 'Groupes', crumb: "Fil d'Ariane", theme: 'Thème', language: 'Langue', logout: 'Déconnexion', collapse: 'Réduire', explorer: 'Explorer', unsaved: 'Modifications non sauvegardées' },
  en: { groups: 'Groups', crumb: 'Breadcrumb', theme: 'Theme', language: 'Language', logout: 'Log out', collapse: 'Collapse', explorer: 'Explorer', unsaved: 'Unsaved changes' },
  es: { groups: 'Grupos', crumb: 'Ruta', theme: 'Tema', language: 'Idioma', logout: 'Cerrar sesión', collapse: 'Contraer', explorer: 'Explorador', unsaved: 'Cambios sin guardar' },
  nl: { groups: 'Groepen', crumb: 'Kruimelpad', theme: 'Thema', language: 'Taal', logout: 'Uitloggen', collapse: 'Inklappen', explorer: 'Verkenner', unsaved: 'Niet-opgeslagen wijzigingen' },
};
export const T = k => (DICT[LANG] || DICT.fr)[k] || DICT.fr[k] || k;

export async function newAdmin(b, { height = 950 } = {}) {
  const page = await newPage(b, { width: 1600, height, lang: LANG, theme: 'dark', admTheme: 'dark' });
  await page.goto(BASE + '/admpan.html', { waitUntil: 'networkidle' });
  await sleep(800);
  await page.fill('#login-username', USER);
  await page.fill('#login-password', PASS);
  await page.click('#btn-login');
  await sleep(2500);
  return page;
}
export async function goTab(page, hash, wait = 2500) {
  await page.evaluate(h => { location.hash = h; }, hash);
  await sleep(wait);
}
export async function shot(page, name, { clip, targets } = {}) {
  if (targets) await annotate(page, targets);
  await page.screenshot({ path: `${IMG_DIR}/${name}.png`, clip });
  if (targets) await clearCallouts(page);
  console.log('  shot', name);
}
// clip around a selector (with margin), annotated
export async function elShot(page, sel, name, { targets, margin = 0, nth = 0 } = {}) {
  const box = await page.locator(sel).nth(nth).boundingBox();
  if (!box) { console.log('  [elShot] missing', sel); return; }
  const vp = page.viewportSize();
  const x = Math.max(0, box.x - margin), y = Math.max(0, box.y - margin);
  const clip = { x, y, width: Math.min(vp.width - x, box.width + 2 * margin), height: Math.min(vp.height - y, box.height + 2 * margin) };
  await shot(page, name, { clip, targets });
}
export const rect = async (page, sel, nth = 0) => page.locator(sel).nth(nth).boundingBox();
