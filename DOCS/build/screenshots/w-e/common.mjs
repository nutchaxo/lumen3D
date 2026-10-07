// Shared helper: UI_LANG (fr|en) and IMG_DIR (root of the image tree: .../img or .../img-en)
import { launch, newPage, annotate, clearCallouts, sleep, BASE } from '../shotlib.mjs';
export { launch, sleep, BASE, annotate, clearCallouts };
export const LANG = process.env.UI_LANG || 'fr';
const ROOT = process.env.IMG_DIR || (LANG === 'en' ? '/home/user/lumen3D/DOCS/documentation/img-en' : '/home/user/lumen3D/DOCS/documentation/img');
export const L = (o) => (typeof o === 'string' ? o : (o[LANG] ?? o.fr));
import fs from 'fs';
export function outDir(ch) { const d = `${ROOT}/${ch}`; fs.mkdirSync(d, { recursive: true }); return d; }
export const page0 = (b, opts = {}) => newPage(b, { lang: LANG, ...opts });
export async function snap(page, dir, name, { clip, targets } = {}) {
  if (targets) await annotate(page, targets);
  await page.screenshot({ path: `${dir}/${name}.png`, clip, timeout: 240000 });
  if (targets) await clearCallouts(page);
  console.log('shot', name);
}
export async function openViewer(page, id, wait = 5000) {
  await page.goto(`${BASE}/viewer.html?id=${id}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  // wait for the final level: histograms present and the progress line hidden again
  const t0 = Date.now();
  while (Date.now() - t0 < 360000) {
    await sleep(4000);
    const ok = await page.evaluate(() => { try { return VolumeViewer.getChannelHistograms().length > 0 && document.querySelector('#quality-stream-progress')?.classList.contains('hidden'); } catch (_) { return false; } }).catch(() => false);
    if (ok) break;
  }
  await sleep(wait);
}
