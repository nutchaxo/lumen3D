/**
 * Admin SPA — Data updates (dataset migrations)
 * =============================================
 * Brings published datasets up to the platform's current data format, like a software
 * update: every dataset carries a `formatVersion`, the server lists the migrations each
 * one still needs, and this tab applies them (DOCS/dataset-migrations/SPEC.md §6, §9, §13.5)
 * with one of two executors:
 *
 *   A. this browser: js/workers/migration-worker.js reads the published data, converts it
 *      with the migration's handler and uploads the result unit by unit;
 *   B. the server: the tab drives a loop of bounded `unit_run` calls.
 *
 * The executor is chosen PER DATASET, before it starts, and is fixed while it runs. Each
 * executor has its own queue (a `Runner` lane), so a dataset given to the browser and another
 * given to the server are converted at the same time. Every browser-run step, whichever lane
 * it belongs to, goes through ONE worker pool: this browser's share of the host's connections
 * and of its own memory is fixed, however many lanes run. A step the chosen executor cannot run
 * (the server says so per migration in `status.server.migrations`, the browser by the
 * handler's probe) goes to the other one, inside the same lane: a dataset's steps stay in order.
 *
 * The speed test converts the same synthetic block (js/migrations/speedtest-brick.webp) on
 * both executors at once for 5 seconds; its winner is the default executor of every dataset
 * the operator has not set.
 *
 * Both executors write the same server journal, so a job survives a reload or a pause. The
 * tab must stay open (a shared host has no background worker): leaving it, or closing the
 * page, pauses every lane.
 *
 * Generic: nothing below knows a particular migration — titles and descriptions come from
 * the registry the server returns, and the worker loads js/migrations/<id>.js by id.
 */

'use strict';

import { Utils, I18n, t as _t, escHtml, apiFetchStatus, getCsrf, toast, el, refreshIcons, storageGet, storageSet } from './shared.js';
import {
  API_MIGRATIONS, createApi, Runner, WorkerPool, buildQueue, migrationChain, remainingUnits, serverCapability,
  runSpeedtest, speedtestScores, SPEEDTEST_SECONDS, netGovernor,
} from './migration-runner.js';

const V = (() => { try { return new URL(import.meta.url).search; } catch (_) { return ''; } })();
const TAB_ID = 'dataset-updates';
const EXECS = ['browser', 'server'];
const DS_EXEC_KEY = 'lumen-dupd-ds-executor';   // { datasetId: 'browser' | 'server' }
const SPEED_KEY = 'lumen-dupd-speedtest';       // the last speed test
const LOG_KEY = 'lumen-dupd-log';
const LOG_MAX = 20;
// The speed test's block needs WebP decode + zlib on the server: m002's capability.
const SPEEDTEST_SERVER_MIGRATION = 'm002-planes';

// The English fallback must interpolate too: a key missing from lang/*.json still has to read
// "3 to update", not "{n} to update".
function t(key, def, params) {
  const s = _t(key, def, params);
  return params ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : s;
}

// Every request of this tab (status, plan, unit_run…) and of its workers shares the page's
// network governor: a bounded number in flight and per second, slowed down when the host
// stops answering, so the operator's address is never taken for a flood.
const api = createApi((url, init) => netGovernor.run(() => apiFetchStatus(url, init)));
netGovernor.onChange = () => schedulePaint();

let _status = null;
let _loading = false;
let _loadError = null;
const _lanes = { browser: null, server: null };   // Runner per executor
const _progress = new Map();                       // dataset id → last progress event
// Sources (the shared pool, each lane's API calls) currently waiting for the link.
const _offline = new Set();
let _pool = null;
let _dsExec = null;
const _browserCaps = {};                           // migration → { available, reasons } | { pending: true }
let _speed = { running: false, elapsed: 0, live: null, result: null };
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

function fmtNum(n, digits = 1) {
  try { return Number(n).toLocaleString(lang(), { maximumFractionDigits: digits, minimumFractionDigits: digits }); } catch (_) { return Number(n).toFixed(digits); }
}

function loc(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  return v[lang()] || v.en || Object.values(v)[0] || '';
}

function typeLabel(type) {
  try { return Utils && Utils.datasetTypeLabel ? Utils.datasetTypeLabel(type) : type; } catch (_) { return type; }
}

function registry() { return (_status && _status.migrations) || []; }
function datasets() { return (_status && _status.datasets) || []; }
function migration(id) { return registry().find((m) => m.id === id) || null; }
function migTitle(id) { return loc(migration(id) && migration(id).title) || id; }
function dsById(id) { return datasets().find((d) => d.id === id) || null; }
function chainOf(ds) { return migrationChain(ds, registry()); }
function needsWork(ds) { return chainOf(ds).length > 0; }
function dsName(ds) { return (ds && (ds.name || ds.folder || ds.id)) || ''; }
function nameOf(id) { return dsName(dsById(id)) || id; }
function other(x) { return x === 'browser' ? 'server' : 'browser'; }

const REASONS = {
  no_webp_decode: () => t('dupd.reasonWebp', 'the server cannot decode lossless WebP images'),
  no_webp_encode: () => t('dupd.reasonWebpEncodeServer', 'the server cannot encode lossless WebP images'),
  no_numpy: () => t('dupd.reasonNumpy', 'the server has no NumPy'),
  no_compression_stream: () => t('dupd.reasonCompression', 'this browser has no compression streams'),
  no_png_codec: () => t('dupd.reasonPng', 'this browser does not round-trip PNG tiles exactly'),
  no_plane_codec: () => t('dupd.reasonPng', 'this browser does not round-trip PNG tiles exactly'),
  no_handler: () => t('dupd.reasonHandler', 'this page has no converter for this update'),
  no_zlib: () => t('dupd.reasonZlib', 'the server has no zlib compression'),
  low_memory: () => t('dupd.reasonMemory', 'the server allows less than 128 MiB of memory per request'),
  exec_time_too_short: () => t('dupd.reasonTime', 'the server stops requests after less than 10 seconds'),
};
// Codes both executors may report, worded for the one that reported them.
const EXEC_REASONS = {
  no_webp_lossless_encode: {
    browser: () => t('dupd.reasonWebpEncode', 'this browser cannot encode lossless WebP images'),
    server: () => t('dupd.reasonWebpEncodeServer', 'the server cannot encode lossless WebP images'),
  },
};
function reasonText(code, executor) {
  const per = EXEC_REASONS[code];
  if (per) return (per[executor] || per.browser)();
  return (REASONS[code] || (() => code))();
}

const ERRORS = {
  source_changed: () => t('dupd.errSourceChanged', 'the dataset was re-processed since the update started'),
  brick_undecodable: () => t('dupd.errBrick', 'a brick could not be decoded'),
  incomplete: () => t('dupd.errIncomplete', 'some units are not done yet'),
  no_progress: () => t('dupd.errNoProgress', 'the server made no progress'),
  request_failed: () => t('dupd.errRequest', 'a request keeps failing'),
  prepare_failed: () => t('dupd.errPrepare', 'the dataset could not be read'),
  unauthorized: () => t('dupd.reasonAuth', 'session expired'),
  unit_blocked: () => t('dupd.errBlocked', 'a lower level of the pyramid is not complete yet'),
  bad_webp: () => t('dupd.errBadWebp', 'the server refused a converted brick'),
  insufficient_disk: () => t('dupd.errDisk', 'not enough disk space on the server (needed / free)'),
  no_executor: () => t('dupd.errNoExecutor', 'neither this browser nor the server can run this update'),
  unit_timeout: () => t('dupd.errUnitTimeout', 'the server cannot convert one unit within its time limit'),
  speedtest_sample_missing: () => t('dupd.errSample', 'the test block is missing from this installation'),
};
/** A server/worker error code in words, with its detail when there is one. */
function errorText(code, detail) {
  const base = code ? (ERRORS[code] ? ERRORS[code]() : code) : '';
  if (detail && detail !== base) return base ? `${base} (${detail})` : String(detail);
  return base || t('dupd.errUnknown', 'unknown error');
}

function execName(x) {
  return x === 'server' ? t('dupd.execServer', 'The server') : t('dupd.execBrowser', 'This browser');
}
function execIcon(x) { return x === 'server' ? 'server' : 'monitor'; }

// ── Per-viewer conveniences (localStorage) ────────────────────────────────────

function readJson(key, fallback) {
  try { const v = JSON.parse(storageGet(key) || 'null'); return v === null ? fallback : v; } catch (_) { return fallback; }
}

function readLog() { const v = readJson(LOG_KEY, []); return Array.isArray(v) ? v : []; }
function pushLog(entry) {
  storageSet(LOG_KEY, JSON.stringify([{ at: new Date().toISOString(), ...entry }, ...readLog()].slice(0, LOG_MAX)));
}

function dsExec() {
  if (_dsExec) return _dsExec;
  const v = readJson(DS_EXEC_KEY, {});
  _dsExec = {};
  if (v && typeof v === 'object') for (const k of Object.keys(v)) if (EXECS.includes(v[k])) _dsExec[k] = v[k];
  return _dsExec;
}
function setDsExec(id, x) { dsExec()[id] = x; storageSet(DS_EXEC_KEY, JSON.stringify(dsExec())); }

function speedResult() {
  if (_speed.result === null) {
    const v = readJson(SPEED_KEY, null);
    _speed.result = v && v.browser && v.server ? v : false;
  }
  return _speed.result || null;
}

// ── Executors ─────────────────────────────────────────────────────────────────

/** Can executor `x` run migration `mid`? The browser counts as able until its probe answers. */
function stepOk(x, mid) {
  if (x === 'server') return serverCapability(_status && _status.server, mid).available;
  const b = _browserCaps[mid];
  return !(b && b.available === false);
}

/** Why `x` cannot run `mid`, in words. */
function stepWhyNot(x, mid) {
  const cap = x === 'server' ? serverCapability(_status && _status.server, mid) : _browserCaps[mid];
  const codes = (cap && cap.reasons) || [];
  return codes.map((c) => reasonText(c, x)).join('; ') || t('dupd.reasonUnknown', 'capability check unavailable');
}

/** The executor that runs step `mid` of a dataset given to `x`: x itself, else the other one. */
function stepExec(x, mid) {
  if (stepOk(x, mid)) return x;
  return stepOk(other(x), mid) ? other(x) : null;
}

function canUse(x, ds) { return chainOf(ds).some((mid) => stepOk(x, mid)); }

/** The speed test's winner, if a test was run. */
function recommended() {
  const r = speedResult();
  return r && r.scores ? r.scores.winner : null;
}

/** The lane holding `id` (current or queued), or null. */
function laneOf(id) {
  for (const x of EXECS) {
    const r = _lanes[x];
    if (r && ((r.current && r.current.dataset === id) || r.queue.some((q) => q.dataset === id))) return x;
  }
  return null;
}

/** The executor of a dataset: its lane while it runs, else the operator's pick, else the default. */
function execOf(ds) {
  const lane = laneOf(ds.id);
  if (lane) return lane;
  const pick = dsExec()[ds.id];
  if (pick && canUse(pick, ds)) return pick;
  for (const x of [recommended(), 'browser', 'server']) if (x && canUse(x, ds)) return x;
  return null;
}

// ── Lanes ─────────────────────────────────────────────────────────────────────

function absUrl(rel) { return new URL(rel, document.baseURI).href; }

function datasetBase(id) {
  const ds = dsById(id);
  const type = ds ? ds.type : String(id).split('/')[0];
  const folder = ds ? ds.folder : String(id).split('/').slice(1).join('/');
  return absUrl(`DATA_WEB/${encodeURIComponent(type)}/${encodeURIComponent(folder)}/`);
}

function poolOptions(extra) {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return {
    // Each unit holds ≈ 16 MiB of planes plus its compressed bricks and tiles: four in
    // flight stay well under 200 MiB while keeping both the link and two cores busy.
    workers: Math.max(1, Math.min(2, Math.floor(cores / 2))),
    slots: 2,
    endpoint: absUrl(API_MIGRATIONS),
    csrf: () => getCsrf(),
    spawn: () => new Worker(absUrl(`js/workers/migration-worker.js${V}`)),
    governor: netGovernor,
    onNet: (online) => setOnline('pool', online),
    ...(extra || {}),
  };
}

function setOnline(source, online) {
  const was = _offline.size === 0;
  if (online) _offline.delete(source); else _offline.add(source);
  if ((_offline.size === 0) !== was) schedulePaint();
}
function isOnline() { return _offline.size === 0; }

/** The browser executor's pool, shared by both lanes (a server-lane step the server cannot run lands here too). */
function sharedPool() {
  if (!_pool || _pool.dead) _pool = new WorkerPool(poolOptions());
  return _pool;
}

function lane(x) {
  if (!_lanes[x]) {
    _lanes[x] = new Runner({
      api,
      pool: sharedPool,
      datasetBase,
      onEvent: (e) => onLaneEvent(x, e),
      executorFor: (mid) => stepExec(x, mid),
    });
  }
  return _lanes[x];
}

function laneState(x) { return _lanes[x] ? _lanes[x].state : 'idle'; }
function isRunning() { return EXECS.some((x) => ['running', 'pausing'].includes(laneState(x))); }
function isPaused() { return EXECS.some((x) => laneState(x) === 'paused' && _lanes[x].queue.length); }
function anyActive() { return isRunning() || isPaused(); }

/** Runs each relevant handler's probe once, in a one-worker pool dropped afterwards. */
function probeBrowser() {
  const todo = registry().filter((m) => !_browserCaps[m.id]);
  if (!todo.length) return;
  const pool = new WorkerPool(poolOptions({ workers: 1, onNet: (online) => setOnline('probe', online) }));
  const runs = todo.map((m) => {
    _browserCaps[m.id] = { pending: true };
    let p;
    try { p = pool.probe(m.id); } catch (err) { p = Promise.reject(err); }
    return p.then((c) => { _browserCaps[m.id] = c; })
      .catch(() => { _browserCaps[m.id] = { available: false, reasons: ['no_handler'] }; });
  });
  Promise.allSettled(runs).then(() => { pool.terminate(); paint(); });
}

function onLaneEvent(x, e) {
  if (e.type === 'progress') { _progress.set(e.dataset, e); schedulePaint(); return; }
  if (e.type === 'net') { setOnline(`lane:${x}`, !!e.online); return; }
  if (e.type === 'job_done') {
    pushLog({ ok: true, dataset: e.dataset, name: nameOf(e.dataset), migration: e.migration, executor: e.executor, seconds: e.seconds, units: e.units, formatVersion: e.formatVersion });
    _progress.delete(e.dataset);
    // One toast per dataset, when its last step lands (the lane still holds the step just done).
    const r = _lanes[x];
    const more = r && r.queue.some((q) => q.dataset === e.dataset && q.migration !== e.migration);
    if (!more) toast(t('dupd.toastDone', '{name} updated to format {v}', { name: nameOf(e.dataset), v: e.formatVersion }), 'success');
    load();
    return;
  }
  if (e.type === 'job_failed') {
    pushLog({ ok: false, dataset: e.dataset, name: nameOf(e.dataset), migration: e.migration, error: e.error, code: e.code, detail: e.detail });
    _progress.delete(e.dataset);
    if (e.code === 'unit_timeout' && x === 'server') { onUnitTimeout(e); return; }
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
    if (e.state === 'idle') load();
    paint();
  }
}

// Datasets already moved to the browser after a unit_timeout: once only, so a browser that
// fails too ends in the history instead of a loop.
const _timeoutSwitched = new Set();

/**
 * The server could not convert a unit in time, twice (unit_timeout). The journal is shared by
 * both executors: when this browser can run the migration, the dataset continues in the
 * browser lane; otherwise the operator is told why.
 */
function onUnitTimeout(e) {
  const browserOk = stepOk('browser', e.migration);
  if (!browserOk || _timeoutSwitched.has(e.dataset)) {
    toast(t('dupd.toastUnitTimeoutStuck', 'Update of {name} stopped: {error}. {hint}', {
      name: nameOf(e.dataset), error: errorText('unit_timeout'),
      hint: browserOk ? t('dupd.unitTimeoutRetry', 'Retry it in this browser, or reprocess the dataset with the pipeline.')
        : t('dupd.unitTimeoutNoBrowser', 'This browser cannot run this update either; reprocess the dataset with the pipeline.') }), 'error');
    load();
    return;
  }
  _timeoutSwitched.add(e.dataset);
  setDsExec(e.dataset, 'browser');
  toast(t('dupd.toastUnitTimeoutSwitch', '{update}: the server cannot convert some units in time. Continuing {name} in this browser.', {
    update: migTitle(e.migration), name: nameOf(e.dataset) }), 'warning');
  // The browser picks the job up where the server stopped, once the status says where that is.
  freshLoad().then(() => updateDatasets([e.dataset])).catch(() => {});
}

/** A status read that starts after any one in flight (load() skips while one runs). */
async function freshLoad() {
  while (_loading) await new Promise((res) => setTimeout(res, 100));
  await load();
}

function updateDatasets(ids) {
  if (!_status) return;
  const list = (ids ? ids.map(dsById).filter(Boolean) : datasets()).filter((ds) => needsWork(ds) && !laneOf(ds.id));
  if (!list.length) { if (!ids) toast(t('dupd.nothing', 'Everything is up to date.'), 'info'); return; }
  const stuck = new Set();
  for (const ds of list) {
    const x = execOf(ds);
    if (!x) { stuck.add(dsName(ds)); continue; }
    if (chainOf(ds).some((mid) => !stepExec(x, mid))) stuck.add(dsName(ds));
    setDsExec(ds.id, x);
    const r = lane(x);
    r.enqueue(buildQueue([ds], registry(), [ds.id]));
    if (r.state === 'paused') r.resume();
  }
  if (stuck.size) {
    toast(t('dupd.toastNoExecutor', 'Neither executor can run every step of: {list}. Those steps will fail.', { list: [...stuck].join(', ') }), 'warning');
  }
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
  const x = laneOf(id);
  const r = x && _lanes[x];
  if (r && r.current && r.current.dataset === id) {
    const wasRunning = r.state === 'running';
    const res = await r.cancelCurrent();
    if (res && !res.ok) toast(t('dupd.cancelFailed', 'Could not discard the job.'), 'error');
    // The rest of that lane's queue was not cancelled: it carries on.
    if (wasRunning && r.queue.length) r.resume();
  } else {
    if (r) r.queue = r.queue.filter((q) => q.dataset !== id);
    if (ds && ds.job) {
      const res = await api.cancel(id, ds.job.migration);
      if (!res.ok) toast(t('dupd.cancelFailed', 'Could not discard the job.'), 'error');
    }
  }
  _progress.delete(id);
  await load();
}

function pauseAll() { for (const x of EXECS) if (laneState(x) === 'running') _lanes[x].pause(); paint(); }
function resumeAll() { for (const x of EXECS) { const r = _lanes[x]; if (r && r.queue.length && (r.state === 'paused' || r.state === 'failed')) r.resume(); } paint(); }

// ── Speed test ────────────────────────────────────────────────────────────────

async function runSpeed() {
  if (_speed.running || anyActive() || !_status) return;
  const serverCap = serverCapability(_status.server, SPEEDTEST_SERVER_MIGRATION);
  _speed = { running: true, elapsed: 0, live: null, result: speedResult() || false };
  paint();
  const pool = new WorkerPool(poolOptions({ onNet: (online) => setOnline('speedtest', online) }));
  let res;
  try {
    res = await runSpeedtest({
      pool, api, seconds: SPEEDTEST_SECONDS, server: serverCap.available,
      onTick: (s) => { _speed.elapsed = s.elapsed; _speed.live = s; paintSpeed(); },
    });
  } catch (err) {
    res = null;
    toast(t('dupd.speedFailed', 'The speed test could not run: {error}', { error: String(err && err.message || err) }), 'error');
  } finally {
    pool.terminate();
  }
  if (res) {
    if (!serverCap.available) { res.server.code = 'server_unavailable'; res.server.detail = (serverCap.reasons || []).join(','); }
    const side = (s) => ({ blocks: s.blocks, seconds: s.seconds, bytesIn: s.bytesIn, bytesOut: s.bytesOut, error: s.error, code: s.code, detail: s.detail });
    _speed.result = { at: new Date().toISOString(), seconds: res.seconds, browser: side(res.browser), server: side(res.server), scores: speedtestScores(res) };
    storageSet(SPEED_KEY, JSON.stringify(_speed.result));
  }
  _speed.running = false;
  _speed.live = null;
  paint();
}

/** Why a side of the speed test has no score, in words. */
function speedSideError(x, s) {
  if (!s || !s.error) return '';
  if (s.code === 'server_unavailable') {
    const codes = String(s.detail || '').split(',').filter(Boolean);
    return codes.length ? codes.map((c) => reasonText(c, 'server')).join('; ') : t('dupd.serverOff', 'the server cannot convert data itself');
  }
  if (s.code && (REASONS[s.code] || EXEC_REASONS[s.code])) return reasonText(s.code, x);
  if (s.code && ERRORS[s.code]) return errorText(s.code, null);
  return s.error;
}

// ── Guards: leaving the tab or the page pauses every lane ─────────────────────

function bindGuards() {
  if (_guardsBound) return;
  _guardsBound = true;
  window.addEventListener('beforeunload', (e) => {
    if (!isRunning()) return;
    // The browser shows its own prompt; the jobs pause either way (the journal keeps them).
    for (const x of EXECS) if (_lanes[x]) _lanes[x].pauseNow('unload');
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
    for (const x of EXECS) if (laneState(x) === 'running') _lanes[x].pause('left_tab');
  }, true);
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function schedulePaint() {
  if (_paintTimer) return;
  // A timer, not requestAnimationFrame: a hidden tab must still record progress.
  _paintTimer = setTimeout(() => { _paintTimer = null; paintLive(); }, 200);
}

function root() { return el('dataset-updates-root'); }

function bar(pct, cls = '') {
  const p = Math.max(0, Math.min(100, pct || 0));
  return `<div class="dupd-bar ${cls}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.toFixed(0)}"><span style="width:${p.toFixed(2)}%"></span></div>`;
}

function speedCard() {
  const r = speedResult();
  const live = _speed.running ? _speed.live : null;
  const sides = {};
  for (const x of EXECS) {
    const s = live ? live[x] : r ? r[x] : null;
    // Live: the count so far; done: the measured throughput (speedtestScores).
    const score = !s || s.error ? null
      : live ? Math.round((10 * s.blocks) / SPEEDTEST_SECONDS)
        : r && r.scores && r.scores[x] !== null && r.scores[x] !== undefined ? r.scores[x] : Math.round((10 * s.blocks) / SPEEDTEST_SECONDS);
    sides[x] = { s, score };
  }
  // The server side cannot even start without WebP decode + zlib: say why instead of 0.
  const serverCap = serverCapability(_status && _status.server, SPEEDTEST_SERVER_MIGRATION);
  if (!serverCap.available) sides.server = { s: { blocks: 0, error: 'server_unavailable', code: 'server_unavailable', detail: (serverCap.reasons || []).join(',') }, score: null };
  const top = Math.max(1, ...EXECS.map((x) => sides[x].score || 0));
  const winner = !_speed.running && r && r.scores ? r.scores.winner : null;
  const rows = EXECS.map((x) => {
    const { s, score } = sides[x];
    const err = s && s.error && s.error !== 'skipped' && !(live && s.running) ? speedSideError(x, s) : '';
    const off = !!err;
    const sub = err
      ? err
      : s ? t('dupd.speedBlocks', '{n} blocks in {s} s', { n: s.blocks, s: fmtNum(live || !(s.seconds > 0) ? SPEEDTEST_SECONDS : s.seconds, 1) })
        : t('dupd.speedNotRun', 'not tested yet');
    const pct = score !== null ? (100 * score) / top : 0;
    const win = winner === x;
    return `<div class="dupd-race ${win ? 'is-win' : ''} ${off ? 'is-off' : ''} ${live && s && s.running ? 'is-live' : ''}">
      <div class="dupd-race-who"><i data-lucide="${execIcon(x)}"></i><div><b>${escHtml(execName(x))}</b><span>${escHtml(sub)}</span></div></div>
      <div class="dupd-race-track">${bar(pct, win ? 'is-win' : '')}</div>
      <div class="dupd-race-score"><b>${score !== null ? score : '—'}</b><span>${escHtml(t('dupd.speedPoints', 'points'))}</span></div>
      ${win ? `<span class="dupd-race-badge">${escHtml(t('dupd.speedFastest', 'Fastest'))}</span>` : ''}
    </div>`;
  }).join('');
  let verdict = '';
  if (_speed.running) {
    verdict = `<div class="dupd-race-clock">${bar((100 * _speed.elapsed) / SPEEDTEST_SECONDS, 'is-thin')}<span>${escHtml(fmtNum(_speed.elapsed, 1))} / ${SPEEDTEST_SECONDS} s</span></div>`;
  } else if (r && r.scores) {
    const sc = r.scores;
    const when = new Date(r.at).toLocaleString(lang());
    const text = sc.winner
      ? (sc.ratio && sc.ratio >= 1.05
        ? t('dupd.speedVerdict', '{who} is {x}× faster: it is proposed by default for every dataset.', { who: execName(sc.winner), x: fmtNum(sc.ratio, 1) })
        : t('dupd.speedVerdictOnly', '{who} is proposed by default for every dataset.', { who: execName(sc.winner) }))
      : t('dupd.speedTie', 'Both executors are as fast: pick either.');
    verdict = `<p class="dupd-speed-verdict"><i data-lucide="sparkles"></i><span>${escHtml(text)}</span></p>
      <p class="adm-muted dupd-small">${escHtml(t('dupd.speedWhen', 'Tested on {when}.', { when }))}</p>`;
  }
  const blocked = anyActive();
  return `<div class="adm-card-head"><i data-lucide="gauge"></i><span>${escHtml(t('dupd.speedTitle', 'Speed test'))}</span>
      <button class="adm-btn ${r ? 'adm-btn-ghost' : 'adm-btn-accent'} adm-btn-sm dupd-head-btn" data-dupd="speed" ${_speed.running || blocked ? 'disabled' : ''}>
        ${_speed.running ? '<span class="spinner spinner-sm"></span>' : '<i data-lucide="play"></i>'}
        ${escHtml(_speed.running ? t('dupd.speedRunning', 'Testing…') : r ? t('dupd.speedAgain', 'Run again') : t('dupd.speedRun', 'Run the test ({s} s)', { s: SPEEDTEST_SECONDS }))}</button></div>
    <div class="adm-card-body">
      <p class="adm-muted dupd-small dupd-speed-intro">${escHtml(t('dupd.speedIntro', 'Both executors convert the same test block (a synthetic 64³ brick) for {s} seconds at the same time; the browser also downloads and uploads it, in batches, as it would in a real update. The higher score converts faster. No dataset is read or modified.', { s: SPEEDTEST_SECONDS }))}</p>
      <div class="dupd-races">${rows}</div>
      ${verdict}
      ${blocked && !_speed.running ? `<p class="adm-muted dupd-small">${escHtml(t('dupd.speedBlocked', 'Available when no update is running.'))}</p>` : ''}
    </div>`;
}

function paintSpeed() {
  const card = el('dupd-speed');
  if (!card) return;
  card.innerHTML = speedCard();
  refreshIcons(card);
}

/** The executor switch of a dataset row. */
function execSwitch(ds, locked) {
  const cur = execOf(ds);
  const rec = recommended();
  return `<div class="dupd-seg" role="radiogroup" aria-label="${escHtml(t('dupd.executor', 'Executor'))}">${EXECS.map((x) => {
    const able = canUse(x, ds);
    const why = able ? '' : chainOf(ds).map((mid) => stepWhyNot(x, mid)).filter(Boolean).join('; ');
    const on = cur === x;
    return `<button type="button" role="radio" aria-checked="${on}" class="dupd-seg-btn ${on ? 'is-on' : ''}"
      data-dupd="exec" data-id="${escHtml(ds.id)}" data-exec="${x}" ${!able || locked ? 'disabled' : ''}
      title="${escHtml(why || execName(x))}"><i data-lucide="${execIcon(x)}"></i><span>${escHtml(execName(x))}</span>${rec === x ? `<em class="dupd-seg-rec" title="${escHtml(t('dupd.recommended', 'Fastest in the speed test'))}">★</em>` : ''}</button>`;
  }).join('')}</div>`;
}

/** The steps a dataset needs, each marked with the executor that would run it when it differs. */
function stepChips(ds) {
  const chain = chainOf(ds);
  const x = execOf(ds);
  const repair = ds.repair && !(ds.pending || []).length;
  return chain.map((mid, i) => {
    const sx = x ? stepExec(x, mid) : null;
    const note = !sx ? `<em class="is-bad">${escHtml(t('dupd.stepNone', 'no executor'))}</em>`
      : sx !== x ? `<em title="${escHtml(stepWhyNot(x, mid))}">${escHtml(t('dupd.stepOn', 'on {who}', { who: execName(sx).toLowerCase() }))}</em>` : '';
    return `<span class="dupd-chip">${chain.length > 1 ? `<b>${i + 1}</b>` : ''}${escHtml(migTitle(mid))}${note}</span>`;
  }).join('') + (repair ? `<span class="dupd-chip is-warn">${escHtml(t('dupd.repair', 'repair'))}</span>` : '');
}

function rowActions(ds) {
  const active = laneOf(ds.id);
  const out = [];
  if (!active) {
    const x = execOf(ds);
    if (ds.job && ds.job.state === 'failed') out.push(`<button class="adm-btn adm-btn-ghost adm-btn-sm" data-dupd="retry" data-id="${escHtml(ds.id)}" ${x ? '' : 'disabled'}><i data-lucide="rotate-ccw"></i> ${escHtml(t('dupd.retry', 'Retry'))}</button>`);
    else if (ds.job) out.push(`<button class="adm-btn adm-btn-accent adm-btn-sm" data-dupd="update" data-id="${escHtml(ds.id)}" ${x ? '' : 'disabled'}><i data-lucide="play"></i> ${escHtml(t('dupd.resume', 'Resume'))}</button>`);
    else if (ds.repair && !(ds.pending || []).length) out.push(`<button class="adm-btn adm-btn-accent adm-btn-sm" data-dupd="update" data-id="${escHtml(ds.id)}" ${x ? '' : 'disabled'}><i data-lucide="wrench"></i> ${escHtml(t('dupd.repairBtn', 'Repair'))}</button>`);
    else out.push(`<button class="adm-btn adm-btn-accent adm-btn-sm" data-dupd="update" data-id="${escHtml(ds.id)}" ${x ? '' : 'disabled'}><i data-lucide="download"></i> ${escHtml(t('dupd.update', 'Update'))}</button>`);
  }
  if (ds.job || active) out.push(`<button class="adm-btn adm-btn-ghost adm-btn-sm dupd-icon-btn" data-dupd="cancel" data-id="${escHtml(ds.id)}" title="${escHtml(t('dupd.cancel', 'Cancel'))}" aria-label="${escHtml(t('dupd.cancel', 'Cancel'))}"><i data-lucide="x"></i></button>`);
  return out.join('');
}

function pauseReason(r) {
  return r.reason === 'left_tab' ? t('dupd.reasonLeft', 'you left the tab')
    : r.reason === 'unload' ? t('dupd.reasonUnload', 'the page was closing')
      : r.reason === 'unauthorized' ? t('dupd.reasonAuth', 'session expired')
        : r.reason === 'offline' ? t('dupd.reasonOffline', 'the server could not be reached') : '';
}

/** The live part of a dataset row: progress while it runs or waits, the job left otherwise. */
function rowLive(ds) {
  const x = laneOf(ds.id);
  const r = x && _lanes[x];
  if (r) {
    const p = r.current && r.current.dataset === ds.id ? _progress.get(ds.id) : null;
    if (!p) {
      const label = r.state === 'running' ? t('dupd.stQueued', 'Waiting for its turn')
        : r.state === 'pausing' ? t('dupd.stPausing', 'Pausing…') : t('dupd.stPaused', 'Paused');
      return `<div class="dupd-live-line"><span class="dupd-state is-wait">${escHtml(label)}</span>
        <span class="adm-muted">${escHtml(t('dupd.stQueuedOn', 'next on {who}', { who: execName(x).toLowerCase() }))}</span></div>`;
    }
    const pct = p.total ? (100 * p.done) / p.total : 0;
    const st = r.state === 'running' ? `<span class="dupd-state is-run">${escHtml(t('dupd.stRunning', 'Running'))}</span>`
      : r.state === 'pausing' ? `<span class="dupd-state is-wait">${escHtml(t('dupd.stPausing', 'Pausing…'))}</span>`
        : `<span class="dupd-state is-wait">${escHtml(t('dupd.stPaused', 'Paused'))}${pauseReason(r) ? ' · ' + escHtml(pauseReason(r)) : ''}</span>`;
    const step = p.steps > 1 ? `${escHtml(t('dupd.step', 'step {i} of {n}', { i: p.step, n: p.steps }))} · ` : '';
    const eta = p.phase === 'finalizing'
      ? (p.assembly && p.assembly.planes ? t('dupd.assembling', 'Assembling planes {x}/{y}', { x: p.assembly.written, y: p.assembly.planes }) : t('dupd.finalizing', 'assembling and publishing…'))
      : t('dupd.etaLeft', '{t} left', { t: fmtDuration(p.eta) });
    const rate = p.rate > 0 ? ` · ${escHtml(t('dupd.rateVal', '{n} units/min', { n: fmtNum(p.rate * 60, 1) }))}` : '';
    return `<div class="dupd-live-line">${st}<span>${step}${escHtml(migTitle(p.migration))}</span>
        <span class="dupd-exec-tag"><i data-lucide="${execIcon(p.executor)}"></i>${escHtml(execName(p.executor))}</span></div>
      ${bar(pct, r.state === 'running' ? 'is-run' : '')}
      <div class="dupd-live-stats"><span><b>${fmtNum(pct, 1)} %</b> · ${p.done} / ${p.total} ${escHtml(t('dupd.units', 'units'))}</span>
        <span>${escHtml(eta)}${rate}</span></div>`;
  }
  const j = ds.job;
  if (!j) return '';
  if (j.state === 'failed') {
    return `<div class="dupd-live-line"><span class="dupd-state is-bad">${escHtml(t('dupd.stFailed', 'Failed'))}</span><span>${escHtml(errorText(j.error, j.detail))}</span></div>`;
  }
  const pct = j.total ? (100 * (j.done || 0)) / j.total : 0;
  const label = j.state === 'assembling' ? t('dupd.stAssembling', 'Assembling') : t('dupd.stPaused', 'Paused');
  return `<div class="dupd-live-line"><span class="dupd-state is-wait">${escHtml(label)}</span><span>${escHtml(migTitle(j.migration))}</span></div>
    ${bar(pct)}
    <div class="dupd-live-stats"><span><b>${fmtNum(pct, 1)} %</b> · ${j.done || 0} / ${j.total || 0} ${escHtml(t('dupd.units', 'units'))}</span>
      <span class="adm-muted">${escHtml(t('dupd.resumeHint', 'Resume to continue where it stopped.'))}</span></div>`;
}

function datasetRow(ds) {
  const active = !!laneOf(ds.id);
  const latest = (_status && _status.latest) || '?';
  const size = ds.estimate && !ds.job ? ` · ${remainingUnits(ds)} ${escHtml(t('dupd.units', 'units'))} · ${fmtMB(ds.estimate.bytes)}` : '';
  return `<article class="dupd-ds ${active ? 'is-active' : ''}">
    <div class="dupd-ds-main">
      <div class="dupd-ds-id">
        <span class="dupd-ds-name">${escHtml(dsName(ds))}</span>
        <span class="dupd-ds-meta">${escHtml(typeLabel(ds.type))}${ds.trees > 1 ? ' · ' + escHtml(t('dupd.trees', '{n} timepoints', { n: ds.trees })) : ''}
          · ${escHtml(t('dupd.formatFromTo', 'format {a} → {b}', { a: ds.formatVersion || 1, b: latest }))}${size}</span>
      </div>
      <div class="dupd-ds-steps">${stepChips(ds)}</div>
      ${ds.problem ? `<p class="adm-warn dupd-small dupd-ds-problem"><i data-lucide="alert-triangle"></i>${escHtml(errorText(ds.problem, ds.problemDetail))}</p>` : ''}
    </div>
    <div class="dupd-ds-ctrl">
      ${execSwitch(ds, active)}
      <div class="dupd-ds-actions">${rowActions(ds)}</div>
    </div>
    <div class="dupd-ds-live" data-dupd-live="${escHtml(ds.id)}">${rowLive(ds)}</div>
  </article>`;
}

function laneStrip() {
  if (!anyActive()) return isOnline() ? '' : `<p class="adm-warn dupd-small dupd-note"><i data-lucide="wifi-off"></i>${escHtml(t('dupd.offline', 'Connection lost — waiting for the network, nothing is lost.'))}</p>`;
  const pills = EXECS.map((x) => {
    const r = _lanes[x];
    const st = laneState(x);
    const queued = r ? new Set(r.queue.map((q) => q.dataset)).size : 0;
    const text = st === 'running' || st === 'pausing'
      ? (queued > 1 ? t('dupd.laneRunningN', 'converting · {n} waiting', { n: queued - 1 }) : t('dupd.laneRunning', 'converting'))
      : st === 'paused' && queued ? t('dupd.lanePaused', 'paused · {n} left', { n: queued }) + (pauseReason(r) ? ` (${pauseReason(r)})` : '')
        : t('dupd.laneIdle', 'idle');
    return `<span class="dupd-lane is-${st === 'pausing' ? 'running' : st}"><i data-lucide="${execIcon(x)}"></i><b>${escHtml(execName(x))}</b><span>${escHtml(text)}</span></span>`;
  }).join('');
  const paced = netGovernor.holding
    ? `<p class="adm-muted dupd-small dupd-note"><i data-lucide="timer"></i>${escHtml(t('dupd.paced', 'The host is answering slowly: requests are paced down so that it does not block this address.'))}</p>`
    : '';
  return `<div class="dupd-lanes">${pills}</div>${paced}
    ${isOnline() ? '' : `<p class="adm-warn dupd-small dupd-note"><i data-lucide="wifi-off"></i>${escHtml(t('dupd.offline', 'Connection lost — waiting for the network, nothing is lost.'))}</p>`}
    ${isRunning() ? `<p class="adm-muted dupd-small dupd-note"><i data-lucide="info"></i>${escHtml(t('dupd.keepOpen', 'Keep this tab open: closing it or leaving it pauses the updates.'))}</p>` : ''}`;
}

function datasetsCard() {
  const todo = datasets().filter(needsWork);
  const done = datasets().filter((ds) => !needsWork(ds));
  const idle = todo.filter((ds) => !laneOf(ds.id));
  const bulk = idle.length > 1 ? `<div class="dupd-bulk"><span class="adm-muted dupd-small">${escHtml(t('dupd.bulk', 'All on:'))}</span>
      ${EXECS.map((x) => `<button class="adm-btn adm-btn-ghost adm-btn-sm" data-dupd="exec-all" data-exec="${x}"><i data-lucide="${execIcon(x)}"></i> ${escHtml(execName(x))}</button>`).join('')}</div>` : '';
  const list = todo.length
    ? `<div class="dupd-ds-list">${todo.map(datasetRow).join('')}</div>`
    : `<div class="dupd-empty"><i data-lucide="check-circle-2"></i><p>${escHtml(datasets().length ? t('dupd.allUpToDate', 'Every dataset is in the latest format.') : t('dupd.noDatasets', 'No published volume dataset.'))}</p></div>`;
  const upToDate = done.length && todo.length
    ? `<details class="dupd-fold"><summary>${escHtml(t('dupd.upToDateN', 'Up to date ({n})', { n: done.length }))}</summary>
        <ul class="dupd-done-list">${done.map((ds) => `<li><i data-lucide="check"></i>${escHtml(dsName(ds))}<span class="adm-muted dupd-small">${escHtml(typeLabel(ds.type))} · ${escHtml(t('dupd.formatN', 'format {v}', { v: ds.formatVersion || 1 }))}</span></li>`).join('')}</ul></details>`
    : '';
  return `<div class="adm-card dupd-card">
    <div class="adm-card-head"><i data-lucide="database"></i><span>${escHtml(t('dupd.datasets', 'Datasets to update'))}</span>
      <span class="adm-card-count">${escHtml(t('dupd.pendingCount', '{n} to update', { n: todo.length }))}</span>${bulk}</div>
    <div class="adm-card-body">
      <div data-dupd-lanes>${laneStrip()}</div>
      ${list}
      ${upToDate}
    </div>
  </div>`;
}

function infoCard() {
  const migs = registry();
  const log = readLog();
  const logRows = log.map((e) => {
    const when = new Date(e.at).toLocaleString(lang());
    const what = e.ok
      ? t('dupd.logOk', 'format {v} · {units} units · {dur} · {exec}', { v: e.formatVersion, units: e.units, dur: fmtDuration(e.seconds), exec: execName(e.executor) })
      : (e.code ? errorText(e.code, e.detail) : (e.error || ''));
    return `<li class="${e.ok ? '' : 'is-failed'}"><i data-lucide="${e.ok ? 'check-circle-2' : 'x-circle'}"></i>
      <div><b>${escHtml(e.name || e.dataset)}</b> — ${escHtml(migTitle(e.migration))}
      <span class="adm-muted dupd-small dupd-block">${escHtml(when)} · ${escHtml(what)}</span></div></li>`;
  }).join('');
  return `<div class="adm-card dupd-card">
    <div class="adm-card-body dupd-folds">
      <details class="dupd-fold"><summary>${escHtml(t('dupd.available', 'Data formats'))} <span class="adm-muted">· ${escHtml(t('dupd.latest', 'latest format {v}', { v: (_status && _status.latest) || '?' }))}</span></summary>
        ${migs.length ? `<ul class="dupd-migs">${migs.map((m) => `
          <li><span class="dupd-chip">${escHtml(String(m.from))} → ${escHtml(String(m.to))}</span>
            <div><b>${escHtml(loc(m.title) || m.id)}</b><p class="adm-muted dupd-small">${escHtml(loc(m.description))}</p></div></li>`).join('')}</ul>`
          : `<p class="adm-muted">${escHtml(t('dupd.noMigrations', 'No data update is defined.'))}</p>`}
      </details>
      <details class="dupd-fold"><summary>${escHtml(t('dupd.log', 'History'))} <span class="adm-muted">· ${log.length}</span></summary>
        ${log.length ? `<ul class="dupd-log">${logRows}</ul>
          <button class="adm-btn adm-btn-ghost adm-btn-sm" data-dupd="clear-log"><i data-lucide="trash-2"></i> ${escHtml(t('dupd.clearLog', 'Clear'))}</button>`
          : `<p class="adm-muted dupd-small">${escHtml(t('dupd.logEmpty', 'Nothing yet.'))}</p>`}
      </details>
    </div>
  </div>`;
}

/** Repaints only what moves while units complete: the live part of each row and the lane strip. */
function paintLive() {
  const host = root();
  if (!host || !_status) return;
  host.querySelectorAll('[data-dupd-live]').forEach((node) => {
    const ds = dsById(node.getAttribute('data-dupd-live'));
    if (!ds) return;
    node.innerHTML = rowLive(ds);
    refreshIcons(node);
  });
  const strip = host.querySelector('[data-dupd-lanes]');
  if (strip) {
    strip.innerHTML = laneStrip();
    refreshIcons(strip);
  }
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
  const idle = datasets().filter((ds) => needsWork(ds) && !laneOf(ds.id) && execOf(ds));
  const lanesBtn = isRunning()
    ? `<button class="adm-btn adm-btn-ghost adm-btn-sm" data-dupd="pause"><i data-lucide="pause"></i> ${escHtml(t('dupd.pauseAll', 'Pause'))}</button>`
    : isPaused() ? `<button class="adm-btn adm-btn-ghost adm-btn-sm" data-dupd="resume"><i data-lucide="play"></i> ${escHtml(t('dupd.resumeAll', 'Resume'))}</button>` : '';
  host.innerHTML = `
    <div class="adm-page-head">
      <div>
        <h2 class="adm-page-title">${escHtml(t('dupd.title', 'Data updates'))}</h2>
        <p class="adm-page-sub">${escHtml(t('dupd.sub', 'Bring published datasets up to the current data format. Choose for each dataset whether this browser or the server converts it: two datasets on different executors are converted at the same time. The original data is never modified, and an update can be paused and resumed at any time.'))}</p>
      </div>
      <div class="dupd-row">
        <button class="adm-btn adm-btn-ghost adm-btn-sm" data-dupd="refresh" title="${escHtml(t('dupd.refresh', 'Refresh'))}"><i data-lucide="refresh-cw"></i> ${escHtml(t('dupd.refresh', 'Refresh'))}</button>
        ${lanesBtn}
        <button class="adm-btn adm-btn-accent" data-dupd="update-all" ${idle.length ? '' : 'disabled'}><i data-lucide="download"></i> ${escHtml(idle.length ? t('dupd.updateAllN', 'Update all ({n})', { n: idle.length }) : t('dupd.updateAll', 'Update all'))}</button>
      </div>
    </div>
    <section class="adm-card dupd-card dupd-speed" id="dupd-speed">${speedCard()}</section>
    ${datasetsCard()}
    ${infoCard()}`;
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
      probeBrowser();
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
      case 'pause': pauseAll(); break;
      case 'resume': resumeAll(); break;
      case 'speed': runSpeed(); break;
      case 'exec': {
        const ds = dsById(id);
        if (ds && !laneOf(id) && canUse(b.dataset.exec, ds)) { setDsExec(id, b.dataset.exec); paint(); }
        break;
      }
      case 'exec-all':
        for (const ds of datasets()) if (needsWork(ds) && !laneOf(ds.id) && canUse(b.dataset.exec, ds)) dsExec()[ds.id] = b.dataset.exec;
        storageSet(DS_EXEC_KEY, JSON.stringify(dsExec()));
        paint();
        break;
      case 'clear-log': storageSet(LOG_KEY, '[]'); paint(); break;
      default: break;
    }
  });
}

export const DatasetUpdatesTab = {
  mount() { bindRoot(); paint(); },
  activate() { bindRoot(); load(); },
  relabel() { paint(); },
};
