// Admin toasts and panels put a refused request into the admin's language: the trash
// dialog maps the trash engines' codes and pinned English sentences, the media picker
// maps the media endpoints' fixed sentences, and the Data updates tab and the import
// keep exception text ("Failed to fetch", a worker's message) in the console.
//
// Run: node tests/js/test_admin_error_wording.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './harness.mjs';

// ── minimal browser surface + an I18n that answers "<key>" so the test sees the key ──
globalThis.window = { addEventListener() {}, location: { origin: 'http://h' } };
globalThis.document = {
  title: 'Admin', getElementById: () => null, addEventListener() {}, querySelector: () => null,
  createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {}, appendChild() {}, classList: { add() {} } }),
};
globalThis.I18n = { t: (k) => `«${k}»` };

const logged = [];
const realError = console.error;
console.error = (...a) => { logged.push(a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ')); };

const trash = await import(pathToFileURL(path.join(ROOT, 'js/pages/admin/dataset-trash.js')).href);
const controls = await import(pathToFileURL(path.join(ROOT, 'js/pages/admin/pages-controls.js')).href);

// ── 1. Every answer of dataset_trash.py / api/_trash_lib.php has words of its own ──
{
  const codes = ['busy', 'use_import_discard', 'trash_unavailable', 'corrupt_entry', 'purge_incomplete',
    'Dataset not found', 'Invalid dataset ID', 'Not in trash', 'Invalid folder name'];
  for (const twin of ['dataset_trash.py', 'api/_trash_lib.php']) {
    const src = readFileSync(path.join(ROOT, twin), 'utf8');
    const answered = new Set([...src.matchAll(/["']error["']\s*(?::|=>)\s*["']([^"']+)["']/g)].map((m) => m[1]));
    answered.delete('exists');   // a question to the operator, handled by the restore dialog itself
    for (const c of answered) assert.ok(codes.includes(c), `${twin} answers "${c}", which the trash dialog does not word`);
  }
  const seen = new Set();
  for (const code of codes) {
    const text = trash.trashReason({ ok: false, status: 409, data: { error: code } });
    assert.match(text, /^«admin\.[A-Za-z]+»$/, `${code} → a translation key, got ${text}`);
    assert.ok(!text.includes(code), `the raw "${code}" never reaches the toast`);
    seen.add(text);
  }
  assert.equal(seen.size, codes.length, 'each cause has its own sentence');

  logged.length = 0;
  assert.equal(trash.trashReason({ ok: false, status: 500, data: { error: 'io_error' } }), '«admin.unknownError»');
  assert.ok(logged.some((l) => l.includes('io_error')), 'an unknown code goes to the console');
  assert.equal(trash.trashReason({ ok: false, status: 0, data: null }), '«admin.trashNoAnswer»', 'no answer at all');
  logged.length = 0;
  trash.trashReason({ ok: false, status: 409, data: { error: 'busy', detail: '[WinError 32] used by another process' } });
  assert.ok(logged.some((l) => l.includes('WinError 32')), 'the OS detail of a known code is logged, not shown');
}

// ── 2. The media picker never prints the endpoint's sentence as received ──
{
  const sentences = new Set();
  const py = readFileSync(path.join(ROOT, 'dev_server.py'), 'utf8');
  const php = readFileSync(path.join(ROOT, 'api/media.php'), 'utf8');
  for (const m of py.matchAll(/_MEDIA_BAD_(?:TYPE|SIZE) = "([^"]+)"/g)) sentences.add(m[1]);
  for (const m of py.matchAll(/return \{"ok": False, "error": "([^"]+)"\}/g)) sentences.add(m[1]);
  for (const m of php.matchAll(/'ok' => false, 'error' => '([^']+)'/g)) sentences.add(m[1]);
  assert.ok(sentences.size >= 3, 'the media twins\' refusals were found');
  for (const s of sentences) {
    const text = controls.mediaUploadError({ ok: true, status: 200, data: { ok: false, error: s } });
    assert.match(text, /^«pages\.media\.err[A-Za-z]+»$/, `"${s}" → its own key, got ${text}`);
  }
  assert.equal(controls.mediaUploadError({ ok: false, status: 413, data: null }), '«pages.media.errSize»', 'a host body limit');
  assert.equal(controls.mediaUploadError({ ok: false, status: 0, data: null }), '«pages.media.uploadErr»');
  assert.equal(controls.mediaUploadError({ ok: false, status: 500, data: { error: 'internal_error' } }), '«pages.media.uploadErr»');
}

// ── 3. Exception text stays in the console (Data updates, import worker) ──
{
  const runner = readFileSync(path.join(ROOT, 'js/pages/admin/migration-runner.js'), 'utf8');
  assert.match(runner, /code: 'auto_retry', errCode: err && err\.code/, 'an automatic restart carries the cause\'s code');
  const tab = readFileSync(path.join(ROOT, 'js/pages/admin/tab-dataset-updates.js'), 'utf8');
  assert.ok(!/toastAutoRetry[^\n]*error: e\.error/.test(tab), 'the restart toast does not print the exception');
  assert.ok(!/speedFailed[^\n]*err\.message/.test(tab), 'the speed-test toast does not print the exception');
  assert.ok(!/: e\.error \}\), 'error'\)/.test(tab), 'the failure toast does not print the exception');
  assert.ok(!/return s\.error;/.test(tab), 'a speed-test side is not described by its exception');
  const upl = readFileSync(path.join(ROOT, 'js/pages/admin/upload-manager.js'), 'utf8');
  assert.ok(!/errWorker[^;]*e\.message/.test(upl), 'the import worker\'s message is not appended to the sentence');
}

console.error = realError;
console.log('PASS test_admin_error_wording');
