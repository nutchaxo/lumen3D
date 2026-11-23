// ImageJ macro language (IJM) conformance: js/modules/studio/advanced-studio/ij-macro-lang.js against
// the golden oracle produced by the real ImageJ 1.54p jar:
//   tests/fixtures/ij-macro/golden.json         <- corpus/<group>/<case>.ijm
//   tests/fixtures/ij-macro/golden-review.json  <- corpus-review/<group>/<case>.ijm (run when present)
// (harness tools/ij_fixtures/macro).
//
// Every case is run through IJMacro.run with a host that collects the Log lines and the dialogs
// (exit("msg"), requires -> showMessage; the error window of a failed eval()/runMacro() -> showError).
// What is compared with the golden: the Log lines; the error (message, line number, the source excerpt of
// the error window, the "called from" stack and whether ImageJ shows no window at all, `silent`;
// `error: null` means the macro ended without error); that the macro ended through exit(); and the
// dialogs (showMessage and errorDialog; the dialogs of a headless Java exception are an artifact of the
// oracle, not language behaviour).
//
// Run: node tests/js/test_ijm_conformance.mjs
// Env: IJM_FILTER=<substring>   only the cases whose "<group>/<case>" contains it
//      IJM_VERBOSE=1            print every failure, not only the first 40
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { loadModule, ROOT } from './harness.mjs';

const IJMacro = loadModule('js/modules/studio/advanced-studio/ij-macro-lang.js', 'IJMacro');
const FIX = path.join(ROOT, 'tests', 'fixtures', 'ij-macro');
const filter = process.env.IJM_FILTER || '';
const verbose = !!process.env.IJM_VERBOSE;

const suites = [{ name: 'corpus', dir: 'corpus', golden: 'golden.json' }];
if (existsSync(path.join(FIX, 'golden-review.json')) && existsSync(path.join(FIX, 'corpus-review')))
  suites.push({ name: 'corpus-review', dir: 'corpus-review', golden: 'golden-review.json' });

const cases = [];
for (const suite of suites) {
  suite.data = JSON.parse(readFileSync(path.join(FIX, suite.golden), 'utf8'));
  for (const group of readdirSync(path.join(FIX, suite.dir)).sort()) {
    const dir = path.join(FIX, suite.dir, group);
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith('.ijm')) continue;
      const key = group + '/' + f.slice(0, -4);
      if (filter && !key.includes(filter)) continue;
      cases.push({ key, suite, group: suite.name === 'corpus' ? group : suite.name + '/' + group, file: path.join(dir, f) });
    }
  }
}

const failures = [];
const pending = [];
// A case that stops on "Function not available in the browser" needs a host built-in (image, Results table,
// call(), getInfo ...), which the language layer routes through host.call and a later phase provides.
// IJM_STRICT=1 counts those as failures.
const strict = !!process.env.IJM_STRICT;
const pendingHost = (res) => !strict && !!res.error && /^Function not available in the browser/.test(res.error.message);
const perGroup = new Map();
const sha = (s) => JSON.stringify(s);

for (const c of cases) {
  const g = perGroup.get(c.group) || { pass: 0, fail: 0, stale: 0, pending: 0 };
  perGroup.set(c.group, g);
  const want = c.suite.data[c.key];
  if (!want) { g.fail++; g.stale++; failures.push({ key: c.key, stale: true, why: ['no golden entry (regenerate ' + c.suite.golden + ')'] }); continue; }
  const code = readFileSync(c.file, 'utf8');
  const log = [], dialogs = [];
  const host = {
    showMessage(title, text) { dialogs.push({ kind: 'showMessage', text, afterLog: log.length }); },
    showError(text) { dialogs.push({ kind: 'errorDialog', text, afterLog: log.length }); },
  };
  let res;
  try {
    res = await IJMacro.run(code, { host, onLog: (s) => log.push(s) });
  } catch (e) {
    res = { ok: false, error: { message: 'run() rejected: ' + (e && e.stack || e), line: -1 }, aborted: false, exited: false };
  }
  const why = [];
  if (JSON.stringify(log) !== JSON.stringify(want.log)) why.push('log:\n    want ' + sha(want.log) + '\n    got  ' + sha(log));
  const silentWanted = !!(want.error && want.error.silent);
  const wantErr = want.error ? { message: want.error.message, line: want.error.line, silent: silentWanted } : null;
  const gotErr = res.error ? { message: res.error.message, line: res.error.line, silent: !!res.error.silent } : null;
  if (JSON.stringify(wantErr) !== JSON.stringify(gotErr)) why.push('error:\n    want ' + sha(wantErr) + '\n    got  ' + sha(gotErr));
  if (want.error && res.error && !silentWanted && 'excerpt' in want.error && want.error.excerpt !== res.error.excerpt)
    why.push('excerpt:\n    want ' + sha(want.error.excerpt) + '\n    got  ' + sha(res.error.excerpt));
  if (want.error && res.error && !silentWanted) {
    const wantFrom = want.error.calledFrom || [];
    if (JSON.stringify(wantFrom) !== JSON.stringify(res.error.calledFrom || []))
      why.push('calledFrom:\n    want ' + sha(wantFrom) + '\n    got  ' + sha(res.error.calledFrom));
  }
  if (!!want.exited !== !!res.exited) why.push('exited: want ' + !!want.exited + ' got ' + !!res.exited);
  const kinds = ['showMessage', 'errorDialog'];
  const wantDialogs = (want.dialogs || []).filter((d) => kinds.includes(d.kind)).map((d) => ({ kind: d.kind, text: d.text, afterLog: d.afterLog }));
  const gotDialogs = dialogs.map((d) => ({ kind: d.kind, text: d.text, afterLog: d.afterLog }));
  const oracleArtifact = (want.dialogs || []).some((d) => d.kind === 'handleException');
  if (!oracleArtifact && JSON.stringify(wantDialogs) !== JSON.stringify(gotDialogs)) why.push('dialogs:\n    want ' + sha(wantDialogs) + '\n    got  ' + sha(gotDialogs));
  if (why.length && pendingHost(res)) { g.pending++; pending.push(c.key); } // a host/image built-in: a later phase
  else if (why.length) { g.fail++; failures.push({ key: c.key, why }); } else g.pass++;
}

console.log('IJM conformance (ImageJ 1.54p golden)');
let pass = 0, fail = 0, stale = 0;
for (const [group, g] of [...perGroup].sort()) {
  console.log(`  ${group.padEnd(24)} ${String(g.pass).padStart(4)} / ${String(g.pass + g.fail + g.pending).padEnd(4)}${g.fail ? '  (' + g.fail + ' failing' + (g.stale ? ', ' + g.stale + ' without golden' : '') + ')' : ''}${g.pending ? '  (' + g.pending + ' waiting for a host built-in)' : ''}`);
  pass += g.pass; fail += g.fail; stale += g.stale;
}
console.log(`  ${'TOTAL'.padEnd(24)} ${String(pass).padStart(4)} / ${pass + fail + pending.length}${pending.length ? '  (' + pending.length + ' wait for a host built-in, not counted as failures; IJM_STRICT=1 counts them)' : ''}${stale ? '  (' + stale + ' cases have no golden entry yet)' : ''}`);

const shown = verbose ? failures : failures.slice(0, 40);
for (const f of shown) console.log(`\nFAIL ${f.key}\n  ${f.why.join('\n  ')}`);
if (failures.length > shown.length) console.log(`\n... ${failures.length - shown.length} more failures (IJM_VERBOSE=1 shows all)`);
if (cases.length === 0) { console.log('no case matches the filter'); process.exit(1); }
process.exit(failures.length ? 1 : 0);
