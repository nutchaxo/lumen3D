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
 *   wait         PHP: opcache re-reads changed files every `waitSeconds`
 *   reupload     PHP: nothing explains it (opcache off, or a library older than its entry point)
 *   opcache      PHP: opcache is the cause and the host blocks us from clearing it
 * `retry` is true when the server acted on this very request (the answer still comes
 * from the old bytecode), so the tab should ask again before alarming the operator;
 * `opts.retriesExhausted` says it already did, so a recheck becomes `processes`.
 * @param {object} v the `version` answer
 * @param {{retriesExhausted?: boolean}} [opts]
 * @returns {null | {code:?string, files:string, remedy:string, parked:string[],
 *                   waitSeconds:number, retry:boolean, details:string, cause:?string,
 *                   outdated:object[], phpUser:?string, reinstall:boolean, repairable:boolean}}
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
  let remedy;
  if (diag.direction === 'code_newer' || cause === 'incomplete') remedy = 'incomplete';
  else if (diag.backend === 'python') remedy = 'restart';
  else if (parked.length) remedy = 'parked';
  else if (cause === 'not_written' && outdated.length) remedy = 'permissions';
  else if (acted) remedy = opts && opts.retriesExhausted ? 'processes' : 'recheck';
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
    remedy, parked, waitSeconds,
    retry: remedy === 'recheck' && !(rec && rec.throttled && !probeInvalidated),
    details: describeOpcache(oc, rec, prec),
    cause, outdated, phpUser,
    reinstall: v.reinstallSupported === true,
    repairable: remedy === 'permissions',
  };
}

/** The raw opcache facts, one line the operator can forward to the host's support. */
export function describeOpcache(oc, rec, prec) {
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
