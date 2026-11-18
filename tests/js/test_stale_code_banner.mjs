// The stale-code banner of the Updates tab (staleCodeBlock in tab-updates.js) must
// name the parked files in its remedy sentence. The shared t() interpolates {files}
// itself, so passing the version as `files` once left "(1.84.1)" instead of the list.
//
// Run: node tests/js/test_stale_code_banner.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (s) => s.replace(/^import\s[^;]*;/gm, '').replace(/^export\s+(function|const|let|class)/gm, '$1');

// Same interpolation as the real t(): the params fill every {name} of the sentence.
const t = (k, d, params) => {
  let v = d ?? '';
  for (const [n, val] of Object.entries(params || {})) v = v.replace(new RegExp(`\\{${n}\\}`, 'g'), String(val));
  return v;
};

function load() {
  const src = strip(read('js/pages/admin/stale-code.js')) + '\n' + strip(read('js/pages/admin/tab-updates.js')) + `
;globalThis.__T = { setVersions: (v) => { _versions = v; }, block: () => staleCodeBlock() };`;
  const ctx = vm.createContext({
    console, JSON, Math, Number, Array, Object, String, Boolean, Date, Promise, RegExp,
    setTimeout() {}, clearTimeout() {},
    API_ADMIN: 'api/admin.php',
    Utils: {}, t,
    escHtml: (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    apiFetch: async () => null, apiFetchStatus: async () => null, toast() {},
    el: () => null, refreshIcons() {},
    renderReleaseNotesTree: () => '',
    fetchPluginUpdates: async () => ({ configured: true, list: [] }),
    runPluginUpdates: async () => ({}), updateAffordance: () => '',
    document: { querySelectorAll: () => [] }, location: { reload() {} },
    fetch: async () => ({ ok: false }),
  });
  vm.runInContext(src, ctx, { filename: 'tab-updates.js' });
  return ctx.__T;
}

const OPCACHE = { enabled: true, restrictApi: '', validateTimestamps: true, revalidateFreq: 2 };

// Parked files: the remedy lists them, never the files' version.
{
  const T = load();
  T.setVersions({
    codeStale: true, codeVersion: '1.82.1', filesVersion: '1.84.1',
    codeDiagnosis: {
      backend: 'php', direction: 'code_older', parked: ['api/_admin_lib.php'], opcache: OPCACHE,
      recovery: { opcacheReset: false, invalidated: 0, swapped: 0, parkedBefore: 1 },
    },
  });
  const out = T.block();
  assert.ok(out.includes('rename each *.lumen-new file over its target (api/_admin_lib.php)')
    || out.includes('(api/_admin_lib.php)'), 'remedy names the parked file');
  assert.ok(!out.includes('(1.84.1)'), 'remedy must not show the files version in place of the list');
  // Body keeps the versions.
  assert.ok(out.includes('version 1.82.1') && out.includes('version 1.84.1'), 'body states both versions');
}

// Several parked files are joined.
{
  const T = load();
  T.setVersions({
    codeStale: true, codeVersion: '1.82.1', filesVersion: '1.84.1',
    codeDiagnosis: { backend: 'php', direction: 'code_older', parked: ['api/a.php', 'api/b.php'], opcache: OPCACHE },
  });
  assert.ok(T.block().includes('api/a.php, api/b.php'));
}

// Other remedies still receive the files version (reupload) and the wait (wait).
{
  const T = load();
  T.setVersions({
    codeStale: true, codeVersion: '1.82.1', filesVersion: '1.84.1',
    codeDiagnosis: { backend: 'php', direction: 'code_older', parked: [], opcache: { ...OPCACHE, validateTimestamps: false, revalidateFreq: 0 }, libraryOutdated: true },
  });
  assert.ok(T.block().includes('Upload the files of version 1.84.1 again'));
  T.setVersions({
    codeStale: true, codeVersion: '1.82.1', filesVersion: '1.84.1',
    codeDiagnosis: { backend: 'php', direction: 'code_older', parked: [], opcache: OPCACHE },
  });
  assert.ok(T.block().includes('every 2 s'));
}

console.log('test_stale_code_banner: OK');
