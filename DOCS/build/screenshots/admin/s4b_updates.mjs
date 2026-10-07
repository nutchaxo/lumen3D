// "Update available" views of the Updates tab and the release-notes page, with MOCKED GitHub answers
// (real changelog files of 1.58.0 -> 1.59.2, as seen from a site still on 1.57.0). Read-only: nothing is installed.
import { launch, newAdmin, goTab, shot, sleep, S, T, rect } from './common.mjs';
import fs from 'fs';
const b = await launch(); const page = await newAdmin(b);
const step = async (name, fn) => { try { await fn(); } catch (e) { console.log('  [FAIL]', name, String(e).split('\n')[0]); } };
const CL = { x: 248, y: 0, width: 1352, height: 950 };
// ---------- mocked GitHub answers: an update is available ----------
await step('mock-updates', async () => {
  const real = await page.evaluate(async () => (await fetch('api/admin.php?action=version', { credentials: 'same-origin' })).json());
  const cl = v => fs.readFileSync(`/home/user/lumen3D/changelog/changelog_${v}.md`, 'utf8');
  const pend = ['1.58.0', '1.59.0', '1.59.1', '1.59.2'].map(v => ({ version: v, markdown: cl(v) }));
  const hist = ['1.57.0', '1.56.1', '1.56.0'].map(v => ({ version: v, markdown: cl(v) })).filter(x => x.markdown);
  const json = o => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  const rt = (name, fn) => page.route(new RegExp('api/admin\\.php\\?action=' + name), fn);
  await rt('version', r => r.fulfill(json({ ...real, web: '1.57.0' })));
  await rt('update_check', r => r.fulfill(json({ available: true, current: '1.57.0', latest: '1.59.2', publishedAt: '2026-10-05T09:00:00Z', htmlUrl: 'https://github.com/', changelogs: pend })));
  await rt('changelog_history', r => r.fulfill(json({ current: '1.57.0', versions: hist })));
  await rt('update_preflight', r => r.fulfill(json({ target: '1.59.2', ok: Array.from({ length: 28 }, (_, i) => ({ path: 'p' + i })), willQuarantine: [], blocking: [] })));
  await page.reload({ waitUntil: 'networkidle' }); await sleep(2500);
  await goTab(page, '#updates', 5500);
  await shot(page, 'updates-release-notes', { clip: { x: 248, y: 0, width: 1352, height: 950 }, targets: [
    { sel: '#notes-versions', n: 1, side: 'right', dx: -200 }, { sel: '#release-notes', n: 2, side: 'left', dx: 30 }, { sel: '#btn-notes-toggle', n: 3, side: 'top' },
    { sel: '#update-body a[href*="changelog"]', n: 4, side: 'top' }, { sel: '#btn-update', n: 5, side: 'right' } ] });
  await page.locator('#btn-update').click(); await sleep(2000);
  await page.evaluate(() => document.querySelector('.adm-preflight')?.scrollIntoView({ block: 'center' })); await sleep(400);
  await shot(page, 'updates-preflight', { clip: CL, targets: [ { sel: '.adm-preflight', n: 1, side: 'left', dx: 30 }, { sel: '#btn-confirm-update', n: 2, side: 'bottom' }, { sel: '#btn-cancel-update', n: 3, side: 'bottom' } ] });
  await page.goto('http://localhost:8080/admpan.html?changelog=1', { waitUntil: 'networkidle' }); await sleep(4000);
  await shot(page, 'changelog-page', { clip: { x: 0, y: 0, width: 1600, height: 950 }, targets: [
    { sel: '#btn-cl-expand', n: 1, side: 'bottom' }, { sel: '.adm-cl-tag--pending', n: 2, side: 'right', nth: 0 }, { sel: '.adm-cl-tag--target', n: 3, side: 'right' }, { sel: '.adm-cl-group-head', n: 4, side: 'left', nth: 0 } ] });
  await page.evaluate(() => document.querySelectorAll('.adm-cl-group-head')[1]?.scrollIntoView({ block: 'start' })); await sleep(500);
  await shot(page, 'changelog-page-installed', { clip: { x: 0, y: 0, width: 1600, height: 500 }, targets: [
    { sel: '.adm-cl-group-head', n: 5, side: 'left', nth: 1 }, { sel: '.adm-cl-tag--current', n: 6, side: 'right' } ] });
});
await b.close();
