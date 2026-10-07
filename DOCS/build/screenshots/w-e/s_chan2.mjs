import { launch, page0, snap, outDir, openViewer, sleep } from './common.mjs';
const dir = outDir('ch11');
const b = await launch();
const page = await page0(b);
await openViewer(page, '3d/Embryo-E95-Em2-Pecam1-Sox2', 8000);
// check Auto / Soft / Contrast / Reset labels
const out = {};
for (const idx of [0, 1, 2]) {
  for (const a of ['auto', 'preset-soft', 'preset-contrast', 'reset']) {
    await page.evaluate(([i, a]) => document.querySelector(`#channel-item-${i} [data-channel-action="${a}"]`)?.click(), [idx, a]);
    await sleep(600);
    out[`${idx}-${a}`] = await page.evaluate((i) => [document.getElementById('lbl-min-' + i)?.textContent, document.getElementById('lbl-mid-' + i)?.textContent, document.getElementById('lbl-max-' + i)?.textContent].join(' / '), idx);
  }
}
console.log(JSON.stringify(out, null, 1));
await page.evaluate(() => { const s = document.getElementById('ch-denoise-0'); }).catch(()=>{});
await b.close();
