/**
 * Admin SPA — floating import dock
 * ================================
 * A transfer that takes hours must be watchable from anywhere in the panel
 * without getting in the way of anything. The dock is therefore an OVERLAY, not
 * a layout participant: `position: fixed`, its own stacking context, and it
 * reserves no space — opening or closing it never reflows the tab underneath, so
 * a form the operator is filling in does not jump.
 *
 * Three sizes, one gesture apart:
 *   panel   the full list — per-dataset progress, state, publish/discard
 *   bar     one line — global percentage, speed, ETA (the default while working)
 *   bubble  a progress ring in the corner, like a support widget; click to grow
 *
 * The chosen size is remembered in localStorage, so an operator who prefers the
 * bubble is not handed a panel again on the next import. The dock mounts once at
 * shell boot and simply hides itself whenever there is nothing to report.
 */

'use strict';

import { t, escHtml, refreshIcons, toast } from './shared.js';
import { navigateTo } from './bus.js';
import { openDataset } from './tab-datasets.js';
import * as Upload from './upload-manager.js';

const SIZE_KEY = 'adm-upload-dock-size';
const SIZES = ['bubble', 'bar', 'panel'];

let _root = null;
let _size = 'bar';
let _unsub = null;
let _bound = false;
let _structureSig = '';

function loadSize() {
  const v = localStorage.getItem(SIZE_KEY);
  return SIZES.includes(v) ? v : 'bar';
}

function setSize(size) {
  _size = SIZES.includes(size) ? size : 'bar';
  localStorage.setItem(SIZE_KEY, _size);
  if (_root) _root.dataset.size = _size;
  _structureSig = '';        // a different size is a different DOM
  render();
}

export function mount() {
  _root = document.getElementById('upload-dock');
  if (!_root) return;
  _size = loadSize();
  _root.dataset.size = _size;

  // mount() runs from enterApp(), which runs again after a logout/login round
  // trip. Binding unconditionally would stack a second click handler, and every
  // subsequent collapse would toggle the size twice and appear to do nothing.
  if (!_bound) { _root.addEventListener('click', onClick); _bound = true; }
  if (_unsub) _unsub();
  _unsub = Upload.subscribe(render);
  _structureSig = '';
  // Imports from an earlier session are still staged server-side; surfacing them
  // straight away is what turns "my upload died" into "click resume".
  Upload.refreshStaged();
  render();
}

/** Hide the dock while a gate (login / first-run setup) owns the screen — it is
 *  a fixed overlay and would otherwise float over the login card if a session
 *  expired mid-transfer. */
export function setGateActive(active) {
  if (_root) _root.classList.toggle('is-gated', !!active);
}

function onClick(e) {
  const btn = e.target.closest('[data-dock-action]');
  if (!btn) return;
  const action = btn.dataset.dockAction;
  const key = btn.dataset.key || null;

  if (action === 'expand') { setSize(_size === 'bubble' ? 'bar' : 'panel'); return; }
  if (action === 'shrink') { setSize(_size === 'panel' ? 'bar' : 'bubble'); return; }
  if (action === 'pause') { Upload.pause(); return; }
  if (action === 'resume') { Upload.resume(); return; }
  if (action === 'goto') { navigateTo('upload'); setSize('panel'); return; }
  if (action === 'edit' && key) { openInEditor(key); return; }
  if (action === 'publish' && key) { doPublish(key); return; }
  if (action === 'discard' && key) { doDiscard(key); return; }
  if (action === 'dismiss') { Upload.cancelAll(); return; }
}

/** Jump to the Datasets tab AND open this dataset — landing on the list with
 *  nothing selected made the operator hunt for the row they just clicked. */
function openInEditor(key) {
  navigateTo('datasets');
  openDataset(`staging:${key}`);
}

async function doPublish(key) {
  const r = await Upload.publish(key);
  if (r.ok && r.data?.ok) {
    toast(t('upl.published', 'Dataset publié ✓ (masqué de l\'explorer — activez-le dans l\'onglet Datasets)'));
  } else if (r.data?.error === 'already_exists') {
    toast(t('upl.errExists', 'Un dataset publié porte déjà ce nom. Utilisez « Remplacer » depuis l\'onglet Import.'), 'error');
  } else {
    toast(t('upl.errPublish', 'Publication refusée : {reason}', { reason: (r.data?.errors || [r.data?.error]).join(', ') }), 'error');
  }
}

async function doDiscard(key) {
  if (!confirm(t('upl.confirmDiscard', 'Supprimer définitivement les fichiers déjà envoyés pour ce dataset ?'))) return;
  await Upload.discard(key);
  toast(t('upl.discarded', 'Import supprimé.'));
}

// ── Render ─────────────────────────────────────────────────────────────────────

// Same reasoning as the Import tab: the manager emits ~6 times a second for the
// whole transfer. A full innerHTML rebuild at that rate re-creates every lucide
// SVG and wipes hover/focus continuously. Rebuild only on a STRUCTURAL change;
// write the moving numbers into the existing nodes otherwise.

function structureSig(s, staged) {
  return [
    _size,
    Upload.isBusy() ? 'busy' : Upload.isPaused() ? 'paused' : s.phase,
    // doneCount is patched, not signed — see the Import tab for why.
    s.datasets.map((d) => `${d.key}:${d.state}:${d.fileCount}:${d.error || ''}`).join(','),
    staged.map((d) => `${d.key}:${d.state}`).join(','),
    s.error || '',
  ].join('|');
}

function render() {
  if (!_root) return;
  const s = Upload.getState();
  const live = s.datasets.length > 0;
  const staged = (s.staged || []).filter((d) => !s.datasets.some((x) => x.key === d.key));
  const anything = live || staged.length > 0;

  _root.hidden = !anything;
  if (!anything) { _structureSig = ''; return; }

  const pct = s.totalBytes > 0 ? Math.min(100, (s.sentBytes / s.totalBytes) * 100) : (live ? 0 : 100);
  const working = Upload.isBusy();
  const paused = Upload.isPaused();

  const sig = structureSig(s, staged);
  if (sig === _structureSig && _root.firstChild) { patch(s, pct, working); return; }
  _structureSig = sig;

  _root.innerHTML = _size === 'bubble'
    ? renderBubble(pct, working, paused)
    : _size === 'bar'
      ? renderBar(s, pct, working, paused)
      : renderPanel(s, pct, working, paused, staged);
  refreshIcons(_root);
  patch(s, pct, working);
}

const RING_R = 22;
const RING_C = 2 * Math.PI * RING_R;

function patch(s, pct, working) {
  const set = (sel, value, root = _root) => {
    const node = root.querySelector(sel);
    if (node && node.textContent !== value) node.textContent = value;
  };

  const ring = _root.querySelector('.dock-ring-fg');
  if (ring) ring.setAttribute('stroke-dashoffset', (RING_C * (1 - pct / 100)).toFixed(1));
  const bubblePct = _root.querySelector('.dock-bubble-pct');
  if (bubblePct) bubblePct.firstChild.nodeValue = String(Math.round(pct));

  set('[data-dock-pct]', `${Math.round(pct)} %`);
  set('[data-dock-sub]', subLine(s, working));
  const fill = _root.querySelector('.dock-global [data-dock-fill], .dock-bar [data-dock-fill]');
  if (fill) fill.style.width = `${pct.toFixed(1)}%`;

  s.datasets.forEach((d) => {
    const row = _root.querySelector(`.dock-row[data-key="${cssEscape(d.key)}"]`);
    if (!row) return;
    const dpct = d.totalBytes > 0 ? Math.min(100, (d.receivedBytes / d.totalBytes) * 100) : 0;
    const rf = row.querySelector('[data-dock-fill]');
    if (rf) rf.style.width = `${dpct.toFixed(1)}%`;
    set('[data-dock-bytes]', `${Upload.formatBytes(d.receivedBytes)} / ${Upload.formatBytes(d.totalBytes)}`, row);
    set('[data-dock-files]', `${d.doneCount}/${d.fileCount} ${t('upl.files', 'fichiers')}`, row);
  });
}

function subLine(s, working) {
  const base = `${Upload.formatBytes(s.sentBytes)} / ${Upload.formatBytes(s.totalBytes)}`;
  if (!working) return base;
  return `${base} · ${Upload.formatSpeed(s.speed)} · ${t('upl.eta', 'reste {d}', { d: Upload.formatDuration(s.etaS) })}`;
}

function cssEscape(value) {
  if (window.CSS && typeof CSS.escape === 'function') return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

/** Progress ring — an SVG circle whose dash offset encodes the percentage. */
function renderBubble(pct, working, paused) {
  const off = RING_C * (1 - pct / 100);
  return `
    <button type="button" class="dock-bubble" data-dock-action="expand"
            title="${escHtml(t('upl.dockShow', 'Afficher le transfert'))}"
            aria-label="${escHtml(t('upl.dockShow', 'Afficher le transfert'))}">
      <svg viewBox="0 0 56 56" class="dock-ring" aria-hidden="true">
        <circle cx="28" cy="28" r="${RING_R}" class="dock-ring-bg"></circle>
        <circle cx="28" cy="28" r="${RING_R}" class="dock-ring-fg"
                stroke-dasharray="${RING_C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"></circle>
      </svg>
      <span class="dock-bubble-pct">${Math.round(pct)}<i>%</i></span>
      ${working ? '<span class="dock-pulse" aria-hidden="true"></span>' : ''}
      ${paused ? '<span class="dock-bubble-badge"><i data-lucide="pause"></i></span>' : ''}
    </button>`;
}

function renderBar(s, pct, working, paused) {
  return `
    <div class="dock-bar">
      <button type="button" class="dock-icon-btn" data-dock-action="shrink"
              title="${escHtml(t('upl.dockHide', 'Réduire'))}" aria-label="${escHtml(t('upl.dockHide', 'Réduire'))}">
        <i data-lucide="chevron-down"></i>
      </button>
      <div class="dock-bar-main">
        <div class="dock-bar-top">
          <span class="dock-bar-title">${escHtml(statusLabel(s, working, paused))}</span>
          <span class="dock-bar-pct" data-dock-pct>${Math.round(pct)} %</span>
        </div>
        <div class="dock-progress"><div class="dock-progress-fill" data-dock-fill style="width:${pct.toFixed(1)}%"></div></div>
        <div class="dock-bar-sub" data-dock-sub>${escHtml(subLine(s, working))}</div>
      </div>
      <div class="dock-bar-actions">
        ${working ? actionBtn('pause', 'pause', t('upl.pause', 'Pause')) : ''}
        ${paused ? actionBtn('resume', 'play', t('upl.resume', 'Reprendre')) : ''}
        ${actionBtn('expand', 'list', t('upl.details', 'Détails'))}
      </div>
    </div>`;
}

function renderPanel(s, pct, working, paused, staged) {
  const rows = s.datasets.map(datasetRow).join('')
             + staged.map((d) => datasetRow(serverRow(d))).join('');
  return `
    <div class="dock-panel">
      <header class="dock-head">
        <span class="dock-head-title"><i data-lucide="upload-cloud"></i> ${escHtml(t('upl.dockTitle', 'Import de datasets'))}</span>
        <div class="dock-head-actions">
          ${working ? actionBtn('pause', 'pause', t('upl.pause', 'Pause')) : ''}
          ${paused ? actionBtn('resume', 'play', t('upl.resume', 'Reprendre')) : ''}
          ${actionBtn('goto', 'external-link', t('upl.openTab', 'Ouvrir l\'onglet Import'))}
          ${actionBtn('shrink', 'minus', t('upl.dockHide', 'Réduire'))}
        </div>
      </header>
      <div class="dock-global">
        <div class="dock-bar-top">
          <span class="dock-bar-title">${escHtml(statusLabel(s, working, paused))}</span>
          <span class="dock-bar-pct" data-dock-pct>${Math.round(pct)} %</span>
        </div>
        <div class="dock-progress"><div class="dock-progress-fill" data-dock-fill style="width:${pct.toFixed(1)}%"></div></div>
        <div class="dock-bar-sub" data-dock-sub>${escHtml(subLine(s, working))}</div>
      </div>
      ${s.error ? `<div class="dock-error"><i data-lucide="alert-triangle"></i> ${escHtml(s.error)}</div>` : ''}
      <ul class="dock-list">${rows}</ul>
    </div>`;
}

function serverRow(d) {
  return {
    key: d.key, type: d.type, folder: d.folder, name: d.name,
    state: d.state, totalBytes: d.totalBytes, receivedBytes: d.receivedBytes,
    fileCount: d.fileCount, doneCount: d.doneCount, error: null,
    fromServer: true, expiresInS: d.expiresInS,
  };
}

function datasetRow(d) {
  const pct = d.totalBytes > 0 ? Math.min(100, (d.receivedBytes / d.totalBytes) * 100) : 0;
  const info = stateInfo(d.state);
  const canEdit = d.state === Upload.DS_EDITABLE || d.state === Upload.DS_STAGED;
  const canPublish = d.state === Upload.DS_STAGED;
  return `
    <li class="dock-row${d.error ? ' has-error' : ''}" data-key="${escHtml(d.key)}">
      <div class="dock-row-head">
        <span class="dock-row-name" title="${escHtml(d.key)}">${escHtml(d.name || d.folder)}</span>
        <span class="dock-state dock-state-${info.cls}">${escHtml(info.label)}</span>
      </div>
      <div class="dock-progress dock-progress-sm"><div class="dock-progress-fill" data-dock-fill style="width:${pct.toFixed(1)}%"></div></div>
      <div class="dock-row-sub">
        <span data-dock-bytes>${escHtml(Upload.formatBytes(d.receivedBytes))} / ${escHtml(Upload.formatBytes(d.totalBytes))}</span>
        · <span data-dock-files>${d.doneCount}/${d.fileCount} ${escHtml(t('upl.files', 'fichiers'))}</span>
        ${d.state === Upload.DS_STALLED && d.expiresInS != null
          ? ` · <span class="dock-expiry">${escHtml(t('upl.expires', 'purge dans {d}', { d: Upload.formatDuration(d.expiresInS) }))}</span>` : ''}
      </div>
      ${d.error ? `<div class="dock-row-err">${escHtml(d.error)}</div>` : ''}
      <div class="dock-row-actions">
        ${canEdit ? actionBtn('edit', 'pencil', t('upl.edit', 'Éditer'), d.key, 'dock-mini') : ''}
        ${canPublish ? actionBtn('publish', 'check-circle', t('upl.publish', 'Publier'), d.key, 'dock-mini dock-mini-accent') : ''}
        ${d.state !== 'published' ? actionBtn('discard', 'trash-2', t('upl.discard', 'Supprimer'), d.key, 'dock-mini dock-mini-danger') : ''}
      </div>
    </li>`;
}

function actionBtn(action, icon, label, key, cls) {
  return `<button type="button" class="${cls || 'dock-icon-btn'}" data-dock-action="${action}"
          ${key ? `data-key="${escHtml(key)}"` : ''} title="${escHtml(label)}" aria-label="${escHtml(label)}">
          <i data-lucide="${icon}"></i>${cls && cls.startsWith('dock-mini') ? `<span>${escHtml(label)}</span>` : ''}</button>`;
}

function stateInfo(state) {
  switch (state) {
    case Upload.DS_UPLOADING: return { cls: 'uploading', label: t('upl.stUploading', 'Envoi — non éditable') };
    case Upload.DS_EDITABLE:  return { cls: 'editable',  label: t('upl.stEditable', 'Envoi — éditable') };
    case Upload.DS_STAGED:    return { cls: 'staged',    label: t('upl.stStaged', 'Envoyé — à publier') };
    case Upload.DS_STALLED:   return { cls: 'stalled',   label: t('upl.stStalled', 'Interrompu') };
    case 'published':         return { cls: 'published', label: t('upl.stPublished', 'Publié') };
    default:                  return { cls: 'uploading', label: state || '—' };
  }
}

function statusLabel(s, working, paused) {
  if (paused) return t('upl.statusPaused', 'Transfert en pause');
  if (s.phase === 'scanning') return t('upl.statusScanning', 'Lecture du dossier…');
  if (s.phase === 'planning') return t('upl.statusPlanning', 'Analyse et vérification…');
  if (working) return t('upl.statusUploading', 'Transfert en cours');
  if (s.phase === 'done') return t('upl.statusDone', 'Transfert terminé');
  return t('upl.statusIdle', 'Imports en attente');
}
