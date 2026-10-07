// Data updates tab. CHANGES SERVER STATE: converts the two legacy demo datasets (E8-Em5 format 1, E9-Em6 format 2).
// Before: back them up (cp -a DATA_WEB/3d/Embryo-E8-Em5-Pecam1-Sox2 and E9-Em6 elsewhere); after: restore them
// (rm -rf the converted folders, cp -a the backups back) and delete uploads/migrations if it exists.
import { launch, newAdmin, goTab, shot, sleep } from './common.mjs';
const E8 = '3d/Embryo-E8-Em5-Pecam1-Sox2', E9 = '3d/Embryo-E9-Em6-Pecam1-Sox2';
const b = await launch(); const page = await newAdmin(b, { height: 1350 });
await goTab(page, '#dataset-updates', 3000);
const full = { x: 248, y: 58, width: 1352, height: 1292 };
const top = () => page.evaluate(() => { for (const e of document.querySelectorAll('*')) if (e.scrollTop > 0) e.scrollTop = 0; });
await page.click('[data-dupd="speed"]'); await sleep(2000);
await top(); await shot(page, 'dupd-speedtest', { clip: { x: 248, y: 58, width: 1352, height: 560 }, targets: [
  { sel: '[data-dupd="speed"]', n: 1, side: 'left' }, { sel: '.dupd-race-score', n: 2, side: 'left', nth: 0 }, { sel: '.dupd-race-track', n: 3, side: 'top', nth: 1 } ] });
await sleep(6000);
await top(); await shot(page, 'dupd-speedtest-result', { clip: { x: 248, y: 58, width: 1352, height: 560 }, targets: [
  { sel: '[data-dupd="speed"]', n: 1, side: 'left' }, { sel: '.dupd-races > :nth-child(1) .dupd-race-score', n: 2, side: 'left' },
  { sel: '.dupd-race-badge', n: 3, side: 'left' }, { sel: '.dupd-speed-verdict', n: 4, side: 'bottom' } ] });
await page.route('**/api/migrations*', async r => { await sleep(500); r.continue(); });
await page.click(`[data-dupd="exec"][data-id="${E9}"][data-exec="server"]`);
await page.click(`[data-dupd="exec"][data-id="${E8}"][data-exec="browser"]`);
await sleep(300);
await top(); await shot(page, 'dupd-before', { clip: full, targets: [
  { sel: '[data-dupd="refresh"]', n: 1, side: 'top' }, { sel: '[data-dupd="update-all"]', n: 2, side: 'top' }, { sel: '.dupd-ds', n: 3, side: 'tl', pad: 6 },
  { sel: '.dupd-ds .dupd-ds-steps', n: 4, side: 'bottom' }, { sel: '.dupd-ds .dupd-seg', n: 5, side: 'left' }, { sel: '.dupd-ds [data-dupd="update"]', n: 6, side: 'bottom' } ] });
await page.click(`[data-dupd="update"][data-id="${E8}"]`);
await sleep(400);
await page.click(`[data-dupd="update"][data-id="${E9}"]`);
await sleep(3500);
await top();
await shot(page, 'dupd-running', { clip: full, targets: [
  { sel: '[data-dupd="pause"]', n: 1, side: 'top' }, { sel: '.dupd-lanes', n: 2, side: 'right', dx: -200 }, { sel: '.dupd-ds', n: 3, side: 'right', dx: -90 },
  { sel: '.dupd-ds .dupd-seg', n: 4, side: 'left' }, { sel: '.dupd-ds .dupd-live-line, .dupd-ds [data-dupd-live]', n: 5, side: 'top' }, { sel: '.dupd-ds [data-dupd="cancel"]', n: 6, side: 'left' } ] });
const card = await page.locator('.dupd-ds').first().boundingBox();
await shot(page, 'dupd-dataset-card', { clip: { x: card.x - 6, y: card.y - 6, width: card.width + 12, height: card.height + 12 }, targets: [
  { sel: '.dupd-ds .dupd-ds-steps', n: 1, side: 'bottom', dy: -4 }, { sel: '.dupd-ds .dupd-seg', n: 2, side: 'left' }, { sel: '.dupd-ds [data-dupd="cancel"]', n: 3, side: 'left' }, { sel: '.dupd-ds-live', n: 4, side: 'right', dx: -300 } ] });
for (let i = 0; i < 100; i++) { await sleep(2000); if (!(await page.locator('.dupd-ds').count())) break; }
await top(); await sleep(1500);
await page.evaluate(() => document.querySelectorAll('.dupd-fold').forEach(d => { d.open = true; }));
await sleep(600);
await shot(page, 'dupd-folds', { clip: full, targets: [ { sel: '.dupd-migs', n: 1, side: 'right', dx: -120 }, { sel: '.dupd-log', n: 2, side: 'right', dx: -120 }, { sel: '[data-dupd="clear-log"]', n: 3, side: 'right' } ] });
await b.close();
