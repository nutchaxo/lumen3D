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

import { API_ADMIN, t, escHtml, apiFetch, el, refreshIcons, Utils } from './shared.js';

let _report = null;
let _loading = false;

// Labels of the children of the "code" category. Anything not listed shows its own
// folder name, so a new top-level folder appears without a change here.
const CODE_LABELS = {
  'js/modules': ['Plugins', 'js/modules'],
  'js/vendor': ['Bibliothèques embarquées', 'js/vendor'],
  'js': ['Scripts', 'js'],
  'css': ['Feuilles de style', 'css'],
  'api': ['API serveur', 'api'],
  'lang': ['Traductions', 'lang'],
  'config': ['Configuration', 'config'],
  'changelog': ['Notes de version', 'changelog'],
  'DOCS': ['Documentation', 'DOCS'],
  'preprocess': ['Pipeline de prétraitement', 'preprocess'],
  'SCRIPTS': ['Scripts du pipeline', 'SCRIPTS'],
  'tools': ['Outils de build', 'tools'],
  'tests': ['Tests', 'tests'],
  'marketplace': ['Catalogue de plugins signé', 'marketplace'],
  'logs': ['Journaux du serveur', 'logs'],
  '.git': ['Historique Git', '.git'],
  '.venv-312': ['Environnement Python local', '.venv-312'],
  '__pycache__': ['Cache Python', '__pycache__'],
  'assets': ['Ressources graphiques', 'assets'],
  'dist': ['Paquets générés', 'dist'],
  'audits': ['Audits', 'audits'],
  '(racine)': ['Fichiers à la racine', null],
};

const UPLOAD_LABELS = {
  staging: ['Imports en cours', 'uploads/staging'],
  trash: ['Corbeille (60 jours)', 'uploads/trash'],
  migrations: ['Migrations de données', 'uploads/migrations'],
  state: ['Journaux d’import', 'uploads/state'],
  autres: ['Autres', null],
};

// Segment colours of the volume bar: theme-aware through the admin tokens.
const SEG = {
  data: 'var(--adm-accent)',
  uploads: 'var(--adm-warning)',
  code: 'color-mix(in srgb, var(--adm-accent) 45%, var(--adm-text-muted))',
  other: 'color-mix(in srgb, var(--adm-text-muted) 55%, transparent)',
  free: 'var(--adm-success)',
};

function units() { return t('admin.storageUnits', 'o|Ko|Mo|Go|To').split('|'); }

function fmtBytes(n) {
  n = Number(n) || 0;
  const u = units();
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  const digits = i === 0 || n >= 100 ? 0 : 1;
  return `${n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${u[i]}`;
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
  if (seconds < 60) return t('admin.storageAgeNow', 'à l’instant');
  const m = Math.round(seconds / 60);
  return t('admin.storageAgeMin', 'il y a {n} min').replace('{n}', m);
}

function fmtScanned(iso) {
  try {
    const loc = (typeof I18n !== 'undefined' && I18n?.getLanguage) ? I18n.getLanguage() : undefined;
    return new Date(iso).toLocaleString(loc, { dateStyle: 'short', timeStyle: 'short' });
  } catch { return iso || ''; }
}

function bar(segments, total) {
  const cells = segments.filter((s) => s.bytes > 0).map((s) =>
    `<span style="width:${pct(s.bytes, total).toFixed(3)}%;background:${s.color}" title="${escHtml(s.label)} — ${escHtml(fmtBytes(s.bytes))}"></span>`).join('');
  return `<div class="adm-storage-bar" role="img" aria-label="${escHtml(t('admin.storageBarAria', 'Répartition du volume'))}">${cells}</div>`;
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
  if (type === 'autres') return t('admin.storageOtherData', 'Autres fichiers');
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
    { label: t('admin.storageSegData', 'Données publiées'), bytes: data, color: SEG.data },
    { label: t('admin.storageSegUploads', 'Imports & corbeille'), bytes: uploads, color: SEG.uploads },
    { label: t('admin.storageSegCode', 'Plateforme & code'), bytes: code, color: SEG.code },
    { label: t('admin.storageSegOther', 'Autres sur le volume'), bytes: other, color: SEG.other },
    { label: t('admin.storageSegFree', 'Disponible'), bytes: free, color: SEG.free },
  ];
  const age = r.cached ? fmtAge(r.ageSeconds || 0) : t('admin.storageAgeNow', 'à l’instant');
  return `
    <div class="adm-card">
      <div class="adm-card-head">
        <i data-lucide="hard-drive"></i>
        <span>${escHtml(t('admin.storageVolume', 'Volume de la plateforme'))}</span>
        <span class="adm-card-count">${escHtml(t('admin.storageScanned', 'mesuré'))} ${escHtml(age)} · ${escHtml(fmtScanned(r.scannedAt))}</span>
      </div>
      <div class="adm-card-body">
        <div class="adm-stat-grid">
          <div class="adm-stat-card">
            <div class="adm-stat-top"><span class="adm-stat-label">${escHtml(t('admin.storageTotal', 'Capacité totale'))}</span></div>
            <div class="adm-stat-value">${escHtml(fmtBytes(total))}</div>
          </div>
          <div class="adm-stat-card">
            <div class="adm-stat-top"><span class="adm-stat-label">${escHtml(t('admin.storageUsed', 'Occupé'))}</span></div>
            <div class="adm-stat-value">${escHtml(fmtBytes(used))}</div>
            <div class="adm-stat-hint">${escHtml(fmtPct(used, total))} ${escHtml(t('admin.storageOfVolume', 'de la capacité'))}</div>
          </div>
          <div class="adm-stat-card">
            <div class="adm-stat-top"><span class="adm-stat-label">${escHtml(t('admin.storageFree', 'Disponible'))}</span></div>
            <div class="adm-stat-value">${escHtml(fmtBytes(free))}</div>
            <div class="adm-stat-hint">${escHtml(fmtPct(free, total))} ${escHtml(t('admin.storageOfVolume', 'de la capacité'))}</div>
          </div>
        </div>
        <div class="adm-storage-volume">
          ${bar(segs, total)}
          ${legend(segs, total)}
        </div>
        <p class="adm-storage-note adm-muted">${escHtml(t('admin.storageNote',
          'Le volume est celui qui héberge l’installation. S’il est partagé avec d’autres services, « Autres sur le volume » les regroupe, et « Disponible » reste l’espace libre réel du volume (un quota d’hébergeur plus strict n’y apparaît pas). Les fichiers liés en dur ne sont comptés qu’une fois.'))}</p>
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
    const count = isType ? `${dsCount(k.id)} ${t('admin.storageDatasets', 'jeu(x)')}` : null;
    return trackRow(label, k.bytes, total, count, isType ? SEG.data : SEG.other);
  }).join('');
  return `
    <div class="adm-card">
      <div class="adm-card-head"><i data-lucide="database"></i><span>${escHtml(t('admin.storageDataCard', 'Données publiées'))}</span>
        <span class="adm-card-count">${escHtml(fmtBytes(total))}</span></div>
      <div class="adm-card-body">${rows || `<p class="adm-muted">${escHtml(t('admin.storageEmpty', 'Aucune donnée.'))}</p>`}</div>
    </div>`;
}

function renderUploadsCard(r) {
  const up = (r.categories || []).find((c) => c.id === 'uploads');
  const total = up ? up.bytes : 0;
  const rows = (up ? up.children : []).map((k) => {
    const [label] = UPLOAD_LABELS[k.id] || [k.id, null];
    return trackRow(label, k.bytes, total, k.files, SEG.uploads);
  }).join('');
  return `
    <div class="adm-card">
      <div class="adm-card-head"><i data-lucide="upload-cloud"></i><span>${escHtml(t('admin.storageUploadsCard', 'Imports & corbeille'))}</span>
        <span class="adm-card-count">${escHtml(fmtBytes(total))}</span></div>
      <div class="adm-card-body">${rows || `<p class="adm-muted">${escHtml(t('admin.storageEmpty', 'Aucune donnée.'))}</p>`}</div>
    </div>`;
}

function renderCodeCard(r) {
  const code = (r.categories || []).find((c) => c.id === 'code');
  const total = code ? code.bytes : 0;
  const rows = (code ? code.children : []).map((k) => {
    const [label] = CODE_LABELS[k.id] || [k.id, null];
    return trackRow(label, k.bytes, total, k.files, SEG.code);
  }).join('');
  return `
    <div class="adm-card">
      <div class="adm-card-head"><i data-lucide="code"></i><span>${escHtml(t('admin.storageCodeCard', 'Plateforme & code'))}</span>
        <span class="adm-card-count">${escHtml(fmtBytes(total))}</span></div>
      <div class="adm-card-body">${rows || `<p class="adm-muted">${escHtml(t('admin.storageEmpty', 'Aucune donnée.'))}</p>`}</div>
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
        <td class="adm-td-num">${Number(d.files || 0).toLocaleString()}</td>
        <td><div class="adm-storage-track"><span style="width:${pct(d.bytes, max).toFixed(2)}%;background:${SEG.data}"></span></div></td>
        <td class="adm-storage-parts">${parts}</td>
      </tr>`;
  }).join('') : `<tr><td colspan="6" class="adm-muted">${escHtml(t('admin.storageNoDataset', 'Aucun dataset publié.'))}</td></tr>`;
  return `
    <div class="adm-card" style="margin-top:18px">
      <div class="adm-card-head"><i data-lucide="table"></i><span>${escHtml(t('admin.storageByDataset', 'Par dataset'))}</span>
        <span class="adm-card-count">${rows.length} ${escHtml(t('admin.storageDatasets', 'jeu(x)'))}</span></div>
      <div class="adm-table-wrap">
        <table class="adm-table">
          <thead><tr>
            <th>${escHtml(t('admin.colDataset', 'Dataset'))}</th>
            <th>${escHtml(t('admin.storageColType', 'Type'))}</th>
            <th class="adm-th-num">${escHtml(t('admin.storageColSize', 'Taille'))}</th>
            <th class="adm-th-num">${escHtml(t('admin.storageColFiles', 'Fichiers'))}</th>
            <th>${escHtml(t('admin.storageColShare', 'Part'))}</th>
            <th>${escHtml(t('admin.storageColParts', 'Détail par dossier'))}</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </div>`;
}

function render() {
  const root = el('storage-root');
  if (!root) return;
  if (!_report) {
    root.innerHTML = `<div class="adm-loading"><span class="spinner spinner-lg"></span>
      <p class="adm-muted">${escHtml(t('admin.storageMeasuring', 'Mesure du stockage…'))}</p></div>`;
    return;
  }
  root.innerHTML = `
    <div class="adm-storage-head">
      <div></div>
      <button class="adm-btn" id="storage-refresh" ${_loading ? 'disabled' : ''}>
        <i data-lucide="refresh-cw"></i> ${escHtml(t('admin.storageRefresh', 'Recalculer'))}
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
    if (data) _report = data;
  } finally {
    _loading = false;
    render();
  }
}

export const StorageTab = {
  id: 'storage',
  titleKey: 'admin.navStorage',
  titleDefault: 'Stockage',
  mounted: false,
  mount() { render(); load(); },
  activate() { load(); },
  relabel() { render(); },
};
