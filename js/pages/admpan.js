/**
 * IRIBHM Microscopy Platform — Admin Panel JS
 * ============================================
 * Vanilla ES module. No framework.
 *
 * State:
 *   _datasets[]  — list fetched from API
 *   _current     — selected dataset summary
 *   _draft       — full metadata being edited (deep clone)
 *   _original    — last-saved state (for reset/dirty check)
 *   _dirty       — boolean
 *   _typeFilter  — 'all' | 'fixed' | 'live' | 'tracking'
 */

'use strict';

// ── Config ────────────────────────────────────────────────────
const API_AUTH     = 'api/auth.php';
const API_DATASETS = 'api/datasets.php';
const PREVIEW_DEBOUNCE = 150;

// ── State ─────────────────────────────────────────────────────
let _datasets    = [];
let _current     = null;
let _draft       = null;
let _original    = null;
let _dirty       = false;
let _typeFilter  = 'all';
let _searchQuery = '';
let _previewTimer = null;
let _selectGen = 0;   // ELE-15: monotonic token; a slow get() for a superseded selection is ignored

// ── DOM refs ──────────────────────────────────────────────────
const el = id => document.getElementById(id);
const DOM = {
  loginScreen      : el('login-screen'),
  adminApp         : el('admin-app'),
  loginUsername    : el('login-username'),
  loginPassword    : el('login-password'),
  loginError       : el('login-error'),
  loginErrorMsg    : el('login-error-msg'),
  btnLogin         : el('btn-login'),
  btnLogout        : el('btn-logout'),
  headerUsername   : el('header-username'),
  headerUnsaved    : el('header-unsaved-wrap'),
  datasetList      : el('dataset-list'),
  listLoading      : el('list-loading'),
  datasetCount     : el('dataset-count'),
  datasetSearch    : el('dataset-search'),
  searchClear      : el('search-clear'),
  previewPlaceholder : el('preview-placeholder'),
  previewLoading   : el('preview-loading'),
  previewFrameWrap : el('preview-frame-wrap'),
  previewFrame     : el('preview-frame'),
  previewLabelBar  : el('preview-label-bar'),
  previewLabelName : el('preview-label-name'),
  previewLabelDim  : el('preview-label-dim'),
  configEmpty      : el('config-empty'),
  configPanel      : el('config-panel'),
  topbarName       : el('topbar-name'),
  topbarType       : el('topbar-type'),
  btnSave          : el('btn-save'),
  btnReset         : el('btn-reset'),
  btnRebuild       : el('btn-rebuild-catalog'),
  rebuildStatus    : el('rebuild-status'),
  fName            : el('f-name'),
  fStage           : el('f-stage'),
  fEmbryo          : el('f-embryo'),
  fDescription     : el('f-description'),
  fFolder          : el('f-folder'),
  fDims            : el('f-dims'),
  fVoxX            : el('f-vox-x'),
  fVoxY            : el('f-vox-y'),
  fVoxZ            : el('f-vox-z'),
  fExposure        : el('f-exposure'),
  fExposureVal     : el('f-exposure-val'),
  btnSetPreview    : el('btn-set-preview'),
  btnDefineOrientation: el('btn-define-orientation'),
  orientationStatus: el('orientation-status'),
  toastContainer   : el('toast-container'),
};

let _isCalibratingOrientation = false;

// ── Utils ─────────────────────────────────────────────────────

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let _csrfToken = null;  // CSRF token for state-changing requests (set after auth)

async function apiFetch(url, options = {}) {
  try {
    const res = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...(_csrfToken ? { 'X-CSRF-Token': _csrfToken } : {}),
        ...(options.headers || {}),
      },
      ...options,
    });
    if (res.status === 401) {
      showLogin();
      return null;
    }
    const text = await res.text();
    try { return JSON.parse(text); }
    catch { return null; }
  } catch (err) {
    console.error('API error:', url, err);
    return null;
  }
}

function toast(msg, type = 'success') {
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
  const div = document.createElement('div');
  div.className = `toast toast-${type}`;
  div.innerHTML = `<span class="toast-icon">${icons[type] || '📢'}</span><span class="toast-msg">${escHtml(msg)}</span>`;
  DOM.toastContainer.appendChild(div);
  setTimeout(() => {
    div.classList.add('dismissing');
    setTimeout(() => div.remove(), 280);
  }, 3000);
}

// ── Dirty tracking ────────────────────────────────────────────

function markDirty() {
  if (_dirty) return;
  _dirty = true;
  DOM.headerUnsaved.style.display = 'block';
  document.title = '● Admin — IRIBHM';
}
function clearDirty() {
  _dirty = false;
  DOM.headerUnsaved.style.display = 'none';
  document.title = 'Admin — IRIBHM Microscopy Platform';
}

// ── Auth ──────────────────────────────────────────────────────

async function checkAuth() {
  const data = await apiFetch(`${API_AUTH}?action=status`);
  if (data?.authenticated) {
    _csrfToken = data.csrf || null;
    showApp();
    loadDatasets();
  } else {
    showLogin();
  }
}

function showLogin() {
  DOM.loginScreen.style.display = 'flex';
  DOM.adminApp.style.display = 'none';
}

function showApp() {
  DOM.loginScreen.style.display = 'none';
  DOM.adminApp.style.display = 'flex';
  DOM.adminApp.style.flexDirection = 'column';
}

async function doLogin() {
  const username = (DOM.loginUsername.value || '').trim();
  const password = DOM.loginPassword.value || '';
  if (!username || !password) return;

  DOM.btnLogin.disabled = true;
  DOM.btnLogin.innerHTML = '<span class="spinner spinner-sm"></span> Connexion…';
  DOM.loginError.style.display = 'none';

  const data = await apiFetch(`${API_AUTH}?action=login`, {
    method: 'POST',
    body: JSON.stringify({ action: 'login', username, password }),
  });

  DOM.btnLogin.disabled = false;
  DOM.btnLogin.innerHTML = 'Se connecter';

  if (data?.ok) {
    _csrfToken = data.csrf || null;
    DOM.headerUsername.textContent = username;
    showApp();
    loadDatasets();
  } else {
    DOM.loginErrorMsg.textContent = data?.error || 'Identifiants incorrects.';
    DOM.loginError.style.display = 'block';
    DOM.loginPassword.value = '';
    DOM.loginPassword.focus();
  }
}

async function doLogout() {
  await apiFetch(`${API_AUTH}?action=logout`, { method: 'POST', body: '{}' });
  _current = _draft = _original = null;
  _dirty = false;
  showLogin();
}

// ── Dataset list ──────────────────────────────────────────────

async function loadDatasets() {
  const data = await apiFetch(`${API_DATASETS}?action=list`);
  if (!data?.datasets) {
    DOM.listLoading.innerHTML = '<div style="padding:20px;text-align:center;font-size:12px;color:var(--adm-text-muted)">Impossible de charger les datasets.<br>Vérifiez que PHP est actif.</div>';
    return;
  }
  _datasets = data.datasets;
  DOM.datasetCount.textContent = _datasets.length;
  if (DOM.listLoading) DOM.listLoading.remove();
  renderList();
}

function getFilteredDatasets() {
  return _datasets.filter(ds => {
    const typeOk = _typeFilter === 'all' || ds.type === _typeFilter;
    const q = _searchQuery.toLowerCase();
    const textOk = !q || (ds.name || '').toLowerCase().includes(q) ||
      (ds.stage || '').toLowerCase().includes(q) ||
      (ds.embryo || '').toLowerCase().includes(q);
    return typeOk && textOk;
  });
}

function renderList() {
  const filtered = getFilteredDatasets();
  const existingItems = DOM.datasetList.querySelectorAll('.dataset-item');
  existingItems.forEach(e => e.remove());

  if (!filtered.length) {
    let empty = DOM.datasetList.querySelector('.list-empty');
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.innerHTML = `<div class="list-empty-icon">🔍</div><div class="list-empty-text">Aucun dataset trouvé.</div>`;
      DOM.datasetList.appendChild(empty);
    }
    return;
  }

  // Remove empty state if present
  const empty = DOM.datasetList.querySelector('.list-empty');
  if (empty) empty.remove();

  filtered.forEach(ds => {
    const item = document.createElement('div');
    item.className = 'dataset-item' + (_current?.id === ds.id ? ' selected' : '');
    item.dataset.id = ds.id;

    const thumbHtml = ds.thumbnail
      ? `<img class="item-thumb" src="${escHtml(ds.thumbnail)}" alt="" loading="lazy">`
      : `<div class="item-thumb-placeholder">🧬</div>`;

    const stageBadge  = ds.stage  ? `<span class="item-stage">${escHtml(ds.stage)}</span>` : '';
    const embryoText  = ds.embryo ? `<span class="item-embryo">${escHtml(ds.embryo)}</span>` : '';
    const statusClass = ds.configured ? 'configured' : 'unconfigured';

    item.innerHTML = `
      ${thumbHtml}
      <div class="item-info">
        <div class="item-name">${escHtml(ds.name)}</div>
        <div class="item-meta">${stageBadge}${embryoText}</div>
      </div>
      <span class="item-status ${statusClass}" title="${ds.configured ? 'Configuré' : 'Non configuré'}"></span>
    `;

    item.addEventListener('click', () => selectDataset(ds.id));
    item.addEventListener('keydown', e => { if (e.key === 'Enter') selectDataset(ds.id); });
    item.setAttribute('tabindex', '0');
    DOM.datasetList.appendChild(item);
  });
}

// ── Select dataset ────────────────────────────────────────────

// Rule 1.4: a malformed metadata.json must be rejected at mount time, not
// partially mounted. Returns null when valid, else a human-readable reason.
function validateDatasetMeta(meta) {
  if (!meta || typeof meta !== 'object') return 'réponse vide';
  if (typeof meta.id !== 'string' || !meta.id) return 'identifiant manquant';
  if (!['fixed', 'live', 'tracking'].includes(meta.type)) return 'type invalide';
  const d = meta.dimensions;
  if (!d || typeof d !== 'object') return 'dimensions manquantes';
  const dimOk = ['x', 'y', 'z', 'c'].every(k => Number.isFinite(d[k]) && d[k] > 0);
  if (!dimOk) return 'dimensions invalides';
  if (!Array.isArray(meta.channels) || meta.channels.length === 0) return 'canaux manquants';
  return null;
}

async function selectDataset(id) {
  if (_dirty) {
    const ok = confirm('Modifications non sauvegardées. Continuer sans sauvegarder ?');
    if (!ok) return;
    clearDirty();
  }

  const myGen = ++_selectGen;   // ELE-15 (RACE-006): invalidate any earlier in-flight selection
  _current = _datasets.find(ds => ds.id === id) || null;
  if (!_current) return;

  // Highlight in list
  DOM.datasetList.querySelectorAll('.dataset-item').forEach(el =>
    el.classList.toggle('selected', el.dataset.id === id)
  );

  // Load full metadata
  const meta = await apiFetch(`${API_DATASETS}?action=get&id=${encodeURIComponent(id)}`);
  // ELE-15: a newer selection superseded this one while get() was in flight.
  // Ignore the stale response so it can't overwrite _draft/_original/_current.
  if (myGen !== _selectGen) return;
  if (!meta) { toast('Impossible de charger le dataset.', 'error'); return; }

  // Rule 1.4: reject a malformed dataset before any mount/edit state is created.
  const invalidReason = validateDatasetMeta(meta);
  if (invalidReason) {
    toast(`Dataset malformé, montage refusé (${invalidReason}).`, 'error');
    return;
  }

  meta.channels = normaliseChannels(meta.channels, meta.dimensions?.c || 0);
  _draft    = deepClone(meta);
  _original = deepClone(meta);
  clearDirty();

  loadPreview(_current);
  populateForm();

  DOM.configEmpty.style.display  = 'none';
  DOM.configPanel.style.display  = 'flex';
  DOM.configPanel.style.flexDirection = 'column';
  DOM.configPanel.style.height   = '100%';
}

function normaliseChannels(channels, count) {
  const DEFAULT_COLORS = ['#00FF66', '#FF3DFF', '#2F6BFF', '#FF3030'];
  const n = Math.max(count || 0, Array.isArray(channels) ? channels.length : 0, 1);
  return Array.from({ length: n }, (_, i) => {
    const raw = Array.isArray(channels) ? channels[i] : null;
    if (raw && typeof raw === 'object') {
      return {
        name:   raw.name   ?? `Canal ${i + 1}`,
        color:  raw.color  ?? DEFAULT_COLORS[i % 4],
        min:    raw.min    ?? 0.0,
        max:    raw.max    ?? 1.0,
        gamma:  raw.gamma  ?? 1.0,
        active: raw.active ?? true,
      };
    }
    return {
      name:   typeof raw === 'string' ? raw : `Canal ${i + 1}`,
      color:  DEFAULT_COLORS[i % 4],
      min: 0, max: 1, gamma: 1, active: true,
    };
  });
}

// ── Preview iframe ────────────────────────────────────────────

function loadPreview(ds) {
  DOM.previewPlaceholder.style.display  = 'none';
  DOM.previewLabelBar.style.display     = 'none';
  DOM.previewFrameWrap.style.display    = 'none';
  DOM.previewLoading.style.display      = 'flex';

  const viewerId = ds.id.includes('/') ? ds.id.split('/').pop() : ds.id;
  const src = `viewer.html?id=${encodeURIComponent(viewerId)}&path=${encodeURIComponent(ds.id)}&mode=admin&hideHeader=true`;
  DOM.previewFrame.src = src;
}

DOM.previewFrame.addEventListener('load', () => {
  DOM.previewLoading.style.display   = 'none';
  DOM.previewFrameWrap.style.display = 'flex';
  if (_current) {
    DOM.previewLabelName.textContent   = _draft?.name || _current.id;
    const d = _draft?.dimensions || {};
    DOM.previewLabelDim.textContent    = d.x ? `${d.x}×${d.y}×${d.z} · ${d.c}ch` : '';
    DOM.previewLabelBar.style.display  = 'flex';
  }
  schedulePreviewUpdate();
});

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
        channels: _draft.channels.map(ch => ({
          active: ch.active,
          color:  ch.color,
          min:    ch.min,
          max:    ch.max,
          gamma:  ch.gamma,
        })),
        exposure: _draft.exposure ?? 1.0,
      },
    }, '*');
  } catch (_) { /* cross-origin guard */ }
}

// ── Form ──────────────────────────────────────────────────────

function populateForm() {
  const m  = _draft;
  const ds = _current;
  DOM.topbarName.textContent   = m.name || ds.folderName || ds.id;
  DOM.topbarType.textContent   = `${m.type || 'fixed'} · ${ds.id}`;
  DOM.fName.value        = m.name        || '';
  DOM.fStage.value       = m.stage       || '';
  DOM.fEmbryo.value      = m.embryo      || '';
  DOM.fDescription.value = m.description || '';
  DOM.fFolder.textContent= ds.folderName || ds.id;

  const d = m.dimensions || {};
  DOM.fDims.textContent = d.x
    ? `${d.x} × ${d.y} × ${d.z} px · ${d.c} canal(ux)`
    : '—';

  const vs = m.voxel_size || {};
  DOM.fVoxX.value = vs.x ?? '';
  DOM.fVoxY.value = vs.y ?? '';
  DOM.fVoxZ.value = vs.z ?? '';

  if (DOM.fExposure) {
    const exp = m.exposure ?? 1.0;
    DOM.fExposure.value = Math.max(20, Math.min(500, Math.round(exp * 100)));
    if (DOM.fExposureVal) DOM.fExposureVal.textContent = `${exp.toFixed(2)}×`;
  }

  _isCalibratingOrientation = false;
  if (DOM.btnDefineOrientation) {
    DOM.btnDefineOrientation.classList.remove('adm-btn-accent');
    DOM.btnDefineOrientation.classList.add('adm-btn-ghost');
    DOM.btnDefineOrientation.innerHTML = '🧭 Définir l\'orientation';
  }
  if (DOM.orientationStatus) {
    DOM.orientationStatus.textContent = m.orientation ? 'Orientation définie ✓' : '(Aucune orientation définie)';
  }
}

// ── Save / Reset ──────────────────────────────────────────────

async function saveDataset() {
  if (!_current || !_draft) return;

  DOM.btnSave.disabled = true;
  DOM.btnSave.innerHTML = '<span class="spinner spinner-sm"></span> Sauvegarde…';

  // Fetch orientation if in calibration mode
  if (_isCalibratingOrientation && DOM.previewFrame.contentWindow) {
    DOM.previewFrame.contentWindow.postMessage({ type: 'GET_ORIENTATION' }, '*');
    await new Promise(resolve => {
      const handler = (e) => {
        if (e.data?.type === 'ORIENTATION_RESULT') {
          _draft.orientation = e.data.quaternion;
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
      DOM.btnDefineOrientation.innerHTML = '🧭 Définir l\'orientation';
    }
    if (DOM.orientationStatus) {
      DOM.orientationStatus.textContent = 'Orientation définie ✓';
    }
    DOM.previewFrame.contentWindow.postMessage({ type: 'CALIBRATE_ORIENTATION_STOP' }, '*');
  }

  // Merge form values into draft
  _draft.name        = (DOM.fName.value || '').trim() || _draft.name;
  _draft.stage       = (DOM.fStage.value || '').trim();
  _draft.embryo      = (DOM.fEmbryo.value || '').trim() || null;
  _draft.description = (DOM.fDescription.value || '').trim() || null;
  _draft.voxel_size  = {
    x: parseFloat(DOM.fVoxX.value) || _draft.voxel_size?.x || 1,
    y: parseFloat(DOM.fVoxY.value) || _draft.voxel_size?.y || 1,
    z: parseFloat(DOM.fVoxZ.value) || _draft.voxel_size?.z || 1,
  };
  if (DOM.fExposure) {
    _draft.exposure = parseFloat(DOM.fExposure.value) / 100;
  }
  const sn = parseStageNumeric(_draft.stage);
  if (sn !== null) _draft.stageNumeric = sn;

  const data = await apiFetch(
    `${API_DATASETS}?action=save&id=${encodeURIComponent(_current.id)}`,
    { method: 'POST', body: JSON.stringify(_draft) }
  );

  DOM.btnSave.disabled = false;
  DOM.btnSave.innerHTML = '💾 Sauvegarder';

  if (data?.ok) {
    _original = deepClone(_draft);
    clearDirty();
    toast('Dataset sauvegardé ✓');
    DOM.topbarName.textContent = _draft.name;

    const idx = _datasets.findIndex(d => d.id === _current.id);
    if (idx !== -1) {
      _datasets[idx] = { ..._datasets[idx], name: _draft.name,
        stage: _draft.stage, embryo: _draft.embryo, configured: true };
    }
    renderList();

    // Silent catalog rebuild
    apiFetch(`${API_DATASETS}?action=rebuild_catalog`, { method: 'POST', body: '{}' });
  } else {
    toast('Erreur lors de la sauvegarde.', 'error');
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
    DOM.btnSetPreview.innerHTML = '<span class="spinner spinner-sm"></span> Enregistrement…';
  }
  
  const data = await apiFetch(
    `${API_DATASETS}?action=save_thumbnail&id=${encodeURIComponent(_current.id)}`,
    {
      method: 'POST',
      body: JSON.stringify({ image: dataUrl })
    }
  );
  
  if (DOM.btnSetPreview) {
    DOM.btnSetPreview.disabled = false;
    DOM.btnSetPreview.innerHTML = '📸 Redéfinir la preview';
  }
  
  if (data?.ok) {
    toast('Preview mise à jour ✓');
    
    // Update the thumbnail in the current state and list
    const timestamp = Date.now();
    const newThumbUrl = `${data.path}?v=${timestamp}`;
    _current.thumbnail = newThumbUrl;
    
    const idx = _datasets.findIndex(d => d.id === _current.id);
    if (idx !== -1) {
      _datasets[idx].thumbnail = newThumbUrl;
    }
    
    // Refresh the list to show the new thumbnail
    renderList();
    
    // Silent catalog rebuild to ensure consistency
    apiFetch(`${API_DATASETS}?action=rebuild_catalog`, { method: 'POST', body: '{}' });
  } else {
    toast(`Erreur lors de l'enregistrement de la preview : ${data?.error || 'Inconnue'}`, 'error');
  }
}

function parseStageNumeric(stage) {
  const m = (stage || '').match(/E(\d+(?:\.\d+)?)/i);
  return m ? parseFloat(m[1]) : null;
}

// ── Rebuild catalog ───────────────────────────────────────────

async function rebuildCatalog() {
  DOM.btnRebuild.disabled = true;
  const prev = DOM.btnRebuild.innerHTML;
  DOM.btnRebuild.innerHTML = '<span class="spinner spinner-sm"></span> Génération…';

  const data = await apiFetch(`${API_DATASETS}?action=rebuild_catalog`,
    { method: 'POST', body: '{}' });

  DOM.btnRebuild.disabled = false;
  DOM.btnRebuild.innerHTML = prev;

  if (data?.ok) {
    const t = new Date().toLocaleTimeString('fr-FR');
    DOM.rebuildStatus.textContent = `✅ ${data.count} datasets — ${t}`;
    toast(`Catalogue régénéré : ${data.count} datasets.`);
  } else {
    DOM.rebuildStatus.textContent = '❌ Erreur lors de la génération.';
    toast('Erreur lors de la génération du catalogue.', 'error');
  }
}

// ── Event listeners ───────────────────────────────────────────

DOM.btnLogin.addEventListener('click', doLogin);
DOM.loginPassword.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
DOM.loginUsername.addEventListener('keydown', e => { if (e.key === 'Enter') DOM.loginPassword.focus(); });
DOM.loginUsername.addEventListener('focus', e => { e.target.style.borderColor = 'var(--adm-accent)'; });
DOM.loginUsername.addEventListener('blur',  e => { e.target.style.borderColor = ''; });
DOM.loginPassword.addEventListener('focus', e => { e.target.style.borderColor = 'var(--adm-accent)'; });
DOM.loginPassword.addEventListener('blur',  e => { e.target.style.borderColor = ''; });

DOM.btnLogout.addEventListener('click', doLogout);
DOM.btnSave.addEventListener('click', saveDataset);
DOM.btnReset.addEventListener('click', resetDataset);
DOM.btnRebuild.addEventListener('click', rebuildCatalog);

// Panel toggle
el('btn-collapse-list')?.addEventListener('click', () => {
  DOM.datasetList.classList.toggle('collapsed');
});

// Search
DOM.datasetSearch.addEventListener('input', e => {
  _searchQuery = e.target.value;
  DOM.searchClear.style.display = _searchQuery ? 'block' : 'none';
  renderList();
});
DOM.searchClear.addEventListener('click', () => {
  _searchQuery = '';
  DOM.datasetSearch.value = '';
  DOM.searchClear.style.display = 'none';
  renderList();
});

// Type filter tabs
document.querySelectorAll('.filter-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    _typeFilter = tab.dataset.type;
    renderList();
  });
});

// Form dirty tracking
[DOM.fName, DOM.fStage, DOM.fEmbryo, DOM.fDescription,
 DOM.fVoxX, DOM.fVoxY, DOM.fVoxZ].forEach(el => {
  if (el) el.addEventListener('input', markDirty);
});

// Exposure slider tracking
if (DOM.fExposure) {
  DOM.fExposure.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value) / 100;
    if (DOM.fExposureVal) DOM.fExposureVal.textContent = `${val.toFixed(2)}×`;
    if (_draft) {
      _draft.exposure = val;
      markDirty();
      schedulePreviewUpdate();
    }
  });
}

// Orientation definition
if (DOM.btnDefineOrientation) {
  DOM.btnDefineOrientation.addEventListener('click', () => {
    if (!_current) return;
    _isCalibratingOrientation = !_isCalibratingOrientation;
    if (_isCalibratingOrientation) {
      DOM.btnDefineOrientation.classList.add('adm-btn-accent');
      DOM.btnDefineOrientation.classList.remove('adm-btn-ghost');
      DOM.btnDefineOrientation.innerHTML = '❌ Annuler l\'orientation';
      if (DOM.orientationStatus) {
        DOM.orientationStatus.textContent = 'Ajustez l\'embryon sur les axes (Puis Sauvegardez)...';
      }
      if (DOM.previewFrame.contentWindow) {
        DOM.previewFrame.contentWindow.postMessage({ type: 'CALIBRATE_ORIENTATION_START' }, '*');
      }
      markDirty(); // Make sure user can save
    } else {
      DOM.btnDefineOrientation.classList.remove('adm-btn-accent');
      DOM.btnDefineOrientation.classList.add('adm-btn-ghost');
      DOM.btnDefineOrientation.innerHTML = '🧭 Définir l\'orientation';
      if (DOM.orientationStatus) {
        DOM.orientationStatus.textContent = _draft?.orientation ? 'Orientation définie ✓' : '(Aucune orientation définie)';
      }
      if (DOM.previewFrame.contentWindow) {
        DOM.previewFrame.contentWindow.postMessage({ type: 'CALIBRATE_ORIENTATION_STOP' }, '*');
      }
    }
  });
}

// Screenshot redefinition
if (DOM.btnSetPreview) {
  DOM.btnSetPreview.addEventListener('click', () => {
    if (!_current) return;
    if (DOM.previewFrame.contentWindow) {
      DOM.btnSetPreview.disabled = true;
      DOM.btnSetPreview.innerHTML = '<span class="spinner spinner-sm"></span> Capturing…';
      DOM.previewFrame.contentWindow.postMessage({ type: 'REQUEST_SCREENSHOT' }, '*');
    }
  });
}

// Ctrl+S
document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveDataset(); }
});

// Warn on close
window.addEventListener('beforeunload', e => {
  if (_dirty) { e.preventDefault(); e.returnValue = ''; }
});

// Listen to Viewer's iframe to sync channel configurations, exposure, and screenshots
window.addEventListener('message', e => {
  // SEC-006: only accept cross-frame messages from this page's own origin
  // (the embedded viewer iframe is same-origin). admpan.js is an ES module and
  // does not load the classic Utils global, so the check is inlined here.
  if (e.origin !== window.location.origin) return;
  if (e.data?.type === 'SYNC_CHANNELS' && e.data.value) {
    if (_draft && _draft.channels) {
      const idx = e.data.channelIndex;
      if (idx !== undefined && _draft.channels[idx]) {
        // Fix bug: map enabled to active for channel persistence
        const isEnabled = e.data.value.enabled !== undefined ? e.data.value.enabled : e.data.value.active;
        _draft.channels[idx].active = isEnabled ?? true;
        _draft.channels[idx].color  = e.data.value.color;
        _draft.channels[idx].min    = e.data.value.min;
        _draft.channels[idx].max    = e.data.value.max;
        _draft.channels[idx].gamma  = e.data.value.gamma;
        _draft.channels[idx].name   = e.data.value.name;
        markDirty();
        // Do not call schedulePreviewUpdate() here, the viewer is already updated!
      }
    }
  }

  if (e.data?.type === 'SYNC_EXPOSURE' && e.data.value !== undefined) {
    if (_draft) {
      _draft.exposure = e.data.value;
      if (DOM.fExposure) {
        DOM.fExposure.value = Math.max(20, Math.min(500, Math.round(e.data.value * 100)));
      }
      if (DOM.fExposureVal) {
        DOM.fExposureVal.textContent = `${e.data.value.toFixed(2)}×`;
      }
      markDirty();
    }
  }

  if (e.data?.type === 'SCREENSHOT_RESPONSE') {
    if (DOM.btnSetPreview) {
      DOM.btnSetPreview.disabled = false;
      DOM.btnSetPreview.innerHTML = '📸 Redéfinir la preview';
    }
    if (e.data.error) {
      toast(`Erreur de capture : ${e.data.error}`, 'error');
    } else if (e.data.dataUrl) {
      saveThumbnail(e.data.dataUrl);
    }
  }
});

// ── Init ──────────────────────────────────────────────────────
checkAuth();
