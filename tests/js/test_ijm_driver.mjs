// IJMacro driver and host-hook behaviour (what the golden oracle cannot say): cancellation, time slicing,
// recursion depth, host hooks that fail, silent errors, resource guards.
// Run: node tests/js/test_ijm_driver.mjs
import { loadModule } from './harness.mjs';

const IJMacro = loadModule('js/modules/studio/advanced-studio/ij-macro-lang.js', 'IJMacro');
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log('  ok   ' + name);
  else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
};
const run = (code, opts = {}) => {
  const log = [];
  return IJMacro.run(code, Object.assign({ onLog: (s) => log.push(s) }, opts)).then((r) => Object.assign(r, { log }));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('IJMacro driver');

{ // abort interrupts a wait() at once
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const t = Date.now();
  const r = await run('wait(3000); print("after");', { signal: ac.signal });
  const dt = Date.now() - t;
  check('abort interrupts wait()', r.aborted && r.log.length === 0 && dt < 500, { dt, aborted: r.aborted });
}
{ // ... and a host promise that never settles in time
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const t = Date.now();
  const r = await run('setOption("Foo"); print("after");', { signal: ac.signal, host: { call: () => sleep(3000) } });
  const dt = Date.now() - t;
  check('abort interrupts a pending host call', r.aborted && dt < 500, { dt });
}
{ // a long run of slow pure built-ins neither starves the event loop nor delays an abort
  const ac = new AbortController();
  let last = Date.now(), gap = 0;
  const iv = setInterval(() => { const n = Date.now(); gap = Math.max(gap, n - last); last = n; }, 5);
  setTimeout(() => ac.abort(), 300);
  const t = Date.now();
  const r = await run('a = newArray(20000); for (i = 0; i < 20000; i++) a[i] = (i * 7919) % 20011;\nfor (k = 0; k < 1000; k++) b = Array.sort(Array.copy(a));', { signal: ac.signal, sliceMs: 30 });
  const dt = Date.now() - t;
  clearInterval(iv);
  check('event loop is released during slow iterations', gap < 200, { gap });
  check('abort during slow iterations is prompt', r.aborted && dt < 800, { dt });
}
{ // recursion depth of ImageJ (STACK_SIZE 1000 slots) and the error line beyond it
  const r = await run('function f(n) { if (n == 0) return 0; return 1 + f(n - 1); }\nprint(f(900));');
  check('user functions nest 900 deep', r.ok && r.log[0] === '900', { err: r.error, log: r.log });
  const r2 = await run('function f(n) { return f(n + 1); }\nf(0);');
  check('runaway recursion is a macro error with its line', !r2.ok && r2.error.message === 'Stack overflow' && r2.error.line === 1, r2.error);
  const r3 = await run('function g(n) { if (n==0) return 0; return g(n-1); }\nfor (i = 0; i < 3; i++) print(g(100 + i * 100));');
  check('deep calls repeated', r3.ok && r3.log.join() === '0,0,0', r3.log);
}
{ // a host hook that throws is a macro error with the line, not an internal error
  const r = await run('print("a");\nprint("[W]", "x");', { host: { printToWindow() { throw new Error('nope'); } } });
  check('printToWindow throwing', !r.ok && r.error.message === 'nope' && r.error.line === 2, r.error);
  const r2 = await run('runMacro("f");', { host: { runMacroFile() { return Promise.reject(new Error('io')); } } });
  check('runMacroFile rejecting', !r2.ok && r2.error.message === 'io' && r2.error.line === 1, r2.error);
  const r3 = await run('showMessage("t", "m"); print("after");', { host: { showMessage() { return sleep(30); } } });
  check('showMessage is modal (awaited)', r3.ok && r3.log[0] === 'after');
}
{ // errors ImageJ shows no window for are flagged silent; the call stack is returned
  const r = await run('x = 1 +');
  check('silent error flagged', !r.ok && r.error.silent === true && r.error.dialogText === null, r.error);
  const r2 = await run('function a() { b(); }\nfunction b() { c(); }\nfunction c() { x = nope; }\na();');
  check('error carries calledFrom and dialog text', !r2.ok && r2.error.silent === false && JSON.stringify(r2.error.calledFrom) === '[2,1,4]' &&
    r2.error.dialogText === 'Undefined variable in line 3\n\t\t(called from line 2)\n\t\t(called from line 1)\n\t\t(called from line 4)\n \nfunction c ( ) { x = <nope> ; } ', r2.error);
}
{ // an error inside eval() reaches the host's error window
  const wins = [];
  const r = await run('s = eval("x = <;");\nprint(s);', { host: { showError: (t) => wins.push(t) } });
  check('eval error is shown', r.ok && r.log[0] === '[aborted]' && wins.length === 1 && /^Number or numeric function expected in line 1\n/.test(wins[0]), { wins, log: r.log });
}
{ // resource guards: a macro error, never a crashed worker
  const r = await run('s = IJ.pad(1, 2000000000);');
  check('IJ.pad with a huge width', !r.ok && /memory/i.test(r.error.message), r.error);
  const r2 = await run('a = newArray(1e9);');
  check('newArray with a huge size', !r2.ok && /memory/i.test(r2.error.message), r2.error);
  const r3 = await run('s = String.format("%2000000000d", 1);');
  check('String.format with a huge width', !r3.ok, r3.error);
  const r4 = await run('s = fromCharCode(' + new Array(101).fill(65).join(',') + ');');
  check('fromCharCode with 101 arguments', !r4.ok && /ArrayIndexOutOfBounds/.test(r4.error.message), r4.error);
  const r5 = await run('s = fromCharCode(' + new Array(100).fill(65).join(',') + '); print(lengthOf(s));');
  check('fromCharCode with 100 arguments', r5.ok && r5.log[0] === '100', r5.error);
}
{ // Array.fourier is not quadratic any more
  const t = Date.now();
  const r = await run('a = newArray(65536); for (i = 0; i < 65536; i++) a[i] = sin(i / 10);\nb = Array.fourier(a, "none"); print(b.length);');
  check('Array.fourier of 65536 values', r.ok && r.log[0] === '32768' && Date.now() - t < 5000, { err: r.error, dt: Date.now() - t });
}

console.log(failed ? failed + ' failing' : 'all passing');
process.exit(failed ? 1 : 0);
