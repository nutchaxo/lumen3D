import { launch, page0, snap, outDir, openViewer, sleep, L, annotate, clearCallouts } from './common.mjs';
const dir = outDir('ch11');
const b = await launch();
const page = await page0(b);
await openViewer(page, '3d/Embryo-E95-Em2-Pecam1-Sox2', 8000);
await page.click('#btn-reset-view').catch(() => {});
await sleep(4000);
// 1. channel panel, DAPI expanded
const A = (n, fr, en, sel, side = 'right', extra = {}) => ({ n, label: L({ fr, en }), sel, side, ...extra });
const targets = [
  A(1, 'Afficher + nom', 'Show + name', '#channel-item-0 .channel-name', 'top', { dx: -20 }),
  A(2, 'Isoler · opacité · couleur', 'Solo · opacity · colour', '#channel-item-0 .channel-quick', 'right', { dx: 40 }),
  A(3, 'Histogramme + poignées min / gamma / max', 'Histogram + min / gamma / max handles', '#ch-hist-0', 'right', { dx: -10, dy: -40 }),
  A(4, 'Valeurs min · gamma · max', 'Min · gamma · max values', '#lbl-mid-0', 'right', { dx: 70 }),
  A(5, 'Auto · Soft · Contrast · Reset', 'Auto · Soft · Contrast · Reset', '#channel-item-0 [data-channel-action="reset"]', 'right', { dx: 60 }),
  A(6, 'Flou gaussien', 'Gaussian blur', '#ch-denoise-0', 'right', { dx: 50 }),
];
await snap(page, dir, 'panneau-canaux', { clip: { x: 0, y: 60, width: 660, height: 660 }, targets });
await snap(page, dir, 'panneau-canaux-nu', { clip: { x: 0, y: 60, width: 320, height: 660 } });
console.log(await page.evaluate(() => [...document.querySelectorAll('#channel-item-0 button')].map(b => b.dataset.channelAction + '|' + b.textContent.trim() + '|' + b.title)));
// 2. gaussian before / after on Sox2 alone, zoomed
await page.click('[data-channel-action="solo"][data-channel-idx="2"]');
await sleep(2000);
const cv = { x: 320, y: 60, width: 1280, height: 890 };
await sleep(8000);
const clip = { x: 870, y: 150, width: 420, height: 380 };
await snap(page, dir, 'flou-avant', { clip });
await page.evaluate(() => { const s = document.getElementById('ch-denoise-2'); s.value = 2.0; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); });
await sleep(30000);
await snap(page, dir, 'flou-apres', { clip });
await snap(page, dir, 'flou-apres-page');
await b.close();
