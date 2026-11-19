// Analyze > Tools > Curve Fitting: the port of ImageJ 1.54p's CurveFitter + Minimizer (ij-proc-fiji.js, IJCurveFit).
//
// Reference: tests/fixtures/ij-wave3/fiji/curve_fit.json — the real ImageJ 1.54p, every function of CurveFitter.sortedTypes, single thread,
// Minimizer.setRandomSeed(1). The port is the same arithmetic in the same order, so the comparison is EXACT where V8 and the JVM agree on
// Math.exp / Math.pow / Math.log (they did on all 25 functions: tolerance below is 1e-9 relative on every number, and the iteration counts —
// which would drift by one on any difference of the simplex path — are compared exactly).
//
// Run: node tests/js/test_ij_fiji_curvefit.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const ctx = vm.createContext({ console, setTimeout, clearTimeout });
for (const f of ['ij-core.js', 'ij-proc-shared.js', 'ij-proc-fiji.js']) vm.runInContext(readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
const CF = vm.runInContext('IJCurveFit', ctx);
const reg = vm.runInContext('IJOpRegistry', ctx);
const fx = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'ij-wave3', 'fiji', 'curve_fit.json'), 'utf8'));
const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);
const plain = (x) => JSON.parse(JSON.stringify(x));

// ── 1. every built-in function against ImageJ ──
assert.equal(fx.cases.length, 25);
assert.deepEqual(plain(CF.SORTED_TYPES), fx.sortedTypes, 'CurveFitter.sortedTypes');
assert.deepEqual(plain(CF.FIT_LIST), fx.fitList, 'CurveFitter.fitList');
assert.deepEqual(plain(CF.F_LIST), fx.fList, 'CurveFitter.fList');
let worst = 0;
for (const c of fx.cases) {
  const r = await CF.fitCurve({ fitType: c.fitType, x: c.x, y: c.y, randomSeed: 1 });
  const e = c.result;
  assert.equal(r.status, e.status, `${c.fitName}: status`);
  assert.equal(r.statusString, e.statusString, `${c.fitName}: status string`);
  assert.equal(r.iterations, e.iterations, `${c.fitName}: iterations`);
  assert.equal(r.restarts, e.restarts, `${c.fitName}: restarts`);
  assert.equal(r.numParams, e.numParams);
  assert.equal(r.formula, c.equation, `${c.fitName}: formula`);
  for (let i = 0; i < e.numParams; i++) { const d = rel(r.params[i], e.params[i]); worst = Math.max(worst, d); assert.ok(d < 1e-9, `${c.fitName}: param ${i}: ${r.params[i]} vs ${e.params[i]}`); }
  for (const k of ['rSquared', 'sumResidualsSqr', 'sd', 'fitGoodness']) { const d = rel(r[k], e[k]); worst = Math.max(worst, d); assert.ok(d < 1e-9, `${c.fitName}: ${k}: ${r[k]} vs ${e[k]}`); }
  assert.equal(r.residuals.length, e.residuals.length);
  r.residuals.forEach((v, i) => assert.ok(Math.abs(v - e.residuals[i]) < 1e-9 * Math.max(1, Math.abs(e.residuals[i])), `${c.fitName}: residual ${i}`));
}
console.log('curve fit: 25 functions agree with ImageJ, worst relative difference ' + worst.toExponential(2));

// ── 2. the Rodbard (NIH Image) quirk: ImageJ ends with "Max. no. of restarts reached" (status 5) and still returns its best simplex ──
{
  const c = fx.cases.find((x) => x.fitName === 'Rodbard (NIH Image)');
  const r = await CF.fitCurve({ fitType: c.fitType, x: c.x, y: c.y, randomSeed: 1 });
  assert.equal(r.status, 5); assert.equal(r.ok, true, 'a status 5 fit still has a result');
  assert.ok(Math.abs(r.rSquared - 0.9743276403000676) < 1e-9);
}

// ── 3. erf (ij.util.IJMath.erf: "maximum absolute and relative errors below 1e-12") ──
{
  // reference values from the series / continued fraction of the complementary error function (Abramowitz & Stegun 7.1)
  const ref = new Map([[0, 0], [0.1, 0.1124629160182849], [0.5, 0.5204998778130465], [1, 0.8427007929497149], [1.5, 0.9661051464753108], [2, 0.9953222650189527], [3, 0.9999779095030014], [5.9, 1]]);
  for (const [x, v] of ref) { assert.ok(Math.abs(CF.erf(x) - v) < 1e-12, `erf(${x})`); assert.equal(CF.erf(-x) + CF.erf(x), 0, `erf is odd at ${x}`); }
  assert.equal(CF.erf(7), 1); assert.equal(CF.erf(-7), -1);
  assert.ok(Math.abs(CF.erf(1e-5) - 2 / Math.sqrt(Math.PI) * 1e-5) < 1e-15, 'the Taylor branch below x² = 1e-8');
}

// ── 4. a fit that cannot start: ImageJ's reasons ──
{
  const x = [-1, 0, 1, 2], y = [1, 2, 3, 5];
  const power = await CF.fitCurve({ fitType: 5, x, y });
  assert.equal(power.ok, false); assert.equal(power.statusString, 'Cannot fit Power when x<0'); assert.equal(power.status, 1);
  assert.equal((await CF.fitCurve({ fitType: 23, x, y })).statusString, 'Cannot fit Chapman-Richards when x<0');
  assert.equal((await CF.fitCurve({ fitType: 6, x: [0, 1, 2], y: [1, 2, 3] })).statusString, 'Cannot fit Log when x<=0');
  assert.equal((await CF.fitCurve({ fitType: 7, x: [-1, 1, 2], y: [1, 2, 3] })).statusString, 'Cannot fit Rodbard to mixture of x<0 and x>0');
  assert.equal((await CF.fitCurve({ fitType: 16, x: [-1, 1, 2], y: [1, 2, 3] })).statusString, 'Cannot fit x<=0');
  assert.equal((await CF.fitCurve({ fitType: 15, x: [1, 2, 3], y: [1, -2, 3] })).statusString, 'Cannot fit y=0 or mixture of y>0, y<0');
  // the (0, 0) point is ignored by the power law fit by regression, which then needs a positive power ("restrictPower")
  const p0 = await CF.fitCurve({ fitType: 16, x: [0, 1, 2, 3, 4], y: [0, 2, 8, 18, 32] });
  assert.ok(p0.ok && Math.abs(p0.params[1] - 2) < 1e-9 && Math.abs(p0.params[0] - 2) < 1e-9, 'y = 2x²: ' + JSON.stringify(p0.params));
}

// ── 5. pairs with a NaN are dropped (CurveFitter constructor) ──
{
  const r = await CF.fitCurve({ fitType: 0, x: [0, 1, 2, 3, NaN, 5], y: [1, 3, 5, 7, 9, 11] });
  assert.equal(r.points, 5); assert.ok(Math.abs(r.params[0] - 1) < 1e-12 && Math.abs(r.params[1] - 2) < 1e-12);
}

// ── 6. determinism: progress ticks and yields change nothing; the seed is the only random input ──
{
  const c = fx.cases.find((x) => x.fitName === 'Gaussian');
  let ticks = 0, checks = 0;
  const hooks = { check() { checks++; }, async tick() { ticks++; await Promise.resolve(); } };
  const a = await CF.fitCurve({ fitType: c.fitType, x: c.x, y: c.y, randomSeed: 5 });
  const b = await CF.fitCurve({ fitType: c.fitType, x: c.x, y: c.y, randomSeed: 5 }, hooks);
  assert.deepEqual(plain(a), plain(b));
  assert.ok(ticks > 0 && checks > 0, 'the minimizer yields and checks');
  const d = await CF.fitCurve({ fitType: c.fitType, x: c.x, y: c.y, randomSeed: 6 });
  assert.ok(rel(d.sumResidualsSqr, a.sumResidualsSqr) < 1e-6, 'another seed finds the same minimum');
  // a cancel stops the fit: the promise rejects, nothing partial comes back
  let n = 0;
  await assert.rejects(CF.fitCurve({ fitType: 20, x: fx.cases[7].x, y: fx.cases[7].y }, { check() { if (++n > 40) throw Object.assign(new Error('cancelled'), { code: 'IJ_CANCELLED' }); } }), (e) => e.code === 'IJ_CANCELLED');
}

// ── 7. the registered operation ──
{
  const spec = reg.get('curveFit');
  assert.equal(spec.kind, 'compute'); assert.equal(spec.version, 1);
  const bad = (p) => assert.throws(() => spec.validate(p), (e) => e.code === 'IJ_BAD_ARGS' || e.code === 'IJ_TOO_LARGE');
  bad(null); bad({ fitType: 99, x: [1, 2], y: [1, 2] }); bad({ fitType: 0, x: [1], y: [1] }); bad({ fitType: 0, x: [1, 2], y: [1] }); bad({ fitType: 0, x: [1, 'a'], y: [1, 2] });
  bad({ fitType: 0, x: [1, 2], y: [1, 2], randomSeed: 1.5 }); bad({ fitType: 0, x: [1, 2], y: [1, 2], maxRestarts: -1 });
  spec.validate({ fitType: 0, x: [1, 2], y: [1, 2] });
  const res = await spec.run({ width: 1, height: 1 }, { fitType: 1, x: [0, 1, 2, 3, 4], y: [1, 2, 5, 10, 17] }, null, { tick: async () => {}, check() {} });
  assert.ok(Math.abs(res.params[0] - 1) < 1e-6 && Math.abs(res.params[2] - 1) < 1e-6, 'y = 1 + x²');
  assert.ok(res.curve.x.length >= 100 && res.curve.x.length === res.curve.y.length, 'the plot curve');
  assert.equal(res.curve.x[0], 0); assert.ok(Math.abs(res.curve.x[res.curve.x.length - 1] - 4) < 1e-6);
}

console.log('ij fiji curvefit: OK');
