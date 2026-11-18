// The Updates tab's stale-code banner and the Catalog's install refusals are decided
// by pure helpers (js/pages/admin/stale-code.js). Locks: no banner unless the server
// says the code is stale, the remedy per backend, the error codes that get a
// translated sentence, and key parity of every new string across the four locales.
//
// Run: node tests/js/test_stale_code_ui.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describeStaleCode, describeOpcache, INSTALL_ERROR_KEYS } from '../../js/pages/admin/stale-code.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// No banner without a verdict.
assert.equal(describeStaleCode(null), null);
assert.equal(describeStaleCode({}), null);
assert.equal(describeStaleCode({ codeVersion: null, filesVersion: '1.3.0', codeStale: false }), null);
assert.equal(describeStaleCode({ codeVersion: '1.3.0', filesVersion: '1.3.0', codeStale: false }), null);
assert.equal(describeStaleCode({ codeVersion: '1.2.0', filesVersion: null, codeStale: true }), null);

// PHP with parked files: rename them.
const php = { codeVersion: '1.83.0', filesVersion: '1.84.0', codeStale: true, codeDiagnosis: { backend: 'php', direction: 'code_older', parked: ['api/admin.php'] } };
const d1 = describeStaleCode(php);
assert.equal(d1.remedy, 'parked'); assert.deepEqual(d1.parked, ['api/admin.php']);
assert.equal(d1.code, '1.83.0'); assert.equal(d1.files, '1.84.0');
const dg = (diag) => describeStaleCode({ ...php, codeDiagnosis: { backend: 'php', direction: 'code_older', parked: [], ...diag } });

// Nothing parked: the remedy follows what the server found and did.
assert.equal(dg({}).remedy, 'opcache');
assert.equal(describeStaleCode({ ...php, codeDiagnosis: null }).remedy, 'opcache');
// The server just dropped its cache: re-check (and the tab asks once more by itself).
const acted = dg({ recovery: { opcacheReset: false, invalidated: 4, filesTried: 4, swapped: 0, parkedBefore: 0, throttled: false } });
assert.equal(acted.remedy, 'recheck'); assert.equal(acted.retry, true);
assert.equal(dg({ recovery: { opcacheReset: true, invalidated: 0, filesTried: 4, throttled: false } }).remedy, 'recheck');
assert.equal(dg({ swappedEarlier: 2 }).remedy, 'recheck');
// Inside the throttle window the previous attempt is shown, the tab does not loop on it.
assert.equal(dg({ recovery: { invalidated: 4, filesTried: 4, throttled: true } }).retry, false);
// opcache re-reads every N seconds: wait.
const wait = dg({ opcache: { enabled: true, restrictApi: '/x', validateTimestamps: true, revalidateFreq: 60 }, recovery: { invalidated: 0, filesTried: 4 } });
assert.equal(wait.remedy, 'wait'); assert.equal(wait.waitSeconds, 60);
// opcache is off, or the library is older than its entry point: nothing to blame on opcache.
assert.equal(dg({ opcache: { enabled: false, restrictApi: '', validateTimestamps: null, revalidateFreq: null } }).remedy, 'reupload');
const lib = describeStaleCode({ codeVersion: null, filesVersion: '1.84.1', codeStale: true, codeDiagnosis: { backend: 'php', libraryOutdated: true, parked: [] } });
assert.equal(lib.remedy, 'reupload'); assert.equal(lib.code, null);
// Code NEWER than the files: an update stopped half-way.
assert.equal(describeStaleCode({ codeVersion: '1.84.2', filesVersion: '1.84.1', codeStale: true, codeDiagnosis: { backend: 'php', direction: 'code_newer', parked: [] } }).remedy, 'incomplete');
// Python: restart.
assert.equal(describeStaleCode({ ...php, codeDiagnosis: { backend: 'python', action: 'restart', direction: 'code_older' } }).remedy, 'restart');
// The raw facts for the host's support.
assert.equal(describeOpcache(null, null), '');
assert.match(describeOpcache({ enabled: true, restrictApi: '/srv', validateTimestamps: false, revalidateFreq: 2 }, { invalidated: 3, filesTried: 5, opcacheReset: false }),
  /opcache\.restrict_api=\/srv.*validate_timestamps=0.*invalidated=3\/5, reset=no/);

// ---- 1.84.2: the probe (api/_code_probe.php) ----
const pv = (probe, extra = {}, top = {}) => describeStaleCode({ ...php, codeVersion: null, ...top,
  codeDiagnosis: { backend: 'php', direction: 'code_older', parked: [], libraryOutdated: true, probe, ...extra } });
const LATE = { path: 'api/_admin_lib.php', exists: true, writable: false, dirWritable: false, owner: 'sftp', group: 'sftp', perms: '0644', phpOwns: false };
// A late file PHP cannot write: repairable from the banner.
const perm = pv({ cause: 'not_written', outdated: [LATE, 'junk', { nope: 1 }, null], php: { user: 'www-data' } });
assert.equal(perm.remedy, 'permissions'); assert.equal(perm.repairable, true);
assert.equal(perm.cause, 'not_written'); assert.equal(perm.phpUser, 'www-data');
assert.deepEqual(perm.outdated, [LATE], 'outdated keeps only objects with a string path');
assert.equal(perm.reinstall, false);
assert.equal(pv({ cause: 'not_written', outdated: [LATE] }, {}, { reinstallSupported: true }).reinstall, true);
// not_written without a listed file is not repairable.
assert.notEqual(pv({ cause: 'not_written', outdated: [] }).remedy, 'permissions');
assert.equal(pv({ cause: 'opcache', outdated: [] }).repairable, false);
// The probe says the disk is newer than the files version: incomplete update.
assert.equal(pv({ cause: 'incomplete', outdated: [] }).remedy, 'incomplete');
// Parked files and Python still outrank the probe; permissions outrank recheck.
assert.equal(pv({ cause: 'not_written', outdated: [LATE] }, { parked: ['api/a.php'] }).remedy, 'parked');
assert.equal(pv({ cause: 'not_written', outdated: [LATE], recovery: { invalidated: 3, tried: 3, blocked: false } }).remedy, 'permissions');
assert.equal(pv(null, { backend: 'python' }).remedy, 'restart');
// The probe invalidated this process: recheck, then (retries spent) processes.
const POPEN = { cause: 'opcache', outdated: [], recovery: { invalidated: 5, tried: 5, blocked: false } };
const rc = pv(POPEN, { recovery: { throttled: true, invalidated: 0, filesTried: 0 } });
assert.equal(rc.remedy, 'recheck'); assert.equal(rc.retry, true, 'a throttled library recovery is ignored when the probe invalidated');
const spent = describeStaleCode({ ...php, codeVersion: null, codeDiagnosis: { backend: 'php', parked: [], probe: POPEN } }, { retriesExhausted: true });
assert.equal(spent.remedy, 'processes'); assert.equal(spent.retry, false);
// retriesExhausted changes nothing else.
assert.equal(describeStaleCode(php, { retriesExhausted: true }).remedy, 'parked');
// The probe could not clear opcache: ask the host (even when the library is outdated).
const blocked = pv({ cause: 'opcache', outdated: [], recovery: { invalidated: 0, tried: 4, blocked: true } });
assert.equal(blocked.remedy, 'opcache');
// Without a probe cause the old library rule stays.
assert.equal(pv({ outdated: [], recovery: { invalidated: 0, tried: 4, blocked: false } }).remedy, 'reupload');
// Details carry the probe's recovery.
assert.match(describeOpcache(null, null, { invalidated: 2, tried: 6, blocked: true }), /probe invalidated=2\/6, blocked=yes/);
assert.match(blocked.details, /blocked=yes/);

// Install refusals with a sentence of their own (and an English one when the dictionary lacks it).
assert.deepEqual(INSTALL_ERROR_KEYS.stale_server_code.slice(0, 2), ['staleServerCode', ['codeVersion', 'filesVersion']]);
assert.deepEqual(INSTALL_ERROR_KEYS.unsupported_placement.slice(0, 2), ['unsupportedPlacement', ['placement']]);
assert.deepEqual(INSTALL_ERROR_KEYS.bad_plugin_id.slice(0, 2), ['badPluginId', []]);
for (const [code, entry] of Object.entries(INSTALL_ERROR_KEYS)) assert.ok(/ /.test(entry[2]), code + ' has an English fallback sentence');

// The real plugin-update.js, imported with a stubbed shared.js: a missing import used to
// make every install error throw a ReferenceError instead of showing a message.
const dir = mkdtempSync(path.join(tmpdir(), 'lumen-pu-'));
try {
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(path.join(dir, 'shared.js'), [
    "export const API_ADMIN = '/api/admin.php';",
    "export const t = (k, fb, vars) => { let s = fb; for (const [a, b] of Object.entries(vars || {})) s = s.split('{' + a + '}').join(b); return s; };",
    'export const escHtml = (s) => String(s);',
    'export const apiFetch = async () => null; export const apiFetchStatus = async () => ({ ok: false, data: {} });',
    'export const toast = () => {}; export const askPassword = async () => null;',
  ].join('\n'));
  copyFileSync(path.join(ROOT, 'js/pages/admin/stale-code.js'), path.join(dir, 'stale-code.js'));
  copyFileSync(path.join(ROOT, 'js/pages/admin/plugin-update.js'), path.join(dir, 'plugin-update.js'));
  const pu = await import(pathToFileURL(path.join(dir, 'plugin-update.js')).href);
  const stale = pu.installErrorText('stale_server_code', { codeVersion: '1.83.0', filesVersion: '1.84.0' });
  assert.ok(stale.includes('1.83.0') && stale.includes('1.84.0') && !stale.includes('{'), stale);
  const older = pu.installErrorText('stale_server_code', { codeVersion: null, filesVersion: '1.84.0' });
  assert.ok(older.includes('older') && older.includes('1.84.0') && !older.includes('?'), older);
  assert.ok(pu.installErrorText('unsupported_placement', { placement: 'widgets' }).includes('"widgets"'));
  assert.equal(pu.installErrorText('bad_password', {}), '');
  assert.ok(pu.pluginUpdateErrorText('stale_server_code', { codeVersion: '1.83.0', filesVersion: '1.84.0' }).includes('1.83.0'));
  assert.ok(pu.pluginUpdateErrorText('bad_password', {}).length > 0);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// Every key the UI uses exists in every locale, with the placeholders it interpolates.
const langs = ['en', 'fr', 'es', 'nl'].map((l) => [l, JSON.parse(readFileSync(path.join(ROOT, 'lang', `${l}.json`), 'utf8'))]);
const need = {
  admin: ['staleCodeTitle', 'staleCodeBody', 'staleCodeBodyOlder', 'staleCodeBodyNewer', 'staleCodeRemedyParked', 'staleCodeRemedyOpcache',
    'staleCodeRemedyRestart', 'staleCodeRemedyRecheck', 'staleCodeRemedyWait', 'staleCodeRemedyIncomplete', 'staleCodeRemedyReupload',
    'staleCodeDetails', 'staleCodeRecheck', 'staleCodeRemedyProcesses', 'staleCodeRemedyPermissions',
    'staleCodeRemedyPermissionsReinstall', 'staleCodeYes', 'staleCodeNo', 'staleCodeWritable', 'staleCodeReplaceable', 'updateErr_reinstall_version_mismatch', 'updateErr_reinstall_version_differs', 'staleCodePhpUser', 'staleCodeRepair',
    'staleCodeRepairReinstall', 'staleCodeRepairing', 'staleCodeRepairDone', 'staleCodeReinstalled', 'staleCodeReinstallFailed',
    'staleCodeCannotWrite'],
  mkt: ['staleServerCode', 'staleServerCodeOlder', 'unsupportedPlacement', 'badPluginId'],
};
for (const [l, d] of langs) {
  for (const [sec, keys] of Object.entries(need)) {
    for (const k of keys) assert.ok(typeof d[sec]?.[k] === 'string' && d[sec][k].length > 0, `${l}.${sec}.${k}`);
  }
  assert.ok(d.admin.staleCodeBody.includes('{code}') && d.admin.staleCodeBody.includes('{files}'), `${l} body tokens`);
  assert.ok(d.admin.staleCodeRemedyParked.includes('{files}'), `${l} parked token`);
  assert.ok(d.admin.staleCodeBodyOlder.includes('{files}') && d.admin.staleCodeBodyNewer.includes('{code}') && d.admin.staleCodeBodyNewer.includes('{files}'), `${l} body tokens (older/newer)`);
  assert.ok(d.admin.staleCodeRemedyWait.includes('{seconds}') && d.admin.staleCodeRemedyIncomplete.includes('{code}') && d.admin.staleCodeRemedyReupload.includes('{files}') && d.admin.staleCodeDetails.includes('{details}'), `${l} remedy tokens`);
  assert.ok(d.admin.staleCodeRepairReinstall.includes('{files}') && d.admin.staleCodeRemedyPermissions.includes('{files}')
    && d.admin.staleCodeWritable.includes('{w}') && d.admin.staleCodeReplaceable.includes('{w}') && d.admin.updateErr_reinstall_version_mismatch.includes('{latest}') && d.admin.staleCodePhpUser.includes('{user}')
    && d.admin.staleCodeRepairDone.includes('{fixed}') && d.admin.staleCodeRepairDone.includes('{failed}'), `${l} repair tokens`);
  assert.ok(d.mkt.staleServerCodeOlder.includes('{filesVersion}'), `${l} older token`);
  assert.ok(d.mkt.staleServerCode.includes('{codeVersion}') && d.mkt.staleServerCode.includes('{filesVersion}'), `${l} stale tokens`);
  assert.ok(d.mkt.unsupportedPlacement.includes('{placement}'), `${l} placement token`);
}

// Probe-only facts (old library fallback): incomplete names the disk library; opcache settings stand in.
{
  const inc = describeStaleCode({ codeStale: true, codeVersion: null, filesVersion: '1.84.2',
    codeDiagnosis: { backend: 'php', libraryOutdated: true, probe: { cause: 'incomplete', library: { diskVersion: '1.84.3' } } } });
  assert.equal(inc.remedy, 'incomplete');
  assert.equal(inc.code, '1.84.3');
  const w = describeStaleCode({ codeStale: true, codeVersion: null, filesVersion: '1.84.2',
    codeDiagnosis: { backend: 'php', libraryOutdated: true, probe: { cause: 'opcache', opcache: { enabled: true, restrictApi: '/x', validateTimestamps: true, revalidateFreq: 2 },
      recovery: { invalidated: 0, tried: 5, blocked: true } } } });
  assert.equal(w.remedy, 'wait');
  assert.equal(w.waitSeconds, 2);
  assert.ok(w.details.includes('opcache.revalidate_freq=2') && w.details.includes('blocked=yes'));
}

console.log('ok');
