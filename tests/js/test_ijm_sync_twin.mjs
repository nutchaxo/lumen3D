// The synchronous twin of the IJMacro interpreter: (1) it is exactly what tools/gen_ijm_sync.mjs derives from the generator
// code (a stale twin fails here), (2) the whole golden corpus gives the same result with and without it, (3) the
// suspension analysis keeps what can wait on the generators, (4) the abort policy of a stretch that cannot yield.
// Run: node tests/js/test_ijm_sync_twin.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadModule, ROOT } from './harness.mjs';
import { generate, TARGET } from '../../tools/gen_ijm_sync.mjs';

const REL = 'js/modules/studio/advanced-studio/ij-macro-lang.js';
const IJMacro = loadModule(REL, 'IJMacro');
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log('  ok   ' + name);
  else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
};

console.log('IJMacro synchronous twin');

/* ---- (1) the twin is generated, never edited ---- */
{
  const src = readFileSync(TARGET, 'utf8');
  let fresh = null, err = null;
  try { fresh = generate(src); } catch (e) { err = String(e && e.message || e); }
  check('generated region is up to date (run node tools/gen_ijm_sync.mjs)', fresh === src, err);
  check('generation is idempotent', err !== null || generate(fresh) === fresh);
  const begin = src.indexOf('/* BEGIN GENERATED SYNC TWIN'), end = src.indexOf('/* END GENERATED SYNC TWIN */');
  const region = src.slice(begin, end);
  check('twin has no generator left', begin > 0 && !/\byield\b|function\*|\*[A-Za-z_$][\w$]*\(.*\) \{$/m.test(region.replace(/\/\*[\s\S]*?\*\//g, '')));
  // every hand-written generator method has a twin, and nothing else does
  const gens = [...src.slice(0, begin).matchAll(/^  \*([A-Za-z_$][\w$]*)\(/gm)].map((m) => m[1]);
  const twins = [...region.matchAll(/^  ([A-Za-z_$][\w$]*)\$s\(/gm)].map((m) => m[1]);
  check('a twin per generator method', gens.length > 50 && gens.every((g) => twins.includes(g)) && twins.length === gens.length, { gens: gens.length, twins: twins.length });
}

/* ---- K.<NAME> reads are dictionary lookups: the code reads the K_<NAME> constants ---- */
{
  const src = readFileSync(TARGET, 'utf8').split(/\r?\n/);
  const bad = [];
  src.forEach((l, i) => {
    if (l.startsWith('const K = {') || l.startsWith('  K_') || /^const K_/.test(l)) return;
    if (/^\s*(\/\*|\*|\/\/)/.test(l)) return;
    if (/(?<![\w.])K\.[A-Za-z_]/.test(l)) bad.push(i + 1);
  });
  check('no K.<NAME> read in the code (use K_<NAME>)', bad.length === 0, bad.slice(0, 5));
  const K = IJMacro.K;
  const decl = readFileSync(TARGET, 'utf8').match(/^const K_ABS[\s\S]*?;/m)[0];
  const pairs = [...decl.matchAll(/K_(\w+) = K\.(\w+)/g)];
  check('every K_<NAME> constant is K.<NAME>', pairs.length > 100 && pairs.every((p) => p[1] === p[2] && K[p[1]] !== undefined));
}

/* ---- (2) differential: the golden corpus, generators vs twin vs twin with whole loops ---- */
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = path.join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ijm') ? [p] : [];
});
async function observe(code, opts) {
  const log = [], dialogs = [];
  const host = {
    showMessage(title, text) { dialogs.push(['m', title, text, log.length]); },
    showError(text) { dialogs.push(['e', text, log.length]); },
    printToWindow(title, text) { log.push('[' + title + '] ' + text); },
  };
  const r = await IJMacro.run(code, Object.assign({ host, onLog: (s) => log.push(s) }, opts));
  return JSON.stringify({ log, dialogs, ok: r.ok, aborted: r.aborted, exited: r.exited, error: r.error, rv: r.returnValue === undefined ? null : r.returnValue });
}
{
  const P = IJMacro.Interpreter.prototype;
  const orig = P.doStatement$s;
  let twinStatements = 0;
  P.doStatement$s = function (...a) { twinStatements++; return orig.apply(this, a); };
  const files = ['corpus', 'corpus-review'].flatMap((d) => { try { return walk(path.join(ROOT, 'tests', 'fixtures', 'ij-macro', d)); } catch { return []; } });
  let diff = 0, shown = 0;
  for (const f of files) {
    const code = readFileSync(f, 'utf8');
    const base = await observe(code, { fastPath: false });
    for (const opts of [{}, { syncLoops: true }]) {
      const got = await observe(code, opts);
      if (got !== base) { diff++; if (shown++ < 5) console.log('    differs: ' + path.relative(ROOT, f) + ' ' + JSON.stringify(opts) + '\n      gen:  ' + base.slice(0, 300) + '\n      twin: ' + got.slice(0, 300)); }
    }
  }
  P.doStatement$s = orig;
  check('golden corpus (' + files.length + ' macros): same log, dialogs, error text and line with the twin', files.length > 1000 && diff === 0, { files: files.length, diff });
  check('the twin really ran (' + twinStatements + ' statements)', twinStatements > 5000, twinStatements);
}

/* ---- (3) the suspension analysis ---- */
const K = IJMacro.K;
const classes = (code, opts) => IJMacro.analyze(code, opts).statements.map((x) => x.class).join();
const run = async (code, opts = {}) => {
  const log = [];
  const res = await IJMacro.run(code, Object.assign({ onLog: (s) => log.push(s) }, opts));
  return { res, log };
};
{
  check('pure statements are twin', classes('x = 1; y = x + 2; print(y);') === 'twin,twin,twin');
  check('wait() is generator, its neighbours are not', classes('x = 1; wait(1); y = x + 2;') === 'twin,gen,twin');
  check('eval() / runMacro() are generator', classes('s = eval("1"); t = runMacro("x"); u = 2;') === 'gen,gen,twin');
  check('showMessage / requires / exit("m") are generator, bare exit is not', classes('showMessage("a"); requires("1.1"); exit("m"); exit;') === 'gen,gen,gen,twin');
  const a = IJMacro.analyze('function g() { wait(1); return 2; }\nfunction h() { return g(); }\nfunction p() { return 3; }\nfunction l() { for (i = 0; i < 3; i++) {} return 1; }\nfunction m() { return l(); }\na = p(); b = h(); c = l(); d = m();');
  check('a function that waits makes its callers wait (transitively), a pure one does not',
    a.functions.g.suspends && a.functions.h.suspends && !a.functions.p.suspends && !a.functions.l.suspends, a.functions);
  check('a function that loops makes its callers loop', a.functions.l.loops && a.functions.m.loops && !a.functions.p.loops, a.functions);
  check('call statements follow their function', a.statements.map((x) => x.class).join() === 'twin,gen,loop,loop', a.statements);
  const w = { printToWindow() {} };
  check('print(literal, x) and print(x) cannot reach a window; print(var, x) can',
    classes('print("a", 1); print("b"); print(1, 2); w = "[L]"; print(w, "x"); print("[L]", 1); print("", 1);', { host: w }) === 'twin,twin,twin,twin,gen,gen,gen');
  check('host.syncFunctions covers printToWindow', classes('print(w, "x");', { host: { syncFunctions: new Set(['printToWindow']) } }) === 'twin');
  check('List.* and String.* reach the host only for the host names',
    classes('List.set("a", "b"); x = List.get("a"); List.setMeasurements(); String.copy("a"); s = String.join(newArray(1, 2));') === 'twin,twin,gen,gen,twin');
  check('Array.show suspends, the other Array functions do not', classes('a = newArray(3); Array.show(a); Array.sort(a); b = Array.concat(a, a);') === 'twin,gen,twin,twin');
  check('IJ.* host names', classes('IJ.log("x"); IJ.pad(3, 5); IJ.deleteRows(1, 2);') === 'twin,twin,gen');
  check('loops that cannot suspend are class loop, with syncLoops they are twin',
    classes('for (i = 0; i < 3; i++) x = i;') === 'loop' && classes('for (i = 0; i < 3; i++) x = i;', { syncLoops: true }) === 'twin');
  check('a loop that waits is generator', classes('for (i = 0; i < 3; i++) { wait(0); }') === 'gen');
  check('if / block containing a loop are class loop', classes('if (1) { for (i = 0; i < 2; i++) x = i; }\n{ do { x = 1; } while (0); }') === 'loop,loop');
}
{ // and the dispatch really does what the analysis says: counts of statements run by the twin
  const P = IJMacro.Interpreter.prototype;
  const orig = P.doStatement$s;
  let twin = 0;
  P.doStatement$s = function (...a) { twin++; return orig.apply(this, a); };
  try {
    const r = await run('s = 0; for (i = 0; i < 1000; i++) { s += i; }\nprint(s);');
    check('a pure loop: its body statements run in the twin, one per iteration', r.log[0] === '499500' && twin >= 1000, { twin });
    const origFor = P.doFor;
    let forGen = 0;
    P.doFor = function* () { forGen++; return yield* origFor.call(this); };
    const gens0 = forGen;
    const r1 = await run('s = 0; for (i = 0; i < 1000; i++) { s += i; }\nprint(s);');
    const gens = forGen - gens0;
    forGen = 0;
    const r2 = await run('s = 0; for (i = 0; i < 1000; i++) { s += i; }\nprint(s);', { syncLoops: true });
    P.doFor = origFor;
    check('syncLoops: the whole loop runs in the twin, not in the generator doFor', r1.log[0] === '499500' && r2.log[0] === '499500' && gens === 1 && forGen === 0, { gens, forGen });
    twin = 0;
    twin = 0;
    const r3 = await run('s = 0; for (i = 0; i < 40; i++) { s += i; wait(0); }\nprint(s);');
    check('a loop that waits works, its sync statements are still dispatched one by one', r3.log[0] === '780' && twin >= 40, { twin });
    const r4 = await run('function f(n) { s = 0; for (j = 0; j < n; j++) s += j; return s; }\nprint(f(10) + f(20));');
    const r4g = await run('function f(n) { s = 0; for (j = 0; j < n; j++) s += j; return s; }\nprint(f(10) + f(20));', { fastPath: false });
    check('a function with a loop', r4.log[0] === r4g.log[0] && r4.log[0] === '45190', r4.log);
    const code = 's = 0; i = 0; while (i < 500) { i++; if (i % 2 == 0) continue; if (i > 400) break; s += i; }\nprint(s + " " + i);';
    const r5 = await run(code), r5g = await run(code, { fastPath: false });
    check('break / continue inside twin statements', r5.log[0] === r5g.log[0] && r5.log[0] === '40000 401', { a: r5.log, b: r5g.log });
    const r6 = await run('i = 0; do { i++; } while (i < 100);\nprint(i);');
    check('do ... while', r6.log[0] === '100', r6.log);
    const r7 = await run('exit; print("no");');
    check('a bare exit', r7.log.length === 0 && r7.res.exited);
    const r8 = await run('exit("bye");', { host: { showMessage() {} } });
    check('exit("msg") shows a dialog', r8.res.exited);
    // a loop that may suspend in its body still evaluates its condition in the twin
    const Pg = IJMacro.Interpreter.prototype;
    const origB = Pg.getBoolean;
    let boolGen = 0;
    Pg.getBoolean = function* () { boolGen++; return yield* origB.call(this); };
    let n = 0;
    const rb = await run('w = "[L]"; i = 0; while (i < 50) { i++; print(w, i); }', { host: { printToWindow: () => { n++; } } });
    Pg.getBoolean = origB;
    check('while (cond) with a suspending body: the condition runs in the twin', rb.res.ok && n === 50 && boolGen === 0, { n, boolGen });
    let win = null;
    const r9 = await run('w = "[Log]"; print(w, "x");', { host: { printToWindow: (t, s) => { win = t + ':' + s; } } });
    check('print(variable, x) reaches the window through the generators', win === 'Log:x', r9.log);
  } finally { P.doStatement$s = orig; }
}

/* ---- host / external built-ins ---- */
{
  const calls = [];
  const mk = () => ({ call: (name, args) => { calls.push(name); return name === 'getPixel' ? args[0] * 10 : null; } });
  IJMacro.define('num', K.GET_PIXEL, function* (f) { const x = yield* f.getFirstArg(); const y = yield* f.getLastArg(); return yield* f.hostCall('getPixel', [x, y]); });
  const src = 'v = 0; for (i = 0; i < 20; i++) v += getPixel(i, 0);\nprint(v);';
  check('an external built-in without options may suspend', classes(src, { host: mk() }) === 'twin,gen,twin', classes(src, { host: mk() }));
  const r = await run(src, { host: mk() });
  check('... and still gives the right answer through the generators', r.log[0] === '1900' && calls.length === 20, r);
  const sync = { syncFunctions: new Set(['getPixel']) };
  check('host.syncFunctions declares it synchronous', classes(src, { host: Object.assign(mk(), sync) }) === 'twin,loop,twin');
  const r2 = await run(src, { host: Object.assign(mk(), sync) });
  check('... the twin drives the generator body', r2.log[0] === '1900', r2);
  const r3 = await run('v = getPixel(1, 0);\nprint(v);', { host: { call: () => Promise.resolve(5), syncFunctions: new Set(['getPixel']) } });
  check('a built-in declared synchronous that returns a Promise is an internal error, never a wrong answer', !r3.res.ok && /Internal error/.test(r3.res.error.message), r3.res.error);
  IJMacro.define('num', K.GET_PIXEL, function* (f) { return 0; }, { suspends: false, sync: (f) => { const x = f.getFirstArg$s(); f.getLastArg$s(); return x * 2; } });
  check('{ suspends: false, sync } is class twin / loop', classes(src) === 'twin,loop,twin');
  const r4 = await run(src);
  check('... and plugs a plain function into the fast path', r4.log[0] === '380', r4.log);
}

/* ---- (4) a stretch that cannot yield: abort policy ---- */
{
  const flag = new Int32Array(new SharedArrayBuffer(4));
  IJMacro.define('do', K.SET_PIXEL, function* (f) { yield* f.getArg(); Atomics.store(flag, 0, 1); }, { suspends: false, sync: (f) => { f.getArg$s(); Atomics.store(flag, 0, 1); } });
  const t = Date.now();
  const r = await run('function fib(n) { if (n < 2) return n; return fib(n - 1) + fib(n - 2); }\nsetPixel(0);\nprint(fib(40));', { abortFlag: flag });
  const dt = Date.now() - t;
  check('abortFlag stops a recursion that cannot yield', r.res.aborted && dt < 3000 && r.log.length === 0, { dt, aborted: r.res.aborted });
  const ac = new AbortController();
  ac.abort();
  const r2 = await run('print("never");', { signal: ac.signal });
  check('an already aborted signal never starts', r2.res.aborted && r2.log.length === 0, r2.res);
  // a pure loop is still sliced and aborted by the signal (its control stays on the generators)
  const ac2 = new AbortController();
  setTimeout(() => ac2.abort(), 100);
  const t2 = Date.now();
  const r3 = await run('x = 0; while (true) { x = x + 1; }', { signal: ac2.signal });
  check('an endless pure loop is aborted by the signal', r3.res.aborted && Date.now() - t2 < 1500, { dt: Date.now() - t2 });
}
{ // the stack: a recursion the native stack cannot hold ends with ImageJ's message and a line, never a crash
  const r = await IJMacro.run('function f(n) { return f(n + 1); }\nf(0);');
  check('runaway recursion: Stack overflow with its line', !r.ok && r.error.message === 'Stack overflow' && r.error.line === 1, r.error);
}

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passing');
