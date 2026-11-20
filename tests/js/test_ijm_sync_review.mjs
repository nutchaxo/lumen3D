// Regression tests for the findings of DOCS/studio-advanced/macros/REVIEW-speed.md: recursion stays abortable and
// stack-safe, the generator tool refuses what it cannot transform, host hooks that answer with a Promise, internal faults
// are not swallowed by library catches, and the corpus gives the same result against an asynchronous host.
// Run: node tests/js/test_ijm_sync_review.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadModule, ROOT } from './harness.mjs';
import { generate, TARGET } from '../../tools/gen_ijm_sync.mjs';

const REL = 'js/modules/studio/advanced-studio/ij-macro-lang.js';
const IJMacro = loadModule(REL, 'IJMacro');
const K = IJMacro.K;

/* A child process with a small native stack (a Chromium worker's is about this size): the deepest recursion must match. */
if (process.argv.includes('--stack-child')) {
  const out = {};
  const fn = 'function f(n) { if (n == 0) return 0; return f(n - 1) + 1; }\n';
  const go = async (name, code, opts) => {
    const log = [];
    const r = await IJMacro.run(code, Object.assign({ onLog: (s) => log.push(s) }, opts));
    out[name] = { log, ok: r.ok, err: r.error && r.error.message };
  };
  for (const [label, opts] of [['gen', { fastPath: false }], ['default', {}]]) {
    await go(label + '-990', fn + 'print(f(990));', opts);
    await go(label + '-eval', 'c = "' + fn.replace(/\n/g, ' ') + ' print(f(800));"; s = eval(c); print("done");', opts);
  }
  console.log(JSON.stringify(out));
  process.exit(0);
}

let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log('  ok   ' + name);
  else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
};
console.log('IJMacro review fixes (REVIEW-speed.md)');

const classes = (code, opts) => IJMacro.analyze(code, opts).statements.map((x) => x.class).join();
const run = async (code, opts = {}) => {
  const log = [];
  const res = await IJMacro.run(code, Object.assign({ onLog: (s) => log.push(s) }, opts));
  return { res, log };
};
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = path.join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ijm') ? [p] : [];
});

/* ---- findings 1 and 2: a recursion is not run whole in the twin ---- */
{
  const fibSrc = 'function fib(n) { if (n < 2) return n; return fib(n - 1) + fib(n - 2); }\nprint(fib(30));';
  const an = IJMacro.analyze(fibSrc + '\nfunction a(n) { return b(n); } function b(n) { if (n > 0) return a(n - 1); return 0; } x = a(3); y = p(1); function p(n) { return n + 1; }');
  check('direct and mutual recursion are flagged recursive, a plain function is not',
    an.functions.fib.recursive && an.functions.a.recursive && an.functions.b.recursive && !an.functions.p.recursive, an.functions);
  check('a statement that calls into a recursion is class loop (generator control)', classes(fibSrc) === 'loop', classes(fibSrc));
  check('a function that calls a recursive one counts as recursive', IJMacro.analyze('function f(n) { if (n < 1) return 0; return f(n - 1); }\nfunction g() { return f(3); }\nx = g();').functions.g.recursive);
  check('syncRecursion puts the call back in the twin', classes('function f(n) { if (n < 1) return 0; return f(n - 1); }\nx = f(5);', { syncRecursion: true }) === 'twin');
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const t = Date.now();
  const r = await run(fibSrc.replace('30', '40'), { signal: ac.signal });
  const dt = Date.now() - t;
  check('a recursion is aborted by the signal within 250 ms (it was 3 s and aborted:false before)', r.res.aborted && dt < 250, { dt, aborted: r.res.aborted });
  const rr = await run('function f(n) { if (n < 2) return n; return f(n - 1) + f(n - 2); }\nprint(f(15));');
  const rg = await run('function f(n) { if (n < 2) return n; return f(n - 1) + f(n - 2); }\nprint(f(15));', { fastPath: false });
  const rs = await run('function f(n) { if (n < 2) return n; return f(n - 1) + f(n - 2); }\nprint(f(15));', { syncRecursion: true });
  check('same value in the three modes', rr.log[0] === '610' && rg.log[0] === '610' && rs.log[0] === '610', [rr.log, rg.log, rs.log]);
}
{
  const child = fileURLToPath(import.meta.url);
  const out = spawnSync(process.execPath, ['--stack-size=500', child, '--stack-child'], { encoding: 'utf8', timeout: 180000 });
  let res = null;
  try { res = JSON.parse(out.stdout.trim().split('\n').pop()); } catch { /* reported below */ }
  const same = res && ['990', 'eval'].every((k) => JSON.stringify(res['gen-' + k]) === JSON.stringify(res['default-' + k]));
  check('--stack-size=500: recursion depth 990 and an eval at depth 800 give the generator result', res !== null && same && res['default-990'].log[0] === '990' && res['default-eval'].log.join('|') === '800|done', { res, err: (out.stderr || '').slice(0, 300) });
}

/* ---- finding 5 and 6: the generator tool refuses what it cannot transform ---- */
{
  const src = readFileSync(TARGET, 'utf8');
  const anchor = src.indexOf("define('do', K_DUMP");
  const eol = src.indexOf('\n', anchor);
  const splice = (text) => src.slice(0, eol + 1) + text + '\n' + src.slice(eol + 1);
  const gen = (text) => { try { generate(text); return null; } catch (e) { return String(e.message); } };
  check('generate() accepts the real source', gen(src) === null);
  let err = gen(splice("define('num', K_GET_ZOOM, (f) => { return f.getArg(); });"));
  check('generate() refuses `(f) => { return f.getArg(); }`', err !== null && /without `yield\*`/.test(err), err);
  err = gen(splice("define('num', K_SCREEN_WIDTH, (fn) => fn.getArg());"));
  check('generate() refuses `(fn) => fn.getArg()`', err !== null && /without `yield\*`/.test(err), err);
  err = gen(splice("define('num', K_GET_ZOOM, (f) => f.getArg$s()); define('num', K_SCREEN_WIDTH, (f) => f.getArg$s());"));
  check('generate() refuses two define( in one statement', err !== null && /one define\(/.test(err), err);
  const ij = src.indexOf("    case 'checksum': {");
  err = gen(src.slice(0, ij) + "    case 'foo': { it.getParens(); return yield* f.hostCall('IJ.foo', []); }\n" + src.slice(ij));
  check('generate() refuses a host-reaching IJ.* case missing from the suspends map', err !== null && /`foo`/.test(err), err);
  const li = src.indexOf("  } else if (name === 'getList')");
  err = gen(src.slice(0, li) + "  } else if (name === 'poke') {\n    yield* f.hostCall('List.poke', []);\n" + src.slice(li));
  check('... and a List.* branch written as `name === ...`', err !== null && /`poke`/.test(err), err);
  // the runtime guard: a built-in of the fast path that returns an iterator is an internal error, never a value
  IJMacro.define('num', K.GET_ZOOM, function* () { return 1; }, { suspends: false, sync: () => (function* () { return 1; })() });
  const g = await run('x = getZoom(); print(x);');
  check('a twin built-in that returns an iterator is an Internal error', !g.res.ok && /Internal error/.test(g.res.error.message), g.res.error);
  IJMacro.define('num', K.GET_ZOOM, function* (f) { f.interp.getParens(); return 1; });
}

/* ---- finding 8: library catches let internal faults through ---- */
{
  const host = { syncFunctions: new Set(['List.setMeasurements']), call: () => Promise.resolve(0) };
  const r = await run('s = eval("List.setMeasurements;"); print(s);', { host });
  check('SyncViolation inside eval is an Internal error, not "[aborted]"', !r.res.ok && /Internal error/.test(r.res.error.message), { err: r.res.error, log: r.log });
  const r2 = await run('s = eval("print(1);"); print(s);');
  check('a normal eval is unchanged', r2.res.ok && r2.log[0] === '1', r2.log);
}

/* ---- finding 9: print(literal, x) rule ---- */
{
  const w = { printToWindow() {} };
  check('print(literal, x) / print(number, x) cannot reach a window', classes('print("a", 1); print(1, 2); print("a" + "b", 1);', { host: w }) === 'twin,twin,twin');
  check('print(variable, x) can', classes('s = "[L]"; print(s, 1);', { host: w }) === 'twin,gen');
  check('print("[Log]", x) can', classes('print("[Log]", 1);', { host: w }) === 'gen');
}

/* ---- finding 10: version hooks that answer with a Promise ---- */
{
  const host = { getVersion: () => Promise.resolve('1.54p'), getFullVersion: () => Promise.resolve('1.54p99'), showMessage() {} };
  const r = await run('print(getVersion()); print(IJ.getFullVersion()); requires("1.50a"); print("ok");', { host });
  check('getVersion / IJ.getFullVersion / requires await a Promise', r.res.ok && r.log.join('|') === '1.54p|1.54p99|ok', { log: r.log, err: r.res.error });
  const r2 = await run('print(getVersion());', { host: { getVersion: () => '1.99z', syncFunctions: new Set(['getVersion']) } });
  check('a synchronous host.getVersion declared in syncFunctions', r2.log[0] === '1.99z', r2.log);
  const r3 = await run('print(getVersion());');
  check('without a host: the built-in version', /^1\.\d+/.test(r3.log[0]), r3.log);
}

/* ---- finding 11: the corpus against an asynchronous host, in every mode ---- */
{
  const files = ['corpus', 'corpus-review'].flatMap((d) => { try { return walk(path.join(ROOT, 'tests', 'fixtures', 'ij-macro', d)); } catch { return []; } }).filter((_, i) => i % 3 === 0);
  const observe = async (code, opts) => {
    const log = [], ev = [];
    const host = {
      showMessage: async (t, x) => { ev.push('m:' + t + ':' + x); },
      showError: async (x) => { ev.push('e:' + x); },
      printToWindow: async (t, x) => { ev.push('w:' + t + ':' + x); },
      getVersion: async () => '1.54p',
      call: async (n) => { ev.push('c:' + n); return null; },
    };
    const r = await IJMacro.run(code, Object.assign({ host, onLog: (s) => log.push(s) }, opts));
    return JSON.stringify({ log, ev, ok: r.ok, aborted: r.aborted, exited: r.exited, error: r.error && [r.error.message, r.error.line] });
  };
  let diff = 0, shown = 0;
  for (const f of files) {
    const code = readFileSync(f, 'utf8');
    const base = await observe(code, { fastPath: false });
    for (const opts of [{}, { syncLoops: true, syncRecursion: true }]) {
      const got = await observe(code, opts);
      if (got !== base) { diff++; if (shown++ < 3) console.log('    differs: ' + path.relative(ROOT, f) + ' ' + JSON.stringify(opts) + '\n      gen:  ' + base.slice(0, 250) + '\n      twin: ' + got.slice(0, 250)); }
    }
  }
  check('async-host corpus (' + files.length + ' macros x 2 modes) identical to the generators', files.length > 300 && diff === 0, { files: files.length, diff });
}

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passing');
