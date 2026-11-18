/**
 * Admin SPA — stale server code
 * =============================
 * The `version` action of both backends reports the release the EXECUTING code was
 * built as (`codeVersion`) next to the release of the files on disk (`filesVersion`).
 * They differ when PHP keeps serving compiled bytecode (opcache), when an update's
 * files are parked as *.lumen-new, when an update stopped half-way, or when the
 * Python server was not restarted.
 *
 * Pure: no DOM, no imports. Turns the server's answer into what the Updates tab
 * should say, so the decision can be tested without a browser.
 */

'use strict';

/**
 * remedy:
 *   incomplete   the code is NEWER than the files: an update stopped half-way, run it again
 *   restart      Python: restart the server
 *   parked       PHP: update files are still parked as *.lumen-new
 *   permissions  PHP: files that PHP could not write are still the old ones (repairable from here)
 *   recheck      PHP: the server just dropped its cached code, the next request is fresh
 *   processes    PHP: this process dropped its cache, others of the host still hold the old one
 *   wait         PHP: opcache re-reads changed files every `waitSeconds`; `touched` > 0 means the
 *                server just gave its files a fresh date (what opcache compares), so the tab
 *                re-checks by itself after `autoRecheckSeconds`
 *   touch        PHP: opcache compares file dates, the dates could not be refreshed from here
 *                and invalidation is blocked: waiting cannot help, upload the files again
 *   touchNoEffect PHP: the dates were refreshed and the wait is over, the code is still old
 *   reupload     PHP: nothing explains it (opcache off, or a library older than its entry point)
 *   opcache      PHP: opcache is the cause and the host blocks us from clearing it
 * `retry` is true when the server acted on this very request (the answer still comes
 * from the old bytecode), so the tab should ask again before alarming the operator;
 * `opts.retriesExhausted` says it already did, so a recheck becomes `processes`;
 * `opts.autoRecheckDone` says the tab's automatic re-check already ran and the code is
 * still old, so `wait` becomes `touchNoEffect`.
 * @param {object} v the `version` answer
 * @param {{retriesExhausted?: boolean, autoRecheckDone?: boolean}} [opts]
 * @returns {null | {code:?string, files:string, remedy:string, parked:string[],
 *                   waitSeconds:number, touched:number, touchFailed:number, autoRecheckSeconds:number,
 *                   retry:boolean, details:string, cause:?string,
 *                   outdated:object[], phpUser:?string, reinstall:boolean, repairable:boolean,
 *                   backend:string, fixable:boolean}}
 */
export function describeStaleCode(v, opts = {}) {
  if (!v || v.codeStale !== true || !v.filesVersion) return null;
  const diag = v.codeDiagnosis || {};
  const parked = Array.isArray(diag.parked) ? diag.parked.filter((p) => typeof p === 'string') : [];
  const probe = diag.probe && typeof diag.probe === 'object' ? diag.probe : null;
  // The old-library fallback has no diagnosis of its own: the probe's opcache facts stand in.
  const oc = diag.opcache && typeof diag.opcache === 'object' ? diag.opcache
    : probe && probe.opcache && typeof probe.opcache === 'object' ? probe.opcache : null;
  const rec = diag.recovery && typeof diag.recovery === 'object' ? diag.recovery : null;
  const prec = probe && probe.recovery && typeof probe.recovery === 'object' ? probe.recovery : null;
  const cause = probe && typeof probe.cause === 'string' ? probe.cause : null;
  const outdated = probe && Array.isArray(probe.outdated)
    ? probe.outdated.filter((o) => o && typeof o === 'object' && typeof o.path === 'string') : [];
  const phpUser = probe && probe.php && typeof probe.php.user === 'string' ? probe.php.user : null;
  const probeInvalidated = !!prec && Number(prec.invalidated) > 0;
  const acted = !!rec && (rec.opcacheReset === true || rec.invalidated > 0 || rec.swapped > 0 || rec.parkedBefore > 0)
    || Number(diag.swappedEarlier) > 0 || probeInvalidated;
  const waitSeconds = oc && oc.validateTimestamps === true && oc.revalidateFreq > 0 ? oc.revalidateFreq : 0;
  // What the server did to the dates of its files: the probe's report, else the library's own recovery.
  const touched = Math.max(0, Number(prec && prec.touched) || Number(rec && rec.touched) || 0);
  const touchFailed = Math.max(0, Number(prec && prec.touchFailed) || Number(rec && rec.touchFailed) || 0);
  const libSource = prec && prec.libTouched !== undefined ? prec : rec;
  const libTouched = libSource && typeof libSource.libTouched === 'boolean' ? libSource.libTouched : null;
  const touchFailedFiles = [prec, rec].map((r) => (r && Array.isArray(r.touchFailedFiles) ? r.touchFailedFiles : []))
    .reduce((a, b) => a.concat(b), []).filter((f) => typeof f === 'string').slice(0, 20);
  const blocked = !!prec && prec.blocked === true;
  const touchReported = !!prec && typeof prec.touched === 'number';
  let remedy;
  if (diag.direction === 'code_newer' || cause === 'incomplete') remedy = 'incomplete';
  else if (diag.backend === 'python') remedy = 'restart';
  else if (parked.length) remedy = 'parked';
  else if (cause === 'not_written' && outdated.length) remedy = 'permissions';
  else if (acted) remedy = opts && opts.retriesExhausted ? 'processes' : 'recheck';
  // Waiting cannot help when the date of the library (or of every file) could not be
  // refreshed, nor when the automatic re-check already ran and the code is still old.
  // A probe that reports its touches but refreshed none (none eligible, or all failed)
  // leaves the dates as they were: waiting cannot help either.
  else if (waitSeconds && blocked && (touchFailed > 0 || touchReported) && (touched === 0 || libTouched === false)) remedy = 'touch';
  // The dates were refreshed and the delay has passed, yet the code is old: another cause.
  else if (waitSeconds && touched > 0 && opts && opts.autoRecheckDone) remedy = 'touchNoEffect';
  else if (waitSeconds) remedy = 'wait';
  else if (prec && prec.blocked === true) remedy = 'opcache';
  else if (cause !== 'opcache' && (diag.libraryOutdated || (oc && oc.enabled === false))) remedy = 'reupload';
  else remedy = 'opcache';
  // "Newer code" found by the probe is the library on disk, not the (old) executing one.
  const diskVersion = probe && probe.library && typeof probe.library.diskVersion === 'string' ? probe.library.diskVersion : null;
  const code = remedy === 'incomplete' && cause === 'incomplete' && diskVersion ? diskVersion
    : (v.codeVersion ? String(v.codeVersion) : null);
  return {
    code,
    files: String(v.filesVersion),
    remedy, parked, waitSeconds, touched, touchFailed,
    // The dates were refreshed: PHP re-reads within waitSeconds; a margin covers the request in flight.
    autoRecheckSeconds: remedy === 'wait' && touched > 0 ? waitSeconds + 5 : 0,
    retry: remedy === 'recheck' && !(rec && rec.throttled && !probeInvalidated),
    details: describeOpcache(oc, rec, prec, touchFailedFiles),
    cause, outdated, phpUser,
    reinstall: v.reinstallSupported === true,
    repairable: remedy === 'permissions',
    backend: diag.backend === 'python' ? 'python' : 'php',
    // "Try to fix automatically" acts on a PHP host; a Python process can only be restarted by hand.
    fixable: diag.backend !== 'python' && remedy !== 'restart',
  };
}

/** The raw opcache facts, one line the operator can forward to the host's support. */
export function describeOpcache(oc, rec, prec, touchFailedFiles) {
  const parts = [];
  if (oc) {
    const yn = (b) => (b === null || b === undefined ? '?' : b ? '1' : '0');
    parts.push(`opcache.enable=${yn(oc.enabled)}`, `opcache.restrict_api=${oc.restrictApi ? oc.restrictApi : '(none)'}`,
      `opcache.validate_timestamps=${yn(oc.validateTimestamps)}`,
      `opcache.revalidate_freq=${oc.revalidateFreq === null || oc.revalidateFreq === undefined ? '?' : oc.revalidateFreq}`);
  }
  if (rec) {
    parts.push(`invalidated=${Number(rec.invalidated) || 0}/${Number(rec.filesTried) || 0}`, `reset=${rec.opcacheReset ? 'yes' : 'no'}`);
  }
  if (prec) {
    parts.push(`probe invalidated=${Number(prec.invalidated) || 0}/${Number(prec.tried) || 0}`, `blocked=${prec.blocked ? 'yes' : 'no'}`);
  }
  const touchSource = prec && prec.touched !== undefined ? prec : rec && rec.touched !== undefined ? rec : null;
  if (touchSource) {
    parts.push(`touched=${Number(touchSource.touched) || 0}`);
    if (Number(touchSource.touchFailed) > 0) {
      parts.push(`touchFailed=${Number(touchSource.touchFailed)}`);
      if (Array.isArray(touchFailedFiles) && touchFailedFiles.length) parts.push(`touchFailedFiles=${touchFailedFiles.join(' ')}`);
    }
  }
  return parts.join(', ');
}

/** Install/update error codes that mean "the server cannot do this": the
 *  translation key (under `mkt.`), the fields of the payload it interpolates, and
 *  an English sentence for a dictionary that lacks the key (never a bare code). */
export const INSTALL_ERROR_KEYS = {
  stale_server_code: ['staleServerCode', ['codeVersion', 'filesVersion'],
    'The server still runs the code of version {codeVersion} while its files are version {filesVersion}. Restart it, or ask the host to clear opcache, before installing plugins.'],
  unsupported_placement: ['unsupportedPlacement', ['placement'],
    'This plugin targets the placement "{placement}", which this platform does not support.'],
  bad_plugin_id: ['badPluginId', [], 'This catalog entry has an invalid plugin identifier.'],
};
