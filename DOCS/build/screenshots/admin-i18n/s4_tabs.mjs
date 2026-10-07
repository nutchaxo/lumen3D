// All the other tabs (read-only). Updates tab uses mocked GitHub answers for the "update available" views.
import { launch, newAdmin, goTab, shot, sleep, S, T, rect } from './common.mjs';
import fs from 'fs';
const b = await launch(); const page = await newAdmin(b);
const step = async (name, fn) => { try { await fn(); } catch (e) { console.log('  [FAIL]', name, String(e).split('\n')[0]); } };
const CL = { x: 248, y: 0, width: 1352, height: 950 };
const H = { 'tab-dataset-types': 570, 'tab-stats': 690, 'tab-appearance': 830, 'tab-pages': 850, 'tab-legal': 270 };
const tab = async (hash, name, targets, { wait = 3500, clip = (H[name] ? { ...CL, height: H[name] } : CL), pre } = {}) => step(name, async () => {
  await goTab(page, '#' + hash, wait); if (pre) await pre();
  await shot(page, name, { clip, targets });
});
const card = (root, n) => `${root} .adm-card:nth-of-type(${n})`;

await tab('dataset-types', 'tab-dataset-types', [
  { sel: '#dataset-types-root .adm-page-head .adm-btn-ghost', n: 1, side: 'bottom' }, { sel: '#dataset-types-root .adm-page-head .adm-btn-accent', n: 2, side: 'bottom' },
  { sel: '.dtype-id', n: 3, side: 'right' }, { sel: '.dtype-count', n: 4, side: 'left' }, { sel: '.dtype-body .adm-field', n: 5, side: 'left', dx: -10 }, { sel: '.dtype-more', n: 6, side: 'left' } ]);
await tab('stats', 'tab-stats', [
  { sel: '#stats-root .adm-btn', n: 1, side: 'left' }, { sel: '.adm-stat-grid', n: 2, side: 'left', dx: -20 }, { sel: '.adm-spark', n: 3, side: 'top', nth: 0 }, { sel: '.adm-table-wrap', n: 4, side: 'left', dx: -20 } ]);
await tab('branding', 'tab-branding', [
  { sel: '#branding-root .adm-page-head .adm-btn-ghost', n: 1, side: 'bottom' }, { sel: '#branding-root .adm-page-head .adm-btn-accent', n: 2, side: 'bottom' },
  { sel: '#branding-root .adm-card', n: 3, side: 'left', nth: 0, dx: 30 }, { sel: '#branding-root .adm-card', n: 4, side: 'left', nth: 1, dx: 30 }, { sel: '#branding-root .adm-card', n: 5, side: 'left', nth: 2, dx: 30 },
  { sel: '.adm-loc-input', n: 6, side: 'right', nth: 0 } ]);
await step('branding-nav', async () => {
  await page.evaluate(() => { const c = document.querySelectorAll('#branding-root .adm-card'); c[3]?.scrollIntoView({ block: 'start' }); });
  await sleep(500);
  await shot(page, 'tab-branding-nav', { clip: CL, targets: [
    { sel: '#branding-root .adm-card', n: 1, side: 'left', nth: 3, dx: 30 }, { sel: '.adm-link-row', n: 2, side: 'left', nth: 0 }, { sel: '#branding-root .adm-card .adm-btn-ghost:has(.lucide-plus)', n: 3, side: 'right' },
    { sel: '#branding-root .adm-card', n: 4, side: 'left', nth: 4, dx: 30 }, { sel: '.adm-switch-row', n: 5, side: 'right', nth: 3, dx: -40 } ] });
});
await tab('appearance', 'tab-appearance', [
  { sel: '#appearance-root .adm-card', n: 1, side: 'left', nth: 0, dx: 30 }, { sel: '#appearance-root .adm-card', n: 2, side: 'left', nth: 1, dx: 30 }, { sel: '#appearance-root .adm-card', n: 3, side: 'left', nth: 2, dx: 30 },
  { sel: '#appearance-root .adm-card', n: 4, side: 'left', nth: 3, dx: 30 }, { sel: '#appearance-root .adm-page-head .adm-btn-accent', n: 5, side: 'bottom' }, { sel: '#appearance-root .adm-page-head .adm-btn-ghost', n: 6, side: 'bottom' } ]);
await tab('pages', 'tab-pages', [
  { sel: '#pages-root select', n: 1, side: 'right', nth: 0 }, { sel: '#pages-root .adm-btn:has(.lucide-plus)', n: 2, side: 'top' }, { sel: '#pages-root select', n: 3, side: 'right', nth: 1 },
  { sel: '#pages-root .adm-btn-accent', n: 4, side: 'right' }, { sel: '#pages-root .adm-btn:has(.lucide-trash-2)', n: 5, side: 'top' } ]);
await tab('legal', 'tab-legal', [
  { sel: '#legal-root select', n: 1, side: 'right' }, { sel: '#legal-root .adm-btn:has(.lucide-plus)', n: 2, side: 'right' }, { sel: '#legal-root .adm-page-head .adm-btn-accent', n: 3, side: 'bottom' }, { sel: '#legal-root .adm-page-head .adm-btn-ghost', n: 4, side: 'bottom' } ]);
await tab('plugins', 'tab-plugins', [
  { sel: '#plugins-root .adm-card', n: 1, side: 'left', nth: 0, dx: 30 }, { sel: '.adm-card-count', n: 2, side: 'left', nth: 0 }, { sel: '.adm-plugin-row', n: 3, side: 'left', nth: 0, dx: 30 },
  { sel: '.adm-plugin-name', n: 4, side: 'top', nth: 0 }, { sel: '.adm-plugin-toggle', n: 5, side: 'left', nth: 0 }, { sel: '.adm-revoke', n: 6, side: 'left', nth: 0 } ]);
await step('plugins-row', async () => {
  const rows = page.locator('.adm-plugin-row'); const n = await rows.count();
  let idx = 0; for (let i = 0; i < n; i++) if (await rows.nth(i).locator('.adm-revoke').count()) { idx = i; break; }
  await rows.nth(idx).scrollIntoViewIfNeeded(); await sleep(300);
  const bx = await rows.nth(idx).boundingBox();
  await shot(page, 'plugins-row', { clip: { x: bx.x - 4, y: bx.y - 4, width: bx.width + 8, height: bx.height + 8 }, targets: [
    { sel: '.adm-plugin-name', n: 1, side: 'top', nth: idx }, { sel: '.adm-tag', n: 2, side: 'bottom', nth: 0 }, { sel: '.adm-plugin-meta', n: 3, side: 'bottom', nth: idx }, { sel: '.adm-plugin-toggle', n: 4, side: 'left', nth: idx }, { sel: '.adm-revoke', n: 5, side: 'bottom', nth: 0 } ] });
});
await tab('marketplace', 'tab-marketplace', [
  { sel: '#marketplace-root .adm-badge-ok', n: 1, side: 'left' }, { sel: '#marketplace-root .adm-btn:has(.lucide-refresh-cw)', n: 2, side: 'left' }, { sel: '#marketplace-root .adm-card', n: 3, side: 'top', nth: 0 },
  { sel: '.mkt-caps', n: 4, side: 'bottom', nth: 0 }, { sel: '.mkt-uninstall', n: 5, side: 'top', nth: 0 } ]);
await tab('updates', 'tab-updates', [
  { sel: '#updates-root .adm-btn:has(.lucide-refresh-cw)', n: 1, side: 'left' }, { sel: '.adm-vchips', n: 2, side: 'left', dx: -10 }, { sel: '#update-body', n: 3, side: 'left', dx: -10 },
  { sel: '#plugin-updates-body', n: 4, side: 'left', dx: -10 }, { sel: '#pipeline-pack-body', n: 5, side: 'left', dx: -10 } ], { clip: { x: 248, y: 0, width: 1352, height: 720 } });
await tab('pipeline', 'tab-pipeline', [
  { sel: '.adm-flow', n: 1, side: 'bottom', dy: -14 }, { sel: '.adm-pl-ver', n: 2, side: 'left' }, { sel: '.adm-ed', n: 3, side: 'top', nth: 0 }, { sel: '.adm-ed', n: 4, side: 'top', nth: 1 }, { sel: '.adm-pl-dl', n: 5, side: 'top', nth: 0 } ]);
await step('pipeline-usage', async () => {
  await page.evaluate(() => document.querySelector('.adm-steps')?.scrollIntoView({ block: 'center' })); await sleep(500);
  await shot(page, 'tab-pipeline-usage', { clip: { ...CL, height: 920 }, targets: [ { sel: '.adm-steps', n: 1, side: 'left', dx: 30 }, { sel: '.adm-note', n: 2, side: 'left', dx: 30 } ] });
});
await tab('security', 'tab-security', [
  { sel: '#security-root .adm-card', n: 1, side: 'top', nth: 0 }, { sel: '#security-root .adm-card', n: 2, side: 'top', nth: 1 }, { sel: '#security-root .adm-card', n: 3, side: 'top', nth: 2 },
  { sel: '#security-root .adm-btn-accent', n: 4, side: 'bottom' } ], { clip: { x: 248, y: 0, width: 1352, height: 540 } });
await step('docs', async () => {
  await goTab(page, '#docs', 4500);
  await shot(page, 'tab-docs', { clip: { x: 248, y: 0, width: 1352, height: 420 }, targets: [
    { sel: '#docs-root .adm-page-head .adm-btn', n: 1, side: 'left' }, { sel: '#docs-root .adm-card', n: 2, side: 'left', nth: 0, dx: 30 }, { sel: '.docs-lang .adm-btn-accent', n: 3, side: 'bottom', nth: 0 },
    { sel: '.docs-view', n: 4, side: 'bottom', nth: 0 }, { sel: '.docs-hist', n: 5, side: 'bottom', nth: 0 } ] });
});

await b.close();
