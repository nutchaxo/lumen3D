// IJMacro additions of the macro extras phase (DOCS/studio-advanced/macros/EXTRAS.md §3): L3 prepared programs and macro entries
// (MacroInstaller / Interpreter.runMacro), L4 the per-pixel program of Process › Math › Macro (ImageMath.applyMacro), L5 reading
// variables after a run. Each check is an ImageJ 1.54p behaviour.
// Run: node tests/js/test_ijm_extras_lang.mjs
import { loadModule } from './harness.mjs';

const IJMacro = loadModule('js/modules/studio/advanced-studio/ij-macro-lang.js', 'IJMacro');
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log('  ok   ' + name);
  else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
};
const logOf = () => { const lines = []; return { lines, onLog: (s) => lines.push(s) }; };

console.log('IJMacro extras (L3 / L4 / L5)');

// ---- L3
{
  const set = 'var n = 0;\nvar s = "a";\nprint("init");\nmacro "Count" { n++; print("n=" + n); }\nmacro "Twice [t]" { n = n + 2; print(n); }\n';
  const P = IJMacro.prepare(set);
  check('prepare lists the entries in order', P.macros.length === 2 && P.macros[0].name === 'Count' && P.macros[1].name === 'Twice [t]', P.macros);
  check('entry line is the MACRO token line', P.macros[0].line === 4 && P.macros[1].line === 5);
  check('needsGlobals = hasVars && macroCount > 0', P.needsGlobals === true && IJMacro.prepare('macro "a" {}').needsGlobals === false);
  const L0 = logOf();
  const g = await IJMacro.run(P, Object.assign({ entry: { start: -1, name: '' } }, L0));
  check('start -1 runs only the var statements (no print)', g.ok && L0.lines.length === 0, L0.lines);
  const L1 = logOf();
  await IJMacro.run(P, Object.assign({ entry: { start: P.macros[0].start, name: 'Count' } }, L1));
  await IJMacro.run(P, Object.assign({ entry: { start: P.macros[0].start, name: 'Count' } }, L1));
  await IJMacro.run(P, Object.assign({ entry: { start: P.macros[1].start, name: 'Twice [t]' } }, L1));
  check('globals persist between entry runs of one Prepared', L1.lines.join('|') === 'n=1|n=2|4', L1.lines);
  const P2 = IJMacro.prepare(set);
  const L2 = logOf();
  await IJMacro.run(P2, Object.assign({ entry: { start: P2.macros[0].start, name: 'Count' } }, L2));
  check('a new Prepared starts from the initializers', L2.lines.join('|') === 'n=1', L2.lines);
  const L3 = logOf();
  const anon = IJMacro.prepare('print("whole");\nx = 3;\nprint(x*2);');
  await IJMacro.run(anon, Object.assign({ entry: { start: 0, name: '' } }, L3));
  check('start 0 runs the whole set (an anonymous set)', L3.lines.join('|') === 'whole|6', L3.lines);
  const L4 = logOf();
  await IJMacro.run(IJMacro.prepare('print(1);'), L4);
  check('a Prepared without entry runs as Interpreter.run(Program)', L4.lines.join('|') === '1');
  const bad = await IJMacro.run(P, { entry: { start: 1e9, name: 'x' } });
  check('an entry outside the program is an internal error', !bad.ok && /bad macro entry/.test(bad.error.message), bad.error);
  const err = await IJMacro.run(IJMacro.prepare('macro "E" {\n  y = undefinedThing + 1;\n}'), { entry: { start: 4, name: 'E' } });
  check('an entry error carries its line', !err.ok && err.error.line === 2, err.error);
  const L5 = logOf();
  const ex = IJMacro.prepare('var k = 5;\nmacro "X" { k++; exit; }\nmacro "Y" { print(k); }');
  await IJMacro.run(ex, { entry: { start: ex.macros[0].start, name: 'X' } });
  await IJMacro.run(ex, Object.assign({ entry: { start: ex.macros[1].start, name: 'Y' } }, L5));
  check('exit in one entry keeps the globals it changed', L5.lines.join('|') === '6', L5.lines);
}

// ---- L4
{
  check('PC_START is the token count of the prefix', IJMacro.tokenize(IJMacro.PIXEL_PREFIX).code.findIndex((t) => (t & 4095) === IJMacro.K.EOF) === IJMacro.PC_START);
  const L = logOf();
  const p = await IJMacro.pixelProgram('print("once"); v=v*2', { onLog: L.onLog });
  check('the code runs once at preparation (print once)', p.ok && L.lines.join('|') === 'once', L.lines);
  check('hasWord flags', !p.hasX && !p.hasA && !p.hasD && !p.hasGetPixel);
  let ok = true;
  for (const v of [0, 1, 100, 200]) { p.set('v', v); const e = p.runSync(); if (e !== null || p.get('v') !== v * 2) ok = false; }
  check('runSync from PC_START, v read back', ok);
  check('per-pixel runs print again (ImageJ runs the whole statement list)', L.lines.length === 5, L.lines);
  const q = await IJMacro.pixelProgram('s="x"; t="getPixel"; u="d"; w2="a"; v=1', {});
  check('hasWord counts string constants', q.ok && q.hasX && q.hasD && q.hasA && q.hasGetPixel);
  check('get of an absent variable is NaN', Number.isNaN(q.get('nope')));
  const r = await IJMacro.pixelProgram('v=v+50*sin(d/10)', {});
  r.set('v', 10); r.set('d', 5); r.runSync();
  check('sin(d/10) formula', Math.abs(r.get('v') - (10 + 50 * Math.sin(0.5))) < 1e-12, r.get('v'));
  const bad = await IJMacro.pixelProgram('v=v*', {});
  check('a syntax error is reported at preparation', !bad.ok && bad.error && /expected|Number or numeric function/i.test(bad.error.message), bad.error);
  const rt = await IJMacro.pixelProgram('if (v>5) v=undefinedVar; else v=0', {});
  rt.set('v', 1);
  check('a run that does not reach the bad branch succeeds', rt.ok && rt.runSync() === null);
  rt.set('v', 9);
  const e2 = rt.runSync();
  check('a per-pixel run error comes back as an error', e2 !== null && /Undefined variable/.test(e2.message), e2);
  const t0 = Date.now();
  const sp = await IJMacro.pixelProgram('v=v*2', {});
  for (let i = 0; i < 512 * 512; i++) { sp.set('v', i & 255); sp.runSync(); }
  console.log('  note 512x512 v=v*2 runSync loop: ' + (Date.now() - t0) + ' ms');
}

// ---- L5
{
  const r = await IJMacro.run('a = 3;\ns = "txt";\narr = newArray(1, "b", 3);\nexit;\nz = 1;', { readVars: ['a', 's', 'arr', 'z'] });
  check('readVars after exit', r.exited && r.vars.a.n === 3 && r.vars.s.s === 'txt' && r.vars.arr.a.join(',') === '1,b,3' && r.vars.z === null, r.vars);
  const e = await IJMacro.run('k = 7;\nq = nope;', { readVars: ['k'] });
  check('readVars after an error', !e.ok && e.vars.k.n === 7, e.vars);
  check('no readVars = empty vars', JSON.stringify((await IJMacro.run('x=1;')).vars) === '{}');
  const rv = await IJMacro.run('return "back";');
  check('returnValue', rv.returnValue === 'back', rv.returnValue);
}

// ---- IJMacroParams.RESERVED = the language's system symbol table (the #@ names Fiji leaves out of the injection)
{
  const IJMacroParams = loadModule('js/modules/studio/advanced-studio/ij-macro-params.js', 'IJMacroParams');
  const notWord = IJMacroParams.RESERVED.filter((n) => (IJMacro.tokenize(n).code[0] & 4095) === IJMacro.K.WORD);
  check('every RESERVED name tokenizes as a keyword or a built-in', notWord.length === 0, notWord);
  const sys = new Set(Object.values(IJMacro.NAME_OF));
  const missing = [...sys].filter((n) => IJMacroParams.RESERVED.indexOf(n) < 0);
  check('every built-in function name is RESERVED', missing.length === 0, missing);
}

if (failed) { console.log(failed + ' FAILED'); process.exit(1); }
console.log('all passed');
