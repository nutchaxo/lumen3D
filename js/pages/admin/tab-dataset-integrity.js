/**
 * Admin SPA — Data integrity tab
 * ==============================
 * A check-up of every dataset: nothing missing, nothing extra, latest format, and for
 * an import still in progress the same validation the publish step runs. Read-only.
 *
 * Reads /api/integrity.php (dev_server.py `_handle_integrity` → dataset_integrity.py,
 * twin api/integrity.php → api/_integrity_lib.php): `list` gives every dataset (published
 * and staged), then `check` runs once per dataset so a slow tree never blocks the others
 * and the table fills as results arrive.
 */

'use strict';

import { t, escHtml, apiFetch, el, refreshIcons, Utils } from './shared.js';

const API_INTEGRITY = 'api/integrity.php';
const PARALLEL = 2;

const LEVEL_ICON = { ok: 'check-circle-2', warn: 'alert-triangle', error: 'x-circle', pending: 'loader', info: 'info' };

let _rows = [];            // [{ id, type, folder, staged, result|null }]
let _latest = null;
let _running = false;
let _done = 0;
let _runToken = 0;
let _filter = 'all';       // 'all' | 'problems'

const typeLabel = (type) => (Utils && Utils.datasetTypeLabel) ? Utils.datasetTypeLabel(type) : type;
const dsParam = (row) => (row.staged ? 'staging:' : '') + row.id;

function findingText(f) {
  const base = t(`dint.code.${f.code}`, f.code);
  return f.detail ? `${base} — ${f.detail}` : base;
}

// "How to fix" for a code; a family of codes (metadata_*, manifest_*, index_*) shares one hint.
function fixText(code) {
  const family = code.startsWith('metadata_') ? 'metadata_' : code.startsWith('manifest_') ? 'manifest_' : code.startsWith('index_') ? 'index_' : null;
  const exact = t(`dint.fix.${code}`, '');
  if (exact) return exact;
  return family ? t(`dint.fix.${family}`, '') : '';
}

function fmtBytes(n) {
  n = Number(n) || 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 || n >= 100 ? 0 : 1)} ${u[i]}`;
}

function statusOf(row) { return row.result ? row.result.status : 'pending'; }

function counts() {
  const c = { ok: 0, warn: 0, error: 0, pending: 0 };
  for (const r of _rows) c[statusOf(r)]++;
  return c;
}

function renderFindings(result) {
  const list = result.findings || [];
  if (!list.length) return `<p class="adm-muted">${escHtml(t('dint.allGood', 'Nothing to report.'))}</p>`;
  return `<ul class="adm-int-findings">${list.map((f) => {
    const files = (f.files || []).map((x) => `<code>${escHtml(x)}</code>`).join(' ');
    const size = f.bytes ? ` <span class="adm-muted">(${escHtml(fmtBytes(f.bytes))})</span>` : '';
    return `<li class="adm-int-f adm-int-${escHtml(f.level)}">
      <i data-lucide="${LEVEL_ICON[f.level] || 'info'}"></i>
      <div><div>${escHtml(findingText(f))}${size}</div>${files ? `<div class="adm-int-files">${files}</div>` : ''}${fixText(f.code) ? `<div class="adm-int-fix">${escHtml(t('dint.howToFix', 'To fix:'))} ${escHtml(fixText(f.code))}</div>` : ''}</div>
    </li>`;
  }).join('')}</ul>`;
}

function renderRow(row) {
  const st = statusOf(row);
  const res = row.result;
  const name = res?.name || row.folder;
  const fmt = res?.format;
  const n = res ? res.findings.filter((f) => f.level !== 'info').length : 0;
  const summary = st === 'pending'
    ? t('dint.checking', 'Checking…')
    : st === 'ok' ? t('dint.statusOk', 'OK')
      : `${n} ${t('dint.findings', 'finding(s)')}`;
  const formatCell = fmt
    ? `v${escHtml(fmt.version ?? '?')}${fmt.schema ? ` <span class="adm-muted">${escHtml(fmt.schema)}</span>` : ''}`
    : '<span class="adm-muted">—</span>';
  const stagedBadge = row.staged ? ` <span class="adm-int-staged">${escHtml(t('dint.staged', 'import'))}</span>` : '';
  return `
    <tr class="adm-int-row">
      <td><span class="adm-int-pill adm-int-${st}"><i data-lucide="${LEVEL_ICON[st]}"></i>${escHtml(summary)}</span></td>
      <td class="adm-td-name" title="${escHtml(row.id)}">${escHtml(name)}${stagedBadge}<div class="adm-storage-id adm-muted">${escHtml(row.id)}</div></td>
      <td><span class="badge badge-${escHtml(row.type)}">${escHtml(typeLabel(row.type))}</span></td>
      <td>${formatCell}</td>
      <td>${res && res.findings.length
        ? `<details><summary>${escHtml(t('dint.details', 'Details'))}</summary>${renderFindings(res)}</details>`
        : ''}</td>
      <td>${['warn', 'error'].includes(st)
        ? `<button class="adm-btn" data-int-recheck="${escHtml(dsParam(row))}" ${_running || row.busy ? 'disabled' : ''}><i data-lucide="refresh-cw"></i> ${escHtml(t('dint.recheck', 'Recheck'))}</button>`
        : row.busy ? `<span class="adm-muted">${escHtml(t('dint.checking', 'Checking…'))}</span>` : ''}</td>
    </tr>`;
}

function render() {
  const root = el('dataset-integrity-root');
  if (!root) return;
  const c = counts();
  const shown = _rows.filter((r) => _filter === 'all' || ['warn', 'error'].includes(statusOf(r)));
  const progress = _running && _rows.length
    ? `<span class="adm-muted">${_done} / ${_rows.length}</span>` : '';
  const stat = (label, value, cls) => `
    <div class="adm-stat-card"><div class="adm-stat-top"><span class="adm-stat-label">${escHtml(label)}</span></div>
    <div class="adm-stat-value adm-int-${cls}">${value}</div></div>`;

  root.innerHTML = `
    <div class="adm-card">
      <div class="adm-card-head"><i data-lucide="shield-check"></i><span>${escHtml(t('dint.title', 'Data integrity'))}</span>
        <span class="adm-card-count">${progress}</span></div>
      <div class="adm-card-body">
        <p class="adm-muted">${escHtml(t('dint.intro',
          'Checks every dataset, published or still importing: nothing missing (metadata, thumbnail, manifest, index, every pack), nothing extra (stray files, interrupted swaps, unlisted gallery images), and the latest data format. Read-only: nothing is modified.'))}</p>
        <div class="adm-int-toolbar">
          <button class="adm-btn" id="int-run" ${_running ? 'disabled' : ''}>
            <i data-lucide="${_rows.length ? 'refresh-cw' : 'play'}"></i>
            ${escHtml(_running ? t('dint.running', 'Checking…') : _rows.length ? t('dint.rerun', 'Run again') : t('dint.run', 'Run the check-up'))}
          </button>
          <label class="adm-int-filter"><input type="checkbox" id="int-problems" ${_filter === 'problems' ? 'checked' : ''}>
            ${escHtml(t('dint.onlyProblems', 'Only datasets with findings'))}</label>
        </div>
        ${_rows.length ? `<div class="adm-stat-grid">
          ${stat(t('dint.sumOk', 'Healthy'), c.ok, 'ok')}
          ${stat(t('dint.sumWarn', 'Warnings'), c.warn, 'warn')}
          ${stat(t('dint.sumError', 'Errors'), c.error, 'error')}
          ${_latest != null ? stat(t('dint.latest', 'Latest format'), `v${_latest}`, 'info') : ''}
        </div>` : ''}
      </div>
    </div>
    ${_rows.length ? `
    <div class="adm-card" style="margin-top:18px">
      <div class="adm-table-wrap">
        <table class="adm-table">
          <thead><tr>
            <th>${escHtml(t('dint.colStatus', 'Status'))}</th>
            <th>${escHtml(t('admin.colDataset', 'Dataset'))}</th>
            <th>${escHtml(t('dint.colType', 'Type'))}</th>
            <th>${escHtml(t('dint.colFormat', 'Format'))}</th>
            <th>${escHtml(t('dint.colFindings', 'Findings'))}</th>
            <th></th>
          </tr></thead>
          <tbody>${shown.map(renderRow).join('') || `<tr><td colspan="6" class="adm-muted">${escHtml(t('dint.nothingShown', 'No dataset to show.'))}</td></tr>`}</tbody>
        </table>
      </div>
    </div>` : ''}`;

  el('int-run')?.addEventListener('click', run);
  root.querySelectorAll('[data-int-recheck]').forEach((b) => b.addEventListener('click', () => recheck(b.getAttribute('data-int-recheck'))));
  el('int-problems')?.addEventListener('change', (e) => { _filter = e.target.checked ? 'problems' : 'all'; render(); });
  refreshIcons(root);
}

/** One dataset's verdict; a failed request keeps what the server said (status + start of the body). */
async function fetchCheck(row) {
  const failed = (detail) => ({
    id: row.id, name: row.folder, staged: row.staged, status: 'error',
    findings: [{ level: 'error', code: 'check_failed', detail }],
  });
  try {
    const res = await fetch(`${API_INTEGRITY}?action=check&dataset=${encodeURIComponent(dsParam(row))}`, { credentials: 'same-origin' });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    if (data && data.result) return data.result;
    if (res.status === 401) return failed('HTTP 401: session expired, sign in again');
    const body = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    return failed(`HTTP ${res.status}${body ? ': ' + body : ' with an empty answer (a gateway or PHP timeout, or PHP ran out of memory)'}`);
  } catch (err) {
    return failed(`network error: ${err && err.message ? err.message : err}`);
  }
}

/** Re-run the check of ONE dataset, in place; the rest of the table is left as it is. */
async function recheck(param) {
  const row = _rows.find((r) => dsParam(r) === param);
  if (!row || row.busy || _running) return;
  row.busy = true;
  render();
  try {
    row.result = await fetchCheck(row);
  } finally {
    row.busy = false;
    render();
  }
}

async function run() {
  if (_running) return;
  const token = ++_runToken;
  _running = true;
  _done = 0;
  _rows = [];
  render();
  try {
    const list = await apiFetch(`${API_INTEGRITY}?action=list`);
    if (!list || !Array.isArray(list.datasets)) throw new Error('list');
    _latest = list.latest ?? null;
    _rows = list.datasets.map((d) => ({ ...d, result: null }));
    render();
    let next = 0;
    const worker = async () => {
      while (token === _runToken && next < _rows.length) {
        const row = _rows[next++];
        const r = await fetchCheck(row);
        row.result = r;
        _done++;
        if (token === _runToken) render();
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
  } catch {
    _rows = [];
  } finally {
    if (token === _runToken) { _running = false; render(); }
  }
}

export const DatasetIntegrityTab = {
  id: 'dataset-integrity',
  titleKey: 'dint.nav',
  titleDefault: 'Data integrity',
  mounted: false,
  mount() { render(); },
  activate() { render(); },
  relabel() { render(); },
};
