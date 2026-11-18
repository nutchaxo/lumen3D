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
    'staleCodeDetails', 'staleCodeRecheck'],
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
  assert.ok(d.mkt.staleServerCodeOlder.includes('{filesVersion}'), `${l} older token`);
  assert.ok(d.mkt.staleServerCode.includes('{codeVersion}') && d.mkt.staleServerCode.includes('{filesVersion}'), `${l} stale tokens`);
  assert.ok(d.mkt.unsupportedPlacement.includes('{placement}'), `${l} placement token`);
}

console.log('ok');
