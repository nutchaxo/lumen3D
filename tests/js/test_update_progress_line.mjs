// The self-update progress line is built in the browser from the server's phase and
// byte counts, in the admin's language — never the server's own (French) log line.
// Every phase dev_server.py reports has its own translated line, and the four locale
// files carry each key.
//
// Run: node tests/js/test_update_progress_line.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ROOT } from './harness.mjs';

const src = readFileSync(path.join(ROOT, 'js/pages/admin/tab-updates.js'), 'utf8');
const server = readFileSync(path.join(ROOT, 'dev_server.py'), 'utf8');

function slice(startPattern) {
  const start = src.indexOf(startPattern);
  assert.ok(start >= 0, `missing ${startPattern}`);
  // Balanced braces/brackets from the first opener after the pattern.
  const open = src.slice(start).search(/[[{]/) + start;
  const pairs = { '[': ']', '{': '}' };
  const stack = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      for (i++; i < src.length && src[i] !== q; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ']' || c === '}') {
      assert.equal(stack.pop(), c);
      if (!stack.length) return src.slice(start, i + 1) + ';';
    }
  }
  throw new Error('unbalanced ' + startPattern);
}

const code = [slice('const PHASES = ['), slice('const PROGRESS_LINES = {'),
  slice('function progressLine(s) {')].join('\n') + '\nreturn { PROGRESS_LINES, progressLine };';

const dict = JSON.parse(readFileSync(path.join(ROOT, 'lang/en.json'), 'utf8'));
const lookup = (key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), dict);
const t = (key, def, params) => {
  const v = lookup(key);
  const s = typeof v === 'string' ? v : def;
  return s.replace(/\{(\w+)\}/g, (m, n) => (params && n in params ? String(params[n]) : m));
};
const Utils = { formatFileSize: (n) => `${(n / 1048576).toFixed(1)} MB` };
const { PROGRESS_LINES, progressLine } = new Function('t', 'Utils', code)(t, Utils);

// The server's own sentence is never displayed.
assert.ok(!/s\.message/.test(src), 'tab-updates.js must not display the server message');
assert.equal(progressLine({ phase: 'backup', message: 'Sauvegarde de l\'installation…' }),
  lookup('admin.updateMsgBackup') || PROGRESS_LINES.backup[1]);

// Byte counts formatted by the client, no literal "Mo".
const dl = progressLine({ phase: 'download', done: 3 * 1048576, total: 12 * 1048576 });
assert.ok(dl.includes('3.0 MB') && dl.includes('12.0 MB'), dl);
assert.ok(!dl.includes('{'), dl);
// Download without byte counts yet: the phase line.
assert.equal(progressLine({ phase: 'download', done: null, total: null }),
  t(PROGRESS_LINES.download[0], PROGRESS_LINES.download[1]));
// Error line, and an unknown phase falls back to its chip label or nothing.
assert.equal(progressLine({ phase: 'error' }), t(PROGRESS_LINES.error[0], PROGRESS_LINES.error[1]));
assert.equal(progressLine({ phase: 'restart' }), t('admin.phaseRestart', 'x'));
assert.equal(progressLine({ phase: 'mystery' }), '');

// Every phase the Python server reports has a line.
const phases = new Set([...server.matchAll(/_set_update\(\s*"(\w+)"/g)].map((m) => m[1]));
for (const m of server.matchAll(/"phase":\s*"(\w+)",\s*"pct"/g)) phases.add(m[1]);
phases.delete('idle');
assert.ok(phases.size >= 9, [...phases].join(','));
for (const p of phases) assert.ok(PROGRESS_LINES[p], `no progress line for server phase ${p}`);

// Once the keys are in the dictionaries, every locale carries every one of them.
const keys = [...Object.values(PROGRESS_LINES).map((l) => l[0]), 'admin.updateMsgDownloadBytes'];
const present = {};
for (const lang of ['en', 'fr', 'es', 'nl']) {
  const d = JSON.parse(readFileSync(path.join(ROOT, `lang/${lang}.json`), 'utf8'));
  present[lang] = keys.filter((k) => typeof k.split('.').reduce((o, s) => (o && typeof o === 'object' ? o[s] : undefined), d) === 'string');
}
if (present.en.length) {
  for (const lang of Object.keys(present)) assert.deepEqual(present[lang], keys, `lang/${lang}.json progress lines`);
} else {
  console.log('note: progress-line keys not in lang/*.json yet; the French fallback shows');
}

console.log('test_update_progress_line: ok');
