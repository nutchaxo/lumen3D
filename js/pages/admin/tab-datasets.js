/**
 * Admin SPA — Datasets tab
 * ========================
 * The original 3-column editor (list · live preview iframe · metadata form),
 * ported intact, plus a per-dataset hide/show control. Preserves the proven
 * mechanics: dirty tracking, the RACE-006 selection-generation token, the
 * orientation calibration handshake, channel/exposure postMessage sync, and the
 * save → rebuild_catalog flow.
 */

'use strict';

import {
  API_DATASETS, t, escHtml, apiFetch, toast, el, deepClone, refreshIcons,
} from './shared.js';
import { setUnsaved, setDirtyGuard } from './bus.js';

const PREVIEW_DEBOUNCE = 150;

let _datasets = [];
let _current = null;
let _draft = null;
let _original = null;
let _dirty = false;
let _typeFilter = 'all';
let _searchQuery = '';
let _previewTimer = null;
let _selectGen = 0;
let _isCalibratingOrientation = false;
let _loaded = false;

let DOM = {};

function refDom() {
  DOM = {
    datasetList: el('dataset-list'),
    listLoading: el('list-loading'),
    datasetCount: el('dataset-count'),
    datasetSearch: el('dataset-search'),
    searchClear: el('search-clear'),
    previewPlaceholder: el('preview-placeholder'),
    previewLoading: el('preview-loading'),
    previewFrameWrap: el('preview-frame-wrap'),
    previewFrame: el('preview-frame'),
    previewLabelBar: el('preview-label-bar'),
    previewLabelName: el('preview-label-name'),
    previewLabelDim: el('preview-label-dim'),
    configEmpty: el('config-empty'),
    configPanel: el('config-panel'),
    topbarName: el('topbar-name'),
    topbarType: el('topbar-type'),
    btnSave: el('btn-save'),
    btnReset: el('btn-reset'),
    btnRebuild: el('btn-rebuild-catalog'),
    rebuildStatus: el('rebuild-status'),
    fName: el('f-name'),
    fStage: el('f-stage'),
    fEmbryo: el('f-embryo'),
    fDescription: el('f-description'),
    fFolder: el('f-folder'),
    fDims: el('f-dims'),
    fVoxX: el('f-vox-x'),
    fVoxY: el('f-vox-y'),
    fVoxZ: el('f-vox-z'),
    fExposure: el('f-exposure'),
    fExposureVal: el('f-exposure-val'),
    fVisible: el('f-visible'),
    visBadge: el('vis-badge'),
    visHint: el('vis-hint'),
    btnSetPreview: el('btn-set-preview'),
    btnDefineOrientation: el('btn-define-orientation'),
    orientationStatus: el('orientation-status'),
  };
}

// ── Dirty tracking ─────────────────────────────────────────────
function markDirty() { if (_dirty) return; _dirty = true; setUnsaved(true); }
function clearDirty() { _dirty = false; setUnsaved(false); }

// ── List ───────────────────────────────────────────────────────
async function loadDatasets() {
  const data = await apiFetch(`${API_DATASETS}?action=list`);
  if (!data?.datasets) {
    if (DOM.listLoading) DOM.listLoading.innerHTML =
      `<div style="padding:20px;text-align:center;font-size:12px;color:var(--adm-text-muted)">${escHtml(t('admin.loadFailed', 'Impossible de charger les datasets.'))}</div>`;
    return;
  }
  _datasets = data.datasets;
  DOM.datasetCount.textContent = _datasets.length;
  if (DOM.listLoading) DOM.listLoading.remove();
  renderList();
  _loaded = true;
}

function getFilteredDatasets() {
  return _datasets.filter((ds) => {
    let typeOk;
    if (_typeFilter === 'all') typeOk = true;
    else if (_typeFilter === 'hidden') typeOk = !!ds.hidden;
    else typeOk = ds.type === _typeFilter;
    const q = _searchQuery.toLowerCase();
    const textOk = !q || (ds.name || '').toLowerCase().includes(q) ||
      (ds.stage || '').toLowerCase().includes(q) ||
      (ds.embryo || '').toLowerCase().includes(q);
    return typeOk && textOk;
  });
}

function renderList() {
  if (!DOM.datasetList) return;
  DOM.datasetList.querySelectorAll('.dataset-item').forEach((e) => e.remove());
  const filtered = getFilteredDatasets();

  if (!filtered.length) {
    let empty = DOM.datasetList.querySelector('.list-empty');
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.innerHTML = `<div class="list-empty-icon">🔍</div><div class="list-empty-text">${escHtml(t('admin.noDatasetFound', 'Aucun dataset trouvé.'))}</div>`;
      DOM.datasetList.appendChild(empty);
    }
    return;
  }
  const empty = DOM.datasetList.querySelector('.list-empty');
  if (empty) empty.remove();

  filtered.forEach((ds) => {
    const item = document.createElement('div');
    item.className = 'dataset-item' + (_current?.id === ds.id ? ' selected' : '') + (ds.hidden ? ' is-hidden' : '');
    item.dataset.id = ds.id;
    const thumbHtml = ds.thumbnail
      ? `<img class="item-thumb" src="${escHtml(ds.thumbnail)}" alt="" loading="lazy">`
      : `<div class="item-thumb-placeholder">🧬</div>`;
    const stageBadge = ds.stage ? `<span class="item-stage">${escHtml(ds.stage)}</span>` : '';
    const embryoText = ds.embryo ? `<span class="item-embryo">${escHtml(ds.embryo)}</span>` : '';
    const hiddenBadge = ds.hidden ? `<span class="item-hidden-badge" title="${escHtml(t('admin.hidden', 'Masqué'))}">${escHtml(t('admin.hiddenShort', 'masqué'))}</span>` : '';
    const statusClass = ds.configured ? 'configured' : 'unconfigured';
    // Per-item visibility toggle. Icon reflects current state (eye = visible,
    // eye-off = hidden); the title spells out the action. No delete control —
    // dataset removal is a filesystem operation by design.
    const visTitle = ds.hidden ? t('admin.showDataset', 'Afficher dans l\'explorer') : t('admin.hideDataset', 'Masquer de l\'explorer');
    const visBtn = `<button type="button" class="item-vis-btn${ds.hidden ? ' is-off' : ''}" data-vis-btn title="${escHtml(visTitle)}" aria-label="${escHtml(visTitle)}"><i data-lucide="${ds.hidden ? 'eye-off' : 'eye'}"></i></button>`;
    item.innerHTML = `
      ${thumbHtml}
      <div class="item-info">
        <div class="item-name">${escHtml(ds.name)}</div>
        <div class="item-meta">${stageBadge}${embryoText}${hiddenBadge}</div>
      </div>
      ${visBtn}
      <span class="item-status ${statusClass}" title="${escHtml(ds.configured ? t('admin.configured', 'Configuré') : t('admin.unconfigured', 'Non configuré'))}"></span>`;
    item.addEventListener('click', () => selectDataset(ds.id));
    item.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectDataset(ds.id); });
    item.setAttribute('tabindex', '0');

    const vbtn = item.querySelector('[data-vis-btn]');
    if (vbtn) {
      // Stop the row's click/Enter from selecting the dataset when toggling.
      vbtn.addEventListener('click', (e) => { e.stopPropagation(); toggleItemVisibility(ds.id, vbtn); });
      vbtn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
    }
    DOM.datasetList.appendChild(item);
  });
  refreshIcons(DOM.datasetList);
}

// ── Validation (Rule 1.4) ──────────────────────────────────────
function validateDatasetMeta(meta) {
  if (!meta || typeof meta !== 'object') return t('admin.reasonEmpty', 'réponse vide');
  if (typeof meta.id !== 'string' || !meta.id) return t('admin.reasonNoId', 'identifiant manquant');
  if (!['fixed', 'live', 'tracking'].includes(meta.type)) return t('admin.reasonBadType', 'type invalide');
  const d = meta.dimensions;
  if (!d || typeof d !== 'object') return t('admin.reasonNoDims', 'dimensions manquantes');
  const dimOk = ['x', 'y', 'z', 'c'].every((k) => Number.isFinite(d[k]) && d[k] > 0);
  if (!dimOk) return t('admin.reasonBadDims', 'dimensions invalides');
  if (!Array.isArray(meta.channels) || meta.channels.length === 0) return t('admin.reasonNoChannels', 'canaux manquants');
  return null;
}

async function selectDataset(id) {
  if (_dirty) {
    if (!confirm(t('admin.confirmDiscard', 'Modifications non sauvegardées. Continuer sans sauvegarder ?'))) return;
    clearDirty();
  }
  const myGen = ++_selectGen;   // RACE-006
  _current = _datasets.find((ds) => ds.id === id) || null;
  if (!_current) return;
  DOM.datasetList.querySelectorAll('.dataset-item').forEach((e) =>
    e.classList.toggle('selected', e.dataset.id === id));

  const meta = await apiFetch(`${API_DATASETS}?action=get&id=${encodeURIComponent(id)}`);
  if (myGen !== _selectGen) return;
  if (!meta) { toast(t('admin.loadDatasetFailed', 'Impossible de charger le dataset.'), 'error'); return; }
  const invalid = validateDatasetMeta(meta);
  if (invalid) { toast(t('admin.malformedRejected', `Dataset malformé, montage refusé (${invalid}).`, { reason: invalid }), 'error'); return; }

  meta.channels = normaliseChannels(meta.channels, meta.dimensions?.c || 0);
  // Preserve the list-level hidden flag if the metadata doesn't carry it yet.
  if (meta.hidden === undefined) meta.hidden = !!_current.hidden;
  _draft = deepClone(meta);
  _original = deepClone(meta);
  clearDirty();
  loadPreview(_current);
  populateForm();
  DOM.configEmpty.style.display = 'none';
  DOM.configPanel.style.display = 'flex';
}

function normaliseChannels(channels, count) {
  const DEFAULT_COLORS = ['#00FF66', '#FF3DFF', '#2F6BFF', '#FF3030'];
  const n = Math.max(count || 0, Array.isArray(channels) ? channels.length : 0, 1);
  return Array.from({ length: n }, (_, i) => {
    const raw = Array.isArray(channels) ? channels[i] : null;
    if (raw && typeof raw === 'object') {
      return {
        name: raw.name ?? `Canal ${i + 1}`,
        color: raw.color ?? DEFAULT_COLORS[i % 4],
        min: raw.min ?? 0.0, max: raw.max ?? 1.0, gamma: raw.gamma ?? 1.0,
        active: raw.active ?? true,
      };
    }
    return { name: typeof raw === 'string' ? raw : `Canal ${i + 1}`, color: DEFAULT_COLORS[i % 4], min: 0, max: 1, gamma: 1, active: true };
  });
}

// ── Preview ────────────────────────────────────────────────────
function loadPreview(ds) {
  DOM.previewPlaceholder.style.display = 'none';
  DOM.previewLabelBar.style.display = 'none';
  DOM.previewFrameWrap.style.display = 'none';
  DOM.previewLoading.style.display = 'flex';
  const viewerId = ds.id.includes('/') ? ds.id.split('/').pop() : ds.id;
  DOM.previewFrame.src = `viewer.html?id=${encodeURIComponent(viewerId)}&path=${encodeURIComponent(ds.id)}&mode=admin&hideHeader=true`;
}

function schedulePreviewUpdate() {
  clearTimeout(_previewTimer);
  _previewTimer = setTimeout(pushPreviewUpdate, PREVIEW_DEBOUNCE);
}
function pushPreviewUpdate() {
  if (!_draft?.channels || !DOM.previewFrame.contentWindow) return;
  try {
    DOM.previewFrame.contentWindow.postMessage({
      type: 'APPLY_WORKSPACE_STATE',
      state: {
        channels: _draft.channels.map((ch) => ({ active: ch.active, color: ch.color, min: ch.min, max: ch.max, gamma: ch.gamma })),
        exposure: _draft.exposure ?? 1.0,
      },
    }, '*');
  } catch (_) { /* cross-origin guard */ }
}

// ── Form ───────────────────────────────────────────────────────
function populateForm() {
  const m = _draft, ds = _current;
  DOM.topbarName.textContent = m.name || ds.folderName || ds.id;
  DOM.topbarType.textContent = `${m.type || 'fixed'} · ${ds.id}`;
  DOM.fName.value = m.name || '';
  DOM.fStage.value = m.stage || '';
  DOM.fEmbryo.value = m.embryo || '';
  DOM.fDescription.value = m.description || '';
  DOM.fFolder.textContent = ds.folderName || ds.id;
  const d = m.dimensions || {};
  DOM.fDims.textContent = d.x ? `${d.x} × ${d.y} × ${d.z} px · ${t('admin.dimsChannels', `${d.c} canal(ux)`, { count: d.c })}` : '—';
  const vs = m.voxel_size || {};
  DOM.fVoxX.value = vs.x ?? '';
  DOM.fVoxY.value = vs.y ?? '';
  DOM.fVoxZ.value = vs.z ?? '';
  if (DOM.fExposure) {
    const exp = m.exposure ?? 1.0;
    DOM.fExposure.value = Math.max(20, Math.min(500, Math.round(exp * 100)));
    if (DOM.fExposureVal) DOM.fExposureVal.textContent = `${exp.toFixed(2)}×`;
  }
  updateVisibilityUI();
  _isCalibratingOrientation = false;
  if (DOM.btnDefineOrientation) {
    DOM.btnDefineOrientation.classList.remove('adm-btn-accent');
    DOM.btnDefineOrientation.classList.add('adm-btn-ghost');
    DOM.btnDefineOrientation.innerHTML = t('admin.defineOrientation', '🧭 Définir l\'orientation');
  }
  if (DOM.orientationStatus) {
    DOM.orientationStatus.textContent = m.orientation
      ? t('admin.orientationSet', 'Orientation définie ✓')
      : t('admin.noOrientation', '(Aucune orientation définie)');
  }
}

function updateVisibilityUI() {
  const hidden = !!_draft?.hidden;
  if (DOM.fVisible) DOM.fVisible.checked = !hidden;
  if (DOM.visBadge) {
    DOM.visBadge.textContent = hidden ? t('admin.hidden', 'Masqué') : t('admin.visible', 'Visible');
    DOM.visBadge.className = 'vis-badge ' + (hidden ? 'is-hidden' : 'is-visible');
  }
  if (DOM.visHint) {
    DOM.visHint.textContent = hidden
      ? t('admin.hiddenHint', 'Absent de l\'explorer public.')
      : t('admin.visibleHint', 'Visible dans l\'explorer public.');
  }
}

// Persist a dataset's hidden flag and sync every surface (list + open editor).
// Reused by the config-panel checkbox and the per-item list button, so it works
// for ANY dataset id — not only the currently selected one.
async function applyVisibility(id, newHidden) {
  const data = await apiFetch(`${API_DATASETS}?action=set_visibility&id=${encodeURIComponent(id)}`,
    { method: 'POST', body: JSON.stringify({ hidden: newHidden }) });
  if (!data?.ok) {
    toast(t('admin.visibilityError', 'Erreur lors du changement de visibilité.'), 'error');
    return false;
  }
  const idx = _datasets.findIndex((d) => d.id === id);
  if (idx !== -1) _datasets[idx].hidden = newHidden;
  // Visibility is persisted immediately, independent of the draft save. If the
  // toggled dataset is the one open in the editor, mirror the flag into draft +
  // original so it doesn't register as an unsaved diff.
  if (_current?.id === id) {
    _current.hidden = newHidden;
    if (_draft) _draft.hidden = newHidden;
    if (_original) _original.hidden = newHidden;
    updateVisibilityUI();
  }
  renderList();
  toast(newHidden ? t('admin.datasetHidden', 'Dataset masqué de l\'explorer.') : t('admin.datasetShown', 'Dataset visible dans l\'explorer.'));
  return true;
}

// Config-panel checkbox (checked = "visible").
async function toggleVisibility() {
  if (!_current) return;
  const newHidden = !!DOM.fVisible && !DOM.fVisible.checked;
  DOM.fVisible.disabled = true;
  const ok = await applyVisibility(_current.id, newHidden);
  DOM.fVisible.disabled = false;
  if (!ok && DOM.fVisible) DOM.fVisible.checked = !newHidden;  // revert on failure
}

// Per-item list button — toggles visibility without opening the dataset.
async function toggleItemVisibility(id, btn) {
  const ds = _datasets.find((d) => d.id === id);
  if (!ds) return;
  if (btn) btn.disabled = true;
  const ok = await applyVisibility(id, !ds.hidden);
  if (!ok && btn) btn.disabled = false;  // on success the list re-renders
}

// ── Save / Reset ───────────────────────────────────────────────
async function saveDataset() {
  if (!_current || !_draft) return;
  DOM.btnSave.disabled = true;
  DOM.btnSave.innerHTML = `<span class="spinner spinner-sm"></span> ${escHtml(t('admin.saving', 'Sauvegarde…'))}`;

  if (_isCalibratingOrientation && DOM.previewFrame.contentWindow) {
    DOM.previewFrame.contentWindow.postMessage({ type: 'GET_ORIENTATION' }, '*');
    await new Promise((resolve) => {
      const handler = (e) => {
        if (e.data?.type === 'ORIENTATION_RESULT') {
          const q = e.data.quaternion;
          const a = Array.isArray(q) ? q.slice() : (q && typeof q === 'object' ? [q.x, q.y, q.z, q.w] : null);
          if (a && a.length === 4 && a.every(Number.isFinite)) {
            const len = Math.hypot(a[0], a[1], a[2], a[3]);
            if (len > 1e-6) {
              const n = a.map((v) => v / len);
              _draft.orientation = Array.isArray(q) ? n : { x: n[0], y: n[1], z: n[2], w: n[3] };
            }
          }
          window.removeEventListener('message', handler);
          resolve();
        }
      };
      window.addEventListener('message', handler);
      setTimeout(() => { window.removeEventListener('message', handler); resolve(); }, 1500);
    });
    _isCalibratingOrientation = false;
    if (DOM.btnDefineOrientation) {
      DOM.btnDefineOrientation.classList.remove('adm-btn-accent');
      DOM.btnDefineOrientation.classList.add('adm-btn-ghost');
      DOM.btnDefineOrientation.innerHTML = t('admin.defineOrientation', '🧭 Définir l\'orientation');
    }
    if (DOM.orientationStatus) DOM.orientationStatus.textContent = t('admin.orientationSet', 'Orientation définie ✓');
    DOM.previewFrame.contentWindow.postMessage({ type: 'CALIBRATE_ORIENTATION_STOP' }, '*');
  }

  _draft.name = (DOM.fName.value || '').trim() || _draft.name;
  _draft.stage = (DOM.fStage.value || '').trim();
  _draft.embryo = (DOM.fEmbryo.value || '').trim() || null;
  _draft.description = (DOM.fDescription.value || '').trim() || null;
  _draft.voxel_size = {
    x: parseFloat(DOM.fVoxX.value) || _draft.voxel_size?.x || 1,
    y: parseFloat(DOM.fVoxY.value) || _draft.voxel_size?.y || 1,
    z: parseFloat(DOM.fVoxZ.value) || _draft.voxel_size?.z || 1,
  };
  if (DOM.fExposure) _draft.exposure = parseFloat(DOM.fExposure.value) / 100;
  const sn = parseStageNumeric(_draft.stage);
  if (sn !== null) _draft.stageNumeric = sn;

  const data = await apiFetch(`${API_DATASETS}?action=save&id=${encodeURIComponent(_current.id)}`,
    { method: 'POST', body: JSON.stringify(_draft) });

  DOM.btnSave.disabled = false;
  DOM.btnSave.innerHTML = t('admin.save', '💾 Sauvegarder');

  if (data?.ok) {
    _original = deepClone(_draft);
    clearDirty();
    toast(t('admin.toastSaved', 'Dataset sauvegardé ✓'));
    DOM.topbarName.textContent = _draft.name;
    const idx = _datasets.findIndex((d) => d.id === _current.id);
    if (idx !== -1) _datasets[idx] = { ..._datasets[idx], name: _draft.name, stage: _draft.stage, embryo: _draft.embryo, configured: true };
    renderList();
    const rb = await apiFetch(`${API_DATASETS}?action=rebuild_catalog`, { method: 'POST', body: '{}' });
    if (!rb?.ok) toast(t('admin.toastSavedNoCatalog', 'Sauvegardé, mais catalogue non régénéré — relancez la reconstruction.'), 'warning');
  } else {
    toast(t('admin.toastSaveError', 'Erreur lors de la sauvegarde.'), 'error');
  }
}

function resetDataset() {
  if (!_original) return;
  _draft = deepClone(_original);
  clearDirty();
  populateForm();
  schedulePreviewUpdate();
}

async function saveThumbnail(dataUrl) {
  if (!_current) return;
  if (DOM.btnSetPreview) {
    DOM.btnSetPreview.disabled = true;
    DOM.btnSetPreview.innerHTML = `<span class="spinner spinner-sm"></span> ${escHtml(t('admin.savingPreview', 'Enregistrement…'))}`;
  }
  const data = await apiFetch(`${API_DATASETS}?action=save_thumbnail&id=${encodeURIComponent(_current.id)}`,
    { method: 'POST', body: JSON.stringify({ image: dataUrl }) });
  if (DOM.btnSetPreview) {
    DOM.btnSetPreview.disabled = false;
    DOM.btnSetPreview.innerHTML = t('admin.setPreview', '📸 Redéfinir la preview');
  }
  if (data?.ok) {
    toast(t('admin.toastPreviewUpdated', 'Preview mise à jour ✓'));
    const newThumbUrl = `${data.path}?v=${Date.now()}`;
    _current.thumbnail = newThumbUrl;
    const idx = _datasets.findIndex((d) => d.id === _current.id);
    if (idx !== -1) _datasets[idx].thumbnail = newThumbUrl;
    renderList();
    const rb = await apiFetch(`${API_DATASETS}?action=rebuild_catalog`, { method: 'POST', body: '{}' });
    if (!rb?.ok) toast(t('admin.toastPreviewNoCatalog', 'Vignette enregistrée, mais catalogue non régénéré.'), 'warning');
  } else {
    const reason = data?.error || t('admin.unknownError', 'Inconnue');
    toast(t('admin.toastPreviewError', `Erreur lors de l'enregistrement de la preview : ${reason}`, { reason }), 'error');
  }
}

function parseStageNumeric(stage) {
  const m = (stage || '').match(/E(\d+(?:\.\d+)?)/i);
  return m ? parseFloat(m[1]) : null;
}

async function rebuildCatalog() {
  DOM.btnRebuild.disabled = true;
  const prev = DOM.btnRebuild.innerHTML;
  DOM.btnRebuild.innerHTML = `<span class="spinner spinner-sm"></span> ${escHtml(t('admin.generating', 'Génération…'))}`;
  const data = await apiFetch(`${API_DATASETS}?action=rebuild_catalog`, { method: 'POST', body: '{}' });
  DOM.btnRebuild.disabled = false;
  DOM.btnRebuild.innerHTML = prev;
  if (data?.ok) {
    const locale = (typeof I18n !== 'undefined' && I18n?.getLanguage) ? I18n.getLanguage() : 'fr-FR';
    const time = new Date().toLocaleTimeString(locale);
    DOM.rebuildStatus.textContent = t('admin.catalogStatusOk', `✅ ${data.count} datasets — ${time}`, { count: data.count, time });
    toast(t('admin.toastCatalogRebuilt', `Catalogue régénéré : ${data.count} datasets.`, { count: data.count }));
  } else {
    DOM.rebuildStatus.textContent = t('admin.catalogStatusError', '❌ Erreur lors de la génération.');
    toast(t('admin.toastCatalogError', 'Erreur lors de la génération du catalogue.'), 'error');
  }
}

// ── Wiring ─────────────────────────────────────────────────────
function wire() {
  DOM.btnSave.addEventListener('click', saveDataset);
  DOM.btnReset.addEventListener('click', resetDataset);
  DOM.btnRebuild.addEventListener('click', rebuildCatalog);

  DOM.datasetSearch.addEventListener('input', (e) => {
    _searchQuery = e.target.value;
    DOM.searchClear.style.display = _searchQuery ? 'block' : 'none';
    renderList();
  });
  DOM.searchClear.addEventListener('click', () => {
    _searchQuery = ''; DOM.datasetSearch.value = '';
    DOM.searchClear.style.display = 'none'; renderList();
  });
  document.querySelectorAll('#tab-datasets .filter-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#tab-datasets .filter-tab').forEach((x) => x.classList.remove('active'));
      tab.classList.add('active');
      _typeFilter = tab.dataset.type;
      renderList();
    });
  });

  [DOM.fName, DOM.fStage, DOM.fEmbryo, DOM.fDescription, DOM.fVoxX, DOM.fVoxY, DOM.fVoxZ]
    .forEach((e) => e && e.addEventListener('input', markDirty));

  if (DOM.fVisible) DOM.fVisible.addEventListener('change', toggleVisibility);

  if (DOM.fExposure) DOM.fExposure.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value) / 100;
    if (DOM.fExposureVal) DOM.fExposureVal.textContent = `${val.toFixed(2)}×`;
    if (_draft) { _draft.exposure = val; markDirty(); schedulePreviewUpdate(); }
  });

  if (DOM.btnDefineOrientation) DOM.btnDefineOrientation.addEventListener('click', () => {
    if (!_current) return;
    _isCalibratingOrientation = !_isCalibratingOrientation;
    if (_isCalibratingOrientation) {
      DOM.btnDefineOrientation.classList.add('adm-btn-accent');
      DOM.btnDefineOrientation.classList.remove('adm-btn-ghost');
      DOM.btnDefineOrientation.innerHTML = t('admin.cancelOrientation', '❌ Annuler l\'orientation');
      if (DOM.orientationStatus) DOM.orientationStatus.textContent = t('admin.orientationAdjustHint', 'Ajustez l\'embryon sur les axes (puis sauvegardez)…');
      DOM.previewFrame.contentWindow?.postMessage({ type: 'CALIBRATE_ORIENTATION_START' }, '*');
      markDirty();
    } else {
      DOM.btnDefineOrientation.classList.remove('adm-btn-accent');
      DOM.btnDefineOrientation.classList.add('adm-btn-ghost');
      DOM.btnDefineOrientation.innerHTML = t('admin.defineOrientation', '🧭 Définir l\'orientation');
      if (DOM.orientationStatus) DOM.orientationStatus.textContent = _draft?.orientation
        ? t('admin.orientationSet', 'Orientation définie ✓') : t('admin.noOrientation', '(Aucune orientation définie)');
      DOM.previewFrame.contentWindow?.postMessage({ type: 'CALIBRATE_ORIENTATION_STOP' }, '*');
    }
  });

  if (DOM.btnSetPreview) DOM.btnSetPreview.addEventListener('click', () => {
    if (!_current || !DOM.previewFrame.contentWindow) return;
    DOM.btnSetPreview.disabled = true;
    DOM.btnSetPreview.innerHTML = `<span class="spinner spinner-sm"></span> ${escHtml(t('admin.capturing', 'Capture…'))}`;
    DOM.previewFrame.contentWindow.postMessage({ type: 'REQUEST_SCREENSHOT' }, '*');
  });

  DOM.previewFrame.addEventListener('load', () => {
    DOM.previewLoading.style.display = 'none';
    DOM.previewFrameWrap.style.display = 'flex';
    if (_current) {
      DOM.previewLabelName.textContent = _draft?.name || _current.id;
      const d = _draft?.dimensions || {};
      DOM.previewLabelDim.textContent = d.x ? `${d.x}×${d.y}×${d.z} · ${d.c}ch` : '';
      DOM.previewLabelBar.style.display = 'flex';
    }
    schedulePreviewUpdate();
  });

  // Ctrl+S
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && (e.key === 's' || e.key === 'S') && _draft) { e.preventDefault(); saveDataset(); }
  });
  window.addEventListener('beforeunload', (e) => { if (_dirty) { e.preventDefault(); e.returnValue = ''; } });

  // Sync from the embedded viewer iframe.
  window.addEventListener('message', (e) => {
    if (e.origin !== window.location.origin) return;   // SEC-006
    if (e.data?.type === 'SYNC_CHANNELS' && e.data.value && _draft?.channels) {
      const idx = e.data.channelIndex;
      if (idx !== undefined && _draft.channels[idx]) {
        const isEnabled = e.data.value.enabled !== undefined ? e.data.value.enabled : e.data.value.active;
        _draft.channels[idx].active = isEnabled ?? true;
        _draft.channels[idx].color = e.data.value.color;
        _draft.channels[idx].min = e.data.value.min;
        _draft.channels[idx].max = e.data.value.max;
        _draft.channels[idx].gamma = e.data.value.gamma;
        _draft.channels[idx].name = e.data.value.name;
        markDirty();
      }
    }
    if (e.data?.type === 'SYNC_EXPOSURE' && e.data.value !== undefined && _draft) {
      _draft.exposure = e.data.value;
      if (DOM.fExposure) DOM.fExposure.value = Math.max(20, Math.min(500, Math.round(e.data.value * 100)));
      if (DOM.fExposureVal) DOM.fExposureVal.textContent = `${e.data.value.toFixed(2)}×`;
      markDirty();
    }
    if (e.data?.type === 'SCREENSHOT_RESPONSE') {
      if (DOM.btnSetPreview) {
        DOM.btnSetPreview.disabled = false;
        DOM.btnSetPreview.innerHTML = t('admin.setPreview', '📸 Redéfinir la preview');
      }
      if (e.data.error) toast(t('admin.toastCaptureError', `Erreur de capture : ${e.data.error}`, { error: e.data.error }), 'error');
      else if (e.data.dataUrl) saveThumbnail(e.data.dataUrl);
    }
  });
}

export const DatasetsTab = {
  id: 'datasets',
  titleKey: 'admin.navDatasets',
  titleDefault: 'Datasets',
  mounted: false,
  mount() {
    refDom();
    setDirtyGuard(() => _dirty);
    wire();
    loadDatasets();
  },
  activate() { if (_loaded) renderList(); },
  relabel() { renderList(); if (_draft) populateForm(); },
};
