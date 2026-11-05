/**
 * Admin SPA — Storage tab (Stockage)
 * ==================================
 * Where the disk of the install goes: the capacity of the volume that holds the
 * platform, what is used and what is still free, and what the used part is made of
 * — published datasets per type and per dataset (by folder: bricks, planes, mips,
 * downloads…), the import staging and trash, and the code itself.
 *
 * Read from /api/admin.php?action=storage (dev_server.py `_admin_storage`, twin
 * api/_admin_lib.php `admin_storage_report`). The walk of the install is cached
 * server-side for ten minutes; the free space is read on every open.
 */

'use strict';

import { API_ADMIN, t, escHtml, apiFetch, el, refreshIcons, toast, Utils } from './shared.js';

let _report = null;
let _loading = false;
let _failed = false;

// Labels of the children of the "code" category: [translation key, English fallback].
// Anything not listed shows its own folder name, so a new top-level folder appears
// without a change here.
const CODE_LABELS = {
  'js/modules': ['storageCodeModules', 'Plugins'],
  'js/vendor': ['storageCodeVendor', 'Bundled libraries'],
  'js': ['storageCodeScripts', 'Scripts'],
  'css': ['storageCodeCss', 'Stylesheets'],
  'api': ['storageCodeApi', 'Server API'],
  'lang': ['storageCodeLang', 'Translations'],
  'config': ['storageCodeConfig', 'Configuration'],
  'changelog': ['storageCodeChangelog', 'Release notes'],
  'DOCS': ['storageCodeDocs', 'Documentation'],
  'preprocess': ['storageCodePreprocess', 'Preprocessing pipeline'],
  'SCRIPTS': ['storageCodeScriptsDir', 'Pipeline scripts'],
  'tools': ['storageCodeTools', 'Build tools'],
  'tests': ['storageCodeTests', 'Tests'],
  'marketplace': ['storageCodeMarketplace', 'Signed plugin catalog'],
  'logs': ['storageCodeLogs', 'Server logs'],
  '.git': ['storageCodeGit', 'Git history'],
  '.venv-312': ['storageCodeVenv', 'Local Python environment'],
  '__pycache__': ['storageCodePycache', 'Python cache'],
  'assets': ['storageCodeAssets', 'Graphic assets'],
  'dist': ['storageCodeDist', 'Generated packages'],
  'audits': ['storageCodeAudits', 'Audits'],
  '(racine)': ['storageCodeRoot', 'Files at the root'],
};

const UPLOAD_LABELS = {
  staging: ['storageUpStaging', 'Imports in progress'],
  trash: ['storageUpTrash', 'Trash (60 days)'],
  migrations: ['storageUpMigrations', 'Data migrations'],
  state: ['storageUpState', 'Import journals'],
  autres: ['storageUpOther', 'Other'],
};

function labelOf(table, id) {
  const entry = table[id];
  return entry ? t(`admin.${entry[0]}`, entry[1]) : id;
}

// Segment colours of the volume bar: theme-aware through the admin tokens.
const SEG = {
  data: 'var(--adm-accent)',
  uploads: 'var(--adm-warning)',
  code: 'color-mix(in srgb, var(--adm-accent) 45%, var(--adm-text-muted))',
  other: 'color-mix(in srgb, var(--adm-text-muted) 55%, transparent)',
  free: 'var(--adm-success)',
};

function units() { return t('admin.storageUnits', 'B|KB|MB|GB|TB').split('|'); }

// The page language, not the browser's: the labels around a number are in it.
function locale() {
  try { return (typeof I18n !== 'undefined' && I18n?.getLanguage) ? I18n.getLanguage() : undefined; } catch { return undefined; }
}

function fmtBytes(n) {
  n = Number(n) || 0;
  const u = units();
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  const digits = i === 0 || n >= 100 ? 0 : 1;
  return `${n.toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${u[i]}`;
}

function pct(part, total) {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.max(0, (part / total) * 100));
}

function fmtPct(part, total) {
  const p = pct(part, total);
  return `${p < 10 && p > 0 ? p.toFixed(1) : Math.round(p)} %`;
}

function fmtAge(seconds) {
  if (seconds < 60) return t('admin.storageAgeNow', 'just now');
  const m = Math.round(seconds / 60);
  return t('admin.storageAgeMin', '{n} min ago').replace('{n}', m);
}

function fmtScanned(iso) {
  try {
    return new Date(iso).toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' });
  } catch { return iso || ''; }
}

function bar(segments, total) {
  const cells = segments.filter((s) => s.bytes > 0).map((s) =>
    `<span style="width:${pct(s.bytes, total).toFixed(3)}%;background:${s.color}" title="${escHtml(s.label)} — ${escHtml(fmtBytes(s.bytes))}"></span>`).join('');
  return `<div class="adm-storage-bar" role="img" aria-label="${escHtml(t('admin.storageBarAria', 'Volume breakdown'))}">${cells}</div>`;
}

function legend(segments, total) {
  return `<div class="adm-storage-legend">${segments.map((s) => `
      <div class="adm-storage-leg">
        <span class="adm-storage-dot" style="background:${s.color}"></span>
        <span class="adm-storage-leg-label">${escHtml(s.label)}</span>
        <span class="adm-storage-leg-val">${escHtml(fmtBytes(s.bytes))} <span class="adm-muted">· ${escHtml(fmtPct(s.bytes, total))}</span></span>
      </div>`).join('')}</div>`;
}

function trackRow(label, bytes, total, count, color) {
  return `
    <div class="adm-storage-row">
      <span class="adm-storage-name">${escHtml(label)}</span>
      <span class="adm-storage-val">${escHtml(fmtBytes(bytes))}</span>
      <div class="adm-storage-track"><span style="width:${pct(bytes, total).toFixed(3)}%;background:${color}"></span></div>
      <span class="adm-storage-meta adm-muted">${count != null ? escHtml(String(count)) + ' · ' : ''}${escHtml(fmtPct(bytes, total))}</span>
    </div>`;
}

// The three dataset types, with a fallback for a page that loaded no utils.js.
const DATASET_TYPES = (Utils && Utils.DATASET_TYPES) || ['3d', '2d', 'live'];

function typeLabel(type) {
  if (type === 'autres') return t('admin.storageOtherData', 'Other files');
  return (Utils && Utils.datasetTypeLabel) ? Utils.datasetTypeLabel(type) : type;
}

function renderVolume(r) {
  const d = r.disk || {};
  const total = d.totalBytes || 0;
  const used = d.usedBytes || 0;
  const free = d.freeBytes || 0;
  const cat = (id) => (r.categories || []).find((c) => c.id === id) || { bytes: 0 };
  const data = cat('data').bytes, uploads = cat('uploads').bytes, code = cat('code').bytes;
  const other = r.otherBytes || 0;
  const segs = [
    { label: t('admin.storageSegData', 'Published data'), bytes: data, color: SEG.data },
    { label: t('admin.storageSegUploads', 'Imports & trash'), bytes: uploads, color: SEG.uploads },
    { label: t('admin.storageSegCode', 'Platform & code'), bytes: code, color: SEG.code },
    { label: t('admin.storageSegOther', 'Other on the volume'), bytes: other, color: SEG.other },
    { label: t('admin.storageSegFree', 'Available'), bytes: free, color: SEG.free },
  ];
  const age = r.cached ? fmtAge(r.ageSeconds || 0) : t('admin.storageAgeNow', 'just now');
  return `
    <div class="adm-card">
      <div class="adm-card-head">
        <i data-lucide="hard-drive"></i>
        <span>${escHtml(t('admin.storageVolume', 'Platform volume'))}</span>
        <span class="adm-card-count">${escHtml(t('admin.storageScanned', 'measured'))} ${escHtml(age)} · ${escHtml(fmtScanned(r.scannedAt))}</span>
      </div>
      <div class="adm-card-body">
        <div class="adm-stat-grid">
          <div class="adm-stat-card">
            <div class="adm-stat-top"><span class="adm-stat-label">${escHtml(t('admin.storageTotal', 'Total capacity'))}</span></div>
            <div class="adm-stat-value">${escHtml(fmtBytes(total))}</div>
          </div>
          <div class="adm-stat-card">
            <div class="adm-stat-top"><span class="adm-stat-label">${escHtml(t('admin.storageUsed', 'Used'))}</span></div>
            <div class="adm-stat-value">${escHtml(fmtBytes(used))}</div>
            <div class="adm-stat-hint">${escHtml(fmtPct(used, total))} ${escHtml(t('admin.storageOfVolume', 'of capacity'))}</div>
          </div>
          <div class="adm-stat-card">
            <div class="adm-stat-top"><span class="adm-stat-label">${escHtml(t('admin.storageFree', 'Available'))}</span></div>
            <div class="adm-stat-value">${escHtml(fmtBytes(free))}</div>
            <div class="adm-stat-hint">${escHtml(fmtPct(free, total))} ${escHtml(t('admin.storageOfVolume', 'of capacity'))}</div>
          </div>
        </div>
        <div class="adm-storage-volume">
          ${bar(segs, total)}
          ${legend(segs, total)}
        </div>
        <p class="adm-storage-note adm-muted">${escHtml(t('admin.storageNote',
          'The volume is the one hosting the installation. If it is shared with other services, "Other on the volume" groups them, and "Available" is the real free space of the volume (a stricter hosting quota does not show here). Hard-linked files are counted once.'))}</p>
      </div>
    </div>`;
}

function renderDataCard(r) {
  const data = (r.categories || []).find((c) => c.id === 'data');
  const total = data ? data.bytes : 0;
  const kids = data ? data.children : [];
  const dsCount = (type) => (r.datasets || []).filter((d) => d.type === type).length;
  const rows = kids.map((k) => {
    const isType = DATASET_TYPES.includes(k.id);
    const label = isType ? typeLabel(k.id) : typeLabel('autres');
    const count = isType ? `${dsCount(k.id)} ${t('admin.storageDatasets', 'dataset(s)')}` : null;
    return trackRow(label, k.bytes, total, count, isType ? SEG.data : SEG.other);
  }).join('');
  return `
    <div class="adm-card">
      <div class="adm-card-head"><i data-lucide="database"></i><span>${escHtml(t('admin.storageDataCard', 'Published data'))}</span>
        <span class="adm-card-count">${escHtml(fmtBytes(total))}</span></div>
      <div class="adm-card-body">${rows || `<p class="adm-muted">${escHtml(t('admin.storageEmpty', 'No data.'))}</p>`}</div>
    </div>`;
}

function renderUploadsCard(r) {
  const up = (r.categories || []).find((c) => c.id === 'uploads');
  const total = up ? up.bytes : 0;
  const rows = (up ? up.children : []).map((k) => {
    return trackRow(labelOf(UPLOAD_LABELS, k.id), k.bytes, total, k.files, SEG.uploads);
  }).join('');
  return `
    <div class="adm-card">
      <div class="adm-card-head"><i data-lucide="upload-cloud"></i><span>${escHtml(t('admin.storageUploadsCard', 'Imports & trash'))}</span>
        <span class="adm-card-count">${escHtml(fmtBytes(total))}</span></div>
      <div class="adm-card-body">${rows || `<p class="adm-muted">${escHtml(t('admin.storageEmpty', 'No data.'))}</p>`}</div>
    </div>`;
}

function renderCodeCard(r) {
  const code = (r.categories || []).find((c) => c.id === 'code');
  const total = code ? code.bytes : 0;
  const rows = (code ? code.children : []).map((k) => {
    return trackRow(labelOf(CODE_LABELS, k.id), k.bytes, total, k.files, SEG.code);
  }).join('');
  return `
    <div class="adm-card">
      <div class="adm-card-head"><i data-lucide="code"></i><span>${escHtml(t('admin.storageCodeCard', 'Platform & code'))}</span>
        <span class="adm-card-count">${escHtml(fmtBytes(total))}</span></div>
      <div class="adm-card-body">${rows || `<p class="adm-muted">${escHtml(t('admin.storageEmpty', 'No data.'))}</p>`}</div>
    </div>`;
}

function renderDatasets(r) {
  const rows = r.datasets || [];
  const max = rows.length ? rows[0].bytes : 0;
  const body = rows.length ? rows.map((d) => {
    const parts = (d.parts || []).slice(0, 4).map((p) =>
      `<span class="adm-storage-part">${escHtml(p.id)} <b>${escHtml(fmtBytes(p.bytes))}</b></span>`).join('');
    return `
      <tr>
        <td class="adm-td-name" title="${escHtml(d.id)}">${escHtml(d.name || d.id)}<div class="adm-storage-id adm-muted">${escHtml(d.id)}</div></td>
        <td><span class="badge badge-${escHtml(d.type)}">${escHtml(typeLabel(d.type))}</span></td>
        <td class="adm-td-num">${escHtml(fmtBytes(d.bytes))}</td>
        <td class="adm-td-num">${Number(d.files || 0).toLocaleString(locale())}</td>
        <td><div class="adm-storage-track"><span style="width:${pct(d.bytes, max).toFixed(2)}%;background:${SEG.data}"></span></div></td>
        <td class="adm-storage-parts">${parts}</td>
      </tr>`;
  }).join('') : `<tr><td colspan="6" class="adm-muted">${escHtml(t('admin.storageNoDataset', 'No published dataset.'))}</td></tr>`;
  return `
    <div class="adm-card" style="margin-top:18px">
      <div class="adm-card-head"><i data-lucide="table"></i><span>${escHtml(t('admin.storageByDataset', 'By dataset'))}</span>
        <span class="adm-card-count">${rows.length} ${escHtml(t('admin.storageDatasets', 'dataset(s)'))}</span></div>
      <div class="adm-table-wrap">
        <table class="adm-table">
          <thead><tr>
            <th>${escHtml(t('admin.colDataset', 'Dataset'))}</th>
            <th>${escHtml(t('admin.storageColType', 'Type'))}</th>
            <th class="adm-th-num">${escHtml(t('admin.storageColSize', 'Size'))}</th>
            <th class="adm-th-num">${escHtml(t('admin.storageColFiles', 'Files'))}</th>
            <th>${escHtml(t('admin.storageColShare', 'Share'))}</th>
            <th>${escHtml(t('admin.storageColParts', 'Breakdown by folder'))}</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </div>`;
}

function render() {
  const root = el('storage-root');
  if (!root) return;
  if (!_report && _failed && !_loading) {
    root.innerHTML = `<div class="adm-loading" role="alert">
      <p class="adm-muted">${escHtml(t('admin.storageLoadFailed', 'Could not measure the storage.'))}</p>
      <button class="adm-btn" id="storage-retry"><i data-lucide="refresh-cw"></i> ${escHtml(t('admin.storageRetry', 'Retry'))}</button></div>`;
    el('storage-retry')?.addEventListener('click', () => load(true));
    refreshIcons(root);
    return;
  }
  if (!_report) {
    root.innerHTML = `<div class="adm-loading"><span class="spinner spinner-lg"></span>
      <p class="adm-muted">${escHtml(t('admin.storageMeasuring', 'Measuring storage…'))}</p></div>`;
    return;
  }
  root.innerHTML = `
    <div class="adm-storage-head">
      <div></div>
      <button class="adm-btn" id="storage-refresh" ${_loading ? 'disabled' : ''}>
        <i data-lucide="refresh-cw"></i> ${escHtml(t('admin.storageRefresh', 'Recompute'))}
      </button>
    </div>
    ${renderVolume(_report)}
    <div class="adm-storage-grid" style="margin-top:18px">
      ${renderDataCard(_report)}
      ${renderUploadsCard(_report)}
      ${renderCodeCard(_report)}
    </div>
    ${renderDatasets(_report)}`;
  el('storage-refresh')?.addEventListener('click', () => load(true));
  refreshIcons(root);
}

async function load(refresh = false) {
  if (_loading) return;
  _loading = true;
  render();
  try {
    const data = await apiFetch(`${API_ADMIN}?action=storage${refresh ? '&refresh=1' : ''}`);
    if (data && typeof data === 'object' && !data.error) { _report = data; _failed = false; }
    else {
      _failed = true;
      // A report already on screen is kept: only say the refresh did not happen.
      if (_report) toast(t('admin.storageLoadFailed', 'Could not measure the storage.'), 'error');
    }
  } finally {
    _loading = false;
    render();
  }
}

export const StorageTab = {
  id: 'storage',
  titleKey: 'admin.navStorage',
  titleDefault: 'Storage',
  mounted: false,
  mount() { render(); load(); },
  activate() { load(); },
  relabel() { render(); },
};
