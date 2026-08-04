/**
 * Admin SPA — dataset import orchestrator
 * =======================================
 * The single owner of an in-flight import. Lives at module scope, so it survives
 * every tab switch in the SPA: the Import tab and the floating dock are just two
 * views onto this state, and closing either one changes nothing about the
 * transfer. Only leaving the page can stop it — which is what the navigation
 * guard in shell.js exists to catch.
 *
 * Division of labour
 * ------------------
 *   this module   folder walk, dataset grouping, planning, ordering, state,
 *                 speed/ETA, pause/resume, publish
 *   upload-worker every byte: slice reads, SHA-256, chunk POSTs (Rule 1.2 — the
 *                 main thread never touches file data, so the 3D preview keeps
 *                 its frame rate while gigabytes stream out)
 *   upload_staging.py / _upload_lib.php   the authority on what is allowed to
 *                 land, what has already landed, and when a dataset may publish
 *
 * Nothing decided here is trusted server-side. The client groups files into
 * datasets and guesses their type because it can cheaply read metadata.json; the
 * server re-derives every one of those claims against its own closed allowlist.
 */

'use strict';

import { API_UPLOAD, apiFetch, apiFetchStatus, getCsrf, t } from './shared.js';

// ── Model ──────────────────────────────────────────────────────────────────────

const PHASE_IDLE = 'idle';
const PHASE_SCANNING = 'scanning';
const PHASE_PLANNING = 'planning';
const PHASE_UPLOADING = 'uploading';
const PHASE_PAUSED = 'paused';
const PHASE_DONE = 'done';

// Dataset states, mirrored from the server (upload_staging.py):
//   uploading — core files missing; not openable, not editable
//   editable  — metadata + manifest + coarsest LOD in; openable at low res
//   staged    — everything in and validated; publishable
//   stalled   — untouched past the grace period; awaiting a re-drop before GC
export const DS_UPLOADING = 'uploading';
export const DS_EDITABLE = 'editable';
export const DS_STAGED = 'staged';
export const DS_STALLED = 'stalled';

const _listeners = new Set();
let _worker = null;

const _state = {
  phase: PHASE_IDLE,
  datasets: [],          // live import model, keyed by `<type>/<folder>`
  staged: [],            // server-side view (includes imports from earlier sessions)
  rejected: [],          // paths refused by the allowlist, across the whole drop
  totalBytes: 0,         // derived from datasets[] — see recomputeTotals()
  sentBytes: 0,          // idem; includes bytes the plan found already stored
  speed: 0,              // bytes/s, smoothed
  etaS: null,
  error: null,
  chunkSize: 8388608,
  parallel: 4,
  backend: null,
  staleAfterS: 604800,
};

export function getState() { return _state; }
export function subscribe(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }
function emit() { _listeners.forEach((fn) => { try { fn(_state); } catch (_) { /* view error */ } }); }

export function isBusy() {
  return _state.phase === PHASE_SCANNING || _state.phase === PHASE_PLANNING
      || _state.phase === PHASE_UPLOADING;
}
export function isPaused() { return _state.phase === PHASE_PAUSED; }
/** True while bytes are in flight OR parked mid-transfer — what the exit guard asks. */
export function hasUnfinishedWork() {
  return isBusy() || (_state.phase === PHASE_PAUSED && _state.sentBytes < _state.totalBytes);
}

// ── Folder walk ────────────────────────────────────────────────────────────────

const MAX_ENTRIES = 400000;

/**
 * Read a dropped DataTransfer into `[{ path, file }]` with paths relative to the
 * drop.
 *
 * webkitGetAsEntry is the only API that survives a *folder* drop in every current
 * browser (showDirectoryPicker is Chromium-only and needs a click, not a drop).
 * The directory reader hands back at most ~100 entries per call, so each
 * directory must be drained in a loop until it returns empty — reading it once
 * silently truncates a dataset to its first 100 packs.
 */
export async function readDataTransfer(dataTransfer) {
  const roots = [];
  const items = Array.from(dataTransfer.items || []);
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) roots.push(entry);
  }
  if (!roots.length) {
    // No directory support (or plain files dropped): fall back to the file list.
    return Array.from(dataTransfer.files || []).map((file) => ({ path: file.name, file }));
  }
  const out = [];
  for (const root of roots) await walkEntry(root, root.name, out);
  return out;
}

async function walkEntry(entry, path, out) {
  if (out.length >= MAX_ENTRIES) return;
  if (entry.isFile) {
    const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
    if (file) out.push({ path, file });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  for (;;) {
    const batch = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
    if (!batch.length) break;      // drained — a single readEntries call caps at ~100
    for (const child of batch) await walkEntry(child, `${path}/${child.name}`, out);
  }
}

/** `<input type="file" webkitdirectory>` → the same shape as readDataTransfer. */
export function readFileInput(fileList) {
  return Array.from(fileList || []).map((file) => ({
    path: file.webkitRelativePath || file.name, file,
  }));
}

// ── Grouping ───────────────────────────────────────────────────────────────────

const TYPES = ['fixed', 'live', 'tracking'];

/**
 * Split a flat file listing into datasets.
 *
 * Every `metadata.json` marks a dataset root, wherever it sits in the tree. That
 * single rule covers all three shapes an operator may drop, which is what makes
 * the import forgiving of how they organise their disk:
 *   DATA_WEB/                 → many datasets across fixed/live/tracking
 *   fixed/                    → many datasets of one type
 *   <dataset>/                → exactly one
 * The dataset TYPE comes from metadata.json itself (parsed here), so a dataset
 * dropped on its own — with no `fixed/` ancestor to name it — is still filed
 * correctly. The parent directory name is only a fallback.
 */
export async function groupIntoDatasets(entries) {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const roots = [];
  for (const { path } of entries) {
    if (!path.endsWith('metadata.json')) continue;
    const parts = path.split('/');
    if (parts[parts.length - 1] !== 'metadata.json') continue;
    roots.push(parts.slice(0, -1).join('/'));
  }
  // Deepest first, so a dataset nested under another candidate root wins its files.
  roots.sort((a, b) => b.split('/').length - a.split('/').length);

  const datasets = [];
  const claimed = new Set();
  for (const root of roots) {
    const prefix = root ? `${root}/` : '';
    const files = entries.filter((e) => e.path.startsWith(prefix) && !claimed.has(e.path));
    if (!files.length) continue;

    const segments = root.split('/').filter(Boolean);
    const folder = segments[segments.length - 1] || '';
    const parentDir = segments.length >= 2 ? segments[segments.length - 2] : '';

    let type = TYPES.includes(parentDir) ? parentDir : null;
    const metaEntry = byPath.get(`${prefix}metadata.json`);
    const meta = metaEntry ? await readJsonFile(metaEntry.file) : null;
    if (meta && TYPES.includes(meta.type)) type = meta.type;
    if (!type) type = 'fixed';   // a single dataset with no type recorded anywhere

    files.forEach((e) => claimed.add(e.path));
    datasets.push({
      type, folder,
      name: (meta && meta.name) || folder,
      stage: meta ? meta.stage || null : null,
      files: files.map((e) => ({ path: e.path.slice(prefix.length), size: e.file.size, file: e.file })),
    });
  }

  const orphans = entries.filter((e) => !claimed.has(e.path)).map((e) => e.path);
  return { datasets, orphans };
}

async function readJsonFile(file) {
  try {
    if (file.size > 8 * 1024 * 1024) return null;
    return JSON.parse(await file.text());
  } catch (_) { return null; }
}

// ── Totals ─────────────────────────────────────────────────────────────────────
// The per-dataset counters are the source of truth and the global figures are
// derived from them. Accumulating a separate global from the worker's own running
// total looked simpler but was wrong the moment a SECOND folder was dropped in the
// same session: the worker's counter spans its whole lifetime while the global
// target is per-import, so the bar read past 100% ("129 Mo / 86 Mo").

function upsertDataset(entry) {
  const i = _state.datasets.findIndex((d) => d.key === entry.key);
  if (i === -1) { _state.datasets.push(entry); return; }
  // A re-drop of a dataset already in the model refreshes the server-derived
  // fields but must never rewind progress this session already made.
  const prev = _state.datasets[i];
  _state.datasets[i] = { ...entry, receivedBytes: Math.max(prev.receivedBytes, entry.receivedBytes) };
}

function recomputeTotals() {
  _state.totalBytes = _state.datasets.reduce((s, d) => s + (d.totalBytes || 0), 0);
  _state.sentBytes = _state.datasets.reduce((s, d) => s + (d.receivedBytes || 0), 0);
}

// ── Import run ─────────────────────────────────────────────────────────────────

/**
 * Plan and start (or resume) an import.
 *
 * Re-dropping a folder after a failure runs this same path: the server's plan
 * answers with the exact chunks still missing, whole files already stored are
 * skipped, and datasets already published are reported so they are not sent
 * again. Nothing about a resume is a special case here.
 */
export async function startImport(entries, options = {}) {
  _state.phase = PHASE_SCANNING;
  _state.error = null;
  emit();

  const limits = await apiFetch(`${API_UPLOAD}?action=limits`);
  if (limits && limits.ok) {
    _state.chunkSize = limits.chunkSize || _state.chunkSize;
    _state.parallel = limits.parallel || _state.parallel;
    _state.backend = limits.backend || null;
    _state.staleAfterS = limits.staleAfterS || _state.staleAfterS;
  }

  const { datasets, orphans } = await groupIntoDatasets(entries);
  if (!datasets.length) {
    _state.phase = PHASE_IDLE;
    _state.error = t('upl.errNoDataset', 'Aucun dataset trouvé : le dossier doit contenir un metadata.json.');
    emit();
    return { ok: false };
  }

  _state.phase = PHASE_PLANNING;
  emit();

  const plan = await apiFetchStatus(`${API_UPLOAD}?action=plan`, {
    method: 'POST',
    body: JSON.stringify({
      chunkSize: _state.chunkSize,
      datasets: datasets.map((d) => ({
        type: d.type, folder: d.folder,
        files: d.files.map((f) => ({ path: f.path, size: f.size })),
      })),
    }),
  });
  if (!plan.ok || !plan.data || !plan.data.ok) {
    _state.phase = PHASE_IDLE;
    _state.error = t('upl.errPlan', 'Le serveur a refusé le plan d\'import.');
    emit();
    return { ok: false };
  }
  _state.chunkSize = plan.data.chunkSize || _state.chunkSize;

  // Merge the server's verdict with the local File handles.
  const jobs = [];
  _state.rejected = orphans.map((p) => ({ path: p, reason: 'outside_dataset' }));

  plan.data.datasets.forEach((pd, dsIndex) => {
    const local = datasets.find((d) => d.type === pd.type && d.folder === pd.folder);
    if (!local || pd.error) {
      _state.rejected.push({ path: `${pd.type}/${pd.folder}`, reason: pd.error || 'unknown' });
      return;
    }
    const fileByPath = new Map(local.files.map((f) => [f.path, f.file]));
    const entry = {
      key: pd.key, type: pd.type, folder: pd.folder, name: local.name,
      state: pd.state, published: pd.published, metaLocked: pd.metaLocked,
      totalBytes: pd.totalBytes, receivedBytes: pd.receivedBytes,
      fileCount: pd.files.length, doneCount: 0, error: null,
      rejected: pd.rejected || [],
    };
    (pd.rejected || []).forEach((r) => _state.rejected.push({ path: `${pd.folder}/${r.path}`, reason: r.reason }));

    // Skipping an already-published dataset is the point of the resume contract:
    // a re-drop after a partial failure must not re-send gigabytes that went live.
    if (pd.published && !options.overwritePublished) {
      entry.state = 'published';
      entry.receivedBytes = entry.totalBytes;
      upsertDataset(entry);
      return;
    }

    pd.files.forEach((pf, fileIndex) => {
      if (pf.done || pf.skip) { entry.doneCount++; return; }
      const file = fileByPath.get(pf.path);
      if (!file) { entry.error = 'missing_local_file'; return; }
      jobs.push({
        ds: pd.key, path: pf.path, file, size: pf.size,
        chunkSize: pf.chunkSize || _state.chunkSize,
        missing: pf.missing, tier: pf.tier ?? 9,
        order: dsIndex * 100000 + fileIndex,
      });
    });
    upsertDataset(entry);
  });

  recomputeTotals();
  _speed.reset(_state.sentBytes);

  if (!jobs.length) {
    _state.phase = PHASE_DONE;
    await refreshStaged();
    emit();
    return { ok: true, nothingToDo: true };
  }

  _state.phase = PHASE_UPLOADING;
  emit();
  ensureWorker();
  _worker.postMessage({ type: 'enqueue', jobs });
  return { ok: true, jobs: jobs.length };
}

// ── Worker plumbing ────────────────────────────────────────────────────────────

// The worker is fetched by URL, not through an HTML <script> tag, so the release
// build's ?v= asset stamper never sees it — and .htaccess caches js/ for a week.
// Carrying this module's OWN stamp across (the stamper does rewrite admin ESM
// specifiers, so import.meta.url ends in ?v=<version> in a release) means a new
// version can never be served the previous version's cached worker.
const WORKER_URL = (() => {
  try { return `js/workers/upload-worker.js${new URL(import.meta.url).search}`; }
  catch (_) { return 'js/workers/upload-worker.js'; }
})();

// The endpoint handed to the worker MUST be absolute. A relative URL inside a
// Worker resolves against the WORKER SCRIPT's location, not the document — so
// 'api/upload.php' would become '/js/workers/api/upload.php' and every chunk
// would 404. Resolving against document.baseURI here also keeps a subdirectory
// install (https://host/lumen/) correct.
const ENDPOINT_URL = (() => {
  try { return new URL(API_UPLOAD, document.baseURI).href; }
  catch (_) { return `${location.origin}/${API_UPLOAD}`; }
})();

function workerConfig() {
  return { type: 'config', endpoint: ENDPOINT_URL, csrf: getCsrf(), parallel: _state.parallel };
}

function ensureWorker() {
  if (_worker) {
    _worker.postMessage(workerConfig());
    return _worker;
  }
  _worker = new Worker(WORKER_URL);
  _worker.onmessage = onWorkerMessage;
  _worker.onerror = (e) => {
    _state.error = `worker: ${e.message || 'error'}`;
    _state.phase = PHASE_IDLE;
    emit();
  };
  _worker.postMessage(workerConfig());
  return _worker;
}

async function onWorkerMessage(e) {
  const msg = e.data || {};
  switch (msg.type) {
    case 'progress':
      // msg.perDataset holds DELTAS since the last flush, never running totals.
      Object.entries(msg.perDataset || {}).forEach(([key, bytes]) => {
        const ds = _state.datasets.find((d) => d.key === key);
        if (ds) ds.receivedBytes = Math.min(ds.totalBytes, ds.receivedBytes + bytes);
      });
      recomputeTotals();
      _speed.sample(_state.sentBytes, msg.at);
      _state.speed = _speed.value();
      _state.etaS = _speed.eta(_state.totalBytes - _state.sentBytes);
      emit();
      break;

    case 'file-done': {
      const ds = _state.datasets.find((d) => d.key === msg.ds);
      if (ds) {
        ds.doneCount++;
        if (msg.state) ds.state = msg.state;
        // The moment the coarse LOD lands the dataset becomes openable; tell the
        // views immediately so the operator can start editing without waiting.
        emit();
      }
      break;
    }

    case 'file-error': {
      const ds = _state.datasets.find((d) => d.key === msg.ds);
      if (ds) ds.error = msg.reason;
      _state.error = t('upl.errFile', 'Échec sur {path} ({reason}).', { path: msg.path, reason: msg.reason });
      emit();
      break;
    }

    case 'chunk-too-large':
      // A PHP host refused our chunk size. Shrink and re-plan; the already-stored
      // chunks stay valid because the server keys resume on the file's OWN
      // recorded chunk size, not on whatever the client is using now.
      _state.chunkSize = Math.max(262144, Math.floor((msg.maxChunkSize || _state.chunkSize / 2)));
      _state.error = t('upl.errChunkSize', 'Taille de bloc réduite à {n} — relancez le dossier pour reprendre.',
                       { n: formatBytes(_state.chunkSize) });
      emit();
      break;

    case 'fatal':
      _state.error = msg.reason === 'unauthorized'
        ? t('upl.errAuth', 'Session expirée — reconnectez-vous puis reglissez le dossier.')
        : msg.reason;
      _state.phase = PHASE_IDLE;
      emit();
      break;

    case 'idle':
      if (_state.phase === PHASE_UPLOADING) {
        _state.phase = PHASE_DONE;
        _state.speed = 0;
        _state.etaS = null;
        await refreshStaged();
        emit();
      }
      break;

    default:
      break;
  }
}

// ── Controls ───────────────────────────────────────────────────────────────────

export function pause() {
  if (!_worker || _state.phase !== PHASE_UPLOADING) return;
  _worker.postMessage({ type: 'pause' });
  _state.phase = PHASE_PAUSED;
  _state.speed = 0;
  _state.etaS = null;
  emit();
}

export function resume() {
  if (!_worker || _state.phase !== PHASE_PAUSED) return;
  _worker.postMessage({ type: 'resume' });
  _state.phase = PHASE_UPLOADING;
  _speed.reset(_state.sentBytes);
  emit();
}

export function cancelAll() {
  if (_worker) _worker.postMessage({ type: 'abort' });
  _state.phase = PHASE_IDLE;
  _state.datasets = [];
  recomputeTotals();
  _state.speed = 0;
  _state.etaS = null;
  emit();
}

/** Stop sending a dataset and delete what has already been staged for it. */
export async function discard(key) {
  if (_worker) _worker.postMessage({ type: 'drop', ds: key });
  const r = await apiFetchStatus(`${API_UPLOAD}?action=discard&ds=${encodeURIComponent(key)}`,
    { method: 'POST', body: '{}' });
  _state.datasets = _state.datasets.filter((d) => d.key !== key);
  recomputeTotals();
  await refreshStaged();
  emit();
  return r.ok;
}

export async function validate(key) {
  return apiFetch(`${API_UPLOAD}?action=validate&ds=${encodeURIComponent(key)}`);
}

/** Move a validated staged dataset into DATA_WEB. Published hidden by default. */
export async function publish(key, { overwrite = false, hidden = true } = {}) {
  const r = await apiFetchStatus(`${API_UPLOAD}?action=publish&ds=${encodeURIComponent(key)}`,
    { method: 'POST', body: JSON.stringify({ overwrite, hidden }) });
  if (r.ok && r.data?.ok) {
    const ds = _state.datasets.find((d) => d.key === key);
    if (ds) ds.state = 'published';
  }
  await refreshStaged();
  emit();
  return r;
}

export async function refreshStaged() {
  const data = await apiFetch(`${API_UPLOAD}?action=list`);
  _state.staged = (data && Array.isArray(data.datasets)) ? data.datasets : [];
  // Fold the server's view back into any live entry so a dataset that finished
  // while the tab was elsewhere shows the right state.
  _state.staged.forEach((s) => {
    const ds = _state.datasets.find((d) => d.key === s.key);
    if (ds && ds.state !== 'published') ds.state = s.state;
  });
  emit();
  return _state.staged;
}

// ── Speed / ETA ────────────────────────────────────────────────────────────────
// Exponentially-weighted average over the last samples. A raw instantaneous rate
// swings wildly between an 8 MiB pack and a 3 KB manifest, and a cumulative
// average never reacts to a link that just slowed down; the EWMA reads steady
// while still tracking a real change within a few seconds.

const _speed = (() => {
  let lastBytes = 0, lastAt = 0, ewma = 0;
  const ALPHA = 0.25;
  return {
    reset(bytes) { lastBytes = bytes; lastAt = Date.now(); ewma = 0; },
    sample(bytes, at) {
      const now = at || Date.now();
      const dt = (now - lastAt) / 1000;
      if (dt <= 0.05) return;
      const rate = (bytes - lastBytes) / dt;
      ewma = ewma ? (ALPHA * rate + (1 - ALPHA) * ewma) : rate;
      lastBytes = bytes;
      lastAt = now;
    },
    value() { return Math.max(0, ewma); },
    eta(remaining) {
      if (ewma <= 0 || remaining <= 0) return null;
      return Math.round(remaining / ewma);
    },
  };
})();

// ── Formatting (shared by both views) ──────────────────────────────────────────

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatSpeed(bytesPerS) {
  if (!bytesPerS) return '—';
  return `${formatBytes(bytesPerS)}/s`;
}

export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return `${m} min ${String(rs).padStart(2, '0')} s`;
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return `${h} h ${String(rm).padStart(2, '0')} min`;
  return `${Math.floor(h / 24)} j ${h % 24} h`;
}
