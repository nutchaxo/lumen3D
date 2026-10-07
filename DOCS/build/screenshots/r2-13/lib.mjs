// Shared helpers for chapter 12 screenshots.
// UI_LANG=fr|en (default fr); IMG_DIR relative to DOCS/documentation (default img/ch13, en: img-en/ch13)
import fs from 'fs';
export const LANG = process.env.UI_LANG || 'fr';
export const DOCS = '/home/user/lumen3D/DOCS/documentation/';
export const DIR = DOCS + (process.env.IMG_DIR || (LANG === 'en' ? 'img-en/ch13' : 'img/ch13'));
fs.mkdirSync(DIR, { recursive: true });
process.env.SHOT_OUT = DIR;
const S = await import('../shotlib.mjs');
export const { launch, annotate, clearCallouts, shot, elShot, sleep, BASE } = S;
export const t = (fr, en) => (LANG === 'en' ? en : fr);
export const newPage = (b, o = {}) => S.newPage(b, { lang: LANG, ...o });
export async function openViewer(page, id, extra = 0, qs = '') {
  await page.goto(`${BASE_}/viewer.html?id=${id}${qs}`);
  await waitStreamed(page);
  await S.sleep(extra);
}
// wait until the brick stream bar has appeared then disappeared (max ~4 min)
export async function waitStreamed(page, max = 240000) {
  const t0 = Date.now(); let calm = 0;
  await S.sleep(8000);
  while (Date.now() - t0 < max) {
    const busy = await page.evaluate(() => { const e = document.getElementById('quality-stream-progress'); return !!e && !e.classList.contains('hidden'); }).catch(() => true);
    calm = busy ? 0 : calm + 1;
    if (calm >= 3) return;
    await S.sleep(2000);
  }
}
const BASE_ = 'http://localhost:8080';
export const E95 = '3d/Embryo-E95-Em2-Pecam1-Sox2';
export const LIVE = 'live/Demo-Lumen3D-E85-Em1-30min-2ch-4tp';
export const P2D = '2d/DLL4xCD1-E95-x3.2-240913-1';
// volume centre of the canvas (the page's #viewer canvas area)
export const CANVAS = { x: 960, y: 480 };
// resolve selectors to boxes in one evaluate (robust when the main thread is busy)
export async function boxes(page, items) {
  const r = await page.evaluate((sels) => sels.map(s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; }), items.map(i => i.sel));
  return items.map((it, k) => ({ ...it, sel: undefined, box: r[k] })).filter(i => { if (!i.box) console.log('  missing', i.n); return i.box; });
}
export async function scrollSidebar(page, to = 99999) {
  await page.evaluate((to) => { for (const e of document.querySelectorAll('*')) { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); if (r.x < 5 && r.width > 250 && r.width < 340 && (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && e.scrollHeight > e.clientHeight) e.scrollTop = to < 0 ? e.scrollHeight - e.clientHeight + to : to; } }, to);
}
