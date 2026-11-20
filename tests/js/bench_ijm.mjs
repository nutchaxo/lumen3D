// Speed benchmark of the IJMacro interpreter: generators only vs the synchronous fast path vs fast path with whole
// loops in the twin, against ImageJ 1.54p (tests/js/bench_ijm/imagej-timings.json, from
// tools/ij_fixtures/macro/run_bench.sh). NOT a test_* file: never part of CI.
// Run: node tests/js/bench_ijm.mjs [runs=3] [--gate] [name ...]
// --gate: exit 1 when the default mode's first run exceeds 3x ImageJ's WARM time (PLAN 5.3) on any macro that has a reference.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';

// A fresh, native (not vm-context: a vm global makes every builtin lookup ~1.7x slower) copy of the module per mode, so the
// inline caches of one mode never colour the next one.
const source = readFileSync(path.join(ROOT, 'js/modules/studio/advanced-studio/ij-macro-lang.js'), 'utf8');
let instances = 0;
async function freshModule() {
  const text = source + ['', 'export { IJMacro };', '// instance ' + (++instances)].join('\n');
  return (await import('data:text/javascript;base64,' + Buffer.from(text).toString('base64'))).IJMacro;
}
const args = process.argv.slice(2);
const gate = args.includes('--gate');
if (gate) args.splice(args.indexOf('--gate'), 1);
const runs = /^\d+$/.test(args[0] || '') ? Number(args.shift()) : 3;
const only = args;
const dir = path.join(ROOT, 'tests', 'js', 'bench_ijm');
const ij = existsSync(path.join(dir, 'imagej-timings.json')) ? JSON.parse(readFileSync(path.join(dir, 'imagej-timings.json'), 'utf8')) : {};

const W = 512, H = 512;
let pix = new Uint8Array(W * H);
function installHost(IJMacro) {
  const K = IJMacro.K;
  IJMacro.define('num', K.GET_WIDTH, function* (f) { f.interp.getParens(); return W; },
    { suspends: false, sync: (f) => { f.interp.getParens(); return W; } });
  IJMacro.define('num', K.GET_HEIGHT, function* (f) { f.interp.getParens(); return H; },
    { suspends: false, sync: (f) => { f.interp.getParens(); return H; } });
  IJMacro.define('num', K.GET_PIXEL, function* (f) { const x = yield* f.getFirstArg(); const y = yield* f.getLastArg(); return pix[(y | 0) * W + (x | 0)]; },
    { suspends: false, sync: (f) => { const x = f.getFirstArg$s(); const y = f.getLastArg$s(); return pix[(y | 0) * W + (x | 0)]; } });
  IJMacro.define('do', K.SET_PIXEL, function* (f) {
    const x = yield* f.getFirstArg(); const y = yield* f.getNextArg(); const v = yield* f.getLastArg(); pix[(y | 0) * W + (x | 0)] = v;
  }, { suspends: false, sync: (f) => { const x = f.getFirstArg$s(); const y = f.getNextArg$s(); const v = f.getLastArg$s(); pix[(y | 0) * W + (x | 0)] = v; } });
}

const modes = [
  ['generators', { fastPath: false }],
  ['fast path', {}],
  ['fast + syncLoops', { syncLoops: true }],
  ['fast + syncLoops/Rec', { syncLoops: true, syncRecursion: true }],
];

const files = readdirSync(dir).filter((f) => f.endsWith('.ijm')).sort();
const rows = [];
for (const file of files) {
  const name = file.replace(/\.ijm$/, '');
  if (only.length && !only.includes(name)) continue;
  const code = readFileSync(path.join(dir, file), 'utf8');
  const row = { name, ij: ij[name] || null, modes: {} };
  let ref = null;
  for (const [label, opts] of modes) {
    const IJMacro = await freshModule();
    installHost(IJMacro);
    const times = [];
    let last = null;
    for (let r = 0; r < runs; r++) {
      pix = new Uint8Array(W * H);
      const log = [];
      const res = await IJMacro.run(code, Object.assign({ onLog: (s) => log.push(s) }, opts));
      if (!res.ok) { console.log('  ' + name + ' [' + label + '] FAILED: ' + JSON.stringify(res.error)); break; }
      const m = /ELAPSED (\d+) ?(.*)/.exec(log[log.length - 1] || '');
      times.push(Number(m[1]));
      last = m[2];
    }
    if (ref === null) ref = last;
    else if (last !== ref) console.log('  ' + name + ' [' + label + '] RESULT DIFFERS: ' + last + ' vs ' + ref);
    row.modes[label] = { first: times[0], min: Math.min(...times) };
  }
  rows.push(row);
}

const pad = (s, n) => String(s).padStart(n);
console.log('IJMacro speed (ms, ELAPSED printed by the macro; first run / best of ' + runs + '); ImageJ 1.54p cold / warm; ratios = first run vs ImageJ cold (xc) and vs warm (xw)');
console.log('  ' + 'macro'.padEnd(10) + modes.map(([l]) => pad(l, 30)).join('') + pad('ImageJ cold/warm', 20));
let gateFailed = false;
for (const r of rows) {
  const cells = modes.map(([l]) => {
    const m = r.modes[l];
    const ratio = r.ij ? ' xc' + (m.first / Math.max(1, r.ij.cold)).toFixed(1) + ' xw' + (m.first / Math.max(1, r.ij.min)).toFixed(1) : '';
    return pad(m.first + ' / ' + m.min + ratio, 30);
  }).join('');
  console.log('  ' + r.name.padEnd(10) + cells + pad(r.ij ? r.ij.cold + ' / ' + r.ij.min : '-', 20));
  const d = r.modes['fast path'];
  if (r.ij && d && d.first > 3 * r.ij.min) { gateFailed = true; console.log('    GATE: ' + r.name + ' default mode ' + d.first + ' ms > 3 x ' + r.ij.min + ' ms (warm ImageJ)'); }
}
if (gate && gateFailed) process.exit(1);
