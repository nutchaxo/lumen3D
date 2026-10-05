/**
 * Admin SPA — Data updates (dataset migrations)
 * =============================================
 * Brings published datasets up to the platform's current data format, like a software
 * update: every dataset carries a `formatVersion`, the server lists the migrations each
 * one still needs, and this tab applies them — one dataset after another, each dataset's
 * migrations in order — with either executor (DOCS/dataset-migrations/SPEC.md §6, §9):
 *
 *   A. this browser: js/workers/migration-worker.js range-reads the bricks, re-cuts and
 *      re-encodes them and uploads the result unit by unit;
 *   B. the server: the tab drives a loop of bounded `unit_run` calls.
 *
 * Both write the same server journal, so a job survives a reload, a pause, an executor
 * switch. The tab must stay open either way (a shared host has no background worker):
 * leaving it, or closing the page, pauses the job.
 *
 * Generic: nothing below knows a particular migration — titles and descriptions come from
 * the registry the server returns, and the worker loads js/migrations/<id>.js by id.
 */

'use strict';

import { Utils, I18n, t as _t, escHtml, apiFetchStatus, getCsrf, toast, el, refreshIcons, storageGet, storageSet } from './shared.js';
import {
  API_MIGRATIONS, createApi, Runner, WorkerPool, buildQueue, migrationChain,
  remainingUnits, estimateSeconds, benchBrowser, benchServer,
} from './migration-runner.js';

const V = (() => { try { return new URL(import.meta.url).search; } catch (_) { return ''; } })();
const TAB_ID = 'dataset-updates';
const LOG_KEY = 'lumen-dupd-log';
const EXEC_KEY = 'lumen-dupd-executor';
const LOG_MAX = 50;

// The English fallback must interpolate too: a key missing from lang/*.json still has to read
// "3 to update", not "{n} to update".
function t(key, def, params) {
  const s = _t(key, def, params);
  return params ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : s;
}

const api = createApi((url, init) => apiFetchStatus(url, init));

let _status = null;
let _loading = false;
let _loadError = null;
let _runner = null;
let _progress = null;      // last progress event
let _online = true;
let _bench = { browser: null, server: null, running: null, error: null, dataset: null, n: 4 };
let _paintTimer = null;
let _guardsBound = false;

// ── Formatting ────────────────────────────────────────────────────────────────

function fmtMB(bytes) {
  const mb = (bytes || 0) / (1024 * 1024);
  return `${mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)} ${t('dupd.unitMB', 'MB')}`;
}

function fmtDuration(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return t('dupd.durHM', '{h} h {m} min', { h, m });
  if (m) return t('dupd.durMS', '{m} min {s} s', { m, s });
  return t('dupd.durS', '{s} s', { s });
}

function lang() {
  try { return (I18n && I18n.getLanguage && I18n.getLanguage()) || 'en'; } catch (_) { return 'en'; }
}

function loc(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  return v[lang()] || v.en || Object.values(v)[0] || '';
}

function typeLabel(type) {
  try { return Utils && Utils.datasetTypeLabel ? Utils.datasetTypeLabel(type) : type; } catch (_) { return type; }
}

function migration(id) {
  return ((_status && _status.migrations) || []).find((m) => m.id === id) || null;
}

function dsById(id) {
  return ((_status && _status.datasets) || []).find((d) => d.id === id) || null;
}

function needsWork(ds) {
  return migrationChain(ds, (_status && _status.migrations) || []).length > 0;
}

const REASONS = {
  no_webp_decode: () => t('dupd.reasonWebp', 'the server cannot decode lossless WebP images'),
  no_zlib: () => t('dupd.reasonZlib', 'the server has no zlib compression'),
  low_memory: () => t('dupd.reasonMemory', 'the server allows less than 128 MiB of memory per request'),
  exec_time_too_short: () => t('dupd.reasonTime', 'the server stops requests after less than 10 seconds'),
};
function reasonText(code) { return (REASONS[code] || (() => code))(); }

const ERRORS = {
  source_changed: () => t('dupd.errSourceChanged', 'the dataset was re-processed since the update started'),
  brick_undecodable: () => t('dupd.errBrick', 'a brick could not be decoded'),
  incomplete: () => t('dupd.errIncomplete', 'some units are not done yet'),
  no_progress: () => t('dupd.errNoProgress', 'the server made no progress'),
  request_failed: () => t('dupd.errRequest', 'a request keeps failing'),
  prepare_failed: () => t('dupd.errPrepare', 'the dataset could not be read'),
  unauthorized: () => t('dupd.reasonAuth', 'session expired'),
  insufficient_disk: () => t('dupd.errDisk', 'not enough disk space on the server (needed / free)'),
};
/** A server/worker error code in words, with its detail when there is one. */
function errorText(code, detail) {
  const base = code ? (ERRORS[code] ? ERRORS[code]() : code) : '';
  if (detail && detail !== base) return base ? `${base} (${detail})` : String(detail);
  return base || t('dupd.errUnknown', 'unknown error');
}
function dsName(ds) { return (ds && (ds.name || ds.folder || ds.id)) || ''; }
function nameOf(id) { return dsName(dsById(id)) || id; }

// ── Log (per-viewer convenience) ──────────────────────────────────────────────

function readLog() {
  try { const v = JSON.parse(storageGet(LOG_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; }
}
function pushLog(entry) {
  const log = readLog();
  log.unshift({ at: new Date().toISOString(), ...entry });
  storageSet(LOG_KEY, JSON.stringify(log.slice(0, LOG_MAX)));
}

// ── Runner ────────────────────────────────────────────────────────────────────

function absUrl(rel) { return new URL(rel, document.baseURI).href; }

function datasetBase(id) {
  const ds = dsById(id);
  const type = ds ? ds.type : String(id).split('/')[0];
  const folder = ds ? ds.folder : String(id).split('/').slice(1).join('/');
  return absUrl(`DATA_WEB/${encodeURIComponent(type)}/${encodeURIComponent(folder)}/`);
}

function poolOptions() {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return {
    // Each unit holds ≈ 16 MiB of planes plus its compressed bricks and tiles: four in
    // flight stay well under 200 MiB while keeping both the link and two cores busy.
    workers: Math.max(1, Math.min(2, Math.floor(cores / 2))),
    slots: 2,
    endpoint: absUrl(API_MIGRATIONS),
    csrf: () => getCsrf(),
    spawn: () => new Worker(absUrl(`js/workers/migration-worker.js${V}`)),
    onNet: (online) => { _online = online; schedulePaint(); },
  };
}

function runner() {
  if (_runner) return _runner;
  _runner = new Runner({
    api,
    pool: () => new WorkerPool(poolOptions()),
    datasetBase,
    onEvent: onRunnerEvent,
  });
  const saved = storageGet(EXEC_KEY);
  if (saved === 'server' || saved === 'browser') _runner.executor = saved;
  return _runner;
}

function isRunning() { return !!_runner && (_runner.state === 'running' || _runner.state === 'pausing'); }

function onRunnerEvent(e) {
  if (e.type === 'progress') { _progress = e; schedulePaint(); return; }
  if (e.type === 'net') { _online = !!e.online; schedulePaint(); return; }
  if (e.type === 'job_done') {
    pushLog({ ok: true, dataset: e.dataset, name: nameOf(e.dataset), migration: e.migration, executor: e.executor, seconds: e.seconds, units: e.units, bytesIn: e.bytesIn, bytesOut: e.bytesOut, formatVersion: e.formatVersion });
    _progress = null;
    toast(t('dupd.toastDone', '{name} updated to format {v}', { name: nameOf(e.dataset), v: e.formatVersion }), 'success');
    load();
    return;
  }
  if (e.type === 'job_failed') {
    pushLog({ ok: false, dataset: e.dataset, name: nameOf(e.dataset), migration: e.migration, error: e.error, code: e.code, detail: e.detail });
    _progress = null;
    toast(t('dupd.toastFailed', 'Update of {name} failed: {error}', { name: nameOf(e.dataset), error: e.code ? errorText(e.code, e.detail) : e.error }), 'error');
    load();
    return;
  }
  if (e.type === 'state') {
    if (e.state === 'paused' && e.reason === 'unauthorized') {
      toast(t('dupd.toastSession', 'Session expired — sign in again, then resume.'), 'warning');
      // A 401 seen by a worker never reaches the shell's handler: this status read does,
      // and brings up the sign-in card.
      load();
    }
    if (e.state === 'idle') { _progress = null; load(); }
    paint();
  }
}

function setExecutor(x) {
  const r = runner();
  if (x === 'server' && !(_status && _status.server && _status.server.available)) return;
  r.executor = x;
  storageSet(EXEC_KEY, x);
  // A running job switches at its next unit boundary: pause, then resume on the new executor.
  if (isRunning()) {
    r.pause('switch');
    // Only while the pause settles: a queue that ends meanwhile (idle) or a resume from
    // elsewhere must not leave this polling forever.
    const wait = () => {
      if (r.state === 'paused' && r.reason === 'switch') r.resume();
      else if (r.state === 'pausing') setTimeout(wait, 150);
    };
    wait();
  }
  paint();
}

function updateDatasets(ids) {
  if (!_status) return;
  const items = buildQueue(_status.datasets, _status.migrations, ids);
  if (!items.length) { toast(t('dupd.nothing', 'Everything is up to date.'), 'info'); return; }
  runner().enqueue(items);
  bindGuards();
  paint();
}

async function retryDataset(id) {
  const ds = dsById(id);
  if (ds && ds.job && ds.job.state === 'failed') {
    // A failed journal (source changed, assembly error) is not resumable: start afresh.
    const r = await api.cancel(id, ds.job.migration);
    if (!r.ok) { toast(t('dupd.cancelFailed', 'Could not discard the job.'), 'error'); return; }
    await load();
  }
  updateDatasets([id]);
}

async function cancelDataset(id) {
  const ds = dsById(id);
  if (!confirm(t('dupd.confirmCancel', 'Discard the progress of this update? The dataset stays as it was.'))) return;
  const r = runner();
  if (r.current && r.current.dataset === id) {
    const res = await r.cancelCurrent();
    if (res && !res.ok) toast(t('dupd.cancelFailed', 'Could not discard the job.'), 'error');
  } else {
    r.queue = r.queue.filter((q) => q.dataset !== id);
    if (ds && ds.job) {
      const res = await api.cancel(id, ds.job.migration);
      if (!res.ok) toast(t('dupd.cancelFailed', 'Could not discard the job.'), 'error');
    }
  }
  await load();
}

// ── Benchmark ─────────────────────────────────────────────────────────────────

function defaultBenchDataset() {
  const pending = ((_status && _status.datasets) || []).filter(needsWork);
  pending.sort((a, b) => (remainingUnits(a) || Infinity) - (remainingUnits(b) || Infinity));
  return pending[0] ? pending[0].id : null;
}

async function runBench(which) {
  const id = _bench.dataset || defaultBenchDataset();
  if (!id || _bench.running) return;
  const ds = dsById(id);
  const mig = ds && migrationChain(ds, _status.migrations)[0];
  if (!mig) return;
  _bench.running = which;
  _bench.error = null;
  paint();
  try {
    if (which === 'browser') {
      const pool = new WorkerPool(poolOptions());
      try {
        _bench.browser = await benchBrowser({ pool, dataset: id, migration: mig, datasetBase: datasetBase(id), n: _bench.n });
      } finally { pool.terminate(); }
    } else {
      _bench.server = await benchServer({ api, dataset: id, n: _bench.n });
    }
  } catch (err) {
    _bench.error = String(err && err.message || err);
  }
  _bench.running = null;
  paint();
}

// ── Guards: leaving the tab or the page pauses a running job ──────────────────

function bindGuards() {
  if (_guardsBound) return;
  _guardsBound = true;
  window.addEventListener('beforeunload', (e) => {
    if (!isRunning()) return;
    // The browser shows its own prompt; the job pauses either way (the journal keeps it).
    _runner.pauseNow('unload');
    e.preventDefault();
    e.returnValue = '';
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.adm-nav-item[data-tab]');
    if (!b || b.dataset.tab === TAB_ID || !isRunning()) return;
    if (!document.querySelector(`.adm-tabpanel.active[data-tab="${TAB_ID}"]`)) return;
    if (!confirm(t('dupd.leaveConfirm', 'An update is running. Leaving this tab pauses it (you can resume later). Leave?'))) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    _runner.pause('left_tab');
  }, true);
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function schedulePaint() {
  if (_paintTimer) return;
  // A timer, not requestAnimationFrame: a hidden tab must still record progress.
  _paintTimer = setTimeout(() => { _paintTimer = null; paintProgress(); }, 200);
}

function root() { return el('dataset-updates-root'); }

function serverPanel() {
  const s = (_status && _status.server) || {};
  if (s.available) {
    const lim = s.maxRunSeconds ? ' ' + t('dupd.serverSlice', '(steps of {s} s)', { s: s.maxRunSeconds }) : '';
    return `<p class="dupd-cap dupd-cap--ok"><i data-lucide="check-circle-2"></i>${escHtml(t('dupd.serverOk', 'The server can run updates itself.') + lim)}</p>`;
  }
  const reasons = (s.reasons || []).map((c) => `<li>${escHtml(reasonText(c))}</li>`).join('');
  return `<div class="dupd-cap dupd-cap--no"><i data-lucide="info"></i><div>
    <p>${escHtml(t('dupd.serverNo', 'The server cannot run updates itself:'))}</p>
    <ul>${reasons || `<li>${escHtml(t('dupd.reasonUnknown', 'capability check unavailable'))}</li>`}</ul>
    ${s.detail ? `<p class="adm-muted dupd-small">${escHtml(s.detail)}</p>` : ''}</div></div>`;
}

function executorPicker() {
  const r = runner();
  const avail = !!(_status && _status.server && _status.server.available);
  const why = avail ? '' : (((_status && _status.server && _status.server.reasons) || []).map(reasonText).join('; ')
    || t('dupd.reasonUnknown', 'capability check unavailable'));
  const opt = (val, title, sub, disabled) => `
    <label class="dupd-exec ${r.executor === val ? 'is-on' : ''} ${disabled ? 'is-off' : ''}">
      <input type="radio" name="dupd-exec" value="${val}" ${r.executor === val ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      <span><b>${escHtml(title)}</b><em>${escHtml(sub)}</em></span>
    </label>`;
  return `<div class="dupd-execs" role="radiogroup" aria-label="${escHtml(t('dupd.executor', 'Executor'))}">
    ${opt('browser', t('dupd.execBrowser', 'A · This browser'), t('dupd.execBrowserSub', 'Downloads the data, converts it here and uploads the result. Keep this tab open.'), false)}
    ${opt('server', t('dupd.execServer', 'B · The server'), avail
      ? t('dupd.execServerSub', 'The server converts the data in short steps driven by this tab. Keep this tab open.')
      : t('dupd.execServerOff', 'Unavailable: {why}', { why }), !avail)}
  </div>`;
}

function benchCard() {
  const list = ((_status && _status.datasets) || []).filter(needsWork);
  const sel = _bench.dataset || defaultBenchDataset();
  const avail = !!(_status && _status.server && _status.server.available);
  const res = (r) => r && r.secondsPerUnit
    ? t('dupd.benchRes', '{s} s per unit · {in} in · {out} out ({n} units)', {
      s: r.secondsPerUnit.toFixed(2), in: fmtMB(r.bytesIn), out: fmtMB(r.bytesOut), n: r.units })
    : '—';
  let est = '';
  if ((_bench.browser && _bench.browser.secondsPerUnit) || (_bench.server && _bench.server.secondsPerUnit)) {
    let totB = 0, totS = 0;
    const rows = list.map((d) => {
      const u = remainingUnits(d);
      const b = estimateSeconds(u, _bench.browser && _bench.browser.secondsPerUnit);
      const s = estimateSeconds(u, _bench.server && _bench.server.secondsPerUnit);
      totB += b || 0; totS += s || 0;
      return `<tr><td>${escHtml(dsName(d))}</td><td class="num">${u}</td><td class="num">${fmtDuration(b)}</td><td class="num">${fmtDuration(s)}</td></tr>`;
    }).join('');
    est = `<table class="dupd-table dupd-est">
      <thead><tr><th>${escHtml(t('dupd.colDataset', 'Dataset'))}</th><th class="num">${escHtml(t('dupd.colUnits', 'Units'))}</th>
      <th class="num">${escHtml(t('dupd.colEtaBrowser', 'Browser'))}</th><th class="num">${escHtml(t('dupd.colEtaServer', 'Server'))}</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td>${escHtml(t('dupd.total', 'Total'))}</td><td></td><td class="num">${_bench.browser ? fmtDuration(totB) : '—'}</td><td class="num">${_bench.server ? fmtDuration(totS) : '—'}</td></tr></tfoot>
    </table>
    <p class="adm-muted dupd-small">${escHtml(t('dupd.benchNote', 'Estimates only: either executor can be chosen freely.'))}</p>`;
  }
  return `<div class="adm-card dupd-card">
    <div class="adm-card-head"><i data-lucide="gauge"></i><span>${escHtml(t('dupd.benchTitle', 'Benchmark'))}</span></div>
    <div class="adm-card-body">
      <div class="dupd-row">
        <label class="adm-field-label" for="dupd-bench-ds">${escHtml(t('dupd.benchOn', 'Sample dataset'))}</label>
        <select id="dupd-bench-ds" class="adm-field-input" ${list.length ? '' : 'disabled'}>
          ${list.map((d) => `<option value="${escHtml(d.id)}" ${d.id === sel ? 'selected' : ''}>${escHtml(dsName(d))}</option>`).join('')}
        </select>
        <label class="adm-field-label" for="dupd-bench-n">${escHtml(t('dupd.benchUnits', 'Units'))}</label>
        <input id="dupd-bench-n" class="adm-field-input dupd-n" type="number" min="1" max="8" value="${_bench.n}">
      </div>
      <div class="dupd-row">
        <button class="adm-btn adm-btn-ghost adm-btn-sm" data-dupd="bench-browser" ${!sel || _bench.running || isRunning() ? 'disabled' : ''}>
          ${_bench.running === 'browser' ? '<span class="spinner spinner-sm"></span>' : '<i data-lucide="monitor"></i>'} ${escHtml(t('dupd.benchBrowser', 'Test the browser'))}</button>
        <span class="dupd-bench-res">${escHtml(res(_bench.browser))}</span>
      </div>
      <div class="dupd-row">
        <button class="adm-btn adm-btn-ghost adm-btn-sm" data-dupd="bench-server" ${!sel || !avail || _bench.running || isRunning() ? 'disabled' : ''}>
          ${_bench.running === 'server' ? '<span class="spinner spinner-sm"></span>' : '<i data-lucide="server"></i>'} ${escHtml(t('dupd.benchServer', 'Test the server'))}</button>
        <span class="dupd-bench-res">${escHtml(avail ? res(_bench.server) : t('dupd.benchServerOff', 'server executor unavailable'))}</span>
      </div>
      ${_bench.error ? `<p class="adm-error dupd-small">${escHtml(_bench.error)}</p>` : ''}
      ${est}
    </div>
  </div>`;
}

function jobCell(ds) {
  const r = _runner;
  const cur = r && r.current && r.current.dataset === ds.id ? _progress : null;
  if (cur) {
    const pct = cur.total ? Math.floor((100 * cur.done) / cur.total) : 0;
    const label = r.state === 'running' ? t('dupd.stRunning', 'running')
      : r.state === 'pausing' ? t('dupd.stPausing', 'pausing…') : t('dupd.stPaused', 'paused');
    return `<span class="adm-tag">${escHtml(label)} ${pct} %</span>`;
  }
  if (r && r.queue.some((q) => q.dataset === ds.id)) return `<span class="adm-tag">${escHtml(t('dupd.stQueued', 'queued'))}</span>`;
  const j = ds.job;
  if (!j) return '';
  if (j.state === 'failed') return `<span class="adm-tag adm-tag-danger">${escHtml(t('dupd.stFailed', 'failed'))}</span> <span class="adm-muted dupd-small">${escHtml(errorText(j.error, j.detail))}</span>`;
  if (j.state === 'assembling') return `<span class="adm-tag adm-tag-warn">${escHtml(t('dupd.stAssembling', 'assembling'))}</span>`;
  const pct = j.total ? Math.floor((100 * (j.done || 0)) / j.total) : 0;
  return `<span class="adm-tag adm-tag-warn">${escHtml(t('dupd.stPaused', 'paused'))} ${pct} % (${j.done || 0}/${j.total || 0})</span>`;
}

function rowActions(ds) {
  const r = _runner;
  const active = r && ((r.current && r.current.dataset === ds.id) || r.queue.some((q) => q.dataset === ds.id));
  const out = [];
  if (!active && needsWork(ds)) {
    if (ds.job && ds.job.state === 'failed') out.push(`<button class="adm-btn adm-btn-ghost adm-btn-sm" data-dupd="retry" data-id="${escHtml(ds.id)}"><i data-lucide="rotate-ccw"></i> ${escHtml(t('dupd.retry', 'Retry'))}</button>`);
    else if (ds.job) out.push(`<button class="adm-btn adm-btn-accent adm-btn-sm" data-dupd="update" data-id="${escHtml(ds.id)}"><i data-lucide="play"></i> ${escHtml(t('dupd.resume', 'Resume'))}</button>`);
    else if (ds.repair && !(ds.pending || []).length) out.push(`<button class="adm-btn adm-btn-accent adm-btn-sm" data-dupd="update" data-id="${escHtml(ds.id)}"><i data-lucide="wrench"></i> ${escHtml(t('dupd.repairBtn', 'Repair'))}</button>`);
    else out.push(`<button class="adm-btn adm-btn-accent adm-btn-sm" data-dupd="update" data-id="${escHtml(ds.id)}"><i data-lucide="download"></i> ${escHtml(t('dupd.update', 'Update'))}</button>`);
  }
  if (ds.job || active) out.push(`<button class="adm-btn adm-btn-ghost adm-btn-sm" data-dupd="cancel" data-id="${escHtml(ds.id)}" title="${escHtml(t('dupd.cancel', 'Cancel'))}" aria-label="${escHtml(t('dupd.cancel', 'Cancel'))}"><i data-lucide="x"></i></button>`);
  return out.join(' ');
}

function datasetsCard() {
  const list = (_status && _status.datasets) || [];
  const pendingCount = list.filter(needsWork).length;
  const rows = list.map((ds) => {
    const chain = migrationChain(ds, _status.migrations);
    const what = chain.length
      ? chain.map((id) => escHtml(loc(migration(id) && migration(id).title) || id)).join('<br>')
        + (ds.repair && !(ds.pending || []).length ? ` <span class="adm-tag adm-tag-warn">${escHtml(t('dupd.repair', 'repair'))}</span>` : '')
      : `<span class="adm-ok">${escHtml(t('dupd.upToDate', 'up to date'))}</span>`;
    const est = chain.length && ds.estimate
      ? `${remainingUnits(ds)} · ${fmtMB(ds.estimate.bytes)}`
      : '';
    return `<tr>
      <td><span class="dupd-name">${escHtml(dsName(ds))}</span><span class="adm-muted dupd-small">${escHtml(typeLabel(ds.type))}${ds.trees > 1 ? ' · ' + escHtml(t('dupd.trees', '{n} timepoints', { n: ds.trees })) : ''}</span>
        ${ds.problem ? `<span class="dupd-problem adm-warn dupd-small">${escHtml(errorText(ds.problem, ds.problemDetail))}</span>` : ''}</td>
      <td class="num">${escHtml(String(ds.formatVersion || 1))}</td>
      <td>${what}</td>
      <td class="num">${est}</td>
      <td>${jobCell(ds)}</td>
      <td class="dupd-actions">${rowActions(ds)}</td>
    </tr>`;
  }).join('');
  return `<div class="adm-card dupd-card">
    <div class="adm-card-head"><i data-lucide="database"></i><span>${escHtml(t('dupd.datasets', 'Datasets'))}</span>
      <span class="adm-card-count">${escHtml(t('dupd.pendingCount', '{n} to update', { n: pendingCount }))}</span></div>
    <div class="adm-card-body dupd-scroll">
      ${list.length ? `<table class="dupd-table">
        <thead><tr><th>${escHtml(t('dupd.colDataset', 'Dataset'))}</th><th class="num">${escHtml(t('dupd.colVersion', 'Format'))}</th>
        <th>${escHtml(t('dupd.colPending', 'Pending'))}</th><th class="num">${escHtml(t('dupd.colEstimate', 'Units · size'))}</th>
        <th>${escHtml(t('dupd.colJob', 'Job'))}</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table>` : `<p class="adm-muted">${escHtml(t('dupd.noDatasets', 'No published volume dataset.'))}</p>`}
    </div>
  </div>`;
}

function progressCard() {
  return `<div class="adm-card dupd-card" id="dupd-progress-card">
    <div class="adm-card-head"><i data-lucide="activity"></i><span>${escHtml(t('dupd.progressTitle', 'Current update'))}</span>
      <span class="adm-card-count" id="dupd-state"></span></div>
    <div class="adm-card-body" id="dupd-progress-body"></div>
  </div>`;
}

function stateText() {
  const r = _runner;
  if (!r) return t('dupd.stIdle', 'idle');
  const reason = r.reason === 'left_tab' ? t('dupd.reasonLeft', 'you left the tab')
    : r.reason === 'unload' ? t('dupd.reasonUnload', 'the page was closing')
      : r.reason === 'unauthorized' ? t('dupd.reasonAuth', 'session expired')
        : r.reason === 'offline' ? t('dupd.reasonOffline', 'the server could not be reached') : '';
  const map = {
    idle: t('dupd.stIdle', 'idle'), running: t('dupd.stRunning', 'running'), pausing: t('dupd.stPausing', 'pausing…'),
    paused: t('dupd.stPaused', 'paused'), failed: t('dupd.stFailed', 'failed'),
  };
  return (map[r.state] || r.state) + (reason && r.state === 'paused' ? ` (${reason})` : '');
}

function paintProgress() {
  const body = el('dupd-progress-body');
  const st = el('dupd-state');
  if (st) st.textContent = stateText();
  if (!body) return;
  const r = _runner;
  const p = _progress;
  const controls = [];
  if (r && (r.state === 'running')) controls.push(`<button class="adm-btn adm-btn-ghost adm-btn-sm" data-dupd="pause"><i data-lucide="pause"></i> ${escHtml(t('dupd.pause', 'Pause'))}</button>`);
  if (r && (r.state === 'paused' || r.state === 'failed') && r.queue.length) controls.push(`<button class="adm-btn adm-btn-accent adm-btn-sm" data-dupd="resume"><i data-lucide="play"></i> ${escHtml(t('dupd.resume', 'Resume'))}</button>`);
  if (r && r.queue.length > 1) controls.push(`<span class="adm-muted dupd-small">${escHtml(t('dupd.queued', '{n} more in the queue', { n: r.queue.length - 1 }))}</span>`);
  if (!p) {
    body.innerHTML = `<p class="adm-muted">${escHtml(r && r.queue.length ? t('dupd.waiting', 'Waiting…') : t('dupd.noJob', 'No update running.'))}</p>
      <div class="dupd-row">${controls.join(' ')}</div>`;
    refreshIcons(body);
    return;
  }
  const pct = p.total ? (100 * p.done) / p.total : 0;
  const mig = migration(p.migration);
  const eta = p.phase !== 'finalizing' ? fmtDuration(p.eta)
    : (p.assembly && p.assembly.planes
      ? t('dupd.assembling', 'Assembling planes {x}/{y}', { x: p.assembly.written, y: p.assembly.planes })
      : t('dupd.finalizing', 'assembling and publishing…'));
  body.innerHTML = `
    <p class="dupd-job-title"><b>${escHtml(nameOf(p.dataset))}</b> — ${escHtml(loc(mig && mig.title) || p.migration)}
      <span class="adm-muted">· ${escHtml(p.executor === 'server' ? t('dupd.execServerShort', 'server') : t('dupd.execBrowserShort', 'browser'))}</span></p>
    <div class="adm-progress" role="progressbar" aria-label="${escHtml(t('dupd.units', 'Units'))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct.toFixed(1)}"><div class="adm-progress-bar" id="dupd-bar"></div></div>
    <dl class="dupd-stats">
      <div><dt>${escHtml(t('dupd.units', 'Units'))}</dt><dd>${p.done} / ${p.total} (${pct.toFixed(1)} %)</dd></div>
      <div><dt>${escHtml(t('dupd.down', 'Downloaded'))}</dt><dd>${fmtMB(p.bytesIn)}</dd></div>
      <div><dt>${escHtml(p.executor === 'server' ? t('dupd.written', 'Written') : t('dupd.up', 'Uploaded'))}</dt><dd>${fmtMB(p.bytesOut)}</dd></div>
      <div><dt>${escHtml(t('dupd.rate', 'Speed'))}</dt><dd>${p.rate > 0 ? escHtml(t('dupd.rateVal', '{n} units/min', { n: (p.rate * 60).toFixed(1) })) : '—'}</dd></div>
      <div><dt>${escHtml(t('dupd.eta', 'Time left'))}</dt><dd>${escHtml(eta)}</dd></div>
    </dl>
    ${_online ? '' : `<p class="adm-warn dupd-small"><i data-lucide="wifi-off"></i> ${escHtml(t('dupd.offline', 'Connection lost — waiting for the network, nothing is lost.'))}</p>`}
    <p class="adm-muted dupd-small">${escHtml(t('dupd.keepOpen', 'Keep this tab open: closing it or leaving it pauses the update.'))}</p>
    <div class="dupd-row">${controls.join(' ')}</div>`;
  const bar = el('dupd-bar');
  if (bar) bar.style.width = `${pct.toFixed(2)}%`;
  refreshIcons(body);
}

function logCard() {
  const log = readLog();
  const rows = log.map((e) => {
    const mig = migration(e.migration);
    const when = new Date(e.at).toLocaleString(lang());
    const what = e.ok
      ? t('dupd.logOk', 'format {v} · {units} units · {dur} · {exec}', {
        v: e.formatVersion, units: e.units, dur: fmtDuration(e.seconds),
        exec: e.executor === 'server' ? t('dupd.execServerShort', 'server') : t('dupd.execBrowserShort', 'browser') })
      : (e.code ? errorText(e.code, e.detail) : (e.error || ''));
    return `<li class="${e.ok ? '' : 'is-failed'}"><span class="adm-muted dupd-small">${escHtml(when)}</span>
      <b>${escHtml(e.name || e.dataset)}</b> — ${escHtml(loc(mig && mig.title) || e.migration)}
      <span class="${e.ok ? 'adm-ok' : 'adm-error'}">${escHtml(e.ok ? t('dupd.logDone', 'done') : t('dupd.stFailed', 'failed'))}</span>
      <span class="adm-muted dupd-small">${escHtml(what)}</span></li>`;
  }).join('');
  return `<div class="adm-card dupd-card">
    <div class="adm-card-head"><i data-lucide="history"></i><span>${escHtml(t('dupd.log', 'Finished updates'))}</span>
      ${log.length ? `<button class="adm-btn adm-btn-ghost adm-btn-sm dupd-head-btn" data-dupd="clear-log">${escHtml(t('dupd.clearLog', 'Clear'))}</button>` : ''}</div>
    <div class="adm-card-body">${log.length ? `<ul class="dupd-log">${rows}</ul>` : `<p class="adm-muted">${escHtml(t('dupd.logEmpty', 'Nothing yet.'))}</p>`}</div>
  </div>`;
}

function migrationsCard() {
  const migs = (_status && _status.migrations) || [];
  return `<div class="adm-card dupd-card">
    <div class="adm-card-head"><i data-lucide="layers"></i><span>${escHtml(t('dupd.available', 'Available updates'))}</span>
      <span class="adm-card-count">${escHtml(t('dupd.latest', 'latest format {v}', { v: (_status && _status.latest) || '?' }))}</span></div>
    <div class="adm-card-body">${migs.length ? `<ul class="dupd-migs">${migs.map((m) => `
      <li><span class="adm-tag">${escHtml(String(m.from))} → ${escHtml(String(m.to))}</span>
        <div><b>${escHtml(loc(m.title) || m.id)}</b><p class="adm-muted dupd-small">${escHtml(loc(m.description))}</p></div></li>`).join('')}</ul>`
      : `<p class="adm-muted">${escHtml(t('dupd.noMigrations', 'No data update is defined.'))}</p>`}</div>
  </div>`;
}

function paint() {
  const host = root();
  if (!host) return;
  if (!_status) {
    host.innerHTML = _loadError
      ? `<div class="adm-card"><div class="adm-card-body"><p class="adm-error">${escHtml(_loadError)}</p>
         <button class="adm-btn adm-btn-ghost adm-btn-sm" data-dupd="refresh">${escHtml(t('dupd.refresh', 'Refresh'))}</button></div></div>`
      : '<div class="adm-loading"><span class="spinner"></span></div>';
    return;
  }
  const anyPending = (_status.datasets || []).some(needsWork);
  host.innerHTML = `
    <div class="adm-page-head">
      <div>
        <h2 class="adm-page-title">${escHtml(t('dupd.title', 'Data updates'))}</h2>
        <p class="adm-page-sub">${escHtml(t('dupd.sub', 'Bring published datasets up to the current data format. The original data is never modified; an update can be paused and resumed at any time.'))}</p>
      </div>
      <div class="dupd-row">
        <button class="adm-btn adm-btn-ghost adm-btn-sm" data-dupd="refresh"><i data-lucide="refresh-cw"></i> ${escHtml(t('dupd.refresh', 'Refresh'))}</button>
        <button class="adm-btn adm-btn-accent" data-dupd="update-all" ${anyPending && !isRunning() ? '' : 'disabled'}><i data-lucide="download"></i> ${escHtml(t('dupd.updateAll', 'Update all'))}</button>
      </div>
    </div>
    ${progressCard()}
    <div class="adm-grid adm-grid-2 dupd-grid">
      <div class="adm-card dupd-card">
        <div class="adm-card-head"><i data-lucide="cpu"></i><span>${escHtml(t('dupd.executor', 'Executor'))}</span></div>
        <div class="adm-card-body">${serverPanel()}${executorPicker()}</div>
      </div>
      ${benchCard()}
    </div>
    ${datasetsCard()}
    ${migrationsCard()}
    ${logCard()}`;
  paintProgress();
  refreshIcons(host);
}

async function load() {
  if (_loading) return;
  _loading = true;
  try {
    const r = await api.status();
    if (r.ok && r.data && Array.isArray(r.data.datasets)) {
      _status = r.data;
      _loadError = null;
      if (_status.server && !_status.server.available && _runner && _runner.executor === 'server' && !isRunning()) _runner.executor = 'browser';
    } else {
      _loadError = t('dupd.loadFailed', 'Could not read the update status ({status}).', { status: r.status || t('dupd.network', 'network') });
    }
  } finally {
    _loading = false;
  }
  paint();
}

function bindRoot() {
  const host = root();
  if (!host || host.dataset.bound) return;
  host.dataset.bound = '1';
  host.addEventListener('click', (e) => {
    const b = e.target.closest('[data-dupd]');
    if (!b || b.disabled) return;
    const id = b.dataset.id;
    switch (b.dataset.dupd) {
      case 'refresh': load(); break;
      case 'update-all': updateDatasets(null); break;
      case 'update': updateDatasets([id]); break;
      case 'retry': retryDataset(id); break;
      case 'cancel': cancelDataset(id); break;
      case 'pause': _runner && _runner.pause(); paint(); break;
      case 'resume': _runner && _runner.resume(); paint(); break;
      case 'bench-browser': runBench('browser'); break;
      case 'bench-server': runBench('server'); break;
      case 'clear-log': storageSet(LOG_KEY, '[]'); paint(); break;
      default: break;
    }
  });
  host.addEventListener('change', (e) => {
    const tg = e.target;
    if (tg.name === 'dupd-exec') setExecutor(tg.value);
    else if (tg.id === 'dupd-bench-ds') { _bench.dataset = tg.value; }
    else if (tg.id === 'dupd-bench-n') { _bench.n = Math.max(1, Math.min(8, parseInt(tg.value, 10) || 4)); }
  });
}

export const DatasetUpdatesTab = {
  mount() { bindRoot(); paint(); },
  activate() { bindRoot(); load(); },
  relabel() { paint(); },
};
