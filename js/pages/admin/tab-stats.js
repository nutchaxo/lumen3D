/**
 * Admin SPA — Statistics tab
 * ==========================
 * Visits / dataset views / downloads (global + per dataset), read from
 * /api/admin.php?action=stats. Charts are hand-rolled SVG sparklines — no chart
 * library is pulled in (only Three.js / Lucide / Fonts are allowed CDN deps).
 */

'use strict';

import { API_ADMIN, t, escHtml, apiFetch, el, refreshIcons } from './shared.js';

let _stats = null;
let _sortKey = 'total';
let _sortDir = -1;

const METRICS = [
  { key: 'visits',    icon: 'mouse-pointer-click', labelKey: 'admin.statVisits',    labelDef: 'Visites' },
  { key: 'views',     icon: 'eye',                 labelKey: 'admin.statViews',     labelDef: 'Vues dataset' },
  { key: 'downloads', icon: 'download',            labelKey: 'admin.statDownloads', labelDef: 'Téléchargements' },
];

function lastNDates(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return out;
}

function sparkline(values) {
  const W = 240, H = 48, n = values.length;
  const max = Math.max(1, ...values);
  if (n <= 1) return `<svg class="adm-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"></svg>`;
  const step = W / (n - 1);
  const pts = values.map((v, i) => [i * step, H - (v / max) * (H - 6) - 3]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${W},${H} L0,${H} Z`;
  return `<svg class="adm-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <path class="adm-spark-area" d="${area}"></path>
      <path class="adm-spark-line" d="${line}"></path>
    </svg>`;
}

function fmtDate(iso) {
  if (!iso) return t('admin.never', 'jamais');
  try {
    const loc = (typeof I18n !== 'undefined' && I18n?.getLanguage) ? I18n.getLanguage() : 'fr-FR';
    return new Date(iso).toLocaleDateString(loc, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return iso; }
}

function render() {
  const root = el('stats-root');
  if (!root) return;
  if (!_stats) { root.innerHTML = `<div class="adm-loading"><span class="spinner spinner-lg"></span></div>`; return; }

  const g = _stats.global || {};
  const dates = lastNDates(30);
  const daily = _stats.daily || {};

  const cards = METRICS.map((m) => {
    const series = dates.map((d) => Number(daily[d]?.[m.key] || 0));
    return `
      <div class="adm-stat-card">
        <div class="adm-stat-top">
          <span class="adm-stat-ic"><i data-lucide="${m.icon}"></i></span>
          <span class="adm-stat-label">${escHtml(t(m.labelKey, m.labelDef))}</span>
        </div>
        <div class="adm-stat-value">${Number(g[m.key] || 0).toLocaleString()}</div>
        ${sparkline(series)}
      </div>`;
  }).join('');

  const rows = (_stats.datasets || []).slice().sort((a, b) => {
    const va = _sortKey === 'total' ? (a.views + a.downloads) : (_sortKey === 'name' ? (a.name || '') : a[_sortKey]);
    const vb = _sortKey === 'total' ? (b.views + b.downloads) : (_sortKey === 'name' ? (b.name || '') : b[_sortKey]);
    if (va < vb) return -_sortDir; if (va > vb) return _sortDir; return 0;
  });

  const tableRows = rows.length ? rows.map((r) => `
      <tr>
        <td class="adm-td-name" title="${escHtml(r.id)}">${escHtml(r.name || r.id)}</td>
        <td class="adm-td-num">${Number(r.views || 0).toLocaleString()}</td>
        <td class="adm-td-num">${Number(r.downloads || 0).toLocaleString()}</td>
        <td class="adm-td-date">${escHtml(fmtDate(r.lastViewed))}</td>
      </tr>`).join('')
    : `<tr><td colspan="4" class="adm-td-empty">${escHtml(t('admin.statsEmpty', 'Aucune donnée d\'utilisation pour le moment.'))}</td></tr>`;

  const sortIc = (k) => _sortKey === k ? (_sortDir < 0 ? ' ▾' : ' ▴') : '';

  root.innerHTML = `
    <div class="adm-page-head">
      <div>
        <h2 class="adm-page-title">${escHtml(t('admin.statsTitle', 'Statistiques d\'utilisation'))}</h2>
        <p class="adm-page-sub">${escHtml(t('admin.statsSince', 'Depuis'))} ${escHtml(fmtDate(g.since))}</p>
      </div>
      <button class="adm-btn adm-btn-ghost adm-btn-sm" id="stats-refresh"><i data-lucide="refresh-cw"></i> ${escHtml(t('admin.refresh', 'Actualiser'))}</button>
    </div>

    <div class="adm-stat-grid">${cards}</div>
    <p class="adm-chart-cap">${escHtml(t('admin.last30days', '30 derniers jours'))}</p>

    <div class="adm-card" style="margin-top:18px">
      <div class="adm-card-head"><i data-lucide="table"></i><span>${escHtml(t('admin.statsByDataset', 'Par dataset'))}</span></div>
      <div class="adm-table-wrap">
        <table class="adm-table">
          <thead><tr>
            <th data-sort="name" class="adm-th-sort">${escHtml(t('admin.colDataset', 'Dataset'))}${sortIc('name')}</th>
            <th data-sort="views" class="adm-th-sort adm-th-num">${escHtml(t('admin.colViews', 'Vues'))}${sortIc('views')}</th>
            <th data-sort="downloads" class="adm-th-sort adm-th-num">${escHtml(t('admin.colDownloads', 'Téléch.'))}${sortIc('downloads')}</th>
            <th>${escHtml(t('admin.colLastViewed', 'Dernière vue'))}</th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </div>`;

  el('stats-refresh').addEventListener('click', load);
  root.querySelectorAll('.adm-th-sort').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (_sortKey === k) _sortDir = -_sortDir; else { _sortKey = k; _sortDir = k === 'name' ? 1 : -1; }
    render();
  }));
  refreshIcons(root);
}

async function load() {
  const data = await apiFetch(`${API_ADMIN}?action=stats`);
  if (data) _stats = data;
  render();
}

export const StatsTab = {
  id: 'stats',
  titleKey: 'admin.navStats',
  titleDefault: 'Statistiques',
  mounted: false,
  mount() { render(); load(); },
  activate() { load(); },
  relabel() { render(); },
};
